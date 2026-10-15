import {
  confirmationTag,
  decodeClientState,
  encodeClientState,
  encodeGroupAnchor,
  restoreGroup,
} from '@kumiai/mls'
import {
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  type GroupMLS,
  HANDSHAKE_KIND,
  type LegacyRejoinRecord,
  type OpenedRecoveryVerdict,
} from '@kumiai/rpc'
import type { StorageTestPorts } from '@kumiai/rpc-conformance'
import { defaultProposalTypes } from 'ts-mls'

import { createGroupCrypto } from '../../src/crypto.js'
import { createGroupMLS, createLedgerEntrySlot } from '../../src/mls.js'
import type {
  GroupKey,
  MemoryTransaction,
  PersistenceFixture,
} from '../../src/persistence-types.js'
import type { RecoveryCandidate } from '../../src/recovery.js'
import { buildRealCommit, createRealGroup, testHandleAccess } from './real-group.js'
import { createStorageFixture } from './storage-persistence.js'

export async function createCodecReopenFixture(id: string): Promise<{
  fixture: PersistenceFixture<StorageTestPorts<MemoryTransaction>>
  key: GroupKey
  zeroRef: string
  boundVerdict: OpenedRecoveryVerdict
  realPort: GroupMLS
  mutationID: string
}> {
  // A vacant earlier leaf makes the real external rejoin change the requester's tree position.
  const real = await createRealGroup(3, id)
  const member = real.members[1]
  const responder = real.members[2]
  if (member == null || responder == null) throw new Error('Missing recovery member')
  const removed = await buildRealCommit(real, { removes: 0 })
  await member.handle.processMessage(removed)
  await responder.handle.processMessage(removed)
  const repeatedToken = member.handle.ledgerTokens[0]
  if (repeatedToken == null) throw new Error('Missing ledger token')
  await member.handle.applyLedgerEntries([repeatedToken])
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const requester = createGroupMLS({ identity: member.identity, access, entrySlot: member.slot })
  const remote = createGroupMLS({
    identity: responder.identity,
    access: testHandleAccess({
      handle: () => responder.handle,
      adopt: (next) => {
        responder.handle = next
      },
    }),
    entrySlot: responder.slot,
  })
  const requestID = 'candidate-request'
  const { request, requestKey } = await requester.createRecoveryRequest(requestID)
  const reply = await remote.sealGroupInfo(request)
  const pending = await requester.applyRecovery(reply, requestID, requestKey)
  if (pending == null || 'renewalRequired' in pending)
    throw new Error('Expected recovery candidate')
  const digest = digestAppliedCommit(pending.commit)
  const position = 'position-1'
  const confirmation = await pending.confirmationKey(position, digest)
  const boundVerdict: OpenedRecoveryVerdict = {
    signer: responder.identity.id,
    verdict: {
      groupID: id,
      requestID,
      position,
      commitDigest: digest,
      verdict: 'confirmed',
      epoch: pending.epoch,
      tag: confirmationTag(confirmation, requestID),
    },
  }
  const zeroRef = 'AA=='
  const proposals = {
    [zeroRef]: {
      proposal: { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } },
      senderLeafIndex: 0,
    },
    'AQ==': {
      proposal: { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } },
      senderLeafIndex: 1,
    },
    'Ag==': {
      proposal: { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } },
      senderLeafIndex: undefined,
    },
  }
  const source = member.handle
  const state = structuredClone({ ...source.state, unappliedProposals: proposals })
  const candidate = pending as RecoveryCandidate
  candidate.group.state.unappliedProposals = structuredClone(proposals)
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(
      pending.commit,
      (await createGroupCrypto({ access }).sealEntries(new TextEncoder().encode('[]'))).sealed,
    ),
  )
  const record: LegacyRejoinRecord = {
    id: 'rejoin-1',
    stage: 'built',
    publishID: 'publish-1',
    expectedHead: null,
    payload,
    payloadDigest: digestAppliedCommit(payload),
    requestID,
    request,
    requestKey,
    candidate: pending.serialize(),
    source: { ...(await requester.readRecoverySource()), head: null },
    digest,
    epochAfter: pending.epoch,
    ledgerBefore: source.ledgerTokens,
    conflictEpoch: null,
  }
  const key = { groupID: id, incarnation: 1 }
  const mutationID = 'codec-reopen'
  const fixture = await createStorageFixture({ id: `${id}-seed`, mode: 'real-mls' })
  try {
    await fixture.ports.device.groups.transition(
      { groupID: id, mutationID, expected: null },
      async (stores) => {
        await stores.lifetime.save({
          groupID: id,
          latestIncarnation: 1,
          activeIncarnation: 1,
          revision: 1,
          mutationID,
          restorePending: false,
        })
        await stores.trust.save({
          groupID: id,
          genesisAnchor: encodeGroupAnchor(source.anchor),
          installed: {
            ...key,
            epoch: Number(source.epoch),
            authenticator: state.keySchedule.epochAuthenticator.slice(),
          },
          signerTree: structuredClone(state.ratchetTree),
          registry: structuredClone(source.registry),
          credential: structuredClone(source.credential),
          binding: null,
          ledger: source.ledgerTokens,
          ciphersuiteName: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
          spentEpochAuthenticators: [state.keySchedule.epochAuthenticator.slice()],
        })
        const rows = stores.incarnation(1)
        await rows.state.save({
          ...key,
          version: 1,
          deleted: false,
          terminal: false,
          epoch: Number(source.epoch),
          epochAuthenticator: state.keySchedule.epochAuthenticator.slice(),
          state: encodeClientState(structuredClone(state)),
          credential: structuredClone(source.credential),
          ledger: source.ledgerTokens,
          senderHWM: 16,
        })
        await rows.control.apply({ putRejoin: record }, mutationID)
      },
    )
    // The new provider and handle consume only snapshot bytes; the host keeps its signing identity.
    const reopened = await fixture.reopen()
    const stored = await reopened.device.groups.loadState(key)
    if (stored == null || stored.deleted || stored.state == null) throw new Error('Missing state')
    const restoredState = decodeClientState(stored.state.slice())
    if (restoredState == null) throw new Error('Invalid state')
    let handle = await restoreGroup({
      state: restoredState,
      credential: structuredClone(stored.credential),
      ledgerEntries: stored.ledger.slice(),
    })
    const realPort = createGroupMLS({
      identity: member.identity,
      access: testHandleAccess({
        handle: () => handle,
        stateVersion: () => stored.version,
        adopt: (next) => {
          handle = next
        },
      }),
      entrySlot: createLedgerEntrySlot(),
    })
    return { fixture, key, zeroRef, boundVerdict, realPort, mutationID }
  } catch (error) {
    await fixture.close()
    throw error
  }
}
