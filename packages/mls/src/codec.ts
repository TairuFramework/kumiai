import {
  clientStateDecoder,
  clientStateEncoder,
  decode,
  encode,
  type ClientState as MLSClientState,
  type RatchetTree,
} from 'ts-mls'

/** Local reservation evidence travels with every durable MLS checkpoint. */
export type ClientState = MLSClientState & {
  handshakeReservation?: { epoch: bigint; generation: number; consumed: boolean }
}

/** v1 stores bare ts-mls state. v3 prefixes epoch (uint64), generation (uint32),
 * and consumed (uint8) before that state. v1 has no evidence permitting reuse.
 * v2 belongs to an incompatible layout and is refused, as are unknown versions.
 * Older readers refuse v3.
 */
const CLIENT_STATE_VERSION = 1
const RESERVATION_STATE_VERSION = 3
const RESERVATION_BYTES = 13

export function decodeClientState(encoded: Uint8Array): ClientState | undefined {
  // Too short to hold the version byte is a TRUNCATED read, not a version this build does not
  // speak, and the two are separate diagnoses — the same split `@kumiai/mls-rpc`'s `openEntries`
  // makes ("not a sealed blob" before "unsupported blob version"). Without this guard `encoded[0]`
  // is `undefined` on an empty buffer, which falls into the version branch below and reports
  // "unsupported client-state version undefined": the loudest possible way to misdescribe an
  // empty store as a format from the future. Truncated bytes return `undefined`, as every other
  // truncated read here does.
  if (encoded.length === 0) return undefined
  // Distinguishable on purpose. `decode()` below returns `undefined` for malformed or
  // truncated bytes reaching `ts-mls`, and that stays `undefined` — but an unknown version
  // byte is not that kind of failure, so it throws instead of returning the same `undefined`
  // a decode failure would. Without this, a version mismatch and a corrupted store are the
  // same value of the same type and a caller cannot tell them apart.
  if (encoded[0] !== CLIENT_STATE_VERSION && encoded[0] !== RESERVATION_STATE_VERSION) {
    throw new Error(`decodeClientState: unsupported client-state version ${encoded[0]}`)
  }
  // A copy: ts-mls decodes secrets as views, and ratcheting zeroes consumed ones in place.
  if (encoded[0] === CLIENT_STATE_VERSION) return decode(clientStateDecoder, encoded.slice(1))
  if (encoded.length < 1 + RESERVATION_BYTES || (encoded[13] !== 0 && encoded[13] !== 1))
    return undefined
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
  const state = decode(clientStateDecoder, encoded.slice(1 + RESERVATION_BYTES))
  if (state == null) return undefined
  return {
    ...state,
    handshakeReservation: {
      epoch: view.getBigUint64(1),
      generation: view.getUint32(9),
      consumed: encoded[13] === 1,
    },
  }
}

export function encodeClientState(state: ClientState): Uint8Array {
  const body = encode(clientStateEncoder, state)
  const reservation = state.handshakeReservation
  const header = reservation == null ? 1 : 1 + RESERVATION_BYTES
  const out = new Uint8Array(header + body.length)
  out[0] = reservation == null ? CLIENT_STATE_VERSION : RESERVATION_STATE_VERSION
  if (reservation != null) {
    const view = new DataView(out.buffer)
    view.setBigUint64(1, reservation.epoch)
    view.setUint32(9, reservation.generation)
    out[13] = reservation.consumed ? 1 : 0
  }
  out.set(body, header)
  return out
}

export function sanitizeRatchetTree(tree: ReadonlyArray<unknown>): RatchetTree {
  return tree.map((node) => (node == null ? undefined : node)) as RatchetTree
}
