import { type OwnIdentity, randomIdentity, stringifyToken } from '@kokuin/token'
import {
  type ClientState,
  type ControllerBinding,
  commitInvite,
  confirmationKey,
  confirmationTag,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  createRecoveryRequest,
  decodeClientState,
  decodeEpochCheckpoint,
  encodeClientState,
  exportGroupInfo,
  type GroupHandle,
  type GroupOptions,
  joinGroupExternal,
  processWelcome,
  type RecoveryVerdict,
  restoreGroup,
  sealCapturedGroupInfo,
  sealRecoveryVerdict,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  asLogPosition,
  type CapturedRejoinRecord,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  type LegacyRejoinRecord,
  type ResyncProof,
} from '@kumiai/rpc'

import { createGroupCrypto } from '../../src/crypto.js'
import type { GroupKey, GroupRecoveryTrust } from '../../src/persistence-types.js'
import {
  buildRecoveryCandidate,
  createRecoveryRequestFromTrust,
  createVerdictJudge,
} from '../../src/recovery.js'
import {
  decodeCapturedRecoveryCandidate,
  encodeRecoveryCandidate,
} from '../../src/recovery-codec.js'
import { recoveryTrustFor } from '../../src/registry/trust.js'
import type {
  LegacyRegistryRecoverySource,
  LegacyResyncProof,
  RegistryRecoverySource,
} from '../../src/registry/types.js'
import { testHandleAccess } from './real-group.js'
import { memoryModel, restoreMemoryControlHandle } from './sealed-memory-mls.js'

type RecoveryFixtureParams = {
  mode: 'real-mls' | 'double'
  identity: OwnIdentity
  options: GroupOptions
  source: GroupHandle
  sourceKey: GroupKey
  sourceTrust?: GroupRecoveryTrust
  missingLedger?: boolean
  responder?: { identity: OwnIdentity; group: GroupHandle }
  lineage?: Array<Uint8Array>
  recoverySource?: RegistryRecoverySource
}
export type LegacyRecoveryFixture = {
  candidate: GroupHandle
  record: LegacyRejoinRecord
  source: LegacyRegistryRecoverySource
  proof: LegacyResyncProof
  sealVerdict(params: {
    verdict?: Partial<RecoveryVerdict>
    identity?: OwnIdentity
    type?: string
    tamperSignature?: boolean
  }): Promise<Uint8Array>
}
export type CapturedRecoveryFixture = Omit<LegacyRecoveryFixture, 'record' | 'source' | 'proof'> & {
  record: CapturedRejoinRecord
  source: RegistryRecoverySource
  proof: ResyncProof
}

export function createRegistryRecovery(
  params: RecoveryFixtureParams & { format: 'captured'; recoverySource: RegistryRecoverySource },
): Promise<CapturedRecoveryFixture>
export function createRegistryRecovery(
  params: RecoveryFixtureParams & { format?: 'legacy' },
): Promise<LegacyRecoveryFixture>
export async function createRegistryRecovery(
  params: RecoveryFixtureParams & { format?: 'legacy' | 'captured' },
): Promise<LegacyRecoveryFixture | CapturedRecoveryFixture> {
  if (params.format !== 'captured') return createLegacyRegistryRecovery(params)
  const source = params.recoverySource
  if (source === undefined) throw new Error('Captured fixture requires a persisted recovery source')
  let responder = params.responder
  let capture = responder
  if (responder === undefined) {
    const member = randomIdentity()
    const bundle = await createKeyPackageBundle(member)
    const { invite } = await createInvite({
      group: params.source,
      identity: params.identity,
      recipientDID: member.id,
      permission: 'member',
    })
    const added = await commitInvite(params.source, bundle.publicPackage, invite)
    // The retained owner signs the advanced snapshot; the new member cannot attest the origin.
    capture = { identity: params.identity, group: added.newGroup }
    responder = {
      identity: member,
      group: (
        await processWelcome({
          identity: member,
          invite,
          welcome: added.welcomeMessage,
          keyPackageBundle: bundle,
          options: params.options,
        })
      ).group,
    }
  }
  if (capture === undefined) throw new Error('Missing capture signer')
  const requestID = crypto.randomUUID()
  const { request, requestKey } = await createRecoveryRequestFromTrust({
    trust: source.trust,
    identity: params.identity,
    requestID,
    comparisonEpoch:
      params.lineage?.[0] === undefined
        ? undefined
        : decodeEpochCheckpoint(params.lineage[0]).body.epoch,
  })
  const captureHead = null
  const sealed = await sealCapturedGroupInfo({
    group: capture.group,
    identity: capture.identity,
    request: new TextDecoder().decode(request),
    captureHead,
    lineage: params.lineage,
  })
  const pending = await buildRecoveryCandidate({
    source,
    sealed,
    requestID,
    requestKey,
    target: { targetID: 'registry-recovery-hub', topicID: `commits/${source.key.groupID}` },
    environment: {
      identity: params.identity,
      options: params.options,
      accept: async () => {
        throw new Error('Fixture preparation must not adopt')
      },
    },
  })
  if (pending === null || 'renewalRequired' in pending)
    throw new Error('Missing captured recovery candidate')
  const digest = digestAppliedCommit(pending.commit)
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(pending.commit, new Uint8Array()),
  )
  const payloadDigest = digestAppliedCommit(payload)
  const position = asLogPosition('registry-recovery-position')
  const boundKey = await pending.confirmationKey(position, digest)
  const responderState = decodeClientState(encodeClientState(responder.group.state))
  if (responderState === undefined) throw new Error('Invalid responder state')
  const accepted = await restoreGroup({
    state: responderState,
    credential: responder.group.credential,
    ledgerEntries: responder.group.ledgerTokens,
    options: params.options,
  })
  await accepted.processMessage(pending.commit)
  const key = await confirmationKey(accepted, position, digest)
  if (key.some((byte, index) => byte !== boundKey[index]))
    throw new Error('Responder confirmation does not match candidate')
  const verdict = await sealRecoveryVerdict({
    group: accepted,
    identity: responder.identity,
    request: new TextDecoder().decode(request),
    verdict: {
      groupID: source.key.groupID,
      requestID,
      position,
      commitDigest: digest,
      verdict: 'confirmed',
      epoch: Number(accepted.epoch),
      tag: confirmationTag(key, requestID),
    },
  })
  const snapshot = decodeCapturedRecoveryCandidate(pending.serialize(), requestKey)
  const candidate = await restoreGroup({
    state: snapshot.state,
    credential: source.trust.credential,
    ledgerEntries: snapshot.replyLedger,
    options: params.options,
  })
  await candidate.bootstrapLedger(responder.group.ledgerTokens)
  const missing = params.missingLedger
    ? await signLedgerEntry(params.identity, {
        type: 'kumiai.role',
        groupID: source.key.groupID,
        subject: params.identity.id,
        value: 'member',
      })
    : undefined
  const record: CapturedRejoinRecord = {
    format: 2,
    id: crypto.randomUUID(),
    stage: 'confirmed',
    publishID: crypto.randomUUID(),
    expectedHead: pending.target.captureHead,
    payload,
    payloadDigest,
    requestID,
    request,
    requestKey,
    candidate: pending.serialize(),
    source: pending.source,
    target: pending.target,
    captureHead: pending.target.captureHead,
    searchFrom: pending.target.captureHead,
    trigger: 'automatic',
    authorisationID: null,
    switchMutationID: crypto.randomUUID(),
    destinationKey: null,
    digest,
    epochAfter: pending.epoch,
    ledgerBefore:
      missing === undefined
        ? params.source.ledgerTokens
        : [missing, ...params.source.ledgerTokens, missing],
    position,
    verdict,
  }
  return {
    candidate,
    source,
    record,
    proof: { ...pending.target, position, payloadDigest, verdict },
    sealVerdict: verdictSealer({
      candidate,
      remote: accepted,
      signer: responder.identity,
      requestID,
      request: new TextDecoder().decode(request),
      position,
      digest,
      key,
    }),
  }
}

async function createLegacyRegistryRecovery(
  params: RecoveryFixtureParams,
): Promise<LegacyRecoveryFixture> {
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
  const state = decodeClientState(encodeClientState(candidate.state))
  if (state === undefined) throw new Error('Invalid recovery candidate')
  const trust = recoveryTrustFor(params.source, params.sourceKey, params.sourceTrust ?? null)
  trust.spentEpochAuthenticators.push(trust.installed.authenticator.slice())
  const missing = params.missingLedger
    ? await signLedgerEntry(params.identity, {
        type: 'kumiai.role',
        groupID: params.source.groupID,
        subject: params.identity.id,
        value: 'member',
      })
    : undefined
  const ledgerBefore =
    missing === undefined
      ? params.source.ledgerTokens
      : [missing, ...params.source.ledgerTokens, missing]
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
    sealVerdict: verdictSealer({
      candidate,
      remote,
      signer,
      requestID,
      request: request.request,
      position,
      digest,
      key,
    }),
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
      ledgerBefore,
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

function verdictSealer(params: {
  candidate: GroupHandle
  remote: GroupHandle
  signer: OwnIdentity
  requestID: string
  request: string
  position: string
  digest: string
  key: Uint8Array
}): LegacyRecoveryFixture['sealVerdict'] {
  const { candidate, remote, signer, requestID, request, position, digest, key } = params
  return async (fault) => {
    const identity = fault.identity ?? signer
    const token = await identity.signToken(
      {
        groupID: candidate.groupID,
        requestID,
        position,
        commitDigest: digest,
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
      request,
      plaintext: utf8.encode(text),
      requireMember: false,
    })
  }
}
