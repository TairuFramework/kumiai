import type { HubFetchTopicParams, HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { fakeEpochSecret } from './fixtures/fake-crypto.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 50))

/**
 * The app lane has TWO deliverers and ONE durable read position. These are about the position, not
 * about either deliverer: what the live lane hands over must move the cursor, and what the drain
 * re-reads must not be handed over twice.
 *
 * `chat/posted` throughout, because only a `retain: 'log'` frame has a place in a log to hold a
 * position in. The plaintext is the assertion in both — a peer that loses or doubles these messages
 * still converges, still matches the roster, still reaches the right epoch, and raises nothing.
 */
describe('the live lane and the drain share one read position', () => {
  /**
   * A frame published while this peer is INSIDE its commit walk.
   *
   * The walk reads the segment's log and then dispenses it epoch by epoch as it ratchets. A frame
   * that reaches the log after that read — the whole of a group's traffic, for as long as a walk
   * takes — is invisible to it, and the peer is offline so no push brings it either. Dropped in the
   * one place built to stop drops.
   *
   * The publish is hung off Bob's OWN first pull of the app topic, so it lands strictly after the
   * read and strictly before the walk ends. A timer would race the walk and pass by luck.
   */
  test('a frame published while this peer is mid-walk is delivered, exactly once', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x51)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    await flush()

    // No roster change anywhere here, so the anchor never moves and there is one app topic for the
    // whole run: what separates the delivered frame from the missed one is WHEN it was published,
    // never which segment it landed on.
    const appTopic = protocolTopic(fakeEpochSecret(1), 1, 'chat')

    for (let index = 0; index < 4; index++) {
      await alice.peer.commit(buildLedgerCommit(alice, []))
    }
    await flush()
    expect(alice.mls.epoch()).toBe(5)

    // Bob's first pull of the app topic is the read the walk then works from. Alice publishes the
    // instant it returns: after the buffer is filled, and with four commits still to walk.
    const realFetchTopic = hub.fetchTopic.bind(hub)
    let bobAppPulls = 0
    ;(hub as { fetchTopic: (p: HubFetchTopicParams) => Promise<HubFetchTopicResult> }).fetchTopic =
      async (params) => {
        const result = await realFetchTopic(params)
        if (params.subscriberDID === 'bob' && params.topicID === appTopic) {
          bobAppPulls += 1
          if (bobAppPulls === 1) {
            await alice.peer
              .protocol('chat')
              .dispatch('chat/posted', { text: 'published mid-walk' })
          }
        }
        return result
      }

    // Bob comes up at epoch 1 and walks to 5. He is not subscribed when Alice publishes above, and
    // the hub pushes nothing to a member it has never had a live channel for, so the pull is the
    // only thing that can deliver this.
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()
    await flush()

    expect(bob.mls.epoch()).toBe(5)
    // Alice was at epoch 5 when she sealed it, and Bob's walk ends there holding that epoch's key.
    expect(seen).toEqual([{ text: 'published mid-walk' }])

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  /**
   * A frame the LIVE lane delivered, and the same process coming back up.
   *
   * The live path hands a retained frame to the host straight off the bus. If that hands the cursor
   * nothing, the cursor sits behind every frame an online member has already read, and the pull on
   * restart reads the whole lot back — the host is told a second time about messages it showed the
   * user before the restart. Bob restarts over the same cursor store, having walked no commit and
   * having nothing else to prompt a drain: the position must have been written by the live delivery
   * itself or it was never written at all.
   */
  test('a restart does not re-deliver what the live lane already delivered', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x52)
    const seen: Array<unknown> = []
    const handlers = { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) }

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { epoch: 1 })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { epoch: 1, handlers })
    await flush()

    await alice.peer.protocol('chat').dispatch('chat/posted', { text: 'read live' })
    await flush()

    // The live lane delivered it, and nothing else could have: no commit has been walked, so no
    // drain has run at all.
    expect(seen).toEqual([{ text: 'read live' }])
    expect(bob.mls.epoch()).toBe(1)

    // The process dies and comes back over the same handle, journal, anchor and cursor store — a
    // restart, not a new member.
    await bob.peer.dispose()
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, { restartOf: bob, handlers })
    await flush()
    await flush()

    expect(restarted.mls.epoch()).toBe(1)
    expect(seen).toEqual([{ text: 'read live' }])

    await alice.peer.dispose()
    await restarted.peer.dispose()
  })
})
