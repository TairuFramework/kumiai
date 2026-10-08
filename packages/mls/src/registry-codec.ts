import type { SignedEvent } from '@kokuin/controller'
import { canonicalStringify, fromUTF, toUTF } from '@sozai/codec'

import { DeviceRegistryCodecError } from './errors.js'
import type { ControllerProjection, DeviceRecord, DeviceRegistry } from './registry.js'

const DEVICE_REGISTRY_VERSION = 1

/** Local persistence format: version byte followed by canonical JSON with sorted map entries. */
export function encodeDeviceRegistry(registry: DeviceRegistry): Uint8Array {
  const sortedEntries = <Value>(map: ReadonlyMap<string, Value>) => {
    return [...map].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  }
  const body = fromUTF(
    canonicalStringify({
      devices: sortedEntries(registry.devices),
      controllers: sortedEntries(registry.controllers),
    }),
  )
  const bytes = new Uint8Array(body.length + 1)
  bytes[0] = DEVICE_REGISTRY_VERSION
  bytes.set(body, 1)
  return bytes
}

export function decodeDeviceRegistry(bytes: Uint8Array): DeviceRegistry {
  if (bytes.length === 0) {
    throw new DeviceRegistryCodecError({ message: 'decodeDeviceRegistry: truncated bytes' })
  }
  if (bytes[0] !== DEVICE_REGISTRY_VERSION) {
    throw new DeviceRegistryCodecError({
      message: `decodeDeviceRegistry: unsupported device-registry version ${bytes[0]}`,
    })
  }
  try {
    const value: unknown = JSON.parse(toUTF(bytes.subarray(1)))
    if (!isObject(value)) throw new TypeError('Expected a registry object')
    return {
      devices: decodeMap(value.devices, isDeviceRecord),
      controllers: decodeMap(value.controllers, isControllerProjection),
    }
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause to Error.
    throw new DeviceRegistryCodecError({
      message: 'decodeDeviceRegistry: invalid device-registry bytes',
      cause,
    })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  return (
    isObject(value) &&
    typeof value.controller === 'string' &&
    (value.status === 'active' || value.status === 'revoked') &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.logPosition === undefined || isNumber(value.logPosition)) &&
    (value.reason === undefined || value.reason === 'reset') &&
    (value.cascadedFrom === undefined || typeof value.cascadedFrom === 'string')
  )
}

function isSignedEvent(value: unknown): value is SignedEvent {
  if (!isObject(value) || !isObject(value.event)) return false
  const event = value.event
  // Retain event-specific fields verbatim; the lifecycle fold authenticates them.
  return (
    event.v === 1 &&
    typeof event.t === 'string' &&
    isNumber(event.g) &&
    isNumber(event.s) &&
    typeof event.crit === 'boolean' &&
    (event.i === undefined || typeof event.i === 'string') &&
    (event.p === undefined || typeof event.p === 'string') &&
    Array.isArray(value.sigs) &&
    value.sigs.every((signature: unknown) => typeof signature === 'string') &&
    (value.recoveryKey === undefined || typeof value.recoveryKey === 'string')
  )
}

function isControllerProjection(value: unknown): value is ControllerProjection {
  return (
    isObject(value) &&
    Array.isArray(value.recordedLog) &&
    value.recordedLog.every(isSignedEvent) &&
    isNumber(value.genFloor) &&
    isNumber(value.timeFloor) &&
    (value.beacon === undefined ||
      (isObject(value.beacon) &&
        isNumber(value.beacon.logLength) &&
        typeof value.beacon.headDigest === 'string'))
  )
}

function decodeMap<Value>(
  value: unknown,
  isValue: (entry: unknown) => entry is Value,
): Map<string, Value> {
  if (!Array.isArray(value)) throw new TypeError('Expected registry map entries')
  const map = new Map<string, Value>()
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      map.has(entry[0]) ||
      !isValue(entry[1])
    ) {
      throw new TypeError('Invalid registry map entry')
    }
    map.set(entry[0], entry[1])
  }
  return map
}
