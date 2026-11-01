import type { StoredMessage } from '@kumiai/hub-protocol'
import { afterEach, expect, test, vi } from 'vitest'

import * as intakeModule from '../src/buffered-control.js'
import { bindControlBatch } from '../src/control-batch.js'
import * as muxModule from '../src/hub-mux.js'
import { commitTopic } from '../src/topic.js'
import { FAKE_BASE_SECRET } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function setup() {
  let intake: intakeModule.BufferedControlIntake | undefined
  let ingress: muxModule.InboundListener | undefined
  const createIntake = intakeModule.createBufferedControlIntake
  vi.spyOn(intakeModule, 'createBufferedControlIntake').mockImplementation((params) => {
    intake = createIntake(params)
    return intake
  })
  const topicID = commitTopic(FAKE_BASE_SECRET)
  const createMux = muxModule.createHubMux
  vi.spyOn(muxModule, 'createHubMux').mockImplementation((params) => {
    const mux = createMux(params)
    const onInbound = mux.onInbound
    mux.onInbound = (topic, listener, options) => {
      if (topic === topicID) ingress = listener
      return onInbound(topic, listener, options)
    }
    return mux
  })
  const hub = new FakeHub()
  const mls = createMemoryGroupMLS({ recoverySecret: FAKE_BASE_SECRET })
  const owner = Promise.withResolvers<void>()
  const selected = vi.fn()
  bindControlBatch(mls, {
    key: mls.control().key,
    run: async () => {
      selected()
      await owner.promise
      throw new Error('Recording owner released without preparing control')
    },
  })
  const member = makeMLSPeer(hub, 'local', FAKE_BASE_SECRET, { mls })
  await member.peer.replay()
  await flush()
  if (intake === undefined || ingress === undefined) throw new Error('Missing peer intake')
  const fetch = vi.spyOn(hub, 'fetchTopic')
  const wake = () =>
    hub.publish({ topicID, senderDID: 'remote', payload: new Uint8Array([0]), retain: 'log' })
  const frame = (position: number): StoredMessage => ({
    topicID,
    senderDID: 'remote',
    sequenceID: String(position).padStart(6, '0'),
    payload: new Uint8Array([255]),
  })
  return {
    ...member,
    hub,
    topicID,
    intake,
    ingress,
    selected,
    fetch,
    frame,
    wake,
    release: () => owner.resolve(),
    async close() {
      owner.resolve()
      await member.peer.dispose()
      await member.peer.drained()
    },
  }
}

function consume(intake: intakeModule.BufferedControlIntake): string | undefined {
  const current = intake.next()
  if (current === undefined) return
  const position = current.page.result.messages[current.index]?.sequenceID
  if (position === undefined) throw new Error('Missing checked occurrence')
  intake.consumed({
    generation: current.page.generation,
    topicID: current.page.topicID,
    position,
  })
  return position
}

test('peer caps checked control at two pages behind a held owner and resumes without loss', async () => {
  const s = await setup()
  try {
    const frames = Array.from({ length: 2500 }, (_, i) => s.frame(i + 1))
    const buffered = new Set<intakeModule.BufferedControlPage>()
    let maxPages = 0
    let maxFrames = 0
    let bufferedFrames = 0
    const offer = s.intake.offer.bind(s.intake)
    vi.spyOn(s.intake, 'offer').mockImplementation((page) => {
      offer(page)
      if (page.result.messages.length > 0) buffered.add(page)
      bufferedFrames += page.result.messages.length
      maxPages = Math.max(maxPages, buffered.size)
      maxFrames = Math.max(maxFrames, bufferedFrames)
    })
    const consumed = s.intake.consumed.bind(s.intake)
    vi.spyOn(s.intake, 'consumed').mockImplementation((input) => {
      const before = s.intake.next()
      consumed(input)
      if (before !== undefined) {
        bufferedFrames--
        if (s.intake.next()?.page !== before.page) buffered.delete(before.page)
      }
    })
    s.fetch.mockImplementation(async ({ topicID, after, limit }) => ({
      messages:
        topicID === s.topicID
          ? frames.filter((frame) => after == null || frame.sequenceID > after).slice(0, limit)
          : [],
      head: topicID === s.topicID ? (frames.at(-1)?.sequenceID ?? null) : null,
      oldest: topicID === s.topicID ? (frames[0]?.sequenceID ?? null) : null,
      gap: false,
    }))
    await s.wake()
    await flush()
    expect(s.selected).toHaveBeenCalledOnce()
    expect(maxPages).toBe(2)
    expect(maxFrames).toBe(200)
    expect(s.fetch.mock.calls.filter(([request]) => request.topicID === s.topicID)).toHaveLength(2)
    s.release()
    const applied: Array<string> = []
    for (let turn = 0; turn < 40; turn++) {
      let position = consume(s.intake)
      while (position !== undefined) {
        applied.push(position)
        position = consume(s.intake)
      }
      await flush()
    }
    expect(applied).toEqual(frames.map((frame) => frame.sequenceID))
    expect(maxPages).toBe(2)
    expect(maxFrames).toBeLessThanOrEqual(200)
    expect(s.intake.next()).toBeUndefined()
    expect(
      s.fetch.mock.calls.every(
        ([request]) => request.topicID !== s.topicID || request.limit === 100,
      ),
    ).toBe(true)
  } finally {
    await s.close()
  }
})

test('peer services a commit wakeup between fetch loop completion and cleanup', async () => {
  const s = await setup()
  try {
    let injected = false
    const offer = s.intake.offer.bind(s.intake)
    vi.spyOn(s.intake, 'offer').mockImplementation((page) => {
      offer(page)
      page.result.messages = new Proxy(page.result.messages, {
        get(target, property, receiver) {
          // Inject after offering the short page, just before the fetch loop exits.
          if (property === 'length' && !injected) {
            injected = true
            s.ingress(s.frame(2), () => {})
          }
          return Reflect.get(target, property, receiver)
        },
      })
    })
    let calls = 0
    s.fetch.mockImplementation(async ({ topicID }) => {
      if (topicID !== s.topicID) return { messages: [], head: null, oldest: null, gap: false }
      calls++
      return { messages: [s.frame(calls)], head: '000002', oldest: '000001', gap: false }
    })
    await s.wake()
    await flush()
    expect(injected).toBe(true)
    expect(calls).toBe(2)
    expect(consume(s.intake)).toBe('000001')
    expect(consume(s.intake)).toBe('000002')
  } finally {
    await s.close()
  }
})

test.each([false, true])(
  'peer retries a quiet failed control fetch after 1000ms, cancelled on dispose / %s',
  async (dispose) => {
    const s = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let calls = 0
      s.fetch.mockImplementation(async ({ topicID }) => {
        if (topicID !== s.topicID) return { messages: [], head: null, oldest: null, gap: false }
        if (++calls === 1) throw new Error('Transient fetch failure')
        return { messages: [s.frame(1)], head: '000001', oldest: '000001', gap: false }
      })
      await s.wake()
      await flush()
      expect(calls).toBe(1)
      expect(s.intake.next()).toBeUndefined()
      const timers = vi.getTimerCount()
      if (dispose) {
        await s.peer.dispose()
        expect(vi.getTimerCount()).toBeLessThan(timers)
      }
      await vi.advanceTimersByTimeAsync(999)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(dispose ? 1 : 2)
      expect(consume(s.intake)).toBe(dispose ? undefined : '000001')
      if (!dispose) {
        await vi.advanceTimersByTimeAsync(60_000)
        expect(calls).toBe(2)
      }
    } finally {
      await s.close()
    }
  },
)

test('peer doubles control retry delay up to 60000ms and resets it after success', async () => {
  const s = await setup()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let failures = 8
    let calls = 0
    let delivered = 0
    s.fetch.mockImplementation(async ({ topicID }) => {
      if (topicID !== s.topicID) return { messages: [], head: null, oldest: null, gap: false }
      calls++
      if (failures-- > 0) throw new Error('Transient fetch failure')
      const message = s.frame(++delivered)
      return { messages: [message], head: message.sequenceID, oldest: '000001', gap: false }
    })
    await s.wake()
    await flush()
    expect(calls).toBe(1)
    for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
      s.ingress(s.frame(999), () => {})
      await flush()
      expect(calls).toBe(index + 1)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(calls).toBe(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(index + 2)
    }
    expect(consume(s.intake)).toBe('000001')
    failures = 1
    await s.wake()
    await flush()
    expect(calls).toBe(10)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toBe(10)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(11)
    expect(consume(s.intake)).toBe('000002')
  } finally {
    await s.close()
  }
})

test.each(['resolve', 'reject'] as const)(
  'peer ignores an active control fetch settling after disposal / %s',
  async (outcome) => {
    const s = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = Promise.withResolvers<void>()
      let calls = 0
      s.fetch.mockImplementation(async ({ topicID }) => {
        if (topicID !== s.topicID) return { messages: [], head: null, oldest: null, gap: false }
        calls++
        await pending.promise
        return { messages: [s.frame(1)], head: '000001', oldest: '000001', gap: false }
      })
      const offer = vi.spyOn(s.intake, 'offer')
      await s.wake()
      await flush()
      expect(calls).toBe(1)
      await s.peer.dispose()
      if (outcome === 'resolve') pending.resolve()
      else pending.reject(new Error('Late fetch failure'))
      await flush()
      expect(offer).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
    } finally {
      await s.close()
    }
  },
)
