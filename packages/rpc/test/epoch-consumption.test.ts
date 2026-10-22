import { expect, test, vi } from 'vitest'

import { revokeHeld } from '../src/control/operations.js'
import { encodeHandshakeFrame } from '../src/handshake.js'
import { commitTopic } from '../src/topic.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  buildRemoveCommit,
  makeMLSPeer,
  seedBuiltOperation,
} from './fixtures/peer.js'

test('built-save extracts the owner from the intent FIFO', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(61))
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const snapshot = await member.control.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.commitOnce).toMatchObject({
      opID: saved.id,
      kind: 'ledger',
      head: null,
      revokes: false,
      enqueuedAt: saved.enqueuedAt,
      deadline: saved.deadline,
    })
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test.each([false, true])(
  'foreign source consumption settles atomically by coverage (gap=%s)',
  async (gap) => {
    const secret = new Uint8Array(32).fill(64)
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'bob'] })
    try {
      await member.peer.replay()
      const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
      const fetch = hub.fetchTopic.bind(hub)
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        const page = await fetch(params)
        return params.topicID === commitTopic(secret) ? { ...page, gap } : page
      })
      const winner = await publishCommit({
        hub,
        senderDID: 'bob',
        recoverySecret: secret,
        epoch: saved.slot.epoch,
      })
      await member.controlWalk.walkCommits()
      const snapshot = await member.control.load()
      expect(snapshot.commitOnce).toBeNull()
      expect(snapshot.operations).toEqual([])
      expect(snapshot.applied).toMatchObject([{ opID: null, sequenceID: winner.sequenceID }])
      expect(snapshot.outcomes).toMatchObject([{ opID: saved.id, kind: gap ? 'unknown' : 'lost' }])
      await hub.publish({
        senderDID: 'replayer',
        topicID: commitTopic(secret),
        retain: 'log',
        payload: saved.slot.payload,
      })
      await member.controlWalk.walkCommits()
      expect((await member.control.load()).outcomes).toEqual(snapshot.outcomes)
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)

test('a mid-walk same-fetch gap strands before an own occurrence can install', async () => {
  const secret = new Uint8Array(32).fill(65)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  try {
    await member.peer.replay()
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 0 })
    await member.controlWalk.walkCommits()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const before = await member.control.load()
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => ({
      ...(await fetch(params)),
      gap: true,
    }))
    await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(snapshot.cursor).toMatchObject({ position: before.cursor?.position, stranded: true })
    expect(snapshot.commitOnce).toEqual(saved.slot)
    expect(snapshot.applied).toEqual([])
    expect(await member.mls.readEpoch()).toBe(saved.slot.epoch)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test.each([false, true])(
  'own occurrence installs without receive application (gap=%s)',
  async (gap) => {
    const secret = new Uint8Array(32).fill(62)
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret)
    try {
      await member.peer.replay()
      const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
      const receive = vi.spyOn(member.mls, 'processCommit').mockImplementation(async () => {
        throw new Error('Own occurrence reached receive application')
      })
      const fetch = hub.fetchTopic.bind(hub)
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        const page = await fetch(params)
        return params.topicID === commitTopic(secret) ? { ...page, gap } : page
      })
      const occurrence = await hub.publish({
        senderDID: 'replayer',
        topicID: commitTopic(secret),
        retain: 'log',
        payload: saved.slot.payload,
      })
      await member.peer.resync()
      const snapshot = await member.control.load()
      expect(receive).not.toHaveBeenCalled()
      expect(snapshot.commitOnce).toBeNull()
      expect(snapshot.applied).toMatchObject([
        { opID: saved.id, sequenceID: occurrence.sequenceID },
      ])
      expect(snapshot.outcomes).toMatchObject([
        { opID: saved.id, kind: gap ? 'unknown' : 'landed' },
      ])
      expect(await member.mls.readEpoch()).toBe(saved.slot.epoch + 1)
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)

test('an unreadable occurrence marks skipped with its cursor and survives restart', async () => {
  const secret = new Uint8Array(32).fill(63)
  const hub = new FakeHub()
  let member = makeMLSPeer(hub, 'alice', secret)
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const occurrence = await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: new Uint8Array([255]),
    })
    const publish = vi.spyOn(hub, 'publish')
    await member.peer.resync()
    const snapshot = await member.control.load()
    expect(snapshot.cursor?.position).toBe(occurrence.sequenceID)
    expect(snapshot.commitOnce).toMatchObject({ publishID: saved.slot.publishID, skipped: true })
    expect(publish).not.toHaveBeenCalled()
    await member.peer.dispose()
    await member.peer.drained()
    member = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
    const later = await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await member.peer.resync()
    const consumed = await member.control.load()
    expect(consumed.commitOnce).toBeNull()
    expect(consumed.outcomes).toMatchObject([{ kind: 'unknown' }])
    expect(consumed.applied[0]?.sequenceID).toBe(later.sequenceID)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an unknown handshake kind cannot preserve complete source coverage', async () => {
  const secret = new Uint8Array(32).fill(71)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  try {
    await member.peer.replay()
    await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const payload = encodeHandshakeFrame(0, new Uint8Array())
    payload[3] = 255
    const occurrence = await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload,
    })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(snapshot.cursor?.position).toBe(occurrence.sequenceID)
    expect(snapshot.commitOnce?.skipped).toBe(true)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a trusted candidate incompatibility halts without cursor progress or build deletion', async () => {
  const secret = new Uint8Array(32).fill(72)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret, {
    adopt: async () => {
      throw Object.assign(new Error('Incompatible saved control source'), {
        name: 'SavedControlCompatibilityError',
      })
    },
  })
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(snapshot.forkHalt?.evidence).toMatchObject({
      kind: 'unexplained-own-commit',
      epoch: saved.slot.epoch,
    })
    expect(snapshot.commitOnce).toEqual(saved.slot)
    expect(snapshot.cursor?.position ?? null).toBeNull()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a build conflicting with an installed local row halts without settling', async () => {
  const secret = new Uint8Array(32).fill(73)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    await member.control.apply(
      {
        putApplied: [
          {
            epoch: saved.slot.epoch,
            digest: 'other-commit',
            payloadDigest: 'other-payload',
            sequenceID: '000000000000',
            opID: null,
            removed: false,
          },
        ],
      },
      'conflicting-local-row',
    )
    await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(snapshot.forkHalt).not.toBeNull()
    expect(snapshot.commitOnce).toEqual(saved.slot)
    expect(snapshot.outcomes).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('same-epoch trusted authenticator divergence halts before reading occurrences', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(74))
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const source = await member.mls.readRecoverySource()
    if (source.identity === null) throw new Error('Missing source')
    vi.spyOn(member.mls, 'readRecoverySource').mockResolvedValue({
      ...source,
      identity: {
        ...source.identity,
        authenticator: new Uint8Array(source.identity.authenticator.length).fill(255),
      },
    })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(snapshot.forkHalt?.evidence).toMatchObject({
      kind: 'epoch-authenticator',
      epoch: saved.slot.epoch,
      local: saved.slot.authenticatorBefore,
    })
    expect(snapshot.commitOnce).toEqual(saved.slot)
    expect(snapshot.cursor?.position ?? null).toBeNull()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a mid-walk same-fetch gap makes competitor consumption unknown', async () => {
  const secret = new Uint8Array(32).fill(75)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'bob'] })
  try {
    await member.peer.replay()
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 0 })
    await member.controlWalk.walkCommits()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => ({
      ...(await fetch(params)),
      gap: true,
    }))
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: saved.slot.epoch })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(snapshot.commitOnce).toBeNull()
    expect(snapshot.outcomes).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a stranded gap followed by unreadable bytes still consumes the competitor without repeated fetch loops', async () => {
  const secret = new Uint8Array(32).fill(80)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'bob'] })
  try {
    await member.peer.replay()
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 0 })
    await member.controlWalk.walkCommits()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const before = await member.control.load()
    const fetch = hub.fetchTopic.bind(hub)
    const reads: Array<string | null> = []
    const pages: Array<Array<string>> = []
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      const page = await fetch(params)
      if (params.topicID !== commitTopic(secret)) return page
      reads.push(params.after ?? null)
      pages.push(page.messages.map((message) => message.sequenceID))
      return { ...page, gap: params.after === before.cursor?.position }
    })
    const unreadable = await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: new Uint8Array([255]),
    })
    const winner = await publishCommit({
      hub,
      senderDID: 'alice',
      committerDID: 'bob',
      recoverySecret: secret,
      epoch: saved.slot.epoch,
    })
    await expect(member.controlWalk.walkCommits()).resolves.toBeDefined()
    expect(pages).toContainEqual([unreadable.sequenceID, winner.sequenceID])
    const consumed = await member.control.load()
    expect(consumed.commitOnce).toBeNull()
    expect(consumed.outcomes).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
    expect(consumed.welcomes).toEqual([])
    expect(consumed.applied).toMatchObject([{ sequenceID: winner.sequenceID, opID: null }])
    expect(consumed.cursor).toMatchObject({ position: before.cursor?.position, stranded: true })
    expect(await member.mls.readEpoch()).toBe(saved.slot.epoch + 1)
    for (let repeat = 0; repeat < 3; repeat++) {
      await expect(member.controlWalk.walkCommits()).resolves.toBe(false)
    }
    expect(reads[0]).toBe(before.cursor?.position)
    expect(reads.slice(1).every((position) => position === winner.sequenceID)).toBe(true)
    expect(reads.length).toBeLessThanOrEqual(10)
    expect((await member.control.load()).outcomes).toEqual(consumed.outcomes)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an adoption invariant defect propagates without creating a fork halt', async () => {
  const secret = new Uint8Array(32).fill(81)
  const defect = Object.assign(new Error('Consumption must close the live build'), {
    name: 'ControlStoreInvariantError',
  })
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret, {
    adopt: async () => {
      throw defect
    },
  })
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await expect(member.controlWalk.walkCommits()).rejects.toBe(defect)
    const snapshot = await member.control.load()
    expect(snapshot.forkHalt).toBeNull()
    expect(snapshot.commitOnce).toEqual(saved.slot)
    expect(snapshot.outcomes).toEqual([])
    expect(snapshot.cursor?.position ?? null).toBeNull()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('background pulls report each distinct persistent adoption invariant once without halting', async () => {
  const secret = new Uint8Array(32).fill(82)
  const hub = new FakeHub()
  let message = 'Consumption must close the live build'
  const adopt = vi.fn(async () => {
    throw Object.assign(new Error(message), { name: 'ControlStoreInvariantError' })
  })
  const diagnostic = vi.fn()
  const member = makeMLSPeer(hub, 'alice', secret, { adopt, onControlPublishError: diagnostic })
  try {
    await member.peer.replay()
    vi.useFakeTimers()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await member.peer.resync()
    await vi.advanceTimersByTimeAsync(7_000)
    expect(adopt.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(diagnostic).toHaveBeenLastCalledWith({
      opID: saved.id,
      error: expect.objectContaining({ name: 'ControlStoreInvariantError', message }),
    })
    message = 'A different control invariant failed'
    await vi.advanceTimersByTimeAsync(16_000)
    expect(diagnostic).toHaveBeenCalledTimes(2)
    const snapshot = await member.control.load()
    expect(snapshot.forkHalt).toBeNull()
    expect(snapshot.commitOnce?.publishID).toBe(saved.slot.publishID)
    expect(snapshot.outcomes).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
    vi.useRealTimers()
  }
})

test('a restarted peer re-fetches unreadable bytes from a stranded cursor and consumes the winner once', async () => {
  const secret = new Uint8Array(32).fill(83)
  const hub = new FakeHub()
  let member = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'bob'] })
  try {
    await member.peer.replay()
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: 0 })
    await member.controlWalk.walkCommits()
    const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
    const before = await member.control.load()
    const fetch = hub.fetchTopic.bind(hub)
    const reads: Array<string | null> = []
    const pages: Array<Array<string>> = []
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      const page = await fetch(params)
      if (params.topicID !== commitTopic(secret)) return page
      reads.push(params.after ?? null)
      pages.push(page.messages.map((row) => row.sequenceID))
      return { ...page, gap: params.after === before.cursor?.position }
    })
    await member.controlWalk.walkCommits()
    const stranded = await member.control.load()
    expect(stranded.cursor).toMatchObject({
      position: before.cursor?.position,
      stranded: true,
      incomplete: true,
    })
    expect(stranded.commitOnce).toEqual(saved.slot)
    const unreadable = await hub.publish({
      senderDID: 'alice',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: new Uint8Array([255]),
    })
    await member.peer.dispose()
    await member.peer.drained()
    reads.length = 0
    pages.length = 0
    member = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
    const winner = await publishCommit({
      hub,
      senderDID: 'alice',
      committerDID: 'bob',
      recoverySecret: secret,
      epoch: saved.slot.epoch,
    })
    await expect(member.controlWalk.walkCommits()).resolves.toBeDefined()
    expect(reads[0]).toBe(before.cursor?.position)
    expect(pages).toContainEqual([unreadable.sequenceID, winner.sequenceID])
    const consumed = await member.control.load()
    expect(consumed.commitOnce).toBeNull()
    expect(consumed.welcomes).toEqual([])
    expect(consumed.outcomes).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
    expect(consumed.applied).toMatchObject([{ sequenceID: winner.sequenceID, opID: null }])
    expect(consumed.cursor).toMatchObject({ position: before.cursor?.position, stranded: true })
    expect(await member.mls.readEpoch()).toBe(saved.slot.epoch + 1)
    for (let repeat = 0; repeat < 3; repeat++)
      await expect(member.controlWalk.walkCommits()).resolves.toBe(false)
    expect(reads.length).toBeLessThanOrEqual(10)
    expect((await member.control.load()).outcomes).toEqual(consumed.outcomes)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('incomplete own Add installs the member without losing an independent Welcome obligation', async () => {
  const secret = new Uint8Array(32).fill(76)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
    const owed = {
      opID: 'prior-invite',
      welcome: new Uint8Array([7]),
      recipients: ['prior-guest'],
      committed: true as const,
    }
    await member.control.apply({ putWelcomes: [owed] }, 'prior-obligation')
    const fetch = hub.fetchTopic.bind(hub)
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => ({
      ...(await fetch(params)),
      gap: true,
    }))
    await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(member.mls.leaves()).toContain('guest')
    expect(snapshot.commitOnce).toBeNull()
    expect(snapshot.outcomes).toMatchObject([{ opID: saved.id, kind: 'unknown' }])
    expect(snapshot.welcomes).toEqual([owed])
    expect(member.welcomes).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('consumption releases the build revoke hold while preserving an independent queued revoke', async () => {
  const secret = new Uint8Array(32).fill(77)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret, { members: ['alice', 'bob', 'carol'] })
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildRemoveCommit(member, 'carol'))
    const queued = {
      ...buildRemoveCommit(member, 'carol'),
      seq: 2,
      enqueuedAt: saved.enqueuedAt,
      deadline: saved.deadline,
      stage: 'intent' as const,
    }
    await member.control.apply({ putOperations: [queued] }, 'independent-revoke')
    expect(revokeHeld(await member.control.load())).toBe(true)
    await publishCommit({ hub, senderDID: 'bob', recoverySecret: secret, epoch: saved.slot.epoch })
    await member.controlWalk.walkCommits()
    const snapshot = await member.control.load()
    expect(snapshot.commitOnce).toBeNull()
    expect(snapshot.operations).toEqual([queued])
    expect(revokeHeld(snapshot)).toBe(true)
    await member.control.apply({ deleteOperations: [queued.id] }, 'cancel-unbuilt')
    expect(revokeHeld(await member.control.load())).toBe(false)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an empty prefix-loss fetch remains incomplete before a later own occurrence', async () => {
  const secret = new Uint8Array(32).fill(78)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    const fetch = hub.fetchTopic.bind(hub)
    let first = true
    vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID === commitTopic(secret) && first) {
        first = false
        return { head: '000000000001', oldest: null, gap: true, messages: [] }
      }
      return fetch(params)
    })
    await member.controlWalk.walkCommits()
    expect((await member.control.load()).cursor?.incomplete).toBe(true)
    await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: saved.slot.payload,
    })
    await member.controlWalk.walkCommits()
    expect((await member.control.load()).outcomes).toMatchObject([
      { opID: saved.id, kind: 'unknown' },
    ])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a held build does not read the live source while walking is disabled', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(79))
  try {
    await member.peer.replay()
    const saved = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved']))
    await member.controlWalk.haltFork({
      kind: 'epoch-authenticator',
      epoch: saved.slot.epoch,
      local: saved.slot.authenticatorBefore,
      remote: new Uint8Array([255]),
    })
    const source = vi
      .spyOn(member.mls, 'readRecoverySource')
      .mockRejectedValue(new Error('Held source must not be read'))
    await expect(member.controlWalk.walkCommits()).resolves.toBe(false)
    expect(source).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})
