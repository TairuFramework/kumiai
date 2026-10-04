import { createIdentity, now } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { parseMLSCredentialIdentity } from '../src/credential.js'
import { createGroup } from '../src/group-create.js'
import {
  createKeyPackageBundle,
  createLastResortKeyPackageBundle,
  makeMLSCredential,
} from '../src/group-credential.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'

const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj))

const validController = {
  id: 'did:kokuin:abc',
  prefix: [{ event: { v: 1, t: 'icp' }, sigs: ['x'] }],
  capability: 'ey.token',
}

describe('parseMLSCredentialIdentity controller', () => {
  test('accepts a well-formed controller binding', () => {
    const parsed = parseMLSCredentialIdentity(
      enc({ id: 'did:key:zDevice', controller: validController }),
    )
    expect(parsed.controller).toEqual(validController)
  })

  test('floating identity has no controller', () => {
    const parsed = parseMLSCredentialIdentity(enc({ id: 'did:key:zDevice' }))
    expect(parsed.controller).toBeUndefined()
  })

  test('rejects a non-object controller', () => {
    expect(() => parseMLSCredentialIdentity(enc({ id: 'did:key:z', controller: 'nope' }))).toThrow()
  })

  test('rejects a controller with a non-string id', () => {
    expect(() =>
      parseMLSCredentialIdentity(
        enc({ id: 'did:key:z', controller: { ...validController, id: 5 } }),
      ),
    ).toThrow()
  })

  test('rejects a controller with a non-string capability', () => {
    expect(() =>
      parseMLSCredentialIdentity(
        enc({ id: 'did:key:z', controller: { ...validController, capability: 5 } }),
      ),
    ).toThrow()
  })

  test('rejects a controller with a non-array prefix', () => {
    expect(() =>
      parseMLSCredentialIdentity(
        enc({ id: 'did:key:z', controller: { ...validController, prefix: {} } }),
      ),
    ).toThrow()
  })
})

test('bound constructors preserve the authenticated controller binding', async () => {
  const leaf = await buildBoundLeaf()
  const identity = await createIdentity({
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(41) }],
    didMethod: 'key',
  })
  const controller = parseMLSCredentialIdentity(leaf.identity).controller
  if (controller == null) throw new Error('fixture has no controller binding')
  const credential = makeMLSCredential(identity, controller)
  expect(
    parseMLSCredentialIdentity((credential as { identity: Uint8Array }).identity).controller,
  ).toEqual(controller)
  for (const construct of [createKeyPackageBundle, createLastResortKeyPackageBundle]) {
    const bundle = await construct(identity, { controller })
    expect(
      parseMLSCredentialIdentity(
        (bundle.publicPackage.leafNode.credential as { identity: Uint8Array }).identity,
      ).controller,
    ).toEqual(controller)
  }
})

test('bound constructors refuse expired and future-issued capabilities', async () => {
  const identity = await createIdentity({
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(41) }],
    didMethod: 'key',
  })
  const timestamp = now()
  for (const capabilityOverrides of [
    { iat: timestamp - 3600, exp: timestamp },
    { iat: timestamp - 3600, exp: timestamp - 1 },
    { iat: timestamp + 600, exp: timestamp + 3600 },
  ]) {
    const leaf = await buildBoundLeaf({ capabilityOverrides })
    const controller = parseMLSCredentialIdentity(leaf.identity).controller
    if (controller == null) throw new Error('fixture has no controller binding')
    await expect(createGroup(identity, 'bad-time', { controller })).rejects.toThrow()
    for (const construct of [createKeyPackageBundle, createLastResortKeyPackageBundle]) {
      await expect(construct(identity, { controller })).rejects.toThrow()
    }
  }
})
