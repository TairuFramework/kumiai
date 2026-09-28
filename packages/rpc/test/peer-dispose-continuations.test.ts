import { BroadcastClient, encodeEventFrame } from '@kumiai/broadcast'
import { describe, expect, test, vi } from 'vitest'

import { encodeAppAAD } from '../src/app-aad.js'
import type { PendingAppFrame } from '../src/crypto.js'
import { PeerDisposedError } from '../src/index.js'
import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

describe('work resumed after disposal', () => {
  test('a blocked rebuild does not register a new epoch after disposal returns', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb1)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, {
      members: ['alice', 'bob', 'carol'],
    })
    await bob.peer.replay()

    const originalDispose = BroadcastClient.prototype.dispose
    let releaseTeardown = (): void => {}
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })
    let teardownStarted = false
    let teardownFinished = false
    const clientDispose = vi
      .spyOn(BroadcastClient.prototype, 'dispose')
      .mockImplementation(function (
        this: BroadcastClient,
        ...args: Parameters<typeof originalDispose>
      ) {
        const result = originalDispose.apply(this, args)
        if (teardownStarted) return result
        teardownStarted = true
        return teardownGate
          .then(() => result)
          .then(() => {
            teardownFinished = true
          })
      })
    const subscribes = vi.spyOn(hub, 'subscribe')
    try {
      await publishCommit({
        hub,
        senderDID: 'alice',
        recoverySecret,
        epoch: 1,
        removes: ['carol'],
      })
      await vi.waitFor(() => expect(teardownStarted).toBe(true))
      expect(bob.mls.epoch()).toBe(2)
      expect(bob.peer.anchorEpoch()).toBe(2)

      await bob.peer.dispose()
      const subscribesAtDisposal = subscribes.mock.calls.length
      releaseTeardown()
      await vi.waitFor(() => expect(teardownFinished).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(subscribes).toHaveBeenCalledTimes(subscribesAtDisposal)
    } finally {
      releaseTeardown()
      clientDispose.mockRestore()
      await bob.peer.dispose()
    }
  })

  test('journal replay paused in an epoch read does not adopt after disposal returns', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb2)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret)
    await bob.peer.replay()

    const commit = bob.mls.buildCommit([])
    await bob.journal.put({
      publishID: 'accepted-before-restart',
      expectedHead: null,
      epoch: 1,
      acceptedAs: '000000000001',
      commit,
      bodies: [],
      kind: 'ledger',
      journal: commit,
    })
    const readEpoch = bob.mls.readEpoch.bind(bob.mls)
    let releaseRead = (): void => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let readResumed = false
    const epochRead = vi.spyOn(bob.mls, 'readEpoch').mockImplementationOnce(async () => {
      await readGate
      readResumed = true
      return readEpoch()
    })
    try {
      const replay = bob.peer.replay()
      await vi.waitFor(() => expect(epochRead).toHaveBeenCalled())
      await bob.peer.dispose()
      releaseRead()
      await expect(replay).rejects.toBeInstanceOf(PeerDisposedError)
      expect(readResumed).toBe(true)
      expect(bob.mls.epoch()).toBe(1)
      expect(bob.journal.slot()?.acceptedAs).toBe('000000000001')
      expect(
        hub.published.filter((message) => message.topicID === commitTopic(recoverySecret)),
      ).toEqual([])
    } finally {
      releaseRead()
      await bob.peer.dispose()
    }
  })

  test('a commit build resuming after disposal does not write a journal slot', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb3)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await alice.peer.replay()
    let releaseBuild = (): void => {}
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })
    let building = false
    try {
      const build = buildLedgerCommit(alice, ['late=commit'])
      const committing = alice.peer.commit(async () => {
        building = true
        await buildGate
        return build()
      })
      await vi.waitFor(() => expect(building).toBe(true))
      await alice.peer.dispose()
      releaseBuild()
      await expect(committing).rejects.toBeInstanceOf(PeerDisposedError)
      expect(alice.journal.slot()).toBeNull()
      expect(
        hub.published.filter((message) => message.topicID === commitTopic(recoverySecret)),
      ).toEqual([])
    } finally {
      releaseBuild()
      await alice.peer.dispose()
    }
  })

  test('a commit waiting for ledger completeness reports disposal', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb7)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await alice.peer.replay()
    const isLedgerComplete = alice.mls.isLedgerComplete.bind(alice.mls)
    let releaseCheck = (): void => {}
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    let checking = false
    vi.spyOn(alice.mls, 'isLedgerComplete').mockImplementationOnce(async () => {
      checking = true
      await checkGate
      return isLedgerComplete()
    })
    try {
      const committing = alice.peer.commit(buildLedgerCommit(alice, ['late=ledger']))
      await vi.waitFor(() => expect(checking).toBe(true))
      await alice.peer.dispose()
      releaseCheck()
      await expect(committing).rejects.toBeInstanceOf(PeerDisposedError)
      expect(alice.journal.slot()).toBeNull()
    } finally {
      releaseCheck()
      await alice.peer.dispose()
    }
  })

  test('a commit publish resolving after disposal leaves acceptance for replay', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb4)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await alice.peer.replay()
    const publish = hub.publish.bind(hub)
    let releasePublish = (): void => {}
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    let publishing = false
    const hubPublish = vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      publishing = true
      await publishGate
      return publish(params)
    })
    try {
      const committing = alice.peer.commit(buildLedgerCommit(alice, ['late=acceptance']))
      await vi.waitFor(() => expect(publishing).toBe(true))
      await alice.peer.dispose()
      releasePublish()
      await expect(committing).rejects.toBeInstanceOf(PeerDisposedError)
      expect(alice.journal.slot()?.acceptedAs).toBeUndefined()
      expect(alice.mls.epoch()).toBe(1)
      expect(hubPublish).toHaveBeenCalledTimes(1)
    } finally {
      releasePublish()
      await alice.peer.dispose()
    }
  })

  test('an accepted commit paused in a roster read does not adopt after disposal', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb5)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await alice.peer.replay()
    const rosterEntries = alice.mls.rosterEntries.bind(alice.mls)
    let releaseRead = (): void => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let readStarted = false
    vi.spyOn(alice.mls, 'rosterEntries').mockImplementationOnce(async () => {
      readStarted = true
      await readGate
      return rosterEntries()
    })
    try {
      const committing = alice.peer.commit(buildLedgerCommit(alice, ['late=adoption']))
      await vi.waitFor(() => expect(readStarted).toBe(true))
      await alice.peer.dispose()
      releaseRead()
      await expect(committing).rejects.toBeInstanceOf(PeerDisposedError)
      expect(alice.mls.epoch()).toBe(1)
      expect(alice.journal.slot()?.acceptedAs).toBeDefined()
    } finally {
      releaseRead()
      await alice.peer.dispose()
    }
  })

  test('a queued drop does not enter app delivery after disposal', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb6)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await alice.peer.replay()
    let releaseBuild = (): void => {}
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })
    let building = false
    try {
      const build = buildLedgerCommit(alice, [])
      const committing = alice.peer.commit(async () => {
        building = true
        await buildGate
        return build()
      })
      await vi.waitFor(() => expect(building).toBe(true))
      const dropping = alice.peer.dropAppFrame('unknown-topic', '000000000001')
      await new Promise((resolve) => setTimeout(resolve, 0))
      await alice.peer.dispose()
      releaseBuild()
      await expect(committing).rejects.toBeInstanceOf(PeerDisposedError)
      await expect(dropping).rejects.toBeInstanceOf(PeerDisposedError)
    } finally {
      releaseBuild()
      await alice.peer.dispose()
    }
  })

  test('a drop waiting for ledger completeness reports disposal', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb8)
    const topicID = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
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
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { crypto })
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
    const notices = vi.fn()
    const restarted = makeMLSPeer(hub, 'bob', recoverySecret, {
      restartOf: bob,
      onAppDeliveryStalled: notices,
    })
    await restarted.peer.protocol('chat').to('alice')
    await restarted.peer.replay()
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ position: blocked.sequenceID, reason: 'future-epoch' }),
    )
    const isLedgerComplete = restarted.mls.isLedgerComplete.bind(restarted.mls)
    let releaseCheck = (): void => {}
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    let checking = false
    vi.spyOn(restarted.mls, 'isLedgerComplete').mockImplementationOnce(async () => {
      checking = true
      await checkGate
      return isLedgerComplete()
    })
    try {
      const dropping = restarted.peer.dropAppFrame(topicID, blocked.sequenceID)
      const rejection = expect(dropping).rejects.toBeInstanceOf(PeerDisposedError)
      await vi.waitFor(() => expect(checking).toBe(true))
      await restarted.peer.dispose()
      releaseCheck()
      await rejection
    } finally {
      releaseCheck()
      await restarted.peer.dispose()
    }
  })

  test('a resync waiting for epoch teardown reports disposal', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xb9)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await alice.peer.replay()
    const originalDispose = BroadcastClient.prototype.dispose
    let releaseTeardown = (): void => {}
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })
    let tearingDown = false
    const clientDispose = vi
      .spyOn(BroadcastClient.prototype, 'dispose')
      .mockImplementation(function (
        this: BroadcastClient,
        ...args: Parameters<typeof originalDispose>
      ) {
        const result = originalDispose.apply(this, args)
        if (tearingDown) return result
        tearingDown = true
        return teardownGate.then(() => result)
      })
    try {
      const resyncing = alice.peer.resync()
      await vi.waitFor(() => expect(tearingDown).toBe(true))
      await alice.peer.dispose()
      releaseTeardown()
      await expect(resyncing).rejects.toBeInstanceOf(PeerDisposedError)
    } finally {
      releaseTeardown()
      clientDispose.mockRestore()
      await alice.peer.dispose()
    }
  })
})
