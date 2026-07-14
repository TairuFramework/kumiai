import { fromUTF, toUTF } from '@sozai/codec'

import { decodeLedgerEntries, encodeLedgerEntries } from './ledger-entries.js'

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
 * The ledger gather is the same rendezvous in the other direction: a peer that rejoined by
 * external commit holds an authenticated ledger head and no entries, so it asks for the whole
 * ordered ledger and checks the answer against that head.
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

export function encodeLedgerRequest(requestID: string): Uint8Array {
  return encodeWithRequestID(requestID, new Uint8Array(), 'ledger request')
}

export function decodeLedgerRequest(payload: Uint8Array): { requestID: string } {
  const { requestID } = decodeWithRequestID(payload, 'ledger request')
  return { requestID }
}

/**
 * A responder's whole ordered ledger. The order is carried, and it is load-bearing: the head
 * is a chain digest, so a permuted list of the same tokens folds to a different head and the
 * requester rejects it.
 */
export function encodeLedgerReply(requestID: string, tokens: Array<string>): Uint8Array {
  return encodeWithRequestID(requestID, encodeLedgerEntries(tokens), 'ledger reply')
}

export function decodeLedgerReply(payload: Uint8Array): {
  requestID: string
  tokens: Array<string>
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'ledger reply')
  return { requestID, tokens: decodeLedgerEntries(rest) }
}
