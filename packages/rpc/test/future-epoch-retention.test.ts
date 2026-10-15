import { encodeEventFrame } from '@kumiai/broadcast'
import type { HubFetchTopicParams, HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { type AppLane, createAppLane } from '../src/app-lane.js'
import { FrameEpochError, type PendingAppFrame } from '../src/crypto.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0xa4)
const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')

function durableBob(hub: DurableFakeHub, options: Parameters<typeof makeMLSPeer>[3] = {}) {
  const rows = new Map<string, PendingAppFrame>()
  const crypto = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    pending: {
      async persistOpened(_state, record) {
        rows.set(record.frame.id, record)
      },
      async list() {
        return [...rows.values()]
      },
      async complete(id) {
        rows.delete(id)
      },
    },
  })
  return makeMLSPeer(hub, 'bob', secret, { ...options, crypto })
}

describe('future-epoch app retention', () => {
  test('an omitted commit cannot move the cursor past an honest next-epoch frame', async () => {
    class OmittingHub extends DurableFakeHub {
      omitForBob = false
      override async fetchTopic(params: HubFetchTopicParams): Promise<HubFetchTopicResult> {
        if (
          this.omitForBob &&
          params.subscriberDID === 'bob' &&
          params.topicID === commitTopic(secret)
        ) {
          return { messages: [], head: null, oldest: null, ...{ gap: false } }
        }
        return super.fetchTopic(params)
      }
    }
    const hub = new OmittingHub()
    const seen = vi.fn()
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => seen(ctx.data) }
    const alice = makeMLSPeer(hub, 'alice', secret)
    const bob = durableBob(hub, { handlers })
    await bob.peer.protocol('chat').to('alice')
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.commit(buildLedgerCommit(alice, []))
    await alice.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'epoch two' } })
    await vi.waitFor(() =>
      expect(hub.published.some((item) => item.topicID === topicID)).toBe(true),
    )
    const frame = hub.published.find((item) => item.topicID === topicID)
    expect(frame).toBeDefined()
    hub.omitForBob = true
    const restarted = makeMLSPeer(hub, 'bob', secret, { restartOf: bob, handlers })
    await restarted.peer.protocol('chat').to('alice')
    expect(restarted.mls.epoch()).toBe(1)
    expect(seen).not.toHaveBeenCalled()
    expect(restarted.appCursorStore.stored(topicID)).toBeNull()

    hub.omitForBob = false
    hub.reattach('bob')
    hub.redeliver('bob')
    await vi.waitFor(() => expect(restarted.mls.epoch()).toBe(2))
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ text: 'epoch two' }))
    expect(restarted.appCursorStore.stored(topicID)).toBe(frame?.sequenceID)
    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  test('a forged far-future frame completes automatically and stays completed across restart', async () => {
    const hub = new DurableFakeHub()
    const notices = vi.fn()
    const seen = vi.fn()
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => seen(ctx.data) }
    const bob = durableBob(hub, { handlers, onAppDeliveryStalled: notices })
    await bob.peer.protocol('chat').to('alice')
    await bob.peer.dispose()
    hub.detach('bob')

    const forged = createFakeCrypto({ epoch: 65535, localDID: 'mallory' })
    const blocked = await hub.publish({
      senderDID: 'mallory',
      topicID,
      retain: 'log',
      payload: await forged.wrap(encodeEventFrame('chat/posted', { text: 'forged' }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
    const restarted = makeMLSPeer(hub, 'bob', secret, {
      restartOf: bob,
      handlers,
      onAppDeliveryStalled: notices,
    })
    await restarted.peer.protocol('chat').to('alice')
    await restarted.peer.replay()
    expect(notices).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
    expect(restarted.appCursorStore.stored(topicID)).toBe(blocked.sequenceID)
    await restarted.peer.dispose()
    const again = makeMLSPeer(hub, 'bob', secret, {
      restartOf: restarted,
      handlers,
      onAppDeliveryStalled: notices,
    })
    await again.peer.protocol('chat').to('alice')
    expect(again.appCursorStore.stored(topicID)).toBe(blocked.sequenceID)
    expect(notices).not.toHaveBeenCalled()
    await again.peer.dispose()
  })
})

test('a peer expires a near-future occurrence without later commit or app traffic', async () => {
  const hub = new DurableFakeHub()
  const seen = vi.fn()
  const bob = durableBob(hub, { handlers: { 'chat/posted': seen } })
  await bob.peer.protocol('chat').to('alice')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const frame = await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await createFakeCrypto({ epoch: 3, localDID: 'alice' }).wrap(
        encodeEventFrame('chat/posted', {}),
        { aad: encodeAppAAD({ topicID, intent: 'log' }) },
      ),
    })
    await bob.peer.replay()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(bob.appCursorStore.stored(topicID)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
    expect(seen).not.toHaveBeenCalled()
    expect(bob.controlWalk.safetyHold()).toBeNull()
    expect((await bob.control.load()).controlHold).toBeNull()
  } finally {
    await bob.peer.dispose()
  }
})

async function expectCompletion(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = Promise.race([
    operation.then(() => 'completed'),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('timed out'), 100)
    }),
  ])
  try {
    await vi.advanceTimersByTimeAsync(100)
    expect(await outcome).toBe('completed')
  } finally {
    clearTimeout(timer)
  }
}

test('an expiry gap observer can await resync without blocking later serial work', async () => {
  const hub = new DurableFakeHub()
  const observed = Promise.withResolvers<void>()
  const notices: Array<string> = []
  const pruned = vi.fn(async () => {
    notices.push('pruned')
    await bob.peer.resync()
    observed.resolve()
  })
  const bob = durableBob(hub, {
    onAppWindowPruned: pruned,
    onAppDeliveryStalled: () => notices.push('stalled'),
    onAppDeliveryResumed: () => notices.push('resumed'),
  })
  await bob.peer.protocol('chat').to('alice')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const frame = await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await createFakeCrypto({ epoch: 3, localDID: 'alice' }).wrap(
        encodeEventFrame('chat/posted', {}),
        { aad: encodeAppAAD({ topicID, intent: 'log' }) },
      ),
    })
    await bob.peer.replay()
    await vi.advanceTimersByTimeAsync(0)
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      const result = await fetch(params)
      return params.topicID === topicID ? { ...result, gap: true } : result
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pruned).toHaveBeenCalledExactlyOnceWith({
      groupID: commitTopic(secret),
      protocol: 'chat',
      cursor: frame.sequenceID,
      oldest: frame.sequenceID,
    })
    await expectCompletion(Promise.all([observed.promise, bob.peer.resync()]))
    expect(notices).toEqual(['stalled', 'pruned', 'resumed'])
    expect(bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
  } finally {
    await bob.peer.dispose()
  }
})

test('a non-durable handler reached by expiry can await resync', async () => {
  const hub = new DurableFakeHub()
  const observed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const handler = vi.fn(async ({ data }: { data: { text: string } }) => {
    if (data.text === 'first') await release.promise
    await bob.peer.resync()
    if (data.text === 'second') observed.resolve()
  })
  const bob = makeMLSPeer(hub, 'bob', secret, { handlers: { 'chat/posted': handler } })
  await bob.peer.protocol('chat').to('alice')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await createFakeCrypto({ epoch: 3, localDID: 'alice' }).wrap(
        encodeEventFrame('chat/posted', {}),
        { aad: encodeAppAAD({ topicID, intent: 'log' }) },
      ),
    })
    await bob.peer.replay()
    await vi.advanceTimersByTimeAsync(0)
    hub.detach('bob')
    const writer = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await writer.wrap(encodeEventFrame('chat/posted', { text: 'first' }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
    const frame = await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await writer.wrap(encodeEventFrame('chat/posted', { text: 'second' }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(handler).toHaveBeenCalledOnce()
    release.resolve()
    await expectCompletion(Promise.all([observed.promise, bob.peer.resync()]))
    expect(handler.mock.calls.map(([ctx]) => ctx.data.text)).toEqual(['first', 'second'])
    expect(bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
  } finally {
    release.resolve()
    await bob.peer.dispose()
  }
})

test('a peer starts hold age only when a paused commit walk catches up', async () => {
  const hub = new DurableFakeHub()
  const first = durableBob(hub)
  await first.peer.protocol('chat').to('alice')
  await first.peer.dispose()
  hub.detach('bob')
  await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
  const frame = await hub.publish({
    senderDID: 'alice',
    topicID,
    retain: 'log',
    payload: await createFakeCrypto({ epoch: 3, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', {}),
      { aad: encodeAppAAD({ topicID, intent: 'log' }) },
    ),
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const bob = makeMLSPeer(hub, 'bob', secret, { restartOf: first })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const process = bob.mls.processCommit.bind(bob.mls)
  vi.spyOn(bob.mls, 'processCommit').mockImplementationOnce(async (...args) => {
    entered.resolve()
    await release.promise
    return process(...args)
  })
  try {
    const replay = bob.peer.replay()
    await entered.promise
    expect(bob.crypto.starts.unwrap).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bob.appCursorStore.stored(topicID)).toBeNull()
    release.resolve()
    await replay
    expect(bob.mls.epoch()).toBe(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(bob.appCursorStore.stored(topicID)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
  } finally {
    release.resolve()
    await bob.peer.dispose()
  }
})

test('a local commit awaiting its publication acknowledgement suspends app expiry', async () => {
  const hub = new DurableFakeHub()
  const bob = durableBob(hub)
  await bob.peer.protocol('chat').to('alice')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let committing: Promise<unknown> | undefined
  try {
    const frame = await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await createFakeCrypto({ epoch: 3, localDID: 'alice' }).wrap(
        encodeEventFrame('chat/posted', {}),
        { aad: encodeAppAAD({ topicID, intent: 'log' }) },
      ),
    })
    await bob.peer.replay()
    await vi.advanceTimersByTimeAsync(0)
    const publish = hub.publish.bind(hub)
    vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      const result = await publish(params)
      if (params.topicID === commitTopic(secret)) {
        entered.resolve()
        await release.promise
      }
      return result
    })
    committing = bob.peer.commit(buildLedgerCommit(bob, []))
    await entered.promise
    await vi.advanceTimersByTimeAsync(30_000)
    expect(bob.appCursorStore.stored(topicID)).toBeNull()
    release.resolve()
    await committing
    await vi.advanceTimersByTimeAsync(0)
    expect(bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
  } finally {
    release.resolve()
    await committing
    await bob.peer.dispose()
  }
})

test('a local commit restores catch-up so a quiet future occurrence still expires', async () => {
  const hub = new DurableFakeHub()
  const bob = durableBob(hub)
  await bob.peer.protocol('chat').to('alice')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const frame = await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await createFakeCrypto({ epoch: 3, localDID: 'alice' }).wrap(
        encodeEventFrame('chat/posted', {}),
        { aad: encodeAppAAD({ topicID, intent: 'log' }) },
      ),
    })
    await bob.peer.replay()
    await vi.advanceTimersByTimeAsync(0)
    await bob.peer.commit(buildLedgerCommit(bob, []))
    expect(bob.mls.epoch()).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
  } finally {
    await bob.peer.dispose()
  }
})

test('live unsupported outer app versions complete without decrypting or a handler', async () => {
  const hub = new DurableFakeHub()
  const seen = vi.fn()
  const bob = durableBob(hub, { handlers: { 'chat/posted': seen } })
  await bob.peer.protocol('chat').to('alice')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const opens = vi.spyOn(bob.crypto, 'unwrap')
  try {
    const aad = encodeAppAAD({ topicID, intent: 'log' })
    aad[0] = 255
    const frame = await hub.publish({
      senderDID: 'alice',
      topicID,
      retain: 'log',
      payload: await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(
        encodeEventFrame('chat/posted', {}),
        { aad },
      ),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(bob.appCursorStore.stored(topicID)).toBe(frame.sequenceID)
    expect(opens).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
    expect(bob.controlWalk.safetyHold()).toBeNull()
  } finally {
    await bob.peer.dispose()
  }
})

const lanes: Array<AppLane> = []
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function futureLane(
  options: {
    durable?: boolean
    caught?: boolean
    hint?: number
    scheduleDrain?: (drain: () => Promise<void>) => Promise<void>
  } = {},
) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let caught = options.caught ?? true
  let workVersion = 0
  const rows = new Map<string, PendingAppFrame>()
  const reader = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    ...(options.durable === false
      ? {}
      : {
          pending: {
            async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
              rows.set(record.frame.id, record)
            },
            async list() {
              return [...rows.values()]
            },
            async complete(id: string) {
              rows.delete(id)
            },
          },
        }),
  })
  if (options.hint != null) reader.epoch = () => options.hint as number
  const cursor = createMemoryAppCursorStore()
  const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
  const emit = vi.fn(async () => {})
  const messages: Array<{ sequenceID: string; payload: Uint8Array }> = []
  const fetch = vi.fn(async ({ after }: { after?: string }) => ({
    messages: messages.filter((message) => after == null || message.sequenceID > after),
    head: messages.at(-1)?.sequenceID ?? null,
    oldest: messages[0]?.sequenceID ?? null,
    gap: false,
  }))
  const create = () => {
    const lane = createAppLane({
      mux: { retainTopic() {}, fetchTopic: fetch } as never,
      crypto: reader,
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map([['chat', { emit }]]) as never,
      retentionSeconds: 60,
      appCursorStore: cursor,
      anchor: () => anchor,
      groupID: () => 'group',
      ...{
        commitLaneCaughtUp: () => caught,
        commitWorkVersion: () => workVersion,
        ...(options.scheduleDrain == null ? {} : { scheduleDrain: options.scheduleDrain }),
      },
    })
    lanes.push(lane)
    return lane
  }
  const append = async (epoch: number) => {
    const sequenceID = String(messages.length + 1).padStart(12, '0')
    const payload = await createFakeCrypto({ epoch, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', { epoch }),
      { aad: encodeAppAAD({ topicID, intent: 'log' }) },
    )
    const message = { sequenceID, payload }
    messages.push(message)
    return message
  }
  const lane = create()
  return {
    lane,
    create,
    reader,
    cursor,
    anchor,
    emit,
    rows,
    messages,
    fetch,
    append,
    setCaught(value: boolean, retry = true) {
      if (!value) workVersion += 1
      caught = value
      if (caught && retry) lane.retryDelivery()
    },
  }
}

describe('caught-up future occurrence bounds', () => {
  test('reset cancels a queued drain before it can fetch the replacement segment', async () => {
    const release = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const f = await futureLane({
      scheduleDrain: async (drain) => {
        await release.promise
        try {
          await drain()
        } finally {
          settled.resolve()
        }
      },
    })
    await f.append(3)
    await f.lane.deliver()
    f.lane.retryDelivery()
    f.lane.reset()
    f.anchor.epoch = 2
    f.anchor.secret = fakeEpochSecret(2, APP_TOPIC_LABEL)
    f.fetch.mockClear().mockRejectedValue(new Error('replacement segment unavailable'))
    release.resolve()
    await settled.promise
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('reset prevents an in-flight drain rejection from arming backoff', async () => {
    const f = await futureLane()
    await f.append(3)
    await f.lane.deliver()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.fetch.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('old segment unavailable')
    })
    f.lane.retryDelivery()
    await entered.promise
    f.lane.reset()
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['resolve', 'reject'])(
    'new segment retries proceed while an old queued drain awaits %s',
    async (outcome) => {
      const release = Promise.withResolvers<void>()
      let scheduled = 0
      const f = await futureLane({
        scheduleDrain: async (drain) => {
          scheduled += 1
          if (scheduled === 1) {
            await release.promise
            if (outcome === 'reject') throw new Error('old scheduler failed')
          }
          await drain()
        },
      })
      await f.append(3)
      await f.lane.deliver()
      f.lane.retryDelivery()
      f.lane.reset()
      await f.lane.deliver()
      const fetches = f.fetch.mock.calls.length
      try {
        f.lane.retryDelivery()
        await vi.advanceTimersByTimeAsync(0)
        expect(f.fetch.mock.calls.length).toBe(fetches + 1)
        release.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(f.cursor.stored(topicID)).toBe('000000000001')
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        release.resolve()
      }
    },
  )

  test.each(['expiry', 'ahead note'])(
    '%s drain waits for an in-flight commit apply before opening',
    async (trigger) => {
      let commit = Promise.resolve()
      const f = await futureLane({
        durable: false,
        scheduleDrain: (drain) => commit.then(drain),
      })
      const message = await f.append(trigger === 'expiry' ? 3 : 4)
      if (trigger === 'expiry') await f.lane.deliver()
      const release = Promise.withResolvers<void>()
      commit = release.promise.then(() => f.reader.setEpoch(trigger === 'expiry' ? 3 : 4))
      try {
        if (trigger === 'ahead note') {
          f.lane.note(
            'chat',
            topicID,
            { ...message, logPosition: message.sequenceID } as never,
            new FrameEpochError(4, 1),
          )
        }
        await vi.advanceTimersByTimeAsync(30_000)
        expect(f.cursor.stored(topicID)).toBeNull()
        expect(f.emit).not.toHaveBeenCalled()
      } finally {
        release.resolve()
        await commit
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(f.emit).toHaveBeenCalledOnce()
      expect(f.cursor.stored(topicID)).toBe(message.sequenceID)
    },
  )

  test.each([false, true])(
    'catch-up changing during unwrap defers poison (initially caught=%s)',
    async (caught) => {
      const f = await futureLane({ caught })
      await f.append(4)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const unwrap = f.reader.unwrap.bind(f.reader)
      vi.spyOn(f.reader, 'unwrap').mockImplementationOnce(async (...args) => {
        try {
          return await unwrap(...args)
        } catch (error) {
          entered.resolve()
          await release.promise
          throw error
        }
      })
      const delivery = f.lane.deliver()
      await entered.promise
      f.setCaught(false, false)
      f.reader.setEpoch(4)
      f.setCaught(true, false)
      release.resolve()
      await delivery
      expect(f.cursor.stored(topicID)).toBeNull()
      expect(f.emit).not.toHaveBeenCalled()
      await f.lane.deliver()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.emit).toHaveBeenCalledOnce()
      expect(f.cursor.stored(topicID)).toBe('000000000001')
    },
  )

  test.each(['fetch', 'cursor save'])(
    'expiry retries one failed %s without traffic and never reopens completed poison',
    async (failure) => {
      const f = await futureLane()
      const message = await f.append(3)
      await f.lane.deliver()
      if (failure === 'fetch') f.fetch.mockRejectedValueOnce(new Error('fetch unavailable'))
      else vi.spyOn(f.cursor, 'save').mockRejectedValueOnce(new Error('cursor unavailable'))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(f.cursor.stored(topicID)).toBeNull()
      const opens = f.reader.starts.unwrap
      await vi.advanceTimersByTimeAsync(999)
      expect(f.cursor.stored(topicID)).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(f.cursor.stored(topicID)).toBe(message.sequenceID)
      if (failure === 'cursor save') expect(f.reader.starts.unwrap).toBe(opens)
      expect(f.emit).not.toHaveBeenCalled()
      expect(f.rows.size).toBe(0)
    },
  )

  test.each([true, false])(
    '+2 holds until 30,000 ms without traffic (durable=%s)',
    async (durable) => {
      const f = await futureLane({ durable })
      await f.append(3)
      await f.lane.deliver()
      expect(f.cursor.stored(topicID)).toBeNull()
      await vi.advanceTimersByTimeAsync(29_999)
      expect(f.cursor.stored(topicID)).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(f.cursor.stored(topicID)).toBe('000000000001')
      expect(f.emit).not.toHaveBeenCalled()
      expect(f.rows.size).toBe(0)
    },
  )

  test.each([-100, 100])('+3 poisons using the locked epoch despite hint %s', async (hint) => {
    const f = await futureLane({ hint })
    await f.append(4)
    await f.lane.deliver()
    expect(f.cursor.stored(topicID)).toBe('000000000001')
    expect(f.rows.size).toBe(0)
    expect(f.emit).not.toHaveBeenCalled()
  })

  test('lag beyond 30 seconds starts no clock; catch-up starts age without traffic', async () => {
    const f = await futureLane({ caught: false })
    await f.append(3)
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(60_000)
    await f.lane.deliver()
    expect(f.cursor.stored(topicID)).toBeNull()
    f.setCaught(true)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(f.cursor.stored(topicID)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.cursor.stored(topicID)).toBe('000000000001')
  })

  test('catch-up starts age while a lagging retry is blocked in app refetch', async () => {
    const f = await futureLane({ caught: false })
    const message = await f.append(3)
    await f.lane.deliver()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.fetch.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { messages: [], head: message.sequenceID, oldest: message.sequenceID, gap: false }
    })
    f.lane.retryDelivery()
    await entered.promise
    f.setCaught(true)
    await vi.advanceTimersByTimeAsync(20_000)
    release.resolve()
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(f.cursor.stored(topicID)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.cursor.stored(topicID)).toBe(message.sequenceID)
  })

  test('expiry suspends enforcement during new commit lag and opens before applying bounds', async () => {
    const f = await futureLane()
    await f.append(3)
    await f.lane.deliver()
    f.setCaught(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.cursor.stored(topicID)).toBeNull()
    f.reader.setEpoch(3)
    f.setCaught(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.emit).toHaveBeenCalledOnce()
    expect(f.cursor.stored(topicID)).toBe('000000000001')
  })

  test('catch-up completes a far-future claim without more traffic', async () => {
    const f = await futureLane({ caught: false })
    await f.append(100)
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.cursor.stored(topicID)).toBeNull()
    f.setCaught(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.cursor.stored(topicID)).toBe('000000000001')
  })

  test('duplicate pushes and refetches cannot renew age', async () => {
    const f = await futureLane({ durable: false })
    const message = await f.append(3)
    const fetched = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.fetch.mockImplementationOnce(async () => {
      fetched.resolve()
      await release.promise
      return {
        messages: [message],
        head: message.sequenceID,
        oldest: message.sequenceID,
        gap: false,
      }
    })
    f.lane.note(
      'chat',
      topicID,
      { ...message, logPosition: message.sequenceID } as never,
      new FrameEpochError(3, 1),
    )
    await fetched.promise
    await vi.advanceTimersByTimeAsync(20_000)
    f.lane.note(
      'chat',
      topicID,
      { ...message, logPosition: message.sequenceID } as never,
      new FrameEpochError(3, 1),
    )
    release.resolve()
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.cursor.stored(topicID)).toBe(message.sequenceID)
  })

  test('restart gives a fresh bounded wait, while committed poison is never reopened', async () => {
    const f = await futureLane()
    await f.append(2)
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(20_000)
    f.lane.dispose()
    const restarted = f.create()
    await restarted.deliver()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(f.cursor.stored(topicID)).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.cursor.stored(topicID)).toBe('000000000001')
    restarted.dispose()
    const opens = vi.spyOn(f.reader, 'unwrap')
    await f.create().deliver()
    expect(opens).not.toHaveBeenCalled()
  })

  test('poison behind an earlier pending record cannot pass its cursor', async () => {
    const f = await futureLane()
    const release = Promise.withResolvers<void>()
    f.emit.mockImplementationOnce(() => release.promise)
    await f.append(1)
    await f.append(4)
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.rows.size).toBe(1)
    expect(f.cursor.stored(topicID)).toBeNull()
    await f.lane.deliver()
    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.cursor.stored(topicID)).toBe('000000000002')
  })

  test('cursor storage failure retains completed poison until a successful save', async () => {
    const f = await futureLane()
    await f.append(4)
    const save = f.cursor.save.bind(f.cursor)
    vi.spyOn(f.cursor, 'save')
      .mockRejectedValueOnce(new Error('ambiguous cursor save'))
      .mockImplementation(save)
    await expect(f.lane.deliver()).rejects.toThrow('ambiguous cursor save')
    expect(f.cursor.stored(topicID)).toBeNull()
    const opens = vi.spyOn(f.reader, 'unwrap')
    await f.lane.deliver()
    expect(f.cursor.stored(topicID)).toBe('000000000001')
    expect(opens).not.toHaveBeenCalled()
  })

  test('disposal cancels a scheduled expiry', async () => {
    const f = await futureLane()
    await f.append(3)
    await f.lane.deliver()
    f.lane.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.cursor.stored(topicID)).toBeNull()
    expect(f.emit).not.toHaveBeenCalled()
  })

  test.each([true, false])(
    'unsupported outer app AAD version completes without opening (durable=%s)',
    async (durable) => {
      const f = await futureLane({ durable })
      const aad = encodeAppAAD({ topicID, intent: 'log' })
      aad[0] = 255
      f.messages.push({
        sequenceID: '000000000001',
        payload: await createFakeCrypto({
          epoch: 1,
          localDID: 'alice',
        }).wrap(encodeEventFrame('chat/posted', {}), { aad }),
      })
      const opens = vi.spyOn(f.reader, 'unwrap')
      await f.lane.deliver()
      expect(f.cursor.stored(topicID)).toBe('000000000001')
      expect(opens).not.toHaveBeenCalled()
      expect(f.rows.size).toBe(0)
      expect(f.emit).not.toHaveBeenCalled()
    },
  )
})
