import { encodeEventFrame } from '@kumiai/broadcast'
import {
  appBatch,
  asLogPosition,
  bindControlBatch,
  type ControlBatchBinding,
  commitTopic,
  controlBatch,
  encodeAppAAD,
  encodeCommitFrame,
  encodeHandshakeFrame,
  frameID,
  type GroupProcedureHandlers,
  HANDSHAKE_KIND,
  type LogHub,
  protocolTopic,
} from '@kumiai/rpc'
import { createGroupPeerWithControlWalk } from '@kumiai/rpc/testing'
import { describe, expect, test, vi } from 'vitest'

import type * as bufferedControlTypes from '../../rpc/lib/buffered-control.js'
import type { BufferedControlIntake } from '../../rpc/lib/buffered-control.js'
import { createRegistryAppPublication } from '../src/app-publication.js'
import { createControlValidationPort } from '../src/control-validation.js'
import { entryCapability } from '../src/entry-capability.js'
import { createHandlerCompletion } from '../src/handler-completion.js'
import { createLedgerEntrySlot } from '../src/mls.js'
import type { MemoryTransaction } from '../src/persistence-types.js'
import { registryLiveSend } from '../src/registry/live-send.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import {
  createAsyncLocalOwnershipContext,
  openedDeliveryContext,
} from './fixtures/ownership-context.js'
import { registryFixtureObserveRestoredControl } from './fixtures/registry.js'
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
  const actual = controlBatch(mls)
  const controlReady = vi.spyOn(actual ?? recording, 'run')
  if (recordControl) {
    if (actual === undefined) bindControlBatch(mls, recording)
    else controlReady.mockImplementation(recording.run)
  }
  if (startupControl)
    messages.set(commitTopic(await mls.exportRecoverySecret()), [
      { sequenceID: '10', payload: new Uint8Array([255]) },
    ])
  const { peer, controlWalk } = createGroupPeerWithControlWalk({
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
  peer.retryAppDelivery()
  await vi.waitFor(() => {
    for (const name of names) {
      const topic = protocolTopic(anchor.anchor.secret, anchor.anchor.epoch, name)
      expect(fetch.mock.calls.some(([request]) => request.topicID === topic)).toBe(true)
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await scheduler?.schedule({
    source: 'startup-app-pull-settled',
    kind: 'accounting',
    run: async () => {},
  })
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
    controlWalk,
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
    test('explicit buffered prefix reconciliation waits for selected proof', async () => {
      const s = await setup(mode, async () => {})
      try {
        expect((await s.controlWalk.reconcileCommitPrefix()).kind).toBe('complete')
        const topicID = commitTopic(await s.mls.exportRecoverySecret())
        const epoch = s.group.access().epoch()
        const commit = await s.group.prepareCommit()
        s.messages.set(topicID, [
          {
            sequenceID: '10',
            payload: encodeHandshakeFrame(
              HANDSHAKE_KIND.commit,
              encodeCommitFrame(commit, new Uint8Array()),
            ),
          },
        ])
        const prefix = await s.controlWalk.reconcileCommitPrefix()
        expect(prefix.kind).toBe('complete')
        expect(s.group.access().epoch()).toBe(epoch + 1)
        expect(s.controlWalk.head()).toBe('10')
        expect((await s.ports.control.load()).cursor?.position).toBe('10')
      } finally {
        await s.close()
      }
    })
    test.each([false, true])(
      'withheld topic fetch cannot block already-ready peer sources (damaged=%s)',
      async (damaged) => {
        const handlerRelease = Promise.withResolvers<void>()
        const s = await setup(mode, async () => handlerRelease.promise, ['A', 'B'])
        const fetchRelease = Promise.withResolvers<void>()
        let withheld = false
        try {
          const anchor = (await s.ports.anchor.load())!.anchor
          const [a, b] = ['A', 'B'].map((name) => protocolTopic(anchor.secret, anchor.epoch, name))
          if (a === undefined || b === undefined) throw new Error('Missing topics')
          s.messages.set(b, [
            {
              sequenceID: '01',
              payload: await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
                aad: encodeAppAAD({ topicID: b, intent: 'log' }),
              }),
            },
          ])
          s.messages.set(a, [
            {
              sequenceID: '01',
              payload: damaged
                ? new Uint8Array([255])
                : await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
                    aad: encodeAppAAD({ topicID: a, intent: 'log' }),
                  }),
            },
          ])
          const fetch = s.fetch.getMockImplementation()!
          s.fetch.mockImplementation(async (input) => {
            if (input.topicID === a) {
              withheld = true
              await fetchRelease.promise
            }
            return fetch(input)
          })
          const topic = commitTopic(await s.mls.exportRecoverySecret())
          const before = s.group.access().epoch()
          const commit = await s.group.prepareCommit()
          s.peer.retryAppDelivery()
          s.messages.set(topic, [
            {
              sequenceID: '10',
              payload: encodeHandshakeFrame(
                HANDSHAKE_KIND.commit,
                encodeCommitFrame(commit, new Uint8Array()),
              ),
            },
          ])
          await s.hub.publish({
            topicID: topic,
            senderDID: s.group.sender.identity.id,
            payload: new Uint8Array([255]),
            retain: 'log',
          })
          await vi.waitFor(() => expect(withheld).toBe(true))
          await vi.waitFor(() => expect(s.group.access().epoch()).toBe(before + 1))
          await vi.waitFor(async () =>
            expect(
              (await s.group.access().pending.list()).some((row) => row.frame.topicID === b),
            ).toBe(true),
          )
          expect((await s.ports.control.load()).controlHold).toBeNull()
        } finally {
          fetchRelease.resolve()
          handlerRelease.resolve()
          await s.close()
        }
      },
    )
    test('control prerequisites never hold a selected turn across network work', async () => {
      const s = await setup(mode, async () => {}, ['B'])
      const held = Promise.withResolvers<void>()
      const network = Promise.withResolvers<void>()
      const networkEntered = Promise.withResolvers<void>()
      let networkStarted = false
      let bProven = false
      try {
        const scheduler = appBatch(s.groupCrypto)!.scheduler
        const binding = appBatch(s.groupCrypto)!
        const openReady = binding.openReady.bind(binding)
        vi.spyOn(binding, 'openReady').mockImplementation(async (...args) => {
          const result = await openReady(...args)
          bProven = true
          return result
        })
        const started = Promise.withResolvers<void>()
        const turn = scheduler.schedule({
          source: 'held',
          kind: 'open',
          run: async () => {
            started.resolve()
            await held.promise
          },
        })
        await started.promise
        const anchor = (await s.ports.anchor.load())!.anchor
        const topicID = protocolTopic(anchor.secret, anchor.epoch, 'B')
        s.messages.set(topicID, [
          {
            sequenceID: '01',
            payload: await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
              aad: encodeAppAAD({ topicID, intent: 'log' }),
            }),
          },
        ])
        registryFixtureObserveRestoredControl(s.f, (handle) => {
          vi.spyOn(handle, 'isLedgerComplete').mockResolvedValue(false)
        })
        const publish = s.hub.publish.bind(s.hub)
        vi.spyOn(s.hub, 'publish').mockImplementation(async (input) => {
          if (input.payload[3] === HANDSHAKE_KIND.ledgerRequest) {
            networkStarted = true
            networkEntered.resolve()
            await network.promise
          }
          return publish(input)
        })
        const controlTopic = commitTopic(await s.mls.exportRecoverySecret())
        s.messages.set(controlTopic, [{ sequenceID: '10', payload: new Uint8Array([255]) }])
        await s.hub.publish({
          topicID: controlTopic,
          payload: new Uint8Array([0]),
          senderDID: s.group.sender.identity.id,
          retain: 'log',
        })
        s.peer.retryAppDelivery()
        for (let i = 0; i < 80; i++) await Promise.resolve()
        const before = await s.ports.control.load()
        held.resolve()
        await turn
        await networkEntered.promise
        for (let index = 0; index < 100; index++) await Promise.resolve()
        expect(networkStarted).toBe(true)
        expect(bProven).toBe(true)
        expect(await s.ports.control.load()).toEqual(before)
        expect(s.controlReady).toHaveBeenCalledOnce()
      } finally {
        held.resolve()
        network.resolve()
        await s.close()
      }
    })
    for (const accounting of ['ordinary', 'own', 'fallback-supplied', 'fallback-absent'] as const)
      test(
        accounting === 'ordinary'
          ? 'one peer advertises buffered B before replenishing A'
          : accounting === 'own'
            ? 'own accounting cannot bypass buffered control and B'
            : `accounting fallback retains arbitration and cancellation (${accounting})`,
        async () => {
          const releases: Array<() => void> = []
          let proofObserved: (() => void) | undefined
          const fallback = accounting.startsWith('fallback')
          const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
            backgroundMaintenance: 'gated',
            ownershipContext:
              accounting !== 'fallback-absent' ? createAsyncLocalOwnershipContext() : undefined,
            beforeRegistry: fallback
              ? (capability) => {
                  const observe = capability.observe.bind(capability)
                  vi.spyOn(capability, 'observe').mockImplementation(
                    (groupID, onProof, afterRelease) =>
                      observe(groupID, (observation) => {
                        onProof(observation)
                        proofObserved?.()
                        releases.push(() => afterRelease?.(observation))
                      }),
                  )
                }
              : undefined,
          })
          const s = await setup(mode, async () => {}, ['A', 'B'], group)
          const release = Promise.withResolvers<void>()
          const entered = Promise.withResolvers<void>()
          const postRelease = Promise.withResolvers<void>()
          const aProof = Promise.withResolvers<void>()
          let proofReturned = false
          try {
            const binding = controlBatch(s.mls)
            expect(binding).toBeDefined()
            const batch = appBatch(s.groupCrypto)
            if (batch === undefined) throw new Error('Missing app batch')
            const selected: Array<string> = []
            const entries: Array<string> = []
            let selectedSource = ''
            const schedule = batch.scheduler.schedule.bind(batch.scheduler)
            const anchor = (await s.ports.anchor.load())!.anchor
            const topics = ['A', 'B'].map((name) =>
              protocolTopic(anchor.secret, anchor.epoch, name),
            )
            // Source IDs use topic IDs, which are opaque hashes.
            const names = new Map(topics.map((topic, index) => [topic, index === 0 ? 'A' : 'B']))
            selected.length = 0
            vi.spyOn(batch.scheduler, 'schedule').mockImplementation((work) =>
              schedule({
                ...work,
                run: async (budget) => {
                  selectedSource =
                    work.kind === 'control'
                      ? 'control'
                      : work.kind === 'accounting'
                        ? 'Read'
                        : ([...names].find(([topic]) => work.source.includes(topic))?.[1] ??
                          work.kind)
                  selected.push(selectedSource)
                  const source = selectedSource
                  const value = await work.run(budget)
                  if (source === 'A' && fallback) {
                    proofReturned = true
                    await postRelease.promise
                  }
                  return value
                },
              }),
            )
            for (const topicID of topics) {
              const payload = await s.group.sender.handle.encrypt(encodeEventFrame('posted'), {
                aad: encodeAppAAD({ topicID, intent: 'log' }),
              })
              s.messages.set(topicID, [{ sequenceID: '01', payload }])
            }
            let stages = 0
            s.group.observeStage(async () => {
              if (++stages === 1) {
                entered.resolve()
                await release.promise
              }
            })
            const before = s.group.access().epoch()
            const topic = commitTopic(await s.mls.exportRecoverySecret())
            const commit = await s.group.prepareCommit()
            proofObserved = aProof.resolve
            const cap = entryCapability(s.f.device.groups)!
            const originalRun = cap.run.bind(cap)
            vi.spyOn(cap, 'run').mockImplementation((...args) => {
              entries.push(selectedSource)
              return originalRun(...args)
            })
            const originalRead = cap.read.bind(cap)
            const reads = vi.spyOn(cap, 'read').mockImplementation((...args) => {
              entries.push('Read')
              return originalRead(...args)
            })
            s.peer.retryAppDelivery()
            await entered.promise
            s.messages.set(topic, [
              {
                sequenceID: '10',
                payload: encodeHandshakeFrame(
                  HANDSHAKE_KIND.commit,
                  encodeCommitFrame(commit, new Uint8Array()),
                ),
              },
            ])
            await s.hub.publish({
              topicID: topic,
              payload: new Uint8Array([255]),
              senderDID: s.group.sender.identity.id,
              retain: 'log',
            })
            for (let i = 0; i < 80; i++) await Promise.resolve()
            expect(s.controlReady).toHaveBeenCalledOnce()
            expect(reads).not.toHaveBeenCalled()
            release.resolve()
            if (fallback) {
              await aProof.promise
              for (let index = 0; index < 300; index++) await Promise.resolve()
              expect(proofReturned).toBe(true)
              await new Promise((resolve) => setTimeout(resolve, 0))
              expect(reads).not.toHaveBeenCalled()
              expect(entries).toEqual(['A'])
              postRelease.resolve()
            }
            await Promise.all(s.controlReady.mock.results.map((result) => result.value))
            await vi.waitFor(() => expect(s.group.access().epoch()).toBe(before + 1))
            await vi.waitFor(() => expect(stages).toBe(2))
            expect(selected.slice(0, 3)).toEqual(['A', 'control', 'B'])
            expect(entries.slice(0, 3)).toEqual(['A', 'control', 'B'])
            await registryLiveSend.get(s.group.access())!.accounting()
            const beforeLate = selected.filter((source) => source === 'Read').length
            for (const start of releases.splice(0)) start()
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(selected.filter((source) => source === 'Read').length).toBe(beforeLate)
            expect((await s.ports.control.load()).cursor).toMatchObject({
              epoch: before + 1,
              position: '10',
            })
          } finally {
            release.resolve()
            postRelease.resolve()
            for (const start of releases) start()
            registryLiveSend.get(s.group.access())?.cancel(new Error('Witness finished'))
            await s.close()
          }
        },
      )
    test('selected control performs all local prerequisites in its entry', async () => {
      const s = await setup(mode, () => {})
      const roots = [
        vi.spyOn(s.mls, 'readEpoch'),
        vi.spyOn(s.mls, 'readCommitHeader'),
        vi.spyOn(s.mls, 'isLedgerComplete'),
        vi.spyOn(s.mls, 'rosterEntries'),
        vi.spyOn(s.groupCrypto, 'openEntries'),
        vi.spyOn(s.ports.control, 'load'),
        vi.spyOn(s.ports.anchor, 'load'),
      ]
      for (const root of roots)
        root.mockImplementation(() => {
          throw new Error('Root prerequisite admission during selected control')
        })
      try {
        const binding = controlBatch(s.mls)
        expect(binding).toBeDefined()
        if (binding === undefined) throw new Error('Missing selected control binding')
        const cap = entryCapability(s.f.device.groups)
        if (cap === null) throw new Error('Missing entry capability')
        const run = vi.spyOn(cap, 'run')
        const read = vi.spyOn(cap, 'read')
        let expired: (() => Promise<number>) | undefined
        let expiredControl: (() => unknown) | undefined
        const before = s.group.access().epoch()
        const result = await binding.run({
          source: 'local-control',
          prepare: async (scope) => {
            expired = scope.readEpoch
            expiredControl = scope.control
            expect(await scope.readEpoch()).toBe(before)
            expect(await scope.isLedgerComplete()).toBe(true)
            expect(await scope.rosterEntries()).toHaveLength(3)
            expect(scope.source.key).toEqual(s.key)
            expect(scope.control().cursor).toBeNull()
            scope.stageControl(
              { cursor: { position: asLogPosition('01'), epoch: before } },
              'local-control',
            )
            if (scope.anchor() !== null) scope.stageAnchor(scope.anchor()!)
            expect(read).not.toHaveBeenCalled()
            return 'prepared'
          },
        })
        expect(result.value).toBe('prepared')
        expect(result.control.cursor?.position).toBe('01')
        expect(run).toHaveBeenCalledTimes(1)
        for (const root of roots) expect(root).not.toHaveBeenCalled()
        await expect(expired?.()).rejects.toThrow('scope has ended')
        expect(() => expiredControl?.()).toThrow('scope has ended')
      } finally {
        for (const root of roots) root.mockRestore()
        await s.close()
      }
    })
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

    test('held app owner bounds checked control intake and releases every occurrence in order', async () => {
      const intakeModule = (await import(
        new URL('../../rpc/lib/buffered-control.js', import.meta.url).href
      )) as typeof bufferedControlTypes
      let intake: BufferedControlIntake | undefined
      const createIntake = intakeModule.createBufferedControlIntake
      const capture = vi
        .spyOn(intakeModule, 'createBufferedControlIntake')
        .mockImplementation((params) => {
          intake = createIntake(params)
          return intake
        })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const s = await setup(mode, async () => {}, ['chat'], undefined, undefined, true)
      try {
        if (intake === undefined) throw new Error('Missing peer intake')
        const buffered = intake
        const frames = Array.from({ length: 2500 }, (_, index) => ({
          sequenceID: String(index + 1).padStart(6, '0'),
          payload: new Uint8Array([255]),
        }))
        let outstanding = 0
        let maximum = 0
        const offer = buffered.offer.bind(buffered)
        vi.spyOn(buffered, 'offer').mockImplementation((page) => {
          offer(page)
          outstanding += page.result.messages.length
          maximum = Math.max(maximum, outstanding)
        })
        const topicID = commitTopic(await s.mls.exportRecoverySecret())
        s.messages.set(s.topicID, [await s.seal('1')])
        let stages = 0
        s.group.observeStage(async () => {
          if (++stages === 1) {
            entered.resolve()
            await release.promise
          }
        })
        s.peer.retryAppDelivery()
        await entered.promise
        const before = s.fetch.mock.calls.filter(([request]) => request.topicID === topicID).length
        s.messages.set(topicID, frames)
        await s.hub.publish({
          topicID,
          senderDID: s.group.sender.identity.id,
          payload: new Uint8Array([0]),
          retain: 'log',
        })
        for (let i = 0; i < 100; i++) await Promise.resolve()
        expect(outstanding).toBe(200)
        expect(buffered.pageCount()).toBe(2)
        expect(s.fetch.mock.calls.filter(([request]) => request.topicID === topicID)).toHaveLength(
          before + 2,
        )
        expect(s.selectedControl).not.toHaveBeenCalled()
        release.resolve()
        await vi.waitFor(() => expect(s.selectedControl).toHaveBeenCalledOnce())
        // The readiness-only binding leaves acknowledgements to this recording consumer.
        const applied: Array<string> = []
        for (let turn = 0; turn < 40; turn++) {
          let current = buffered.next()
          while (current !== undefined) {
            const position = current.page.result.messages[current.index]?.sequenceID
            if (position === undefined) throw new Error('Missing occurrence')
            applied.push(position)
            outstanding--
            buffered.consumed({ generation: current.page.generation, topicID, position })
            current = buffered.next()
          }
          for (let i = 0; i < 100; i++) await Promise.resolve()
          expect(buffered.pageCount()).toBeLessThanOrEqual(2)
        }
        expect(applied).toEqual(frames.map((frame) => frame.sequenceID))
        expect(maximum).toBe(200)
        expect(outstanding).toBe(0)
      } finally {
        release.resolve()
        capture.mockRestore()
        await s.close()
      }
    })

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
