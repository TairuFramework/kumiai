import { encodeDeviceRegistry } from '@kumiai/mls'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import { GroupStateConflictError } from './persistence-errors.js'
import type { GroupRecoveryTrust } from './persistence-types.js'
import { assertRecoverySourceTrust } from './registry/source-trust.js'

type TrustPath = Array<string | number>

function representation(trust: GroupRecoveryTrust, path: TrustPath): string | undefined {
  const [root, index, nodeField, field, item, itemField] = path
  if (path.length === 1 && (root === 'genesisAnchor' || root === 'registry')) return 'bytes'
  if (path.length === 2) {
    if (root === 'installed' && index === 'authenticator') return 'bytes'
    if (root === 'spentEpochAuthenticators' && typeof index === 'number') return 'bytes'
    if (root === 'signerTree' && typeof index === 'number') return 'slot'
    if (root === 'binding' && index === 'holderGrant') return 'optional'
  }
  if (root === 'binding' && index === 'prefix' && typeof nodeField === 'number') {
    if (path.length === 4 && field === 'recoveryKey') return 'optional'
    if (path.length === 5 && field === 'event' && (item === 'i' || item === 'p')) return 'optional'
  }
  if (root !== 'signerTree' || typeof index !== 'number') return undefined
  const node = trust.signerTree[index]
  if (node?.nodeType === 2 && nodeField === 'parent' && path.length === 4)
    return field === 'hpkePublicKey' || field === 'parentHash' ? 'bytes' : undefined
  if (node?.nodeType !== 1 || nodeField !== 'leaf') return undefined
  if (path.length === 4) {
    if (field === 'hpkePublicKey' || field === 'signaturePublicKey' || field === 'signature')
      return 'bytes'
    if (field === 'parentHash' && node.leaf.leafNodeSource === 3) return 'bytes'
  }
  if (
    path.length === 5 &&
    field === 'lifetime' &&
    node.leaf.leafNodeSource === 1 &&
    (item === 'notBefore' || item === 'notAfter')
  )
    return 'bigint'
  if (
    path.length === 6 &&
    field === 'extensions' &&
    typeof item === 'number' &&
    itemField === 'extensionData'
  )
    return 'bytes'
  if (field !== 'credential') return undefined
  const type = node.leaf.credential.credentialType
  if (
    path.length === 5 &&
    ((type === 1 && item === 'identity') || (type !== 1 && type !== 2 && item === 'data'))
  )
    return 'bytes'
  if (path.length === 6 && type === 2 && item === 'certificates' && typeof itemField === 'number')
    return 'bytes'
  return undefined
}

function canonical(value: unknown, trust: GroupRecoveryTrust, path: TrustPath = []): unknown {
  // Only schema-validated positions may erase runtime types into public JSON.
  const position = representation(trust, path)
  if (value === undefined) {
    if (position === 'slot') return null
    if (position === 'optional') return undefined
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof Uint8Array && position === 'bytes') return toB64U(value)
  if (typeof value === 'bigint' && position === 'bigint') return value.toString(10)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value))
    return Array.from(value, (entry, index) => canonical(entry, trust, [...path, index]))
  if (
    value !== undefined &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry, trust, [...path, key])])
        .filter(([, entry]) => entry !== undefined),
    )
  }
  throw new GroupStateConflictError('Invalid public recovery trust value')
}

export function recoveryTrustDigest(trust: GroupRecoveryTrust): string {
  assertRecoverySourceTrust(trust)
  const registry = encodeDeviceRegistry(trust.registry)
  const encoder = new TextEncoder()
  const domain = encoder.encode('kumiai/recovery-trust/v1')
  const body = encoder.encode(JSON.stringify(canonical({ ...trust, registry }, trust)))
  const bytes = new Uint8Array(8 + domain.length + body.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, domain.length, false)
  bytes.set(domain, 4)
  view.setUint32(4 + domain.length, body.length, false)
  bytes.set(body, 8 + domain.length)
  return toB64U(sha256(bytes))
}
