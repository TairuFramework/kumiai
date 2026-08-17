import {
  assertCapabilityToken,
  assertDeviceCapabilityPolicy,
  assertValidIssuedAt,
  hasPermission,
  type Permission,
} from '@kokuin/capability'
import { type SignedEvent, tryDecodeKey } from '@kokuin/controller'
import {
  decodeMultibase,
  decodePeer4,
  getAlgorithmAndPublicKey,
  getSignatureInfo,
  isPeer4,
  normalizeDID,
  verifyToken,
} from '@kokuin/token'
import type { AuthenticationService, Credential } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'

import { type MLSCredentialIdentity, parseMLSCredentialIdentity } from './credential.js'
import { createEmbeddedControllerResolver } from './embedded-resolver.js'

/** The action a device capability must grant for a leaf to authenticate as a kumiai MLS leaf. */
export const MLS_LEAF_ACT = 'authenticate'
/** The resource half of that grant — kumiai-namespaced, group-independent. */
export const MLS_LEAF_RES = 'kumiai/mls-leaf'

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

/**
 * The shared capability-verification core: verify a `cnf`-pinned, `exp`-bounded @kokuin/capability
 * grant against a controller's EMBEDDED log prefix (no external I/O), asserting it grants
 * `permission` to `audience` and pins `leafKey`. Returns false on any failure. Optionally pins the
 * issuer (`requireIssuer`) — the embedded resolver already answers only for `controllerID`, so the
 * issuer is pinned there too; the explicit check is belt-and-braces for the manage path.
 */
async function verifyPinnedCapability(params: {
  capability: string
  prefix: Array<SignedEvent>
  controllerID: string
  audience: string
  permission: Permission
  leafKey: Uint8Array
  requireIssuer?: string
}): Promise<boolean> {
  const resolver = createEmbeddedControllerResolver({
    controllerID: params.controllerID,
    prefix: params.prefix,
  })
  let verified: Awaited<ReturnType<typeof verifyToken>>
  try {
    verified = await verifyToken(params.capability, {
      methods: [resolver],
      historic: true,
      allowUnsigned: false,
    })
  } catch {
    return false
  }
  try {
    assertCapabilityToken(verified)
    if (
      params.requireIssuer != null &&
      normalizeDID(verified.payload.iss) !== normalizeDID(params.requireIssuer)
    )
      return false
    if (normalizeDID(verified.payload.aud) !== normalizeDID(params.audience)) return false
    if (!hasPermission(params.permission, verified.payload)) return false
    assertValidIssuedAt(verified.payload)
    assertDeviceCapabilityPolicy(verified.payload)
  } catch {
    return false
  }
  const kid = verified.payload.cnf?.kid
  if (typeof kid !== 'string') return false
  const pinned = tryDecodeKey(kid)
  return pinned != null && constantTimeEqual(pinned.publicKey, params.leafKey)
}

/**
 * Validate a bound leaf: the device authenticates against its own leaf key (floating check), and the
 * embedded controller proof shows the profile authorised THIS device with THIS key. All sync — the
 * prefix is folded through the embedded resolver, never fetched. Returns false on any failure.
 */
async function validateBoundLeaf(
  parsed: MLSCredentialIdentity,
  signaturePublicKey: Uint8Array,
  deviceDenySet: () => ReadonlySet<string>,
): Promise<boolean> {
  const controller = parsed.controller
  if (controller == null) return false
  if (!controller.id.startsWith('did:kokuin:')) return false
  if (!matchesLeafKey(parsed, signaturePublicKey)) return false

  // Deny governs the capability-mediated (bound) leaf; checked before the capability verify so a
  // revoked device is rejected regardless of an otherwise-valid grant.
  if (deviceDenySet().has(normalizeDID(parsed.id))) return false

  return await verifyPinnedCapability({
    capability: controller.capability,
    prefix: controller.prefix,
    controllerID: controller.id,
    audience: parsed.id,
    permission: { act: MLS_LEAF_ACT, res: MLS_LEAF_RES },
    leafKey: signaturePublicKey,
  })
}

/**
 * Verify a management capability presented by a manage-op's issuer device: the authorized profile
 * (`controllerID`) issued a `kumiai/devices` grant to that device (`audience`), `cnf`-pinned to the
 * device's leaf key and `exp`-bounded. Verified against the profile's log prefix (embedded in the
 * issuer's own bound leaf), never fetched. Returns false on any failure.
 */
export async function verifyManagementCapability(params: {
  capability?: string
  prefix: Array<SignedEvent>
  controllerID: string
  audience: string
  leafKey: Uint8Array
}): Promise<boolean> {
  if (params.capability == null) return false
  return await verifyPinnedCapability({
    capability: params.capability,
    prefix: params.prefix,
    controllerID: params.controllerID,
    audience: params.audience,
    permission: { act: MLS_DEVICES_ACT, res: MLS_DEVICES_RES },
    leafKey: params.leafKey,
    requireIssuer: params.controllerID,
  })
}

export function createDIDAuthenticationService(
  deps: { deviceDenySet?: () => ReadonlySet<string> } = {},
): AuthenticationService {
  const deviceDenySet = deps.deviceDenySet ?? (() => EMPTY_DENY)
  return {
    async validateCredential(
      credential: Credential,
      signaturePublicKey: Uint8Array,
    ): Promise<boolean> {
      if (credential.credentialType !== defaultCredentialTypes.basic) {
        return false
      }

      let parsed: MLSCredentialIdentity
      try {
        parsed = parseMLSCredentialIdentity((credential as { identity: Uint8Array }).identity)
      } catch {
        return false
      }

      if (parsed.controller != null) {
        try {
          return await validateBoundLeaf(parsed, signaturePublicKey, deviceDenySet)
        } catch {
          return false
        }
      }
      return matchesLeafKey(parsed, signaturePublicKey)
    },
  }
}
