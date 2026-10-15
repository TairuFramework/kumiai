import { decodeDeviceRegistry, encodeDeviceRegistry } from '@kumiai/mls'

import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupRecoveryTrust } from './persistence-types.js'
import { assertRecoverySourceTrust } from './registry/source-trust.js'

type Shape =
  | 'string'
  | 'boolean'
  | 'number'
  | 'bigint'
  | 'bytes'
  | 'json'
  | { object: Record<string, Shape>; optional?: Array<string>; open?: boolean }
  | { array: Shape; sparse?: boolean }
  | { map: Shape }
  | { nullable: Shape }
  | { tag: string; variants: Record<string, Shape>; fallback?: Shape }

const commonEvent: Record<string, Shape> = {
  v: 'number',
  t: 'string',
  i: 'string',
  g: 'number',
  s: 'number',
  p: 'string',
  crit: 'boolean',
}
const authorityEvent: Record<string, Shape> = {
  ...commonEvent,
  k: { array: 'string' },
  ka: { array: 'string' },
  n: { array: 'string' },
  kt: 'number',
  nt: 'number',
}
const event: Shape = {
  tag: 't',
  variants: {
    icp: { object: { ...authorityEvent, r: 'string' }, optional: ['i', 'p'] },
    rot: {
      object: { ...authorityEvent, a: 'string', d: { array: 'string' } },
      optional: ['i', 'p', 'a', 'd'],
    },
    rev: { object: { ...commonEvent, x: 'string', cap: 'string' }, optional: ['i', 'p', 'cap'] },
  },
  // Future event payloads stay public JSON; the lifecycle fold decides their authority.
  fallback: { object: commonEvent, optional: ['i', 'p'], open: true },
}
const signedEvent: Shape = {
  object: { event, sigs: { array: 'string' }, recoveryKey: 'string' },
  optional: ['recoveryKey'],
}
const credential: Shape = {
  tag: 'credentialType',
  variants: {
    1: { object: { credentialType: 'number', identity: 'bytes' } },
    2: { object: { credentialType: 'number', certificates: { array: 'bytes' } } },
  },
  fallback: { object: { credentialType: 'number', data: 'bytes' } },
}
const commonLeaf: Record<string, Shape> = {
  hpkePublicKey: 'bytes',
  signaturePublicKey: 'bytes',
  credential,
  capabilities: {
    object: Object.fromEntries(
      ['versions', 'ciphersuites', 'extensions', 'proposals', 'credentials'].map((key) => [
        key,
        { array: 'number' },
      ]),
    ),
  },
  leafNodeSource: 'number',
  extensions: { array: { object: { extensionType: 'number', extensionData: 'bytes' } } },
  signature: 'bytes',
}
const leaf: Shape = {
  tag: 'leafNodeSource',
  variants: {
    1: {
      object: { ...commonLeaf, lifetime: { object: { notBefore: 'bigint', notAfter: 'bigint' } } },
    },
    2: { object: commonLeaf },
    3: { object: { ...commonLeaf, parentHash: 'bytes' } },
  },
}
const registry: Shape = {
  object: {
    devices: {
      map: {
        object: {
          controller: 'string',
          status: 'string',
          label: 'string',
          logPosition: 'number',
          reason: 'string',
          cascadedFrom: 'string',
        },
        optional: ['label', 'logPosition', 'reason', 'cascadedFrom'],
      },
    },
    controllers: {
      map: {
        object: {
          recordedLog: { array: signedEvent },
          genFloor: 'number',
          timeFloor: 'number',
          beacon: { object: { logLength: 'number', headDigest: 'string' } },
        },
        optional: ['beacon'],
      },
    },
  },
}
const trustShape: Shape = {
  object: {
    groupID: 'string',
    genesisAnchor: 'bytes',
    installed: {
      object: { groupID: 'string', incarnation: 'number', epoch: 'number', authenticator: 'bytes' },
    },
    signerTree: {
      array: {
        tag: 'nodeType',
        variants: {
          1: { object: { nodeType: 'number', leaf } },
          2: {
            object: {
              nodeType: 'number',
              parent: {
                object: {
                  hpkePublicKey: 'bytes',
                  parentHash: 'bytes',
                  unmergedLeaves: { array: 'number' },
                },
              },
            },
          },
        },
      },
      sparse: true,
    },
    registry,
    credential: { object: { id: 'string', groupID: 'string' } },
    binding: {
      nullable: {
        object: {
          id: 'string',
          prefix: { array: signedEvent },
          capability: 'string',
          holderGrant: 'string',
        },
        optional: ['holderGrant'],
      },
    },
    ledger: { array: 'string' },
    ciphersuiteName: 'string',
    spentEpochAuthenticators: { array: 'bytes' },
  },
}

function invalid(): never {
  throw new GroupStateConflictError('Invalid public recovery trust shape')
}

function plain(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid()
  return value as Record<string, unknown>
}

function ownKeys(value: object, allowed: (key: string) => boolean): Array<string> {
  return Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string' || !allowed(key)) return invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      (!descriptor.enumerable && !(Array.isArray(value) && key === 'length'))
    )
      return invalid()
    return key
  })
}

function indexKey(key: string, length: number): boolean {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key
}

function project(value: unknown, shape: Shape, ancestors: Set<object>): unknown {
  if (shape === 'string' || shape === 'boolean' || shape === 'bigint') {
    if (typeof value !== shape) return invalid()
    return value
  }
  if (shape === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0))
      return invalid()
    return value
  }
  if (shape === 'bytes') {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype)
      return invalid()
    ownKeys(value, (key) => indexKey(key, value.length))
    return Uint8Array.from(value)
  }
  if (shape === 'json') {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return project(value, 'number', ancestors)
    return project(
      value,
      Array.isArray(value) ? { array: 'json' } : { object: {}, open: true },
      ancestors,
    )
  }
  if ('nullable' in shape) return value === null ? null : project(value, shape.nullable, ancestors)
  if ('tag' in shape) {
    const object = plain(value)
    const descriptor = Object.getOwnPropertyDescriptor(object, shape.tag)
    if (descriptor === undefined || !('value' in descriptor)) return invalid()
    const tag: unknown = descriptor.value
    if (typeof tag !== 'number' && typeof tag !== 'string') return invalid()
    const variant = Object.hasOwn(shape.variants, tag) ? shape.variants[tag] : shape.fallback
    if (variant === undefined) return invalid()
    return project(value, variant, ancestors)
  }
  if (value === null || typeof value !== 'object' || ancestors.has(value)) return invalid()
  ancestors.add(value)
  try {
    if ('array' in shape) {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        return invalid()
      ownKeys(value, (key) => key === 'length' || indexKey(key, value.length))
      return Array.from(value, (entry) => {
        return entry === undefined && shape.sparse
          ? undefined
          : project(entry, shape.array, ancestors)
      })
    }
    if ('map' in shape) {
      if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype)
        return invalid()
      ownKeys(value, () => false)
      return new Map(
        Array.from(value, ([key, entry]) => {
          if (typeof key !== 'string') return invalid()
          return [key, project(entry, shape.map, ancestors)]
        }),
      )
    }
    const object = plain(value)
    const keys = ownKeys(object, (key) => shape.open === true || Object.hasOwn(shape.object, key))
    for (const key of Object.keys(shape.object)) {
      if (!keys.includes(key) && !shape.optional?.includes(key)) return invalid()
    }
    return Object.fromEntries(
      keys.flatMap((key) => {
        const entry = object[key]
        if (entry === undefined && shape.optional?.includes(key)) return []
        return [
          [
            key,
            project(
              entry,
              Object.hasOwn(shape.object, key) ? (shape.object[key] as Shape) : 'json',
              ancestors,
            ),
          ],
        ]
      }),
    )
  } finally {
    ancestors.delete(value)
  }
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false
  if (left instanceof Map && right instanceof Map)
    return (
      left.size === right.size &&
      Array.from(left).every(([key, value]) => right.has(key) && equal(value, right.get(key)))
    )
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Reflect.ownKeys(left)
  return (
    keys.length === Reflect.ownKeys(right).length &&
    keys.every((key) => {
      return Object.hasOwn(right, key) && equal(Reflect.get(left, key), Reflect.get(right, key))
    })
  )
}

export function projectRecoveryTrust(trust: unknown): GroupRecoveryTrust {
  let projected: GroupRecoveryTrust
  try {
    projected = project(trust, trustShape, new Set()) as GroupRecoveryTrust
    assertRecoverySourceTrust(projected)
    if (!equal(projected.registry, decodeDeviceRegistry(encodeDeviceRegistry(projected.registry))))
      return invalid()
  } catch (cause) {
    if (cause instanceof GroupStateConflictError) throw cause
    return invalid()
  }
  return projected
}
