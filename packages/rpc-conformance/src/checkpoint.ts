import { describe, expect, test } from 'vitest'

import { storageChange } from './group-storage.js'
import type {
  ConformanceGroupKey,
  ConformanceGroupStores,
  ConformanceGroupTransaction,
  ConformancePersistenceFixture,
  FixtureOptions,
  StorageTestPorts,
} from './persistence-fixture.js'

export type ConformanceCheckpointRecord =
  | {
      kind: 'fact'
      id: string
      key: ConformanceGroupKey
      epoch: number
      canonical: Uint8Array
      supersededAt: number | null
    }
  | {
      kind: 'publication'
      id: string
      key: ConformanceGroupKey
      factID: string
      frame: Uint8Array | null
      publishID: string | null
      accepted: boolean
      nextHeartbeatAt: number | null
    }
  | {
      kind: 'cursor'
      id: string
      key: ConformanceGroupKey
      topicID: string
      position: string | null
    }

export type ConformanceCheckpointFactRecord = Extract<ConformanceCheckpointRecord, { kind: 'fact' }>
export type ConformanceCheckpointComparison =
  | { kind: 'agreement'; epoch: number; signerDID: string; keyHash: string }
  | {
      kind: 'conflict'
      epoch: number
      signerDID: string
      keyHash: string
      localAuthHash: string
      remoteAuthHash: string
      parentAuthHash: string | null
    }
  | { kind: 'invalid' | 'coverage-gap' }
export type ConformanceCheckpointCoverage = {
  groupID: string
  current: { key: ConformanceGroupKey; epoch: number } | null
  retained: Array<{ key: ConformanceGroupKey; from: number; through: number }>
  effectiveFloor: number | null
  gaps: Array<{
    key: ConformanceGroupKey
    from: number
    through: number
    reason: 'pre-join' | 'skipped' | 'expired'
  }>
}
export type ConformanceCheckpointPort = {
  signInstalled(factID: string): Promise<Uint8Array | null>
  compare(key: ConformanceGroupKey, frame: Uint8Array): Promise<ConformanceCheckpointComparison>
  exportCheckpoints(key: ConformanceGroupKey, epochs?: Array<number>): Promise<Array<Uint8Array>>
  checkpointFact(key: ConformanceGroupKey, epoch: number): Promise<Uint8Array | null>
  checkpointCoverage(groupID: string): Promise<ConformanceCheckpointCoverage>
}

export type ConformanceCheckpointStore = {
  load(id: string): Promise<ConformanceCheckpointRecord | null>
  list(): Promise<Array<ConformanceCheckpointRecord>>
  put(record: ConformanceCheckpointRecord): Promise<void>
  remove(ids: Array<string>): Promise<void>
}

type Fixture<TTx extends ConformanceGroupTransaction> = ConformancePersistenceFixture<
  StorageTestPorts<TTx>
>
export type CheckpointStorageConformanceParams<TTx extends ConformanceGroupTransaction> = {
  label: string
  createFixture(id: string, options?: FixtureOptions<TTx>): Promise<Fixture<TTx>>
  writeSideRow(tx: TTx, key: string, bytes: Uint8Array): Promise<void>
  retire(fixture: Fixture<TTx>): Promise<void>
}

const groupID = 'group-A'
const key = { groupID, incarnation: 1 }
const fact = (): Extract<ConformanceCheckpointRecord, { kind: 'fact' }> => ({
  kind: 'fact',
  id: 'fact-3',
  key: { ...key },
  epoch: 3,
  canonical: new Uint8Array([0, 128, 255]),
  supersededAt: null,
})
const cursor = (): Extract<ConformanceCheckpointRecord, { kind: 'cursor' }> => ({
  kind: 'cursor',
  id: 'checkpoint-cursor',
  key: { ...key },
  topicID: 'checkpoint-topic',
  position: '7',
})
const publication = (): Extract<ConformanceCheckpointRecord, { kind: 'publication' }> => ({
  kind: 'publication',
  id: 'publication-3',
  key: { ...key },
  factID: 'fact-3',
  frame: new Uint8Array([255, 1, 0]),
  publishID: 'checkpoint-publish',
  accepted: false,
  nextHeartbeatAt: null,
})

export function testCheckpointStorageConformance<TTx extends ConformanceGroupTransaction>(
  params: CheckpointStorageConformanceParams<TTx>,
): void {
  describe(`Checkpoint storage -- ${params.label}`, () => {
    const read = (fixture: Fixture<TTx>, id = groupID) =>
      fixture.entry().read(id, (reads) => reads.checkpoints())
    const write = async (
      fixture: Fixture<TTx>,
      records: Array<ConformanceCheckpointRecord>,
      mutationID = 'checkpoint-write',
    ) => {
      const groups = fixture.ports.device.groups
      await groups.transition(await storageChange(groups, groupID, mutationID), async (stores) => {
        for (const record of records) await stores.checkpoints.put(record)
      })
    }

    test('checkpoint rows are sealed and group scoped', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const before = [fact(), publication(), cursor()]
        await write(fixture, before)
        expect(await read(fixture)).toEqual(before)
        expect(await read(fixture, 'group-B')).toEqual([])
        const rows = (await fixture.inspectRawBytes()).filter(
          (row) => row.namespace === 'checkpoints',
        )
        expect(rows).toHaveLength(3)
        for (const row of rows) {
          expect(row.incarnation).toBeNull()
          expect(row.bytes).not.toEqual(fact().canonical)
        }
        const groups = fixture.ports.device.groups
        await expect(
          groups.transition(await storageChange(groups, groupID, 'wrong-key'), (stores) =>
            stores.checkpoints.put({ ...cursor(), key: { groupID: 'group-B', incarnation: 1 } }),
          ),
        ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
        expect(await read(fixture)).toEqual(before)
        const source = rows.find((row) => row.recordID === 'fact-3')
        if (source === undefined) throw new Error('Missing checkpoint fact ciphertext')
        // Move valid ciphertext into another authenticated address.
        const targets = [
          {
            namespace: 'checkpoints',
            key: JSON.stringify(['group-A', null, 'checkpoint-cursor']),
            groupID,
          },
          {
            namespace: 'checkpoints',
            key: JSON.stringify(['group-B', null, 'checkpoint-cursor']),
            groupID: 'group-B',
          },
          { namespace: 'control', key: JSON.stringify(['group-A', 1, 'current']), groupID },
        ]
        for (const target of targets) {
          if (target.groupID === 'group-B') {
            await groups.transition(
              await storageChange(groups, 'group-B', 'seed-other-cursor'),
              (stores) =>
                stores.checkpoints.put({
                  ...cursor(),
                  key: { groupID: 'group-B', incarnation: 1 },
                }),
            )
          }
          const original = (await fixture.inspectRawBytes()).find(
            (row) => row.namespace === target.namespace && row.key === target.key,
          )
          if (original === undefined) throw new Error('Missing AAD target')
          await fixture.mutateStoredRecord(target.namespace, target.key, () => source.bytes)
          if (target.namespace === 'control')
            await expect(groups.ports(key).control.load()).rejects.toThrow()
          else await expect(read(fixture, target.groupID)).rejects.toThrow()
          await fixture.mutateStoredRecord(target.namespace, target.key, () => original.bytes)
        }
        const reopened = await fixture.reopen()
        await reopened.device.groups.transition(
          await storageChange(reopened.device.groups, groupID, 'read-one'),
          async (stores) => {
            expect(await stores.checkpoints.load('fact-3')).toEqual(fact())
            expect(await stores.checkpoints.load('absent')).toBeNull()
          },
        )
        expect(await read(fixture)).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('checkpoint snapshot and transaction roll back together', async () => {
      let failSide = false
      const fixture = await params.createFixture(groupID, {
        effects: {
          outbox: async (tx) => {
            await params.writeSideRow(tx, 'checkpoint-side', new Uint8Array([9]))
            if (failSide) throw new Error('checkpoint side-write failure')
          },
        },
      })
      try {
        await write(fixture, [fact(), publication(), cursor()])
        const before = await read(fixture)
        const rawBefore = await fixture.inspectRows()
        const groups = fixture.ports.device.groups
        failSide = true
        await expect(
          groups.transition(
            await storageChange(groups, groupID, 'checkpoint-and-event'),
            async (stores) => {
              await stores.checkpoints.remove(['fact-3'])
              await stores.checkpoints.put({ ...cursor(), position: '8' })
              const state = await stores.incarnation(1).state.load()
              if (state === null || state.deleted) throw new Error('Missing state')
              await stores.incarnation(1).state.save({ ...state, version: state.version + 1 })
              await stores.incarnation(1).meta.putEvents([
                {
                  ...key,
                  id: 'checkpoint-rollback-event',
                  kind: 'accepted',
                  entry: {
                    seq: 77,
                    protocol: 'chat',
                    prc: 'posted',
                    data: new Uint8Array([7]),
                    lastAttempt: null,
                    status: 'accepted',
                  },
                },
              ])
            },
          ),
        ).rejects.toThrow('checkpoint side-write failure')
        await fixture.reopen()
        expect(await read(fixture)).toEqual(before)
        expect(await fixture.inspectRows()).toEqual(rawBefore)
      } finally {
        await fixture.close()
      }
    })

    test.each(['commit', 'rollback'] as const)(
      'unknown proof releases no rows: late %s',
      async (outcome) => {
        const fixture = await params.createFixture(groupID)
        try {
          await write(fixture, [fact()])
          const before = await read(fixture)
          const groups = fixture.ports.device.groups
          const change = await storageChange(groups, groupID, 'checkpoint-unknown')
          const fault = fixture.rejectCommitPending()
          let released = false
          const hooks: Array<string> = []
          const pending = groups
            .transition(change, async (stores) => {
              stores.tx.onCommit(() => hooks.push('committed'))
              stores.tx.onRollback(() => hooks.push('rolled-back'))
              await stores.checkpoints.put(cursor())
              return stores.checkpoints.list()
            })
            .then(
              (value) => {
                released = true
                return value
              },
              (error: unknown) => {
                released = true
                throw error
              },
            )
          const observed = pending.catch((error: unknown) => error)
          await fault.rejected
          await fault.barrierWaiting
          expect(released).toBe(false)
          expect(hooks).toEqual([])
          let readReleased = false
          const waitingRead = read(fixture).then((rows) => {
            readReleased = true
            return rows
          })
          expect(await read(fixture, 'group-B')).toEqual([])
          expect(readReleased).toBe(false)
          await fault.finish(outcome)
          if (outcome === 'commit') expect(await observed).toEqual([...before, cursor()])
          else expect(await observed).toMatchObject({ name: 'StorageOutcomeUnknownError' })
          const expected = outcome === 'commit' ? [...before, cursor()] : before
          expect(hooks).toEqual([outcome === 'commit' ? 'committed' : 'rolled-back'])
          expect(await waitingRead).toEqual(expected)
          await fixture.reopen()
          expect(await read(fixture)).toEqual(expected)
        } finally {
          await fixture.close()
        }
      },
    )

    test('group checkpoint records survive incarnation retirement', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        await write(fixture, [fact(), publication(), cursor()])
        const before = await read(fixture)
        await params.retire(fixture)
        await fixture.reopen()
        expect(await read(fixture)).toEqual(before)
        for (const physicalRecord of (await fixture.inspectRawBytes()).filter(
          (row) => row.namespace === 'checkpoints',
        )) {
          expect(physicalRecord.incarnation).toBeNull()
        }
      } finally {
        await fixture.close()
      }
    })

    test('prepare and expired capabilities cannot write checkpoints', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        await write(fixture, [fact()])
        let expired: ConformanceGroupStores<TTx> | undefined
        await fixture.entry().run(
          { groupID, mutationID: 'checkpoint-entry' },
          async (reads) => {
            const life = await reads.lifetime()
            if (life === null) throw new Error('Missing lifetime')
            const before = await reads.checkpoints()
            const prepare = fixture.constructPrepareStores(key)
            await expect(prepare.checkpoints.put(cursor())).rejects.toMatchObject({
              name: 'PersistencePhaseError',
            })
            await expect(prepare.checkpoints.remove(['fact-3'])).rejects.toMatchObject({
              name: 'PersistencePhaseError',
            })
            expect(await reads.checkpoints()).toEqual(before)
            return {
              expected: { revision: life.revision, activeIncarnation: life.activeIncarnation },
              value: null,
            }
          },
          async (stores) => {
            expired = stores
            const original = fact()
            const saving = stores.checkpoints.put(original)
            if (original.kind === 'fact') original.canonical.fill(99)
            original.key.groupID = 'changed-by-caller'
            await saving
            const loaded = await stores.checkpoints.load('fact-3')
            if (loaded?.kind !== 'fact') throw new Error('Missing fact')
            loaded.canonical.fill(22)
            expect(await stores.checkpoints.load('fact-3')).toEqual(fact())
            await stores.checkpoints.put(cursor())
          },
        )
        if (expired === undefined) throw new Error('Missing expired stores')
        await expect(expired.checkpoints.put(publication())).rejects.toMatchObject({
          name: 'PersistencePhaseError',
        })
        await expect(expired.checkpoints.remove(['fact-3'])).rejects.toMatchObject({
          name: 'PersistencePhaseError',
        })
        await expect(expired.checkpoints.list()).rejects.toMatchObject({
          name: 'PersistencePhaseError',
        })
        await expect(expired.checkpoints.load('fact-3')).rejects.toMatchObject({
          name: 'PersistencePhaseError',
        })
        expect(await read(fixture)).toEqual([fact(), cursor()])
      } finally {
        await fixture.close()
      }
    })

    test('generic checkpoint records do not install state or grant provenance', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const groups = fixture.ports.device.groups
        const beforeState = await groups.loadState(key)
        const beforeTrust = await groups.loadTrust(groupID)
        await write(fixture, [
          { ...fact(), epoch: 999, key: { ...key, incarnation: 999 } },
          publication(),
        ])
        expect(await groups.loadState(key)).toEqual(beforeState)
        expect(await groups.loadTrust(groupID)).toEqual(beforeTrust)
        expect((await groups.load(groupID))?.latestIncarnation).toBe(1)
        expect(await groups.loadState({ ...key, incarnation: 999 })).toBeNull()
      } finally {
        await fixture.close()
      }
    })

    test('checkpoint operations drain before closure and preserve group independence', async () => {
      const fixture = await params.createFixture(groupID)
      const latch = fixture.holdNextSeal()
      const operations: Array<Promise<void>> = []
      let signalReady = (): void => {}
      const ready = new Promise<void>((resolve) => {
        signalReady = resolve
      })
      try {
        const groups = fixture.ports.device.groups
        const change = await storageChange(groups, groupID, 'checkpoint-drain')
        let returned = false
        const writer = groups
          .transition(change, async (stores) => {
            operations.push(stores.checkpoints.put(fact()))
            await latch.reached
            operations.push(stores.checkpoints.put(cursor()))
            signalReady()
          })
          .then(() => {
            returned = true
          })
        await ready
        expect(returned).toBe(false)
        // The blocked seal belongs only to this group.
        await groups.transition(
          await storageChange(groups, 'group-B', 'checkpoint-independent'),
          (stores) =>
            stores.checkpoints.put({ ...cursor(), key: { groupID: 'group-B', incarnation: 1 } }),
        )
        expect(await read(fixture, 'group-B')).toEqual([
          { ...cursor(), key: { groupID: 'group-B', incarnation: 1 } },
        ])
        latch.release()
        await writer
        await Promise.all(operations)
        await fixture.reopen()
        expect(await read(fixture)).toEqual([fact(), cursor()])
      } finally {
        latch.release()
        await fixture.close()
      }
    })

    test('checkpoint metadata needs no private state open', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const rows = await fixture.inspectRawBytes()
        for (const row of rows.filter(
          (row) => row.groupID === groupID && ['state', 'trust'].includes(row.namespace),
        )) {
          await fixture.mutateStoredRecord(row.namespace, row.key, () => new Uint8Array([0]))
        }
        await write(fixture, [fact(), publication(), cursor()])
        await fixture.reopen()
        expect(await read(fixture)).toEqual([fact(), publication(), cursor()])
        const groups = fixture.ports.device.groups
        await expect(groups.loadState(key)).rejects.toThrow()
        await expect(groups.loadTrust(groupID)).rejects.toThrow()
        await groups.transition(
          await storageChange(groups, groupID, 'checkpoint-remove'),
          (stores) => stores.checkpoints.remove(['publication-3', 'absent']),
        )
        expect(await read(fixture)).toEqual([fact(), cursor()])
      } finally {
        await fixture.close()
      }
    })
  })
}
