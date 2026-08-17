import { audienceConfirmation, now } from '@kokuin/capability'
import type { Credential } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { createDIDAuthenticationService } from '../src/authentication.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'

const credentialOf = (identity: Uint8Array): Credential =>
  ({ credentialType: defaultCredentialTypes.basic, identity }) as Credential

const validate = (identity: Uint8Array, key: Uint8Array, denySet?: () => ReadonlySet<string>) =>
  createDIDAuthenticationService(
    denySet ? { deviceDenySet: denySet } : undefined,
  ).validateCredential(credentialOf(identity), key)

describe('validateCredential — bound did:kokuin leaf', () => {
  test('A1: accepts a valid bound leaf', async () => {
    const leaf = await buildBoundLeaf()
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(true)
  })

  test('R1: rejects a controller.id that is not did:kokuin', async () => {
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({ ...id, controller: { ...b, id: 'did:web:evil.example' } }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R2: rejects a prefix whose inception hashes to another profile', async () => {
    const other = await buildBoundLeaf({ controllerSeed: new Uint8Array(32).fill(99) })
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({
        ...id,
        controller: {
          ...b,
          prefix: JSON.parse(new TextDecoder().decode(other.identity)).controller.prefix,
        },
      }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R3: rejects a tampered capability signature', async () => {
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({ ...id, controller: { ...b, capability: `${b.capability}x` } }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R4: rejects a capability whose aud is another device', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { aud: 'did:key:zSomeoneElse' } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R5: rejects a capability lacking the mls-leaf grant', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { act: 'read', res: 'other' } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R6: rejects an expired capability', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { exp: now() - 10 } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R7: rejects a capability with no exp (device policy)', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { exp: undefined } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R8: rejects when cnf pins a different key', async () => {
    const leaf = await buildBoundLeaf({
      capabilityOverrides: {
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: new Uint8Array(32).fill(1) }),
      },
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R9: rejects when the leaf key differs from the device id key', async () => {
    const leaf = await buildBoundLeaf()
    expect(await validate(leaf.identity, new Uint8Array(32).fill(2))).toBe(false)
  })

  test('R11: rejects when the deny set contains the device id', async () => {
    const leaf = await buildBoundLeaf()
    const denySet = () => new Set([leaf.deviceID])
    expect(await validate(leaf.identity, leaf.deviceKey, denySet)).toBe(false)
  })
})
