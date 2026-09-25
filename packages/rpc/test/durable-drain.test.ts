import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { FrameEpochError, isAppFrameStorageError } from '../src/crypto.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

function pendingStore() {
  const records = new Map<string, PendingAppFrame>()
  let fail = false
  return {
    records,
    setFail(value: boolean) {
      fail = value
    },
    port: {
      async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
        if (fail) throw new Error('storage unavailable')
        records.set(record.frame.id, record)
      },
      async list() {
        return [...records.values()]
      },
      async complete(id: string) {
        records.delete(id)
      },
    },
  }
}

function retainedLane() {
  const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
  const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
  const store = pendingStore()
  const reader = createFakeCrypto({ epoch: 1, localDID: 'bob', pending: store.port })
  const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const messages: Array<{ sequenceID: string; payload: Uint8Array }> = []
  const cursor = createMemoryAppCursorStore()
  const lane = createAppLane({
    mux: {
      retainTopic() {},
      async fetchTopic({ after }: { after?: string }) {
        return {
          messages: messages.filter((message) => after == null || message.sequenceID > after),
          head: messages.at(-1)?.sequenceID ?? null,
          oldest: messages[0]?.sequenceID ?? null,
        }
      },
    } as never,
    crypto: reader,
    localDID: 'bob',
    protocols: { chat },
    eventHandlers: new Map([['chat', { emit: async () => {} }]]) as never,
    retentionSeconds: 60,
    appCursorStore: cursor,
    anchor: () => anchor,
    groupID: () => 'group',
  })
  const append = async (position: string, intent: 'log' | 'ephemeral') => {
    messages.push({
      sequenceID: position,
      payload: await sender.wrap(
        fromUTF('{"payload":{"typ":"event","prc":"chat/posted","data":{}}}'),
        {
          aad: encodeAppAAD({ topicID, intent }),
        },
      ),
    })
  }
  return { lane, reader, store, cursor, topicID, append }
}

describe('durable retained drain', () => {
  test('a storage fault leaves the frame sealed, and a durable open leaves the cursor behind pending', async () => {
    const { lane, store, cursor, topicID, append } = retainedLane()
    await append('000000000001', 'log')
    store.setFail(true)
    await expect(lane.deliver()).rejects.toSatisfy(isAppFrameStorageError)
    expect(store.records.size).toBe(0)
    expect(cursor.stored(topicID)).toBeNull()

    store.setFail(false)
    await lane.deliver()
    expect(store.records.size).toBe(1)
    expect(lane.pendingRecords()).toHaveLength(1)
    expect([...store.records.values()][0]?.frame).toMatchObject({
      topicID,
      protocol: 'chat',
      segment: 1,
      position: '000000000001',
    })
    await lane.deliver()
    expect(store.records.size).toBe(1)
    expect(cursor.stored(topicID)).toBeNull()
  })

  test('an ephemeral-intent frame found in the retained log is dead', async () => {
    const { lane, reader, store, cursor, topicID, append } = retainedLane()
    await append('000000000001', 'ephemeral')
    const unwrap = vi.spyOn(reader, 'unwrap')
    await lane.deliver()
    expect(unwrap).not.toHaveBeenCalled()
    expect(store.records.size).toBe(0)
    expect(cursor.stored(topicID)).toBe('000000000001')
  })

  test('a pushed position cannot replace the ciphertext fetched at that position', async () => {
    const { lane, store, topicID, append } = retainedLane()
    const ahead = createFakeCrypto({ epoch: 2, localDID: 'alice' })
    lane.note(
      'chat',
      topicID,
      {
        sequenceID: '000000000001',
        logPosition: '000000000001',
        senderDID: 'alice',
        topicID,
        payload: await ahead.wrap(fromUTF('untrusted push'), {
          aad: encodeAppAAD({ topicID, intent: 'log' }),
        }),
      },
      new FrameEpochError(2, 1),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await append('000000000001', 'log')
    await lane.deliver()
    expect(store.records.size).toBe(1)
    expect([...store.records.values()][0]?.frame.position).toBe('000000000001')
  })

  test('a rejected fetch waits for the other protocol before a retry starts', async () => {
    const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
    const chatTopic = protocolTopic(anchor.secret, 1, 'chat')
    let releaseDelayed: (() => void) | undefined
    const delayed = new Promise<void>((resolve) => {
      releaseDelayed = resolve
    })
    let chatFetches = 0
    let otherFetches = 0
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic(params: { topicID: string }) {
          if (params.topicID === chatTopic) {
            chatFetches += 1
            if (chatFetches === 1) throw new Error('first fetch failed')
          } else {
            otherFetches += 1
            if (otherFetches === 1) await delayed
          }
          return { messages: [], head: null, oldest: null }
        },
      } as never,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
      localDID: 'bob',
      protocols: { chat, other: chat },
      eventHandlers: new Map(),
      retentionSeconds: 60,
      anchor: () => anchor,
      groupID: () => 'group',
    })
    const first = lane.deliver()
    const failed = expect(first).rejects.toThrow('first fetch failed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const retry = lane.deliver()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatFetches).toBe(1)
    expect(otherFetches).toBe(1)
    releaseDelayed?.()
    await failed
    await retry
    expect(chatFetches).toBe(2)
    expect(otherFetches).toBe(2)
  })

  test('a storage fault before a commit stops the walk until the frame opens', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x91)
    const store = pendingStore()
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: store.port }),
    })
    await flush()
    hub.detach('bob')
    await alice.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'first' } })
    await alice.peer.commit(buildLedgerCommit(alice, []))
    store.setFail(true)
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toSatisfy(
      isAppFrameStorageError,
    )
    expect(bob.mls.epoch()).toBe(1)
    store.setFail(false)
    await bob.peer.commit(buildLedgerCommit(bob, []))
    expect(bob.mls.epoch()).toBe(3)
    expect(store.records.size).toBe(1)
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a failed final drain after rotation still rebuilds the new app topic', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x92)
    const store = pendingStore()
    const seen: Array<unknown> = []
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, {
      epoch: 1,
      members: ['alice', 'bob', 'carol'],
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      epoch: 1,
      members: ['alice', 'bob', 'carol'],
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: store.port }),
      handlers: { 'chat/changed': (context: { data: unknown }) => void seen.push(context.data) },
    })
    await flush()
    hub.detach('bob')
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()
    await alice.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'new topic' } })
    store.setFail(true)
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toSatisfy(
      isAppFrameStorageError,
    )
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.peer.anchorEpoch()).toBe(2)
    hub.reattach('bob')
    await alice.peer.protocol('chat').dispatch('chat/changed', { data: { text: 'after failure' } })
    await flush()
    expect(seen).toEqual([{ text: 'after failure' }])
    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
