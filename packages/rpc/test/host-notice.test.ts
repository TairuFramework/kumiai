import { describe, expect, test, vi } from 'vitest'

import { notifyHost } from '../src/host-notice.js'

describe('notifyHost', () => {
  test('ignores an absent callback', () => {
    expect(() => notifyHost(undefined, 'value')).not.toThrow()
  })

  test('calls the callback synchronously', () => {
    const callback = vi.fn()
    notifyHost(callback, 'value')
    expect(callback).toHaveBeenCalledWith('value')
  })

  test('swallows a synchronous throw', () => {
    const error = new Error('observer failed')
    expect(() =>
      notifyHost(() => {
        throw error
      }, 'value'),
    ).not.toThrow()
  })

  test('handles a rejected promise without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      notifyHost(() => Promise.reject(new Error('observer failed')), 'value')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
