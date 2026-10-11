import { describe, expect, test } from 'vitest'

import { throwIfAborted } from '../src/abort.js'

describe('throwIfAborted', () => {
  test('returns when the signal is undefined', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow()
  })

  test('returns when the signal is not aborted', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()
  })

  test.each([new Error('cancelled'), { cancelled: true }, 'cancelled', null])(
    'throws the identical abort reason %j',
    (reason) => {
      const controller = new AbortController()
      controller.abort(reason)
      let caught: unknown = Symbol('not thrown')
      try {
        throwIfAborted(controller.signal)
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(reason)
    },
  )

  test('throws an AbortError when an aborted signal has no reason', () => {
    const signal = { aborted: true, reason: undefined } as AbortSignal
    expect(() => throwIfAborted(signal)).toThrowError(
      Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
    )
  })
})
