import type { GroupHandle } from '@kumiai/mls'
import type { AdoptionExpected, SendAdmission } from '@kumiai/rpc'

import type { ControlReadScope } from '../access.js'
import type {
  DevicePersistence,
  EpochIdentity,
  GroupKey,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupTransaction,
} from '../persistence-types.js'
import type { RecoveryEnvironment } from './validation.js'

export type GroupRuntimeSnapshot = EpochIdentity & {
  stateVersion: number
  members: ReadonlySet<string>
  available: boolean
}
export type GroupEpochRuntime = {
  snapshot(): GroupRuntimeSnapshot | null
  onEpochChanged(listener: (value: GroupRuntimeSnapshot | null) => void): () => void
}
export type RegistryHandleAccess = {
  key: GroupKey
  runtime: GroupEpochRuntime
  epoch(): number
  stateVersion(): number
  admission(): SendAdmission
  read<T>(fn: (handle: GroupHandle) => T | Promise<T>): Promise<T>
  readControl<T>(fn: (scope: ControlReadScope) => Promise<T>): Promise<T>
  onRetire(hook: () => Promise<void>): () => void
}
export type RecoverySource = AdoptionExpected & {
  trust: GroupRecoveryTrust
  lifetimeRevision: number
}
export type GroupHandleRegistry = {
  start(): Promise<void>
  access(groupID: string): Promise<RegistryHandleAccess>
  recoverySource(groupID: string): Promise<RecoverySource>
}
export type ReadableGroupState = GroupStateRecord & { deleted: false; state: Uint8Array }

/** Providers must register entry capability and a shared coordinator token for every root wrapper.
 * Copied wrappers are unregistered; one live registry owns the shared token. */
export type GroupHandleRegistryParams<TTx extends GroupTransaction> = {
  persistence: DevicePersistence<TTx>
  providerID: string
  recovery: RecoveryEnvironment
  restore(record: ReadableGroupState): Promise<GroupHandle>
  restoreCandidate(candidate: Uint8Array): Promise<GroupHandle>
}
