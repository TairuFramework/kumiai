import { afterEach, expect, test, vi } from 'vitest'

import { reportLiveBuild } from '../src/control/operations.js'
import { forkEventID } from '../src/control/safety.js'
import { closeControlBuild, consumeOwnOccurrence } from '../src/control/slot.js'
import { asLogPosition } from '../src/cursor.js'
import { StorageOutcomeUnknownError } from '../src/errors.js'
import { commitTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  makeMLSPeer,
  seedBuiltOperation,
  type TestPeer,
} from './fixtures/peer.js'

const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const member of peers.splice(0)) {
    await member.peer.dispose()
    await member.peer.drained()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('acknowledging a provisional ID after own installation preserves the fresh final outcome', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(67)
  const member = makeMLSPeer(hub, 'alice', secret)
  peers.push(member)
  await member.peer.replay()
  const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
  vi.useFakeTimers()
  vi.setSystemTime(saved.slot.deadline)
  await member.controlWalk.stepOperation(saved.id)
  const provisional = (await member.peer.outcomes())[0]
  if (provisional === undefined) throw new Error('Missing provisional report')
  expect(provisional).toMatchObject({ opID: saved.id, kind: 'unknown' })
  expect((await member.control.load()).commitOnce?.reported).toBe(true)
  await hub.publish({
    topicID: commitTopic(secret),
    senderDID: 'alice',
    payload: saved.slot.payload,
    publishID: saved.slot.publishID,
    retain: 'log',
  })
  await member.peer.replay()
  const final = (await member.peer.outcomes())[0]
  expect(final).toMatchObject({ opID: saved.id, kind: 'landed' })
  expect(final?.id).not.toBe(provisional.id)
  expect((await member.control.load()).commitOnce).toBeNull()
  await member.peer.ack(provisional.id)
  await member.peer.replay()
  expect(await member.peer.outcomes()).toEqual([final])
  expect(member.mls.epoch()).toBe(2)
})

test('fork halt evidence survives restart and returned byte mutation', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(68)
  const member = makeMLSPeer(hub, 'alice', secret)
  peers.push(member)
  await member.peer.replay()
  const evidence = {
    kind: 'epoch-authenticator' as const,
    epoch: 1,
    local: new Uint8Array([1, 2]),
    remote: new Uint8Array([3, 4]),
  }
  await member.controlWalk.haltFork(evidence)
  const expected = structuredClone((await member.control.load()).forkHalt)
  evidence.local.fill(9)
  evidence.remote.fill(9)
  const exposed = (await member.control.load()).forkHalt
  if (exposed?.evidence.kind !== 'epoch-authenticator') throw new Error('Missing halt evidence')
  exposed.evidence.local.fill(8)
  exposed.evidence.remote.fill(8)
  expect((await member.control.load()).forkHalt).toEqual(expected)
  await member.peer.dispose()
  await member.peer.drained()
  const onSafetyEvent = vi.fn()
  const again = makeMLSPeer(hub, 'alice', secret, { restartOf: member, onSafetyEvent })
  peers.push(again)
  await again.peer.replay()
  expect((await again.control.load()).forkHalt).toEqual(expected)
  expect(again.controlWalk.safetyHold()).toBe('fork-halted')
  expect(onSafetyEvent).not.toHaveBeenCalled()
})

test('clock reporting during validation leaves only the fresh final outcome after installation', async () => {
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(70))
  peers.push(member)
  await member.peer.replay()
  const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
  const restore = member.validation.restoreValidation.bind(member.validation)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(member.validation, 'restoreValidation').mockImplementation(async (built) => {
    entered.resolve()
    await release.promise
    return restore(built)
  })
  await hub.publish({
    senderDID: 'alice',
    topicID: commitTopic(new Uint8Array(32).fill(70)),
    retain: 'log',
    payload: saved.slot.payload,
  })
  const walking = member.controlWalk.walkCommits()
  try {
    await entered.promise
    await reportLiveBuild({
      control: member.control,
      now: () => saved.deadline,
      newID: () => crypto.randomUUID(),
      emit: vi.fn(),
    })
    expect((await member.control.load()).outcomes).toHaveLength(1)
  } finally {
    release.resolve()
  }
  await walking
  expect((await member.control.load()).commitOnce).toBeNull()
  expect((await member.control.load()).outcomes).toMatchObject([{ opID: saved.id, kind: 'landed' }])
  expect((await member.control.load()).outcomes).toHaveLength(1)
})

test('ambiguous own installation obeys an aborted signal without another installation', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(70))
  peers.push(member)
  await member.peer.replay()
  const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
  const before = await member.control.load()
  const entered = Promise.withResolvers<void>()
  const read = Promise.withResolvers<string | null>()
  vi.spyOn(member.control, 'lastMutation').mockImplementation(async () => {
    entered.resolve()
    return await read.promise
  })
  const adopt = vi.fn().mockRejectedValue(new StorageOutcomeUnknownError())
  const emit = vi.fn()
  const controller = new AbortController()
  const installing = consumeOwnOccurrence(
    {
      control: member.control,
      signal: controller.signal,
      validation: member.validation,
      adoption: { adopt },
      now: () => 123,
      newID: () => crypto.randomUUID(),
      emit,
    },
    { position: asLogPosition('000001'), payload: saved.slot.payload, senderDID: 'alice' },
  )
  const settled = installing.catch((error: unknown) => error)
  const reason = new Error('Installation owner stopped')
  try {
    await vi.waitFor(() => expect(member.control.lastMutation).toHaveBeenCalledOnce())
    await entered.promise
    controller.abort(reason)
    expect(await settled).toBe(reason)
    expect(adopt).toHaveBeenCalledOnce()
    expect(await member.control.load()).toEqual(before)
    expect(member.mls.epoch()).toBe(1)
    expect(emit).not.toHaveBeenCalled()
  } finally {
    controller.abort(reason)
    read.resolve(null)
    await settled
  }
})

test('a stale installation under a safety hold changes no final outcome', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(69))
  peers.push(member)
  await member.peer.replay()
  const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const restore = member.validation.restoreValidation.bind(member.validation)
  vi.spyOn(member.validation, 'restoreValidation').mockImplementation(async (built) => {
    const validation = await restore(built)
    entered.resolve()
    await release.promise
    return validation
  })
  const emit = vi.fn()
  const installing = consumeOwnOccurrence(
    {
      control: member.control,
      validation: member.validation,
      adoption: { adopt: member.mls.adoptOperation },
      now: () => 123,
      newID: () => crypto.randomUUID(),
      emit,
    },
    { position: asLogPosition('000001'), payload: saved.slot.payload, senderDID: 'alice' },
  )
  try {
    await entered.promise
    await member.control.apply(
      {
        forkHalt: {
          eventID: forkEventID(member.control.key),
          detectedAt: 123,
          evidence: {
            kind: 'unexplained-own-commit',
            epoch: 1,
            position: '000001',
            digest: 'host',
          },
        },
      },
      'host-halt',
    )
    const before = await member.control.load()
    release.resolve()
    await expect(installing).resolves.toBe('moved')
    expect(await member.control.load()).toEqual(before)
    expect(member.mls.epoch()).toBe(1)
    expect(emit).not.toHaveBeenCalled()
  } finally {
    release.resolve()
  }
})

test.each(['landed', 'lost', 'unknown'] as const)(
  'closure %s preserves independent obligations and replaces provisional reports',
  async (kind) => {
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(67))
    try {
      await member.peer.replay()
      const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
      const provisional = { id: 'provisional', opID: saved.id, kind: 'unknown' as const, at: 1 }
      const obligation = {
        opID: 'prior-invite',
        welcome: new Uint8Array([7]),
        recipients: ['prior-guest'],
        committed: true as const,
      }
      await member.control.apply({ putOutcomes: [provisional], putWelcomes: [obligation] }, 'owed')
      const snapshot = await member.control.load()
      const changes = closeControlBuild(
        snapshot,
        kind === 'landed' ? { kind, position: asLogPosition('000002') } : { kind },
        2,
        'final',
      )
      expect(changes.commitOnce).toBeNull()
      expect(changes.deleteOutcomes).toEqual(['provisional'])
      expect(changes.putOutcomes).toMatchObject([{ id: 'final', opID: saved.id, at: 2, kind }])
      expect(changes.deleteWelcomes).toBeUndefined()
      expect(changes.putWelcomes).toEqual(
        kind === 'landed'
          ? [
              {
                opID: saved.id,
                welcome: saved.slot.welcome?.bytes,
                recipients: saved.slot.welcome?.recipients,
                committed: true,
              },
            ]
          : undefined,
      )
      expect((await member.control.load()).welcomes).toEqual([obligation])
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)
