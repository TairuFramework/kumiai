import type { LogHub } from '@kumiai/hub-tunnel'
import { expect, type MockInstance, test, vi } from 'vitest'

import { APP_TOPIC_LABEL, inboxTopic, protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { fakeEpochSecret } from './fixtures/fake-crypto.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

for (const scenario of ['acknowledged', 'delayed', 'two epochs', 'expired'] as const) {
  test(`anchor-time subscription delivers within its bounds: ${scenario}`, async () => {
    const fake = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb8)
    const secret = fakeEpochSecret(2, APP_TOPIC_LABEL)
    const topicID = protocolTopic(secret, 2, 'chat')
    const selfInbox = inboxTopic(secret, 2, 'bob')
    let acknowledge = (): void => {}
    const subscriptionGate = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    const retains: Array<{ topicID: string; retention: number | undefined }> = []
    const hub: LogHub = {
      subscribe: async (did, topic, options) => {
        if (did === 'bob' && (topic === topicID || topic === selfInbox)) {
          retains.push({ topicID: topic, retention: options?.retention })
          if (scenario === 'delayed') await subscriptionGate
        }
        fake.subscribe(did, topic, options)
      },
      unsubscribe: (did, topic) => fake.unsubscribe(did, topic),
      publish: (params) => fake.publish(params),
      receive: (did) => fake.receive(did),
      fetchTopic: (params) => fake.fetchTopic(params),
    }
    let captured = (): void => {}
    const captureStarted = new Promise<void>((resolve) => {
      captured = resolve
    })
    let release = (): void => {}
    const saveGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = createMemoryAnchorStore()
    const save = store.save
    store.save = async (slot) => {
      await save(slot)
      if (slot.pending == null && slot.anchor.epoch === 2) {
        captured()
        await saveGate
      }
    }
    const deliveries: Array<unknown> = []
    const members = ['alice', 'bob', 'carol']
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      members,
      anchorStore: store,
      handlers: { 'chat/changed': (event: { data: unknown }) => void deliveries.push(event.data) },
    })
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { members })
    let clock: MockInstance | undefined
    try {
      await Promise.all([alice.peer.replay(), bob.peer.replay()])
      fake.detach('bob')
      await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
      await flush()
      await alice.peer.replay()
      if (scenario === 'two epochs') {
        fake.detach('alice')
        await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 2 })
      }
      fake.reattach('bob')
      fake.redeliver('bob')
      await captureStarted
      expect(bob.peer.anchorEpoch()).toBe(2)
      expect(retains).toEqual([
        { topicID, retention: 2_419_200 },
        { topicID: selfInbox, retention: 2_419_200 },
      ])
      await alice.peer.protocol('chat').dispatch('chat/changed', { data: { text: 'during save' } })
      await flush()
      expect(deliveries).toHaveLength(0)
      if (scenario === 'delayed') {
        acknowledge()
        await flush()
        await alice.peer.protocol('chat').dispatch('chat/changed', { data: { text: 'after ack' } })
        await flush()
      }
      if (scenario === 'expired') {
        clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
      }
      release()
      await bob.peer.replay()
      await flush()
      expect(bob.mls.epoch()).toBe(scenario === 'two epochs' ? 3 : 2)
      expect(retains).toHaveLength(2)
      if (scenario === 'two epochs' || scenario === 'expired') {
        const intermediateEpochDeliveries = deliveries.length
        expect(intermediateEpochDeliveries).toBe(0)
      } else {
        const deliveriesWithinTTL = deliveries.length
        expect(deliveriesWithinTTL).toBe(1)
        expect(deliveries).toEqual([{ text: scenario === 'delayed' ? 'after ack' : 'during save' }])
      }
    } finally {
      clock?.mockRestore()
      acknowledge()
      release()
      await bob.peer.replay()
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    }
  })
}
