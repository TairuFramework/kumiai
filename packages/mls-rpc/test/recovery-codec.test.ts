import { confirmationTag, encodeClientState } from '@kumiai/mls'
import type { AdoptionWrite } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS } from '../src/mls.js'
import type { RecoveryCandidate } from '../src/recovery.js'
import { createRealGroup } from './fixtures/real-group.js'

async function setup() {
  const group = await createRealGroup(2, 'candidate-codec')
  const member = group.members[0]
  const responder = group.members[1]
  if (member == null || responder == null) throw new Error('Missing member')
  const writes: Array<AdoptionWrite | undefined> = []
  let adoptions = 0
  const access = simpleHandleAccess({
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
    createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
  const port = requester()
  const remote = createGroupMLS({
    access: simpleHandleAccess({
      handle: () => responder.handle,
      adopt: (next) => {
        responder.handle = next
      },
    }),
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
    writes,
    signer: responder.identity.id,
    adoptions: () => adoptions,
  }
}

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
  const access = simpleHandleAccess({
    handle: () => s.member.handle,
    adopt: (next) => {
      s.member.handle = next
    },
    persist: () => {
      if (shouldFail) throw new Error('save failed')
    },
  })
  const port = createGroupMLS({ access, identity: s.member.identity, entrySlot: s.member.slot })
  const pending = await port.restoreRecovery(s.pending.serialize(), s.requestKey)
  const write = () => ({ mutationID: 'retry-save', changes: { deleteRejoin: true as const } })
  const noPersist = createGroupMLS({
    access: simpleHandleAccess({
      handle: () => s.member.handle,
      adopt: (next) => {
        s.member.handle = next
      },
    }),
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
