import { describe, expect, test, vi } from 'vitest'

import { createAppLane } from '../src/app-lane.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { adaptBusHandlers } from '../src/handlers.js'
import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, chat, makeMLSPeer } from './fixtures/peer.js'

describe('durable app rotation', () => {
  test('a failed anchor export refuses a new-epoch dispatch', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x94)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      members: ['alice', 'bob', 'carol'],
    })
    await bob.peer.protocol('chat').to('alice')
    hub.detach('bob')
    const originalExport = bob.crypto.exportSecret.bind(bob.crypto)
    vi.spyOn(bob.crypto, 'exportSecret').mockImplementation((label, length) => {
      if (label === APP_TOPIC_LABEL && bob.crypto.epoch() === 2) {
        throw new Error('export failed')
      }
      return originalExport(label, length)
    })
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    await expect(bob.peer.commit(buildLedgerCommit(bob, []))).rejects.toThrow('export failed')
    await expect(
      bob.peer.protocol('chat').dispatch('chat/posted', {
        data: { text: 'must not leave' },
      }),
    ).rejects.toThrow('anchor')
    await bob.peer.dispose()
  })

  test('a dispatch during anchor export seals onto the new topic and is delivered', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x93)
    const seen = vi.fn()
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      members: ['alice', 'bob', 'carol'],
    })
    await bob.peer.protocol('chat').to('alice')
    hub.detach('bob')
    let entered!: () => void
    let release!: () => void
    const exporting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalExport = bob.crypto.exportSecret.bind(bob.crypto)
    vi.spyOn(bob.crypto, 'exportSecret').mockImplementation(async (label, length) => {
      if (label === APP_TOPIC_LABEL && bob.crypto.epoch() === 2) {
        entered()
        await held
      }
      return originalExport(label, length)
    })
    await publishCommit({ hub, senderDID: 'admin', recoverySecret, epoch: 1, removes: ['carol'] })
    const oldTopic = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
    const newTopic = protocolTopic(fakeEpochSecret(2, APP_TOPIC_LABEL), 2, 'chat')
    const committing = bob.peer.commit(buildLedgerCommit(bob, []))
    await exporting
    const dispatching = bob.peer.protocol('chat').dispatch('chat/posted', {
      data: { text: 'new segment' },
    })
    release()
    await committing
    await dispatching
    const appPublications = hub.published.filter(
      (message) => message.topicID === oldTopic || message.topicID === newTopic,
    )
    expect(appPublications.map((message) => message.topicID)).toEqual([newTopic])
    expect(bob.crypto.frameEpoch(appPublications[0]?.payload ?? new Uint8Array())).toBe(2)
    const records = new Map<string, PendingAppFrame>()
    const lane = createAppLane({
      mux: {
        retainTopic() {},
        async fetchTopic({ after }: { after?: string }) {
          return {
            messages: appPublications.filter(
              (message) => after == null || message.sequenceID > after,
            ),
            head: appPublications.at(-1)?.sequenceID ?? null,
            oldest: appPublications[0]?.sequenceID ?? null,
          }
        },
      } as never,
      crypto: createFakeCrypto({
        epoch: 2,
        localDID: 'alice',
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
      }),
      localDID: 'alice',
      protocols: { chat },
      eventHandlers: new Map([['chat', adaptBusHandlers(chat, { 'chat/posted': seen }).events]]),
      retentionSeconds: 60,
      anchor: () => ({ epoch: 2, secret: fakeEpochSecret(2, APP_TOPIC_LABEL) }),
      groupID: () => 'group',
    })
    await lane.deliver()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1))
    expect(seen.mock.calls[0]?.[0].data.text).toBe('new segment')
    lane.dispose()
    await bob.peer.dispose()
  })
})
