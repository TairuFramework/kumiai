import { randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import {
  APP_TOPIC_LABEL,
  asLogPosition,
  createOpenedAppHandler,
  encodeAppAAD,
  type GroupCrypto,
  type LogHub,
  type MailboxHub,
  normaliseOpenedAppHandler,
  type OpenedAppHandler,
  OpenedDeliveryReentryError,
  openedDeliveryBinding,
  protocolTopic,
  type PendingAppFrame as RpcPendingAppFrame,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import type { createAppLane as CreateAppLane } from '../../rpc/lib/app-lane.js'
import type { createHubMux as CreateHubMux } from '../../rpc/lib/hub-mux.js'
import { entryCapability } from '../src/entry-capability.js'
import { createHandlerCompletion } from '../src/handler-completion.js'
import { drainStoredOpened, registryOpenedDeliveryContext } from '../src/opened-delivery.js'
import { GroupStateConflictError } from '../src/persistence-errors.js'
import type { GroupKey, MemoryTransaction, PendingAppFrame } from '../src/persistence-types.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { registryRetirement } from '../src/registry/retirement.js'
import { retireToSuccessor } from '../src/successor.js'
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

async function setup(
  mode: 'real-mls' | 'double',
  supplied: boolean,
  contextBinding: 'registry' | 'peer factory' = 'registry',
) {
  const context = createAsyncLocalOwnershipContext()
  const groupID = crypto.randomUUID()
  const fixture = await createRegistryFixture({
    mode,
    setup: 'seeded',
    groupID,
    backgroundMaintenance: 'gated',
    openedDeliveryContext: contextBinding === 'registry' ? context : null,
    deliverOpened: contextBinding === 'registry' ? async () => {} : undefined,
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
  const drain = (
    deliver: OpenedAppHandler<MemoryTransaction> | ((record: PendingAppFrame) => Promise<void>),
  ) =>
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
    expect(() =>
      createGroupHandleRegistry({
        ...params,
        openedHandler: () => {
          throw new Error('Unexpected resolution')
        },
      }),
    ).toThrow(TypeError)
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

    test('detaching a source removes its handler fallback', async () => {
      const env = await setup(mode, supplied, 'peer factory')
      await env.plant([env.record('detached')])
      const access = await env.fixture.registry.access(env.key.groupID)
      const binding = openedDeliveryBinding(access.pending)
      if (binding === undefined) throw new Error('Missing opened binding')
      const delivered: Array<string> = []
      const source = (name: string) => ({
        handoff: async () => {},
        completed: async () => {},
        deliver: async () => {
          delivered.push(name)
        },
      })
      const detach = binding.attach(env.context, source('detached'))
      detach()
      let settled = false
      const drain = env.fixture.registry.drainOpened(env.key).then(() => {
        settled = true
      })
      let removeReplacement: (() => void) | undefined
      try {
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(delivered).toEqual([])
        expect(settled).toBe(false)
        expect(await env.pending()).toHaveLength(1)
        removeReplacement = binding.attach(env.context, source('replacement'))
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 })
        await drain
        expect(delivered).toEqual(['replacement'])
        expect(await env.pending()).toEqual([])
      } finally {
        removeReplacement ??= binding.attach(env.context, source('cleanup'))
        await drain
        removeReplacement()
        await env.fixture.close()
      }
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
        completion: createHandlerCompletion({
          persistence: env.fixture.device.groups,
          key: env.key,
        }),
        openedDeliveryContext: env.context,
        localDID: 'bob',
        protocols,
        handlers: { chat: { posted: async () => {} } },
      })
      let settled = false
      const drain = env.drain(async (record) => {
        if (!registered) await handler.deliver(record)
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

    test('default effect before completion crash preserves complete handler metadata', async () => {
      const env = await setup(mode, supplied)
      const saved = env.record('effect')
      await env.plant([saved])
      const effects: Array<unknown> = []
      const handler = (persistence: typeof env.fixture.device.groups) =>
        createOpenedAppHandler({
          localDID: env.fixture.identity.id,
          protocols,
          completion: createHandlerCompletion({ persistence, key: env.key }),
          openedDeliveryContext: env.context,
          handlers: {
            chat: {
              posted: async (event) => {
                effects.push(event)
              },
            },
          },
        })
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
      await expect(env.drain(handler(env.fixture.device.groups))).rejects.toThrow('process stopped')
      env.capability.run = run
      expect(await env.pending()).toEqual([saved])
      const reopened = await env.fixture.reopen()
      await drainStoredOpened({
        persistence: reopened.device.groups,
        key: env.key,
        openedDeliveryContext: env.context,
        deliver: handler(reopened.device.groups),
      })
      const metadata = {
        data: { text: 'effect' },
        message: { payload: { iss: saved.senderDID } },
        frame: saved.frame,
        epoch: saved.epoch,
        incarnation: saved.frame.incarnation,
        idempotencyKey: saved.idempotencyKey,
      }
      expect(effects).toEqual([metadata, metadata])
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
      'lifecycle retirement',
      'lifecycle switch',
      'lifecycle readmission',
      'lifecycle deletion',
      'lifecycle successor',
    ] as const)('live handler refuses its own %s after an await', async (entry) => {
      const env = await setup(mode, supplied)
      await env.plant([env.record('live-reentry')])
      const entered = Promise.withResolvers<void>()
      const invoke = Promise.withResolvers<void>()
      const checked = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const beginnings = vi.spyOn(registryRetirement(env.fixture.registry), 'beginRetirement')
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
            let nested: Promise<unknown>
            if (entry === 'lifecycle retirement')
              nested = Promise.resolve().then(() => {
                registryRetirement(env.fixture.registry).beginRetirement(env.key)
              })
            else if (entry === 'lifecycle deletion') nested = env.fixture.registry.delete(env.key)
            else if (entry === 'lifecycle readmission')
              nested = env.fixture.registry.seed(await env.fixture.makeHandle(2), {
                replace: true,
                packageUse: null,
              })
            else if (entry === 'lifecycle successor')
              nested = retireToSuccessor({
                registry: env.fixture.registry,
                persistence: env.fixture.device.groups,
                source: env.key,
                successor: { groupID: 'other', incarnation: 1 },
              })
            else if (entry === 'lifecycle switch')
              nested = env.fixture.registry.switchIncarnation(await env.fixture.makeHandle(2), {
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
                  destination: { control: { cursor: { position: asLogPosition('1'), epoch: 2 } } },
                },
              })
            else
              nested =
                entry === 'registry drain'
                  ? env.fixture.registry.drainOpened(env.key)
                  : entry === 'registry disposal'
                    ? env.fixture.registry.dispose()
                    : entry === 'registry peer disposal'
                      ? Promise.resolve(running.owner.dispose())
                      : running.owner.drained()
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
        if (entry === 'lifecycle deletion') expect(beginnings).not.toHaveBeenCalled()
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

    test('opened handler refuses manual recovery before authorisation', async () => {
      const env = await setup(mode, supplied)
      await env.plant([env.record('manual-authorisation')])
      const before = await env.capability.read(env.key.groupID, (reads) => reads.checkpoints())
      let result: unknown
      try {
        await env.drain(async () => {
          await Promise.resolve()
          try {
            await env.fixture.manualRecovery().authoriseManualRecovery(env.key, {
              mode: 'resync',
              targetID: 'selected-hub',
              commitTopicID: 'selected-commits',
              allowOpenFork: false,
            })
          } catch (error) {
            result = error
          }
        })
        expect(result).toBeInstanceOf(OpenedDeliveryReentryError)
        expect(await env.capability.read(env.key.groupID, (reads) => reads.checkpoints())).toEqual(
          before,
        )
      } finally {
        await env.fixture.close()
      }
    })

    test.each(['registry', 'peer factory'] as const)(
      'opened handler refuses overlapping manual recovery while stopPeer awaits it (%s)',
      async (contextBinding) => {
        const env = await setup(mode, supplied, contextBinding)
        expect(registryOpenedDeliveryContext(env.fixture.registry)).toBe(
          contextBinding === 'registry' ? env.context : undefined,
        )
        await env.plant([env.record('overlapping-recovery')])
        const entered = Promise.withResolvers<void>()
        const invoke = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let result: unknown
        let recoverAgain: (() => Promise<unknown>) | undefined
        const running = await startLeaseRotationPeer({
          mode,
          fixture: env.fixture,
          key: env.key,
          outbox: env.fixture.device.groups.ports(env.key).outbox,
          openedDeliveryContext: contextBinding === 'peer factory' ? env.context : undefined,
          handler: async () => {
            entered.resolve()
            await invoke.promise
            if (recoverAgain === undefined) throw new Error('Missing repeated recovery')
            await Promise.race([
              recoverAgain().catch((error: unknown) => {
                result = error
              }),
              release.promise,
            ])
            await release.promise
          },
        })
        await running.owner.ready
        await entered.promise
        const peer = running.owner.peer()
        if (peer === null) throw new Error('Missing source peer')
        const stopping = Promise.withResolvers<void>()
        const drained = peer.drained.bind(peer)
        const stop = vi.spyOn(peer, 'drained').mockImplementation(async () => {
          stopping.resolve()
          await drained()
        })
        const { FakeHub } = (await import(
          new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
        )) as { FakeHub: new () => LogHub & MailboxHub }
        let recovered = false
        const recovery = env.fixture.safety().recover(env.key, {
          mode: 'resync',
          target: {
            targetID: 'selected-hub',
            hub: new FakeHub(),
            commitTopicID: 'selected-commits',
          },
        })
        void recovery.then(
          () => {
            recovered = true
          },
          () => {},
        )
        try {
          await stopping.promise
          const records = await env.capability.read(env.key.groupID, (reads) => reads.checkpoints())
          const saved = records.find((record) => record.kind === 'manual-recovery')
          if (saved?.kind !== 'manual-recovery') throw new Error('Missing manual authorisation')
          recoverAgain = () => running.owner.runManualRecovery(saved.value)
          invoke.resolve()
          await vi.waitFor(() => expect(result).toBeInstanceOf(OpenedDeliveryReentryError))
          expect(recovered).toBe(false)
          expect(await env.pending()).toHaveLength(1)
          release.resolve()
          await expect(recovery).resolves.toEqual(env.key)
          expect(await env.pending()).toEqual([])
          expect(running.owner.status()).toEqual({ kind: 'running' })
        } finally {
          invoke.resolve()
          release.resolve()
          stop.mockRestore()
          running.owner.dispose()
          await recovery.catch(() => {})
          await running.owner.drained()
          await env.fixture.close()
        }
      },
    )

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

    test.each(['at-least-once', 'transactional'] as const)(
      'disposed fallback refuses unadmitted records but keeps admitted completion (%s)',
      async (policy) => {
        const env = await setup(mode, supplied)
        const records = [env.record('first'), env.record('second', 'chat', 5)]
        const entered = Promise.withResolvers<void>()
        const first = Promise.withResolvers<void>()
        const second = Promise.withResolvers<void>()
        let liveCalls = 0
        const running = await startLeaseRotationPeer({
          mode,
          fixture: env.fixture,
          key: env.key,
          outbox: env.fixture.device.groups.ports(env.key).outbox,
          handler: {
            mode: policy,
            handle: async () => {
              liveCalls++
              entered.resolve()
              await (liveCalls === 1 ? first.promise : second.promise)
            },
          },
        })
        await running.owner.ready
        await env.plant(records)
        const peer = running.owner.peer()
        if (peer === null) throw new Error('Missing peer')
        let opened = false
        const drain = peer.drainOpened().then(() => {
          opened = true
        })
        await entered.promise
        const disposing = peer.dispose()
        const drained = peer.drained()
        try {
          expect(opened).toBe(false)
          first.resolve()
          await disposing
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
          await disposing
          second.resolve()
          await disposing
          await drained
          running.owner.dispose()
          await running.owner.drained()
          await env.fixture.close()
        }
      },
    )

    test.each(['dispose start', 'drained'] as const)(
      'disposed peers withdraw fallback while retaining their opened waiter: %s',
      async (stage) => {
        const env = await setup(mode, supplied, 'peer factory')
        const records = [env.record('first'), env.record('second', 'chat', 5)]
        await env.plant(records)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const oldCalls: Array<unknown> = []
        const replacementCalls: Array<unknown> = []
        const running = await startLeaseRotationPeer({
          mode,
          fixture: env.fixture,
          key: env.key,
          outbox: env.fixture.device.groups.ports(env.key).outbox,
          openedDeliveryContext: env.context,
          handler: async (event) => {
            oldCalls.push(event.data)
            entered.resolve()
            await release.promise
          },
        })
        await entered.promise
        const peer = running.owner.peer()
        if (peer === null) throw new Error('Missing peer')
        const access = await env.fixture.registry.access(env.key.groupID)
        const binding = openedDeliveryBinding(access.pending)
        if (binding === undefined) throw new Error('Missing opened binding')
        let opened = false
        const openedDrain = peer.drainOpened().then(() => {
          opened = true
        })
        let detachReplacement: (() => void) | undefined
        try {
          const disposal = peer.dispose()
          expect(opened).toBe(false)
          if (stage === 'drained') {
            await disposal
            release.resolve()
            await peer.drained()
            expect(oldCalls).toEqual([{ text: 'first' }])
            expect(await env.pending()).toEqual(records.slice(1))
            expect(opened).toBe(false)
          }
          detachReplacement = binding.attach(env.context, {
            handoff: async () => {},
            completed: async () => {},
            deliver: createOpenedAppHandler({
              completion: createHandlerCompletion({
                persistence: env.fixture.device.groups,
                key: env.key,
              }),
              openedDeliveryContext: env.context,
              localDID: env.fixture.identity.id,
              protocols,
              handlers: {
                chat: {
                  posted: async (event) => {
                    replacementCalls.push(event.data)
                  },
                },
              },
            }).deliver,
          })
          const storedDrain = env.fixture.registry.drainOpened(env.key)
          release.resolve()
          await storedDrain
          await disposal
          await peer.drained()
          await openedDrain
          await env.fixture.registry.drainOpened(env.key)
          expect(oldCalls).toEqual([{ text: 'first' }])
          expect(replacementCalls).toEqual([{ text: 'second' }])
          expect(await env.pending()).toEqual([])
        } finally {
          release.resolve()
          detachReplacement?.()
          await env.drain(async () => {})
          await openedDrain
          running.owner.dispose()
          await running.owner.drained()
          await env.fixture.close()
        }
      },
    )

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

    test.each(['drain', 'delete', 'readmit', 'switch'] as const)(
      'late completion promise is awaited before lifecycle handoff: %s',
      async (entry) => {
        const { createAppLane } = (await import(
          new URL('../../rpc/lib/app-lane.js', import.meta.url).href
        )) as { createAppLane: typeof CreateAppLane }
        const { createHubMux } = (await import(
          new URL('../../rpc/lib/hub-mux.js', import.meta.url).href
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
        const stop = new AbortController()
        const failureSignal = env.capability.failureSignal
        env.capability.failureSignal = AbortSignal.any([
          stop.signal,
          ...(failureSignal === undefined ? [] : [failureSignal]),
        ])
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
        const completing = Promise.withResolvers<void>()
        const releaseCompletion = Promise.withResolvers<void>()
        const receiver = createFakeCrypto({
          epoch: 1,
          localDID,
          pending: {
            async persistOpened(_state, record) {
              await env.plant([record])
            },
            list: env.pending,
            complete: (id) => binding.complete(id),
          },
        })
        const anchor = await receiver.exportSecret(APP_TOPIC_LABEL)
        const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
        const cursor = env.fixture.device.groups.ports(env.key).cursor
        const completion = createHandlerCompletion({
          persistence: env.fixture.device.groups,
          key: env.key,
        })
        const complete = completion.complete.bind(completion)
        const lateCompletion = vi.spyOn(completion, 'complete').mockImplementation(async (ids) => {
          await complete(ids)
          completing.resolve()
          await releaseCompletion.promise
        })
        const lane = createAppLane({
          groupKey: env.key,
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
          openedFailureSignal: binding.failureSignal,
          completion,
          openedHandler: normaliseOpenedAppHandler({
            completion,
            openedDeliveryContext: env.context,
            deliver: async () => {
              entered.resolve()
              await releaseHandler.promise
            },
          }),
        })
        const detach = binding.attach(env.context, {
          handoff: () => lane.handoffOpened(),
          completed: (id) => lane.acknowledgeOpened(id),
          deliver: async () => {
            entered.resolve()
            await releaseHandler.promise
          },
        })
        let lifecycle: () => Promise<unknown> = () => env.fixture.registry.delete(env.key)
        if (entry === 'readmit') {
          const candidate = await env.fixture.makeHandle(2)
          lifecycle = () =>
            env.fixture.registry.seed(candidate, {
              replace: true,
              packageUse: { kind: 'ordinary', ref: 'cursor-readmit', sourceID: 'hub' },
            })
        } else if (entry === 'switch') {
          const recovery = await env.fixture.confirmedRecovery(env.key, {
            confirm: true,
            format: 'legacy',
          })
          lifecycle = async () =>
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
        }
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
          drain =
            entry === 'drain'
              ? env.drain(async () => {
                  coldCalls++
                })
              : lifecycle().then(() => {})
          void drain.then(
            () => {
              settled = true
            },
            () => {},
          )
          await reading.promise
          releaseHandler.resolve()
          await completing.promise
          expect(await env.pending()).toEqual([])
          releaseRead.resolve()
          await new Promise((resolve) => setTimeout(resolve, 100))
          expect({ settled, cursor: await cursor.load(topicID), coldCalls }).toEqual({
            settled: false,
            cursor: published.sequenceID,
            coldCalls: 0,
          })
          releaseCompletion.resolve()
          await drain
          expect(await cursor.load(topicID)).toBe(entry === 'delete' ? null : published.sequenceID)
          if (entry === 'readmit' || entry === 'switch')
            expect(
              await env.fixture.device.groups
                .ports({ ...env.key, incarnation: 2 })
                .cursor.load(topicID),
            ).toBeNull()
          expect(coldCalls).toBe(0)
        } finally {
          releaseHandler.resolve()
          releaseRead.resolve()
          releaseCompletion.resolve()
          env.capability.read = read
          lateCompletion.mockRestore()
          if (!settled) stop.abort(new Error('Lifecycle witness ended'))
          await drain?.catch(() => {})
          lane.dispose()
          await lane.idle().catch(() => {})
          detach()
          mux.dispose()
          env.capability.failureSignal = failureSignal
          await env.fixture.close().catch((error: unknown) => {
            if (error !== stop.signal.reason) throw error
          })
        }
      },
    )

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

for (const mode of ['real-mls', 'double'] as const) {
  for (const supplied of [false, true]) {
    describe(`handler lifecycle policies (${mode}, ownership ${supplied})`, () => {
      test('cold drain retains claim until canonical completion settles', async () => {
        const env = await setup(mode, supplied)
        const stop = new AbortController()
        env.capability.failureSignal = AbortSignal.any([
          stop.signal,
          ...(env.capability.failureSignal === undefined ? [] : [env.capability.failureSignal]),
        ])
        await env.plant([env.record('late-proof')])
        const completion = createHandlerCompletion({
          persistence: env.fixture.device.groups,
          key: env.key,
        })
        const original = completion.complete.bind(completion)
        const completing = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const complete = vi.spyOn(completion, 'complete').mockImplementation(async (ids) => {
          await original(ids)
          completing.resolve()
          await release.promise
        })
        let settled = false
        const drain = env
          .drain(async () => {})
          .then(() => {
            settled = true
          })
        void drain.catch(() => {})
        try {
          await completing.promise
          expect(await env.pending()).toEqual([])
          expect(settled).toBe(false)
          release.resolve()
          await drain
        } finally {
          release.resolve()
          stop.abort(new Error('Drain witness ended'))
          await drain.catch(() => {})
          complete.mockRestore()
          await env.fixture.close()
        }
      })

      test.each(['at-least-once', 'transactional'] as const)(
        'cold handoff calls canonical completion once per record (%s)',
        async (policy) => {
          const env = await setup(mode, supplied, 'peer factory')
          await env.plant([env.record('first'), env.record('second', 'chat', 5)])
          const completion = createHandlerCompletion({
            persistence: env.fixture.device.groups,
            key: env.key,
          })
          const complete = vi.spyOn(completion, 'complete')
          const transact = vi.spyOn(completion, 'transact')
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const effects: Array<unknown> = []
          const running = await startLeaseRotationPeer({
            mode,
            fixture: env.fixture,
            key: env.key,
            outbox: env.fixture.device.groups.ports(env.key).outbox,
            openedDeliveryContext: env.context,
            handler: {
              mode: policy,
              handle: async (event: { data: unknown }) => {
                effects.push(event.data)
                if (effects.length === 1) {
                  entered.resolve()
                  await release.promise
                }
              },
            },
          })
          let drain: Promise<void> | undefined
          try {
            await entered.promise
            drain = env.fixture.registry.drainOpened(env.key)
            await new Promise((resolve) => setTimeout(resolve, 30))
            expect(effects).toEqual([{ text: 'first' }])
            release.resolve()
            await drain
            expect(effects).toEqual([{ text: 'first' }, { text: 'second' }])
            expect(complete.mock.calls).toEqual(
              policy === 'at-least-once' ? [[['first']], [['second']]] : [],
            )
            expect(transact.mock.calls.map(([ids]) => ids)).toEqual(
              policy === 'transactional' ? [['first'], ['second']] : [],
            )
            expect(await env.pending()).toEqual([])
          } finally {
            release.resolve()
            await drain
            running.owner.dispose()
            await running.owner.drained()
            complete.mockRestore()
            transact.mockRestore()
            await env.fixture.close()
          }
        },
      )

      test.each(['at-least-once', 'transactional'] as const)(
        'registry resolves cold dispatchers independently for two groups (%s)',
        async (policy) => {
          const context = createAsyncLocalOwnershipContext()
          const resolved: Array<ReturnType<typeof createHandlerCompletion>> = []
          const effects: Array<string> = []
          let fixture: Awaited<ReturnType<typeof createRegistryFixture>>
          fixture = await createRegistryFixture({
            mode,
            groupID: crypto.randomUUID(),
            setup: 'empty',
            backgroundMaintenance: 'gated',
            ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
            openedDeliveryContext: context,
            openedHandler: (binding) => {
              expect(binding.openedDeliveryContext).toBe(context)
              expect(binding.completion).toBe(
                createHandlerCompletion({ persistence: fixture.device.groups, key: binding.key }),
              )
              expect(binding.completion.key).toEqual(binding.key)
              resolved.push(binding.completion)
              return createOpenedAppHandler({
                ...binding,
                localDID: fixture.identity.id,
                protocols,
                handlers: {
                  chat: {
                    posted: {
                      mode: policy,
                      handle: async (event: { frame: { groupID: string } }) => {
                        effects.push(event.frame.groupID)
                      },
                    },
                  },
                },
              })
            },
          })
          try {
            const keys = await Promise.all(
              [crypto.randomUUID(), crypto.randomUUID()].map(async (groupID) =>
                fixture.registry.seed(await fixture.makeHandle(0, groupID), { packageUse: null }),
              ),
            )
            const capability = entryCapability(fixture.device.groups)
            if (capability === null) throw new Error('Missing capability')
            for (const key of keys) {
              await capability.run(
                { groupID: key.groupID, mutationID: crypto.randomUUID() },
                async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
                async (stores) => {
                  await stores.incarnation(key.incarnation).pending.put([
                    {
                      frame: {
                        ...key,
                        id: 'same-id',
                        protocol: 'chat',
                        procedure: 'posted',
                        segment: 0,
                        topicID: 'shared-topic',
                        position: '2',
                      },
                      senderDID: randomIdentity().id,
                      epoch: 0,
                      payload: encodeEventFrame('posted', { text: key.groupID }),
                      idempotencyKey: key.groupID,
                    },
                  ])
                  await stores.incarnation(key.incarnation).cursor.save('shared-topic', '1')
                },
              )
            }
            const drains = await Promise.allSettled(
              keys.map((key) => fixture.registry.drainOpened(key)),
            )
            expect(drains.map((drain) => drain.status)).toEqual(['fulfilled', 'fulfilled'])
            expect(effects.sort()).toEqual(keys.map((key) => key.groupID).sort())
            expect(resolved).toHaveLength(2)
            expect(resolved[0]).not.toBe(resolved[1])
            for (const key of keys) {
              expect(
                await capability.read(key.groupID, (reads) => reads.pendingFrames(key.incarnation)),
              ).toEqual([])
              expect(
                await capability.read(key.groupID, (reads) =>
                  reads.appCursor(key.incarnation, 'shared-topic'),
                ),
              ).toBe('1')
            }
          } finally {
            await fixture.close()
          }
        },
      )

      test.each([
        ['at-least-once', 'attached fallback'],
        ['transactional', 'attached fallback'],
        ['at-least-once', 'resolver'],
        ['transactional', 'resolver'],
        ['at-least-once', 'raw override'],
      ] as const)(
        'attached fallback and registry override retain context after await (%s, %s)',
        async (policy, source) => {
          const context = createAsyncLocalOwnershipContext()
          const groupID = crypto.randomUUID()
          const key = { groupID, incarnation: 1 }
          const release = Promise.withResolvers<void>()
          const entered = Promise.withResolvers<void>()
          let diagnostic: unknown
          let nested: Promise<void> | undefined
          const invoke = vi.fn(async () => {
            await Promise.resolve()
            nested = fixture.registry.delete(key)
            void nested.catch((error: unknown) => {
              diagnostic = error
            })
            entered.resolve()
            await release.promise
          })
          const resolve: NonNullable<
            Parameters<typeof createRegistryFixture>[0]['openedHandler']
          > = (binding) =>
            createOpenedAppHandler({
              ...binding,
              localDID: fixture.identity.id,
              protocols,
              handlers: { chat: { posted: { mode: policy, handle: invoke } } },
            })
          const fixture = await createRegistryFixture({
            mode,
            groupID,
            setup: 'seeded',
            backgroundMaintenance: 'gated',
            ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
            openedDeliveryContext: context,
            ...(source === 'resolver'
              ? { openedHandler: resolve }
              : source === 'raw override'
                ? { deliverOpened: invoke }
                : {}),
          })
          const access = await fixture.registry.access(groupID)
          const completion = createHandlerCompletion({ persistence: fixture.device.groups, key })
          const binding = openedDeliveryBinding(access.pending)
          if (binding === undefined) throw new Error('Missing opened binding')
          const fallback = resolve({ key, completion, openedDeliveryContext: context })
          if (source !== 'attached fallback')
            vi.spyOn(fallback, 'deliver').mockRejectedValue(new Error('Override lost precedence'))
          const detach = binding.attach(context, {
            handler: fallback,
            handoff: async () => {},
            completed: async () => {},
          })
          const capability = entryCapability(fixture.device.groups)
          if (capability === null) throw new Error('Missing capability')
          const other = await fixture.registry.seed(
            await fixture.makeHandle(0, crypto.randomUUID()),
            { packageUse: null },
          )
          await capability.run(
            { groupID, mutationID: crypto.randomUUID() },
            async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
            async (stores) =>
              stores.incarnation(1).pending.put([
                {
                  frame: {
                    ...key,
                    id: 'context',
                    protocol: 'chat',
                    procedure: 'posted',
                    segment: 0,
                    topicID: 'chat',
                    position: '1',
                  },
                  senderDID: randomIdentity().id,
                  epoch: 0,
                  payload: encodeEventFrame('posted', { text: 'context' }),
                  idempotencyKey: 'context',
                },
              ]),
          )
          const drain = fixture.registry.drainOpened(key)
          try {
            await entered.promise
            await vi.waitFor(() => expect(diagnostic).toBeInstanceOf(OpenedDeliveryReentryError))
            expect(context.get()).toBeUndefined()
            await fixture.registry.drainOpened(other)
            release.resolve()
            await drain
            await nested?.catch(() => {})
            expect(invoke).toHaveBeenCalledOnce()
          } finally {
            release.resolve()
            await drain.catch(() => {})
            await nested?.catch(() => {})
            detach()
            await fixture.close()
          }
        },
      )

      test.each(['at-least-once', 'transactional'] as const)(
        'cold dispatcher after incarnation switch uses the requested key (%s)',
        async (policy) => {
          const context = createAsyncLocalOwnershipContext()
          const groupID = crypto.randomUUID()
          const resolved: Array<ReturnType<typeof createHandlerCompletion<MemoryTransaction>>> = []
          const effects: Array<number> = []
          let fixture: Awaited<ReturnType<typeof createRegistryFixture>>
          fixture = await createRegistryFixture({
            mode,
            groupID,
            setup: 'seeded',
            backgroundMaintenance: 'gated',
            openedDeliveryContext: context,
            ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
            openedHandler: (binding) => {
              expect(binding.completion).toBe(
                createHandlerCompletion({ persistence: fixture.device.groups, key: binding.key }),
              )
              expect(binding.completion.key).toEqual(binding.key)
              resolved.push(binding.completion)
              return createOpenedAppHandler({
                ...binding,
                localDID: fixture.identity.id,
                protocols,
                handlers: {
                  chat: {
                    posted: {
                      mode: policy,
                      handle: async (event: { incarnation: number }) => {
                        effects.push(event.incarnation)
                      },
                    },
                  },
                },
              })
            },
          })
          const capability = entryCapability(fixture.device.groups)
          if (capability === null) throw new Error('Missing capability')
          const oldKey = { groupID, incarnation: 1 }
          const plant = async (key: GroupKey) =>
            capability.run(
              { groupID, mutationID: crypto.randomUUID() },
              async (reads) => ({ expected: await reads.lifetime(), value: undefined }),
              async (stores) => {
                await stores.incarnation(key.incarnation).pending.put([
                  {
                    frame: {
                      ...key,
                      id: 'reused-id',
                      protocol: 'chat',
                      procedure: 'posted',
                      segment: 0,
                      topicID: 'reused-topic',
                      position: '2',
                    },
                    senderDID: randomIdentity().id,
                    epoch: key.incarnation,
                    payload: encodeEventFrame('posted', { text: 'switched' }),
                    idempotencyKey: `key-${key.incarnation}`,
                  },
                ])
                await stores.incarnation(key.incarnation).cursor.save('reused-topic', '1')
              },
            )
          try {
            await plant(oldKey)
            await fixture.registry.drainOpened(oldKey)
            const oldCompletion = createHandlerCompletion({
              persistence: fixture.device.groups,
              key: oldKey,
            })
            const recovery = await fixture.confirmedRecovery(oldKey, {
              confirm: true,
              format: 'legacy',
            })
            const newKey = await fixture.registry.switchIncarnation(recovery.candidate, {
              source: await fixture.registry.recoverySource(groupID),
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
            await plant(newKey)
            const before = await fixture.inspectRows()
            await oldCompletion.complete(['reused-id'])
            expect(await fixture.inspectRows()).toEqual(before)
            expect(
              await capability.read(groupID, (reads) => reads.appCursor(1, 'reused-topic')),
            ).toBe('1')
            fixture = await fixture.reopen()
            await fixture.registry.drainOpened(oldKey)
            await fixture.registry.drainOpened(newKey)
            const current = entryCapability(fixture.device.groups)
            if (current === null) throw new Error('Missing reconstructed capability')
            expect(
              await current.read(groupID, (reads) => reads.pendingFrames(newKey.incarnation)),
            ).toEqual([])
            expect(
              await current.read(groupID, (reads) =>
                reads.appCursor(newKey.incarnation, 'reused-topic'),
              ),
            ).toBe('1')
            expect(effects).toEqual([1, 2])
            const services = [...new Set(resolved)]
            expect([...new Set(services.map((service) => JSON.stringify(service.key)))]).toEqual([
              JSON.stringify(oldKey),
              JSON.stringify(newKey),
            ])
            const currentCompletion = services.at(-1)
            expect(currentCompletion?.key).toEqual(newKey)
            for (const service of services.filter((service) => service.key.incarnation === 1))
              expect(service).not.toBe(currentCompletion)
          } finally {
            await fixture.close()
          }
        },
      )

      test.each(['wrong completion', 'wrong key', 'wrong context'] as const)(
        'registry rejects a resolver binding before invocation (%s)',
        async (invalid) => {
          const context = createAsyncLocalOwnershipContext()
          const deliver = vi.fn(async () => {})
          const groupID = crypto.randomUUID()
          const fixture = await createRegistryFixture({
            mode,
            groupID,
            setup: 'seeded',
            backgroundMaintenance: 'gated',
            openedDeliveryContext: context,
            ownershipContext: supplied ? createAsyncLocalOwnershipContext() : undefined,
            openedHandler: (binding) => ({
              completion:
                invalid === 'wrong completion'
                  ? { ...binding.completion }
                  : invalid === 'wrong key'
                    ? { ...binding.completion, key: { ...binding.key, incarnation: 99 } }
                    : binding.completion,
              openedDeliveryContext:
                invalid === 'wrong context' ? createAsyncLocalOwnershipContext() : context,
              deliver,
            }),
          })
          try {
            const key = { groupID, incarnation: 1 }
            const completion = createHandlerCompletion({ persistence: fixture.device.groups, key })
            const complete = vi.spyOn(completion, 'complete')
            await expect(fixture.registry.drainOpened(key)).rejects.toBeInstanceOf(TypeError)
            expect(deliver).not.toHaveBeenCalled()
            expect(complete).not.toHaveBeenCalled()
            complete.mockRestore()
          } finally {
            await fixture.close()
          }
        },
      )
    })
  }
}
