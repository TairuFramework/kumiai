import { encodeEventFrame } from '@kumiai/broadcast'
import { fromUTF } from '@sozai/codec'
import { describe, expect, onTestFinished, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { appFrameIdempotencyKey } from '../src/app-frame.js'
import * as appLaneModule from '../src/app-lane.js'
import { createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { FrameEpochError, isAppFrameStorageError } from '../src/crypto.js'
import type { GroupTransaction, HandlerCompletion } from '../src/handler-completion.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { testAppLaneParams } from './fixtures/app-lane.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { memoryAuthenticator } from './fixtures/memory-group-mls.js'
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
  const lane = createAppLane(
    testAppLaneParams({
      groupKey: { groupID: 'group', incarnation: 1 },
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
      appliedEpoch: () => reader.epoch(),
      crypto: reader,
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map([['chat', { emit: async () => {} }]]) as never,
      retentionSeconds: 60,
      appCursorStore: cursor,
      anchor: () => anchor,
      groupID: () => 'group',
    }),
  )
  const append = async (position: string, intent: 'log' | 'ephemeral') => {
    messages.push({
      sequenceID: position,
      payload: await sender.wrap(encodeEventFrame('chat/posted', {}), {
        aad: encodeAppAAD({ topicID, intent }),
      }),
    })
  }
  return { lane, reader, store, cursor, topicID, append }
}

describe('durable retained drain', () => {
  test('durable delivery reloads the saved record with its original frame epoch and origin', async () => {
    const { lane, reader, store, append } = retainedLane()
    onTestFinished(() => lane.dispose())
    await append('000000000001', 'log')
    reader.setEpoch(2)
    await lane.deliver()
    const saved = [...store.records.values()][0]
    expect(saved).toBeDefined()
    expect(lane.pendingRecords()).toEqual([saved])
    expect(saved).toMatchObject({
      epoch: 1,
      senderDID: 'alice',
      frame: { groupID: 'group', incarnation: 1, procedure: 'chat/posted' },
    })
    expect(saved?.idempotencyKey).toBe(
      JSON.stringify([
        'kumiai/frame/v1',
        'group',
        1,
        saved?.frame.topicID,
        '000000000001',
        'chat',
        'chat/posted',
      ]),
    )
  })

  test('structural completion preserves durable cursors after saved delivery and rowless refusal', async () => {
    const { lane, cursor, topicID, append, store } = retainedLane()
    onTestFinished(() => lane.dispose())
    await append('10', 'ephemeral')
    await lane.deliver()
    expect(store.records.size).toBe(0)
    expect(cursor.stored(topicID)).toBeNull()
  })

  test('retained singleton without pending projects authenticated metadata', async () => {
    const anchor = { epoch: 7, secret: fakeEpochSecret(7, APP_TOPIC_LABEL) }
    const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
    const reader = createFakeCrypto({ epoch: 7, localDID: 'bob' })
    reader.setEpoch(8)
    const sender = createFakeCrypto({ epoch: 7, localDID: 'alice' })
    const payload = await sender.wrap(encodeEventFrame('chat/posted', {}), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    })
    const emit = vi.fn()
    const lane = createAppLane(
      testAppLaneParams({
        groupKey: { groupID: 'group', incarnation: 3 },
        mux: {
          retainTopic() {},
          async fetchTopic() {
            return {
              messages: [{ sequenceID: '10', payload }],
              head: '10',
              oldest: '10',
            }
          },
        } as never,
        appliedEpoch: () => 8,
        crypto: reader,
        localDID: 'bob',
        protocols: { chat },
        eventHandlers: new Map([['chat', { emit }]]) as never,
        retentionSeconds: 60,
        anchor: () => anchor,
        groupID: () => 'group',
      }),
    )
    onTestFinished(() => lane.dispose())
    await lane.deliver()
    expect(emit).toHaveBeenCalledWith(
      'chat/posted',
      expect.objectContaining({ epoch: 7, incarnation: 3 }),
    )
  })

  test('structural completion without private registration remains a portable adapter', async () => {
    const construction = vi.spyOn(appLaneModule, 'createAppLane')
    onTestFinished(() => construction.mockRestore())
    const hub = new DurableFakeHub()
    const secret = new Uint8Array(32).fill(42)
    const store = pendingStore()
    const reader = createFakeCrypto({ epoch: 7, localDID: 'bob', pending: store.port })
    const effects = new Map<string, string>()
    const completion: HandlerCompletion<GroupTransaction & { effects: Map<string, string> }> = {
      key: { groupID: 'memory-group', incarnation: 1 },
      complete: vi.fn(async (ids) => {
        for (const id of ids) store.records.delete(id)
      }),
      transact: vi.fn(async (ids, handle) => {
        const records = [...store.records.values()].filter((record) =>
          ids.includes(record.frame.id),
        )
        if (records.length === 0) return
        const staged = new Map(effects)
        const hooks: Array<() => void> = []
        await handle(
          {
            providerID: 'portable',
            groupID: completion.key.groupID,
            effects: staged,
            onCommit: (hook: () => void) => {
              hooks.push(hook)
            },
            onRollback() {},
          },
          records,
        )
        effects.clear()
        for (const [id, value] of staged) effects.set(id, value)
        for (const id of ids) store.records.delete(id)
        for (const hook of hooks) hook()
      }),
    }
    const plain = vi.fn(async (_context: unknown) => {})
    const transactional = vi.fn(
      async ({
        tx,
        idempotencyKey,
      }: {
        tx: GroupTransaction & { effects: Map<string, string> }
        idempotencyKey: string
      }) => {
        tx.effects.set(idempotencyKey, 'once')
      },
    )
    const bob = makeMLSPeer(hub, 'bob', secret, {
      epoch: 7,
      crypto: reader,
      completion: completion as HandlerCompletion<GroupTransaction>,
      handlers: { 'chat/posted': plain },
    })
    expect(construction.mock.calls.at(-1)?.[0].completion).toBe(completion)
    expect(construction.mock.calls.at(-1)?.[0].openedHandler?.completion).toBe(completion)
    // The next peer uses the same portable port with the transactional policy.
    const sender = createFakeCrypto({ epoch: 7, localDID: 'alice' })
    const topicID = protocolTopic(fakeEpochSecret(7, APP_TOPIC_LABEL), 7, 'chat')
    try {
      await bob.peer.replay()
      await hub.publish({
        topicID,
        senderDID: 'alice',
        retain: 'log',
        payload: await sender.wrap(encodeEventFrame('chat/posted', {}), {
          aad: encodeAppAAD({ topicID, intent: 'log' }),
        }),
      })
      bob.peer.retryAppDelivery()
      await vi.waitFor(() => expect(plain).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(store.records.size).toBe(0))
      expect(plain.mock.calls[0]?.[0]).toMatchObject({
        epoch: 7,
        incarnation: 1,
        frame: { procedure: 'chat/posted' },
      })
      const context = plain.mock.calls[0]?.[0] as {
        frame: PendingAppFrame['frame']
        idempotencyKey: string
      }
      expect(context.idempotencyKey).toBe(appFrameIdempotencyKey(context.frame))
      expect(completion.complete).toHaveBeenCalledTimes(1)
      expect(bob.appCursorStore.stored(topicID)).toBeNull()
      await bob.peer.dispose()
      const next = makeMLSPeer(hub, 'bob', secret, {
        epoch: 7,
        restartOf: bob,
        crypto: reader,
        completion: completion as HandlerCompletion<GroupTransaction>,
        handlers: { 'chat/posted': { mode: 'transactional', handle: transactional } },
      })
      try {
        await next.peer.replay()
        next.peer.retryAppDelivery()
        await flush()
        expect(transactional).not.toHaveBeenCalled()
        await hub.publish({
          topicID,
          senderDID: 'alice',
          retain: 'log',
          payload: await sender.wrap(encodeEventFrame('chat/posted', {}), {
            aad: encodeAppAAD({ topicID, intent: 'log' }),
          }),
        })
        next.peer.retryAppDelivery()
        await vi.waitFor(() => expect(effects.size).toBe(1))
        expect(transactional).toHaveBeenCalledTimes(1)
        expect(completion.transact).toHaveBeenCalledTimes(1)
        await completion.complete(['unknown', 'unknown'])
        await completion.transact(['unknown'], async () => {
          throw new Error('unknown callback')
        })
        expect(next.appCursorStore.stored(topicID)).toBeNull()
        await next.peer.dispose()
        const reopened = makeMLSPeer(hub, 'bob', secret, {
          epoch: 7,
          restartOf: next,
          crypto: reader,
          completion: completion as HandlerCompletion<GroupTransaction>,
          handlers: { 'chat/posted': { mode: 'transactional', handle: transactional } },
        })
        try {
          await reopened.peer.replay()
          reopened.peer.retryAppDelivery()
          await flush()
          expect(transactional).toHaveBeenCalledTimes(1)
          expect(effects.size).toBe(1)
          expect(reopened.appCursorStore.stored(topicID)).toBeNull()
        } finally {
          await reopened.peer.dispose()
        }
      } finally {
        await next.peer.dispose()
      }
    } finally {
      await bob.peer.dispose()
    }
  })

  test('a failed saved-record read retries without opening twice or advancing the cursor', async () => {
    const { lane, reader, store, cursor, topicID, append } = retainedLane()
    onTestFinished(() => lane.dispose())
    await append('000000000001', 'log')
    const list = store.port.list.bind(store.port)
    const failure = new Error('saved-record read unavailable')
    vi.spyOn(store.port, 'list').mockImplementation(async () => {
      if (store.records.size > 0) throw failure
      return list()
    })
    await expect(lane.deliver()).rejects.toSatisfy(isAppFrameStorageError)
    expect(cursor.stored(topicID)).toBeNull()
    expect(store.records.size).toBe(1)
    await expect(lane.dropFrame(topicID, '000000000001')).rejects.toThrow('app frame is pending')
    vi.mocked(store.port.list).mockImplementation(list)
    await lane.deliver()
    expect(reader.starts.unwrap).toBe(1)
    expect(lane.pendingRecords()).toEqual([...store.records.values()])
    expect(cursor.stored(topicID)).toBeNull()
  })

  test('a saved-record read retry survives resetting the app lane without reopening', async () => {
    const { lane, reader, store, cursor, topicID, append } = retainedLane()
    onTestFinished(() => lane.dispose())
    await append('000000000001', 'log')
    vi.spyOn(store.port, 'list').mockRejectedValue(new Error('saved-record read unavailable'))
    await expect(lane.deliver()).rejects.toSatisfy(isAppFrameStorageError)
    lane.reset()
    vi.mocked(store.port.list).mockResolvedValue([...store.records.values()])
    await lane.deliver()
    expect(reader.starts.unwrap).toBe(1)
    expect(lane.pendingRecords()).toEqual([...store.records.values()])
    expect(cursor.stored(topicID)).toBeNull()
  })

  test('a durable open with no saved record refuses delivery and cursor advancement', async () => {
    const { lane, store, cursor, topicID, append } = retainedLane()
    onTestFinished(() => lane.dispose())
    vi.spyOn(store.port, 'list').mockResolvedValue([])
    await append('000000000001', 'log')
    await expect(lane.deliver()).rejects.toSatisfy(isAppFrameStorageError)
    expect(lane.pendingRecords()).toEqual([])
    expect(cursor.stored(topicID)).toBeNull()
  })

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
    expect(cursor.stored(topicID)).toBeNull()
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

  test('a rejected pull waits for its other protocol without reserving the app lane', async () => {
    const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
    const chatTopic = protocolTopic(anchor.secret, 1, 'chat')
    let releaseDelayed: (() => void) | undefined
    const delayed = new Promise<void>((resolve) => {
      releaseDelayed = resolve
    })
    let chatFetches = 0
    let otherFetches = 0
    const lane = createAppLane(
      testAppLaneParams({
        groupKey: { groupID: 'group', incarnation: 1 },
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
        appliedEpoch: () => 1,
        crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
        localDID: 'bob',
        protocols: { chat, other: chat },
        eventHandlers: new Map(),
        retentionSeconds: 60,
        anchor: () => anchor,
        groupID: () => 'group',
      }),
    )
    onTestFinished(() => {
      releaseDelayed?.()
      lane.dispose()
    })
    const first = lane.deliver()
    const failed = expect(first).rejects.toThrow('first fetch failed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const retry = lane.deliver()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(chatFetches).toBe(2)
    expect(otherFetches).toBe(2)
    releaseDelayed?.()
    await failed
    await retry
    expect(chatFetches).toBe(2)
    expect(otherFetches).toBe(2)
  })

  test('a storage fault preserves the frame while commits advance and the app lane retries', async () => {
    const stalled = vi.fn()
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x91)
    const store = pendingStore()
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { members: ['alice', 'bob'], epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      members: ['alice', 'bob'],
      epoch: 1,
      handlers: {
        'chat/posted': () => {
          throw new Error('handler paused')
        },
      },
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: store.port }),
      onAppDeliveryStalled: stalled,
    })
    await flush()
    hub.detach('bob')
    await alice.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'first' } })
    await flush()
    await alice.peer.commit(buildLedgerCommit(alice, []))
    store.setFail(true)
    await bob.peer.enqueue(buildLedgerCommit(bob, []))
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(bob.mls.epoch()).toBe(3))
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
    expect(bob.appCursorStore.stored(topicID)).toBeNull()
    expect(store.records.size).toBe(0)
    store.setFail(false)
    await vi.waitFor(() => expect(store.records.size).toBe(1), { timeout: 2500 })
    expect([...store.records.values()][0]?.frame).toMatchObject({ topicID, segment: 1 })
    expect(bob.appCursorStore.stored(topicID)).toBeNull()
    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a failed final drain after rotation still rebuilds the new app topic', async () => {
    const stalled = vi.fn()
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
      onAppDeliveryStalled: stalled,
      handlers: { 'chat/changed': (context: { data: unknown }) => void seen.push(context.data) },
    })
    await flush()
    hub.detach('bob')
    await publishCommit({
      authenticator: memoryAuthenticator(bob.mls),
      hub,
      senderDID: 'admin',
      recoverySecret,
      epoch: 1,
      removes: ['carol'],
    })
    await flush()
    await alice.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'new topic' } })
    await flush()
    store.setFail(true)
    await bob.peer.enqueue(buildLedgerCommit(bob, []))
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(bob.mls.epoch()).toBe(3))
    expect(bob.peer.anchorEpoch()).toBe(2)
    hub.reattach('bob')
    await alice.peer.protocol('chat').dispatch('chat/changed', { data: { text: 'after failure' } })
    await flush()
    expect(seen).toEqual([{ text: 'after failure' }])
    await alice.peer.dispose()
    await bob.peer.dispose()
  })
})
