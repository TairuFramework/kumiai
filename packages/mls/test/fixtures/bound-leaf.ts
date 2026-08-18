import { audienceConfirmation, createCapability, now } from '@kokuin/capability'
import { createControllerIdentity, createInception, didFromInception } from '@kokuin/controller'
import { createIdentity, createSigningIdentity, stringifyToken } from '@kokuin/token'

import type { ControllerBinding, MLSCredentialIdentity } from '../../src/credential.js'

export type BoundLeaf = {
  /** JSON-encoded MLSCredentialIdentity bytes, ready for a Credential.identity field. */
  identity: Uint8Array
  /** The device's signing public key = the MLS leaf key to pass as signaturePublicKey. */
  deviceKey: Uint8Array
  /** The device DID (did:key, or did:peer:4 short form when deviceMethod is 'peer:4'). */
  deviceID: string
  /** The controller (profile) DID. */
  controllerID: string
}

export type BuildBoundLeafOptions = {
  controllerSeed?: Uint8Array
  deviceSeed?: Uint8Array
  profile?: number
  /** 'key' (default) builds a did:key device; 'peer:4' builds a did:peer:4 device with longForm. */
  deviceMethod?: 'key' | 'peer:4'
  /** Override the assembled MLSCredentialIdentity before encoding — used to craft reject cases. */
  mutate?: (identity: MLSCredentialIdentity, binding: ControllerBinding) => MLSCredentialIdentity
  /** Override the capability payload before signing — used to craft reject cases. */
  capabilityOverrides?: Record<string, unknown>
}

type DeviceIdentity = { id: string; longForm?: string; publicKey: Uint8Array }

/** did:key (default) or did:peer:4 (longForm carries the doc) — mirrors the floating peer4 fixtures. */
async function buildDevice(
  deviceSeed: Uint8Array,
  method: 'key' | 'peer:4',
): Promise<DeviceIdentity> {
  if (method === 'key') {
    const signing = createSigningIdentity(deviceSeed)
    return { id: signing.id, publicKey: signing.publicKey }
  }
  const identity = await createIdentity({
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: deviceSeed }],
    didMethod: 'peer:4',
  })
  return { id: identity.id, longForm: identity.longForm, publicKey: identity.publicKey }
}

/**
 * Craft a bound-leaf identity from controller + capability primitives (no minting API exists in
 * Slice 1). A valid leaf by default; `mutate`/`capabilityOverrides` corrupt exactly one thing.
 */
export async function buildBoundLeaf(options: BuildBoundLeafOptions = {}): Promise<BoundLeaf> {
  const controllerSeed = options.controllerSeed ?? new Uint8Array(32).fill(31)
  const deviceSeed = options.deviceSeed ?? new Uint8Array(32).fill(41)
  const profile = options.profile ?? 0

  const inception = createInception(controllerSeed, profile)
  const controllerID = didFromInception(inception.event)
  const controller = createControllerIdentity({ seed: controllerSeed, profile, log: [inception] })
  const device = await buildDevice(deviceSeed, options.deviceMethod ?? 'key')

  const capabilityToken = await createCapability(controller, {
    sub: controllerID,
    aud: device.id,
    act: 'authenticate',
    res: 'kumiai/mls-leaf',
    exp: now() + 3600,
    cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: device.publicKey }),
    ...options.capabilityOverrides,
  })

  const binding: ControllerBinding = {
    id: controllerID,
    prefix: [inception],
    capability: stringifyToken(capabilityToken),
  }
  let identity: MLSCredentialIdentity = {
    id: device.id,
    ...(device.longForm != null ? { longForm: device.longForm } : {}),
    controller: binding,
  }
  if (options.mutate) identity = options.mutate(identity, binding)

  return {
    identity: new TextEncoder().encode(JSON.stringify(identity)),
    deviceKey: device.publicKey,
    deviceID: device.id,
    controllerID,
  }
}
