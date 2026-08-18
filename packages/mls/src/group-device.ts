import type { SigningIdentity } from '@kokuin/token'
import { encode, mlsMessageEncoder } from 'ts-mls'

import { commitWithEntries } from './group-commit.js'
import { deriveGroup, type GroupHandle, mutexFor } from './group-handle.js'
import { signLedgerEntry } from './ledger.js'
import { DEVICE_ENTRY_TYPE } from './registry.js'

export type DeviceWriteResult = {
  /** Framed MLSMessage bytes. The caller (kubun) broadcasts to existing members via its DS. */
  commitMessage: Uint8Array
  newGroup: GroupHandle
  /** Post-commit epoch (== newGroup.epoch). */
  epoch: bigint
}

/**
 * Record a `device -> controller` binding: self-attested (leaf) when `device` is the caller's own,
 * or management-capability-authorized (`capability`) when recording a co-device already in the
 * group. Proof gating runs in `commitWithEntries` (authoring side) and every receiver's pipeline —
 * no admin role is required. Returns the commit bytes to broadcast.
 */
export async function registerDevice(
  group: GroupHandle,
  identity: SigningIdentity,
  params: { device: string; controller: string; capability?: string },
): Promise<DeviceWriteResult> {
  return mutexFor(group).run(async () => {
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: params.device,
      value: {
        op: 'register',
        controller: params.controller,
        ...(params.capability != null ? { capability: params.capability } : {}),
      },
    })
    const result = await commitWithEntries(group, [], [token], false, { requireAdmin: false })
    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries([token])
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

/**
 * Rename a device already bound in the registry. A manage op — authorized by the profile's
 * management capability (the issuer is a device of `controllerOf(device)`); no admin role required.
 */
export async function labelDevice(
  group: GroupHandle,
  identity: SigningIdentity,
  params: { device: string; label: string; capability: string },
): Promise<DeviceWriteResult> {
  return mutexFor(group).run(async () => {
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: params.device,
      value: { op: 'label', label: params.label, capability: params.capability },
    })
    const result = await commitWithEntries(group, [], [token], false, { requireAdmin: false })
    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries([token])
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}
