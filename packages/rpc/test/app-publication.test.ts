import { Buffer } from 'node:buffer'
import { encodeEventFrame } from '@kumiai/broadcast'
import { afterEach, expect, test, vi } from 'vitest'

import { type AppOutboxEntry, createAppOutboxAcceptance } from '../src/app-outbox.js'
import type { AppPublicationSnapshot, PreparedAppPublication } from '../src/app-publication.js'
import { createLogDelivery } from '../src/log-delivery.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryAppOutbox } from './fixtures/outbox.js'
import { makeMLSPeer } from './fixtures/peer.js'

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
      recordSettlement: (seq, obligation, expected) =>
        outbox.recordSettlement(seq, obligation, expected),
      publish,
      probe,
      pull: async () => {},
      heal: async () => {},
      remove: (seq, outcome) => outbox.remove(seq, outcome),
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

test.each(['payload', 'plaintext', 'authenticator'] as const)(
  'prepared Buffer %s stays isolated from producer mutation across handoffs',
  async (field) => {
    const f = fixture()
    const plaintext = encodeEventFrame('chat/posted', {})
    const bytes = Buffer.from(field === 'plaintext' ? plaintext : [1])
    const prepare = f.prepare.getMockImplementation()
    if (prepare === undefined) throw new Error('Missing preparation')
    f.prepare.mockImplementation(async (...args) => {
      const frame = await prepare(...args)
      if (field === 'payload') frame.payload = bytes
      else if (field === 'plaintext') frame.entry.data = bytes
      else frame.snapshot.identity.authenticator = bytes
      return frame
    })
    if (field === 'authenticator') {
      const snapshot = f.getSnapshot()
      if (snapshot === null) throw new Error('Missing snapshot')
      f.setSnapshot({
        ...snapshot,
        identity: { ...snapshot.identity, authenticator: new Uint8Array([1]) },
      })
    }
    const handoffs: Array<{ publishID: string; payload: Array<number> }> = []
    f.publish.mockReset().mockImplementation((frame) => {
      handoffs.push({ publishID: frame.publishID, payload: Array.from(frame.payload) })
      return null
    })
    try {
      await f.queue.accept({ protocol: 'chat', prc: 'chat/posted', data: plaintext })
      f.worker.trigger()
      await f.tick()
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]?.payload).toEqual([1])
      bytes.fill(9)
      await f.tick(1000)
      expect(handoffs).toHaveLength(2)
      expect(handoffs[1]).toEqual({ publishID: handoffs[0]?.publishID, payload: [1] })
      expect(Array.from(f.queue.entries()[0]?.data ?? [])).toEqual(Array.from(plaintext))
      expect(f.prepare).toHaveBeenCalledTimes(1)
    } finally {
      f.worker.close()
      f.queue.close()
    }
  },
)

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

for (const path of ['no-new-head', 'covered-walk'] as const) {
  const proof = async (f: ReturnType<typeof fixture>) => {
    if (path === 'no-new-head') {
      f.probe.mockResolvedValue({ messages: [], head: null, gap: false, oldest: null })
      f.worker.trigger()
      await f.tick()
    } else {
      await f.worker.certify(2, f.worker.beginWalk())
      f.worker.trigger()
      await f.tick()
    }
  }
  const published = async () => {
    const f = fixture()
    f.publish.mockReset().mockResolvedValue({ sequenceID: 'app-position' })
    await f.queue.accept(message('proof'))
    f.worker.trigger()
    await f.tick()
    expect(f.publish).toHaveBeenCalledTimes(1)
    return f
  }
  test(`both proof paths persist an obligation before freezing proof (${path})`, async () => {
    const f = await published()
    const commit = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const record = f.outbox.recordSettlement.bind(f.outbox)
    const recordSpy = vi.spyOn(f.outbox, 'recordSettlement').mockImplementation(async (...args) => {
      entered.resolve()
      await commit.promise
      return await record(...args)
    })
    const remove = vi.spyOn(f.outbox, 'remove')
    const pending = proof(f)
    try {
      await f.tick()
      await flush()
      expect(recordSpy).toHaveBeenCalledTimes(1)
      expect(remove).not.toHaveBeenCalled()
      expect(f.queue.entries()).toHaveLength(1)
      expect((await f.outbox.events()).map((event) => event.kind)).toEqual(['accepted'])
      const attempt = f.queue.entries()[0]?.lastAttempt
      expect(recordSpy.mock.calls[0]).toEqual([
        0,
        {
          sequenceID: 'app-position',
          attemptID: attempt?.publishID,
          topicID: 'topic',
          outcome: 'published',
        },
        { identity: f.getSnapshot()?.identity, stateVersion: 1, attemptID: attempt?.publishID },
      ])
      commit.resolve()
      await pending
      expect(remove).toHaveBeenCalledTimes(1)
      expect((await f.outbox.events()).filter((event) => event.kind === 'published')).toMatchObject(
        [
          {
            occurrence: { position: 'app-position', topicID: 'topic', incarnation: 1, segment: 2 },
          },
        ],
      )
    } finally {
      commit.resolve()
      await pending
      f.worker.close()
      f.queue.close()
    }
  })
  test.each([
    'groupID',
    'identity',
    'epoch',
    'authenticator',
    'authenticator-length',
    'stateVersion',
    'sealVersion',
    'segment',
    'topic',
    'attempt',
    'attempt-topic',
    'null',
  ] as const)(`crossed or uncertain proof windows cannot certify (%s / ${path})`, async (kind) => {
    const f = await published()
    const record = vi.spyOn(f.outbox, 'recordSettlement')
    const original = structuredClone(f.getSnapshot())
    const mutate = () => {
      if (original === null) throw new Error('Missing snapshot')
      if (kind === 'null') f.setSnapshot(null)
      else if (kind === 'groupID')
        f.setSnapshot({ ...original, identity: { ...original.identity, groupID: 'other' } })
      else if (kind === 'epoch')
        f.setSnapshot({ ...original, identity: { ...original.identity, epoch: 3 } })
      else if (kind === 'authenticator-length')
        f.setSnapshot({
          ...original,
          identity: { ...original.identity, authenticator: new Uint8Array([2, 9]) },
        })
      else if (kind === 'identity')
        f.setSnapshot({ ...original, identity: { ...original.identity, incarnation: 2 } })
      else if (kind === 'authenticator')
        f.setSnapshot({
          ...original,
          identity: { ...original.identity, authenticator: new Uint8Array([9]) },
        })
      else if (kind === 'topic') f.setSnapshot({ ...original, topicID: 'other' })
      else if (kind !== 'attempt' && kind !== 'attempt-topic')
        f.setSnapshot({ ...original, [kind]: original[kind] + 1 })
      else {
        const entry = f.queue.entries()[0]
        if (entry?.lastAttempt == null) throw new Error('Missing attempt')
        f.queue.replace({
          ...entry,
          lastAttempt: {
            ...entry.lastAttempt,
            ...(kind === 'attempt'
              ? { publishID: 'replacement' }
              : { topicID: 'replacement-topic' }),
          },
        })
      }
    }
    try {
      if (path === 'covered-walk') {
        const started = f.worker.beginWalk()
        await flush()
        mutate()
        await f.worker.certify(2, started)
      } else {
        let probes = 0
        f.probe.mockImplementation(async () => {
          if (++probes === 2) mutate()
          return { messages: [], head: null, gap: false, oldest: null }
        })
        f.worker.trigger()
        await f.tick()
      }
      expect(record).not.toHaveBeenCalled()
      expect(await f.outbox.loadSettlement(0)).toBeNull()
      expect(f.queue.entries()).toHaveLength(1)
      // A fresh unchanged window with the actual attempt remains usable.
      f.setSnapshot(original)
      const stored = (await f.outbox.list())[0]
      if (stored === undefined) throw new Error('Missing stored entry')
      f.queue.replace(stored)
      if ((kind === 'attempt' || kind === 'attempt-topic') && path === 'covered-walk') {
        f.worker.trigger()
        await f.tick()
      }
      await proof(f)
      expect(record).toHaveBeenCalledTimes(1)
    } finally {
      f.worker.close()
      f.queue.close()
    }
  })
  test.each(['identity', 'attempt', 'sealVersion'] as const)(
    `late acknowledgement cannot certify a replacement attempt (%s / ${path})`,
    async (kind) => {
      const f = fixture()
      const ack = Promise.withResolvers<{ sequenceID: string }>()
      f.publish
        .mockReset()
        .mockReturnValueOnce(ack.promise)
        .mockResolvedValue({ sequenceID: 'fresh-ack' })
      const record = vi.spyOn(f.outbox, 'recordSettlement')
      try {
        await f.queue.accept(message('late'))
        f.worker.trigger()
        await f.tick()
        expect(f.publish).toHaveBeenCalledTimes(1)
        const original = structuredClone(f.getSnapshot())
        const entry = f.queue.entries()[0]
        if (original === null || entry?.lastAttempt == null) throw new Error('Missing attempt')
        if (kind === 'identity')
          f.setSnapshot({ ...original, identity: { ...original.identity, incarnation: 2 } })
        else if (kind === 'sealVersion')
          f.setSnapshot({ ...original, sealVersion: original.sealVersion + 1 })
        else
          f.queue.replace({
            ...entry,
            lastAttempt: { ...entry.lastAttempt, publishID: 'replacement' },
          })
        ack.resolve({ sequenceID: 'stale-ack' })
        await flush()
        await f.worker.certify(2, f.worker.beginWalk())
        expect(record).not.toHaveBeenCalled()
        expect(await f.outbox.loadSettlement(0)).toBeNull()
        f.setSnapshot(original)
        f.queue.replace(entry)
        f.worker.trigger()
        await f.tick(1000)
        await proof(f)
        expect(record).toHaveBeenCalledTimes(1)
        expect(record.mock.calls[0]?.[1].sequenceID).toBe('fresh-ack')
      } finally {
        ack.resolve({ sequenceID: 'stale-ack' })
        f.worker.close()
        f.queue.close()
      }
    },
  )
}

test(
  'acknowledgement after walk cutoff cannot certify unchanged state (covered-walk)',
  async () => {
    const f = fixture()
    const ack = Promise.withResolvers<{ sequenceID: string }>()
    f.publish.mockReset().mockReturnValue(ack.promise)
    const record = vi.spyOn(f.outbox, 'recordSettlement')
    try {
      await f.queue.accept(message('late'))
      f.worker.trigger()
      await f.tick()
      expect(f.publish).toHaveBeenCalledTimes(1)
      const snapshot = structuredClone(f.getSnapshot())
      const entry = structuredClone(f.queue.entries())
      const started = f.worker.beginWalk()
      await f.worker.readyWalk(started)
      ack.resolve({ sequenceID: 'late-position' })
      await flush()
      expect(f.getSnapshot()).toEqual(snapshot)
      expect(f.queue.entries()).toEqual(entry)
      await f.worker.certify(2, started)
      expect(record).not.toHaveBeenCalled()
      expect(await f.outbox.loadSettlement(0)).toBeNull()
      await f.worker.certify(2, f.worker.beginWalk())
      expect(record).toHaveBeenCalledTimes(1)
      expect(record.mock.calls[0]?.[1].sequenceID).toBe('late-position')
    } finally {
      ack.resolve({ sequenceID: 'late-position' })
      f.worker.close()
      f.queue.close()
    }
  },
)

test('no-new-head probe waits for acknowledgement before capturing its proof window', async () => {
  const f = fixture()
  const ack = Promise.withResolvers<{ sequenceID: string }>()
  f.publish.mockReset().mockReturnValue(ack.promise)
  f.probe.mockResolvedValue({ messages: [], head: null, gap: false, oldest: null })
  const record = vi.spyOn(f.outbox, 'recordSettlement')
  try {
    await f.queue.accept(message('serialized'))
    f.worker.trigger()
    await f.tick()
    expect(f.publish).toHaveBeenCalledTimes(1)
    // The first probe precedes handoff; the proof probe must wait for its acknowledgement.
    expect(f.probe).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveBeenCalled()
    expect(await f.outbox.loadSettlement(0)).toBeNull()
    const snapshot = structuredClone(f.getSnapshot())
    const attempt = f.queue.entries()[0]?.lastAttempt
    ack.resolve({ sequenceID: 'serialized-position' })
    await flush()
    expect(f.getSnapshot()).toEqual(snapshot)
    expect(f.probe).toHaveBeenCalledTimes(2)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0]?.[1]).toEqual({
      sequenceID: 'serialized-position',
      attemptID: attempt?.publishID,
      topicID: 'topic',
      outcome: 'published',
    })
    expect((await f.outbox.events()).filter((event) => event.kind === 'published')).toMatchObject([
      { occurrence: { position: 'serialized-position', topicID: 'topic' } },
    ])
  } finally {
    ack.resolve({ sequenceID: 'serialized-position' })
    f.worker.close()
    f.queue.close()
  }
})

test('peer root entry checks ownership before joining its commit queue', async () => {
  const f = makeMLSPeer(new FakeHub(), 'proof-root', new Uint8Array(32).fill(4))
  try {
    await f.peer.replay()
    const error = Object.assign(new Error('Root entry in settlement effect'), {
      name: 'ReentrantOwnershipError',
    })
    vi.spyOn(f.appPublication, 'assertRoot').mockImplementation(() => {
      throw error
    })
    await expect(f.peer.replay()).rejects.toBe(error)
  } finally {
    await f.peer.dispose()
  }
})

test('log acceptance does not wait for a publication snapshot', async () => {
  const f = makeMLSPeer(new FakeHub(), 'adoption-root', new Uint8Array(32).fill(4))
  const gate = Promise.withResolvers<AppPublicationSnapshot | null>()
  let submission: Promise<void> | undefined
  try {
    await f.peer.replay()
    vi.spyOn(f.appPublication, 'snapshot').mockReturnValue(gate.promise)
    let accepted = false
    submission = f.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'queued' } })
    void submission.then(() => {
      accepted = true
    })
    await flush()
    expect(accepted).toBe(true)
    expect(await f.appOutbox.list()).toMatchObject([
      { protocol: 'chat', prc: 'chat/posted', status: 'accepted', lastAttempt: null },
    ])
  } finally {
    gate.resolve(null)
    await submission
    await f.peer.dispose()
  }
})

test.each(['dispatch', 'request', 'gather', 'to'] as const)(
  'protocol %s checks ownership before yielding',
  async (method) => {
    const f = makeMLSPeer(new FakeHub(), 'protocol-root', new Uint8Array(32).fill(4))
    const abort = new AbortController()
    try {
      await f.peer.replay()
      const error = Object.assign(new Error('Root entry in settlement effect'), {
        name: 'ReentrantOwnershipError',
      })
      vi.spyOn(f.appPublication, 'assertRoot').mockImplementation(() => {
        throw error
      })
      const protocol = f.peer.protocol('chat')
      const calls = {
        dispatch: () => protocol.dispatch('chat/posted', { data: {} }),
        request: () => protocol.request('chat/echo', { param: {}, timeoutMs: 10 }),
        gather: () => protocol.gather('chat/echo', { param: {}, signal: abort.signal }),
        to: () => protocol.to('other-member'),
      }
      let rejected: unknown
      void calls[method]().catch((cause: unknown) => {
        rejected = cause
      })
      await flush()
      expect(rejected).toBe(error)
    } finally {
      abort.abort()
      await f.peer.dispose()
    }
  },
)
