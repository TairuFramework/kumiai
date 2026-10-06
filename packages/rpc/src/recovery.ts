import { fromUTF, toUTF } from '@sozai/codec'

/**
 * Payload codecs for the rendezvous carried on the handshake lane.
 *
 * A request names a `requestID` (reply correlation + responder observe-and-suppress) and carries
 * the port's signed request blob, which the peer never reads. Requester DID and the ephemeral
 * key its reply must be sealed to live INSIDE that signed blob, never in a peer-added field — a
 * field beside the token would offer the responder an unsigned DID to seal against.
 *
 * The ledger gather is the same rendezvous reversed and carries the SAME signed blob: the topic
 * is public and secretless, so an unnamed request is one anyone can mint, and an unsealed reply
 * puts the group's whole authority state in the clear.
 */

/** Cap on decoded ID lengths — these become attacker-controlled map keys. */
const MAX_REQUEST_ID_BYTES = 128
/** Confirmation position and digest prefixes are bounded only by the u16 length field. */
const MAX_CONFIRMATION_FIELD_BYTES = 0xffff

type EncodeWithRequestIDParams = {
  requestID: string
  payload: Uint8Array
  label: string
  maxBytes?: number
}

type RequestIDPrefixed = { requestID: string; rest: Uint8Array }

function encodeWithRequestID(params: EncodeWithRequestIDParams): Uint8Array {
  const { requestID, payload, label, maxBytes = MAX_REQUEST_ID_BYTES } = params
  const rid = fromUTF(requestID)
  if (rid.length > maxBytes) {
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
  maxBytes = MAX_REQUEST_ID_BYTES,
): RequestIDPrefixed {
  if (payload.length < 2) {
    throw new Error(`${label} is too short`)
  }
  const ridLen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(
    0,
    true,
  )
  if (ridLen > maxBytes) {
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
  return encodeWithRequestID({ requestID, payload: request, label: 'recovery request' })
}

export function decodeRecoveryRequest(payload: Uint8Array): {
  requestID: string
  request: Uint8Array
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'recovery request')
  return { requestID, request: rest }
}

export function encodeRecoveryReply(requestID: string, groupInfo: Uint8Array): Uint8Array {
  return encodeWithRequestID({ requestID, payload: groupInfo, label: 'recovery reply' })
}

export function decodeRecoveryReply(payload: Uint8Array): {
  requestID: string
  groupInfo: Uint8Array
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'recovery reply')
  return { requestID, groupInfo: rest }
}

/**
 * A ledger gather carries the port's signed request blob, as a recovery request does: it is
 * what a responder authorizes against and the only key it will seal to. A request with no blob
 * is from nobody, and every responder refuses it.
 */
export function encodeLedgerRequest(requestID: string, request: Uint8Array): Uint8Array {
  return encodeWithRequestID({ requestID, payload: request, label: 'ledger request' })
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
 * answers. The lane carries the bytes and reads none of them.
 *
 * Order is inside the seal and load-bearing: the head is a chain digest, so a permuted list of
 * the same tokens folds to a different head and the requester rejects it.
 */
export function encodeLedgerReply(requestID: string, sealed: Uint8Array): Uint8Array {
  return encodeWithRequestID({ requestID, payload: sealed, label: 'ledger reply' })
}

export function decodeLedgerReply(payload: Uint8Array): {
  requestID: string
  sealed: Uint8Array
} {
  const { requestID, rest } = decodeWithRequestID(payload, 'ledger reply')
  return { requestID, sealed: rest }
}

export type RecoveryConfirmRequest = {
  requestID: string
  request: Uint8Array
  position: string
  commitDigest: string
}

export function encodeRecoveryConfirmRequest(value: RecoveryConfirmRequest): Uint8Array {
  const label = 'recovery confirmation'
  const digestPrefixed = encodeWithRequestID({
    requestID: value.commitDigest,
    payload: value.request,
    label,
    maxBytes: MAX_CONFIRMATION_FIELD_BYTES,
  })
  const positionPrefixed = encodeWithRequestID({
    requestID: value.position,
    payload: digestPrefixed,
    label,
    maxBytes: MAX_CONFIRMATION_FIELD_BYTES,
  })
  return encodeWithRequestID({ requestID: value.requestID, payload: positionPrefixed, label })
}

export function decodeRecoveryConfirmRequest(payload: Uint8Array): RecoveryConfirmRequest {
  const outer = decodeWithRequestID(payload, 'recovery confirmation')
  const position = decodeWithRequestID(
    outer.rest,
    'recovery confirmation',
    MAX_CONFIRMATION_FIELD_BYTES,
  )
  const digest = decodeWithRequestID(
    position.rest,
    'recovery confirmation',
    MAX_CONFIRMATION_FIELD_BYTES,
  )
  if (digest.rest.length === 0) throw new Error('recovery confirmation has no signed request')
  return {
    requestID: outer.requestID,
    position: position.requestID,
    commitDigest: digest.requestID,
    request: digest.rest,
  }
}

export function encodeRecoveryVerdict(requestID: string, sealed: Uint8Array): Uint8Array {
  return encodeWithRequestID({ requestID, payload: sealed, label: 'recovery verdict' })
}

export type RecoveryVerdictFrame = { requestID: string; sealed: Uint8Array }

export function decodeRecoveryVerdict(payload: Uint8Array): RecoveryVerdictFrame {
  const { requestID, rest } = decodeWithRequestID(payload, 'recovery verdict')
  return { requestID, sealed: rest }
}
