import type { OwnIdentity } from '@kokuin/token'
import {
  assertRecoveryBinding,
  type ClientState,
  type ControllerBinding,
  type DeviceRegistry,
  type GroupHandle,
  joinGroupExternal,
  LeafBindingError,
  LeafLapsedError,
  RevokeProofError,
} from '@kumiai/mls'
import type { PendingRecovery } from '@kumiai/rpc'

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

  async function usable(group: GroupHandle, candidate: ControllerBinding): Promise<boolean> {
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
      if (!prepared && group.anchor.controller != null) {
        if ((await this.prepare(group)) === 'renewal-required')
          return { renewalRequired: true } as const
      }
      if (group.anchor.controller != null && (binding == null || !(await usable(group, binding)))) {
        binding = await request(group)
        if (binding == null || !(await usable(group, binding)))
          return { renewalRequired: true } as const
      }
      const build = (controller?: ControllerBinding) =>
        joinGroupExternal({
          identity,
          groupInfo: reply.groupInfo,
          credential: group.credential,
          resync: true,
          controller,
          options: {
            commitPolicy: group.commitPolicy,
            resolveLedgerEntries: group.resolveLedgerEntries,
            onLedgerEntries: group.onLedgerEntries,
          },
          ...(group.anchor.controller == null ? {} : { ledgerEntries: reply.ledger }),
        })
      try {
        return await build(binding)
      } catch (error) {
        if (
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
          return await build(binding)
        } catch (replacementError) {
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
