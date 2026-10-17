import { encodeEventFrame } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'

import type { Anchor, AnchorSlot } from '../src/anchor.js'
import { encodeAppAAD } from '../src/app-aad.js'
import { RETAINED_EPOCHS_MAX } from '../src/app-frame.js'
import type * as AppLaneModule from '../src/app-lane.js'
import { type AppLaneParams, createAppLane } from '../src/app-lane.js'
import { AppFrameStorageError, FrameEpochError, type PendingAppFrame } from '../src/crypto.js'
import { asLogPosition } from '../src/cursor.js'
import { adaptBusHandlers } from '../src/handlers.js'
import { AppFetchBusyError, createHubMux } from '../src/hub-mux.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  buildRemoveCommit,
  chat,
  makeMLSPeer,
} from './fixtures/peer.js'

const captured = vi.hoisted(
  () => [] as Array<{ lane: ReturnType<typeof createAppLane>; params: AppLaneParams }>,
)
vi.mock('../src/app-lane.js', async (original) => {
  const module = await original<typeof AppLaneModule>()
  return {
    ...module,
    createAppLane(params: AppLaneParams) {
      const lane = module.createAppLane(params)
      captured.push({ lane, params })
      return lane
    },
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  captured.length = 0
})
const at = (epoch: number): Anchor => ({ epoch, secret: fakeEpochSecret(epoch, APP_TOPIC_LABEL) })
const topic = (epoch: number) => protocolTopic(at(epoch).secret, epoch, 'chat')
const pos = (n: number) => String(n).padStart(12, '0')
const empty = () => ({ messages: [], head: null, oldest: null, gap: false })
const recoverySecret = new Uint8Array(32).fill(0xb4)
const members = ['alice', 'bob', 'carol']

function fixture(
  options: Pick<AppLaneParams, 'scheduleDrain' | 'scheduleDelivery'> & { durable?: boolean } = {},
) {
  let anchor = at(1)
  let applied = 1
  let departing: NonNullable<AnchorSlot['departing']> = []
  const rows = new Map<string, PendingAppFrame>()
  const saved: Array<PendingAppFrame> = []
  const reader = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    retainedEpochs: RETAINED_EPOCHS_MAX,
    pending:
      options.durable === false
        ? undefined
        : {
            async persistOpened(_state, record) {
              rows.set(record.frame.id, record)
              saved.push(record)
            },
            async list() {
              return [...rows.values()]
            },
            async complete(id) {
              rows.delete(id)
            },
          },
  })
  const seen: Array<string> = []
  const handlers = adaptBusHandlers(chat, {
    'chat/posted': ({ data }: { data: { text: string } }) => {
      seen.push(data.text)
    },
  }).events
  const hub = new DurableFakeHub()
  const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
  const cursor = createMemoryAppCursorStore()
  const stalled = vi.fn()
  const resumed = vi.fn()
  const pruned = vi.fn()
  const lane = createAppLane({
    mux,
    crypto: reader,
    appliedEpoch: () => applied,
    localDID: 'bob',
    protocols: { chat },
    eventHandlers: new Map([['chat', handlers]]),
    retentionSeconds: 60,
    appCursorStore: cursor,
    onAppDeliveryStalled: stalled,
    onAppDeliveryResumed: resumed,
    onAppWindowPruned: pruned,
    anchor: () => anchor,
    groupID: () => 'group',
    departing: () => departing,
    scheduleDrain: options.scheduleDrain,
    scheduleDelivery: options.scheduleDelivery,
  })
  onTestFinished(() => {
    lane.dispose()
    mux.dispose()
  })
  const advance = (epoch: number) => {
    reader.setEpoch(epoch)
    applied = epoch
  }
  const rotate = (epoch: number) => {
    departing = [...departing, { anchor, departedAt: epoch }].slice(-RETAINED_EPOCHS_MAX)
    anchor = at(epoch)
    advance(epoch)
  }
  const send = async (anchorEpoch: number, epoch: number, text: string, senderDID = text) => {
    const topicID = topic(anchorEpoch)
    const sender = createFakeCrypto({ epoch, localDID: senderDID })
    const payload = await sender.wrap(encodeEventFrame('chat/posted', { text }), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    })
    await hub.publish({ senderDID, topicID, retain: 'log', payload })
    return payload
  }
  return {
    lane,
    reader,
    hub,
    mux,
    cursor,
    stalled,
    resumed,
    pruned,
    rows,
    saved,
    seen,
    advance,
    rotate,
    send,
  }
}

function peerFixture() {
  const hub = new DurableFakeHub()
  const seen: Array<string> = []
  const pruned = vi.fn()
  const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
    members,
    onAppWindowPruned: pruned,
    handlers: {
      'chat/posted': ({ data }: { data: { text: string } }) => {
        seen.push(data.text)
      },
    },
  })
  onTestFinished(() => bob.peer.dispose())
  return { hub, seen, bob, pruned }
}
const currentLane = () => {
  const found = captured.at(-1)
  if (found == null) throw new Error('missing app lane')
  return found
}
const publishOld = async (hub: DurableFakeHub, text: string) => {
  const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  await hub.publish({
    senderDID: 'alice',
    topicID: topic(1),
    retain: 'log',
    payload: await sender.wrap(encodeEventFrame('chat/posted', { text }), {
      aad: encodeAppAAD({ topicID: topic(1), intent: 'log' }),
    }),
  })
}

describe('departing app topics', () => {
  test('delayed old-topic frame delivers across a roster change', async () => {
    const f = fixture()
    await f.send(1, 1, 'old')
    f.rotate(2)
    await f.send(2, 2, 'new')
    await f.lane.deliver()
    await expect.poll(() => f.seen).toEqual(['old', 'new'])
    expect(f.saved.map((record) => record.frame.segment)).toEqual([1, 2])
    await f.lane.deliver()
    expect(f.seen).toEqual(['old', 'new'])
  })

  test('departing topic survives restart', async () => {
    const { hub, bob, seen } = peerFixture()
    await bob.peer.replay()
    await bob.peer.commit(buildRemoveCommit(bob, 'carol'))
    await bob.peer.dispose()
    hub.detach('bob')
    await publishOld(hub, 'after crash')
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      handlers: {
        'chat/posted': ({ data }: { data: { text: string } }) => {
          seen.push(data.text)
        },
      },
    })
    onTestFinished(() => restarted.peer.dispose())
    await restarted.peer.replay()
    await expect.poll(() => seen).toEqual(['after crash'])
  })

  test('departing topic survives a key-only advance and restart', async () => {
    const { hub, bob, seen } = peerFixture()
    await bob.peer.replay()
    await bob.peer.commit(buildRemoveCommit(bob, 'carol'))
    const before = (await bob.anchorStore.load())?.departing
    let pending: AnchorSlot | undefined
    const save = bob.anchorStore.save.bind(bob.anchorStore)
    vi.spyOn(bob.anchorStore, 'save').mockImplementation(async (slot) => {
      await save(slot)
      if (slot.pending != null) pending = structuredClone(slot)
    })
    await bob.peer.enqueue(
      buildLedgerCommit(bob, [], {
        onAdopt: async () => {
          throw new Error('crash')
        },
      }),
    )
    await expect.poll(() => pending?.pending).toBeDefined()
    expect(before).toEqual([{ anchor: at(1), departedAt: 2 }])
    expect(pending?.departing).toEqual(before)
    await bob.peer.dispose()
    hub.detach('bob')
    await publishOld(hub, 'after pending save')
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      handlers: {
        'chat/posted': ({ data }: { data: { text: string } }) => {
          seen.push(data.text)
        },
      },
    })
    onTestFinished(() => restarted.peer.dispose())
    await restarted.peer.replay()
    await expect.poll(() => seen).toEqual(['after pending save'])
  })

  test('keepAnchor keeps departing', async () => {
    const { bob } = peerFixture()
    await bob.peer.replay()
    await bob.peer.commit(buildRemoveCommit(bob, 'carol'))
    const before = (await bob.anchorStore.load())?.departing
    await bob.peer.enqueue(
      buildLedgerCommit(bob, [], {
        onAdopt: async () => {
          throw new Error('unlanded')
        },
      }),
    )
    await expect.poll(async () => (await bob.anchorStore.load())?.pending).toBeDefined()
    await bob.peer.dispose()
    const restarted = makeMLSPeer(new DurableFakeHub(), 'bob', recoverySecret, { restartOf: bob })
    onTestFinished(() => restarted.peer.dispose())
    await restarted.peer.replay()
    expect((await bob.anchorStore.load())?.departing).toEqual([{ anchor: at(1), departedAt: 2 }])
    expect((await bob.anchorStore.load())?.departing).toEqual(before)
  })

  test('landed proof keeps departing in a peer-written pending slot', async () => {
    const { bob } = peerFixture()
    await bob.peer.replay()
    await bob.peer.commit(buildRemoveCommit(bob, 'carol'))
    const before = (await bob.anchorStore.load())?.departing
    const adopt = bob.mls.adoptOperation.bind(bob.mls)
    let landed: AnchorSlot | null = null
    vi.spyOn(bob.mls, 'adoptOperation').mockImplementation(async (...args) => {
      const result = await adopt(...args)
      landed = await bob.anchorStore.load()
      return result
    })
    await bob.peer.commit(buildLedgerCommit(bob, []))
    expect(landed).toMatchObject({
      pending: { landed: true },
      departing: [{ anchor: at(1), departedAt: 2 }],
    })
    expect((await bob.anchorStore.load())?.departing).toEqual(before)
  })

  test('empty page then revealed frame', async () => {
    const f = fixture()
    f.rotate(2)
    const fetch = vi.spyOn(f.hub, 'fetchTopic')
    await f.lane.deliver()
    expect(fetch.mock.calls.some(([request]) => request.topicID === topic(1))).toBe(true)
    await f.send(1, 1, 'revealed')
    await f.lane.deliver()
    await expect.poll(() => f.seen).toEqual(['revealed'])
  })

  test('late honest publication on the old topic is delivered', async () => {
    const f = fixture()
    await f.lane.deliver()
    f.rotate(2)
    await f.lane.deliver()
    f.advance(4)
    await f.send(1, 1, 'late')
    await f.lane.deliver()
    await expect.poll(() => f.seen).toEqual(['late'])
  })

  test('applied epoch refreshes when a walk applied a commit then threw', async () => {
    const { bob, hub } = peerFixture()
    await bob.peer.replay()
    const { params } = currentLane()
    hub.detach('bob')
    const landed = await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    const read = bob.mls.readEpoch.bind(bob.mls)
    let failures = 0
    vi.spyOn(bob.mls, 'readEpoch').mockImplementation(async () => {
      const epoch = await read()
      if (epoch === 2 && failures++ < 2) throw new Error('epoch read temporarily unavailable')
      return epoch
    })
    await expect(
      bob.controlWalk.walkCommits({
        through: asLogPosition(landed.sequenceID),
        range: null,
        work: { takeFetch: () => true, takeFrame: () => true },
      }),
    ).rejects.toThrow('epoch read temporarily unavailable')
    expect(bob.mls.epoch()).toBe(2)
    expect(params.appliedEpoch()).toBe(2)
  })

  test('a failed epoch refresh preserves the original walk error', async () => {
    const { bob, hub } = peerFixture()
    await bob.peer.replay()
    hub.detach('bob')
    const landed = await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    const walkError = new Error('walk observation failed')
    const refreshError = new Error('final epoch refresh failed')
    const read = bob.mls.readEpoch.bind(bob.mls)
    let failures = 0
    vi.spyOn(bob.mls, 'readEpoch').mockImplementation(async () => {
      const epoch = await read()
      if (epoch === 2) throw failures++ < 2 ? walkError : refreshError
      return epoch
    })
    await expect(
      bob.controlWalk.walkCommits({
        through: asLogPosition(landed.sequenceID),
        range: null,
        work: { takeFetch: () => true, takeFrame: () => true },
      }),
    ).rejects.toBe(walkError)
    expect(failures).toBe(3)
  })

  test('a successful walk still rejects when its epoch refresh fails', async () => {
    const { bob } = peerFixture()
    await bob.peer.replay()
    const refreshError = new Error('final epoch refresh failed')
    vi.spyOn(bob.mls, 'readEpoch').mockRejectedValue(refreshError)
    await expect(
      bob.controlWalk.walkCommits({
        through: null,
        range: null,
        work: { takeFetch: () => true, takeFrame: () => true },
      }),
    ).rejects.toBe(refreshError)
  })

  test.each([-1, 0, 1])('expiry boundary ignores epoch hint offset %s', async (offset) => {
    const { bob, hub } = peerFixture()
    await bob.peer.replay()
    const { lane, params } = currentLane()
    await publishOld(hub, 'cursor before pruning')
    await lane.deliver()
    await expect.poll(() => params.appCursorStore?.load(topic(1))).toBe(pos(1))
    await bob.peer.commit(buildRemoveCommit(bob, 'carol'))
    let reportedPruned: Map<unknown, unknown> | undefined
    const set = Map.prototype.set
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      if (key === topic(1) && value instanceof Set) reportedPruned = this
      return set.call(this, key, value)
    })
    const fetchTopic = params.mux.fetchTopic.bind(params.mux)
    const fetch = vi
      .spyOn(params.mux, 'fetchTopic')
      .mockImplementation((request) =>
        request.topicID === topic(1)
          ? Promise.resolve({ ...empty(), head: pos(5), oldest: pos(5), gap: true })
          : fetchTopic(request),
      )
    for (let epoch = 3; epoch <= 33; epoch++) await bob.peer.commit(buildLedgerCommit(bob, []))
    const epoch = bob.crypto.epoch
    const setEpochHintOffset = (offset: number) =>
      vi.spyOn(bob.crypto, 'epoch').mockImplementation(() => epoch() + offset)
    const hint = setEpochHintOffset(offset)
    fetch.mockClear()
    await lane.deliver()
    expect(params.appliedEpoch()).toBe(33)
    expect(fetch.mock.calls.some(([request]) => request.topicID === topic(1))).toBe(true)
    expect(reportedPruned?.has(topic(1))).toBe(true)
    hint.mockRestore()
    await bob.peer.commit(buildLedgerCommit(bob, []))
    setEpochHintOffset(offset)
    fetch.mockClear()
    await lane.deliver()
    expect(params.appliedEpoch()).toBe(34)
    expect(fetch.mock.calls.some(([request]) => request.topicID === topic(1))).toBe(false)
    expect(reportedPruned?.has(topic(1))).toBe(false)
  })

  test('trimming at 33 rotations', async () => {
    const { bob } = peerFixture()
    await bob.peer.replay()
    for (let epoch = 2; epoch <= 34; epoch++)
      await bob.peer.commit(buildInviteCommit(bob, `member-${epoch}`))
    expect((await bob.anchorStore.load())?.departing).toEqual(
      Array.from({ length: 32 }, (_, i) => ({ anchor: at(i + 2), departedAt: i + 3 })),
    )
  })

  test('expiry clears staged and buffered bookkeeping before caught-up times are applied', async () => {
    const f = fixture({ durable: false, scheduleDrain: async () => {} })
    const oldTopic = topic(1)
    const topicMaps: Array<Map<unknown, unknown>> = []
    let times: Map<unknown, unknown> | undefined
    let lastTopicSet: Set<unknown> | undefined
    let retained: Set<unknown> | undefined
    let busyTopics: Set<unknown> | undefined
    const set = Map.prototype.set
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      if (key === oldTopic) topicMaps.push(this)
      if (typeof key === 'object' && key != null && 'sealed' in key && typeof value === 'number')
        times = this
      return set.call(this, key, value)
    })
    const add = Set.prototype.add
    vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value) {
      if (value === oldTopic) lastTopicSet = this
      return add.call(this, value)
    })
    const retain = f.mux.retainTopic.bind(f.mux)
    vi.spyOn(f.mux, 'retainTopic').mockImplementation((topicID, options) => {
      if (topicID === oldTopic) retained = lastTopicSet
      retain(topicID, options)
    })
    vi.spyOn(f.mux, 'onAppFetchAvailable').mockImplementation(() => {
      busyTopics = lastTopicSet
      return () => {}
    })
    const payload = await f.send(1, 2, 'buffered future')
    await f.lane.deliver()
    const segment = topicMaps.find(
      (map) => (map.get(oldTopic) as Array<{ sealed?: unknown }> | undefined)?.[0]?.sealed != null,
    )
    const cursors = topicMaps.find(
      (map) => (map.get(oldTopic) as { anchorEpoch?: number } | undefined)?.anchorEpoch === 1,
    )
    vi.spyOn(f.mux, 'fetchTopic').mockRejectedValueOnce(new AppFetchBusyError())
    await f.lane.deliver()
    expect(segment?.has(oldTopic)).toBe(true)
    expect(cursors?.has(oldTopic)).toBe(true)
    expect(retained?.has(oldTopic)).toBe(true)
    expect(busyTopics?.has(oldTopic)).toBe(true)

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.mocked(f.mux.fetchTopic).mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return empty()
    })
    f.lane.note(
      'chat',
      oldTopic,
      {
        topicID: oldTopic,
        senderDID: 'alice',
        payload,
        sequenceID: pos(5),
        logPosition: pos(5),
      },
      new FrameEpochError(2, 1),
    )
    const staged = topicMaps.find(
      (map) => (map.get(oldTopic) as Array<{ frame?: unknown }> | undefined)?.[0]?.frame != null,
    )
    expect(staged?.has(oldTopic)).toBe(true)
    expect(times?.size).toBe(2)
    const clear = Map.prototype.clear
    let generalClears = 0
    vi.spyOn(Map.prototype, 'clear').mockImplementation(function (this: Map<unknown, unknown>) {
      if (this === times) generalClears++
      clear.call(this)
    })
    f.rotate(2)
    f.advance(34)
    await entered.promise
    try {
      expect(generalClears).toBe(0)
      expect(times?.size).toBe(0)
      expect(segment?.has(oldTopic)).toBe(false)
      expect(cursors?.has(oldTopic)).toBe(false)
      expect(staged?.has(oldTopic)).toBe(false)
      expect(retained?.has(oldTopic)).toBe(false)
      expect(busyTopics?.has(oldTopic)).toBe(false)
    } finally {
      release.resolve()
    }
    await f.lane.deliver()
  })

  test('expiry settles stall bookkeeping over 40 cycles', async () => {
    const f = fixture()
    const push = Array.prototype.push
    let peakNotices = 0
    Object.defineProperty(Array.prototype, 'push', {
      value: function <T>(this: Array<T>, ...items: Array<T>): number {
        const size = push.apply(this, items)
        if (items.some((item) => typeof item === 'function' && item.name === 'notify')) {
          peakNotices = Math.max(peakNotices, size)
        }
        return size
      },
    })
    onTestFinished(() => {
      Object.defineProperty(Array.prototype, 'push', { value: push })
    })

    let blocking: Map<unknown, unknown> | undefined
    let times: Map<unknown, unknown> | undefined
    let pruned: Map<unknown, unknown> | undefined
    const setMaps: Array<Map<unknown, unknown>> = []
    const set = Map.prototype.set
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      if (typeof key === 'string' && key.includes('\u0000')) blocking = this
      if (typeof key === 'object' && key != null && 'sealed' in key && typeof value === 'number')
        times = this
      if (value instanceof Set) setMaps.push(this)
      return set.call(this, key, value)
    })
    for (let cycle = 0; cycle < 40; cycle++) {
      const epoch = 1 + cycle * 34
      if (cycle > 0) f.rotate(epoch)
      await f.cursor.save(topic(epoch), pos(1))
      const payload = await f.send(epoch, epoch + 1, `future-${cycle}`)
      vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async ({ topicID }) =>
        topicID === topic(epoch)
          ? {
              messages: [{ topicID, payload, senderDID: 'alice', sequenceID: pos(5) }],
              head: pos(5),
              oldest: pos(5),
              gap: true,
            }
          : empty(),
      )
      await f.lane.deliver()
      pruned = setMaps.find((map) =>
        (map.get(topic(epoch)) as Set<string> | undefined)?.has(pos(1)),
      )
      expect(pruned).toBeDefined()
      expect(blocking?.size).toBe(1)
      f.lane.retryDelivery()
      expect(times?.size).toBe(1)
      await Promise.resolve()
      f.rotate(epoch + 1)
      f.advance(epoch + 33)
      await f.lane.deliver()
      expect(blocking?.size).toBe(0)
      expect(pruned?.has(topic(epoch))).toBe(false)
      expect(times?.size ?? 0).toBe(0)
      expect(f.resumed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          topicID: topic(epoch),
          reason: 'future-epoch',
          settlement: 'expired',
        }),
      )
      expect(f.resumed).toHaveBeenCalledTimes(cycle + 1)
      expect(f.stalled).toHaveBeenCalledTimes(cycle + 1)
      expect(peakNotices).toBeGreaterThan(0)
      expect(peakNotices).toBeLessThanOrEqual(2)
    }
  })

  test.each(['storage', 'future'] as const)(
    'expiry leaves an opened %s-stalled record to settle on completion',
    async (failure) => {
      const starts: Array<() => void> = []
      const f = fixture({
        scheduleDelivery: (start) => {
          starts.push(start)
        },
      })
      await f.send(1, failure === 'future' ? 2 : 1, 'pending delivery')
      if (failure === 'storage') {
        vi.spyOn(f.reader, 'unwrap').mockImplementationOnce(() => {
          throw new AppFrameStorageError('storage unavailable')
        })
        await expect(f.lane.deliver()).rejects.toThrow('storage unavailable')
      } else {
        await f.lane.deliver()
      }
      expect(f.stalled).toHaveBeenCalledTimes(1)
      expect(f.lane.pendingRecords()).toHaveLength(0)
      f.advance(2)
      await f.lane.deliver()
      expect(f.lane.pendingRecords()).toHaveLength(1)
      expect(f.resumed).not.toHaveBeenCalled()
      f.rotate(3)
      f.advance(35)
      await f.lane.deliver()
      expect(f.lane.pendingRecords()).toHaveLength(1)
      expect(f.seen).toEqual([])
      expect(f.resumed).not.toHaveBeenCalled()
      expect(starts.length).toBeGreaterThan(0)
      for (const start of starts) start()
      await expect.poll(() => f.rows.size).toBe(0)
      expect(f.seen).toEqual(['pending delivery'])
      expect(f.resumed).toHaveBeenCalledExactlyOnceWith({
        groupID: 'group',
        protocol: 'chat',
        topicID: topic(1),
        position: pos(1),
        ...(failure === 'future' ? { reason: 'future-epoch' } : {}),
        settlement: 'resumed',
      })
    },
  )

  test('app work never writes the anchor slot, including a capture racing expiry', async () => {
    const { bob } = peerFixture()
    await bob.peer.replay()
    await bob.peer.commit(buildRemoveCommit(bob, 'carol'))
    const { lane, params } = currentLane()
    const save = vi.spyOn(bob.anchorStore, 'save')
    for (let epoch = 3; epoch <= 42; epoch++) {
      await bob.peer.commit(buildLedgerCommit(bob, []))
      const count = save.mock.calls.length
      await lane.deliver()
      expect(save).toHaveBeenCalledTimes(count)
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const persist = bob.anchorStore.save.bind(bob.anchorStore)
    save.mockRestore()
    vi.spyOn(bob.anchorStore, 'save').mockImplementation(async (slot) => {
      if (slot.pending == null && slot.anchor.epoch === 43) {
        entered.resolve()
        await release.promise
      }
      await persist(slot)
    })
    const rotation = bob.peer.commit(buildInviteCommit(bob, 'new-member'))
    await entered.promise
    try {
      const before = await bob.anchorStore.load()
      expect(before?.pending?.landed).toBe(true)
      expect(params.anchor().epoch).toBe(2)
      expect(params.departing?.()).toEqual([{ anchor: at(1), departedAt: 2 }])
      await lane.deliver()
      expect(await bob.anchorStore.load()).toEqual(before)
    } finally {
      release.resolve()
    }
    await rotation
    expect((await bob.anchorStore.load())?.anchor.epoch).toBe(43)
  })

  test('rotation during an awaited unwrap keeps the old segment', async () => {
    const f = fixture()
    await f.send(1, 1, 'gated')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const unwrap = f.reader.unwrap
    vi.spyOn(f.reader, 'unwrap').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return unwrap(...args)
    })
    const delivery = f.lane.deliver()
    await entered.promise
    f.rotate(2)
    release.resolve()
    await delivery
    await expect.poll(() => f.seen).toEqual(['gated'])
    expect(f.saved[0]?.frame.segment).toBe(1)
    await expect.poll(() => f.cursor.load(topic(1))).toBe(pos(1))
    expect(await f.cursor.load(topic(2))).toBeNull()
  })

  test('old sealed frame blocks a newer-segment record with an overlapping token', async () => {
    const f = fixture()
    const payload = await f.send(1, 2, 'old')
    let newPayload: Uint8Array | undefined
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async ({ topicID, after }) => {
      if (after != null) return empty()
      const bytes = topicID === topic(1) ? payload : newPayload
      const position = topicID === topic(1) ? pos(5) : pos(1)
      return bytes == null
        ? empty()
        : {
            messages: [
              {
                topicID,
                payload: bytes,
                senderDID: 'alice',
                sequenceID: position,
              } as StoredMessage,
            ],
            head: position,
            oldest: position,
            gap: false,
          }
    })
    await f.lane.deliver()
    f.rotate(2)
    newPayload = await f.send(2, 2, 'new')
    // Keep the old frame held while the newer segment opens at the same handle epoch.
    const unwrap = f.reader.unwrap
    vi.spyOn(f.reader, 'unwrap').mockImplementation((bytes, options) => {
      if (bytes === payload) throw new FrameEpochError(3, 2)
      return unwrap(bytes, options)
    })
    await f.lane.deliver()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.seen).toEqual([])
    vi.mocked(f.reader.unwrap).mockRestore()
    await f.lane.deliver()
    await expect.poll(() => f.seen).toEqual(['old', 'new'])
    expect(f.saved.map((record) => [record.frame.segment, record.frame.position])).toEqual([
      [2, pos(1)],
      [1, pos(5)],
    ])
  })
})
