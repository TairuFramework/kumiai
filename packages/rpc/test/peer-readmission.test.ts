import { afterEach, expect, test, vi } from 'vitest'

import { controlBuildRef } from '../src/control/slot.js'
import { applyChanges, readmissionChanges } from '../src/control/store.js'
import type { ControlSnapshot } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const peers: Array<TestPeer> = []
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.useRealTimers()
})

function unsettled(): ControlSnapshot {
  const built = {
    publishID: 'invite-publish',
    expectedHead: null,
    searchFrom: null,
    epoch: 1,
    authenticatorBefore: new Uint8Array([1]),
    incarnation: 1,
    payload: new Uint8Array([2]),
    payloadDigest: 'invite-payload',
    digest: 'invite-commit',
    bodies: [],
    journal: new Uint8Array([3]),
    welcome: null,
  }
  const operation = {
    kind: 'invite' as const,
    revokes: true,
    body: new Uint8Array([4]),
    enqueuedAt: 100,
    deadline: 30_100,
  }
  return {
    commitOnce: null,
    commitOnceAcceptance: null,
    controlHold: null,
    strand: null,
    operations: [
      { ...operation, id: 'intent', seq: 1, stage: 'intent' },
      { ...operation, id: 'built', seq: 2, stage: 'built', built: controlBuildRef(built) },
      {
        ...operation,
        id: 'accepted',
        seq: 3,
        stage: 'accepted',
        built: controlBuildRef(built),
        acceptedAs: asLogPosition('002'),
        acceptance: {
          source: {
            key: { groupID: 'group-A', incarnation: 1 },
            stateVersion: 1,
            identity: {
              groupID: 'group-A',
              incarnation: 1,
              epoch: 1,
              authenticator: new Uint8Array([1]),
            },
          },
          from: null,
          position: asLogPosition('002'),
          payloadDigest: built.payloadDigest,
        },
      },
    ],
    rejoin: {
      id: 'rejoin',
      stage: 'confirmed',
      publishID: 'rejoin-publish',
      expectedHead: null,
      payload: new Uint8Array([5]),
      payloadDigest: 'rejoin-payload',
      requestID: 'request',
      request: new Uint8Array([6]),
      requestKey: new Uint8Array([7]),
      candidate: new Uint8Array([8]),
      source: {
        epoch: 1,
        authenticator: new Uint8Array([1]),
        key: { groupID: 'group-A', incarnation: 1 },
        head: null,
      },
      digest: 'rejoin-commit',
      epochAfter: 2,
      ledgerBefore: ['ledger-token'],
      conflictEpoch: 1,
      position: asLogPosition('003'),
      verdict: new Uint8Array([9]),
    },
    outcomes: [{ id: 'settled', opID: 'settled', at: 50, kind: 'lost' }],
    welcomes: [
      { opID: 'accepted', welcome: new Uint8Array([10]), recipients: ['carol'], committed: true },
    ],
    applied: [
      {
        epoch: 1,
        digest: 'old-commit',
        payloadDigest: 'old-payload',
        sequenceID: '001',
        opID: 'settled',
        removed: true,
      },
    ],
    responses: [
      { position: asLogPosition('003'), digest: 'refused-rejoin', kind: 'refused', epoch: 1 },
    ],
    cursor: {
      position: asLogPosition('001'),
      epoch: 2,
      stranded: true,
      fork: { conflictEpoch: 1, sharedPosition: null, frameDigest: 'fork' },
    },
  }
}

function expectReset(before: ControlSnapshot, after: ControlSnapshot) {
  expect(after.operations).toEqual([])
  expect(after.rejoin).toBeNull()
  expect(after.applied).toEqual([])
  expect(after.responses).toEqual([])
  expect(after.cursor).toBeNull()
  expect(after.welcomes).toEqual(before.welcomes)
  expect(after.outcomes).toEqual([
    ...before.outcomes,
    ...before.operations.map(({ id }) => ({
      id,
      opID: id,
      kind: 'unknown',
      at: expect.any(Number),
    })),
    { id: 'rejoin', opID: null, kind: 'unknown', at: expect.any(Number) },
  ])
}

test('re-admission forgets the old branch and retains outcomes and Welcome obligations', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const before = unsettled()
  const copy = structuredClone(before)
  const after = applyChanges(before, readmissionChanges(before))
  expectReset(before, after)
  expect(after.outcomes.slice(1).map(({ at }) => at)).toEqual([1000, 1000, 1000, 1000])
  expect(before).toEqual(copy)
  expect(applyChanges(after, readmissionChanges(after))).toEqual(after)
})

test('re-admission clears large response snapshots with repeated epochs', () => {
  const before = unsettled()
  before.responses = Array.from({ length: 200_000 }, (_, index) => ({
    position: asLogPosition(String(index)),
    digest: `refused-${index}`,
    kind: 'refused',
    epoch: index === 100_000 ? 9 : 7,
  }))
  const changes = readmissionChanges(before)
  expect(changes.deleteResponsesBelow).toBe(10)
  expectReset(before, applyChanges(before, changes))
  expect(before.responses).toHaveLength(200_000)
})

test('a failed replacement leaves the state, control and anchor together on the old branch', async () => {
  const db = createMemoryHostDatabase()
  const before = unsettled()
  await db.saveState('bob', new Uint8Array([1]))
  await db.control('bob', { groupID: 'memory-group', incarnation: 1 }).apply(
    {
      putOperations: before.operations,
      putRejoin: before.rejoin ?? undefined,
      putOutcomes: before.outcomes,
      putWelcomes: before.welcomes,
      putApplied: before.applied,
      putResponses: before.responses,
      cursor: before.cursor,
    },
    'old-branch',
  )
  const slot = { anchor: { epoch: 1, secret: new Uint8Array([2]) } }
  await db.anchorStore('bob').save(slot)
  db.failNext('mid-seed')
  await expect(
    db.seed('bob', new Uint8Array([4]), {
      replace: true,
      expectedVersion: await db.loadVersion('bob'),
    }),
  ).rejects.toThrow('Injected transaction failure')
  expect(await db.loadState('bob')).toEqual(new Uint8Array([1]))
  expect(await db.control('bob', { groupID: 'memory-group', incarnation: 1 }).load()).toEqual(
    before,
  )
  expect(await db.anchorStore('bob').load()).toEqual(slot)
})

test('a crash after Welcome replacement commits the reset and restart captures the joined anchor', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(0x93)
  const seed = makeMLSPeer(hub, 'bob', secret)
  peers.push(seed)
  await seed.peer.replay()
  await seed.peer.dispose()
  await seed.peer.drained()
  const before = unsettled()
  await seed.control.apply(
    {
      putOperations: before.operations,
      putRejoin: before.rejoin ?? undefined,
      putOutcomes: before.outcomes,
      putWelcomes: before.welcomes,
      putApplied: before.applied,
      putResponses: before.responses,
      cursor: before.cursor,
    },
    'old-branch',
  )
  await seed.anchorStore.save({
    anchor: { epoch: 1, secret: new Uint8Array(32).fill(1) },
    pending: {
      advance: 'old-rotation',
      epochBefore: 1,
      epochAfter: 2,
      rosterBefore: ['bob'],
      forced: true,
    },
  })
  const joined = createMemoryGroupMLS({ localDID: 'bob', recoverySecret: secret, epoch: 4 })
  const state = joined.serializeState()
  seed.database.seam('after-seed', () => {
    throw new Error('process crashed after Welcome replacement')
  })
  await expect(
    seed.database.seed('bob', state, {
      replace: true,
      expectedVersion: await seed.database.loadVersion('bob'),
    }),
  ).rejects.toThrow('process crashed after Welcome replacement')
  expect(await seed.database.loadState('bob')).toEqual(state)
  expectReset(before, await seed.control.load())
  expect(await seed.anchorStore.load()).toBeNull()

  const again = makeMLSPeer(hub, 'bob', secret, { restartOf: seed })
  peers.push(again)
  await again.peer.replay()
  expect(again.mls.epoch()).toBe(4)
  expect(again.peer.anchorEpoch()).toBe(4)
  expect((await again.anchorStore.load())?.anchor.epoch).toBe(4)
  expect((await again.anchorStore.load())?.pending).toBeUndefined()
  expect(await again.peer.outcomes()).toEqual((await seed.control.load()).outcomes)
  expect(again.welcomes).toEqual(['accepted'])
  expect((await seed.control.load()).welcomes).toEqual([])
  await again.peer.protocol('chat').dispatch('chat/changed', { data: { readmitted: true } })
})

test('a delayed Welcome replacement rejects a stale version without resetting newer state or control', async () => {
  const db = createMemoryHostDatabase()
  const stateAt = (epoch: number) =>
    createMemoryGroupMLS({ localDID: 'bob', epoch }).serializeState()
  await db.seed('bob', stateAt(1))
  const expectedVersion = await db.loadVersion('bob')
  let entered!: () => void
  let release!: () => void
  const enteredSeed = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  db.seam('before-seed', async () => {
    entered()
    await gate
  })
  const stale = db.seed('bob', stateAt(4), { replace: true, expectedVersion })
  const rejected = expect(stale).rejects.toThrow('stale')
  await enteredSeed
  const newer = stateAt(5)
  await db.seed('bob', newer, { replace: true, expectedVersion })
  const currentVersion = await db.loadVersion('bob')
  const slot = { anchor: { epoch: 5, secret: new Uint8Array([5]) } }
  await db.anchorStore('bob').save(slot)
  await db
    .control('bob', { groupID: 'memory-group', incarnation: 1 })
    .apply({ putOperations: unsettled().operations }, 'new-control')
  const control = await db.control('bob', { groupID: 'memory-group', incarnation: 1 }).load()
  release()
  await rejected
  expect(await db.loadState('bob')).toEqual(newer)
  expect(await db.loadVersion('bob')).toBe(currentVersion)
  expect(await db.control('bob', { groupID: 'memory-group', incarnation: 1 }).load()).toEqual(
    control,
  )
  expect(await db.control('bob', { groupID: 'memory-group', incarnation: 1 }).lastMutation()).toBe(
    'new-control',
  )
  expect(await db.anchorStore('bob').load()).toEqual(slot)
})
