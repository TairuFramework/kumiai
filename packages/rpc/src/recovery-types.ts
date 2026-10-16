import type {
  AdoptionExpected,
  AdoptionWriteFactory,
  GroupKey,
  LegacyRejoinRecord,
} from './control/types.js'
import type { LegacyPendingRecovery } from './crypto.js'
import { asLogPosition, type LogPosition } from './cursor.js'

export type RecoverySource<TTrust = unknown> = AdoptionExpected & {
  trust: TTrust
  trustDigest: string
  lifetimeRevision: number
}
export type RecoveryTargetCapture = {
  targetID: string
  topicID: string
  groupInfoEpoch: number
  groupInfoAuthenticator: Uint8Array
  captureHead: LogPosition | null
}
export type ResyncProof = RecoveryTargetCapture & {
  position: LogPosition
  payloadDigest: string
  verdict: Uint8Array
}
export type CapturedRejoinRecord = Omit<LegacyRejoinRecord, 'source' | 'conflictEpoch'> & {
  format: 2
  source: RecoverySource
  target: RecoveryTargetCapture
  captureHead: LogPosition | null
  searchFrom: LogPosition | null
  trigger: 'automatic' | 'manual'
  authorisationID: string | null
  switchMutationID: string | null
  destinationKey: GroupKey | null
}
export type StoredRejoinRecord = LegacyRejoinRecord | CapturedRejoinRecord
export type RecoveryOrigin = {
  sourceKey: GroupKey
  target: RecoveryTargetCapture
  searchFrom: LogPosition | null
}
export type AcceptedRejoinSettlement = {
  id: string
  origin: RecoveryOrigin
  ledgerBefore: Array<string>
} & (
  | {
      kind: 'accepted-unadoptable'
      digest: string
      payloadDigest: string
      epochAfter: number
      acceptedEpoch: number
      /** SHA-256/base64url of the exact wire-encoded fresh LeafNode. */
      leafDigest: string
    }
  | { kind: 'not-accepted'; epoch: number }
)
export type CapturedRecapture = {
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  epochFloor: number | null
}
export type RecoveryReconciliation =
  | { kind: 'accepted'; epoch: number; leafDigest: string }
  | { kind: 'head-only'; head: LogPosition | null }
  | { kind: 'unapplied-later'; epoch: number; leafDigest: string }
  | { kind: 'retry' | 'held' }
export type CapturedPendingRecovery = Omit<LegacyPendingRecovery, 'onAccepted'> & {
  source: RecoverySource<unknown>
  target: RecoveryTargetCapture
  onAccepted(
    expected: RecoverySource<unknown>,
    proof: ResyncProof,
    write: AdoptionWriteFactory,
  ): Promise<void>
}
export type CapturedAppliedRecovery = CapturedPendingRecovery | { renewalRequired: true } | null
export type CapturedRecoveryPort = {
  applyRecovery(
    sealed: Uint8Array,
    requestID: string,
    requestKey: Uint8Array,
  ): Promise<CapturedAppliedRecovery>
  restoreRecovery(candidate: Uint8Array, requestKey: Uint8Array): Promise<CapturedPendingRecovery>
  reconcileCapture(
    record: CapturedRejoinRecord,
    reply: CapturedRecapture,
  ): Promise<RecoveryReconciliation>
  sealGroupInfo(request: Uint8Array, captureHead: LogPosition | null): Promise<Uint8Array>
}
export type ConfirmedRecoveryHandoff = { record: CapturedRejoinRecord; completion: Promise<void> }
export type RecoveryContinuation = {
  source: GroupKey
  destination: GroupKey
  record: StoredRejoinRecord
}
export type RecoveryCompletion = (params: {
  ledger: Array<string>
  mutationID: string
}) => Promise<void>
export type RecoveryContinuationPort = {
  loadRecoveryContinuation(destination: GroupKey): Promise<RecoveryContinuation | null>
  finishRecoveryContinuation(params: {
    continuation: RecoveryContinuation
    ledger: Array<string>
    mutationID: string
  }): Promise<void>
}

export function validateCaptureHead(value: unknown): LogPosition | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    throw new TypeError('Invalid recovery capture head')
  return asLogPosition(value)
}

// Copy portable data without interpreting host-owned trust or requiring structuredClone.
function copyRecoveryValue<TValue>(value: TValue): TValue {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as TValue
  if (Array.isArray(value)) return value.map(copyRecoveryValue) as TValue
  if (value instanceof Map)
    return new Map(
      [...value].map(([key, child]) => [copyRecoveryValue(key), copyRecoveryValue(child)]),
    ) as TValue
  if (value instanceof Set) return new Set([...value].map(copyRecoveryValue)) as TValue
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Recovery trust must contain portable data')
    const copy = Object.create(prototype) as Record<string, unknown>
    for (const [key, child] of Object.entries(value))
      Object.defineProperty(copy, key, {
        value: copyRecoveryValue(child),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    return copy as TValue
  }
  if (typeof value === 'function') throw new TypeError('Recovery trust must contain portable data')
  return value
}

export function copyRecoverySource<TTrust>(source: RecoverySource<TTrust>): RecoverySource<TTrust> {
  return {
    key: { groupID: source.key.groupID, incarnation: source.key.incarnation },
    stateVersion: source.stateVersion,
    identity:
      source.identity === null
        ? null
        : { ...source.identity, authenticator: Uint8Array.from(source.identity.authenticator) },
    trust: copyRecoveryValue(source.trust),
    trustDigest: source.trustDigest,
    lifetimeRevision: source.lifetimeRevision,
  }
}
export function copyRecoveryTargetCapture(target: RecoveryTargetCapture): RecoveryTargetCapture {
  return {
    targetID: target.targetID,
    topicID: target.topicID,
    groupInfoEpoch: target.groupInfoEpoch,
    groupInfoAuthenticator: Uint8Array.from(target.groupInfoAuthenticator),
    captureHead: validateCaptureHead(target.captureHead),
  }
}
export function copyRecoveryOrigin(origin: RecoveryOrigin): RecoveryOrigin {
  return {
    sourceKey: { groupID: origin.sourceKey.groupID, incarnation: origin.sourceKey.incarnation },
    target: copyRecoveryTargetCapture(origin.target),
    searchFrom: origin.searchFrom,
  }
}
export function assignRecoverySwitchMutationID(current: string | null, mutationID: string): string {
  if (current !== null && current !== mutationID)
    throw new TypeError('Recovery switch mutation ID is already assigned')
  return mutationID
}
export function raiseRecoveryEpochFloor(current: number | null, epoch: number): number {
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    (current !== null && (!Number.isSafeInteger(current) || current < 0))
  )
    throw new TypeError('Invalid recovery epoch floor')
  return current === null ? epoch : Math.max(current, epoch)
}
