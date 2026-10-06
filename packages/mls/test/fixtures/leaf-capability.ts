import { audienceConfirmation } from '@kokuin/capability'
import { createControllerIdentity, createInception } from '@kokuin/controller'
import { createSigningIdentity, stringifyToken } from '@kokuin/token'
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64uFromJSON, fromUTF, toB64U } from '@sozai/codec'
import type { Credential } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'

export type LeafCapabilityFixtureOptions = {
  child?: Record<string, unknown>
  parent?: Record<string, unknown>
  wrongSigner?: boolean
  depth?: boolean
}

export async function leafCapabilityFixture(options: LeafCapabilityFixtureOptions = {}) {
  const seed = new Uint8Array(32).fill(31)
  const inception = createInception(seed, 0)
  const controller = createControllerIdentity({ seed, profile: 0, log: [inception] })
  const trustedSeed = new Uint8Array(32).fill(61)
  const trusted = createSigningIdentity(trustedSeed)
  const device = createSigningIdentity(new Uint8Array(32).fill(41))
  const parentPayload = {
    sub: controller.id,
    aud: trusted.id,
    act: 'authenticate',
    res: 'kumiai/mls-leaf',
    cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: trusted.publicKey }),
    iat: 1000,
    nbf: 1000,
    exp: 10000,
    ...options.parent,
    ...(options.depth ? { cap: 'extra-parent' } : {}),
  }
  const parent = stringifyToken(await controller.signToken(parentPayload))
  const childPayload = {
    sub: controller.id,
    aud: device.id,
    act: 'authenticate',
    res: 'kumiai/mls-leaf',
    cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: device.publicKey }),
    iat: 2000,
    nbf: 2000,
    exp: 3000,
    cap: parent,
    ...options.child,
  }
  const signer = options.wrongSigner ? device : trusted
  const token = stringifyToken(await signer.signToken(childPayload))
  const credential = (capability = token, id: string = device.id): Credential => ({
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode(
      JSON.stringify({
        id,
        controller: { id: controller.id, prefix: [inception], capability },
      }),
    ),
  })
  const rawChild = (claims: string, signingSeed = trustedSeed) => {
    const header = b64uFromJSON({ typ: 'JWT', alg: 'EdDSA' })
    const payload = toB64U(fromUTF(claims))
    const data = `${header}.${payload}`
    return `${data}.${toB64U(ed25519.sign(fromUTF(data), signingSeed))}`
  }
  return { controller, trusted, device, parent, credential, childPayload, rawChild, inception }
}
