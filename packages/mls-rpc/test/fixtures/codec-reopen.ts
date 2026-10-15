import { confirmationTag, decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import {
  type ControlSnapshot,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  type GroupMLS,
  HANDSHAKE_KIND,
  type LegacyRejoinRecord,
  type OpenedRecoveryVerdict,
  type StoredRejoinRecord,
} from '@kumiai/rpc'
import type { StorageTestPorts } from '@kumiai/rpc-conformance'
import { defaultProposalTypes } from 'ts-mls'

import { createGroupCrypto } from '../../src/crypto.js'
import { entryCapability } from '../../src/entry-capability.js'
import { createGroupMLS, createLedgerEntrySlot } from '../../src/mls.js'
import type {
  GroupKey,
  MemoryTransaction,
  PersistenceFixture,
} from '../../src/persistence-types.js'
import type { RecoveryCandidate } from '../../src/recovery.js'
import {
  decodeCapturedRecoveryCandidate,
  encodeCapturedRecoveryCandidate,
} from '../../src/recovery-codec.js'
import { readRecoverySource } from '../../src/registry/source.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import { capturedRecord } from './captured-recovery.js'
import {
  buildRealCommit,
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from './real-group.js'
import { createStorageFixture } from './storage-persistence.js'

export async function createCodecReopenFixture(
  id: string,
  format: 'legacy' | 'captured' = 'legacy',
): Promise<{
  fixture: PersistenceFixture<StorageTestPorts<MemoryTransaction>>
  key: GroupKey
  zeroRef: string
  boundVerdict: OpenedRecoveryVerdict
  realPort: GroupMLS
  mutationID: string
  sourceStateVersion: number
  controlSnapshot: ControlSnapshot
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
  const key = { groupID: id, incarnation: 1 }
  const mutationID = 'codec-reopen'
  const fixture = await createStorageFixture({ id: `${id}-seed`, mode: 'real-mls' })
  const trust = recoveryTrustFor(source, key, null)
  trust.spentEpochAuthenticators.push(trust.installed.authenticator.slice())
  await fixture.ports.device.groups.transition(
    { groupID: id, mutationID: `${mutationID}-seed`, expected: null },
    async (stores) => {
      await stores.lifetime.save({
        groupID: id,
        latestIncarnation: 1,
        activeIncarnation: 1,
        revision: 1,
        mutationID: `${mutationID}-seed`,
        restorePending: false,
      })
      await stores.trust.save(trust)
      await stores.incarnation(1).state.save({
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
    },
  )
  const recoveryAdoption = (groups: typeof fixture.ports.device.groups) => ({
    target: { targetID: 'codec-reopen-hub', topicID: `commits/${id}` },
    environment: { identity: member.identity, options: {} },
    readRecoverySource: async () => {
      const capability = entryCapability(groups)
      if (capability === null) throw new Error('Missing recovery source reader')
      return await capability.read(id, (reads) => readRecoverySource(reads, id))
    },
    accept: async () => {
      throw new Error('Codec fixture must not adopt')
    },
  })
  const sourceStateVersion = (
    await recoveryAdoption(fixture.ports.device.groups).readRecoverySource()
  ).stateVersion
  const access = testHandleAccess({
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
  })
  const requester = createGroupMLS({
    identity: member.identity,
    ...testGroupMLSDependencies(access),
    entrySlot: member.slot,
    ...(format === 'captured'
      ? { recoveryAdoption: recoveryAdoption(fixture.ports.device.groups) }
      : {}),
  })
  const remote = createGroupMLS({
    identity: responder.identity,
    ...testGroupMLSDependencies(
      testHandleAccess({
        handle: () => responder.handle,
        adopt: (next) => {
          responder.handle = next
        },
      }),
    ),
    entrySlot: responder.slot,
  })
  const requestID = 'candidate-request'
  const { request, requestKey } = await requester.createRecoveryRequest(requestID)
  const captured = requester.capturedRecovery
  const reply = captured
    ? await remote.sealGroupInfo(request, null)
    : await remote.sealGroupInfo(request)
  let pending = captured
    ? await captured.applyRecovery(reply, requestID, requestKey)
    : await requester.applyRecovery(reply, requestID, requestKey)
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
  if ('source' in pending) {
    const snapshot = decodeCapturedRecoveryCandidate(pending.serialize(), requestKey)
    snapshot.state.unappliedProposals = structuredClone(proposals)
    if (captured === undefined) throw new Error('Missing captured recovery port')
    pending = await captured.restoreRecovery(
      encodeCapturedRecoveryCandidate(snapshot, requestKey),
      requestKey,
    )
  } else {
    const candidate = pending as RecoveryCandidate
    candidate.group.state.unappliedProposals = structuredClone(proposals)
  }
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(
      pending.commit,
      (await createGroupCrypto({ access }).sealEntries(new TextEncoder().encode('[]'))).sealed,
    ),
  )
  const legacySource = await requester.readRecoverySource()
  const legacyIdentity = legacySource.identity
  if (legacyIdentity === null) throw new Error('Missing source identity')
  const legacyRecord = (): LegacyRejoinRecord => ({
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
    source: {
      ...legacySource,
      epoch: legacyIdentity.epoch,
      authenticator: legacyIdentity.authenticator.slice(),
      head: null,
    },
    digest,
    epochAfter: pending.epoch,
    ledgerBefore: source.ledgerTokens,
    conflictEpoch: null,
  })

  const record: StoredRejoinRecord =
    'source' in pending
      ? {
          ...capturedRecord(pending, request, requestKey, requestID),
          ledgerBefore: source.ledgerTokens,
        }
      : legacyRecord()
  try {
    await fixture.ports.device.groups.ports(key).control.apply({ putRejoin: record }, mutationID)
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
      ...testGroupMLSDependencies(
        testHandleAccess({
          handle: () => handle,
          stateVersion: () => stored.version,
          adopt: (next) => {
            handle = next
          },
        }),
        reopened.device.groups.ports(key).control,
      ),
      entrySlot: createLedgerEntrySlot(),
      ...(format === 'captured'
        ? { recoveryAdoption: recoveryAdoption(reopened.device.groups) }
        : {}),
    })
    const controlSnapshot = await reopened.device.groups.ports(key).control.load()
    return {
      fixture,
      key,
      zeroRef,
      boundVerdict,
      realPort,
      mutationID,
      sourceStateVersion,
      controlSnapshot,
    }
  } catch (error) {
    await fixture.close()
    throw error
  }
}
