import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, onTestFinished, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { createAppLane, frameID } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { adaptBusHandlers } from '../src/handlers.js'
import { createHubMux } from '../src/hub-mux.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { chat, makeMLSPeer } from './fixtures/peer.js'

const anchor = { epoch: 1, secret: fakeEpochSecret(1, APP_TOPIC_LABEL) }
const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
const aad = encodeAppAAD({ topicID, intent: 'log' })

function pendingStore() {
  const rows = new Map<string, PendingAppFrame>()
  return {
    rows,
    async persistOpened(_state: Uint8Array, record: PendingAppFrame) {
      rows.set(record.frame.id, record)
    },
    async list() {
      return [...rows.values()]
    },
    async complete(id: string) {
      rows.delete(id)
    },
  }
}

describe('durable app lane hygiene', () => {
  test('idle awaits an in-flight cursor save after disposal', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
    const cursor = createMemoryAppCursorStore()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const save = cursor.save
    cursor.save = async (topic, position) => {
      entered.resolve()
      await gate.promise
      await save(topic, position)
    }
    const lane = createAppLane({
      mux,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending: pendingStore() }),
      appliedEpoch: () => 1,
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map(),
      retentionSeconds: 60,
      appCursorStore: cursor,
      anchor: () => anchor,
      groupID: () => 'group',
    })
    onTestFinished(() => {
      gate.resolve()
      lane.dispose()
      mux.dispose()
    })
    const payload = await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', { text: 'saved' }),
      { aad },
    )
    const frame = await hub.publish({ topicID, senderDID: 'alice', payload, retain: 'log' })
    await lane.deliver()
    await entered.promise
    lane.dispose()
    let idle = false
    const drain = lane.idle().then(() => {
      idle = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(idle).toBe(false)
    gate.resolve()
    await drain
    expect(cursor.stored(topicID)).toBe(frame.sequenceID)
  })

  test('drained awaits an in-flight cursor save', async () => {
    const hub = new DurableFakeHub()
    const pending = pendingStore()
    const appCursorStore = createMemoryAppCursorStore()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const save = appCursorStore.save
    appCursorStore.save = async (topic, position) => {
      entered.resolve()
      await gate.promise
      await save(topic, position)
    }
    const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0xb6), {
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending }),
      appCursorStore,
    })
    onTestFinished(async () => {
      gate.resolve()
      await bob.peer.dispose()
      await bob.peer.drained()
    })
    await bob.peer.protocol('chat').to('alice')
    const payload = await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', { text: 'saved' }),
      { aad },
    )
    const frame = await hub.publish({ topicID, senderDID: 'alice', payload, retain: 'log' })
    await bob.peer.retryAppDelivery(topicID)
    await entered.promise
    await bob.peer.dispose()
    let drained = false
    const drain = bob.peer.drained().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drained).toBe(false)
    expect(appCursorStore.stored(topicID)).toBeNull()
    gate.resolve()
    await drain
    expect(appCursorStore.stored(topicID)).toBe(frame.sequenceID)
  })

  test('a finished record does not resume another frame stalled at its position', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
    const pending = pendingStore()
    const stalled = vi.fn()
    const resumed = vi.fn()
    const handler = vi.fn()
    const lane = createAppLane({
      mux,
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending }),
      appliedEpoch: () => 1,
      localDID: 'bob',
      protocols: { chat },
      eventHandlers: new Map([['chat', adaptBusHandlers(chat, { 'chat/posted': handler }).events]]),
      retentionSeconds: 60,
      onAppDeliveryStalled: stalled,
      onAppDeliveryResumed: resumed,
      anchor: () => anchor,
      groupID: () => 'group',
    })
    onTestFinished(() => {
      lane.dispose()
      mux.dispose()
    })
    const payload = await createFakeCrypto({ epoch: 2, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', { text: 'X' }),
      { aad },
    )
    const frame = await hub.publish({ topicID, senderDID: 'alice', payload, retain: 'log' })
    await lane.deliver()
    expect(stalled).toHaveBeenCalledTimes(1)

    const yPayload = encodeEventFrame('chat/posted', { text: 'Y' })
    const ySealed = await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(yPayload, {
      aad,
    })
    const record: PendingAppFrame = {
      frame: {
        id: frameID(topicID, ySealed),
        topicID,
        position: frame.sequenceID,
        protocol: 'chat',
        segment: 1,
      },
      senderDID: 'alice',
      payload: yPayload,
    }
    pending.rows.set(record.frame.id, record)
    await lane.restore([record])
    await lane.deliver()
    await vi.waitFor(() => expect(lane.pendingRecords()).toHaveLength(0))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(pending.rows.size).toBe(0)
    expect(resumed).not.toHaveBeenCalled()

    await lane.dropFrame(topicID, frame.sequenceID)
    expect(resumed).toHaveBeenCalledExactlyOnceWith({
      settlement: 'resumed',
      groupID: 'group',
      protocol: 'chat',
      topicID,
      position: frame.sequenceID,
      reason: 'future-epoch',
    })
  })
})
