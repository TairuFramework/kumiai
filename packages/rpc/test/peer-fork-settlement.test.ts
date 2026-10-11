import { afterEach, describe, expect, test } from 'vitest'

import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { classifyCommit } from '../src/classify.js'
import { appliedRows, forkEvidence, forkSettlement } from '../src/control/forks.js'
import { controlBuildRef } from '../src/control/slot.js'
import { applyChanges, applyResolved } from '../src/control/store.js'
import type { AppliedCommit, ControlSnapshot, Operation, Outcome } from '../src/control/types.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import type { StrandObservation } from '../src/peer.js'
import { commitTopic, rendezvousTopic } from '../src/topic.js'
import { publishCommit, publishedCommitDigest } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'
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
  strand: null,
  operations: [],
  rejoin: null,
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

describe('fork settlement', () => {
  test('settles every acceptance and affected own row once, leaving queued builds and older outcomes', () => {
    const snapshot: ControlSnapshot = {
      ...empty(),
      operations: [
        operation('accepted', 1, 'accepted'),
        operation('both', 2, 'accepted'),
        operation('intent', 3, 'intent'),
        operation('built', 4, 'built'),
      ],
      applied: [applied(1, 'older'), applied(2, 'both'), applied(3), applied(4, 'landed')],
      outcomes: [landed('older', 1), landed('both', 2), landed('landed', 4)],
    }
    const before = structuredClone(snapshot)
    const rejoin = { ...applied(5), digest: 'rejoin' }
    const changes = forkSettlement(snapshot, 2, rejoin)
    const result = applyChanges(snapshot, changes)
    expect(changes.deleteOperations).toEqual(['accepted', 'both'])
    expect(result.operations.map((op) => op.id)).toEqual(['intent', 'built'])
    expect(result.outcomes).toEqual([
      landed('older', 1),
      expect.objectContaining({ id: 'both', opID: 'both', kind: 'unknown' }),
      expect.objectContaining({ id: 'landed', opID: 'landed', kind: 'unknown' }),
      expect.objectContaining({ id: 'accepted', opID: 'accepted', kind: 'unknown' }),
    ])
    expect(changes.putOutcomes).toHaveLength(3)
    expect(result.applied).toEqual([applied(1, 'older'), rejoin])
    expect(snapshot).toEqual(before)
  })

  test('an own winner at the divergence epoch becomes unknown when a competitor was adopted', () => {
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
    ).toMatchObject({ row: 'fork', branch: 'losing' })
    const result = applyChanges(snapshot, forkSettlement(snapshot, 2, applied(3)))
    expect(result.outcomes).toEqual([
      expect.objectContaining({ opID: 'winning-invite', kind: 'unknown' }),
    ])
  })

  test('late-revealed divergence leaves rows and landed outcomes below the detected epoch alone', () => {
    const snapshot = {
      ...empty(),
      applied: [
        applied(1, 'divergence'),
        applied(2, 'second'),
        applied(3, 'third'),
        applied(4, 'fourth'),
      ],
      outcomes: [
        landed('divergence', 1),
        landed('second', 2),
        landed('third', 3),
        landed('fourth', 4),
      ],
    }
    expect(forkEvidence(snapshot, 4, 'competitor')).toEqual({
      conflictEpoch: 4,
      sharedPosition: asLogPosition('000000000003'),
      frameDigest: 'competitor',
    })
    const result = applyChanges(snapshot, forkSettlement(snapshot, 4, applied(5)))
    expect(result.applied).toEqual([
      applied(1, 'divergence'),
      applied(2, 'second'),
      applied(3, 'third'),
      applied(5),
    ])
    expect(result.outcomes).toEqual([
      landed('divergence', 1),
      landed('second', 2),
      landed('third', 3),
      expect.objectContaining({ opID: 'fourth', kind: 'unknown' }),
    ])
  })

  test('forged lower-position conflict proves no outcome beyond unknown', () => {
    const snapshot = { ...empty(), applied: [applied(2, 'invite')] }
    const evidence = forkEvidence(snapshot, 2, 'fake-commit')
    expect(evidence.sharedPosition).toBeNull()
    const result = applyChanges(
      snapshot,
      forkSettlement(snapshot, evidence.conflictEpoch, applied(3)),
    )
    expect(result.outcomes).toEqual([expect.objectContaining({ opID: 'invite', kind: 'unknown' })])
  })

  test('an invite accepted on the losing branch is unknown and its Welcome obligation stays durable', () => {
    const invite = { ...operation('invite', 1, 'accepted'), kind: 'invite' as const }
    const obligation = { opID: invite.id, welcome: new Uint8Array([7]), recipients: ['dave'] }
    const snapshot = { ...empty(), operations: [invite], welcomes: [obligation] }
    const result = applyChanges(snapshot, forkSettlement(snapshot, 4, applied(5)))
    expect(result.operations).toEqual([])
    expect(result.outcomes).toEqual([expect.objectContaining({ opID: 'invite', kind: 'unknown' })])
    expect(result.welcomes).toEqual([obligation])
  })

  test.each([2, 3])(
    'reads an own landed row before the rejoin replaces it at epoch %s',
    (epoch) => {
      const rejoin = { ...applied(epoch), digest: 'rejoin' }
      const snapshot = {
        ...empty(),
        applied: [applied(1), applied(2, 'own'), applied(3, 'later')],
        outcomes: [landed('own', 2), landed('later', 3)],
      }
      const result = applyChanges(snapshot, forkSettlement(snapshot, 2, rejoin))
      expect(result.applied).toEqual([applied(1), rejoin])
      expect(result.outcomes).toEqual([
        expect.objectContaining({ opID: 'own', kind: 'unknown' }),
        expect.objectContaining({ opID: 'later', kind: 'unknown' }),
      ])
    },
  )

  test.each(['host', 'double'] as const)(
    'settlement is atomic and survives an ambiguous %s write',
    async (provider) => {
      const database = createMemoryHostDatabase()
      const double = createMemoryControlStore<LogPosition>({ groupID: 'group-A', incarnation: 1 })
      const store =
        provider === 'host'
          ? database.control('group', { groupID: 'group', incarnation: 1 })
          : double
      await store.apply(
        {
          putOperations: [operation('accepted', 1, 'accepted')],
          putApplied: [applied(1), applied(2, 'own')],
          putOutcomes: [landed('own', 2)],
        },
        'seed',
      )
      const before = await store.load()
      const rejoin = { ...applied(2), digest: 'rejoin' }
      const changes = forkSettlement(before, 2, rejoin)
      if (provider === 'host') database.failNext('mid-apply')
      else double.failNext('mid-apply')
      await expect(store.apply(changes, 'failed')).rejects.toThrow('Injected')
      expect(await store.load()).toEqual(before)
      expect(await store.lastMutation()).toBe('seed')
      if (provider === 'host') database.commitThenRejectNext('apply')
      else double.commitThenRejectNext('apply')
      await applyResolved(store, changes, 'settled')
      const reopened =
        provider === 'host'
          ? database.control('group', { groupID: 'group', incarnation: 1 })
          : double
      expect(await reopened.lastMutation()).toBe('settled')
      expect(await reopened.load()).toMatchObject({
        operations: [],
        applied: [applied(1), rejoin],
        outcomes: [
          expect.objectContaining({ opID: 'own', kind: 'unknown' }),
          expect.objectContaining({ opID: 'accepted', kind: 'unknown' }),
        ],
      })
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

describe('durable fork evidence', () => {
  test('a fork loser restarts and writes strand and evidence together when the winner is shown', async () => {
    const hub = new FakeHub()
    const shared = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
    })
    const winner = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 2,
    })
    const loser = await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 2 })
    hub.hideFrom('bob', winner.sequenceID)
    const seed = member(hub)
    await seed.peer.replay()
    expect(seed.mls.epoch()).toBe(3)
    await seed.peer.dispose()
    await seed.peer.drained()
    const again = member(hub, { restartOf: seed })
    await again.peer.replay()
    const cursor = (await again.control.load()).cursor
    again.database.seam('after-apply', () => {
      void again.peer.dispose()
    })
    hub.revealTo('bob', winner.sequenceID)
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      payload: new Uint8Array([0]),
    })
    await expect.poll(async () => (await again.control.load()).cursor?.stranded).toBe(true)
    await again.peer.dispose()
    await again.peer.drained()
    const evidence = {
      conflictEpoch: 2,
      sharedPosition: asLogPosition(shared.sequenceID),
      frameDigest: publishedCommitDigest(hub, winner.sequenceID),
    }
    expect(await again.control.load()).toMatchObject({
      rejoin: null,
      outcomes: [],
      cursor: { ...cursor, position: loser.sequenceID, stranded: true, fork: evidence },
    })
    expect(hub.published.filter((row) => row.topicID === rendezvousTopic(secret))).toEqual([])
    // The hub never serves the competing frame again.
    hub.hideFrom('bob', winner.sequenceID)
    const restarted = member(hub, { restartOf: again })
    await expect
      .poll(() => hub.published.filter((row) => row.topicID === rendezvousTopic(secret)).length)
      .toBeGreaterThan(0)
    expect((await restarted.control.load()).cursor).toEqual({
      ...cursor,
      stranded: true,
      fork: evidence,
    })
    await restarted.peer.enqueue(buildLedgerCommit(restarted, []))
  })

  test('later fork reveals preserve the earliest known conflict epoch for settlement', async () => {
    const hub = new FakeHub()
    const shared = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
    })
    const winner = await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 2,
    })
    await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 2 })
    const later = await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 3 })
    await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 3 })
    hub.hideFrom('bob', winner.sequenceID)
    hub.hideFrom('bob', later.sequenceID)
    const observations: Array<StrandObservation> = []
    const bob = member(hub, {
      onStrand: (observation) => {
        observations.push(observation)
      },
    })
    await bob.peer.replay()
    expect(bob.mls.epoch()).toBe(4)
    const cursor = (await bob.control.load()).cursor
    hub.revealTo('bob', winner.sequenceID)
    hub.revealTo('bob', later.sequenceID)
    await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      payload: new Uint8Array([0]),
    })
    await expect
      .poll(() => observations.map((observation) => observation.claimedEpoch))
      .toEqual([2])
    expect((await bob.control.load()).cursor).toEqual({
      ...cursor,
      stranded: true,
      fork: {
        conflictEpoch: 2,
        sharedPosition: asLogPosition(shared.sequenceID),
        frameDigest: publishedCommitDigest(hub, winner.sequenceID),
      },
    })
  })

  test.each(['live', 'restart'] as const)(
    'a moved acceptance with a matching digest but different payload persists fork evidence on %s',
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
        controlHold: {
          reason: 'fork-evidence',
          position: row.sequenceID,
          evidence: {
            kind: 'digest-divergence',
            epoch: 1,
            position: row.sequenceID,
            localDigest: row.payloadDigest,
            remoteDigest: accepted.built.payloadDigest,
          },
        },
        strand: { reason: 'lost-state' },
        cursor: {
          ...snapshot.cursor,
          stranded: true,
        },
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

  async function healStoredFork(
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
    const accepted = { ...operation('invite', 1, 'accepted'), kind: 'invite' as const }
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
          stranded: true,
          fork: { conflictEpoch: 1, sharedPosition: null, frameDigest: 'withheld-competitor' },
        },
      },
      'stored-fork',
    )
    await bob.peer.dispose()
    await bob.peer.drained()
    const restarted = member(hub, {
      restartOf: bob,
      recovery: { timeoutMs: 30, deadlineMs: 300, getDelayMs: () => 0 },
      adopt: async () => 'moved',
    })
    await expect
      .poll(
        async () => {
          const snapshot = await restarted.control.load()
          return (
            snapshot.rejoin == null &&
            snapshot.outcomes.some(
              (outcome) => outcome.opID === 'own' && outcome.kind === 'unknown',
            )
          )
        },
        { timeout: 5000 },
      )
      .toBe(true)
    return { hub, alice, restarted, snapshot: await restarted.control.load() }
  }

  test('rejoin uses stored fork evidence after a crash before its build', async () => {
    const { snapshot } = await healStoredFork()
    expect(snapshot.outcomes).toEqual([
      landed('older', 0),
      expect.objectContaining({ opID: 'own', kind: 'unknown' }),
      expect.objectContaining({ opID: 'later', kind: 'unknown' }),
    ])
    expect(snapshot.cursor?.fork).toBeUndefined()
  })
  test('a forged lower-position conflict heals without asserting which operation won', async () => {
    const { snapshot } = await healStoredFork()
    expect(
      snapshot.outcomes
        .filter((outcome) => outcome.opID !== 'older')
        .map((outcome) => outcome.kind),
    ).toEqual(['unknown', 'unknown'])
  })
  test('rejoin settles a losing-branch invite as unknown and its roster decides membership', async () => {
    const { restarted, snapshot } = await healStoredFork({ acceptedInvite: true })
    expect(snapshot.operations).toEqual([])
    expect(restarted.mls.leaves()).not.toContain('dave')
    expect(snapshot.outcomes).toContainEqual(
      expect.objectContaining({ opID: 'invite', kind: 'unknown' }),
    )
    expect(await restarted.mls.rosterEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ did: 'alice' }),
        expect.objectContaining({ did: 'bob' }),
      ]),
    )
  })
  test('rejoin adoption overwrites an own landed row only after settling its operation as unknown', async () => {
    const { snapshot } = await healStoredFork({ collision: true })
    expect(snapshot.applied).toEqual([expect.objectContaining({ epoch: 1, opID: null })])
    expect(snapshot.outcomes).toEqual([expect.objectContaining({ opID: 'own', kind: 'unknown' })])
  })
  test('fork loser restart and winner reveal produce unknown and reenact outcomes', async () => {
    const { snapshot } = await healStoredFork({ reenact: true })
    expect(snapshot.outcomes).toContainEqual(
      expect.objectContaining({ kind: 'reenact', tokens: ['branch-token'] }),
    )
    expect(snapshot.outcomes).toContainEqual(
      expect.objectContaining({ opID: 'own', kind: 'unknown' }),
    )
  })
  test('final rejoin apply retains its row at or above the conflict epoch', async () => {
    const { snapshot, restarted } = await healStoredFork()
    const rows = snapshot.applied
    expect(rows).toEqual([applied(0, 'older'), expect.objectContaining({ epoch: 1, opID: null })])
    await restarted.peer.replay()
    expect((await restarted.control.load()).applied).toEqual(rows)
  })
})
