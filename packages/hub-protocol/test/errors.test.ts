import { describe, expect, test } from 'vitest'

import {
  HUB_ERROR_CODES,
  hubErrorCodeOf,
  hubErrorFromCode,
  InvalidPayloadError,
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
