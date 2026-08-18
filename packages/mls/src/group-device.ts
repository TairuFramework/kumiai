import { normalizeDID, type SigningIdentity } from '@kokuin/token'
import {
  type DefaultProposal,
  defaultCredentialTypes,
  defaultProposalTypes,
  encode,
  isDefaultCredential,
  type KeyPackage,
  mlsMessageEncoder,
} from 'ts-mls'

import { parseMLSCredentialIdentity } from './credential.js'
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
    const result = await commitWithEntries(group, [], [token], { requireAdmin: false })
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
    const result = await commitWithEntries(group, [], [token], { requireAdmin: false })
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
 * Bring a co-device into the group WITHOUT a group admin: an MLS Add of the new device's key
 * package plus a `kumiai.device` `add` entry, both authorized by the profile's management
 * capability. Binds the added leaf to `device`/`controller` (the key package must present `device`).
 * Returns the Commit + Welcome bytes.
 */
export async function addDevice(
  group: GroupHandle,
  identity: SigningIdentity,
  params: { keyPackage: KeyPackage; device: string; controller: string; capability: string },
): Promise<DeviceWriteResult & { welcomeMessage: Uint8Array }> {
  return mutexFor(group).run(async () => {
    // Bind the added leaf to the entry's subject — the key package must present `device`.
    const credential = params.keyPackage.leafNode.credential
    if (
      !isDefaultCredential(credential) ||
      credential.credentialType !== defaultCredentialTypes.basic
    ) {
      throw new Error(
        'addDevice: the key package carries a non-basic credential, which names no device DID',
      )
    }
    const presentedDID = normalizeDID(parseMLSCredentialIdentity(credential.identity).id)
    if (presentedDID !== normalizeDID(params.device)) {
      throw new Error(
        `addDevice: the key package presents ${presentedDID}, not the device ${normalizeDID(params.device)}`,
      )
    }

    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: params.device,
      value: { op: 'add', controller: params.controller, capability: params.capability },
    })
    const addProposal: DefaultProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: params.keyPackage },
    }
    const result = await commitWithEntries(group, [addProposal], [token], {
      ratchetTreeExtension: true,
      requireAdmin: false,
    })
    if (result.welcome == null) {
      throw new Error('addDevice: expected a Welcome message for the add proposal')
    }
    const newGroup = deriveGroup(group, result.newState)
    await newGroup.applyLedgerEntries([token])
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      welcomeMessage: encode(mlsMessageEncoder, result.welcome),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

/**
 * Revoke a device: ONE commit, TWO effects, matching the two surfaces the kokuin security doc
 * sanctions. (1) a `kumiai.device` `revoke` entry — folds the subject to `revoked`, so the derived
 * deny set gains it (closing Slice 1's external-rejoin path, which the deny set governs). (2) if the
 * subject currently holds a leaf, an MLS Remove of it in the SAME commit (the deny set alone leaves a
 * stale leaf; the Remove alone lets it rejoin on its still-valid bound-leaf capability). Both are
 * required. Authorized by the profile's management capability; no admin role.
 */
export async function revokeDevice(
  group: GroupHandle,
  identity: SigningIdentity,
  params: { device: string; capability: string },
): Promise<DeviceWriteResult> {
  return mutexFor(group).run(async () => {
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: params.device,
      value: { op: 'revoke', capability: params.capability },
    })
    const leafIndex = group.findMemberLeafIndex(params.device)
    const proposals: Array<DefaultProposal> =
      leafIndex === undefined
        ? []
        : [{ proposalType: defaultProposalTypes.remove, remove: { removed: leafIndex } }]
    const result = await commitWithEntries(group, proposals, [token], {
      requireAdmin: false,
    })
    const newGroup = deriveGroup(group, result.newState)
    const enacted = await newGroup.applyLedgerEntries([token])
    newGroup.emitControlEvents(enacted)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}

/**
 * Announce the controller's FULL log head into the group as folded, cross-peer-consistent state.
 * Advisory only — it gates nothing. Authored by any bound device of `controller` (self-scoped, no
 * management capability). Publish only-on-change and only when the log meaningfully advances: each
 * call is a permanent ledger entry (replayed at every welcome, no compaction).
 */
export async function announceControllerBeacon(
  group: GroupHandle,
  identity: SigningIdentity,
  params: { controller: string; logLength: number; headDigest: string },
): Promise<DeviceWriteResult> {
  return mutexFor(group).run(async () => {
    const token = await signLedgerEntry(identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: group.groupID,
      subject: params.controller,
      value: { op: 'beacon', logLength: params.logLength, headDigest: params.headDigest },
    })
    const result = await commitWithEntries(group, [], [token], { requireAdmin: false })
    const newGroup = deriveGroup(group, result.newState)
    const enacted = await newGroup.applyLedgerEntries([token])
    newGroup.emitControlEvents(enacted)
    return {
      commitMessage: encode(mlsMessageEncoder, result.commit),
      newGroup,
      epoch: newGroup.epoch,
    }
  })
}
