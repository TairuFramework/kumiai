import { encodeEventFrame } from '@kumiai/broadcast'
import type { HubFetchTopicParams, HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0xa4)
const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')

function durableBob(hub: DurableFakeHub, options: Parameters<typeof makeMLSPeer>[3] = {}) {
  const rows = new Map<string, PendingAppFrame>()
  const crypto = createFakeCrypto({
    epoch: 1,
    localDID: 'bob',
    pending: {
      async persistOpened(_state, record) {
        rows.set(record.frame.id, record)
      },
      async list() {
        return [...rows.values()]
      },
      async complete(id) {
        rows.delete(id)
      },
    },
  })
  return makeMLSPeer(hub, 'bob', secret, { ...options, crypto })
}

describe('future-epoch app retention', () => {
  test('an omitted commit cannot move the cursor past an honest next-epoch frame', async () => {
    class OmittingHub extends DurableFakeHub {
      omitForBob = false
      override async fetchTopic(params: HubFetchTopicParams): Promise<HubFetchTopicResult> {
        if (
          this.omitForBob &&
          params.subscriberDID === 'bob' &&
          params.topicID === commitTopic(secret)
        ) {
          return { messages: [], head: null, oldest: null }
        }
        return super.fetchTopic(params)
      }
    }
    const hub = new OmittingHub()
    const seen = vi.fn()
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => seen(ctx.data) }
    const alice = makeMLSPeer(hub, 'alice', secret)
    const bob = durableBob(hub, { handlers })
    await bob.peer.protocol('chat').to('alice')
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.commit(buildLedgerCommit(alice, []))
    await alice.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'epoch two' } })
    const frame = hub.published.find((item) => item.topicID === topicID)
    expect(frame).toBeDefined()
    hub.omitForBob = true
    const restarted = makeMLSPeer(hub, 'bob', secret, { restartOf: bob, handlers })
    await restarted.peer.protocol('chat').to('alice')
    expect(restarted.mls.epoch()).toBe(1)
    expect(seen).not.toHaveBeenCalled()
    expect(restarted.appCursorStore.stored(topicID)).toBeNull()

    hub.omitForBob = false
    hub.reattach('bob')
    hub.redeliver('bob')
    await vi.waitFor(() => expect(restarted.mls.epoch()).toBe(2))
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ text: 'epoch two' }))
    expect(restarted.appCursorStore.stored(topicID)).toBe(frame?.sequenceID)
    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  test('a forged far-future frame stalls once and an operator drop persists across restart', async () => {
    const hub = new DurableFakeHub()
    const notices = vi.fn()
    const seen = vi.fn()
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => seen(ctx.data) }
    const bob = durableBob(hub, { handlers, onAppDeliveryStalled: notices })
    await bob.peer.protocol('chat').to('alice')
    await bob.peer.dispose()
    hub.detach('bob')

    const forged = createFakeCrypto({ epoch: 65535, localDID: 'mallory' })
    const blocked = await hub.publish({
      senderDID: 'mallory',
      topicID,
      retain: 'log',
      payload: await forged.wrap(encodeEventFrame('chat/posted', { text: 'forged' }), {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      }),
    })
    const restarted = makeMLSPeer(hub, 'bob', secret, {
      restartOf: bob,
      handlers,
      onAppDeliveryStalled: notices,
    })
    await restarted.peer.protocol('chat').to('alice')
    await restarted.peer.replay()
    expect(notices).toHaveBeenCalledTimes(1)
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({
        position: blocked.sequenceID,
        reason: 'future-epoch',
      }),
    )
    expect(restarted.appCursorStore.stored(topicID)).toBeNull()
    expect(seen).not.toHaveBeenCalled()

    await restarted.peer.dropAppFrame(topicID, blocked.sequenceID)
    expect(restarted.appCursorStore.stored(topicID)).toBe(blocked.sequenceID)
    await restarted.peer.dispose()
    const again = makeMLSPeer(hub, 'bob', secret, {
      restartOf: restarted,
      handlers,
      onAppDeliveryStalled: notices,
    })
    await again.peer.protocol('chat').to('alice')
    expect(again.appCursorStore.stored(topicID)).toBe(blocked.sequenceID)
    expect(notices).toHaveBeenCalledTimes(1)
    await again.peer.dispose()
  })
})
