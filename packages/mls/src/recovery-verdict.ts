import {
  encodeMultibase,
  isVerifiedToken,
  normalizeDID,
  type SigningIdentity,
  stringifyToken,
  verifyToken,
} from '@kokuin/token'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { type ClientState, type LeafNode, nodeTypes } from 'ts-mls'

import type { GroupAnchor } from './anchor.js'
import { readCapability } from './capability.js'
import { foldChain } from './controller-log.js'
import { parseMLSCredentialIdentity } from './credential.js'
import type { GroupHandle } from './group-handle.js'
import { attestedTreeTime, leafExpiry } from './lifecycle.js'
import { effectiveAuthorityOf, memberRootStatus } from './member-root.js'
import {
  type OpenSealedReplyParams,
  openSealedReply,
  recoveryLeafForDID,
  SealedGroupInfoError,
  type SealedReplyKind,
  sealToRequest,
  verifyRecoveryRequest,
  verifyRecoveryToken,
} from './recovery.js'
import type { DeviceRegistry } from './registry.js'

export type RecoveryRefusalReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'
export type RecoveryVerdict = {
  groupID: string
  requestID: string
  position: string
  commitDigest: string
} & (
  | { verdict: 'confirmed'; epoch: number; tag: string }
  | { verdict: 'superseded' }
  | {
      verdict: 'refused'
      reason: RecoveryRefusalReason
      refusalAuthority?: 'authenticated-commit'
    }
)
export type OpenedRecoveryVerdict = { signer: string; verdict: RecoveryVerdict }

const utf8 = new TextEncoder()
const VERDICT_TYPE = 'kumiai.recovery-verdict'
const VERDICT_REPLY: SealedReplyKind = {
  hpkeInfo: utf8.encode('kumiai/mls/recovery-verdict/v1'),
  aadDomain: utf8.encode('kumiai/mls/recovery-verdict-aad/v1'),
  version: 1,
  fail: (_reason, message, options) => new Error(message, options),
}

function frame(value: string): Uint8Array {
  const bytes = utf8.encode(value)
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
}

export async function confirmationKey(
  group: GroupHandle,
  position: string,
  commitDigest: string,
): Promise<Uint8Array> {
  const fields = [group.groupID, position, commitDigest].map(frame)
  const context = new Uint8Array(fields.reduce((size, field) => size + field.length, 0))
  let offset = 0
  for (const field of fields) {
    context.set(field, offset)
    offset += field.length
  }
  return await group.exportSecret('kumiai.rejoin-confirm', context, 32)
}

export function confirmationTag(key: Uint8Array, requestID: string): string {
  return encodeMultibase(hmac(sha256, key, utf8.encode(requestID)))
}

function isRecoveryVerdict(value: unknown): value is RecoveryVerdict {
  if (value == null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (
    ![v.groupID, v.requestID, v.position, v.commitDigest].every(
      (field) => typeof field === 'string' && field.length > 0,
    )
  )
    return false
  return (
    v.verdict === 'superseded' ||
    (v.verdict === 'confirmed' &&
      Number.isSafeInteger(v.epoch) &&
      (v.epoch as number) >= 0 &&
      typeof v.tag === 'string') ||
    (v.verdict === 'refused' &&
      ['binding', 'lapse', 'floor', 'policy', 'invalid'].includes(v.reason as string))
  )
}

export type SealRecoveryVerdictParams = {
  group: GroupHandle
  identity: SigningIdentity
  /** The signed recovery request token being answered. */
  request: string
  verdict: RecoveryVerdict
}

export async function sealRecoveryVerdict(params: SealRecoveryVerdictParams): Promise<Uint8Array> {
  const { group, identity, request, verdict } = params
  const verified = await verifyRecoveryRequest(request)
  if (
    normalizeDID(identity.id) !== normalizeDID(group.credential.id) ||
    !isRecoveryVerdict(verdict) ||
    verdict.groupID !== group.groupID ||
    verdict.groupID !== verified.groupID ||
    verdict.requestID !== verified.requestID
  )
    throw new Error('Recovery verdict does not bind the signed request')
  const token = await identity.signToken(
    { ...verdict, type: VERDICT_TYPE },
    { embedLongForm: true },
  )
  // A refusal can answer an agent whose leaf the responder no longer holds.
  return await sealToRequest({
    kind: VERDICT_REPLY,
    group,
    request,
    plaintext: utf8.encode(stringifyToken(token)),
    requireMember: false,
  })
}

export async function openRecoveryVerdict(
  params: Omit<OpenSealedReplyParams, 'kind'> & { retainedTrust?: boolean },
): Promise<OpenedRecoveryVerdict> {
  const { group, sealed, requestID, ephemeralPrivateKey } = params
  const kind: SealedReplyKind = params.retainedTrust
    ? {
        ...VERDICT_REPLY,
        fail: (reason, message, options) => new SealedGroupInfoError(reason, message, options),
      }
    : VERDICT_REPLY
  const plaintext = await openSealedReply({
    kind,
    group,
    sealed,
    requestID,
    ephemeralPrivateKey,
  })
  const encoded = new TextDecoder().decode(plaintext)
  const token = params.retainedTrust
    ? await verifyRecoveryToken(encoded, group.context)
    : await verifyToken(encoded)
  if (
    !isVerifiedToken(token) ||
    token.payload.type !== VERDICT_TYPE ||
    !isRecoveryVerdict(token.payload) ||
    token.payload.groupID !== group.groupID ||
    token.payload.requestID !== requestID
  )
    throw params.retainedTrust
      ? new SealedGroupInfoError('unauthenticated', 'Unauthenticated recovery verdict')
      : new Error('Unauthenticated recovery verdict')
  const { groupID, position, commitDigest } = token.payload
  const binding = { groupID, requestID, position, commitDigest }
  const verdict: RecoveryVerdict =
    token.payload.verdict === 'confirmed'
      ? { ...binding, verdict: 'confirmed', epoch: token.payload.epoch, tag: token.payload.tag }
      : token.payload.verdict === 'refused'
        ? {
            ...binding,
            verdict: 'refused',
            reason: token.payload.reason,
            ...(token.payload.refusalAuthority === 'authenticated-commit'
              ? { refusalAuthority: 'authenticated-commit' as const }
              : {}),
          }
        : { ...binding, verdict: 'superseded' }
  return { signer: normalizeDID(token.payload.iss), verdict }
}

export type RecoverySignerEligibleParams = {
  group: GroupHandle
  registry: DeviceRegistry
  signer: string
  /** Seconds since epoch; defaults to the current time. */
  now?: number
}

export function recoverySignerEligible(params: RecoverySignerEligibleParams): boolean {
  return recoverySignerEligibleFromPublic({
    tree: params.group.state.ratchetTree,
    anchor: params.group.anchor,
    known: params.registry,
    signer: params.signer,
    now: params.now,
  })
}

/** @internal Origin authority does not depend on the offered tree's surviving leaves. */
export function recoverySignerEligibleFromPublic(params: {
  tree: ClientState['ratchetTree']
  anchor: GroupAnchor
  known: DeviceRegistry
  signer: string
  now?: number
}): boolean {
  const { tree, anchor, known: registry, signer, now = Date.now() / 1000 } = params
  const controller = anchor.controller
  if (controller == null) return false
  const leaf = recoveryLeafForDID(tree, signer)
  if (leaf == null) return false
  const binding = recoveryLeafIdentity(leaf)?.controller
  if (binding == null || binding.id !== controller) return false
  for (const node of tree) {
    if (node?.nodeType === nodeTypes.leaf && recoveryLeafIdentity(node.leaf) == null) return false
  }
  try {
    const time = attestedTreeTime(tree, registry, controller)
    const payload =
      binding.member != null || binding.capability == null
        ? undefined
        : readCapability(binding.capability).payload
    if (
      registry.devices.get(normalizeDID(signer))?.status === 'revoked' ||
      (payload?.cap != null &&
        registry.devices.get(normalizeDID(payload.iss))?.status === 'revoked')
    )
      return false
    const folded = foldChain(controller, binding.prefix)
    const projection = registry.controllers.get(normalizeDID(controller))
    if (!folded.ok || (folded.states.at(-1)?.gen ?? 0) < (projection?.genFloor ?? 0)) return false
    const authority = effectiveAuthorityOf(
      { did: signer, binding, leafKey: leaf.signaturePublicKey },
      registry,
      controller,
    )
    if ('status' in authority) return false
    if (binding.member != null && authority.slot === 'membership') {
      const status = memberRootStatus(registry, controller, {
        kind: 'member',
        did: signer,
        add: binding.member.add,
        gen: binding.member.g,
      })
      if (
        status.status !== 'effective' ||
        status.key.length !== leaf.signaturePublicKey.length ||
        status.key.some((byte, index) => byte !== leaf.signaturePublicKey[index])
      )
        return false
    }
    const expiry = leafExpiry(binding, registry, controller)
    return expiry != null && expiry >= Math.max(time, now - 300)
  } catch {
    return false
  }
}

function recoveryLeafIdentity(
  leaf: LeafNode,
): ReturnType<typeof parseMLSCredentialIdentity> | undefined {
  const credential = leaf?.credential
  if (credential == null || typeof credential !== 'object' || !('identity' in credential))
    return undefined
  // Reader faults are operational failures. Only parsing delivered bytes is a refusal.
  const identity = credential.identity
  try {
    return parseMLSCredentialIdentity(identity)
  } catch {
    return undefined
  }
}
