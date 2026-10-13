import type { ConformanceAnchorSlot } from './anchor-store.js'
import type {
  ConformanceAdoptionExpected,
  ConformanceAdoptionWrite,
  ConformanceControlChanges,
  ConformanceControlSnapshot,
  ConformanceRejoinRecord,
  ConformanceWelcomeObligation,
} from './control-store.js'
import type { ConformanceSendAdmission } from './group-mls.js'
import type {
  ConformanceAppSettlementObligation,
  ConformanceDevicePersistence,
  ConformanceEpochIdentity,
  ConformanceGroupKey,
  ConformanceGroupRecoveryTrust,
  ConformanceGroupStateRecord,
  ConformanceGroupStores,
  ConformanceGroupTransaction,
  ConformancePackageUse,
  ConformancePersistenceEvent,
  ConformanceStorageAppOutboxEntry,
} from './persistence-fixture.js'

export type ConformanceRegistryHandle = {
  groupID: string
  epoch: bigint
  credential: { id: string; groupID: string }
  ledgerTokens: Array<string>
  listMembers(): Array<{ id: string; leafIndex: number }>
  sendAdmission(): { epoch: number; admissible: boolean }
}
export type ConformanceRegistryRuntime = {
  snapshot():
    | (ConformanceEpochIdentity & {
        stateVersion: number
        members: ReadonlySet<string>
        available: boolean
      })
    | null
  onEpochChanged(
    listener: (value: ReturnType<ConformanceRegistryRuntime['snapshot']>) => void,
  ): () => void
}
export type ConformanceRegistryControlSnapshot = ConformanceControlSnapshot
export type ConformanceRegistryControlRead<THandle> = {
  handle: THandle
  source: ConformanceAdoptionExpected
}
export type ConformanceRegistryAdoptionFactory = (staged: {
  incarnation: number
  epochAfter: number
  removed: boolean
  epochAuthenticator: Uint8Array
}) => ConformanceAdoptionWrite<string>
export type ConformanceRegistryAccess<THandle> = {
  key: ConformanceGroupKey
  runtime: ConformanceRegistryRuntime
  epoch(): number
  stateVersion(): number
  admission(): ConformanceSendAdmission
  read<TValue>(fn: (handle: THandle) => TValue | Promise<TValue>): Promise<TValue>
  readControl<TValue>(
    fn: (
      scope: ConformanceRegistryControlRead<THandle> & {
        refresh(): Promise<ConformanceRegistryControlRead<THandle>>
      },
    ) => Promise<TValue>,
  ): Promise<TValue>
  mutate<TValue>(
    fn: (handle: THandle, persist: (handle: THandle) => Promise<void>) => Promise<TValue>,
    adoption?: ConformanceRegistryAdoptionFactory,
  ): Promise<TValue>
  replace(
    next: THandle,
    adoption?: ConformanceRegistryAdoptionFactory,
    prepare?: (current: THandle, source: ConformanceAdoptionExpected) => Promise<boolean>,
  ): Promise<void>
  adopt(
    next: THandle,
    expected: ConformanceAdoptionExpected,
    write: ConformanceAdoptionWrite<string>,
  ): Promise<'installed' | 'noop' | 'moved'>
  onRetire(hook: () => Promise<void>): () => void
}
export type ConformanceRegistryRecoverySource = ConformanceAdoptionExpected & {
  trust: ConformanceGroupRecoveryTrust
  lifetimeRevision: number
}
export type ConformanceRegistryResyncProof = {
  targetID: string
  topicID: string
  groupInfoEpoch: number
  captureHead: string | null
  position: string
  payloadDigest: string
  verdict: Uint8Array
}
export type ConformanceRegistrySwitchWrite = {
  mutationID: string
  source: { rejoinID: string }
  destination: { control: { cursor: { position: string; epoch: number } } }
}
export type ConformanceRegistry<THandle> = {
  start(): Promise<void>
  access(groupID: string): Promise<ConformanceRegistryAccess<THandle>>
  seed(
    group: THandle,
    params: { replace?: boolean; packageUse: ConformancePackageUse | null },
  ): Promise<ConformanceGroupKey>
  recoverySource(groupID: string): Promise<ConformanceRegistryRecoverySource>
  switchIncarnation(
    candidate: THandle,
    params: {
      source: ConformanceRegistryRecoverySource
      rejoinID: string
      proof: ConformanceRegistryResyncProof
      write: ConformanceRegistrySwitchWrite
    },
  ): Promise<ConformanceGroupKey>
  delete(key: ConformanceGroupKey): Promise<void>
  dispose(): Promise<void>
}

type RegistryFixtureRows = {
  key: ConformanceGroupKey
  state?: ConformanceGroupStateRecord
  trust?: ConformanceGroupRecoveryTrust
  control?: ConformanceControlChanges<string>
  anchor?: ConformanceAnchorSlot | null
  outbox?: Array<ConformanceStorageAppOutboxEntry>
  events?: Array<ConformancePersistenceEvent>
  settlements?: Array<{ seq: number; value: ConformanceAppSettlementObligation }>
}
type RegistryFixturePendingFault = {
  rejected: Promise<void>
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}
export type ConformanceRegistryFixtureBase<
  THandle,
  TTx extends ConformanceGroupTransaction = ConformanceGroupTransaction,
> = {
  device: ConformanceDevicePersistence<TTx>
  identity: { id: string; privateKey: Uint8Array; publicKey: Uint8Array }
  environment: {
    identity: { id: string; privateKey: Uint8Array; publicKey: Uint8Array }
    options: object
  }
  makeHandle(epoch: number, groupID?: string): Promise<THandle>
  authenticator(handle: THandle): Promise<Uint8Array>
  stateBytes(handle: THandle): Uint8Array
  advanceSender(handle: THandle): Promise<void>
  advance(handle: THandle): Promise<THandle>
  welcomeHistory(kind: ConformancePackageUse['kind']): Promise<{
    exact: THandle
    alternate: THandle
    restored: THandle
    newer: THandle
    unusedOlder: THandle
    packageUse: ConformancePackageUse
  }>
  confirmedRecovery(
    sourceKey: ConformanceGroupKey,
    options?: { confirm?: boolean; missingLedger?: boolean },
  ): Promise<{
    candidate: THandle
    record: ConformanceRejoinRecord
    source: ConformanceRegistryRecoverySource
    proof: ConformanceRegistryResyncProof
  }>
  acceptedOrdinary(
    access: ConformanceRegistryAccess<THandle>,
    options?: { accepted: boolean },
  ): Promise<{
    candidate: THandle
    alternate: THandle
    expected: ConformanceAdoptionExpected
    write: ConformanceAdoptionWrite<string>
  }>
  serveRetiredWelcomes(
    key: ConformanceGroupKey,
    deliver: (welcome: ConformanceWelcomeObligation) => Promise<void>,
  ): Promise<{ remaining: Array<string>; failures: Array<unknown> }>
  installRows(rows: RegistryFixtureRows): Promise<void>
  inspectRows(): Promise<Record<string, Map<string, unknown>>>
  corruptState(key: ConformanceGroupKey): Promise<void>
  removeStateBytes(key: ConformanceGroupKey): Promise<void>
  corruptTrust(groupID: string): Promise<void>
  mutateMetadata(key: ConformanceGroupKey, fn: (value: unknown) => unknown): Promise<void>
  holdColdPublication(groupID: string): { started: Promise<void>; release(): void }
  holdRestore(groupID: string): { started: Promise<void>; release(): void }
  holdProof(mutationID: string): { started: Promise<void>; release(): void }
  restoreCount(groupID: string): number
  coldLoadCount(groupID: string): number
  overrideRestore(
    fn: (
      record: ConformanceGroupStateRecord & { deleted: false; state: Uint8Array },
    ) => Promise<THandle>,
  ): void
  onPhase(
    phase: 'prepare' | 'work' | 'effects' | 'finalise' | 'account' | 'proof' | 'hook',
    fn: () => void | Promise<void>,
  ): void
  constructPrepareStores(): ConformanceGroupStores<TTx>
  reopen(): Promise<ConformanceRegistryFixtureBase<THandle, TTx>>
  close(): Promise<void>
  armNextWorkFault(point: 'pending'): RegistryFixturePendingFault & { mutationID: Promise<string> }
  armNextWorkFault(point: 'after-first-write' | 'before-commit' | 'commit-then-reject'): {
    mutationID: Promise<string>
  }
  armWorkFault(mutationID: string, point: 'pending'): RegistryFixturePendingFault
  armWorkFault(
    mutationID: string,
    point: 'after-first-write' | 'before-commit' | 'commit-then-reject',
  ): void
}
export type ConformanceRegistryFixture<
  THandle,
  TTx extends ConformanceGroupTransaction = ConformanceGroupTransaction,
> = Omit<ConformanceRegistryFixtureBase<THandle, TTx>, 'reopen'> & {
  registry: ConformanceRegistry<THandle>
  reopen(): Promise<ConformanceRegistryFixture<THandle, TTx>>
}
