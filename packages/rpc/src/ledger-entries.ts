import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from './crypto.js'

/**
 * The blob a commit frame carries: the signed control-ledger tokens the Commit enacts, sealed
 * with `GroupCrypto.sealEntries` under a key derived from the epoch the Commit is framed at (the
 * epoch every peer that can apply it holds). The hub sees only the sealed bytes, never a body.
 *
 *   [ VERSION(1) | count(2, LE) | (tokenLength(4, LE) | token utf8)... ]
 *
 * This module is the ONLY place a commit frame's blob is opened, via a resolver that runs only
 * when the MLS port asks for the bodies of a commit it is applying. Opening is a consequence
 * of "I can apply this frame", never a precondition of reading it.
 */

/**
 * Current ledger-entry blob format version.
 *
 * Unversioned, this format degrades tolerably only by ACCIDENT: the resolver's `catch` turns a
 * mis-parse into an empty answer, which the lane files as poison. That is an accident and not a
 * contract — nothing stops a later layout from parsing as a plausible token list under today's
 * rules — so the version byte makes the refusal a decision instead of a lucky one.
 *
 * An unknown version is REFUSED here, distinguishably. It does not heal: the blob rides INSIDE a
 * commit frame, and it is the handshake header the lane reads first that carries the heal rule.
 */
export const LEDGER_ENTRIES_VERSION = 1

const VERSION_BYTES = 1
const COUNT_BYTES = 2
const HEADER_BYTES = VERSION_BYTES + COUNT_BYTES
const LENGTH_BYTES = 4

/** Encode the signed tokens a Commit enacts, for sealing into its frame. */
export function encodeLedgerEntries(tokens: Array<string>): Uint8Array {
  const encoded = tokens.map((token) => fromUTF(token))
  const size = encoded.reduce((total, bytes) => total + LENGTH_BYTES + bytes.length, HEADER_BYTES)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = LEDGER_ENTRIES_VERSION
  view.setUint16(VERSION_BYTES, encoded.length, true)
  let offset = HEADER_BYTES
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, true)
    out.set(bytes, offset + LENGTH_BYTES)
    offset += LENGTH_BYTES + bytes.length
  }
  return out
}

/**
 * Decode the signed tokens sealed into a commit frame. Throws on bytes that are not a list, and
 * on a version this build does not know.
 */
export function decodeLedgerEntries(bytes: Uint8Array): Array<string> {
  if (bytes.length < HEADER_BYTES) {
    throw new Error('ledger entry blob is too short')
  }
  const version = bytes[0]
  if (version !== LEDGER_ENTRIES_VERSION) {
    throw new Error(`unsupported ledger entry blob version: ${version}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(VERSION_BYTES, true)
  const tokens: Array<string> = []
  let offset = HEADER_BYTES
  for (let i = 0; i < count; i++) {
    if (offset + LENGTH_BYTES > bytes.length) {
      throw new Error('ledger entry blob is truncated')
    }
    const length = view.getUint32(offset, true)
    const start = offset + LENGTH_BYTES
    if (start + length > bytes.length) {
      throw new Error('ledger entry blob is truncated')
    }
    tokens.push(toUTF(bytes.subarray(start, start + length)))
    offset = start + length
  }
  return tokens
}

/**
 * A ledger-entry resolver over the blob of the commit frame being applied. The MLS port calls
 * it with the ids the Commit's control envelope names; it answers with the bodies sealed into
 * that same frame — making body delivery atomic with the commit, so first delivery cannot
 * strand.
 *
 * Answers with every token in the blob, not just the named subset: tokens are
 * content-addressed, so the caller binds each body to its id by digesting, and an unrequested
 * body is ignored. A responder can fail to answer, never inject.
 *
 * A blob this peer cannot open yields NO entries, not an error: the commit fails to resolve and
 * the port raises missing-entries, never corruption. THE OPEN GETS EXACTLY ONE ATTEMPT — the lane
 * files that commit as poison, advances the cursor over it and never re-reads it (`peer.ts`, the
 * `isMissingLedgerEntries` branch of the walk). So this must not be used to absorb a failure that
 * a retry would fix: there is no retry. In practice it should not arise at all on the apply path,
 * since the port asks only for a commit it is applying, framed at this peer's epoch, which is the
 * epoch the blob is sealed under.
 *
 * The `catch` is deliberately narrow about what it means and deliberately blind to which of three
 * things happened: the AEAD refused the bytes, the plaintext did not decode as an entry list, or
 * the blob genuinely lacked the ids. Only the first is reachable by TAMPERING — a hub that flips
 * one byte turns that commit into poison for the targeted peer, silently and unattributably. The
 * cost is bounded and known: the peer skips the commit, the next one is framed ahead of it, and
 * the `ahead` disposition strands it into a rejoin that re-gathers the ledger. Nothing is
 * injected, because bodies are content-addressed and signature-verified downstream. But the
 * poison rule's justification — "a blob this peer cannot open is one no member at this epoch can"
 * — holds only for an honest hub, and this is where that assumption is spent.
 *
 * Opened with {@link GroupCrypto.openEntries} and NOT with `unwrap`, because this runs INSIDE the
 * MLS port's apply of the commit it is resolving for. `unwrap` consumes a ratchet generation and
 * mutates the handle; an open that does either is unsound while the handle is mid-apply, whatever
 * order it is scheduled in. `openEntries` derives its key from the epoch's exporter secret, so it
 * is pure and re-entrant and this resolver may be called from anywhere the epoch is right.
 */
export function createLedgerEntryResolver(
  sealedEntries: Uint8Array,
  openEntries: GroupCrypto['openEntries'],
): (ids: Array<string>) => Promise<Array<string>> {
  return async (_ids: Array<string>): Promise<Array<string>> => {
    try {
      // Body trust comes from the token's own signature + content-address, which the caller
      // re-verifies — not from the seal, which only buys confidentiality from the hub.
      return decodeLedgerEntries(await openEntries(sealedEntries))
    } catch {
      return []
    }
  }
}
