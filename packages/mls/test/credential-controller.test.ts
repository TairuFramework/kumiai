import { describe, expect, test } from 'vitest'

import { parseMLSCredentialIdentity } from '../src/credential.js'

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
