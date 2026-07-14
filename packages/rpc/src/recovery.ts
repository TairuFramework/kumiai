import { fromUTF, toUTF } from '@sozai/codec'

/**
 * Payload codecs for the rendezvous carried on the handshake lane.
 *
 * A recovery request names a `requestID` — so replies correlate and redundant responders can
 * observe-and-suppress — and carries the port's own signed request blob, which the peer never
 * reads. The requester's identity, and the ephemeral key its reply must be sealed to, live
 * INSIDE that blob where the requester's signature covers them: a peer that put the DID in a
 * field of its own beside the token would be offering the responder an unsigned one to seal
 * against.
 *
 * The ledger gather is the same rendezvous in the other direction, and it carries the SAME
 * signed blob for the same two reasons. The topic is public and secretless: a request that
 * named no requester would be a request anyone could mint, and a reply that was not sealed
 * would put the group's whole ordered authority state — every role, every promotion, every
 * demotion — on a public topic in the clear. A peer that rejoined by external commit holds an
 * authenticated ledger head and no entries, so it asks for the whole ordered ledger, opens the
 * reply with the key minted for its own request, and checks what it finds against that head.
 */

/** Cap on decoded ID lengths — these become attacker-controlled map keys. */
const MAX_REQUEST_ID_BYTES = 128

function encodeWithRequestID(requestID: string, payload: Uint8Array, label: string): Uint8Array {
  const rid = fromUTF(requestID)
  if (rid.length > MAX_REQUEST_ID_BYTES) {
    throw new Error(`${label} requestID is too long`)
  }
  const out = new Uint8Array(2 + rid.length + payload.length)
  new DataView(out.buffer).setUint16(0, rid.length, true)
  out.set(rid, 2)
  out.set(payload, 2 + rid.length)
  return out
}

function decodeWithRequestID(
  payload: Uint8Array,
  label: string,
): { requestID: string; rest: Uint8Array } {
  if (payload.length < 2) {
    throw new Error(`${label} is too short`)
  }
  const ridLen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(
    0,
    true,
  )
  if (ridLen > MAX_REQUEST_ID_BYTES) {
    throw new Error(`${label} requestID is too long`)
  }
  if (payload.length < 2 + ridLen) {
    throw new Error(`${label} is truncated`)
  }
  return {
    requestID: toUTF(payload.subarray(2, 2 + ridLen)),
    rest: payload.subarray(2 + ridLen),
  }
}

export function encodeRecoveryRequest(requestID: string, request: Uint8Array): Uint8Array {
  return encodeWithRequestID(requestID, request, 'recovery request')
}

export function decodeRecoveryRequest(payload: Uint8Array): {
  requestID: string
  request: Uint8Array
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'recovery request')
  return { requestID, request: rest }
}

export function encodeRecoveryReply(requestID: string, groupInfo: Uint8Array): Uint8Array {
  return encodeWithRequestID(requestID, groupInfo, 'recovery reply')
}

export function decodeRecoveryReply(payload: Uint8Array): {
  requestID: string
  groupInfo: Uint8Array
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'recovery reply')
  return { requestID, groupInfo: rest }
}

/**
 * A ledger gather carries the port's signed request blob, exactly as a recovery request does
 * and for the same reason: it is what a responder authorizes against, and it is the only key
 * a responder will seal to. A request with no blob is a request from nobody, and every
 * responder refuses it.
 */
export function encodeLedgerRequest(requestID: string, request: Uint8Array): Uint8Array {
  return encodeWithRequestID(requestID, request, 'ledger request')
}

export function decodeLedgerRequest(payload: Uint8Array): {
  requestID: string
  request: Uint8Array
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'ledger request')
  return { requestID, request: rest }
}

/**
 * A responder's whole ordered ledger, SEALED to the ephemeral key inside the request it
 * answers. The lane carries the bytes and reads none of them: what is in there is the port's
 * business, and the hub's business is nothing.
 *
 * The order is carried inside the seal, and it is load-bearing: the head is a chain digest,
 * so a permuted list of the same tokens folds to a different head and the requester rejects it.
 */
export function encodeLedgerReply(requestID: string, sealed: Uint8Array): Uint8Array {
  return encodeWithRequestID(requestID, sealed, 'ledger reply')
}

export function decodeLedgerReply(payload: Uint8Array): {
  requestID: string
  sealed: Uint8Array
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'ledger reply')
  return { requestID, sealed: rest }
}
