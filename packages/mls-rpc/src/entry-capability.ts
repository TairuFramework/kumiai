import type {
  AnchorSlot,
  BatchBudget,
  CheckpointRecord,
  ControlSnapshot,
  GroupCondition,
} from '@kumiai/rpc'

import type { OwnerAttempt } from './owner-queue.js'
import { PersistencePhaseError } from './persistence-errors.js'
import type {
  AppOutboxEntry,
  AppPoisonRecord,
  AppSettlementObligation,
  EpochIdentity,
  GroupKey,
  GroupLifetime,
  GroupPersistence,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  GroupTransaction,
  GroupTransition,
  PendingAppFrame,
  PersistenceEvent,
} from './persistence-types.js'

export type StateMetadata = GroupKey & {
  version: number
  deleted: boolean
  terminal: boolean
  initialIdentity: EpochIdentity | null
}
export type AccountedGroupObservation = {
  mutationID: string
  condition?: GroupCondition | null
  lifetime: GroupLifetime | null
  lifetimeStatus: 'missing' | 'readable' | 'unreadable'
  metadata: Array<StateMetadata>
  // Includes affected incarnations and the active version read. Readable rows survive partial failure.
  metadataStatus: 'missing' | 'readable' | 'unreadable'
  trust: GroupRecoveryTrust | null
  trustStatus: 'missing' | 'readable' | 'unreadable' | 'spent-set-corrupt'
  activeKey: GroupKey | null
  activeVersion: number | null
  control: ControlSnapshot | null
  controlStatus: 'missing' | 'readable' | 'unreadable'
  stateStatus: 'missing' | 'null' | 'deleted' | 'readable' | 'unreadable' | 'unobserved'
  terminal: boolean | null
}
export type EntryReads = {
  anchor(incarnation: number): Promise<AnchorSlot | null>
  outbox(incarnation: number): Promise<Array<AppOutboxEntry>>
  settlement(incarnation: number, seq: number): Promise<AppSettlementObligation | null>
  checkpoints(): Promise<Array<CheckpointRecord>>
  lifetime(): Promise<GroupLifetime | null>
  trust(): Promise<GroupRecoveryTrust | null>
  metadata(incarnation: number): Promise<StateMetadata | null>
  state(incarnation: number): Promise<GroupStateRecord | null>
  control(incarnation: number): Promise<ControlSnapshot>
  events(incarnation: number): Promise<Array<PersistenceEvent>>
  appFrame(
    incarnation: number,
    id: string,
  ): Promise<{ pending: PendingAppFrame | null; poison: AppPoisonRecord | null }>
  pendingFrames(incarnation: number): Promise<Array<PendingAppFrame>>
  appCursor(incarnation: number, topicID: string): Promise<string | null>
  controlMutation(incarnation: number): Promise<string | null>
  diagnoseState(
    incarnation: number,
  ): Promise<'missing' | 'null' | 'deleted' | 'readable' | 'unreadable'>
}
export type ClosingReason = 'terminal' | 'switch' | 'readmission' | 'delete' | 'successor'
export type ClosingMutation = { mutationID: string }
export type ClosingDomain = { states: Array<GroupStateRecord>; lifetime: GroupLifetime | null }
export type ClosingPreparation = {
  freeze<TPrepared extends Prepared<unknown>>(request: {
    source: GroupKey
    reason: ClosingReason
    prepared: TPrepared
    domain: ClosingDomain
  }): Promise<TPrepared>
}
export type Prepared<T> = {
  expected: GroupTransition['expected']
  mutationID?: string
  closing?: ClosingMutation
  value: T
}
export type CertifiedFinalisationResult = { seq: number; status: 'published' | 'already-complete' }
export type FinaliseBatchResult = { consumed: number; results: Array<CertifiedFinalisationResult> }

export type EntryCapability<TTx extends GroupTransaction> = {
  assertRoot(): void
  command<T>(
    groupID: string,
    work: (attempt: OwnerAttempt) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>
  activity(groupID: string, excludingMutationID?: string): { generation: number; pending: number }
  failureSignal?: AbortSignal
  finaliseCertifiedAppBatch(
    key: GroupKey,
    seqs: Array<number>,
    budget: BatchBudget,
  ): Promise<FinaliseBatchResult>
  finaliseCertifiedApp(key: GroupKey, seq: number): Promise<void>
  observe(
    groupID: string,
    onProof: (observation: AccountedGroupObservation) => void,
    afterRelease?: (observation: AccountedGroupObservation) => void,
  ): () => void

  read<T>(groupID: string, fn: (reads: EntryReads) => Promise<T>): Promise<T>
  run<P, T>(
    // Null binds the ID supplied by prepare before any work write.
    request: { groupID: string; mutationID: string | null },
    prepare: (reads: EntryReads, closing: ClosingPreparation) => Promise<Prepared<P>>,
    work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
    effects?: (stores: GroupStores<TTx>, prepared: P, result: T) => Promise<void>,
  ): Promise<T>
}

const readAttempts = new WeakMap<EntryReads, OwnerAttempt>()
export function bindEntryReadsAttempt(reads: EntryReads, attempt: OwnerAttempt): void {
  readAttempts.set(reads, attempt)
}
export function entryReadsAttempt(reads: EntryReads): OwnerAttempt {
  const attempt = readAttempts.get(reads)
  if (attempt === undefined) throw new PersistencePhaseError('Unregistered entry reads')
  attempt.assertLive()
  return attempt
}
const bindings = new WeakMap<object, { capability: unknown; coordinatorBinding: object }>()

export function bindEntryCapability<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  capability: EntryCapability<TTx>
  coordinatorBinding: object
}): void {
  bindings.set(params.persistence, {
    capability: params.capability,
    coordinatorBinding: params.coordinatorBinding,
  })
}

export function entryCapability<TTx extends GroupTransaction>(
  persistence: GroupPersistence<TTx>,
): EntryCapability<TTx> | null {
  return (bindings.get(persistence)?.capability as EntryCapability<TTx> | undefined) ?? null
}

export function coordinatorBinding<TTx extends GroupTransaction>(
  persistence: GroupPersistence<TTx>,
): object | null {
  return bindings.get(persistence)?.coordinatorBinding ?? null
}
