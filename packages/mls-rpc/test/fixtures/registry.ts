import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  commitKeyRotation,
  createGroup,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  type GroupOptions,
  restoreGroup,
} from '@kumiai/mls'
import type { AnchorSlot, ControlChanges, RejoinRecord } from '@kumiai/rpc'

import { type EntryCapability, entryCapability } from '../../src/entry-capability.js'
import { physicalRecordKey } from '../../src/persistence-codec.js'
import type {
  AppOutboxEntry,
  AppSettlementObligation,
  DevicePersistence,
  GroupKey,
  GroupRecoveryTrust,
  GroupStateRecord,
  GroupStores,
  MemoryStoreRows,
  MemoryTransaction,
  PackageUse,
  PersistenceEvent,
} from '../../src/persistence-types.js'
import { registryRetirement } from '../../src/registry/retirement.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import type { GroupHandleRegistry } from '../../src/registry/types.js'
import { type RecoveryEnvironment, registryOptions } from '../../src/registry/validation.js'
import { deferred } from '../../src/runtime.js'
import { createRegistryRecovery } from './registry-recovery.js'
import { createRegistryWelcomeHistory, registryHandle } from './registry-welcome.js'
import { memoryModel, restoreMemoryControlHandle } from './sealed-memory-mls.js'
import { createStorageFixture, type RegistryStorageFixture } from './storage-persistence.js'
import { nextChange } from './storage-seed.js'

export type RegistryRowSetup = {
  key: GroupKey
  state?: GroupStateRecord
  trust?: GroupRecoveryTrust
  control?: ControlChanges
  anchor?: AnchorSlot | null
  outbox?: Array<AppOutboxEntry>
  events?: Array<PersistenceEvent>
  settlements?: Array<{ seq: number; value: AppSettlementObligation }>
}
export type RegistryFixtureBase = {
  device: DevicePersistence<MemoryTransaction>
  identity: OwnIdentity
  environment: RecoveryEnvironment
  makeHandle(epoch: number): Promise<GroupHandle>
  advance(handle: GroupHandle): Promise<GroupHandle>
  welcomeHistory(kind: PackageUse['kind']): Promise<{
    exact: GroupHandle
    alternate: GroupHandle
    newer: GroupHandle
    unusedOlder: GroupHandle
    packageUse: PackageUse
  }>
  confirmedRecovery(sourceKey: GroupKey): Promise<{ candidate: GroupHandle; record: RejoinRecord }>
  installRows(rows: RegistryRowSetup): Promise<void>
  inspectRows(): Promise<MemoryStoreRows>
  corruptState(key: GroupKey): Promise<void>
  removeStateBytes(key: GroupKey): Promise<void>
  corruptTrust(groupID: string): Promise<void>
  mutateMetadata(key: GroupKey, fn: (value: unknown) => unknown): Promise<void>
  holdRestore(groupID: string): { started: Promise<void>; release(): void }
  holdProof(mutationID: string): { started: Promise<void>; release(): void }
  restoreCount(groupID: string): number
  overrideRestore(
    fn: (record: GroupStateRecord & { deleted: false; state: Uint8Array }) => Promise<GroupHandle>,
  ): void
  onPhase(
    phase: 'prepare' | 'work' | 'effects' | 'finalise' | 'account' | 'proof' | 'hook',
    fn: () => void | Promise<void>,
  ): void
  constructPrepareStores(): GroupStores<MemoryTransaction>
  reopen(): Promise<RegistryFixtureBase>
  close(): Promise<void>
  armNextWorkFault(point: 'pending'): PendingFault & { mutationID: Promise<string> }
  armNextWorkFault(point: 'after-first-write' | 'before-commit' | 'commit-then-reject'): {
    mutationID: Promise<string>
  }
  armWorkFault(mutationID: string, point: 'pending'): PendingFault
  armWorkFault(
    mutationID: string,
    point: 'after-first-write' | 'before-commit' | 'commit-then-reject',
  ): void
}
export type PendingFault = {
  rejected: Promise<void>
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}

type FixtureParams = {
  mode: 'real-mls' | 'double'
  setup: 'empty' | 'seeded'
  groupID: string
  options?: GroupOptions
}
type Hold = {
  started: ReturnType<typeof deferred<void>>
  released: ReturnType<typeof deferred<void>>
}

// The restore callback is fixture instrumentation, never a registry implementation.
const restorers = new WeakMap<
  RegistryFixtureBase,
  (record: GroupStateRecord & { deleted: false; state: Uint8Array }) => Promise<GroupHandle>
>()
const markerWriters = new WeakMap<RegistryFixtureBase, RegistryStorageFixture['forceOwnerMarker']>()
export function registryFixtureRestore(fixture: RegistryFixtureBase) {
  const restore = restorers.get(fixture)
  if (restore === undefined) throw new Error('Unknown registry fixture')
  return restore
}

export function registryFixtureRetirement(registry: GroupHandleRegistry) {
  return registryRetirement(registry)
}

export function registryFixtureForceOwnerMarker(
  fixture: RegistryFixtureBase,
  ...args: Parameters<RegistryStorageFixture['forceOwnerMarker']>
): Promise<void> {
  const write = markerWriters.get(fixture)
  if (write === undefined) throw new Error('Unknown registry fixture')
  return write(...args)
}

export function registryFixtureObserve(
  fixture: RegistryFixtureBase,
  ...args: Parameters<EntryCapability<MemoryTransaction>['observe']>
): () => void {
  const capability = entryCapability(fixture.device.groups)
  if (capability === null) throw new Error('Unknown registry fixture capability')
  return capability.observe(...args)
}

export async function createRegistryFixture(params: FixtureParams): Promise<RegistryFixtureBase> {
  return assemble(params, randomIdentity())
}

async function assemble(
  params: FixtureParams,
  identity: OwnIdentity,
  rows?: MemoryStoreRows,
): Promise<RegistryFixtureBase> {
  const environment: RecoveryEnvironment = {
    identity,
    options: registryOptions(params.options ?? {}),
  }
  const storage = await createStorageFixture({
    id: params.groupID,
    mode: params.mode,
    identity,
    setup: 'empty',
    rows,
  })
  const key = { groupID: params.groupID, incarnation: 1 }
  const restoreHolds = new Map<string, Hold>()
  const counts = new Map<string, number>()
  let override:
    | ((record: GroupStateRecord & { deleted: false; state: Uint8Array }) => Promise<GroupHandle>)
    | undefined
  let closed = false
  async function restore(
    record: GroupStateRecord & { deleted: false; state: Uint8Array },
  ): Promise<GroupHandle> {
    if (closed) throw new Error('Closed registry fixture')
    counts.set(record.groupID, (counts.get(record.groupID) ?? 0) + 1)
    const hold = restoreHolds.get(record.groupID)
    if (hold !== undefined) {
      hold.started.resolve()
      await hold.released.promise
      restoreHolds.delete(record.groupID)
    }
    if (override !== undefined) return override(record)
    const state = decodeClientState(record.state)
    if (state === undefined) throw new Error('Invalid fixture state')
    return (params.mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
      state,
      credential: record.credential,
      ledgerEntries: record.ledger,
      options: environment.options,
    })
  }
  function hold(map: Map<string, Hold>, id: string) {
    if (map.has(id)) throw new Error('Already held')
    const value = { started: deferred<void>(), released: deferred<void>() }
    map.set(id, value)
    return { started: value.started.promise, release: () => value.released.resolve() }
  }
  const fixture: RegistryFixtureBase = {
    device: storage.ports.device,
    identity,
    environment,
    async makeHandle(epoch) {
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid fixture epoch')
      let handle = (await createGroup(identity, params.groupID, environment.options)).group
      while (Number(handle.epoch) < epoch) handle = (await commitKeyRotation(handle)).newGroup
      return registryHandle({ mode: params.mode, handle, options: environment.options })
    },
    async advance(handle) {
      if (params.mode === 'real-mls') return (await commitKeyRotation(handle)).newGroup
      const candidate = await restoreMemoryControlHandle({
        state: structuredClone(handle.state),
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
        options: environment.options,
      })
      const model = memoryModel(candidate)
      await model.adopt(model.buildCommit([]))
      return candidate
    },
    async welcomeHistory(kind) {
      return (
        await createRegistryWelcomeHistory({
          ...params,
          identity,
          options: environment.options,
          kind,
        })
      ).history
    },
    async confirmedRecovery(sourceKey) {
      const record = await fixture.device.groups.loadState(sourceKey)
      if (record === null || record.deleted || record.state === null)
        throw new Error('Missing recovery source')
      const source = await restore({ ...record, state: record.state })
      const result = await createRegistryRecovery({
        ...params,
        identity,
        options: environment.options,
        source,
        sourceKey,
      })
      return result
    },
    async installRows(setup) {
      const groups = fixture.device.groups
      const mutationID = crypto.randomUUID()
      const change = await nextChange(groups, setup.key.groupID, mutationID)
      await groups.transition(change, async (stores) => {
        if (change.expected === null)
          await stores.lifetime.save({
            groupID: setup.key.groupID,
            latestIncarnation: setup.key.incarnation,
            activeIncarnation: setup.key.incarnation,
            revision: 1,
            mutationID,
            restorePending: false,
          })
        const target = stores.incarnation(setup.key.incarnation)
        if (setup.state !== undefined) await target.state.save(setup.state)
        if (setup.trust !== undefined) await stores.trust.save(setup.trust)
        if (setup.control !== undefined) await target.control.apply(setup.control, mutationID)
        if (setup.anchor !== undefined) await target.anchor.save(setup.anchor)
        if (setup.outbox !== undefined) await target.outbox.put(setup.outbox)
        if (setup.events !== undefined) await target.meta.putEvents(setup.events)
        for (const value of setup.settlements ?? [])
          await target.meta.putSettlement(value.seq, value.value)
      })
    },
    inspectRows: storage.inspectRows,
    async corruptState(target) {
      await corrupt(storage, 'state', target)
    },
    async removeStateBytes(target) {
      await storage.deleteCommittedRow(
        'state',
        physicalRecordKey({ ...target, namespace: 'state', recordID: 'current' }),
      )
    },
    async corruptTrust(groupID) {
      await corrupt(storage, 'trust', { groupID, incarnation: null })
    },
    mutateMetadata: storage.mutateMetadata,
    holdRestore: (groupID) => hold(restoreHolds, groupID),
    holdProof: storage.holdProof,
    restoreCount: (groupID) => counts.get(groupID) ?? 0,
    overrideRestore: (fn) => {
      override = fn
    },
    onPhase: storage.onPhase,
    constructPrepareStores: () => storage.constructPrepareStores(key),
    async reopen() {
      await storage.reopen()
      const committed = await storage.inspectRows()
      await fixture.close()
      return assemble({ ...params, setup: 'empty' }, identity, committed)
    },
    async close() {
      if (closed) return
      closed = true
      for (const value of restoreHolds.values()) value.released.resolve()
      restoreHolds.clear()
      override = undefined
      counts.clear()
      await storage.close()
    },
    armNextWorkFault: storage.armNextWorkFault,
    armWorkFault: storage.armWorkFault,
  }
  restorers.set(fixture, restore)
  markerWriters.set(fixture, storage.forceOwnerMarker)
  if (params.setup === 'seeded' && rows === undefined) {
    const handle = await fixture.makeHandle(0)
    await fixture.installRows({
      key,
      state: {
        ...key,
        version: 1,
        deleted: false,
        terminal: false,
        epoch: Number(handle.epoch),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
        state: encodeClientState(handle.state),
        credential: handle.credential,
        ledger: handle.ledgerTokens,
        senderHWM: 0,
      },
      trust: recoveryTrustFor(handle, key, null),
    })
  }
  return fixture
}

async function corrupt(
  storage: RegistryStorageFixture,
  namespace: string,
  key: { groupID: string; incarnation: number | null },
) {
  await storage.mutateStoredRecord(
    namespace,
    physicalRecordKey({ ...key, namespace, recordID: 'current' }),
    (bytes) => {
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
      return bytes
    },
  )
}
