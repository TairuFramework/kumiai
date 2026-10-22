import { afterEach, expect, test, vi } from 'vitest'

import { stepLegacyRejoin } from '../src/control/rejoin.js'
import { forkEventID, recoveryUnavailableEventID } from '../src/control/safety.js'
import { closeControlBuild } from '../src/control/slot.js'
import { applyChanges, readmissionChanges } from '../src/control/store.js'
import type { ControlSnapshot } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import {
  buildInviteCommit,
  buildLegacyRejoinRecord,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const peers: Array<TestPeer> = []

test.each([false, true])(
  'authenticated build closure clears spentSource with a live build present=%s',
  async (live) => {
    const member = makeMLSPeer(new FakeHub(), 'bob', new Uint8Array(32).fill(0x96))
    peers.push(member)
    await member.peer.replay()
    if (live) await seedBuiltOperation(member, buildInviteCommit(member, 'invitee'))
    const before = { ...(await member.control.load()), spentSource: { epoch: 1 } }
    const changes = closeControlBuild(before, { kind: 'unknown' }, 123, 'consumed')
    expect(changes.spentSource).toBeNull()
    expect(
      applyChanges(before, changes, { kind: 'retirement', key: member.control.key }).spentSource,
    ).toBeNull()
  },
)
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
  vi.useRealTimers()
})

test.each([false, true])(
  'readmission closes the live source build atomically (acknowledged=%s)',
  async (acknowledged) => {
    const secret = new Uint8Array(32).fill(0x94)
    const member = makeMLSPeer(new FakeHub(), 'bob', secret)
    peers.push(member)
    await member.peer.replay()
    const saved = await seedBuiltOperation(
      member,
      buildInviteCommit(member, 'invitee'),
      acknowledged ? 'accepted' : undefined,
    )
    const record = {
      ...(await buildLegacyRejoinRecord(member)),
      stage: 'confirmed' as const,
      position: asLogPosition('confirmed-recovery'),
    }
    await member.peer.dispose()
    await member.peer.drained()
    const provisional = { id: 'prior-report', opID: saved.id, at: 1, kind: 'unknown' as const }
    const obligation = {
      opID: 'owed',
      welcome: new Uint8Array([9]),
      recipients: ['recipient'],
    }
    await member.control.apply(
      {
        putRejoin: record,
        putOutcomes: [provisional],
        putWelcomes: [obligation],
      },
      'pending-readmission',
    )
    const pending = await member.mls.restoreRecovery(record.candidate, record.requestKey)
    const unreachable = async (): Promise<never> => {
      throw new Error('Unexpected recovery work')
    }
    const emitted: Array<unknown> = []
    const next = await stepLegacyRejoin(
      {
        control: member.control,
        publish: unreachable,
        searchLog: unreachable,
        confirm: unreachable,
        runSerial: (fn) => fn(),
        scan: async () => ({ current: record.source, gap: false, frames: [] }),
        adopt: async (_record, write) => {
          await pending.onAccepted(write)
        },
        bootstrapLedger: unreachable,
        getLedger: unreachable,
        newID: () => crypto.randomUUID(),
        now: () => 1234,
        emit: (outcome) => {
          emitted.push(outcome)
        },
        discarded: unreachable,
      },
      record,
    )
    const after = await member.control.load()
    expect(member.mls.epoch()).toBe(record.epochAfter)
    expect(next?.stage).toBe('adopted')
    expect(after.commitOnce).toBeNull()
    expect(after.spentSource).toBeNull()
    expect(after.operations).toEqual([])
    expect(after.outcomes).toEqual([
      { id: expect.any(String), opID: saved.id, at: 1234, kind: 'unknown' },
    ])
    expect(after.outcomes[0]?.id).not.toBe(provisional.id)
    expect(after.outcomes[0]?.id).not.toBe(saved.id)
    expect(after.welcomes).toEqual([obligation])
    expect(after.cursor).toMatchObject({ position: record.position, epoch: record.epochAfter })
    expect(emitted).toEqual(after.outcomes)
  },
)

test('the peer recovery switch closes its acknowledged build with a fresh final unknown', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(0x95)
  const options = {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 1000, deadlineMs: 10_000, getDelayMs: () => 0 },
  }
  const alice = makeMLSPeer(hub, 'alice', secret, options)
  const bob = makeMLSPeer(hub, 'bob', secret, options)
  peers.push(alice, bob)
  await alice.peer.replay()
  await bob.peer.replay()
  const saved = await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'), 'accepted')
  const obligation = {
    opID: 'owed',
    welcome: new Uint8Array([9]),
    recipients: ['recipient'],
  }
  await bob.control.apply(
    {
      putOutcomes: [{ id: 'prior-report', opID: saved.id, at: 1, kind: 'unknown' }],
      putWelcomes: [obligation],
    },
    'pending-switch',
  )
  expect((await bob.peer.recover()).advanced).toBe(true)
  const after = await bob.control.load()
  expect(after.commitOnce).toBeNull()
  expect(after.spentSource).toBeNull()
  const outcome = after.outcomes.find(({ opID }) => opID === saved.id)
  expect(outcome).toMatchObject({ kind: 'unknown', id: expect.any(String) })
  expect(outcome?.id).not.toBe('prior-report')
  expect(outcome?.id).not.toBe(saved.id)
  expect(after.outcomes.some(({ id }) => id === 'prior-report')).toBe(false)
  expect(after.welcomes.some(({ opID }) => opID === saved.id)).toBe(false)
})

test('same-incarnation recovery clears an abandoned source marker without a live build', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(0x97)
  const options = {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 1000, deadlineMs: 10_000, getDelayMs: () => 0 },
  }
  const alice = makeMLSPeer(hub, 'alice', secret, options)
  const bob = makeMLSPeer(hub, 'bob', secret, options)
  peers.push(alice, bob)
  await alice.peer.replay()
  await bob.peer.replay()
  await seedBuiltOperation(bob, buildInviteCommit(bob, 'invitee'))
  const sourceEpoch = bob.mls.epoch()
  await bob.peer.abandon()
  const before = await bob.control.load()
  expect(before.commitOnce).toBeNull()
  expect(before.spentSource).toEqual({ epoch: sourceEpoch })
  expect((await bob.peer.recover()).advanced).toBe(true)
  const after = await bob.control.load()
  expect(bob.control.key).toEqual(alice.control.key)
  expect(bob.mls.epoch()).toBeGreaterThan(sourceEpoch)
  expect(after.spentSource).toBeNull()
  expect(after.outcomes).toEqual(before.outcomes)
})

function unsettled(): ControlSnapshot {
  const operation = {
    kind: 'invite' as const,
    revokes: true,
    body: new Uint8Array([4]),
    enqueuedAt: 100,
    deadline: 30_100,
  }
  return {
    schemaVersion: 1,
    commitOnce: null,
    spentSource: null,
    controlHold: null,
    forkHalt: null,
    recoveryUnavailable: null,
    strand: null,
    operations: [
      { ...operation, id: 'intent', seq: 1, stage: 'intent' },
      { ...operation, id: 'queued-2', seq: 2, stage: 'intent' },
      { ...operation, id: 'queued-3', seq: 3, stage: 'intent' },
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
    recoveryEpochFloor: null,
    forkRecoveryAttempt: null,
    settledRejoins: [],
    outcomes: [{ id: 'settled', opID: 'settled', at: 50, kind: 'lost' }],
    welcomes: [{ opID: 'accepted', welcome: new Uint8Array([10]), recipients: ['carol'] }],
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
      {
        position: asLogPosition('003'),
        digest: 'applied-rejoin',
        kind: 'applied',
        epoch: 1,
        epochAfter: 2,
      },
    ],
    cursor: {
      position: asLogPosition('001'),
      epoch: 2,
      stranded: true,
    },
  }
}

function expectReset(before: ControlSnapshot, after: ControlSnapshot) {
  expect(after.operations).toEqual([])
  expect(after.rejoin).toBeNull()
  expect(after.recoveryEpochFloor).toBeNull()
  expect(after.settledRejoins).toEqual([])
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

test('readmission clears applied with existing prune-below', () => {
  const key = { groupID: 'group-A', incarnation: 1 }
  const before = unsettled()
  before.forkHalt = {
    eventID: forkEventID(key),
    evidence: { kind: 'unexplained-own-commit', epoch: 1, position: '001', digest: 'old-commit' },
    detectedAt: 100,
  }
  before.recoveryUnavailable = {
    ...key,
    id: recoveryUnavailableEventID(key),
    kind: 'group:recovery-unavailable',
    reason: 'trust-unreadable',
  }
  before.applied.push({
    epoch: Number.MAX_SAFE_INTEGER,
    digest: 'max-epoch-commit',
    payloadDigest: 'max-epoch-payload',
    sequenceID: '004',
    opID: null,
    removed: false,
  })
  const changes = readmissionChanges(before)
  expect(changes.deleteAppliedBelow).toBe(Number.MAX_SAFE_INTEGER + 1)
  expect(changes).not.toHaveProperty('deleteAppliedFrom')
  const after = applyChanges(before, changes, undefined, key)
  expectReset(before, after)
  expect(after.forkHalt).toEqual(before.forkHalt)
  expect(after.recoveryUnavailable).toEqual(before.recoveryUnavailable)
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
