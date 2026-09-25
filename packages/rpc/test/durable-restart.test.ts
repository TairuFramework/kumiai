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
import { chat, makeMLSPeer } from './fixtures/peer.js'

const recoverySecret = new Uint8Array(32).fill(0x91)
const oldTopic = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
const newTopic = protocolTopic(fakeEpochSecret(2, APP_TOPIC_LABEL), 2, 'chat')
const payload = (text: string) =>
  fromUTF(JSON.stringify({ payload: { typ: 'event', prc: 'chat/posted', data: { text } } }))

describe('durable pending restoration', () => {
  test('a crash after the atomic open restores the record, applies it once, then opens the next frame', async () => {
    const hub = new DurableFakeHub()
    const rows = new Map<string, PendingAppFrame>()
    const database: { state?: Uint8Array } = {}
    const persist = vi.fn(async (state: Uint8Array, record: PendingAppFrame) => {
      database.state = state.slice()
      rows.set(record.frame.id, record)
      void first.peer.dispose() // crash before the queued handler starts
    })
    const complete = vi.fn(async (id: string) => {
      rows.delete(id)
    })
    const pending = { persistOpened: persist, list: async () => [...rows.values()], complete }
    const first = makeMLSPeer(hub, 'bob', recoverySecret, {
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending }),
      handlers: { 'chat/posted': vi.fn() },
    })
    await first.peer.protocol('chat').to('alice')
    const alice = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const publish = async (text: string) =>
      hub.publish({
        topicID: oldTopic,
        senderDID: 'alice',
        payload: await alice.wrap(payload(text), {
          aad: encodeAppAAD({ topicID: oldTopic, intent: 'log' }),
        }),
        retain: 'log',
      })
    await publish('first')
    await vi.waitFor(() => expect(rows.size).toBe(1))
    await first.peer.dispose()
    expect(database.state).toBeDefined()
    expect(first.appCursorStore.stored(oldTopic)).toBeNull()

    const seen: Array<{ text: string; id: string }> = []
    let releaseFirst: (() => void) | undefined
    const firstApplied = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const second = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: first,
      crypto: createFakeCrypto({ localDID: 'bob', state: database.state, pending }),
      handlers: {
        'chat/posted': async ({
          data,
          frame,
        }: {
          data: { text: string }
          frame: PendingAppFrame['frame']
        }) => {
          seen.push({ text: data.text, id: frame.id })
          if (data.text === 'first') await firstApplied
        },
      },
    })
    await vi.waitFor(() => expect(seen.map((item) => item.text)).toEqual(['first']))
    expect(first.appCursorStore.stored(oldTopic)).toBeNull()
    releaseFirst?.()
    await vi.waitFor(() => expect(rows.size).toBe(0))
    expect(first.appCursorStore.stored(oldTopic)).toBe(hub.head(oldTopic))
    await publish('second')
    await vi.waitFor(() => expect(seen.map((item) => item.text)).toEqual(['first', 'second']))
    await vi.waitFor(() => expect(rows.size).toBe(0))
    expect(new Set(seen.map((item) => item.id)).size).toBe(2)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(complete).toHaveBeenCalledTimes(2)
    await second.peer.dispose()
  })

  test('a failed startup list is retried before the seed pull can open a frame', async () => {
    const hub = new DurableFakeHub()
    const alice = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    await hub.publish({
      topicID: oldTopic,
      senderDID: 'alice',
      payload: await alice.wrap(payload('waiting'), {
        aad: encodeAppAAD({ topicID: oldTopic, intent: 'log' }),
      }),
      retain: 'log',
    })
    let lists = 0
    const persist = vi.fn(async (_state: Uint8Array, _record: PendingAppFrame) => {})
    const seen = vi.fn()
    const peer = makeMLSPeer(hub, 'bob', recoverySecret, {
      crypto: createFakeCrypto({
        epoch: 1,
        localDID: 'bob',
        pending: {
          async persistOpened(state, record) {
            await persist(state, record)
          },
          async list() {
            lists += 1
            if (lists === 1) throw new Error('transient list failure')
            return []
          },
          async complete() {},
        },
      }),
      handlers: { 'chat/posted': seen },
    })
    await vi.waitFor(() => expect(lists).toBe(1))
    expect(persist).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1), { timeout: 2500 })
    expect(lists).toBeGreaterThanOrEqual(2)
    await peer.peer.dispose()
  })

  test('an old-segment pending record survives reset and does not advance the new topic cursor', async () => {
    const cursor = createMemoryAppCursorStore()
    const old = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const sealed = await old.wrap(payload('old'), {
      aad: encodeAppAAD({ topicID: oldTopic, intent: 'log' }),
    })
    const record: PendingAppFrame = {
      frame: {
        id: 'old-id',
        topicID: oldTopic,
        protocol: 'chat',
        segment: 1,
        position: '000000000001',
      },
      payload: payload('old'),
      senderDID: 'alice',
    }
    const rows = new Map([[record.frame.id, record]])
    const unknown: PendingAppFrame = {
      ...record,
      frame: { ...record.frame, id: 'unknown-id', protocol: 'unserved' },
    }
    rows.set(unknown.frame.id, unknown)
    const complete = vi.fn(async (id: string) => {
      rows.delete(id)
    })
    const seen = vi.fn()
    const notices = vi.fn()
    const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic({ topicID }: { topicID: string }) {
          return {
            messages:
              topicID === oldTopic ? [{ sequenceID: record.frame.position, payload: sealed }] : [],
            head: null,
            oldest: null,
          }
        },
      } as never,
      crypto: createFakeCrypto({
        epoch: 2,
        localDID: 'bob',
        pending: {
          async persistOpened() {
            throw new Error('must not reopen')
          },
          async list() {
            return [...rows.values()]
          },
          complete,
        },
      }),
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map([['chat', adaptBusHandlers(chat, { 'chat/posted': seen }).events]]),
      retentionSeconds: 60,
      appCursorStore: cursor,
      anchor: () => anchor,
      groupID: () => 'group',
      onAppDeliveryStalled: notices,
      justifiedEpochCeiling: async () => 2,
    })
    await lane.restore([record, unknown])
    await lane.restore([record, unknown])
    expect(complete).not.toHaveBeenCalledWith('unknown-id')
    expect(rows.has('unknown-id')).toBe(true)
    expect(notices).toHaveBeenCalledTimes(1)
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'unserved', reason: 'unknown-protocol' }),
    )
    anchor.epoch = 2
    anchor.secret = fakeEpochSecret(2, APP_TOPIC_LABEL)
    lane.reset()
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(rows.size).toBe(1))
    await expect(
      lane.dropFrame(unknown.frame.topicID, unknown.frame.position),
    ).resolves.toBeUndefined()
    expect(rows.size).toBe(0)
    expect(complete).toHaveBeenCalledWith('old-id')
    expect(cursor.stored(newTopic)).toBeNull()
    expect(cursor.history(newTopic)).toEqual([])
    lane.dispose()
  })

  test('a missing-protocol record survives one start and delivers when registered on the next', async () => {
    const record: PendingAppFrame = {
      frame: {
        id: 'later-id',
        topicID: oldTopic,
        protocol: 'later',
        segment: 1,
        position: '000000000001',
      },
      payload: payload('saved'),
      senderDID: 'alice',
    }
    const rows = new Map([[record.frame.id, record]])
    const complete = vi.fn(async (id: string) => {
      rows.delete(id)
    })
    const pending = {
      async persistOpened() {},
      async list() {
        return [...rows.values()]
      },
      complete,
    }
    const notices = vi.fn()
    const seen = vi.fn()
    const makeLane = (registered: boolean) =>
      createAppLane({
        mux: {
          retainTopic() {},
          async fetchTopic() {
            return { messages: [], head: null, oldest: null }
          },
        } as never,
        crypto: createFakeCrypto({ epoch: 2, localDID: 'bob', pending }),
        localDID: 'bob',
        protocols: registered ? { later: chat } : {},
        eventHandlers: registered
          ? new Map([['later', adaptBusHandlers(chat, { 'chat/posted': seen }).events]])
          : new Map(),
        retentionSeconds: 60,
        anchor: () => ({ epoch: 2, secret: fakeEpochSecret(2, APP_TOPIC_LABEL) }),
        groupID: () => 'group',
        onAppDeliveryStalled: notices,
        justifiedEpochCeiling: async () => 2,
      })
    const first = makeLane(false)
    await first.restore([record])
    await first.deliver()
    expect(rows.size).toBe(1)
    expect(complete).not.toHaveBeenCalled()
    expect(notices).toHaveBeenCalledTimes(1)
    first.dispose()
    const second = makeLane(true)
    await second.restore(await pending.list())
    await second.deliver()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(rows.size).toBe(0))
    second.dispose()
  })

  test('startup reports a missing protocol after the group id is available', async () => {
    const record: PendingAppFrame = {
      frame: {
        id: 'missing-at-start',
        topicID: oldTopic,
        protocol: 'missing',
        segment: 1,
        position: '000000000001',
      },
      payload: payload('saved'),
      senderDID: 'alice',
    }
    const rows = new Map([[record.frame.id, record]])
    const notices = vi.fn()
    const bob = makeMLSPeer(new DurableFakeHub(), 'bob', recoverySecret, {
      crypto: createFakeCrypto({
        localDID: 'bob',
        pending: {
          async persistOpened() {},
          async list() {
            return [...rows.values()]
          },
          async complete(id) {
            rows.delete(id)
          },
        },
      }),
      onAppDeliveryStalled: notices,
    })
    await bob.peer.protocol('chat').to('alice')
    await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(1))
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unknown-protocol', protocol: 'missing' }),
    )
    expect(rows.size).toBe(1)
    await bob.peer.dispose()
  })

  test('disposing during startup restore backoff stops retries and settles disposal', async () => {
    const hub = new DurableFakeHub()
    const list = vi.fn(async (): Promise<Array<PendingAppFrame>> => {
      throw new Error('store unavailable')
    })
    const peer = makeMLSPeer(hub, 'bob', recoverySecret, {
      crypto: createFakeCrypto({
        localDID: 'bob',
        pending: { async persistOpened() {}, list, async complete() {} },
      }),
    })
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    await Promise.race([
      peer.peer.dispose(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('dispose stayed blocked')), 200),
      ),
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(list).toHaveBeenCalledTimes(1)
  })
})
