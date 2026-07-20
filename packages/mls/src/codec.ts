import {
  type ClientState,
  clientStateDecoder,
  clientStateEncoder,
  decode,
  encode,
  type RatchetTree,
} from 'ts-mls'

export type { ClientState }

/**
 * The client-state blob's format version, first byte.
 *
 * This code is the only reader this blob ever has: `encodeClientState` and `decodeClientState`
 * are one process serializing its own state to itself (to disk, to storage, wherever), never a
 * wire format another peer or another build reads. So there is no peer to stay compatible with —
 * an unknown version is refused outright, not migrated.
 *
 * It buys diagnosis, not compatibility. There is no version of this a v1 build can read, and a
 * format change is a flag day whatever this byte says. What it changes is that the failure reads
 * as "this blob is v2 and I speak v1" rather than an opaque decode failure indistinguishable from
 * truncated bytes or a corrupted store.
 */
const CLIENT_STATE_VERSION = 1

export function decodeClientState(encoded: Uint8Array): ClientState | undefined {
  // encoded[0] is `undefined` on an empty array, which already fails this check — no
  // separate empty-input guard needed.
  if (encoded[0] !== CLIENT_STATE_VERSION) return undefined
  return decode(clientStateDecoder, encoded.subarray(1))
}

export function encodeClientState(state: ClientState): Uint8Array {
  const body = encode(clientStateEncoder, state)
  const out = new Uint8Array(1 + body.length)
  out[0] = CLIENT_STATE_VERSION
  out.set(body, 1)
  return out
}

export function sanitizeRatchetTree(tree: ReadonlyArray<unknown>): RatchetTree {
  return tree.map((node) => (node == null ? undefined : node)) as RatchetTree
}
