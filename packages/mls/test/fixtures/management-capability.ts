import { audienceConfirmation, createCapability, now } from '@kokuin/capability'
import {
  createControllerIdentity,
  createInception,
  didFromInception,
  type SignedEvent,
} from '@kokuin/controller'
import { stringifyToken } from '@kokuin/token'

export type ManagementCapability = {
  /** Stringified capability token to place in a kumiai.device entry's value.capability. */
  capability: string
  /** The controller (profile) DID that issued it. */
  controllerID: string
  /** The controller log prefix that resolves the profile's signature (embed in the manager leaf). */
  prefix: Array<SignedEvent>
}

export type BuildManagementCapabilityOptions = {
  controllerSeed?: Uint8Array
  profile?: number
  /** The manager device DID the grant is issued to (aud). */
  managerDID: string
  /** The manager device signature public key (cnf pin). */
  managerKey: Uint8Array
  /** Override the payload before signing — used to craft reject cases. */
  capabilityOverrides?: Record<string, unknown>
}

/** Craft a management capability (no minting API in Slice 2 — profile-side, out of scope). */
export async function buildManagementCapability(
  options: BuildManagementCapabilityOptions,
): Promise<ManagementCapability> {
  const controllerSeed = options.controllerSeed ?? new Uint8Array(32).fill(31)
  const profile = options.profile ?? 0
  const inception = createInception(controllerSeed, profile)
  const controllerID = didFromInception(inception.event)
  const controller = createControllerIdentity({ seed: controllerSeed, profile, log: [inception] })

  const token = await createCapability(controller, {
    sub: controllerID,
    aud: options.managerDID,
    act: 'manage',
    res: 'kumiai/devices',
    exp: now() + 3600,
    cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: options.managerKey }),
    ...options.capabilityOverrides,
  })

  return { capability: stringifyToken(token), controllerID, prefix: [inception] }
}
