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

  // Slice 1 regression guard: the embedded resolver spreads the base controller resolver and
  // overrides ONLY resolveDenySet — resolveHistoric must still be forwarded verbatim, or a
  // `historic: true` verifyToken call (management-capability verification) would silently start
  // asking the wrong question.
  test('still forwards resolveHistoric from the base controller resolver', async () => {
    const resolver = createEmbeddedControllerResolver({ controllerID: did, prefix: [inception] })
    expect(typeof resolver.resolveHistoric).toBe('function')
    const resolved = await resolver.resolveHistoric?.(did, {})
    expect(resolved?.alg).toBe('EdDSA')
    expect(resolved?.publicKey).toBeInstanceOf(Uint8Array)
  })
})
