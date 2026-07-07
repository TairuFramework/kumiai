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
})
