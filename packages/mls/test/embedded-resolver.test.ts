import { createInception, didFromInception } from '@kokuin/controller'
import { describe, expect, test } from 'vitest'

import { createEmbeddedControllerResolver } from '../src/embedded-resolver.js'

const seed = new Uint8Array(32).fill(7)
const inception = createInception(seed, 0)
const did = didFromInception(inception.event)

describe('createEmbeddedControllerResolver', () => {
  test('resolves the controller signing key from the embedded prefix', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    const resolved = await resolver.resolve(did, {})
    expect(resolved.alg).toBe('EdDSA')
    expect(resolved.publicKey).toBeInstanceOf(Uint8Array)
  })

  test.each(['resolveMember', 'frozen'])('does not expose %s', (method) => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    expect(method in resolver).toBe(false)
  })

  test('returns the injected deny set', async () => {
    const denySet = new Set(['did:key:zDenied'])
    const resolver = createEmbeddedControllerResolver({
      controllerID: did,
      prefix: [inception],
      denySet,
    })
    expect(await resolver.resolveDenySet?.(did)).toBe(denySet)
  })

  test('empty deny set by default', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    expect((await resolver.resolveDenySet?.(did))?.size).toBe(0)
  })

  test('unknown DID never reaches an external source (loadLog returns undefined → Unknown DID)', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    await expect(resolver.resolve('did:kokuin:someoneElse', {})).rejects.toThrow(/Unknown DID/)
  })

  // Historical authority keys must remain available for grants issued before rotation.
  test('still forwards resolveHistoric from the base controller resolver', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    expect(typeof resolver.resolveHistoric).toBe('function')
    const resolved = await resolver.resolveHistoric?.(did, {})
    expect(resolved?.alg).toBe('EdDSA')
    expect(resolved?.publicKey).toBeInstanceOf(Uint8Array)
  })
})
