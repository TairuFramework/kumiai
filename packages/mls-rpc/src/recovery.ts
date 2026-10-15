import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  assertRecoveryBinding,
  authenticateRecoveryReply as authenticateTrustedReply,
  type CapturedRecoveryGroupInfo,
  type ClientState,
  type ControllerBinding,
  confirmationKey,
  confirmationTag,
  createRecoveryRequestFromTrust as createTrustedRequest,
  type DeviceRegistry,
  decodeGroupAnchor,
  type GroupHandle,
  type GroupOptions,
  joinGroupExternal,
  LeafBindingError,
  LeafLapsedError,
  nobleCryptoProvider,
  openRecoveryVerdictFromTrust as openTrustedVerdict,
  parseMLSCredentialIdentity,
  RevokeProofError,
  recoverySignerEligible,
  restoreGroup,
  SealedGroupInfoError,
} from '@kumiai/mls'
import {
  type CapturedAppliedRecovery,
  type CapturedPendingRecovery,
  type CapturedRecapture,
  type CapturedRejoinRecord,
  copyRecoverySource,
  copyRecoveryTargetCapture,
  type OpenedRecoveryVerdict,
  type PendingRecovery,
  type RecoveryReconciliation,
  validateCaptureHead,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import {
  type CiphersuiteName,
  decode,
  getCiphersuiteImpl,
  mlsMessageDecoder,
  wireformats,
} from 'ts-mls'

import type { RecoveryAdoptionDependencies, RecoveryRouting } from './mls.js'
import type { GroupRecoveryTrust } from './persistence-types.js'
import {
  type CapturedRecoverySnapshot,
  decodeCapturedRecoveryCandidate,
  encodeCapturedRecoveryCandidate,
  validateRecoverySource,
} from './recovery-codec.js'
import {
  leafBytes,
  offeredTree,
  publicTreeBytes,
  verifyOfferedGroupInfo,
} from './recovery-public-state.js'
import { validateCapturedRecoveryRecord } from './recovery-record.js'
import { recoveryTrustInputs } from './registry/trust.js'
import type { RegistryRecoverySource } from './registry/types.js'
import type { RecoveryEnvironment } from './registry/validation.js'

export class RecoveryCandidateError extends TypeError {
  override name = 'RecoveryCandidateError'
}

export const RECOVERY_LABEL = 'kumiai/recovery/v1'

export async function deriveRecoverySecretFromTrust(
  trust: GroupRecoveryTrust,
  options: GroupOptions = {},
): Promise<Uint8Array> {
  const suite = await getCiphersuiteImpl(
    trust.ciphersuiteName as CiphersuiteName,
    options.cryptoProvider ?? nobleCryptoProvider,
  )
  const utf8 = new TextEncoder()
  return await suite.kdf.expand(
    await suite.kdf.extract(utf8.encode(trust.groupID), trust.genesisAnchor),
    utf8.encode(RECOVERY_LABEL),
    32,
  )
}

export async function createRecoveryRequestFromTrust(params: {
  trust: GroupRecoveryTrust
  identity: OwnIdentity
  requestID: string
  deadlineMs?: number
}): Promise<{ request: Uint8Array; requestKey: Uint8Array }> {
  const result = await createTrustedRequest({ ...params, trust: recoveryTrustInputs(params.trust) })
  return { ...result, request: new TextEncoder().encode(result.request) }
}

export type AuthenticateRecoveryReplyParams = {
  trust: GroupRecoveryTrust
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  options: GroupOptions
}

export async function authenticateRecoveryReply(
  params: AuthenticateRecoveryReplyParams,
): Promise<CapturedRecoveryGroupInfo | null> {
  return await authenticateTrustedReply({ ...params, trust: recoveryTrustInputs(params.trust) })
}

export async function openRecoveryVerdictFromTrust(
  params: AuthenticateRecoveryReplyParams,
): Promise<OpenedRecoveryVerdict | null> {
  try {
    return await openTrustedVerdict({ ...params, trust: recoveryTrustInputs(params.trust) })
  } catch (error) {
    if (error instanceof SealedGroupInfoError || error instanceof LeafBindingError) return null
    throw error
  }
}

export type RecoveryBindingRequest = {
  groupID: string
  controllerID: string
  current: ControllerBinding
}

export type RecoveryBinding = (request: RecoveryBindingRequest) => Promise<ControllerBinding | null>

export type RecoveryReply = { groupInfo: Uint8Array; ledger: Array<string>; signer: string }

export type VerdictJudgeParams = {
  group: GroupHandle
  sourceTree: ClientState['ratchetTree']
  known: DeviceRegistry
  requestID: string
  boundCommit?: BoundRecoveryCommit
}

export type BoundRecoveryCommit = { position: string; commitDigest: string; tag?: string }

/** Retained with the speculative handle for subsequent signer judgement. */
export type RecoveryCandidate = PendingRecovery & {
  group: GroupHandle
  sourceTree: ClientState['ratchetTree']
  groupInfo: Uint8Array
  knownRegistry: DeviceRegistry
  replyLedger: Array<string>
  signer: string
}

export function knownRecoveryRegistry(
  known: DeviceRegistry,
  reply: DeviceRegistry,
): DeviceRegistry {
  const devices = new Map(reply.devices)
  for (const [did, record] of known.devices) {
    if (record.status === 'revoked' || !devices.has(did)) devices.set(did, record)
  }
  const controllers = new Map(reply.controllers)
  for (const [id, projection] of known.controllers) {
    const offered = controllers.get(id)
    controllers.set(
      id,
      offered == null
        ? projection
        : {
            ...offered,
            genFloor: Math.max(projection.genFloor, offered.genFloor),
            timeFloor: Math.max(projection.timeFloor, offered.timeFloor),
          },
    )
  }
  return { devices, controllers }
}

export function createRecoveryBindingState(identity: OwnIdentity, host?: RecoveryBinding) {
  let binding: ControllerBinding | undefined
  let asked = false
  let prepared = false
  const unusable = new Set<string>()
  const bindingID = (value: ControllerBinding): string =>
    JSON.stringify([value.id, value.prefix, value.capability, value.holderGrant])
  function markBindingUnusable(id?: string): void {
    if (id == null) return
    unusable.delete(id)
    unusable.add(id)
    while (unusable.size > 16) {
      const oldest = unusable.values().next().value
      if (oldest != null) unusable.delete(oldest)
    }
  }

  async function usable(group: GroupHandle, candidate: ControllerBinding): Promise<boolean> {
    if (unusable.has(bindingID(candidate))) return false
    try {
      await assertRecoveryBinding({ group, identity, controller: candidate })
      return true
    } catch {
      return false
    }
  }
  function current(group: GroupHandle): ControllerBinding | undefined {
    const leaf = group.bindingOfDID(identity.id)
    return leaf?.controller == null || leaf.prefix == null || leaf.capability == null
      ? undefined
      : {
          id: leaf.controller,
          prefix: leaf.prefix,
          capability: leaf.capability,
          ...(leaf.holderGrant == null ? {} : { holderGrant: leaf.holderGrant }),
        }
  }
  async function request(group: GroupHandle): Promise<ControllerBinding | undefined> {
    if (asked) return undefined
    asked = true
    const held = current(group)
    if (host == null || held == null || group.anchor.controller == null) return undefined
    return (
      (await host({
        groupID: group.groupID,
        controllerID: group.anchor.controller,
        current: held,
      })) ?? undefined
    )
  }
  return {
    isBindingUnusable: (candidate: ControllerBinding): boolean =>
      unusable.has(bindingID(candidate)),
    markCandidateBindingUnusable(group: GroupHandle): void {
      const carried = current(group)
      markBindingUnusable(carried == null ? undefined : bindingID(carried))
    },
    async prepare(group: GroupHandle): Promise<'ready' | 'renewal-required'> {
      asked = false
      prepared = true
      binding = current(group)
      if (group.anchor.controller == null) return 'ready'
      if (binding != null && (await usable(group, binding))) return 'ready'
      binding = await request(group)
      return binding != null && (await usable(group, binding)) ? 'ready' : 'renewal-required'
    },
    async join(group: GroupHandle, reply: RecoveryReply) {
      if (!prepared) {
        prepared = true
        binding = current(group)
      }
      let signerEligible = group.anchor.controller == null
      const build = (controller?: ControllerBinding) => {
        signerEligible = group.anchor.controller == null
        return joinGroupExternal({
          identity,
          groupInfo: reply.groupInfo,
          credential: group.credential,
          resync: true,
          controller,
          beforeBinding: async (pending, source) => {
            if (group.anchor.controller == null) return
            if (
              !recoverySignerEligible({
                group: pending,
                known: knownRecoveryRegistry(group.registry, source.registry),
                signer: reply.signer,
              })
            )
              throw new Error('Ineligible recovery attestation signer')
            signerEligible = true
            if (controller == null || !(await usable(group, controller)))
              throw new LeafBindingError('floating-refused')
          },
          options: {
            commitPolicy: group.commitPolicy,
            resolveLedgerEntries: group.resolveLedgerEntries,
            onLedgerEntries: group.onLedgerEntries,
          },
          ...(group.anchor.controller == null ? {} : { ledgerEntries: reply.ledger }),
        })
      }
      const candidate = async (controller?: ControllerBinding) => {
        const result = await build(controller)
        const carried = current(result.group)
        const id = carried == null ? undefined : bindingID(carried)
        return { ...result, markBindingUnusable: () => markBindingUnusable(id) }
      }
      try {
        return await candidate(binding)
      } catch (error) {
        if (
          !signerEligible ||
          group.anchor.controller == null ||
          !(
            error instanceof LeafBindingError ||
            error instanceof LeafLapsedError ||
            error instanceof RevokeProofError
          )
        )
          return null
        binding = await request(group)
        if (binding == null || !(await usable(group, binding)))
          return { renewalRequired: true } as const
        try {
          return await candidate(binding)
        } catch (replacementError) {
          if (!signerEligible) return null
          return replacementError instanceof LeafBindingError ||
            replacementError instanceof LeafLapsedError ||
            replacementError instanceof RevokeProofError
            ? ({ renewalRequired: true } as const)
            : null
        }
      }
    },
  }
}

export function createVerdictJudge(params: VerdictJudgeParams) {
  const { group, sourceTree, known, requestID } = params
  let tuple: BoundRecoveryCommit | undefined =
    params.boundCommit == null ? undefined : { ...params.boundCommit }
  function verdictRefusal(opened: OpenedRecoveryVerdict): 'tuple' | 'ineligible' | null {
    const { signer, verdict } = opened
    if (
      normalizeDID(signer) === normalizeDID(group.credential.id) ||
      tuple == null ||
      verdict.groupID !== group.groupID ||
      verdict.requestID !== requestID ||
      verdict.position !== tuple.position ||
      verdict.commitDigest !== tuple.commitDigest
    )
      return 'tuple'
    if (
      verdict.verdict === 'confirmed' &&
      (verdict.epoch !== Number(group.epoch) || verdict.tag !== tuple.tag)
    )
      return 'tuple'
    if (group.anchor.controller != null)
      return recoverySignerEligible({ group, known, signer }) ? null : 'ineligible'
    if (verdict.verdict === 'confirmed') return null
    for (const node of sourceTree) {
      if (node == null || !('leaf' in node)) continue
      const credential = node.leaf.credential
      if (!('identity' in credential)) continue
      try {
        if (
          normalizeDID(parseMLSCredentialIdentity(credential.identity).id) === normalizeDID(signer)
        )
          return null
      } catch {}
    }
    return 'ineligible'
  }
  return {
    boundCommit: () => (tuple == null ? undefined : { ...tuple }),
    async confirmationKey(position: string, commitDigest: string) {
      if (tuple != null && (tuple.position !== position || tuple.commitDigest !== commitDigest))
        throw new Error('Pending recovery already bound to another commit')
      tuple ??= { position, commitDigest }
      const key = await confirmationKey(group, position, commitDigest)
      tuple.tag = confirmationTag(key, requestID)
      return key
    },
    verdictRefusal,
    judgeVerdict(opened: OpenedRecoveryVerdict): 'authoritative' | 'advisory' {
      const { verdict } = opened
      if (
        verdict.verdict === 'superseded' ||
        (verdict.verdict === 'refused' && verdict.refusalAuthority !== 'authenticated-commit')
      )
        return 'advisory'
      return verdictRefusal(opened) === null ? 'authoritative' : 'advisory'
    },
  }
}

export type CapturedRecoveryEnvironment = RecoveryEnvironment & {
  accept: RecoveryAdoptionDependencies['accept']
}

const capturedBindings = new WeakMap<
  CapturedRecoveryEnvironment,
  ReturnType<typeof createRecoveryBindingState>
>()

function capturedBindingState(environment: CapturedRecoveryEnvironment) {
  let state = capturedBindings.get(environment)
  if (state === undefined) {
    state = createRecoveryBindingState(environment.identity, environment.recoveryBinding)
    capturedBindings.set(environment, state)
  }
  return state
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function sameOrigin(left: RegistryRecoverySource, right: RegistryRecoverySource): boolean {
  return (
    left.key.groupID === right.key.groupID &&
    left.key.incarnation === right.key.incarnation &&
    left.trustDigest === right.trustDigest &&
    ((left.identity === null && right.identity === null) ||
      (left.identity !== null &&
        right.identity !== null &&
        left.identity.epoch === right.identity.epoch &&
        sameBytes(left.identity.authenticator, right.identity.authenticator)))
  )
}

function assertOwner(
  source: RegistryRecoverySource,
  environment: CapturedRecoveryEnvironment,
): void {
  if (
    normalizeDID(source.trust.credential.id) !== normalizeDID(environment.identity.id) ||
    typeof environment.accept !== 'function'
  )
    throw new TypeError('Invalid captured recovery environment')
}

async function authenticateSnapshot(
  snapshot: CapturedRecoverySnapshot,
  requestKey: Uint8Array,
  environment: CapturedRecoveryEnvironment,
): Promise<void> {
  const reply = await authenticateRecoveryReply({
    trust: snapshot.source.trust,
    sealed: snapshot.attestedReply,
    requestID: snapshot.requestID,
    requestKey,
    options: environment.options,
  })
  if (
    reply === null ||
    !sameBytes(reply.groupInfo, snapshot.groupInfo) ||
    reply.signer !== snapshot.signer ||
    JSON.stringify(reply.ledger) !== JSON.stringify(snapshot.replyLedger) ||
    reply.captureHead !== snapshot.captureHead ||
    !sameBytes(reply.groupInfoAuthenticator, snapshot.target.groupInfoAuthenticator) ||
    !sameBytes(
      publicTreeBytes({
        ...snapshot.state,
        ratchetTree: offeredTree(snapshot.state, reply.groupInfo),
      }).tree,
      publicTreeBytes({ ...snapshot.state, ratchetTree: snapshot.sourceTree }).tree,
    )
  )
    throw new RecoveryCandidateError('Captured recovery attestation mismatch')
}

async function capturedPending(
  snapshot: CapturedRecoverySnapshot,
  requestKey: Uint8Array,
  environment: CapturedRecoveryEnvironment,
): Promise<CapturedPendingRecovery> {
  const source = copyRecoverySource(snapshot.source)
  const target = copyRecoveryTargetCapture(snapshot.target)
  const key = requestKey.slice()
  const group = await restoreGroup({
    state: snapshot.state,
    credential: source.trust.credential,
    ledgerEntries: snapshot.replyLedger,
    options: { ...environment.options, ciphersuiteName: source.trust.ciphersuiteName },
  })
  const binding = capturedBindingState(environment)
  const judge = createVerdictJudge({
    group,
    sourceTree: snapshot.sourceTree,
    known: snapshot.knownRegistry,
    requestID: snapshot.requestID,
    boundCommit: snapshot.boundCommit,
  })
  if (snapshot.boundCommit?.tag !== undefined) {
    await judge.confirmationKey(snapshot.boundCommit.position, snapshot.boundCommit.commitDigest)
    if (judge.boundCommit()?.tag !== snapshot.boundCommit.tag)
      throw new RecoveryCandidateError('Captured recovery confirmation tag mismatch')
  }
  return {
    get source() {
      return copyRecoverySource(source)
    },
    get target() {
      return copyRecoveryTargetCapture(target)
    },
    get commit() {
      return snapshot.commit.slice()
    },
    epoch: snapshot.epoch,
    markBindingUnusable: () => binding.markCandidateBindingUnusable(group),
    confirmationKey: judge.confirmationKey,
    judgeVerdict: judge.judgeVerdict,
    serialize: () =>
      encodeCapturedRecoveryCandidate(
        { ...snapshot, source, target, state: group.state, boundCommit: judge.boundCommit() },
        key,
      ),
    async onAccepted(expected, proof, write) {
      const narrowed = validateRecoverySource(expected as RegistryRecoverySource)
      if (!sameOrigin(source, narrowed) || typeof write !== 'function')
        throw new TypeError('Captured recovery source mismatch')
      await environment.accept(group, { source: copyRecoverySource(narrowed), proof, write })
    },
  }
}

export async function buildRecoveryCandidate(params: {
  source: RegistryRecoverySource
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  target: RecoveryRouting
  environment: CapturedRecoveryEnvironment
}): Promise<CapturedAppliedRecovery> {
  const source = copyRecoverySource(validateRecoverySource(params.source))
  const { environment } = params
  assertOwner(source, environment)
  if (!params.target.targetID || !params.target.topicID)
    throw new TypeError('Invalid recovery target')
  const sealed = params.sealed.slice()
  const requestKey = params.requestKey.slice()
  const reply = await authenticateRecoveryReply({
    trust: source.trust,
    sealed,
    requestID: params.requestID,
    requestKey,
    options: environment.options,
  })
  if (reply === null) return null
  const info = decode(mlsMessageDecoder, reply.groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info) return null
  let controller = source.trust.binding ?? undefined
  const build = () =>
    joinGroupExternal({
      identity: environment.identity,
      credential: source.trust.credential,
      groupInfo: reply.groupInfo,
      resync: true,
      controller,
      ...(decodeGroupAnchor(source.trust.genesisAnchor)?.controller == null
        ? {}
        : { ledgerEntries: reply.ledger }),
      options: { ...environment.options, ciphersuiteName: source.trust.ciphersuiteName },
      beforeBinding: async (_pending, before) => {
        if (controller !== undefined) {
          if (capturedBindingState(environment).isBindingUnusable(controller))
            throw new LeafBindingError('floating-refused')
          await assertRecoveryBinding({ group: before, identity: environment.identity, controller })
        }
      },
    })
  let result: Awaited<ReturnType<typeof build>>
  try {
    result = await build()
  } catch (error) {
    if (
      !(
        error instanceof LeafBindingError ||
        error instanceof LeafLapsedError ||
        error instanceof RevokeProofError
      )
    )
      throw error
    if (source.trust.binding === null) return null
    controller =
      (await environment.recoveryBinding?.({
        groupID: source.key.groupID,
        controllerID: source.trust.binding.id,
        current: source.trust.binding,
      })) ?? undefined
    if (controller === undefined) return { renewalRequired: true }
    try {
      result = await build()
    } catch (replacementError) {
      if (
        replacementError instanceof LeafBindingError ||
        replacementError instanceof LeafLapsedError ||
        replacementError instanceof RevokeProofError
      )
        return { renewalRequired: true }
      throw replacementError
    }
  }
  const target = {
    ...params.target,
    groupInfoEpoch: Number(info.groupInfo.groupContext.epoch),
    groupInfoAuthenticator: reply.groupInfoAuthenticator.slice(),
    captureHead: validateCaptureHead(reply.captureHead),
  }
  return await capturedPending(
    {
      source,
      target,
      captureHead: target.captureHead,
      searchFrom: target.captureHead,
      state: result.group.state,
      sourceTree: offeredTree(result.group.state, reply.groupInfo),
      knownRegistry: knownRecoveryRegistry(source.trust.registry, result.sourceRegistry),
      attestedReply: sealed,
      groupInfo: reply.groupInfo,
      replyLedger: reply.ledger,
      signer: reply.signer,
      commit: result.commitMessage,
      epoch: Number(result.group.epoch),
      requestID: params.requestID,
    },
    requestKey,
    environment,
  )
}

export async function restoreRecoveryCandidate(params: {
  source: RegistryRecoverySource
  candidate: Uint8Array
  requestKey: Uint8Array
  environment: CapturedRecoveryEnvironment
}): Promise<CapturedPendingRecovery> {
  const source = validateRecoverySource(params.source)
  assertOwner(source, params.environment)
  const snapshot = decodeCapturedRecoveryCandidate(params.candidate, params.requestKey)
  if (!sameOrigin(source, snapshot.source))
    throw new RecoveryCandidateError('Captured recovery origin mismatch')
  await authenticateSnapshot(snapshot, params.requestKey, params.environment)
  return await capturedPending(snapshot, params.requestKey, params.environment)
}

export async function reconcileRecoveryCapture(params: {
  source: RegistryRecoverySource
  target: RecoveryRouting
  record: CapturedRejoinRecord
  reply: CapturedRecapture
  environment: CapturedRecoveryEnvironment
}): Promise<RecoveryReconciliation> {
  const { record, reply, environment } = params
  const source = validateRecoverySource(params.source)
  assertOwner(source, environment)
  validateCapturedRecoveryRecord(record)
  const snapshot = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
  if (
    !sameOrigin(source, snapshot.source) ||
    record.target.targetID !== params.target.targetID ||
    record.target.topicID !== params.target.topicID
  )
    throw new TypeError('Captured recovery origin or target mismatch')
  await authenticateSnapshot(snapshot, record.requestKey, environment)
  const recaptured = await authenticateRecoveryReply({
    trust: snapshot.source.trust,
    sealed: reply.sealed,
    requestID: reply.requestID,
    requestKey: reply.requestKey,
    options: environment.options,
  })
  if (recaptured === null) return { kind: 'retry' }
  const info = decode(mlsMessageDecoder, recaptured.groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info) return { kind: 'retry' }
  const suite = await getCiphersuiteImpl(
    source.trust.ciphersuiteName as CiphersuiteName,
    environment.options.cryptoProvider ?? nobleCryptoProvider,
  )
  if (!(await verifyOfferedGroupInfo(snapshot.state, info, suite))) return { kind: 'retry' }
  const epoch = Number(info.groupInfo.groupContext.epoch)
  if (
    !Number.isSafeInteger(epoch) ||
    epoch < record.target.groupInfoEpoch ||
    (reply.epochFloor !== null && epoch < reply.epochFloor)
  )
    return { kind: 'retry' }
  if (epoch === record.target.groupInfoEpoch)
    return sameBytes(recaptured.groupInfoAuthenticator, record.target.groupInfoAuthenticator)
      ? { kind: 'head-only', head: validateCaptureHead(recaptured.captureHead) }
      : { kind: 'retry' }
  const fresh = leafBytes(
    snapshot.state,
    snapshot.state.ratchetTree[snapshot.state.privatePath.leafIndex * 2],
  )
  const present = offeredTree(snapshot.state, recaptured.groupInfo).some(
    (node) => node?.nodeType === 1 && sameBytes(leafBytes(snapshot.state, node), fresh),
  )
  return present
    ? { kind: 'accepted', epoch, leafDigest: toB64U(sha256(fresh)) }
    : { kind: 'unapplied-later', epoch }
}
