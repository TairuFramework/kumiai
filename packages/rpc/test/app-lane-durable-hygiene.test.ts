import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, onTestFinished, test, vi } from 'vitest'

import type { Anchor } from '../src/anchor.js'
import { encodeAppAAD } from '../src/app-aad.js'
import * as appLaneModule from '../src/app-lane.js'
import { createAppLane, frameID } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { createHubMux } from '../src/hub-mux.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { testAppLaneParams } from './fixtures/app-lane.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { completeTestRecord, createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
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
  test('idle joins completion work admitted while another handler is suspended', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
    const pending = pendingStore()
    const cursor = createMemoryAppCursorStore()
    const first = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const refused = Promise.withResolvers<void>()
    const saving = Promise.withResolvers<void>()
    const saved = Promise.withResolvers<void>()
    const otherTopic = protocolTopic(anchor.secret, anchor.epoch, 'other')
    const complete = pending.complete
    pending.complete = async (id) => {
      if (pending.rows.get(id)?.frame.topicID === otherTopic) {
        saving.resolve()
        await saved.promise
      }
      await complete(id)
    }
    const lane = createAppLane(
      testAppLaneParams({
        groupKey: { groupID: 'group', incarnation: 1 },
        mux,
        crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending }),
        appliedEpoch: () => 1,
        localDID: 'bob',
        protocols: { chat, other: chat },
        eventHandlers: new Map(),
        deliver: async (record) => {
          if (record.frame.protocol === 'chat') {
            entered.resolve()
            await first.promise
            throw new Error('Retain the failed live record')
          }
          refused.resolve()
          return
        },
        retentionSeconds: 60,
        appCursorStore: cursor,
        anchor: () => anchor,
        groupID: () => 'group',
      }),
    )
    onTestFinished(async () => {
      first.resolve()
      saved.resolve()
      lane.dispose()
      await lane.idle()
      mux.dispose()
    })
    const sender = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    for (const topic of [topicID, otherTopic]) {
      const payload = await sender.wrap(encodeEventFrame('chat/posted', { text: 'retained' }), {
        aad: encodeAppAAD({ topicID: topic, intent: 'log' }),
      })
      await hub.publish({ topicID: topic, senderDID: 'alice', payload, retain: 'log' })
    }
    await lane.deliver()
    await Promise.all([entered.promise, refused.promise])
    await new Promise((resolve) => setTimeout(resolve, 0))
    lane.dispose()
    let idle = false
    const drain = lane.idle().then(() => {
      idle = true
    })
    const record = lane.pendingRecords().find((record) => record.frame.protocol === 'other')
    if (record === undefined) throw new Error('Missing retained record')
    await saving.promise
    first.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(idle).toBe(false)
    saved.resolve()
    await drain
    expect(cursor.stored(otherTopic)).toBeNull()
    expect([...pending.rows.values()].map((record) => record.frame.protocol)).toEqual(['chat'])
    lane.releaseOpened()
    const retained = lane.pendingRecords()[0]
    if (retained === undefined) throw new Error('Missing failed live record')
    await pending.complete(retained.frame.id)
    await lane.acknowledgeOpened(retained.frame.id)
    expect(lane.pendingRecords()).toEqual([])
    expect(cursor.stored(topicID)).toBeNull()
  })

  test('drained awaits app lane idle after the host boundary drains', async () => {
    const gate = Promise.withResolvers<void>()
    const create = appLaneModule.createAppLane
    const factory = vi.spyOn(appLaneModule, 'createAppLane').mockImplementation((params) => {
      const lane = create(params)
      const idle = lane.idle
      lane.idle = async () => {
        await gate.promise
        await idle()
      }
      return lane
    })
    const bob = makeMLSPeer(new DurableFakeHub(), 'bob', new Uint8Array(32).fill(0xb6))
    onTestFinished(async () => {
      gate.resolve()
      factory.mockRestore()
      await bob.peer.dispose()
      await bob.peer.drained()
    })
    await bob.peer.protocol('chat').to('alice')
    await bob.peer.dispose()
    let drained = false
    const drain = bob.peer.drained().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drained).toBe(false)
    gate.resolve()
    await drain
    expect(drained).toBe(true)
  })

  test('portable completion survives an unavailable root cursor during disposal', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
    const cursor = createMemoryAppCursorStore()
    const save = vi.spyOn(cursor, 'save').mockRejectedValue(new Error('root cursor unavailable'))
    const pending = pendingStore()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const complete = pending.complete
    pending.complete = async (id) => {
      entered.resolve()
      await gate.promise
      await complete(id)
    }
    const lane = createAppLane(
      testAppLaneParams({
        groupKey: { groupID: 'group', incarnation: 1 },
        mux,
        crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending }),
        appliedEpoch: () => 1,
        localDID: 'bob',
        protocols: { chat },
        eventHandlers: new Map(),
        retentionSeconds: 60,
        appCursorStore: cursor,
        anchor: () => anchor,
        groupID: () => 'group',
      }),
    )
    onTestFinished(() => {
      gate.resolve()
      lane.dispose()
      mux.dispose()
    })
    const payload = await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted'),
      { aad },
    )
    await hub.publish({ topicID, senderDID: 'alice', payload, retain: 'log' })
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
    expect(pending.rows.size).toBe(0)
    expect(save).not.toHaveBeenCalled()
    expect(cursor.stored(topicID)).toBeNull()
  })

  test('drained awaits an in-flight portable completion', async () => {
    const hub = new DurableFakeHub()
    const pending = pendingStore()
    const cursor = createMemoryAppCursorStore()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const complete = pending.complete
    pending.complete = async (id) => {
      entered.resolve()
      await gate.promise
      await complete(id)
    }
    const bob = makeMLSPeer(hub, 'bob', new Uint8Array(32).fill(0xb6), {
      crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending }),
      appCursorStore: cursor,
    })
    onTestFinished(async () => {
      gate.resolve()
      await bob.peer.dispose()
      await bob.peer.drained()
    })
    await bob.peer.protocol('chat').to('alice')
    const payload = await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted'),
      { aad },
    )
    await hub.publish({ topicID, senderDID: 'alice', payload, retain: 'log' })
    bob.peer.retryAppDelivery(topicID)
    await entered.promise
    await bob.peer.dispose()
    let drained = false
    const drain = bob.peer.drained().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drained).toBe(false)
    gate.resolve()
    await drain
    expect(pending.rows.size).toBe(0)
    expect(cursor.stored(topicID)).toBeNull()
  })

  test('a finished record does not resume another frame stalled at its position', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
    const pending = pendingStore()
    const stalled = vi.fn()
    const resumed = vi.fn()
    const handler = vi.fn()
    const lane = createAppLane(
      testAppLaneParams({
        groupKey: { groupID: 'group', incarnation: 1 },
        mux,
        crypto: createFakeCrypto({ epoch: 1, localDID: 'bob', pending }),
        appliedEpoch: () => 1,
        localDID: 'bob',
        protocols: { chat },
        handlers: { chat: { 'chat/posted': handler } },
        retentionSeconds: 60,
        onAppDeliveryStalled: stalled,
        onAppDeliveryResumed: resumed,
        anchor: () => anchor,
        groupID: () => 'group',
      }),
    )
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
    const record: PendingAppFrame = completeTestRecord(
      {
        frame: {
          id: frameID(topicID, ySealed),
          topicID,
          position: frame.sequenceID,
          protocol: 'chat',
          segment: 1,
        },
        senderDID: 'alice',
        payload: yPayload,
      },
      { groupID: 'group', incarnation: 1 },
      'chat/posted',
      1,
    )
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

  test('expiry settles a sealed frame while a different pending record at its position survives', async () => {
    const hub = new DurableFakeHub()
    const mux = createHubMux({ hub, localDID: 'bob', onReceiveEnded() {} })
    const pending = pendingStore()
    const stalled = vi.fn()
    const resumed = vi.fn()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const handler = vi.fn(async () => {
      entered.resolve()
      await gate.promise
    })
    const protocols: Record<string, typeof chat> = {}
    let currentAnchor: Anchor = anchor
    let appliedEpoch = 1
    const reader = createFakeCrypto({ epoch: 1, localDID: 'bob', pending })
    const lane = createAppLane(
      testAppLaneParams({
        groupKey: { groupID: 'group', incarnation: 1 },
        mux,
        crypto: reader,
        appliedEpoch: () => appliedEpoch,
        localDID: 'bob',
        protocols,
        handlers: { chat: { 'chat/posted': handler } },
        retentionSeconds: 60,
        onAppDeliveryStalled: stalled,
        onAppDeliveryResumed: resumed,
        anchor: () => currentAnchor,
        departing: () => (currentAnchor === anchor ? [] : [{ anchor, departedAt: 2 }]),
        groupID: () => 'group',
      }),
    )
    onTestFinished(async () => {
      gate.resolve()
      lane.dispose()
      await lane.idle()
      mux.dispose()
    })
    const xSealed = await createFakeCrypto({ epoch: 3, localDID: 'alice' }).wrap(
      encodeEventFrame('chat/posted', { text: 'X' }),
      { aad },
    )
    const frame = await hub.publish({
      topicID,
      senderDID: 'alice',
      payload: xSealed,
      retain: 'log',
    })
    const yPayload = encodeEventFrame('chat/posted', { text: 'Y' })
    const ySealed = await createFakeCrypto({ epoch: 1, localDID: 'alice' }).wrap(yPayload, { aad })
    const record: PendingAppFrame = completeTestRecord(
      {
        frame: {
          id: frameID(topicID, ySealed),
          topicID,
          position: frame.sequenceID,
          protocol: 'chat',
          segment: 1,
        },
        senderDID: 'alice',
        payload: yPayload,
      },
      { groupID: 'group', incarnation: 1 },
      'chat/posted',
      1,
    )
    pending.rows.set(record.frame.id, record)
    await lane.restore([record])
    expect(stalled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'unknown-protocol', position: frame.sequenceID }),
    )
    protocols.chat = chat
    await lane.deliver()
    await entered.promise
    expect(stalled).toHaveBeenCalledTimes(2)
    expect(stalled).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'future-epoch', position: frame.sequenceID }),
    )

    currentAnchor = { epoch: 2, secret: fakeEpochSecret(2, APP_TOPIC_LABEL) }
    appliedEpoch = 2
    reader.setEpoch(appliedEpoch)
    await lane.deliver()
    expect(resumed).not.toHaveBeenCalled()
    appliedEpoch = 34
    reader.setEpoch(appliedEpoch)
    await lane.deliver()
    expect(resumed).toHaveBeenCalledExactlyOnceWith({
      settlement: 'expired',
      groupID: 'group',
      protocol: 'chat',
      topicID,
      position: frame.sequenceID,
      reason: 'future-epoch',
    })
    expect(lane.pendingRecords()).toEqual([record])
    expect(pending.rows.get(record.frame.id)).toBe(record)

    gate.resolve()
    await vi.waitFor(() => expect(resumed).toHaveBeenCalledTimes(2))
    expect(resumed).toHaveBeenLastCalledWith({
      settlement: 'resumed',
      groupID: 'group',
      protocol: 'chat',
      topicID,
      position: frame.sequenceID,
      reason: 'unknown-protocol',
    })
    expect(lane.pendingRecords()).toHaveLength(0)
    expect(pending.rows.size).toBe(0)
    await lane.deliver()
    expect(resumed).toHaveBeenCalledTimes(2)
  })
})
