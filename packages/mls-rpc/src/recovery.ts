import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  assertRecoveryBinding,
  type ClientState,
  type ControllerBinding,
  confirmationKey,
  confirmationTag,
  type DeviceRegistry,
  type GroupHandle,
  joinGroupExternal,
  LeafBindingError,
  LeafLapsedError,
  parseMLSCredentialIdentity,
  RevokeProofError,
  recoverySignerEligible,
} from '@kumiai/mls'
import type { OpenedRecoveryVerdict, PendingRecovery } from '@kumiai/rpc'

export type RecoveryBinding = (request: {
  groupID: string
  controllerID: string
  current: ControllerBinding
}) => Promise<ControllerBinding | null>

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
    JSON.stringify([value.id, value.prefix, value.capability])
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
      : { id: leaf.controller, prefix: leaf.prefix, capability: leaf.capability }
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
    async prepare(group: GroupHandle): Promise<'ready' | 'renewal-required'> {
      asked = false
      prepared = true
      binding = current(group)
      if (group.anchor.controller == null) return 'ready'
      if (binding != null && (await usable(group, binding))) return 'ready'
      binding = await request(group)
      return binding != null && (await usable(group, binding)) ? 'ready' : 'renewal-required'
    },
    async join(
      group: GroupHandle,
      reply: { groupInfo: Uint8Array; ledger: Array<string>; signer: string },
    ) {
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
              !recoverySignerEligible(
                pending,
                knownRecoveryRegistry(group.registry, source.registry),
                reply.signer,
              )
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

export function createVerdictJudge(
  group: GroupHandle,
  sourceTree: ClientState['ratchetTree'],
  known: DeviceRegistry,
  requestID: string,
) {
  let tuple: { position: string; commitDigest: string; tag?: string } | undefined
  return {
    async confirmationKey(position: string, commitDigest: string) {
      if (tuple != null && (tuple.position !== position || tuple.commitDigest !== commitDigest))
        throw new Error('Pending recovery already bound to another commit')
      tuple ??= { position, commitDigest }
      const key = await confirmationKey(group, position, commitDigest)
      tuple.tag = confirmationTag(key, requestID)
      return key
    },
    judgeVerdict(opened: OpenedRecoveryVerdict): 'authoritative' | 'advisory' {
      const { signer, verdict } = opened
      if (
        tuple == null ||
        verdict.groupID !== group.groupID ||
        verdict.requestID !== requestID ||
        verdict.position !== tuple.position ||
        verdict.commitDigest !== tuple.commitDigest
      )
        return 'advisory'
      if (
        verdict.verdict === 'confirmed' &&
        (verdict.epoch !== Number(group.epoch) || verdict.tag !== tuple.tag)
      )
        return 'advisory'
      if (group.anchor.controller != null)
        return recoverySignerEligible(group, known, signer) ? 'authoritative' : 'advisory'
      if (verdict.verdict === 'confirmed') return 'authoritative'
      for (const node of sourceTree) {
        if (node == null || !('leaf' in node)) continue
        const credential = node.leaf.credential
        if (!('identity' in credential)) continue
        try {
          if (
            normalizeDID(parseMLSCredentialIdentity(credential.identity).id) ===
            normalizeDID(signer)
          )
            return 'authoritative'
        } catch {}
      }
      return 'advisory'
    },
  }
}
