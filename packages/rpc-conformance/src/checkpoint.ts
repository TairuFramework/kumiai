import { describe, expect, onTestFinished, test, vi } from 'vitest'

import type {
  ConformanceCapturedRejoinRecord,
  ConformanceForkRecoveryAuthorisation,
  ConformanceGroupConditionEvent,
} from './control-store.js'
import type { ConformanceForkNotice, ConformanceForkNoticeEvent } from './fork-notice.js'
import { storageChange } from './group-storage.js'
import type {
  ConformanceManualRecoveryRecord,
  ConformanceSuccessorTombstone,
} from './manual-recovery.js'
import type {
  ConformanceAppHoldRecord,
  ConformanceBranchAbandonedEvent,
  ConformanceCheckpointFactRecord,
  ConformanceGroupKey,
  ConformanceGroupStores,
  ConformanceGroupTransaction,
  ConformanceHoldHistoryRecord,
  ConformancePersistenceFixture,
  FixtureOptions,
  StorageTestPorts,
} from './persistence-fixture.js'

export type ConformanceCheckpointRecord<Position extends string = string> =
  | ConformanceAppHoldRecord
  | ConformanceHoldHistoryRecord
  | {
      kind: 'branch-abandonment'
      id: string
      key: ConformanceGroupKey
      event: ConformanceBranchAbandonedEvent
      factIDs: Array<string>
      acknowledgedAt: number | null
    }
  | {
      kind: 'own-branch-messages'
      id: string
      key: ConformanceGroupKey
      epoch: number
      authHash: string
      messages: Array<{ id: string; epoch: number; authHash: string }>
    }
  | {
      kind: 'others-seen'
      id: string
      key: ConformanceGroupKey
      epoch: number
      authHash: string
      count: number
    }
  | {
      kind: 'branch-coverage'
      id: string
      key: ConformanceGroupKey
      startedEpoch: number
      startedAuthHash: string
    }
  | {
      kind: 'manual-recovery'
      id: string
      key: ConformanceGroupKey
      value: ConformanceManualRecoveryRecord<Position>
    }
  | {
      kind: 'successor'
      id: string
      key: ConformanceGroupKey
      value: ConformanceSuccessorTombstone
    }
  | {
      kind: 'superseded-rejoin'
      id: string
      key: ConformanceGroupKey
      record: ConformanceCapturedRejoinRecord<Position>
      authorisation: ConformanceForkRecoveryAuthorisation
    }
  | {
      kind: 'condition'
      id: string
      key: ConformanceGroupKey
      event: ConformanceGroupConditionEvent
      active: boolean
      notification?: { emitAt: number; emitted: boolean; installationID: string }
      sealedProof: Uint8Array | null
    }
  | {
      kind: 'notice-tombstone'
      id: string
      key: ConformanceGroupKey
      noticeID: string
      acknowledgedRevision: number
      acknowledgedAt: number | null
      frames: Array<{ hash: string; installationID: string }>
    }
  | { kind: 'notice'; id: string; key: ConformanceGroupKey; notice: ConformanceForkNotice }
  | {
      kind: 'evidence'
      id: string
      key: ConformanceGroupKey
      noticeID: string
      first: Uint8Array
      second: Uint8Array
      localRosterFact: Uint8Array
      eligibilityRosterFact: Uint8Array | null
    }
  | {
      kind: 'notice-event'
      id: string
      key: ConformanceGroupKey
      event: ConformanceForkNoticeEvent
      emitAt: number
      acknowledged: boolean
    }
  | ConformanceCheckpointFactRecord
  | {
      kind: 'coverage'
      id: string
      key: ConformanceGroupKey
      current: { key: ConformanceGroupKey; epoch: number } | null
      effectiveFloor: number | null
      gaps: ConformanceCheckpointCoverage['gaps']
      installations: Array<{ id: string; key: ConformanceGroupKey; epoch: number }>
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
      retryAt?: number
      retryDelay?: number
    }
  | {
      kind: 'cursor'
      id: string
      key: ConformanceGroupKey
      topicID: string
      position: string | null
      intake?: Uint8Array
      schedule?: {
        clock: number
        tokens: number
        refilledAt: number
        receiveAt: number
        retryDelay: number
      }
    }

export type { ConformanceCheckpointFactRecord } from './persistence-fixture.js'
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

export type ConformanceCheckpointStore<Position extends string = string> = {
  load(id: string): Promise<ConformanceCheckpointRecord<Position> | null>
  list(): Promise<Array<ConformanceCheckpointRecord<Position>>>
  put(record: ConformanceCheckpointRecord<Position>): Promise<void>
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
  schedule: { clock: 10000, tokens: 0, refilledAt: 10000, receiveAt: 11000, retryDelay: 15000 },
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
  retryAt: 12000,
  retryDelay: 15000,
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
        const installed = await read(fixture)
        const otherInstalled = await read(fixture, 'group-B')
        const before = [...installed, fact(), publication(), cursor()]
        await write(fixture, [fact(), publication(), cursor()])
        expect(await read(fixture)).toEqual(before)
        expect(await read(fixture, 'group-B')).toEqual(otherInstalled)
        const rows = (await fixture.inspectRawBytes()).filter(
          (row) => row.namespace === 'checkpoints',
        )
        expect(rows).toHaveLength(before.length + otherInstalled.length)
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

    test('ordinary condition writes require verified coordinator authority', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const key = { groupID, incarnation: 1 }
        const record: ConformanceCheckpointRecord = {
          kind: 'condition',
          id: 'condition-absence',
          key,
          active: true,
          event: {
            ...key,
            id: 'condition-absence',
            kind: 'not-member',
            detectedAt: 123,
            evidence: {
              responderKeyHash: 'responder-key',
              epoch: 3,
              authHash: 'other-branch',
              observedAt: 123,
              responderDIDs: ['responder'],
              responderCount: 1,
            },
          },
          sealedProof: new Uint8Array([0, 128, 255]),
        }
        await expect(write(fixture, [record])).rejects.toThrow('authority')
        expect(await read(fixture)).not.toContainEqual(record)
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
          const otherInstalled = await read(fixture, 'group-B')
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
          expect(await read(fixture, 'group-B')).toEqual(otherInstalled)
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
        const after = await read(fixture)
        for (const row of before) {
          if (row.kind === 'coverage') continue
          const retained = after.find((record) => record.id === row.id)
          const installed = before.find((record) => record.kind === 'coverage')
          const authorised =
            installed?.kind === 'coverage' &&
            installed.installations.some((fact) => fact.id === row.id)
          expect(retained).toMatchObject(
            row.kind === 'fact' && authorised ? { ...row, supersededAt: expect.any(Number) } : row,
          )
        }
        expect(after.find((record) => record.kind === 'coverage')).toMatchObject({
          key: { groupID, incarnation: 2 },
        })
        expect(
          after
            .filter((record) => record.key.incarnation === 2 && record.kind !== 'coverage')
            .map((record) => record.kind)
            .sort(),
        ).toEqual(['branch-coverage', 'fact', 'publication'])
        const marker = after.find(
          (row) => row.kind === 'branch-coverage' && row.key.incarnation === 2,
        )
        const destinationFact = after.find(
          (row) => row.kind === 'fact' && row.key.incarnation === 2,
        )
        if (marker?.kind !== 'branch-coverage' || destinationFact?.kind !== 'fact')
          throw new Error('Missing destination journal coverage')
        expect(JSON.parse(new TextDecoder().decode(destinationFact.canonical))).toMatchObject({
          epoch: marker.startedEpoch,
          authHash: marker.startedAuthHash,
        })
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
        const installed = await read(fixture)
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
        expect(await read(fixture)).toEqual([...installed, fact(), cursor()])
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

    test('installed coverage and provenance cannot be rewritten by ordinary records', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const records = await read(fixture)
        const coverage = records.find((row) => row.kind === 'coverage')
        if (coverage?.kind !== 'coverage') throw new Error('Missing installed coverage')
        expect(coverage.current).toEqual({ key, epoch: 3 })
        expect(coverage.effectiveFloor).toBe(3)
        expect(coverage.gaps).toEqual([{ key, from: 0, through: 2, reason: 'pre-join' }])
        expect(coverage).not.toHaveProperty('members')
        const installed = records.find((row) => row.id === coverage.installations[0]?.id)
        if (installed?.kind !== 'fact') throw new Error('Missing authorised fact')
        await expect(
          write(fixture, [{ ...coverage, effectiveFloor: 0, gaps: [] }]),
        ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
        await expect(write(fixture, [{ ...installed, supersededAt: 0 }])).rejects.toMatchObject({
          name: 'GroupStateConflictError',
        })
        expect(await read(fixture)).toEqual(records)
        await fixture.reopen()
        expect(await read(fixture)).toEqual(records)
      } finally {
        await fixture.close()
      }
    })

    test('effects cannot rewrite installed coverage after finalisation', async () => {
      let replacement: ConformanceCheckpointRecord | undefined
      const fixture = await params.createFixture(groupID, {
        effects: {
          async outbox(tx) {
            if (replacement !== undefined)
              await fixture.constructGroupStores(tx, key).checkpoints.put(replacement)
          },
        },
      })
      try {
        const records = await read(fixture)
        const coverage = records.find((row) => row.kind === 'coverage')
        if (coverage?.kind !== 'coverage') throw new Error('Missing installed coverage')
        replacement = { ...coverage, current: null, installations: [], gaps: [] }
        const groups = fixture.ports.device.groups
        const before = await fixture.inspectRows()
        await expect(
          groups.transition(
            await storageChange(groups, groupID, 'effect-coverage'),
            async (stores) => {
              await stores.incarnation(1).meta.putEvents([
                {
                  ...key,
                  id: 'effect-checkpoint-event',
                  kind: 'accepted',
                  entry: {
                    seq: 79,
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
        ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
        expect(await fixture.inspectRows()).toEqual(before)
      } finally {
        await fixture.close()
      }
    })

    test('checkpoint operations drain before closure and preserve group independence', async () => {
      const fixture = await params.createFixture(groupID)
      const installed = await read(fixture)
      const otherInstalled = await read(fixture, 'group-B')
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
          ...otherInstalled,
          { ...cursor(), key: { groupID: 'group-B', incarnation: 1 } },
        ])
        latch.release()
        await writer
        await Promise.all(operations)
        await fixture.reopen()
        expect(await read(fixture)).toEqual([...installed, fact(), cursor()])
      } finally {
        latch.release()
        await fixture.close()
      }
    })

    test('checkpoint metadata needs no private state open', async () => {
      const fixture = await params.createFixture(groupID)
      try {
        const installed = await read(fixture)
        const rows = await fixture.inspectRawBytes()
        for (const row of rows.filter(
          (row) => row.groupID === groupID && ['state', 'trust'].includes(row.namespace),
        )) {
          await fixture.mutateStoredRecord(row.namespace, row.key, () => new Uint8Array([0]))
        }
        await write(fixture, [fact(), publication(), cursor()])
        await fixture.reopen()
        expect(await read(fixture)).toEqual([...installed, fact(), publication(), cursor()])
        const groups = fixture.ports.device.groups
        await expect(groups.loadState(key)).rejects.toThrow()
        await expect(groups.loadTrust(groupID)).rejects.toThrow()
        await groups.transition(
          await storageChange(groups, groupID, 'checkpoint-remove'),
          (stores) => stores.checkpoints.remove(['publication-3', 'absent']),
        )
        expect(await read(fixture)).toEqual([...installed, fact(), cursor()])
      } finally {
        await fixture.close()
      }
    })
  })
}

export type CheckpointPortFixture = {
  port: ConformanceCheckpointPort
  key: ConformanceGroupKey
  installed(): Promise<{ id: string; epoch: number }>
  advance(): Promise<void>
  generations(): Promise<unknown>
  unproven(kind: 'speculative' | 'rolled-back' | 'foreign-key' | 'fabricated-fact'): Promise<string>
  retire(): Promise<void>
  decodeEpoch(frame: Uint8Array): number
  close(): Promise<void>
}

export function testCheckpointPortConformance(params: {
  label: string
  createFixture(): Promise<CheckpointPortFixture>
}): void {
  describe(`CheckpointPort: ${params.label}`, () => {
    test.each(['speculative', 'rolled-back', 'foreign-key', 'fabricated-fact'] as const)(
      'signing requires proven installed fact: %s',
      async (kind) => {
        const fixture = await params.createFixture()
        try {
          expect(await fixture.port.signInstalled(await fixture.unproven(kind))).toBeNull()
          expect(await fixture.port.signInstalled((await fixture.installed()).id)).not.toBeNull()
        } finally {
          await fixture.close()
        }
      },
    )
    test('rapid advances sign the captured installation', async () => {
      const fixture = await params.createFixture()
      try {
        const captured = await fixture.installed()
        const capturedEpoch = captured.epoch
        await fixture.advance()
        await fixture.advance()
        const generationsBeforeSigning = await fixture.generations()
        const frame = await fixture.port.signInstalled(captured.id)
        if (frame === null) throw new Error('Missing captured checkpoint')
        const decoded = { epoch: fixture.decodeEpoch(frame) }
        expect(decoded.epoch).toBe(capturedEpoch)
        const generationsAfterSigning = await fixture.generations()
        expect(generationsAfterSigning).toEqual(generationsBeforeSigning)
        expect(await fixture.port.signInstalled(captured.id)).toEqual(frame)
        expect(await fixture.port.signInstalled((await fixture.installed()).id)).not.toBeNull()
        expect(await fixture.port.exportCheckpoints(fixture.key)).toHaveLength(2)
        expect(await fixture.port.exportCheckpoints(fixture.key, [capturedEpoch])).toEqual([frame])
        const snapshot = frame.slice()
        frame.fill(0)
        expect(await fixture.port.exportCheckpoints(fixture.key, [capturedEpoch])).toEqual([
          snapshot,
        ])
        expect(await fixture.port.checkpointFact(fixture.key, capturedEpoch)).not.toBeNull()
        expect(
          await fixture.port.checkpointFact({ ...fixture.key, incarnation: 999 }, capturedEpoch),
        ).toBeNull()
      } finally {
        await fixture.close()
      }
    })
    test('retired workers cannot sign for replacement', async () => {
      const fixture = await params.createFixture()
      try {
        const captured = await fixture.installed()
        await fixture.retire()
        await expect(fixture.port.signInstalled(captured.id)).rejects.toThrow()
      } finally {
        await fixture.close()
      }
    })
  })
}

export function testCheckpointCacheConformance(params: {
  label: string
  createFixture(): Promise<{
    port: ConformanceCheckpointPort
    key: ConformanceGroupKey
    installed(): Promise<{ id: string; epoch: number }>
    advance(): Promise<void>
    saveFrame(factID: string, frame: Uint8Array): Promise<void>
    signBody(body: Record<string, unknown>, otherSigner?: boolean): Uint8Array
    otherKeyHash: string
    close(): Promise<void>
  }>
}): void {
  describe(`checkpoint cache: ${params.label}`, () => {
    test('saved publication cannot substitute another installation', async () => {
      const fixture = await params.createFixture()
      try {
        const first = await fixture.installed()
        const frame = await fixture.port.signInstalled(first.id)
        if (frame === null) throw new Error('Missing signed checkpoint')
        await fixture.advance()
        const current = await fixture.installed()
        expect(current.epoch).toBeGreaterThan(first.epoch)
        await fixture.saveFrame(current.id, frame)
        await expect(fixture.port.signInstalled(current.id)).rejects.toThrow()
      } finally {
        await fixture.close()
      }
    })
    test.each([
      'v',
      'type',
      'groupID',
      'genesisHash',
      'ciphersuite',
      'epoch',
      'authHash',
      'parentAuthHash',
      'keyHash',
      'leafIndex',
      'extra',
      'other-signer',
      'signature',
      'noncanonical',
      'version',
      'kind',
      'length',
      'body-length',
      'truncated',
      'oversized',
    ] as const)('cached own statement preserves %s binding', async (kind) => {
      const fixture = await params.createFixture()
      try {
        const fact = await fixture.installed()
        const original = await fixture.port.signInstalled(fact.id)
        if (original === null) throw new Error('Missing signed checkpoint')
        expect(await fixture.port.signInstalled(fact.id)).toEqual(original)
        const body = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(original.slice(10, -64)),
        ) as Record<string, unknown>
        const hash = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'
        const changes: Record<string, unknown> = {
          v: 2,
          type: 'other',
          groupID: 'another-group',
          genesisHash: hash,
          ciphersuite: body.ciphersuite === 1 ? 3 : 1,
          epoch: fact.epoch + 1,
          authHash: hash,
          parentAuthHash: body.parentAuthHash === null ? hash : null,
          keyHash: hash,
          leafIndex: Number(body.leafIndex) + 1,
          extra: true,
        }
        let frame: Uint8Array = original.slice()
        if (Object.hasOwn(changes, kind))
          frame = fixture.signBody({ ...body, [kind]: changes[kind] })
        else if (kind === 'other-signer')
          frame = fixture.signBody({ ...body, keyHash: fixture.otherKeyHash }, true)
        else if (kind === 'signature') frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 1
        else if (kind === 'noncanonical') {
          frame = new Uint8Array(original.length + 1)
          frame.set(original.slice(0, 10))
          frame[10] = 32
          frame.set(original.slice(10), 11)
          const view = new DataView(frame.buffer)
          view.setUint32(2, frame.length - 6)
          view.setUint32(6, frame.length - 74)
        } else if (kind === 'version') frame[0] = 2
        else if (kind === 'kind') frame[1] = 2
        else if (kind === 'length') new DataView(frame.buffer).setUint32(2, frame.length - 7)
        else if (kind === 'body-length') new DataView(frame.buffer).setUint32(6, frame.length - 75)
        else if (kind === 'truncated') frame = frame.slice(0, 73)
        else if (kind === 'oversized') frame = new Uint8Array(4097)
        expect(frame).not.toEqual(original)
        if (kind === 'other-signer')
          expect((await fixture.port.compare(fixture.key, frame)).kind).toBe('agreement')
        await fixture.saveFrame(fact.id, frame)
        await expect(fixture.port.signInstalled(fact.id)).rejects.toThrow()
      } finally {
        await fixture.close()
      }
    })
  })
}

export type CheckpointComparisonFixture = {
  port: ConformanceCheckpointPort
  key: ConformanceGroupKey
  sharedRosterDID: string
  frame: Uint8Array
  wrongKeyFrame: Uint8Array
  wrongBindingFrame: Uint8Array
  malformedFrames: Array<Uint8Array>
  close(): Promise<void>
}
export function testCheckpointComparisonConformance(params: {
  label: string
  createFixture(): Promise<CheckpointComparisonFixture>
}): void {
  describe(`checkpoint comparison: ${params.label}`, () => {
    test('shared roster controls eligibility after divergent membership', async () => {
      const fixture = await params.createFixture()
      try {
        const comparison = await fixture.port.compare(fixture.key, fixture.frame)
        expect(comparison.kind).toBe('conflict')
        if (comparison.kind !== 'conflict') throw new Error('Missing conflict')
        const sharedRosterDID = fixture.sharedRosterDID
        expect(comparison.signerDID).toBe(sharedRosterDID)
        expect(await fixture.port.compare(fixture.key, fixture.wrongKeyFrame)).toEqual({
          kind: 'coverage-gap',
        })
        expect(await fixture.port.compare(fixture.key, fixture.wrongBindingFrame)).toEqual({
          kind: 'invalid',
        })
        for (const frame of fixture.malformedFrames)
          expect(await fixture.port.compare(fixture.key, frame)).toEqual({ kind: 'invalid' })
        const damaged = fixture.frame.slice()
        damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1
        expect(await fixture.port.compare(fixture.key, damaged)).toEqual({ kind: 'invalid' })
        expect(
          await fixture.port.compare(
            { ...fixture.key, incarnation: fixture.key.incarnation + 1 },
            fixture.frame,
          ),
        ).toEqual({ kind: 'coverage-gap' })
      } finally {
        await fixture.close()
      }
    })
  })
}

export function testCheckpointCoverageConformance(params: {
  label: string
  createFixture(): Promise<{
    groupID: string
    port(): ConformanceCheckpointPort
    install(incarnation: number, epoch: number): Promise<void>
    restart(): Promise<void>
    prune(): Promise<void>
    close(): Promise<void>
  }>
}): void {
  test(`public comparison coverage survives pruning and restart: ${params.label}`, async ({
    signal,
  }) => {
    const fixture = await params.createFixture()
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    // Runs on timeout too; the abandoned body keeps running and must not leak the mocked clock.
    onTestFinished(() => {
      clock.mockRestore()
    })
    try {
      await fixture.install(1, 3)
      await fixture.install(1, 6)
      for (let epoch = 7; epoch <= 261; epoch++) {
        if (signal.aborted) throw signal.reason
        await fixture.install(epoch < 130 ? 1 : 2, epoch)
      }
      const key = { groupID: fixture.groupID, incarnation: 2 }
      const before = await fixture.port().checkpointCoverage(fixture.groupID)
      expect(before).toMatchObject({
        current: { key, epoch: 261 },
        effectiveFloor: 6,
        retained: [
          { key: { ...key, incarnation: 1 }, from: 6, through: 129 },
          { key, from: 130, through: 261 },
        ],
        gaps: expect.arrayContaining([
          { key: { ...key, incarnation: 1 }, from: 0, through: 2, reason: 'pre-join' },
          { key: { ...key, incarnation: 1 }, from: 3, through: 3, reason: 'expired' },
          { key: { ...key, incarnation: 1 }, from: 4, through: 5, reason: 'skipped' },
          { key, from: 0, through: 129, reason: 'pre-join' },
        ]),
      })
      clock.mockReturnValue(start + 604800000 - 1)
      expect(await fixture.port().checkpointCoverage(fixture.groupID)).toEqual(before)
      await fixture.restart()
      expect(await fixture.port().checkpointCoverage(fixture.groupID)).toEqual(before)
      clock.mockReturnValue(start + 604800000)
      const expired = await fixture.port().checkpointCoverage(fixture.groupID)
      expect(expired).toMatchObject({
        current: { key, epoch: 261 },
        effectiveFloor: 261,
        retained: [{ key, from: 261, through: 261 }],
        gaps: expect.arrayContaining([{ key, from: 130, through: 260, reason: 'expired' }]),
      })
      expect(await fixture.port().checkpointFact({ ...key, incarnation: 1 }, 6)).toBeNull()
      await fixture.prune()
      await fixture.restart()
      expect(await fixture.port().checkpointCoverage(fixture.groupID)).toEqual(expired)
      expect(await fixture.port().checkpointFact({ ...key, incarnation: 1 }, 6)).toBeNull()
    } finally {
      await fixture.close()
    }
  }, 120000)
}

export function malformedCheckpointBodies(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [
    { extra: true },
    { v: 2 },
    { type: 'other' },
    { ciphersuite: 99 },
    { epoch: -1 },
    { epoch: 0.5 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { leafIndex: -1 },
    { leafIndex: 0x100000000 },
    { groupID: '' },
    { groupID: '\ud800' },
    { authHash: 'invalid' },
    { genesisHash: 'invalid' },
    { keyHash: 'invalid' },
    { parentAuthHash: 'invalid' },
  ].map((patch) => ({ ...body, ...patch }))
}

export type ConformanceCheckpointService<Position extends string = string> =
  ConformanceCheckpointPort & {
    importCheckpoint(key: ConformanceGroupKey, frame: Uint8Array): Promise<void>
    forkNotices(groupID: string): Promise<Array<ConformanceForkNotice>>
    ackForkNotice(groupID: string, id: string, revision: number): Promise<void>
    events(groupID: string): Promise<Array<ConformanceForkNoticeEvent>>
    readRecords(): Promise<Array<ConformanceCheckpointRecord<Position>>>
    updateRecords(change: {
      put?: Array<ConformanceCheckpointRecord<Position>>
      remove?: Array<string>
    }): Promise<void>
  }
