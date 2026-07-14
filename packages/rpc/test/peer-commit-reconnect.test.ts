import type { ProtocolDefinition } from '@enkaku/protocol'
import { describe, expect, test } from 'vitest'

import { createMemoryGroupMLS } from '../src/memory-group-mls.js'
import { createGroupPeer } from '../src/peer.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { adoptJournalledBlob } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { chat: typeof chat }

function makeDurablePeer(hub: DurableFakeHub, localDID: string, recoverySecret: Uint8Array) {
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
    journal: createMemoryCommitJournal(),
    adoptJournalled: async (blob) => {
      adoptJournalledBlob(mls, blob)
    },
    localDID,
    protocols: { chat },
    handlers: { chat: {} } as never,
  })
  return { peer, crypto, mls }
}

describe('the commit lane across a disconnect', () => {
  test('a redelivered commit is not applied twice; a missed one is caught up by the pull', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x66)
    const bob = makeDurablePeer(hub, 'bob', recoverySecret)
    await flush()

    // Online: a Commit is delivered, and applied once.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await flush()
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.commits()).toBe(1)

    // Redelivery is just another wakeup. The cursor is already past that frame, so the
    // pull returns nothing and the Commit is not applied a second time — even when the
    // hub pushes it again. Redelivery has stopped mattering for commits.
    hub.redeliver('bob')
    await flush()
    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.commits()).toBe(1)

    // Offline: a Commit lands while bob is detached, so no push reaches him.
    hub.detach('bob')
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 2 })
    await flush()
    expect(bob.mls.epoch()).toBe(2)

    // Back online: the next wakeup makes him pull, and he takes the missed frame from
    // the log rather than from the delivery it happens to arrive on.
    hub.reattach('bob')
    hub.redeliver('bob')
    await flush()
    expect(bob.mls.epoch()).toBe(3)
    expect(bob.mls.commits()).toBe(2)

    await bob.peer.dispose()
  })
})
