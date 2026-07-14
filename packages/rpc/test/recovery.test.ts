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

  test('a ledger reply round-trips the whole ordered ledger', () => {
    const tokens = ['role:bob=admin', 'circle:x=Foo', 'circle:x=Bar']
    const decoded = decodeLedgerReply(encodeLedgerReply('req-2', tokens))
    expect(decoded.requestID).toBe('req-2')
    // ORDER is carried, and it is load-bearing: the head is a chain digest, so the same
    // tokens in another order fold to another head and the requester rejects them.
    expect(decoded.tokens).toEqual(tokens)
    expect(decodeLedgerRequest(encodeLedgerRequest('req-2'))).toEqual({ requestID: 'req-2' })
  })
})
