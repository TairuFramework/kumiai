import {
  assertCapabilityToken,
  assertNonExpired,
  assertValidDelegation,
  assertValidIssuedAt,
  assertValidNotBefore,
  checkCapability,
  hasPermission,
  type Permission,
} from '@kokuin/capability'
import type { SignedEvent } from '@kokuin/controller'
import {
  type DIDMethodResolver,
  decodeMultibase,
  decodePeer4,
  getAlgorithmAndPublicKey,
  getSignatureInfo,
  getVerifier,
  isPeer4,
  normalizeDID,
  type ResolvedMember,
  verifyToken,
} from '@kokuin/token'
import { fromB64U, fromUTF } from '@sozai/codec'
import type { AuthenticationService, Credential } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'

import {
  assertCapabilityLifetime,
  assertControllerGrant,
  capabilityKey,
  MAX_LEAF_LIFETIME,
  MAX_TRUSTED_GRANT_LIFETIME,
  MLS_LEAF_ACT,
  MLS_LEAF_RES,
  readCapability,
} from './capability.js'
import { foldChain } from './controller-log.js'
import { type MLSCredentialIdentity, parseMLSCredentialIdentity } from './credential.js'
import { createRegistryControllerResolver, prefixRelation } from './embedded-resolver.js'
import { LeafBindingError } from './errors.js'
import { effectiveAuthorityOf, memberRootStatus, memberRootsOf } from './member-root.js'
import { type DeviceRegistry, denySetOf, mayReadmitResetDevice } from './registry.js'

export { MLS_LEAF_ACT, MLS_LEAF_RES } from './capability.js'

/** The action a management capability must grant to mutate a profile's device registry. */
export const MLS_DEVICES_ACT = 'manage'
/** The resource half — kumiai-namespaced and group-independent. */
export const MLS_DEVICES_RES = 'kumiai/devices'

const EMPTY_DENY: ReadonlySet<string> = new Set()

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index is within bounds
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

/**
 * Whether `signaturePublicKey` is the key the parsed identity's DID authenticates with — the
 * floating-leaf binding, shared by floating validation and the bound branch (a bound leaf is a
 * floating leaf plus a controller attribution). `did:peer:4` binds through the long-form
 * authentication verification methods; every other form is a `did:key` whose key IS its identifier.
 */
function matchesLeafKey(parsed: MLSCredentialIdentity, signaturePublicKey: Uint8Array): boolean {
  if (isPeer4(parsed.id)) {
    if (parsed.longForm == null) return false
    let decoded: ReturnType<typeof decodePeer4>
    try {
      decoded = decodePeer4(parsed.longForm)
    } catch {
      return false
    }
    if (decoded.shortForm !== parsed.id) return false
    // Only verification methods referenced by `authentication` are
    // permitted to sign for authentication — per DID Core. Reject MLS
    // leaves bound to keys outside that set (KEM keys, assertion-only
    // keys, etc.) even if the byte comparison would otherwise match.
    const authIDs = new Set(decoded.doc.authentication ?? [])
    if (authIDs.size === 0) return false
    for (const vm of decoded.doc.verificationMethod ?? []) {
      if (!authIDs.has(vm.id)) continue
      if (typeof vm.publicKeyMultibase !== 'string') continue
      let vmBytes: Uint8Array
      try {
        vmBytes = decodeMultibase(vm.publicKeyMultibase)
      } catch {
        continue
      }
      // Validate multicodec prefix and strip it; rejects unknown codecs
      // (e.g. X25519 KEM keys, future PQ codecs) instead of blindly
      // comparing 2-byte-truncated bytes.
      const stripped = getAlgorithmAndPublicKey(vmBytes)
      if (stripped == null) continue
      const [, publicKeyBytes] = stripped
      if (constantTimeEqual(publicKeyBytes, signaturePublicKey)) return true
    }
    return false
  }

  try {
    const [, publicKeyFromDID] = getSignatureInfo(parsed.id)
    return constantTimeEqual(publicKeyFromDID, signaturePublicKey)
  } catch {
    return false
  }
}

export type JudgingContext = {
  registry?: DeviceRegistry
  stage: 'structural' | 'full'
  mode: 'admit' | 'retain' | 'rejudge'
}

export type DIDAuthenticationDependencies = {
  deviceDenySet?: () => ReadonlySet<string>
  judging?: () => JudgingContext
  leafLifetime?: () => number | undefined
  trustedGrantLifetime?: () => number | undefined
  /**
   * Whether this leaf may keep an issuer the deny set names, on its holder evidence. The caller
   * answers for the group (its anchor names a controller) and for the leaf (it is the credential
   * already in the tree at that index, or it arrives in a Welcome tree). Absent: never.
   */
  mayKeepDeniedIssuer?: (credential: Credential, signaturePublicKey: Uint8Array) => boolean
}

function isDenied(denied: ReadonlySet<string>, did: string): boolean {
  return denied.has(did) || denied.has(normalizeDID(did))
}

type VerifyPinnedCapabilityParams = {
  capability: string
  resolver?: DIDMethodResolver
  stage?: JudgingContext['stage']
  prefix: Array<SignedEvent>
  controllerID: string
  audience: string
  permission: Permission
  leafKey: Uint8Array
  denySet?: ReadonlySet<string>
  leafLifetime?: number
  trustedGrantLifetime?: number
  /** Refuse a delegated (chained) capability. */
  directOnly?: boolean
  /** Verify as a trusted grant, using its configured lifetime and maximum. */
  trustedGrant?: boolean
}

/** Authenticate only embedded proof, using the token's issuance as its reference time. */
async function verifyPinnedCapability(params: VerifyPinnedCapabilityParams): Promise<void> {
  if (
    !params.controllerID.startsWith('did:kokuin:') ||
    !foldChain(params.controllerID, params.prefix).ok
  ) {
    throw new LeafBindingError('controller-mismatch')
  }
  const token = readCapability(params.capability)
  const payload = token.payload
  const ceiling = params.trustedGrant ? MAX_TRUSTED_GRANT_LIFETIME : MAX_LEAF_LIFETIME
  const lifetime = params.trustedGrant ? params.trustedGrantLifetime : params.leafLifetime
  assertCapabilityLifetime(payload, Math.min(lifetime ?? ceiling, ceiling))
  if (normalizeDID(payload.sub) !== normalizeDID(params.controllerID)) {
    throw new LeafBindingError('subject-mismatch')
  }
  if (normalizeDID(payload.aud) !== normalizeDID(params.audience)) {
    throw new LeafBindingError('audience-mismatch')
  }
  if (!hasPermission(params.permission, payload)) throw new LeafBindingError('permission-denied')
  const leafKey = capabilityKey(payload)
  if (!constantTimeEqual(leafKey.publicKey, params.leafKey)) {
    throw new LeafBindingError('confirmation-invalid')
  }
  const denySet = params.denySet ?? EMPTY_DENY
  const base =
    params.resolver ??
    createRegistryControllerResolver({
      controllerID: params.controllerID,
      prefix: params.prefix,
    }).frozen()
  const resolver = {
    ...base,
    async resolveDenySet(did: string): Promise<ReadonlySet<string>> {
      await base.resolveDenySet?.(did)
      return denySet
    },
  }
  const check = async (claims: typeof payload) => {
    if (params.stage === 'structural') return
    await checkCapability(params.permission, claims, {
      atTime: payload.iat,
      methods: [resolver],
      maxDepth: 1,
      // Kokuin forwards this ceiling to the parent; local bounds still apply to each grant.
      maxMemberGrantLifetime: MAX_TRUSTED_GRANT_LIFETIME,
    })
  }
  if (payload.cap === undefined) {
    assertControllerGrant(payload, params.controllerID)
    const verified = await verifyToken(params.capability, {
      methods: [resolver],
      historic: true,
      atTime: payload.iat,
      allowUnsigned: false,
    })
    assertCapabilityToken(verified)
    await check(payload)
    return
  }
  if (params.directOnly) throw new LeafBindingError('chain-depth')
  const parents = Array.isArray(payload.cap) ? payload.cap : [payload.cap]
  const parentRaw = parents[0]
  if (parents.length !== 1 || parentRaw == null) throw new LeafBindingError('chain-depth')
  const parent = readCapability(parentRaw)
  if (parent.payload.cap !== undefined) throw new LeafBindingError('chain-depth')
  assertControllerGrant(parent.payload, params.controllerID)
  assertCapabilityLifetime(
    parent.payload,
    Math.min(params.trustedGrantLifetime ?? MAX_TRUSTED_GRANT_LIFETIME, MAX_TRUSTED_GRANT_LIFETIME),
  )
  if (normalizeDID(payload.iss) !== normalizeDID(parent.payload.aud)) {
    throw new LeafBindingError('issuer-mismatch')
  }
  if (normalizeDID(payload.aud) === normalizeDID(payload.iss)) {
    throw new LeafBindingError('self-issued')
  }
  if (payload.exp > parent.payload.exp) throw new LeafBindingError('child-outlives-parent')
  if (params.stage !== 'structural' && isDenied(denySet, payload.iss))
    throw new LeafBindingError('denied-issuer')
  const issuerKey = capabilityKey(parent.payload)
  if (token.header.alg !== issuerKey.alg) throw new LeafBindingError('signature-invalid')
  if (
    !(await getVerifier(token.header.alg)(
      fromB64U(token.signature),
      fromUTF(token.data),
      issuerKey.publicKey,
    ))
  ) {
    throw new LeafBindingError('signature-invalid')
  }
  assertNonExpired(payload, payload.iat)
  assertValidIssuedAt(payload, payload.iat)
  assertValidNotBefore(payload, payload.iat)
  const verifiedParent = await verifyToken(parentRaw, {
    atTime: payload.iat,
    methods: [resolver],
    historic: true,
    allowUnsigned: false,
  })
  assertCapabilityToken(verifiedParent)
  assertValidDelegation(verifiedParent.payload, payload, payload.iat)
  // A self-issued child bypasses kokuin's parent walk.
  if (normalizeDID(payload.iss) === normalizeDID(payload.sub)) await check(parent.payload)
  await check(payload)
}

function withoutIssuer(denied: ReadonlySet<string>, capability: string): ReadonlySet<string> {
  const issuer = normalizeDID(readCapability(capability).payload.iss)
  return new Set([...denied].filter((did) => normalizeDID(did) !== issuer))
}

/** Structural evidence gate also used before MLS invokes its boolean authentication adapter. */
export function checkHolderEvidence(
  parsed: MLSCredentialIdentity,
  signaturePublicKey: Uint8Array,
  trustedGrantLifetime = MAX_TRUSTED_GRANT_LIFETIME,
): string | undefined {
  const binding = parsed.controller
  if (binding == null) return
  if (binding.member != null) return
  if (binding.capability == null) throw new LeafBindingError('controller-mismatch')
  const leafPayload = readCapability(binding.capability).payload
  if (leafPayload.cap === undefined) {
    if (binding.holderGrant != null) throw new LeafBindingError('holder-evidence-mismatch')
    return
  }
  if (binding.holderGrant == null) throw new LeafBindingError('missing-holder-evidence')
  try {
    const grant = readCapability(binding.holderGrant).payload
    assertControllerGrant(grant, binding.id)
    assertCapabilityLifetime(grant, Math.min(trustedGrantLifetime, MAX_TRUSTED_GRANT_LIFETIME))
    if (
      grant.cap !== undefined ||
      grant.iat > leafPayload.iat ||
      grant.exp <= leafPayload.iat ||
      (grant.nbf != null && grant.nbf > leafPayload.iat) ||
      normalizeDID(grant.aud) !== normalizeDID(parsed.id) ||
      !constantTimeEqual(capabilityKey(grant).publicKey, signaturePublicKey) ||
      !hasPermission({ act: MLS_LEAF_ACT, res: MLS_LEAF_RES }, grant)
    )
      throw new LeafBindingError('holder-evidence-mismatch')
  } catch (cause) {
    if (
      cause instanceof LeafBindingError &&
      cause.reason === 'lifetime-cap' &&
      readCapability(binding.holderGrant).payload.mbr != null
    )
      throw cause
    const error = new LeafBindingError('holder-evidence-mismatch')
    error.cause = cause
    throw error
  }
  return binding.holderGrant
}

/**
 * A chained leaf carrying its holder's own valid controller grant, for a holder the deny set does
 * not name. Such a leaf names a device the controller bound itself, so denying the device that
 * issued its capability does not take that binding away.
 */
export function hasHolderEvidence(
  parsed: MLSCredentialIdentity,
  signaturePublicKey: Uint8Array,
  denied: ReadonlySet<string>,
  trustedGrantLifetime?: number,
): boolean {
  const binding = parsed.controller
  if (binding == null || binding.member != null || isDenied(denied, parsed.id)) return false
  if (binding.capability == null) throw new LeafBindingError('controller-mismatch')
  try {
    if (readCapability(binding.capability).payload.cap === undefined) return false
    return checkHolderEvidence(parsed, signaturePublicKey, trustedGrantLifetime) != null
  } catch {
    return false
  }
}

/** Internal throwing boundary for entry gates; ts-mls consumes the boolean adapter below. */
export async function verifyLeafCredential(
  credential: Credential,
  signaturePublicKey: Uint8Array,
  deps: DIDAuthenticationDependencies = {},
): Promise<void> {
  if (credential.credentialType !== defaultCredentialTypes.basic) {
    throw new Error('Unsupported MLS credential type')
  }
  const parsed = parseMLSCredentialIdentity((credential as { identity: Uint8Array }).identity)
  if (!matchesLeafKey(parsed, signaturePublicKey)) throw new LeafBindingError('identity-change')
  const judging: JudgingContext = deps.judging?.() ?? { stage: 'full', mode: 'admit' }
  const registry = judging.registry
  const structural = judging.stage === 'structural'
  const denied = structural
    ? EMPTY_DENY
    : (deps.deviceDenySet?.() ?? (registry == null ? EMPTY_DENY : denySetOf(registry)))
  if (isDenied(denied, parsed.id) && (registry == null || !mayReadmitResetDevice(registry, parsed)))
    throw new LeafBindingError('denied-id')
  // Exempt only this holder; every issuer remains subject to the full deny set.
  const denySet = isDenied(denied, parsed.id)
    ? new Set([...denied].filter((did) => normalizeDID(did) !== normalizeDID(parsed.id)))
    : denied
  const binding = parsed.controller
  if (binding == null) return
  if (!structural && registry != null) {
    const folded = foldChain(binding.id, binding.prefix)
    if (!folded.ok) throw new LeafBindingError('controller-mismatch')
    if (
      (folded.states.at(-1)?.gen ?? 0) <
      (registry.controllers.get(normalizeDID(binding.id))?.genFloor ?? 0)
    )
      throw new LeafBindingError('generation-floor')
  }
  try {
    const roots = memberRootsOf(binding, parsed.id)
    const primary = roots[0]
    if (!structural && registry == null && roots.some(({ root }) => root.kind === 'member'))
      throw new LeafBindingError('controller-mismatch')
    const frozen = createRegistryControllerResolver({
      controllerID: binding.id,
      prefix: binding.prefix,
      registry: structural ? undefined : registry,
    }).frozen()
    if (binding.member != null) {
      if (!binding.id.startsWith('did:kokuin:') || !foldChain(binding.id, binding.prefix).ok)
        throw new LeafBindingError('controller-mismatch')
      if (structural) return
      if (registry == null) throw new LeafBindingError('controller-mismatch')
      const root = primary?.root
      if (root == null) throw new LeafBindingError('member-unavailable')
      const status = memberRootStatus(registry, binding.id, root)
      if (status.status === 'removed') throw new LeafBindingError('member-removed')
      const unavailable = () => {
        if (judging.mode !== 'retain') throw new LeafBindingError('member-unavailable')
      }
      const projection = registry.controllers.get(normalizeDID(binding.id))
      if (prefixRelation(projection?.recordedLog, binding.prefix) !== 'contained') {
        unavailable()
        return
      }
      let member: ResolvedMember | undefined
      try {
        member = await frozen.resolveMember?.(binding.id, {
          did: parsed.id,
          add: binding.member.add,
          gen: binding.member.g,
        })
      } catch (cause) {
        if (cause instanceof Error && cause.message.endsWith('is another DID')) {
          const error = new LeafBindingError('member-removed')
          error.cause = cause
          throw error
        }
        unavailable()
        return
      }
      if (member == null || status.status !== 'effective') {
        unavailable()
        return
      }
      if (!constantTimeEqual(member.key.publicKey, signaturePublicKey))
        throw new LeafBindingError('confirmation-invalid')
      return
    }
    if (binding.capability == null) throw new LeafBindingError('controller-mismatch')
    const common = {
      prefix: binding.prefix,
      controllerID: binding.id,
      audience: parsed.id,
      permission: { act: MLS_LEAF_ACT, res: MLS_LEAF_RES },
      leafKey: signaturePublicKey,
      resolver: frozen,
      leafLifetime: deps.leafLifetime?.(),
      trustedGrantLifetime: deps.trustedGrantLifetime?.(),
    }
    const verifyHolder = async (capability: string, stage: JudgingContext['stage']) => {
      try {
        await verifyPinnedCapability({
          ...common,
          capability,
          stage,
          denySet,
          directOnly: true,
          trustedGrant: true,
        })
      } catch (cause) {
        if (cause instanceof LeafBindingError && cause.reason === 'lifetime-cap') throw cause
        const error = new LeafBindingError('holder-evidence-mismatch')
        error.cause = cause
        throw error
      }
    }
    // Authenticate every carried signature before consulting current authority or substitutes.
    await verifyPinnedCapability({ ...common, capability: binding.capability, stage: 'structural' })
    const holderGrant = checkHolderEvidence(parsed, signaturePublicKey, common.trustedGrantLifetime)
    if (holderGrant != null) await verifyHolder(holderGrant, 'structural')
    if (structural) return

    if (primary?.root.kind === 'member') {
      const status =
        registry == null
          ? { status: 'unavailable' as const }
          : memberRootStatus(registry, binding.id, primary.root)
      if (judging.mode === 'admit') {
        if (status.status === 'removed') throw new LeafBindingError('member-removed')
        if (status.status === 'unavailable') throw new LeafBindingError('member-unavailable')
      }
      const projection = registry?.controllers.get(normalizeDID(binding.id))
      const unavailable =
        status.status === 'unavailable' ||
        (status.status !== 'removed' &&
          prefixRelation(projection?.recordedLog, binding.prefix) !== 'contained')
      if (unavailable) {
        if (judging.mode === 'retain') return
        throw new LeafBindingError('member-unavailable')
      }
      if (registry == null) throw new LeafBindingError('member-unavailable')
      const authority = effectiveAuthorityOf(
        { did: parsed.id, binding, leafKey: signaturePublicKey },
        registry,
        binding.id,
      )
      if ('status' in authority) {
        if (authority.status === 'unavailable' && judging.mode === 'retain') return
        throw new LeafBindingError(
          authority.status === 'removed' ? 'member-removed' : 'member-unavailable',
        )
      }
      if (authority.slot === 'holder' || authority.slot === 'survivor') {
        const substitute =
          authority.slot === 'holder'
            ? holderGrant
            : projection?.survivorGrants.get(normalizeDID(parsed.id))
        if (substitute == null) throw new LeafBindingError('member-removed')
        await verifyHolder(substitute, 'full')
        return
      }
    }
    // The holder grant does not inherit the leaf capability's issuer exception.
    const leafDenySet =
      deps.mayKeepDeniedIssuer?.(credential, signaturePublicKey) &&
      hasHolderEvidence(parsed, signaturePublicKey, denySet, common.trustedGrantLifetime)
        ? withoutIssuer(denySet, binding.capability)
        : denySet
    await verifyPinnedCapability({
      ...common,
      capability: binding.capability,
      denySet: leafDenySet,
    })
    if (holderGrant != null) {
      const holder = roots.find(({ slot }) => slot === 'holder')
      if (holder?.root.kind === 'member' && registry != null) {
        const status = memberRootStatus(registry, binding.id, holder.root)
        if (
          status.status === 'unavailable' ||
          (status.status !== 'removed' &&
            prefixRelation(
              registry.controllers.get(normalizeDID(binding.id))?.recordedLog,
              binding.prefix,
            ) !== 'contained')
        ) {
          if (judging.mode === 'retain') return
          throw new LeafBindingError('member-unavailable')
        }
      }
      await verifyHolder(holderGrant, 'full')
    }
  } catch (error) {
    if (error instanceof LeafBindingError) throw error
    const rejection = new LeafBindingError('signature-invalid')
    rejection.cause = error
    throw rejection
  }
}

/** Management grants are direct controller grants, verified at their issuance time. */
export async function verifyManagementCapability(params: {
  capability?: string
  prefix: Array<SignedEvent>
  controllerID: string
  audience: string
  leafKey: Uint8Array
}): Promise<boolean> {
  if (params.capability == null) return false
  try {
    if (readCapability(params.capability).payload.mbr != null) return false
    await verifyPinnedCapability({
      ...params,
      capability: params.capability,
      permission: { act: MLS_DEVICES_ACT, res: MLS_DEVICES_RES },
      directOnly: true,
    })
    return true
  } catch {
    return false
  }
}

export function createDIDAuthenticationService(
  deps: DIDAuthenticationDependencies = {},
): AuthenticationService {
  return {
    async validateCredential(
      credential: Credential,
      signaturePublicKey: Uint8Array,
    ): Promise<boolean> {
      try {
        await verifyLeafCredential(credential, signaturePublicKey, deps)
        return true
      } catch {
        return false
      }
    },
  }
}
