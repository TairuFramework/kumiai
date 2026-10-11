export function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    : signal.reason
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw getAbortReason(signal)
}
