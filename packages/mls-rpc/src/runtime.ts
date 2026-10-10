export function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export function anySignal(signals: Array<AbortSignal>): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  function dispose(): void {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
    listeners.clear()
  }
  for (const signal of signals) {
    if (controller.signal.aborted) break
    const abort = () => {
      dispose()
      controller.abort(signal.reason)
    }
    if (signal.aborted) abort()
    else if (!listeners.has(signal)) {
      listeners.set(signal, abort)
      signal.addEventListener('abort', abort)
    }
  }
  return { signal: controller.signal, dispose }
}
