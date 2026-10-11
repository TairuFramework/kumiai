import type { LeafNodeExtension } from 'ts-mls'

import type { ConformanceAnchorSlot, ConformanceAnchorStore } from './anchor-store.js'
import type {
  ConformanceAdoptionWrite,
  ConformanceControlChanges,
  ConformanceControlSnapshot,
  ConformanceControlStore,
} from './control-store.js'

export type ConformanceMemberCredential = { id: string; groupID: string }
export type ConformanceSignedEvent = {
  event: {
    v: 1
    t: 'icp' | 'rot' | 'rev'
    i?: string
    g: number
    s: number
    p?: string
    crit: boolean
  }
  sigs: Array<string>
  recoveryKey?: string
}
export type ConformanceControllerBinding = {
  id: string
  prefix: Array<ConformanceSignedEvent>
  capability: string
  holderGrant?: string
}
export type ConformanceDeviceRegistry = {
  devices: ReadonlyMap<
    string,
    {
      controller: string
      status: 'active' | 'revoked'
      label?: string
      logPosition?: number
      reason?: 'reset'
      cascadedFrom?: string
    }
  >
  controllers: ReadonlyMap<
    string,
    {
      recordedLog: Array<ConformanceSignedEvent>
      genFloor: number
      timeFloor: number
      beacon?: { logLength: number; headDigest: string }
    }
  >
}
export type ConformanceLeafNode = {
  hpkePublicKey: Uint8Array
  signaturePublicKey: Uint8Array
  credential:
    | { credentialType: 1; identity: Uint8Array }
    | { credentialType: 2; certificates: Array<Uint8Array> }
    | { credentialType: number; data: Uint8Array }
  capabilities: {
    versions: Array<number>
    ciphersuites: Array<number>
    extensions: Array<number>
    proposals: Array<number>
    credentials: Array<number>
  }
  signature: Uint8Array
  extensions: Array<LeafNodeExtension>
} & (
  | { leafNodeSource: 1; lifetime: { notBefore: bigint; notAfter: bigint } }
  | { leafNodeSource: 2 }
  | { leafNodeSource: 3; parentHash: Uint8Array }
)
export type ConformancePublicTree = Array<
  | { nodeType: 1; leaf: ConformanceLeafNode }
  | {
      nodeType: 2
      parent: { hpkePublicKey: Uint8Array; parentHash: Uint8Array; unmergedLeaves: Array<number> }
    }
  | undefined
>
export type ConformanceAppCursorStore = {
  load(topicID: string): Promise<string | null>
  save(topicID: string, position: string): Promise<void>
}
export type ConformanceKeyPackageRecord = {
  kind: 'ordinary'
  ref: string
  keyPackage: string
  privatePackage: string
  notAfter: number
}
export type ConformanceLastResortRecord = Omit<ConformanceKeyPackageRecord, 'kind'> & {
  kind: 'last-resort'
  uploadedAt: number | null
}
export type ConformanceKeyPackagePoolStore = {
  list(ownerDID: string): Promise<Array<ConformanceKeyPackageRecord>>
  put(ownerDID: string, record: ConformanceKeyPackageRecord): Promise<void>
  delete(ownerDID: string, ref: string): Promise<void>
  consume(ref: string, groupID: string): Promise<void>
  receipt(ref: string): Promise<{ groupID: string } | null>
}
export type ConformanceLastResortStore = Omit<ConformanceKeyPackagePoolStore, 'list' | 'put'> & {
  list(ownerDID: string): Promise<Array<ConformanceLastResortRecord>>
  put(ownerDID: string, record: ConformanceLastResortRecord): Promise<void>
}

export type ConformanceGroupKey = { groupID: string; incarnation: number }

export type ConformanceEpochIdentity = ConformanceGroupKey & {
  epoch: number
  authenticator: Uint8Array
}

export type ConformancePackageUse = {
  sourceID: string
  ref: string
  kind: 'ordinary' | 'last-resort'
}

export type ConformanceGroupLifetime = {
  groupID: string
  latestIncarnation: number
  activeIncarnation: number | null
  revision: number
  mutationID: string
  restorePending: boolean
}

export type ConformanceGroupStateRecord = ConformanceGroupKey & { version: number } & (
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

export type ConformanceGroupRecoveryTrust = {
  groupID: string
  genesisAnchor: Uint8Array
  installed: ConformanceEpochIdentity
  signerTree: ConformancePublicTree
  registry: ConformanceDeviceRegistry
  credential: ConformanceMemberCredential
  binding: ConformanceControllerBinding | null
  ledger: Array<string>
  ciphersuiteName: string
  spentEpochAuthenticators: Array<Uint8Array>
}

export type ConformanceGroupTransaction = {
  providerID: string
  groupID: string | null
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}

export type ConformanceIncarnationStores<Position extends string = string> = {
  state: {
    load(): Promise<ConformanceGroupStateRecord | null>
    loadInitialIdentity(): Promise<ConformanceEpochIdentity | null>
    save(
      record: ConformanceGroupStateRecord,
      expected?: ConformanceAdoptionWrite<Position>['expected'],
    ): Promise<void>
  }
  control: {
    load(): Promise<ConformanceControlSnapshot<Position>>
    apply(changes: ConformanceControlChanges<Position>, mutationID: string): Promise<void>
  }
  anchor: {
    load(): Promise<ConformanceAnchorSlot | null>
    save(slot: ConformanceAnchorSlot | null): Promise<void>
  }
  pending: {
    list(): Promise<Array<ConformanceStoragePendingAppFrame>>
    put(records: Array<ConformanceStoragePendingAppFrame>): Promise<void>
    poison(records: Array<ConformanceAppPoisonRecord>): Promise<void>
    listPoison(): Promise<Array<ConformanceAppPoisonRecord>>
    complete(ids: Array<string>): Promise<void>
  }
  cursor: {
    load(topicID: string): Promise<string | null>
    save(topicID: string, position: string): Promise<void>
  }
  outbox: {
    list(): Promise<Array<ConformanceStorageAppOutboxEntry>>
    put(entries: Array<ConformanceStorageAppOutboxEntry>): Promise<void>
    remove(seqs: Array<number>): Promise<void>
    clear(): Promise<void>
  }
  meta: {
    loadSettlement(seq: number): Promise<ConformanceAppSettlementObligation | null>
    putSettlement(seq: number, value: ConformanceAppSettlementObligation | null): Promise<void>
    events(): Promise<Array<ConformancePersistenceEvent>>
    putEvents(events: Array<ConformancePersistenceEvent>): Promise<void>
    ackEvent(id: string): Promise<void>
  }
  clearTransport(): Promise<void> // preserves owed outcomes/Welcomes, fork evidence and unacked events
}

export type ConformanceGroupStores<
  TTx extends ConformanceGroupTransaction,
  Position extends string = string,
> = {
  tx: TTx
  lifetime: {
    load(): Promise<ConformanceGroupLifetime | null>
    save(value: ConformanceGroupLifetime): Promise<void>
  }
  trust: {
    load(): Promise<ConformanceGroupRecoveryTrust | null>
    save(value: ConformanceGroupRecoveryTrust): Promise<void>
  }
  incarnation(incarnation: number): ConformanceIncarnationStores<Position>
}

export type ConformanceGroupTransition = {
  groupID: string
  mutationID: string
  expected: { revision: number; activeIncarnation: number | null } | null
}

export type ConformanceGroupPersistence<
  TTx extends ConformanceGroupTransaction,
  Position extends string = string,
> = {
  load(groupID: string): Promise<ConformanceGroupLifetime | null>
  loadState(key: ConformanceGroupKey): Promise<ConformanceGroupStateRecord | null>
  readEvidence(key: ConformanceGroupKey): Promise<{
    source: {
      key: ConformanceGroupKey
      stateVersion: number
      identity: ConformanceEpochIdentity | null
    }
    applied: ConformanceControlSnapshot<Position>['applied']
    cursor: ConformanceControlSnapshot<Position>['cursor']
    terminal: boolean
  }>
  loadTrust(groupID: string): Promise<ConformanceGroupRecoveryTrust | null>
  list(): Promise<Array<ConformanceGroupLifetime>>
  ports(key: ConformanceGroupKey): ConformanceGroupPersistencePorts<Position>
  transition<TValue>(
    change: ConformanceGroupTransition,
    work: (stores: ConformanceGroupStores<TTx, Position>) => Promise<TValue>,
  ): Promise<TValue>
  resolve(groupID: string, mutationID: string): Promise<'committed' | 'rolled-back'>
}

export type ConformanceGroupPersistencePorts<Position extends string = string> = {
  key: ConformanceGroupKey
  control: ConformanceControlStore<Position>
  outbox: ConformanceStorageAppOutbox
  anchor: ConformanceAnchorStore
  cursor: ConformanceAppCursorStore
}

export type ConformanceOwnershipContextPort = {
  run<T>(token: object, fn: () => T): T
  get(): object | undefined
}

export type ConformanceAtRestCodec = {
  seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}

export type ConformanceTransactionHookSettlement = {
  settle(outcome: 'committed' | 'rolled-back'): void
}

export type ConformanceOutcomeAwareTransactionOptions = {
  onUnknown(settlement: ConformanceTransactionHookSettlement): void
}

export type ConformanceMemoryStoreRows = Record<string, Map<string, unknown>>

export type ConformanceMemoryTransaction = ConformanceGroupTransaction & {
  rows: ConformanceMemoryStoreRows
}

export type ConformanceMemoryDatabase = {
  transact<TValue>(
    scope: { groupID: string | null; devicePackages: boolean },
    fn: (tx: ConformanceMemoryTransaction) => Promise<TValue>,
    options?: ConformanceOutcomeAwareTransactionOptions,
  ): Promise<TValue>
  completionBarrier(scope: { groupID: string | null; devicePackages: boolean }): Promise<void>
  snapshot(): ConformanceMemoryStoreRows
}

export type ConformanceDeviceRecord = {
  revision: number
  mutationID: string
  restoreWork: ConformanceRestoreWork | null
}

export type ConformanceHubCleanupRow = ConformancePackageUse & {
  id: string
  ownerDID: string
  groupID: string | null
  notAfter: number
}

export type ConformanceRestoreWork = {
  id: string
  stage: 'invalidate' | 'rotate' | 'groups'
  remainingGroups: Array<string>
}

export type ConformanceDeviceStores<
  TTx extends ConformanceGroupTransaction,
  Position extends string = string,
> = {
  tx: TTx
  group: ConformanceGroupStores<TTx, Position> | null
  ordinary(sourceID: string): ConformanceKeyPackagePoolStore
  lastResort(sourceID: string): ConformanceLastResortStore
  cleanup: {
    list(): Promise<Array<ConformanceHubCleanupRow>>
    put(row: ConformanceHubCleanupRow): Promise<void>
    remove(id: string): Promise<void>
  }
  restore: {
    load(): Promise<ConformanceRestoreWork | null>
    save(work: ConformanceRestoreWork | null): Promise<void>
  }
}

export type ConformanceDevicePersistence<
  TTx extends ConformanceGroupTransaction,
  Position extends string = string,
> = {
  providerID: string
  ownerDID: string
  groups: ConformanceGroupPersistence<TTx, Position>
  load(): Promise<ConformanceDeviceRecord>
  transition<TValue>(
    change: {
      mutationID: string
      expectedRevision: number
      group: ConformanceGroupTransition | null
    },
    work: (stores: ConformanceDeviceStores<TTx, Position>) => Promise<TValue>,
  ): Promise<TValue>
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
}

export type ConformanceTransactionalGroupEffects<TTx extends ConformanceGroupTransaction> = {
  outbox?(tx: TTx, event: ConformanceAppStatusEvent): Promise<void>
  delete?(tx: TTx, key: ConformanceGroupKey): Promise<void>
}

export type ConformanceRawStoredRecord = {
  groupID: string
  incarnation: number | null
  namespace: string
  recordID: string
  key: string
  bytes: Uint8Array
}

export type ConformancePendingCommitFault = {
  rejected: Promise<void>
  barrierWaiting: Promise<void>
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}

type ConformanceFixtureGroupStores<TPorts> = TPorts extends {
  device: {
    groups: {
      transition(change: never, work: (stores: infer TStores) => Promise<unknown>): Promise<unknown>
    }
  }
}
  ? TStores
  : never

type ConformanceFixtureDeviceStores<TPorts> = TPorts extends {
  device: {
    transition(change: never, work: (stores: infer TStores) => Promise<unknown>): Promise<unknown>
  }
}
  ? TStores
  : never

export type ConformancePersistenceFixture<TPorts> = {
  ports: TPorts
  reopen(): Promise<TPorts>
  reopenWithoutBarrier(): Promise<TPorts>
  failNext(point: 'after-first-write' | 'before-commit' | 'status-read'): void
  commitThenReject(): void
  rejectCommitPending(): ConformancePendingCommitFault
  holdNextSeal(): { reached: Promise<void>; release(): void }
  failNextSeal(error?: Error): void
  holdNextOpen(): { started: Promise<void>; release(): void }
  failNextOpen(error?: Error): void
  probeCodec(fn: (phase: string) => Promise<void>): void
  onPhase(
    phase: 'prepare' | 'work' | 'effects' | 'finalise' | 'account' | 'proof' | 'hook',
    fn: () => Promise<void> | void,
  ): void
  readWith<T>(fn: (stores: ConformanceFixtureDeviceStores<TPorts>) => Promise<T>): Promise<T>
  combinedWith(signal: AbortSignal): Promise<void>
  retryNextTransition(): void
  forceOwnerMarker(
    owner: { groupID: string } | { ownerDID: string },
    marker: { mutationID: string; revision: number },
  ): Promise<void>
  deleteCommittedRow(namespace: string, key: string): Promise<void>
  constructGroupStores(
    tx: ConformanceFixtureGroupStores<TPorts> extends { tx: infer TTx } ? TTx : never,
    key: ConformanceGroupKey,
  ): ConformanceFixtureGroupStores<TPorts>
  inspectRows(): Promise<ConformanceMemoryStoreRows>
  inspectRawBytes(): Promise<Array<ConformanceRawStoredRecord>>
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

export type ConformancePreOpenAppFrameRef = ConformanceGroupKey & {
  id: string
  protocol: string
  topicID: string
  segment: number
  position: string // segment = anchor epoch
}

export type ConformanceStorageAppFrameRef = ConformancePreOpenAppFrameRef & { procedure: string }

export type ConformanceStoragePendingAppFrame = {
  frame: ConformanceStorageAppFrameRef
  payload: Uint8Array
  senderDID: string
  epoch: number
  idempotencyKey: string
}

export type ConformanceAppPoisonRecord = {
  frame: ConformancePreOpenAppFrameRef
  reason: string
  keyConsumed: boolean
}

export type ConformanceAppAttempt = {
  incarnation: number
  epoch: number
  floor: string | null
  attempts: number
  publishID: string
  segment: number
  topicID: string
}

export type ConformanceStorageAppOutboxEntry = {
  seq: number
  protocol: string
  prc: string
  data: Uint8Array
  lastAttempt: ConformanceAppAttempt | null
  status: 'accepted' | 'failed'
}

export type ConformanceStorageAppOutbox = {
  put(entry: ConformanceStorageAppOutboxEntry): Promise<void>
  list(): Promise<Array<ConformanceStorageAppOutboxEntry>>
  recordSettlement(
    seq: number,
    obligation: ConformanceAppSettlementObligation,
    expected: ConformanceAppSettlementExpected,
  ): Promise<ConformanceAppSettlementResult>
  loadSettlement(seq: number): Promise<ConformanceAppSettlementObligation | null>
  remove(seq: number, outcome?: ConformanceAppPublicationOutcome): Promise<void>
  clear(): Promise<void>
  events(): Promise<Array<ConformanceAppStatusEvent>>
  ackEvent(id: string): Promise<void>
}

export type ConformanceAppPublicationOutcome = {
  incarnation: number
  segment: number
  topicID: string
  position: string
}

export type ConformanceAppSettlementObligation = {
  sequenceID: string
  attemptID: string
  topicID: string
  outcome: 'published'
}

export type ConformanceAppSettlementExpected = {
  identity: ConformanceEpochIdentity
  stateVersion: number
  attemptID: string
}

export type ConformanceAppSettlementResult =
  | { recorded: true }
  | {
      recorded: false
      reason: 'identity-changed' | 'state-version-changed' | 'attempt-changed' | 'entry-missing'
    }

export type ConformanceAppStatusEvent = ConformanceGroupKey & {
  id: string
  entry: ConformanceStorageAppOutboxEntry
} & (
    | { kind: 'accepted' }
    | { kind: 'published'; occurrence: ConformanceAppPublicationOutcome }
    | {
        kind: 'failed'
        reason: 'incarnation-abandoned' | 'removed' | 'deleted' | 'database-restored'
        nextIncarnation?: number
      }
  )

export type ConformanceGroupForkEvidence =
  | {
      kind: 'digest-divergence'
      epoch: number
      position: string
      localDigest: string
      remoteDigest: string
    }
  | { kind: 'epoch-authenticator'; epoch: number; local: Uint8Array; remote: Uint8Array }
  | { kind: 'unexplained-own-commit'; epoch: number; position: string; digest: string }

export type ConformanceForkHalt = {
  eventID: string
  evidence: ConformanceGroupForkEvidence
  detectedAt: number
}

export type ConformanceGroupSafetyEvent = ConformanceGroupKey & {
  id: string
  kind: 'group:fork'
  halt: ConformanceForkHalt
}

export type ConformanceRecoveryUnavailableEvent = ConformanceGroupKey & {
  id: string
  kind: 'group:recovery-unavailable'
  reason: 'trust-unreadable'
}

export type ConformancePersistenceEvent =
  | ConformanceAppStatusEvent
  | ConformanceGroupSafetyEvent
  | ConformanceRecoveryUnavailableEvent

export type StorageTestPorts<TTx extends ConformanceGroupTransaction> = {
  device: ConformanceDevicePersistence<TTx>
  packageStores(sourceID: string): {
    ordinary: ConformanceKeyPackagePoolStore
    lastResort: ConformanceLastResortStore
  }
}
export type FixtureOptions<TTx extends ConformanceGroupTransaction> = {
  effects?: ConformanceTransactionalGroupEffects<TTx>
  ownershipContext?: ConformanceOwnershipContextPort
}

export type StorageConformanceParams<TTx extends ConformanceGroupTransaction> = {
  label: string
  ownershipContext?: () => ConformanceOwnershipContextPort
  lowerEpochCandidate(groupID: string): Promise<{
    state: ConformanceGroupStateRecord & { deleted: false }
    trust: ConformanceGroupRecoveryTrust
  }>
  writeSideRow(tx: TTx, key: string, bytes: Uint8Array): Promise<void>
  createFixture(
    id: string,
    options?: FixtureOptions<TTx>,
  ): Promise<ConformancePersistenceFixture<StorageTestPorts<TTx>>>
}
