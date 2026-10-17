import { type DeviceRegistry, decodeDeviceRegistry, encodeDeviceRegistry } from '@kumiai/mls'

import { SpentSetCorruptError } from './persistence-errors.js'
import type { AtRestCodec } from './persistence-types.js'

// Preserve provider error identity while recording guarded open/decoding refusal.
const storedOpenFailures = new WeakSet<object>()

export function isStoredOpenFailure(cause: unknown): boolean {
  return (
    cause !== null &&
    (typeof cause === 'object' || typeof cause === 'function') &&
    storedOpenFailures.has(cause)
  )
}

export type StoredAddress = {
  groupID: string
  incarnation: number | null
  namespace: string
  recordID: string
}

export function recordAAD(address: StoredAddress): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'kumiai/at-rest/v1',
      address.groupID,
      address.incarnation,
      address.namespace,
      address.recordID,
    ]),
  )
}

// Namespaces own separate maps; each key binds the remaining address components.
export function physicalRecordKey(address: StoredAddress): string {
  return JSON.stringify([address.groupID, address.incarnation, address.recordID])
}

export async function topicLocator(topicID: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(topicID)),
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

type Node =
  | ['undefined']
  | ['scalar', string | number | boolean | null]
  | ['number', 'NaN' | 'Infinity' | '-Infinity' | '-0']
  | ['bigint', string]
  | ['bytes', Array<number>]
  | ['array', Array<Node>]
  | ['object', Array<[string, Node]>]
  | ['map', Array<[Node, Node]>]

function encodeNode(value: unknown, ancestors: Set<object>): Node {
  if (value === undefined) return ['undefined']
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return ['scalar', value]
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return ['number', '-0']
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (value === Number.POSITIVE_INFINITY) return ['number', 'Infinity']
    if (value === Number.NEGATIVE_INFINITY) return ['number', '-Infinity']
    return ['scalar', value]
  }
  if (typeof value === 'bigint') return ['bigint', value.toString()]
  if (value instanceof Uint8Array) return ['bytes', Array.from(value)]
  if (typeof value !== 'object') throw new TypeError('Unsupported stored value')
  if (ancestors.has(value)) throw new TypeError('Cyclic stored value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return ['array', Array.from(value, (entry) => encodeNode(entry, ancestors))]
    }
    if (value instanceof Map) {
      return [
        'map',
        Array.from(value, ([key, entry]): [Node, Node] => [
          encodeNode(key, ancestors),
          encodeNode(entry, ancestors),
        ]),
      ]
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Unsupported stored object')
    }
    return [
      'object',
      Object.entries(value).map(([key, entry]): [string, Node] => [
        key,
        encodeNode(entry, ancestors),
      ]),
    ]
  } finally {
    ancestors.delete(value)
  }
}

function malformed(): never {
  throw new TypeError('Malformed stored value')
}

function entries(value: unknown): Array<[unknown, unknown]> {
  if (!Array.isArray(value)) return malformed()
  return value.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2) return malformed()
    return [entry[0], entry[1]]
  })
}

function decodeNode(node: unknown): unknown {
  if (!Array.isArray(node)) return malformed()
  const [tag, value] = node
  if (tag === 'undefined' && node.length === 1) return undefined
  if (node.length !== 2) return malformed()
  switch (tag) {
    case 'scalar':
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        return value
      }
      return malformed()
    case 'number':
      switch (value) {
        case 'NaN':
          return Number.NaN
        case 'Infinity':
          return Number.POSITIVE_INFINITY
        case '-Infinity':
          return Number.NEGATIVE_INFINITY
        case '-0':
          return -0
        default:
          return malformed()
      }
    case 'bigint':
      if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) {
        return malformed()
      }
      return BigInt(value)
    case 'bytes':
      if (
        !Array.isArray(value) ||
        !value.every(
          (byte: unknown) =>
            typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      ) {
        return malformed()
      }
      return Uint8Array.from(value)
    case 'array':
      if (!Array.isArray(value)) return malformed()
      return value.map(decodeNode)
    case 'map':
      return new Map(entries(value).map(([key, entry]) => [decodeNode(key), decodeNode(entry)]))
    case 'object': {
      const keys = new Set<string>()
      return Object.fromEntries(
        entries(value).map(([key, entry]) => {
          if (typeof key !== 'string' || keys.has(key)) return malformed()
          keys.add(key)
          return [key, decodeNode(entry)]
        }),
      )
    }
    default:
      return malformed()
  }
}

export function encodeStoredValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(encodeNode(value, new Set())))
}

export function decodeStoredValue(bytes: Uint8Array): unknown {
  const node: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  return decodeNode(node)
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected stored trust object')
  }
  return value as Record<string, unknown>
}

export function encodeTrust(value: unknown): unknown {
  const trust = objectValue(value)
  const registry = objectValue(trust.registry)
  if (!(registry.devices instanceof Map) || !(registry.controllers instanceof Map)) {
    throw new TypeError('Expected device registry maps')
  }
  return { ...trust, registry: encodeDeviceRegistry(registry as DeviceRegistry) }
}

export function assertSurvivingSpentSet(trust: { spentEpochAuthenticators?: unknown }): void {
  const spent = trust.spentEpochAuthenticators
  if (
    !Array.isArray(spent) ||
    spent.length === 0 ||
    !Array.from(spent).every((entry) => entry instanceof Uint8Array && entry.length > 0)
  )
    throw new SpentSetCorruptError()
}

export function decodeTrust(value: unknown): unknown {
  const trust = objectValue(value)
  if (!(trust.registry instanceof Uint8Array)) {
    throw new TypeError('Expected encoded device registry')
  }
  return { ...trust, registry: decodeDeviceRegistry(trust.registry) }
}

export async function sealRecord(
  codec: AtRestCodec,
  address: StoredAddress,
  value: unknown,
): Promise<Uint8Array> {
  const plaintext = encodeStoredValue(address.namespace === 'trust' ? encodeTrust(value) : value)
  const sealed = await codec.seal(plaintext, recordAAD(address))
  return Uint8Array.from(sealed)
}

export async function openRecord(
  codec: AtRestCodec,
  address: StoredAddress,
  bytes: Uint8Array,
): Promise<unknown> {
  try {
    const plaintext = await codec.open(Uint8Array.from(bytes), recordAAD(address))
    const value = decodeStoredValue(Uint8Array.from(plaintext))
    if (address.namespace !== 'trust') return value
    assertSurvivingSpentSet(objectValue(value))
    return decodeTrust(value)
  } catch (cause) {
    const error =
      cause !== null && (typeof cause === 'object' || typeof cause === 'function')
        ? cause
        : new Error('Stored value open failed', { cause })
    storedOpenFailures.add(error)
    throw error
  }
}
