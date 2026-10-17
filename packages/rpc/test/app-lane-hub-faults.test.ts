import { encodeEventFrame } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type * as AppLaneModule from '../src/app-lane.js'
import { type AppLaneParams, createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { adaptBusHandlers } from '../src/handlers.js'
import { createHubMux } from '../src/hub-mux.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

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
  vi.useRealTimers()
  vi.restoreAllMocks()
  captured.length = 0
})

const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
const topicID = protocolTopic(anchor.secret, 1, 'chat')
const position = (n: number) => String(n).padStart(12, '0')
const empty = (): HubFetchTopicResult => ({ messages: [], head: null, oldest: null, gap: false })
const entry = (sequenceID: string, payload: Uint8Array = new Uint8Array([255])): StoredMessage => ({
  sequenceID,
  payload,
  senderDID: 'alice',
  topicID,
  logPosition: sequenceID,
})
const page = (messages: Array<StoredMessage>, gap = false): HubFetchTopicResult => ({
  messages,
  head: messages.at(-1)?.sequenceID ?? null,
  oldest: messages[0]?.sequenceID ?? null,
  gap,
})

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function fixture(
  options: {
    durable?: boolean
    handler?: () => unknown
    protocols?: AppLaneParams['protocols']
  } = {},
) {
  const rows = new Map<string, PendingAppFrame>()
  const complete = vi.fn(async (id: string) => {
    rows.delete(id)
  })
  const reader = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    ...(options.durable
      ? {
          pending: {
            async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
              rows.set(record.frame.id, record)
            },
            async list() {
              return [...rows.values()]
            },
            complete,
          },
        }
      : {}),
  })
  const seen: Array<string> = []
  const events = adaptBusHandlers(chat, {
    'chat/posted': ({ data }: { data: { text: string } }) => {
      seen.push(data.text)
      return options.handler?.()
    },
  }).events
  const cursor = createMemoryAppCursorStore()
  const hub = new DurableFakeHub()
  const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
  const pruned = vi.fn()
  const drains = { pending: 0, peak: 0, starts: 0 }
  const lane = createAppLane({
    mux,
    crypto: reader,
    appliedEpoch: () => reader.epoch(),
    localDID: 'bob',
    protocols: options.protocols ?? { chat },
    eventHandlers: new Map([['chat', events]]),
    retentionSeconds: 60,
    appCursorStore: cursor,
    onAppWindowPruned: pruned,
    anchor: () => anchor,
    groupID: () => 'group',
    scheduleDrain: async (drain) => {
      drains.pending++
      drains.starts++
      drains.peak = Math.max(drains.peak, drains.pending)
      try {
        await drain()
      } finally {
        drains.pending--
      }
    },
  })
  onTestFinished(() => {
    lane.dispose()
    mux.dispose()
  })
  const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const sealed = async (text: string, epoch = 1) =>
    (epoch === 1 ? sender : createFakeCrypto({ epoch, localDID: 'alice' })).wrap(
      encodeEventFrame('chat/posted', { text }),
      { aad: encodeAppAAD({ topicID, intent: 'log' }) },
    )
  return { lane, reader, rows, complete, seen, cursor, hub, mux, pruned, drains, sealed }
}

// Observe the real collections without adding a production diagnostics API.
function collections() {
  const arrays: Array<Array<unknown>> = []
  const notices: Array<Set<unknown>> = []
  const noticeMaps: Array<Map<unknown, unknown>> = []
  const set = Map.prototype.set
  vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    if (key === 'chat' && Array.isArray(value)) arrays.push(value)
    if (key === topicID && value instanceof Set) {
      notices.push(value)
      noticeMaps.push(this)
    }
    return set.call(this, key, value)
  })
  return {
    check() {
      for (const values of arrays) expect(values.length).toBeLessThanOrEqual(1_000)
      for (const values of notices) expect(values.size).toBeLessThanOrEqual(64)
    },
    arrays,
    notices,
    noticeMaps,
  }
}

describe('app pulls against a faulty hub', () => {
  test('endless increasing junk stays bounded while a commit applies', async () => {
    const hub = new DurableFakeHub()
    const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0xb3), { epoch: 1 })
    onTestFinished(() => bob.peer.dispose())
    await bob.peer.protocol('chat').to('alice')
    const capturedLane = captured.at(-1)
    if (capturedLane == null) throw new Error('missing peer lane')
    const { lane, params } = capturedLane
    await lane.deliver()
    hub.detach('bob')
    const observed = collections()
    let calls = 0
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID !== topicID) return fetch(params)
      calls++
      if (calls > 20) return empty()
      return page(Array.from({ length: 100 }, (_, i) => entry(position((calls - 1) * 100 + i + 1))))
    })
    const perPull = new Map<AbortSignal | undefined, number>()
    const muxFetch = params.mux.fetchTopic
    vi.spyOn(params.mux, 'fetchTopic').mockImplementation((request) => {
      const signal = (request as { signal?: AbortSignal }).signal
      if (request.topicID === topicID) perPull.set(signal, (perPull.get(signal) ?? 0) + 1)
      return muxFetch(request)
    })
    const delivery = lane.deliver()
    await bob.peer.commit(buildLedgerCommit(bob, []))
    expect(bob.mls.epoch()).toBe(2)
    await delivery
    for (const count of perPull.values()) expect(count).toBeLessThanOrEqual(4)
    observed.check()
  })

  test('a full future-frame buffer stops pulling', async () => {
    const f = fixture()
    const observed = collections()
    const bytes = await f.sealed('future', 2)
    let seq = 0
    const fetch = vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async () => {
      if (seq >= 2_000) return empty()
      return page(Array.from({ length: 100 }, () => entry(position(++seq), bytes)))
    })
    for (let i = 0; i < 4; i++) {
      await f.lane.deliver()
      observed.check()
    }
    expect(observed.arrays.some((values) => values.length === 1_000)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(10)
  })

  test('payload bytes are budgeted across each pull', async () => {
    const f = fixture()
    const bytes = new Uint8Array(1024 * 1024).fill(255)
    const fetch = vi
      .spyOn(f.hub, 'fetchTopic')
      .mockResolvedValue(page(Array.from({ length: 100 }, (_, i) => entry(position(i + 1), bytes))))
    await f.lane.deliver()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(f.cursor.stored(topicID)).toBe(position(4))
  })

  test('protocol topics share the payload budget', async () => {
    const f = fixture({ protocols: { chat, other: chat } })
    const otherTopic = protocolTopic(anchor.secret, 1, 'other')
    const bytes = new Uint8Array(1024 * 1024).fill(255)
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async ({ topicID: topic }) => {
      return page(
        Array.from({ length: 100 }, (_, i) => ({
          ...entry(position(i + 1), bytes),
          topicID: topic,
        })),
      )
    })
    await f.lane.deliver()
    const processed =
      Number(f.cursor.stored(topicID) ?? '0') + Number(f.cursor.stored(otherTopic) ?? '0')
    expect(processed).toBe(4)
  })

  test('overlapping pulls discard a page when its fetched cursor moved', async () => {
    const f = fixture()
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    vi.spyOn(f.hub, 'fetchTopic')
      .mockReturnValueOnce(withheld.promise)
      .mockResolvedValue(page([entry('1', await f.sealed('fresh'))]))
    const first = f.lane.deliver()
    let secondDone = false
    try {
      await flush()
      const second = f.lane.deliver().then(() => {
        secondDone = true
      })
      await flush()
      expect(secondDone).toBe(true)
      await second
      withheld.resolve(page([entry('2', await f.sealed('stale'))]))
      await first
      expect(f.seen).toEqual(['fresh'])
      expect(f.cursor.stored(topicID)).toBe('1')
    } finally {
      withheld.resolve(empty())
      await first
    }
  })

  test('withheld fetch is aborted at the deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    const fetch = vi.spyOn(f.hub, 'fetchTopic').mockReturnValue(withheld.promise)
    const requests = vi.spyOn(f.mux, 'fetchTopic')
    let settled = false
    const task = f.lane.deliver().finally(() => {
      settled = true
    })
    try {
      await flush()
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(requests.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    } finally {
      withheld.resolve(empty())
      await task
    }
  })

  test('repeated deadlines keep outstanding fetches bounded', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    const fetch = vi.spyOn(f.hub, 'fetchTopic').mockReturnValue(withheld.promise)
    try {
      for (let i = 0; i < 50; i++) {
        let settled = false
        const task = f.lane.deliver().then(() => {
          settled = true
        })
        await flush()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(settled).toBe(true)
        await task
        expect(fetch.mock.calls.length).toBeLessThanOrEqual(2)
      }
      expect(fetch).toHaveBeenCalledTimes(2)
      withheld.resolve(empty())
      await flush()
      await f.lane.deliver()
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally {
      withheld.resolve(empty())
    }
  })

  test('hub-driven collections stay bounded', async () => {
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture({
      handler: () => {
        entered.resolve()
        return release.promise
      },
    })
    const observed = collections()
    let sequence = 1
    let first = true
    let outstanding = 0
    let peak = 0
    const initial = await f.sealed('held')
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async () => {
      outstanding++
      peak = Math.max(peak, outstanding)
      try {
        if (first) {
          first = false
          return page([entry(position(sequence++), initial)])
        }
        return page([entry(position(sequence++))], true)
      } finally {
        outstanding--
      }
    })
    f.lane.kick()
    try {
      await entered.promise
      for (let i = 0; i < 10_000; i++) {
        f.lane.note('chat', topicID, entry(position(i + 2)), undefined)
        f.lane.kick()
      }
      await flush()
      observed.check()
      expect(observed.arrays.some((values) => values.length === 1_000)).toBe(true)
      expect(f.drains.pending).toBeLessThanOrEqual(2)
      expect(f.drains.peak).toBeLessThanOrEqual(2)
      expect(peak).toBeLessThanOrEqual(2)
    } finally {
      release.resolve()
    }
    await vi.waitFor(() => expect(f.drains.pending).toBe(0))
    expect(f.drains.starts).toBeLessThanOrEqual(2)
    for (let i = 0; i < 200; i++) {
      await f.lane.deliver()
      observed.check()
      expect(f.drains.peak).toBeLessThanOrEqual(2)
      expect(peak).toBeLessThanOrEqual(2)
    }
    expect(f.pruned.mock.calls.length).toBeGreaterThan(64)
    expect(observed.notices.length).toBeGreaterThan(0)
    f.lane.reset()
    for (const [index, map] of observed.noticeMaps.entries()) {
      if (!observed.notices[index]?.has('bob')) expect(map.has(topicID)).toBe(false)
    }
  })

  test('completion never waits on a fetch', async () => {
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture({
      durable: true,
      handler: () => {
        entered.resolve()
        return release.promise
      },
    })
    const bytes = await f.sealed('complete')
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    vi.spyOn(f.hub, 'fetchTopic')
      .mockResolvedValueOnce(page([entry('1', bytes)]))
      .mockReturnValue(withheld.promise)
    await f.lane.deliver()
    await entered.promise
    const next = f.lane.deliver()
    try {
      await flush()
      release.resolve()
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1), { timeout: 300 })
      await vi.waitFor(() => expect(f.cursor.stored(topicID)).toBe('1'), { timeout: 300 })
    } finally {
      release.resolve()
      withheld.resolve(empty())
      await next
    }
  })

  test.each([false, true])(
    'one comparator orders buffer and workers, durable=%s',
    async (durable) => {
      const f = fixture({ durable })
      const messages = await Promise.all(
        ['10', '100', '9', 'B', 'a'].map(async (seq) => entry(seq, await f.sealed(seq))),
      )
      vi.spyOn(f.hub, 'fetchTopic').mockResolvedValue(page(messages))
      await f.lane.deliver()
      await vi.waitFor(() => expect(f.seen).toEqual(['10', '100', '9', 'B', 'a']))
    },
  )

  test('one comparator orders restore after restart', async () => {
    const f = fixture({ durable: true })
    const records = ['9', 'a', '100', 'B', '10'].map((seq) => ({
      frame: { id: `restored-${seq}`, topicID, protocol: 'chat', segment: 1, position: seq },
      payload: encodeEventFrame('chat/posted', { text: seq }),
      senderDID: 'alice',
    }))
    await f.lane.restore(records)
    expect(f.lane.pendingRecords().map((record) => record.frame.position)).toEqual([
      '10',
      '100',
      '9',
      'B',
      'a',
    ])
    f.lane.retryDelivery()
    await vi.waitFor(() => expect(f.seen).toEqual(['10', '100', '9', 'B', 'a']))
  })

  test('junk mid-page is skipped', async () => {
    const f = fixture()
    vi.spyOn(f.hub, 'fetchTopic').mockResolvedValue(
      page([entry('1', await f.sealed('first')), entry('2'), entry('3', await f.sealed('last'))]),
    )
    await expect(f.lane.deliver()).resolves.toBeUndefined()
    expect(f.seen).toEqual(['first', 'last'])
    expect(f.cursor.stored(topicID)).toBe('3')
  })

  test('non-increasing entry is skipped', async () => {
    const f = fixture()
    vi.spyOn(f.hub, 'fetchTopic').mockResolvedValue(
      page([
        entry('1', await f.sealed('first')),
        entry('1', await f.sealed('duplicate')),
        entry('0', await f.sealed('backwards')),
        entry('2', await f.sealed('last')),
      ]),
    )
    await expect(f.lane.deliver()).resolves.toBeUndefined()
    expect(f.seen).toEqual(['first', 'last'])
    expect(f.cursor.stored(topicID)).toBe('2')
  })

  test('oversized sequenceID page ends the pull without raising', async () => {
    const f = fixture()
    vi.spyOn(f.hub, 'fetchTopic').mockResolvedValue(page([entry('x'.repeat(65))]))
    await expect(f.lane.deliver()).resolves.toBeUndefined()
    expect(f.cursor.stored(topicID)).toBeNull()
    expect(f.seen).toEqual([])
  })

  test('reset aborts an in-flight pull and drops its result', async () => {
    const f = fixture()
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    vi.spyOn(f.hub, 'fetchTopic').mockReturnValue(withheld.promise)
    const requests = vi.spyOn(f.mux, 'fetchTopic')
    const task = f.lane.deliver()
    await flush()
    f.lane.reset()
    const aborted = requests.mock.calls[0]?.[0].signal?.aborted
    withheld.resolve(page([entry('1', await f.sealed('stale'))]))
    await task
    expect(aborted).toBe(true)
    expect(f.seen).toEqual([])
    expect(f.cursor.stored(topicID)).toBeNull()
  })
})
