import type { ClientState, ControllerBinding, DeviceRegistry, MemberCredential } from '@kumiai/mls'
import type { BundleSource, KeyPackagePoolStore, LastResortStore } from '@kumiai/mls-hub'
import type {
  AdoptionWrite,
  AnchorSlot,
  AnchorStore,
  AppCursorStore,
  BranchAbandonedEvent,
  CheckpointStore,
  ControlChanges,
  ControlEvidenceSnapshot,
  ControlSnapshot,
  ControlStore,
  EpochIdentity,
  GroupConditionEvent,
  GroupKey,
  GroupSafetyEvent,
  RecoveryUnavailableEvent,
} from '@kumiai/rpc'

import type { EntryReads, Prepared, StateMetadata } from './entry-capability.js'

export type OwnershipContextPort = {
  run<T>(token: object, fn: () => T): T
  get(): object | undefined
}

export type {
  AbandonedEpochRange,
  BranchAbandonedEvent,
  BranchReportCoverage,
  EpochIdentity,
  ForkHalt,
  ForkNotice,
  ForkNoticeEvent,
  GroupForkEvidence,
  GroupKey,
  GroupSafetyEvent,
  ManualRecoveryRecord,
  ManualRecoveryStatus,
  OwnBranchMessage,
  PersistedManualRecovery,
  RecoveryUnavailableEvent,
  SafetyHold,
} from '@kumiai/rpc'

export type PackageUse = { sourceID: string; ref: string; kind: 'ordinary' | 'last-resort' }

export type GroupLifetime = {
  groupID: string
  latestIncarnation: number
  activeIncarnation: number | null
  revision: number
  mutationID: string
  restorePending: boolean // (r15 decision) cleared only by fresh-incarnation resync
}

export type GroupStateRecord = GroupKey & { version: number } & (
    | { deleted: true }
    | {
        deleted: false
        terminal: boolean
        epoch: number
        epochAuthenticator: Uint8Array
        state: Uint8Array | null
        credential: { id: string; groupID: string }
        ledger: Array<string>
        senderHWM: number
      }
  )

export type GroupRecoveryTrust = {
  groupID: string
  genesisAnchor: Uint8Array
  installed: EpochIdentity
  signerTree: ClientState['ratchetTree']
  registry: DeviceRegistry
  credential: MemberCredential
  binding: ControllerBinding | null
  ledger: Array<string>
  ciphersuiteName: string
  spentEpochAuthenticators: Array<Uint8Array>
}

export type GroupTransaction = {
  providerID: string
  groupID: string | null
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}

export type IncarnationStores = {
  state: {
    load(): Promise<GroupStateRecord | null>
    loadInitialIdentity(): Promise<EpochIdentity | null>
    loadMetadata(): Promise<StateMetadata | null>
    save(record: GroupStateRecord, expected?: AdoptionWrite['expected']): Promise<void>
  }
  control: {
    load(): Promise<ControlSnapshot>
    apply(changes: ControlChanges, mutationID: string): Promise<void>
  }
  anchor: { load(): Promise<AnchorSlot | null>; save(slot: AnchorSlot | null): Promise<void> }
  pending: {
    list(): Promise<Array<PendingAppFrame>>
    put(records: Array<PendingAppFrame>): Promise<void>
    poison(records: Array<AppPoisonRecord>): Promise<void>
    listPoison(): Promise<Array<AppPoisonRecord>>
    complete(ids: Array<string>): Promise<void>
  }
  cursor: {
    load(topicID: string): Promise<string | null>
    save(topicID: string, position: string): Promise<void>
    /** Forgets every app read position of this incarnation (hub positions die with the hub). */
    clear(): Promise<void>
  }
  outbox: {
    list(): Promise<Array<AppOutboxEntry>>
    put(entries: Array<AppOutboxEntry>): Promise<void>
    remove(seqs: Array<number>): Promise<void>
    clear(): Promise<void>
  }
  meta: {
    loadSettlement(seq: number): Promise<AppSettlementObligation | null>
    putSettlement(seq: number, value: AppSettlementObligation | null): Promise<void>
    events(): Promise<Array<PersistenceEvent>>
    putEvents(events: Array<PersistenceEvent>): Promise<void>
    ackEvent(id: string): Promise<void>
  }
  clearTransport(): Promise<void> // preserves owed outcomes/Welcomes, fork evidence and unacked events
}

export type GroupStores<TTx extends GroupTransaction> = {
  tx: TTx
  checkpoints: CheckpointStore
  lifetime: { load(): Promise<GroupLifetime | null>; save(value: GroupLifetime): Promise<void> }
  trust: {
    load(): Promise<GroupRecoveryTrust | null>
    save(value: GroupRecoveryTrust): Promise<void>
  }
  incarnation(incarnation: number): IncarnationStores
}

export type GroupTransition = {
  groupID: string
  mutationID: string
  expected: { revision: number; activeIncarnation: number | null } | null
}

export type GroupPersistence<TTx extends GroupTransaction> = {
  load(groupID: string): Promise<GroupLifetime | null>
  loadState(key: GroupKey): Promise<GroupStateRecord | null>
  readEvidence(key: GroupKey): Promise<ControlEvidenceSnapshot>
  loadTrust(groupID: string): Promise<GroupRecoveryTrust | null>
  list(): Promise<Array<GroupLifetime>>
  ports(key: GroupKey): GroupPersistencePorts
  transition<TValue>(
    change: GroupTransition,
    work: (stores: GroupStores<TTx>) => Promise<TValue>,
  ): Promise<TValue>
  resolve(groupID: string, mutationID: string): Promise<'committed' | 'rolled-back'>
}

export type GroupPersistencePorts = {
  key: GroupKey
  control: ControlStore
  outbox: AppOutbox
  anchor: AnchorStore
  cursor: AppCursorStore
}

export type AtRestCodec = {
  seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}

export type TransactionHookSettlement = { settle(outcome: 'committed' | 'rolled-back'): void }

export type OutcomeAwareTransactionOptions = {
  onUnknown(settlement: TransactionHookSettlement): void
}

export type MemoryStoreRows = Record<string, Map<string, unknown>>

export type MemoryTransaction = GroupTransaction & { rows: MemoryStoreRows }

export type MemoryDatabase = {
  transact<TValue>(
    scope: { groupID: string | null; devicePackages: boolean },
    fn: (tx: MemoryTransaction) => Promise<TValue>,
    options?: OutcomeAwareTransactionOptions,
  ): Promise<TValue>
  completionBarrier(scope: { groupID: string | null; devicePackages: boolean }): Promise<void>
  snapshot(groupID?: string): MemoryStoreRows
}

export type DeviceRecord = { revision: number; mutationID: string; restoreWork: RestoreWork | null }

export type HubCleanupRow = PackageUse & {
  id: string
  ownerDID: string
  groupID: string | null
  notAfter: number
}

export type RestoreWork = {
  id: string
  stage: 'invalidate' | 'rotate' | 'groups'
  remainingGroups: Array<string>
}

export type DeviceStores<TTx extends GroupTransaction> = {
  tx: TTx
  group: GroupStores<TTx> | null
  ordinary(sourceID: string): KeyPackagePoolStore
  lastResort(sourceID: string): LastResortStore
  cleanup: {
    list(): Promise<Array<HubCleanupRow>>
    put(row: HubCleanupRow): Promise<void>
    remove(id: string): Promise<void>
  }
  restore: { load(): Promise<RestoreWork | null>; save(work: RestoreWork | null): Promise<void> }
}

export type DevicePersistence<TTx extends GroupTransaction> = {
  providerID: string
  ownerDID: string
  groups: GroupPersistence<TTx>
  load(): Promise<DeviceRecord>
  transition<TValue>(
    change: { mutationID: string; expectedRevision: number; group: GroupTransition | null },
    work: (stores: DeviceStores<TTx>) => Promise<TValue>,
  ): Promise<TValue>
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
}

export type TransactionalGroupEffects<TTx extends GroupTransaction> = {
  outbox?(tx: TTx, event: AppStatusEvent): Promise<void>
  delete?(tx: TTx, key: GroupKey): Promise<void>
}

export type RawStoredRecord = {
  groupID: string
  incarnation: number | null
  namespace: string
  recordID: string
  key: string
  bytes: Uint8Array
}

export type PendingCommitFault = {
  rejected: Promise<void>
  barrierWaiting: Promise<void>
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}

type FixtureGroupStores<TPorts> = TPorts extends {
  device: {
    groups: {
      transition(change: never, work: (stores: infer TStores) => Promise<unknown>): Promise<unknown>
    }
  }
}
  ? TStores
  : never

type FixtureDeviceStores<TPorts> = TPorts extends {
  device: {
    transition(change: never, work: (stores: infer TStores) => Promise<unknown>): Promise<unknown>
  }
}
  ? TStores
  : never

type FixtureEntryReads<TPorts> = Omit<EntryReads, 'control' | 'checkpoints'> & {
  checkpoints(): FixtureGroupStores<TPorts> extends { checkpoints: { list(): infer TResult } }
    ? TResult
    : never
  control(incarnation: number): FixtureGroupStores<TPorts> extends {
    incarnation(incarnation: number): { control: { load(): infer TResult } }
  }
    ? TResult
    : never
}

export type PersistenceFixture<TPorts> = {
  entry(): {
    read<T>(groupID: string, fn: (reads: FixtureEntryReads<TPorts>) => Promise<T>): Promise<T>
    run<P, T>(
      request: Pick<GroupTransition, 'groupID' | 'mutationID'>,
      prepare: (reads: FixtureEntryReads<TPorts>) => Promise<Prepared<P>>,
      work: (stores: FixtureGroupStores<TPorts>, prepared: P) => Promise<T>,
    ): Promise<T>
  }
  constructPrepareStores(key: GroupKey): FixtureGroupStores<TPorts>
  ports: TPorts
  reopen(): Promise<TPorts>
  reopenWithoutBarrier(): Promise<TPorts>
  failNext(point: 'after-first-write' | 'before-commit' | 'status-read'): void
  commitThenReject(): void
  rejectCommitPending(): PendingCommitFault
  holdNextSeal(): { reached: Promise<void>; release(): void }
  failNextSeal(error?: Error): void
  holdNextOpen(): { started: Promise<void>; release(): void }
  failNextOpen(error?: Error): void
  probeCodec(fn: (phase: string) => Promise<void>): void
  onPhase(
    phase: 'prepare' | 'work' | 'effects' | 'finalise' | 'account' | 'proof' | 'hook',
    fn: () => Promise<void> | void,
  ): void
  readWith<T>(fn: (stores: FixtureDeviceStores<TPorts>) => Promise<T>): Promise<T>
  combinedWith(signal: AbortSignal): Promise<void>
  retryNextTransition(): void
  forceOwnerMarker(
    owner: { groupID: string } | { ownerDID: string },
    marker: { mutationID: string; revision: number },
  ): Promise<void>
  deleteCommittedRow(namespace: string, key: string): Promise<void>
  constructGroupStores(
    tx: FixtureGroupStores<TPorts> extends { tx: infer TTx } ? TTx : never,
    key: GroupKey,
  ): FixtureGroupStores<TPorts>
  inspectRows(): Promise<MemoryStoreRows>
  inspectRawBytes(): Promise<Array<RawStoredRecord>>
  inspectSideRow(key: string): Promise<Uint8Array | null>
  mutateStoredRecord(
    namespace: string,
    key: string,
    mutate: (bytes: Uint8Array) => Uint8Array,
  ): Promise<void>
  swapStoredRecords(namespace: string, keyA: string, keyB: string): Promise<void>
  setTime(now: number): void
  advanceTime(ms: number): Promise<void>
  close(): Promise<void>
}

export type PreOpenAppFrameRef = GroupKey & {
  id: string
  protocol: string
  topicID: string
  segment: number
  position: string // segment = anchor epoch
}

export type OpenAppInput = {
  frame: PreOpenAppFrameRef
  ciphertext: Uint8Array
  expectedAAD?: Uint8Array
}
export type OpenAppResult =
  | { kind: 'opened'; record: PendingAppFrame }
  | { kind: 'refused'; frame: PreOpenAppFrameRef; reason: 'malformed-plaintext'; keyConsumed: true }
  | {
      kind: 'refused'
      frame: PreOpenAppFrameRef
      reason: 'invalid-ciphertext' | 'wrong-aad' | 'duplicate' | 'invalid-position'
      keyConsumed: false
    }
  | {
      kind: 'refused'
      frame: PreOpenAppFrameRef
      reason: 'past-epoch'
      keyConsumed: false
      frameEpoch: number
      handleEpoch: number
    }
  | {
      kind: 'held'
      frame: PreOpenAppFrameRef
      reason: 'future-epoch'
      frameEpoch: number
      handleEpoch: number
    }
  | { kind: 'held'; frame: PreOpenAppFrameRef; reason: 'unsupported-version' }
export type PendingAppFrames = {
  list(): Promise<Array<PendingAppFrame>>
  complete(id: string): Promise<void>
}
export const MAX_OPEN_BATCH_FRAMES = 64
export const RECEIVE_SAVE_ATTEMPTS = 3

export type AppFrameRef = PreOpenAppFrameRef & { procedure: string }
// GroupCrypto.unwrap opts.frame changes to PreOpenAppFrameRef (r16 decision).

export type PendingAppFrame = {
  frame: AppFrameRef
  payload: Uint8Array
  senderDID: string
  epoch: number
  idempotencyKey: string
}

export type AppPoisonRecord = { frame: PreOpenAppFrameRef; reason: string; keyConsumed: boolean }

export type AppAttempt = {
  incarnation: number
  epoch: number
  floor: string | null
  attempts: number
  publishID: string
  segment: number
  topicID: string
}

export type AppOutboxEntry = {
  seq: number
  protocol: string
  prc: string
  data: Uint8Array
  lastAttempt: AppAttempt | null
  status: 'accepted' | 'failed'
}

export type AppOutbox = {
  put(entry: AppOutboxEntry): Promise<void>
  list(): Promise<Array<AppOutboxEntry>>
  recordSettlement(
    seq: number,
    obligation: AppSettlementObligation,
    expected: AppSettlementExpected,
  ): Promise<AppSettlementResult>
  loadSettlement(seq: number): Promise<AppSettlementObligation | null>
  remove(seq: number, outcome?: AppPublicationOutcome): Promise<void>
  clear(): Promise<void>
  events(): Promise<Array<AppStatusEvent>>
  ackEvent(id: string): Promise<void>
}

export type AppPublicationOutcome = {
  incarnation: number
  segment: number
  topicID: string
  position: string
}

export type AppSettlementObligation = {
  sequenceID: string
  attemptID: string
  topicID: string
  outcome: 'published'
}

export type AppSettlementExpected = {
  identity: EpochIdentity
  stateVersion: number
  attemptID: string
}

export type AppSettlementResult =
  | { recorded: true }
  | {
      recorded: false
      reason: 'identity-changed' | 'state-version-changed' | 'attempt-changed' | 'entry-missing'
    }

export type AppStatusEvent = GroupKey & { id: string; entry: AppOutboxEntry } & (
    | { kind: 'accepted' }
    | { kind: 'published'; occurrence: AppPublicationOutcome }
    | {
        kind: 'failed'
        reason: 'incarnation-abandoned' | 'removed' | 'deleted' | 'database-restored'
        nextIncarnation?: number
      }
  )

export type PersistenceEvent =
  | BranchAbandonedEvent
  | AppStatusEvent
  | GroupSafetyEvent
  | RecoveryUnavailableEvent
  | GroupConditionEvent

export type DevicePackageAdapters = {
  providerID: string
  ownerDID: string
  sources: Array<BundleSource & { kind: PackageUse['kind']; providerID: string; ownerDID: string }>
  stores: Array<{
    sourceID: string
    kind: PackageUse['kind']
    providerID: string
    ownerDID: string
    store: KeyPackagePoolStore | LastResortStore
  }>
  rotateAvailability(): Promise<void> // durable fresh provisioning; uploads stay outside transactions
  cleanup(row: HubCleanupRow): Promise<'removed' | 'expired' | 'retry' | 'unsupported'>
}

export type GroupBatchOptions = {
  maxBatchFrames?: number
  maxBatchDelayMs?: number
  maxBatchWorkMs?: number
}
