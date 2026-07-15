import { describe, expect, test } from 'vitest'

import {
  decodeLedgerReply,
  decodeLedgerRequest,
  decodeRecoveryRequest,
  encodeLedgerReply,
  encodeLedgerRequest,
  encodeRecoveryRequest,
} from '../src/recovery.js'

describe('rendezvous codecs', () => {
  test('a recovery request round-trips its id and the signed request it carries', () => {
    const request = new Uint8Array([1, 2, 3, 4])
    const decoded = decodeRecoveryRequest(encodeRecoveryRequest('req-1', request))
    expect(decoded.requestID).toBe('req-1')
    // The requester's DID and the key its reply is sealed to live INSIDE the signed blob,
    // where its signature covers them. The lane carries the bytes and reads none of them.
    expect(Array.from(decoded.request)).toEqual([1, 2, 3, 4])
  })

  test('rejects an over-long requestID', () => {
    expect(() => encodeRecoveryRequest('x'.repeat(200), new Uint8Array())).toThrow(/requestID/)
  })

  test('rejects a truncated request buffer', () => {
    const valid = encodeRecoveryRequest('req-1', new Uint8Array([9]))
    // Drop the bytes the declared requestID length claims, so it overruns the buffer.
    expect(() => decodeRecoveryRequest(valid.subarray(0, 3))).toThrow()
  })

  test('a ledger gather carries a signed request, and a sealed reply', () => {
    // The ledger is the group's whole authority state and the rendezvous topic is public, so
    // the lane carries bytes it cannot read in BOTH directions: the requester's signed blob —
    // which is what a responder authorizes against, and the only key it will seal to — and the
    // responder's sealed answer. Neither is a field this codec can look inside.
    const request = new Uint8Array([7, 7, 7])
    const decodedRequest = decodeLedgerRequest(encodeLedgerRequest('req-2', request))
    expect(decodedRequest.requestID).toBe('req-2')
    expect(Array.from(decodedRequest.request)).toEqual([7, 7, 7])

    const sealed = new Uint8Array([1, 2, 3, 4, 5])
    const decodedReply = decodeLedgerReply(encodeLedgerReply('req-2', sealed))
    expect(decodedReply.requestID).toBe('req-2')
    expect(Array.from(decodedReply.sealed)).toEqual([1, 2, 3, 4, 5])
  })
})
