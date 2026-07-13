import type { ProtocolDefinition } from '@enkaku/protocol'
import type { LogHub, MailboxHub } from '@kumiai/hub-tunnel'
import { describe, expect, test } from 'vitest'

import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { createMemoryGroupMLS } from '../src/memory-group-mls.js'
import { createGroupPeer } from '../src/peer.js'
import { commitTopic, protocolTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

/** A peer that joined the group at `epoch` — from a Welcome, say. */
function makeMLSPeer(hub: LogHub, localDID: string, recoverySecret: Uint8Array, epoch = 1) {
  const crypto = createFakeCrypto({ epoch, localDID })
  const mls = createMemoryGroupMLS({
    recoverySecret,
    epoch,
    onAdvance: (e) => crypto.setEpoch(e),
  })
  const peer = createGroupPeer<Protocols>({
    hub,
    crypto,
    mls,
    localDID,
    protocols: { chat },
    handlers: { chat: {} } as never,
  })
  return { peer, crypto, mls }
}

/** Every recovery request this peer group put on the wire. */
function recoveryRequests(hub: FakeHub, recoverySecret: Uint8Array): Array<unknown> {
  const topic = rendezvousTopic(recoverySecret)
  return hub.published.filter((m) => {
    if (m.topicID !== topic) return false
    try {
      return decodeHandshakeFrame(m.payload).kind === HANDSHAKE_KIND.recoveryRequest
    } catch {
      return false
    }
  })
}

describe('the commit lane is pull-driven', () => {
  test('a member that subscribes after commits have landed converges by pulling them', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x11)

    // Dave is invited at epoch 1 — his Welcome names that epoch — but the group commits
    // twice more before he gets as far as subscribing. Nothing will ever push those two
    // frames at him: he was not a subscriber when they were published.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 2 })

    const dave = makeMLSPeer(hub, 'dave', recoverySecret, 1)
    await flush()

    // He reaches the group's epoch, by reading the log.
    expect(dave.mls.epoch()).toBe(3)
    expect(dave.mls.commits()).toBe(2)

    // And his app lane was rebuilt at the epoch he reached, not the one he joined at.
    const secret = await dave.crypto.exportSecret()
    expect(hub.subscriberCount(protocolTopic(secret, 3, 'chat'))).toBe(1)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(0)

    // He needed no help from another member: he asked for no recovery. (Walking frames
    // from epochs he never held is ordinary catch-up, not evidence of a fork.)
    expect(recoveryRequests(hub, recoverySecret)).toHaveLength(0)

    await dave.peer.dispose()
  })

  test('a peer that has processed nothing seeds from the log, not from the head', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x12)
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    const { sequenceID } = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret,
      epoch: 2,
    })

    // The head is right there in the topic, and it names a commit the joiner has never
    // applied. A cursor seeded from it would skip both frames and strand him.
    expect(hub.head(commitTopic(recoverySecret))).toBe(sequenceID)

    const dave = makeMLSPeer(hub, 'dave', recoverySecret, 1)
    await flush()
    expect(dave.mls.commits()).toBe(2)

    await dave.peer.dispose()
  })

  test('two peers online: one commit, one apply each', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x13)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    const carol = makeMLSPeer(hub, 'carol', recoverySecret)
    await flush()

    // An accepted log frame is pushed AND retained. Both online peers see it twice —
    // once as a delivery, once in the log — and must apply it exactly once: the push is
    // a wakeup, and the frames come from the pull.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await flush()

    expect(bob.mls.commits()).toBe(1)
    expect(bob.mls.epoch()).toBe(2)
    expect(carol.mls.commits()).toBe(1)
    expect(carol.mls.epoch()).toBe(2)

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a committer does not apply its own commit again when it reads the log back', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x14)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await flush()

    // Alice produced this Commit and adopts it as the hub takes it. The log hands her back
    // her own frame — push never did, because the hub excludes the sender.
    const own = alice.mls.buildCommit()
    await alice.peer.localCommitted(own, { adopt: () => alice.mls.adopt(own) })
    await flush()
    expect(alice.mls.commits()).toBe(0)

    // Another member commits next, waking alice. Her cursor walks over her own frame on
    // the way, so she applies theirs and only theirs, and never re-applies hers.
    await publishCommit({ hub, senderDID: 'zoe', recoverySecret, epoch: 2 })
    await flush()

    expect(alice.mls.commits()).toBe(1)
    expect(bob.mls.commits()).toBe(2)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('a frame the peer cannot use is dropped, and the cursor steps over it', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x15)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await flush()

    // Garbage, and a frame from another lane, both on the commit topic. Neither is a
    // commit; both are stepped over rather than wedging the lane behind them.
    await hub.publish({
      senderDID: 'mallory',
      topicID: commitTopic(recoverySecret),
      payload: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      retain: 'log',
    })
    await hub.publish({
      senderDID: 'mallory',
      topicID: commitTopic(recoverySecret),
      payload: encodeHandshakeFrame(HANDSHAKE_KIND.recoveryRequest, new Uint8Array([1])),
      retain: 'log',
    })
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await flush()

    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.commits()).toBe(1)

    await bob.peer.dispose()
  })

  test('a hub with no log cannot be wired into a peer at all', () => {
    const hub = new FakeHub()
    // Push-delivery only: nothing here can be read back by a peer that was not subscribed
    // when a commit was published. That is not a condition to check for at run time — it
    // is a hub this lane cannot be built on, and the type says so at the host's wiring.
    const mailboxOnly: MailboxHub = {
      publish: (params) => hub.publish(params),
      subscribe: (did, topicID) => hub.subscribe(did, topicID),
      unsubscribe: (did, topicID) => hub.unsubscribe(did, topicID),
      receive: (did) => hub.receive(did),
    }
    // Never invoked: the assertion IS the compile error, checked by `test:types`. If a
    // MailboxHub ever became assignable here, @ts-expect-error would fail the build.
    const wire = (): void => {
      createGroupPeer<Protocols>({
        // @ts-expect-error a MailboxHub is not a LogHub: the commit lane reads a log
        hub: mailboxOnly,
        crypto: createFakeCrypto({ epoch: 1, localDID: 'bob' }),
        localDID: 'bob',
        protocols: { chat },
        handlers: { chat: {} } as never,
      })
    }
    expect(wire).toBeTypeOf('function')
  })
})
