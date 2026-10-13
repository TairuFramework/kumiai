import { type OwnIdentity, randomIdentity, stringifyToken } from '@kokuin/token'
import {
  type ClientState,
  type ControllerBinding,
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
  type RecoveryVerdict,
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
import type { GroupKey, GroupRecoveryTrust } from '../../src/persistence-types.js'
import { createVerdictJudge } from '../../src/recovery.js'
import { encodeRecoveryCandidate } from '../../src/recovery-codec.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import type { RecoverySource, ResyncProof } from '../../src/registry/types.js'
import { testHandleAccess } from './real-group.js'
import { memoryModel, restoreMemoryControlHandle } from './sealed-memory-mls.js'

export async function createRegistryRecovery(params: {
  mode: 'real-mls' | 'double'
  identity: OwnIdentity
  options: GroupOptions
  source: GroupHandle
  sourceKey: GroupKey
  sourceTrust?: GroupRecoveryTrust
  responder?: { identity: OwnIdentity; group: GroupHandle }
}): Promise<{
  candidate: GroupHandle
  record: RejoinRecord
  source: RecoverySource
  proof: ResyncProof
  sealVerdict(params: {
    verdict?: Partial<RecoveryVerdict>
    identity?: OwnIdentity
    type?: string
    tamperSignature?: boolean
  }): Promise<Uint8Array>
}> {
  const signer = params.responder?.identity ?? randomIdentity()
  const requestID = crypto.randomUUID()
  let candidate: GroupHandle
  let remote: GroupHandle
  let sourceTree: ClientState['ratchetTree']
  let groupInfo: Uint8Array
  let commit: Uint8Array
  let replyLedger: Array<string>
  if (params.mode === 'real-mls') {
    if (params.responder != null) remote = params.responder.group
    else {
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
    }
    groupInfo = (await exportGroupInfo({ group: remote })).groupInfo
    const joined = await joinGroupExternal({
      identity: params.identity,
      groupInfo,
      credential: params.source.credential,
      resync: true,
      ...(params.source.anchor.controller == null
        ? {}
        : {
            controller: sourceBinding(params.source),
          }),
      options: params.options,
    })
    candidate = joined.group
    commit = joined.commitMessage
    sourceTree = params.source.state.ratchetTree
    replyLedger = remote.ledgerTokens
  } else {
    const copy = (handle = params.source) =>
      restoreMemoryControlHandle({
        state: structuredClone(handle.state),
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
        options: params.options,
      })
    const responder = await copy(params.responder?.group)
    const responseModel = memoryModel(responder)
    if (params.responder == null)
      await responseModel.adopt(responseModel.buildCommit([], { adds: [signer.id] }))
    sourceTree = params.source.state.ratchetTree
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
    // Verdict transport uses genuine HPKE and signing even for independent model candidates.
    remote =
      params.responder?.group ??
      (await createGroup(signer, params.source.groupID, params.options)).group
  }
  await candidate.bootstrapLedger(replyLedger)
  if (params.mode === 'double') {
    const state = decodeClientState(encodeClientState(candidate.state))
    if (state == null) throw new Error('Invalid memory recovery candidate')
    // Canonical wire field order makes the model's nested receive snapshot stable across restore.
    candidate = await restoreMemoryControlHandle({
      state,
      credential: candidate.credential,
      ledgerEntries: replyLedger,
      options: params.options,
    })
  }
  const request = await createRecoveryRequest({
    group: params.source,
    identity: params.identity,
    requestID,
  })
  const digest = digestAppliedCommit(commit)
  const access = testHandleAccess({ handle: () => params.source, adopt: () => {} })
  const entries = await createGroupCrypto({ access }).sealEntries(new TextEncoder().encode('[]'))
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(commit, entries.sealed),
  )
  const payloadDigest = digestAppliedCommit(payload)
  const position = asLogPosition('registry-recovery-position')
  const judge = createVerdictJudge({
    group: candidate,
    sourceTree,
    known: params.source.registry,
    requestID,
  })
  const key = await judge.confirmationKey(position, payloadDigest)
  const verdict = await sealRecoveryVerdict({
    group: remote,
    identity: signer,
    request: request.request,
    verdict: {
      groupID: candidate.groupID,
      requestID,
      position,
      commitDigest: payloadDigest,
      verdict: 'confirmed',
      epoch: Number(candidate.epoch),
      tag: confirmationTag(key, requestID),
    },
  })
  const state = decodeClientState(encodeClientState(candidate.state))
  if (state === undefined) throw new Error('Invalid recovery candidate')
  const trust = recoveryTrustFor(params.source, params.sourceKey, params.sourceTrust ?? null)
  trust.spentEpochAuthenticators.push(trust.installed.authenticator.slice())
  return {
    candidate,
    source: {
      key: { ...params.sourceKey },
      stateVersion: 1,
      identity: { ...trust.installed, authenticator: trust.installed.authenticator.slice() },
      trust,
      lifetimeRevision: 1,
    },
    proof: {
      targetID: 'registry-recovery-hub',
      topicID: `commits/${candidate.groupID}`,
      groupInfoEpoch: Number(params.source.epoch),
      captureHead: null,
      position,
      payloadDigest,
      verdict,
    },
    async sealVerdict(fault) {
      const identity = fault.identity ?? signer
      const token = await identity.signToken(
        {
          groupID: candidate.groupID,
          requestID,
          position,
          commitDigest: payloadDigest,
          verdict: 'confirmed',
          epoch: Number(candidate.epoch),
          tag: confirmationTag(key, requestID),
          ...fault.verdict,
          type: fault.type ?? 'kumiai.recovery-verdict',
        },
        { embedLongForm: true },
      )
      let text = stringifyToken(token)
      if (fault.tamperSignature) {
        const parts = text.split('.')
        const signature = parts[2]
        if (signature == null) throw new Error('Missing signature')
        parts[2] = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
        text = parts.join('.')
      }
      const { sealToRequest } = (await import(
        new URL('../../../mls/src/recovery.ts', import.meta.url).href
      )) as {
        sealToRequest(params: {
          kind: {
            hpkeInfo: Uint8Array
            aadDomain: Uint8Array
            version: number
            fail: (reason: string, message: string) => Error
          }
          group: GroupHandle
          request: string
          plaintext: Uint8Array
          requireMember: boolean
        }): Promise<Uint8Array>
      }
      const utf8 = new TextEncoder()
      return sealToRequest({
        kind: {
          hpkeInfo: utf8.encode('kumiai/mls/recovery-verdict/v1'),
          aadDomain: utf8.encode('kumiai/mls/recovery-verdict-aad/v1'),
          version: 1,
          fail: (_reason, message) => new Error(message),
        },
        group: remote,
        request: request.request,
        plaintext: utf8.encode(text),
        requireMember: false,
      })
    },
    record: {
      id: crypto.randomUUID(),
      stage: 'confirmed',
      publishID: crypto.randomUUID(),
      expectedHead: null,
      payload,
      payloadDigest,
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

function sourceBinding(group: GroupHandle): ControllerBinding {
  const binding = group.bindingOfDID(group.credential.id)
  if (binding?.controller == null || binding.prefix == null || binding.capability == null)
    throw new Error('Missing source binding')
  return {
    id: binding.controller,
    prefix: binding.prefix,
    capability: binding.capability,
    ...(binding.holderGrant == null ? {} : { holderGrant: binding.holderGrant }),
  }
}
