import { audienceConfirmation, now } from '@kokuin/capability'
import type { SignedEvent } from '@kokuin/controller'
import type { Credential } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'
import { describe, expect, test, vi } from 'vitest'

import { createDIDAuthenticationService } from '../src/authentication.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'

// Captures every DID the embedded resolver's loadLog is ever called with, across the whole file —
// the zero-sidecar test below resets it and asserts the only DID ever loaded is the embedded
// controller. `...actual` keeps every other export (createControllerIdentity, createInception, ...,
// used by the fixture) untouched; only `createControllerResolver`'s `loadLog` is wrapped.
const resolverCalls = vi.hoisted(() => ({ dids: [] as Array<string> }))
vi.mock('@kokuin/controller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kokuin/controller')>()
  return {
    ...actual,
    createControllerResolver: (
      resolverOptions: Parameters<typeof actual.createControllerResolver>[0],
    ) =>
      actual.createControllerResolver({
        ...resolverOptions,
        loadLog: async (did: string) => {
          resolverCalls.dids.push(did)
          return resolverOptions.loadLog(did)
        },
      }),
  }
})

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

  test('A2: accepts a valid bound leaf, did:peer:4 device with longForm', async () => {
    const leaf = await buildBoundLeaf({ deviceMethod: 'peer:4' })
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

  test('R7: rejects a capability whose exp is beyond the device policy ceiling (30d > 7d max)', async () => {
    // Far-future exp is NOT expired, so verifyToken's own time check (step 4) does not catch this —
    // only assertDeviceCapabilityPolicy's lifetime ceiling (step 8) does.
    const leaf = await buildBoundLeaf({
      capabilityOverrides: { exp: now() + 30 * 24 * 60 * 60 },
    })
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

  test('R10: rejects a prefix the sync fold cannot fold (authority-only violated)', async () => {
    const leaf = await buildBoundLeaf({
      mutate: (id, b) => ({
        ...id,
        // A second, malformed event the fold refuses — stands in for a cap-authorised revoke, which
        // the sync foldLog also refuses (CAPABILITY_REVOKE_NEEDS_ASYNC_FOLD).
        controller: {
          ...b,
          prefix: [
            ...b.prefix,
            // Malformed on purpose — a SignedEvent the fold refuses, not a well-typed one.
            { event: { v: 1, t: 'rev', crit: true }, sigs: [] } as unknown as SignedEvent,
          ],
        },
      }),
    })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('validation never queries a DID other than the embedded controller (zero-sidecar)', async () => {
    // Distinguishes "embedded-only" from "would-be-external": a spy wraps createControllerResolver's
    // loadLog at the exact seam createEmbeddedControllerResolver uses, recording every DID it is ever
    // invoked with. If validation reached outside the embedded prefix for anything — a second
    // resolve, a cache warm, a rotated-issuer lookup — it would show up here. It doesn't: the log is
    // proof the boundary holds, not an inference from the absence of a network in this test run.
    resolverCalls.dids.length = 0
    const leaf = await buildBoundLeaf()
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(true)
    expect(resolverCalls.dids).toEqual([leaf.controllerID])
  })
})
