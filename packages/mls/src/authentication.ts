import {
  assertCapabilityToken,
  assertValidDelegation,
  checkCapability,
  hasPermission,
  type Permission,
} from '@kokuin/capability'
import { foldLog, type SignedEvent } from '@kokuin/controller'
import {
  decodeMultibase,
  decodePeer4,
  getAlgorithmAndPublicKey,
  getSignatureInfo,
  getVerifier,
  isPeer4,
  normalizeDID,
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
import { type MLSCredentialIdentity, parseMLSCredentialIdentity } from './credential.js'
import { createEmbeddedControllerResolver } from './embedded-resolver.js'
import { LeafBindingError } from './errors.js'

export { MLS_LEAF_ACT, MLS_LEAF_RES } from './capability.js'

/** The action a management capability must grant to mutate a profile's device registry. */
export const MLS_DEVICES_ACT = 'manage'
/** The resource half — kumiai-namespaced, group-independent, per the kokuin management tier. */
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

export type DIDAuthenticationDependencies = {
  deviceDenySet?: () => ReadonlySet<string>
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
    !foldLog(params.controllerID, params.prefix).ok
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
  const resolver = createEmbeddedControllerResolver({
    controllerID: params.controllerID,
    prefix: params.prefix,
    denySet,
  })
  if (payload.cap === undefined) {
    assertControllerGrant(payload, params.controllerID)
    const verified = await verifyToken(params.capability, {
      methods: [resolver],
      historic: true,
      atTime: payload.iat,
      allowUnsigned: false,
    })
    assertCapabilityToken(verified)
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
  if (isDenied(denySet, payload.iss)) throw new LeafBindingError('denied-issuer')
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
  // checkCapability treats iss === sub as a root grant, so it does not walk that parent.
  if (normalizeDID(payload.iss) === normalizeDID(payload.sub)) {
    const verifiedParent = await verifyToken(parentRaw, {
      atTime: payload.iat,
      methods: [resolver],
      historic: true,
      allowUnsigned: false,
    })
    assertCapabilityToken(verifiedParent)
    assertValidDelegation(verifiedParent.payload, payload, payload.iat)
  }
  await checkCapability(params.permission, payload, {
    atTime: payload.iat,
    methods: [resolver],
    maxDepth: 1,
  })
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
  const leafPayload = readCapability(binding.capability).payload
  if (leafPayload.cap === undefined) return
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
  if (binding == null || isDenied(denied, parsed.id)) return false
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
  const denySet = deps.deviceDenySet?.() ?? EMPTY_DENY
  if (isDenied(denySet, parsed.id)) throw new LeafBindingError('denied-id')
  if (parsed.controller == null) return
  try {
    // The holder grant below is still verified against the full deny set.
    const leafDenySet =
      deps.mayKeepDeniedIssuer?.(credential, signaturePublicKey) &&
      hasHolderEvidence(parsed, signaturePublicKey, denySet, deps.trustedGrantLifetime?.())
        ? withoutIssuer(denySet, parsed.controller.capability)
        : denySet
    await verifyPinnedCapability({
      capability: parsed.controller.capability,
      prefix: parsed.controller.prefix,
      controllerID: parsed.controller.id,
      audience: parsed.id,
      permission: { act: MLS_LEAF_ACT, res: MLS_LEAF_RES },
      leafKey: signaturePublicKey,
      denySet: leafDenySet,
      leafLifetime: deps.leafLifetime?.(),
      trustedGrantLifetime: deps.trustedGrantLifetime?.(),
    })
    const holderGrant = checkHolderEvidence(
      parsed,
      signaturePublicKey,
      deps.trustedGrantLifetime?.(),
    )
    if (holderGrant != null) {
      try {
        await verifyPinnedCapability({
          capability: holderGrant,
          prefix: parsed.controller.prefix,
          controllerID: parsed.controller.id,
          audience: parsed.id,
          permission: { act: MLS_LEAF_ACT, res: MLS_LEAF_RES },
          leafKey: signaturePublicKey,
          denySet,
          trustedGrantLifetime: deps.trustedGrantLifetime?.(),
          directOnly: true,
          trustedGrant: true,
        })
      } catch (cause) {
        const error = new LeafBindingError('holder-evidence-mismatch')
        error.cause = cause
        throw error
      }
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
