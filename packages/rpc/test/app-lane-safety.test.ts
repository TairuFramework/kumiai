import { encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { type AppLane, createAppLane } from '../src/app-lane.js'
import type { SafetyHold } from '../src/control/safety.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { GroupSafetyHeldError } from '../src/errors.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { testAppLaneParams } from './fixtures/app-lane.js'
import { completeTestRecord, createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { chat } from './fixtures/peer.js'

const lanes: Array<AppLane> = []
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.dispose()
  vi.restoreAllMocks()
})
const reasons = ['fork-halted', 'recovery-unavailable'] as const

async function fixture() {
  let hold: SafetyHold = null
  const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
  const topicID = protocolTopic(anchor.secret, 1, 'chat')
  const records = new Map<string, PendingAppFrame>()
  const complete = vi.fn(async (id: string) => {
    records.delete(id)
  })
  const reader = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    pending: {
      persistOpened: async (_state, record) => {
        records.set(record.frame.id, record)
      },
      list: async () => [...records.values()],
      complete,
    },
  })
  const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const messages = await Promise.all(
    ['000000000001', '000000000002'].map(async (sequenceID) => ({
      sequenceID,
      senderDID: 'alice',
      topicID,
      payload: await sender.wrap(encodeEventFrame('chat/posted', { sequenceID }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })),
  )
  const fetch = vi.fn(async ({ after }: { after?: string }) => ({
    messages: messages.filter((message) => after == null || message.sequenceID > after),
    head: messages.at(-1)?.sequenceID ?? null,
    oldest: messages[0]?.sequenceID ?? null,
    gap: false,
  }))
  const retain = vi.fn()
  const cursor = createMemoryAppCursorStore()
  const emit = vi.fn(async () => {})
  const held = vi.fn((reason: NonNullable<SafetyHold>) => {
    hold ??= reason
  })
  const lane = createAppLane(
    testAppLaneParams({
      groupKey: { groupID: 'group', incarnation: 1 },
      mux: { retainTopic: retain, fetchTopic: fetch } as never,
      appliedEpoch: () => reader.epoch(),
      crypto: reader,
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map([['chat', { emit }]]) as never,
      retentionSeconds: 60,
      appCursorStore: cursor,
      anchor: () => anchor,
      groupID: () => 'group',
      safetyHold: () => hold,
      onSafetyHeld: held,
    }),
  )
  lanes.push(lane)
  return {
    lane,
    reader,
    records,
    cursor,
    topicID,
    messages,
    fetch,
    retain,
    emit,
    held,
    complete,
    halt: (reason: NonNullable<SafetyHold>) => {
      hold = reason
    },
    safetyHold: () => hold,
  }
}

test.each(reasons)('two-frame drain stops at next open under %s', async (reason) => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const open = f.reader.unwrap.bind(f.reader)
  const unwrap = vi.spyOn(f.reader, 'unwrap').mockImplementation(async (...args) => {
    const result = await open(...args)
    entered.resolve()
    await release.promise
    return result
  })
  const drain = f.lane.deliver()
  await entered.promise
  f.halt(reason)
  release.resolve()
  await drain
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce())
  expect(unwrap).toHaveBeenCalledOnce()
  expect(f.cursor.stored(f.topicID)).toBe('000000000001')
  f.fetch.mockClear()
  f.retain.mockClear()
  await f.lane.deliver()
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.retain).not.toHaveBeenCalled()
  expect(unwrap).toHaveBeenCalledOnce()
  // The unopened ciphertext remains droppable, rather than being silently consumed.
  await f.lane.dropFrame(f.topicID, '000000000002')
  expect(f.cursor.stored(f.topicID)).toBe('000000000002')
})

test('terminal plaintext completion ignores sealed predecessors without fetching or opening', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    const first = f.messages[0]
    if (first === undefined) throw new Error('Missing frame')
    first.payload = await createFakeCrypto({ epoch: 2, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', { sealed: true }),
      { aad: encodeAppAAD({ topicID: f.topicID, intent: 'log' }) },
    )
    f.fetch.mockImplementation(async ({ after }) => ({
      messages: after == null ? [first] : [],
      head: first.sequenceID,
      oldest: first.sequenceID,
      gap: false,
    }))
    await f.lane.deliver()
    const record = completeTestRecord(
      {
        frame: {
          id: 'already-opened',
          topicID: f.topicID,
          protocol: 'chat',
          segment: 1,
          position: '000000000002',
        },
        senderDID: 'alice',
        payload: encodeEventFrame('chat/posted', { opened: true }),
      },
      { groupID: 'group', incarnation: 1 },
      'chat/posted',
      1,
    )
    f.records.set(record.frame.id, record)
    await f.lane.restore([record])
    const fetches = f.fetch.mock.calls.length
    const opens = f.reader.starts.unwrap
    let completed = false
    const completing = f.lane.completeOpened().then(() => {
      completed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.fetch).toHaveBeenCalledTimes(fetches)
    expect(f.reader.starts.unwrap).toBe(opens)
    expect(completed).toBe(true)
    expect(f.records.size).toBe(0)
    expect(f.emit).toHaveBeenCalledExactlyOnceWith(
      'chat/posted',
      expect.objectContaining({ data: { opened: true } }),
    )
    await completing
  } finally {
    f.lane.dispose()
    vi.useRealTimers()
  }
})

test('terminal completion awaits an already committed open whose result is still pending', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  const opened = Promise.withResolvers<void>()
  const returning = Promise.withResolvers<void>()
  const handler = Promise.withResolvers<void>()
  const unwrap = f.reader.unwrap.bind(f.reader)
  vi.spyOn(f.reader, 'unwrap').mockImplementation(async (...args) => {
    const result = await unwrap(...args)
    opened.resolve()
    await returning.promise
    return result
  })
  f.emit.mockImplementation(async () => {
    await handler.promise
  })
  const draining = f.lane.deliver()
  try {
    await opened.promise
    expect(f.records.size).toBe(1)
    let completed = false
    const completing = f.lane.completeOpened().then(() => {
      completed = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    returning.resolve()
    await draining
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    expect(f.emit).toHaveBeenCalledOnce()
    handler.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await completing
    expect(f.reader.starts.unwrap).toBe(1)
    expect(f.records.size).toBe(0)
  } finally {
    returning.resolve()
    handler.resolve()
    await draining
    f.lane.dispose()
    vi.useRealTimers()
  }
})

test.each([false, true])(
  'completed plaintext waits for the later cursor save to succeed, terminal=%s',
  async (terminal) => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      const first = f.messages[0]
      if (first === undefined) throw new Error('Missing frame')
      f.fetch.mockResolvedValue({
        messages: [first],
        head: first.sequenceID,
        oldest: first.sequenceID,
        gap: false,
      })
      const save = f.cursor.save
      let failures = 0
      let blocked = true
      f.cursor.save = async (topic, position) => {
        failures++
        if (blocked) throw new Error('Cursor save unavailable')
        await save(topic, position)
      }
      await f.lane.deliver()
      let completed = false
      const completing = terminal
        ? f.lane.completeOpened().then(() => {
            completed = true
          })
        : Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(failures).toBeGreaterThanOrEqual(1)
      expect(f.emit).toHaveBeenCalledOnce()
      expect(f.complete).toHaveBeenCalledOnce()
      expect(f.lane.pendingRecords()).toEqual([])
      expect(completed).toBe(false)
      expect(f.cursor.stored(f.topicID)).toBeNull()
      blocked = false
      if (!terminal) {
        await f.lane.deliver()
        expect(f.cursor.stored(f.topicID)).toBe(first.sequenceID)
      }
      await vi.advanceTimersByTimeAsync(100)
      expect(f.emit).toHaveBeenCalledOnce()
      expect(f.complete).toHaveBeenCalledOnce()
      await completing
      expect(f.cursor.stored(f.topicID)).toBe(first.sequenceID)
    } finally {
      f.lane.dispose()
      vi.useRealTimers()
    }
  },
)

test.each(reasons.flatMap((reason) => [false, true].map((delayed) => [reason, delayed] as const)))(
  'safety unwrap refusal stays retryable under %s (access await=%s)',
  async (reason, delayed) => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const unwrap = vi.spyOn(f.reader, 'unwrap').mockImplementation(async () => {
      entered.resolve()
      if (delayed) await release.promise
      throw new GroupSafetyHeldError(reason)
    })
    const drain = f.lane.deliver()
    await entered.promise
    if (delayed) expect(f.safetyHold()).toBeNull()
    release.resolve()
    await drain
    expect(f.held).toHaveBeenCalledExactlyOnceWith(reason)
    expect(f.safetyHold()).toBe(reason)
    expect(unwrap).toHaveBeenCalledOnce()
    expect(f.complete).not.toHaveBeenCalled()
    expect(f.records.size).toBe(0)
    expect(f.cursor.stored(f.topicID)).toBeNull()
    f.fetch.mockClear()
    f.lane.note('chat', f.topicID, { ...f.messages[0], logPosition: '000000000001' } as never, null)
    await f.lane.deliver()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(unwrap).toHaveBeenCalledOnce()
    await f.lane.dropFrame(f.topicID, '000000000001')
    expect(f.cursor.stored(f.topicID)).toBe('000000000001')
  },
)

test.each(
  reasons.flatMap((reason) => ['load', 'fetch'].map((boundary) => [reason, boundary] as const)),
)('halt after %s during %s prevents retain and open', async (reason, boundary) => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  if (boundary === 'load') {
    vi.spyOn(f.cursor, 'load').mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return null
    })
  } else {
    f.fetch.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { messages: f.messages, head: '000000000002', oldest: '000000000001', gap: false }
    })
  }
  const unwrap = vi.spyOn(f.reader, 'unwrap')
  const drain = f.lane.deliver()
  await entered.promise
  f.halt(reason)
  release.resolve()
  await drain
  expect(unwrap).not.toHaveBeenCalled()
  expect(f.cursor.stored(f.topicID)).toBeNull()
  expect(f.fetch).toHaveBeenCalledTimes(boundary === 'fetch' ? 1 : 0)
  expect(f.retain).toHaveBeenCalledTimes(boundary === 'fetch' ? 1 : 0)
})

test.each(reasons)('held note latches %s before any sync fetch', async (reason) => {
  const f = await fixture()
  f.lane.note(
    'chat',
    f.topicID,
    { ...f.messages[0], logPosition: '000000000001' } as never,
    new GroupSafetyHeldError(reason),
  )
  expect(f.safetyHold()).toBe(reason)
  await f.lane.deliver()
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.retain).not.toHaveBeenCalled()
  expect(f.cursor.stored(f.topicID)).toBeNull()
})

test.each(reasons)(
  'opened handler finishes and pending delivery retries under %s',
  async (reason) => {
    const f = await fixture()
    f.messages.splice(1)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.emit.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('retry this opened record')
    })
    await f.lane.deliver()
    await entered.promise
    f.halt(reason)
    f.fetch.mockClear()
    release.resolve()
    await vi.waitFor(() => expect(f.lane.pendingRecords()).toHaveLength(1))
    f.lane.retryDelivery()
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce())
    expect(f.emit).toHaveBeenCalledTimes(2)
    expect(f.cursor.stored(f.topicID)).toBe('000000000001')
    expect(f.fetch).not.toHaveBeenCalled()
  },
)
