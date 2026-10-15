import { decodeClientState, encodeClientState } from '@kumiai/mls'
import { expect, test } from 'vitest'

import { decodeRecoveryCandidate } from '../src/recovery-codec.js'
import { decodeRecoveryRecord } from '../src/recovery-record.js'
import { createCodecReopenFixture } from './fixtures/codec-reopen.js'

test('reopens sealed real MLS pending zero sender and recovery candidate without plaintext state caches', async () => {
  const groupID = 'group-A'
  const { fixture, key, zeroRef, boundVerdict, realPort, mutationID } =
    await createCodecReopenFixture(groupID)
  try {
    const before = (await fixture.ports.device.groups.ports(key).control.load()).rejoin
    if (before == null) throw new Error('missing rejoin')
    const candidateBytes = before.candidate.slice()
    const reopened = await fixture.reopen()
    const stored = await reopened.device.groups.loadState(key)
    expect(stored?.deleted).toBe(false)
    if (stored == null || stored.deleted || stored.state == null) throw new Error('missing state')
    expect((await realPort.readRecoverySource()).stateVersion).toBe(stored.version)
    expect(stored.state[0]).toBe(2)
    expect(decodeClientState(stored.state)?.unappliedProposals[zeroRef]?.senderLeafIndex).toBe(0)
    const rejoin = (await reopened.device.groups.ports(key).control.load()).rejoin
    if (rejoin == null) throw new Error('missing rejoin')
    const decoded = decodeRecoveryRecord(rejoin)
    expect(decoded).toMatchObject({ kind: 'legacy', executable: false, record: rejoin })
    expect(rejoin.candidate[0]).toBe(2)
    const restored = await realPort.restoreRecovery(rejoin.candidate, rejoin.requestKey)
    expect(restored.judgeVerdict(boundVerdict)).toBe('authoritative')
    expect(await reopened.device.groups.resolve(groupID, mutationID)).toBe('committed')

    const state = decodeClientState(stored.state)
    if (state == null) throw new Error('missing decoded state')
    const clone = decodeClientState(encodeClientState(structuredClone(state)))
    if (clone == null) throw new Error('missing cloned state')
    for (const value of [state, clone]) {
      expect(value.unappliedProposals[zeroRef]?.senderLeafIndex).toBe(0)
      expect(value.unappliedProposals['AQ==']?.senderLeafIndex).toBe(1)
      expect(value.unappliedProposals['Ag==']).toBeDefined()
      expect(value.unappliedProposals['Ag==']?.senderLeafIndex).toBeUndefined()
    }
    const candidate = decodeRecoveryCandidate(rejoin.candidate, rejoin.requestKey)
    expect(rejoin.candidate).toEqual(candidateBytes)
    expect(candidate.sourceTree).not.toEqual(candidate.state.ratchetTree)
    expect(candidate.state.privatePath.leafIndex).not.toBe(state.privatePath.leafIndex)
    expect(candidate.sourceTree[state.privatePath.leafIndex * 2]).toMatchObject({ nodeType: 1 })
    expect(candidate.sourceTree[candidate.state.privatePath.leafIndex * 2]).toBeUndefined()
    expect(candidate.state.unappliedProposals[zeroRef]?.senderLeafIndex).toBe(0)
    expect(candidate.state.unappliedProposals['AQ==']?.senderLeafIndex).toBe(1)
    expect(candidate.state.unappliedProposals['Ag==']).toBeDefined()
    expect(candidate.state.unappliedProposals['Ag==']?.senderLeafIndex).toBeUndefined()
    expect(rejoin.source.authenticator).toEqual(stored.epochAuthenticator)
    expect(rejoin.ledgerBefore).toEqual(stored.ledger)
    expect(stored.ledger.length).toBeGreaterThan(new Set(stored.ledger).size)
    expect(await realPort.getLedger()).toEqual(stored.ledger)
    expect(await realPort.readEpoch()).toBe(stored.epoch)
    expect(restored.epoch).toBe(rejoin.epochAfter)
    expect(
      restored.judgeVerdict({
        ...boundVerdict,
        verdict: { ...boundVerdict.verdict, position: 'wrong-position' },
      }),
    ).toBe('advisory')

    const raw = await fixture.inspectRawBytes()
    const rows = await fixture.inspectRows()
    for (const namespace of ['state', 'control']) {
      const row = raw.find((value) => value.namespace === namespace && value.groupID === groupID)
      if (row == null) throw new Error(`missing sealed ${namespace}`)
      expect(rows[namespace]?.get(row.key)).toEqual(row.bytes)
      expect(row.bytes).not.toEqual(namespace === 'state' ? stored.state : rejoin.candidate)
    }
    state.keySchedule.exporterSecret.fill(0)
    stored.state.fill(0)
    rejoin.candidate.fill(0)
    rejoin.requestKey.fill(0)
    const again = await fixture.reopen()
    const saved = await again.device.groups.loadState(key)
    if (saved == null || saved.deleted || saved.state == null) throw new Error('missing state')
    expect(encodeClientState(clone)).toEqual(saved.state)
    const savedRejoin = (await again.device.groups.ports(key).control.load()).rejoin
    if (savedRejoin == null) throw new Error('missing rejoin')
    expect(
      (await realPort.restoreRecovery(savedRejoin.candidate, savedRejoin.requestKey)).judgeVerdict(
        boundVerdict,
      ),
    ).toBe('authoritative')
    expect(await again.device.groups.resolve(groupID, mutationID)).toBe('committed')
  } finally {
    await fixture.close()
  }
})
