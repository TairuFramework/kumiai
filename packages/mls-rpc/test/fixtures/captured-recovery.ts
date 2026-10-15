import { confirmationTag, decodeClientState, restoreGroup } from '@kumiai/mls'
import {
  type CapturedPendingRecovery,
  type CapturedRejoinRecord,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'

import { createGroupMLS } from '../../src/mls.js'
import { recoveryTrustDigest } from '../../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import {
  createRealGroup,
  persistedTestAccess,
  type RealMember,
  testGroupMLSDependencies,
} from './real-group.js'
import {
  createTransactionalAccess,
  createTransactionalStore,
  type TransactionalStore,
} from './transactional-access.js'

export function capturedRecord(
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

export async function createCapturedRealRecovery(transactional = false) {
  const real = await createRealGroup(2, `captured-contract-${crypto.randomUUID()}`)
  const requester = real.members[0]
  const responder = real.members[1]
  if (requester === undefined || responder === undefined)
    throw new Error('Missing captured members')
  const trust = recoveryTrustFor(
    requester.handle,
    { groupID: requester.handle.groupID, incarnation: 1 },
    null,
  )
  const source = {
    key: { groupID: trust.groupID, incarnation: 1 },
    stateVersion: 1,
    lifetimeRevision: 1,
    identity: null,
    trust,
    trustDigest: recoveryTrustDigest(trust),
  }
  let accepted = 0
  const make = async (member: RealMember, store: TransactionalStore, recovery: boolean) => {
    const access = transactional
      ? (await createTransactionalAccess(member, store)).access
      : persistedTestAccess(
          {
            handle: () => member.handle,
            adopt: (next) => {
              member.handle = next
            },
          },
          store,
        )
    return createGroupMLS({
      ...testGroupMLSDependencies(access, store.control),
      identity: member.identity,
      entrySlot: member.slot,
      ...(recovery
        ? {
            recoveryAdoption: {
              target: { targetID: 'hub', topicID: 'commits' },
              environment: { identity: member.identity, options: {} },
              readRecoverySource: async () => source,
              accept: async () => {
                accepted++
              },
            },
          }
        : {}),
    })
  }
  const responderStore = createTransactionalStore(responder.handle)
  return {
    requester: await make(requester, createTransactionalStore(requester.handle), true),
    responder: await make(responder, responderStore, false),
    async restartResponder() {
      const store = await responderStore.fork()
      const row = store.snapshot()
      const state = decodeClientState(row.state)
      if (state == null) throw new Error('Missing responder state')
      const member = {
        ...responder,
        handle: await restoreGroup({
          state,
          credential: responder.handle.credential,
          ledgerEntries: row.ledger,
          options: { resolveLedgerEntries: responder.slot.resolve },
        }),
      }
      return await make(member, store, false)
    },
    record: capturedRecord,
    confirmationTag,
    accepted: () => accepted,
  }
}
