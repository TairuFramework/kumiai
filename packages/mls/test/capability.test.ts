import { audienceConfirmation } from '@kokuin/capability'
import { createIdentity } from '@kokuin/token'
import { b64uToJSON } from '@sozai/codec'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import * as mls from '../src/index.js'
import { leafCapabilityFixture } from './fixtures/leaf-capability.js'

const payloadOf = (token: string): Record<string, unknown> => {
  const payload = token.split('.')[1]
  if (payload == null) throw new Error('missing payload')
  return b64uToJSON(payload)
}

afterEach(() => vi.restoreAllMocks())

describe('capability issuing', () => {
  test('mints a direct leaf at the seven-day ceiling with the required pins', async () => {
    const f = await leafCapabilityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    const token = await mls.mintLeafCapability({
      signer: f.controller,
      controllerID: f.controller.id,
      audience: f.device.id,
      leafKey: f.device.publicKey,
      exp: 606800,
    })
    expect(payloadOf(token)).toMatchObject({
      iss: f.controller.id,
      sub: f.controller.id,
      aud: f.device.id,
      iat: 2000,
      exp: 606800,
      act: 'authenticate',
      res: 'kumiai/mls-leaf',
      cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.device.publicKey }),
    })
    expect(payloadOf(token).cap).toBeUndefined()
    await expect(
      verifyLeafCredential(f.credential(token), f.device.publicKey),
    ).resolves.toBeUndefined()
  })

  test('mints a trusted grant at the 365-day ceiling', async () => {
    const f = await leafCapabilityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    const parent = await mls.mintTrustedGrant({
      signer: f.controller,
      controllerID: f.controller.id,
      audience: f.trusted.id,
      leafKey: f.trusted.publicKey,
      exp: 31538000,
    })
    expect(payloadOf(parent)).toMatchObject({
      iss: f.controller.id,
      sub: f.controller.id,
      aud: f.trusted.id,
      iat: 2000,
      exp: 31538000,
      act: 'authenticate',
      res: 'kumiai/mls-leaf',
      cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.trusted.publicKey }),
    })
    expect(payloadOf(parent).cap).toBeUndefined()
  })

  test('mints a child at its parent expiry and embeds the parent', async () => {
    const f = await leafCapabilityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    const token = await mls.mintLeafCapability({
      signer: f.trusted,
      controllerID: f.controller.id,
      audience: f.device.id,
      leafKey: f.device.publicKey,
      exp: 10000,
      parent: f.parent,
    })
    expect(payloadOf(token)).toMatchObject({
      iss: f.trusted.id,
      sub: f.controller.id,
      aud: f.device.id,
      iat: 2000,
      exp: 10000,
      cap: f.parent,
    })
    await expect(
      verifyLeafCredential(f.credential(token), f.device.publicKey),
    ).resolves.toBeUndefined()
  })

  test.each([
    ['leaf', 606801],
    ['trusted', 31538001],
    ['leaf', 2000],
    ['trusted', 2000],
    ['leaf', Number.NaN],
    ['trusted', Number.NaN],
    ['leaf', Number.POSITIVE_INFINITY],
    ['trusted', Number.POSITIVE_INFINITY],
    ['leaf', Number.NEGATIVE_INFINITY],
    ['leaf', 1999],
  ] as const)('refuses invalid %s expiry %s', async (kind, exp) => {
    const f = await leafCapabilityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    const mint = kind === 'leaf' ? mls.mintLeafCapability : mls.mintTrustedGrant
    await expect(
      mint({
        signer: f.controller,
        controllerID: f.controller.id,
        audience: f.device.id,
        leafKey: f.device.publicKey,
        exp,
      }),
    ).rejects.toMatchObject({
      name: 'LeafBindingError',
      reason: 'lifetime-cap',
    })
  })

  test('refuses self-audience and child expiry beyond its parent', async () => {
    const f = await leafCapabilityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    const params = {
      signer: f.trusted,
      controllerID: f.controller.id,
      audience: f.device.id,
      leafKey: f.device.publicKey,
      exp: 10000,
      parent: f.parent,
    }
    await expect(
      mls.mintLeafCapability({ ...params, audience: f.trusted.id }),
    ).rejects.toMatchObject({ reason: 'self-issued' })
    await expect(mls.mintLeafCapability({ ...params, exp: 10001 })).rejects.toMatchObject({
      reason: 'child-outlives-parent',
    })
  })

  test('requires a controller signer for a direct grant', async () => {
    const f = await leafCapabilityFixture()
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    const params = {
      signer: f.trusted,
      controllerID: f.controller.id,
      audience: f.device.id,
      leafKey: f.device.publicKey,
      exp: 3000,
    }
    await expect(mls.mintLeafCapability(params)).rejects.toMatchObject({
      reason: 'issuer-mismatch',
    })
    await expect(mls.mintTrustedGrant(params)).rejects.toMatchObject({ reason: 'issuer-mismatch' })
  })

  test.each([
    { iat: undefined },
    { exp: undefined },
    { exp: 2000 },
    { iat: 2001 },
    { nbf: 2001 },
    { sub: 'did:key:foreign' },
    { aud: 'did:key:foreign' },
    { cnf: { kid: 'bad-key' } },
    { act: 'manage', res: 'kumiai/devices' },
    { cap: 'extra-parent' },
  ])('refuses an unsuitable parent %j', async (parent) => {
    const f = await leafCapabilityFixture({ parent })
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    await expect(
      mls.mintLeafCapability({
        signer: f.trusted,
        controllerID: f.controller.id,
        audience: f.device.id,
        leafKey: f.device.publicKey,
        exp: 3000,
        parent: f.parent,
      }),
    ).rejects.toBeInstanceOf(Error)
  })

  test('supports a trusted peer identity without resolving its DID', async () => {
    const f = await leafCapabilityFixture()
    const trusted = await createIdentity({
      didMethod: 'peer:4',
      keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(91) }],
    })
    vi.spyOn(Date, 'now').mockReturnValue(2000000)
    const parent = await mls.mintTrustedGrant({
      signer: f.controller,
      controllerID: f.controller.id,
      audience: trusted.id,
      leafKey: trusted.publicKey,
      exp: 10000,
    })
    for (let i = 0; i < 2; i++) {
      const token = await mls.mintLeafCapability({
        signer: trusted,
        controllerID: f.controller.id,
        audience: f.device.id,
        leafKey: f.device.publicKey,
        exp: 3000,
        parent,
      })
      await expect(
        verifyLeafCredential(f.credential(token), f.device.publicKey),
      ).resolves.toBeUndefined()
    }
  })
})
