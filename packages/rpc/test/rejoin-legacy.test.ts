import { afterEach, expect, test, vi } from 'vitest'

import { asLogPosition } from '../src/cursor.js'
import type { RecoveryContinuation } from '../src/recovery-types.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildRejoinRecord, makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(41)
const peers: Array<TestPeer> = []
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.restoreAllMocks()
})

async function setup() {
  const hub = new FakeHub()
  const source = makeMLSPeer(hub, 'bob', secret)
  peers.push(source)
  await source.peer.replay()
  await source.peer.dispose()
  await source.peer.drained()
  const record = {
    ...(await buildRejoinRecord(source)),
    stage: 'adopted' as const,
    position: asLogPosition('installed'),
    ledgerBefore: ['missing', 'missing'],
  }
  const continuation: RecoveryContinuation = {
    source: record.source.key,
    destination: { ...record.source.key, incarnation: 2 },
    record,
  }
  return { hub, source, continuation }
}

test('continuation and completion must be supplied together', async () => {
  const s = await setup()
  expect(() => makeMLSPeer(s.hub, 'bob', secret, { continuation: s.continuation })).toThrow(
    TypeError,
  )
  expect(() => makeMLSPeer(s.hub, 'bob', secret, { completion: async () => {} })).toThrow(TypeError)
})

test('destination retries completion after verified bootstrap and returns reenact once without enqueue', async () => {
  const s = await setup()
  let complete = false
  let finishes = 0
  const ledgers: Array<Array<string>> = []
  const destinationMLS = s.source.mls
  const readSource = destinationMLS.readRecoverySource.bind(destinationMLS)
  vi.spyOn(destinationMLS, 'readRecoverySource').mockImplementation(async () => ({
    ...(await readSource()),
    key: s.continuation.destination,
  }))
  vi.spyOn(destinationMLS, 'isLedgerComplete').mockImplementation(async () => complete)
  const stored = await s.source.anchorStore.load()
  if (stored === null) throw new Error('Missing anchor')
  await s.source.anchorStore.save({
    ...stored,
    pending: {
      epochBefore: 0,
      epochAfter: 1,
      rosterBefore: ['bob'],
      forced: true,
      advance: 'installed',
      landed: true,
    },
  })
  const roster = destinationMLS.rosterEntries.bind(destinationMLS)
  vi.spyOn(destinationMLS, 'rosterEntries').mockImplementation(async () => {
    expect(complete).toBe(true)
    return roster()
  })
  // The destination already has a head-verified ledger on the second startup, as after a bootstrap crash.
  const destination = makeMLSPeer(s.hub, 'bob', secret, {
    mls: destinationMLS,
    anchorStore: s.source.anchorStore,
    continuation: s.continuation,
    completion: async ({ ledger }) => {
      expect(complete).toBe(true)
      ledgers.push(ledger)
      if (++finishes === 1) throw new Error('Completion rolled back')
    },
    recovery: { timeoutMs: 10, deadlineMs: 30, getDelayMs: () => 60_000 },
  })
  peers.push(destination)
  await destination.peer.replay()
  expect(finishes).toBe(0)
  expect((await destination.control.load()).operations).toEqual([])
  complete = true
  await expect(destination.peer.replay()).rejects.toThrow('Completion rolled back')
  const results = await Promise.all([destination.peer.replay(), destination.peer.replay()])
  expect(results.flatMap((result) => result.reenact ?? [])).toEqual(['missing'])
  expect(ledgers).toEqual([[], []])
  expect((await destination.control.load()).operations).toEqual([])
  expect(s.hub.published.filter((row) => row.topicID.includes('commits'))).toEqual([])
})

test('destination head-verifies a gathered ledger before completing the retired source', async () => {
  const s = await setup()
  let lying = true
  const options = { recoverySecret: secret, members: ['alice', 'bob'], epoch: 1 }
  const responderMLS = createMemoryGroupMLS({
    ...options,
    localDID: 'alice',
    ledgerEntries: ['present'],
    serveLedger: (ledger) => (lying ? [] : ledger),
  })
  const responder = makeMLSPeer(s.hub, 'alice', secret, {
    mls: responderMLS,
    recovery: { getDelayMs: () => 0 },
  })
  peers.push(responder)
  await responder.peer.replay()
  const mls = createMemoryGroupMLS({ ...options, localDID: 'bob', ledgerEntries: ['present'] })
  const state = JSON.parse(new TextDecoder().decode(mls.serializeState())) as Record<
    string,
    unknown
  >
  mls.restoreState(new TextEncoder().encode(JSON.stringify({ ...state, ledger: [] })))
  const readSource = mls.readRecoverySource.bind(mls)
  vi.spyOn(mls, 'readRecoverySource').mockImplementation(async () => ({
    ...(await readSource()),
    key: s.continuation.destination,
  }))
  const roster = mls.rosterEntries.bind(mls)
  vi.spyOn(mls, 'rosterEntries').mockImplementation(async () => {
    expect(await mls.isLedgerComplete()).toBe(true)
    return roster()
  })
  const ledgers: Array<Array<string>> = []
  const destination = makeMLSPeer(s.hub, 'bob', secret, {
    mls,
    continuation: {
      ...s.continuation,
      record: { ...s.continuation.record, ledgerBefore: ['missing', 'present', 'missing'] },
    },
    completion: async ({ ledger }) => {
      expect(await mls.isLedgerComplete()).toBe(true)
      ledgers.push(ledger)
    },
    recovery: { timeoutMs: 30, deadlineMs: 100, getDelayMs: () => 60_000 },
  })
  peers.push(destination)
  await destination.peer.replay()
  expect(await mls.isLedgerComplete()).toBe(false)
  expect(ledgers).toEqual([])
  lying = false
  expect(await destination.peer.replay()).toEqual({ reenact: ['missing'] })
  expect(ledgers).toEqual([['present']])
  expect(await destination.peer.replay()).toEqual({})
  expect((await destination.control.load()).operations).toEqual([])
})

test('disposal during source completion emits no bootstrap notice', async () => {
  const s = await setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const readSource = s.source.mls.readRecoverySource.bind(s.source.mls)
  vi.spyOn(s.source.mls, 'readRecoverySource').mockImplementation(async () => ({
    ...(await readSource()),
    key: s.continuation.destination,
  }))
  const notices: Array<string> = []
  const destination = makeMLSPeer(s.hub, 'bob', secret, {
    mls: s.source.mls,
    continuation: s.continuation,
    completion: async () => {
      entered.resolve()
      await release.promise
    },
    onRecovery: (event) => {
      notices.push(event.phase)
    },
  })
  peers.push(destination)
  try {
    const replay = expect(destination.peer.replay()).rejects.toMatchObject({
      name: 'PeerDisposedError',
    })
    await entered.promise
    const disposal = destination.peer.dispose()
    release.resolve()
    await disposal
    await replay
    await destination.peer.drained()
    expect(notices).not.toContain('bootstrapped')
  } finally {
    release.resolve()
  }
})
