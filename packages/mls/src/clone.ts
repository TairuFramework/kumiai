export function cloneData<T>(value: T): T {
  if (typeof value === 'function') throw new TypeError('cloneData: unsupported value')
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return new Uint8Array(value) as T
  if (Array.isArray(value)) return value.map((item: unknown) => cloneData(item)) as T

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('cloneData: unsupported value')
  }
  const copy = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneData(item)]),
  )
  if (prototype === null) Object.setPrototypeOf(copy, null)
  return copy as T
}
