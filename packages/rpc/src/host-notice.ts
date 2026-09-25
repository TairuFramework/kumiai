export function notifyHost<T>(
  callback: ((value: T) => void | Promise<void>) | undefined,
  value: T,
): void {
  if (callback == null) return
  try {
    const result = callback(value)
    if (result != null && typeof (result as Promise<void>).then === 'function') {
      ;(result as Promise<void>).then(undefined, () => {})
    }
  } catch {
    // An observer cannot change a lane outcome.
  }
}
