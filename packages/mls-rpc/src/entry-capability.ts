import type { CheckpointRecord, ControlSnapshot, GroupCondition } from '@kumiai/rpc'

import type {
  EpochIdentity,
  GroupKey,
  GroupLifetime,
  GroupPersistence,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  GroupTransaction,
  GroupTransition,
  PersistenceEvent,
} from './persistence-types.js'

export type StateMetadata = GroupKey & {
  version: number
  deleted: boolean
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
  trustStatus: 'missing' | 'readable' | 'unreadable'
  activeKey: GroupKey | null
  activeVersion: number | null
  control: ControlSnapshot | null
  controlStatus: 'missing' | 'readable' | 'unreadable'
  stateStatus: 'missing' | 'null' | 'deleted' | 'readable' | 'unreadable'
  terminal: boolean | null
}
export type EntryReads = {
  checkpoints(): Promise<Array<CheckpointRecord>>
  lifetime(): Promise<GroupLifetime | null>
  trust(): Promise<GroupRecoveryTrust | null>
  metadata(incarnation: number): Promise<StateMetadata | null>
  state(incarnation: number): Promise<GroupStateRecord | null>
  control(incarnation: number): Promise<ControlSnapshot>
  events(incarnation: number): Promise<Array<PersistenceEvent>>
  controlMutation(incarnation: number): Promise<string | null>
  diagnoseState(
    incarnation: number,
  ): Promise<'missing' | 'null' | 'deleted' | 'readable' | 'unreadable'>
}
export type Prepared<T> = {
  expected: GroupTransition['expected']
  mutationID?: string
  value: T
}
export type EntryCapability<TTx extends GroupTransaction> = {
  activity(groupID: string, excludingMutationID?: string): { generation: number; pending: number }
  failureSignal?: AbortSignal
  observe(
    groupID: string,
    onProof: (observation: AccountedGroupObservation) => void,
    afterRelease?: (observation: AccountedGroupObservation) => void,
  ): () => void

  read<T>(groupID: string, fn: (reads: EntryReads) => Promise<T>): Promise<T>
  run<P, T>(
    // Null binds the ID supplied by prepare before any work write.
    request: { groupID: string; mutationID: string | null },
    prepare: (reads: EntryReads) => Promise<Prepared<P>>,
    work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
  ): Promise<T>
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
