import { encodeEventFrame } from '@kumiai/broadcast'
import {
  appBatch,
  bindControlBatch,
  type ControlBatchBinding,
  commitTopic,
  createGroupPeer,
  encodeAppAAD,
  frameID,
  type GroupProcedureHandlers,
  type LogHub,
  protocolTopic,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { createRegistryAppPublication } from '../src/app-publication.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { entryCapability } from '../src/entry-capability.js'
import { createHandlerCompletion } from '../src/handler-completion.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import type { MemoryTransaction } from '../src/persistence-types.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { openedDeliveryContext } from './fixtures/ownership-context.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'
import { writeSideRow } from './fixtures/storage-persistence.js'

const protocol = { posted: { type: 'event', retain: 'log', data: { type: 'object' } } } as const
const { FakeHub } = (await import(
  new URL('../../rpc/test/fixtures/fake-hub.ts', import.meta.url).href
)) as { FakeHub: new () => LogHub }

type Mode = 'real-mls' | 'double'
type CryptoGroup = Awaited<ReturnType<typeof createRegistryCryptoGroup>>
async function setup(
  mode: Mode,
  handler: GroupProcedureHandlers<typeof protocol, MemoryTransaction>['posted'],
  names = ['chat'],
  existingGroup?: CryptoGroup,
  retained?: Map<string, Array<{ sequenceID: string; payload: Uint8Array }>>,
  recordControl = false,
  startupControl = false,
) {
  const group =
    existingGroup ??
    (await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
      backgroundMaintenance: 'gated',
    }))
  const f = group.fixture()
  const key = group.key
  const access = group.access()
  const groupCrypto = group.receiver()
  const hub = new FakeHub()
  const messages = retained ?? new Map<string, Array<{ sequenceID: string; payload: Uint8Array }>>()
  const fetch = vi
    .spyOn(hub, 'fetchTopic')
    .mockImplementation(async ({ topicID, after, limit }) => {
      const all = messages.get(topicID) ?? []
      return {
        messages: all
          .filter((frame) => after == null || frame.sequenceID > after)
          .slice(0, limit)
          .map((frame) => ({ ...frame, topicID, senderDID: group.sender.identity.id })),
        head: all.at(-1)?.sequenceID ?? null,
        oldest: all[0]?.sequenceID ?? null,
        gap: false,
      }
    })
  const ports = f.device.groups.ports(key)
  const completion = createHandlerCompletion({ persistence: f.device.groups, key })
  const completed = vi.spyOn(completion, 'complete')
  const unwrap = vi.spyOn(groupCrypto, 'unwrap')
  const mls = await createRegistryGroupMLS({
    registry: f.registry,
    key,
    recovery: f.environment,
    target: { targetID: 'batch-hub', topicID: 'batch-commits' },
    identity: f.identity,
    entrySlot: createLedgerEntrySlot(),
  })
  const scheduler = appBatch(groupCrypto)?.scheduler
  const selectedControl = vi.fn()
  const recording: ControlBatchBinding = {
    key,
    run: (input) => {
      if (scheduler === undefined) throw new Error('Missing scheduler')
      return scheduler.schedule({
        ...input,
        kind: 'control',
        run: async () => {
          selectedControl()
          throw new Error('Control preparation is outside the readiness checkpoint')
        },
      })
    },
  }
  const controlReady = vi.spyOn(recording, 'run')
  if (recordControl) bindControlBatch(mls, recording)
  if (startupControl)
    messages.set(commitTopic(await mls.exportRecoverySecret()), [
      { sequenceID: '10', payload: new Uint8Array([255]) },
    ])
  const peer = createGroupPeer({
    hub,
    crypto: groupCrypto,
    completion,
    openedDeliveryContext,
    mls,
    control: ports.control,
    anchorStore: ports.anchor,
    appCursorStore: ports.cursor,
    appOutbox: ports.outbox,
    appPublication: createRegistryAppPublication(access),
    appOutboxLimit: 16,
    localDID: f.identity.id,
    protocols: Object.fromEntries(names.map((name) => [name, protocol])),
    handlers: Object.fromEntries(names.map((name) => [name, { posted: handler }])),
    readEvidence: () => f.device.groups.readEvidence(key),
    validation: createControlValidationPort({
      identity: f.identity,
      options: f.environment.options,
      restoreCandidate: async () => {
        throw new Error('No own build')
      },
    }),
    prepareBuild: async () => {
      throw new Error('No own build')
    },
    adopt: async () => {
      throw new Error('No own adoption')
    },
    deliverWelcome: async () => {},
  })
  await peer.replay()
  const anchor = await ports.anchor.load()
  if (anchor === null) throw new Error('Missing anchor')
  const topicID = protocolTopic(anchor.anchor.secret, anchor.anchor.epoch, 'chat')
  const seal = async (position: string, data = {}) => {
    const payload = await group.sender.handle.encrypt(encodeEventFrame('posted', data), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    })
    return { sequenceID: position, payload }
  }
  return {
    group,
    hub,
    mls,
    controlReady,
    selectedControl,
    f,
    key,
    peer,
    ports,
    completion,
    completed,
    groupCrypto,
    unwrap,
    messages,
    fetch,
    topicID,
    seal,
    async close() {
      await peer.dispose()
      await peer.drained()
      await group.close()
    },
  }
}

for (const mode of ['real-mls', 'double'] as const)
  describe(`retained batches / ${mode}`, () => {
    test('bound startup buffers checked control without legacy walking', async () => {
      const s = await setup(mode, async () => {}, ['chat'], undefined, undefined, true, true)
      try {
        for (let i = 0; i < 50; i++) await Promise.resolve()
        expect(s.controlReady).toHaveBeenCalledOnce()
        expect((await s.ports.control.load()).cursor).toBeNull()
      } finally {
        await s.close()
      }
    })

    test('commit wakeup without fetched bytes advertises no control', async () => {
      const s = await setup(mode, async () => {}, ['chat'], undefined, undefined, true)
      try {
        const topicID = commitTopic(await s.mls.exportRecoverySecret())
        const before = s.fetch.mock.calls.length
        await s.hub.publish({
          topicID,
          senderDID: s.group.sender.identity.id,
          payload: new Uint8Array([1, 2, 3]),
          retain: 'log',
        })
        await vi.waitFor(() => expect(s.fetch.mock.calls.length).toBeGreaterThan(before))
        for (let i = 0; i < 50; i++) await Promise.resolve()
        expect(s.controlReady).not.toHaveBeenCalled()
        expect(s.selectedControl).not.toHaveBeenCalled()
      } finally {
        await s.close()
      }
    })

    for (const pendingFetch of [false, true])
      test(
        pendingFetch
          ? 'pending control fetch does not hide already-buffered work'
          : 'peer advertises buffered control before prerequisite reads',
        async () => {
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const withheld = Promise.withResolvers<void>()
          let fetchEntered = false
          const s = await setup(mode, async () => {}, ['A', 'B'], undefined, undefined, true)
          const binding = appBatch(s.groupCrypto)
          if (binding === undefined) throw new Error('Missing app binding')
          const scheduled = vi.spyOn(binding.scheduler, 'schedule')
          const topic = commitTopic(await s.mls.exportRecoverySecret())
          const anchor = (await s.ports.anchor.load())?.anchor
          if (anchor === undefined) throw new Error('Missing anchor')
          const topics = ['A', 'B'].map((name) => protocolTopic(anchor.secret, anchor.epoch, name))
          for (const topicID of topics) {
            const payload = await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
              aad: encodeAppAAD({ topicID, intent: 'log' }),
            })
            s.messages.set(topicID, [{ sequenceID: '1', payload }])
          }
          let stages = 0
          s.group.observeStage(async () => {
            if (++stages === 1) {
              entered.resolve()
              await release.promise
            }
          })
          try {
            s.peer.retryAppDelivery()
            await entered.promise
            const capability = entryCapability(s.f.device.groups)
            if (capability === null) throw new Error('Missing entry capability')
            const reads = vi.spyOn(capability, 'read')
            const prerequisites = [
              vi.spyOn(s.mls, 'readEpoch'),
              vi.spyOn(s.mls, 'readCommitHeader'),
              vi.spyOn(s.mls, 'isLedgerComplete'),
              vi.spyOn(s.mls, 'rosterEntries'),
              vi.spyOn(s.ports.control, 'load'),
              vi.spyOn(s.ports.anchor, 'load'),
            ]
            // Push metadata is deliberately different from the checked fetched occurrence.
            const fetchCount = s.fetch.mock.calls.filter(
              ([request]) => request.topicID === topic,
            ).length
            s.messages.set(
              topic,
              pendingFetch
                ? Array.from({ length: 100 }, (_, index) => ({
                    sequenceID: String(index + 1).padStart(4, '0'),
                    payload: new Uint8Array([255]),
                  }))
                : [{ sequenceID: '10', payload: new Uint8Array([255]) }],
            )
            if (pendingFetch) {
              const fetch = s.fetch.getMockImplementation()
              if (fetch === undefined) throw new Error('Missing fetch implementation')
              s.fetch.mockImplementation(async (request) => {
                if (request.topicID === topic && request.after === '0100') {
                  fetchEntered = true
                  await withheld.promise
                }
                return fetch(request)
              })
            }
            await s.hub.publish({
              topicID: topic,
              senderDID: s.group.sender.identity.id,
              payload: new Uint8Array([0]),
              retain: 'log',
            })
            // Flush finite ingress microtasks; a blocked root read must fail an assertion, not time out.
            for (let i = 0; i < 50; i++) await Promise.resolve()
            for (const read of prerequisites) expect(read).not.toHaveBeenCalled()
            expect(reads).not.toHaveBeenCalled()
            expect(
              s.fetch.mock.calls.filter(([request]) => request.topicID === topic).length,
            ).toBeGreaterThan(fetchCount)
            expect(s.controlReady).toHaveBeenCalledTimes(1)
            expect(scheduled.mock.calls.filter(([w]) => w.kind === 'control')).toHaveLength(1)
            expect(scheduled.mock.calls.some(([w]) => w.source.includes(topics[1] as string))).toBe(
              true,
            )
            expect(s.selectedControl).not.toHaveBeenCalled()
            if (pendingFetch) {
              expect(fetchEntered).toBe(true)
              expect(s.controlReady).toHaveBeenCalledTimes(1)
              expect(s.selectedControl).not.toHaveBeenCalled()
              const stopping = s.peer.dispose()
              expect(s.controlReady.mock.calls[0]?.[0].signal?.aborted).toBe(true)
              // Disposal withdraws readiness, while independent storage work can still finish.
              release.resolve()
              await stopping
              await Promise.allSettled(scheduled.mock.results.map((result) => result.value))
              await s.peer.drained()
              const saved = await s.group.access().pending.list()
              expect(saved.length).toBeGreaterThan(0)
              await s.completion.complete(saved.map((record) => record.frame.id))
              expect(await s.group.access().pending.list()).toEqual([])
              expect(s.selectedControl).not.toHaveBeenCalled()
              withheld.resolve()
            } else {
              release.resolve()
              await vi.waitFor(() => expect(s.selectedControl).toHaveBeenCalledOnce())
            }
          } finally {
            release.resolve()
            withheld.resolve()
            await s.close()
          }
        },
      )

    test('real peer keeps registry batching and completion through host wrapping', async () => {
      const release = Promise.withResolvers<void>()
      const staged = Promise.withResolvers<void>()
      const stageRelease = Promise.withResolvers<void>()
      const handler = vi.fn(async () => release.promise)
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
      const s = await setup(mode, handler)
      const binding = appBatch(s.groupCrypto)
      if (binding === undefined) throw new Error('Missing original batch binding')
      const open = vi.spyOn(binding, 'openReady')
      let stages = 0
      s.group.observeStage(async () => {
        if (++stages === 1) {
          staged.resolve()
          await stageRelease.promise
        }
      })
      try {
        const messages = []
        for (let i = 1; i <= 130; i++) messages.push(await s.seal(String(i).padStart(4, '0')))
        s.messages.set(s.topicID, messages)
        s.peer.retryAppDelivery()
        await staged.promise
        expect(s.unwrap).not.toHaveBeenCalled()
        let dropped: unknown
        void s.peer.dropAppFrame(s.topicID, '0001').then(
          () => {
            dropped = 'dropped'
          },
          (error) => {
            dropped = error
          },
        )
        await vi.waitFor(() => expect(dropped).toMatchObject({ message: 'app frame is pending' }))
        expect(handler).not.toHaveBeenCalled()
        stageRelease.resolve()
        await vi.waitFor(async () =>
          expect(await s.group.access().pending.list()).toHaveLength(130),
        )
        expect(open.mock.results).toHaveLength(3)
        const results = await Promise.all(open.mock.results.map((result) => result.value))
        expect(results.map((result) => result.consumed)).toEqual([64, 64, 2])
        expect(s.unwrap).not.toHaveBeenCalled()
        release.resolve()
        await vi.waitFor(
          async () => expect(await s.group.access().pending.list()).toHaveLength(0),
          { timeout: 5000 },
        )
        expect(handler).toHaveBeenCalledTimes(130)
        expect(s.completed).toHaveBeenCalledTimes(130)
        expect(await s.ports.cursor.load(s.topicID)).toBe('0130')
      } finally {
        stageRelease.resolve()
        release.resolve()
        clock.mockRestore()
        await s.close()
      }
    })

    test('later completion retains live coverage until the earlier prefix closes', async () => {
      const release = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const handler = vi.fn(async () => {
        entered.resolve()
        await release.promise
      })
      const s = await setup(mode, handler)
      try {
        const a = await s.seal('10')
        const bInput = await s.seal('2')
        const future = await s.group.sealFuture(
          encodeEventFrame('posted'),
          1,
          encodeAppAAD({ topicID: s.topicID, intent: 'log' }),
        )
        s.messages.set(s.topicID, [a, bInput, { sequenceID: '20', payload: future }])
        s.peer.retryAppDelivery()
        await entered.promise
        await vi.waitFor(async () => expect(await s.group.access().pending.list()).toHaveLength(2))
        const records = await s.group.access().pending.list()
        const b = records.find((record) => record.frame.position === '2')
        if (b === undefined) throw new Error('Missing B')
        await s.completion.complete([b.frame.id])
        expect(await s.ports.cursor.load(s.topicID)).toBeNull()
        expect(await s.group.access().pending.list()).toHaveLength(1)
        release.resolve()
        await vi.waitFor(async () => expect(await s.ports.cursor.load(s.topicID)).toBe('2'))
        expect(handler).toHaveBeenCalledTimes(1)
        await s.group.reopen()
        expect(await s.group.fixture().device.groups.ports(s.key).cursor.load(s.topicID)).toBe('2')
        expect(await s.group.access().pending.list()).toEqual([])
        const reopened = await setup(mode, handler, ['chat'], s.group, s.messages)
        try {
          expect(
            reopened.fetch.mock.calls.some(
              ([request]) => request.topicID === s.topicID && request.after === '2',
            ),
          ).toBe(true)
          expect(handler).toHaveBeenCalledTimes(1)
          expect(await reopened.group.access().pending.list()).toEqual([])
        } finally {
          await reopened.peer.dispose()
          await reopened.peer.drained()
        }
      } finally {
        release.resolve()
        await s.close()
      }
    })

    test.each(['default', 'transactional'] as const)(
      'completion behind a held occurrence survives its row removal / %s',
      async (policy) => {
        for (const earlierPending of [false, true]) {
          let time = Date.now()
          const clock = vi.spyOn(Date, 'now').mockImplementation(() => time)
          const release = Promise.withResolvers<void>()
          const handler = vi.fn(async () => release.promise)
          const effect = vi.fn(async (tx: MemoryTransaction) => {
            await writeSideRow(tx, 'held-suffix-effect', new Uint8Array([2]))
          })
          const s = await setup(mode, handler)
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
          try {
            const first = earlierPending ? [await s.seal('1')] : []
            const b = await s.seal('2')
            const a = await s.group.sealFuture(
              encodeEventFrame('posted'),
              1,
              encodeAppAAD({ topicID: s.topicID, intent: 'log' }),
            )
            s.messages.set(s.topicID, [...first, { sequenceID: '10', payload: a }, b])
            s.peer.retryAppDelivery()
            await vi.waitFor(async () =>
              expect(await s.group.access().pending.list()).toHaveLength(earlierPending ? 2 : 1),
            )
            if (earlierPending) await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
            const ids = [frameID(s.topicID, b.payload)]
            if (policy === 'transactional') await s.completion.transact(ids, effect)
            else await s.completion.complete(ids)
            expect(await s.ports.cursor.load(s.topicID)).toBeNull()
            expect(await s.group.access().pending.list()).toHaveLength(earlierPending ? 1 : 0)
            expect(handler).toHaveBeenCalledTimes(earlierPending ? 1 : 0)
            release.resolve()
            if (earlierPending) {
              await vi.waitFor(async () => expect(await s.ports.cursor.load(s.topicID)).toBe('1'))
              expect(await s.group.access().pending.list()).toEqual([])
            }
            time += 30_000
            await vi.advanceTimersByTimeAsync(30_000)
            await vi.waitFor(async () => expect(await s.ports.cursor.load(s.topicID)).toBe('2'))
            expect(handler).toHaveBeenCalledTimes(earlierPending ? 1 : 0)
            expect(effect).toHaveBeenCalledTimes(policy === 'transactional' ? 1 : 0)
            expect(
              Object.values(await s.f.inspectRows()).flatMap((rows) =>
                rows.has('held-suffix-effect') ? [rows.get('held-suffix-effect')] : [],
              ),
            ).toEqual(policy === 'transactional' ? [new Uint8Array([2])] : [])
            vi.useRealTimers()
            await s.peer.dispose()
            await s.peer.drained()
            await s.group.reopen()
            const reopened = await setup(mode, handler, ['chat'], s.group, s.messages)
            try {
              expect(
                reopened.fetch.mock.calls.some(
                  ([request]) => request.topicID === s.topicID && request.after === '2',
                ),
              ).toBe(true)
              expect(await reopened.group.access().pending.list()).toEqual([])
              expect(handler).toHaveBeenCalledTimes(earlierPending ? 1 : 0)
              expect(effect).toHaveBeenCalledTimes(policy === 'transactional' ? 1 : 0)
            } finally {
              await reopened.peer.dispose()
              await reopened.peer.drained()
            }
          } finally {
            release.resolve()
            vi.useRealTimers()
            clock.mockRestore()
            await s.close()
          }
        }
      },
    )

    test('coverage capture cannot deadlock completion behind app mutex', async () => {
      const release = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const s = await setup(mode, async () => {
        entered.resolve()
        await release.promise
      })
      try {
        s.messages.set(s.topicID, [await s.seal('10'), await s.seal('2')])
        s.peer.retryAppDelivery()
        await entered.promise
        await vi.waitFor(async () => expect(await s.group.access().pending.list()).toHaveLength(2))
        const b = (await s.group.access().pending.list()).find(
          (record) => record.frame.position === '2',
        )
        if (b === undefined) throw new Error('Missing B')
        s.f.onPhase('before-work', () => {
          s.peer.retryAppDelivery()
        })
        await s.completion.complete([b.frame.id])
        expect(await s.group.access().pending.list()).toHaveLength(1)
        expect(await s.ports.cursor.load(s.topicID)).toBeNull()
        release.resolve()
        await vi.waitFor(async () => expect(await s.ports.cursor.load(s.topicID)).toBe('2'))
      } finally {
        release.resolve()
        await s.close()
      }
    })

    test('one peer discovers both ready protocols before awaiting a source', async () => {
      const s = await setup(mode, async () => {}, ['A', 'B'])
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      try {
        const anchor = (await s.ports.anchor.load())?.anchor
        if (anchor === undefined) throw new Error('Missing anchor')
        const topics = ['A', 'B'].map((name) => protocolTopic(anchor.secret, anchor.epoch, name))
        for (const topic of topics) {
          const payload = await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
            aad: encodeAppAAD({ topicID: topic, intent: 'log' }),
          })
          s.messages.set(topic, [{ sequenceID: '1', payload }])
        }
        let stages = 0
        s.group.observeStage(async () => {
          if (++stages === 1) {
            started.resolve()
            await release.promise
          }
        })
        const binding = appBatch(s.groupCrypto)
        if (binding === undefined) throw new Error('Missing binding')
        const advertised = vi.spyOn(binding.scheduler, 'schedule')
        const opened = vi.spyOn(binding, 'openReady')
        s.peer.retryAppDelivery()
        await started.promise
        expect(
          advertised.mock.calls.some(([work]) => work.source.includes(topics[1] as string)),
        ).toBe(true)
        const topicA = topics[0] as string
        const more = await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
          aad: encodeAppAAD({ topicID: topicA, intent: 'log' }),
        })
        s.messages.get(topicA)?.push({ sequenceID: '2', payload: more })
        s.peer.retryAppDelivery()
        release.resolve()
        await vi.waitFor(() => expect(opened.mock.calls.length).toBeGreaterThanOrEqual(2))
        expect(opened.mock.calls.slice(0, 2).map(([inputs]) => inputs[0]?.frame.protocol)).toEqual([
          'A',
          'B',
        ])
      } finally {
        release.resolve()
        await s.close()
      }
    })

    test('future expiry alone requests rowless completion', async () => {
      let time = Date.now()
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => time)
      const s = await setup(mode, async () => {
        throw new Error('Future handler')
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const two = await s.group.sealFuture(
          encodeEventFrame('posted'),
          2,
          encodeAppAAD({ topicID: s.topicID, intent: 'log' }),
        )
        const three = await s.group.sealFuture(
          encodeEventFrame('posted'),
          1,
          encodeAppAAD({ topicID: s.topicID, intent: 'log' }),
        )
        s.messages.set(s.topicID, [
          { sequenceID: '10', payload: three },
          { sequenceID: '2', payload: two },
        ])
        s.peer.retryAppDelivery()
        await vi.advanceTimersByTimeAsync(0)
        await vi.waitFor(async () => expect(await s.ports.cursor.load(s.topicID)).toBe('10'))
        time += 29_999
        await vi.advanceTimersByTimeAsync(29_999)
        expect(await s.ports.cursor.load(s.topicID)).toBe('10')
        time += 1
        await vi.advanceTimersByTimeAsync(1)
        await vi.waitFor(async () => expect(await s.ports.cursor.load(s.topicID)).toBe('2'))
        expect(await s.group.access().pending.list()).toEqual([])
      } finally {
        vi.useRealTimers()
        clock.mockRestore()
        await s.close()
      }
    })

    test('dead prefix prunes poison in the cursor transaction', async () => {
      const release = Promise.withResolvers<void>()
      const s = await setup(mode, async () => release.promise)
      try {
        const malformed = await s.group.sender.handle.encrypt(new TextEncoder().encode('{}'), {
          aad: encodeAppAAD({ topicID: s.topicID, intent: 'log' }),
        })
        s.messages.set(s.topicID, [{ sequenceID: '10', payload: malformed }, await s.seal('2')])
        const binding = appBatch(s.groupCrypto)
        if (binding === undefined) throw new Error('Missing binding')
        const open = binding.openReady.bind(binding)
        const faultReady = Promise.withResolvers<{
          rejected: Promise<void>
          finish(outcome: 'commit' | 'rollback'): Promise<void>
        }>()
        vi.spyOn(binding, 'openReady').mockImplementationOnce(async (...args) => {
          const result = await open(...args)
          faultReady.resolve(s.f.armNextWorkFault('pending'))
          return result
        })
        s.peer.retryAppDelivery()
        const fault = await faultReady.promise
        await fault.rejected
        const capability = entryCapability(s.f.device.groups)
        if (capability === null) throw new Error('Missing entry')
        // Root reads cannot join unresolved ownership; inspect only after rollback.
        await fault.finish('rollback')
        expect(await s.ports.cursor.load(s.topicID)).toBeNull()
        expect(
          (
            await capability.read(s.key.groupID, (reads) =>
              reads.appFrame(s.key.incarnation, frameID(s.topicID, malformed)),
            )
          ).poison,
        ).not.toBeNull()
        s.peer.retryAppDelivery()
        await vi.waitFor(async () => expect(await s.ports.cursor.load(s.topicID)).toBe('10'))
        expect(
          (
            await capability.read(s.key.groupID, (reads) =>
              reads.appFrame(s.key.incarnation, frameID(s.topicID, malformed)),
            )
          ).poison,
        ).toBeNull()
      } finally {
        release.resolve()
        await s.close()
      }
    })

    test('rowless dead-only peer prefix commits its cursor and survives reopen', async () => {
      const handler = vi.fn(async () => {})
      const s = await setup(mode, handler)
      try {
        const wrong = await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
          aad: encodeAppAAD({ topicID: 'wrong-topic', intent: 'log' }),
        })
        s.messages.set(s.topicID, [
          { sequenceID: '10', payload: wrong },
          { sequenceID: '2', payload: new Uint8Array([255]) },
          { sequenceID: '20', payload: new Uint8Array([0]) },
          { sequenceID: '3', payload: new Uint8Array() },
        ])
        const before = await s.f.inspectRows()
        const binding = appBatch(s.groupCrypto)
        if (binding === undefined) throw new Error('Missing binding')
        const open = binding.openReady.bind(binding)
        const scheduled = vi.spyOn(binding.scheduler, 'schedule')
        const settle = async () => {
          for (let turn = 0; turn < 4; turn++) {
            for (let microtask = 0; microtask < 30; microtask++) await Promise.resolve()
            await Promise.allSettled(scheduled.mock.results.map((result) => result.value))
          }
        }
        const ready = Promise.withResolvers<{ disarm(): void }>()
        const opened = vi.spyOn(binding, 'openReady').mockImplementationOnce(async (...args) => {
          const result = await open(...args)
          ready.resolve(s.f.armNextWorkFault('before-commit'))
          return result
        })
        s.peer.retryAppDelivery()
        await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce())
        const fault = await ready.promise
        await settle()
        expect(await s.f.inspectRows()).toEqual(before)
        expect(await s.ports.cursor.load(s.topicID)).toBeNull()
        expect(handler).not.toHaveBeenCalled()
        fault.disarm()
        s.peer.retryAppDelivery()
        await settle()
        expect(await s.ports.cursor.load(s.topicID)).toBe('3')
        expect(handler).not.toHaveBeenCalled()
        expect(s.completed).not.toHaveBeenCalled()
        expect(await s.group.access().pending.list()).toEqual([])
        await s.group.reopen()
        expect(await s.group.fixture().device.groups.ports(s.key).cursor.load(s.topicID)).toBe('3')
        const reopened = await setup(mode, handler, ['chat'], s.group, s.messages)
        try {
          expect(
            reopened.fetch.mock.calls.some(
              ([request]) => request.topicID === s.topicID && request.after === '3',
            ),
          ).toBe(true)
          expect(handler).not.toHaveBeenCalled()
          expect(await reopened.group.access().pending.list()).toEqual([])
        } finally {
          await reopened.peer.dispose()
          await reopened.peer.drained()
        }
      } finally {
        await s.close()
      }
    })
  })
