import type { GroupHandle } from '@kumiai/mls'
import type {
  AdoptionExpected,
  AdoptionWrite,
  GroupCondition,
  LogPosition,
  RecoverySource,
  ResyncProof,
  SendAdmission,
} from '@kumiai/rpc'

import type { ControlReadScope, HandleAccess } from '../access.js'
import type {
  DevicePersistence,
  EpochIdentity,
  GroupKey,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupTransaction,
  OpenAppInput,
  OpenAppResult,
  PackageUse,
  PendingAppFrames,
} from '../persistence-types.js'
import type { RecoveryEnvironment } from './validation.js'

export type GroupRuntimeSnapshot = EpochIdentity & {
  condition?: GroupCondition | null
  stateVersion: number
  members: ReadonlySet<string>
  available: boolean
}
export type GroupEpochRuntime = {
  snapshot(): GroupRuntimeSnapshot | null
  onEpochChanged(listener: (value: GroupRuntimeSnapshot | null) => void): () => void
}
export type SealedApp = { ciphertext: Uint8Array; epoch: number; generation: number }
export type ReceiveInput = { ciphertext: Uint8Array; expectedAAD: Uint8Array }
export type ReceiveResult =
  | {
      kind: 'opened'
      payload: Uint8Array
      senderDID?: string
      aad: Uint8Array
      frameEpoch: number
      handleEpoch: number
    }
  | {
      kind: 'refused'
      reason: 'past-epoch' | 'future-epoch'
      frameEpoch: number
      handleEpoch: number
    }
  | {
      kind: 'refused'
      reason:
        | 'log-intent'
        | 'consumed'
        | 'closed-epoch'
        | 'generation-bound'
        | 'capacity'
        | 'invalid'
      error?: unknown
    }
export type RegistryHandleAccess = {
  receive(frames: Array<ReceiveInput>): Promise<Array<ReceiveResult>>
  seal(
    plaintext: Uint8Array,
    opts: { aad: Uint8Array; intent: 'log' | 'ephemeral' },
  ): Promise<SealedApp>
  onRotationRequired(listener: (identity: EpochIdentity) => void): () => void
  key: GroupKey
  runtime: GroupEpochRuntime
  epoch(): number
  stateVersion(): number
  admission(): SendAdmission
  read<T>(fn: (handle: GroupHandle) => T | Promise<T>): Promise<T>
  readControl<T>(fn: (scope: ControlReadScope) => Promise<T>): Promise<T>
  openBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>
  pending: PendingAppFrames
  mutate: HandleAccess['mutate']
  replace: HandleAccess['replace']
  adopt(
    next: GroupHandle,
    expected: AdoptionExpected,
    write: AdoptionWrite,
  ): Promise<'installed' | 'noop' | 'moved'>
  onRetire(hook: () => Promise<void>): () => void
}
export type LegacyRegistryRecoverySource = AdoptionExpected & {
  trust: GroupRecoveryTrust
  lifetimeRevision: number
}
export type LegacyResyncProof = {
  targetID: string
  topicID: string
  groupInfoEpoch: number
  captureHead: LogPosition | null
  position: LogPosition
  payloadDigest: string
  verdict: Uint8Array
}
export type RegistrySwitchWrite = {
  mutationID: string
  source: { rejoinID: string; authorisationID?: string }
  destination: { control: { cursor: { position: LogPosition; epoch: number } } }
}
export type GroupHandleRegistry = {
  switchIncarnation(
    candidate: GroupHandle,
    params: {
      source: LegacyRegistryRecoverySource | RegistryRecoverySource
      rejoinID: string
      proof: LegacyResyncProof | ResyncProof
      write: RegistrySwitchWrite
    },
  ): Promise<GroupKey>
  start(): Promise<void>
  seed(
    group: GroupHandle,
    params: { replace?: boolean; packageUse: PackageUse | null },
  ): Promise<GroupKey>
  access(groupID: string): Promise<RegistryHandleAccess>
  recoverySource(groupID: string): Promise<RegistryRecoverySource>
  delete(key: GroupKey): Promise<void>
  dispose(): Promise<void>
}
export type ReadableGroupState = GroupStateRecord & { deleted: false; state: Uint8Array }

export type RetirementAttempt = {
  generation: number
  drain(): Promise<void>
  settle(outcome: 'committed' | 'rolled-back'): void
}

/** Providers must register entry capability and a shared coordinator token for every root wrapper.
 * Copied wrappers are unregistered; one live registry owns the shared token. */
export type GroupHandleRegistryParams<TTx extends GroupTransaction> = {
  persistence: DevicePersistence<TTx>
  providerID: string
  recovery: RecoveryEnvironment
  restore(record: ReadableGroupState): Promise<GroupHandle>
  restoreCandidate(candidate: Uint8Array): Promise<GroupHandle>
}

export type RegistryRecoverySource = RecoverySource<GroupRecoveryTrust>
export type { ResyncProof } from '@kumiai/rpc'
