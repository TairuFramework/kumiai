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
}

function isDenied(denied: ReadonlySet<string>, did: string): boolean {
  return denied.has(did) || denied.has(normalizeDID(did))
}

/** Authenticate only embedded proof, using the token's issuance as its reference time. */
async function verifyPinnedCapability(params: {
  capability: string
  prefix: Array<SignedEvent>
  controllerID: string
  audience: string
  permission: Permission
  leafKey: Uint8Array
  denySet?: ReadonlySet<string>
  leafLifetime?: number
  trustedGrantLifetime?: number
  directOnly?: boolean
}): Promise<void> {
  if (
    !params.controllerID.startsWith('did:kokuin:') ||
    !foldLog(params.controllerID, params.prefix).ok
  ) {
    throw new LeafBindingError('controller-mismatch')
  }
  const token = readCapability(params.capability)
  const payload = token.payload
  const leafLifetime = Math.min(params.leafLifetime ?? MAX_LEAF_LIFETIME, MAX_LEAF_LIFETIME)
  assertCapabilityLifetime(payload, leafLifetime)
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
    await verifyPinnedCapability({
      capability: parsed.controller.capability,
      prefix: parsed.controller.prefix,
      controllerID: parsed.controller.id,
      audience: parsed.id,
      permission: { act: MLS_LEAF_ACT, res: MLS_LEAF_RES },
      leafKey: signaturePublicKey,
      denySet,
      leafLifetime: deps.leafLifetime?.(),
      trustedGrantLifetime: deps.trustedGrantLifetime?.(),
    })
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
