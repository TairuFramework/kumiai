import { ErrorCodes } from '@enkaku/protocol'
import { AuthorizationDeniedError, KeyPackageQuotaExceededError } from '@kumiai/hub-protocol'
import { describe, expect, test } from 'vitest'

import { HubRefusedError, HubRetryableError, toRetryableOrThrow } from '../src/errors.js'

describe('toRetryableOrThrow', () => {
  test('a transport failure is retryable and carries no code', () => {
    const cause = new Error('socket closed')
    const error = toRetryableOrThrow(cause, 'status')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.stage).toBe('status')
    expect(error.code).toBeNull()
    expect(error.cause).toBe(cause)
  })

  test('a thrown non-Error is retryable', () => {
    const error = toRetryableOrThrow('nope', 'upload')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.code).toBeNull()
    expect(error.cause).toBe('nope')
  })

  // The path a host actually hits. `hub-client` is a pass-through wrapper, so a hub answer arrives
  // as an enkaku RequestError carrying the wire code — `constructor.name` is `RequestError`, `name`
  // is `'Error'`, and it is NOT an instance of the hub-protocol class. Identifying by `instanceof`
  // alone would class every refusal as retryable and retry it forever.
  test('a wire code identifies a refusal that matches neither class nor name', () => {
    const wire = Object.assign(new Error('denied'), { code: 'HUB_AUTHORIZATION_DENIED' })

    expect(() => toRetryableOrThrow(wire, 'status')).toThrow(HubRefusedError)
  })

  test('a wire code identifies a retryable answer too', () => {
    const wire = Object.assign(new Error('full'), { code: 'HUB_KEYPACKAGE_QUOTA' })
    const error = toRetryableOrThrow(wire, 'upload')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.code).toBe('HUB_KEYPACKAGE_QUOTA')
  })

  test('the real hub-protocol class is identified', () => {
    const error = toRetryableOrThrow(new KeyPackageQuotaExceededError('full'), 'upload')

    expect(error).toBeInstanceOf(HubRetryableError)
    expect(error.code).toBe('HUB_KEYPACKAGE_QUOTA')
  })

  // A host bundling two copies of hub-protocol breaks `instanceof`, and a rebuilt error may carry
  // only the name. Matching the name too is what keeps a refusal from becoming a retry loop.
  test('a foreign class carrying the right name is identified', () => {
    const foreign = new Error('denied')
    foreign.name = 'AuthorizationDeniedError'

    expect(() => toRetryableOrThrow(foreign, 'status')).toThrow(HubRefusedError)
  })

  test('a refusal carries its code and stage', () => {
    try {
      toRetryableOrThrow(new AuthorizationDeniedError('denied'), 'upload')
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(HubRefusedError)
      expect((error as HubRefusedError).code).toBe('HUB_AUTHORIZATION_DENIED')
      expect((error as HubRefusedError).stage).toBe('upload')
    }
  })

  test.each([
    ['EK02 access denied', ErrorCodes.ACCESS_DENIED],
    ['EK06 message too large', ErrorCodes.MESSAGE_TOO_LARGE],
    // Reachable today: the upload schema caps `keyPackages` at 50 and nothing validates `target`
    // against it, so a pool with `target: 200` would otherwise re-mint a doomed batch forever.
    ['EK08 invalid message', ErrorCodes.INVALID_MESSAGE],
  ])('%s is refused', (_name, code) => {
    const wire = Object.assign(new Error('rejected'), { code })

    expect(() => toRetryableOrThrow(wire, 'upload')).toThrow(HubRefusedError)
  })

  test.each([
    ['EK01 handler error', ErrorCodes.HANDLER_ERROR],
    ['EK03 controller limit', ErrorCodes.CONTROLLER_LIMIT],
    ['EK04 handler limit', ErrorCodes.HANDLER_LIMIT],
    ['EK05 timeout', ErrorCodes.TIMEOUT],
  ])('%s is retryable', (_name, code) => {
    const wire = Object.assign(new Error('busy'), { code })

    expect(toRetryableOrThrow(wire, 'status')).toBeInstanceOf(HubRetryableError)
  })

  test('an unrecognised code is retryable', () => {
    const wire = Object.assign(new Error('who knows'), { code: 'SOMETHING_NEW' })

    expect(toRetryableOrThrow(wire, 'status').code).toBe('SOMETHING_NEW')
  })
})
