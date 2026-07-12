/**
 * A FIFO async serializer: `run` executes its callbacks one at a time, in the
 * order they were called. A callback's rejection is delivered to its own caller
 * but never stalls or poisons the queue for later callbacks — the chain always
 * advances. Order is not reprioritized: callers rely on it to preserve causal
 * order (e.g. the epoch at which an MLS message is produced).
 *
 * Deliberately dependency-free and generic, so it can move to `@sozai/async`
 * unchanged; this package's only per-instance glue is a WeakMap keyed by handle.
 */
export type Mutex = {
  run: <T>(fn: () => Promise<T>) => Promise<T>
}

export function createMutex(): Mutex {
  let chain: Promise<unknown> = Promise.resolve()
  const noop = (): void => {}
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = chain.then(fn, fn)
      chain = result.then(noop, noop)
      return result
    },
  }
}
