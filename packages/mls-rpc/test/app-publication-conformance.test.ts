import { setTimeout as settleBackend } from 'node:timers/promises'
import { encodeEventFrame } from '@kumiai/broadcast'
import { testAppPublicationConformance } from '@kumiai/rpc-conformance'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as settlement from '../src/app-settlement.js'
import { finaliseAppSettlements } from '../src/app-settlement.js'
import { groupBatchFor } from '../src/group-batch-binding.js'
import { memoryTransactionEntry } from '../src/memory-group-state.js'
import type { MemoryTransaction } from '../src/persistence-types.js'
import { sourceResultBinding } from '../src/registry/source-crypto-commands.js'
import { createAppPublicationFixture } from './fixtures/app-publication.js'
import { completionFixture } from './fixtures/handler-completion.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'

for (const mode of ['real-mls', 'double'] as const) {
  test(`prepared publication bytes retain the source binding (${mode})`, async () => {
    const f = await createAppPublicationFixture(mode)
    try {
      const entry = {
        seq: 0,
        protocol: 'chat',
        prc: 'posted',
        data: encodeEventFrame('posted', {}),
        status: 'accepted' as const,
        lastAttempt: null,
      }
      await f.outbox.put(entry)
      const prepared = await f.publication.prepare(entry, null)
      const binding = sourceResultBinding(prepared.payload)
      expect(binding?.key).toEqual(f.key)
      expect(binding?.generation).toBeGreaterThan(0)
    } finally {
      await f.close()
    }
  })
  for (const context of ['supplied', 'absent'] as const) {
    testAppPublicationConformance({
      label: `${mode} / ${context}`,
      createFixture: () =>
        createAppPublicationFixture(
          mode,
          context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        ),
    })
  }
}

for (const mode of ['real-mls', 'double'] as const)
  for (const supplied of [false, true])
    describe(`settlement collection / ${mode} / ${supplied}`, () => {
      beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(1000)
      })
      afterEach(() => {
        vi.restoreAllMocks()
      })
      async function setup(cap = 64, corrupt = false) {
        const f = await completionFixture(mode, supplied, cap)
        await f.capability.run(
          { groupID: f.key.groupID, mutationID: crypto.randomUUID() },
          async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
          async (stores) => {
            const rows = stores.incarnation(f.key.incarnation)
            for (const seq of [1, 2]) {
              await rows.outbox.put([
                {
                  seq,
                  protocol: 'chat',
                  prc: 'posted',
                  data: encodeEventFrame('posted', {}),
                  status: 'accepted',
                  lastAttempt: {
                    incarnation: f.key.incarnation,
                    epoch: 3,
                    segment: 2,
                    floor: null,
                    attempts: 1,
                    publishID: `attempt-${seq}`,
                    topicID: `original-${seq}`,
                  },
                },
              ])
              await rows.meta.putSettlement(seq, {
                sequenceID: `position-${seq}`,
                attemptID: `attempt-${seq}`,
                topicID: corrupt && seq === 2 ? 'corrupt' : `original-${seq}`,
                outcome: 'published',
              })
            }
          },
        )
        return f
      }
      test('certified finalisation batch preserves per-item outcomes and retry ownership', async () => {
        const f = await setup()
        try {
          const result = await groupBatchFor(f.binding, f.key.groupID).schedule({
            source: 'certified',
            kind: 'settlement',
            run: (budget) => f.capability.finaliseCertifiedAppBatch(f.key, [1, 2, 1, 3], budget),
          })
          expect(result).toEqual({
            consumed: 4,
            results: [
              { seq: 1, status: 'published' },
              { seq: 2, status: 'published' },
              { seq: 1, status: 'already-complete' },
              { seq: 3, status: 'already-complete' },
            ],
          })
          const events = (await f.groups.ports(f.key).outbox.events()).filter(
            (e) => e.kind === 'published',
          )
          expect(events).toHaveLength(2)
          expect(events.map((e) => e.kind === 'published' && e.occurrence)).toEqual(
            [1, 2].map((seq) => ({
              incarnation: f.key.incarnation,
              segment: 2,
              topicID: `original-${seq}`,
              position: `position-${seq}`,
            })),
          )
          const before = await f.fixture.inspectRows()
          await finaliseAppSettlements({ persistence: f.groups, key: f.key })
          expect(await f.fixture.inspectRows()).toEqual(before)
        } finally {
          await f.fixture.close()
        }
      })
      test('certified conflicts roll back siblings without retry and no-op batches preserve markers', async () => {
        const f = await setup(64, true)
        try {
          const before = await f.fixture.inspectRows()
          let retries = 0
          f.fixture.onPhase('retry', () => {
            retries++
          })
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          await expect(
            scheduler.schedule({
              source: 'conflict',
              kind: 'settlement',
              run: (budget) => f.capability.finaliseCertifiedAppBatch(f.key, [1, 2], budget),
            }),
          ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
          expect(retries).toBe(0)
          expect(await f.fixture.inspectRows()).toEqual(before)
          expect(
            await scheduler.schedule({
              source: 'no-op',
              kind: 'settlement',
              run: (budget) => f.capability.finaliseCertifiedAppBatch(f.key, [3, 3], budget),
            }),
          ).toEqual({
            consumed: 2,
            results: [
              { seq: 3, status: 'already-complete' },
              { seq: 3, status: 'already-complete' },
            ],
          })
          expect(await f.fixture.inspectRows()).toEqual(before)
        } finally {
          await f.fixture.close()
        }
      })
      test('certified finalisation backoff retains same-group ownership', async () => {
        const f = await setup(2)
        const primitive = settlement.finaliseCertifiedAppInTransaction
        const attempts: Array<{
          seq: number
          tx: object
          stores: object
          owner: object | undefined
          mutationID: string
        }> = []
        const spy = vi
          .spyOn(settlement, 'finaliseCertifiedAppInTransaction')
          .mockImplementation(async (input) => {
            attempts.push({
              seq: input.seq,
              tx: input.stores.tx,
              stores: input.stores,
              owner: memoryTransactionEntry((input.stores.tx as MemoryTransaction).rows),
              mutationID: input.mutationID,
            })
            if (input.seq === 1 && attempts.length > 2 && attempts.length <= 19)
              f.fixture.failNext('before-commit')
            return primitive(input)
          })
        const before = await f.fixture.inspectRows()
        const fault = f.fixture.armNextWorkFault('before-commit')
        let retries = 0
        const firstRetry = Promise.withResolvers<void>()
        f.fixture.onPhase('retry', () => {
          retries++
          firstRetry.resolve()
        })
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          let finished = false
          const batch = scheduler
            .schedule({
              source: 'certified',
              kind: 'settlement',
              run: (budget) => f.capability.finaliseCertifiedAppBatch(f.key, [1, 2, 99], budget),
            })
            .then((result) => {
              finished = true
              return result
            })
          void batch.catch(() => {})
          const mutationID = await fault.mutationID
          for (let spin = 0; spin < 200 && retries === 0; spin++) await settleBackend(1)
          expect(retries).toBe(1)
          await firstRetry.promise
          await vi.advanceTimersByTimeAsync(0)
          const later = vi.fn()
          const queued = (['control', 'open', 'enqueue', 'accounting'] as const).map((kind) =>
            scheduler.schedule({
              source: kind,
              kind,
              run: async () => {
                later()
              },
            }),
          )
          const life = await f.capability.read('group-B', (reads) => reads.lifetime())
          await f.groups.transition(
            { groupID: 'group-B', mutationID: crypto.randomUUID(), expected: life },
            async () => {},
          )
          const retirement = f.capability.run(
            { groupID: f.key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => {
              later()
              return { expected: await reads.lifetime(), value: undefined }
            },
            async () => {},
          )
          const delays = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 15000, 15000]
          for (const [index, delay] of delays.entries()) {
            await vi.advanceTimersByTimeAsync(delay - 1)
            expect(retries).toBe(index + 1)
            expect(later).not.toHaveBeenCalled()
            expect(finished).toBe(false)
            const rows = await f.fixture.inspectRows()
            for (const namespace of ['outbox', 'meta'])
              expect(rows[namespace]).toEqual(before[namespace])
            await vi.advanceTimersByTimeAsync(1)
            for (let spin = 0; spin < 200 && retries < index + 2 && !finished; spin++)
              await settleBackend(1)
            await vi.advanceTimersByTimeAsync(0)
          }
          const result = await batch
          expect(result).toEqual({
            consumed: 2,
            results: [
              { seq: 1, status: 'published' },
              { seq: 2, status: 'published' },
            ],
          })
          expect(attempts.map((input) => input.seq)).toEqual(
            Array.from({ length: 11 }, () => [1, 2]).flat(),
          )
          expect(new Set(attempts.map((input) => input.owner)).size).toBe(1)
          expect(new Set(attempts.map((input) => input.mutationID))).toEqual(new Set([mutationID]))
          expect(new Set(attempts.map((input) => input.tx)).size).toBe(11)
          expect(new Set(attempts.map((input) => input.stores)).size).toBe(11)
          expect(before).not.toEqual(await f.fixture.inspectRows())
          await Promise.all([...queued, retirement])
          expect(later).toHaveBeenCalledTimes(5)
        } finally {
          vi.useRealTimers()
          spy.mockRestore()
          await f.fixture.close()
        }
      })
      test('settlement staging stops at the work boundary and leaves the suffix owned by its producer', async () => {
        let now = 1000
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
        const f = await setup()
        const primitive = settlement.finaliseCertifiedAppInTransaction
        const spy = vi
          .spyOn(settlement, 'finaliseCertifiedAppInTransaction')
          .mockImplementation(async (input) => {
            const result = await primitive(input)
            now += 8
            return result
          })
        try {
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          expect(
            await scheduler.schedule({
              source: 'work-bound',
              kind: 'settlement',
              run: (budget) => f.capability.finaliseCertifiedAppBatch(f.key, [1, 2], budget),
            }),
          ).toEqual({ consumed: 1, results: [{ seq: 1, status: 'published' }] })
          expect((await f.groups.ports(f.key).outbox.list()).map((entry) => entry.seq)).toContain(2)
          expect(await f.groups.ports(f.key).outbox.loadSettlement(2)).not.toBeNull()
          expect(spy).toHaveBeenCalledTimes(1)
          spy.mockRestore()
          clock.mockRestore()
          await finaliseAppSettlements({ persistence: f.groups, key: f.key })
          expect(
            (await f.groups.ports(f.key).outbox.events()).filter(
              (event) => event.kind === 'published',
            ),
          ).toHaveLength(2)
        } finally {
          spy.mockRestore()
          clock.mockRestore()
          await f.fixture.close()
        }
      })
      test('cold and singleton settlements collect a bounded prefix', async () => {
        for (const client of ['singleton', 'cold']) {
          const f = await setup(2)
          const gate = Promise.withResolvers<void>()
          try {
            const scheduler = groupBatchFor(f.binding, f.key.groupID)
            const active = scheduler.schedule({
              source: 'held',
              kind: 'open',
              run: () => gate.promise,
            })
            const batch = vi.spyOn(f.capability, 'finaliseCertifiedAppBatch')
            const calls =
              client === 'cold'
                ? [finaliseAppSettlements({ persistence: f.groups, key: f.key })]
                : [1, 2].map((seq) => f.capability.finaliseCertifiedApp(f.key, seq))
            gate.resolve()
            await active
            await Promise.all(calls)
            expect(batch).toHaveBeenCalledTimes(1)
            expect(batch.mock.calls[0]?.[1]).toEqual([1, 2])
          } finally {
            gate.resolve()
            await f.fixture.close()
          }
        }
      })
      test('settlement collector preserves untouched suffix order', async () => {
        const f = await setup(2)
        const release = Promise.withResolvers<void>()
        try {
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const active = scheduler.schedule({
            source: 'held',
            kind: 'open',
            run: () => release.promise,
          })
          const batch = vi.spyOn(f.capability, 'finaliseCertifiedAppBatch')
          const calls = [1, 2, 99, 100].map((seq) => f.capability.finaliseCertifiedApp(f.key, seq))
          release.resolve()
          await active
          await Promise.all(calls)
          expect(batch.mock.calls.map((call) => call[1])).toEqual([
            [1, 2, 99, 100],
            [99, 100],
          ])
        } finally {
          release.resolve()
          await f.fixture.close()
        }
      })
      test('certification rollback keeps its existing owner precedence', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const initial = await f.groups.loadState(f.key)
          if (initial === null || initial.deleted) throw new Error('Missing state')
          const outbox = f.groups.ports(f.key).outbox
          await outbox.put({
            seq: 10,
            protocol: 'chat',
            prc: 'posted',
            data: encodeEventFrame('posted', {}),
            status: 'accepted',
            lastAttempt: {
              incarnation: f.key.incarnation,
              epoch: initial.epoch,
              segment: 0,
              floor: null,
              attempts: 1,
              publishID: 'current',
              topicID: 'topic',
            },
          })
          const state = await f.groups.loadState(f.key)
          if (state === null || state.deleted) throw new Error('Missing state')
          const life = await f.groups.load(f.key.groupID)
          let retries = 0
          f.fixture.onPhase('retry', () => {
            retries++
          })
          f.fixture.armNextWorkFault('before-commit')
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
          try {
            let failure: unknown
            const certification = outbox
              .recordSettlement(
                10,
                {
                  sequenceID: 'position',
                  attemptID: 'current',
                  topicID: 'topic',
                  outcome: 'published',
                },
                {
                  identity: {
                    ...f.key,
                    epoch: state.epoch,
                    authenticator: state.epochAuthenticator,
                  },
                  stateVersion: state.version,
                  attemptID: 'current',
                },
              )
              .catch((error: unknown) => {
                failure = error
              })
            for (let spin = 0; spin < 200 && retries === 0 && failure === undefined; spin++)
              await settleBackend(1)
            expect(retries).toBe(1)
            await vi.advanceTimersByTimeAsync(0)
            let later = false
            const lifecycle = f.groups.transition(
              {
                groupID: f.key.groupID,
                mutationID: crypto.randomUUID(),
                expected: life === null ? null : { ...life, revision: life.revision + 1 },
              },
              async () => {
                later = true
              },
            )
            await vi.advanceTimersByTimeAsync(99)
            expect(later).toBe(false)
            expect(failure).toBeUndefined()
            await vi.advanceTimersByTimeAsync(1)
            expect(await certification).toEqual({ recorded: true })
            await lifecycle
            expect(later).toBe(true)
          } finally {
            vi.useRealTimers()
          }
        } finally {
          await f.fixture.close()
        }
      })
      test('certification mismatch remains a no-write result beside batching', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const state = await f.groups.loadState(f.key)
          if (state === null || state.deleted) throw new Error('Missing state')
          const outbox = f.groups.ports(f.key).outbox
          await outbox.put({
            seq: 10,
            protocol: 'chat',
            prc: 'posted',
            data: encodeEventFrame('posted', {}),
            status: 'accepted',
            lastAttempt: {
              incarnation: f.key.incarnation,
              epoch: state.epoch,
              segment: 0,
              floor: null,
              attempts: 1,
              publishID: 'current',
              topicID: 'topic',
            },
          })
          const current = await f.groups.loadState(f.key)
          if (current === null || current.deleted) throw new Error('Missing current state')
          const expected = {
            identity: { ...f.key, epoch: state.epoch, authenticator: state.epochAuthenticator },
            stateVersion: current.version,
            attemptID: 'current',
          }
          const obligation = {
            sequenceID: 'position',
            attemptID: 'current',
            topicID: 'topic',
            outcome: 'published' as const,
          }
          for (const reason of [
            'identity-changed',
            'state-version-changed',
            'attempt-changed',
            'entry-missing',
          ] as const) {
            const input = structuredClone(expected)
            if (reason === 'identity-changed') input.identity.epoch++
            if (reason === 'state-version-changed') input.stateVersion++
            if (reason === 'attempt-changed') input.attemptID = 'wrong'
            const before = await f.fixture.inspectRows()
            expect(
              await outbox.recordSettlement(
                reason === 'entry-missing' ? 99 : 10,
                obligation,
                input,
              ),
            ).toEqual({ recorded: false, reason })
            expect(await f.fixture.inspectRows()).toEqual(before)
          }
        } finally {
          await f.fixture.close()
        }
      })
      test('scheduled enqueue and settlement roots reject reentry before admission', async () => {
        const f = await setup()
        try {
          await f.plant([f.record('handler')])
          const ports = f.groups.ports(f.key)
          const entry = (await ports.outbox.list()).find((row) => row.seq === 1)
          if (entry === undefined) throw new Error('Missing certified entry')
          const state = await f.groups.loadState(f.key)
          if (state === null || state.deleted) throw new Error('Missing state')
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const schedule = vi.spyOn(scheduler, 'schedule')
          const before = await f.fixture.inspectRows()
          await f.completion.transact(['handler'], async () => {
            const calls = [
              () => ports.outbox.put(entry),
              () =>
                ports.outbox.remove(1, {
                  incarnation: f.key.incarnation,
                  segment: 2,
                  topicID: 'original-1',
                  position: 'position-1',
                }),
              () =>
                ports.outbox.recordSettlement(
                  1,
                  {
                    outcome: 'published',
                    sequenceID: 'position-1',
                    attemptID: 'attempt-1',
                    topicID: 'original-1',
                  },
                  {
                    identity: {
                      ...f.key,
                      epoch: state.epoch,
                      authenticator: state.epochAuthenticator,
                    },
                    stateVersion: state.version,
                    attemptID: 'attempt-1',
                  },
                ),
              () => finaliseAppSettlements({ persistence: f.groups, key: f.key }),
              () => f.capability.finaliseCertifiedApp(f.key, 1),
            ]
            const admissions = schedule.mock.calls.length
            const outcomes: Array<unknown> = Array.from({ length: calls.length })
            calls.forEach((call, index) => {
              try {
                void Promise.resolve(call()).then(
                  () => {
                    outcomes[index] = 'admitted'
                  },
                  (error: unknown) => {
                    outcomes[index] = error
                  },
                )
              } catch (error) {
                outcomes[index] = error
              }
            })
            for (let i = 0; i < 50; i++) await Promise.resolve()
            for (const outcome of outcomes)
              expect(outcome).toMatchObject({ name: 'ReentrantOwnershipError' })
            expect(schedule.mock.calls).toHaveLength(admissions)
            expect(await f.fixture.inspectRows()).toEqual(before)
          })
        } finally {
          await f.fixture.close()
        }
      })
    })
