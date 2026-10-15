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
  SealedGroupInfoError,
} from '@kumiai/mls'
import type { OpenedRecoveryVerdict, PendingRecovery } from '@kumiai/rpc'
import { type CiphersuiteName, getCiphersuiteImpl } from 'ts-mls'

import type { GroupRecoveryTrust } from './persistence-types.js'
import { recoveryTrustInputs } from './registry/trust.js'

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
      return verdictRefusal(opened) === null ? 'authoritative' : 'advisory'
    },
  }
}
