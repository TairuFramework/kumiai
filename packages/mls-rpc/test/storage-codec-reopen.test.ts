import { randomIdentity } from '@kokuin/token'
import {
  checkpointAuthHash,
  checkpointGenesisHash,
  checkpointKeyHash,
  decodeClientState,
  decodeEpochRosterFact,
  encodeClientState,
  encodeEpochRosterFact,
} from '@kumiai/mls'
import {
  applyChanges,
  type CapturedRejoinRecord,
  type GroupMLS,
  type LogPosition,
  readmissionChanges,
} from '@kumiai/rpc'
import { toB64U } from '@sozai/codec'
import { expect, test } from 'vitest'

import { decodeCapturedRecoveryCandidate, decodeRecoveryCandidate } from '../src/recovery-codec.js'
import { decodeRecoveryRecord } from '../src/recovery-record.js'
import { createCodecReopenFixture } from './fixtures/codec-reopen.js'
import { createStorageFixture } from './fixtures/storage-persistence.js'
import { nextChange } from './fixtures/storage-seed.js'

test.each(['legacy', 'captured'] as const)(
  'reopens sealed %s MLS pending zero sender and recovery candidate without plaintext state caches',
  async (format) => {
    const groupID = 'group-A'
    const {
      fixture,
      key,
      zeroRef,
      boundVerdict,
      realPort,
      mutationID,
      sourceStateVersion,
      controlSnapshot,
    } = await createCodecReopenFixture(groupID, format)
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
      expect(rejoin).toEqual(before)
      const decoded = decodeRecoveryRecord(rejoin)
      expect(decoded).toMatchObject({
        kind: format,
        executable: format === 'captured',
        record: rejoin,
      })
      expect(rejoin.candidate[0]).toBe(format === 'captured' ? 3 : 2)
      const restore = (candidate: Uint8Array, requestKey: Uint8Array) => {
        if ('format' in rejoin) {
          const captured = realPort.capturedRecovery
          if (captured === undefined) throw new Error('Missing captured recovery port')
          return captured.restoreRecovery(candidate, requestKey)
        }
        return realPort.restoreRecovery(candidate, requestKey)
      }
      const restored = await restore(rejoin.candidate, rejoin.requestKey)
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
      const candidate =
        'format' in rejoin
          ? decodeCapturedRecoveryCandidate(rejoin.candidate, rejoin.requestKey)
          : decodeRecoveryCandidate(rejoin.candidate, rejoin.requestKey)
      if ('format' in rejoin) {
        expect(rejoin.source.identity?.epoch).toBe(stored.epoch)
        expect(rejoin.source.stateVersion).toBe(sourceStateVersion)
        expect(candidate).toMatchObject({ source: rejoin.source, target: rejoin.target })
        expect(
          decodeCapturedRecoveryCandidate(rejoin.candidate, rejoin.requestKey).attestedReply.length,
        ).toBeGreaterThan(0)
        expect(rejoin.captureHead).toBe(rejoin.target.captureHead)
      } else {
        expect(rejoin.source.epoch).toBe(stored.epoch)
      }
      expect(rejoin.candidate).toEqual(candidateBytes)
      expect(candidate.sourceTree).not.toEqual(candidate.state.ratchetTree)
      expect(candidate.state.privatePath.leafIndex).not.toBe(state.privatePath.leafIndex)
      expect(candidate.sourceTree[state.privatePath.leafIndex * 2]).toMatchObject({ nodeType: 1 })
      expect(candidate.sourceTree[candidate.state.privatePath.leafIndex * 2]).toBeUndefined()
      expect(candidate.state.unappliedProposals[zeroRef]?.senderLeafIndex).toBe(0)
      expect(candidate.state.unappliedProposals['AQ==']?.senderLeafIndex).toBe(1)
      expect(candidate.state.unappliedProposals['Ag==']).toBeDefined()
      expect(candidate.state.unappliedProposals['Ag==']?.senderLeafIndex).toBeUndefined()
      expect(
        'format' in rejoin ? rejoin.source.identity?.authenticator : rejoin.source.authenticator,
      ).toEqual(stored.epochAuthenticator)
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
      expect(savedRejoin).toEqual(before)
      expect(
        (await restore(savedRejoin.candidate, savedRejoin.requestKey)).judgeVerdict(boundVerdict),
      ).toBe('authoritative')
      expect(await again.device.groups.resolve(groupID, mutationID)).toBe('committed')
      const snapshot = controlSnapshot
      const reset = applyChanges(snapshot, readmissionChanges(snapshot))
      expect(reset.rejoin).toBeNull()
      expect(reset.outcomes).toContainEqual(
        expect.objectContaining({ id: savedRejoin.id, kind: 'unknown' }),
      )
      expect(snapshot.rejoin).toEqual(savedRejoin)
      if (realPort.capturedRecovery !== undefined) {
        const { buildCapturedRejoinRecord } = (await import(
          new URL('../../rpc/test/fixtures/peer.ts', import.meta.url).href
        )) as {
          buildCapturedRejoinRecord(
            mls: GroupMLS,
            captureHead: LogPosition | null,
          ): Promise<CapturedRejoinRecord>
        }
        const prepared = await buildCapturedRejoinRecord(realPort, null)
        expect(prepared.source.identity?.epoch).toBe(saved.epoch)
        expect(prepared.source.stateVersion).toBe(saved.version)
        const restored = await realPort.capturedRecovery.restoreRecovery(
          prepared.candidate,
          prepared.requestKey,
        )
        expect(restored.source).toEqual(prepared.source)
        expect(restored.target).toEqual(prepared.target)
        expect(decodeCapturedRecoveryCandidate(restored.serialize(), prepared.requestKey)).toEqual(
          decodeCapturedRecoveryCandidate(prepared.candidate, prepared.requestKey),
        )
      }
    } finally {
      await fixture.close()
    }
  },
)

test('reopens canonical checkpoint bytes without sharing mutable MLS state', async () => {
  const groupID = 'checkpoint-codec-reopen'
  const identity = randomIdentity()
  const fixture = await createStorageFixture({ id: groupID, mode: 'real-mls', identity })
  const key = { groupID, incarnation: 1 }
  try {
    const groups = fixture.ports.device.groups
    const trust = await groups.loadTrust(groupID)
    const stored = await groups.loadState(key)
    if (trust === null || stored === null || stored.deleted || stored.state === null)
      throw new Error('Missing installed state')
    const client = decodeClientState(stored.state)
    if (client === undefined) throw new Error('Invalid MLS state')
    const fact = {
      v: 1 as const,
      key,
      epoch: stored.epoch,
      ciphersuite: 1,
      genesisHash: checkpointGenesisHash(trust.genesisAnchor),
      authHash: checkpointAuthHash({
        groupID,
        genesisHash: checkpointGenesisHash(trust.genesisAnchor),
        epoch: stored.epoch,
        epochAuthenticator: stored.epochAuthenticator,
      }),
      parentAuthHash: null,
      confirmedTranscriptHash: toB64U(client.groupContext.confirmedTranscriptHash),
      members: [
        {
          signerDID: identity.id,
          keyHash: checkpointKeyHash(identity.publicKey),
          leafIndex: 0,
          signaturePublicKey: toB64U(identity.publicKey),
        },
      ],
      installation: { mutationID: 'seed', stateVersion: 1 },
    }
    const canonical = encodeEpochRosterFact(fact)
    const before = canonical.slice()
    await groups.transition(
      await nextChange(groups, groupID, 'store-canonical-checkpoint'),
      (stores) =>
        stores.checkpoints.put({
          kind: 'fact',
          id: 'installed-fact',
          key,
          epoch: stored.epoch,
          canonical,
          supersededAt: null,
        }),
    )
    canonical.fill(0)
    client.groupContext.confirmedTranscriptHash.fill(0)
    await fixture.reopen()
    const rows = await fixture.entry().read(groupID, (reads) => reads.checkpoints())
    const saved = rows[0]
    if (saved?.kind !== 'fact') throw new Error('Missing checkpoint fact')
    expect(saved.canonical).toEqual(before)
    expect(decodeEpochRosterFact(saved.canonical)).toEqual(fact)
    const physicalRecord = (await fixture.inspectRawBytes()).find(
      (row) => row.namespace === 'checkpoints',
    )
    expect(physicalRecord?.incarnation).toBeNull()
    expect(physicalRecord?.bytes).not.toEqual(before)
    saved.canonical.fill(0)
    const again = await fixture.entry().read(groupID, (reads) => reads.checkpoints())
    expect(again[0]).toMatchObject({ canonical: before })
  } finally {
    await fixture.close()
  }
})
