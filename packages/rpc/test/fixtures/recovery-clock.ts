import { setImmediate } from 'node:timers/promises'
import { onTestFinished, vi } from 'vitest'

/** Keep transport and reply jitter live; deadlines advance only when the test asks. */
export function controlRecoveryClock(replyDelayMs = 0) {
  const nativeTimeout = globalThis.setTimeout
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    shouldClearNativeTimers: true,
  })
  const timedTimeout = globalThis.setTimeout
  const timeout = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((callback, delay, ...args) => {
      return delay != null && delay <= replyDelayMs
        ? nativeTimeout(callback, delay, ...args)
        : timedTimeout(callback, delay, ...args)
    })
  onTestFinished(() => {
    timeout.mockRestore()
    vi.useRealTimers()
  })
}

/**
 * Drain protocol work without spending deadline time. `performance` stays real because
 * controlRecoveryClock does not fake it.
 */
export async function drainUntil(
  done: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 4000,
) {
  const startedAt = performance.now()
  while (!(await done())) {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`)
    }
    await vi.advanceTimersByTimeAsync(0)
    await setImmediate()
  }
}
