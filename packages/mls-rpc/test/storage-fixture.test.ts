import type * as Mls from '@kumiai/mls'
import type * as Hub from '@kumiai/mls-hub'
import type * as Rpc from '@kumiai/rpc'
import type * as Mirror from '@kumiai/rpc-conformance'
import { expect, test } from 'vitest'

import type { EntryReads } from '../src/entry-capability.js'
import type * as Actual from '../src/persistence-types.js'
import {
  createMemoryDevicePersistence,
  createMemoryTransaction,
  memoryFaults,
} from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createStorageFixture, writeSideRow } from './fixtures/storage-persistence.js'

test('mutates only addressed ciphertext and preserves markers on missing keys or callback throws', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  try {
    const groups = fixture.ports.device.groups
    const before = await fixture.inspectRawBytes()
    const rowsBefore = await fixture.inspectRows()
    const pending = before.filter((row) => row.namespace === 'pending')
    const first = pending.find((row) => row.recordID === 'frame-1')
    const second = pending.find((row) => row.recordID === 'frame-2')
    if (first === undefined || second === undefined) throw new Error('Missing pending rows')
    await expect(
      fixture.mutateStoredRecord('pending', first.key, (bytes) => {
        bytes.fill(0)
        throw new Error('mutation failed')
      }),
    ).rejects.toThrow('mutation failed')
    await expect(
      fixture.mutateStoredRecord('pending', 'missing', (bytes) => bytes),
    ).rejects.toThrow('missing')
    await expect(fixture.swapStoredRecords('pending', first.key, 'missing')).rejects.toThrow(
      'missing',
    )
    await expect(
      fixture.mutateStoredRecord(
        'group-owner',
        JSON.stringify(['group-A', null, 'current']),
        (bytes) => bytes,
      ),
    ).rejects.toThrow()
    expect(await fixture.inspectRawBytes()).toEqual(before)
    expect(await fixture.inspectRows()).toEqual(rowsBefore)
    const change = await nextChange(groups, 'group-A', 'swapped-read')
    const previousMutationID = (await groups.load('group-A'))?.mutationID
    await fixture.swapStoredRecords('pending', first.key, second.key)
    const after = await fixture.inspectRawBytes()
    expect(
      after.find((row) => row.key === first.key && row.namespace === 'pending')?.bytes,
    ).toEqual(second.bytes)
    expect(
      after.find((row) => row.key === second.key && row.namespace === 'pending')?.bytes,
    ).toEqual(first.bytes)
    expect(after.filter((row) => row.namespace !== 'pending')).toEqual(
      before.filter((row) => row.namespace !== 'pending'),
    )
    const reopened = await fixture.reopen()
    await expect(
      reopened.device.groups.transition(change, async (stores) =>
        stores.incarnation(1).pending.list(),
      ),
    ).rejects.toThrow()
    expect((await reopened.device.groups.load('group-A'))?.mutationID).toBe(previousMutationID)
  } finally {
    await fixture.close()
  }
})

test('returns detached raw snapshots and side rows without opening ciphertext', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  try {
    const before = await fixture.inspectRawBytes()
    const rows = await fixture.inspectRows()
    for (const row of before) {
      expect(rows[row.namespace]?.get(row.key)).toEqual(row.bytes)
      expect(JSON.parse(row.key)).toEqual([row.groupID, row.incarnation, row.recordID])
    }
    const first = before[0]
    if (first === undefined) throw new Error('Missing sealed rows')
    const expected = first.bytes.slice()
    first.bytes.fill(0)
    expect((await fixture.inspectRawBytes())[0]?.bytes).toEqual(expected)
    const groups = fixture.ports.device.groups
    const bytes = new TextEncoder().encode('opaque host side row')
    await groups.transition(await nextChange(groups, 'group-A', 'side-row'), async (stores) => {
      await writeSideRow(stores.tx, 'effect-1', bytes)
    })
    expect(await fixture.inspectSideRow('effect-1')).toEqual(bytes)
    const inspected = await fixture.inspectSideRow('effect-1')
    inspected?.fill(0)
    expect(await fixture.inspectSideRow('effect-1')).toEqual(bytes)
    expect((await fixture.inspectRawBytes()).some((row) => row.namespace === 'host-side')).toBe(
      false,
    )
  } finally {
    await fixture.close()
  }
})

// Each direction checks every value union and transaction/store callback signature.
type ActualContracts = [
  EntryReads,
  Actual.GroupKey,
  Actual.EpochIdentity,
  Actual.PackageUse,
  Actual.GroupLifetime,
  Actual.GroupStateRecord,
  Actual.GroupRecoveryTrust,
  Actual.GroupTransaction,
  Actual.GroupStores<Actual.MemoryTransaction>,
  Actual.GroupPersistence<Actual.MemoryTransaction>,
  Actual.DeviceStores<Actual.MemoryTransaction>,
  Actual.DevicePersistence<Actual.MemoryTransaction>,
  Actual.TransactionalGroupEffects<Actual.MemoryTransaction>,
  Actual.PersistenceFixture<Mirror.StorageTestPorts<Actual.MemoryTransaction>>,
  Actual.IncarnationStores,
  Actual.GroupTransition,
  Actual.GroupPersistencePorts,
  Actual.OwnershipContextPort,
  Actual.AtRestCodec,
  Actual.TransactionHookSettlement,
  Actual.OutcomeAwareTransactionOptions,
  Actual.MemoryStoreRows,
  Actual.MemoryTransaction,
  Actual.MemoryDatabase,
  Actual.DeviceRecord,
  Actual.HubCleanupRow,
  Actual.RestoreWork,
  Actual.RawStoredRecord,
  Actual.PendingCommitFault,
  Actual.PreOpenAppFrameRef,
  Actual.AppFrameRef,
  Actual.PendingAppFrame,
  Actual.AppPoisonRecord,
  Actual.AppAttempt,
  Actual.AppOutboxEntry,
  Actual.AppOutbox,
  Actual.AppPublicationOutcome,
  Actual.AppSettlementObligation,
  Actual.AppSettlementExpected,
  Actual.AppSettlementResult,
  Actual.AppStatusEvent,
  Actual.GroupForkEvidence,
  Actual.ForkHalt,
  Actual.GroupSafetyEvent,
  Actual.RecoveryUnavailableEvent,
  Actual.PersistenceEvent,
  Mls.ClientState['ratchetTree'],
  Mls.DeviceRegistry,
  Mls.MemberCredential,
  Mls.ControllerBinding,
  Hub.KeyPackageRecord,
  Hub.LastResortRecord,
  Hub.KeyPackagePoolStore,
  Hub.LastResortStore,
  Rpc.AnchorSlot,
  Rpc.AnchorStore,
  Rpc.AppCursorStore,
  Rpc.ControlStore,
  Rpc.ControlSnapshot,
  Rpc.ControlChanges,
  Rpc.AcceptedRejoinSettlement,
  Rpc.SafetyHold,
]
type MirrorContracts = [
  Mirror.ConformanceEntryReads<Rpc.LogPosition>,
  Mirror.ConformanceGroupKey,
  Mirror.ConformanceEpochIdentity,
  Mirror.ConformancePackageUse,
  Mirror.ConformanceGroupLifetime,
  Mirror.ConformanceGroupStateRecord,
  Mirror.ConformanceGroupRecoveryTrust,
  Mirror.ConformanceGroupTransaction,
  Mirror.ConformanceGroupStores<Actual.MemoryTransaction, Rpc.LogPosition>,
  Mirror.ConformanceGroupPersistence<Actual.MemoryTransaction, Rpc.LogPosition>,
  Mirror.ConformanceDeviceStores<Actual.MemoryTransaction, Rpc.LogPosition>,
  Mirror.ConformanceDevicePersistence<Actual.MemoryTransaction, Rpc.LogPosition>,
  Mirror.ConformanceTransactionalGroupEffects<Actual.MemoryTransaction>,
  Mirror.ConformancePersistenceFixture<Mirror.StorageTestPorts<Actual.MemoryTransaction>>,
  Mirror.ConformanceIncarnationStores<Rpc.LogPosition>,
  Mirror.ConformanceGroupTransition,
  Mirror.ConformanceGroupPersistencePorts<Rpc.LogPosition>,
  Mirror.ConformanceOwnershipContextPort,
  Mirror.ConformanceAtRestCodec,
  Mirror.ConformanceTransactionHookSettlement,
  Mirror.ConformanceOutcomeAwareTransactionOptions,
  Mirror.ConformanceMemoryStoreRows,
  Mirror.ConformanceMemoryTransaction,
  Mirror.ConformanceMemoryDatabase,
  Mirror.ConformanceDeviceRecord,
  Mirror.ConformanceHubCleanupRow,
  Mirror.ConformanceRestoreWork,
  Mirror.ConformanceRawStoredRecord,
  Mirror.ConformancePendingCommitFault,
  Mirror.ConformancePreOpenAppFrameRef,
  Mirror.ConformanceStorageAppFrameRef,
  Mirror.ConformanceStoragePendingAppFrame,
  Mirror.ConformanceAppPoisonRecord,
  Mirror.ConformanceAppAttempt,
  Mirror.ConformanceStorageAppOutboxEntry,
  Mirror.ConformanceStorageAppOutbox,
  Mirror.ConformanceAppPublicationOutcome,
  Mirror.ConformanceAppSettlementObligation,
  Mirror.ConformanceAppSettlementExpected,
  Mirror.ConformanceAppSettlementResult,
  Mirror.ConformanceAppStatusEvent,
  Mirror.ConformanceGroupForkEvidence,
  Mirror.ConformanceForkHalt,
  Mirror.ConformanceGroupSafetyEvent,
  Mirror.ConformanceRecoveryUnavailableEvent,
  Mirror.ConformancePersistenceEvent,
  Mirror.ConformancePublicTree,
  Mirror.ConformanceDeviceRegistry,
  Mirror.ConformanceMemberCredential,
  Mirror.ConformanceControllerBinding,
  Mirror.ConformanceKeyPackageRecord,
  Mirror.ConformanceLastResortRecord,
  Mirror.ConformanceKeyPackagePoolStore,
  Mirror.ConformanceLastResortStore,
  Mirror.ConformanceAnchorSlot,
  Mirror.ConformanceAnchorStore,
  Mirror.ConformanceAppCursorStore,
  Mirror.ConformanceControlStore<Rpc.LogPosition>,
  Mirror.ConformanceControlSnapshot<Rpc.LogPosition>,
  Mirror.ConformanceControlChanges<Rpc.LogPosition>,
  Mirror.ConformanceAcceptedRejoinSettlement<Rpc.LogPosition>,
  Mirror.ConformanceSafetyHold,
]
function assignContracts(actual: ActualContracts, mirror: MirrorContracts): void {
  const mirrored: MirrorContracts = actual
  const implementation: ActualContracts = mirror
  void mirrored
  void implementation
}
void assignContracts

function requiredRecoveryFields(
  actual: Rpc.ControlSnapshot,
  mirror: Mirror.ConformanceControlSnapshot<Rpc.LogPosition>,
): void {
  const actualFloor: number | null = actual.recoveryEpochFloor
  const mirrorFloor: number | null = mirror.recoveryEpochFloor
  const actualSettlements: Array<Rpc.AcceptedRejoinSettlement> = actual.settledRejoins
  const mirrorSettlements: Array<Rpc.AcceptedRejoinSettlement> = mirror.settledRejoins
  void [actualFloor, mirrorFloor, actualSettlements, mirrorSettlements]
}
void requiredRecoveryFields

const ciphertextNamespaces = [
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
] as const

async function readAddress(
  ports: Mirror.StorageTestPorts<Actual.MemoryTransaction>,
  row: Actual.RawStoredRecord,
): Promise<unknown> {
  const groups = ports.device.groups
  if (row.namespace === 'lifetime') return groups.load(row.groupID)
  if (row.namespace === 'trust') return groups.loadTrust(row.groupID)
  if (row.namespace === 'state')
    return groups.loadState({ groupID: row.groupID, incarnation: row.incarnation ?? 1 })
  if (row.namespace === 'device' || row.namespace === 'device-restore') return ports.device.load()
  if (row.namespace === 'device-package')
    return ports.packageStores('source-1').ordinary.list(ports.device.ownerDID)
  if (row.namespace === 'device-last-resort')
    return ports.packageStores('source-1').lastResort.list(ports.device.ownerDID)
  if (row.namespace === 'device-receipt') {
    const value: unknown = JSON.parse(row.recordID)
    if (!Array.isArray(value) || typeof value[1] !== 'string')
      throw new Error('Invalid receipt address')
    return ports.packageStores('source-1').ordinary.receipt(value[1])
  }
  if (row.namespace === 'device-cleanup')
    return ports.device.transition(
      {
        mutationID: 'read-corrupt',
        expectedRevision: (await ports.device.load()).revision,
        group: null,
      },
      async (stores) => stores.cleanup.list(),
    )
  const change = await nextChange(groups, row.groupID, 'read-corrupt')
  return groups.transition(change, async (stores) => {
    const rows = stores.incarnation(row.incarnation ?? 1)
    switch (row.namespace) {
      case 'control':
        return rows.control.load()
      case 'anchor':
        return rows.anchor.load()
      case 'pending':
        return rows.pending.list()
      case 'poison':
        return rows.pending.listPoison()
      case 'cursor':
        return rows.cursor.load('topic-secret')
      case 'outbox':
        return rows.outbox.list()
      case 'meta':
        return row.recordID.startsWith('["settlement"')
          ? rows.meta.loadSettlement(7)
          : rows.meta.events()
      default:
        throw new Error('Unknown namespace')
    }
  })
}

for (const namespace of ciphertextNamespaces) {
  test.each(['group', 'incarnation', 'namespace', 'record'] as const)(
    `rejects ${namespace} ciphertext sealed for the wrong %s after reopen`,
    async (part) => {
      const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
      try {
        const row = (await fixture.inspectRawBytes()).find((row) => row.namespace === namespace)
        if (row === undefined) throw new Error('Missing namespace')
        const aad = (groupID: string, incarnation: number | null, name: string, recordID: string) =>
          new TextEncoder().encode(
            JSON.stringify(['kumiai/at-rest/v1', groupID, incarnation, name, recordID]),
          )
        const codec = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
        const payload = await codec.open(
          row.bytes,
          aad(row.groupID, row.incarnation, namespace, row.recordID),
        )
        const wrong = await codec.seal(
          payload,
          aad(
            part === 'group' ? 'wrong-group' : row.groupID,
            part === 'incarnation' ? (row.incarnation ?? 0) + 1 : row.incarnation,
            part === 'namespace' ? 'wrong-namespace' : namespace,
            part === 'record' ? 'wrong-record' : row.recordID,
          ),
        )
        const before = await fixture.inspectRows()
        await fixture.mutateStoredRecord(namespace, row.key, () => wrong)
        wrong.fill(0)
        const reopened = await fixture.reopen()
        await expect(readAddress(reopened, row)).rejects.toThrow()
        const after = await fixture.inspectRows()
        expect(after['group-owner']).toEqual(before['group-owner'])
        expect(after['device-owner']).toEqual(before['device-owner'])
        for (const name of ciphertextNamespaces)
          if (name !== namespace) expect(after[name]).toEqual(before[name])
      } finally {
        await fixture.close()
      }
    },
  )
}

test('missing retained trust refuses installation while a safety event can still commit', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  const donor = await createStorageFixture({ id: 'group-A', mode: 'double' })
  try {
    const groups = fixture.ports.device.groups
    const fresh = await storageSeed(donor.ports.device.groups)
    await groups.transition(await nextChange(groups, 'group-A', 'lose-trust'), async (stores) => {
      stores.tx.rows.trust?.delete(JSON.stringify(['group-A', null, 'current']))
    })
    const reopened = await fixture.reopen()
    expect(await reopened.device.groups.loadTrust('group-A')).toBeNull()
    const before = await fixture.inspectRows()
    await expect(
      reopened.device.groups.transition(
        await nextChange(reopened.device.groups, 'group-A', 'install'),
        async (stores) => writeStorageInstall(stores, fresh, 'install', 2),
      ),
    ).rejects.toThrow()
    expect(await fixture.inspectRows()).toEqual(before)
    await reopened.device.groups.transition(
      await nextChange(reopened.device.groups, 'group-A', 'safety'),
      async (stores) =>
        stores.incarnation(1).meta.putEvents([
          {
            groupID: 'group-A',
            incarnation: 1,
            id: 'safety-missing',
            kind: 'group:recovery-unavailable',
            reason: 'trust-unreadable',
          },
        ]),
    )
    expect((await reopened.device.groups.load('group-A'))?.mutationID).toBe('safety')
    const safetyPorts = await fixture.reopen()
    await safetyPorts.device.groups.transition(
      await nextChange(safetyPorts.device.groups, 'group-A', 'read-safety'),
      async (stores) => {
        expect(
          (await stores.incarnation(1).meta.events()).find(
            (event) => event.id === 'safety-missing',
          ),
        ).toEqual({
          groupID: 'group-A',
          incarnation: 1,
          id: 'safety-missing',
          kind: 'group:recovery-unavailable',
          reason: 'trust-unreadable',
        })
      },
    )
  } finally {
    await fixture.close()
    await donor.close()
  }
}, 5000)

async function nextChange(
  groups: Pick<Mirror.ConformanceGroupPersistence<Actual.MemoryTransaction>, 'load'>,
  groupID: string,
  mutationID: string,
): Promise<Actual.GroupTransition> {
  const lifetime = await groups.load(groupID)
  return {
    groupID,
    mutationID,
    expected:
      lifetime === null
        ? null
        : { revision: lifetime.revision, activeIncarnation: lifetime.activeIncarnation },
  }
}
async function storageSeed(groups: Mirror.ConformanceGroupPersistence<Actual.MemoryTransaction>) {
  const lifetime = await groups.load('group-A')
  const state = await groups.loadState({ groupID: 'group-A', incarnation: 1 })
  const trust = await groups.loadTrust('group-A')
  if (lifetime === null || state === null || state.deleted || trust === null)
    throw new Error('Missing storage seed')
  return { lifetime, state, trust }
}
async function writeStorageInstall(
  stores: Mirror.ConformanceGroupStores<Actual.MemoryTransaction>,
  seed: Awaited<ReturnType<typeof storageSeed>>,
  mutationID: string,
  incarnation: number,
): Promise<void> {
  const previous = await stores.lifetime.load()
  await stores.lifetime.save({
    ...seed.lifetime,
    latestIncarnation: incarnation,
    activeIncarnation: incarnation,
    revision: (previous?.revision ?? 0) + 1,
    mutationID,
  })
  await stores.incarnation(incarnation).state.save({ ...seed.state, incarnation, version: 1 })
  await stores.trust.save({ ...seed.trust, installed: { ...seed.trust.installed, incarnation } })
}

test.each(['commit', 'rollback'] as const)(
  'initially absent device and group owners await combined late %s',
  async (finish) => {
    const donor = await createStorageFixture({ id: 'group-A', mode: 'double' })
    try {
      const seed = await storageSeed(donor.ports.device.groups)
      const ownerDID = donor.ports.device.ownerDID
      const ordinary = (await donor.ports.packageStores('source-1').ordinary.list(ownerDID))[0]
      if (ordinary === undefined) throw new Error('Missing package')
      const db = createMemoryTransaction({ rows: { 'host-side': new Map() } })
      const device = createMemoryDevicePersistence({
        db,
        ownerDID,
        providerID: 'fresh-provider',
        atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) }),
      })
      expect((await device.load()).revision).toBe(0)
      expect(await device.groups.load('group-A')).toBeNull()
      const fault = memoryFaults(db).rejectCommitPending()
      const hooks: Array<string> = []
      let done = false
      const operation = device
        .transition(
          {
            mutationID: 'first-install',
            expectedRevision: 0,
            group: { groupID: 'group-A', mutationID: 'first-install', expected: null },
          },
          async (stores) => {
            if (stores.group === null) throw new Error('Missing group participant')
            stores.tx.onCommit(() => {
              hooks.push('commit')
            })
            stores.tx.onRollback(() => {
              hooks.push('rollback')
            })
            await stores.ordinary('source-1').put(ownerDID, ordinary)
            await stores.ordinary('source-1').consume(ordinary.ref, 'group-A')
            await stores.restore.save({
              id: 'restore-first',
              stage: 'invalidate',
              remainingGroups: ['group-A'],
            })
            await writeStorageInstall(stores.group, seed, 'first-install', 1)
            await writeSideRow(stores.tx, 'effect-1', new Uint8Array([1, 2, 3]))
            return 'installed'
          },
        )
        .then(
          (value) => {
            done = true
            return value
          },
          (error: unknown) => {
            done = true
            return error
          },
        )
      await fault.rejected
      await fault.barrierWaiting
      expect(done).toBe(false)
      expect(hooks).toEqual([])
      expect(db.snapshot()).toEqual({
        'host-side': new Map(),
        'group-owner': new Map([
          [JSON.stringify(['group-A', null, 'current']), { mutationID: null, revision: 0 }],
        ]),
      })
      const resolution = device.resolve('first-install')
      await fault.finish(finish)
      expect(await operation).toEqual(
        finish === 'commit'
          ? 'installed'
          : expect.objectContaining({ name: 'StorageOutcomeUnknownError' }),
      )
      expect(hooks).toEqual([finish === 'commit' ? 'commit' : 'rollback'])
      expect((await device.load()).revision).toBe(finish === 'commit' ? 1 : 0)
      expect(await resolution).toBe(finish === 'commit' ? 'committed' : 'rolled-back')
      if (finish === 'commit') expect(await device.resolve('first-install')).toBe('committed')
      else
        await expect(device.resolve('first-install')).rejects.toMatchObject({
          name: 'GroupStateUncertainError',
        })
      expect(hooks).toHaveLength(1)
    } finally {
      await donor.close()
    }
  },
)

for (const mode of ['real-mls', 'double'] as const) {
  test.each(['commit', 'rollback'] as const)(
    `reopen waits for an initially absent owner before reconstructing rows -- ${mode} late %s`,
    async (finish) => {
      const fixture = await createStorageFixture({ id: 'group-B', mode })
      const donor = await createStorageFixture({ id: 'group-A', mode })
      const groups = fixture.ports.device.groups
      await groups.load('group-A')
      const fault = fixture.rejectCommitPending()
      try {
        const seed = await storageSeed(donor.ports.device.groups)
        const install = groups
          .transition(
            { groupID: 'group-A', mutationID: 'pending-reopen', expected: null },
            async (stores) => writeStorageInstall(stores, seed, 'pending-reopen', 1),
          )
          .then(
            (value) => value,
            (error: unknown) => error,
          )
        await fault.rejected
        await fault.barrierWaiting
        let reopened = false
        const reopening = fixture.reopen().then((ports) => {
          reopened = true
          return ports
        })
        // Allow reconstruction to run while the absent owner's transaction is still private.
        await new Promise<void>((resolve) => setImmediate(resolve))
        const early = reopened
        await fault.finish(finish)
        expect(await install).toEqual(
          finish === 'commit'
            ? undefined
            : expect.objectContaining({ name: 'StorageOutcomeUnknownError' }),
        )
        const ports = await reopening
        expect(early).toBe(false)
        expect((await ports.device.groups.load('group-A'))?.mutationID ?? null).toBe(
          finish === 'commit' ? 'pending-reopen' : null,
        )
      } finally {
        await fixture.close()
        await donor.close()
      }
    },
  )
}

test('codec faults and probes fire once', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  try {
    const groups = fixture.ports.device.groups
    const phases: Array<string> = []
    fixture.probeCodec(async (phase) => {
      phases.push(phase)
    })
    await groups.loadState({ groupID: 'group-A', incarnation: 1 })
    await groups.loadState({ groupID: 'group-A', incarnation: 1 })
    expect(phases).toEqual(['work'])
    const openError = new Error('open failed')
    fixture.failNextOpen(openError)
    await expect(groups.loadState({ groupID: 'group-A', incarnation: 1 })).rejects.toThrow()
    await expect(groups.loadState({ groupID: 'group-A', incarnation: 1 })).resolves.toMatchObject({
      deleted: false,
    })
    const sealError = new Error('seal failed')
    const change = await nextChange(groups, 'group-A', 'seal-fault')
    fixture.failNextSeal(sealError)
    await expect(
      groups.transition(change, async (stores) => {
        await stores
          .incarnation(1)
          .anchor.save({ anchor: { epoch: 3, secret: new Uint8Array(32).fill(97) } })
      }),
    ).rejects.toThrow()
    await groups.transition(change, async (stores) => {
      await stores
        .incarnation(1)
        .anchor.save({ anchor: { epoch: 3, secret: new Uint8Array(32).fill(97) } })
    })
  } finally {
    await fixture.close()
  }
})

test('a suspended codec probe keeps the hold and failure on the first concurrent call', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  const probeStarted = Promise.withResolvers<void>()
  const probeReleased = Promise.withResolvers<void>()
  const latch = fixture.holdNextOpen()
  const calls: Array<Promise<unknown>> = []
  try {
    const groups = fixture.ports.device.groups
    fixture.failNextOpen(new Error('first open failed'))
    fixture.probeCodec(async () => {
      probeStarted.resolve()
      await probeReleased.promise
    })
    let firstSettled = false
    const first = groups.loadState({ groupID: 'group-A', incarnation: 1 }).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    )
    calls.push(first)
    void first.then(() => {
      firstSettled = true
    })
    await probeStarted.promise
    const second = groups.loadState({ groupID: 'group-B', incarnation: 1 }).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    )
    calls.push(second)
    expect(
      await Promise.race([second, latch.started.then(() => 'second call held')]),
    ).toMatchObject({
      ok: true,
      value: { deleted: false },
    })
    probeReleased.resolve()
    await latch.started
    expect(firstSettled).toBe(false)
    latch.release()
    expect(await first).toMatchObject({ ok: false })
    await expect(groups.loadState({ groupID: 'group-A', incarnation: 1 })).resolves.toMatchObject({
      deleted: false,
    })
  } finally {
    probeReleased.resolve()
    latch.release()
    await Promise.all(calls)
    await fixture.close()
  }
})

test('held opens suspend once and phase callbacks are one-shot', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  const latch = fixture.holdNextOpen()
  try {
    const groups = fixture.ports.device.groups
    let done = false
    const read = groups.loadState({ groupID: 'group-A', incarnation: 1 }).then(() => {
      done = true
    })
    await latch.started
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)
    latch.release()
    await read
    const phases: Array<string> = []
    for (const phase of ['prepare', 'work', 'finalise', 'effects', 'account', 'hook'] as const) {
      fixture.onPhase(phase, () => {
        phases.push(phase)
      })
    }
    await groups.transition(await nextChange(groups, 'group-A', 'phase-probe'), async () => {})
    await groups.transition(await nextChange(groups, 'group-A', 'next-probe'), async () => {})
    expect(phases).toEqual(['prepare', 'work', 'finalise', 'effects', 'account', 'hook'])
    expect(await fixture.readWith(async (stores) => stores.restore.load())).toMatchObject({
      id: 'restore-1',
    })
    await fixture.combinedWith(new AbortController().signal)
  } finally {
    latch.release()
    await fixture.close()
  }
})

test('a rejecting phase hook is observed after the transition commits', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  try {
    const groups = fixture.ports.device.groups
    const failure = new Error('hook failed')
    fixture.onPhase('hook', async () => {
      await Promise.resolve()
      throw failure
    })
    await expect(
      groups.transition(await nextChange(groups, 'group-A', 'hook-fault'), async () => {}),
    ).rejects.toBe(failure)
    expect((await groups.load('group-A'))?.mutationID).toBe('hook-fault')
    await groups.transition(await nextChange(groups, 'group-A', 'after-hook-fault'), async () => {})
  } finally {
    await fixture.close()
  }
})

test('forced rollback retries work under the retained owner entry', async () => {
  const fixture = await createStorageFixture({ id: 'group-A', mode: 'double' })
  try {
    const groups = fixture.ports.device.groups
    const change = await nextChange(groups, 'group-A', 'retry-probe')
    fixture.retryNextTransition()
    let attempts = 0
    await groups.transition(change, async (stores) => {
      attempts++
      await stores.incarnation(1).cursor.save('retry-topic', String(attempts))
    })
    expect(attempts).toBe(2)
    expect((await groups.load('group-A'))?.mutationID).toBe('retry-probe')
    expect(
      await groups.ports({ groupID: 'group-A', incarnation: 1 }).cursor.load('retry-topic'),
    ).toBe('2')
  } finally {
    await fixture.close()
  }
})
