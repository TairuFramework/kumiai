import { randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import {
  asLogPosition,
  OpenedDeliveryReentryError,
  openedDeliveryBinding,
  runOpenedDelivery,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { deleteIncarnations, retireIncarnation } from '../src/registry/retired.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { retireToSuccessor } from '../src/successor.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { startLeaseRotationPeer } from './fixtures/registry-lease-rotation.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const supplied of [true, false]) {
    describe(`opened lifecycle (${mode}, ownership context ${supplied})`, () => {
      async function setup(coldDelivery = true) {
        const context = createAsyncLocalOwnershipContext()
        const groupID = crypto.randomUUID()
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const delivered: Array<string> = []
        const fixture = await createRegistryFixture({
          mode,
          groupID,
          setup: 'seeded',
          backgroundMaintenance: 'gated',
          openedDeliveryContext: context,
          ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
          deliverOpened: !coldDelivery
            ? undefined
            : async (record) => {
                delivered.push(record.frame.id)
                entered.resolve()
                await release.promise
              },
        })
        const key = { groupID, incarnation: 1 }
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing capability')
        const record = (id: string) => ({
          frame: {
            ...key,
            id,
            protocol: 'chat',
            procedure: 'posted',
            topicID: 'old-topic',
            segment: 0,
            position: '2',
          },
          payload: encodeEventFrame('posted', { text: id }),
          senderDID: randomIdentity().id,
          epoch: 0,
          idempotencyKey: id,
        })
        const plant = async (id: string) =>
          capability.run(
            { groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({ expected: await reads.lifetime(), value: null }),
            async (stores) => {
              await stores.incarnation(1).pending.put([record(id)])
            },
          )
        const pending = () => capability.read(groupID, (reads) => reads.pendingFrames(1))
        return { fixture, key, capability, context, entered, release, delivered, plant, pending }
      }

      test.each(['retirement', 'deletion', 'clearTransport'] as const)(
        'each erasure primitive independently refuses pending rows: %s',
        async (primitive) => {
          const env = await setup()
          try {
            await env.plant('retained')
            const before = await env.fixture.inspectRows()
            let clears = 0
            const work = () => {
              const mutationID = crypto.randomUUID()
              return env.capability.run(
                { groupID: env.key.groupID, mutationID },
                async (reads) => ({ expected: await reads.lifetime(), value: null }),
                async (stores) => {
                  const original = stores.incarnation
                  stores.incarnation = (incarnation) => {
                    const rows = original(incarnation)
                    return {
                      ...rows,
                      clearTransport: async () => {
                        clears++
                        await rows.clearTransport()
                      },
                    }
                  }
                  if (primitive === 'retirement') {
                    await retireIncarnation(stores, {
                      source: env.key,
                      nextIncarnation: null,
                      mutationID,
                      at: 12,
                    })
                    const lifetime = await stores.lifetime.load()
                    if (lifetime === null) throw new Error('Missing lifetime')
                    await stores.lifetime.save({
                      ...lifetime,
                      activeIncarnation: null,
                      revision: lifetime.revision + 1,
                      mutationID,
                    })
                  } else if (primitive === 'deletion')
                    await deleteIncarnations(stores, env.key, mutationID)
                  else await stores.incarnation(1).clearTransport()
                },
              )
            }
            const refusal = await work().then(
              () => null,
              (error: unknown) => error,
            )
            expect.soft(refusal).toMatchObject({
              name:
                primitive === 'clearTransport'
                  ? 'GroupStateConflictError'
                  : 'GroupControlUnsettledError',
              message:
                primitive === 'retirement'
                  ? 'Opened application records prevent retirement'
                  : primitive === 'deletion'
                    ? 'Opened application records prevent deletion'
                    : 'Pending application records prevent transport clearing',
            })
            if (primitive === 'deletion') expect.soft(clears).toBe(0)
            expect(await env.fixture.inspectRows()).toEqual(before)
            await env.capability.run(
              { groupID: env.key.groupID, mutationID: crypto.randomUUID() },
              async (reads) => ({ expected: await reads.lifetime(), value: null }),
              async (stores) => {
                await stores.incarnation(1).pending.complete(['retained'])
              },
            )
            await expect(work()).resolves.toBeUndefined()
          } finally {
            env.release.resolve()
            await env.fixture.close()
          }
        },
      )

      async function lifecycle(
        env: Awaited<ReturnType<typeof setup>>,
        kind: 'delete' | 'Welcome-readmission' | 'resync' | 'successor',
      ) {
        let begin: () => Promise<unknown>
        if (kind === 'delete') begin = () => env.fixture.registry.delete(env.key)
        else if (kind === 'Welcome-readmission') {
          const candidate = await env.fixture.makeHandle(2)
          begin = () =>
            env.fixture.registry.seed(candidate, {
              replace: true,
              packageUse: { kind: 'ordinary', sourceID: 'hub', ref: 'fresh' },
            })
        } else if (kind === 'resync') {
          const recovery = await env.fixture.confirmedRecovery(env.key, {
            confirm: true,
            format: 'legacy',
          })
          begin = async () =>
            env.fixture.registry.switchIncarnation(recovery.candidate, {
              source: await env.fixture.registry.recoverySource(env.key.groupID),
              rejoinID: recovery.record.id,
              proof: recovery.proof,
              write: {
                mutationID: crypto.randomUUID(),
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
          const successor = await env.fixture.registry.seed(
            await env.fixture.makeHandle(0, `${env.key.groupID}-successor`),
            { packageUse: null },
          )
          begin = () =>
            retireToSuccessor({
              registry: env.fixture.registry,
              persistence: env.fixture.device.groups,
              source: env.key,
              successor,
            })
        }
        return begin
      }

      test.each(['delete', 'Welcome-readmission', 'resync', 'successor'] as const)(
        'every retirement drains pending before transport clearing: %s',
        async (kind) => {
          const env = await setup()
          let work: Promise<unknown> | undefined
          try {
            const begin = await lifecycle(env, kind)
            await env.plant('source-work')
            let settled = false
            work = begin().finally(() => {
              settled = true
            })
            void work.catch(() => {})
            await vi.waitFor(() => expect(env.delivered).toEqual(['source-work']), {
              timeout: 2000,
            })
            expect(settled).toBe(false)
            expect(await env.pending()).toHaveLength(1)
            expect(await env.fixture.device.groups.load(env.key.groupID)).toMatchObject({
              activeIncarnation: 1,
            })
            env.release.resolve()
            await work
            expect(await env.pending()).toEqual([])
            expect(env.delivered).toEqual(['source-work'])
            expect(
              (await env.fixture.device.groups.load(env.key.groupID))?.activeIncarnation,
            ).not.toBe(1)
          } finally {
            env.release.resolve()
            await work?.catch(() => {})
            await env.fixture.close()
          }
        },
      )

      test.each(['resync', 'delete'] as const)(
        'live handler drains unadmitted backlog without registry delivery: %s',
        async (kind) => {
          const env = await setup(false)
          const release = Promise.withResolvers<void>()
          const calls: Array<unknown> = []
          let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
          let work: Promise<unknown> | undefined
          let settled = false
          try {
            await env.plant('first')
            await env.plant('second')
            running = await startLeaseRotationPeer({
              mode,
              fixture: env.fixture,
              key: env.key,
              outbox: env.fixture.device.groups.ports(env.key).outbox,
              handler: async (event) => {
                calls.push(event.data)
                await release.promise
              },
            })
            await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 2000 })
            expect(calls).toEqual([{ text: 'first' }])
            const begin = await lifecycle(env, kind)
            work = begin().then(() => {
              settled = true
            })
            void work.catch(() => {})
            await vi.waitFor(() => expect(running?.owner.status().kind).toBe('switch-blocked'), {
              timeout: 2000,
            })
            expect(await env.pending()).toHaveLength(2)
            release.resolve()
            await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 })
            await work
            expect(calls).toEqual([{ text: 'first' }, { text: 'second' }])
            expect(await env.pending()).toEqual([])
            expect(running.owner.status().kind).not.toBe('switch-blocked')
          } finally {
            release.resolve()
            if (work !== undefined && !settled) {
              await env.capability.run(
                { groupID: env.key.groupID, mutationID: crypto.randomUUID() },
                async (reads) => ({ expected: await reads.lifetime(), value: null }),
                async (stores) => {
                  await stores.incarnation(1).pending.complete(['first', 'second'])
                },
              )
            }
            await work?.catch(() => {})
            running?.owner.dispose()
            await running?.owner.drained()
            await env.fixture.close()
          }
        },
      )

      test.each(['delete', 'Welcome-readmission', 'resync', 'successor'] as const)(
        'new pending work found by lifecycle recheck causes another drain: %s',
        async (kind) => {
          const env = await setup()
          let work: Promise<unknown> | undefined
          try {
            const begin = await lifecycle(env, kind)
            env.release.resolve()
            const retirement = registryRetirement(env.fixture.registry)
            const original = retirement.drainOpened
            let injected = false
            const drain = vi.spyOn(retirement, 'drainOpened').mockImplementation(async (key) => {
              await original(key)
              if (!injected) {
                injected = true
                await env.plant('late-open')
              }
            })
            work = begin()
            await expect(work.then(() => 'completed')).resolves.toBe('completed')
            expect(injected).toBe(true)
            expect(env.delivered).toEqual(['late-open'])
            expect(drain.mock.calls.length).toBeGreaterThanOrEqual(2)
            expect(await env.pending()).toEqual([])
            drain.mockRestore()
          } finally {
            env.release.resolve()
            await work?.catch(() => {})
            await env.fixture.close()
          }
        },
      )

      test('three pending rechecks refuse deletion and release owner creation', async () => {
        const env = await setup()
        try {
          env.release.resolve()
          const retirement = registryRetirement(env.fixture.registry)
          const original = retirement.drainOpened
          let changes = 0
          const drain = vi.spyOn(retirement, 'drainOpened').mockImplementation(async (key) => {
            await original(key)
            changes++
            await env.plant(`late-${changes}`)
          })
          await expect(env.fixture.registry.delete(env.key)).rejects.toMatchObject({
            name: 'GroupControlUnsettledError',
            message: 'Group work changed during three deletion drains',
          })
          expect(changes).toBe(3)
          expect(await env.pending()).toHaveLength(1)
          drain.mockRestore()
          expect((await env.fixture.registry.access(env.key.groupID)).key).toEqual(env.key)
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test('switch revalidates a proven administrative version after publication drainage', async () => {
        const env = await setup()
        try {
          await env.fixture.registry.access(env.key.groupID)
          const outbox = env.fixture.device.groups.ports(env.key).outbox
          await outbox.put({
            seq: 13,
            protocol: 'chat',
            prc: 'posted',
            data: encodeEventFrame('posted', { text: 'certified' }),
            status: 'accepted',
            lastAttempt: {
              incarnation: 1,
              epoch: 0,
              segment: 0,
              floor: null,
              attempts: 1,
              publishID: 'source-attempt',
              topicID: 'source-topic',
            },
          })
          const state = await env.fixture.device.groups.loadState(env.key)
          if (state === null || state.deleted) throw new Error('Missing source')
          expect(
            await outbox.recordSettlement(
              13,
              {
                attemptID: 'source-attempt',
                topicID: 'source-topic',
                sequenceID: '42',
                outcome: 'published',
              },
              {
                identity: {
                  ...env.key,
                  epoch: state.epoch,
                  authenticator: state.epochAuthenticator,
                },
                stateVersion: state.version,
                attemptID: 'source-attempt',
              },
            ),
          ).toEqual({ recorded: true })
          const begin = await lifecycle(env, 'resync')
          await expect(begin()).resolves.toEqual({ ...env.key, incarnation: 2 })
          expect(await outbox.loadSettlement(13)).toBeNull()
          expect(await outbox.events()).toContainEqual(
            expect.objectContaining({
              kind: 'published',
              occurrence: { incarnation: 1, segment: 0, topicID: 'source-topic', position: '42' },
            }),
          )
          expect(env.delivered).toEqual([])
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test('retired services do not write the active incarnation', async () => {
        const env = await setup()
        try {
          const readmit = await lifecycle(env, 'Welcome-readmission')
          await readmit()
          const key = { ...env.key, incarnation: 2 }
          const record = {
            frame: {
              ...key,
              id: 'active-work',
              protocol: 'chat',
              procedure: 'posted',
              topicID: 'new-topic',
              segment: 2,
              position: '1',
            },
            payload: encodeEventFrame('posted', { text: 'active' }),
            senderDID: randomIdentity().id,
            epoch: 2,
            idempotencyKey: 'active',
          }
          await env.capability.run(
            { groupID: key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({ expected: await reads.lifetime(), value: null }),
            async (stores) => {
              await stores.incarnation(2).pending.put([record])
              await stores.incarnation(2).cursor.save('new-topic', '0')
            },
          )
          const before = await env.fixture.inspectRows()
          env.release.resolve()
          await expect(env.fixture.registry.delete(env.key)).rejects.toMatchObject({
            name: 'DisplacedGroupHandleError',
          })
          expect(env.delivered).toEqual([])
          expect(await env.fixture.inspectRows()).toEqual(before)
          expect(await env.capability.read(key.groupID, (reads) => reads.pendingFrames(2))).toEqual(
            [record],
          )
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test('terminal reconstruction drains before clearing', async () => {
        const env = await setup()
        let reopened: Awaited<ReturnType<typeof env.fixture.reopen>> | undefined
        let work: Promise<void> | undefined
        try {
          await env.plant('terminal-open')
          const state = await env.fixture.device.groups.loadState(env.key)
          if (state === null || state.deleted) throw new Error('Missing source')
          await env.fixture.installRows({
            key: env.key,
            state: { ...state, version: state.version + 1, terminal: true, state: null },
          })
          const control = await env.fixture.device.groups.ports(env.key).control.load()
          reopened = await env.fixture.reopen()
          const restores = reopened.restores()
          work = reopened.registry.delete(env.key)
          await env.entered.promise
          expect(reopened.restores()).toBe(restores)
          expect(await reopened.device.groups.load(env.key.groupID)).toMatchObject({
            activeIncarnation: 1,
          })
          env.release.resolve()
          await work
          expect(env.delivered).toEqual(['terminal-open'])
          expect(await reopened.device.groups.ports(env.key).control.load()).toEqual(control)
        } finally {
          env.release.resolve()
          await work?.catch(() => {})
          await (reopened ?? env.fixture).close()
        }
      })

      test('delivery can seed a different group without joining its own retirement', async () => {
        const env = await setup()
        try {
          const groupID = `${env.key.groupID}-other`
          const candidate = await env.fixture.makeHandle(0, groupID)
          const source = await env.fixture.device.groups.load(env.key.groupID)
          await runOpenedDelivery(env.context, { key: env.key }, async () => {
            await Promise.resolve()
            expect(await env.fixture.registry.seed(candidate, { packageUse: null })).toEqual({
              groupID,
              incarnation: 1,
            })
          })
          expect(await env.fixture.device.groups.load(env.key.groupID)).toEqual(source)
        } finally {
          env.release.resolve()
          await env.fixture.close()
        }
      })

      test.each(['retire', 'switch', 'readmit', 'delete', 'successor'] as const)(
        'delivery refuses same-group lifecycle reentry after await: %s',
        async (kind) => {
          const env = await setup()
          try {
            const candidate = await env.fixture.makeHandle(2)
            const before = await env.fixture.inspectRows()
            const begin = vi.spyOn(registryRetirement(env.fixture.registry), 'beginRetirement')
            let result: unknown
            await runOpenedDelivery(env.context, { key: env.key }, async () => {
              await Promise.resolve()
              try {
                if (kind === 'retire')
                  registryRetirement(env.fixture.registry).beginRetirement(env.key)
                else if (kind === 'delete') await env.fixture.registry.delete(env.key)
                else if (kind === 'readmit')
                  await env.fixture.registry.seed(candidate, { replace: true, packageUse: null })
                else if (kind === 'successor')
                  await retireToSuccessor({
                    registry: env.fixture.registry,
                    persistence: env.fixture.device.groups,
                    source: env.key,
                    successor: { groupID: 'other', incarnation: 1 },
                  })
                else
                  await env.fixture.registry.switchIncarnation(candidate, {
                    source: await env.fixture.registry.recoverySource(env.key.groupID),
                    rejoinID: 'absent',
                    proof: {
                      targetID: 'hub',
                      topicID: 'commits',
                      groupInfoEpoch: 2,
                      captureHead: null,
                      position: asLogPosition('1'),
                      payloadDigest: 'digest',
                      verdict: new Uint8Array(),
                    },
                    write: {
                      mutationID: 'forbidden',
                      source: { rejoinID: 'absent' },
                      destination: {
                        control: { cursor: { position: asLogPosition('1'), epoch: 2 } },
                      },
                    },
                  })
              } catch (error) {
                result = error
              }
            })
            expect(result).toBeInstanceOf(OpenedDeliveryReentryError)
            if (kind === 'delete') expect(begin).not.toHaveBeenCalled()
            expect(await env.fixture.inspectRows()).toEqual(before)
          } finally {
            env.release.resolve()
            await env.fixture.close()
          }
        },
      )

      async function liveRetirement(advance: boolean) {
        const env = await setup()
        const release = Promise.withResolvers<void>()
        const entered = Promise.withResolvers<void>()
        let running: Awaited<ReturnType<typeof startLeaseRotationPeer>> | undefined
        let work: Promise<unknown> | undefined
        try {
          await env.plant('live')
          const access = await env.fixture.registry.access(env.key.groupID)
          const completion = vi.spyOn(access.pending, 'complete')
          const binding = openedDeliveryBinding(access.pending)
          if (binding === undefined) throw new Error('Missing opened binding')
          const attach = binding.attach
          const handedOff = vi.fn()
          binding.attach = (context, source) =>
            attach(context, {
              ...source,
              handoff: () => {
                handedOff()
                return source.handoff()
              },
            })
          let calls = 0
          running = await startLeaseRotationPeer({
            mode,
            fixture: env.fixture,
            key: env.key,
            outbox: env.fixture.device.groups.ports(env.key).outbox,
            handler: async () => {
              calls++
              entered.resolve()
              await release.promise
            },
          })
          await entered.promise
          let settled = false
          if (advance) vi.useFakeTimers()
          const retirement = registryRetirement(env.fixture.registry)
          const begin = retirement.beginRetirement
          const fenced = Promise.withResolvers<void>()
          vi.spyOn(retirement, 'beginRetirement').mockImplementation((key) => {
            const attempt = begin(key)
            fenced.resolve()
            expect(handedOff).toHaveBeenCalledTimes(1)
            return attempt
          })
          if (advance) {
            const attempt = retirement.beginRetirement(env.key)
            work = attempt.drain().then(() => {
              settled = true
              attempt.settle('rolled-back')
            })
          } else {
            work = env.fixture.registry.delete(env.key).then(() => {
              settled = true
            })
          }
          void work.catch(() => {})
          await fenced.promise
          await expect(access.pending.complete('live')).rejects.toMatchObject({
            name: 'RegistryRetiringError',
          })
          expect(settled).toBe(false)
          if (advance) {
            await vi.advanceTimersByTimeAsync(6000)
            expect(settled).toBe(false)
            expect(await env.pending()).toHaveLength(1)
            expect(await env.fixture.device.groups.load(env.key.groupID)).toMatchObject({
              activeIncarnation: 1,
            })
            expect(await env.capability.read(env.key.groupID, (reads) => reads.events(1))).toEqual(
              [],
            )
            expect(running.owner.status()).toEqual({
              kind: 'switch-blocked',
              key: env.key,
              reason: 'opened-records',
              pending: 1,
            })
            vi.useRealTimers()
          }
          completion.mockClear()
          release.resolve()
          await work
          expect(calls).toBe(1)
          expect(completion).not.toHaveBeenCalled()
          expect(env.delivered).toEqual([])
          expect(await env.pending()).toEqual([])
        } finally {
          release.resolve()
          env.release.resolve()
          await work?.catch(() => {})
          vi.restoreAllMocks()
          running?.owner.dispose()
          await running?.owner.drained()
          await env.fixture.close()
          vi.useRealTimers()
        }
      }
      test('retirement hands suspended live delivery to exact-key completion', () =>
        liveRetirement(false))
      test('timeout never erases opened records or certifies retirement', () =>
        liveRetirement(true))
    })
  }
}
