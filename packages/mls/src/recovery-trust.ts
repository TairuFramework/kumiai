import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import { canonicalStringify } from '@sozai/codec'
import type { ClientState } from 'ts-mls'

import { decodeGroupAnchor } from './anchor.js'
import { verifyLeafCredential } from './authentication.js'
import {
  type ControllerBinding,
  didFromCredential,
  type MemberCredential,
  parseMLSCredentialIdentity,
} from './credential.js'
import { LeafBindingError } from './errors.js'
import { resolveMlsContext } from './group-context.js'
import {
  type CapturedRecoveryGroupInfo,
  createRecoveryRequest,
  openRecoveryGroupInfoFromPublic,
  type PublicRecoveryGroup,
  recoveryLeafForDID,
  SealedGroupInfoError,
} from './recovery.js'
import {
  type OpenedRecoveryVerdict,
  openRecoveryVerdict,
  recoverySignerEligibleFromPublic,
} from './recovery-verdict.js'
import { type DeviceRegistry, denySetOf } from './registry.js'
import type { GroupOptions } from './types.js'

export type RecoveryTrustInputs = {
  groupID: string
  genesisAnchor: Uint8Array
  signerTree: ClientState['ratchetTree']
  registry: DeviceRegistry
  credential: MemberCredential
  binding: ControllerBinding | null
  ledger: Array<string>
  ciphersuiteName: string
}

export type CreateRecoveryRequestFromTrustParams = {
  trust: RecoveryTrustInputs
  identity: OwnIdentity
  requestID: string
  deadlineMs?: number
  comparisonEpoch?: number
}

export type AuthenticateRecoveryReplyParams = {
  trust: RecoveryTrustInputs
  sealed: Uint8Array
  requestID: string
  requestKey: Uint8Array
  options: GroupOptions
}

export async function publicRecoveryGroup(
  trust: RecoveryTrustInputs,
  options: GroupOptions,
): Promise<PublicRecoveryGroup> {
  const anchor = decodeGroupAnchor(trust.genesisAnchor)
  if (anchor == null || trust.credential.groupID !== trust.groupID)
    throw new SealedGroupInfoError('group-mismatch', 'Invalid retained recovery group binding')
  const context = await resolveMlsContext(
    { ...options, ciphersuiteName: trust.ciphersuiteName },
    anchor,
  )
  return {
    groupID: trust.groupID,
    credential: trust.credential,
    context,
    anchor,
    genesisAnchor: trust.genesisAnchor,
    signerTree: trust.signerTree,
  }
}

async function assertTrustedMember(
  group: PublicRecoveryGroup,
  trust: RecoveryTrustInputs,
  did: string,
): Promise<void> {
  const member = recoveryLeafForDID(group.signerTree, did)
  if (member == null || !('identity' in member.credential))
    throw new SealedGroupInfoError(
      'unauthenticated',
      'Recovery identity is absent from retained signer tree',
    )
  const parsed = parseMLSCredentialIdentity(member.credential.identity)
  if (group.anchor.controller != null && parsed.controller?.id !== group.anchor.controller)
    throw new SealedGroupInfoError(
      'unauthenticated',
      'Retained signer has the wrong controller binding',
    )
  // Keep reader exceptions outside the credential verifier's rejection boundary.
  const denied = denySetOf(trust.registry)
  await verifyLeafCredential(member.credential, member.signaturePublicKey, {
    deviceDenySet: () => denied,
    leafLifetime: () => group.anchor.leafLifetime,
    trustedGrantLifetime: () => group.anchor.trustedGrantLifetime,
  })
}

export async function assertTrustedRecoveryOwner(
  group: PublicRecoveryGroup,
  trust: RecoveryTrustInputs,
): Promise<void> {
  if (trust.registry.devices.get(normalizeDID(trust.credential.id))?.status === 'revoked')
    throw new SealedGroupInfoError('unauthenticated', 'Retained recovery owner is denied')
  const owner = recoveryLeafForDID(group.signerTree, trust.credential.id)
  if (owner == null || !('identity' in owner.credential))
    throw new SealedGroupInfoError('unauthenticated', 'Retained recovery owner is absent')
  const held = parseMLSCredentialIdentity(owner.credential.identity).controller ?? null
  if (canonicalStringify(held) !== canonicalStringify(trust.binding))
    throw new SealedGroupInfoError(
      'unauthenticated',
      'Retained recovery owner binding does not match',
    )
  await assertTrustedMember(group, trust, trust.credential.id)
}

export async function assertTrustedRecoverySigner(
  group: PublicRecoveryGroup,
  trust: RecoveryTrustInputs,
  signer: string,
  publicKey?: Uint8Array,
): Promise<void> {
  let signerGroup = group
  if (publicKey !== undefined) {
    const member = recoveryLeafForDID(group.signerTree, signer)
    const first = group.signerTree.findIndex((node) => node?.nodeType === 1 && node.leaf === member)
    const selected = group.signerTree.findIndex(
      (node) =>
        node?.nodeType === 1 &&
        didFromCredential(node.leaf.credential) === normalizeDID(signer) &&
        publicKey.length === node.leaf.signaturePublicKey.length &&
        publicKey.every((byte, index) => byte === node.leaf.signaturePublicKey[index]),
    )
    if (first < 0 || selected < 0)
      throw new SealedGroupInfoError(
        'unauthenticated',
        'Recovery signing key is absent from retained tree',
      )
    if (first !== selected) {
      // DID-based authority checks must select this key while retaining every member's time floor.
      const signerTree = group.signerTree.slice()
      ;[signerTree[first], signerTree[selected]] = [signerTree[selected], signerTree[first]]
      signerGroup = { ...group, signerTree }
    }
  }
  await assertTrustedMember(signerGroup, trust, signer)
  if (
    signerGroup.anchor.controller != null &&
    !recoverySignerEligibleFromPublic({
      tree: signerGroup.signerTree,
      anchor: signerGroup.anchor,
      known: trust.registry,
      signer,
    })
  )
    throw new SealedGroupInfoError('unauthenticated', 'Ineligible retained recovery signer')
}

export async function createRecoveryRequestFromTrust(
  params: CreateRecoveryRequestFromTrustParams,
): Promise<{ request: string; requestKey: Uint8Array }> {
  const { trust, identity, requestID } = params
  const group = await publicRecoveryGroup(trust, {})
  const held = await createRecoveryRequest({
    group,
    identity,
    requestID,
    comparisonEpoch: params.comparisonEpoch,
  })
  return { request: held.request, requestKey: held.ephemeralPrivateKey }
}

export async function authenticateRecoveryReply(
  params: AuthenticateRecoveryReplyParams,
): Promise<CapturedRecoveryGroupInfo | null> {
  const { trust, sealed, requestID, requestKey, options } = params
  // Provider construction and local key faults must not become wire refusals.
  if (requestKey.length !== 32) throw new Error('Invalid retained recovery request key length')
  try {
    const group = await publicRecoveryGroup(trust, options)
    await assertTrustedRecoveryOwner(group, trust)
    const reply = await openRecoveryGroupInfoFromPublic({
      group,
      sealed,
      requestID,
      ephemeralPrivateKey: requestKey,
      captured: true,
    })
    await assertTrustedRecoverySigner(group, trust, reply.signer)
    return reply
  } catch (error) {
    if (error instanceof SealedGroupInfoError || error instanceof LeafBindingError) return null
    throw error
  }
}

export async function openRecoveryVerdictFromTrust(
  params: AuthenticateRecoveryReplyParams,
): Promise<OpenedRecoveryVerdict> {
  const { trust, sealed, requestID, requestKey, options } = params
  const group = await publicRecoveryGroup(trust, options)
  await assertTrustedRecoveryOwner(group, trust)
  const opened = await openRecoveryVerdict({
    group,
    sealed,
    requestID,
    ephemeralPrivateKey: requestKey,
    retainedTrust: true,
  })
  // Controller-less confirmations gain authority from the caller's candidate-derived tuple/tag check.
  if (group.anchor.controller != null || opened.verdict.verdict !== 'confirmed')
    await assertTrustedRecoverySigner(group, trust, opened.signer)
  return opened
}
