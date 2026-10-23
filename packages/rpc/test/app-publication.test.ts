import { encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, expect, test, vi } from 'vitest'

import { type AppOutboxEntry, createAppOutboxAcceptance } from '../src/app-outbox.js'
import type { AppPublicationSnapshot, PreparedAppPublication } from '../src/app-publication.js'
import { createLogDelivery } from '../src/log-delivery.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

function fixture(limit = 8) {
  vi.useFakeTimers()
  let snapshot: AppPublicationSnapshot | null = {
    identity: { groupID: 'retry', incarnation: 1, epoch: 2, authenticator: new Uint8Array([2]) },
    stateVersion: 1,
    sealVersion: 0,
    segment: 2,
    topicID: 'topic',
  }
  const outbox = createMemoryAppOutbox({
    key: { groupID: 'retry', incarnation: 1 },
    snapshot: () => snapshot,
  })
  let allowed = true
  let safety = false
  const admission = () =>
    allowed
      ? { admissible: true as const, epoch: 2 }
      : { admissible: false as const, reason: 'rotation-required' as const, epoch: 2 }
  let queue = createAppOutboxAcceptance({ outbox, limit, admission })
  const prepare = vi.fn(
    async (entry: AppOutboxEntry, floor: string | null): Promise<PreparedAppPublication> => {
      if (snapshot === null) throw new Error('Retired')
      const updated = {
        ...entry,
        lastAttempt: {
          incarnation: snapshot.identity.incarnation,
          epoch: snapshot.identity.epoch,
          floor,
          attempts: (entry.lastAttempt?.attempts ?? 0) + 1,
          publishID: crypto.randomUUID(),
          segment: snapshot.segment,
          topicID: snapshot.topicID,
        },
      }
      await outbox.put(updated)
      return {
        entry: updated,
        payload: new Uint8Array([prepare.mock.calls.length]),
        snapshot: structuredClone(snapshot),
      }
    },
  )
  const publish =
    vi.fn<
      (frame: {
        topicID: string
        payload: Uint8Array
        publishID: string
      }) => Promise<{ sequenceID: string }> | null
    >()
  publish
    .mockRejectedValueOnce(new Error('offline'))
    .mockReturnValueOnce(null)
    .mockResolvedValue({ sequenceID: 'accepted' })
  const probe = vi.fn(async () => {
    return {
      messages: [],
      head: 'commit' as string | null,
      gap: false,
      oldest: null,
    }
  })
  const makeWorker = () =>
    createLogDelivery({
      queue,
      ready: async () => {},
      floor: () => ({ epoch: snapshot?.identity.epoch ?? 2, position: null, covered: true }),
      held: () => !allowed || safety,
      handoffHeld: () => safety,
      prepare,
      snapshot: async () => structuredClone(snapshot),
      loadSettlement: (seq) => outbox.loadSettlement(seq),
      publish,
      probe,
      pull: async () => {},
      heal: async () => {},
      remove: (seq) => outbox.remove(seq),
      clear: () => outbox.clear(),
      cleared: () => {},
      deliveredWindowMs: 1000,
      deliveredLimit: 8,
    })
  let worker = makeWorker()
  return {
    get queue() {
      return queue
    },
    prepare,
    publish,
    probe,
    get worker() {
      return worker
    },
    outbox,
    setAdmission: (value: boolean) => {
      allowed = value
    },
    setSafety: (value: boolean) => {
      safety = value
    },
    restart() {
      worker.close()
      queue.close()
      queue = createAppOutboxAcceptance({ outbox, limit, admission })
      worker = makeWorker()
    },
    setSnapshot: (value: AppPublicationSnapshot | null) => {
      snapshot = value
    },
    getSnapshot: () => snapshot,
    async tick(ms = 0) {
      await vi.advanceTimersByTimeAsync(ms)
      await flush()
    },
  }
}

test('failed and null handoff retry the same prepared bytes and ID', async () => {
  const f = fixture()
  try {
    await f.queue.accept({
      protocol: 'chat',
      prc: 'chat/posted',
      data: encodeEventFrame('chat/posted', {}),
    })
    f.worker.trigger()
    await f.tick()
    await f.tick(1000)
    await f.tick(2000)
    expect(f.publish).toHaveBeenCalledTimes(3)
    expect(f.publish.mock.calls[1]?.[0]).toEqual(f.publish.mock.calls[0]?.[0])
    expect(f.publish.mock.calls[2]?.[0]).toEqual(f.publish.mock.calls[0]?.[0])
    expect(f.prepare).toHaveBeenCalledTimes(1)
  } finally {
    f.worker.close()
    f.queue.close()
  }
})

test.each(['epoch', 'authenticator', 'topic'] as const)(
  'identity or anchor movement invalidates an unproven prepared frame (%s)',
  async (kind) => {
    const f = fixture()
    try {
      await f.queue.accept({
        protocol: 'chat',
        prc: 'chat/posted',
        data: encodeEventFrame('chat/posted', {}),
      })
      f.worker.trigger()
      await f.tick()
      const snapshot = f.getSnapshot()
      if (snapshot === null) throw new Error('Missing snapshot')
      f.setSnapshot(
        kind === 'topic'
          ? { ...snapshot, topicID: 'new-topic' }
          : {
              ...snapshot,
              identity: {
                ...snapshot.identity,
                ...(kind === 'epoch' ? { epoch: 3 } : { authenticator: new Uint8Array([3]) }),
              },
            },
      )
      await f.tick(1000)
      expect(f.prepare).toHaveBeenCalledTimes(2)
      expect(f.publish.mock.calls[1]?.[0].topicID).toBe(kind === 'topic' ? 'new-topic' : 'topic')
      expect(f.publish.mock.calls[1]?.[0].publishID).not.toBe(
        f.publish.mock.calls[0]?.[0].publishID,
      )
    } finally {
      f.worker.close()
      f.queue.close()
    }
  },
)

test('head-only movement keeps prepared app bytes', async () => {
  const f = fixture()
  try {
    await f.queue.accept({
      protocol: 'chat',
      prc: 'chat/posted',
      data: encodeEventFrame('chat/posted', {}),
    })
    f.worker.trigger()
    await f.tick()
    const snapshot = f.getSnapshot()
    if (snapshot === null) throw new Error('Missing snapshot')
    f.setSnapshot({
      ...snapshot,
      stateVersion: snapshot.stateVersion + 1,
      sealVersion: snapshot.sealVersion + 1,
    })
    await f.tick(1000)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.publish.mock.calls[1]?.[0]).toEqual(f.publish.mock.calls[0]?.[0])
  } finally {
    f.worker.close()
    f.queue.close()
  }
})

test('active reconstruction reseals unproven plaintext under a new ID', async () => {
  const f = fixture()
  try {
    await f.queue.accept({
      protocol: 'chat',
      prc: 'chat/posted',
      data: encodeEventFrame('chat/posted', { text: 'retained' }),
    })
    f.worker.trigger()
    await f.tick()
    const original = (await f.outbox.list())[0]
    f.restart()
    f.worker.trigger()
    await f.tick()
    const current = (await f.outbox.list())[0]
    expect(current?.data).toEqual(original?.data)
    expect(current?.lastAttempt?.attempts).toBe(2)
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.publish.mock.calls[1]?.[0].publishID).not.toBe(f.publish.mock.calls[0]?.[0].publishID)
    expect(f.publish.mock.calls[1]?.[0].payload).not.toEqual(f.publish.mock.calls[0]?.[0].payload)
  } finally {
    f.worker.close()
    f.queue.close()
  }
})

test('retired reconstruction never reseals an old entry', async () => {
  const f = fixture()
  try {
    await f.queue.accept({
      protocol: 'chat',
      prc: 'chat/posted',
      data: encodeEventFrame('chat/posted', {}),
    })
    f.worker.trigger()
    await f.tick()
    f.setSnapshot(null)
    f.restart()
    f.worker.trigger()
    await f.tick()
    await f.tick(1000)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.publish).toHaveBeenCalledTimes(1)
  } finally {
    f.worker.close()
    f.queue.close()
  }
})

test('a frame sealed below 500 can still hand off', async () => {
  const f = fixture()
  try {
    await f.queue.accept({
      protocol: 'chat',
      prc: 'chat/posted',
      data: encodeEventFrame('chat/posted', {}),
    })
    f.worker.trigger()
    await f.tick()
    f.setAdmission(false)
    await expect(
      f.queue.accept({
        protocol: 'chat',
        prc: 'chat/posted',
        data: encodeEventFrame('chat/posted', {}),
      }),
    ).rejects.toMatchObject({ reason: 'rotation-required' })
    await f.tick(1000)
    expect(f.publish).toHaveBeenCalledTimes(2)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    f.setSafety(true)
    await f.tick(2000)
    expect(f.publish).toHaveBeenCalledTimes(2)
  } finally {
    f.worker.close()
    f.queue.close()
  }
})

test('unavailable snapshot preserves prepared bytes until a fresh source is known', async () => {
  const f = fixture()
  try {
    await f.queue.accept({
      protocol: 'chat',
      prc: 'chat/posted',
      data: encodeEventFrame('chat/posted', {}),
    })
    f.worker.trigger()
    await f.tick()
    const snapshot = f.getSnapshot()
    f.setSnapshot(null)
    await f.tick(1000)
    expect(f.publish).toHaveBeenCalledTimes(1)
    f.setSnapshot(snapshot)
    await f.tick(1000)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.publish.mock.calls[1]?.[0]).toEqual(f.publish.mock.calls[0]?.[0])
  } finally {
    f.worker.close()
    f.queue.close()
  }
})

const message = (text: string) => {
  return {
    protocol: 'chat',
    prc: 'chat/posted',
    data: encodeEventFrame('chat/posted', { text }),
  }
}

test('a full outbox makes progress during rejoin and preserves resend order', async () => {
  const f = fixture(2)
  f.publish.mockReset().mockResolvedValue({ sequenceID: 'accepted' })
  f.probe.mockResolvedValue({ messages: [], head: null, gap: false, oldest: null })
  try {
    await f.queue.accept(message('old-first'))
    await f.queue.accept(message('old-second'))
    f.worker.trigger()
    await f.tick()
    expect(f.queue.entries()).toEqual([])
    await f.queue.accept(message('queued-first'))
    await f.queue.accept(message('queued-second'))
    f.worker.rejoined(2)
    await f.tick()
    await f.tick(1000)
    expect(f.publish).toHaveBeenCalledTimes(6)
    expect(f.queue.entries()).toEqual([])
    const originals = [message('old-first').data, message('old-second').data]
    const resends = f.prepare.mock.calls
      .slice(2)
      .map(([entry]) => entry.data)
      .filter((data) => {
        return originals.some(
          (old) => old.length === data.length && old.every((byte, index) => byte === data[index]),
        )
      })
    expect(resends).toEqual([message('old-first').data, message('old-second').data])
  } finally {
    f.worker.close()
    f.queue.close()
  }
})

test('a resend uses its own sequence across concurrent dispatch acceptance', async () => {
  const f = fixture()
  f.publish.mockReset().mockResolvedValue({ sequenceID: 'accepted' })
  f.probe.mockResolvedValue({ messages: [], head: null, gap: false, oldest: null })
  const dispatchEntered = Promise.withResolvers<void>()
  const resendEntered = Promise.withResolvers<void>()
  const releaseDispatch = Promise.withResolvers<void>()
  const releaseResend = Promise.withResolvers<void>()
  const put = f.outbox.put.bind(f.outbox)
  let dispatch: Promise<void> | undefined
  try {
    await f.queue.accept(message('resend'))
    f.worker.trigger()
    await f.tick()
    expect(f.queue.entries()).toEqual([])
    vi.spyOn(f.outbox, 'put').mockImplementation(async (entry) => {
      if (entry.lastAttempt === null) {
        if (entry.seq === 1) {
          dispatchEntered.resolve()
          await releaseDispatch.promise
        } else {
          resendEntered.resolve()
          await releaseResend.promise
        }
      }
      await put(entry)
    })
    dispatch = f.queue.accept(message('dispatch'))
    await dispatchEntered.promise
    f.worker.rejoined(2)
    const pass = f.tick()
    await resendEntered.promise
    releaseDispatch.resolve()
    await dispatch
    releaseResend.resolve()
    await pass
    expect(f.prepare.mock.calls[1]?.[0]).toMatchObject({ seq: 2, data: message('resend').data })
    expect(f.publish).toHaveBeenCalledTimes(3)
    expect(f.queue.entries()).toEqual([])
  } finally {
    releaseDispatch.resolve()
    releaseResend.resolve()
    await dispatch
    f.worker.close()
    f.queue.close()
  }
})
