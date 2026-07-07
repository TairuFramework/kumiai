import { fromUTF, toUTF } from '@sozai/codec'

/**
 * Payload codecs for the recovery rendezvous carried on the handshake lane. A
 * request names a `requestID` (so replies correlate and redundant responders can
 * observe-and-suppress) and the `requesterDID` the responder seals its reply to;
 * a reply echoes the `requestID` and carries the sealed GroupInfo.
 */

/** Cap on decoded ID lengths — these become attacker-controlled map keys. */
const MAX_REQUEST_ID_BYTES = 128
const MAX_REQUESTER_DID_BYTES = 512

export function encodeRecoveryRequest(requestID: string, requesterDID: string): Uint8Array {
  const rid = fromUTF(requestID)
  const did = fromUTF(requesterDID)
  if (rid.length > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery request requestID is too long')
  }
  if (did.length > MAX_REQUESTER_DID_BYTES) {
    throw new Error('recovery request requesterDID is too long')
  }
  const out = new Uint8Array(2 + rid.length + 2 + did.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, rid.length, true)
  out.set(rid, 2)
  view.setUint16(2 + rid.length, did.length, true)
  out.set(did, 2 + rid.length + 2)
  return out
}

export function decodeRecoveryRequest(payload: Uint8Array): {
  requestID: string
  requesterDID: string
} {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (payload.length < 2) {
    throw new Error('recovery request is too short')
  }
  const ridLen = view.getUint16(0, true)
  if (ridLen > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery request requestID is too long')
  }
  if (payload.length < 2 + ridLen + 2) {
    throw new Error('recovery request is truncated')
  }
  const requestID = toUTF(payload.subarray(2, 2 + ridLen))
  const didLen = view.getUint16(2 + ridLen, true)
  if (didLen > MAX_REQUESTER_DID_BYTES) {
    throw new Error('recovery request requesterDID is too long')
  }
  if (payload.length < 2 + ridLen + 2 + didLen) {
    throw new Error('recovery request is truncated')
  }
  const requesterDID = toUTF(payload.subarray(2 + ridLen + 2, 2 + ridLen + 2 + didLen))
  return { requestID, requesterDID }
}

export function encodeRecoveryReply(requestID: string, groupInfo: Uint8Array): Uint8Array {
  const rid = fromUTF(requestID)
  if (rid.length > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery reply requestID is too long')
  }
  const out = new Uint8Array(2 + rid.length + groupInfo.length)
  new DataView(out.buffer).setUint16(0, rid.length, true)
  out.set(rid, 2)
  out.set(groupInfo, 2 + rid.length)
  return out
}

export function decodeRecoveryReply(payload: Uint8Array): {
  requestID: string
  groupInfo: Uint8Array
} {
  if (payload.length < 2) {
    throw new Error('recovery reply is too short')
  }
  const ridLen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(
    0,
    true,
  )
  if (ridLen > MAX_REQUEST_ID_BYTES) {
    throw new Error('recovery reply requestID is too long')
  }
  if (payload.length < 2 + ridLen) {
    throw new Error('recovery reply is truncated')
  }
  return {
    requestID: toUTF(payload.subarray(2, 2 + ridLen)),
    groupInfo: payload.subarray(2 + ridLen),
  }
}
