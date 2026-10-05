import { audienceConfirmation, type CapabilityPayload, hasPermission } from '@kokuin/capability'
import { tryDecodeKey } from '@kokuin/controller'
import {
  isSignedToken,
  normalizeDID,
  now,
  type SignedToken,
  type SigningIdentity,
  stringifyToken,
} from '@kokuin/token'
import { b64uToJSON } from '@sozai/codec'

import { LeafBindingError } from './errors.js'

/** The action a device capability must grant for a leaf to authenticate as a kumiai MLS leaf. */
export const MLS_LEAF_ACT = 'authenticate'
/** The resource half of that grant — kumiai-namespaced, group-independent. */
export const MLS_LEAF_RES = 'kumiai/mls-leaf'

export const MAX_LEAF_LIFETIME = 604800
export const MAX_TRUSTED_GRANT_LIFETIME = 31536000

type LeafCapabilityPayload = CapabilityPayload & {
  iat: number
  exp: number
  nbf?: number
  cap?: string | Array<string>
}

/** Decode only; callers must authenticate the signed bytes before trusting these claims. */
export function readCapability(raw: string): SignedToken<LeafCapabilityPayload> {
  const parts = raw.split('.')
  const [header, payload, signature] = parts
  if (parts.length !== 3 || !header || !payload || !signature) {
    throw new Error('Invalid capability encoding')
  }
  const token = {
    header: b64uToJSON(header),
    payload: b64uToJSON(payload),
    signature,
    data: `${header}.${payload}`,
  }
  if (!isSignedToken(token)) throw new Error('Invalid signed capability')
  const claims = token.payload
  if (typeof claims.sub !== 'string' || typeof claims.aud !== 'string') {
    throw new Error('Invalid capability subject or audience')
  }
  for (const part of [claims.act, claims.res]) {
    if (
      typeof part !== 'string' &&
      !(Array.isArray(part) && part.every((value) => typeof value === 'string'))
    ) {
      throw new Error('Invalid capability permission')
    }
  }
  return token as SignedToken<LeafCapabilityPayload>
}

export function assertCapabilityLifetime(
  payload: { iat?: unknown; exp?: unknown; nbf?: unknown },
  maximum: number,
): void {
  const { iat, exp, nbf } = payload
  if (
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    exp <= iat ||
    exp - iat > maximum ||
    !Number.isFinite(maximum) ||
    maximum <= 0
  ) {
    throw new LeafBindingError('lifetime-cap')
  }
  if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf))) {
    throw new Error('Invalid capability not-before claim')
  }
}

export function capabilityKey(payload: CapabilityPayload) {
  const cnf = payload.cnf
  if (
    cnf == null ||
    typeof cnf !== 'object' ||
    Object.keys(cnf).length !== 1 ||
    typeof cnf.kid !== 'string'
  ) {
    throw new LeafBindingError('confirmation-invalid')
  }
  const key = tryDecodeKey(cnf.kid)
  if (key == null || key.alg !== 'EdDSA') throw new Error('Invalid capability confirmation key')
  return key
}

export function assertControllerGrant(payload: CapabilityPayload, controllerID: string): void {
  if (normalizeDID(payload.iss) !== normalizeDID(controllerID)) {
    throw new LeafBindingError('issuer-mismatch')
  }
  if (normalizeDID(payload.sub) !== normalizeDID(controllerID)) {
    throw new LeafBindingError('subject-mismatch')
  }
}

export type MintLeafCapabilityParams = {
  signer: SigningIdentity
  controllerID: string
  audience: string
  leafKey: Uint8Array
  exp: number
  parent?: string
}

export type MintTrustedGrantParams = Omit<MintLeafCapabilityParams, 'parent'>

function issuingPayload(params: MintTrustedGrantParams, maximum: number) {
  if (!params.controllerID.startsWith('did:kokuin:')) {
    throw new LeafBindingError('controller-mismatch')
  }
  const iat = now()
  assertCapabilityLifetime({ iat, exp: params.exp }, maximum)
  const cnf = audienceConfirmation({ alg: 'EdDSA', publicKey: params.leafKey })
  capabilityKey({
    iss: params.signer.id,
    sub: params.controllerID,
    aud: params.audience,
    act: MLS_LEAF_ACT,
    res: MLS_LEAF_RES,
    cnf,
  })
  return {
    sub: params.controllerID,
    aud: params.audience,
    act: MLS_LEAF_ACT,
    res: MLS_LEAF_RES,
    cnf,
    iat,
    exp: params.exp,
  }
}

export async function mintLeafCapability(params: MintLeafCapabilityParams): Promise<string> {
  const payload = issuingPayload(params, MAX_LEAF_LIFETIME)
  if (normalizeDID(params.audience) === normalizeDID(params.signer.id)) {
    throw new LeafBindingError('self-issued')
  }
  if (params.parent == null) {
    assertControllerGrant({ ...payload, iss: params.signer.id }, params.controllerID)
  } else {
    // Issuing has no controller prefix; receivers authenticate the embedded parent.
    const parent = readCapability(params.parent)
    if (parent.payload.cap !== undefined) throw new LeafBindingError('chain-depth')
    assertControllerGrant(parent.payload, params.controllerID)
    if (!hasPermission({ act: MLS_LEAF_ACT, res: MLS_LEAF_RES }, parent.payload)) {
      throw new Error('Parent does not grant leaf authentication')
    }
    assertCapabilityLifetime(parent.payload, MAX_TRUSTED_GRANT_LIFETIME)
    if (normalizeDID(parent.payload.aud) !== normalizeDID(params.signer.id)) {
      throw new LeafBindingError('issuer-mismatch')
    }
    const key = capabilityKey(parent.payload)
    if (
      !key.publicKey.every((byte, index) => byte === params.signer.publicKey[index]) ||
      key.publicKey.length !== params.signer.publicKey.length
    ) {
      throw new LeafBindingError('issuer-mismatch')
    }
    if (payload.exp > parent.payload.exp) throw new LeafBindingError('child-outlives-parent')
    if (
      parent.payload.iat > payload.iat ||
      parent.payload.exp < payload.iat ||
      (parent.payload.nbf != null && parent.payload.nbf > payload.iat)
    ) {
      throw new Error('Parent capability is not valid at issuance')
    }
    return stringifyToken(await params.signer.signToken({ ...payload, cap: params.parent }))
  }
  return stringifyToken(await params.signer.signToken(payload))
}

export async function mintTrustedGrant(params: MintTrustedGrantParams): Promise<string> {
  const payload = issuingPayload(params, MAX_TRUSTED_GRANT_LIFETIME)
  assertControllerGrant({ ...payload, iss: params.signer.id }, params.controllerID)
  return stringifyToken(await params.signer.signToken(payload))
}
