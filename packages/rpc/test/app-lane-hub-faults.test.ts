import { encodeEventFrame } from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type * as AppLaneModule from '../src/app-lane.js'
import { type AppLaneParams, createAppLane } from '../src/app-lane.js'
import { FrameEpochError, type PendingAppFrame } from '../src/crypto.js'
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
    eventHandlers: new Map(
      Object.keys(options.protocols ?? { chat }).map((name) => [name, events]),
    ),
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
  const sealed = async (text: string, epoch = 1, topic = topicID) =>
    (epoch === 1 ? sender : createFakeCrypto({ epoch, localDID: 'alice' })).wrap(
      encodeEventFrame('chat/posted', { text }),
      { aad: encodeAppAAD({ topicID: topic, intent: 'log' }) },
    )
  return { lane, reader, rows, complete, seen, cursor, hub, mux, pruned, drains, sealed }
}

// Observe the real collections without adding a production diagnostics API.
function collections() {
  const arrays: Array<Array<unknown>> = []
  const notices: Array<Set<unknown>> = []
  const noticeMaps: Array<Map<unknown, unknown>> = []
  const pullMaps = new Set<Map<unknown, unknown>>()
  let peakControllers = 0
  const set = Map.prototype.set
  vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value,
  ) {
    if (key === topicID && Array.isArray(value)) arrays.push(value)
    if (key === topicID && value instanceof Set) {
      notices.push(value)
      noticeMaps.push(this)
    }
    const result = set.call(this, key, value)
    if (key instanceof AbortController) {
      pullMaps.add(this)
      peakControllers = Math.max(peakControllers, this.size)
    }
    return result
  })
  return {
    check() {
      for (const values of arrays) expect(values.length).toBeLessThanOrEqual(1_000)
      for (const values of notices) expect(values.size).toBeLessThanOrEqual(64)
    },
    arrays,
    notices,
    noticeMaps,
    pullMaps,
    get peakControllers() {
      return peakControllers
    },
  }
}

describe('app pulls against a faulty hub', () => {
  test('refused-frame floods yield to timers and commits at a bounded rate', async () => {
    const hub = new DurableFakeHub()
    const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0xb4), { epoch: 1 })
    onTestFinished(() => bob.peer.dispose())
    await bob.peer.protocol('chat').to('alice')
    const capturedLane = captured.at(-1)
    if (capturedLane == null) throw new Error('missing peer lane')
    const { lane, params } = capturedLane
    await lane.deliver()
    hub.detach('bob')
    const at = params.anchor()
    const appTopic = protocolTopic(at.secret, at.epoch, 'chat')
    const fetch = hub.fetchTopic.bind(hub)
    let requests = 0
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (request) => {
      if (request.topicID !== appTopic) return fetch(request)
      // Stop a regressed microtask loop so its assertions can still run.
      if (++requests > 200) return empty()
      return page(
        Array.from({ length: 100 }, (_, i) => ({
          ...entry(position((requests - 1) * 100 + i + 1)),
          topicID: appTopic,
        })),
      )
    })
    let timerRequests = 0
    let timerFired = false
    let commitApplied = false
    lane.kick()
    const commit = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        timerFired = true
        timerRequests = requests
        void bob.peer.commit(buildLedgerCommit(bob, [])).then(() => {
          commitApplied = true
          resolve()
        }, reject)
      }, 0)
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(timerFired).toBe(true)
    expect(commitApplied).toBe(true)
    expect(bob.mls.epoch()).toBe(2)
    expect(timerRequests).toBeGreaterThan(0)
    expect(timerRequests).toBeLessThanOrEqual(4)
    expect(requests).toBeGreaterThan(timerRequests)
    // The commit also wakes app catch-up as its control walk settles.
    expect(requests).toBeLessThanOrEqual(40)
    await commit
  })

  test.each([false, true])('refused-frame continuation backs off, durable=%s', async (durable) => {
    vi.useFakeTimers()
    const f = fixture({ durable })
    let requests = 0
    let progress: Uint8Array | undefined
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async () => {
      if (++requests > 200) return empty()
      const messages = Array.from({ length: 100 }, (_, i) =>
        entry(position((requests - 1) * 100 + i + 1)),
      )
      if (progress != null) {
        messages[0] = entry(position((requests - 1) * 100 + 1), progress)
        progress = undefined
      }
      return page(messages)
    })
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(requests).toBeGreaterThan(4)
    expect(requests).toBeLessThanOrEqual(36)
    const beforeCap = requests
    await vi.advanceTimersByTimeAsync(1_000)
    expect(requests).toBe(beforeCap + 4)
    const beforeWake = requests
    f.lane.kick()
    await vi.advanceTimersByTimeAsync(1)
    expect(requests).toBe(beforeWake + 4)
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toBe(beforeWake + 8)
    await vi.advanceTimersByTimeAsync(5_000)
    const beforeProgress = requests
    progress = await f.sealed('progress')
    await f.lane.deliver()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.seen).toEqual(['progress'])
    expect(requests).toBe(beforeProgress + 8)
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toBe(beforeProgress + 12)
  })

  test('endless increasing junk stays bounded while a commit applies', async () => {
    const hub = new DurableFakeHub()
    const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0xb3), { epoch: 1 })
    onTestFinished(() => bob.peer.dispose())
    await bob.peer.protocol('chat').to('alice')
    const capturedLane = captured.at(-1)
    if (capturedLane == null) throw new Error('missing peer lane')
    const { lane, params } = capturedLane
    const at = params.anchor()
    const appTopic = protocolTopic(at.secret, at.epoch, 'chat')
    await lane.deliver()
    hub.detach('bob')
    const observed = collections()
    let calls = 0
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID !== appTopic) return fetch(params)
      calls++
      if (calls === 1) {
        entered.resolve()
        await release.promise
      }
      if (calls > 20) return empty()
      return page(Array.from({ length: 100 }, (_, i) => entry(position((calls - 1) * 100 + i + 1))))
    })
    const perPull = new Map<AbortSignal | undefined, number>()
    const muxFetch = params.mux.fetchTopic
    vi.spyOn(params.mux, 'fetchTopic').mockImplementation((request) => {
      const signal = (request as { signal?: AbortSignal }).signal
      if (request.topicID === appTopic) perPull.set(signal, (perPull.get(signal) ?? 0) + 1)
      return muxFetch(request)
    })
    const delivery = lane.deliver()
    let finished = false
    void delivery.then(() => {
      finished = true
    })
    try {
      await entered.promise
      await bob.peer.commit(buildLedgerCommit(bob, []))
      expect(bob.mls.epoch()).toBe(2)
      expect(finished).toBe(false)
    } finally {
      release.resolve()
    }
    await delivery
    expect(perPull.size).toBeGreaterThan(0)
    expect(Math.max(...perPull.values())).toBe(4)
    for (const count of perPull.values()) expect(count).toBeLessThanOrEqual(4)
    observed.check()
  })

  test('a fair pull fetches every populated topic before fetching another page', async () => {
    const f = fixture({ protocols: { chat, other: chat, third: chat, fourth: chat } })
    const topics = ['chat', 'other', 'third', 'fourth'].map((name) =>
      protocolTopic(anchor.secret, 1, name),
    )
    const fetched: Array<string> = []
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async ({ topicID: topic, after }) => {
      fetched.push(topic)
      if (after != null) return empty()
      const messages = Array.from({ length: 100 }, (_, i) => entry(position(i + 1)))
      messages[0] = entry(position(1), await f.sealed(topic, 1, topic))
      return page(messages)
    })
    await f.lane.deliver()
    expect(new Set(f.seen)).toEqual(new Set(topics))
    expect(new Set(fetched.slice(0, 4))).toEqual(new Set(topics))
    for (const topic of topics) expect(f.cursor.stored(topic)).toBe(position(100))
  })

  test('a busy mux rejects distinctly and retries after underlying fetches settle', async () => {
    const f = fixture()
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    const fetch = vi.spyOn(f.hub, 'fetchTopic').mockReturnValue(withheld.promise)
    const controller = new AbortController()
    const request = { topicID, signal: controller.signal, limit: 100 }
    const first = f.mux.fetchTopic(request)
    const second = f.mux.fetchTopic(request)
    try {
      await expect(f.mux.fetchTopic(request)).rejects.toMatchObject({ name: 'AppFetchBusyError' })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      withheld.resolve(empty())
      await Promise.all([first, second])
    }
    await expect(f.mux.fetchTopic(request)).resolves.toEqual(empty())
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test.each(['resolve', 'reject'])(
    'busy topics resume without an external trigger when aborted fetches %s',
    async (settlement) => {
      vi.useFakeTimers()
      const f = fixture({ protocols: { chat, other: chat, third: chat, fourth: chat } })
      const topics = ['chat', 'other', 'third', 'fourth'].map((name) =>
        protocolTopic(anchor.secret, 1, name),
      )
      const messages = new Map(
        await Promise.all(
          topics.map(async (topic) => [topic, await f.sealed(topic, 1, topic)] as const),
        ),
      )
      const withheld = Promise.withResolvers<HubFetchTopicResult>()
      const subscriptions = vi.spyOn(f.mux, 'onAppFetchAvailable')
      const fetch = vi
        .spyOn(f.hub, 'fetchTopic')
        .mockReturnValueOnce(withheld.promise)
        .mockReturnValueOnce(withheld.promise)
        .mockImplementation(async ({ topicID: topic }) =>
          page([{ ...entry('1', messages.get(topic)), topicID: topic }]),
        )
      const initial = f.lane.deliver()
      try {
        await vi.advanceTimersByTimeAsync(10_000)
        await initial
        await vi.advanceTimersByTimeAsync(100)
        expect(new Set(f.seen)).toEqual(new Set(topics))
        expect(fetch).toHaveBeenCalledTimes(6)
        expect(subscriptions.mock.calls.length).toBeLessThanOrEqual(1)
        if (settlement === 'resolve') withheld.resolve(empty())
        else withheld.reject(new Error('late hub rejection'))
        await vi.advanceTimersByTimeAsync(0)
        expect(fetch).toHaveBeenCalledTimes(6)
        expect(f.drains.pending).toBe(0)
        for (const topic of topics) expect(f.cursor.stored(topic)).toBe('1')
      } finally {
        f.lane.dispose()
        withheld.resolve(empty())
        await initial
      }
    },
  )

  test('busy retry observes capacity released before its rejection is handled', async () => {
    const f = fixture()
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    const fetch = vi
      .spyOn(f.hub, 'fetchTopic')
      .mockReturnValueOnce(withheld.promise)
      .mockReturnValueOnce(withheld.promise)
      .mockResolvedValue(page([entry('1', await f.sealed('recovered'))]))
    const controller = new AbortController()
    const request = { topicID, signal: controller.signal, limit: 100 }
    const initial = Promise.allSettled([f.mux.fetchTopic(request), f.mux.fetchTopic(request)])
    controller.abort()
    await initial
    const muxFetch = f.mux.fetchTopic
    vi.spyOn(f.mux, 'fetchTopic').mockImplementation((params) => {
      const result = muxFetch(params)
      withheld.resolve(empty())
      return result
    })
    try {
      await f.lane.deliver()
      await flush()
      expect(f.seen).toEqual(['recovered'])
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(f.cursor.stored(topicID)).toBe('1')
    } finally {
      f.lane.dispose()
      withheld.resolve(empty())
    }
  })

  test('busy recovery visits every topic after one of four abandoned requests settles', async () => {
    vi.useFakeTimers()
    const f = fixture({ protocols: { chat, other: chat, third: chat, fourth: chat } })
    const first = Promise.withResolvers<HubFetchTopicResult>()
    const second = Promise.withResolvers<HubFetchTopicResult>()
    let calls = 0
    const fetch = vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async () => {
      calls++
      if (calls === 1) return first.promise
      if (calls <= 4) return second.promise
      return empty()
    })
    try {
      for (let i = 0; i < 4; i++) {
        const controller = new AbortController()
        const request = f.mux.fetchTopic({ topicID, signal: controller.signal })
        controller.abort()
        await Promise.allSettled([request])
      }
      await f.lane.deliver()
      expect(fetch).toHaveBeenCalledTimes(4)
      first.resolve(empty())
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(8)
      expect(new Set(fetch.mock.calls.slice(4).map(([request]) => request.topicID)).size).toBe(4)
      expect(f.drains.pending).toBe(0)
      second.resolve(empty())
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(8)
    } finally {
      f.lane.dispose()
      first.resolve(empty())
      second.resolve(empty())
    }
  })

  test.each(['reset', 'dispose'] as const)(
    '%s cancels the coalesced busy retry before capacity returns',
    async (action) => {
      const f = fixture()
      const withheld = Promise.withResolvers<HubFetchTopicResult>()
      const fetch = vi.spyOn(f.hub, 'fetchTopic').mockReturnValue(withheld.promise)
      const controller = new AbortController()
      const request = { topicID, signal: controller.signal, limit: 100 }
      const initial = Promise.allSettled(
        Array.from({ length: 4 }, () => {
          const controller = new AbortController()
          const task = f.mux.fetchTopic({ ...request, signal: controller.signal })
          controller.abort()
          return task
        }),
      )
      controller.abort()
      await initial
      try {
        await f.lane.deliver()
        f.lane[action]()
        withheld.resolve(empty())
        await flush()
        expect(fetch).toHaveBeenCalledTimes(4)
        expect(f.drains.starts).toBe(0)
      } finally {
        f.lane.dispose()
        withheld.resolve(empty())
      }
    },
  )

  test('oversized pages inspect only the requested prefix before validating entries', async () => {
    const f = fixture()
    let inspected = 0
    const duplicate = entry('1', new Uint8Array())
    const messages = new Proxy(
      Array.from({ length: 100_000 }, () => duplicate),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) inspected++
          return Reflect.get(target, key, receiver)
        },
      },
    )
    messages[99_999] = entry('x'.repeat(65), new Uint8Array())
    vi.spyOn(f.hub, 'fetchTopic').mockResolvedValue({
      messages,
      head: '1',
      oldest: '1',
      gap: false,
    })
    const result = f.mux.fetchTopic({ topicID, limit: 100, signal: new AbortController().signal })
    await expect(result).resolves.toMatchObject({
      messages: Array.from({ length: 100 }, () => duplicate),
    })
    expect(inspected).toBe(100)
  })

  test('a first entry larger than the pull byte budget is consumed without wedging the topic', async () => {
    const f = fixture()
    vi.spyOn(f.hub, 'fetchTopic').mockResolvedValue(
      page([
        entry('1', new Uint8Array(4 * 1024 * 1024 + 1)),
        entry('2', await f.sealed('after oversized')),
      ]),
    )
    await f.lane.deliver()
    expect(f.seen).toEqual(['after oversized'])
    expect(f.cursor.stored(topicID)).toBe('2')
  })

  test.each([null, '3'])(
    'replayed entries never move the next transport cursor backwards from %s',
    async (stored) => {
      const f = fixture()
      if (stored != null) await f.cursor.save(topicID, stored)
      const fetch = vi
        .spyOn(f.hub, 'fetchTopic')
        .mockResolvedValueOnce(page([entry('2'), ...Array.from({ length: 99 }, () => entry('1'))]))
        .mockResolvedValue(empty())
      await f.lane.deliver()
      if (stored == null) expect(fetch.mock.calls[1]?.[0].after).toBe('2')
      else expect(fetch).toHaveBeenCalledTimes(1)
      expect(f.cursor.stored(topicID)).toBe(stored ?? '2')
    },
  )

  test('a full future-frame buffer stops pulling', async () => {
    const f = fixture()
    const observed = collections()
    const bytes = await f.sealed('future', 2)
    let seq = 0
    const fetch = vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async () => {
      if (seq >= 2_000) return empty()
      return page(Array.from({ length: 100 }, () => entry(position(++seq), bytes)))
    })
    f.lane.kick()
    await vi.waitFor(
      () => expect(observed.arrays.some((values) => values.length === 1_000)).toBe(true),
      { timeout: 2000 },
    )
    await vi.waitFor(() => expect(f.drains.pending).toBe(0), { timeout: 2000 })
    observed.check()
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

  test('the fetch deadline starts after the snapshot reservation finishes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const loaded = Promise.withResolvers<string | null>()
    const withheld = Promise.withResolvers<HubFetchTopicResult>()
    vi.spyOn(f.cursor, 'load').mockReturnValueOnce(loaded.promise)
    const fetch = vi.spyOn(f.hub, 'fetchTopic').mockReturnValue(withheld.promise)
    let settled = false
    const task = f.lane.deliver().then(() => {
      settled = true
    })
    try {
      await flush()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(fetch).not.toHaveBeenCalled()
      loaded.resolve(null)
      await flush()
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
    } finally {
      loaded.resolve(null)
      withheld.resolve(empty())
      await task
    }
  })

  test('resets coalesce ahead-hint retries behind a hanging handler across generations', async () => {
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = fixture({
      handler: () => {
        entered.resolve()
        return release.promise
      },
    })
    vi.spyOn(f.hub, 'fetchTopic')
      .mockResolvedValueOnce(page([entry('1', await f.sealed('held'))]))
      .mockResolvedValue(empty())
    const observed = collections()
    f.lane.kick()
    await entered.promise
    const then = Promise.prototype.then
    let continuations = 0
    Object.defineProperty(Promise.prototype, 'then', {
      configurable: true,
      writable: true,
      value: function (
        this: Promise<unknown>,
        fulfilled: Parameters<Promise<unknown>['then']>[0],
        rejected: Parameters<Promise<unknown>['then']>[1],
      ) {
        continuations++
        return then.call(this, fulfilled, rejected)
      },
    })
    try {
      for (let i = 0; i < 50; i++) {
        f.lane.reset()
        f.lane.note('chat', topicID, entry(position(i + 2)), new FrameEpochError(2, 1))
        await flush()
      }
      Object.defineProperty(Promise.prototype, 'then', { value: then })
      expect(f.drains.starts).toBe(2)
      expect(f.drains.peak).toBeLessThanOrEqual(2)
      expect(observed.pullMaps.size).toBeGreaterThan(0)
      expect(observed.peakControllers).toBeGreaterThan(0)
      expect(observed.peakControllers).toBeLessThanOrEqual(2)
      for (const pulls of observed.pullMaps) expect(pulls.size).toBeLessThanOrEqual(2)
      expect(continuations).toBeGreaterThan(0)
      expect(continuations).toBeLessThanOrEqual(20)
    } finally {
      Object.defineProperty(Promise.prototype, 'then', { value: then })
      release.resolve()
    }
    await vi.waitFor(() => expect(f.drains.pending).toBe(0))
    expect(f.drains.starts).toBe(3)
    for (const pulls of observed.pullMaps) expect(pulls.size).toBe(0)
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
        expect(fetch.mock.calls.length).toBeLessThanOrEqual(4)
      }
      expect(fetch).toHaveBeenCalledTimes(4)
      withheld.resolve(empty())
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(5)
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
        f.lane.note('chat', topicID, entry(position(i + 2)), new FrameEpochError(2, 1))
        f.lane.kick()
      }
      await flush()
      observed.check()
      expect(observed.arrays.some((values) => values.length === 1_000)).toBe(true)
      expect(f.drains.pending).toBe(2)
      expect(f.drains.peak).toBe(2)
      expect(peak).toBeLessThanOrEqual(2)
    } finally {
      release.resolve()
    }
    await vi.waitFor(() => expect(f.drains.pending).toBe(0))
    expect(f.drains.starts).toBeGreaterThan(1)
    vi.useFakeTimers()
    const withheld = Promise.withResolvers<void>()
    const concurrentFetch = vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async () => {
      outstanding++
      peak = Math.max(peak, outstanding)
      try {
        await withheld.promise
        return empty()
      } finally {
        outstanding--
      }
    })
    concurrentFetch.mockClear()
    const deliveries = Array.from({ length: 20 }, () => f.lane.deliver())
    try {
      await flush()
      expect(concurrentFetch).toHaveBeenCalledTimes(2)
      expect(outstanding).toBe(2)
      expect(peak).toBe(2)
      await vi.advanceTimersByTimeAsync(10_000)
      await Promise.all(deliveries)
    } finally {
      withheld.resolve()
      await Promise.all(deliveries)
      vi.useRealTimers()
    }
    concurrentFetch.mockImplementation(async () => page([entry(position(sequence++))], true))
    for (let i = 0; i < 200; i++) {
      await f.lane.deliver()
      observed.check()
      expect(f.drains.peak).toBeLessThanOrEqual(2)
      expect(peak).toBeLessThanOrEqual(4)
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

  test('reordered entries are sorted and duplicate positions are skipped', async () => {
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
    expect(f.seen).toEqual(['backwards', 'first', 'last'])
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

test.each([false, true])(
  'reordered pages deliver both frames without skipping, durable=%s',
  async (durable) => {
    const f = fixture({ durable })
    const messages = [entry('2', await f.sealed('second')), entry('1', await f.sealed('first'))]
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async ({ after }) =>
      after == null ? page(messages) : empty(),
    )
    f.lane.kick()
    await vi.waitFor(() => expect(f.cursor.stored(topicID)).toBe('2'), { timeout: 2000 })
    expect(f.seen).toEqual(['first', 'second'])
  },
)

test.each([false, true])(
  'one kick drains 1001 retained frames across pull budgets, durable=%s',
  async (durable) => {
    const f = fixture({ durable })
    const messages = await Promise.all(
      Array.from({ length: 1001 }, async (_, i) =>
        entry(position(i + 1), await f.sealed(String(i + 1))),
      ),
    )
    const perPull = new Map<AbortSignal | undefined, number>()
    const fetch = f.mux.fetchTopic
    vi.spyOn(f.mux, 'fetchTopic').mockImplementation((request) => {
      perPull.set(request.signal, (perPull.get(request.signal) ?? 0) + 1)
      return fetch(request)
    })
    vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async ({ after, limit }) =>
      page(
        messages.filter((message) => after == null || message.sequenceID > after).slice(0, limit),
      ),
    )
    f.lane.kick()
    await vi.waitFor(() => expect(f.cursor.stored(topicID)).toBe(position(1001)), { timeout: 5000 })
    expect(f.seen).toHaveLength(1001)
    expect(perPull.size).toBeGreaterThan(2)
    for (const count of perPull.values()) expect(count).toBeLessThanOrEqual(4)
  },
)

test('one kick continues after a byte budget', async () => {
  const f = fixture()
  const messages = Array.from({ length: 5 }, (_, i) =>
    entry(position(i + 1), new Uint8Array(1024 * 1024)),
  )
  vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async ({ after }) =>
    page(messages.filter((message) => after == null || message.sequenceID > after)),
  )
  f.lane.kick()
  await vi.waitFor(() => expect(f.cursor.stored(topicID)).toBe(position(5)), { timeout: 2000 })
})

test('one kick continues after a fetch deadline when the hub heals', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const withheld = Promise.withResolvers<HubFetchTopicResult>()
  vi.spyOn(f.hub, 'fetchTopic')
    .mockReturnValueOnce(withheld.promise)
    .mockResolvedValueOnce(page([entry('1', await f.sealed('healed'))]))
    .mockResolvedValue(empty())
  try {
    f.lane.kick()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(f.cursor.stored(topicID)).toBe('1'), { timeout: 1000 })
    expect(f.seen).toEqual(['healed'])
  } finally {
    f.lane.dispose()
    withheld.resolve(empty())
  }
})

test('two aborted hung fetches leave capacity to deliver after the hub heals', async () => {
  const f = fixture()
  const withheld = Promise.withResolvers<HubFetchTopicResult>()
  const fetch = vi
    .spyOn(f.hub, 'fetchTopic')
    .mockReturnValueOnce(withheld.promise)
    .mockReturnValueOnce(withheld.promise)
    .mockResolvedValueOnce(page([entry('1', await f.sealed('healed'))]))
    .mockResolvedValue(empty())
  const controller = new AbortController()
  const initial = Promise.allSettled([
    f.mux.fetchTopic({ topicID, signal: controller.signal }),
    f.mux.fetchTopic({ topicID, signal: controller.signal }),
  ])
  controller.abort()
  await initial
  try {
    f.lane.kick()
    await vi.waitFor(() => expect(f.cursor.stored(topicID)).toBe('1'), { timeout: 1000 })
    expect(f.seen).toEqual(['healed'])
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally {
    f.lane.dispose()
    withheld.resolve(page([entry('2', await f.sealed('late'))]))
  }
})

test('mux propagates abort to cancellable requests and bounds uncancellable requests', async () => {
  const f = fixture()
  let outstanding = 0
  let peak = 0
  const abort = vi.fn()
  const fetch = vi.spyOn(f.hub, 'fetchTopic').mockImplementation(() => {
    const pending = Promise.withResolvers<HubFetchTopicResult>()
    outstanding++
    peak = Math.max(peak, outstanding)
    return Object.assign(
      pending.promise.finally(() => {
        outstanding--
      }),
      {
        abort: () => {
          abort()
          pending.reject(new Error('cancelled'))
        },
      },
    )
  })
  for (let i = 0; i < 20; i++) {
    const controller = new AbortController()
    const task = f.mux.fetchTopic({ topicID, signal: controller.signal })
    controller.abort()
    await expect(task).rejects.toThrow()
  }
  expect(abort).toHaveBeenCalledTimes(20)
  expect(peak).toBeLessThanOrEqual(2)
  const withheld = Promise.withResolvers<HubFetchTopicResult>()
  fetch.mockReturnValue(withheld.promise)
  const before = fetch.mock.calls.length
  try {
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController()
      const task = f.mux.fetchTopic({ topicID, signal: controller.signal })
      controller.abort()
      await expect(task).rejects.toThrow()
    }
    expect(fetch.mock.calls.length - before).toBe(4)
  } finally {
    withheld.resolve(empty())
  }
})

test('replayed pages cannot spend byte budgets forever without cursor progress', async () => {
  const f = fixture()
  let calls = 0
  const message = entry('1', new Uint8Array(1024 * 1024))
  vi.spyOn(f.hub, 'fetchTopic').mockImplementation(async () => {
    if (++calls > 5) throw new Error('bounded replay spin guard')
    return page(Array.from({ length: 100 }, () => message))
  })
  f.lane.kick()
  await vi.waitFor(() => expect(f.cursor.stored(topicID)).toBe('1'), { timeout: 1000 })
  await vi.waitFor(() => expect(f.drains.pending).toBe(0), { timeout: 1000 })
  expect(calls).toBeLessThanOrEqual(2)
})
