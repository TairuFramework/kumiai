import { describe, expect, test } from 'vitest'

import { decodeRecoveryRequest, encodeRecoveryRequest } from '../src/recovery.js'

describe('recovery request codec', () => {
  test('round-trips requestID and requesterDID', () => {
    const bytes = encodeRecoveryRequest('req-1', 'did:key:alice')
    expect(decodeRecoveryRequest(bytes)).toEqual({
      requestID: 'req-1',
      requesterDID: 'did:key:alice',
    })
  })

  test('rejects an over-long requestID', () => {
    expect(() => encodeRecoveryRequest('x'.repeat(200), 'did:key:alice')).toThrow(/requestID/)
  })

  test('rejects an over-long requesterDID', () => {
    expect(() => encodeRecoveryRequest('req-1', 'x'.repeat(600))).toThrow(/requesterDID/)
  })

  test('rejects a truncated request buffer', () => {
    const valid = encodeRecoveryRequest('req-1', 'did:key:alice')
    // Drop the trailing requesterDID bytes so the declared didLen overruns the buffer.
    expect(() => decodeRecoveryRequest(valid.subarray(0, valid.length - 3))).toThrow()
  })
})
