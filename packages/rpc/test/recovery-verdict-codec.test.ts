import { expect, test } from 'vitest'

import { FrameTooLargeError } from '../src/frame-size.js'
import {
  decodeHandshakeFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import {
  decodeRecoveryConfirmRequest,
  decodeRecoveryVerdict,
  encodeRecoveryConfirmRequest,
  encodeRecoveryVerdict,
} from '../src/recovery.js'

test('confirmation requests and verdicts round trip with fixed handshake kinds', () => {
  const request = {
    requestID: 'request',
    request: new Uint8Array([1, 2]),
    position: 'position',
    commitDigest: 'digest',
  }
  expect(decodeRecoveryConfirmRequest(encodeRecoveryConfirmRequest(request))).toEqual(request)
  const longPosition = { ...request, position: 'p'.repeat(512) }
  expect(decodeRecoveryConfirmRequest(encodeRecoveryConfirmRequest(longPosition))).toEqual(
    longPosition,
  )
  const sealed = new Uint8Array([3, 4])
  expect(decodeRecoveryVerdict(encodeRecoveryVerdict('request', sealed))).toEqual({
    requestID: 'request',
    sealed,
  })
  expect(HANDSHAKE_VERSION).toBe(1)
  expect(HANDSHAKE_KIND.recoveryConfirmRequest).toBe(5)
  expect(HANDSHAKE_KIND.recoveryVerdict).toBe(6)
  expect(
    decodeHandshakeFrame(
      encodeHandshakeFrame(
        HANDSHAKE_KIND.recoveryVerdict,
        encodeRecoveryVerdict('request', sealed),
      ),
    ).kind,
  ).toBe(6)
  expect(() =>
    encodeHandshakeFrame(
      HANDSHAKE_KIND.recoveryVerdict,
      encodeRecoveryVerdict('request', new Uint8Array(786_432)),
    ),
  ).toThrow(FrameTooLargeError)
  const payload = encodeRecoveryConfirmRequest(request)
  for (let length = 0; length < payload.length - request.request.length; length++) {
    expect(() => decodeRecoveryConfirmRequest(payload.subarray(0, length))).toThrow()
  }
})
