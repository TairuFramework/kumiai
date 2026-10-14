import { commitKeyRotation } from '@kumiai/mls'
import {
  ControlSafetyImmutableError,
  forkEventID,
  GroupSafetyHeldError,
  SendNotAdmissibleError,
} from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import {
  createForkFixture,
  type ForkFixture,
  observeForkWork,
  observeStartup,
} from './fixtures/fork-halt.js'

const fixtures: Array<ForkFixture> = []
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
  'real %s divergence halts with exact commit digests and retained history',
  async (branch) => {
    const f = await setup()
    const fork = await f.competing(branch)
    const before = await f.member.control.load()
    const head = f.member.controlWalk.head()
    const work = observeForkWork(f)
    expect(await fork.reveal()).toBe(false)
    const after = await f.member.control.load()
    expect(after.forkHalt?.evidence).toEqual(fork.evidence)
    expect(after.applied).toEqual(before.applied)
    expect(after.cursor).toEqual(before.cursor)
    expect(after.responses).toEqual(before.responses)
    expect(after.strand).toEqual(before.strand)
    expect(f.member.controlWalk.head()).toBe(head)
    expect(f.member.access.epoch()).toBe(fork.evidence.epoch + 1)
    expect(f.onStrand).toHaveBeenCalledExactlyOnceWith({
      groupID: f.topic,
      position: fork.evidence.position,
      commitDigest: fork.evidence.remoteDigest,
      localEpoch: fork.evidence.epoch + 1,
      claimedEpoch: fork.evidence.epoch,
      kind: `fork-${branch}`,
      confidence: 'observed',
    })
    expect(await f.safety().events(f.key)).toEqual([
      { ...f.key, id: forkEventID(f.key), kind: 'group:fork', halt: after.forkHalt },
    ])
    work.epoch.mockClear()
    work.evidence.mockClear()
    await refuseWork(f)
    for (const [name, counter] of Object.entries(work)) expect(counter, name).not.toHaveBeenCalled()
    expect(f.onRecovery).not.toHaveBeenCalled()
    expect(f.onSafetyEvent).toHaveBeenCalledOnce()
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
  await f.safety().reportFork(f.key, { ...event.halt.evidence, epoch: 0 })
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
    await fault.rejected
    expect(f.member.controlWalk.safetyHold()).toBe('fork-halted')
    expect(f.onSafetyEvent).not.toHaveBeenCalled()
    expect(await f.registry.inspectRows()).toEqual(before)
    await expect(
      f.member.peer.protocol('chat').dispatch('chat/posted', { data: {} }),
    ).rejects.toEqual(new SendNotAdmissibleError('fork-halted'))
    try {
      await fault.finish(outcome)
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
    }
    await halting
    expect(f.onSafetyEvent).toHaveBeenCalledOnce()
    expect(await f.safety().events(f.key)).toEqual([f.onSafetyEvent.mock.calls[0]?.[0]])
    await f.restart()
    expect(await f.safety().events(f.key)).toEqual([f.onSafetyEvent.mock.calls[0]?.[0]])
  },
)

test('one-shot below-cursor rollback retries retained body using storage alone', async () => {
  const f = await setup()
  const fork = await f.competing('losing')
  const before = await f.member.control.load()
  const fault = f.registry.armNextWorkFault('pending')
  const apply = f.member.control.apply.bind(f.member.control)
  const attempts = vi.spyOn(f.member.control, 'apply').mockImplementation(apply)
  const revealing = fork.reveal()
  await fault.rejected
  expect(f.onSafetyEvent).not.toHaveBeenCalled()
  // The forged prefix is absent on every subsequent read, including after a crash.
  const page = await f.hub.fetchTopic({
    subscriberDID: f.identity.id,
    topicID: f.topic,
    after: before.cursor?.position ?? undefined,
  })
  expect(page.messages.map((message) => message.sequenceID)).not.toContain(fork.evidence.position)
  const network = observeStartup(f.hub)
  await fault.finish('rollback')
  expect(await revealing).toBe(false)
  const bodies = attempts.mock.calls.filter(([changes]) => changes.forkHalt !== undefined)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]?.[0].forkHalt).toEqual(bodies[0]?.[0].forkHalt)
  expect((await f.member.control.load()).forkHalt?.evidence).toEqual(fork.evidence)
  expect((await f.member.control.load()).applied).toEqual(before.applied)
  expect((await f.member.control.load()).cursor).toEqual(before.cursor)
  for (const [name, counter] of Object.entries(network))
    expect(counter, name).not.toHaveBeenCalled()
})

test('crash before a one-shot halt commits cannot reconstruct the vanished evidence', async () => {
  const f = await setup()
  const fork = await f.competing('losing')
  const fault = f.registry.armNextWorkFault('pending')
  const revealing = fork.reveal()
  await fault.rejected
  expect(f.member.controlWalk.safetyHold()).toBe('fork-halted')
  expect(f.onSafetyEvent).not.toHaveBeenCalled()
  const stopping = f.member.peer.dispose()
  await fault.finish('rollback')
  await stopping
  await f.member.peer.drained()
  await revealing
  await f.restart()
  // The crash loses the volatile body. Storage cannot recreate an observation the hub withholds.
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
  const initial = await commitKeyRotation(f.real.committer.handle)
  await survivor.access.replace(initial.newGroup)
  await f.publish(initial.commitMessage, f.real.committer.handle)
  await f.member.peer.replay()
  expect(f.member.access.epoch()).toBe(Number(initial.newGroup.epoch))
  await f.stopPeer()
  const missed = await commitKeyRotation(initial.newGroup)
  await survivor.access.replace(missed.newGroup)
  await f.publish(missed.commitMessage, initial.newGroup)
  const afterGap = await commitKeyRotation(missed.newGroup)
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
