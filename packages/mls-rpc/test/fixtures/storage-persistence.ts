import { createFullIdentity, randomIdentity } from '@kokuin/token'
import type { LogHub } from '@kumiai/hub-tunnel'
import {
  commitInvite,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  keyPackageRef,
  restoreGroup,
} from '@kumiai/mls'
import type { KeyPackageRecord } from '@kumiai/mls-hub'
import {
  type AdoptionExpected,
  type AdoptionWrite,
  asLogPosition,
  type ControlSlot,
  commitTopic,
  controlBuildRef,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  type FirstValidCommit,
  HANDSHAKE_KIND,
  type Operation,
} from '@kumiai/rpc'
import { createGroupPeerWithControlWalk } from '@kumiai/rpc/testing'
import type { CommitOnceEvidence, StorageTestPorts } from '@kumiai/rpc-conformance'
import { expect, vi } from 'vitest'

import { createControlAdoptionPort } from '../../src/control-adoption.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../../src/control-build.js'
import { decodeControlJournal } from '../../src/control-journal.js'
import { createControlValidationPort } from '../../src/control-validation.js'
import { createGroupCrypto } from '../../src/crypto.js'
import { entryCapability } from '../../src/entry-capability.js'
import { memoryGroupOwnerQueues } from '../../src/memory-group-persistence.js'
import {
  assertMemoryWrite,
  createGroupStateStores,
  createMemoryPrepareTransaction,
} from '../../src/memory-group-state.js'
import { groupOwnerKey } from '../../src/memory-incarnation-stores.js'
import * as packageReads from '../../src/memory-package-stores.js'
import { createGroupMLS, createLedgerEntrySlot } from '../../src/mls.js'
import { type OwnerEntry, ownerEntryFailureSignal } from '../../src/owner-queue.js'
import {
  decodeStoredValue,
  encodeStoredValue,
  physicalRecordKey,
} from '../../src/persistence-codec.js'
import type {
  DeviceStores,
  GroupPersistence,
  MemoryTransaction,
  OwnershipContextPort,
  PendingCommitFault,
  PersistenceFixture,
  RawStoredRecord,
  TransactionalGroupEffects,
} from '../../src/persistence-types.js'
import {
  createIncarnationStores,
  createMemoryDevicePersistence,
  createMemoryPackageStores,
  createMemoryTransaction,
  memoryFaults,
} from '../../src/testing.js'
import { createDeterministicAtRestCodec } from './at-rest.js'
import { createSealedControlAccess } from './sealed-control-access.js'
import {
  buildSealedMemoryOperation,
  memoryModel,
  restoreMemoryControlHandle,
  sealedMemoryValidation,
} from './sealed-memory-mls.js'
import { installSeed, makeStorageSeed, nextChange, type StorageSeed } from './storage-seed.js'

const sideNamespace = 'host-side'
const markerNamespaces = new Set(['group-owner', 'device-owner'])
const payloadNamespaces = new Set([
  'lifetime',
  'trust',
  'state',
  'control',
  'anchor',
  'pending',
  'poison',
  'cursor',
  'outbox',
  'meta',
  'device',
  'device-package',
  'device-last-resort',
  'device-receipt',
  'device-cleanup',
  'device-restore',
])

export async function writeSideRow(
  tx: MemoryTransaction,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  assertMemoryWrite(tx, 'side')
  const rows = tx.rows[sideNamespace]
  if (rows === undefined) throw new Error('Missing transaction side-row namespace')
  rows.set(key, bytes.slice())
}

function address(namespace: string, key: string): Omit<RawStoredRecord, 'bytes'> {
  const value: unknown = JSON.parse(key)
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== 'string' ||
    (value[1] !== null && !Number.isSafeInteger(value[1])) ||
    typeof value[2] !== 'string'
  ) {
    throw new Error('Invalid physical record address')
  }
  return { namespace, key, groupID: value[0], incarnation: value[1], recordID: value[2] }
}

export async function createStorageFixture(params: {
  id: string
  mode: 'real-mls' | 'double'
  effects?: TransactionalGroupEffects<MemoryTransaction>
  ownershipContext?: OwnershipContextPort
  seed?: StorageSeed
}): Promise<PersistenceFixture<StorageTestPorts<MemoryTransaction>>> {
  const identity = randomIdentity()
  const ownerDID = identity.id
  const providerID = 'storage-provider'
  const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
  type Phase = Parameters<PersistenceFixture<StorageTestPorts<MemoryTransaction>>['onPhase']>[0]
  type Latch = { reached(): void; wait: Promise<void>; release(): void }
  let sealLatch: Latch | undefined
  let openLatch: Latch | undefined
  let sealFailure: Error | undefined
  let openFailure: Error | undefined
  let codecProbe: ((phase: string) => Promise<void>) | undefined
  let retry = false
  const phaseCallbacks = new Map<Phase, () => Promise<void> | void>()
  const held = new Set<Latch>()
  function clearInstrumentation(): void {
    sealLatch = undefined
    openLatch = undefined
    sealFailure = undefined
    openFailure = undefined
    codecProbe = undefined
    phaseCallbacks.clear()
  }
  async function codecCall(kind: 'seal' | 'open', bytes: Uint8Array, aad: Uint8Array) {
    const probe = codecProbe
    codecProbe = undefined
    const latch = kind === 'seal' ? sealLatch : openLatch
    const error = kind === 'seal' ? sealFailure : openFailure
    if (kind === 'seal') {
      sealLatch = undefined
      sealFailure = undefined
    } else {
      openLatch = undefined
      openFailure = undefined
    }
    if (probe !== undefined) await probe(memoryGroupOwnerQueues(db)?.current()?.phase ?? 'released')
    if (latch !== undefined) {
      held.add(latch)
      latch.reached()
      await latch.wait
      held.delete(latch)
    }
    if (error !== undefined) throw error
    return await codec[kind](bytes, aad)
  }
  const atRest = {
    open: (bytes: Uint8Array, aad: Uint8Array) => codecCall('open', bytes, aad),
    seal: (bytes: Uint8Array, aad: Uint8Array) => codecCall('seal', bytes, aad),
  }
  let db = createMemoryTransaction({ rows: { [sideNamespace]: new Map() } })
  let closed = false
  let fakeTime = false
  const pending = new Set<{
    fault: PendingCommitFault
    rejected: boolean
    completed: Promise<void>
    done(): void
  }>()
  let readDevice!: <T>(fn: (stores: DeviceStores<MemoryTransaction>) => Promise<T>) => Promise<T>
  const instrumented = new WeakSet<object>()
  const activeEntries = new Map<string, OwnerEntry>()
  let registeredGroups!: GroupPersistence<MemoryTransaction>
  function instrumentOwners(database: typeof db): void {
    const owners = memoryGroupOwnerQueues(database)
    if (owners === undefined || instrumented.has(owners)) return
    instrumented.add(owners)
    const run = owners.run
    owners.run = (kind, scopes, body, options) => {
      const callbacks =
        kind === 'read' ? new Map<Phase, () => Promise<void> | void>() : new Map(phaseCallbacks)
      const retrying = kind !== 'read' && retry
      if (kind !== 'read') {
        phaseCallbacks.clear()
        retry = false
      }
      let hookResult: Promise<{ error: unknown } | undefined> = Promise.resolve(undefined)
      return run(
        kind,
        scopes,
        async (entry) => {
          if (entry.scopes.groupID !== null) activeEntries.set(entry.scopes.groupID, entry)
          let attemptSignal: AbortSignal | undefined
          const invoke = (phase: Phase) => {
            const fn = callbacks.get(phase)
            callbacks.delete(phase)
            if (fn === undefined) return
            return entry.callback(fn)
          }
          const enter = entry.enter
          const retain = entry.retain
          const settle = entry.settle
          let first = retrying
          let restarting = false
          entry.enter = async (phase) => {
            if (restarting && phase === 'prepare') return
            if (restarting && phase === 'work') restarting = false
            await enter(phase)
            const nextSignal = entry.attempt().signal
            if (nextSignal !== attemptSignal) {
              attemptSignal?.removeEventListener('abort', clear)
              attemptSignal = nextSignal
              attemptSignal?.addEventListener('abort', clear, { once: true })
            }
            if (callbacks.has(phase as Phase)) await invoke(phase as Phase)
          }
          entry.retain = (proof) =>
            retain(async () => {
              await invoke('proof')
              return await proof()
            })
          entry.settle = (outcome) => {
            if (first && outcome === 'rolled-back') return
            settle(outcome)
          }
          const signal = ownerEntryFailureSignal(entry)
          const clear = () => {
            callbacks.clear()
            clearInstrumentation()
          }
          signal?.addEventListener('abort', clear, { once: true })
          try {
            return await entry.callback(async () => {
              if (callbacks.has('hook'))
                entry.onCommit(() => {
                  hookResult = (async () => {
                    try {
                      await invoke('hook')
                    } catch (error) {
                      return { error }
                    }
                  })()
                })
              if (first) memoryFaults(database).failNext('before-commit')
              try {
                return await body(entry)
              } catch (error) {
                clearInstrumentation()
                callbacks.clear()
                if (!first) throw error
                first = false
                if (
                  !(error instanceof Error) ||
                  error.message !== 'Injected before-commit failure'
                ) {
                  settle('rolled-back')
                  throw error
                }
                restarting = true
                return await body(entry)
              }
            })
          } finally {
            callbacks.clear()
            if (entry.scopes.groupID !== null && activeEntries.get(entry.scopes.groupID) === entry)
              activeEntries.delete(entry.scopes.groupID)
            signal?.removeEventListener('abort', clear)
            attemptSignal?.removeEventListener('abort', clear)
          }
        },
        options,
      ).then(async (value) => {
        const hook = await hookResult
        if (hook !== undefined) throw hook.error
        return value
      })
    }
  }
  function ports(effects = params.effects, database = db) {
    // Capture the registered public Read callback without adding a production test API.
    const bind = packageReads.bindMemoryPackageReads
    const capture = vi
      .spyOn(packageReads, 'bindMemoryPackageReads')
      .mockImplementation((device, read) => {
        readDevice = read
        bind(device, read)
      })
    let device: ReturnType<typeof createMemoryDevicePersistence>
    try {
      device = createMemoryDevicePersistence({
        db: database,
        atRest,
        providerID,
        ownerDID,
        effects,
        ownershipContext: params.ownershipContext,
      })
    } finally {
      capture.mockRestore()
    }
    instrumentOwners(database)
    registeredGroups = device.groups
    return {
      device,
      packageStores: (sourceID: string) => createMemoryPackageStores({ device, sourceID }),
    }
  }
  const initial = ports({})
  await initial.device.load()
  const seed =
    params.seed ??
    (await makeStorageSeed({
      id: params.id,
      incarnation: 1,
      epoch: 3,
      mode: params.mode,
    }))
  await installSeed(initial.device.groups, seed, 'seed')
  if (params.id !== 'group-B') {
    const independent = await makeStorageSeed({
      id: 'group-B',
      incarnation: 1,
      epoch: 3,
      mode: params.mode,
    })
    await installSeed(initial.device.groups, independent, 'seed-B')
  }
  const plaintext = new TextEncoder().encode('plaintext-sentinel')
  const topicID = 'topic-secret'
  await initial.device.groups.transition(
    await nextChange(initial.device.groups, params.id, 'seed-records'),
    async (stores) => {
      const rows = stores.incarnation(1)
      await rows.control.apply(
        { putOutcomes: [{ id: 'operation-1', opID: 'operation-1', at: 1000, kind: 'unknown' }] },
        'seed-records',
      )
      await rows.anchor.save({ anchor: { epoch: 3, secret: new Uint8Array(32).fill(97) } })
      for (const [id, position] of [
        ['frame-2', '10'],
        ['frame-1', '2'],
      ]) {
        if (id === undefined || position === undefined) throw new Error('Missing frame address')
        const frame = {
          ...seed.key,
          id,
          topicID,
          protocol: 'chat',
          procedure: 'posted',
          segment: 3,
          position,
        }
        await rows.pending.put([
          {
            frame,
            payload: plaintext,
            senderDID: seed.trust.credential.id,
            epoch: 3,
            idempotencyKey: JSON.stringify([
              'kumiai/frame/v1',
              params.id,
              1,
              topicID,
              position,
              'chat',
              'posted',
            ]),
          },
        ])
      }
      await rows.pending.poison([
        {
          frame: {
            ...seed.key,
            id: 'poison-1',
            topicID,
            protocol: 'chat',
            segment: 3,
            position: '1',
          },
          reason: 'invalid frame',
          keyConsumed: true,
        },
      ])
      await rows.cursor.save(topicID, '2')
      const entry = {
        seq: 7,
        protocol: 'chat',
        prc: 'posted',
        data: plaintext,
        status: 'accepted' as const,
        lastAttempt: null,
      }
      await rows.outbox.put([entry])
      await rows.meta.putSettlement(7, {
        sequenceID: '10',
        attemptID: 'publish-1',
        topicID,
        outcome: 'published',
      })
      await rows.meta.putEvents([{ ...seed.key, id: 'event-1', kind: 'accepted', entry }])
    },
  )
  const bundle = await createKeyPackageBundle(identity)
  const ordinary: KeyPackageRecord = {
    kind: 'ordinary',
    ref: await keyPackageRef(bundle.publicPackage),
    keyPackage: encodeKeyPackage(bundle.publicPackage),
    privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
    notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
  }
  await initial.device.transition(
    { mutationID: 'seed-device', expectedRevision: 0, group: null },
    async (stores) => {
      await stores.ordinary('source-1').put(ownerDID, ordinary)
      // The receipt keeps its own real package reference, while another private record remains inspectable.
      const consumedBundle = await createKeyPackageBundle(identity)
      const consumed = {
        ...ordinary,
        ref: await keyPackageRef(consumedBundle.publicPackage),
        keyPackage: encodeKeyPackage(consumedBundle.publicPackage),
        privatePackage: encodePrivateKeyPackage(consumedBundle.privatePackage),
      }
      await stores.ordinary('source-1').put(ownerDID, consumed)
      await stores.ordinary('source-1').consume(consumed.ref, params.id)
      await stores
        .lastResort('source-1')
        .put(ownerDID, { ...ordinary, kind: 'last-resort', uploadedAt: null })
      await stores.cleanup.put({
        id: 'cleanup-1',
        ownerDID,
        sourceID: 'source-1',
        ref: consumed.ref,
        kind: 'ordinary',
        groupID: params.id,
        notAfter: ordinary.notAfter,
      })
      await stores.restore.save({
        id: 'restore-1',
        stage: 'invalidate',
        remainingGroups: [params.id],
      })
    },
  )
  function active(): void {
    if (closed) throw new Error('Closed storage fixture')
  }
  function ciphertext(namespace: string, key: string): Uint8Array {
    active()
    if (!payloadNamespaces.has(namespace) || markerNamespaces.has(namespace))
      throw new Error('Not a ciphertext namespace')
    const value = db.snapshot()[namespace]?.get(key)
    if (value === undefined) throw new Error(`Missing ciphertext key: ${key}`)
    if (!(value instanceof Uint8Array)) throw new Error('Not sealed bytes')
    return value.slice()
  }
  const fixture: PersistenceFixture<StorageTestPorts<MemoryTransaction>> = {
    entry() {
      active()
      const capability = entryCapability(registeredGroups)
      if (capability === null) throw new Error('Missing entry capability')
      return capability
    },
    constructPrepareStores(key) {
      active()
      const owners = memoryGroupOwnerQueues(db)
      const entry = activeEntries.get(key.groupID)
      if (owners === undefined || entry === undefined || entry.phase !== 'prepare')
        throw new Error('Missing prepare entry')
      const tx = createMemoryPrepareTransaction({
        rows: db.snapshot(key.groupID),
        entry,
        owners,
        groupID: key.groupID,
        providerID,
      })
      // Reconstructed containers retain the explicit binding through their guarded maps.
      return fixture.constructGroupStores({ ...tx, rows: { ...tx.rows } }, key)
    },
    ports: ports(),
    async reopenWithoutBarrier() {
      active()
      // A database wrapper creates fresh application queues over the same pending backend.
      const restarted = { ...db }
      fixture.ports = ports(params.effects, restarted)
      return fixture.ports
    },
    async reopen() {
      active()
      // An absent owner's transaction is invisible in the committed snapshot.
      await Promise.all(
        [...pending].filter((owner) => owner.rejected).map((owner) => owner.completed),
      )
      // Fence backend completion before replacing the database and all adapter caches.
      await db.completionBarrier({ groupID: null, devicePackages: true })
      const groups = new Set<string>()
      for (const key of db.snapshot()['group-owner']?.keys() ?? [])
        groups.add(address('group-owner', key).groupID)
      for (const groupID of groups) await db.completionBarrier({ groupID, devicePackages: false })
      db = createMemoryTransaction({ rows: db.snapshot() })
      fixture.ports = ports()
      return fixture.ports
    },
    failNext(point) {
      active()
      memoryFaults(db).failNext(point)
    },
    commitThenReject() {
      active()
      memoryFaults(db).commitThenReject()
    },
    rejectCommitPending() {
      active()
      const fault = memoryFaults(db).rejectCommitPending()
      const { promise, resolve } = Promise.withResolvers<void>()
      const owner = { fault, rejected: false, completed: promise, done: resolve }
      pending.add(owner)
      void fault.rejected.then(() => {
        owner.rejected = true
      })
      return {
        ...fault,
        async finish(outcome) {
          await fault.finish(outcome)
          owner.done()
          pending.delete(owner)
        },
      }
    },
    holdNextSeal() {
      active()
      if (sealLatch !== undefined) throw new Error('Seal already held')
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      sealLatch = { reached: reached.resolve, wait: release.promise, release: release.resolve }
      return { reached: reached.promise, release: release.resolve }
    },
    failNextSeal(error = new Error('Injected seal failure')) {
      active()
      sealFailure = error
    },
    holdNextOpen() {
      active()
      if (openLatch !== undefined) throw new Error('Open already held')
      const started = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      openLatch = { reached: started.resolve, wait: released.promise, release: released.resolve }
      return { started: started.promise, release: released.resolve }
    },
    failNextOpen(error = new Error('Injected open failure')) {
      active()
      openFailure = error
    },
    probeCodec(fn) {
      active()
      codecProbe = fn
    },
    onPhase(phase, fn) {
      active()
      phaseCallbacks.set(phase, fn)
    },
    readWith(fn) {
      active()
      return readDevice(fn)
    },
    combinedWith(signal) {
      active()
      const owners = memoryGroupOwnerQueues(db)
      if (owners === undefined) throw new Error('Missing fixture owners')
      return owners.run(
        'combined',
        { ownerDID, groupID: params.id },
        async (entry) => {
          await entry.enter('prepare')
          await entry.enter('work')
          await entry.enter('outcome')
          entry.settle('committed')
        },
        { signal },
      )
    },
    retryNextTransition() {
      active()
      retry = true
    },
    async forceOwnerMarker(owner, marker) {
      active()
      const namespace = 'groupID' in owner ? 'group-owner' : 'device-owner'
      const key =
        'groupID' in owner
          ? groupOwnerKey(owner.groupID)
          : physicalRecordKey({
              groupID: owner.ownerDID,
              incarnation: null,
              namespace,
              recordID: 'current',
            })
      memoryFaults(db).forceCommittedRow(namespace, key, marker)
    },
    async deleteCommittedRow(namespace, key) {
      active()
      memoryFaults(db).forceCommittedRow(namespace, key, undefined)
    },
    constructGroupStores(tx, key) {
      active()
      const { lifetime, trust } = createGroupStateStores({ tx, groupID: key.groupID, atRest })
      return {
        tx,
        lifetime,
        trust,
        incarnation: (incarnation) =>
          createIncarnationStores({ tx, key: { groupID: key.groupID, incarnation }, atRest }),
      }
    },
    async inspectRows() {
      active()
      return db.snapshot()
    },
    async inspectRawBytes() {
      active()
      const records: Array<RawStoredRecord> = []
      for (const [namespace, rows] of Object.entries(db.snapshot())) {
        if (namespace === sideNamespace || markerNamespaces.has(namespace)) continue
        if (!payloadNamespaces.has(namespace))
          throw new Error(`Unclassified payload namespace: ${namespace}`)
        for (const [key, value] of rows) {
          if (!(value instanceof Uint8Array)) throw new Error(`Unsealed payload: ${namespace}`)
          records.push({ ...address(namespace, key), bytes: value.slice() })
        }
      }
      return records.sort(
        (a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key),
      )
    },
    async inspectSideRow(key) {
      active()
      const value = db.snapshot()[sideNamespace]?.get(key)
      if (value === undefined) return null
      if (!(value instanceof Uint8Array)) throw new Error('Invalid side-row bytes')
      return value.slice()
    },
    async mutateStoredRecord(namespace, key, mutate) {
      const before = ciphertext(namespace, key)
      const next = mutate(before.slice()).slice()
      const location = address(namespace, key)
      await db.transact(
        {
          groupID: namespace.startsWith('device') ? null : location.groupID,
          devicePackages: namespace.startsWith('device'),
        },
        async (tx) => {
          tx.rows[namespace]?.set(key, next)
        },
      )
    },
    async swapStoredRecords(namespace, keyA, keyB) {
      const first = ciphertext(namespace, keyA)
      const second = ciphertext(namespace, keyB)
      const left = address(namespace, keyA)
      const right = address(namespace, keyB)
      if (left.groupID !== right.groupID) throw new Error('Swap requires one owner')
      await db.transact(
        {
          groupID: namespace.startsWith('device') ? null : left.groupID,
          devicePackages: namespace.startsWith('device'),
        },
        async (tx) => {
          tx.rows[namespace]?.set(keyA, second)
          tx.rows[namespace]?.set(keyB, first)
        },
      )
    },
    setTime(now) {
      active()
      vi.useFakeTimers({ now })
      fakeTime = true
    },
    async advanceTime(ms) {
      active()
      if (!fakeTime) throw new Error('Set fixture time first')
      await vi.advanceTimersByTimeAsync(ms)
    },
    async close() {
      if (closed) return
      sealLatch?.release()
      openLatch?.release()
      clearInstrumentation()
      for (const latch of held) latch.release()
      held.clear()
      for (const owner of pending) {
        if (owner.rejected) await owner.fault.finish('rollback')
        owner.done()
      }
      pending.clear()
      if (fakeTime) vi.useRealTimers()
      closed = true
    },
  }
  return fixture
}

export async function createControlCrashHarness(mode: 'real-mls' | 'double', seed?: StorageSeed) {
  const fixture = await createStorageFixture({ id: 'control-crash', mode, seed })
  const key = { groupID: 'control-crash', incarnation: 1 }
  const closers: Array<() => Promise<void>> = []
  const fixtureClose = fixture.close.bind(fixture)
  fixture.close = async () => {
    await fixtureClose()
    for (const close of closers) await close()
  }
  const observations = {
    builds: 0,
    buildCompletions: 0,
    ownAdoptions: 0,
    handlePublications: 0,
    welcomeDeliveries: 0,
  }
  const { FakeHub } = (await import(
    new URL('../../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
  )) as {
    FakeHub: new () => LogHub & {
      published: Array<{
        payload: Uint8Array
        publishID?: string
        sequenceID: string
        expectedHead?: string | null
      }>
    }
  }
  const hub = new FakeHub()
  const publications: Array<{
    payload: Uint8Array
    publishID: string | undefined
    expectedHead: string | null
  }> = []
  const transport = {
    subscribe: hub.subscribe.bind(hub),
    unsubscribe: hub.unsubscribe?.bind(hub),
    receive: hub.receive.bind(hub),
    fetchTopic: hub.fetchTopic.bind(hub),
    publish: async (params: Parameters<typeof hub.publish>[0]) => {
      publications.push({
        payload: params.payload.slice(),
        publishID: params.publishID,
        expectedHead: params.expectedHead ?? null,
      })
      return hub.publish(params)
    },
  }
  const attach = async () => {
    const groups = fixture.ports.device.groups as GroupPersistence<MemoryTransaction>
    const control = groups.ports(key).control
    const hooks: {
      beforeSave?: (slot: ControlSlot) => void
      beforeAccept?: () => void
      beforeAdopt?: () => void
    } = {}
    const persistBuild = createPersistenceBuildSaver({ persistence: groups, key })
    const saveBuilt: typeof persistBuild = async (intent, built, expected, mutationID) => {
      hooks.beforeSave?.(built)
      return persistBuild(intent, built, expected, mutationID)
    }
    const apply = control.apply.bind(control)
    control.apply = async (changes, mutationID) => {
      if (changes.commitOnceAcceptance != null) hooks.beforeAccept?.()
      return apply(changes, mutationID)
    }
    const source = async () => (await groups.readEvidence(key)).source
    const stored = await groups.loadState(key)
    if (stored === null || stored.deleted) throw new Error('Missing crash source')
    const retained = (await control.load()).commitOnce
    const sourceBytes =
      stored.state ??
      (retained === null ? undefined : decodeControlJournal(retained.journal).sourceState)
    if (sourceBytes === undefined) throw new Error('Missing retained crash source')
    const initial = decodeClientState(sourceBytes)
    if (initial === undefined) throw new Error('Invalid crash source')
    const identity = {
      ...createFullIdentity(initial.signaturePrivateKey),
      privateKey: initial.signaturePrivateKey,
    }
    const restoreHandle = mode === 'double' ? restoreMemoryControlHandle : restoreGroup
    const initialHandle = await restoreHandle({
      state: initial,
      credential: stored.credential,
      ledgerEntries: stored.ledger,
    })
    const host = await createSealedControlAccess(
      groups,
      key,
      () => observations.handlePublications++,
      () => hooks.beforeAdopt?.(),
      initialHandle,
      restoreHandle,
    )
    const restoreCandidate = async (bytes: Uint8Array) => {
      const state = decodeClientState(bytes)
      if (state === undefined) throw new Error('Invalid candidate')
      const slot = (await control.load()).commitOnce
      return restoreHandle({
        state,
        credential: stored.credential,
        ledgerEntries: mode === 'double' ? undefined : (slot?.bodies ?? stored.ledger),
      })
    }
    const adoption = createControlAdoptionPort({ access: host.access, control, restoreCandidate })
    const adoptControl: typeof adoption.adopt = async (bytes, expected, write) => {
      const result = await adoption.adopt(bytes, expected, write)
      if (result === 'installed') observations.ownAdoptions++
      return result
    }
    const buildHost = async (
      op: Operation,
      handle: Awaited<ReturnType<typeof restoreCandidate>>,
    ) => {
      observations.builds++
      if (mode === 'double') return buildSealedMemoryOperation(op, handle)
      const { invite, publicPackage } = decodeStoredValue(op.body) as {
        invite: Parameters<typeof commitInvite>[2]
        publicPackage: Parameters<typeof commitInvite>[1]
      }
      const built = await commitInvite(handle, publicPackage, invite)
      return {
        commit: built.commitMessage,
        bodies: invite.ledgerEntries,
        journal: encodeClientState(built.newGroup.state),
        welcome: { bytes: built.welcomeMessage, recipients: [invite.recipientDID] },
        incarnation: key.incarnation,
        epoch: Number(handle.epoch),
        authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
        digest: digestAppliedCommit(built.commitMessage),
      }
    }
    const buildPort = createControlBuildPort({
      access: host.access,
      control,
      build: buildHost,
      saveBuilt,
      now: Date.now,
      newID: () => crypto.randomUUID(),
    })
    const entrySlot = createLedgerEntrySlot()
    const cryptoPort = createGroupCrypto({ access: host.access })
    const mls =
      mode === 'double'
        ? new Proxy(memoryModel(initialHandle), {
            get(_target, property) {
              if (property === 'readRecoverySource')
                return async () => {
                  const value = await source()
                  if (value.identity === null) throw new Error('Missing memory source identity')
                  return {
                    ...value,
                    epoch: value.identity.epoch,
                    authenticator: value.identity.authenticator,
                  }
                }
              const current = memoryModel(host.live())
              const value = Reflect.get(current, property)
              return typeof value === 'function' ? value.bind(current) : value
            },
          })
        : createGroupMLS({ access: host.access, identity, entrySlot })
    const validation =
      mode === 'double'
        ? sealedMemoryValidation()
        : createControlValidationPort({ identity, restoreCandidate, options: {} })
    let running: ReturnType<typeof createGroupPeerWithControlWalk> | undefined
    const runtime = () => {
      if (running === undefined) {
        running = createGroupPeerWithControlWalk({
          hub: transport,
          crypto: cryptoPort,
          mls,
          control,
          prepareBuild: async (op, frame) => {
            const result = await buildPort.prepareBuild(op, frame)
            if (result.kind === 'saved') observations.buildCompletions++
            return result
          },
          validation,
          adopt: adoptControl,
          appOutbox: groups.ports(key).outbox,
          appOutboxLimit: 128,
          appCursorStore: groups.ports(key).cursor,
          readEvidence: () => groups.readEvidence(key),
          // Anchor staging has its own durable owner; it must not move the guarded MLS row.
          anchorStore: groups.ports({ groupID: 'group-B', incarnation: 1 }).anchor,
          localDID: identity.id,
          protocols: {},
          handlers: {},
          deliverWelcome: async () => {
            observations.welcomeDeliveries++
          },
        })
        closers.push(close)
      }
      return running
    }
    const close = async () => {
      if (running !== undefined) {
        await running.peer.dispose()
        await running.peer.drained()
      }
    }
    const intent = async () => {
      const retained = (await control.load()).operations.find((row) => row.stage === 'intent')
      if (retained?.stage === 'intent') return retained
      const invitee = randomIdentity()
      const body = await (async () => {
        if (mode === 'double') return encodeStoredValue({ target: invitee.id })
        const bundle = await createKeyPackageBundle(invitee)
        const { invite } = await createInvite({
          group: host.live(),
          identity,
          recipientDID: invitee.id,
          permission: 'member',
        })
        return encodeStoredValue({ invite, publicPackage: bundle.publicPackage })
      })()
      const op: Operation & { stage: 'intent' } = {
        id: crypto.randomUUID(),
        kind: 'invite',
        revokes: false,
        body,
        seq: 1,
        enqueuedAt: Date.now(),
        deadline: Date.now() + 30_000,
        stage: 'intent',
      }
      await control.apply(
        { putOperations: [op], cursor: { position: null, epoch: stored.epoch } },
        'intent',
      )
      return op
    }
    const build = async () => {
      const op = await intent()
      let slot: ControlSlot | undefined
      let expected: AdoptionExpected | undefined
      const preparation = createControlBuildPort({
        access: host.access,
        control,
        build: buildHost,
        saveBuilt: async (_intent, value, source) => {
          slot = value
          expected = source
          return 'saved'
        },
        now: Date.now,
        newID: () => crypto.randomUUID(),
      })
      await preparation.prepareBuild(op, async (built, seal) => ({
        payload: encodeHandshakeFrame(
          HANDSHAKE_KIND.commit,
          encodeCommitFrame(built.commit, (await seal(encodeLedgerEntries(built.bodies))).sealed),
        ),
        publishID: crypto.randomUUID(),
        expectedHead: null,
      }))
      if (slot === undefined || expected === undefined) throw new Error('Missing preparation')
      return { intent: op, slot, expected }
    }
    const accept = async (slot: ControlSlot, mutationID: string) => {
      const proof: FirstValidCommit = {
        source: await source(),
        from: slot.searchFrom,
        position: asLogPosition('000000000001'),
        payloadDigest: slot.payloadDigest,
      }
      const op = (await control.load()).operations.find((row) => row.id === slot.opID)
      if (op === undefined) throw new Error('Missing crash operation')
      await control.apply(
        {
          commitOnceAcceptance: proof,
          putOperations: [
            {
              ...op,
              stage: 'accepted',
              built: controlBuildRef(slot),
              acceptedAs: proof.position,
              acceptance: proof,
            },
          ],
        },
        mutationID,
      )
      return proof
    }
    const adopt = async (
      expected: AdoptionExpected & { acceptance: FirstValidCommit },
      write: AdoptionWrite,
      fault: {
        skipTrust?: boolean
        reuseAuthenticator?: boolean
        staleLifetime?: boolean
        absentLifetime?: boolean
      } = {},
    ) => {
      const slot = (await control.load()).commitOnce
      if (slot === null) throw new Error('Missing durable crash slot')
      host.fault(fault)
      const result = await adoptControl(slot.journal, expected, write)
      if (result === 'moved') throw new Error('Control adoption moved')
    }

    const armAnchor = async (slot: ControlSlot) => {
      const state = await groups.loadState(key)
      if (state === null || state.deleted) throw new Error('Missing anchor source')
      await groups.ports(key).anchor.save({
        anchor: { epoch: slot.epoch, secret: new Uint8Array(32).fill(0x72) },
        pending: {
          epochBefore: slot.epoch,
          epochAfter: slot.epoch + 1,
          rosterBefore: [state.credential.id],
          forced: false,
          advance: slot.digest,
        },
      })
    }
    return {
      groups,
      control,
      key,
      validation,
      get peer() {
        return runtime().peer
      },
      get controlWalk() {
        return runtime().controlWalk
      },
      intent,
      hub,
      publications,
      observations,
      hooks,
      close,
      localDID: identity.id,
      operation: async () => {
        const row = (await control.load()).operations[0]
        if (row === undefined) throw new Error('Missing queued operation')
        return row
      },
      topic: async () => commitTopic(await mls.exportRecoverySecret()),
      armFault: (
        stage: 'built' | 'accepted' | 'adoption',
        work: () => void | Promise<void>,
        hook?: () => void,
      ) => {
        const arm = () => {
          if (stage === 'built') hooks.beforeSave = undefined
          else if (stage === 'accepted') hooks.beforeAccept = undefined
          else hooks.beforeAdopt = undefined
          fixture.onPhase('work', work)
          if (hook !== undefined) fixture.onPhase('hook', hook)
        }
        if (stage === 'built') hooks.beforeSave = arm
        else if (stage === 'accepted') hooks.beforeAccept = arm
        else hooks.beforeAdopt = arm
      },
      source,
      build,
      saveBuilt,
      accept,
      adopt,
      armAnchor,
      loadAnchor: () => groups.ports(key).anchor.load(),
      recoveryTrust: () => groups.loadTrust(key.groupID),
      losePrivateState: async () => {
        const state = await groups.loadState(key)
        if (state === null || state.deleted) throw new Error('Missing private state')
        await groups.transition(
          await nextChange(groups, key.groupID, 'lost-private-state'),
          async (stores) => {
            await stores
              .incarnation(1)
              .state.save({ ...state, version: state.version + 1, state: null })
          },
        )
      },
    }
  }
  const attached = await attach()
  return Object.defineProperties(
    {
      fixture,
      async reopen() {
        for (const close of closers) await close()
        await fixture.reopen()
        return attach()
      },
    },
    {
      ...Object.getOwnPropertyDescriptors(attached),
    },
  ) as typeof attached & { fixture: typeof fixture; reopen(): ReturnType<typeof attach> }
}

export async function runControlProofConflict(
  mode: 'real-mls' | 'double',
  stage: 'built' | 'accepted' | 'adoption' = 'built',
): Promise<CommitOnceEvidence> {
  const h = await createControlCrashHarness(mode)
  await h.peer.resync()
  const intent = await h.intent()
  if (stage !== 'built') {
    await h.controlWalk.stepOperation(intent.id)
    const built = (await h.control.load()).commitOnce
    if (built === null) throw new Error('Missing saved slot')
    await h.hub.publish({
      senderDID: h.localDID,
      topicID: await h.topic(),
      payload: built.payload,
      publishID: built.publishID,
      retain: 'log',
    })
  }
  const baseline = h.publications.length
  const controlBefore = await h.control.load()
  const calls: Array<string> = []
  const started = Promise.withResolvers<ReturnType<typeof h.fixture.rejectCommitPending>>()
  h.armFault(
    stage,
    () => started.resolve(h.fixture.rejectCommitPending()),
    () => calls.push('hook'),
  )
  let fault: ReturnType<typeof h.fixture.rejectCommitPending> | undefined
  let completed = false
  let latch: ReturnType<typeof h.fixture.holdNextSeal> | undefined
  try {
    const saving = h.controlWalk.stepOperation((await h.operation()).id).then(
      () => null,
      (error: unknown) => error,
    )
    fault = await started.promise
    await fault.rejected
    await fault.barrierWaiting
    expect(h.publications).toHaveLength(baseline)
    expect(calls).toEqual([])
    const otherChange = await nextChange(h.groups, 'group-B', 'draining')
    latch = h.fixture.holdNextSeal()
    const operations: Array<Promise<unknown>> = []
    const draining = h.groups
      .transition(otherChange, async (stores) => {
        operations.push(
          stores
            .incarnation(1)
            .cursor.save('active', '2')
            .then(
              () => null,
              (error: unknown) => error,
            ),
        )
        operations.push(
          stores
            .incarnation(1)
            .cursor.save('queued', '3')
            .then(
              () => null,
              (error: unknown) => error,
            ),
        )
        await Promise.all(operations)
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    await latch.reached
    const later = h.groups.load('group-B').then(
      () => null,
      (error: unknown) => error,
    )
    await h.fixture.forceOwnerMarker(
      { groupID: h.key.groupID },
      { mutationID: 'intruder', revision: 99 },
    )
    await fault.finish('rollback')
    completed = true
    const error = await saving
    expect(error).toMatchObject({ name: 'GroupStateConflictError' })
    expect(await later).toBe(error)
    expect(await draining).toBe(error)
    for (const operation of operations) expect(await operation).toBe(error)
    latch.release()
    expect(
      await h.groups.load(h.key.groupID).then(
        () => null,
        (failure: unknown) => failure,
      ),
    ).toBe(error)
    expect(calls).toEqual([])
    const reopened = await h.reopen()
    const restored = await reopened.control.load()
    if (stage !== 'adoption') expect(restored).toEqual(controlBefore)
    else {
      expect(restored.commitOnce).toEqual(controlBefore.commitOnce)
      expect(restored.applied).toEqual([])
    }
    const publications = h.publications.slice(baseline)
    return {
      outcome: 'unknown',
      builds: h.observations.builds,
      ownAdoptions: h.observations.ownAdoptions,
      welcomeDeliveries: h.observations.welcomeDeliveries,
      payloads: publications.map((row) => row.payload),
      publishIDs: publications.map((row) => {
        if (row.publishID === undefined) throw new Error('Missing control publish ID')
        return row.publishID
      }),
      expectedHeads: publications.map((row) => row.expectedHead ?? null),
      searchFrom: controlBefore.commitOnce?.searchFrom ?? null,
      slotAfterAck: (await reopened.control.load()).commitOnce,
      winnerFollowed: false,
      candidateMatchesReceiver: false,
      progressPreserved: false,
      cursor: (await reopened.control.load()).cursor?.position ?? null,
      terminal: (await reopened.groups.readEvidence(reopened.key)).terminal,
      publicationsBeforeProof: publications.length,
    }
  } finally {
    latch?.release()
    if (!completed) await fault?.finish('rollback')
    await h.fixture.close()
  }
}
