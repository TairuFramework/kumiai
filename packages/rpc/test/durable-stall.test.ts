import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { AppDeliveryStalled } from '../src/app-lane.js'
import { createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { isAppFrameStorageError } from '../src/crypto.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
const secret = new Uint8Array(32).fill(0x97)

function pendingStore() {
  const rows = new Map<string, PendingAppFrame>()
  let fail = true
  return {
    rows,
    setFail(value: boolean) {
      fail = value
    },
    port: {
      async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
        if (fail) throw new Error('storage unavailable')
        rows.set(record.frame.id, record)
      },
      async list() {
        return [...rows.values()]
      },
      async complete(id: string) {
        rows.delete(id)
      },
    },
  }
}

async function publish(
  hub: DurableFakeHub,
  sender: ReturnType<typeof createFakeCrypto>,
  text: string,
) {
  return hub.publish({
    topicID,
    senderDID: 'alice',
    payload: await sender.wrap(
      fromUTF(JSON.stringify({ payload: { typ: 'event', prc: 'chat/posted', data: { text } } })),
      { aad: encodeAppAAD({ topicID, intent: 'log' }) },
    ),
    retain: 'log',
  })
}

describe('durable storage stall', () => {
  test('reports each blocked protocol once across repeated drains', async () => {
    const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
    const topics = ['chat', 'other'].map((name) => protocolTopic(anchor.secret, 1, name))
    const sender = createFakeCrypto({ epoch: 2, localDID: 'alice' })
    const frames = await Promise.all(
      topics.map((topic) =>
        sender.wrap(fromUTF('future'), { aad: encodeAppAAD({ topicID: topic, intent: 'log' }) }),
      ),
    )
    const notices = vi.fn()
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic({ topicID: requested, after }: { topicID: string; after?: string }) {
          const index = topics.indexOf(requested)
          return {
            messages:
              after == null && index >= 0
                ? [{ sequenceID: '000000000001', payload: frames[index] }]
                : [],
            head: '000000000001',
            oldest: '000000000001',
          }
        },
      } as never,
      crypto: createFakeCrypto({
        epoch: 1,
        localDID: 'bob',
        pending: {
          async persistOpened() {},
          async list() {
            return []
          },
          async complete() {},
        },
      }),
      localDID: 'bob',
      protocols: { chat, other: chat },
      eventHandlers: new Map(),
      retentionSeconds: 60,
      onAppDeliveryStalled: notices,
      anchor: () => anchor,
      groupID: () => 'group',
      justifiedEpochCeiling: async () => 2,
    })
    await lane.deliver()
    await lane.deliver()
    expect(notices.mock.calls.map(([event]) => event.protocol)).toEqual(['chat', 'other'])
    lane.dispose()
  })

  test('a justified future-epoch frame reports a stall until dropped', async () => {
    const sender = createFakeCrypto({ epoch: 65535, localDID: 'mallory' })
    const sealed = await sender.wrap(fromUTF('future'), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    })
    const notices = vi.fn()
    const cursor = createMemoryAppCursorStore()
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic({ after }: { after?: string }) {
          return {
            messages: after == null ? [{ sequenceID: '000000000001', payload: sealed }] : [],
            head: '000000000001',
            oldest: '000000000001',
          }
        },
      } as never,
      crypto: createFakeCrypto({
        epoch: 1,
        localDID: 'bob',
        pending: {
          async persistOpened() {},
          async list() {
            return []
          },
          async complete() {},
        },
      }),
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map(),
      retentionSeconds: 60,
      appCursorStore: cursor,
      onAppDeliveryStalled: notices,
      anchor: () => ({ epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }),
      groupID: () => 'group',
      justifiedEpochCeiling: async () => 65535,
    })
    await lane.deliver()
    await lane.deliver()
    expect(notices).toHaveBeenCalledTimes(1)
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'future-epoch', position: '000000000001' }),
    )
    await lane.dropFrame(topicID, '000000000001')
    expect(cursor.stored(topicID)).toBe('000000000001')
    lane.dispose()
  })
  test('reports each blocking frame once, and dropping it resumes the journal-first walk', async () => {
    const hub = new DurableFakeHub()
    const store = pendingStore()
    const notices = vi.fn((_event: AppDeliveryStalled) => {
      throw new Error('observer failed')
    })
    const alice = makeMLSPeer(hub, 'alice', secret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', secret, {
      epoch: 1,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: store.port }),
      onAppDeliveryStalled: notices,
    })
    await bob.peer.protocol('chat').to('alice')
    hub.detach('bob')
    const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const first = await publish(hub, sender, 'first')
    await alice.peer.commit(buildLedgerCommit(alice, []))
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toSatisfy(
      isAppFrameStorageError,
    )
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toSatisfy(
      isAppFrameStorageError,
    )
    expect(notices).toHaveBeenCalledTimes(1)
    expect(notices).toHaveBeenCalledWith({
      groupID: expect.any(String),
      protocol: 'chat',
      topicID,
      position: first.sequenceID,
      error: expect.any(Error),
    })
    expect(bob.mls.epoch()).toBe(1)
    expect(bob.appCursorStore.stored(topicID)).toBeNull()

    const journalRead = vi.spyOn(bob.journal, 'get')
    await bob.peer.dropAppFrame(topicID, first.sequenceID)
    expect(journalRead).toHaveBeenCalled()
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(first.sequenceID)
    expect(store.rows.size).toBe(0)

    const second = await publish(hub, createFakeCrypto({ epoch: 2, localDID: 'alice' }), 'second')
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toSatisfy(
      isAppFrameStorageError,
    )
    expect(notices).toHaveBeenCalledTimes(2)
    expect(notices.mock.calls[1]?.[0]).toMatchObject({ position: second.sequenceID })
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('refuses a pending frame and keeps its record and cursor', async () => {
    const hub = new DurableFakeHub()
    const store = pendingStore()
    store.setFail(false)
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = vi.fn(async () => held)
    const bob = makeMLSPeer(hub, 'bob', secret, {
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: store.port }),
      handlers: { 'chat/posted': handler },
    })
    await bob.peer.protocol('chat').to('alice')
    const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const frame = await publish(hub, sender, 'held')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    await expect(bob.peer.dropAppFrame('another topic', frame.sequenceID)).rejects.toThrow(
      /buffered/,
    )
    await expect(bob.peer.dropAppFrame(topicID, frame.sequenceID)).rejects.toThrow(/pending/)
    store.setFail(true)
    const behind = await publish(hub, sender, 'behind')
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toSatisfy(
      isAppFrameStorageError,
    )
    await expect(bob.peer.dropAppFrame(topicID, behind.sequenceID)).rejects.toThrow(
      /earlier.*pending/,
    )
    expect(store.rows.size).toBe(1)
    expect(bob.appCursorStore.stored(topicID)).toBeNull()
    release?.()
    await vi.waitFor(() => expect(store.rows.size).toBe(0))
    await bob.peer.dispose()
  })
})
