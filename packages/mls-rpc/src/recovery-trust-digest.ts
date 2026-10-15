import { encodeDeviceRegistry } from '@kumiai/mls'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import type { GroupRecoveryTrust } from './persistence-types.js'
import { projectRecoveryTrust } from './recovery-trust-projection.js'

function canonical(value: unknown): unknown {
  if (value instanceof Uint8Array) return toB64U(value)
  if (typeof value === 'bigint') return value.toString(10)
  if (Array.isArray(value))
    return Array.from(value, (entry) => (entry === undefined ? null : canonical(entry)))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

export function recoveryTrustDigest(trust: GroupRecoveryTrust): string {
  const projected = projectRecoveryTrust(trust)
  const registry = encodeDeviceRegistry(projected.registry)
  const encoder = new TextEncoder()
  const domain = encoder.encode('kumiai/recovery-trust/v1')
  const body = encoder.encode(JSON.stringify(canonical({ ...projected, registry })))
  const bytes = new Uint8Array(8 + domain.length + body.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, domain.length, false)
  bytes.set(domain, 4)
  view.setUint32(4 + domain.length, body.length, false)
  bytes.set(body, 8 + domain.length)
  return toB64U(sha256(bytes))
}
