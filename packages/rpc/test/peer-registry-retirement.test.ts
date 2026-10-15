import { expect, test, vi } from 'vitest'

import { digestAppliedCommit } from '../src/classify.js'
import { asLogPosition } from '../src/cursor.js'
import { SendNotAdmissibleError } from '../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import type { CapturedRejoinRecord } from '../src/recovery-types.js'
import { rendezvousTopic } from '../src/topic.js'
import { encodeSignedRecoveryConfirmation } from './fixtures/commits.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryGroupMLS, encodeMemoryCommit } from './fixtures/memory-group-mls.js'
import { buildRejoinRecord, makeMLSPeer } from './fixtures/peer.js'

test('recovery-only startup never reads lost private state or opens application work', async () => {
  const hub = new FakeHub()
  const mls = createMemoryGroupMLS({ localDID: 'alice' })
  const epoch = vi.spyOn(mls, 'readEpoch').mockRejectedValue(new Error('Private state unavailable'))
  const anchor = vi.spyOn(mls, 'exportRecoverySecret')
  const member = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(8), { mls, recoveryOnly: true })
  try {
    await member.peer.replay()
    expect(epoch).not.toHaveBeenCalled()
    expect(anchor).toHaveBeenCalled()
    expect(() => member.peer.protocol('chat')).toThrow(SendNotAdmissibleError)
    expect(hub.published).toEqual([])
    expect(await member.appOutbox.list()).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only construction never asks application crypto for private state', async () => {
  const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
  const epoch = vi.spyOn(crypto, 'epoch').mockImplementation(() => {
    throw new Error('Private crypto state unavailable')
  })
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(9), {
    crypto,
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    expect(epoch).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only peers reject new control work without saving an intent', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(10), {
    recoveryOnly: true,
  })
  try {
    await expect(
      member.peer.enqueue({
        id: 'rotation',
        kind: 'rotation',
        revokes: false,
        body: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(SendNotAdmissibleError)
    expect((await member.control.load()).operations).toEqual([])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only startup preserves queued control intents without invoking private MLS', async () => {
  const mls = createMemoryGroupMLS({ localDID: 'alice' })
  await mls.persistInitialState()
  const intent = {
    id: 'queued',
    kind: 'rotation' as const,
    revokes: false,
    body: new Uint8Array([1]),
    stage: 'intent' as const,
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 30_000,
  }
  await mls.control().apply({ putOperations: [intent] }, 'queued-intent')
  const epoch = vi.spyOn(mls, 'readEpoch').mockRejectedValue(new Error('Lost private state'))
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(11), {
    mls,
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(epoch).not.toHaveBeenCalled()
    expect((await member.control.load()).operations).toEqual([intent])
    await expect(member.peer.resync()).rejects.toBeInstanceOf(SendNotAdmissibleError)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('recovery-only peers ignore valid signed confirmation requests without private MLS work', async () => {
  const hub = new FakeHub()
  const secret = new Uint8Array(32).fill(12)
  const member = makeMLSPeer(hub, 'alice', secret, {
    members: ['alice', 'bob'],
    recoveryOnly: true,
  })
  try {
    await member.peer.replay()
    const bob = createMemoryGroupMLS({ localDID: 'bob', members: ['alice', 'bob'] })
    const requestID = 'lost-state-confirmation'
    const { request } = await bob.createRecoveryRequest(requestID)
    const commit = encodeMemoryCommit(1, 'bob', [], { external: true })
    const payload = await encodeSignedRecoveryConfirmation(bob, {
      requestID,
      request,
      position: 'p',
      commitDigest: digestAppliedCommit(commit),
      commit,
    })
    const epoch = vi.spyOn(member.mls, 'readEpoch')
    const complete = vi.spyOn(member.mls, 'isLedgerComplete')
    const validate = vi.spyOn(member.mls, 'validateRecoveryCommit')
    const build = vi.spyOn(member, 'buildOperation')
    const fetch = vi.spyOn(hub, 'fetchTopic')
    const before = await member.control.load()
    await hub.publish({
      senderDID: 'relay',
      topicID: rendezvousTopic(secret),
      payload: encodeHandshakeFrame(HANDSHAKE_KIND.recoveryConfirmRequest, payload),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(epoch).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await member.control.load()).toEqual(before)
    expect(hub.published).toHaveLength(1)
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test.each(['dropAppFrame', 'reconcileCommitPrefix', 'abandon'] as const)(
  'recovery-only %s preserves confirmed recovery without private MLS or control writes',
  async (method) => {
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(13), {
      recoveryOnly: true,
    })
    try {
      await member.peer.replay()
      const { source, conflictEpoch: _conflict, ...saved } = await buildRejoinRecord(member)
      const record: CapturedRejoinRecord = {
        ...saved,
        format: 2,
        source: {
          key: source.key,
          identity: { ...source.key, epoch: source.epoch, authenticator: source.authenticator },
          stateVersion: 1,
          lifetimeRevision: 1,
          trust: { retained: new Uint8Array([1, 2, 3]) },
          trustDigest: 'd'.repeat(43),
        },
        target: {
          targetID: 'recovery-hub',
          topicID: 'recovery-commits',
          groupInfoEpoch: source.epoch,
          groupInfoAuthenticator: source.authenticator.slice(),
          captureHead: null,
        },
        captureHead: null,
        searchFrom: null,
        trigger: 'automatic',
        authorisationID: null,
        switchMutationID: crypto.randomUUID(),
        destinationKey: null,
        ledgerBefore: ['owed-before-recovery'],
        stage: 'confirmed' as const,
        position: asLogPosition('confirmed-recovery'),
        verdict: new Uint8Array([1]),
      }
      await member.control.apply({ putRejoin: record }, 'confirmed-recovery')
      const before = await member.control.load()
      const epoch = vi.spyOn(member.mls, 'readEpoch')
      const complete = vi.spyOn(member.mls, 'isLedgerComplete')
      const ledger = vi.spyOn(member.mls, 'getLedger')
      const writes = vi.spyOn(member.control, 'apply')
      if (method === 'reconcileCommitPrefix') {
        await expect(member.controlWalk.reconcileCommitPrefix()).resolves.toEqual({
          kind: 'incomplete',
        })
      } else {
        await expect(
          method === 'abandon'
            ? member.peer.abandon()
            : member.peer.dropAppFrame('unopened-app-topic', 'blocked-position'),
        ).rejects.toBeInstanceOf(SendNotAdmissibleError)
      }
      expect(epoch).not.toHaveBeenCalled()
      expect(complete).not.toHaveBeenCalled()
      expect(ledger).not.toHaveBeenCalled()
      expect(writes).not.toHaveBeenCalled()
      expect(await member.control.load()).toEqual(before)
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)
