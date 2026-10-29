import { type ControllerLog, isControllerLog, isEpochEventShape } from '@kokuin/controller'
import { canonicalStringify, fromUTF, toUTF } from '@sozai/codec'

import { hasChainRevoke } from './controller-log.js'
import { DeviceRegistryCodecError } from './errors.js'
import type { RemovedMember } from './member-root.js'
import type { ControllerProjection, DeviceRecord, DeviceRegistry } from './registry.js'

const DEVICE_REGISTRY_VERSION = 1

/** Local persistence format: version byte followed by canonical JSON with sorted map entries. */
export function encodeDeviceRegistry(registry: DeviceRegistry): Uint8Array {
  const sortedEntries = <Value>(map: ReadonlyMap<string, Value>) => {
    return [...map].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  }
  for (const record of registry.devices.values()) {
    if (!isDeviceRecord(record))
      throw new DeviceRegistryCodecError({ message: 'encodeDeviceRegistry: invalid device record' })
  }
  const body = fromUTF(
    canonicalStringify({
      devices: sortedEntries(registry.devices),
      controllers: sortedEntries(registry.controllers).map(([did, projection]) => [
        did,
        {
          ...projection,
          recordedLog: projection.recordedLog?.chain,
          recordedEvents: projection.recordedLog?.events,
          attestations: sortedEntries(projection.attestations),
          removedMembers: sortedEntries(projection.removedMembers),
          survivorGrants: sortedEntries(projection.survivorGrants),
        },
      ]),
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
      controllers: new Map(
        [...decodeMap(value.controllers, isObject)].map(([did, projection]) => [
          did,
          decodeControllerProjection(projection),
        ]),
      ),
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
    Reflect.ownKeys(value).every((key) =>
      ['controller', 'status', 'label', 'proofRef', 'reason', 'cascadedFrom'].includes(key as string),
    ) &&
    typeof value.controller === 'string' &&
    (value.status === 'active' || value.status === 'revoked') &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.proofRef === undefined || isProofRef(value.proofRef)) &&
    (value.reason === undefined || value.reason === 'reset') &&
    (value.cascadedFrom === undefined || typeof value.cascadedFrom === 'string')
  )
}

function isSignedChainEvent(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.event)) return false
  const event = value.event
  return (
    event.v === 1 &&
    typeof event.t === 'string' &&
    event.t !== 'rev' &&
    isNumber(event.g) &&
    isNumber(event.s) &&
    typeof event.crit === 'boolean' &&
    (event.i === undefined || typeof event.i === 'string') &&
    (event.p === undefined || typeof event.p === 'string') &&
    Array.isArray(value.sigs) &&
    value.sigs.every((sig: unknown) => typeof sig === 'string') &&
    (value.recoveryKey === undefined || typeof value.recoveryKey === 'string')
  )
}

function decodeControllerProjection(value: Record<string, unknown>): ControllerProjection {
  if (
    !isNumber(value.genFloor) ||
    !isNumber(value.timeFloor) ||
    (value.beacon !== undefined &&
      !(
        isObject(value.beacon) &&
        isNumber(value.beacon.logLength) &&
        typeof value.beacon.headDigest === 'string'
      ))
  )
    throw new TypeError('Invalid controller projection')
  let recordedLog: ControllerLog | undefined
  if (value.recordedLog !== undefined || value.recordedEvents !== undefined) {
    const log = { chain: value.recordedLog, events: value.recordedEvents }
    if (
      !isControllerLog(log) ||
      hasChainRevoke(log.chain) ||
      !log.chain.every(isSignedChainEvent) ||
      !log.events.every(isEpochEventShape)
    )
      throw new TypeError('Invalid recorded log')
    recordedLog = log
  }
  return {
    ...(recordedLog === undefined ? {} : { recordedLog }),
    genFloor: value.genFloor,
    timeFloor: value.timeFloor,
    attestations: decodeMap(value.attestations, isNumber),
    removedMembers: decodeMap(value.removedMembers, (member): member is RemovedMember => {
      return (
        isObject(member) &&
        typeof member.did === 'string' &&
        isNumber(member.gen) &&
        isProofRef(member.proofRef)
      )
    }),
    survivorGrants: decodeMap(
      value.survivorGrants,
      (grant): grant is string => typeof grant === 'string',
    ),
    ...(value.beacon === undefined
      ? {}
      : { beacon: value.beacon as ControllerProjection['beacon'] }),
  }
}

function isProofRef(value: unknown): boolean {
  return (
    isObject(value) &&
    ((isNumber(value.chainIndex) && Object.keys(value).length === 1) ||
      (isNumber(value.snapshot) && Object.keys(value).length === 1) ||
      (typeof value.event === 'string' &&
        Object.keys(value).every((key) => key === 'event' || key === 'epoch') &&
        (value.epoch === undefined || typeof value.epoch === 'string')))
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
