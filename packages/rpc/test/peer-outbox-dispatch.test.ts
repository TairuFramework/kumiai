import { encodeEventFrame } from '@kumiai/broadcast'
import { expect, test, vi } from 'vitest'

import {
  type AppOutboxEntry,
  createAppOutboxAcceptance,
  MAX_APP_ENTRY_BYTES,
} from '../src/app-outbox.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'
import { makeMLSPeer } from './fixtures/peer.js'
import { deferred } from './fixtures/single-connection-host.js'

const entry = (text: string) => ({
  protocol: 'chat',
  prc: 'chat/posted',
  data: encodeEventFrame('chat/posted', { text }),
})
const admissible = () => ({ epoch: 1, admissible: true as const })

test('delayed first insert fences later accepted entries in call order', async () => {
  const store = createMemoryAppOutbox()
  const gate = deferred<void>()
  const queue = createAppOutboxAcceptance({
    outbox: {
      ...store,
      put: async (row) => {
        if (row.seq === 0) await gate.promise
        await store.put(row)
      },
    },
    limit: 4,
    admission: admissible,
  })
  await queue.ready()
  let resolved = false
  const first = queue.accept(entry('first')).then(() => {
    resolved = true
  })
  const second = queue.accept(entry('second'))
  await second
  expect(resolved).toBe(false)
  expect(queue.entries().map((row) => row.seq)).toEqual([1])
  expect(queue.lowestUnresolvedSeq()).toBe(0)
  expect(
    queue
      .entries()
      .filter((row) => row.seq < (queue.lowestUnresolvedSeq() ?? Number.POSITIVE_INFINITY)),
  ).toEqual([])
  gate.resolve()
  await first
  expect(queue.lowestUnresolvedSeq()).toBeNull()
  expect(queue.entries().map((row) => row.seq)).toEqual([0, 1])
  queue.close()
})

test('rejected atomic put releases its reservation and capacity', async () => {
  const store = createMemoryAppOutbox()
  const gate = deferred<void>()
  const queue = createAppOutboxAcceptance({
    outbox: {
      ...store,
      put: async (row) => {
        if (row.seq === 0) {
          await gate.promise
          throw new Error('disk refused')
        }
        await store.put(row)
      },
    },
    limit: 2,
    admission: admissible,
  })
  await queue.ready()
  const first = queue.accept(entry('first')).catch((error: unknown) => error)
  await queue.accept(entry('second'))
  expect(queue.lowestUnresolvedSeq()).toBe(0)
  gate.resolve()
  expect(await first).toMatchObject({ message: 'disk refused' })
  expect(queue.lowestUnresolvedSeq()).toBeNull()
  await queue.accept(entry('third'))
  expect((await store.list()).map((row) => row.seq)).toEqual([1, 2])
  queue.close()
})

test('one free slot accepts exactly one caller and counts unresolved puts', async () => {
  const store = createMemoryAppOutbox()
  await store.put({ ...entry('restored'), seq: 7, lastAttempt: null })
  const gate = deferred<void>()
  const queue = createAppOutboxAcceptance({
    outbox: {
      ...store,
      put: async (row) => {
        await gate.promise
        await store.put(row)
      },
    },
    limit: 2,
    admission: admissible,
  })
  await queue.ready()
  const first = queue.accept(entry('first'))
  await expect(queue.accept(entry('second'))).rejects.toMatchObject({ name: 'AppOutboxFullError' })
  expect(queue.lowestUnresolvedSeq()).toBe(8)
  expect(await store.list()).toHaveLength(1)
  gate.resolve()
  await first
  await expect(queue.accept(entry('third'))).rejects.toMatchObject({ name: 'AppOutboxFullError' })
  expect((await store.list()).map((row) => row.seq)).toEqual([7, 8])
  queue.close()
})

test('pre-init calls resume in order after a failed listing without losing calls', async () => {
  vi.useFakeTimers()
  const store = createMemoryAppOutbox()
  let failures = 1
  const queue = createAppOutboxAcceptance({
    outbox: {
      ...store,
      list: async () => {
        if (failures-- > 0) throw new Error('listing unavailable')
        return store.list()
      },
    },
    limit: 2,
    admission: admissible,
  })
  try {
    const first = queue.accept(entry('first'))
    const second = queue.accept(entry('second'))
    await Promise.resolve()
    expect(queue.entries()).toEqual([])
    expect(queue.lowestUnresolvedSeq()).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([first, second])
    expect(queue.entries().map((row) => row.data)).toEqual([
      entry('first').data,
      entry('second').data,
    ])
    await expect(store.list()).resolves.toHaveLength(2)
  } finally {
    queue.close()
    vi.useRealTimers()
  }
})

test('entry bound rejects before allocating a sequence and accepts the exact boundary', async () => {
  const store = createMemoryAppOutbox()
  const queue = createAppOutboxAcceptance({ outbox: store, limit: 2, admission: admissible })
  await queue.ready()
  expect(MAX_APP_ENTRY_BYTES).toBe(524_288)
  await expect(
    queue.accept({ ...entry('large'), data: new Uint8Array(524_289) }),
  ).rejects.toMatchObject({ name: 'AppEntryTooLargeError' })
  expect(queue.lowestUnresolvedSeq()).toBeNull()
  await queue.accept({ ...entry('boundary'), data: new Uint8Array(524_288) })
  expect((await store.list())[0]).toMatchObject({ seq: 0, lastAttempt: null })
  queue.close()
})

test('lapsed sender is refused with its reason before allocating', async () => {
  const store = createMemoryAppOutbox()
  const queue = createAppOutboxAcceptance({
    outbox: store,
    limit: 2,
    admission: () => ({ epoch: 9, admissible: false, reason: 'lapsed' }),
  })
  await queue.ready()
  await expect(queue.accept(entry('refused'))).rejects.toMatchObject({
    name: 'SendNotAdmissibleError',
    reason: 'lapsed',
  })
  expect(queue.lowestUnresolvedSeq()).toBeNull()
  expect(await store.list()).toEqual([])
  queue.close()
})

test('peer dispatch resolves only after durable put and never seals or publishes', async () => {
  const hub = new FakeHub()
  const store = createMemoryAppOutbox()
  const gate = deferred<void>()
  const member = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(1), {
    appOutbox: {
      ...store,
      put: async (row) => {
        await gate.promise
        await store.put(row)
      },
    },
    appOutboxLimit: 2,
  })
  const seal = vi.spyOn(member.crypto, 'wrap')
  let resolved = false
  const dispatch = member.peer
    .protocol('chat')
    .dispatch('chat/posted', { data: { text: 'durable' } })
    .then(() => {
      resolved = true
    })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(resolved).toBe(false)
  expect(await store.list()).toEqual([])
  gate.resolve()
  await dispatch
  expect(resolved).toBe(true)
  expect(await store.list()).toEqual([{ ...entry('durable'), seq: 0, lastAttempt: null }])
  expect(seal).not.toHaveBeenCalled()
  expect(hub.published).toEqual([])
  await member.peer.dispose()
  await member.peer.drained()
})

test('a live listing failure cannot erase accepted entries or pending reservations', async () => {
  const store = createMemoryAppOutbox()
  const gate = deferred<void>()
  let failList = false
  const outbox = {
    ...store,
    list: async () => {
      if (failList) throw new Error('listing unavailable')
      return store.list()
    },
    put: async (row: AppOutboxEntry) => {
      if (row.seq === 0) await gate.promise
      await store.put(row)
    },
  }
  const queue = createAppOutboxAcceptance({ outbox, limit: 3, admission: admissible })
  await queue.ready()
  const first = queue.accept(entry('first'))
  await queue.accept(entry('second'))
  failList = true
  await expect(outbox.list()).rejects.toThrow('listing unavailable')
  expect(queue.lowestUnresolvedSeq()).toBe(0)
  expect(queue.entries().map((row) => row.seq)).toEqual([1])
  await queue.accept(entry('third'))
  await expect(queue.accept(entry('fourth'))).rejects.toMatchObject({ name: 'AppOutboxFullError' })
  gate.resolve()
  await first
  expect(queue.entries().map((row) => row.seq)).toEqual([0, 1, 2])
  expect((await store.list()).map((row) => row.seq)).toEqual([0, 1, 2])
  queue.close()
})

test('peer enforces the encoded plaintext boundary and lapsed admission before durable acceptance', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(2))
  const overhead = encodeEventFrame('chat/posted', { text: '' }).byteLength
  const text = 'x'.repeat(524_288 - overhead)
  await expect(
    member.peer.protocol('chat').dispatch('chat/posted', { data: { text: `${text}x` } }),
  ).rejects.toMatchObject({ name: 'AppEntryTooLargeError' })
  expect(await member.appOutbox.list()).toEqual([])
  await member.peer.protocol('chat').dispatch('chat/posted', { data: { text } })
  expect((await member.appOutbox.list())[0]?.data.byteLength).toBe(524_288)
  expect((await member.appOutbox.list())[0]?.seq).toBe(0)
  vi.spyOn(member.mls, 'sendAdmission').mockReturnValue({
    epoch: 1,
    admissible: false,
    reason: 'lapsed',
  })
  await expect(
    member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'lapsed' } }),
  ).rejects.toMatchObject({ name: 'SendNotAdmissibleError', reason: 'lapsed' })
  expect(await member.appOutbox.list()).toHaveLength(1)
  await member.peer.dispose()
  await member.peer.drained()
})

test('drained waits for a host outbox put already in flight', async () => {
  const store = createMemoryAppOutbox()
  const gate = deferred<void>()
  const entered = deferred<void>()
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(3), {
    appOutbox: {
      ...store,
      put: async (row) => {
        entered.resolve()
        await gate.promise
        await store.put(row)
      },
    },
  })
  const dispatch = member.peer.protocol('chat').dispatch('chat/posted', { data: {} })
  await entered.promise
  await member.peer.dispose()
  let drained = false
  const drain = member.peer.drained().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  await expect(
    member.peer.protocol('chat').dispatch('chat/posted', { data: {} }),
  ).rejects.toMatchObject({ name: 'PeerDisposedError' })
  gate.resolve()
  await dispatch
  await drain
  expect(await store.list()).toHaveLength(1)
})

test('disposal rejects pre-list callers and cancels listing retries', async () => {
  vi.useFakeTimers()
  const store = createMemoryAppOutbox()
  const list = vi.fn(async () => {
    throw new Error('offline')
  })
  const queue = createAppOutboxAcceptance({
    outbox: { ...store, list },
    limit: 1,
    admission: admissible,
  })
  try {
    const pending = queue.accept(entry('waiting')).catch((error: unknown) => error)
    await Promise.resolve()
    queue.close()
    expect(await pending).toMatchObject({ name: 'PeerDisposedError' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(list).toHaveBeenCalledTimes(1)
    expect(await store.list()).toEqual([])
  } finally {
    queue.close()
    vi.useRealTimers()
  }
})

test.each([1, 2])('listing handoff preserves call order with %i free slots', async (limit) => {
  const store = createMemoryAppOutbox()
  const listing = deferred<Array<AppOutboxEntry>>()
  const queue = createAppOutboxAcceptance({
    outbox: { ...store, list: () => listing.promise },
    limit,
    admission: admissible,
  })
  try {
    const first = queue.accept(entry('first'))
    listing.resolve([])
    const second = Promise.resolve().then(() => queue.accept(entry('second')))
    const results = await Promise.allSettled([first, second])
    expect(results[0]?.status).toBe('fulfilled')
    if (limit === 1) {
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { name: 'AppOutboxFullError' },
      })
    } else {
      expect(results[1]?.status).toBe('fulfilled')
    }
    const rows = await store.list()
    expect(rows[0]).toMatchObject({ seq: 0, data: entry('first').data })
    if (limit === 2) expect(rows[1]).toMatchObject({ seq: 1, data: entry('second').data })
  } finally {
    queue.close()
  }
})

test('removal refuses acceptance with a distinct error while disposal retains its error', async () => {
  const queue = createAppOutboxAcceptance({
    outbox: createMemoryAppOutbox(),
    limit: 2,
    admission: admissible,
  })
  await queue.ready()
  queue.stop()
  await expect(queue.accept(entry('removed'))).rejects.toMatchObject({ name: 'PeerRemovedError' })
  queue.close()
  await expect(queue.accept(entry('disposed'))).rejects.toMatchObject({ name: 'PeerDisposedError' })
})
