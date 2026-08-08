import { describe, expect, test } from 'vitest'

import {
  AuthorizationDeniedError,
  HUB_ERROR_CODES,
  hubErrorCodeOf,
  hubErrorFromCode,
  InvalidPayloadError,
  KeyPackageFetchLimitError,
  KeyPackageQuotaExceededError,
  SubscriptionQuotaExceededError,
  WakeNotSupportedError,
} from '../src/errors.js'

describe('InvalidPayloadError', () => {
  test('has a stable code and round-trips through the wire code', () => {
    expect(HUB_ERROR_CODES.invalidPayload).toBe('HUB_INVALID_PAYLOAD')

    const error = new InvalidPayloadError('bad base64')
    expect(error.name).toBe('InvalidPayloadError')
    expect(hubErrorCodeOf(error)).toBe('HUB_INVALID_PAYLOAD')

    const rebuilt = hubErrorFromCode('HUB_INVALID_PAYLOAD', 'bad base64')
    expect(rebuilt).toBeInstanceOf(InvalidPayloadError)
    expect(rebuilt?.message).toBe('bad base64')
  })
})

describe('DoS-hardening hub errors round-trip through their wire codes', () => {
  const cases = [
    [
      new AuthorizationDeniedError('no'),
      HUB_ERROR_CODES.authorizationDenied,
      'AuthorizationDeniedError',
    ],
    [
      new KeyPackageQuotaExceededError('full'),
      HUB_ERROR_CODES.keyPackageQuota,
      'KeyPackageQuotaExceededError',
    ],
    [
      new SubscriptionQuotaExceededError('full'),
      HUB_ERROR_CODES.subscriptionQuota,
      'SubscriptionQuotaExceededError',
    ],
    [
      new KeyPackageFetchLimitError('slow down'),
      HUB_ERROR_CODES.keyPackageFetchLimit,
      'KeyPackageFetchLimitError',
    ],
  ] as const

  test.each(cases)('%o carries %s and rebuilds with name %s', (error, code, name) => {
    expect(hubErrorCodeOf(error)).toBe(code)
    const rebuilt = hubErrorFromCode(code, error.message)
    expect(rebuilt).toBeInstanceOf(Error)
    expect(rebuilt?.name).toBe(name)
    expect(rebuilt?.message).toBe(error.message)
  })
})

describe('WakeNotSupportedError', () => {
  test('crosses the wire as HUB_WAKE_NOT_SUPPORTED', () => {
    expect(hubErrorCodeOf(new WakeNotSupportedError('no wake'))).toBe(
      HUB_ERROR_CODES.wakeNotSupported,
    )
  })

  test('rebuilds from its code', () => {
    const rebuilt = hubErrorFromCode(HUB_ERROR_CODES.wakeNotSupported, 'no wake')
    expect(rebuilt).toBeInstanceOf(WakeNotSupportedError)
    expect(rebuilt?.message).toBe('no wake')
  })
})
