export type Scope = { groupID: string | null; devicePackages: boolean }

export const groupNamespaces = new Set([
  'lifetime',
  'trust',
  'checkpoints',
  'state',
  'control',
  'anchor',
  'pending',
  'poison',
  'cursor',
  'outbox',
  'meta',
  'group-owner',
])
export const deviceNamespaces = new Set([
  'device',
  'device-owner',
  'device-package',
  'device-last-resort',
  'device-receipt',
  'device-cleanup',
  'device-restore',
])

export function belongs(namespace: string, key: string, scope: Scope): boolean {
  if (!groupNamespaces.has(namespace) && !deviceNamespaces.has(namespace)) return true
  let address: unknown
  try {
    address = JSON.parse(key)
  } catch {
    return false
  }
  if (
    !Array.isArray(address) ||
    address.length !== 3 ||
    typeof address[0] !== 'string' ||
    (address[1] !== null && (!Number.isSafeInteger(address[1]) || address[1] < 1)) ||
    typeof address[2] !== 'string'
  )
    return false
  return deviceNamespaces.has(namespace)
    ? scope.devicePackages && address[1] === null
    : scope.groupID !== null && address[0] === scope.groupID
}

export function cloneValue<TValue>(value: TValue): TValue {
  const copies = new Map<object, object>()
  function copyBuffer(buffer: ArrayBufferLike): ArrayBuffer {
    const existing = copies.get(buffer)
    if (existing !== undefined) return existing as ArrayBuffer
    const copy = new Uint8Array(buffer).slice().buffer
    copies.set(buffer, copy)
    return copy
  }
  function copy(value: unknown): unknown {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError('Unsupported memory row value')
    }
    if (typeof value !== 'object' || value === null) return value
    // Shared storage is accepted only through views, never as an exposed row value.
    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
      throw new TypeError('Unsupported memory row value')
    const existing = copies.get(value)
    if (existing !== undefined) return existing
    if (ArrayBuffer.isView(value)) {
      const buffer = copyBuffer(value.buffer)
      if (value instanceof DataView) {
        const view = new DataView(buffer, value.byteOffset, value.byteLength)
        copies.set(value, view)
        return view
      }
      const View = [
        Int8Array,
        Uint8Array,
        Uint8ClampedArray,
        Int16Array,
        Uint16Array,
        Int32Array,
        Uint32Array,
        ...(typeof Float16Array === 'undefined' ? [] : [Float16Array]),
        Float32Array,
        Float64Array,
        BigInt64Array,
        BigUint64Array,
      ].find((View) => value instanceof View)
      if (View === undefined) throw new TypeError('Unsupported memory row view')
      const view = new View(
        buffer,
        value.byteOffset,
        (value as unknown as { length: number }).length,
      )
      copies.set(value, view)
      return view
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype === ArrayBuffer.prototype) return copyBuffer(value as ArrayBuffer)
    if (prototype === Date.prototype) {
      const date = new Date((value as Date).getTime())
      copies.set(value, date)
      return date
    }
    if (prototype === Map.prototype) {
      const map = new Map<unknown, unknown>()
      copies.set(value, map)
      for (const [key, item] of value as Map<unknown, unknown>) map.set(copy(key), copy(item))
      return map
    }
    if (prototype === Set.prototype) {
      const set = new Set<unknown>()
      copies.set(value, set)
      for (const item of value as Set<unknown>) set.add(copy(item))
      return set
    }
    if (prototype === Object.prototype || prototype === null || Array.isArray(value)) {
      const object = Array.isArray(value) ? new Array(value.length) : Object.create(prototype)
      copies.set(value, object)
      for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === 'length') continue
        Object.defineProperty(object, key, {
          value: copy(Reflect.get(value, key)),
          enumerable: Object.prototype.propertyIsEnumerable.call(value, key),
          configurable: true,
          writable: true,
        })
      }
      return object
    }
    throw new TypeError('Unsupported memory row value')
  }
  return copy(value) as TValue
}
