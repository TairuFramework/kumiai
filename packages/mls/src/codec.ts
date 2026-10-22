import {
  clientStateDecoder,
  clientStateEncoder,
  encode,
  type ClientState as MLSClientState,
  type RatchetTree,
} from 'ts-mls'

import { ClientStateReservationError } from './errors.js'

/** Local reservation evidence travels with every durable MLS checkpoint. */
export type ClientState = MLSClientState & {
  handshakeReservation?: { epoch: bigint; generation: number; consumed: boolean }
}

/** v2: flags, optional reservation, length-prefixed ts-mls body, then sorted leaf-zero refs.
 * Reservation fields are epoch (uint64), generation (uint32), consumed (uint8).
 * Body length, ref count and UTF-8 ref lengths are uint32. All integers are big-endian.
 * Refs ascend by JS string (UTF-16 code unit) ordering.
 * This is the only supported client-state format.
 */
const CLIENT_STATE_VERSION = 2
const RESERVATION_BYTES = 13
// Match ts-mls decode()'s default input limit, even though we call the decoder directly.
const MAX_BODY_BYTES = 64_000_000

export function decodeClientState(encoded: Uint8Array): ClientState | undefined {
  if (encoded.length === 0) return undefined
  // Unsupported versions remain distinguishable from malformed storage.
  if (encoded[0] !== CLIENT_STATE_VERSION) {
    throw new Error(`decodeClientState: unsupported client-state version ${encoded[0]}`)
  }
  const flags = encoded[1]
  if (flags !== 0 && flags !== 1) return undefined
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
  let offset = 2
  let reservation: ClientState['handshakeReservation']
  if (flags === 1) {
    if (encoded.length < offset + RESERVATION_BYTES || (encoded[14] !== 0 && encoded[14] !== 1))
      return undefined
    reservation = {
      epoch: view.getBigUint64(offset),
      generation: view.getUint32(offset + 8),
      consumed: encoded[14] === 1,
    }
    offset += RESERVATION_BYTES
  }
  const readLength = () => {
    if (encoded.length - offset < 4) return undefined
    const length = view.getUint32(offset)
    offset += 4
    return length
  }
  const bodyLength = readLength()
  if (
    bodyLength === undefined ||
    bodyLength > MAX_BODY_BYTES ||
    bodyLength > encoded.length - offset - 4
  ) {
    return undefined
  }
  // ts-mls secrets are views. Even Buffer inputs must be copied before ratcheting zeroes them.
  const bodyCopy = new Uint8Array(encoded.subarray(offset, offset + bodyLength))
  offset += bodyLength
  const refCount = readLength()
  if (refCount === undefined || refCount > Math.floor((encoded.length - offset) / 4)) {
    return undefined
  }
  try {
    const result = clientStateDecoder(bodyCopy, 0)
    if (result === undefined || result[1] !== bodyCopy.length) return undefined
    const state: ClientState = result[0]
    // rc.13 accepts invalid optional tags and elements extending past an inner vector boundary.
    const canonicalBody = encode(clientStateEncoder, state)
    if (
      canonicalBody.length !== bodyCopy.length ||
      !canonicalBody.every((byte, index) => byte === bodyCopy[index])
    ) {
      return undefined
    }
    const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let previousRef: string | undefined
    for (let index = 0; index < refCount; index++) {
      const refLength = readLength()
      if (refLength === undefined || refLength > encoded.length - offset) return undefined
      const ref = textDecoder.decode(encoded.subarray(offset, offset + refLength))
      offset += refLength
      if (previousRef !== undefined && ref <= previousRef) return undefined
      if (!Object.hasOwn(state.unappliedProposals, ref)) return undefined
      const proposal = state.unappliedProposals[ref]
      if (proposal === undefined || proposal.senderLeafIndex !== undefined) return undefined
      proposal.senderLeafIndex = 0
      previousRef = ref
    }
    if (offset !== encoded.length) return undefined
    if (reservation !== undefined) state.handshakeReservation = reservation
    return state
  } catch {
    return undefined
  }
}

export function encodeClientState(state: ClientState): Uint8Array {
  const reservation = state.handshakeReservation
  if (
    reservation != null &&
    (typeof reservation.epoch !== 'bigint' ||
      reservation.epoch < 0n ||
      reservation.epoch > 0xffffffffffffffffn ||
      !Number.isInteger(reservation.generation) ||
      reservation.generation < 0 ||
      reservation.generation > 0xffffffff)
  ) {
    throw new ClientStateReservationError()
  }
  const body = encode(clientStateEncoder, state)
  // rc.13 optionalEncoder drops numeric zero. Preserve only exact zero senders separately.
  const textEncoder = new TextEncoder()
  const refs = Object.keys(state.unappliedProposals)
    .filter((ref) => state.unappliedProposals[ref]?.senderLeafIndex === 0)
    .sort()
    .map((ref) => textEncoder.encode(ref))
  const header = reservation == null ? 2 : 2 + RESERVATION_BYTES
  const out = new Uint8Array(
    header + 8 + body.length + refs.reduce((length, ref) => length + 4 + ref.length, 0),
  )
  const view = new DataView(out.buffer)
  out[0] = CLIENT_STATE_VERSION
  out[1] = reservation == null ? 0 : 1
  if (reservation != null) {
    view.setBigUint64(2, reservation.epoch)
    view.setUint32(10, reservation.generation)
    out[14] = reservation.consumed ? 1 : 0
  }
  view.setUint32(header, body.length)
  out.set(body, header + 4)
  view.setUint32(header + 4 + body.length, refs.length)
  let offset = header + 8 + body.length
  for (const ref of refs) {
    view.setUint32(offset, ref.length)
    out.set(ref, offset + 4)
    offset += 4 + ref.length
  }
  return out
}

export function sanitizeRatchetTree(tree: ReadonlyArray<unknown>): RatchetTree {
  return tree.map((node) => (node == null ? undefined : node)) as RatchetTree
}
