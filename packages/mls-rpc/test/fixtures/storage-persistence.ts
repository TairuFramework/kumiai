import { randomIdentity } from '@kokuin/token'
import {
  createKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  keyPackageRef,
} from '@kumiai/mls'
import type { KeyPackageRecord } from '@kumiai/mls-hub'
import type { StorageTestPorts } from '@kumiai/rpc-conformance'
import { vi } from 'vitest'

import { createGroupStateStores } from '../../src/memory-group-state.js'
import { groupOwnerKey } from '../../src/memory-incarnation-stores.js'
import { physicalRecordKey } from '../../src/persistence-codec.js'
import type {
  MemoryTransaction,
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
import { installSeed, makeStorageSeed, nextChange } from './storage-seed.js'

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
}): Promise<PersistenceFixture<StorageTestPorts<MemoryTransaction>>> {
  const identity = randomIdentity()
  const ownerDID = identity.id
  const providerID = 'storage-provider'
  const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
  let sealLatch: { reached(): void; wait: Promise<void>; release(): void } | undefined
  const atRest = {
    open: codec.open,
    async seal(bytes: Uint8Array, aad: Uint8Array) {
      const latch = sealLatch
      sealLatch = undefined
      if (latch !== undefined) {
        latch.reached()
        await latch.wait
      }
      return await codec.seal(bytes, aad)
    },
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
  function ports(effects = params.effects) {
    const device = createMemoryDevicePersistence({ db, atRest, providerID, ownerDID, effects })
    return {
      device,
      packageStores: (sourceID: string) => createMemoryPackageStores({ device, sourceID }),
    }
  }
  const initial = ports({})
  const seed = await makeStorageSeed({ id: params.id, incarnation: 1, epoch: 3, mode: params.mode })
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
    ports: ports(),
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
      sealLatch = undefined
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
