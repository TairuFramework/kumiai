import { audienceConfirmation, now } from '@kokuin/capability'
import { createRevoke, createRotate, type SignedEvent } from '@kokuin/controller'
import type { Credential } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'
import { describe, expect, test, vi } from 'vitest'

import { createDIDAuthenticationService, verifyLeafCredential } from '../src/authentication.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'
import { leafCapabilityFixture } from './fixtures/leaf-capability.js'

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

  test('rejects a capability whose expiry precedes issuance', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { exp: now() - 10 } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R7: rejects a capability with no exp (device policy)', async () => {
    const leaf = await buildBoundLeaf({ capabilityOverrides: { exp: undefined } })
    expect(await validate(leaf.identity, leaf.deviceKey)).toBe(false)
  })

  test('R7: rejects a capability whose exp is beyond the device policy ceiling (30d > 7d max)', async () => {
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

  test('R12: a throwing deviceDenySet provider fails closed (never throws past the boundary)', async () => {
    const leaf = await buildBoundLeaf()
    const throwingDenySet = () => {
      throw new Error('deny provider exploded')
    }
    await expect(validate(leaf.identity, leaf.deviceKey, throwingDenySet)).resolves.toBe(false)
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

describe('offline leaf credential verification', () => {
  test('rejects foreign self-issuance with a typed reason and at the boolean boundary', async () => {
    const f = await leafCapabilityFixture()
    const token = await f.device.signToken({ ...f.childPayload, cap: undefined })
    const credential = f.credential(`${token.data}.${token.signature}`)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2000000)
    try {
      expect(
        await createDIDAuthenticationService().validateCredential(credential, f.device.publicKey),
      ).toBe(false)
      await expect(verifyLeafCredential(credential, f.device.publicKey)).rejects.toMatchObject({
        name: 'LeafBindingError',
        reason: 'issuer-mismatch',
      })
    } finally {
      clock.mockRestore()
    }
  })

  test('accepts a trusted delegation without resolving the trusted DID', async () => {
    const f = await leafCapabilityFixture()
    resolverCalls.dids.length = 0
    await expect(verifyLeafCredential(f.credential(), f.device.publicKey)).resolves.toBeUndefined()
    expect(
      await createDIDAuthenticationService().validateCredential(f.credential(), f.device.publicKey),
    ).toBe(true)
    expect(resolverCalls.dids.every((did) => did === f.controller.id)).toBe(true)
    expect(resolverCalls.dids.length).toBeGreaterThan(0)
  })

  test.each([
    ['nested parent', { depth: true }, 'chain-depth'],
    ['child outlives parent', { child: { exp: 10001 } }, 'child-outlives-parent'],
    ['wrong subject', { child: { sub: 'did:key:foreign' } }, 'subject-mismatch'],
    ['parent exceeds ceiling', { parent: { exp: 31537001 } }, 'lifetime-cap'],
    ['issuer differs from parent audience', { wrongSigner: true }, 'issuer-mismatch'],
  ] as const)('rejects %s', async (_name, options, reason) => {
    const f = await leafCapabilityFixture(options)
    await expect(verifyLeafCredential(f.credential(), f.device.publicKey)).rejects.toMatchObject({
      reason,
    })
    expect(
      await createDIDAuthenticationService().validateCredential(f.credential(), f.device.publicKey),
    ).toBe(false)
  })

  test('rejects a child addressed to its trusted issuer', async () => {
    const f = await leafCapabilityFixture()
    const token = await f.trusted.signToken({
      ...f.childPayload,
      aud: f.trusted.id,
      cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.trusted.publicKey }),
    })
    await expect(
      verifyLeafCredential(
        f.credential(`${token.data}.${token.signature}`, f.trusted.id),
        f.trusted.publicKey,
      ),
    ).rejects.toMatchObject({ reason: 'self-issued' })
  })

  test('rejects a group-denied trusted issuer', async () => {
    const f = await leafCapabilityFixture()
    const deps = { deviceDenySet: () => new Set([f.trusted.id]) }
    await expect(
      verifyLeafCredential(f.credential(), f.device.publicKey, deps),
    ).rejects.toMatchObject({ reason: 'denied-issuer' })
    expect(
      await createDIDAuthenticationService(deps).validateCredential(
        f.credential(),
        f.device.publicKey,
      ),
    ).toBe(false)
  })

  test('denies floating leaves using the group deny set', async () => {
    const f = await leafCapabilityFixture()
    const credential: Credential = {
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(JSON.stringify({ id: f.device.id })),
    }
    const deps = { deviceDenySet: () => new Set([f.device.id]) }
    await expect(verifyLeafCredential(credential, f.device.publicKey, deps)).rejects.toMatchObject({
      reason: 'denied-id',
    })
    expect(
      await createDIDAuthenticationService(deps).validateCredential(credential, f.device.publicKey),
    ).toBe(false)
  })

  test('receiver clocks cannot change direct or delegated verdicts', async () => {
    const f = await leafCapabilityFixture()
    const direct = await f.controller.signToken({ ...f.childPayload, cap: undefined })
    const credentials = [f.credential(), f.credential(`${direct.data}.${direct.signature}`)]
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(0)
      const a = await Promise.all(
        credentials.map((credential) =>
          createDIDAuthenticationService().validateCredential(credential, f.device.publicKey),
        ),
      )
      clock.mockReturnValue(100000000)
      const b = await Promise.all(
        credentials.map((credential) =>
          createDIDAuthenticationService().validateCredential(credential, f.device.publicKey),
        ),
      )
      expect(a).toEqual([true, true])
      expect(a).toEqual(b)
      clock.mockImplementation(() => {
        throw new Error('verification read the clock')
      })
      for (const credential of credentials)
        await expect(verifyLeafCredential(credential, f.device.publicKey)).resolves.toBeUndefined()
    } finally {
      clock.mockRestore()
    }
  })

  test.each([
    { iat: undefined },
    { exp: undefined },
    { exp: 2000 },
    { cnf: null },
    { cnf: { kid: 'bad-key' } },
    { cnf: { jku: 'https://example.com/key' } },
    { cnf: { kid: 'bad-key', jwk: {} } },
    { nbf: 2001 },
  ])('fails closed on malformed child claims %j', async (child) => {
    const f = await leafCapabilityFixture({ child })
    expect(
      await createDIDAuthenticationService().validateCredential(f.credential(), f.device.publicKey),
    ).toBe(false)
    await expect(verifyLeafCredential(f.credential(), f.device.publicKey)).rejects.toBeInstanceOf(
      Error,
    )
  })

  test.each(['iat', 'exp', 'nbf'])('fails closed on non-finite wire %s', async (claim) => {
    const f = await leafCapabilityFixture()
    for (const value of ['1e400', '-1e400', 'null']) {
      const payload = JSON.stringify({
        ...f.childPayload,
        iss: f.trusted.id,
        [claim]: '__invalid__',
      }).replace('"__invalid__"', value)
      const credential = f.credential(f.rawChild(payload))
      expect(
        await createDIDAuthenticationService().validateCredential(credential, f.device.publicKey),
      ).toBe(false)
      await expect(verifyLeafCredential(credential, f.device.publicKey)).rejects.toBeInstanceOf(
        Error,
      )
    }
  })

  test('reads lifetime providers for each verdict', async () => {
    const f = await leafCapabilityFixture()
    let leafLifetime = 1000
    let trustedGrantLifetime = 9000
    const deps = {
      leafLifetime: () => leafLifetime,
      trustedGrantLifetime: () => trustedGrantLifetime,
    }
    const service = createDIDAuthenticationService(deps)
    expect(await service.validateCredential(f.credential(), f.device.publicKey)).toBe(true)
    leafLifetime = 999
    await expect(
      verifyLeafCredential(f.credential(), f.device.publicKey, deps),
    ).rejects.toMatchObject({ reason: 'lifetime-cap' })
    expect(await service.validateCredential(f.credential(), f.device.publicKey)).toBe(false)
    leafLifetime = 1000
    trustedGrantLifetime = 8999
    await expect(
      verifyLeafCredential(f.credential(), f.device.publicKey, deps),
    ).rejects.toMatchObject({ reason: 'lifetime-cap' })
  })
})

test('rejects a forged signature claiming the trusted issuer', async () => {
  const f = await leafCapabilityFixture()
  const raw = f.rawChild(
    JSON.stringify({ ...f.childPayload, iss: f.trusted.id }),
    new Uint8Array(32).fill(41),
  )
  await expect(verifyLeafCredential(f.credential(raw), f.device.publicKey)).rejects.toThrow(
    'Invalid capability signature',
  )
  expect(
    await createDIDAuthenticationService().validateCredential(
      f.credential(raw),
      f.device.publicKey,
    ),
  ).toBe(false)
})

test('authenticates the parent even when the child issuer equals the subject', async () => {
  const f = await leafCapabilityFixture()
  const parent = f.rawChild(
    JSON.stringify({
      iss: f.controller.id,
      sub: f.controller.id,
      aud: f.controller.id,
      act: 'authenticate',
      res: 'kumiai/mls-leaf',
      iat: 1000,
      exp: 10000,
      cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.trusted.publicKey }),
    }),
  )
  const raw = f.rawChild(JSON.stringify({ ...f.childPayload, iss: f.controller.id, cap: parent }))
  expect(
    await createDIDAuthenticationService().validateCredential(
      f.credential(raw),
      f.device.publicKey,
    ),
  ).toBe(false)
  await expect(verifyLeafCredential(f.credential(raw), f.device.publicKey)).rejects.toBeInstanceOf(
    Error,
  )
})

test.each([
  { iat: undefined },
  { exp: undefined },
  { exp: 1000 },
  { iat: 2001 },
  { nbf: 2001 },
  { sub: 'did:key:foreign' },
  { cnf: { kid: 'bad-key' } },
  { act: 'manage', res: 'kumiai/devices' },
])('refuses malformed or inapplicable parent claims %j', async (parent) => {
  const f = await leafCapabilityFixture({ parent })
  expect(
    await createDIDAuthenticationService().validateCredential(f.credential(), f.device.publicKey),
  ).toBe(false)
})

test('the embedded controller head cannot deny a trusted issuer on its own', async () => {
  const f = await leafCapabilityFixture()
  const revoke = createRevoke({
    seed: new Uint8Array(32).fill(31),
    profile: 0,
    did: f.controller.id,
    prior: f.inception.event,
    target: f.trusted.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const credential = f.credential()
  const parsed = JSON.parse(
    new TextDecoder().decode((credential as { identity: Uint8Array }).identity),
  )
  parsed.controller.prefix.push(revoke)
  const extended: Credential = {
    credentialType: defaultCredentialTypes.basic,
    identity: new TextEncoder().encode(JSON.stringify(parsed)),
  }
  await expect(verifyLeafCredential(extended, f.device.publicKey)).resolves.toBeUndefined()
  await expect(
    verifyLeafCredential(extended, f.device.publicKey, {
      deviceDenySet: () => new Set([f.trusted.id]),
    }),
  ).rejects.toMatchObject({ reason: 'denied-issuer' })
})

test('verifies direct and delegated grants under a rotated historical authority key', async () => {
  const f = await leafCapabilityFixture()
  const rotate = createRotate({
    seed: new Uint8Array(32).fill(31),
    profile: 0,
    did: f.controller.id,
    prior: f.inception.event,
  })
  const direct = await f.controller.signToken({ ...f.childPayload, cap: undefined })
  for (const original of [f.credential(), f.credential(`${direct.data}.${direct.signature}`)]) {
    const parsed = JSON.parse(
      new TextDecoder().decode((original as { identity: Uint8Array }).identity),
    )
    parsed.controller.prefix.push(rotate)
    const credential: Credential = {
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(JSON.stringify(parsed)),
    }
    await expect(verifyLeafCredential(credential, f.device.publicKey)).resolves.toBeUndefined()
  }
})
