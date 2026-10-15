import { encodeMultibase } from '@kokuin/token'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U } from '@sozai/codec'

import { digestAppliedCommit } from '../../src/classify.js'
import { encodeCommitFrame } from '../../src/commit-frame.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import type { CapturedPendingRecovery, CapturedRejoinRecord } from '../../src/recovery-types.js'
import { createMemoryGroupMLS } from './memory-group-mls.js'

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
  const trust = { groupID: 'memory-capture', ownerDID: 'alice', members: ['alice', 'bob'] }
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
  const options = { groupID: trust.groupID, members: trust.members }
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
