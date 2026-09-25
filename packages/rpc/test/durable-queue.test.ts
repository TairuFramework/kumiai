import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { adaptBusHandlers } from '../src/handlers.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
const payload = (text: string) =>
  fromUTF(JSON.stringify({ payload: { typ: 'event', prc: 'chat/posted', data: { text } } }))

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
  const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
  const lane = createAppLane({
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
    crypto: reader,
    localDID: 'bob',
    protocols: { chat },
    eventHandlers: new Map([['chat', adaptBusHandlers(chat, { 'chat/posted': handler }).events]]),
    retentionSeconds: 60,
    appCursorStore: cursor,
    anchor: () => anchor,
    groupID: () => 'group',
    justifiedEpochCeiling: async () => 2,
  })
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
  return { lane, reader, records, complete, cursor, append, appendRaw }
}

describe('durable delivery queue', () => {
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
    const record: PendingAppFrame = {
      frame: { id: 'saved-a', topicID, protocol: 'chat', segment: 1, position: '000000000001' },
      payload: payload('A'),
      senderDID: 'alice',
    }
    const seen = vi.fn()
    const complete = vi.fn(async () => {})
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic({ topicID: requested }: { topicID: string }) {
          if (requested !== topicID) throw new Error('other protocol fetch failed')
          return { messages: [], head: null, oldest: null }
        },
      } as never,
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
      eventHandlers: new Map([['chat', adaptBusHandlers(chat, { 'chat/posted': seen }).events]]),
      retentionSeconds: 60,
      anchor: () => ({ epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }),
      groupID: () => 'group',
      justifiedEpochCeiling: async () => 1,
    })
    await lane.restore([record])
    await expect(lane.deliver()).rejects.toThrow('other protocol fetch failed')
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith('saved-a'))
    lane.dispose()
  })

  test('a worker does not complete a record after disposal while its handler is in flight', async () => {
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
    expect(complete).not.toHaveBeenCalled()
    expect(records.size).toBe(1)
  })

  test('unusable records are completed and do not block a later valid event', async () => {
    const seen: Array<string> = []
    const { lane, records, cursor, append, appendRaw } = fixture(({ data }) => {
      seen.push(data.text)
    })
    await appendRaw('000000000001', fromUTF('{'))
    await appendRaw('000000000002', fromUTF('{"payload":{"typ":"request","prc":"chat/posted"}}'))
    await appendRaw(
      '000000000003',
      fromUTF('{"payload":{"typ":"event","prc":"chat/changed","data":{}}}'),
    )
    await appendRaw(
      '000000000004',
      fromUTF('{"payload":{"typ":"event","prc":"chat/posted","data":"invalid"}}'),
    )
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
