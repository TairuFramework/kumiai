import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { type GroupContextExtension, makeCustomExtension } from 'ts-mls'

import { LEDGER_HEAD_EXTENSION_TYPE } from './anchor.js'
import type { GroupHandle } from './group.js'

/** Binary version tag for the encoded ledger-head extension. */
export const LEDGER_HEAD_VERSION = 1

/**
 * Domain separator mixed into every genesis head so a head can never collide
 * with a raw SHA-256 of unrelated data (e.g. a bare group id, or another
 * protocol's digest of the same bytes). Fixed, non-empty, and namespaced to
 * this module and version.
 */
const DOMAIN = new TextEncoder().encode('kumiai/mls/ledger-head/v1')

const utf8 = new TextEncoder()

const SHA256_LENGTH = 32

/** The parsed ledger-head extension: a version and the running chain digest. */
export type LedgerHead = { v: number; head: Uint8Array }

/**
 * Thrown when a joiner's recomputed head does not match the authenticated one:
 * an inviter omitted, reordered, or truncated a ledger entry. Carries both heads
 * so a caller can log the mismatch. Thrown by the joiner's verification path in
 * a later step; here it backs {@link assertHeadMatches}.
 */
export class LedgerIncompleteError extends Error {
  #expected: Uint8Array
  #actual: Uint8Array

  constructor(expected: Uint8Array, actual: Uint8Array) {
    super('recomputed ledger head does not match the authenticated head')
    this.name = 'LedgerIncompleteError'
    this.#expected = expected
    this.#actual = actual
  }

  /** The authenticated head read from the group's GroupContext. Named apart from
   *  `expected`/`actual` on purpose: a test runner's diff formatter assigns those
   *  two properties on any thrown Error, and a getter-only pair turns an
   *  unexpected throw into a `Cannot set property` TypeError instead of the real
   *  failure. */
  get expectedHead(): Uint8Array {
    return this.#expected
  }

  /** The head recomputed from the entries the inviter supplied. */
  get actualHead(): Uint8Array {
    return this.#actual
  }
}

/**
 * Length-frame one entry id: a 4-byte big-endian length prefix before the id's
 * UTF-8 bytes. The prefix makes the chain unambiguous about id boundaries, so
 * `['ab','c']` and `['a','bc']` cannot fold to the same head.
 */
function frameID(id: string): Uint8Array {
  const bytes = utf8.encode(id)
  const framed = new Uint8Array(4 + bytes.length)
  const view = new DataView(framed.buffer)
  view.setUint32(0, bytes.length, false)
  framed.set(bytes, 4)
  return framed
}

/**
 * Genesis head for a group: `SHA256(DOMAIN ‖ groupID)`. Pure. The epoch-0 link
 * of the chain, written into the GroupContext by group creation.
 */
export function genesisHead(groupID: string): Uint8Array {
  return sha256(concatBytes(DOMAIN, utf8.encode(groupID)))
}

/**
 * Extend a head by a batch of entry ids, in envelope order. Each id is a chain
 * link: `head ← SHA256(head ‖ frame(id))`, folded left to right. Pure,
 * order-sensitive, and length-sensitive (see {@link frameID}). An empty batch is
 * a no-op — a commit carrying no entries does not move the head.
 */
export function extendHead(head: Uint8Array, entryIDs: Array<string>): Uint8Array {
  let acc = head
  for (const id of entryIDs) {
    acc = sha256(concatBytes(acc, frameID(id)))
  }
  return acc
}

/**
 * Recompute a head from genesis across an ordered id list. Pure. Composes with
 * {@link extendHead}: `computeHead(g, [...a, ...b])` equals
 * `extendHead(extendHead(genesisHead(g), a), b)`, so an existing member verifies
 * a head update by extending its own chain — never by refolding from genesis.
 */
export function computeHead(groupID: string, entryIDs: Array<string>): Uint8Array {
  return extendHead(genesisHead(groupID), entryIDs)
}

/**
 * Encode a head as the LedgerHead GroupContext extension data: one version byte
 * (`LEDGER_HEAD_VERSION`) followed by the 32 digest bytes. A single canonical
 * byte form — no JSON — so the value can be byte-compared in the commit policy.
 */
export function encodeLedgerHead(head: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(1 + head.length)
  bytes[0] = LEDGER_HEAD_VERSION
  bytes.set(head, 1)
  return bytes
}

/**
 * Tolerant decode: returns null on any wrong length or unknown version byte,
 * never throws. Only a version-`LEDGER_HEAD_VERSION`, `1 + 32`-byte buffer
 * decodes.
 */
export function decodeLedgerHead(bytes: Uint8Array): LedgerHead | null {
  if (bytes.length !== 1 + SHA256_LENGTH || bytes[0] !== LEDGER_HEAD_VERSION) {
    return null
  }
  return { v: LEDGER_HEAD_VERSION, head: bytes.slice(1) }
}

/** Build the ledger-head GroupContext extension for a head digest. */
export function buildLedgerHeadExtension(head: Uint8Array): GroupContextExtension {
  return makeCustomExtension({
    extensionType: LEDGER_HEAD_EXTENSION_TYPE,
    extensionData: encodeLedgerHead(head),
  })
}

function findHeadExtension(handle: GroupHandle): GroupContextExtension | undefined {
  return handle.state.groupContext.extensions.find(
    (ext) => ext.extensionType === LEDGER_HEAD_EXTENSION_TYPE,
  )
}

/**
 * The head's raw GroupContext extension, exactly as it sits in the group, or
 * null when genuinely absent. Never throws. Mirrors
 * {@link readGroupAnchorExtension}: it does not decode — it is the source of the
 * verbatim bytes a group-context-extensions proposal must copy and the commit
 * policy byte-compares.
 */
export function readLedgerHeadExtension(handle: GroupHandle): GroupContextExtension | null {
  return findHeadExtension(handle) ?? null
}

/**
 * Read and decode the ledger head from a group handle. Returns null only when
 * the head extension is genuinely absent. A present-but-undecodable extension is
 * corruption, not absence, and throws — so a control gate fails closed rather
 * than silently treating a tampered head as no head. For bytes to byte-compare
 * or copy into a proposal, use {@link readLedgerHeadExtension}, never a
 * re-encode of this result.
 */
export function readLedgerHead(handle: GroupHandle): LedgerHead | null {
  const extension = findHeadExtension(handle)
  if (extension == null) {
    return null
  }
  const data = extension.extensionData
  const head = data instanceof Uint8Array ? decodeLedgerHead(data) : null
  if (head == null) {
    throw new Error('ledger head extension present but could not be decoded')
  }
  return head
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * Whether a recomputed head equals the authenticated one. The predicate form of
 * {@link assertHeadMatches} — one comparison, two entry points: a gate that must
 * fail closed throws, a local invariant check reads the boolean.
 */
export function headsMatch(expected: Uint8Array, actual: Uint8Array): boolean {
  return bytesEqual(expected, actual)
}

/**
 * Assert a recomputed head matches the authenticated one, or throw
 * {@link LedgerIncompleteError} carrying both. Returns for equal heads.
 */
export function assertHeadMatches(expected: Uint8Array, actual: Uint8Array): void {
  if (!headsMatch(expected, actual)) {
    throw new LedgerIncompleteError(expected, actual)
  }
}
