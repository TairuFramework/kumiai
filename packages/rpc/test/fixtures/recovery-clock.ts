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

/** Drain actual protocol work without letting a polling helper spend deadline time. */
export async function drainUntil(done: () => boolean) {
  while (!done()) {
    await vi.advanceTimersByTimeAsync(0)
    await setImmediate()
  }
}
