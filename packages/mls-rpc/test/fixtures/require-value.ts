export function requireValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing required fixture value')
  return value
}
