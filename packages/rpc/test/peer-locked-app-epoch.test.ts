import { encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, test } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, type FakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, makeMLSPeer, seedBuiltOperation } from './fixtures/peer.js'

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms))

const OFFSETS = [0, -1, 1]

function lie(crypto: FakeCrypto, offset: number): FakeCrypto {
  const actual = crypto.epoch
  crypto.epoch = () => actual() + offset
  return crypto
}

async function sealAt(epoch: number, topicID: string, text: string, intent: 'log' | 'ephemeral') {
  return await createFakeCrypto({ epoch, localDID: 'alice' }).wrap(
    encodeEventFrame('chat/posted', { text }),
    { aad: encodeAppAAD({ topicID, intent }) },
  )
}

describe('app delivery, anchors and sealing ignore the epoch hint', () => {
  test.each(OFFSETS)(
    'the drain delivers the current frame and keeps a future one (hint %i)',
    async (offset) => {
      const hub = new DurableFakeHub()
      const secret = new Uint8Array(32).fill(0xc1)
      const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
      for (const [epoch, text] of [
        [1, 'now'],
        [2, 'later'],
      ] as const) {
        await hub.publish({
          senderDID: 'alice',
          topicID,
          retain: 'log',
          payload: await sealAt(epoch, topicID, text, 'log'),
        })
      }
      const posted = hub.published.filter((m) => m.topicID === topicID)
      const seen: Array<unknown> = []
      const bob = makeMLSPeer(hub, 'bob', secret, {
        epoch: 1,
        crypto: lie(createFakeCrypto({ epoch: 1, localDID: 'bob' }), offset),
        handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
      })
      await flush(200)

      expect(bob.peer.anchorEpoch()).toBe(1)
      expect(seen).toEqual([{ text: 'now' }])
      expect(bob.appCursorStore.stored(topicID)).toBe(posted[0]?.sequenceID)
      await bob.peer.dispose()
    },
  )

  test.each(OFFSETS)(
    'a live push is done only once it opened or is past (hint %i)',
    async (offset) => {
      const hub = new DurableFakeHub()
      const secret = new Uint8Array(32).fill(0xc2)
      const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
      const seen: Array<unknown> = []
      const bob = makeMLSPeer(hub, 'bob', secret, {
        epoch: 1,
        crypto: lie(createFakeCrypto({ epoch: 1, localDID: 'bob' }), offset),
        handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
      })
      await flush(200)

      for (const [epoch, text] of [
        [1, 'now'],
        [2, 'later'],
      ] as const) {
        await hub.publish({
          senderDID: 'alice',
          topicID,
          retain: 'log',
          payload: await sealAt(epoch, topicID, text, 'log'),
        })
        await flush()
      }
      await flush(200)
      const posted = hub.published.filter((m) => m.topicID === topicID)

      expect(seen).toEqual([{ text: 'now' }])
      expect(bob.appCursorStore.stored(topicID)).toBe(posted[0]?.sequenceID)
      await bob.peer.dispose()
    },
  )

  test.each(OFFSETS)(
    'the journal records the epoch the bodies were sealed at (hint %i)',
    async (offset) => {
      const hub = new DurableFakeHub()
      const secret = new Uint8Array(32).fill(0xc4)
      const alice = makeMLSPeer(hub, 'alice', secret, {
        epoch: 1,
        crypto: lie(createFakeCrypto({ epoch: 1, localDID: 'alice' }), offset),
      })
      await flush()

      await alice.peer.enqueue(
        buildLedgerCommit(alice, ['token'], {
          onAdopt: async () => {
            throw new Error('the process died here')
          },
        }),
      )
      await expect
        .poll(async () => (await alice.control.load()).operations[0]?.stage)
        .toBe('accepted')

      expect((await alice.control.load()).operations[0]).toMatchObject({
        stage: 'accepted',
        built: { epoch: 1 },
      })
      await alice.peer.dispose()
    },
  )

  test.each(OFFSETS)(
    'a journalled commit at the handle epoch replays (hint %i)',
    async (offset) => {
      const hub = new DurableFakeHub()
      const secret = new Uint8Array(32).fill(0xc5)
      const first = makeMLSPeer(hub, 'alice', secret, { epoch: 1 })
      await flush()
      await first.peer.dispose()

      await seedBuiltOperation(first, buildLedgerCommit(first, ['token']))
      const second = makeMLSPeer(hub, 'alice', secret, {
        restartOf: first,
        crypto: lie(createFakeCrypto({ epoch: 1, localDID: 'alice' }), offset),
      })
      await flush(200)

      expect(hub.published.filter((m) => m.topicID === commitTopic(secret))).toHaveLength(1)
      expect(second.mls.epoch()).toBe(2)
      await second.peer.dispose()
    },
  )
})
