import type { Capabilities, GroupContextExtension } from 'ts-mls'
import { defaultCapabilities, makeCustomExtension } from 'ts-mls'

import type { GroupHandle } from './group.js'

/**
 * MLS GroupContext extension type carrying the genesis anchor. A uint16 outside
 * the MLS default extension types (1–5) and clear of every reserved GREASE
 * value, so it can never collide with a ts-mls built-in or a probing extension.
 */
export const GROUP_ANCHOR_EXTENSION_TYPE = 0xf100

/**
 * MLS GroupContext extension type carrying the control-ledger head. Its update
 * logic arrives in a later step, but its type is reserved and advertised from
 * the outset (see {@link controlCapabilities}) so an anchored group can later
 * grow a head without every member's leaf being rejected.
 */
export const LEDGER_HEAD_EXTENSION_TYPE = 0xf101

/**
 * Reserved for a future control extension, carrying no data today.
 *
 * Reserved and advertised BEFORE it carries anything, for the same reason
 * {@link LEDGER_HEAD_EXTENSION_TYPE} was: RFC 9420 requires every member leaf to advertise
 * each custom GroupContext extension type, and leaves cannot be rewritten. A type introduced
 * after members have joined cannot be installed in their group at all — the only remedy is
 * re-admitting every member. Reserving costs one line now and is unavailable forever after.
 */
export const RESERVED_EXTENSION_TYPE = 0xf102

const CURRENT_VERSION = 1

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Genesis anchor baked into the MLS GroupContext at group creation: the creator
 * DID is the epoch-0 admin. It survives every epoch and is authenticated by the
 * GroupInfo signature, so every joiner reads the same value. Treated as
 * immutable for the lifetime of the group.
 */
export type GroupAnchor = {
  creatorDID: string
  version: number
  /**
   * Opaque consumer payload, written once at group creation. `@kumiai/mls`
   * never reads or interprets it — it is any JSON value the consumer chooses. A
   * consumer holding raw bytes encodes them to a JSON-safe form (e.g. base64)
   * itself; the anchor container is already JSON, so it does not double-encode.
   * Kubun stores its recovery seed here.
   */
  app?: unknown
}

/** Serialize an anchor to its GroupContext extension bytes. */
export function encodeGroupAnchor(anchor: GroupAnchor): Uint8Array {
  return encoder.encode(JSON.stringify(anchor))
}

/**
 * Tolerant decode: returns null on malformed bytes or wrong shape, never
 * throws. `creatorDID` must be a string and `version` a number; `app` is
 * optional and any JSON value, so an anchor without it is valid, not malformed.
 * (A consumer that requires a specific `app` shape enforces that in its own
 * decode of `app`, not here.)
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
  if ('app' in record && record.app !== undefined) {
    anchor.app = record.app
  }
  return anchor
}

/** Build the genesis-anchor GroupContext extension for an anchor value. */
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
 * Leaf-node capabilities advertising all three control GroupContext extension
 * types (genesis anchor, ledger head, and the reserved third type). RFC 9420
 * requires every member leaf to advertise each custom GroupContext extension
 * type, or `commitInvite` rejects the added leaf. All three are advertised from
 * the outset — even before the ledger head or the reserved type carry data —
 * so an anchored group can later grow a head, or install the reserved type,
 * without re-admitting members. Pass these at both `createGroup` (creator leaf)
 * and `createKeyPackageBundle` (invitee leaf) so a control group can be joined.
 *
 * Idempotent: each type appears exactly once even if the defaults already carry
 * it.
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
 * The anchor's raw GroupContext extension, exactly as it sits in the group, or
 * null when genuinely absent. Unlike {@link readGroupAnchor} this does not
 * decode — it is the source of the verbatim bytes a future group-context-
 * extensions (GCE) proposal must copy.
 *
 * A GCE proposal replaces the *entire* GroupContext extension list, so every
 * ledger-head update must re-include the anchor unchanged, and the receiving
 * commit policy byte-compares the proposed anchor's `extensionData` against its
 * own. Re-encoding a decoded {@link GroupAnchor} instead of copying these bytes
 * can make that comparison fail on identical content (JSON key order, number
 * formatting, dropped `undefined` keys) — an intermittent failure that looks
 * exactly like an anchor-tampering attack. The decoded anchor is for reading;
 * these bytes are for round-tripping.
 */
export function readGroupAnchorExtension(handle: GroupHandle): GroupContextExtension | null {
  return findAnchorExtension(handle) ?? null
}

/**
 * Read and decode the genesis anchor from a group handle. Returns null only
 * when the anchor extension is genuinely absent. A present-but-undecodable
 * extension is corruption, not absence, and throws — so a control gate reads it
 * as "anchor unreadable" and fails closed rather than silently downgrading. (The
 * anchor is written once at creation and authenticated by the GroupInfo
 * signature, so this is a corruption guard, not a forgery path.) For bytes to
 * copy into a proposal, use {@link readGroupAnchorExtension}, never a re-encode
 * of this result.
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
