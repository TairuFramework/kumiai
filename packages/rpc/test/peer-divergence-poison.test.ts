import { afterEach, expect, test, vi } from 'vitest'

import type { StrandObservation } from '../src/peer.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer, type TestPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0xd4)
const peers: Array<TestPeer> = []
afterEach(async () => {
  for (const { peer } of peers.splice(0)) {
    await peer.dispose()
    await peer.drained()
  }
  vi.restoreAllMocks()
})

test.each([
  ['lower', false],
  ['higher', false],
  ['lower', true],
  ['higher', true],
] as const)(
  'delivered past divergence cannot latch delivery halt: %s position, forged=%s',
  async (ordering, forged) => {
    const hub = new FakeHub()
    const firstParams = {
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
      ...(ordering === 'lower' && forged ? { signerDID: 'mallory' } : {}),
    }
    const first = await publishCommit({ ...firstParams, expectedHead: null })
    const secondParams = {
      hub,
      senderDID: 'carol',
      recoverySecret: secret,
      epoch: 1,
      ...(ordering === 'higher' && forged ? { signerDID: 'mallory' } : {}),
    }
    await expect(publishCommit({ ...secondParams, expectedHead: null })).rejects.toMatchObject({
      name: 'HeadMismatchError',
    })
    const second = await publishCommit(secondParams)
    const remote = ordering === 'lower' ? first : second
    hub.hideFrom('bob', remote.sequenceID)
    const onSafetyEvent = vi.fn()
    const onRecovery = vi.fn()
    const observations: Array<StrandObservation> = []
    const bob = makeMLSPeer(hub, 'bob', secret, {
      members: ['alice', 'bob', 'carol'],
      onSafetyEvent,
      onRecovery,
      onStrand: (observation) => {
        observations.push(observation)
      },
      deliverWelcome: async () => {
        throw new Error('Welcome transport unavailable')
      },
    })
    peers.push(bob)
    await bob.peer.replay()
    expect(bob.mls.epoch()).toBe(2)
    await bob.control.apply(
      {
        putOutcomes: [{ id: 'saved-outcome', opID: 'saved-op', at: 1, kind: 'unknown' }],
        putWelcomes: [
          {
            opID: 'owed-invite',
            welcome: new Uint8Array([7]),
            recipients: ['dave'],
            committed: true,
          },
        ],
      },
      'saved-obligations',
    )
    const before = await bob.control.load()
    hub.revealTo('bob', remote.sequenceID)
    const marker = await hub.publish({
      senderDID: 'zoe',
      topicID: commitTopic(secret),
      payload: new Uint8Array([0]),
      retain: 'log',
    })
    await bob.peer.replay()
    const after = await bob.control.load()
    expect(after.forkHalt).toBeNull()
    expect(after.controlHold).toBeNull()
    expect(bob.controlWalk.safetyHold()).toBeNull()
    expect(after.strand).toBeNull()
    expect(after.cursor).toEqual({ position: marker.sequenceID, epoch: 2 })
    expect(after.applied).toEqual(before.applied)
    expect(after.outcomes).toEqual(before.outcomes)
    expect(after.welcomes).toEqual(before.welcomes)
    expect(after.responses).toEqual(before.responses)
    expect(observations).toMatchObject([
      { kind: 'past-epoch-divergence', confidence: 'claimed', claimedEpoch: 1, localEpoch: 2 },
    ])
    expect(onSafetyEvent).not.toHaveBeenCalled()
    expect(onRecovery).not.toHaveBeenCalled()
    await bob.peer.dispose()
    await bob.peer.drained()
    let delivered = false
    const again = makeMLSPeer(hub, 'bob', secret, {
      restartOf: bob,
      onRecovery,
      onSafetyEvent,
      deliverWelcome: async () => {
        delivered = true
      },
    })
    peers.push(again)
    await again.peer.replay()
    expect(delivered).toBe(true)
    expect((await again.control.load()).welcomes).toEqual([])
    expect(await again.peer.outcomes()).toEqual(before.outcomes)
    expect((await again.control.load()).applied).toEqual(before.applied)
    expect(again.controlWalk.safetyHold()).toBeNull()
    expect(onRecovery).not.toHaveBeenCalled()
    expect(onSafetyEvent).not.toHaveBeenCalled()
    await publishCommit({ hub, senderDID: 'alice', recoverySecret: secret, epoch: 2 })
    await again.peer.replay()
    expect(again.mls.epoch()).toBe(3)
  },
)
