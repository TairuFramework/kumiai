import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type AppCompletionCoverage,
  appFrameIdempotencyKey,
  bindAppCompletionCoverage,
  combineDurableHandlers,
  createOpenedAppHandler,
  encodeAppAAD,
  type HandlerCompletion,
} from '@kumiai/rpc'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { retirementDomain } from '../src/closing-preparation.js'
import { entryCapability } from '../src/entry-capability.js'
import { groupBatchFor } from '../src/group-batch-binding.js'
import { createHandlerCompletion, handlerCompletionForEntry } from '../src/handler-completion.js'
import type { GroupStores, MemoryTransaction } from '../src/persistence-types.js'
import { copyEntryReads } from './fixtures/entry-reads.js'
import {
  authenticatedCompletionFixture,
  completionFixture,
  orderedCoverage,
} from './fixtures/handler-completion.js'
import { writeSideRow } from './fixtures/storage-persistence.js'
import { makeStorageSeed, writeInstallationCheckpoint } from './fixtures/storage-seed.js'

function bind(
  completion: HandlerCompletion<MemoryTransaction>,
  coverage: ReturnType<typeof orderedCoverage>,
) {
  const binding = bindAppCompletionCoverage(completion, coverage.source)
  if (binding === undefined) throw new Error('Missing coverage registration')
  return binding
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
})
afterEach(() => vi.restoreAllMocks())
for (const mode of ['real-mls', 'double'] as const)
  for (const supplied of [false, true]) {
    describe(`${mode}, ownership ${supplied}`, () => {
      test('one oversized complete call yields bounded proven prefixes', async () => {
        for (const cap of [64, 32]) {
          const f = await completionFixture(mode, supplied, cap)
          try {
            const records = Array.from({ length: 130 }, (_, i) =>
              f.record(String(i).padStart(3, '0')),
            )
            await f.plant(records)
            vi.spyOn(Date, 'now').mockReturnValue(1000)
            const sizes: Array<number> = []
            let previous = 130
            f.capability.observe(
              f.key.groupID,
              () => {},
              async () => {
                const count = (await f.pending()).length
                sizes.push(previous - count)
                previous = count
              },
            )
            await f.completion.complete([
              ...records.map((r) => r.frame.id),
              records[0]?.frame.id as string,
              'missing',
            ])
            await vi.waitFor(() =>
              expect(sizes).toEqual(cap === 64 ? [64, 64, 2] : [32, 32, 32, 32, 2]),
            )
            expect(await f.pending()).toEqual([])
          } finally {
            await f.fixture.close()
          }
        }
      })
      test('oversized atomic transact refuses without invoking its aggregate callback', async () => {
        for (const cap of [64, 32]) {
          const f = await completionFixture(mode, supplied, cap)
          try {
            const records = Array.from({ length: cap === 64 ? 130 : 33 }, (_, i) =>
              f.record(String(i).padStart(3, '0')),
            )
            await f.plant(records)
            vi.spyOn(Date, 'now').mockReturnValue(1000)
            const handle = vi.fn(async () => {})
            const before = await f.fixture.inspectRows()
            await expect(
              f.completion.transact(
                records.map((r) => r.frame.id),
                handle,
              ),
            ).rejects.toBeInstanceOf(RangeError)
            expect(handle).not.toHaveBeenCalled()
            expect(await f.fixture.inspectRows()).toEqual(before)
            await f.completion.transact(
              records
                .slice(0, cap)
                .reverse()
                .map((r) => r.frame.id),
              async (_tx, saved) => {
                expect(saved).toEqual(records.slice(0, cap))
              },
            )
            expect((await f.pending()).length).toBe(records.length - cap)
          } finally {
            await f.fixture.close()
          }
        }
      })
      test('transactional completion commits effect pending and cursor atomically', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const records = [f.record('A', '10'), f.record('B', '2'), f.record('poison', '20')]
          await f.plant(records.slice(0, 2))
          await f.plant(records.slice(2), true)
          bind(f.completion, orderedCoverage(records, ['pending', 'pending', 'dead']))
          const before = await f.fixture.inspectRows()
          for (const point of ['after-first-write', 'before-commit'] as const) {
            f.fixture.armNextWorkFault(point)
            await expect(
              f.completion.transact(['A', 'B'], async (tx, saved) => {
                expect(saved).toEqual(records.slice(0, 2))
                await writeSideRow(tx, 'effect', new Uint8Array([9]))
              }),
            ).rejects.toThrow()
            expect(await f.fixture.inspectRows()).toEqual(before)
          }
          let committedRows: ReturnType<typeof f.fixture.inspectRawBytes> | undefined
          await f.completion.transact(['B', 'A'], async (tx) => {
            tx.onCommit(() => {
              committedRows = f.fixture.inspectRawBytes()
            })
            await writeSideRow(tx, 'effect', new Uint8Array([9]))
          })
          expect(committedRows).toBeDefined()
          const proven = await committedRows
          expect(proven?.filter((row) => row.namespace === 'cursor')).toHaveLength(1)
          expect(proven?.filter((row) => ['pending', 'poison'].includes(row.namespace))).toEqual([])
          expect(await f.fixture.inspectSideRow('effect')).toEqual(new Uint8Array([9]))
          expect(await f.pending()).toEqual([])
          expect(await f.cursor()).toBe('20')
          const poison = await f.capability.read(f.key.groupID, (reads) =>
            reads.appFrame(1, 'poison'),
          )
          expect(poison.poison).toBeNull()
        } finally {
          await f.fixture.close()
        }
      })
      test('completion cannot cross a held prefix', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const records = [f.record('held', '10'), f.record('B', '2')]
          await f.plant(records.slice(1))
          bind(f.completion, orderedCoverage(records))
          await f.completion.complete(['B'])
          expect(await f.cursor()).toBeNull()
        } finally {
          await f.fixture.close()
        }
      })
      test('later completion retains live coverage until the earlier prefix closes', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const records = [f.record('A', '10'), f.record('B', '2'), f.record('held', '20')]
          await f.plant(records.slice(0, 2))
          const coverage = orderedCoverage(records)
          bind(f.completion, coverage)
          await f.completion.transact(['B'], async (tx) =>
            writeSideRow(tx, 'B', new Uint8Array([2])),
          )
          expect((await f.pending()).map((r) => r.frame.id)).toEqual(['A'])
          expect(await f.cursor()).toBeNull()
          await f.completion.complete(['A'])
          expect(await f.cursor()).toBe('2')
          expect(coverage.remaining().map((r) => r.frame.id)).toEqual(['held'])
          const reopened = await f.fixture.reopen()
          expect(await reopened.device.groups.ports(f.key).cursor.load('chat')).toBe('2')
          expect(
            await f.fixture.entry().read(f.key.groupID, (reads) => reads.pendingFrames(1)),
          ).toEqual([])
          expect(await f.fixture.inspectSideRow('B')).toEqual(new Uint8Array([2]))
        } finally {
          await f.fixture.close()
        }
      })
      test('coverage binding advances without saved IDs and preserves unknown-ID no-op', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const coverage = orderedCoverage(
            [f.record('a', '10'), f.record('b', '2')],
            ['dead', 'dead'],
          )
          const binding = bind(f.completion, coverage)
          await f.completion.complete(['missing'])
          expect(await f.cursor()).toBeNull()
          f.fixture.armNextWorkFault('before-commit')
          await expect(binding.advance()).rejects.toThrow()
          expect(await f.cursor()).toBeNull()
          await binding.advance()
          expect(await f.cursor()).toBe('2')
          expect(bindAppCompletionCoverage({ ...f.completion }, coverage.source)).toBeUndefined()
          binding.unbind()
          expect(() => binding.advance()).toThrow()
        } finally {
          await f.fixture.close()
        }
      })
      test('transactional failures cannot couple independent protocol lanes', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          await f.plant([
            f.record('A'),
            { ...f.record('B'), frame: { ...f.record('B').frame, protocol: 'other' } },
          ])
          const gate = Promise.withResolvers<void>()
          const entered = Promise.withResolvers<void>()
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const open = scheduler.schedule({
            source: 'open',
            kind: 'open',
            async run() {
              entered.resolve()
              await gate.promise
            },
          })
          await entered.promise
          let aCalls = 0
          let bCalls = 0
          const a = async (tx: MemoryTransaction) => {
            aCalls++
            await writeSideRow(tx, 'A', new Uint8Array([1]))
            throw new Error('A fails')
          }
          const failed = f.completion.transact(['A'], a)
          const refusal = expect(failed).rejects.toThrow('A fails')
          const b = f.completion.transact(['B'], async (tx) => {
            bCalls++
            await writeSideRow(tx, 'B', new Uint8Array([2]))
          })
          const bResult = b.then(
            () => null,
            (error: unknown) => error,
          )
          gate.resolve()
          await open
          await refusal
          const bError = await bResult
          expect(await f.fixture.inspectSideRow('B')).toEqual(new Uint8Array([2]))
          expect(bError).toBeNull()
          for (let i = 0; i < 2; i++)
            await expect(f.completion.transact(['A'], a)).rejects.toThrow('A fails')
          expect(aCalls).toBe(3)
          expect(bCalls).toBe(1)
          expect(await f.fixture.inspectSideRow('A')).toBeNull()
          expect((await f.pending()).map((r) => r.frame.id)).toEqual(['A'])
          expect(await f.cursor()).toBeNull()
        } finally {
          await f.fixture.close()
        }
      })
      test('handler failure isolates its lane', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const payload = new TextEncoder().encode(
            JSON.stringify({ payload: { typ: 'event', prc: 'posted', data: {} } }),
          )
          const records = [
            f.record('A'),
            f.record('later-A'),
            { ...f.record('B'), frame: { ...f.record('B').frame, protocol: 'other' } },
          ].map((record) => ({ ...record, payload }))
          await f.plant(records)
          const context = new AsyncLocalStorage<object>()
          const seen: Array<string> = []
          let fail = true
          const opened = createOpenedAppHandler({
            localDID: 'receiver',
            protocols: {
              chat: { posted: { type: 'event', retain: 'log' } },
              other: { posted: { type: 'event', retain: 'log' } },
            },
            completion: f.completion,
            openedDeliveryContext: {
              run: (token, fn) => context.run(token, fn),
              get: () => context.getStore(),
            },
            handlers: {
              chat: {
                posted: combineDurableHandlers<unknown, MemoryTransaction>([
                  {
                    mode: 'transactional',
                    async handle({ tx, frame }) {
                      seen.push(frame.id)
                      await writeSideRow(tx, frame.id, new Uint8Array([1]))
                    },
                  },
                  {
                    mode: 'transactional',
                    async handle() {
                      if (fail) throw new Error('lane A')
                    },
                  },
                ]),
              },
              other: {
                posted: {
                  mode: 'transactional',
                  async handle({ tx, frame }) {
                    await writeSideRow(tx, frame.id, new Uint8Array([2]))
                  },
                },
              },
            },
          })
          const [first, later, other] = records
          if (first === undefined || later === undefined || other === undefined)
            throw new Error('Missing record')
          // Each protocol drain stops at its first failed record.
          const results = await Promise.allSettled([
            (async () => {
              await opened.deliver(first)
              await opened.deliver(later)
            })(),
            opened.deliver(other),
          ])
          expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
          expect(seen).toEqual(['A'])
          expect((await f.pending()).map((r) => r.frame.id)).toEqual(['A', 'later-A'])
          expect(await f.fixture.inspectSideRow('A')).toBeNull()
          expect(await f.fixture.inspectSideRow('B')).toEqual(new Uint8Array([2]))
          fail = false
          await opened.deliver(first)
          expect(seen).toEqual(['A', 'A'])
          expect(await f.fixture.inspectSideRow('A')).toEqual(new Uint8Array([1]))
        } finally {
          await f.fixture.close()
        }
      })
      test('production transactional handler preserves effects-phase restrictions', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const saved = {
            ...f.record('production'),
            payload: new TextEncoder().encode(
              JSON.stringify({ payload: { typ: 'event', prc: 'posted', data: { text: 'saved' } } }),
            ),
          }
          await f.plant([saved])
          const before = await f.fixture.inspectRawBytes()
          const context = new AsyncLocalStorage<object>()
          const complete = vi.spyOn(f.completion, 'complete')
          const handle = vi.fn(async ({ tx, data }) => {
            await Promise.resolve()
            expect(data).toEqual({ text: 'saved' })
            for (const view of [tx, { ...tx }, { ...tx, rows: { ...tx.rows } }]) {
              const stores = f.fixture.constructGroupStores(view, f.key)
              const life = await stores.lifetime.load()
              const trust = await stores.trust.load()
              const state = await stores.incarnation(1).state.load()
              if (life === null || trust === null || state === null)
                throw new Error('Missing domain')
              for (const write of [
                () => stores.lifetime.save(life),
                () => stores.trust.save(trust),
                () => stores.incarnation(1).state.save(state),
              ])
                await expect(write()).rejects.toMatchObject({ name: 'PersistencePhaseError' })
            }
            await writeSideRow(tx, 'production-effect', new Uint8Array([7]))
          })
          const opened = createOpenedAppHandler({
            localDID: 'receiver',
            protocols: { chat: { posted: { type: 'event', retain: 'log' } } },
            completion: f.completion,
            openedDeliveryContext: {
              run: (token, fn) => context.run(token, fn),
              get: () => context.getStore(),
            },
            handlers: { chat: { posted: { mode: 'transactional', handle } } },
          })
          await opened.deliver(saved)
          await opened.deliver(saved)
          expect(handle).toHaveBeenCalledOnce()
          expect(complete).not.toHaveBeenCalled()
          expect(await f.pending()).toEqual([])
          expect(await f.fixture.inspectSideRow('production-effect')).toEqual(new Uint8Array([7]))
          const domain = (rows: typeof before) =>
            rows.filter((row) => ['state', 'trust', 'control', 'anchor'].includes(row.namespace))
          expect(domain(await f.fixture.inspectRawBytes())).toEqual(domain(before))
        } finally {
          await f.fixture.close()
        }
      })
      test('transactional completion enters effects with domain writes refused', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          await f.plant([f.record('A')])
          const before = await f.fixture.inspectRawBytes()
          const phases: Array<string> = []
          for (const phase of ['work', 'finalise', 'effects', 'account'] as const)
            f.fixture.onPhase(phase, () => {
              phases.push(phase)
            })
          let retained: ReturnType<typeof f.fixture.constructGroupStores> | undefined
          await f.completion.transact(['A'], async (tx) => {
            expect(phases).toEqual(['work', 'finalise', 'effects'])
            for (const view of [tx, { ...tx }, { ...tx, rows: { ...tx.rows } }]) {
              const stores = f.fixture.constructGroupStores(view, f.key)
              retained = stores
              const life = await stores.lifetime.load()
              const trust = await stores.trust.load()
              const state = await stores.incarnation(1).state.load()
              if (life === null || trust === null || state === null)
                throw new Error('Missing domain')
              for (const write of [
                () => stores.lifetime.save(life),
                () => stores.trust.save(trust),
                () => stores.incarnation(1).state.save(state),
              ])
                await expect(write()).rejects.toMatchObject({ name: 'PersistencePhaseError' })
            }
            await writeSideRow(tx, 'lawful', new Uint8Array([1]))
          })
          expect(phases).toEqual(['work', 'finalise', 'effects', 'account'])
          const domain = (rows: typeof before) =>
            rows.filter((row) => ['state', 'trust', 'control', 'anchor'].includes(row.namespace))
          expect(domain(await f.fixture.inspectRawBytes())).toEqual(domain(before))
          expect(await f.fixture.inspectSideRow('lawful')).toEqual(new Uint8Array([1]))
          if (retained === undefined) throw new Error('Missing retained stores')
          await expect(retained.lifetime.load()).rejects.toMatchObject({
            name: 'PersistencePhaseError',
          })
        } finally {
          await f.fixture.close()
        }
      })
      test('unknown completion exposes no effect before proof', async () => {
        for (const outcome of ['commit', 'rollback'] as const) {
          const f = await completionFixture(mode, supplied)
          try {
            await f.plant([f.record('A', '10')])
            bind(f.completion, orderedCoverage([f.record('A', '10')]))
            const fault = f.fixture.armNextWorkFault('pending')
            let hooks = 0
            let settled = false
            let calls = 0
            const pending = f.completion.transact(['A'], async (tx) => {
              calls++
              tx.onCommit(() => hooks++)
              await writeSideRow(tx, 'effect', new Uint8Array([1]))
            })
            const result = pending.then(
              () => {
                settled = true
                return null
              },
              (error: unknown) => {
                settled = true
                return error
              },
            )
            await fault.rejected
            expect(settled).toBe(false)
            expect(hooks).toBe(0)
            expect(await f.fixture.inspectSideRow('effect')).toBeNull()
            const rows = await f.fixture.inspectRawBytes()
            expect(rows.filter((row) => row.namespace === 'pending')).toHaveLength(1)
            expect(rows.filter((row) => row.namespace === 'cursor')).toHaveLength(0)
            await fault.finish(outcome)
            const error = await result
            if (outcome === 'commit') {
              expect(error).toBeNull()
              expect(hooks).toBe(1)
              expect(await f.cursor()).toBe('10')
              const mutationID = await fault.mutationID
              await f.groups.resolve(f.key.groupID, mutationID)
              await f.groups.resolve(f.key.groupID, mutationID)
              expect(hooks).toBe(1)
              await f.completion.transact(['A'], async () => {
                calls++
              })
              expect(calls).toBe(1)
            } else {
              expect(error).toBeInstanceOf(Error)
              expect(hooks).toBe(0)
              expect(await f.cursor()).toBeNull()
              expect((await f.pending()).length).toBe(1)
            }
          } finally {
            await f.fixture.close()
          }
        }
      })
      test('unknown and duplicate IDs never invoke a completed handler', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const original = f.record('A')
          await f.plant([original])
          let calls = 0
          const ids = ['missing', 'A', 'A']
          const saved = f.completion.transact(ids, async (tx, rows) => {
            calls++
            expect(rows).toEqual([original])
            rows[0]?.payload.fill(99)
            await writeSideRow(tx, 'once', new Uint8Array([1]))
          })
          ids.fill('replacement')
          await saved
          await f.completion.transact([], async () => {
            calls++
          })
          await f.completion.transact(['missing', 'A', 'A'], async () => {
            calls++
          })
          const reopened = await f.fixture.reopen()
          const completion = createHandlerCompletion({
            persistence: reopened.device.groups,
            key: f.key,
          })
          await completion.transact(['A'], async () => {
            calls++
          })
          expect(calls).toBe(1)
          expect(await f.fixture.inspectSideRow('once')).toEqual(new Uint8Array([1]))
        } finally {
          await f.fixture.close()
        }
      })
      test('authenticated malformed poison prunes atomically while unauthenticated input creates no row', async () => {
        const f = await authenticatedCompletionFixture(mode, supplied)
        try {
          const malformed = await f.seal('10')
          const wrongAAD = await f.seal('2')
          const junk = await f.seal('20')
          wrongAAD.expectedAAD = encodeAppAAD({ topicID: 'wrong', intent: 'log' })
          junk.ciphertext = new Uint8Array([1, 2, 3])
          expect(await f.access.openBatch([malformed, wrongAAD, junk])).toMatchObject([
            { kind: 'refused', reason: 'malformed-plaintext', keyConsumed: true },
            { kind: 'refused', reason: 'wrong-aad', keyConsumed: false },
            { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
          ])
          const capability = entryCapability(f.fixture.device.groups)
          if (capability === null) throw new Error('Missing capability')
          for (const input of [wrongAAD, junk])
            expect(
              await capability.read(f.key.groupID, (reads) => reads.appFrame(1, input.frame.id)),
            ).toEqual({ pending: null, poison: null })
          bind(f.completion, orderedCoverage([{ frame: malformed.frame }], ['dead']))
          const before = await f.fixture.inspectRows()
          f.fixture.armNextWorkFault('before-commit')
          await expect(f.completion.complete([malformed.frame.id])).rejects.toThrow()
          expect(await f.fixture.inspectRows()).toEqual(before)
          const handle = vi.fn(async () => {})
          await f.completion.transact([malformed.frame.id], handle)
          expect(handle).not.toHaveBeenCalled()
          expect(
            await capability.read(f.key.groupID, (reads) => reads.appFrame(1, malformed.frame.id)),
          ).toEqual({ pending: null, poison: null })
          expect(await f.fixture.device.groups.ports(f.key).cursor.load('chat')).toBe('10')
        } finally {
          await f.fixture.close()
        }
      })
      test('poison pruning and cursor roll back together', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const records = [f.record('poison', '10')]
          await f.plant(records, true)
          bind(f.completion, orderedCoverage(records, ['dead']))
          const before = await f.fixture.inspectRows()
          f.fixture.armNextWorkFault('before-commit')
          await expect(f.completion.complete(['poison'])).rejects.toThrow()
          expect(await f.fixture.inspectRows()).toEqual(before)
          let calls = 0
          await f.completion.transact(['poison'], async () => {
            calls++
          })
          expect(calls).toBe(0)
          expect(await f.cursor()).toBe('10')
          expect(
            (await f.fixture.inspectRawBytes()).filter((r) => r.namespace === 'poison'),
          ).toEqual([])
        } finally {
          await f.fixture.close()
        }
      })
      test('stale coverage cannot cross a moved cursor or incarnation', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          await f.plant([f.record('A', '10')])
          const coverage = orderedCoverage([f.record('A', '10')])
          bind(f.completion, coverage)
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const gate = Promise.withResolvers<void>()
          const entered = Promise.withResolvers<void>()
          const open = scheduler.schedule({
            source: 'open',
            kind: 'open',
            async run() {
              entered.resolve()
              await gate.promise
            },
          })
          await entered.promise
          let calls = 0
          const complete = f.completion.transact(['A'], async () => {
            calls++
            expect(
              coverage.source.current(coverage.source.capture([])[0] as AppCompletionCoverage),
            ).toBe(true)
          })
          coverage.reset()
          gate.resolve()
          await open
          await complete
          expect(calls).toBe(1)
          expect(await f.cursor()).toBe('10')
          const wrong = orderedCoverage([f.record('wrong', '20', 'wrong-origin')], ['dead'])
          const capture = wrong.source.capture
          wrong.source.capture = (ids) =>
            capture(ids).map((proof) => ({ ...proof, key: { ...f.key, incarnation: 2 } }))
          await bind(f.completion, wrong).advance()
          expect(await f.cursor('wrong-origin')).toBeNull()
          expect(await f.cursor()).toBe('10')
        } finally {
          await f.fixture.close()
        }
      })
      test('coverage withdrawn during an awaited cursor read preserves the cursor', async () => {
        for (const phase of ['prepare', 'work', 'effects'] as const) {
          const f = await completionFixture(mode, supplied)
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          try {
            const record = f.record('A', '100')
            await f.plant([record])
            await f.groups.ports(f.key).cursor.save('chat', '000')
            const coverage = orderedCoverage([record])
            const capture = coverage.source.capture
            coverage.source.capture = (ids) =>
              capture(ids).map((proof) => ({ ...proof, previous: '000' }))
            coverage.source.current = (proof) => proof.previous === '000'
            const binding = bind(f.completion, coverage)
            let suspended = false
            const suspend = async () => {
              if (suspended) return
              suspended = true
              entered.resolve()
              await release.promise
            }
            const wrap = (
              stores: GroupStores<MemoryTransaction>,
            ): GroupStores<MemoryTransaction> => ({
              ...stores,
              incarnation(incarnation) {
                const rows = stores.incarnation(incarnation)
                return {
                  ...rows,
                  cursor: {
                    ...rows.cursor,
                    async load(topicID) {
                      const value = await rows.cursor.load(topicID)
                      await suspend()
                      return value
                    },
                  },
                }
              },
            })
            const run = f.capability.run
            f.capability.run = (request, prepare, work, effects) =>
              run(
                request,
                (reads, closing) =>
                  prepare(
                    phase === 'prepare'
                      ? copyEntryReads(reads, {
                          async appCursor(incarnation, topicID) {
                            const value = await reads.appCursor(incarnation, topicID)
                            await suspend()
                            return value
                          },
                        })
                      : reads,
                    closing,
                  ),
                (stores, prepared) => work(phase === 'work' ? wrap(stores) : stores, prepared),
                (stores, prepared, result) =>
                  effects?.(phase === 'effects' ? wrap(stores) : stores, prepared, result) ??
                  Promise.resolve(),
              )
            const before = await f.fixture.inspectRows()
            const result = f.completion.complete(['A']).then(
              () => null,
              (error: unknown) => error,
            )
            await entered.promise
            binding.unbind()
            release.resolve()
            const error = await result
            expect(await f.cursor()).toBe('000')
            if (phase === 'effects') {
              expect(error).toMatchObject({ name: 'GroupStateConflictError' })
              expect(await f.fixture.inspectRows()).toEqual(before)
            } else {
              expect(error).toBeNull()
              expect(await f.pending()).toEqual([])
            }
          } finally {
            release.resolve()
            await f.fixture.close()
          }
        }
      })
      test('coverage withdrawn during awaited completion writes rolls back all progress', async () => {
        for (const boundary of ['complete', 'save'] as const) {
          const f = await completionFixture(mode, supplied)
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          try {
            const record = f.record('A', '100')
            await f.plant([record])
            const binding = bind(f.completion, orderedCoverage([record]))
            const run = f.capability.run
            f.capability.run = (request, prepare, work, effects) =>
              run(request, prepare, work, (stores, prepared, result) => {
                const wrapped: GroupStores<MemoryTransaction> = {
                  ...stores,
                  incarnation(incarnation) {
                    const rows = stores.incarnation(incarnation)
                    return {
                      ...rows,
                      pending: {
                        ...rows.pending,
                        async complete(ids) {
                          await rows.pending.complete(ids)
                          if (boundary === 'complete') {
                            entered.resolve()
                            await release.promise
                          }
                        },
                      },
                      cursor: {
                        ...rows.cursor,
                        async save(topicID, position) {
                          await rows.cursor.save(topicID, position)
                          if (boundary === 'save') {
                            entered.resolve()
                            await release.promise
                          }
                        },
                      },
                    }
                  },
                }
                return effects?.(wrapped, prepared, result) ?? Promise.resolve()
              })
            const before = await f.fixture.inspectRows()
            const result = f.completion
              .transact(['A'], async (tx) => {
                await writeSideRow(tx, 'withdrawn-effect', new Uint8Array([9]))
              })
              .then(
                () => null,
                (error: unknown) => error,
              )
            await entered.promise
            binding.unbind()
            release.resolve()
            const error = await result
            expect(await f.cursor()).toBeNull()
            expect(await f.fixture.inspectRows()).toEqual(before)
            expect(await f.fixture.inspectSideRow('withdrawn-effect')).toBeNull()
            expect(error).toMatchObject({ name: 'GroupStateConflictError' })
          } finally {
            release.resolve()
            await f.fixture.close()
          }
        }
      })
      test('ordinary failed batches release before caller retry', async () => {
        for (const kind of ['completion', 'transact', 'enqueue'] as const) {
          const f = await completionFixture(mode, supplied)
          const started = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const outcome = Promise.withResolvers<void>()
          try {
            await f.plant([f.record('ordinary')])
            const before = await f.fixture.inspectRows()
            const log: Array<string> = []
            const scheduler = groupBatchFor(f.binding, f.key.groupID)
            f.fixture.onPhase('work', async () => {
              started.resolve()
              await release.promise
            })
            f.fixture.onPhase('outcome', () => {
              outcome.resolve()
            })
            f.fixture.armNextWorkFault('before-commit')
            const invoke = () =>
              kind === 'completion'
                ? f.completion.complete(['ordinary'])
                : kind === 'transact'
                  ? f.completion.transact(['ordinary'], async (tx) =>
                      writeSideRow(tx, 'ordinary', new Uint8Array([1])),
                    )
                  : f.groups.ports(f.key).outbox.put({
                      seq: 99,
                      protocol: 'chat',
                      prc: 'posted',
                      data: new TextEncoder().encode(
                        '{"v":2,"payload":{"typ":"event","prc":"posted","data":{}}}',
                      ),
                      status: 'accepted',
                      lastAttempt: null,
                    })
            let failed: unknown
            const first = invoke().catch((error: unknown) => {
              failed = error
            })
            await started.promise
            const b = scheduler.schedule({
              source: 'B',
              kind: 'completion',
              run: async () => {
                log.push('B')
              },
            })
            release.resolve()
            await outcome.promise
            for (let i = 0; i < 1000; i++) await Promise.resolve()
            expect(log).toEqual(['B'])
            await first
            expect(failed).toBeInstanceOf(Error)
            expect(await f.fixture.inspectRows()).toEqual(before)
            expect(log).toEqual(['B'])
            log.push('retry-advertised')
            await Promise.all([b, invoke()])
            expect(log).toEqual(['B', 'retry-advertised'])
            if (kind === 'transact')
              expect(await f.fixture.inspectSideRow('ordinary')).toEqual(new Uint8Array([1]))
          } finally {
            release.resolve()
            await f.fixture.close()
          }
        }
      })
      test('collected completion waits for its bounded coverage suffix', async () => {
        const f = await completionFixture(mode, supplied, 1)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        try {
          const records = [f.record('A'), f.record('B')]
          await f.plant(records.slice(0, 1))
          bind(f.completion, orderedCoverage(records, ['pending', 'dead']))
          let finished = false
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const schedule = scheduler.schedule.bind(scheduler)
          let turns = 0
          vi.spyOn(scheduler, 'schedule').mockImplementation((work) =>
            schedule({
              ...work,
              run: async (budget) => {
                if (++turns === 2) {
                  entered.resolve()
                  await release.promise
                }
                return work.run(budget)
              },
            }),
          )
          const completing = f.completion.complete(['A']).then(() => {
            finished = true
          })
          await entered.promise
          for (let i = 0; i < 50; i++) await Promise.resolve()
          expect(finished).toBe(false)
          release.resolve()
          await completing
          expect(await f.cursor()).toBe('B')
        } finally {
          release.resolve()
          await f.fixture.close()
        }
      })
      test('coalesced completions advance coverage across batch splits', async () => {
        for (const ids of [['A'], ['A', 'missing']]) {
          const f = await completionFixture(mode, supplied, 1)
          const release = Promise.withResolvers<void>()
          try {
            const records = [f.record('A'), f.record('B')]
            await f.plant(records.slice(0, 1))
            const coverage = orderedCoverage(records, ['pending', 'dead'])
            bind(f.completion, coverage)
            const committed = vi.spyOn(coverage.source, 'committed')
            const active = groupBatchFor(f.binding, f.key.groupID).schedule({
              source: 'held',
              kind: 'open',
              run: () => release.promise,
            })
            const remainingAtResolution: Array<Array<string>> = []
            const calls = [f.completion.complete(ids), f.completion.complete(['missing'])]
            const completing = Promise.all(
              calls.map((call) =>
                call.then(() => {
                  remainingAtResolution.push(coverage.remaining().map((row) => row.frame.id))
                }),
              ),
            )
            release.resolve()
            await active
            await completing
            expect(await f.cursor()).toBe('B')
            expect(remainingAtResolution).toEqual([[], []])
            expect(await f.pending()).toEqual([])
            expect(committed.mock.calls.flatMap(([ids]) => ids)).toEqual(['A'])
            expect(
              committed.mock.calls.flatMap(([, proofs]) => proofs.map((proof) => proof.through)),
            ).toEqual(['A', 'B'])
            const beforeMissing = await f.fixture.inspectRows()
            await f.completion.complete(['missing'])
            expect(await f.fixture.inspectRows()).toEqual(beforeMissing)
            expect(committed).toHaveBeenCalledTimes(2)
          } finally {
            release.resolve()
            await f.fixture.close()
          }
        }
      })
      test('collected completion rollback preserves every row and eligible cursor', async () => {
        const f = await completionFixture(mode, supplied, 2)
        const release = Promise.withResolvers<void>()
        try {
          const records = [f.record('A'), f.record('B')]
          await f.plant(records)
          bind(f.completion, orderedCoverage(records))
          const before = await f.fixture.inspectRows()
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const active = scheduler.schedule({
            source: 'held',
            kind: 'open',
            run: () => release.promise,
          })
          f.fixture.armNextWorkFault('before-commit')
          const calls = records.map((record) => f.completion.complete([record.frame.id]))
          const settled = Promise.allSettled(calls)
          release.resolve()
          await active
          expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected'])
          expect(await f.fixture.inspectRows()).toEqual(before)
          expect(await f.cursor()).toBeNull()
          await Promise.all(records.map((record) => f.completion.complete([record.frame.id])))
          expect(await f.pending()).toEqual([])
          expect(await f.cursor()).toBe('B')
        } finally {
          release.resolve()
          await f.fixture.close()
        }
      })
      test('compatible completions and settlements share bounded transactions', async () => {
        const f = await completionFixture(mode, supplied, 2)
        const gate = Promise.withResolvers<void>()
        try {
          await f.plant([f.record('A'), f.record('B'), f.record('C')])
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const active = scheduler.schedule({
            source: 'held',
            kind: 'open',
            run: () => gate.promise,
          })
          const run = vi.spyOn(f.capability, 'run')
          const calls = ['A', 'B', 'C'].map((id) => f.completion.complete([id]))
          gate.resolve()
          await active
          await Promise.all(calls)
          expect(run).toHaveBeenCalledTimes(2)
          expect(await f.pending()).toEqual([])
        } finally {
          gate.resolve()
          await f.fixture.close()
        }
      })
      test('transactional root reentry obeys ownership diagnostics', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          await f.plant([f.record('A')])
          const coverageBinding = bind(f.completion, orderedCoverage([f.record('A')]))
          await f.completion.transact(['A'], async (tx) => {
            for (const call of [
              () => f.completion.complete(['A']),
              () => f.completion.transact(['A'], async () => {}),
              () => coverageBinding.advance(),
            ])
              expect(call).toThrowError(
                expect.objectContaining({ name: 'ReentrantOwnershipError' }),
              )
            if (supplied) {
              await Promise.resolve()
              expect(() => f.completion.complete(['A'])).toThrowError(
                expect.objectContaining({ name: 'ReentrantOwnershipError' }),
              )
            }
            await writeSideRow(tx, 'root-guarded', new Uint8Array([1]))
          })
          expect(await f.fixture.inspectSideRow('root-guarded')).toEqual(new Uint8Array([1]))
        } finally {
          await f.fixture.close()
        }
      })
      test('atomic staging work exhaustion refuses the whole set before effects', async () => {
        for (const maxWorkMs of [8, 3]) {
          const f = await completionFixture(mode, supplied, 64, maxWorkMs)
          try {
            await f.plant([f.record('A'), f.record('B')])
            let clock = 1000
            vi.spyOn(Date, 'now').mockImplementation(() => clock)
            let opens = 0
            let staging = false
            f.fixture.onPhase('prepare', () => {
              staging = true
            })
            f.fixture.observeCodec((kind, namespace) => {
              if (staging && kind === 'open' && namespace === 'pending' && ++opens === 1)
                clock += maxWorkMs
            })
            const before = await f.fixture.inspectRows()
            const handle = vi.fn(async () => {})
            await expect(f.completion.transact(['A', 'B'], handle)).rejects.toBeInstanceOf(
              RangeError,
            )
            expect(handle).not.toHaveBeenCalled()
            expect(await f.fixture.inspectRows()).toEqual(before)
          } finally {
            await f.fixture.close()
          }
        }
      })
      test('saved completion staging stops reading at the frame boundary', async () => {
        const f = await completionFixture(mode, supplied, 32)
        try {
          const records = Array.from({ length: 33 }, (_, i) => f.record(String(i).padStart(3, '0')))
          await f.plant(records)
          const stagedReads: Array<Array<string>> = []
          const run = f.capability.run
          f.capability.run = (request, prepare, work, effects) =>
            run(
              request,
              async (reads, closing) => {
                const batch: Array<string> = []
                stagedReads.push(batch)
                return prepare(
                  copyEntryReads(reads, {
                    async appFrame(incarnation, id) {
                      batch.push(id)
                      return reads.appFrame(incarnation, id)
                    },
                  }),
                  closing,
                )
              },
              work,
              effects,
            )
          await f.completion.complete(records.map((r) => r.frame.id))
          expect(stagedReads).toEqual([
            records.slice(0, 32).map((r) => r.frame.id),
            [records[32]?.frame.id],
          ])
          expect(await f.pending()).toEqual([])
        } finally {
          await f.fixture.close()
        }
      })
      test('atomic protocol identification bounds saved reads before staging refusal', async () => {
        const f = await completionFixture(mode, supplied, 32)
        try {
          const records = Array.from({ length: 33 }, (_, i) => f.record(String(i).padStart(3, '0')))
          await f.plant(records)
          const batches: Array<Array<string>> = []
          const read = f.capability.read
          f.capability.read = (groupID, fn) =>
            read(groupID, (reads) => {
              const batch: Array<string> = []
              batches.push(batch)
              return fn(
                copyEntryReads(reads, {
                  async appFrame(incarnation, id) {
                    batch.push(id)
                    return reads.appFrame(incarnation, id)
                  },
                }),
              )
            })
          const before = await f.fixture.inspectRows()
          const handle = vi.fn(async () => {})
          await expect(
            f.completion.transact(
              records.map((r) => r.frame.id),
              handle,
            ),
          ).rejects.toBeInstanceOf(RangeError)
          expect(batches).toEqual([
            records.slice(0, 32).map((r) => r.frame.id),
            [records[32]?.frame.id],
          ])
          expect(handle).not.toHaveBeenCalled()
          expect(await f.fixture.inspectRows()).toEqual(before)
        } finally {
          await f.fixture.close()
        }
      })
      test('callback-free clock exhaustion yields before reading the saved suffix', async () => {
        for (const maxWorkMs of [8, 3]) {
          const f = await completionFixture(mode, supplied, 64, maxWorkMs)
          try {
            const records = [f.record('A'), f.record('B'), f.record('C')]
            await f.plant(records)
            let clock = 1000
            vi.spyOn(Date, 'now').mockImplementation(() => clock)
            const batches: Array<Array<string>> = []
            const order: Array<string> = []
            let ready: Promise<void> | undefined
            const run = f.capability.run
            f.capability.run = (request, prepare, work, effects) =>
              run(
                request,
                async (reads, closing) => {
                  const batch: Array<string> = []
                  batches.push(batch)
                  return prepare(
                    copyEntryReads(reads, {
                      async appFrame(incarnation, id) {
                        batch.push(id)
                        const value = await reads.appFrame(incarnation, id)
                        clock += maxWorkMs
                        if (ready === undefined)
                          ready = groupBatchFor(f.binding, f.key.groupID).schedule({
                            source: 'ready-clock-peer',
                            kind: 'completion',
                            async run() {
                              order.push('peer')
                              await run(
                                { groupID: f.key.groupID, mutationID: crypto.randomUUID() },
                                async (reads) => ({
                                  expected: await reads.lifetime(),
                                  value: null,
                                }),
                                async (stores) =>
                                  writeSideRow(stores.tx, 'clock-peer', new Uint8Array([9])),
                              )
                            },
                          })
                        return value
                      },
                    }),
                    closing,
                  )
                },
                work,
                async (stores, prepared, result) => {
                  order.push('completion')
                  await effects?.(stores, prepared, result)
                },
              )
            await f.completion.complete(records.map((r) => r.frame.id))
            await ready
            expect(batches).toEqual([['A'], ['B'], ['C']])
            expect(order).toEqual(['completion', 'peer', 'completion', 'completion'])
            expect(await f.fixture.inspectSideRow('clock-peer')).toEqual(new Uint8Array([9]))
            expect(await f.pending()).toEqual([])
          } finally {
            await f.fixture.close()
          }
        }
      })
      test('poison and dead-only prefixes share the bounded completion budget', async () => {
        for (const cap of [64, 32])
          for (const kind of ['poison', 'dead', 'mixed'] as const) {
            const f = await completionFixture(mode, supplied, cap)
            try {
              const records = Array.from({ length: 130 }, (_, i) =>
                f.record(String(i).padStart(3, '0')),
              )
              if (kind === 'poison') await f.plant(records, true)
              if (kind === 'mixed') {
                await f.plant(records.filter((_, i) => i % 2 === 0))
                await f.plant(
                  records.filter((_, i) => i % 2 === 1),
                  true,
                )
              }
              const coverage = orderedCoverage(
                records,
                records.map((_, i) => (kind === 'mixed' && i % 2 === 0 ? 'pending' : 'dead')),
              )
              const binding = bind(f.completion, coverage)
              vi.spyOn(Date, 'now').mockReturnValue(1000)
              const sizes: Array<number> = []
              let previous = 0
              f.capability.observe(
                f.key.groupID,
                () => {},
                async () => {
                  const cursor = await f.cursor()
                  const end = cursor === null ? 0 : Number(cursor) + 1
                  sizes.push(end - previous)
                  previous = end
                },
              )
              if (kind === 'dead') await binding.advance()
              else await f.completion.complete([...records.map((r) => r.frame.id), 'missing'])
              await vi.waitFor(() =>
                expect(sizes).toEqual(cap === 64 ? [64, 64, 2] : [32, 32, 32, 32, 2]),
              )
              expect(await f.cursor()).toBe('129')
              expect(coverage.remaining()).toEqual([])
              expect(
                (await f.fixture.inspectRawBytes()).filter((r) =>
                  ['pending', 'poison'].includes(r.namespace),
                ),
              ).toEqual([])
            } finally {
              await f.fixture.close()
            }
          }
      })
      test('one failed prefix preserves prior proof and fairly releases between prefixes', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const records = Array.from({ length: 130 }, (_, i) =>
            f.record(String(i).padStart(3, '0')),
          )
          await f.plant(records)
          vi.spyOn(Date, 'now').mockReturnValue(1000)
          const order: Array<string> = []
          const hold = Promise.withResolvers<void>()
          const entered = Promise.withResolvers<void>()
          f.fixture.onPhase('effects', async () => {
            entered.resolve()
            await hold.promise
          })
          const complete = f.completion.complete(records.map((r) => r.frame.id))
          const failure = expect(complete).rejects.toThrow('Injected before-commit failure')
          await entered.promise
          const b = groupBatchFor(f.binding, f.key.groupID).schedule({
            source: 'ready-B',
            kind: 'completion',
            async run() {
              order.push('B')
              expect((await f.pending()).length).toBe(66)
              await f.capability.run(
                { groupID: f.key.groupID, mutationID: crypto.randomUUID() },
                async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
                async (stores) => writeSideRow(stores.tx, 'ready-B', new Uint8Array([2])),
              )
              f.fixture.armNextWorkFault('before-commit')
            },
          })
          hold.resolve()
          await b
          await failure
          expect(order).toEqual(['B'])
          expect(await f.fixture.inspectSideRow('ready-B')).toEqual(new Uint8Array([2]))
          expect((await f.pending()).length).toBe(66)
          await f.completion.complete(records.map((r) => r.frame.id))
          expect(await f.pending()).toEqual([])
        } finally {
          await f.fixture.close()
        }
      })
      test('completion rechecks saved pending records before invoking effects', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          await f.plant([f.record('A')])
          const run = f.capability.run
          let first = true
          f.capability.run = (request, prepare, work, effects) =>
            run(
              request,
              prepare,
              async (stores, prepared) => {
                if (first) {
                  first = false
                  await stores.incarnation(1).pending.complete(['A'])
                }
                return work(stores, prepared)
              },
              effects,
            )
          const handle = vi.fn(async () => {})
          // A provider changing the saved set between preparation and work cannot publish an effect.
          await expect(f.completion.transact(['A'], handle)).rejects.toThrow()
          expect(handle).not.toHaveBeenCalled()
          expect((await f.pending()).length).toBe(1)
        } finally {
          await f.fixture.close()
        }
      })
      test('exact retired-key completion cannot follow the active incarnation', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          await f.plant([f.record('A', '10')])
          bind(f.completion, orderedCoverage([f.record('A', '10')]))
          const successor = await makeStorageSeed({
            id: f.key.groupID,
            incarnation: 2,
            epoch: 1,
            mode,
            identity: f.identity,
          })
          const mutationID = crypto.randomUUID()
          await f.capability.run(
            { groupID: f.key.groupID, mutationID },
            async (reads, closing) => {
              const lifetime = await reads.lifetime()
              if (lifetime === null) throw new Error('Missing source')
              const next = {
                ...lifetime,
                activeIncarnation: 2,
                latestIncarnation: 2,
                revision: lifetime.revision + 1,
                mutationID,
              }
              return closing.freeze({
                source: f.key,
                reason: 'switch',
                prepared: { expected: lifetime, value: undefined },
                domain: await retirementDomain(reads, next, [successor.state]),
              })
            },
            async (stores) => {
              const life = await stores.lifetime.load()
              if (life === null) throw new Error('Missing lifetime')
              const trust = await stores.trust.load()
              if (trust === null) throw new Error('Missing trust')
              await stores.lifetime.save({
                ...life,
                activeIncarnation: 2,
                latestIncarnation: 2,
                revision: life.revision + 1,
                mutationID,
              })
              await stores.incarnation(2).state.save(successor.state)
              await stores.trust.save({
                ...successor.trust,
                genesisAnchor: trust.genesisAnchor,
                spentEpochAuthenticators: trust.spentEpochAuthenticators,
              })
              await writeInstallationCheckpoint(stores, {
                key: successor.key,
                confirmedTranscriptHash: successor.confirmedTranscriptHash,
                mutationID,
                stateVersion: successor.state.version,
              })
            },
          )
          await f.capability.run(
            { groupID: f.key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
            async (stores) => {
              await stores.incarnation(2).cursor.save('chat', '1')
              const next = f.record('A', '2')
              next.frame.incarnation = 2
              next.idempotencyKey = appFrameIdempotencyKey(next.frame)
              await stores.incarnation(2).pending.put([next])
            },
          )
          await expect(f.groups.ports(f.key).cursor.save('chat', '2')).rejects.toThrow(
            'Inactive group incarnation',
          )
          const nextBefore = (await f.fixture.inspectRawBytes()).filter(
            (row) => row.incarnation === 2,
          )
          await f.completion.complete(['A'])
          expect(await f.cursor()).toBe('10')
          expect(await f.pending()).toEqual([])
          expect((await f.groups.load(f.key.groupID))?.activeIncarnation).toBe(2)
          expect(
            (await f.fixture.inspectRawBytes()).filter((row) => row.incarnation === 2),
          ).toEqual(nextBefore)
          expect(await f.groups.ports(successor.key).cursor.load('chat')).toBe('1')
          expect(
            (await f.capability.read(f.key.groupID, (reads) => reads.pendingFrames(2))).map(
              (row) => row.frame.id,
            ),
          ).toEqual(['A'])
        } finally {
          await f.fixture.close()
        }
      })
      test('transactional sources remain stable per protocol and isolate explicit aggregates', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const a = f.record('A')
          const b = f.record('B')
          const c = f.record('C')
          c.frame.protocol = 'other'
          await f.plant([a, b, c])
          const scheduler = groupBatchFor(f.binding, f.key.groupID)
          const schedule = scheduler.schedule
          let activeSource = ''
          scheduler.schedule = (work) =>
            schedule({
              ...work,
              run(budget) {
                activeSource = work.source
                return work.run(budget)
              },
            })
          const sources: Array<string> = []
          await f.completion.transact(['A'], async () => {
            sources.push(activeSource)
          })
          await f.completion.transact(['B'], async () => {
            sources.push(activeSource)
          })
          expect(sources[0]).toBe(sources[1])
          expect(sources[0]).toContain(f.key.groupID)
          expect(sources[0]).toContain('chat')
          await f.plant([a, b])
          await f.completion.transact(['A', 'C'], async () => {
            sources.push(activeSource)
          })
          expect(sources[2]).not.toBe(sources[0])
        } finally {
          await f.fixture.close()
        }
      })
      test('queued unbound or moved-cursor coverage cannot write', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const records = [f.record('dead', '10')]
          const coverage = orderedCoverage(records, ['dead'])
          const bound = bind(f.completion, coverage)
          const gate = Promise.withResolvers<void>()
          const entered = Promise.withResolvers<void>()
          const open = groupBatchFor(f.binding, f.key.groupID).schedule({
            source: 'open',
            kind: 'open',
            async run() {
              entered.resolve()
              await gate.promise
            },
          })
          await entered.promise
          const advance = bound.advance()
          bound.unbind()
          gate.resolve()
          await open
          await advance
          expect(await f.cursor()).toBeNull()
          const next = bind(f.completion, orderedCoverage(records, ['dead']))
          await f.groups.ports(f.key).cursor.save('chat', '2')
          const before = await f.fixture.inspectRows()
          await expect(next.advance()).rejects.toThrow('cursor moved')
          expect(await f.fixture.inspectRows()).toEqual(before)
          await f.completion.complete(['missing'])
          expect(await f.cursor()).toBe('2')
        } finally {
          await f.fixture.close()
        }
      })
      test('completion respects independent topic prefixes', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          const held = f.record('held', '10')
          const b = f.record('B', '2')
          const c = f.record('C', '2', 'other')
          await f.plant([b, c])
          bind(f.completion, orderedCoverage([held, b]))
          bind(f.completion, orderedCoverage([c]))
          await f.completion.complete(['B', 'C'])
          expect(await f.cursor()).toBeNull()
          expect(await f.cursor('other')).toBe('2')
        } finally {
          await f.fixture.close()
        }
      })
      test('cold completion without coverage preserves the cursor', async () => {
        const f = await completionFixture(mode, supplied)
        try {
          await f.plant([f.record('B', '2')])
          expect(
            handlerCompletionForEntry({ capability: f.capability, binding: f.binding, key: f.key }),
          ).toBe(f.completion)
          const namespaces: Array<string> = []
          f.fixture.observeCodec((kind, ns) => {
            if (kind === 'seal') namespaces.push(ns)
          })
          await f.completion.transact(['B'], async (tx) =>
            writeSideRow(tx, 'cold', new Uint8Array([1])),
          )
          expect(await f.cursor()).toBeNull()
          expect(await f.pending()).toEqual([])
          expect(namespaces).not.toContain('state')
          expect(namespaces).not.toContain('trust')
          const handle = vi.fn(async () => {})
          await f.completion.transact(['missing', 'B', 'B'], handle)
          expect(handle).not.toHaveBeenCalled()
        } finally {
          await f.fixture.close()
        }
      })
    })
  }
