import type { LogHub } from '@kumiai/hub-tunnel'
import { describe, expect, test, vi } from 'vitest'

import { APP_TOPIC_LABEL, commitTopic, protocolTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

describe('commit delivery during initialization', () => {
  test('catches up when a commit arrives during epoch construction, then disposes', async () => {
    const recoverySecret = new Uint8Array(32).fill(0xa1)
    const entry = 'role:delivery-during-init=member'
    const source = new FakeHub()
    await publishCommit({
      hub: source,
      senderDID: 'alice',
      recoverySecret,
      epoch: 1,
      entries: [entry],
    })
    const commit = source.published[0]
    if (commit == null) throw new Error('missing prepared commit')

    const fake = new FakeHub()
    const appTopic = protocolTopic(fakeEpochSecret(1, APP_TOPIC_LABEL), 1, 'chat')
    let delivered = false
    const hub: LogHub = {
      subscribe: (did, topicID, options) => {
        fake.subscribe(did, topicID, options)
        if (topicID === appTopic && !delivered) {
          delivered = true
          void fake.publish({
            senderDID: commit.senderDID,
            topicID: commit.topicID,
            payload: commit.payload,
            retain: 'log',
          })
        }
      },
      unsubscribe: (did, topicID) => fake.unsubscribe(did, topicID),
      publish: (params) => fake.publish(params),
      fetchTopic: (params) => fake.fetchTopic(params),
      receive: (did) => fake.receive(did),
    }

    const crypto = createFakeCrypto({
      epoch: 1,
      localDID: 'bob',
      pending: {
        persistOpened: async () => {},
        list: async () => [],
        complete: async () => {},
      },
    })
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { crypto, epoch: 1 })
    await vi.waitFor(() => expect(delivered).toBe(true), { timeout: 300 })
    await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2), { timeout: 300 })
    expect(await bob.mls.getLedger()).toContain(entry)
    await expect(
      Promise.race([
        bob.peer.dispose(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('dispose timed out')), 300),
        ),
      ]),
    ).resolves.toBeUndefined()
  })

  test('dispose completes while anchor loading blocks initialization', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa2)
    const anchorStore = createMemoryAnchorStore()
    const load = anchorStore.load.bind(anchorStore)
    let releaseLoad = (): void => {}
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    vi.spyOn(anchorStore, 'load').mockImplementation(async () => {
      await loadGate
      return load()
    })

    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { anchorStore })
    try {
      await expect(
        Promise.race([
          alice.peer.dispose(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('dispose timed out')), 300),
          ),
        ]),
      ).resolves.toBeUndefined()
    } finally {
      releaseLoad()
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hub.subscriberCount(commitTopic(recoverySecret))).toBe(0)
  })

  test('dispose waits for a host bootstrap started during initialization', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa3)
    const members = ['alice', 'bob']
    const recovery = { timeoutMs: 1000, getDelayMs: () => 0, deadlineMs: 2000 }
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members, recovery })
    await bob.peer.replay()

    const mls = createMemoryGroupMLS({
      recoverySecret,
      epoch: 1,
      localDID: 'alice',
      members,
    })
    vi.spyOn(mls, 'isLedgerComplete').mockResolvedValue(false)
    let releaseBootstrap = (): void => {}
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve
    })
    const hostBootstrap = mls.bootstrapLedger.bind(mls)
    const bootstrap = vi.spyOn(mls, 'bootstrapLedger').mockImplementation(async (tokens) => {
      await bootstrapGate
      await hostBootstrap(tokens)
    })
    const alice = makeMLSPeer(hub, 'alice', recoverySecret, { mls, members, recovery })
    let disposalSettled = false
    try {
      await vi.waitFor(() => expect(bootstrap).toHaveBeenCalled(), { timeout: 1000 })
      const fetches = vi.spyOn(hub, 'fetchTopic')
      const applies = vi.spyOn(mls, 'processCommit')
      const epochReads = vi.spyOn(mls, 'readEpoch')
      const disposal = alice.peer.dispose().then(() => {
        disposalSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(disposalSettled).toBe(false)
      const fetchesBeforeRelease = fetches.mock.calls.length
      const appliesBeforeRelease = applies.mock.calls.length
      const epochReadsBeforeRelease = epochReads.mock.calls.length
      releaseBootstrap()
      await expect(
        Promise.race([
          disposal,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('dispose timed out after bootstrap')), 300),
          ),
        ]),
      ).resolves.toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetches).toHaveBeenCalledTimes(fetchesBeforeRelease)
      expect(applies).toHaveBeenCalledTimes(appliesBeforeRelease)
      expect(epochReads).toHaveBeenCalledTimes(epochReadsBeforeRelease)
    } finally {
      releaseBootstrap()
      await alice.peer.dispose()
      await bob.peer.dispose()
    }
  })

  test('a seed lane blocked on journal replay stops after disposal returns', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa4)
    const mls = createMemoryGroupMLS({ recoverySecret, epoch: 1, localDID: 'bob' })
    const journal = createMemoryCommitJournal()
    let releaseRead = (): void => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let readResumed = false
    const getJournal = journal.get.bind(journal)
    const journalRead = vi.spyOn(journal, 'get').mockImplementation(async () => {
      await readGate
      readResumed = true
      return getJournal()
    })
    const checkLedger = vi.spyOn(mls, 'isLedgerComplete')
    const fetches = vi.spyOn(hub, 'fetchTopic')
    const epochReads = vi.spyOn(mls, 'readEpoch')
    const applies = vi.spyOn(mls, 'processCommit')
    const bootstraps = vi.spyOn(mls, 'bootstrapLedger')
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { mls, journal })
    try {
      await vi.waitFor(() => expect(journalRead).toHaveBeenCalled(), { timeout: 1000 })
      await bob.peer.dispose()
      const epochReadsAtDisposal = epochReads.mock.calls.length
      const ledgerChecksAtDisposal = checkLedger.mock.calls.length
      releaseRead()
      await vi.waitFor(() => expect(readResumed).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetches).not.toHaveBeenCalled()
      expect(epochReads).toHaveBeenCalledTimes(epochReadsAtDisposal)
      expect(checkLedger).toHaveBeenCalledTimes(ledgerChecksAtDisposal)
      expect(applies).not.toHaveBeenCalled()
      expect(bootstraps).not.toHaveBeenCalled()
    } finally {
      releaseRead()
      await bob.peer.dispose()
    }
  })

  test('a seed pull stops before fetching when its epoch read resumes after disposal', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa5)
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    const mls = createMemoryGroupMLS({ recoverySecret, epoch: 1, localDID: 'bob' })
    const readEpoch = mls.readEpoch.bind(mls)
    let releaseRead = (): void => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let readResumed = false
    const epochRead = vi.spyOn(mls, 'readEpoch').mockImplementationOnce(async () => {
      await readGate
      readResumed = true
      return readEpoch()
    })
    const fetches = vi.spyOn(hub, 'fetchTopic')
    const applies = vi.spyOn(mls, 'processCommit')
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { mls })
    try {
      await vi.waitFor(() => expect(epochRead).toHaveBeenCalled(), { timeout: 1000 })
      await bob.peer.dispose()
      const fetchesAtDisposal = fetches.mock.calls.filter(
        ([params]) => params.topicID === commitTopic(recoverySecret),
      ).length
      releaseRead()
      await vi.waitFor(() => expect(readResumed).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        fetches.mock.calls.filter(([params]) => params.topicID === commitTopic(recoverySecret)),
      ).toHaveLength(fetchesAtDisposal)
      expect(applies).not.toHaveBeenCalled()
      expect(mls.epoch()).toBe(1)
    } finally {
      releaseRead()
      await bob.peer.dispose()
    }
  })

  test('a seed pull does not apply a fetched commit after disposal', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa6)
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    const mls = createMemoryGroupMLS({ recoverySecret, epoch: 1, localDID: 'bob' })
    const fetchTopic = hub.fetchTopic.bind(hub)
    let releaseFetch = (): void => {}
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let fetchResumed = false
    const fetches = vi.spyOn(hub, 'fetchTopic').mockImplementationOnce(async (params) => {
      await fetchGate
      fetchResumed = true
      return fetchTopic(params)
    })
    const applies = vi.spyOn(mls, 'processCommit')
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { mls })
    try {
      await vi.waitFor(() => expect(fetches).toHaveBeenCalled(), { timeout: 1000 })
      await bob.peer.dispose()
      const fetchesAtDisposal = fetches.mock.calls.filter(
        ([params]) => params.topicID === commitTopic(recoverySecret),
      ).length
      releaseFetch()
      await vi.waitFor(() => expect(fetchResumed).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        fetches.mock.calls.filter(([params]) => params.topicID === commitTopic(recoverySecret)),
      ).toHaveLength(fetchesAtDisposal)
      expect(applies).not.toHaveBeenCalled()
      expect(mls.epoch()).toBe(1)
    } finally {
      releaseFetch()
      await bob.peer.dispose()
    }
  })

  test('a delivery blocked in journal replay does not pull after disposal', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0xa7)
    const mls = createMemoryGroupMLS({ recoverySecret, epoch: 1, localDID: 'bob' })
    const journal = createMemoryCommitJournal()
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { mls, journal })
    let releaseRead = (): void => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    try {
      await bob.peer.replay()
      let readResumed = false
      const getJournal = journal.get.bind(journal)
      const journalRead = vi.spyOn(journal, 'get').mockImplementation(async () => {
        await readGate
        readResumed = true
        return getJournal()
      })
      const fetches = vi.spyOn(hub, 'fetchTopic')
      const applies = vi.spyOn(mls, 'processCommit')
      await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
      await vi.waitFor(() => expect(journalRead).toHaveBeenCalled(), { timeout: 1000 })
      await bob.peer.dispose()
      const fetchesAtDisposal = fetches.mock.calls.filter(
        ([params]) => params.topicID === commitTopic(recoverySecret),
      ).length
      releaseRead()
      await vi.waitFor(() => expect(readResumed).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        fetches.mock.calls.filter(([params]) => params.topicID === commitTopic(recoverySecret)),
      ).toHaveLength(fetchesAtDisposal)
      expect(applies).not.toHaveBeenCalled()
      expect(mls.epoch()).toBe(1)
    } finally {
      releaseRead()
      await bob.peer.dispose()
    }
  })
})
