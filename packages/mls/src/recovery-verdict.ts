import { foldLog } from '@kokuin/controller'
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

import { readCapability } from './capability.js'
import type { GroupHandle } from './group-handle.js'
import {
  type OpenSealedGroupInfoParams,
  openSealedReply,
  type SealedReplyKind,
  sealToRequest,
  verifyRecoveryRequest,
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
  | { verdict: 'refused'; reason: RecoveryRefusalReason }
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

export async function sealRecoveryVerdict(params: {
  group: GroupHandle
  identity: SigningIdentity
  request: string
  verdict: RecoveryVerdict
}): Promise<Uint8Array> {
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
  return await sealToRequest(
    VERDICT_REPLY,
    group,
    request,
    utf8.encode(stringifyToken(token)),
    false,
  )
}

export async function openRecoveryVerdict(
  params: OpenSealedGroupInfoParams,
): Promise<OpenedRecoveryVerdict> {
  const { group, sealed, requestID, ephemeralPrivateKey } = params
  const plaintext = await openSealedReply(
    VERDICT_REPLY,
    group,
    sealed,
    requestID,
    ephemeralPrivateKey,
  )
  const token = await verifyToken(new TextDecoder().decode(plaintext))
  if (
    !isVerifiedToken(token) ||
    token.payload.type !== VERDICT_TYPE ||
    !isRecoveryVerdict(token.payload) ||
    token.payload.groupID !== group.groupID ||
    token.payload.requestID !== requestID
  )
    throw new Error('Unauthenticated recovery verdict')
  const { groupID, position, commitDigest } = token.payload
  const binding = { groupID, requestID, position, commitDigest }
  const verdict: RecoveryVerdict =
    token.payload.verdict === 'confirmed'
      ? { ...binding, verdict: 'confirmed', epoch: token.payload.epoch, tag: token.payload.tag }
      : token.payload.verdict === 'refused'
        ? { ...binding, verdict: 'refused', reason: token.payload.reason }
        : { ...binding, verdict: 'superseded' }
  return { signer: normalizeDID(token.payload.iss), verdict }
}

export function recoverySignerEligible(
  group: GroupHandle,
  known: DeviceRegistry,
  signer: string,
  now = Date.now() / 1000,
): boolean {
  const controller = group.anchor.controller
  if (controller == null) return false
  try {
    const binding = group.bindingOfDID(signer)
    if (binding?.controller !== controller || binding.capability == null || binding.prefix == null)
      return false
    const payload = readCapability(binding.capability).payload
    if (
      known.devices.get(normalizeDID(signer))?.status === 'revoked' ||
      (payload.cap != null && known.devices.get(normalizeDID(payload.iss))?.status === 'revoked')
    )
      return false
    const folded = foldLog(controller, binding.prefix)
    const projection = known.controllers.get(normalizeDID(controller))
    if (!folded.ok || (folded.states.at(-1)?.gen ?? 0) < (projection?.genFloor ?? 0)) return false
    let time = projection?.timeFloor ?? 0
    for (const member of group.listMembers()) {
      const leaf = group.bindingOfDID(member.id)
      if (leaf?.controller !== controller || leaf.capability == null) continue
      const capability = readCapability(leaf.capability).payload
      const parent = Array.isArray(capability.cap) ? capability.cap[0] : capability.cap
      time = Math.max(time, parent == null ? capability.iat : readCapability(parent).payload.iat)
    }
    return payload.exp >= Math.max(time, now - 300)
  } catch {
    return false
  }
}
