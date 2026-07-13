import type { Unwrap } from '@kumiai/broadcast'
import { fromUTF, toUTF } from '@sozai/codec'

/**
 * The blob a commit frame carries: the signed control-ledger tokens the Commit enacts,
 * sealed with `GroupCrypto.wrap` under the epoch secret the Commit is framed at — the
 * epoch every peer that can apply the Commit is at. The hub sees only the sealed bytes,
 * and never a body.
 *
 *   [ count(2, LE) | (tokenLength(4, LE) | token utf8)... ]
 *
 * This module holds the ONLY place a commit frame's blob is opened, and it is a
 * resolver: it runs when the MLS port asks for the bodies of a commit it is applying,
 * and at no other time. Unwrapping is a consequence of "I can apply this frame", never a
 * precondition of reading it.
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
 * A ledger-entry resolver over the blob of the commit frame being applied. The MLS port
 * calls it with the ids the Commit's control envelope names, and it answers with the
 * bodies sealed into that same frame — which is what makes body delivery atomic with the
 * commit, and first-delivery stranding impossible rather than merely retryable.
 *
 * It answers with every token in the blob rather than the subset the ids name: a token is
 * content-addressed, so the caller binds each body to the id it asked for by digesting it,
 * and a body that matches no requested id is ignored. A responder can fail to answer,
 * never inject.
 *
 * A blob this peer cannot open yields NO entries, not an error: the commit then fails to
 * resolve what it names, the port raises its missing-entries error, and the lane leaves
 * the cursor where it is so the frame is read again. It is never reported as corruption.
 * In practice this does not arise on the apply path at all — the port asks only for a
 * commit it is applying, and a commit it is applying is framed at the epoch this peer is
 * at, which is the epoch the blob is sealed under.
 */
export function createLedgerEntryResolver(
  sealedEntries: Uint8Array,
  unwrap: Unwrap,
): (ids: Array<string>) => Promise<Array<string>> {
  return async (_ids: Array<string>): Promise<Array<string>> => {
    try {
      const opened = await unwrap(sealedEntries)
      const payload = opened instanceof Uint8Array ? opened : opened.payload
      // The blob's authenticity is not what makes a body trustworthy: every token is
      // signed and content-addressed, and the caller re-verifies both. The seal buys
      // confidentiality from the hub, so the recovered sender is deliberately unused.
      return decodeLedgerEntries(payload)
    } catch {
      return []
    }
  }
}
