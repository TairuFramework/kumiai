import { encodeEventFrame } from '@kumiai/broadcast'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { APP_TOPIC_LABEL, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * The retained drain binds `expectedAAD` to the DURABLE CURSOR's own topic, the one authority a
 * returning member has for "what lane am I reading". Two ways a frame's carried AAD can fail that
 * bind: it names a DIFFERENT topic (sealed for another lane, replayed or misrouted onto this one),
 * or it names NONE at all (sealed before this binding existed). Both are dead, not delivered — and
 * dead is done, so the cursor must still pass over them rather than jam behind either forever.
 */
describe('the retained drain binds expectedAAD to the cursor topic', () => {
  test('a frame sealed for one topic does not open on another lane', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x99)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
    // The topic a DIFFERENT protocol running in the same segment would derive. The forged frame
    // below is sealed as though bound for that lane, then placed on bob's actual `chat` lane.
    const otherTopicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'other-protocol')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'genuine' })

    // A DIFFERENT sender DID than alice's, so this forged frame's ratchet generation cannot
    // collide with any of alice's own on bob's receiving side.
    const forged = createFakeCrypto({ epoch: 1, localDID: 'mallory' })
    await hub.publish({
      senderDID: 'mallory',
      topicID,
      retain: 'log',
      payload: await forged.wrap(encodeEventFrame('chat/posted', { text: 'wrong topic' }), {
        aad: fromUTF(otherTopicID),
      }),
    })
    await flush()

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    // Dropped, not delivered: only the genuine frame reached the host's handler.
    expect(seen).toEqual([{ text: 'genuine' }])

    // Dead is done: the cursor advanced past BOTH frames, not just the genuine one — a
    // wrong-topic frame must not jam the read position behind it forever.
    const frames = hub.published.filter((m) => m.topicID === topicID)
    expect(frames).toHaveLength(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(frames[1]?.sequenceID)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })

  test('a pre-upgrade empty-AAD retained frame is rejected and the cursor advances (invalidation)', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x9a)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await bob.peer.dispose()
    hub.detach('bob')

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'genuine' })

    // A pre-upgrade frame: sealed with NO AAD at all, as every retained frame was before this
    // binding existed. `wrap` with no `opts` carries an empty AAD, exactly that legacy shape.
    const legacy = createFakeCrypto({ epoch: 1, localDID: 'mallory' })
    await hub.publish({
      senderDID: 'mallory',
      topicID,
      retain: 'log',
      payload: await legacy.wrap(encodeEventFrame('chat/posted', { text: 'legacy, unbound' })),
    })
    await flush()

    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    hub.reattach('bob')
    await flush()

    // Rejected: the empty AAD never matches the cursor's real topic, so it is not delivered.
    expect(seen).toEqual([{ text: 'genuine' }])

    // And INVALIDATED, deliberately: the cursor advances past it rather than treating it as a
    // claim still worth holding a place for — retained history from before the AAD bind is
    // unrecoverable by design, not silently re-offered forever.
    const frames = hub.published.filter((m) => m.topicID === topicID)
    expect(frames).toHaveLength(2)
    expect(bob.appCursorStore.stored(topicID)).toBe(frames[1]?.sequenceID)

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
