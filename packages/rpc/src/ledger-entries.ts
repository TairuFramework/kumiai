import { fromUTF, toUTF } from '@sozai/codec'

import type { GroupCrypto } from './crypto.js'

/**
 * The blob a commit frame carries: the signed control-ledger tokens the Commit enacts, sealed
 * with `GroupCrypto.sealEntries` under a key derived from the epoch the Commit is framed at (the
 * epoch every peer that can apply it holds). The hub sees only the sealed bytes, never a body.
 *
 *   [ count(2, LE) | (tokenLength(4, LE) | token utf8)... ]
 *
 * This module is the ONLY place a commit frame's blob is opened, via a resolver that runs only
 * when the MLS port asks for the bodies of a commit it is applying. Opening is a consequence
 * of "I can apply this frame", never a precondition of reading it.
 */

const COUNT_BYTES = 2
const LENGTH_BYTES = 4

/** Encode the signed tokens a Commit enacts, for sealing into its frame. */
export function encodeLedgerEntries(tokens: Array<string>): Uint8Array {
  const encoded = tokens.map((token) => fromUTF(token))
  const size = encoded.reduce((total, bytes) => total + LENGTH_BYTES + bytes.length, COUNT_BYTES)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint16(0, encoded.length, true)
  let offset = COUNT_BYTES
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, true)
    out.set(bytes, offset + LENGTH_BYTES)
    offset += LENGTH_BYTES + bytes.length
  }
  return out
}

/** Decode the signed tokens sealed into a commit frame. Throws on bytes that are not a list. */
export function decodeLedgerEntries(bytes: Uint8Array): Array<string> {
  if (bytes.length < COUNT_BYTES) {
    throw new Error('ledger entry blob is too short')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(0, true)
  const tokens: Array<string> = []
  let offset = COUNT_BYTES
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
 * A blob this peer cannot open yields NO entries, not an error: the commit fails to resolve,
 * the port raises missing-entries, and the lane leaves the cursor put so the frame is re-read
 * — never reported as corruption. In practice this cannot arise on the apply path: the port
 * asks only for a commit it is applying, framed at this peer's epoch, the epoch the blob is
 * sealed under.
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
