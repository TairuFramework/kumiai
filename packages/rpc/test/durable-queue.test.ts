import { encodeEventFrame } from '@kumiai/broadcast'
import { fromUTF } from '@sozai/codec'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { testAppLaneParams } from './fixtures/app-lane.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { completeTestRecord, createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { memoryAuthenticator } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

afterEach(() => vi.useRealTimers())

const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
const payload = (text: string) =>
  fromUTF(JSON.stringify({ v: 2, payload: { typ: 'event', prc: 'chat/posted', data: { text } } }))

function fixture(
  handler: (context: { data: { text: string }; frame?: PendingAppFrame['frame'] }) => unknown,
  failPersist?: (record: PendingAppFrame) => boolean,
) {
  const records = new Map<string, PendingAppFrame>()
  const complete = vi.fn(async (id: string) => {
    records.delete(id)
  })
  const pending = {
    async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
      if (failPersist?.(record)) throw new Error('persistent storage failure')
      records.set(record.frame.id, record)
    },
    async list() {
      return [...records.values()]
    },
    complete,
  }
  const reader = createFakeCrypto({ epoch: 1, localDID: 'bob', pending })
  const sender1 = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const sender2 = createFakeCrypto({ epoch: 2, localDID: 'alice' })
  const messages: Array<{ sequenceID: string; payload: Uint8Array }> = []
  const cursor = createMemoryAppCursorStore()
  const protocols = {
    chat: {
      ...chat,
      'chat/posted': {
        ...chat['chat/posted'],
        data: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    },
  } as const
  const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
  const lane = createAppLane(
    testAppLaneParams({
      groupKey: { groupID: 'group', incarnation: 1 },
      mux: {
        retainTopic() {},
        async fetchTopic({ after }: { after?: string }) {
          const page = messages.filter((message) => after == null || message.sequenceID > after)
          return {
            messages: page,
            head: messages.at(-1)?.sequenceID ?? null,
            oldest: messages[0]?.sequenceID ?? null,
          }
        },
      } as never,
      appliedEpoch: () => reader.epoch(),
      crypto: reader,
      localDID: 'bob',
      protocols,
      handlers: { chat: { 'chat/posted': handler } },
      retentionSeconds: 60,
      appCursorStore: cursor,
      anchor: () => anchor,
      groupID: () => 'group',
    }),
  )
  const append = async (position: string, text: string, epoch = 1) => {
    messages.push({
      sequenceID: position,
      payload: await (epoch === 1 ? sender1 : sender2).wrap(payload(text), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
  }
  const appendRaw = async (position: string, bytes: Uint8Array, local = false) => {
    const sender = local ? createFakeCrypto({ epoch: 1, localDID: 'bob' }) : sender1
    messages.push({
      sequenceID: position,
      payload: await sender.wrap(bytes, {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
  }
  return { lane, reader, records, complete, cursor, append, appendRaw, pending, messages }
}

describe('durable delivery queue', () => {
  test.each([false, true])(
    'opened drain recovers a failed reload without ciphertext and waits through disposal=%s',
    async (dispose) => {
      const handler = Promise.withResolvers<void>()
      const completion = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const completing = Promise.withResolvers<void>()
      const reloading = Promise.withResolvers<void>()
      const reload = Promise.withResolvers<void>()
      const seen = vi.fn(async () => {
        entered.resolve()
        await handler.promise
      })
      const { lane, reader, records, complete, cursor, append, pending, messages } = fixture(seen)
      onTestFinished(() => {
        handler.resolve()
        completion.resolve()
        reload.resolve()
        lane.dispose()
      })
      const list = vi.spyOn(pending, 'list').mockRejectedValue(new Error('reload unavailable'))
      await append('000000000001', 'saved')
      await expect(lane.deliver()).rejects.toThrow('Failed to reload saved app frame')
      expect(records.size).toBe(1)
      expect(lane.pendingRecords()).toEqual([])
      if (dispose) lane.reset()
      messages.length = 0
      list.mockImplementation(async () => {
        reloading.resolve()
        await reload.promise
        return [...records.values()]
      })
      list.mockRejectedValueOnce(new Error('reload still unavailable'))
      complete.mockImplementation(async (id) => {
        completing.resolve()
        await completion.promise
        records.delete(id)
      })
      let drained = false
      const drain = lane.completeOpened().then(() => {
        drained = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(drained).toBe(false)
      await reloading.promise
      reload.resolve()
      await entered.promise
      if (dispose) lane.dispose()
      expect(drained).toBe(false)
      handler.resolve()
      await completing.promise
      expect(drained).toBe(false)
      completion.resolve()
      await drain
      expect(records.size).toBe(0)
      expect(seen).toHaveBeenCalledOnce()
      expect(reader.starts.unwrap).toBe(1)
      expect(cursor.stored(topicID)).toBe(dispose ? null : '000000000001')
    },
  )

  test('disposal during a saved-record reload preserves the opened drain for storage completion', async () => {
    const reload = Promise.withResolvers<void>()
    const reloading = Promise.withResolvers<void>()
    const seen = vi.fn()
    const { lane, records, append, pending, messages } = fixture(seen)
    onTestFinished(() => {
      reload.resolve()
      lane.dispose()
    })
    const list = vi.spyOn(pending, 'list').mockRejectedValue(new Error('reload unavailable'))
    await append('000000000001', 'saved')
    await expect(lane.deliver()).rejects.toThrow('Failed to reload saved app frame')
    lane.reset()
    messages.length = 0
    list.mockImplementation(async () => {
      reloading.resolve()
      await reload.promise
      return [...records.values()]
    })
    let drained = false
    const drain = lane.completeOpened().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drained).toBe(false)
    await reloading.promise
    lane.dispose()
    reload.resolve()
    await vi.waitFor(() => expect(lane.pendingRecords()).toHaveLength(1))
    expect(drained).toBe(false)
    expect(records.size).toBe(1)
    expect(seen).not.toHaveBeenCalled()
    const saved = [...records.values()][0]
    if (saved == null) throw new Error('missing saved frame')
    records.delete(saved.frame.id)
    await lane.acknowledgeOpened(saved.frame.id)
    await drain
    expect(lane.pendingRecords()).toEqual([])
  })

  test('storage completion settles an unreloaded open after disposal while reads still fail', async () => {
    const seen = vi.fn()
    const { lane, records, append, pending } = fixture(seen)
    vi.spyOn(pending, 'list').mockRejectedValue(new Error('reload unavailable'))
    await append('000000000001', 'saved')
    await expect(lane.deliver()).rejects.toThrow('Failed to reload saved app frame')
    const saved = [...records.values()][0]
    if (saved == null) throw new Error('missing saved frame')
    let drained = false
    const drain = lane.completeOpened().then(() => {
      drained = true
    })
    onTestFinished(async () => {
      lane.dispose()
      await lane.restore([saved])
      await lane.acknowledgeOpened(saved.frame.id)
      await drain
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    lane.dispose()
    expect(drained).toBe(false)
    records.delete(saved.frame.id)
    await lane.acknowledgeOpened(saved.frame.id)
    await vi.waitFor(() => expect(drained).toBe(true))
    expect(seen).not.toHaveBeenCalled()
  })

  test('terminal removal waits for an unreloaded open before clearing accepted sends', async () => {
    const hub = new DurableFakeHub()
    const records = new Map<string, PendingAppFrame>()
    const entered = Promise.withResolvers<void>()
    const handler = Promise.withResolvers<void>()
    const completing = Promise.withResolvers<void>()
    const completion = Promise.withResolvers<void>()
    let failReload = false
    let failedReads = 0
    const pending = {
      async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
        records.set(record.frame.id, record)
        failReload = true
      },
      async list() {
        if (failReload) {
          failedReads++
          throw new Error('reload unavailable')
        }
        return [...records.values()]
      },
      async complete(id: string) {
        completing.resolve()
        await completion.promise
        records.delete(id)
      },
    }
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob', pending })
    const secret = new Uint8Array(32).fill(0x91)
    const cleared = vi.fn()
    const seen = vi.fn(async () => {
      entered.resolve()
      await handler.promise
    })
    const bob = makeMLSPeer(hub, 'bob', secret, {
      crypto,
      handlers: { 'chat/posted': seen },
      onAppOutboxCleared: cleared,
    })
    onTestFinished(async () => {
      failReload = false
      handler.resolve()
      completion.resolve()
      await bob.peer.dispose()
      await bob.peer.drained()
    })
    await bob.peer.protocol('chat').to('alice')
    await hub.publish({
      topicID,
      senderDID: 'alice',
      payload: await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(payload('saved'), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
      retain: 'log',
    })
    await vi.waitFor(() => expect(failedReads).toBeGreaterThan(0))
    hub.detach('bob')
    await publishCommit({
      authenticator: memoryAuthenticator(bob.mls),
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      removes: ['bob'],
    })
    await bob.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'unsent' } })
    await vi.waitFor(async () => expect((await bob.control.load()).applied).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(records.size).toBe(1)
    expect(await bob.appOutbox.list()).toHaveLength(1)
    expect(cleared).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
    const opens = crypto.starts.unwrap
    const fetches = vi.spyOn(hub, 'fetchTopic')
    const publications = hub.published.length
    failReload = false
    await entered.promise
    expect(await bob.appOutbox.list()).toHaveLength(1)
    handler.resolve()
    await completing.promise
    expect(await bob.appOutbox.list()).toHaveLength(1)
    completion.resolve()
    await vi.waitFor(async () => expect(await bob.appOutbox.list()).toEqual([]))
    expect(records.size).toBe(0)
    expect(seen).toHaveBeenCalledOnce()
    expect(cleared).toHaveBeenCalledWith({ reason: 'removed', seqs: [0] })
    expect(crypto.starts.unwrap).toBe(opens)
    expect(fetches).not.toHaveBeenCalled()
    expect(hub.published).toHaveLength(publications)
  })

  test('an earlier ahead frame blocks an at-epoch frame until both can deliver in log order', async () => {
    const seen: Array<string> = []
    const { lane, reader, cursor, append } = fixture(({ data, frame }) => {
      expect(frame?.topicID).toBe(topicID)
      seen.push(data.text)
    })
    await append('000000000001', 'A', 2)
    await append('000000000002', 'B')
    await lane.deliver()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seen).toEqual([])
    expect(cursor.stored(topicID)).toBeNull()
    reader.setEpoch(2)
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toEqual(['A', 'B']))
    await vi.waitFor(() => expect(cursor.stored(topicID)).toBe('000000000002'))
    lane.dispose()
  })

  test('a throwing handler retries after backoff and holds later frames', async () => {
    const seen: Array<string> = []
    let attempts = 0
    const { lane, records, cursor, append } = fixture(({ data }) => {
      seen.push(data.text)
      if (data.text === 'A' && attempts++ === 0) throw new Error('host failed')
    })
    await append('000000000001', 'A')
    await append('000000000002', 'B')
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toEqual(['A']))
    expect(records.size).toBe(2)
    expect(cursor.stored(topicID)).toBeNull()
    await vi.waitFor(() => expect(seen).toEqual(['A', 'A', 'B']), { timeout: 2500 })
    await vi.waitFor(() => expect(records.size).toBe(0))
    lane.dispose()
  })

  test('a failed complete retries and may invoke the handler again', async () => {
    const seen: Array<string> = []
    const { lane, records, complete, append } = fixture(({ data }) => {
      seen.push(data.text)
    })
    complete.mockRejectedValueOnce(new Error('store failed'))
    await append('000000000001', 'A')
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toEqual(['A', 'A']), { timeout: 2500 })
    await vi.waitFor(() => expect(records.size).toBe(0))
    lane.dispose()
  })

  test('a later persist failure still starts delivery of an earlier durable record', async () => {
    const seen = vi.fn()
    const { lane, records, append } = fixture(
      seen,
      (record) => record.frame.position === '000000000002',
    )
    await append('000000000001', 'A')
    await append('000000000002', 'B')
    await expect(lane.deliver()).rejects.toThrow('failed to persist opened app frame')
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    expect(seen.mock.calls[0]?.[0].data.text).toBe('A')
    expect(records.size).toBe(0)
    lane.dispose()
  })

  test('a failed fetch for another protocol still starts a restored record', async () => {
    const record: PendingAppFrame = completeTestRecord(
      {
        frame: { id: 'saved-a', topicID, protocol: 'chat', segment: 1, position: '000000000001' },
        payload: payload('A'),
        senderDID: 'alice',
      },
      { groupID: 'group', incarnation: 1 },
      'chat/posted',
      1,
    )
    const seen = vi.fn()
    const complete = vi.fn(async () => {})
    const lane = createAppLane(
      testAppLaneParams({
        groupKey: { groupID: 'group', incarnation: 1 },
        mux: {
          retainTopic() {},
          async fetchTopic({ topicID: requested }: { topicID: string }) {
            if (requested !== topicID) throw new Error('other protocol fetch failed')
            return { messages: [], head: null, oldest: null }
          },
        } as never,
        appliedEpoch: () => 1,
        crypto: createFakeCrypto({
          localDID: 'bob',
          pending: {
            async persistOpened() {},
            async list() {
              return [record]
            },
            complete,
          },
        }),
        localDID: 'bob',
        protocols: { chat, other: chat },
        handlers: { chat: { 'chat/posted': seen } },
        retentionSeconds: 60,
        anchor: () => ({ epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }),
        groupID: () => 'group',
      }),
    )
    await lane.restore([record])
    await expect(lane.deliver()).rejects.toThrow('other protocol fetch failed')
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith('saved-a'))
    lane.dispose()
  })

  test('an admitted worker completes its record after disposal', async () => {
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = vi.fn(async () => held)
    const { lane, records, complete, append } = fixture(seen)
    await append('000000000001', 'A')
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    lane.dispose()
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(complete).toHaveBeenCalledTimes(1)
    expect(records.size).toBe(0)
  })

  test('unusable records are completed and do not block a later valid event', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => {
      const calls = diagnostic.mock.calls
      diagnostic.mockRestore()
      expect(calls.length).toBeGreaterThan(0)
    })
    const seen: Array<string> = []
    const { lane, records, cursor, append, appendRaw } = fixture(({ data }) => {
      seen.push(data.text)
    })
    await appendRaw('000000000001', fromUTF('{'))
    await appendRaw('000000000002', fromUTF('{"payload":{"typ":"request","prc":"chat/posted"}}'))
    await appendRaw('000000000003', encodeEventFrame('chat/posted', { text: null }))
    await appendRaw('000000000004', encodeEventFrame('chat/posted', { text: 42 }))
    await appendRaw('000000000005', payload('echo'), true)
    await append('000000000006', 'valid')
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toEqual(['valid']))
    await vi.waitFor(() => expect(records.size).toBe(0))
    expect(cursor.stored(topicID)).toBe('000000000006')
    lane.dispose()
  })

  test('a handler can await a peer commit without holding the app or commit mutex', async () => {
    const hub = new DurableFakeHub()
    const records = new Map<string, PendingAppFrame>()
    const crypto = createFakeCrypto({
      epoch: 1,
      localDID: 'bob',
      pending: {
        async persistOpened(_state, record) {
          records.set(record.frame.id, record)
        },
        async list() {
          return [...records.values()]
        },
        async complete(id) {
          records.delete(id)
        },
      },
    })
    let bob: ReturnType<typeof makeMLSPeer>
    const seen = vi.fn(async () => {
      await bob.peer.commit(buildLedgerCommit(bob, []))
    })
    bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x91), {
      crypto,
      handlers: { 'chat/posted': seen },
    })
    await bob.peer.protocol('chat').to('alice')
    const alice = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    await hub.publish({
      topicID,
      senderDID: 'alice',
      payload: await alice.wrap(payload('commit'), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
      retain: 'log',
    })
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1), { timeout: 2500 })
    await vi.waitFor(() => expect(records.size).toBe(0), { timeout: 2500 })
    await bob.peer.dispose()
  })

  test('a pending handler starts before the producing commit operation releases', async () => {
    const hub = new DurableFakeHub()
    const records = new Map<string, PendingAppFrame>()
    const crypto = createFakeCrypto({
      epoch: 1,
      localDID: 'bob',
      pending: {
        async persistOpened(_state, record) {
          records.set(record.frame.id, record)
        },
        async list() {
          return [...records.values()]
        },
        async complete(id) {
          records.delete(id)
        },
      },
    })
    const seen = vi.fn()
    const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x91), {
      crypto,
      handlers: { 'chat/posted': seen },
    })
    await bob.peer.protocol('chat').to('alice')
    hub.detach('bob')
    await hub.publish({
      topicID,
      senderDID: 'alice',
      payload: await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(payload('held'), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
      retain: 'log',
    })
    let entered!: () => void
    let release!: () => void
    const atRoster = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalRoster = bob.mls.rosterEntries.bind(bob.mls)
    vi.spyOn(bob.mls, 'rosterEntries').mockImplementation(async () => {
      entered()
      await held
      return originalRoster()
    })
    vi.useFakeTimers()
    const committing = bob.peer.commit(buildLedgerCommit(bob, []))
    void committing.catch(() => {})
    try {
      await atRoster
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toHaveBeenCalledTimes(1)
      expect(records.size).toBe(0)
      expect(bob.mls.epoch()).toBe(1)
      release()
      await committing
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await committing.catch(() => {})
      await bob.peer.dispose()
    }
  })

  test('dispose during retry backoff prevents another handler call', async () => {
    const seen = vi.fn(() => {
      throw new Error('host failed')
    })
    const { lane, records, append } = fixture(seen)
    await append('000000000001', 'A')
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    lane.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(seen).toHaveBeenCalledTimes(1)
    expect(records.size).toBe(1)
  })

  test('peer disposal stops a queued handler retry', async () => {
    const hub = new DurableFakeHub()
    const records = new Map<string, PendingAppFrame>()
    const crypto = createFakeCrypto({
      epoch: 1,
      localDID: 'bob',
      pending: {
        async persistOpened(_state, record) {
          records.set(record.frame.id, record)
        },
        async list() {
          return [...records.values()]
        },
        async complete(id) {
          records.delete(id)
        },
      },
    })
    const seen = vi.fn(() => {
      throw new Error('host failed')
    })
    const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0x91), {
      crypto,
      handlers: { 'chat/posted': seen },
    })
    await bob.peer.protocol('chat').to('alice')
    const alice = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    await hub.publish({
      topicID,
      senderDID: 'alice',
      payload: await alice.wrap(payload('retry'), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
      retain: 'log',
    })
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    await bob.peer.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(seen).toHaveBeenCalledTimes(1)
    expect(records.size).toBe(1)
  })
})
