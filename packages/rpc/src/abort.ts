export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason !== undefined) throw signal.reason
  throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
}
