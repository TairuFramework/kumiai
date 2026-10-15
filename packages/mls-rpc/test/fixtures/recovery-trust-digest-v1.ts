// Frozen digest implementation from 677ce50 for persisted-format compatibility.
import { decodeDeviceRegistry, encodeDeviceRegistry } from '@kumiai/mls'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import { assertTrustTransition } from '../../src/persistence-guards.js'
import type { GroupRecoveryTrust } from '../../src/persistence-types.js'

function canonical(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof Uint8Array) return toB64U(value)
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError('Negative recovery trust bigint')
    return value.toString(10)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Array.from(value, (entry) => canonical(entry ?? null))
  if (value !== undefined && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new TypeError('Invalid public recovery trust value')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  throw new TypeError('Invalid public recovery trust value')
}

export function legacyRecoveryTrustDigest(trust: GroupRecoveryTrust): string {
  assertTrustTransition(null, trust)
  if (
    typeof trust.credential.id !== 'string' ||
    !trust.ledger.every((token) => typeof token === 'string') ||
    (trust.binding !== null &&
      (typeof trust.binding?.id !== 'string' ||
        typeof trust.binding.capability !== 'string' ||
        !Array.isArray(trust.binding.prefix)))
  )
    throw new TypeError('Malformed public recovery trust')
  const registry = encodeDeviceRegistry(trust.registry)
  decodeDeviceRegistry(registry)
  const encoder = new TextEncoder()
  const domain = encoder.encode('kumiai/recovery-trust/v1')
  const body = encoder.encode(JSON.stringify(canonical({ ...trust, registry })))
  const bytes = new Uint8Array(8 + domain.length + body.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, domain.length, false)
  bytes.set(domain, 4)
  view.setUint32(4 + domain.length, body.length, false)
  bytes.set(body, 8 + domain.length)
  return toB64U(sha256(bytes))
}
