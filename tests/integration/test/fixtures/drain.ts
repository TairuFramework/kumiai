import { setImmediate } from 'node:timers/promises'
import { vi } from 'vitest'

/** Bounded below the 10 s integration test timeout so a missing event names what was awaited. */
export async function drainUntil(
  done: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 8000,
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
