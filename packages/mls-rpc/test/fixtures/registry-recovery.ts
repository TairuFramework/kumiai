import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ClientState,
  commitInvite,
  confirmationTag,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  createRecoveryRequest,
  decodeClientState,
  encodeClientState,
  exportGroupInfo,
  type GroupHandle,
  type GroupOptions,
  joinGroupExternal,
  processWelcome,
  sealRecoveryVerdict,
} from '@kumiai/mls'
import {
  asLogPosition,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  type RejoinRecord,
} from '@kumiai/rpc'

import { createGroupCrypto } from '../../src/crypto.js'
import type { GroupKey } from '../../src/persistence-types.js'
import { createVerdictJudge } from '../../src/recovery.js'
import { encodeRecoveryCandidate } from '../../src/recovery-codec.js'
import { testHandleAccess } from './real-group.js'
import { memoryModel, restoreMemoryControlHandle } from './sealed-memory-mls.js'

export async function createRegistryRecovery(params: {
  mode: 'real-mls' | 'double'
  identity: OwnIdentity
  options: GroupOptions
  source: GroupHandle
  sourceKey: GroupKey
}): Promise<{ candidate: GroupHandle; record: RejoinRecord }> {
  const signer = randomIdentity()
  const requestID = crypto.randomUUID()
  let candidate: GroupHandle
  let remote: GroupHandle
  let sourceTree: ClientState['ratchetTree']
  let groupInfo: Uint8Array
  let commit: Uint8Array
  let replyLedger: Array<string>
  if (params.mode === 'real-mls') {
    const bundle = await createKeyPackageBundle(signer)
    const { invite } = await createInvite({
      group: params.source,
      identity: params.identity,
      recipientDID: signer.id,
      permission: 'member',
    })
    const added = await commitInvite(params.source, bundle.publicPackage, invite)
    remote = (
      await processWelcome({
        identity: signer,
        invite,
        welcome: added.welcomeMessage,
        keyPackageBundle: bundle,
        options: params.options,
      })
    ).group
    groupInfo = (await exportGroupInfo({ group: remote })).groupInfo
    const joined = await joinGroupExternal({
      identity: params.identity,
      groupInfo,
      credential: params.source.credential,
      resync: true,
      options: params.options,
    })
    candidate = joined.group
    commit = joined.commitMessage
    sourceTree = remote.state.ratchetTree
    replyLedger = remote.ledgerTokens
  } else {
    const copy = () =>
      restoreMemoryControlHandle({
        state: structuredClone(params.source.state),
        credential: params.source.credential,
        ledgerEntries: params.source.ledgerTokens,
        options: params.options,
      })
    const responder = await copy()
    const responseModel = memoryModel(responder)
    await responseModel.adopt(responseModel.buildCommit([], { adds: [signer.id] }))
    sourceTree = responder.state.ratchetTree
    replyLedger = responder.ledgerTokens
    candidate = await copy()
    const requester = memoryModel(candidate)
    const request = await requester.createRecoveryRequest(requestID)
    groupInfo = await responseModel.sealGroupInfo(request.request)
    const pending = await requester.applyRecovery(groupInfo, requestID, request.requestKey)
    if (pending === null || 'renewalRequired' in pending)
      throw new Error('Missing memory recovery candidate')
    commit = pending.commit
    await pending.onAccepted(() => ({ mutationID: crypto.randomUUID(), changes: {} }))
    await candidate.bootstrapLedger(replyLedger)
    // Verdict transport uses genuine HPKE and signing even for independent model candidates.
    remote = (await createGroup(signer, params.source.groupID, params.options)).group
  }
  const request = await createRecoveryRequest({
    group: params.source,
    identity: params.identity,
    requestID,
  })
  const digest = digestAppliedCommit(commit)
  const position = asLogPosition('registry-recovery-position')
  const judge = createVerdictJudge({
    group: candidate,
    sourceTree,
    known: params.source.registry,
    requestID,
  })
  const key = await judge.confirmationKey(position, digest)
  const verdict = await sealRecoveryVerdict({
    group: remote,
    identity: signer,
    request: request.request,
    verdict: {
      groupID: candidate.groupID,
      requestID,
      position,
      commitDigest: digest,
      verdict: 'confirmed',
      epoch: Number(candidate.epoch),
      tag: confirmationTag(key, requestID),
    },
  })
  const access = testHandleAccess({ handle: () => params.source, adopt: () => {} })
  const entries = await createGroupCrypto({ access }).sealEntries(new TextEncoder().encode('[]'))
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(commit, entries.sealed),
  )
  const state = decodeClientState(encodeClientState(candidate.state))
  if (state === undefined) throw new Error('Invalid recovery candidate')
  return {
    candidate,
    record: {
      id: crypto.randomUUID(),
      stage: 'confirmed',
      publishID: crypto.randomUUID(),
      expectedHead: null,
      payload,
      payloadDigest: digestAppliedCommit(payload),
      requestID,
      request: new TextEncoder().encode(request.request),
      requestKey: request.ephemeralPrivateKey,
      candidate: encodeRecoveryCandidate(
        {
          state,
          sourceTree,
          groupInfo,
          knownRegistry: params.source.registry,
          replyLedger,
          signer: signer.id,
          commit: commit,
          epoch: Number(candidate.epoch),
          requestID,
          boundCommit: judge.boundCommit(),
        },
        request.ephemeralPrivateKey,
      ),
      source: {
        key: params.sourceKey,
        epoch: Number(params.source.epoch),
        authenticator: params.source.state.keySchedule.epochAuthenticator.slice(),
        head: null,
      },
      digest,
      epochAfter: Number(candidate.epoch),
      ledgerBefore: params.source.ledgerTokens,
      conflictEpoch: null,
      position,
      verdict,
    },
  }
}
