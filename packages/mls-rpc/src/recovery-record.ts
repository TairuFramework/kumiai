import {
  type CapturedRejoinRecord,
  copyRecoverySource,
  copyRecoveryTargetCapture,
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
  HANDSHAKE_KIND,
  HANDSHAKE_VERSION,
  type LegacyRejoinRecord,
  validateCaptureHead,
} from '@kumiai/rpc'

import { decodeStoredValue, encodeStoredValue } from './persistence-codec.js'
import {
  decodeCapturedRecoveryCandidate,
  validateRecoveryCapture,
  validateRecoverySource,
} from './recovery-codec.js'
import type { RegistryRecoverySource } from './registry/types.js'

export type DecodedRecoveryRecord =
  | { kind: 'legacy'; executable: false; record: LegacyRejoinRecord }
  | { kind: 'captured'; executable: boolean; record: CapturedRejoinRecord }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function counter(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function key(value: unknown): boolean {
  return object(value) && text(value.groupID) && counter(value.incarnation, 1)
}

function bytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length > 0
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function assertCommon(value: unknown): asserts value is LegacyRejoinRecord | CapturedRejoinRecord {
  if (
    !object(value) ||
    !text(value.id) ||
    !text(value.publishID) ||
    !['built', 'published', 'confirmed', 'adopted', 'refused'].includes(String(value.stage)) ||
    !bytes(value.payload) ||
    !text(value.payloadDigest) ||
    !text(value.digest) ||
    !text(value.requestID) ||
    !bytes(value.request) ||
    !bytes(value.requestKey) ||
    !bytes(value.candidate) ||
    !counter(value.epochAfter, 1) ||
    !Array.isArray(value.ledgerBefore) ||
    !value.ledgerBefore.every((token) => typeof token === 'string') ||
    (value.position !== undefined && !text(value.position)) ||
    (value.verdict !== undefined && !bytes(value.verdict)) ||
    (value.refusal !== undefined &&
      !['binding', 'lapse', 'floor', 'policy', 'invalid'].includes(String(value.refusal))) ||
    (value.expectedHead !== null && typeof value.expectedHead !== 'string')
  )
    throw new TypeError('Malformed recovery record')
}

export function validateCapturedRecoveryRecord(record: CapturedRejoinRecord): void {
  assertCommon(record)
  if (record.format !== 2 || !object(record.source))
    throw new TypeError('Invalid captured recovery record')
  validateRecoverySource(record.source as RegistryRecoverySource)
  validateRecoveryCapture(record)
  validateCaptureHead(record.expectedHead)
  if (
    (record.trigger !== 'automatic' && record.trigger !== 'manual') ||
    (record.trigger === 'automatic'
      ? record.authorisationID !== null
      : !text(record.authorisationID)) ||
    (record.switchMutationID !== null && !text(record.switchMutationID)) ||
    (record.destinationKey !== null && !key(record.destinationKey)) ||
    (record.stage === 'adopted' && record.destinationKey === null) ||
    (record.destinationKey !== null &&
      (record.destinationKey.groupID !== record.source.key.groupID ||
        record.destinationKey.incarnation !== record.source.key.incarnation + 1))
  )
    throw new TypeError('Invalid captured recovery stage')

  const candidate = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
  const source = candidate.source
  const saved = record.source
  if (
    source.key.groupID !== saved.key.groupID ||
    source.key.incarnation !== saved.key.incarnation ||
    source.stateVersion !== saved.stateVersion ||
    source.lifetimeRevision !== saved.lifetimeRevision ||
    source.trustDigest !== saved.trustDigest ||
    (source.identity === null) !== (saved.identity === null) ||
    (source.identity !== null &&
      saved.identity !== null &&
      (source.identity.epoch !== saved.identity.epoch ||
        !equalBytes(source.identity.authenticator, saved.identity.authenticator))) ||
    candidate.target.targetID !== record.target.targetID ||
    candidate.target.topicID !== record.target.topicID ||
    candidate.target.groupInfoEpoch !== record.target.groupInfoEpoch ||
    !equalBytes(candidate.target.groupInfoAuthenticator, record.target.groupInfoAuthenticator) ||
    candidate.captureHead !== record.captureHead ||
    candidate.searchFrom !== record.searchFrom ||
    candidate.requestID !== record.requestID ||
    candidate.epoch !== record.epochAfter ||
    digestAppliedCommit(candidate.commit) !== record.digest ||
    digestAppliedCommit(record.payload) !== record.payloadDigest
  )
    throw new TypeError('Captured recovery record association mismatch')
  const frame = decodeHandshakeFrame(record.payload)
  const commit = decodeCommitFrame(frame.payload)
  if (
    frame.version !== HANDSHAKE_VERSION ||
    frame.kind !== HANDSHAKE_KIND.commit ||
    !equalBytes(commit.commit, candidate.commit)
  )
    throw new TypeError('Captured recovery payload mismatch')
  if (record.stage === 'confirmed' || record.stage === 'adopted') {
    if (
      !text(record.position) ||
      !bytes(record.verdict) ||
      candidate.boundCommit?.position !== record.position ||
      candidate.boundCommit.commitDigest !== record.digest ||
      !text(candidate.boundCommit.tag)
    )
      throw new TypeError('Captured recovery confirmation mismatch')
  }
}

export function decodeRecoveryRecord(value: unknown): DecodedRecoveryRecord {
  assertCommon(value)
  if ('format' in value) {
    if (value.format !== 2) throw new TypeError('Unsupported recovery record format')
    validateCapturedRecoveryRecord(value)
    const record = decodeStoredValue(encodeStoredValue(value)) as CapturedRejoinRecord
    record.source = copyRecoverySource(value.source)
    record.target = copyRecoveryTargetCapture(value.target)
    return { kind: 'captured', executable: record.trigger === 'automatic', record }
  }
  if (
    !key(value.source?.key) ||
    !counter(value.source.epoch) ||
    !bytes(value.source.authenticator) ||
    (value.conflictEpoch !== null && !counter(value.conflictEpoch))
  )
    throw new TypeError('Malformed legacy recovery record')
  if (value.source.head !== null && typeof value.source.head !== 'string')
    throw new TypeError('Malformed legacy recovery head')
  return {
    kind: 'legacy',
    executable: false,
    record: decodeStoredValue(encodeStoredValue(value)) as LegacyRejoinRecord,
  }
}
