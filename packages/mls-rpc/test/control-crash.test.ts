import { randomIdentity } from '@kokuin/token'
import { decodeClientState, encodeClientState, encodeGroupAnchor } from '@kumiai/mls'
import { asLogPosition, encodeCommitFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '@kumiai/rpc'
import { testCommitOnceConformance } from '@kumiai/rpc-conformance'
import { expect, test } from 'vitest'

import { testControlCrashBoundaries } from './fixtures/control-crash.js'
import { buildRealUnavailableCommit, createRealGroup } from './fixtures/real-group.js'
import {
  createControlCrashHarness,
  runControlProofConflict,
} from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

for (const mode of ['double', 'real-mls'] as const) {
  testControlCrashBoundaries(mode)
  testCommitOnceConformance({
    label: `sealed provider: ${mode}`,
    scenarios: ['ownership-conflict'],
    run: () => runControlProofConflict(mode),
  })
  test(`unavailable earlier frame holds exact own commit without adoption or Welcome (${mode})`, async () => {
    const real = mode === 'real-mls' ? await createRealGroup(3, 'control-crash') : undefined
    const seed =
      real === undefined
        ? undefined
        : await makeStorageSeed({
            id: 'control-crash',
            incarnation: 1,
            epoch: 3,
            mode,
          })
    if (seed !== undefined && real !== undefined) {
      const handle = real.committer.handle
      seed.confirmedTranscriptHash = handle.state.groupContext.confirmedTranscriptHash.slice()
      seed.state = {
        ...seed.state,
        state: encodeClientState(handle.state),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
        credential: handle.credential,
        ledger: handle.ledgerTokens,
      }
      seed.trust = {
        ...seed.trust,
        genesisAnchor: encodeGroupAnchor(handle.anchor),
        installed: {
          ...seed.key,
          epoch: 3,
          authenticator: handle.state.keySchedule.epochAuthenticator,
        },
        signerTree: handle.state.ratchetTree,
        registry: handle.registry,
        credential: handle.credential,
        ledger: handle.ledgerTokens,
        spentEpochAuthenticators: [handle.state.keySchedule.epochAuthenticator],
      }
    }
    const h = await createControlCrashHarness(mode, seed)
    try {
      await h.peer.resync()
      const built = await h.build()
      expect(await h.saveBuilt(built.intent, built.slot, built.expected, 'built')).toBe('saved')
      const competitor = real?.members[0]
      if (real !== undefined && competitor === undefined) throw new Error('Missing competitor')
      const commit =
        real === undefined || competitor === undefined
          ? new TextEncoder().encode(
              JSON.stringify({
                epoch: 3,
                committerDID: randomIdentity().id,
                entryIDs: [],
                missingProposal: true,
              }),
            )
          : await buildRealUnavailableCommit({
              ...real,
              committer: competitor,
              members: [real.committer],
            })
      const topicID = await h.topic()
      const prefixPayload = encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(commit, new Uint8Array()),
      )
      const prefix = await h.hub.publish({
        senderDID: h.localDID,
        topicID,
        retain: 'log',
        payload: prefixPayload,
      })
      await h.hub.publish({
        senderDID: h.localDID,
        topicID,
        retain: 'log',
        payload: built.slot.payload,
        publishID: built.slot.publishID,
      })
      const before = await h.groups.loadState(h.key)
      if (before === null || before.deleted) throw new Error('Missing source state')
      await h.controlWalk.stepOperation(built.intent.id)
      const saved = await h.control.load()
      expect(h.observations.ownAdoptions).toBe(0)
      expect(saved.commitOnceAcceptance).toBeNull()
      expect(saved.controlHold).toMatchObject({ reason: 'acceptance-unknown' })
      expect(saved.commitOnce).toEqual(built.slot)
      expect(saved.applied).toEqual([])
      expect(saved.welcomes).toEqual([])
      expect(saved.outcomes.some((row) => row.kind === 'landed')).toBe(false)
      expect(await h.groups.loadState(h.key)).toMatchObject({
        epoch: before.epoch,
        epochAuthenticator: before.epochAuthenticator,
        state: before.state,
      })
      expect(h.observations.welcomeDeliveries).toBe(0)
      const validation = await h.validation.restoreValidation(built.slot)
      expect(
        await validation?.validateFrame(
          {
            position: asLogPosition(prefix.sequenceID),
            payload: prefixPayload,
            senderDID: h.localDID,
          },
          built.slot,
        ),
      ).toEqual({ kind: 'unavailable', reason: 'missing-proposal' })
    } finally {
      await h.fixture.close()
    }
  })
}

test('double control builds and reconstructs independent memory MLS state', async () => {
  const h = await createControlCrashHarness('double')
  try {
    const stored = await h.groups.loadState(h.key)
    if (stored === null || stored.deleted || stored.state === null) throw new Error('Missing state')
    const state = decodeClientState(stored.state)
    if (state === undefined) throw new Error('Invalid state')
    expect(new TextDecoder().decode(state.confirmationTag)).toMatch(/^\{"epoch":3,"slots":/)
    const built = await h.build()
    const { decodeControlJournal } = await import('../src/control-journal.js')
    const candidate = decodeClientState(decodeControlJournal(built.slot.journal).candidate)
    if (candidate === undefined) throw new Error('Invalid candidate')
    expect(JSON.parse(new TextDecoder().decode(candidate.confirmationTag))).toMatchObject({
      epoch: 4,
    })
    await h.saveBuilt(built.intent, built.slot, built.expected, 'built')
    const reopened = await h.reopen()
    expect((await reopened.control.load()).commitOnce).toEqual(built.slot)
  } finally {
    await h.fixture.close()
  }
})
