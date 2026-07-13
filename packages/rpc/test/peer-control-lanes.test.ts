import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { createMemoryGroupMLS } from '../src/memory-group-mls.js'
import { createGroupPeer } from '../src/peer.js'
import { commitTopic, protocolTopic, rendezvousTopic } from '../src/topic.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

/** Build an MLS-enabled peer whose fake MLS keeps the fake crypto's epoch in step. */
function makeMLSPeer(hub: FakeHub, localDID: string, recoverySecret: Uint8Array) {
  const crypto = createFakeCrypto({ epoch: 1, localDID })
  const mls = createMemoryGroupMLS({
    recoverySecret,
    epoch: 1,
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

/** Append a Commit to the group's commit log, the way a committing member does. */
function publishCommit(
  hub: FakeHub,
  senderDID: string,
  recoverySecret: Uint8Array,
  commit: Uint8Array,
): Promise<{ sequenceID: string }> {
  return hub.publish({
    senderDID,
    topicID: commitTopic(recoverySecret),
    payload: encodeHandshakeFrame(HANDSHAKE_KIND.commit, commit),
    retain: 'log',
  })
}

describe('control lane lifecycle', () => {
  test('commit and rendezvous are subscribed once at init, survive resync, drop on dispose', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x33)
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const mls = createMemoryGroupMLS({ recoverySecret })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      mls,
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    await flush()

    const commits = commitTopic(recoverySecret)
    const rendezvous = rendezvousTopic(recoverySecret)
    expect(commits).not.toBe(rendezvous)
    const secret = await crypto.exportSecret()
    expect(hub.subscriberCount(commits)).toBe(1)
    expect(hub.subscriberCount(rendezvous)).toBe(1)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(1)

    // Advance the epoch and resync: app topics rotate, both control topics persist.
    crypto.setEpoch(2)
    await peer.resync()
    await flush()

    expect(hub.subscriberCount(commits)).toBe(1)
    expect(hub.subscriberCount(rendezvous)).toBe(1)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(0)
    expect(hub.subscriberCount(protocolTopic(secret, 2, 'chat'))).toBe(1)

    await peer.dispose()
    await flush()
    expect(hub.subscriberCount(commits)).toBe(0)
    expect(hub.subscriberCount(rendezvous)).toBe(0)
  })

  test('the commit topic is subscribed with the log retention window', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x34)
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const mls = createMemoryGroupMLS({ recoverySecret })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      mls,
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
      commitLogRetentionSeconds: 1234,
    })
    await flush()

    expect(hub.requestedRetention(commitTopic(recoverySecret))).toBe(1234)
    // The rendezvous lane is a mailbox: it takes the hub's default window.
    expect(hub.requestedRetention(rendezvousTopic(recoverySecret))).toBeUndefined()

    await peer.dispose()
  })

  test('no control subscriptions when mls is omitted', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x33)
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    await flush()

    expect(hub.subscriberCount(commitTopic(recoverySecret))).toBe(0)
    expect(hub.subscriberCount(rendezvousTopic(recoverySecret))).toBe(0)
    await peer.dispose()
  })

  test('a Commit advances and resyncs every receiver', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x44)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    const carol = makeMLSPeer(hub, 'carol', recoverySecret)
    await flush()

    const secret = await bob.crypto.exportSecret()
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(2)

    await publishCommit(hub, 'alice', recoverySecret, new Uint8Array([1]))
    await flush()

    expect(bob.mls.epoch()).toBe(2)
    expect(carol.mls.epoch()).toBe(2)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(0)
    expect(hub.subscriberCount(protocolTopic(secret, 2, 'chat'))).toBe(2)

    await bob.peer.dispose()
    await carol.peer.dispose()
  })

  test('a no-op Commit does not resync', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x44)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await flush()

    const secret = await bob.crypto.exportSecret()
    await publishCommit(hub, 'alice', recoverySecret, new Uint8Array())
    await flush()

    expect(bob.mls.epoch()).toBe(1)
    expect(bob.mls.commits()).toBe(0)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(1)

    await bob.peer.dispose()
  })

  test('localCommitted appends to the log and resyncs the sender', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x55)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await flush()

    const secret = await alice.crypto.exportSecret()
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(2)

    // Alice produced a Commit and already applied it locally: advance her epoch.
    alice.crypto.setEpoch(2)
    await alice.peer.localCommitted(new Uint8Array([7]))
    await flush()

    // Bob pulled the Commit, advanced, and resynced; Alice rebuilt to epoch 2.
    expect(bob.mls.epoch()).toBe(2)
    expect(hub.subscriberCount(protocolTopic(secret, 1, 'chat'))).toBe(0)
    expect(hub.subscriberCount(protocolTopic(secret, 2, 'chat'))).toBe(2)
    // It went to the log, not the mailbox: it moved the topic's head, so it is still
    // there for a member invited tomorrow.
    const committed = hub.published.filter((m) => m.topicID === commitTopic(recoverySecret))
    expect(committed).toHaveLength(1)
    expect(hub.head(commitTopic(recoverySecret))).toBe(committed[0].sequenceID)

    await alice.peer.dispose()
    await bob.peer.dispose()
  })

  test('localCommitted is a no-op without an MLS port', async () => {
    const hub = new FakeHub()
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const peer = createGroupPeer<Protocols>({
      hub,
      crypto,
      localDID: 'alice',
      protocols: { chat },
      handlers: { chat: {} } as never,
    })
    await flush()
    await expect(peer.localCommitted(new Uint8Array([1]))).resolves.toBeUndefined()
    await peer.dispose()
  })
})
