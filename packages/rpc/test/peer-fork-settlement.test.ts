import { afterEach, describe, expect, test } from 'vitest'

import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { classifyCommit } from '../src/classify.js'
import { appliedRows } from '../src/control/forks.js'
import { forkEventID } from '../src/control/safety.js'
import { controlBuildRef } from '../src/control/slot.js'
import { applyChanges, applyResolved } from '../src/control/store.js'
import type { AppliedCommit, ControlSnapshot, Operation, Outcome } from '../src/control/types.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import type { StrandObservation } from '../src/peer.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
import { memoryEntryID } from './fixtures/memory-group-mls.js'
import {
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const empty = (): ControlSnapshot => ({
  commitOnce: null,
  commitOnceAcceptance: null,
  controlHold: null,
  forkHalt: null,
  recoveryUnavailable: null,
  strand: null,
  operations: [],
  rejoin: null,
  recoveryEpochFloor: null,
  forkRecoveryAttempt: null,
  settledRejoins: [],
  outcomes: [],
  welcomes: [],
  applied: [],
  responses: [],
  cursor: null,
})
const applied = (epoch: number, opID: string | null = null): AppliedCommit => ({
  epoch,
  opID,
  digest: `commit-${epoch}`,
  payloadDigest: `payload-${epoch}`,
  sequenceID: String(epoch).padStart(12, '0'),
  removed: false,
})
function operation(id: string, seq: number, stage: Operation['stage']): Operation {
  const base = {
    id,
    seq,
    kind: 'ledger' as const,
    revokes: false,
    body: new Uint8Array([1]),
    enqueuedAt: 100,
    deadline: 30_100,
  }
  if (stage === 'intent') return { ...base, stage }
  const built = {
    epoch: 1,
    authenticatorBefore: new Uint8Array([1]),
    incarnation: 1,
    publishID: `publish-${id}`,
    expectedHead: null,
    searchFrom: null,
    payload: new Uint8Array([2]),
    payloadDigest: `payload-${id}`,
    digest: `commit-${id}`,
    bodies: [],
    journal: new Uint8Array([3]),
    welcome: null,
  }
  return stage === 'built'
    ? { ...base, stage, built: controlBuildRef(built) }
    : {
        ...base,
        stage,
        built: controlBuildRef(built),
        acceptedAs: asLogPosition(String(seq).padStart(12, '0')),
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
          position: asLogPosition(String(seq).padStart(12, '0')),
          payloadDigest: built.payloadDigest,
        },
      }
}
const landed = (opID: string, epoch: number): Outcome => ({
  id: opID,
  opID,
  at: 100,
  kind: 'landed',
  position: asLogPosition(applied(epoch).sequenceID),
})

describe('fork history preservation', () => {
  test('classification reads only retained applied history', () => {
    const snapshot = { ...empty(), applied: [applied(1), applied(2)] }
    const rows = appliedRows(snapshot)
    expect([...rows.entries()]).toEqual([
      [1, applied(1)],
      [2, applied(2)],
    ])
    expect(rows.get(0)).toBeUndefined()
    expect(rows.get(3)).toBeUndefined()
    rows.delete(1)
    expect(snapshot.applied).toEqual([applied(1), applied(2)])
  })

  test('an own winner still identifies a losing divergence without repairing history', () => {
    const own = operation('winning-invite', 1, 'accepted')
    if (own.stage !== 'accepted') throw new Error('Missing acceptance')
    const snapshot = {
      ...empty(),
      operations: [{ ...own, built: { ...own.built, epoch: 2 } }],
      applied: [applied(2)],
    }
    expect(
      classifyCommit({
        header: { epoch: 2 },
        sequenceID: own.acceptedAs,
        commitDigest: 'commit-winning-invite',
        state: { localDID: 'bob', epoch: 3, appliedByEpoch: appliedRows(snapshot) },
      }),
    ).toMatchObject({ row: 'past-epoch-divergence' })
    expect(snapshot.outcomes).toEqual([])
    expect(snapshot.applied).toEqual([applied(2)])
  })

  test.each([2, 4])(
    'a halt at epoch %s preserves operations, outcomes and Welcome obligations',
    (epoch) => {
      const snapshot: ControlSnapshot = {
        ...empty(),
        operations: [
          operation('accepted', 1, 'accepted'),
          operation('intent', 2, 'intent'),
          operation('built', 3, 'built'),
        ],
        applied: [applied(1, 'older'), applied(2, 'own'), applied(3), applied(4, 'later')],
        outcomes: [landed('older', 1), landed('own', 2), landed('later', 4)],
        welcomes: [{ opID: 'accepted', welcome: new Uint8Array([7]), recipients: ['dave'] }],
        cursor: { position: asLogPosition('000000000004'), epoch: 5 },
      }
      const before = structuredClone(snapshot)
      const key = { groupID: 'group-A', incarnation: 1 }
      const forkHalt = {
        eventID: forkEventID(key),
        detectedAt: 100,
        evidence: {
          kind: 'digest-divergence' as const,
          epoch,
          position: String(epoch),
          localDigest: `commit-${epoch}`,
          remoteDigest: 'competitor',
        },
      }
      const result = applyChanges(snapshot, { forkHalt }, undefined, key)
      expect(result).toEqual({ ...before, forkHalt })
      expect(snapshot).toEqual(before)
    },
  )

  test.each(['host', 'double'] as const)(
    'halt preservation is atomic and survives an ambiguous %s write',
    async (provider) => {
      const database = createMemoryHostDatabase()
      const key = { groupID: 'group', incarnation: 1 }
      const double = createMemoryControlStore<LogPosition>(key)
      const store = provider === 'host' ? database.control('group', key) : double
      await store.apply(
        {
          putOperations: [operation('accepted', 1, 'accepted')],
          putApplied: [applied(1), applied(2, 'own')],
          putOutcomes: [landed('own', 2)],
        },
        'seed',
      )
      const before = await store.load()
      const forkHalt = {
        eventID: forkEventID(key),
        detectedAt: 100,
        evidence: {
          kind: 'digest-divergence' as const,
          epoch: 2,
          position: '000000000002',
          localDigest: 'commit-2',
          remoteDigest: 'competitor',
        },
      }
      const changes = { forkHalt }
      if (provider === 'host') database.failNext('mid-apply')
      else double.failNext('mid-apply')
      await expect(store.apply(changes, 'failed')).rejects.toThrow('Injected')
      expect(await store.load()).toEqual(before)
      expect(await store.lastMutation()).toBe('seed')
      if (provider === 'host') database.commitThenRejectNext('apply')
      else double.commitThenRejectNext('apply')
      await applyResolved(store, changes, 'halted')
      const reopened = provider === 'host' ? database.control('group', key) : double
      expect(await reopened.lastMutation()).toBe('halted')
      expect(await reopened.load()).toEqual({ ...before, forkHalt })
    },
  )
})

const secret = new Uint8Array(32).fill(0x92)
const peers: Array<TestPeer> = []
function member(hub: FakeHub, options: Parameters<typeof makeMLSPeer>[3] = {}) {
  const result = makeMLSPeer(hub, 'bob', secret, {
    members: ['alice', 'bob'],
    recovery: { timeoutMs: 30, getDelayMs: () => 0, deadlineMs: 60 },
    ...options,
  })
  peers.push(result)
  return result
}
afterEach(async () => {
  await Promise.all(peers.map(({ peer }) => peer.dispose()))
  await Promise.all(peers.splice(0).map(({ peer }) => peer.drained()))
})

describe('durable fork halts', () => {
  test('past divergence preserves history after a cursor-write crash and restart', async () => {
    const hub = new FakeHub()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    const hidden = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 2,
    })
    const applied = await publishCommit({
      hub,
      senderDID: 'carol',
      recoverySecret: secret,
      epoch: 2,
    })
    hub.hideFrom('bob', hidden.sequenceID)
    const seed = member(hub)
    await seed.peer.replay()
    await seed.peer.dispose()
    await seed.peer.drained()
    const again = member(hub, { restartOf: seed })
    await again.peer.replay()
    const before = await again.control.load()
    let seamFired = false
    again.database.seam('after-apply', () => {
      seamFired = true
      void again.peer.dispose()
    })
    hub.revealTo('bob', hidden.sequenceID)
    const poison = await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      payload: new Uint8Array([0]),
      retain: 'log',
    })
    await again.peer.replay().catch((error: unknown) => {
      expect(error).toMatchObject({ name: 'PeerDisposedError' })
    })
    await again.peer.dispose()
    await again.peer.drained()
    expect(seamFired).toBe(true)
    const snapshot = await again.control.load()
    expect(snapshot.forkHalt).toBeNull()
    expect(snapshot.applied).toEqual(before.applied)
    expect(snapshot.outcomes).toEqual(before.outcomes)
    expect(snapshot.strand).toBeNull()
    expect(snapshot.cursor?.position).toBe(applied.sequenceID)
    const restarted = member(hub, { restartOf: again })
    await restarted.peer.replay()
    const restored = await restarted.control.load()
    expect(restored.cursor?.position).toBe(poison.sequenceID)
    expect(restored.applied).toEqual(before.applied)
    expect(restarted.controlWalk.safetyHold()).toBeNull()
    expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
    await restarted.peer.commit(buildLedgerCommit(restarted, []))
    expect(restarted.mls.epoch()).toBe(4)
  })

  test('later past divergence leaves all applied history unchanged', async () => {
    const hub = new FakeHub()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 1 })
    const hidden = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 2,
    })
    await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 2 })
    const later = await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 3 })
    const last = await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 3 })
    hub.hideFrom('bob', hidden.sequenceID)
    hub.hideFrom('bob', later.sequenceID)
    const observations: Array<StrandObservation> = []
    const bob = member(hub, {
      onStrand: (observation) => {
        observations.push(observation)
      },
    })
    await bob.peer.replay()
    const before = await bob.control.load()
    hub.revealTo('bob', hidden.sequenceID)
    hub.revealTo('bob', later.sequenceID)
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      payload: new Uint8Array([0]),
    })
    await bob.peer.replay()
    const after = await bob.control.load()
    expect(after.cursor?.position).toBe(last.sequenceID)
    expect(after.strand).toBeNull()
    expect(after.forkHalt).toBeNull()
    expect(after.applied).toEqual(before.applied)
    expect(bob.controlWalk.safetyHold()).toBeNull()
    await expect.poll(() => observations.map((row) => row.claimedEpoch)).toEqual([2, 3])
    expect(
      observations.every(
        (row) => row.kind === 'past-epoch-divergence' && row.confidence === 'claimed',
      ),
    ).toBe(true)
    await bob.peer.replay()
    expect((await bob.control.load()).applied).toEqual(before.applied)
  })

  test.each(['live', 'restart'] as const)(
    'a moved acceptance with different payload preserves unknown work on %s',
    async (mode) => {
      const hub = new FakeHub()
      const bob = member(hub, { adopt: async () => 'moved' })
      await bob.peer.replay()
      const result = await publishCommit({
        hub,
        senderDID: 'alice',
        recoverySecret: secret,
        epoch: 1,
      })
      await expect.poll(() => bob.mls.epoch()).toBe(2)
      const op = await seedBuiltOperation(bob, buildLedgerCommit(bob, []), result.sequenceID)
      if (op.stage !== 'accepted') throw new Error('Missing acceptance')
      const snapshot = await bob.control.load()
      const row = snapshot.applied[0]
      if (row == null) throw new Error('Missing applied row')
      const accepted = { ...op, built: { ...op.built, epoch: 1, digest: row.digest } }
      expect(accepted.built.payloadDigest).not.toBe(row.payloadDigest)
      await bob.control.apply({ putOperations: [accepted] }, 'conflicting-acceptance')
      let runner = bob
      if (mode === 'restart') {
        await bob.peer.dispose()
        await bob.peer.drained()
        runner = member(hub, { restartOf: bob, adopt: async () => 'moved' })
        await runner.peer.replay()
      } else {
        await runner.peer.enqueue(buildLedgerCommit(runner, []))
        await runner.peer.replay()
      }
      expect(await runner.control.load()).toMatchObject({
        operations: [
          accepted,
          ...(mode === 'live' ? [expect.objectContaining({ stage: 'intent' })] : []),
        ],
        outcomes: [],
        applied: snapshot.applied,
        forkHalt: null,
        controlHold: { reason: 'acceptance-unknown' },
        strand: snapshot.strand,
        cursor: snapshot.cursor,
      })
      expect(
        hub.published.filter((message) => message.topicID === commitTopic(secret)),
      ).toHaveLength(1)
      const held = await runner.control.load()
      expect(
        hub.published.filter(
          (message) => message.topicID === rendezvousTopic(secret) && message.senderDID === 'bob',
        ),
      ).toEqual([])
      await runner.peer.dispose()
      await runner.peer.drained()
      hub.trim(commitTopic(secret), '999999999999')
      const again = member(hub, { restartOf: runner })
      await again.peer.replay()
      expect((await again.control.load()).controlHold).toEqual(held.controlHold)
      expect((await again.control.load()).commitOnce).toEqual(held.commitOnce)
      expect((await again.control.load()).cursor).toEqual(held.cursor)
      expect((await again.control.load()).strand).toEqual(held.strand)
      expect(
        hub.published.filter(
          (message) => message.topicID === rendezvousTopic(secret) && message.senderDID === 'bob',
        ),
      ).toEqual([])
    },
  )

  async function restartStoredForkHalt(
    options: { acceptedInvite?: boolean; collision?: boolean; reenact?: boolean } = {},
  ) {
    const hub = new FakeHub()
    const alice = makeMLSPeer(hub, 'alice', secret, {
      members: ['alice', 'bob'],
      recovery: { timeoutMs: 30, deadlineMs: 300, getDelayMs: () => 0 },
    })
    peers.push(alice)
    const bob = member(hub, {
      epoch: 2,
      recovery: { timeoutMs: 30, deadlineMs: 300, getDelayMs: () => 0 },
      adopt: async () => 'moved',
    })
    await alice.peer.replay()
    await bob.peer.replay()
    const rows = options.collision
      ? [applied(1, 'own')]
      : [applied(0, 'older'), applied(1, 'own'), applied(2, 'later')]
    const accepted = {
      ...operation('invite', 1, 'accepted'),
      kind: 'invite' as const,
      enqueuedAt: Date.now(),
      deadline: Date.now() + 30_000,
    }
    if (options.acceptedInvite) {
      bob.mls.adopt(bob.mls.buildCommit([], { adds: ['dave'] }))
      await bob.database.saveState('bob', bob.mls.serializeState())
    }
    if (options.reenact) {
      bob.mls.adopt(bob.mls.buildCommit(['branch-token']))
      await bob.database.saveState('bob', bob.mls.serializeState())
    }
    await bob.control.apply(
      {
        putApplied: rows,
        putOutcomes: rows.flatMap((row) => (row.opID == null ? [] : [landed(row.opID, row.epoch)])),
        ...(options.acceptedInvite ? { putOperations: [accepted] } : {}),
        cursor: {
          position: null,
          epoch: bob.mls.epoch(),
        },
      },
      'stored-fork',
    )
    await bob.controlWalk.haltFork({
      kind: 'digest-divergence',
      epoch: 1,
      position: '000000000001',
      localDigest: 'commit-own',
      remoteDigest: 'withheld-competitor',
    })
    const before = await bob.control.load()
    await bob.peer.dispose()
    await bob.peer.drained()
    const restarted = member(hub, {
      restartOf: bob,
      recovery: { timeoutMs: 30, deadlineMs: 300, getDelayMs: () => 0 },
      adopt: async () => 'moved',
    })
    await restarted.peer.replay()
    const snapshot = await restarted.control.load()
    expect(snapshot.forkHalt).toEqual(before.forkHalt)
    expect(snapshot.cursor).toEqual(before.cursor)
    expect(snapshot.strand).toEqual(before.strand)
    expect(snapshot.applied).toEqual(before.applied)
    expect(snapshot.outcomes).toEqual(before.outcomes)
    expect(snapshot.rejoin).toBeNull()
    expect(hub.published).toEqual([])
    return { hub, alice, restarted, snapshot, before }
  }

  test('a stored fork halt survives a crash without recovery or history repair', async () => {
    const { restarted, snapshot } = await restartStoredForkHalt()
    expect(snapshot.outcomes).toEqual([landed('older', 0), landed('own', 1), landed('later', 2)])
    expect(restarted.controlWalk.safetyHold()).toBe('fork-halted')
  })
  test('an observed lower-position conflict preserves proven landed outcomes', async () => {
    const { snapshot } = await restartStoredForkHalt()
    expect(snapshot.outcomes.map((outcome) => outcome.kind)).toEqual(['landed', 'landed', 'landed'])
  })
  test('a halted losing-branch invite retains its operation and membership', async () => {
    const { restarted, snapshot } = await restartStoredForkHalt({ acceptedInvite: true })
    expect(snapshot.operations).toMatchObject([{ id: 'invite', stage: 'accepted' }])
    expect(restarted.mls.leaves()).toContain('dave')
    expect(snapshot.outcomes.some((outcome) => outcome.opID === 'invite')).toBe(false)
  })
  test('a halted applied own row keeps its landed outcome', async () => {
    const { snapshot } = await restartStoredForkHalt({ collision: true })
    expect(snapshot.applied).toEqual([applied(1, 'own')])
    expect(snapshot.outcomes).toEqual([landed('own', 1)])
  })
  test('a halted fork retains branch entries without reenact outcomes', async () => {
    const { snapshot, restarted } = await restartStoredForkHalt({ reenact: true })
    expect(snapshot.outcomes.some((outcome) => outcome.kind === 'reenact')).toBe(false)
    expect(restarted.mls.ledgerIDs()).toContain(memoryEntryID('branch-token'))
    expect((await restarted.peer.replay()).reenact ?? []).toEqual([])
  })
  test('a halted restart retains every applied row across repeated replay', async () => {
    const { snapshot, restarted } = await restartStoredForkHalt()
    expect(snapshot.applied).toEqual([applied(0, 'older'), applied(1, 'own'), applied(2, 'later')])
    await restarted.peer.replay()
    expect((await restarted.control.load()).applied).toEqual(snapshot.applied)
  })
})
