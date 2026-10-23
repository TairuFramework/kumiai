import { randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import {
  APP_TOPIC_LABEL,
  createOpenedAppHandler,
  encodeAppAAD,
  type GroupCrypto,
  type LogHub,
  OpenedDeliveryReentryError,
  openedDeliveryBinding,
  protocolTopic,
  type PendingAppFrame as RpcPendingAppFrame,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import type { createAppLane as CreateAppLane } from '../../rpc/lib/app-lane.js'
import type { createHubMux as CreateHubMux } from '../../rpc/lib/hub-mux.js'
import { entryCapability } from '../src/entry-capability.js'
import { drainStoredOpened } from '../src/opened-delivery.js'
import { GroupStateConflictError } from '../src/persistence-errors.js'
import type { PendingAppFrame } from '../src/persistence-types.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRegistryFixture, registryFixtureForceOwnerMarker } from './fixtures/registry.js'
import { startLeaseRotationPeer } from './fixtures/registry-lease-rotation.js'

const protocols = {
  chat: {
    posted: {
      type: 'event',
      retain: 'log',
      data: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
} as const

async function setup(mode: 'real-mls' | 'double', supplied: boolean) {
  const context = createAsyncLocalOwnershipContext()
  const groupID = crypto.randomUUID()
  const fixture = await createRegistryFixture({
    mode,
    setup: 'seeded',
    groupID,
    backgroundMaintenance: 'gated',
    openedDeliveryContext: context,
    deliverOpened: async () => {},
    ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
  })
  const key = { groupID, incarnation: 1 }
  const capability = entryCapability(fixture.device.groups)
  if (capability === null) throw new Error('Missing coordinator')
  const record = (id: string, protocol = 'chat', segment = 4, position = 'Z'): PendingAppFrame => ({
    frame: {
      ...key,
      id,
      protocol,
      procedure: 'posted',
      topicID: `${protocol}-${segment}`,
      segment,
      position,
    },
    payload: encodeEventFrame('posted', { text: id }),
    senderDID: randomIdentity().id,
    epoch: 7,
    idempotencyKey: `original-${id}`,
  })
  const plant = async (records: Array<PendingAppFrame>) =>
    capability.run(
      { groupID: key.groupID, mutationID: crypto.randomUUID() },
      async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
      async (stores) => {
        await stores.incarnation(1).pending.put(records)
        await stores.incarnation(1).cursor.save('chat-4', 'A')
      },
    )
  const pending = () => capability.read(key.groupID, (reads) => reads.pendingFrames(1))
  const drain = (deliver: (record: PendingAppFrame) => Promise<void>) =>
    drainStoredOpened({
      persistence: fixture.device.groups,
      key,
      deliver,
      openedDeliveryContext: context,
    })
  return { fixture, key, capability, context, record, plant, pending, drain }
}

test.each(['real-mls', 'double'] as const)(
  'durable registry dispatch requires context while empty drainage does not (%s)',
  async (mode) => {
    const groupID = crypto.randomUUID()
    const fixture = await createRegistryFixture({
      mode,
      groupID,
      setup: 'empty',
      backgroundMaintenance: 'gated',
    })
    const params = {
      persistence: fixture.device,
      providerID: fixture.device.providerID,
      recovery: fixture.environment,
      restore: async () => {
        throw new Error('Unexpected restore')
      },
      restoreCandidate: async () => {
        throw new Error('Unexpected candidate restore')
      },
    }
    expect(() => createGroupHandleRegistry({ ...params, deliverOpened: async () => {} })).toThrow(
      TypeError,
    )
    const registry = createGroupHandleRegistry(params)
    await expect(
      Promise.resolve().then(() => registry.drainOpened({ groupID, incarnation: 1 })),
    ).resolves.toBeUndefined()
    await registry.dispose()
    await fixture.close()
  },
)

describe.each(['real-mls', 'double'] as const)('stored opened delivery (%s)', (mode) => {
  describe.each([true, false])('ownership context %s', (supplied) => {
    test('reconstruction drains stored plaintext without reopening frames', async () => {
      const env = await setup(mode, supplied)
      const records = [env.record('first'), env.record('second', 'chat', 5)]
      await env.plant(records)
      const reconstructed = await env.fixture.reopen()
      const access = vi.spyOn(reconstructed.registry, 'access')
      const restores = reconstructed.restores()
      const delivered: Array<PendingAppFrame> = []
      await drainStoredOpened({
        persistence: reconstructed.device.groups,
        key: env.key,
        openedDeliveryContext: env.context,
        deliver: async (record) => {
          delivered.push(record)
        },
      })
      expect(delivered).toEqual(records)
      expect(reconstructed.restores()).toBe(restores)
      expect(access).not.toHaveBeenCalled()
      const capability = entryCapability(reconstructed.device.groups)
      if (capability === null) throw new Error('Missing coordinator')
      expect(await capability.read(env.key.groupID, (reads) => reads.pendingFrames(1))).toEqual([])
      await reconstructed.close()
    })

    test('failed old anchor blocks newer work in the same protocol only', async () => {
      const env = await setup(mode, supplied)
      await env.plant([
        env.record('A5', 'chat', 5),
        env.record('A4z', 'chat', 4, 'z'),
        env.record('B', 'other'),
        env.record('A4Z', 'chat', 4, 'Z'),
      ])
      const release = Promise.withResolvers<void>()
      const seen: Array<string> = []
      const drain = env.drain(async (record) => {
        seen.push(record.frame.id)
        if (record.frame.id === 'A4Z') await release.promise
      })
      await vi.waitFor(() => expect(seen).toContain('B'))
      expect(seen).toEqual(['A4Z', 'B'])
      release.resolve()
      await drain
      expect(seen).toEqual(['A4Z', 'B', 'A4z', 'A5'])
      await env.fixture.close()
    })

    test('rejected handler never completes its pending record', async () => {
      const env = await setup(mode, supplied)
      const saved = env.record('retry')
      await env.plant([saved])
      let allowed = false
      let calls = 0
      const drain = env.drain(async (record) => {
        calls++
        expect(record).toEqual(saved)
        if (!allowed) throw new Error('handler refused')
      })
      await vi.waitFor(() => expect(calls).toBe(1))
      expect(await env.pending()).toEqual([saved])
      allowed = true
      await drain
      expect(calls).toBe(2)
      expect(await env.pending()).toEqual([])
      await env.fixture.close()
    })

    test('unknown protocol blocks without deleting or fetching', async () => {
      const env = await setup(mode, supplied)
      const saved = env.record('unknown', 'unknown')
      await env.plant([saved])
      const sealed = (await env.fixture.inspectRows()).pending
      let registered = false
      const handler = createOpenedAppHandler({
        localDID: 'bob',
        protocols,
        handlers: { chat: { posted: async () => {} } },
      })
      let settled = false
      const drain = env.drain(async (record) => {
        if (!registered) await handler(record)
      })
      void drain.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(settled).toBe(false)
      expect(await env.pending()).toEqual([saved])
      expect((await env.fixture.inspectRows()).pending).toEqual(sealed)
      registered = true
      await drain
      await env.fixture.close()
    })

    test('a different group can drain from an opened callback', async () => {
      const env = await setup(mode, supplied)
      const otherID = crypto.randomUUID()
      const key = await env.fixture.registry.seed(await env.fixture.makeHandle(0, otherID), {
        packageUse: null,
      })
      await env.plant([env.record('outer')])
      let calls = 0
      await env.drain(async () => {
        await drainStoredOpened({
          persistence: env.fixture.device.groups,
          key,
          openedDeliveryContext: env.context,
          deliver: async () => {
            calls++
          },
        })
      })
      expect(calls).toBe(0)
      await env.fixture.close()
    })

    test.each(['terminal', 'retired', 'corrupt'] as const)(
      'stored plaintext drains with an unavailable source (%s)',
      async (state) => {
        const env = await setup(mode, supplied)
        const record = env.record('unavailable')
        await env.plant([record])
        if (state === 'retired') {
          const lifetime = await env.fixture.device.groups.load(env.key.groupID)
          if (lifetime === null) throw new Error('Missing lifetime')
          const mutationID = crypto.randomUUID()
          await env.fixture.device.groups.transition(
            { groupID: env.key.groupID, mutationID, expected: lifetime },
            async (stores) => {
              await stores.lifetime.save({
                ...lifetime,
                revision: lifetime.revision + 1,
                activeIncarnation: null,
                mutationID,
              })
            },
          )
        } else if (state === 'terminal') {
          await env.capability.run(
            { groupID: env.key.groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({ expected: await reads.lifetime(), value: await reads.state(1) }),
            async (stores, source) => {
              if (source === null || source.deleted) throw new Error('Missing source')
              await stores
                .incarnation(1)
                .state.save({ ...source, version: source.version + 1, terminal: true })
            },
          )
        } else await env.fixture.corruptState(env.key, 'unreadable')
        const reopened = await env.fixture.reopen()
        const restored = reopened.restores()
        const delivered: Array<PendingAppFrame> = []
        await drainStoredOpened({
          persistence: reopened.device.groups,
          key: env.key,
          openedDeliveryContext: env.context,
          deliver: async (record) => {
            delivered.push(record)
          },
        })
        expect(delivered).toEqual([record])
        expect(reopened.restores()).toBe(restored)
        await reopened.close()
      },
    )

    test.each(['active', 'retired'] as const)(
      'retired completion cannot advance an unread frontier (%s)',
      async (state) => {
        const env = await setup(mode, supplied)
        await env.plant([env.record('later')])
        if (state === 'retired') {
          const lifetime = await env.fixture.device.groups.load(env.key.groupID)
          if (lifetime === null) throw new Error('Missing lifetime')
          const mutationID = crypto.randomUUID()
          await env.fixture.device.groups.transition(
            { groupID: env.key.groupID, mutationID, expected: lifetime },
            async (stores) => {
              await stores.lifetime.save({
                ...lifetime,
                activeIncarnation: null,
                revision: lifetime.revision + 1,
                mutationID,
              })
            },
          )
        }
        let completed = false
        const draining = env.drain(async () => {})
        void draining.then(() => {
          completed = true
        })
        await vi.waitFor(() => expect(completed).toBe(true))
        await draining
        expect(
          await env.capability.read(env.key.groupID, (reads) => reads.appCursor(1, 'chat-4')),
        ).toBe('A')
        await env.fixture.close()
      },
    )

    test.each(['service', 'registry drain', 'registry disposal'] as const)(
      'handler cannot await its own %s after an await',
      async (entry) => {
        const env = await setup(mode, supplied)
        await env.plant([env.record('reentry')])
        let result: unknown
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const drain = env.drain(async () => {
          await Promise.resolve()
          const nested =
            entry === 'service'
              ? env.drain(async () => {})
              : entry === 'registry drain'
                ? env.fixture.registry.drainOpened(env.key)
                : env.fixture.registry.dispose()
          void nested.catch((error: unknown) => {
            result = error
          })
          await new Promise((resolve) => setTimeout(resolve, 10))
          entered.resolve()
          await release.promise
        })
        await entered.promise
        try {
          expect(result).toBeInstanceOf(OpenedDeliveryReentryError)
        } finally {
          release.resolve()
        }
        await drain
        await env.fixture.close()
      },
    )

    test('effect before completion crash redelivers the same record', async () => {
      const env = await setup(mode, supplied)
      const saved = env.record('effect')
      await env.plant([saved])
      const effects: Array<PendingAppFrame> = []
      const stop = new AbortController()
      env.capability.failureSignal = stop.signal
      const run = env.capability.run.bind(env.capability)
      env.fixture.armNextWorkFault('before-commit')
      let stopped = false
      env.capability.run = async (...args) => {
        try {
          return await run(...args)
        } catch (error) {
          if (!stopped) {
            stopped = true
            stop.abort(new Error('process stopped before completion'))
          }
          throw error
        }
      }
      await expect(
        env.drain(async (record) => {
          effects.push(record)
        }),
      ).rejects.toThrow('process stopped')
      env.capability.run = run
      expect(await env.pending()).toEqual([saved])
      const reopened = await env.fixture.reopen()
      await drainStoredOpened({
        persistence: reopened.device.groups,
        key: env.key,
        openedDeliveryContext: env.context,
        deliver: async (record) => {
          effects.push(record)
        },
      })
      expect(effects).toEqual([saved, saved])
      await reopened.close()
    })

    test.each(['commit', 'rollback', 'conflict'] as const)(
      'completion ambiguity retains the drain until proof (%s)',
      async (outcome) => {
        const env = await setup(mode, supplied)
        await env.plant([env.record('proof')])
        const proofEntered = Promise.withResolvers<void>()
        const proofRelease = Promise.withResolvers<void>()
        env.fixture.onPhase('proof', async () => {
          proofEntered.resolve()
          await proofRelease.promise
        })
        const fault = env.fixture.armNextWorkFault('pending')
        const delivered: Array<PendingAppFrame> = []
        let result: unknown = 'pending'
        const drain = env.drain(async (record) => {
          delivered.push(record)
        })
        void drain.then(
          () => {
            result = 'resolved'
          },
          (error: unknown) => {
            result = error
          },
        )
        await fault.rejected
        await proofEntered.promise
        let resolution: unknown = 'pending'
        const resolving = env.fixture.device.groups.resolve(env.key.groupID, await fault.mutationID)
        void resolving.then(
          (value) => {
            resolution = value
          },
          (error: unknown) => {
            resolution = error
          },
        )

        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(result).toBe('pending')
        expect(resolution).toBe('pending')
        expect(delivered).toHaveLength(1)
        await fault.finish(outcome === 'rollback' ? 'rollback' : 'commit')
        if (outcome === 'conflict')
          await registryFixtureForceOwnerMarker(
            env.fixture,
            { groupID: env.key.groupID },
            { mutationID: 'conflicting-owner', revision: 999 },
          )
        expect(result).toBe('pending')
        proofRelease.resolve()
        if (outcome === 'conflict') {
          await expect(drain).rejects.toBeInstanceOf(GroupStateConflictError)
          expect(result).toBe(env.capability.failureSignal?.reason)
          await expect(resolving).rejects.toBe(env.capability.failureSignal?.reason)
        } else {
          await drain
          expect(await resolving).toBe(outcome === 'commit' ? 'committed' : 'rolled-back')
          expect(await env.pending()).toEqual([])
          expect(delivered.every((record) => record.idempotencyKey === 'original-proof')).toBe(true)
        }
        await env.fixture.close().catch(() => {})
      },
    )

    test.each([
      'registry drain',
      'registry disposal',
      'registry peer disposal',
      'registry peer drained',
    ] as const)('live handler refuses its own %s after an await', async (entry) => {
      const env = await setup(mode, supplied)
      await env.plant([env.record('live-reentry')])
      const entered = Promise.withResolvers<void>()
      const invoke = Promise.withResolvers<void>()
      const checked = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let result: unknown
      const running = await startLeaseRotationPeer({
        mode,
        fixture: env.fixture,
        key: env.key,
        outbox: env.fixture.device.groups.ports(env.key).outbox,
        handler: async () => {
          entered.resolve()
          await invoke.promise
          try {
            const nested =
              entry === 'registry drain'
                ? env.fixture.registry.drainOpened(env.key)
                : entry === 'registry disposal'
                  ? env.fixture.registry.dispose()
                  : entry === 'registry peer disposal'
                    ? running.owner.dispose()
                    : running.owner.drained()
            if (nested !== undefined)
              void nested.catch((error: unknown) => {
                result = error
              })
          } catch (error) {
            result = error
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
          checked.resolve()
          await release.promise
        },
      })
      await entered.promise
      invoke.resolve()
      await checked.promise
      try {
        expect(result).toBeInstanceOf(OpenedDeliveryReentryError)
      } finally {
        release.resolve()
      }
      const peer = running.owner.peer()
      if (peer === null) throw new Error('Missing peer')
      await peer.drainOpened()
      expect(await env.pending()).toEqual([])
      expect(running.owner.status().kind).toBe('running')
      running.owner.dispose()
      await running.owner.drained()
      await env.fixture.close()
    })

    test('external registry disposal waits for an admitted handler without using its live completion facade', async () => {
      const env = await setup(mode, supplied)
      await env.plant([env.record('external-disposal')])
      const access = await env.fixture.registry.access(env.key.groupID)
      const liveCompletion = vi.spyOn(access.pending, 'complete')
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const running = await startLeaseRotationPeer({
        mode,
        fixture: env.fixture,
        key: env.key,
        outbox: env.fixture.device.groups.ports(env.key).outbox,
        handler: async () => {
          entered.resolve()
          await release.promise
        },
      })
      await entered.promise
      let settled = false
      const disposal = env.fixture.registry.dispose()
      void disposal.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      release.resolve()
      await disposal
      expect(liveCompletion).not.toHaveBeenCalled()
      expect(await env.pending()).toEqual([])
      running.owner.dispose()
      await running.owner.drained()
      await env.fixture.close()
    })

    test('disposal does not release an opened drain waiter', async () => {
      const env = await setup(mode, supplied)
      await env.plant([env.record('disposal')])
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const running = await startLeaseRotationPeer({
        mode,
        fixture: env.fixture,
        key: env.key,
        outbox: env.fixture.device.groups.ports(env.key).outbox,
        handler: async () => {
          entered.resolve()
          await release.promise
        },
      })
      await entered.promise
      const peer = running.owner.peer()
      if (peer === null) throw new Error('Missing peer')
      let settled = false
      const drain = peer.drainOpened()
      void drain.then(() => {
        settled = true
      })
      await peer.dispose()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(settled).toBe(false)
      const proofEntered = Promise.withResolvers<void>()
      const proofRelease = Promise.withResolvers<void>()
      env.fixture.onPhase('proof', async () => {
        proofEntered.resolve()
        await proofRelease.promise
      })
      const fault = env.fixture.armNextWorkFault('pending')
      release.resolve()
      await fault.rejected
      await proofEntered.promise
      expect(settled).toBe(false)
      await fault.finish('commit')
      expect(settled).toBe(false)
      proofRelease.resolve()
      await drain
      await peer.drained()
      running.owner.dispose()
      await running.owner.drained()
      expect(await env.pending()).toEqual([])
      await env.fixture.close()
    })

    test('disposed peers leave unadmitted records to cold delivery and retain their opened waiter', async () => {
      const env = await setup(mode, supplied)
      const records = [env.record('first'), env.record('second', 'chat', 5)]
      await env.plant(records)
      const entered = Promise.withResolvers<void>()
      const first = Promise.withResolvers<void>()
      const second = Promise.withResolvers<void>()
      let liveCalls = 0
      const running = await startLeaseRotationPeer({
        mode,
        fixture: env.fixture,
        key: env.key,
        outbox: env.fixture.device.groups.ports(env.key).outbox,
        handler: async () => {
          liveCalls++
          entered.resolve()
          await (liveCalls === 1 ? first.promise : second.promise)
        },
      })
      await entered.promise
      const peer = running.owner.peer()
      if (peer === null) throw new Error('Missing peer')
      let opened = false
      const drain = peer.drainOpened().then(() => {
        opened = true
      })
      await peer.dispose()
      const drained = peer.drained()
      try {
        expect(opened).toBe(false)
        first.resolve()
        await vi.waitFor(async () => expect(await env.pending()).toEqual(records.slice(1)))
        await drained
        expect(liveCalls).toBe(1)
        expect(opened).toBe(false)
        const cold: Array<PendingAppFrame> = []
        await env.drain(async (record) => {
          cold.push(record)
        })
        expect(cold).toEqual(records.slice(1))
        expect(await env.pending()).toEqual([])
        await vi.waitFor(() => expect(opened).toBe(true), { timeout: 500 })
        await drain
        expect(liveCalls).toBe(1)
      } finally {
        first.resolve()
        second.resolve()
        await drained
        running.owner.dispose()
        await running.owner.drained()
        await env.fixture.close()
      }
    })

    test('suspended live delivery does not block another protocol during cold handoff', async () => {
      const env = await setup(mode, supplied)
      const records = [env.record('A4'), env.record('A5', 'chat', 5), env.record('B', 'other')]
      await env.plant(records)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let liveCalls = 0
      const running = await startLeaseRotationPeer({
        mode,
        fixture: env.fixture,
        key: env.key,
        outbox: env.fixture.device.groups.ports(env.key).outbox,
        handler: async () => {
          liveCalls++
          entered.resolve()
          await release.promise
        },
      })
      await entered.promise
      const seen: Array<string> = []
      let settled = false
      const drain = env.drain(async (record) => {
        seen.push(record.frame.id)
      })
      void drain.then(() => {
        settled = true
      })
      try {
        await vi.waitFor(
          async () => {
            expect([...seen]).toEqual(['B'])
            expect(await env.pending()).toEqual(records.slice(0, 2))
          },
          { timeout: 500 },
        )
        expect(settled).toBe(false)
        expect(liveCalls).toBe(1)
      } finally {
        release.resolve()
        await drain
        running.owner.dispose()
        await running.owner.drained()
        await env.fixture.close()
      }
      expect(seen).toEqual(['B', 'A5'])
      expect(liveCalls).toBe(1)
    })

    test('cold drain joins live cursor finalisation after pending removal', async () => {
      const { createAppLane } = (await import(
        new URL('../../rpc/src/app-lane.ts', import.meta.url).href
      )) as { createAppLane: typeof CreateAppLane }
      const { createHubMux } = (await import(
        new URL('../../rpc/src/hub-mux.ts', import.meta.url).href
      )) as { createHubMux: typeof CreateHubMux }
      const { DurableFakeHub } = (await import(
        new URL('../../rpc/test/fixtures/durable-fake-hub.ts', import.meta.url).href
      )) as { DurableFakeHub: new () => LogHub }
      const { createFakeCrypto } = (await import(
        new URL('../../rpc/test/fixtures/fake-crypto.ts', import.meta.url).href
      )) as {
        createFakeCrypto(params: {
          epoch: number
          localDID: string
          pending?: {
            persistOpened(state: Uint8Array, record: RpcPendingAppFrame): Promise<void>
            list(): Promise<Array<RpcPendingAppFrame>>
            complete(id: string): Promise<void>
          }
        }): GroupCrypto
      }
      const env = await setup(mode, supplied)
      const access = await env.fixture.registry.access(env.key.groupID)
      const binding = openedDeliveryBinding(access.pending)
      if (binding === undefined) throw new Error('Missing opened binding')
      const hub = new DurableFakeHub()
      const localDID = env.fixture.identity.id
      const mux = createHubMux({ hub, localDID, onReceiveEnded() {} })
      const entered = Promise.withResolvers<void>()
      const releaseHandler = Promise.withResolvers<void>()
      const reading = Promise.withResolvers<void>()
      const releaseRead = Promise.withResolvers<void>()
      const saving = Promise.withResolvers<void>()
      const releaseSave = Promise.withResolvers<void>()
      const receiver = createFakeCrypto({
        epoch: 1,
        localDID,
        pending: {
          async persistOpened(_state, record) {
            await env.plant([
              {
                ...record,
                frame: { ...record.frame, ...env.key, procedure: 'posted' },
                epoch: 1,
                idempotencyKey: record.frame.id,
              },
            ])
          },
          list: env.pending,
          complete: (id) => binding.complete(id),
        },
      })
      const anchor = await receiver.exportSecret(APP_TOPIC_LABEL)
      const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
      const cursor = env.fixture.device.groups.ports(env.key).cursor
      const save = cursor.save
      cursor.save = async (topicID, position) => {
        saving.resolve()
        await releaseSave.promise
        await save(topicID, position)
      }
      const lane = createAppLane({
        mux,
        crypto: receiver,
        localDID,
        protocols,
        eventHandlers: new Map(),
        retentionSeconds: 60,
        appliedEpoch: () => 1,
        anchor: () => anchor,
        groupID: () => env.key.groupID,
        appCursorStore: cursor,
        claimOpened: (record, fn) => binding.claim(record, fn),
        completeOpenedRecord: (id) => binding.complete(id),
        deliverOpened: async () => {
          entered.resolve()
          await releaseHandler.promise
        },
      })
      const detach = binding.attach(env.context, {
        handoff: () => lane.handoffOpened(),
        completed: (id) => lane.acknowledgeOpened(id),
      })
      const read = env.capability.read
      let drain: Promise<void> | undefined
      let settled = false
      let coldCalls = 0
      try {
        const senderDID = randomIdentity().id
        const sender = createFakeCrypto({ epoch: 1, localDID: senderDID })
        const payload = await sender.wrap(encodeEventFrame('posted', { text: 'retained' }), {
          aad: encodeAppAAD({ topicID, intent: 'log' }),
        })
        const published = await hub.publish({ topicID, senderDID, payload, retain: 'log' })
        await lane.deliver()
        await entered.promise
        let firstRead = true
        env.capability.read = async (...args) => {
          if (firstRead) {
            firstRead = false
            reading.resolve()
            await releaseRead.promise
          }
          return read(...args)
        }
        drain = env.drain(async () => {
          coldCalls++
        })
        void drain.then(() => {
          settled = true
        })
        await reading.promise
        releaseHandler.resolve()
        await saving.promise
        expect(await env.pending()).toEqual([])
        releaseRead.resolve()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect({ settled, cursor: await cursor.load(topicID), coldCalls }).toEqual({
          settled: false,
          cursor: null,
          coldCalls: 0,
        })
        releaseSave.resolve()
        await drain
        expect(await cursor.load(topicID)).toBe(published.sequenceID)
        expect(coldCalls).toBe(0)
      } finally {
        releaseHandler.resolve()
        releaseRead.resolve()
        releaseSave.resolve()
        env.capability.read = read
        if (drain !== undefined) await drain
        lane.dispose()
        await lane.idle()
        detach()
        mux.dispose()
        await env.fixture.close()
      }
    })

    test('failed old anchor blocks newer work in the same protocol only after live handoff', async () => {
      const env = await setup(mode, supplied)
      const records = [env.record('A4'), env.record('A5', 'chat', 5), env.record('B', 'other')]
      await env.plant(records)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let refuse = true
      const running = await startLeaseRotationPeer({
        mode,
        fixture: env.fixture,
        key: env.key,
        outbox: env.fixture.device.groups.ports(env.key).outbox,
        handler: async () => {
          entered.resolve()
          await release.promise
          if (refuse) throw new Error('live handler refused')
        },
      })
      await entered.promise
      const coldRelease = Promise.withResolvers<void>()
      const seen: Array<string> = []
      const drain = env.drain(async (record) => {
        seen.push(record.frame.id)
        if (record.frame.id === 'A4') await coldRelease.promise
      })
      release.resolve()
      try {
        await vi.waitFor(() => expect(seen).toContain('B'), { timeout: 500 })
        expect(seen).toEqual(['A4', 'B'])
        expect(await env.pending()).toEqual(records.slice(0, 2))
      } finally {
        refuse = false
        coldRelease.resolve()
      }
      await drain
      expect(seen).toEqual(['A4', 'B', 'A5'])
      running.owner.dispose()
      await running.owner.drained()
      await env.fixture.close()
    })

    test('already running live delivery and cold drain never overlap a callback', async () => {
      const env = await setup(mode, supplied)
      await env.plant([env.record('live')])
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let live = 0
      const running = await startLeaseRotationPeer({
        mode,
        fixture: env.fixture,
        key: env.key,
        outbox: env.fixture.device.groups.ports(env.key).outbox,
        handler: async () => {
          live++
          entered.resolve()
          await release.promise
          live--
        },
      })
      await entered.promise
      const access = await env.fixture.registry.access(env.key.groupID)
      const binding = openedDeliveryBinding(access.pending)
      if (binding === undefined) throw new Error('Missing delivery binding')
      let duplicate = 0
      const claimed = binding.claim(env.record('live'), async () => {
        duplicate++
      })
      let cold = 0
      let settled = false
      const drain = env.drain(async () => {
        expect(live).toBe(0)
        cold++
      })
      void drain.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      expect(cold).toBe(0)
      expect(duplicate).toBe(0)
      release.resolve()
      await drain
      expect(await claimed).toBe(false)
      expect(duplicate).toBe(0)
      expect(cold).toBe(0)
      expect(await env.pending()).toEqual([])
      running.owner.dispose()
      await running.owner.drained()
      await env.fixture.close()
    })
  })
})
