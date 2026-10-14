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
import {
  type AdoptionWrite,
  type AnchorSlot,
  asLogPosition,
  type ControlChanges,
  type ControlSlot,
  type WelcomeObligation,
} from '@kumiai/rpc'
import type { ConformanceControlSearchPort } from '@kumiai/rpc-conformance'
import { createApplicationMessage } from 'ts-mls'

import { simpleHandleAccess } from '../../src/access.js'
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
    options?: { confirm?: boolean; missingLedger?: boolean },
  ): ReturnType<typeof createRegistryRecovery>
  installRows(rows: RegistryRowSetup): Promise<void>
  inspectRows(): Promise<MemoryStoreRows>
  corruptState(key: GroupKey): Promise<void>
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
      access: simpleHandleAccess({
        key: { groupID: handle.groupID, incarnation: 1 },
        stateVersion: () => 1,
        handle: () => handle,
        adopt: () => {},
      }),
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
    async confirmedRecovery(sourceKey, options) {
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
        sourceTrust: (await fixture.device.groups.loadTrust(sourceKey.groupID)) ?? undefined,
        missingLedger: options?.missingLedger,
      })
      if (!options?.confirm) return result
      const trust = await fixture.device.groups.loadTrust(sourceKey.groupID)
      await fixture.installRows({
        key: sourceKey,
        ...(options?.missingLedger && trust !== null
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
    async corruptState(target) {
      await corrupt(storage, 'state', target)
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
      return assemble({ ...params, setup: 'empty' }, identity, committed)
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
  markerWriters.set(fixture, storage.forceOwnerMarker)
  rowRemovers.set(fixture, storage.deleteCommittedRow)
  const safetyHandle = await fixture.makeHandle(0)
  safetyMLS = createGroupMLS({
    access: simpleHandleAccess({
      key,
      stateVersion: () => 1,
      handle: () => safetyHandle,
      adopt: () => {},
    }),
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
    mutationID: 'ordinary-adoption',
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
