import type { Capabilities, GroupContextExtension } from 'ts-mls'
import { defaultCapabilities, makeCustomExtension } from 'ts-mls'

import type { GroupHandle } from './group.js'

/**
 * MLS GroupContext extension type for the genesis anchor. A uint16 outside the MLS default
 * range (1–5) and clear of GREASE values, so it never collides with a built-in or a probe.
 */
export const GROUP_ANCHOR_EXTENSION_TYPE = 0xf100

/**
 * MLS GroupContext extension type for the control-ledger head. Update logic lands in a later
 * step; the type is reserved and advertised now (see {@link controlCapabilities}) so member
 * leaves don't need to be rejected once it grows data.
 */
export const LEDGER_HEAD_EXTENSION_TYPE = 0xf101

/**
 * Reserved for a future control extension; carries no data today. Reserved and advertised now
 * for the same reason as {@link LEDGER_HEAD_EXTENSION_TYPE}: RFC 9420 requires every member
 * leaf to advertise each custom GroupContext extension type it can carry, and leaves cannot be
 * rewritten — a type introduced after members join can never be installed without re-admitting
 * everyone.
 */
export const RESERVED_EXTENSION_TYPE = 0xf102

const CURRENT_VERSION = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Genesis anchor baked into the MLS GroupContext at creation: the creator DID is the epoch-0
 * admin. Survives every epoch, authenticated by the GroupInfo signature, treated as immutable.
 */
export type GroupAnchor = {
  creatorDID: string
  version: number
  /**
   * Opaque consumer payload written once at creation; `@kumiai/mls` never reads or interprets
   * it. A consumer holding raw bytes must JSON-safe-encode them (e.g. base64) itself. Kubun
   * stores its recovery seed here.
   */
  app?: unknown
}

export function encodeGroupAnchor(anchor: GroupAnchor): Uint8Array {
  return encoder.encode(JSON.stringify(anchor))
}

/**
 * Tolerant decode: null on malformed bytes or wrong shape, never throws. `creatorDID` must be a
 * string and `version` a number; `app` is optional, so its absence isn't malformed. A consumer
 * needing a specific `app` shape validates that itself.
 *
 * Forward-compat gate: when `version > CURRENT_VERSION` (a future build wrote it), the returned
 * anchor keeps `creatorDID` and `version` but drops `app` — the opaque payload may carry semantics
 * this build has never seen, and a v1 consumer reading it as v1 (kubun keeps its recovery seed in
 * `app`) cannot tell. `version` is preserved so a consumer distinguishes "future version, app
 * withheld" from "genuinely no app". Contract this rests on: a `version` bump means `app` semantics
 * changed and nothing else; any future control-relevant field must go in a new extension type, never
 * inside the anchor where a version-tolerant older peer would silently ignore it.
 */
export function decodeGroupAnchor(bytes: Uint8Array): GroupAnchor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object') {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.creatorDID !== 'string' || typeof record.version !== 'number') {
    return null
  }
  const anchor: GroupAnchor = { creatorDID: record.creatorDID, version: record.version }
  // Withhold the app payload from a future build's anchor: a version this build
  // has never seen may carry a payload with v2 semantics, and handing it to a
  // consumer under v1 expectations is exactly the silent misread this guards.
  // The structural fields (creatorDID, version) stay usable, so the member still
  // joins — only the opaque payload it provably cannot interpret is dropped.
  if (record.version <= CURRENT_VERSION && 'app' in record && record.app !== undefined) {
    anchor.app = record.app
  }
  return anchor
}

export function buildGroupAnchorExtension(anchor: GroupAnchor): GroupContextExtension {
  return makeCustomExtension({
    extensionType: GROUP_ANCHOR_EXTENSION_TYPE,
    extensionData: encodeGroupAnchor(anchor),
  })
}

/** Build the anchor extension for a freshly created group at the current version. */
export function buildCurrentGroupAnchorExtension(
  creatorDID: string,
  app?: unknown,
): GroupContextExtension {
  return buildGroupAnchorExtension({ creatorDID, version: CURRENT_VERSION, app })
}

/**
 * Leaf capabilities advertising all three control GroupContext extension types (genesis
 * anchor, ledger head, reserved). RFC 9420 requires every leaf to advertise each custom
 * extension type or `commitInvite` rejects it; all three are advertised now, before the latter
 * two carry data, so they can be grown later without re-admitting members. Pass at both
 * `createGroup` (creator leaf) and `createKeyPackageBundle` (invitee leaf).
 *
 * Idempotent: each type appears once even if the defaults already carry it.
 */
export function controlCapabilities(): Capabilities {
  const base = defaultCapabilities()
  const extensions = new Set<number>(base.extensions)
  extensions.add(GROUP_ANCHOR_EXTENSION_TYPE)
  extensions.add(LEDGER_HEAD_EXTENSION_TYPE)
  extensions.add(RESERVED_EXTENSION_TYPE)
  return { ...base, extensions: [...extensions] }
}

function findAnchorExtension(handle: GroupHandle): GroupContextExtension | undefined {
  return handle.state.groupContext.extensions.find(
    (ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
}

/**
 * The anchor's raw extension bytes, exactly as stored, or null if absent. Unlike
 * {@link readGroupAnchor} this doesn't decode — a GCE (group-context-extensions) proposal must
 * copy these verbatim, since it replaces the *entire* extension list and the commit policy
 * byte-compares the proposed anchor's `extensionData` against this. Re-encoding a decoded
 * {@link GroupAnchor} instead can fail that comparison on identical content (JSON key order,
 * number formatting, dropped `undefined` keys) — indistinguishable from tampering. Use these
 * bytes for round-tripping; the decoded anchor is for reading only.
 */
export function readGroupAnchorExtension(handle: GroupHandle): GroupContextExtension | null {
  return findAnchorExtension(handle) ?? null
}

/**
 * Read and decode the genesis anchor. Null only when genuinely absent; a present-but-
 * undecodable extension is corruption and throws, so a control gate fails closed instead of
 * silently downgrading (the anchor is authenticated by the GroupInfo signature, so this guards
 * corruption, not forgery). Use {@link readGroupAnchorExtension} for bytes to copy into a
 * proposal — never a re-encode of this result.
 *
 * A future-version anchor is not corruption: {@link decodeGroupAnchor} decodes it (dropping `app`),
 * so this returns a non-null anchor and the member joins. Only the payload a v1 build cannot
 * interpret is withheld.
 */
export function readGroupAnchor(handle: GroupHandle): GroupAnchor | null {
  const extension = findAnchorExtension(handle)
  if (extension == null) {
    return null
  }
  const data = extension.extensionData
  const anchor = data instanceof Uint8Array ? decodeGroupAnchor(data) : null
  if (anchor == null) {
    throw new Error('group anchor extension present but could not be decoded')
  }
  return anchor
}
