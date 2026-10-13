import { normalizeDID } from '@kokuin/token'
import {
  type ClientState,
  decodeGroupAnchor,
  encodeClientState,
  type GroupHandle,
  openRecoveryVerdict,
  parseMLSCredentialIdentity,
  readGroupAnchorExtension,
  verifyRecoveryRequest,
} from '@kumiai/mls'
import {
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
  HANDSHAKE_KIND,
  type RejoinRecord,
} from '@kumiai/rpc'

import {
  type RegistryResyncRefusalReason,
  RegistryResyncRefusedError,
} from '../persistence-errors.js'
import { createVerdictJudge, knownRecoveryRegistry } from '../recovery.js'
import { decodeRecoveryCandidate } from '../recovery-codec.js'
import type { RecoverySource, ResyncProof } from './types.js'

function requireMatch(condition: boolean, reason: RegistryResyncRefusalReason): asserts condition {
  if (!condition) throw new RegistryResyncRefusedError({ reason })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Uint8Array || right instanceof Uint8Array)
    return left instanceof Uint8Array && right instanceof Uint8Array && sameBytes(left, right)
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!sameValue(left[index], right[index])) return false
    }
    return true
  }
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object')
    return false
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(left)) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(right))
  )
    return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
    )
  )
}

function ownCredential(state: ClientState) {
  const leaf = state.ratchetTree[state.privatePath.leafIndex * 2]
  if (leaf?.nodeType !== 1 || !('identity' in leaf.leaf.credential))
    throw new Error('Recovery own leaf missing')
  return parseMLSCredentialIdentity(leaf.leaf.credential.identity)
}

export async function verifyRegistryResync(params: {
  source: RecoverySource
  candidate: GroupHandle
  record: RejoinRecord
  proof: ResyncProof
}): Promise<void> {
  const { source, candidate, record, proof } = params
  let reason: RegistryResyncRefusalReason = 'malformed'
  try {
    requireMatch(
      proof != null &&
        typeof proof.targetID === 'string' &&
        proof.targetID.length > 0 &&
        typeof proof.topicID === 'string' &&
        proof.topicID.length > 0 &&
        Number.isSafeInteger(proof.groupInfoEpoch) &&
        proof.groupInfoEpoch >= 0 &&
        (proof.captureHead === null ||
          (typeof proof.captureHead === 'string' && proof.captureHead.length > 0)) &&
        typeof proof.position === 'string' &&
        proof.position.length > 0 &&
        typeof proof.payloadDigest === 'string' &&
        proof.payloadDigest.length > 0 &&
        proof.verdict instanceof Uint8Array,
      'malformed',
    )
    // Target/capture association is not persisted in this record; callers must authenticate it separately.
    requireMatch(record.stage === 'confirmed', 'unaccepted')
    requireMatch(
      record.position === proof.position &&
        record.payloadDigest === proof.payloadDigest &&
        record.verdict instanceof Uint8Array &&
        sameBytes(record.verdict, proof.verdict),
      'tuple',
    )

    reason = 'source'
    const installed = source.trust.installed
    requireMatch(
      source.identity !== null &&
        source.key.groupID === record.source.key.groupID &&
        source.key.incarnation === record.source.key.incarnation &&
        source.key.groupID === source.trust.groupID &&
        source.key.groupID === installed.groupID &&
        source.key.incarnation === installed.incarnation &&
        source.identity.groupID === installed.groupID &&
        source.identity.incarnation === installed.incarnation &&
        source.identity.epoch === installed.epoch &&
        sameBytes(source.identity.authenticator, installed.authenticator) &&
        record.source.epoch === installed.epoch &&
        sameBytes(record.source.authenticator, installed.authenticator) &&
        sameValue(record.ledgerBefore, source.trust.ledger),
      'source',
    )

    reason = 'candidate'
    const snapshot = decodeRecoveryCandidate(record.candidate, record.requestKey)
    const credential = ownCredential(snapshot.state)
    const binding = candidate.bindingOfDID(candidate.credential.id)
    const controller =
      binding?.controller == null || binding.prefix == null || binding.capability == null
        ? undefined
        : {
            id: binding.controller,
            prefix: binding.prefix,
            capability: binding.capability,
            ...(binding.holderGrant == null ? {} : { holderGrant: binding.holderGrant }),
          }
    const frame = decodeHandshakeFrame(record.payload)
    requireMatch(frame.kind === HANDSHAKE_KIND.commit, 'candidate')
    const anchor = readGroupAnchorExtension(candidate)?.extensionData
    requireMatch(anchor instanceof Uint8Array, 'candidate')
    requireMatch(
      snapshot.requestID === record.requestID &&
        snapshot.epoch === record.epochAfter &&
        snapshot.epoch === Number(candidate.epoch) &&
        new TextDecoder('utf-8', { fatal: true }).decode(snapshot.state.groupContext.groupId) ===
          source.key.groupID &&
        candidate.groupID === source.key.groupID &&
        candidate.credential.groupID === source.key.groupID &&
        source.trust.credential.groupID === source.key.groupID &&
        normalizeDID(credential.id) === normalizeDID(candidate.credential.id) &&
        sameValue(credential.controller, controller) &&
        sameBytes(encodeClientState(snapshot.state), encodeClientState(candidate.state)) &&
        sameValue(snapshot.replyLedger, candidate.ledgerTokens) &&
        digestAppliedCommit(snapshot.commit) === record.digest &&
        sameBytes(decodeCommitFrame(frame.payload).commit, snapshot.commit) &&
        digestAppliedCommit(record.payload) === record.payloadDigest &&
        sameBytes(anchor, source.trust.genesisAnchor),
      'candidate',
    )

    reason = 'source'
    requireMatch(normalizeDID(credential.id) === normalizeDID(source.trust.credential.id), 'source')
    // sourceState carries the candidate context/schedule: only its public tree belongs to the source.
    requireMatch(
      sameBytes(
        encodeClientState({ ...snapshot.state, ratchetTree: snapshot.sourceTree }),
        encodeClientState({ ...snapshot.state, ratchetTree: source.trust.signerTree }),
      ),
      'source',
    )
    const sourceLeaf = snapshot.sourceTree.find((node) => {
      return (
        node?.nodeType === 1 &&
        'identity' in node.leaf.credential &&
        normalizeDID(parseMLSCredentialIdentity(node.leaf.credential.identity).id) ===
          normalizeDID(source.trust.credential.id)
      )
    })
    requireMatch(
      sameValue(
        sourceLeaf?.nodeType === 1 && 'identity' in sourceLeaf.leaf.credential
          ? (parseMLSCredentialIdentity(sourceLeaf.leaf.credential.identity).controller ?? null)
          : null,
        source.trust.binding,
      ),
      'source',
    )

    reason = 'candidate'
    const request = await verifyRecoveryRequest(
      new TextDecoder('utf-8', { fatal: true }).decode(record.request),
    )
    requireMatch(
      request.groupID === candidate.groupID &&
        request.requestID === record.requestID &&
        normalizeDID(request.requesterDID) === normalizeDID(candidate.credential.id),
      'candidate',
    )

    reason = 'tuple'
    const tuple = snapshot.boundCommit
    requireMatch(
      tuple != null &&
        tuple.position === proof.position &&
        tuple.commitDigest === proof.payloadDigest,
      'tuple',
    )
    const judge = createVerdictJudge({
      group: candidate,
      sourceTree: snapshot.sourceTree,
      known: knownRecoveryRegistry(source.trust.registry, snapshot.knownRegistry),
      requestID: record.requestID,
      boundCommit: tuple,
    })
    await judge.confirmationKey(proof.position, proof.payloadDigest)
    requireMatch(tuple.tag === judge.boundCommit()?.tag, 'tuple')

    reason = 'malformed'
    const opened = await openRecoveryVerdict({
      group: candidate,
      sealed: proof.verdict,
      requestID: record.requestID,
      ephemeralPrivateKey: record.requestKey,
    })
    requireMatch(opened.verdict.verdict === 'confirmed', 'unaccepted')
    // The judge reads the mutable cached anchor, not the authenticated extension bytes.
    requireMatch(sameValue(candidate.anchor, decodeGroupAnchor(anchor)), 'candidate')
    if (judge.judgeVerdict(opened) !== 'authoritative')
      throw new RegistryResyncRefusedError({ reason: judge.verdictRefusal(opened) ?? 'tuple' })
  } catch (cause) {
    if (cause instanceof RegistryResyncRefusedError) throw cause
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause to Error.
    throw new RegistryResyncRefusedError({ reason, cause })
  }
}
