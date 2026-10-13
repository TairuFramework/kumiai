import { decodeDeviceRegistry, encodeDeviceRegistry } from '@kumiai/mls'

import { GroupStateConflictError } from '../persistence-errors.js'
import { assertTrustTransition } from '../persistence-guards.js'
import type { GroupRecoveryTrust } from '../persistence-types.js'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unsigned(value: unknown, maximum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function vector(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && Array.from(value).every(valid)
}

function bytes(value: unknown): boolean {
  return value instanceof Uint8Array
}

function uint16(value: unknown): boolean {
  return unsigned(value, 0xffff)
}

function uint64(value: unknown): boolean {
  return typeof value === 'bigint' && value >= 0n && value <= 0xffffffffffffffffn
}

function credential(value: unknown): boolean {
  if (!object(value) || !uint16(value.credentialType)) return false
  if (value.credentialType === 1) return bytes(value.identity)
  if (value.credentialType === 2) return vector(value.certificates, bytes)
  return bytes(value.data)
}

function leaf(value: unknown): boolean {
  if (
    !object(value) ||
    !bytes(value.hpkePublicKey) ||
    !bytes(value.signaturePublicKey) ||
    !bytes(value.signature) ||
    !credential(value.credential) ||
    !object(value.capabilities) ||
    !['versions', 'ciphersuites', 'extensions', 'proposals', 'credentials'].every((field) =>
      vector((value.capabilities as Record<string, unknown>)[field], uint16),
    ) ||
    !vector(
      value.extensions,
      (entry) => object(entry) && uint16(entry.extensionType) && bytes(entry.extensionData),
    )
  )
    return false
  if (value.leafNodeSource === 1)
    return (
      object(value.lifetime) && uint64(value.lifetime.notBefore) && uint64(value.lifetime.notAfter)
    )
  if (value.leafNodeSource === 2) return true
  return value.leafNodeSource === 3 && bytes(value.parentHash)
}

function signerNode(value: unknown): boolean {
  // Blank public ratchet-tree slots are represented by undefined.
  if (value === undefined) return true
  if (!object(value)) return false
  if (value.nodeType === 1) return leaf(value.leaf)
  return (
    value.nodeType === 2 &&
    object(value.parent) &&
    bytes(value.parent.hpkePublicKey) &&
    bytes(value.parent.parentHash) &&
    vector(value.parent.unmergedLeaves, (index) => unsigned(index, 0xffffffff))
  )
}

function signedEvent(value: unknown): boolean {
  if (!object(value) || !object(value.event)) return false
  const event = value.event
  return (
    event.v === 1 &&
    typeof event.t === 'string' &&
    typeof event.g === 'number' &&
    Number.isFinite(event.g) &&
    typeof event.s === 'number' &&
    Number.isFinite(event.s) &&
    typeof event.crit === 'boolean' &&
    (event.i === undefined || typeof event.i === 'string') &&
    (event.p === undefined || typeof event.p === 'string') &&
    vector(value.sigs, (signature) => typeof signature === 'string') &&
    (value.recoveryKey === undefined || typeof value.recoveryKey === 'string')
  )
}

function binding(value: unknown): boolean {
  return (
    value === null ||
    (object(value) &&
      typeof value.id === 'string' &&
      typeof value.capability === 'string' &&
      vector(value.prefix, signedEvent) &&
      (value.holderGrant === undefined || typeof value.holderGrant === 'string'))
  )
}

export function assertRecoverySourceTrust(trust: GroupRecoveryTrust): void {
  assertTrustTransition(null, trust)
  if (
    !vector(trust.signerTree, signerNode) ||
    !vector(trust.ledger, (token) => typeof token === 'string') ||
    typeof trust.credential.id !== 'string' ||
    !binding(trust.binding)
  )
    throw new GroupStateConflictError('Malformed nested recovery trust')
  // Reuse the registry codec's complete map-entry and public log structural checks.
  decodeDeviceRegistry(encodeDeviceRegistry(trust.registry))
}
