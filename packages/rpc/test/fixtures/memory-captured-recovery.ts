import { encodeMultibase } from '@kokuin/token'
import type { RosterAbsenceFixture, RosterAbsenceScenario } from '@kumiai/rpc-conformance'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U, toUTF } from '@sozai/codec'

import { digestAppliedCommit } from '../../src/classify.js'
import { encodeCommitFrame } from '../../src/commit-frame.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import type { CapturedPendingRecovery, CapturedRejoinRecord } from '../../src/recovery-types.js'
import { createMemoryGroupMLS, encodeMemoryCommit } from './memory-group-mls.js'

export function memoryCapturedRecord(
  pending: CapturedPendingRecovery,
  request: Uint8Array,
  requestKey: Uint8Array,
  requestID: string,
): CapturedRejoinRecord {
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(pending.commit, new Uint8Array()),
  )
  return {
    format: 2,
    id: requestID,
    publishID: requestID,
    stage: 'built',
    source: pending.source,
    target: pending.target,
    captureHead: pending.target.captureHead,
    searchFrom: pending.target.captureHead,
    expectedHead: pending.target.captureHead,
    trigger: 'automatic',
    authorisationID: null,
    switchMutationID: null,
    destinationKey: null,
    payload,
    payloadDigest: digestAppliedCommit(payload),
    digest: digestAppliedCommit(pending.commit),
    requestID,
    request,
    requestKey,
    candidate: pending.serialize(),
    epochAfter: pending.epoch,
    ledgerBefore: [],
  }
}

export async function createCapturedMemoryRecovery(
  target = { targetID: 'hub', topicID: 'commits' },
) {
  const trust = {
    groupID: 'memory-capture',
    ownerDID: 'alice',
    members: ['alice', 'bob'],
    controller: 'controller',
    signerControllers: { alice: 'controller', bob: 'controller' },
    revoked: [] as Array<string>,
  }
  const source = {
    key: { groupID: trust.groupID, incarnation: 1 },
    stateVersion: 1,
    identity: null,
    lifetimeRevision: 1,
    trust,
    trustDigest: toB64U(sha256(fromUTF(JSON.stringify(trust)))),
  }
  let accepted = 0
  let sourceError: Error | null = null
  const options = {
    groupID: trust.groupID,
    members: trust.members,
    binding: { id: 'controller', prefix: [], capability: 'captured-capability' },
  }
  const requester = createMemoryGroupMLS({
    ...options,
    localDID: 'alice',
    capturedRecovery: {
      target,
      readSource: async () => {
        if (sourceError !== null) throw sourceError
        return source
      },
      accept: async () => {
        accepted++
      },
    },
  })
  const responder = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  return {
    invalidateRetainedSigner(kind: 'missing' | 'wrong-controller' | 'revoked') {
      if (kind === 'missing') trust.members = trust.members.filter((did) => did !== 'bob')
      else if (kind === 'wrong-controller') trust.signerControllers.bob = 'foreign-controller'
      else trust.revoked.push('bob')
      source.trustDigest = toB64U(sha256(fromUTF(JSON.stringify(trust))))
    },
    requester,
    responder,
    failSource: (error: Error) => {
      sourceError = error
    },
    async restartResponder() {
      const database = responder.database()
      const state = await database.loadState(trust.groupID)
      if (state === null) throw new Error('Missing responder state')
      const restarted = createMemoryGroupMLS({ ...options, localDID: 'bob', hostDB: database })
      restarted.restoreState(state)
      return restarted
    },
    record: memoryCapturedRecord,
    confirmationTag: (key: Uint8Array, requestID: string) =>
      encodeMultibase(hmac(sha256, key, fromUTF(requestID))),
    accepted: () => accepted,
  }
}

export async function createRosterAbsenceMemoryFixture(
  scenario: RosterAbsenceScenario = 'absent',
): Promise<RosterAbsenceFixture> {
  const groupID = `roster-double-${crypto.randomUUID()}`
  const trust = {
    groupID,
    ownerDID: 'alice',
    members: ['alice', 'bob'],
    revoked: [] as Array<string>,
  }
  const source = {
    key: { groupID, incarnation: 1 },
    stateVersion: 1,
    identity: null,
    lifetimeRevision: 1,
    trust,
    trustDigest: toB64U(sha256(fromUTF(JSON.stringify(trust)))),
  }
  const options = { groupID, members: ['alice', 'bob'], epoch: 1 }
  const requester = createMemoryGroupMLS({
    ...options,
    localDID: 'alice',
    capturedRecovery: {
      target: { targetID: 'hub', topicID: 'commits' },
      readSource: async () => source,
      accept: async () => {
        throw new Error('Verification cannot adopt')
      },
    },
  })
  const responderSource = { ...source, trust: { ...trust, ownerDID: 'bob' }, trustDigest: '' }
  responderSource.trustDigest = toB64U(sha256(fromUTF(JSON.stringify(responderSource.trust))))
  const responder = createMemoryGroupMLS({
    ...options,
    localDID: 'bob',
    capturedRecovery: {
      target: { targetID: 'hub', topicID: 'commits' },
      readSource: async () => responderSource,
      accept: async () => {
        throw new Error('Unexpected adoption')
      },
    },
  })
  await requester.persistInitialState()
  await responder.persistInitialState()
  const saved = await requester.createRecoveryRequest('saved-rejoin')
  const captured = requester.capturedRecovery
  if (captured === undefined) throw new Error('Missing captured requester')
  const pending = await captured.applyRecovery(
    await responder.sealGroupInfo(saved.request, null),
    'saved-rejoin',
    saved.requestKey,
  )
  if (pending === null || 'renewalRequired' in pending) throw new Error('Missing saved rejoin')
  await requester
    .control()
    .apply(
      { putRejoin: memoryCapturedRecord(pending, saved.request, saved.requestKey, 'saved-rejoin') },
      'save-rejoin',
    )
  await responder.processCommit(
    encodeMemoryCommit(
      1,
      'alice',
      [],
      scenario === 'present' ? { external: true, branch: 'fresh-leaf' } : { removes: ['alice'] },
    ),
    {},
  )
  if (scenario === 'wrong-key' || scenario === 'expired' || scenario === 'imported') {
    const state = JSON.parse(toUTF(responder.serializeState())) as {
      rosterHistory: Array<{
        epoch: number
        members: Array<{ did: string; keyHash: string }>
        supersededAt: number | null
      }>
    }
    for (const fact of state.rosterHistory) {
      if (fact.epoch >= 2) continue
      if (scenario === 'wrong-key')
        for (const member of fact.members)
          if (member.did === 'alice') member.keyHash = toB64U(new Uint8Array(32))
      if (scenario === 'expired') fact.supersededAt = Date.now() - 604800001
    }
    if (scenario === 'imported')
      state.rosterHistory = state.rosterHistory.filter((fact) => fact.epoch >= 2)
    responder.restoreState(fromUTF(JSON.stringify(state)))
  }
  return {
    requester,
    responder,
    epoch: 2,
    requesterDID: 'alice',
    responderDID: 'bob',
    async refuseResponder(reason) {
      await responder.control().apply(
        reason === 'fork-halted'
          ? {
              forkHalt: {
                eventID: JSON.stringify(['group:fork', groupID, 1]),
                detectedAt: 1,
                evidence: {
                  kind: 'unexplained-own-commit',
                  epoch: 2,
                  position: 'head',
                  digest: 'conflict',
                },
              },
            }
          : {
              cursor: {
                position: null,
                epoch: reason === 'epoch-mismatch' ? 1 : 2,
                ...(reason === 'stranded' ? { stranded: true as const } : {}),
                ...(reason === 'incomplete' ? { incomplete: true as const } : {}),
              },
            },
        crypto.randomUUID(),
      )
    },
    comparisonEpoch: async (request) =>
      (JSON.parse(toUTF(request)) as { comparisonEpoch?: number }).comparisonEpoch,
    invalidateSigner() {
      trust.revoked.push('bob')
      source.trustDigest = toB64U(sha256(fromUTF(JSON.stringify(trust))))
    },
    snapshot: async () => ({
      attempt: (await requester.control().load()).rejoin,
      state: {
        bytes: requester.serializeState(),
        control: await requester.control().load(),
        source: await requester.readRecoverySource(),
      },
    }),
    close: async () => {},
  }
}
