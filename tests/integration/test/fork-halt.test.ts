import { commitKeyRotation } from '@kumiai/mls'
import {
  ControlSafetyImmutableError,
  encodeCommitFrame,
  encodeHandshakeFrame,
  forkEventID,
  GroupSafetyHeldError,
  HANDSHAKE_KIND,
  SendNotAdmissibleError,
} from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { bareTestHandle } from '../../../packages/mls-rpc/test/fixtures/real-group.js'
import { operationRequest } from './app-lane-e2e.js'
import {
  createCapturedRecoveryFixture,
  createForkFixture,
  type ForkFixture,
  observeForkWork,
  observeStartup,
} from './fixtures/fork-halt.js'

const fixtures: Array<Pick<ForkFixture, 'close'>> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup() {
  const fixture = await createForkFixture()
  fixtures.push(fixture)
  return fixture
}

async function refuseWork(f: ForkFixture) {
  const chat = f.member.peer.protocol('chat')
  for (const procedure of ['chat/posted', 'chat/changed'] as const)
    await expect(chat.dispatch(procedure, { data: {} })).rejects.toEqual(
      new SendNotAdmissibleError('fork-halted'),
    )
  await expect(chat.request('chat/double', { param: {} })).rejects.toEqual(
    new SendNotAdmissibleError('fork-halted'),
  )
  await expect(chat.gather('chat/double', { param: {} })).rejects.toEqual(
    new SendNotAdmissibleError('fork-halted'),
  )
  await expect(chat.to(f.real.committer.identity.id)).rejects.toEqual(
    new SendNotAdmissibleError('fork-halted'),
  )
  const request = {
    id: crypto.randomUUID(),
    kind: 'rotation' as const,
    revokes: false,
    body: new Uint8Array(),
    timeoutMs: 1000,
  }
  await expect(f.member.peer.enqueue(request)).rejects.toEqual(
    new GroupSafetyHeldError('fork-halted'),
  )
  await expect(f.member.peer.commit(request)).rejects.toEqual(
    new GroupSafetyHeldError('fork-halted'),
  )
  await expect(f.member.peer.recover()).rejects.toEqual(new GroupSafetyHeldError('fork-halted'))
  await expect(f.member.peer.resync()).rejects.toEqual(new GroupSafetyHeldError('fork-halted'))
  expect(() => f.member.peer.reauthorize()).toThrow(new GroupSafetyHeldError('fork-halted'))
  await f.member.peer.replay()
  await f.member.peer.retryAppDelivery()
}

test.each(['losing', 'winning'] as const)(
  'real %s past divergence preserves history and permits survivor progress',
  async (branch) => {
    const f = await setup()
    const fork = await f.competing(branch)
    const before = await f.member.control.load()
    expect(await fork.reveal({ following: false })).toBe(false)
    const after = await f.member.control.load()
    expect(after.forkHalt).toBeNull()
    expect(after.applied).toEqual(before.applied)
    expect(after.cursor?.position).toBe(
      fork.appliedPosition > fork.evidence.position ? fork.appliedPosition : fork.evidence.position,
    )
    expect(after.responses).toEqual(before.responses)
    expect(after.outcomes).toEqual(before.outcomes)
    expect(after.welcomes).toEqual(before.welcomes)
    expect(after.strand).toEqual(before.strand)
    expect(f.member.controlWalk.safetyHold()).toBeNull()
    expect(f.member.access.epoch()).toBe(fork.evidence.epoch + 1)
    expect(f.onStrand).toHaveBeenCalledExactlyOnceWith({
      groupID: f.topic,
      position: fork.evidence.position,
      commitDigest: fork.evidence.remoteDigest,
      localEpoch: fork.evidence.epoch + 1,
      claimedEpoch: fork.evidence.epoch,
      kind: 'past-epoch-divergence',
      confidence: 'claimed',
    })
    expect(await f.safety().events(f.key)).toEqual([])
    expect(f.onSafetyEvent).not.toHaveBeenCalled()
    expect(f.onRecovery).not.toHaveBeenCalled()
    await f.restart()
    expect((await f.member.control.load()).applied).toEqual(before.applied)
    expect(f.member.controlWalk.safetyHold()).toBeNull()
    expect(await fork.reveal()).toBe(true)
    expect(f.member.access.epoch()).toBe(fork.evidence.epoch + 2)
    expect((await f.member.control.load()).applied.slice(0, before.applied.length)).toEqual(
      before.applied,
    )
    await expect(
      f.member.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
    ).resolves.toBeUndefined()
  },
)

test('host mismatch halts registry then peer on refresh and reconstruction', async () => {
  const f = await setup()
  const access = await f.registry.registry.access(f.key.groupID)
  const evidence = await f.authenticatorEvidence()
  await f.safety().reportFork(f.key, evidence)
  const stored = await f.member.control.load()
  expect(stored.forkHalt?.evidence).toEqual(evidence)
  expect(await f.registry.device.groups.ports(f.key).control.load()).toEqual(stored)
  expect(access.admission()).toMatchObject({ admissible: false, reason: 'fork-halted' })
  expect(await f.safety().events(f.key)).toEqual([
    { ...f.key, id: forkEventID(f.key), kind: 'group:fork', halt: stored.forkHalt },
  ])
  // Registry admission reaches this consumer only when it refreshes its control store.
  expect(f.member.controlWalk.safetyHold()).toBeNull()
  await f.member.peer.replay()
  expect(f.member.controlWalk.safetyHold()).toBe('fork-halted')
  await refuseWork(f)
  await f.restart()
  expect((await f.registry.registry.access(f.key.groupID)).admission()).toMatchObject({
    admissible: false,
    reason: 'fork-halted',
  })
  expect((await f.member.control.load()).forkHalt).toEqual(stored.forkHalt)
  await refuseWork(f)
  expect(f.onSafetyEvent).not.toHaveBeenCalled()
})

test('durable halt restart loads before network without owed obligations', async () => {
  const f = await setup()
  await f.safety().reportFork(f.key, await f.authenticatorEvidence())
  await f.stopPeer()
  const startup = observeStartup(f.hub)
  await f.restart({ beforeReady: (next) => Object.assign(startup, observeForkWork(next)) })
  expect(f.member.controlWalk.safetyHold()).toBe('fork-halted')
  for (const [name, counter] of Object.entries(startup))
    expect(counter, name).not.toHaveBeenCalled()
  await refuseWork(f)
  for (const [name, counter] of Object.entries(startup))
    expect(counter, name).not.toHaveBeenCalled()
})

test('clean real-MLS restart exercises the startup counters', async () => {
  const f = await setup()
  await f.stopPeer()
  const startup = observeStartup(f.hub)
  await f.restart()
  expect(startup.receive).toHaveBeenCalledOnce()
  expect(startup.start).toHaveBeenCalledOnce()
  expect(startup.subscribe).toHaveBeenCalled()
  expect(startup.fetch).toHaveBeenCalled()
  expect(startup.retain).toHaveBeenCalled()
  expect(startup.buildEpoch).toHaveBeenCalledOnce()
})

test('ack retains immutable evidence and event identity after reopen', async () => {
  const f = await setup()
  await f.safety().reportFork(f.key, await f.authenticatorEvidence())
  await f.restart()
  const [event] = await f.safety().events(f.key)
  expect(event?.id).toBe(forkEventID(f.key))
  if (event === undefined || event.kind !== 'group:fork') throw new Error('Missing fork event')
  expect(event.halt).toEqual((await f.member.control.load()).forkHalt)
  await expect(f.registry.device.groups.ports(f.key).outbox.ackEvent(event.id)).rejects.toThrow(
    TypeError,
  )
  await f.safety().ackEvent(f.key, event.id)
  await f.restart()
  expect(await f.safety().events(f.key)).toEqual([])
  expect((await f.member.control.load()).forkHalt).toEqual(event.halt)
  await expect(
    f.safety().reportFork(f.key, { ...event.halt.evidence, epoch: 0 }),
  ).resolves.toBeUndefined()
  await f.member.control.apply({ forkHalt: event.halt }, crypto.randomUUID())
  await expect(
    f.member.control.apply(
      { forkHalt: { ...event.halt, detectedAt: event.halt.detectedAt + 1 } },
      crypto.randomUUID(),
    ),
  ).rejects.toBeInstanceOf(ControlSafetyImmutableError)
  expect(await f.safety().events(f.key)).toEqual([])
  const fresh = await f.registry.makeHandle(f.member.access.epoch() + 1)
  await expect(
    f.registry.registry.seed(fresh, {
      replace: true,
      packageUse: { sourceID: 'fork-readmission', ref: crypto.randomUUID(), kind: 'ordinary' },
    }),
  ).rejects.toMatchObject({ reason: 'fork-halted' })
  expect((await f.member.control.load()).forkHalt).toEqual(event.halt)
  await refuseWork(f)
})

test.each(['throw', 'reject'] as const)(
  'commit before notification replays durable event after callback %s',
  async (kind) => {
    const f = await setup()
    f.onSafetyEvent.mockImplementation(() => {
      if (kind === 'throw') throw new Error('host notification fault')
      return Promise.reject(new Error('host notification fault'))
    })
    await f.member.controlWalk.haltFork(await f.authenticatorEvidence())
    expect(f.onSafetyEvent).toHaveBeenCalledOnce()
    const events = await f.safety().events(f.key)
    await f.restart()
    expect(await f.safety().events(f.key)).toEqual(events)
    expect(f.onSafetyEvent).toHaveBeenCalledOnce()
    expect((await f.member.control.load()).forkHalt).toEqual(
      events[0]?.kind === 'group:fork' ? events[0].halt : undefined,
    )
    await refuseWork(f)
  },
)

test.each(['commit', 'rollback'] as const)(
  'delayed COMMIT proof emits only after proof: %s',
  async (outcome) => {
    const f = await setup()
    const before = await f.registry.inspectRows()
    const fault = f.registry.armNextWorkFault('pending')
    const apply = f.member.control.apply.bind(f.member.control)
    const writes = vi.spyOn(f.member.control, 'apply')
    const retryEntered = Promise.withResolvers<void>()
    const retryRelease = Promise.withResolvers<void>()
    let attempts = 0
    writes.mockImplementation(async (changes, mutationID) => {
      if (changes.forkHalt !== undefined && ++attempts === 2) {
        retryEntered.resolve()
        await retryRelease.promise
      }
      return apply(changes, mutationID)
    })
    const halting = f.member.controlWalk.haltFork(await f.authenticatorEvidence())
    let proofFinished = false
    try {
      await fault.rejected
      expect(f.member.controlWalk.safetyHold()).toBe('fork-halted')
      expect(f.onSafetyEvent).not.toHaveBeenCalled()
      expect(await f.registry.inspectRows()).toEqual(before)
      await expect(
        f.member.peer.protocol('chat').dispatch('chat/posted', { data: {} }),
      ).rejects.toEqual(new SendNotAdmissibleError('fork-halted'))
      await fault.finish(outcome)
      proofFinished = true
      if (outcome === 'rollback') {
        await retryEntered.promise
        expect(f.onSafetyEvent).not.toHaveBeenCalled()
        expect(await f.safety().events(f.key)).toEqual([])
        expect((await f.member.control.load()).forkHalt).toBeNull()
        const bodies = writes.mock.calls.filter(([changes]) => changes.forkHalt !== undefined)
        expect(bodies).toHaveLength(2)
        expect(bodies[1]?.[0].forkHalt).toEqual(bodies[0]?.[0].forkHalt)
        expect(bodies[1]?.[1]).not.toBe(bodies[0]?.[1])
      }
    } finally {
      retryRelease.resolve()
      if (!proofFinished) await fault.finish('rollback')
    }
    await halting
    expect(f.onSafetyEvent).toHaveBeenCalledOnce()
    expect(await f.safety().events(f.key)).toEqual([f.onSafetyEvent.mock.calls[0]?.[0]])
    await f.restart()
    expect(await f.safety().events(f.key)).toEqual([f.onSafetyEvent.mock.calls[0]?.[0]])
  },
)

test('one-shot host halt rollback retries retained body using storage alone', async () => {
  const f = await setup()
  const evidence = await f.authenticatorEvidence()
  const before = await f.member.control.load()
  const fault = f.registry.armNextWorkFault('pending')
  const apply = f.member.control.apply.bind(f.member.control)
  const attempts = vi.spyOn(f.member.control, 'apply').mockImplementation(apply)
  const halting = f.member.controlWalk.haltFork(evidence)
  await fault.rejected
  expect(f.onSafetyEvent).not.toHaveBeenCalled()
  const network = observeStartup(f.hub)
  await fault.finish('rollback')
  await halting
  const bodies = attempts.mock.calls.filter(([changes]) => changes.forkHalt !== undefined)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]?.[0].forkHalt).toEqual(bodies[0]?.[0].forkHalt)
  expect((await f.member.control.load()).forkHalt?.evidence).toEqual(evidence)
  expect((await f.member.control.load()).applied).toEqual(before.applied)
  expect((await f.member.control.load()).cursor).toEqual(before.cursor)
  for (const [name, counter] of Object.entries(network))
    expect(counter, name).not.toHaveBeenCalled()
})

test('crash before a host halt commits cannot reconstruct the volatile evidence', async () => {
  const f = await setup()
  const evidence = await f.authenticatorEvidence()
  const fault = f.registry.armNextWorkFault('pending')
  const halting = f.member.controlWalk.haltFork(evidence)
  await fault.rejected
  expect(f.member.controlWalk.safetyHold()).toBe('fork-halted')
  expect(f.onSafetyEvent).not.toHaveBeenCalled()
  const stopping = f.member.peer.dispose()
  // Observe closed admission before resolving rollback and releasing the storage retry.
  try {
    await expect
      .poll(
        async () => {
          try {
            await f.member.peer.replay()
            return null
          } catch (error) {
            if (error instanceof Error) return error.name
            throw error
          }
        },
        { timeout: 1000 },
      )
      .toBe('PeerDisposedError')
  } finally {
    await fault.finish('rollback')
  }
  await stopping
  await f.member.peer.drained()
  await halting
  await f.restart()
  // The crash loses the volatile body. Storage cannot recreate an uncommitted host report.
  expect((await f.member.control.load()).forkHalt).toBeNull()
  expect(await f.safety().events(f.key)).toEqual([])
  expect(f.member.controlWalk.safetyHold()).toBeNull()
  expect(f.onSafetyEvent).not.toHaveBeenCalled()
})

test('missing applied history remains non-fork with real past commits', async () => {
  const f = await setup()
  const fork = await f.competing('losing')
  await f.member.control.apply(
    { deleteAppliedBelow: Number.MAX_SAFE_INTEGER + 1 },
    crypto.randomUUID(),
  )
  expect(await fork.reveal({ following: false })).toBe(false)
  expect((await f.member.control.load()).forkHalt).toBeNull()
  expect(await f.safety().events(f.key)).toEqual([])
  expect(f.member.controlWalk.safetyHold()).toBeNull()
})

test('certified losing replay remains non-fork with real competing commits', async () => {
  const f = await setup()
  const fork = await f.competing('winning')
  const certificate = await fork.certify()
  const before = await f.member.control.load()
  expect(await fork.reveal({ following: false, range: certificate })).toBe(false)
  expect((await f.member.control.load()).forkHalt).toBeNull()
  expect((await f.member.control.load()).applied).toEqual(before.applied)
  expect(await f.safety().events(f.key)).toEqual([])
  expect(f.onStrand).not.toHaveBeenCalled()
})

test('ordinary gap recovery still heals and confirms with real MLS', async () => {
  const f = await setup()
  const survivor = await f.survivor()
  const initial = await commitKeyRotation(await bareTestHandle(f.real.committer.handle))
  await survivor.access.replace(initial.newGroup)
  await f.publish(initial.commitMessage, f.real.committer.handle)
  await f.member.peer.replay()
  expect(f.member.access.epoch()).toBe(Number(initial.newGroup.epoch))
  await f.stopPeer()
  const missed = await commitKeyRotation(await bareTestHandle(initial.newGroup))
  await survivor.access.replace(missed.newGroup)
  await f.publish(missed.commitMessage, initial.newGroup)
  const afterGap = await commitKeyRotation(await bareTestHandle(missed.newGroup))
  await survivor.access.replace(afterGap.newGroup)
  const retained = await f.publish(afterGap.commitMessage, missed.newGroup)
  f.hub.trim(f.topic, retained.sequenceID)
  const recoveredEpoch = Number(afterGap.newGroup.epoch) + 1
  await f.restart()
  await vi.waitFor(() => expect(f.member.access.epoch()).toBe(survivor.access.epoch()))
  expect(f.member.access.epoch()).toBe(recoveredEpoch)
  expect((await f.member.control.load()).forkHalt).toBeNull()
  expect(f.member.controlWalk.safetyHold()).toBeNull()
  await vi.waitFor(() =>
    expect(f.onRecovery).toHaveBeenCalledWith(expect.objectContaining({ phase: 'succeeded' })),
  )
  expect(await f.safety().events(f.key)).toEqual([])
  await expect(
    f.member.peer.protocol('chat').dispatch('chat/changed', { data: {} }),
  ).resolves.toBeUndefined()
})

test('an orphaned real own commit diagnoses a contradiction and permits the next valid commit', async () => {
  const f = await setup()
  const before = await f.member.control.load()
  const receiver = f.real.members[0]
  if (receiver === undefined) throw new Error('Missing receiver')
  const own = await commitKeyRotation(await bareTestHandle(receiver.handle))
  const copied = await f.publish(own.commitMessage, receiver.handle)
  await f.member.peer.replay()
  const after = await f.member.control.load()
  expect(after.cursor?.position).toBe(copied.sequenceID)
  expect(after.applied).toEqual(before.applied)
  expect(after.outcomes).toEqual(before.outcomes)
  expect(after.welcomes).toEqual(before.welcomes)
  expect(after.forkHalt).toBeNull()
  expect(after.controlHold).toBeNull()
  const valid = await commitKeyRotation(await bareTestHandle(f.real.committer.handle))
  await f.publish(valid.commitMessage, f.real.committer.handle)
  await f.member.peer.replay()
  expect(f.member.access.epoch()).toBe(Number(valid.newGroup.epoch))
  expect(await f.safety().events(f.key)).toEqual([])
  expect(f.onRecovery).not.toHaveBeenCalled()
})

test.each(['handshake', 'commit-frame'] as const)(
  'an unknown real %s version advances with a diagnostic and leaves later work usable',
  async (version) => {
    const f = await setup()
    const before = await f.member.control.load()
    const rotated = await commitKeyRotation(await bareTestHandle(f.real.committer.handle))
    const frame = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(rotated.commitMessage, new Uint8Array()),
    )
    frame[version === 'handshake' ? 2 : 4] = 255
    const unknown = await f.hub.publish({
      senderDID: f.real.committer.identity.id,
      topicID: f.topic,
      retain: 'log',
      payload: frame,
    })
    await f.member.peer.replay()
    const snapshot = await f.member.control.load()
    expect(snapshot.cursor?.position).toBe(unknown.sequenceID)
    expect(snapshot.applied).toEqual(before.applied)
    expect(snapshot.forkHalt).toBeNull()
    expect(snapshot.controlHold).toBeNull()
    expect(f.onStrand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unknown-version', diagnostic: 'upgrade-required' }),
    )
    await f.publish(rotated.commitMessage, f.real.committer.handle)
    await f.member.peer.replay()
    expect(f.member.access.epoch()).toBe(Number(rotated.newGroup.epoch))
    expect(await f.safety().events(f.key)).toEqual([])
    expect(f.onRecovery).not.toHaveBeenCalled()
  },
)

test('a live registry host report holds the peer synchronously without waiting for control refresh', async () => {
  const f = await createCapturedRecoveryFixture()
  fixtures.push(f)
  const before = await (await f.bob.fixture.registry.access(f.bob.key.groupID)).read(
    (handle) => handle,
  )
  const other = (await commitKeyRotation(await bareTestHandle(before))).newGroup
  await f.bob.peer.commit(operationRequest('rotation', {}))
  const safety = f.bob.fixture.safety()
  const local = await safety.epochAuthenticator(f.bob.key)
  if (local === null) throw new Error('Missing committed identity')
  expect(local.epoch).toBe(Number(other.epoch))
  const remote = other.state.keySchedule.epochAuthenticator.slice()
  expect(remote).not.toEqual(local.authenticator)
  const held = await f.bob.control.load()
  await safety.reportFork(f.bob.key, {
    kind: 'epoch-authenticator',
    epoch: local.epoch,
    local: local.authenticator,
    remote,
  })
  expect(f.bob.mls.sendAdmission()).toEqual({
    epoch: local.epoch,
    admissible: false,
    reason: 'fork-halted',
  })
  await expect(f.bob.peer.protocol('chat').dispatch('chat/changed', { data: {} })).rejects.toEqual(
    new SendNotAdmissibleError('fork-halted'),
  )
  await expect(f.bob.peer.recover()).rejects.toEqual(new GroupSafetyHeldError('fork-halted'))
  const snapshot = await f.bob.control.load()
  expect(snapshot.forkHalt).not.toBeNull()
  expect(snapshot.applied).toEqual(held.applied)
  expect(snapshot.outcomes).toEqual(held.outcomes)
  expect(snapshot.welcomes).toEqual(held.welcomes)
})
