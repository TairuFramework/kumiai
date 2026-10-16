import { createIdentity, type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  checkpointAuthHash,
  checkpointKeyHash,
  checkpointSignatureInput,
  commitKeyRotation,
  createGroup,
  decodeClientState,
  decodeEpochRosterFact,
  encodeClientState,
  encodeEpochCheckpoint,
  type GroupHandle,
  type GroupOptions,
  restoreGroup,
} from '@kumiai/mls'
import {
  type AdoptionWrite,
  type AnchorSlot,
  asLogPosition,
  type ControlChanges,
  type ControlSlot,
  type LogPosition,
  type WelcomeObligation,
} from '@kumiai/rpc'
import type { ConformanceControlSearchPort, ForkNoticeFixture } from '@kumiai/rpc-conformance'
import { ed25519 } from '@noble/curves/ed25519.js'
import { createApplicationMessage } from 'ts-mls'

import { createCheckpointService } from '../../src/checkpoint.js'
import { encodeControlJournal } from '../../src/control-journal.js'
import { controlBuildContexts } from '../../src/control-write-context.js'
import {
  bindEntryCapability,
  coordinatorBinding,
  type EntryCapability,
  type EntryReads,
  entryCapability,
} from '../../src/entry-capability.js'
import { createGroupMLS, createLedgerEntrySlot } from '../../src/mls.js'
import {
  decodeStoredValue,
  encodeStoredValue,
  physicalRecordKey,
  sealRecord,
} from '../../src/persistence-codec.js'
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
  OwnershipContextPort,
  PackageUse,
  PersistenceEvent,
  TransactionalGroupEffects,
} from '../../src/persistence-types.js'
import { createGroupHandleRegistry } from '../../src/registry/registry.js'
import { serveRetiredObligations } from '../../src/registry/retired.js'
import { registryRetirement } from '../../src/registry/retirement.js'
import { readRecoverySource } from '../../src/registry/source.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import type {
  GroupHandleRegistry,
  ReadableGroupState,
  RegistryHandleAccess,
} from '../../src/registry/types.js'
import { type RecoveryEnvironment, registryOptions } from '../../src/registry/validation.js'
import { deferred } from '../../src/runtime.js'
import { createGroupSafety, type GroupSafety } from '../../src/safety.js'
import { createDeterministicAtRestCodec } from './at-rest.js'
import { createRealGroup, testGroupMLSDependencies, testHandleAccess } from './real-group.js'
import {
  type CapturedRecoveryFixture,
  createRegistryRecovery,
  type LegacyRecoveryFixture,
} from './registry-recovery.js'
import { createRegistryWelcomeHistory, registryHandle } from './registry-welcome.js'
import { memoryModel, restoreMemoryControlHandle } from './sealed-memory-mls.js'
import { createStorageFixture, type RegistryStorageFixture } from './storage-persistence.js'
import { nextChange, storageTranscript, writeInstallationCheckpoint } from './storage-seed.js'

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
export type RegistryFixture = Omit<RegistryFixtureBase, 'reopen'> & {
  registry: GroupHandleRegistry
  safety(): GroupSafety
  reopen(): Promise<RegistryFixture>
}
export type RegistryFixtureBase = {
  device: DevicePersistence<MemoryTransaction>
  identity: OwnIdentity
  environment: RecoveryEnvironment
  makeHandle(epoch: number, groupID?: string): Promise<GroupHandle>
  authenticator(handle: GroupHandle): Promise<Uint8Array>
  stateBytes(handle: GroupHandle): Uint8Array
  advanceSender(handle: GroupHandle): Promise<void>
  acceptedOrdinary(
    access: RegistryHandleAccess,
    options?: { accepted: boolean },
  ): ReturnType<typeof acceptedOrdinary>
  serveRetiredWelcomes(
    key: GroupKey,
    deliver: (welcome: WelcomeObligation) => Promise<void>,
    search?: ConformanceControlSearchPort,
  ): Promise<{ remaining: Array<string>; failures: Array<unknown> }>
  advance(handle: GroupHandle): Promise<GroupHandle>
  welcomeHistory(kind: PackageUse['kind']): Promise<{
    exact: GroupHandle
    alternate: GroupHandle
    restored: GroupHandle
    newer: GroupHandle
    unusedOlder: GroupHandle
    packageUse: PackageUse
  }>
  confirmedRecovery(
    sourceKey: GroupKey,
    options?: { confirm?: boolean; missingLedger?: boolean; format?: 'legacy' | 'captured' },
  ): Promise<LegacyRecoveryFixture | CapturedRecoveryFixture>
  installRows(rows: RegistryRowSetup): Promise<void>
  inspectRows(): Promise<MemoryStoreRows>
  corruptState(key: GroupKey, damage?: 'unreadable' | 'client-state' | 'identity'): Promise<void>
  removeStateBytes(key: GroupKey): Promise<void>
  corruptTrust(groupID: string, damage?: 'unreadable' | 'empty-spent'): Promise<void>
  removeTrust(groupID: string): Promise<void>
  failTrustReads(error: Error | null): void
  mutateMetadata(key: GroupKey, fn: (value: unknown) => unknown): Promise<void>
  holdColdPublication(groupID: string): { started: Promise<void>; release(): void }
  holdRestore(groupID: string): { started: Promise<void>; release(): void }
  holdProof(mutationID: string): { started: Promise<void>; release(): void }
  restoreCount(groupID: string): number
  coldLoadCount(groupID: string): number
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
  identity?: OwnIdentity
  mode: 'real-mls' | 'double'
  setup: 'empty' | 'seeded'
  groupID: string
  options?: GroupOptions
  effects?: TransactionalGroupEffects<MemoryTransaction>
  ownershipContext?: OwnershipContextPort
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
const rowRemovers = new WeakMap<RegistryFixtureBase, RegistryStorageFixture['deleteCommittedRow']>()

const controlCorrupters = new WeakMap<RegistryFixtureBase, (key: GroupKey) => Promise<void>>()
type CapturedFixtureState = { keys: Set<string>; handles: WeakSet<GroupHandle> }
const capturedStates = new WeakMap<RegistryFixtureBase, CapturedFixtureState>()
function retainCapturedDestination(
  fixture: RegistryFixtureBase,
  recovery: { candidate: GroupHandle; source: { key: GroupKey } },
) {
  const retained = capturedStates.get(fixture)
  if (retained === undefined) throw new Error('Missing captured fixture state')
  retained.keys.add(
    JSON.stringify([recovery.source.key.groupID, recovery.source.key.incarnation + 1]),
  )
  retained.handles.add(recovery.candidate)
}

export async function registryFixtureCapturedRecovery(
  fixture: RegistryFixtureBase,
  sourceKey: GroupKey,
  options?: { confirm?: boolean; missingLedger?: boolean },
): Promise<CapturedRecoveryFixture> {
  const stored = await fixture.device.groups.loadState(sourceKey)
  if (stored === null || stored.deleted || stored.state === null)
    throw new Error('Missing recovery source')
  const result = await createRegistryRecovery({
    mode: 'real-mls',
    format: 'captured',
    identity: fixture.identity,
    options: fixture.environment.options,
    source: await registryFixtureRestore(fixture)({ ...stored, state: stored.state }),
    sourceKey,
    recoverySource: await registryFixtureRecoverySource(fixture, sourceKey),
    missingLedger: options?.missingLedger,
  })
  retainCapturedDestination(fixture, result)
  if (options?.confirm) {
    await fixture.installRows({ key: sourceKey, control: { putRejoin: result.record } })
    return { ...result, source: await registryFixtureRecoverySource(fixture, sourceKey) }
  }
  return result
}

export async function registryFixtureRecoverySource(fixture: RegistryFixtureBase, key: GroupKey) {
  const capability = entryCapability(fixture.device.groups)
  if (capability === null) throw new Error('Missing registry capability')
  const source = await capability.read(key.groupID, (reads) =>
    readRecoverySource(reads, key.groupID),
  )
  if (source.key.incarnation !== key.incarnation) throw new Error('Displaced fixture source')
  return source
}

export async function registryFixtureCorruptControl(fixture: RegistryFixtureBase, key: GroupKey) {
  const corrupt = controlCorrupters.get(fixture)
  if (corrupt === undefined) throw new Error('Missing control corruption helper')
  await fixture.device.groups.ports(key).control.apply({}, crypto.randomUUID())
  await corrupt(key)
}

export async function registryFixtureRemoveTrust(fixture: RegistryFixtureBase, groupID: string) {
  const remove = rowRemovers.get(fixture)
  if (remove === undefined) throw new Error('Missing row removal helper')
  await remove(
    'trust',
    physicalRecordKey({ groupID, incarnation: null, namespace: 'trust', recordID: 'current' }),
  )
}

export async function registryFixtureRemoveMetadata(
  fixture: RegistryFixtureBase,
  key: GroupKey,
): Promise<void> {
  const remove = rowRemovers.get(fixture)
  if (remove === undefined) throw new Error('Unknown registry fixture')
  await remove(
    'meta',
    physicalRecordKey({ ...key, namespace: 'meta', recordID: JSON.stringify(['state-version']) }),
  )
}
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

export async function registryFixtureSafetyParams(fixture: RegistryFixture) {
  const handle = await fixture.makeHandle(0)
  return {
    registry: fixture.registry,
    persistence: fixture.device.groups,
    mls: createGroupMLS({
      ...testGroupMLSDependencies(
        testHandleAccess({
          key: { groupID: handle.groupID, incarnation: 1 },
          handle: () => handle,
          adopt: () => {},
        }),
      ),
      identity: fixture.identity,
      entrySlot: createLedgerEntrySlot(),
    }),
    resolveTarget: async () => {
      throw new Error('Unexpected target resolution')
    },
  }
}

export async function registryFixtureSafety(fixture: RegistryFixture): Promise<GroupSafety> {
  return fixture.safety()
}

export async function createRegistryFixture(params: FixtureParams): Promise<RegistryFixture> {
  return assemble(params, params.identity ?? randomIdentity())
}

async function assemble(
  params: FixtureParams,
  identity: OwnIdentity,
  rows?: MemoryStoreRows,
  captured: CapturedFixtureState = { keys: new Set(), handles: new WeakSet() },
): Promise<RegistryFixture> {
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
    effects: params.effects,
    ownershipContext: params.ownershipContext,
  })
  const key = { groupID: params.groupID, incarnation: 1 }
  const restoreHolds = new Map<string, Hold>()
  const publicationHolds = new Map<string, Hold>()
  const counts = new Map<string, number>()
  const coldCounts = new Map<string, number>()
  let override:
    | ((record: GroupStateRecord & { deleted: false; state: Uint8Array }) => Promise<GroupHandle>)
    | undefined
  let closed = false
  let owner: GroupHandleRegistry | undefined
  let safetyMLS: ReturnType<typeof createGroupMLS>
  let trustReadFailure: Error | null = null
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
    const real =
      params.mode === 'real-mls' ||
      captured.keys.has(JSON.stringify([record.groupID, record.incarnation]))
    const handle = await (real ? restoreGroup : restoreMemoryControlHandle)({
      state,
      credential: record.credential,
      ledgerEntries: record.ledger,
      options: environment.options,
    })
    if (real) captured.handles.add(handle)
    return handle
  }
  function hold(map: Map<string, Hold>, id: string) {
    if (map.has(id)) throw new Error('Already held')
    const value = { started: deferred<void>(), released: deferred<void>() }
    map.set(id, value)
    return { started: value.started.promise, release: () => value.released.resolve() }
  }
  const fixture: RegistryFixture = {
    get registry() {
      if (closed) throw new Error('Closed registry fixture')
      owner ??= createGroupHandleRegistry({
        persistence: fixture.device,
        providerID: fixture.device.providerID,
        recovery: environment,
        restore: (record) => {
          coldCounts.set(record.groupID, (coldCounts.get(record.groupID) ?? 0) + 1)
          return restore(record)
        },
        restoreCandidate: (bytes) => restoreHost(fixture, bytes),
      })
      return owner
    },
    device: storage.ports.device,
    safety: () =>
      createGroupSafety({
        registry: fixture.registry,
        persistence: fixture.device.groups,
        mls: safetyMLS,
        resolveTarget: async () => {
          throw new Error('Unexpected target resolution')
        },
      }),
    identity,
    environment,
    async makeHandle(epoch, groupID = params.groupID) {
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid fixture epoch')
      let handle = (await createGroup(identity, groupID, environment.options)).group
      while (Number(handle.epoch) < epoch) handle = (await commitKeyRotation(handle)).newGroup
      return registryHandle({ mode: params.mode, handle, options: environment.options })
    },
    stateBytes: (handle) => encodeClientState(handle.state),
    async advanceSender(handle) {
      if (params.mode === 'real-mls') await handle.encrypt(new Uint8Array([9]))
      else {
        // Inherited encrypt updates the superclass state, not the double's exposed projection.
        const state = handle.state
        const { newState } = await createApplicationMessage({
          context: handle.context,
          state,
          message: new Uint8Array([9]),
          authenticatedData: new Uint8Array(),
        })
        Object.assign(state, newState)
      }
    },
    async authenticator(handle) {
      return handle.state.keySchedule.epochAuthenticator.slice()
    },
    acceptedOrdinary: (access, options) => acceptedOrdinary(fixture, access, options),
    serveRetiredWelcomes: (key, deliverWelcome, search) =>
      serveRetiredObligations({
        persistence: fixture.device.groups,
        key,
        search: {
          async searchLog(built, position) {
            const result = await search?.searchLog(built, position)
            if (result === undefined) return { kind: 'unknown' }
            if (result.kind === 'superseded')
              return { ...result, winner: asLogPosition(result.winner) }
            if (result.kind === 'unknown') {
              const { retryHead, ...unknown } = result
              return {
                ...unknown,
                ...(retryHead === undefined
                  ? {}
                  : { retryHead: retryHead === null ? null : asLogPosition(retryHead) }),
              }
            }
            if (result.kind !== 'first-valid') return result
            return {
              ...result,
              proof: {
                ...result.proof,
                from: result.proof.from === null ? null : asLogPosition(result.proof.from),
                position: asLogPosition(result.proof.position),
              },
            }
          },
        },
        deliverWelcome,
      }),
    async advance(handle) {
      if (params.mode === 'real-mls' || captured.handles.has(handle)) {
        const advanced = (await commitKeyRotation(handle)).newGroup
        captured.handles.add(advanced)
        return advanced
      }
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
    async confirmedRecovery(sourceKey, options) {
      const record = await fixture.device.groups.loadState(sourceKey)
      if (record === null || record.deleted || record.state === null)
        throw new Error('Missing recovery source')
      const source = await restore({ ...record, state: record.state })
      const common = {
        ...params,
        identity,
        options: environment.options,
        source,
        sourceKey,
        sourceTrust: (await fixture.device.groups.loadTrust(sourceKey.groupID)) ?? undefined,
        missingLedger: options?.missingLedger,
      }
      const result =
        options?.format === 'legacy'
          ? await createRegistryRecovery({ ...common, format: 'legacy' })
          : await createRegistryRecovery({
              ...common,
              format: 'captured',
              recoverySource: await registryFixtureRecoverySource(fixture, sourceKey),
            })
      if ('format' in result.record) retainCapturedDestination(fixture, result)
      if (!options?.confirm) return result
      const trust = await fixture.device.groups.loadTrust(sourceKey.groupID)
      await fixture.installRows({
        key: sourceKey,
        ...(options?.missingLedger && trust !== null && !('format' in result.record)
          ? {
              state: { ...record, version: record.version + 1, ledger: result.record.ledgerBefore },
              trust: { ...trust, ledger: result.record.ledgerBefore },
            }
          : {}),
        control: { putRejoin: result.record },
      })
      const capability = entryCapability(fixture.device.groups)
      if (capability === null) throw new Error('Missing registry capability')
      return {
        ...result,
        source: await capability.read(sourceKey.groupID, (reads) =>
          readRecoverySource(reads, sourceKey.groupID),
        ),
      }
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
        if (setup.state !== undefined && !setup.state.deleted && setup.trust !== undefined)
          await writeInstallationCheckpoint(stores, {
            key: setup.key,
            confirmedTranscriptHash: storageTranscript(setup.state.state),
            mutationID,
            stateVersion: setup.state.version,
          })
        if (setup.control !== undefined) {
          const slot = setup.control.commitOnce
          if (slot != null) {
            const state = await target.state.load()
            if (state === null || state.deleted) throw new Error('Missing slot source')
            controlBuildContexts.set(stores.tx, {
              kind: 'build',
              source: {
                key: setup.key,
                stateVersion: state.version,
                identity: {
                  ...setup.key,
                  epoch: state.epoch,
                  authenticator: state.epochAuthenticator,
                },
              },
              queueHeadID: slot.opID,
              checkpoint: slot.searchFrom,
            })
          }
          try {
            await target.control.apply(setup.control, mutationID)
          } finally {
            controlBuildContexts.delete(stores.tx)
          }
        }
        if (setup.anchor !== undefined) await target.anchor.save(setup.anchor)
        if (setup.outbox !== undefined) await target.outbox.put(setup.outbox)
        if (setup.events !== undefined) await target.meta.putEvents(setup.events)
        for (const value of setup.settlements ?? [])
          await target.meta.putSettlement(value.seq, value.value)
      })
    },
    inspectRows: storage.inspectRows,
    async corruptState(target, damage = 'unreadable') {
      if (damage === 'unreadable') {
        await corrupt(storage, 'state', target)
        return
      }
      const record = await fixture.device.groups.loadState(target)
      if (record === null || record.deleted || record.state === null)
        throw new Error('Missing fixture state')
      const client = decodeClientState(record.state)
      if (client === undefined) throw new Error('Invalid fixture state')
      client.groupContext.epoch += 1n
      const state = damage === 'client-state' ? new Uint8Array([0]) : encodeClientState(client)
      const location = { ...target, namespace: 'state', recordID: 'current' }
      const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
      const bytes = await sealRecord(codec, location, { ...record, state })
      await storage.mutateStoredRecord('state', physicalRecordKey(location), () => bytes)
    },
    async removeStateBytes(target) {
      await storage.deleteCommittedRow(
        'state',
        physicalRecordKey({ ...target, namespace: 'state', recordID: 'current' }),
      )
    },
    async corruptTrust(groupID, damage = 'unreadable') {
      if (damage === 'unreadable') {
        await corrupt(storage, 'trust', { groupID, incarnation: null })
        return
      }
      const trust = await fixture.device.groups.loadTrust(groupID)
      if (trust === null) throw new Error('Missing retained trust')
      const location = { groupID, incarnation: null, namespace: 'trust', recordID: 'current' }
      const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
      const bytes = await sealRecord(codec, location, { ...trust, spentEpochAuthenticators: [] })
      // Physical damage bypasses the domain's monotonic spent-set guard.
      await storage.mutateStoredRecord('trust', physicalRecordKey(location), () => bytes)
    },
    async removeTrust(groupID) {
      await storage.deleteCommittedRow(
        'trust',
        physicalRecordKey({ groupID, incarnation: null, namespace: 'trust', recordID: 'current' }),
      )
    },
    failTrustReads: (error) => {
      trustReadFailure = error
    },
    mutateMetadata: storage.mutateMetadata,
    holdColdPublication: (groupID) => hold(publicationHolds, groupID),
    holdRestore: (groupID) => hold(restoreHolds, groupID),
    holdProof: storage.holdProof,
    restoreCount: (groupID) => counts.get(groupID) ?? 0,
    coldLoadCount: (groupID) => coldCounts.get(groupID) ?? 0,
    overrideRestore: (fn) => {
      override = fn
    },
    onPhase: storage.onPhase,
    constructPrepareStores: () => storage.constructPrepareStores(key),
    async reopen() {
      await owner?.dispose()
      owner = undefined
      await storage.reopen()
      const committed = await storage.inspectRows()
      await fixture.close()
      return assemble({ ...params, setup: 'empty' }, identity, committed, captured)
    },
    async close() {
      if (closed) return
      await owner?.dispose()
      owner = undefined
      closed = true
      for (const value of restoreHolds.values()) value.released.resolve()
      restoreHolds.clear()
      for (const value of publicationHolds.values()) value.released.resolve()
      publicationHolds.clear()
      override = undefined
      counts.clear()
      coldCounts.clear()
      await storage.close()
    },
    armNextWorkFault: storage.armNextWorkFault,
    armWorkFault: storage.armWorkFault,
  }
  // Hold a restored Read result after owner release, before registry publication.
  const capability = entryCapability(fixture.device.groups)
  const binding = coordinatorBinding(fixture.device.groups)
  if (capability === null || binding === null) throw new Error('Missing fixture binding')
  function faultReads(reads: EntryReads): EntryReads {
    return {
      ...reads,
      trust: async () => {
        if (trustReadFailure !== null) throw trustReadFailure
        return reads.trust()
      },
    }
  }
  bindEntryCapability({
    persistence: fixture.device.groups,
    coordinatorBinding: binding,
    capability: {
      ...capability,
      async read(groupID, fn) {
        const before = coldCounts.get(groupID) ?? 0
        const result = await capability.read(groupID, (reads) => fn(faultReads(reads)))
        const held = publicationHolds.get(groupID)
        if (held !== undefined && (coldCounts.get(groupID) ?? 0) > before) {
          publicationHolds.delete(groupID)
          held.started.resolve()
          await held.released.promise
        }
        return result
      },
      run: (request, prepare, work) => {
        return capability.run(
          request,
          (reads) => prepare(faultReads(reads)),
          (stores, prepared) => {
            return work(
              {
                ...stores,
                trust: {
                  ...stores.trust,
                  load: async () => {
                    if (trustReadFailure !== null) throw trustReadFailure
                    return stores.trust.load()
                  },
                },
              },
              prepared,
            )
          },
        )
      },
    },
  })
  restorers.set(fixture, restore)
  capturedStates.set(fixture, captured)
  markerWriters.set(fixture, storage.forceOwnerMarker)
  rowRemovers.set(fixture, storage.deleteCommittedRow)
  const safetyHandle = await fixture.makeHandle(0)
  safetyMLS = createGroupMLS({
    ...testGroupMLSDependencies(
      testHandleAccess({
        key,
        handle: () => safetyHandle,
        adopt: () => {},
      }),
    ),
    identity,
    entrySlot: createLedgerEntrySlot(),
  })
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
  // Diagnostic enumeration must not construct a second live registry.
  controlCorrupters.set(fixture, (key) => corrupt(storage, 'control', key))
  Object.defineProperty(fixture, 'registry', { enumerable: false })
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

function hostBytes(handle: GroupHandle) {
  return encodeStoredValue({
    state: encodeClientState(handle.state),
    credential: handle.credential,
    ledger: handle.ledgerTokens,
  })
}
async function restoreHost(fixture: RegistryFixtureBase, bytes: Uint8Array): Promise<GroupHandle> {
  const host = decodeStoredValue(bytes) as Pick<
    ReadableGroupState,
    'state' | 'credential' | 'ledger'
  >
  const state = host.state === null ? undefined : decodeClientState(host.state)
  if (state === undefined || host.state === null) throw new Error('Missing host state')
  return registryFixtureRestore(fixture)({
    ...host,
    state: host.state,
    groupID: host.credential.groupID,
    incarnation: 1,
    version: 1,
    deleted: false,
    terminal: false,
    epoch: Number(state.groupContext.epoch),
    epochAuthenticator: state.keySchedule.epochAuthenticator,
    senderHWM: 0,
  })
}

async function acceptedOrdinary(
  fixture: RegistryFixtureBase,
  access: RegistryHandleAccess,
  options = { accepted: true },
) {
  const { handle, source } = await access.readControl(async ({ handle, source }) => ({
    handle,
    source,
  }))
  const candidate = await fixture.advance(handle)
  const alternate = await fixture.advance(await access.read((current) => current))
  const journal = encodeControlJournal({
    version: 1,
    source,
    checkpoint: null,
    sourceState: encodeClientState(handle.state),
    sourceCredential: handle.credential,
    sourceLedger: handle.ledgerTokens,
    candidate: hostBytes(candidate),
  })
  const slot: ControlSlot = {
    opID: 'rotation',
    incarnation: 1,
    epoch: Number(handle.epoch),
    authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
    searchFrom: null,
    expectedHead: null,
    publishID: 'publish',
    payload: new Uint8Array([1, 2, 3]),
    payloadDigest: 'accepted-payload',
    digest: 'rotation-digest',
    bodies: [],
    welcome: null,
    journal,
  }
  await fixture.installRows({
    key: access.key,
    control: {
      putOperations: [
        {
          id: slot.opID,
          kind: 'rotation',
          revokes: false,
          body: new Uint8Array(),
          seq: 1,
          enqueuedAt: 0,
          deadline: 30000,
          stage: 'intent',
        },
      ],
      commitOnce: slot,
    },
  })
  const proof = {
    source: await access.readControl(async ({ source }) => source),
    from: null,
    position: asLogPosition('00001'),
    payloadDigest: slot.payloadDigest,
  }
  if (options.accepted)
    await fixture.installRows({ key: access.key, control: { commitOnceAcceptance: proof } })
  const expected = await access.readControl(async ({ source }) => source)
  const write: AdoptionWrite = {
    mutationID: crypto.randomUUID(),
    expected: { ...expected, acceptance: proof, journal },
    anchorLanded: slot.digest,
    changes: {
      commitOnce: null,
      deleteOperations: [slot.opID],
      putApplied: [
        {
          epoch: slot.epoch,
          digest: slot.digest,
          payloadDigest: slot.payloadDigest,
          sequenceID: proof.position,
          opID: slot.opID,
          removed: false,
        },
      ],
      cursor: { position: proof.position, epoch: Number(candidate.epoch) },
    },
  }
  return { candidate, alternate, write, expected }
}

export async function createForkNoticeFixture(params: {
  mode: 'real-mls' | 'double'
  ownershipContext?: OwnershipContextPort
  deferSplit?: boolean
}): Promise<
  ForkNoticeFixture<LogPosition> & {
    installSplit(): Promise<void>
    journalOwnMessage(id: string): Promise<{ id: string; epoch: number; authHash: string }>
  }
> {
  const real = await createRealGroup(1, `fork-notice-${crypto.randomUUID()}`)
  const member = real.members[0]
  if (member === undefined) throw new Error('Missing fork member')
  let signingReads = 0
  const identity = {
    ...real.committer.identity,
    get privateKey() {
      signingReads++
      return real.committer.identity.privateKey
    },
  }
  let fixture = await createRegistryFixture({
    groupID: member.handle.groupID,
    mode: params.mode,
    setup: 'empty',
    identity,
    ownershipContext: params.ownershipContext,
    options: { resolveLedgerEntries: real.resolveLedgerEntries },
  })
  const wrap = async (handle: GroupHandle) =>
    registryHandle({
      mode: params.mode,
      handle: await restoreGroup({
        state: handle.state,
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
        options: fixture.environment.options,
      }),
      options: fixture.environment.options,
    })
  const key = await fixture.registry.seed(await wrap(real.committer.handle), {
    packageUse: { sourceID: 'fork-notice', ref: 'member-package', kind: 'ordinary' },
  })
  let local = (await commitKeyRotation(real.committer.handle)).newGroup
  const remote = (await commitKeyRotation(member.handle)).newGroup
  async function install() {
    const before = await fixture.device.groups.loadState(key)
    if (before === null || before.deleted) throw new Error('Missing fork installation')
    const handle = await wrap(local)
    await fixture.installRows({
      key,
      state: {
        ...before,
        version: before.version + 1,
        epoch: Number(handle.epoch),
        state: encodeClientState(handle.state),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
        ledger: handle.ledgerTokens,
      },
      trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
    })
  }
  if (!params.deferSplit) await install()
  const emitted: ForkNoticeFixture['emitted'] = []
  let serviceKey = key
  const create = () =>
    createCheckpointService({
      registry: fixture.registry,
      key: serviceKey,
      identity: fixture.identity,
      onForkNotice: (event) => emitted.push(event),
    })
  let service = create()
  const factBytes = await service.checkpointFact(
    key,
    Number(local.epoch) - (params.deferSplit ? 1 : 0),
  )
  if (factBytes === null) throw new Error('Missing split fact')
  const fact = decodeEpochRosterFact(factBytes)
  const predecessorBytes = await service.checkpointFact(key, Number(remote.epoch) - 1)
  if (predecessorBytes === null) throw new Error('Missing common predecessor fact')
  const predecessor = decodeEpochRosterFact(predecessorBytes)
  const agreeingBody = {
    v: 1 as const,
    type: 'kumiai/checkpoint/v1' as const,
    groupID: key.groupID,
    genesisHash: predecessor.genesisHash,
    ciphersuite: predecessor.ciphersuite,
    epoch: predecessor.epoch,
    authHash: predecessor.authHash,
    parentAuthHash: predecessor.parentAuthHash,
    keyHash: checkpointKeyHash(member.identity.publicKey),
    leafIndex: member.handle.state.privatePath.leafIndex,
  }
  const agreeingPredecessorFrame = encodeEpochCheckpoint(
    agreeingBody,
    ed25519.sign(checkpointSignatureInput(agreeingBody), member.identity.privateKey),
  )
  const remoteHash = checkpointAuthHash({
    groupID: key.groupID,
    genesisHash: fact.genesisHash,
    epoch: Number(remote.epoch),
    epochAuthenticator: remote.state.keySchedule.epochAuthenticator,
  })
  function sign(identity: OwnIdentity) {
    const body = {
      v: 1 as const,
      type: 'kumiai/checkpoint/v1' as const,
      groupID: key.groupID,
      genesisHash: fact.genesisHash,
      ciphersuite: fact.ciphersuite,
      epoch: Number(remote.epoch),
      authHash: remoteHash,
      parentAuthHash: params.deferSplit ? fact.authHash : fact.parentAuthHash,
      keyHash: checkpointKeyHash(identity.publicKey),
      leafIndex: remote.state.privatePath.leafIndex,
    }
    return encodeEpochCheckpoint(
      body,
      ed25519.sign(checkpointSignatureInput(body), identity.privateKey),
    )
  }
  return {
    key,
    service: () => service,
    signingReads: () => signingReads,
    installSplit: install,
    async journalOwnMessage(id) {
      const epoch = Number(local.epoch)
      const canonical = await service.checkpointFact(serviceKey, epoch)
      if (canonical === null) throw new Error('Missing prospective installation')
      const fact = decodeEpochRosterFact(canonical)
      await fixture.device.groups.ports(serviceKey).outbox.put({
        seq: 1,
        protocol: 'chat',
        prc: 'posted',
        data: new Uint8Array([1]),
        status: 'accepted',
        lastAttempt: {
          incarnation: serviceKey.incarnation,
          epoch,
          publishID: id,
          attempts: 1,
          floor: null,
          segment: epoch,
          topicID: 'own-message-topic',
        },
      })
      return { id, epoch, authHash: fact.authHash }
    },
    holdProof: () => fixture.armNextWorkFault('pending'),
    async raw() {
      const rows = await fixture.inspectRows()
      return [...(rows.checkpoints ?? new Map<string, unknown>())].map(([id, bytes]) => {
        const address = JSON.parse(id)
        if (!(bytes instanceof Uint8Array)) throw new Error('Unsealed checkpoint')
        return { namespace: 'checkpoints', incarnation: address[1], bytes }
      })
    },
    frame: sign(member.identity),
    agreeingPredecessorFrame,
    nextSignerFrame: sign(real.committer.identity),
    async mergeFrames() {
      let branch = remote
      let parentAuthHash = remoteHash
      const frames = new Map<number, Uint8Array>()
      let update: Uint8Array | undefined
      while (Number(local.epoch) < 6) {
        local = (await commitKeyRotation(local)).newGroup
        await install()
        branch = (await commitKeyRotation(branch)).newGroup
        const epoch = Number(branch.epoch)
        const authHash = checkpointAuthHash({
          groupID: key.groupID,
          genesisHash: fact.genesisHash,
          epoch,
          epochAuthenticator: branch.state.keySchedule.epochAuthenticator,
        })
        const body = {
          v: 1 as const,
          type: 'kumiai/checkpoint/v1' as const,
          groupID: key.groupID,
          genesisHash: fact.genesisHash,
          ciphersuite: fact.ciphersuite,
          epoch,
          authHash,
          parentAuthHash,
          keyHash: checkpointKeyHash(member.identity.publicKey),
          leafIndex: branch.state.privatePath.leafIndex,
        }
        frames.set(
          epoch,
          encodeEpochCheckpoint(
            body,
            ed25519.sign(checkpointSignatureInput(body), member.identity.privateKey),
          ),
        )
        if (epoch === 6) {
          const updated = { ...body, keyHash: checkpointKeyHash(real.committer.identity.publicKey) }
          update = encodeEpochCheckpoint(
            updated,
            ed25519.sign(checkpointSignatureInput(updated), real.committer.identity.privateKey),
          )
        }
        parentAuthHash = authHash
      }
      const later = frames.get(6)
      const earlier = frames.get(4)
      const link = frames.get(5)
      if (
        later === undefined ||
        earlier === undefined ||
        link === undefined ||
        update === undefined
      )
        throw new Error('Missing fork lineage')
      return { later, earlier, link, update }
    },
    emitted,
    async snapshot() {
      return {
        state: await fixture.device.groups.loadState(key),
        trust: await fixture.device.groups.loadTrust(key.groupID),
        control: await fixture.device.groups.ports(key).control.load(),
        anchor: await fixture.device.groups.ports(key).anchor.load(),
        events: await fixture.safety().events(key),
      }
    },
    installedRecords: () => service.readRecords(),
    async restart() {
      fixture = await fixture.reopen()
      service = create()
    },
    async advance(count) {
      for (let i = 0; i < count; i++) {
        local = (await commitKeyRotation(local)).newGroup
        await install()
      }
    },
    async retire() {
      const recovery = await fixture.confirmedRecovery(key, { confirm: true })
      if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
        throw new Error('Missing captured switch')
      serviceKey = await fixture.registry.switchIncarnation(recovery.candidate, {
        source: recovery.source,
        rejoinID: recovery.record.id,
        proof: recovery.proof,
        write: {
          mutationID: recovery.record.switchMutationID,
          source: { rejoinID: recovery.record.id },
          destination: {
            control: {
              cursor: {
                position: recovery.proof.position,
                epoch: Number(recovery.candidate.epoch),
              },
            },
          },
        },
      })
      service = create()
    },
    close: () => fixture.close(),
  }
}

export async function createNotMemberFixture(
  params: {
    additionalResponder?: boolean
    sameDIDResponder?: boolean
    localEpoch?: number
    remoteEpoch?: number
    splitEpoch?: number
    mode?: 'real-mls' | 'double'
    ownershipContext?: OwnershipContextPort
  } = {},
) {
  const { createCapturedFormerMember } = await import('./captured-recovery.js')
  const { createRegistryGroupMLS } = await import('../../src/registry-group-mls.js')
  const { createNotMemberHandler } = await import('../../src/safety-conditions.js')
  const multiKey = params.sameDIDResponder
    ? await createIdentity({
        keys: [
          { purpose: 'sig', alg: 'EdDSA' },
          { purpose: 'sig', alg: 'EdDSA' },
        ],
      })
    : undefined
  const base = await createCapturedFormerMember(true, multiKey)
  const alternateKey = multiKey?.keys[1]
  const alternate: OwnIdentity | undefined =
    multiKey === undefined || alternateKey === undefined
      ? undefined
      : {
          ...multiKey,
          publicKey: alternateKey.publicKey,
          privateKey: alternateKey.privateKey,
          signToken: (payload) =>
            multiKey.signToken(payload, { kid: alternateKey.fragment, embedLongForm: true }),
        }
  const splitEpoch = params.splitEpoch ?? 10
  const localEpoch = params.localEpoch ?? 20
  const remoteEpoch = params.remoteEpoch ?? 12
  const clone = async (handle: GroupHandle) => {
    const state = decodeClientState(encodeClientState(handle.state))
    if (state === undefined) throw new Error('Missing diagnostic state')
    return restoreGroup({
      state,
      credential: handle.credential,
      ledgerEntries: handle.ledgerTokens,
      options: registryOptions({}),
    })
  }
  let common = await clone(base.earlierGroup)
  let own = await clone(base.requester.handle)
  const additionals: Array<{
    identity: OwnIdentity
    handle: GroupHandle
    fixture: RegistryFixture | null
  }> = []
  for (const identity of [
    ...(alternate === undefined ? [] : [alternate]),
    ...(params.additionalResponder ? [randomIdentity()] : []),
  ]) {
    const { createInvite, commitInvite, createKeyPackageBundle, processWelcome } = await import(
      '@kumiai/mls'
    )
    const lifecycle = (await import(
      new URL('../../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
    )) as {
      bindingFor(
        identity: OwnIdentity,
        prefix?: ControllerBinding['prefix'],
        issuer?: { identity: OwnIdentity; parent: string },
      ): Promise<ControllerBinding>
      trustedGrant(identity: OwnIdentity): Promise<string>
    }
    const controller = await lifecycle.bindingFor(
      identity,
      undefined,
      identity.id === base.responder.identity.id
        ? undefined
        : {
            identity: base.responder.identity,
            parent: await lifecycle.trustedGrant(base.responder.identity),
          },
    )
    const bundle = await createKeyPackageBundle(identity, { controller })
    const { invite } = await createInvite({
      group: common,
      identity: base.responder.identity,
      recipientDID: identity.id,
    })
    const added = await commitInvite(common, bundle.publicPackage, invite)
    common = added.newGroup
    await own.processMessage(added.commitMessage)
    for (const previous of additionals) await previous.handle.processMessage(added.commitMessage)
    additionals.push({
      identity,
      fixture: null,
      handle: (
        await processWelcome({
          identity,
          invite,
          welcome: added.welcomeMessage,
          keyPackageBundle: bundle,
          options: registryOptions({}),
        })
      ).group,
    })
  }
  while (Number(common.epoch) < splitEpoch - 1) {
    const rotation = await commitKeyRotation(common)
    common = rotation.newGroup
    await own.processMessage(rotation.commitMessage)
    for (const additional of additionals)
      await additional.handle.processMessage(rotation.commitMessage)
  }
  const local = await createRegistryFixture({
    mode: params.mode ?? 'real-mls',
    setup: 'empty',
    groupID: own.groupID,
    identity: base.requester.identity,
    ownershipContext: params.ownershipContext,
  })
  const remote = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID: own.groupID,
    identity: base.responder.identity,
    ownershipContext: params.ownershipContext,
  })
  const localKey = await local.registry.seed(
    await registryHandle({
      mode: params.mode ?? 'real-mls',
      handle: await clone(own),
      options: local.environment.options,
    }),
    { packageUse: { sourceID: 'diagnostic', ref: 'requester-package', kind: 'ordinary' } },
  )
  const remoteKey = await remote.registry.seed(await clone(common), {
    packageUse: { sourceID: 'diagnostic', ref: 'responder-package', kind: 'ordinary' },
  })
  async function install(fixture: RegistryFixture, key: GroupKey, proposed: GroupHandle) {
    const handle =
      fixture === local
        ? await registryHandle({
            mode: params.mode ?? 'real-mls',
            handle: await clone(proposed),
            options: fixture.environment.options,
          })
        : proposed
    const previous = await fixture.device.groups.loadState(key)
    if (previous === null || previous.deleted) throw new Error('Missing diagnostic installation')
    await fixture.installRows({
      key,
      state: {
        ...previous,
        version: previous.version + 1,
        state: encodeClientState(handle.state),
        credential: handle.credential,
        ledger: handle.ledgerTokens,
        epoch: Number(handle.epoch),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
      },
      trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
    })
  }
  for (const additional of additionals) {
    additional.fixture = await createRegistryFixture({
      mode: 'real-mls',
      setup: 'empty',
      groupID: own.groupID,
      identity: additional.identity,
    })
    await additional.fixture.registry.seed(await clone(additional.handle), {
      packageUse: { sourceID: 'diagnostic', ref: 'second-responder', kind: 'ordinary' },
    })
  }
  const continuing = await clone(common)
  const divergent = await clone(common)
  const continuers: Array<RegistryFixture> = []
  const { proposeSelfRemoval, commitSelfRemovals } = await import('@kumiai/mls')
  const removal = await proposeSelfRemoval(await clone(own))
  await common.processMessage(removal.frame)
  for (const additional of additionals) await additional.handle.processMessage(removal.frame)
  const removed = await commitSelfRemovals(common)
  if (removed === null) throw new Error('Missing excluding branch')
  let excluding = removed.newGroup
  await install(remote, remoteKey, excluding)
  for (const additional of additionals) {
    if (additional.fixture === null) throw new Error('Missing additional responder fixture')
    await additional.handle.processMessage(removed.commitMessage)
    await install(additional.fixture, remoteKey, additional.handle)
  }
  while (Number(excluding.epoch) < remoteEpoch) {
    const rotation = await commitKeyRotation(excluding)
    excluding = rotation.newGroup
    await install(remote, remoteKey, excluding)
    for (const additional of additionals) {
      if (additional.fixture === null) throw new Error('Missing additional responder fixture')
      await additional.handle.processMessage(rotation.commitMessage)
      await install(additional.fixture, remoteKey, additional.handle)
    }
  }
  while (Number(own.epoch) < localEpoch) {
    const rotation = await commitKeyRotation(own)
    own = rotation.newGroup
    await continuing.processMessage(rotation.commitMessage)
    await install(local, localKey, own)
  }
  let localFixture = local
  let localMLS = await createRegistryGroupMLS({
    registry: localFixture.registry,
    key: localKey,
    identity: base.requester.identity,
    entrySlot: createLedgerEntrySlot(),
    recovery: localFixture.environment,
    target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
  })
  const remoteMLS = await createRegistryGroupMLS({
    registry: remote.registry,
    key: remoteKey,
    identity: base.responder.identity,
    entrySlot: createLedgerEntrySlot(),
    recovery: remote.environment,
    target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
  })
  const remoteService = createCheckpointService({
    registry: remote.registry,
    key: remoteKey,
    identity: base.responder.identity,
  })
  for (const row of await remoteService.readRecords())
    if (row.kind === 'fact') await remoteService.signInstalled(row.id)
  let current = true
  const handler = () =>
    createNotMemberHandler({
      registry: localFixture.registry,
      key: localKey,
      recovery: localFixture.environment,
      current: () => current,
    })
  return {
    key: localKey,
    remoteKey,
    local: () => localFixture,
    remote,
    mls: () => localMLS,
    remoteMLS,
    responderDID: base.responder.identity.id,
    service: () =>
      createCheckpointService({
        registry: localFixture.registry,
        key: localKey,
        identity: base.requester.identity,
      }),
    async proof(requestID = crypto.randomUUID()) {
      const request = await localMLS.createRecoveryRequest(requestID, undefined, splitEpoch)
      const evidence = await remoteMLS.capturedRecovery?.sealRosterAbsence?.(request.request, null)
      if (evidence == null) throw new Error('Missing signed absence proof')
      return { ...request, evidence, requestID }
    },
    async secondProof(index = additionals.length - 1) {
      const additional = additionals[index]
      if (additional?.fixture == null) throw new Error('Missing second responder')
      const service = createCheckpointService({
        registry: additional.fixture.registry,
        key: remoteKey,
        identity: additional.identity,
      })
      for (const row of await service.readRecords())
        if (row.kind === 'fact') await service.signInstalled(row.id)
      const responder = await createRegistryGroupMLS({
        registry: additional.fixture.registry,
        key: remoteKey,
        identity: additional.identity,
        entrySlot: createLedgerEntrySlot(),
        recovery: additional.fixture.environment,
        target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
      })
      const requestID = crypto.randomUUID()
      const held = await localMLS.createRecoveryRequest(requestID, undefined, splitEpoch)
      const evidence = await responder.capturedRecovery?.sealRosterAbsence?.(held.request, null)
      if (evidence == null) throw new Error('Missing second signed absence')
      return { ...held, evidence, requestID, responderDID: additional.identity.id }
    },
    async advanceResponder() {
      excluding = (await commitKeyRotation(excluding)).newGroup
      await install(remote, remoteKey, excluding)
      for (const row of await remoteService.readRecords())
        if (row.kind === 'fact') await remoteService.signInstalled(row.id)
    },
    diagnose: (input: { evidence: Uint8Array; requestID: string; requestKey: Uint8Array }) =>
      handler()(input),
    stop: () => {
      current = false
    },
    async advance() {
      own = (await commitKeyRotation(own)).newGroup
      await install(localFixture, localKey, own)
    },
    async confirmedRecovery() {
      const recovery = await createRegistryRecovery({
        format: 'captured',
        mode: 'real-mls',
        identity: localFixture.identity,
        options: localFixture.environment.options,
        source: await clone(own),
        sourceKey: localKey,
        recoverySource: await registryFixtureRecoverySource(localFixture, localKey),
        responder: { identity: remote.identity, group: await clone(continuing) },
      })
      retainCapturedDestination(localFixture, recovery)
      await localFixture.installRows({ key: localKey, control: { putRejoin: recovery.record } })
      return { ...recovery, source: await registryFixtureRecoverySource(localFixture, localKey) }
    },
    async continuing(options: { divergent?: boolean; epoch?: number } = {}) {
      let offered = await clone(options.divergent ? divergent : continuing)
      while (Number(offered.epoch) < (options.epoch ?? localEpoch))
        offered = (await commitKeyRotation(offered)).newGroup
      const survivor = await createRegistryFixture({
        mode: 'real-mls',
        setup: 'empty',
        groupID: own.groupID,
        identity: base.responder.identity,
      })
      continuers.push(survivor)
      await survivor.registry.seed(offered, {
        packageUse: { sourceID: 'diagnostic', ref: 'continuing-responder', kind: 'ordinary' },
      })
      return survivor
    },
    async restart() {
      localFixture = await localFixture.reopen()
      localMLS = await createRegistryGroupMLS({
        registry: localFixture.registry,
        key: localKey,
        identity: base.requester.identity,
        entrySlot: createLedgerEntrySlot(),
        recovery: localFixture.environment,
        target: { targetID: 'diagnostic-hub', topicID: 'diagnostic-commits' },
      })
    },
    async close() {
      await localFixture.close()
      await remote.close()
      for (const additional of additionals) await additional.fixture?.close()
      for (const survivor of continuers) await survivor.close()
    },
  }
}
