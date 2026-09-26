import { describe, expect, test, vi } from 'vitest'

import { COMMIT_FRAME_VERSION, encodeCommitFrame } from '../src/commit-frame.js'
import {
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  HANDSHAKE_MAGIC,
  HANDSHAKE_VERSION,
} from '../src/handshake.js'
import type { RecoveryEvent, StrandObservation } from '../src/peer.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { makeMLSPeer } from './fixtures/peer.js'

const recovery = { timeoutMs: 10, deadlineMs: 30, getDelayMs: () => 0 }

type Case = 'applicable' | 'past' | 'future' | 'own' | 'unknown-handshake' | 'unknown-commit'

async function runCase(kind: Case, offset: number) {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(0xa1)
  const topicID = commitTopic(secret)
  let sequenceID: string
  if (kind === 'unknown-handshake' || kind === 'unknown-commit') {
    const payload = encodeCommitFrame(new Uint8Array([1]), new Uint8Array())
    if (kind === 'unknown-commit') payload[0] = COMMIT_FRAME_VERSION + 1
    const frame = encodeHandshakeFrame(HANDSHAKE_KIND.commit, payload)
    if (kind === 'unknown-handshake') frame[HANDSHAKE_MAGIC.length] = HANDSHAKE_VERSION + 1
    sequenceID = (await hub.publish({ senderDID: 'zoe', topicID, payload: frame, retain: 'log' }))
      .sequenceID
  } else {
    sequenceID = (
      await publishCommit({
        hub,
        senderDID: kind === 'own' ? 'bob' : 'alice',
        recoverySecret: secret,
        epoch: kind === 'past' ? 1 : kind === 'future' ? 3 : 2,
        ...(kind === 'applicable' ? { adds: ['dave'] } : {}),
      })
    ).sequenceID
  }
  const crypto = createFakeCrypto({
    epoch: kind === 'past' ? 2 : kind === 'future' ? 1 : 2,
    localDID: 'bob',
  })
  const actualEpoch = crypto.epoch
  crypto.epoch = () => actualEpoch() + offset
  const observations: Array<StrandObservation> = []
  const recoveries: Array<RecoveryEvent> = []
  const fetch = vi.spyOn(hub, 'fetchTopic')
  const bob = makeMLSPeer(hub, 'bob', secret, {
    crypto,
    epoch: kind === 'past' ? 2 : kind === 'future' ? 1 : 2,
    members: ['alice', 'bob', 'carol'],
    recovery,
    onStrand: (observation) => {
      observations.push(observation)
    },
    onRecovery: (event) => {
      recoveries.push(event)
    },
  })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
  await bob.peer.replay()
  if (kind === 'future' || kind === 'own' || kind.startsWith('unknown')) {
    await vi.waitFor(() => expect(recoveries.some((event) => event.phase === 'failed')).toBe(true))
  }
  const fetchesBeforeWake = fetch.mock.calls.length
  await hub.publish({ senderDID: 'zoe', topicID, payload: new Uint8Array([0]) })
  await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(fetchesBeforeWake))
  const cursor =
    fetch.mock.calls.filter(([request]) => request.topicID === topicID).at(-1)?.[0].after ?? null
  const result = {
    epoch: bob.mls.epoch(),
    commits: bob.mls.commits(),
    ...(kind === 'applicable' ? { anchorEpoch: bob.peer.anchorEpoch() } : {}),
    cursor,
    strandKinds: observations.map((observation) => observation.kind),
    repairStarted: recoveries.some((event) => event.phase === 'started'),
    repairFailed: recoveries.some((event) => event.phase === 'failed'),
  }
  await bob.peer.dispose()
  return { result, sequenceID }
}

describe('commit decisions use the handle epoch', () => {
  test.each<Case>(['applicable', 'past', 'future', 'own', 'unknown-handshake', 'unknown-commit'])(
    '%s has the same result with lagging and leading hints',
    async (kind) => {
      const honest = await runCase(kind, 0)
      for (const offset of [-1, 1]) {
        const lying = await runCase(kind, offset)
        expect(lying.result).toEqual(honest.result)
      }
      if (kind === 'applicable') {
        expect(honest.result.commits).toBe(1)
        expect(honest.result.epoch).toBe(3)
        expect(honest.result.cursor).toBe(honest.sequenceID)
      }
      if (kind === 'own') expect(honest.result.cursor).toBeNull()
    },
  )

  test.each([-1, 0, 1])(
    'fork evidence uses the locked epoch with hint offset %i',
    async (offset) => {
      const hub = new FakeHub()
      hub.acceptAtAnyHead()
      const secret = new Uint8Array(32).fill(0xa2)
      const winner = await publishCommit({
        hub,
        senderDID: 'alice',
        recoverySecret: secret,
        epoch: 1,
      })
      await publishCommit({ hub, senderDID: 'carol', recoverySecret: secret, epoch: 1 })
      hub.hideFrom('bob', winner.sequenceID)
      const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
      const actualEpoch = crypto.epoch
      crypto.epoch = () => actualEpoch() + offset
      const observations: Array<StrandObservation> = []
      const bob = makeMLSPeer(hub, 'bob', secret, {
        crypto,
        recovery,
        members: ['alice', 'bob', 'carol'],
        onStrand: (observation) => {
          observations.push(observation)
        },
      })
      await vi.waitFor(() => expect(bob.mls.epoch()).toBe(2))
      hub.revealTo('bob', winner.sequenceID)
      await hub.publish({
        senderDID: 'zoe',
        topicID: commitTopic(secret),
        payload: new Uint8Array([0]),
      })
      await vi.waitFor(() =>
        expect(observations.map((observation) => observation.kind)).toContain('fork-losing'),
      )
      expect(observations.at(-1)?.localEpoch).toBe(2)
      expect(bob.mls.commits()).toBe(1)
      await bob.peer.dispose()
    },
  )

  test('a refused apply reclassifies from its returned epoch', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0xa3)
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret: secret,
      epoch: 1,
    })
    const { sequenceID } = await publishCommit({
      hub,
      senderDID: 'carol',
      recoverySecret: secret,
      epoch: 2,
    })
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
    const mls = createMemoryGroupMLS({
      recoverySecret: secret,
      epoch: 1,
      localDID: 'bob',
      members: ['alice', 'bob', 'carol'],
      onAdvance: (next) => crypto.setEpoch(next),
    })
    const readHeader = vi.spyOn(mls, 'readCommitHeader')
    const originalProcess = mls.processCommit
    let raced = false
    mls.processCommit = async (commit, context) => {
      if (!raced) {
        raced = true
        mls.adopt(mls.buildCommit())
      }
      return originalProcess(commit, context)
    }
    const observations: Array<StrandObservation> = []
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const bob = makeMLSPeer(hub, 'bob', secret, {
      crypto,
      mls,
      members: ['alice', 'bob', 'carol'],
      onStrand: (observation) => {
        observations.push(observation)
      },
    })
    await bob.peer.replay()
    expect(raced).toBe(true)
    expect(readHeader.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(bob.mls.epoch()).toBe(3)
    expect(bob.mls.commits()).toBe(1)
    expect(observations).toEqual([])
    const beforeWake = fetch.mock.calls.length
    await hub.publish({
      senderDID: 'zoe',
      topicID: commitTopic(secret),
      payload: new Uint8Array([0]),
    })
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(beforeWake))
    expect(
      fetch.mock.calls.filter(([request]) => request.topicID === commitTopic(secret)).at(-1)?.[0]
        .after,
    ).toBe(sequenceID)
    await bob.peer.dispose()
  })
})
