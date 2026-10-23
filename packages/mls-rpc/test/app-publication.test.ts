import { encodeEventFrame } from '@kumiai/broadcast'
import { APP_TOPIC_LABEL, encodeAppAAD } from '@kumiai/rpc'
import { createAppOutboxAcceptance, createLogDelivery } from '@kumiai/rpc/testing'
import { describe, expect, test, vi } from 'vitest'

import { createRegistryAppPublication } from '../src/app-publication.js'
import { entryCapability } from '../src/entry-capability.js'
import { registryLiveSend } from '../src/registry/live-send.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import {
  createRegistryFixture,
  registryFixtureForceOwnerMarker,
  registryFixtureRestore,
} from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`${mode} / ${context}`, () => {
      test('attempt and required lease state commit before payload release', async () => {
        const fixture = await createRegistryFixture({
          mode,
          setup: 'empty',
          groupID: crypto.randomUUID(),
          backgroundMaintenance: 'gated',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        let releaseFault = async () => {}
        try {
          const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
          const access = await fixture.registry.access(key.groupID)
          const ports = fixture.device.groups.ports(key)
          await ports.anchor.save({
            anchor: {
              epoch: 0,
              secret: await access.read((handle) =>
                handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
              ),
            },
          })
          const entry = {
            seq: 0,
            protocol: 'chat',
            prc: 'chat/posted',
            data: encodeEventFrame('chat/posted', { text: 'hello' }),
            status: 'accepted' as const,
            lastAttempt: null,
          }
          await ports.outbox.put(entry)
          for (let index = 0; index < 13; index++)
            await access.seal(new Uint8Array([index]), {
              aad: encodeAppAAD({ topicID: 'warm', intent: 'ephemeral' }),
              intent: 'ephemeral',
            })
          const fault = fixture.armNextWorkFault('pending')
          releaseFault = () => fault.finish('rollback')
          let released = false
          const pending = createRegistryAppPublication(access)
            .prepare(entry, null)
            .then((value) => {
              released = true
              return value
            })
          await fault.rejected
          expect(released).toBe(false)
          await fault.finish('commit')
          releaseFault = async () => {}
          const prepared = await pending
          expect(prepared.entry.lastAttempt).toMatchObject({
            incarnation: key.incarnation,
            epoch: 0,
            topicID: prepared.snapshot.topicID,
            attempts: 1,
          })
          expect(prepared.entry.lastAttempt?.publishID).toBeTruthy()
          expect(await ports.outbox.list()).toEqual([prepared.entry])
          expect(await fixture.device.groups.loadState(key)).toMatchObject({
            senderHWM: 32,
            version: prepared.snapshot.stateVersion,
          })
        } finally {
          await releaseFault().catch(() => {})
          await fixture.close()
        }
      })
    })
  }
}

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`preparation guards ${mode} / ${context}`, () => {
      async function setup() {
        const fixture = await createRegistryFixture({
          mode,
          setup: 'empty',
          groupID: crypto.randomUUID(),
          backgroundMaintenance: 'gated',
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
        const access = await fixture.registry.access(key.groupID)
        const ports = fixture.device.groups.ports(key)
        await ports.anchor.save({
          anchor: {
            epoch: 0,
            secret: await access.read((handle) =>
              handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
            ),
          },
        })
        const entry = {
          seq: 0,
          protocol: 'chat',
          prc: 'posted',
          data: encodeEventFrame('posted', {}),
          status: 'accepted' as const,
          lastAttempt: null,
        }
        await ports.outbox.put(entry)
        const publication = createRegistryAppPublication(access)
        const capability = entryCapability(fixture.device.groups)
        const live = registryLiveSend.get(access)
        if (capability === null || live === undefined)
          throw new Error('Missing private instrumentation')
        await live.accounting()
        return { fixture, key, access, ports, entry, publication, capability, live }
      }
      test.each(['version', 'epoch', 'incarnation', 'anchor'] as const)(
        'queued %s movement refuses preparation',
        async (kind) => {
          const f = await setup()
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const run = f.capability.run.bind(f.capability)
          let blocked = false
          f.capability.run = async (...args) => {
            if (!blocked) {
              blocked = true
              entered.resolve()
              await release.promise
            }
            return await run(...args)
          }
          try {
            const pending = f.publication.prepare(f.entry, null)
            const result = pending.catch((error: unknown) => error)
            await entered.promise
            if (kind === 'version') await f.access.mutate(async () => {})
            else if (kind === 'epoch') {
              const next = await f.fixture.acceptedOrdinary(f.access)
              await f.access.replace(next.candidate, () => next.write)
            } else if (kind === 'incarnation') {
              const recovery = await f.fixture.confirmedRecovery(f.key, { confirm: true })
              if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
                throw new Error('Missing captured switch')
              await f.fixture.registry.switchIncarnation(recovery.candidate, {
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
            } else {
              const next = await f.fixture.acceptedOrdinary(f.access)
              await f.access.replace(next.candidate, () => next.write)
              await f.ports.anchor.save({
                anchor: {
                  epoch: f.access.epoch(),
                  secret: await f.access.read((handle) =>
                    handle.exportSecret(APP_TOPIC_LABEL, new Uint8Array(), 32),
                  ),
                },
              })
            }
            const rows = await f.fixture.inspectRows()
            const entries = await f.ports.outbox.list()
            release.resolve()
            expect(await result).toBeInstanceOf(Error)
            expect(await f.fixture.inspectRows()).toEqual(rows)
            expect(await f.ports.outbox.list()).toEqual(entries)
          } finally {
            release.resolve()
            await f.fixture.close()
          }
        },
      )
      test.each(context === 'supplied' ? ['synchronous', 'after-await'] : ['synchronous'])(
        'owner-held preparation rejects reentry before accounting or the send mutex (%s)',
        async (timing) => {
          const f = await setup()
          const run = f.capability.run.bind(f.capability)
          const nested: Array<Promise<unknown>> = []
          let first = true
          f.capability.run = (request, prepare, work) =>
            run(
              request,
              async (reads) => {
                if (first) {
                  first = false
                  if (timing === 'after-await') await Promise.resolve()
                  const accounting = vi.spyOn(f.live, 'accounting')
                  accounting.mockClear()
                  let outcome: unknown
                  nested.push(
                    f.publication.prepare(f.entry, null).then(
                      (value) => {
                        outcome = value
                      },
                      (error: unknown) => {
                        outcome = error
                      },
                    ),
                  )
                  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
                  expect(outcome).toMatchObject({ name: 'ReentrantOwnershipError' })
                  expect(accounting).not.toHaveBeenCalled()
                }
                return await prepare(reads)
              },
              work,
            )
          try {
            const prepared = await f.publication.prepare(f.entry, null)
            expect(prepared.entry.lastAttempt?.attempts).toBe(1)
            expect(await f.ports.outbox.list()).toEqual([prepared.entry])
          } finally {
            await Promise.all(nested)
            await f.fixture.close()
          }
        },
      )
      test('preparation rejects an obligated entry before seal or put', async () => {
        const f = await setup()
        try {
          const prepared = await f.publication.prepare(f.entry, null)
          const attempt = prepared.entry.lastAttempt
          if (attempt === null) throw new Error('Missing attempt')
          const obligation = {
            sequenceID: 'accepted',
            attemptID: attempt.publishID,
            topicID: attempt.topicID,
            outcome: 'published' as const,
          }
          expect(
            await f.ports.outbox.recordSettlement(0, obligation, {
              identity: prepared.snapshot.identity,
              stateVersion: prepared.snapshot.stateVersion,
              attemptID: attempt.publishID,
            }),
          ).toEqual({ recorded: true })
          await f.live.accounting()
          const copy = f.live.snapshot()?.copy
          if (copy === undefined) throw new Error('Missing private sender')
          const seal = vi.spyOn(copy, 'encryptApplication')
          let puts = 0
          const run = f.capability.run.bind(f.capability)
          f.capability.run = (request, prepare, work) =>
            run(request, prepare, async (stores, value) => {
              const incarnation = stores.incarnation.bind(stores)
              stores.incarnation = (number) => {
                const rows = incarnation(number)
                return {
                  ...rows,
                  outbox: {
                    ...rows.outbox,
                    put: async (entries) => {
                      puts++
                      await rows.outbox.put(entries)
                    },
                  },
                }
              }
              return await work(stores, value)
            })
          await expect(f.publication.prepare(prepared.entry, null)).rejects.toThrow()
          expect(seal).not.toHaveBeenCalled()
          expect(puts).toBe(0)
          expect(await f.ports.outbox.loadSettlement(0)).toEqual(obligation)
        } finally {
          await f.fixture.close()
        }
      })
      test('retirement during crypto refuses the attempt before work writes', async () => {
        const f = await setup()
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const seal = f.live.prepareSeal.bind(f.live)
        vi.spyOn(f.live, 'prepareSeal').mockImplementation(async (...args) => {
          const value = await seal(...args)
          entered.resolve()
          await release.promise
          return value
        })
        try {
          const rows = await f.fixture.inspectRows()
          const pending = f.publication.prepare(f.entry, null).catch((error: unknown) => error)
          await entered.promise
          const retirement = registryRetirement(f.fixture.registry).beginRetirement(f.key)
          try {
            release.resolve()
            expect(await pending).toBeInstanceOf(Error)
            expect(await f.fixture.inspectRows()).toEqual(rows)
            expect(await f.ports.outbox.list()).toEqual([f.entry])
          } finally {
            retirement.settle('rolled-back')
          }
        } finally {
          release.resolve()
          await f.fixture.close()
        }
      })
      test('refill and attempt share one mutation and one owner entry', async () => {
        const f = await setup()
        try {
          for (let seq = 0; seq < 13; seq++) {
            const row = { ...f.entry, seq }
            if (seq !== 0) await f.ports.outbox.put(row)
            await f.publication.prepare(row, null)
          }
          const before = await f.fixture.device.groups.loadState(f.key)
          if (before === null || before.deleted) throw new Error('Missing state')
          const row = { ...f.entry, seq: 13 }
          await f.ports.outbox.put(row)
          const observed: Array<{
            phase: string
            version: number | undefined
            publishID: string | undefined
          }> = []
          let inspectEffects = async () => {}
          const execute = f.capability.run.bind(f.capability)
          f.capability.run = (request, prepare, work) =>
            execute(request, prepare, async (stores, value) => {
              const inspect = async (phase: string) => {
                const rows = stores.incarnation(f.key.incarnation)
                const state = await rows.state.load()
                const entry = (await rows.outbox.list()).find((entry) => entry.seq === 13)
                const marker = [...(stores.tx.rows['group-owner']?.values() ?? [])].find(
                  (value) =>
                    value !== null &&
                    typeof value === 'object' &&
                    Reflect.get(value, 'mutationID') === request.mutationID,
                )
                expect(marker).toBeDefined()
                observed.push({
                  phase,
                  version: state?.version,
                  publishID: entry?.lastAttempt?.publishID,
                })
              }
              inspectEffects = () => inspect('effects')
              const result = await work(stores, value)
              await inspect('work')
              return result
            })
          f.fixture.onPhase('effects', () => inspectEffects())
          const run = vi.spyOn(f.capability, 'run')
          const prepared = await f.publication.prepare(row, null)
          const after = await f.fixture.device.groups.loadState(f.key)
          expect(run).toHaveBeenCalledTimes(1)
          expect(observed).toEqual(
            ['work', 'effects'].map((phase) => ({
              phase,
              version: prepared.snapshot.stateVersion,
              publishID: prepared.entry.lastAttempt?.publishID,
            })),
          )
          expect(after).toMatchObject({
            senderHWM: before.senderHWM + 16,
            version: prepared.snapshot.stateVersion,
          })
          expect((await f.ports.outbox.list()).find((entry) => entry.seq === 13)).toEqual(
            prepared.entry,
          )
        } finally {
          await f.fixture.close()
        }
      })
      test('ambiguous preparation releases no payload before proof (rollback)', async () => {
        const f = await setup()
        try {
          const before = await f.fixture.inspectRows()
          const fault = f.fixture.armNextWorkFault('pending')
          let released = false
          const pending = f.publication.prepare(f.entry, null).then((value) => {
            released = true
            return value
          })
          const result = pending.catch((error: unknown) => error)
          await fault.rejected
          expect(released).toBe(false)
          await fault.finish('rollback')
          expect(await result).toBeInstanceOf(Error)
          expect(released).toBe(false)
          expect(await f.fixture.inspectRows()).toEqual(before)
        } finally {
          await f.fixture.close()
        }
      })
      test('ambiguous preparation with marker conflict fail-stops without payload', async () => {
        const f = await setup()
        try {
          const fault = f.fixture.armNextWorkFault('pending')
          let released = false
          const pending = f.publication.prepare(f.entry, null).then((value) => {
            released = true
            return value
          })
          const result = pending.catch((error: unknown) => error)
          await fault.rejected
          expect(await f.publication.snapshot('chat')).toBeNull()
          await registryFixtureForceOwnerMarker(
            f.fixture,
            { groupID: f.key.groupID },
            { mutationID: crypto.randomUUID(), revision: 99 },
          )
          await fault
            .finish('rollback')
            .catch((error: unknown) =>
              expect(error).toMatchObject({ name: 'GroupStateConflictError' }),
            )
          expect(await result).toBeInstanceOf(Error)
          expect(released).toBe(false)
          await expect(
            (async () => await f.fixture.device.groups.loadState(f.key))(),
          ).rejects.toMatchObject({ name: 'GroupStateConflictError' })
        } finally {
          await f.fixture
            .close()
            .catch((error: unknown) =>
              expect(error).toMatchObject({ name: 'GroupStateConflictError' }),
            )
        }
      })
      test('failed publication preparation wastes its consumed generation', async () => {
        const f = await setup()
        try {
          for (let index = 0; index < 16; index++)
            await f.access.seal(new Uint8Array([index]), {
              aad: encodeAppAAD({ topicID: 'warm', intent: 'ephemeral' }),
              intent: 'ephemeral',
            })
          const generations: Array<number> = []
          const seal = f.live.prepareSeal.bind(f.live)
          vi.spyOn(f.live, 'prepareSeal').mockImplementation(async (...args) => {
            const value = await seal(...args)
            generations.push(value.sealed.generation)
            return value
          })
          f.fixture.armNextWorkFault('after-first-write')
          await expect(f.publication.prepare(f.entry, null)).rejects.toThrow()
          await f.publication.prepare(f.entry, null)
          expect(generations).toEqual([16, 17])
        } finally {
          await f.fixture.close()
        }
      })
      test('publication accounting finishes before owner acquisition', async () => {
        const f = await setup()
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const order: Array<string> = []
        const read = f.capability.read.bind(f.capability)
        let first = true
        let accounted = false
        f.capability.read = async (groupID, fn) => {
          if (first) {
            first = false
            entered.resolve()
            await release.promise
            accounted = true
            order.push('read-finished')
          }
          return await read(groupID, fn)
        }
        const run = f.capability.run.bind(f.capability)
        f.capability.run = (...args) => {
          order.push('owner-acquired')
          if (!accounted) return Promise.reject(new Error('Owner acquired before accounting'))
          return run(...args)
        }
        const seal = vi.spyOn(f.access, 'seal')
        try {
          await f.ports.control.apply({}, crypto.randomUUID())
          await entered.promise
          const pending = f.publication.prepare(f.entry, null)
          void pending.catch(() => {})
          for (let turn = 0; turn < 20; turn++) await Promise.resolve()
          expect(order).toEqual([])
          release.resolve()
          await pending
          expect(order).toEqual(['read-finished', 'owner-acquired'])
          expect(seal).not.toHaveBeenCalled()
        } finally {
          release.resolve()
          await f.fixture.close()
        }
      })
      test('authenticator-only settlement refusal preserves the installed source', async () => {
        const f = await setup()
        try {
          const record = await f.fixture.device.groups.loadState(f.key)
          if (record === null || record.deleted || record.state === null)
            throw new Error('Missing source')
          const split = await f.fixture.advance(
            await registryFixtureRestore(f.fixture)({ ...record, state: record.state }),
          )
          const next = await f.fixture.acceptedOrdinary(f.access)
          await f.access.replace(next.candidate, () => next.write)
          const prepared = await f.publication.prepare(f.entry, null)
          const authenticator = split.state.keySchedule.epochAuthenticator.slice()
          expect(Number(split.epoch)).toBe(prepared.snapshot.identity.epoch)
          expect(authenticator).not.toEqual(prepared.snapshot.identity.authenticator)
          const attempt = prepared.entry.lastAttempt
          if (attempt === null) throw new Error('Missing attempt')
          const before = await f.fixture.inspectRows()
          expect(
            await f.ports.outbox.recordSettlement(
              0,
              {
                sequenceID: 'accepted',
                attemptID: attempt.publishID,
                topicID: attempt.topicID,
                outcome: 'published',
              },
              {
                identity: { ...prepared.snapshot.identity, authenticator },
                stateVersion: prepared.snapshot.stateVersion,
                attemptID: attempt.publishID,
              },
            ),
          ).toEqual({ recorded: false, reason: 'identity-changed' })
          expect(await f.fixture.inspectRows()).toEqual(before)
          let wrongExpected = false
          const refusedExpected = Promise.withResolvers<void>()
          const queue = createAppOutboxAcceptance({
            outbox: f.ports.outbox,
            limit: 4,
            admission: () => f.access.admission(),
          })
          const prepare = vi.fn(f.publication.prepare)
          const publish = vi.fn(
            async (_frame: { topicID: string; payload: Uint8Array; publishID: string }) => ({
              sequenceID: 'accepted',
            }),
          )
          publish.mockRejectedValueOnce(new Error('Handoff failed'))
          const delivery = createLogDelivery({
            queue,
            ready: async () => {},
            floor: () => ({
              epoch: prepared.snapshot.identity.epoch,
              position: null,
              covered: true,
            }),
            held: () => false,
            prepare,
            snapshot: async (protocol) => {
              const current = await f.publication.snapshot(protocol)
              if (wrongExpected && prepare.mock.calls.length >= 2)
                setTimeout(() => refusedExpected.resolve(), 0)
              return current === null || !wrongExpected
                ? current
                : {
                    ...current,
                    identity: { ...current.identity, authenticator: authenticator.slice() },
                  }
            },
            loadSettlement: f.ports.outbox.loadSettlement,
            publish,
            probe: async () => ({ messages: [], head: 'unproven', oldest: null, gap: false }),
            pull: async () => {},
            heal: async () => {},
            remove: f.ports.outbox.remove,
            clear: f.ports.outbox.clear,
            cleared: () => {},
            deliveredWindowMs: 1000,
            deliveredLimit: 4,
          })
          try {
            delivery.trigger()
            await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
            wrongExpected = true
            await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2), { timeout: 2000 })
            await refusedExpected.promise
            expect(publish).toHaveBeenCalledTimes(1)
            const state = await f.fixture.device.groups.loadState(f.key)
            if (state === null || state.deleted) throw new Error('Missing installed state')
            expect(state.epochAuthenticator).toEqual(prepared.snapshot.identity.authenticator)
            expect(state.epoch).toBe(prepared.snapshot.identity.epoch)
            wrongExpected = false
            delivery.trigger()
            await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2))
            expect(prepare).toHaveBeenCalledTimes(3)
            expect(publish.mock.calls[1]?.[0]?.publishID).not.toBe(
              publish.mock.calls[0]?.[0]?.publishID,
            )
          } finally {
            delivery.close()
            queue.close()
          }
        } finally {
          await f.fixture.close()
        }
      })
      test('ephemeral seal does not acquire a publication transaction', async () => {
        const f = await setup()
        try {
          const run = vi.spyOn(f.capability, 'run')
          const rows = await f.fixture.inspectRows()
          await f.access.seal(new Uint8Array([1]), {
            aad: encodeAppAAD({ topicID: 'ephemeral', intent: 'ephemeral' }),
            intent: 'ephemeral',
          })
          expect(run).not.toHaveBeenCalled()
          expect(await f.fixture.inspectRows()).toEqual(rows)
        } finally {
          await f.fixture.close()
        }
      })
    })
  }
}
