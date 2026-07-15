import {
  createGroupInfoWithExternalPubAndRatchetTree,
  decode,
  encode,
  type MlsGroupInfo,
  mlsMessageDecoder,
  mlsMessageEncoder,
  protocolVersions,
  wireformats,
} from 'ts-mls'

import { GROUP_ANCHOR_EXTENSION_TYPE } from './anchor.js'
import type { GroupHandle } from './group-handle.js'

/**
 * Read the MLS epoch from a framed message's cleartext header without decrypting.
 * Advisory only — the header epoch is unauthenticated; use it to drop stale / buffer
 * future messages before the authenticated processMessage. Returns undefined for
 * non-message or undecodable bytes.
 *
 * Total by contract (a safe pre-filter over untrusted Delivery Service bytes): never
 * throws. ts-mls `decode` throws on some malformed inputs (e.g. oversized); that is
 * caught and treated as "not a message".
 */
export function readMessageEpoch(bytes: Uint8Array): bigint | undefined {
  const message = (() => {
    try {
      return decode(mlsMessageDecoder, bytes)
    } catch {
      return undefined
    }
  })()
  if (message == null) return undefined
  if (message.wireformat === wireformats.mls_private_message) {
    return message.privateMessage.epoch
  }
  if (message.wireformat === wireformats.mls_public_message) {
    return message.publicMessage.content.epoch
  }
  return undefined
}

export type InspectGroupInfoResult = {
  /** The GroupInfo's epoch, read from its groupContext. */
  epoch: bigint
  /** The GroupInfo's ratchet-tree hash, read from its groupContext. Compare for
   *  equality against a known post-commit state's treeHash to confirm canonical
   *  convergence (same epoch + same treeHash ⟺ same group state). */
  treeHash: Uint8Array
}

/**
 * Read a framed MLSMessage(GroupInfo)'s epoch and ratchet-tree hash without joining
 * or mutating state. Used to confirm an external-resync Commit was canonically
 * accepted: compare the returned (epoch, treeHash) against the rejoiner's own
 * post-commit state. Equal ⟹ this device's Commit won the epoch; unequal ⟹ another
 * won and the rejoin must retry.
 *
 * Structural read only — does NOT verify the GroupInfo signature; the caller obtains
 * the bytes over the group's authorized channel. Unlike readMessageEpoch, this THROWS
 * on malformed input: an already-trusted malformed GroupInfo is a programming error.
 */
export function inspectGroupInfo(groupInfoBytes: Uint8Array): InspectGroupInfoResult {
  const message = decode(mlsMessageDecoder, groupInfoBytes)
  if (message == null) {
    throw new Error('Invalid groupInfo: failed to decode MLSMessage')
  }
  if (message.wireformat !== wireformats.mls_group_info) {
    throw new Error(
      `Invalid groupInfo: expected wireformat mls_group_info, got ${String(message.wireformat)}`,
    )
  }
  const { groupContext } = message.groupInfo
  return { epoch: groupContext.epoch, treeHash: groupContext.treeHash }
}

export type GroupInfoBinding = {
  /** The group id the GroupInfo's GroupContext names, decoded from its bytes. */
  groupID: string
  /** The genesis-anchor GroupContext extension's raw data, or null when absent.
   *  Byte-compared against the requester's own immutable anchor, never re-encoded. */
  anchorExtensionData: Uint8Array | null
}

/**
 * Read a framed MLSMessage(GroupInfo)'s group-identifying bindings without joining:
 * the group id its GroupContext names and the raw genesis-anchor extension bytes. A
 * recovering peer compares both against the group it believes it is healing, so a
 * GroupInfo for another group or with a different anchor is refused before it can
 * steer an external join. Structural read only; does not verify the signature. Throws
 * on malformed input, like {@link inspectGroupInfo}.
 */
export function readGroupInfoBinding(groupInfoBytes: Uint8Array): GroupInfoBinding {
  const message = decode(mlsMessageDecoder, groupInfoBytes)
  if (message == null) {
    throw new Error('Invalid groupInfo: failed to decode MLSMessage')
  }
  if (message.wireformat !== wireformats.mls_group_info) {
    throw new Error(
      `Invalid groupInfo: expected wireformat mls_group_info, got ${String(message.wireformat)}`,
    )
  }
  const { groupContext } = message.groupInfo
  const anchor = groupContext.extensions.find(
    (ext) => ext.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )
  return {
    groupID: new TextDecoder().decode(groupContext.groupId),
    anchorExtensionData: anchor?.extensionData instanceof Uint8Array ? anchor.extensionData : null,
  }
}

export type ExportGroupInfoParams = {
  group: GroupHandle
}

export type ExportGroupInfoResult = {
  /** Framed MLSMessage(GroupInfo) bytes. Self-describing with protocol
   *  version + wireformat + GroupInfo (external_pub + ratchet tree embedded). */
  groupInfo: Uint8Array
}

export async function exportGroupInfo(
  params: ExportGroupInfoParams,
): Promise<ExportGroupInfoResult> {
  const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
    params.group.state,
    [],
    params.group.context.cipherSuite,
  )
  const framed: MlsGroupInfo = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_group_info,
    groupInfo,
  }
  return { groupInfo: encode(mlsMessageEncoder, framed) }
}
