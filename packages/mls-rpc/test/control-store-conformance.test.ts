import {
  type AdoptionWrite,
  asLogPosition,
  type CommitOnceWriteContext,
  type ControlChanges,
  type ControlSlot,
  controlAdoptionAllowed,
  controlBuildRef,
  controlSafetyHeld,
} from '@kumiai/rpc'
import {
  type ConformanceControlHost,
  type ConformanceEpochIdentity,
  decodeControlFixtureState,
  testControlStoreConformance,
} from '@kumiai/rpc-conformance'
import { expect, test } from 'vitest'

import { controlBuildContexts } from '../src/control-write-context.js'
import { createGroupStateStores } from '../src/memory-group-state.js'
import {
  type ControlRecord,
  groupOwnerKey,
  memoryRecordTable,
  sameStoredValue,
} from '../src/memory-incarnation-stores.js'
import { decodeStoredValue, encodeStoredValue, recordAAD } from '../src/persistence-codec.js'
import type { MemoryDatabase, MemoryTransaction } from '../src/persistence-types.js'
import { createIncarnationStores, createMemoryTransaction, memoryFaults } from '../src/testing.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'

const key = { groupID: 'group-A', incarnation: 1 }
const atRest = createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(98) })
type HostState = {
  bytes: Uint8Array
  version: number
  initial: ConformanceEpochIdentity | null
}
let db: MemoryDatabase

// The contract supplies an opaque host codec. Control and anchor use the real sealed provider.
function host(): ConformanceControlHost {
  const transact = async <TValue>(
    mutationID: string | null,
    work: (tx: MemoryTransaction) => Promise<TValue>,
  ): Promise<TValue> => {
    return db.transact({ groupID: key.groupID, devicePackages: false }, async (tx) => {
      if (mutationID !== null) {
        const previous = tx.rows['group-owner']?.get(groupOwnerKey(key.groupID)) as
          | { revision: number }
          | undefined
        tx.rows['group-owner']?.set(groupOwnerKey(key.groupID), {
          revision: (previous?.revision ?? 0) + 1,
          mutationID,
        })
      }
      return work(tx)
    })
  }
  const stateTable = (tx: MemoryTransaction) =>
    memoryRecordTable<HostState>({ tx, key, atRest, namespace: 'meta' })
  const rows = (tx: MemoryTransaction, context: CommitOnceWriteContext | null = null) =>
    createIncarnationStores({ tx, key, atRest, adoptionContext: async () => context })
  return {
    control: {
      key,
      load: () => transact(null, (tx) => rows(tx).control.load()),
      lastMutation: () =>
        transact(null, async (tx) => {
          return (
            (
              await memoryRecordTable<ControlRecord>({
                tx,
                key,
                atRest,
                namespace: 'control',
              }).load('current')
            )?.mutationID ?? null
          )
        }),
      apply: (changes, mutationID) =>
        transact(mutationID, async (tx) => {
          // The cast bridges only the mirror's unbranded log positions.
          await rows(tx).control.apply(changes as ControlChanges, mutationID)
        }),
    },
    loadVersion: () =>
      transact(null, async (tx) => (await stateTable(tx).load('control-host-state'))?.version ?? 0),
    loadState: () =>
      transact(
        null,
        async (tx) => (await stateTable(tx).load('control-host-state'))?.bytes ?? null,
      ),
    saveBuilt: (intent, built, expected, mutationID) =>
      transact(mutationID, async (tx) => {
        const state = await stateTable(tx).load('control-host-state')
        const identity = state === null ? null : decodeControlFixtureState(state.bytes)
        const snapshot = await rows(tx).control.load()
        if (
          controlSafetyHeld(snapshot) !== null ||
          snapshot.controlHold !== null ||
          !sameStoredValue(expected.key, key) ||
          !sameStoredValue(expected.identity, identity) ||
          expected.stateVersion !== (state?.version ?? 0) ||
          (snapshot.cursor === null && !sameStoredValue(state?.initial, identity)) ||
          !sameStoredValue(snapshot.operations[0], intent) ||
          built.searchFrom !== (snapshot.cursor?.position ?? null) ||
          (snapshot.cursor !== null &&
            (snapshot.cursor.epoch !== identity?.epoch || snapshot.cursor.stranded))
        )
          return 'moved'
        if (
          snapshot.commitOnce !== null &&
          snapshot.commitOnce.incarnation === key.incarnation &&
          snapshot.commitOnce.epoch >= (identity?.epoch ?? 0)
        )
          return 'occupied'
        controlBuildContexts.set(tx, {
          kind: 'build',
          source: expected,
          queueHeadID: intent.id,
          checkpoint: snapshot.cursor?.position ?? null,
        })
        try {
          await rows(tx).control.apply(
            {
              commitOnce: built as ControlSlot,
              commitOnceAcceptance: null,
              putOperations: [
                { ...intent, stage: 'built', built: controlBuildRef(built as ControlSlot) },
              ],
            } as ControlChanges,
            mutationID,
          )
        } finally {
          controlBuildContexts.delete(tx)
        }
        return 'saved'
      }),
    saveState: (bytes, write) =>
      transact(write?.mutationID ?? crypto.randomUUID(), async (tx) => {
        const state = await stateTable(tx).load('control-host-state')
        const before = state === null ? null : decodeControlFixtureState(state.bytes)
        const after = decodeControlFixtureState(bytes)
        const snapshot = await rows(tx).control.load()
        if (
          controlSafetyHeld(snapshot) !== null ||
          (write !== undefined &&
            snapshot.controlHold !== null &&
            snapshot.controlHold.reason !== 'acceptance-unknown') ||
          (write?.expected !== undefined &&
            !controlAdoptionAllowed(
              snapshot,
              {
                key,
                identity: before,
                stateVersion: state?.version ?? 0,
              },
              write.expected as NonNullable<AdoptionWrite['expected']>,
            ))
        ) {
          throw Object.assign(new Error('Adoption source or proof moved'), {
            name: 'ControlAdoptionMovedError',
          })
        }
        await stateTable(tx).save('control-host-state', {
          bytes,
          version: (state?.version ?? 0) + 1,
          initial: state === null ? after : state.initial,
        })
        // Only identity is consulted by control head updates; MLS codecs are covered by crash tests.
        const identityTable = memoryRecordTable({ tx, key, atRest, namespace: 'state' })
        if (after === null) identityTable.remove('current')
        else
          await identityTable.save('current', {
            ...after,
            deleted: false,
            epochAuthenticator: after.authenticator,
          })
        if (write !== undefined) {
          const context: CommitOnceWriteContext | null =
            before === null
              ? null
              : after !== null &&
                  after.groupID === before.groupID &&
                  after.incarnation > before.incarnation
                ? {
                    kind: 'retirement',
                    key: { groupID: before.groupID, incarnation: before.incarnation },
                  }
                : { kind: 'adoption', before, after }
          await rows(tx, context).control.apply(write.changes as ControlChanges, write.mutationID)
          const anchor = await rows(tx).anchor.load()
          if (write.anchorLanded !== undefined && anchor?.pending?.advance === write.anchorLanded) {
            await rows(tx).anchor.save({ ...anchor, pending: { ...anchor.pending, landed: true } })
          }
        }
      }),
    anchor: {
      load: () => transact(null, (tx) => rows(tx).anchor.load()),
      save: (slot) => transact(crypto.randomUUID(), (tx) => rows(tx).anchor.save(slot)),
    },
  }
}

testControlStoreConformance({
  open: async () => {
    db = createMemoryTransaction({ rows: {} })
    await db.transact({ groupID: key.groupID, devicePackages: false }, async (tx) => {
      await createGroupStateStores({ tx, groupID: key.groupID, atRest }).lifetime.save({
        groupID: key.groupID,
        latestIncarnation: 1,
        activeIncarnation: 1,
        revision: 1,
        mutationID: 'initial',
        restorePending: false,
      })
    })
    return host()
  },
  reopen: async () => {
    db = createMemoryTransaction({ rows: db.snapshot() })
    return host()
  },
  injectFailure: () => memoryFaults(db).failNext('before-commit'),
  commitThenReject: () => memoryFaults(db).commitThenReject(),
})

test.each([undefined, 9])(
  'root provider normalises legacy recovery fields without rewriting ciphertext (floor %s)',
  async (floor) => {
    const fixture = await createStorageFixture({ id: key.groupID, mode: 'double' })
    try {
      const control = fixture.ports.device.groups.ports(key).control
      const rejoin = {
        id: 'legacy-rejoin',
        stage: 'published' as const,
        publishID: 'legacy-publish',
        expectedHead: null,
        payload: new Uint8Array([0, 255]),
        payloadDigest: 'legacy-payload',
        requestID: 'legacy-request',
        request: new Uint8Array([1]),
        requestKey: new Uint8Array([255, 0]),
        candidate: new Uint8Array([128, 1]),
        source: { key, epoch: 3, authenticator: new Uint8Array([5]), head: null },
        digest: 'legacy-commit',
        epochAfter: 4,
        ledgerBefore: ['owed'],
        conflictEpoch: 3,
      }
      const response = {
        position: asLogPosition('legacy-position'),
        digest: 'legacy-digest',
        epoch: 3,
        kind: 'refused' as const,
        reason: 'policy' as const,
      }
      await control.apply({ putRejoin: rejoin, putResponses: [response] }, 'legacy-record')
      const location = (await fixture.inspectRawBytes()).find(
        (row) => row.namespace === 'control' && row.groupID === key.groupID,
      )
      if (location === undefined) throw new Error('Missing control row')
      const aad = recordAAD(location)
      const record = decodeStoredValue(await atRest.open(location.bytes, aad)) as ControlRecord
      const {
        recoveryEpochFloor: _floor,
        settledRejoins: _settlements,
        ...legacy
      } = record.snapshot
      const encoded = await atRest.seal(
        encodeStoredValue({
          ...record,
          snapshot: {
            ...legacy,
            ...(floor === undefined ? {} : { recoveryEpochFloor: floor }),
          },
        }),
        aad,
      )
      await fixture.mutateStoredRecord('control', location.key, () => encoded)
      const raw = await fixture.inspectRawBytes()
      const reopened = await fixture.reopen()
      const loaded = await reopened.device.groups.ports(key).control.load()
      expect(loaded).toEqual({ ...legacy, recoveryEpochFloor: floor ?? null, settledRejoins: [] })
      expect(loaded.rejoin).toEqual(rejoin)
      expect(loaded.responses).toEqual([response])
      expect(await fixture.inspectRawBytes()).toEqual(raw)
      await reopened.device.groups.ports(key).control.apply({ deleteRejoin: true }, 'clear-legacy')
      expect((await reopened.device.groups.ports(key).control.load()).recoveryEpochFloor).toBe(
        floor ?? null,
      )
      await reopened.device.groups.ports(key).control.apply(
        {
          putResponses: [
            { ...response, digest: 'another-digest', refusalAuthority: 'authenticated-commit' },
          ],
        },
        'add-response-tuple',
      )
      expect((await reopened.device.groups.ports(key).control.load()).responses).toEqual([
        response,
        { ...response, digest: 'another-digest', refusalAuthority: 'authenticated-commit' },
      ])
    } finally {
      await fixture.close()
    }
  },
)
