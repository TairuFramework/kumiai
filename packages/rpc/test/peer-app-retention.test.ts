import { toUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'
import { protocolTopic } from '../src/topic.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/**
 * A per-procedure `retain: 'log'` marker declared in the group protocol makes a logged event
 * pull-drainable — retained by the hub and readable back with `fetchTopic` — while ephemeral
 * events (the default) and all RPC stay on the live mailbox lane. Both classes may share one
 * topic: `fetchTopic` returns only the logged frames.
 */
const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
  'room/typing': { type: 'event', data: { type: 'object' } },
})

type Protocols = { room: typeof room }

function makePeer(hub: FakeHub, localDID: string, handlers: Record<string, unknown>) {
  const crypto = createFakeCrypto({ epoch: 1, localDID })
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    localDID,
    protocols: { room },
    handlers: { room: handlers } as never,
  })
  return { peer, crypto }
}

describe('per-procedure retention for app events', () => {
  test('a logged event is delivered live and is pull-drainable; an ephemeral event is live only', async () => {
    const hub = new FakeHub()
    const postedSeen: Array<unknown> = []
    const typingSeen: Array<unknown> = []

    const alice = makePeer(hub, 'alice', {})
    const bob = makePeer(hub, 'bob', {
      'room/posted': (ctx: { data: unknown }) => void postedSeen.push(ctx.data),
      'room/typing': (ctx: { data: unknown }) => void typingSeen.push(ctx.data),
    })
    await flush()

    // Both procedures share the one `room` topic. The logged one is dispatched to the log lane,
    // the ephemeral one to the live mailbox lane.
    await alice.peer.protocol('room').dispatch('room/posted', { text: 'kept' })
    await alice.peer.protocol('room').dispatch('room/typing', { text: 'gone' })
    await flush()

    // Both reach the online subscriber's handler live — the logged event is not diverted off the
    // live path by being retained.
    expect(postedSeen).toEqual([{ text: 'kept' }])
    expect(typingSeen).toEqual([{ text: 'gone' }])

    // Only the logged event is retained: draining the topic returns it and nothing else, decoded
    // to its plaintext — proving pull-ability independently of the live delivery above.
    const secret = await alice.crypto.exportSecret()
    const topicID = protocolTopic(secret, 1, 'room')
    const drained = await hub.fetchTopic({ subscriberDID: 'bob', topicID })
    expect(drained.messages).toHaveLength(1)

    // Opened by a member of the group that has NOT already read this frame, and not by bob's own
    // crypto: opening is a consuming operation on the real port (a ratchet generation is spent),
    // and bob's peer opened this frame on the live lane above. The claim under test is that the
    // frame is RETAINED and openable at this epoch, which is exactly what a fresh reader shows.
    const reader = createFakeCrypto({ epoch: 1, localDID: 'carol' })
    const opened = await reader.unwrap(drained.messages[0].payload)
    const bytes = opened instanceof Uint8Array ? opened : opened.payload
    expect(JSON.parse(toUTF(bytes))).toEqual({
      payload: { typ: 'event', prc: 'room/posted', data: { text: 'kept' } },
    })

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('retain:log on a request procedure is rejected at the type level and at runtime', () => {
    expect(() =>
      defineGroupProtocol({
        'room/ask': {
          type: 'request',
          // @ts-expect-error only 'event' procedures may declare retain; request is always ephemeral
          retain: 'log',
          param: { type: 'object' },
          result: { type: 'object' },
        },
      }),
    ).toThrow(/retain/)
  })
})
