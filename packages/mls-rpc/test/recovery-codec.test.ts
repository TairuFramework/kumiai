import {
  confirmationTag,
  decodeClientState,
  encodeClientState,
  sealCapturedGroupInfo,
} from '@kumiai/mls'
import { type AdoptionWrite, type AdoptionWriteFactory, asLogPosition } from '@kumiai/rpc'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { defaultProposalTypes } from 'ts-mls'
import { expect, expectTypeOf, test } from 'vitest'

import { createGroupMLS } from '../src/mls.js'
import { decodeStoredValue, encodeStoredValue } from '../src/persistence-codec.js'
import type { RecoveryCandidate } from '../src/recovery.js'
import {
  type CapturedRecoverySnapshot,
  decodeCapturedRecoveryCandidate,
  decodeRecoveryCandidate,
  encodeCapturedRecoveryCandidate,
  encodeRecoveryCandidate,
  type RecoverySnapshot,
} from '../src/recovery-codec.js'
import { recoveryTrustDigest } from '../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import {
  buildRealCommit,
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
} from './fixtures/transactional-access.js'

async function setup(differentTree = false) {
  const group = await createRealGroup(differentTree ? 3 : 2, 'candidate-codec')
  const member = group.members[differentTree ? 1 : 0]
  const responder = group.members[differentTree ? 2 : 1]
  if (member == null || responder == null) throw new Error('Missing member')
  if (differentTree) {
    // A vacant earlier leaf makes recovery move the requester to another position.
    const commit = await buildRealCommit(group, { removes: 0 })
    await member.handle.processMessage(commit)
    await responder.handle.processMessage(commit)
  }
  const writes: Array<AdoptionWrite | undefined> = []
  let adoptions = 0
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      adoptions += 1
      member.handle = next
    },
    persist: (_handle, write) => {
      writes.push(write)
    },
  })
  const requester = () =>
    createGroupMLS({
      ...testGroupMLSDependencies(access),
      identity: member.identity,
      entrySlot: member.slot,
    })
  const port = requester()
  const remote = createGroupMLS({
    ...testGroupMLSDependencies(
      testHandleAccess({
        handle: () => responder.handle,
        adopt: (next) => {
          responder.handle = next
        },
      }),
    ),
    identity: responder.identity,
    entrySlot: responder.slot,
  })
  const { request, requestKey } = await port.createRecoveryRequest('candidate-request')
  expect(request).toBeInstanceOf(Uint8Array)
  expect(requestKey).toBeInstanceOf(Uint8Array)
  const sealed = await remote.sealGroupInfo(request)
  const pending = await port.applyRecovery(sealed, 'candidate-request', requestKey)
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  return {
    port,
    requester,
    remote,
    request,
    requestKey,
    sealed,
    pending,
    member,
    responder,
    writes,
    signer: responder.identity.id,
    adoptions: () => adoptions,
  }
}

test.each([null, 'captured-position'])(
  'captured v3 retains full sourceState and immutable origin (%s)',
  async (captureHead) => {
    const s = await setup(true)
    const pending = s.pending as RecoveryCandidate
    const head = captureHead === null ? null : asLogPosition(captureHead)
    const trust = recoveryTrustFor(
      s.member.handle,
      { groupID: 'candidate-codec', incarnation: 1 },
      null,
    )
    const attestedReply = await sealCapturedGroupInfo({
      group: s.responder.handle,
      identity: s.responder.identity,
      request: new TextDecoder().decode(s.request),
      captureHead: head,
    })
    const snapshot: CapturedRecoverySnapshot = {
      ...decodeRecoveryCandidate(s.pending.serialize(), s.requestKey),
      source: {
        key: { groupID: trust.groupID, incarnation: 1 },
        stateVersion: 1,
        lifetimeRevision: 2,
        identity: trust.installed,
        trust,
        trustDigest: recoveryTrustDigest(trust),
      },
      target: {
        targetID: 'capture-hub',
        topicID: 'capture-topic',
        groupInfoEpoch: pending.epoch - 1,
        groupInfoAuthenticator: s.responder.handle.state.keySchedule.epochAuthenticator.slice(),
        captureHead: head,
      },
      captureHead: head,
      searchFrom: head,
      attestedReply,
    }
    const bytes = encodeCapturedRecoveryCandidate(snapshot, s.requestKey)
    expect(bytes[0]).toBe(3)
    const restored = decodeCapturedRecoveryCandidate(bytes, s.requestKey)
    expect(restored.source).toEqual(snapshot.source)
    expect(restored.target).toEqual(snapshot.target)
    expect(restored.captureHead).toBe(head)
    expect(restored.searchFrom).toBe(head)
    expect(restored.attestedReply).toEqual(attestedReply)
    expect(encodeClientState(restored.state)).toEqual(encodeClientState(snapshot.state))
    expect(encodeClientState({ ...restored.state, ratchetTree: restored.sourceTree })).toEqual(
      encodeClientState({ ...snapshot.state, ratchetTree: snapshot.sourceTree }),
    )
    expect(restored.sourceTree).not.toEqual(restored.state.ratchetTree)
    for (const version of [1, 2]) {
      expect(() =>
        decodeCapturedRecoveryCandidate(
          new Uint8Array([version, ...bytes.subarray(1)]),
          s.requestKey,
        ),
      ).toThrow('Unsupported recovery candidate version')
    }
    expect(() => decodeCapturedRecoveryCandidate(s.pending.serialize(), s.requestKey)).toThrow()
    expect(() => decodeRecoveryCandidate(bytes, s.requestKey)).toThrow()
    expect(() => decodeCapturedRecoveryCandidate(bytes, new Uint8Array(32))).toThrow()
    const tampered = bytes.slice()
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
    expect(() => decodeCapturedRecoveryCandidate(tampered, s.requestKey)).toThrow()
    const aad = new TextEncoder().encode('kumiai/recovery-candidate/v3')
    const body = xchacha20poly1305(s.requestKey, bytes.subarray(1, 25), aad).decrypt(
      bytes.subarray(25),
    )
    const value = decodeStoredValue(body) as Record<string, unknown>
    const sourceState = decodeClientState(value.sourceState as Uint8Array)
    if (sourceState == null) throw new Error('Missing complete source state')
    sourceState.keySchedule.exporterSecret[0] = (sourceState.keySchedule.exporterSecret[0] ?? 0) ^ 1
    const alteredBody = encodeStoredValue({ ...value, sourceState: encodeClientState(sourceState) })
    const nonce = crypto.getRandomValues(new Uint8Array(24))
    const altered = new Uint8Array([
      3,
      ...nonce,
      ...xchacha20poly1305(s.requestKey, nonce, aad).encrypt(alteredBody),
    ])
    expect(() => decodeCapturedRecoveryCandidate(altered, s.requestKey)).toThrow('sourceState')
  },
)

test.each(['empty', 'mixed'] as const)(
  'round trips a complete sourceState with a different tree and zero one absent senders (%s)',
  async (proposals) => {
    const s = await setup(true)
    const candidate = s.pending as RecoveryCandidate
    const key = await candidate.confirmationKey('position-1', 'digest-1')
    // Commit leaves carry signing-only fields that the MLS wire codec omits.
    const sourceState = decodeClientState(
      encodeClientState({ ...candidate.group.state, ratchetTree: candidate.sourceTree }),
    )
    if (sourceState == null) throw new Error('Invalid source state fixture')
    const proposal = { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } }
    const snapshot: RecoverySnapshot = {
      state: {
        ...candidate.group.state,
        unappliedProposals:
          proposals === 'empty'
            ? {}
            : {
                'AA==': { proposal, senderLeafIndex: 0 },
                'AQ==': { proposal, senderLeafIndex: 1 },
                'Ag==': { proposal, senderLeafIndex: undefined },
              },
      },
      sourceTree: sourceState.ratchetTree,
      groupInfo: candidate.groupInfo,
      knownRegistry: candidate.knownRegistry,
      replyLedger: candidate.replyLedger,
      signer: candidate.signer,
      commit: candidate.commit,
      epoch: candidate.epoch,
      requestID: 'candidate-request',
      boundCommit: {
        position: 'position-1',
        commitDigest: 'digest-1',
        tag: confirmationTag(key, 'candidate-request'),
      },
    }
    expect(snapshot.sourceTree).not.toEqual(snapshot.state.ratchetTree)
    const bytes = encodeRecoveryCandidate(snapshot, s.requestKey)
    expect(bytes[0]).toBe(2)
    const after = decodeRecoveryCandidate(bytes, s.requestKey)
    expect(encodeClientState(after.state)).toEqual(encodeClientState(snapshot.state))
    expect(after.sourceTree).toEqual(snapshot.sourceTree)
    expect(after.sourceTree).not.toEqual(snapshot.state.ratchetTree)
    expect(after.boundCommit).toEqual(snapshot.boundCommit)
    expect(after.knownRegistry).toEqual(snapshot.knownRegistry)
    expect(after.replyLedger).toEqual(snapshot.replyLedger)
    expect(after.groupInfo).toEqual(snapshot.groupInfo)
    expect(after.commit).toEqual(snapshot.commit)
    expect(after.signer).toBe(snapshot.signer)
    expect(after.requestID).toBe(snapshot.requestID)
    expect(Object.values(after.state.unappliedProposals).map((p) => p.senderLeafIndex)).toEqual(
      proposals === 'empty' ? [] : [0, 1, undefined],
    )
    expect(() =>
      decodeRecoveryCandidate(new Uint8Array([1, ...bytes.subarray(1)]), s.requestKey),
    ).toThrow('Unsupported recovery candidate version 1')
    expect(() => decodeRecoveryCandidate(bytes, new Uint8Array(32))).toThrow()
  },
)

test('candidate restores exact state and source tree with its bound verdict judgement', async () => {
  const s = await setup()
  const key = await s.pending.confirmationKey('position-1', 'digest-1')
  const verdict = {
    signer: s.signer,
    verdict: {
      groupID: 'candidate-codec',
      requestID: 'candidate-request',
      position: 'position-1',
      commitDigest: 'digest-1',
      verdict: 'confirmed' as const,
      epoch: s.pending.epoch,
      tag: confirmationTag(key, 'candidate-request'),
    },
  }
  const restored = await s.requester().restoreRecovery(s.pending.serialize(), s.requestKey)
  const before = s.pending as RecoveryCandidate
  const after = restored as RecoveryCandidate
  expect(encodeClientState(after.group.state)).toEqual(encodeClientState(before.group.state))
  expect(encodeClientState({ ...after.group.state, ratchetTree: after.sourceTree })).toEqual(
    encodeClientState({ ...before.group.state, ratchetTree: before.sourceTree }),
  )
  expect(after.commit).toEqual(before.commit)
  expect(after.replyLedger).toEqual(before.replyLedger)
  expect(after.knownRegistry).toEqual(before.knownRegistry)
  expect(restored.judgeVerdict(verdict)).toBe('authoritative')
  expect(restored.judgeVerdict(verdict)).toBe(s.pending.judgeVerdict(verdict))
  expect(restored.judgeVerdict({ ...verdict, verdict: { ...verdict.verdict, tag: 'wrong' } })).toBe(
    'advisory',
  )
  await expect(restored.confirmationKey('another-position', 'digest-1')).rejects.toThrow('bound')
  expect(await s.port.readEpoch()).toBe(s.pending.epoch - 1)
})

test('restored acceptance persists the adoption write once, including after another restore', async () => {
  const s = await setup()
  const bytes = s.pending.serialize()
  const restored = await s.requester().restoreRecovery(bytes, s.requestKey)
  expectTypeOf(restored.onAccepted).parameters.toEqualTypeOf<[AdoptionWriteFactory]>()
  const write: AdoptionWrite = { mutationID: 'adoption-1', changes: { deleteRejoin: true } }
  await restored.onAccepted(() => write)
  await restored.onAccepted(() => write)
  await (await s.requester().restoreRecovery(bytes, s.requestKey)).onAccepted(() => write)
  expect(s.adoptions()).toBe(1)
  expect(s.writes).toEqual([write])
  expect(await s.port.readEpoch()).toBe(s.pending.epoch)
})

test('only the explicit request key opens replies or restores a candidate, without a TTL', async () => {
  const s = await setup()
  const wrongKey = new Uint8Array(32)
  expect(await s.port.applyRecovery(s.sealed, 'candidate-request', wrongKey)).toBeNull()
  expect(await s.port.applyRecovery(s.sealed, 'other-request', s.requestKey)).toBeNull()
  const ledger = await s.remote.sealLedger(s.request)
  expect(await s.requester().openSealedLedger(ledger, 'candidate-request', s.requestKey)).toEqual(
    await s.remote.getLedger(),
  )
  expect(await s.port.openSealedLedger(ledger, 'candidate-request', wrongKey)).toBeNull()
  const bytes = s.pending.serialize()
  await expect(s.requester().restoreRecovery(bytes, wrongKey)).rejects.toThrow()
  await expect(s.requester().restoreRecovery(bytes, new Uint8Array())).rejects.toThrow()
  const tampered = bytes.slice()
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
  await expect(s.requester().restoreRecovery(tampered, s.requestKey)).rejects.toThrow()
})

test('acceptance refuses a host without persistence and can retry after a failed save', async () => {
  const s = await setup()
  let shouldFail = true
  const access = testHandleAccess({
    handle: () => s.member.handle,
    adopt: (next) => {
      s.member.handle = next
    },
    persist: () => {
      if (shouldFail) throw new Error('save failed')
    },
  })
  const port = createGroupMLS({
    ...testGroupMLSDependencies(access),
    identity: s.member.identity,
    entrySlot: s.member.slot,
  })
  const pending = await port.restoreRecovery(s.pending.serialize(), s.requestKey)
  const write = () => ({ mutationID: 'retry-save', changes: { deleteRejoin: true as const } })
  const noPersist = createGroupMLS({
    ...testGroupMLSDependencies(
      testHandleAccess({
        handle: () => s.member.handle,
        adopt: (next) => {
          s.member.handle = next
        },
      }),
    ),
    identity: s.member.identity,
    entrySlot: s.member.slot,
  })
  const unpersisted = await noPersist.restoreRecovery(s.pending.serialize(), s.requestKey)
  await expect(unpersisted.onAccepted(write)).rejects.toThrow('persist callback')
  await expect(pending.onAccepted(write)).rejects.toThrow('save failed')
  expect(await port.readEpoch()).toBe(s.pending.epoch - 1)
  shouldFail = false
  await pending.onAccepted(write)
  expect(await port.readEpoch()).toBe(s.pending.epoch)
})

test('a candidate cannot be restored through another member of the same group', async () => {
  const s = await setup()
  await expect(s.remote.restoreRecovery(s.pending.serialize(), s.requestKey)).rejects.toThrow(
    'member',
  )
})

test('concurrent restored acceptances through the same access adopt only once', async () => {
  const s = await setup()
  const bytes = s.pending.serialize()
  const first = await s.requester().restoreRecovery(bytes, s.requestKey)
  const second = await s.requester().restoreRecovery(bytes, s.requestKey)
  const write = () => ({
    mutationID: 'concurrent-adoption',
    changes: { deleteRejoin: true as const },
  })
  await Promise.all([first.onAccepted(write), second.onAccepted(write)])
  expect(s.adoptions()).toBe(1)
  expect(s.writes).toHaveLength(1)
})

test('restored adoption survives a crash with its control changes and no second save', async () => {
  const s = await setup()
  const store = createTransactionalStore(s.member.handle)
  const first = await createTransactionalAccess(s.member, store)
  const port = createGroupMLS({
    ...testGroupMLSDependencies(first.access, store.control),
    identity: s.member.identity,
    entrySlot: s.member.slot,
  })
  const bytes = s.pending.serialize()
  const restored = await port.restoreRecovery(bytes, s.requestKey)
  await restored.onAccepted(() => ({
    mutationID: 'crash-adoption',
    changes: {
      putOutcomes: [
        { id: 'rejoin-result', kind: 'reenact', opID: null, at: 123, tokens: ['before'] },
      ],
    },
  }))
  expect(store.snapshot().revision).toBe(1)
  const restartedStore = await store.fork()
  const restartedAccess = await createTransactionalAccess(s.member, restartedStore)
  const restarted = createGroupMLS({
    ...testGroupMLSDependencies(restartedAccess.access, restartedStore.control),
    identity: s.member.identity,
    entrySlot: s.member.slot,
  })
  const again = await restarted.restoreRecovery(bytes, s.requestKey)
  await again.onAccepted(() => {
    throw new Error('Already co-committed')
  })
  expect(await restarted.readEpoch()).toBe(restored.epoch)
  expect(restartedStore.snapshot().revision).toBe(1)
  expect(restartedStore.snapshot().mutationID).toBe('crash-adoption')
  expect(restartedStore.snapshot().control.outcomes).toEqual([
    { id: 'rejoin-result', kind: 'reenact', opID: null, at: 123, tokens: ['before'] },
  ])
})

test('live acceptance requires a write and restart retains its co-committed changes exactly once', async () => {
  const s = await setup()
  const store = createTransactionalStore(s.member.handle)
  const first = await createTransactionalAccess(s.member, store)
  const port = createGroupMLS({
    ...testGroupMLSDependencies(first.access, store.control),
    identity: s.member.identity,
    entrySlot: s.member.slot,
  })
  const live = await port.applyRecovery(s.sealed, 'candidate-request', s.requestKey)
  if (live == null || 'renewalRequired' in live) throw new Error('Expected candidate')
  const bytes = live.serialize()
  await expect(Reflect.apply(live.onAccepted, live, [])).rejects.toThrow()
  expect(store.snapshot().revision).toBe(0)
  await live.onAccepted(() => ({
    mutationID: 'live-rejoin',
    changes: {
      putOutcomes: [{ id: 'live-result', opID: null, at: 123, kind: 'reenact', tokens: ['owed'] }],
    },
  }))
  const restartedStore = await store.fork()
  const restartedAccess = await createTransactionalAccess(s.member, restartedStore)
  const restarted = createGroupMLS({
    ...testGroupMLSDependencies(restartedAccess.access, restartedStore.control),
    identity: s.member.identity,
    entrySlot: s.member.slot,
  })
  await (await restarted.restoreRecovery(bytes, s.requestKey)).onAccepted(() => {
    throw new Error('Already committed')
  })
  expect(restartedStore.snapshot().revision).toBe(1)
  expect(restartedStore.snapshot().mutationID).toBe('live-rejoin')
  expect(restartedStore.snapshot().control.outcomes).toEqual([
    { id: 'live-result', opID: null, at: 123, kind: 'reenact', tokens: ['owed'] },
  ])
})
