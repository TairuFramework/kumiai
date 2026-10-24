import { audienceConfirmation, now } from '@kokuin/capability'
import {
  createAdd,
  createRemove,
  createRotate,
  digestOf,
  EPOCH_SATURATED,
  encodeKey,
  epochHeads,
  foldLog,
  type SignedEvent,
  snapshotOf,
} from '@kokuin/controller'
import { stringifyToken } from '@kokuin/token'
import type { Credential } from 'ts-mls'
import { defaultCredentialTypes, nodeTypes } from 'ts-mls'
import { describe, expect, test, vi } from 'vitest'

import {
  createDIDAuthenticationService,
  type JudgingContext,
  verifyLeafCredential,
} from '../src/authentication.js'
import { LeafBindingError } from '../src/errors.js'
import { deviceDenyHolderFor } from '../src/group-context.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { rejectionReason, validateEntry } from '../src/lifecycle.js'
import {
  cascadeOf,
  claimsFor,
  effectiveAuthorityOf,
  effectOf,
  memberRootStatus,
} from '../src/member-root.js'
import { type ControllerProjection, registryForLog, registrySeed } from '../src/registry.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'
import { revokeChain, rotateChain } from './fixtures/controller-chain.js'
import { buildEpoch, saturatedLog } from './fixtures/controller-epoch.js'
import { leafCapabilityFixture } from './fixtures/leaf-capability.js'
import { agent, pipelineGroup, rawBundle } from './fixtures/lifecycle-pipeline.js'

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
        // Chain revokes fail closed, including malformed unsigned ones.
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
    // loadLog at the exact seam createRegistryControllerResolver uses, recording every DID it is ever
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

  test('refuses a member-issued grant without a lifecycle judging context', async () => {
    const f = await leafCapabilityFixture()
    const initial = foldLog(f.controller.id, { chain: [f.inception], events: [] })
    if (!initial.ok) throw new Error(initial.reason)
    const add = createAdd({
      seed: new Uint8Array(32).fill(31),
      profile: 0,
      did: f.controller.id,
      head: initial.head,
      parents: [initial.head.epoch],
      member: { did: f.trusted.id, key: encodeKey(f.trusted.publicKey, 'EdDSA'), lease: 10000 },
    })
    const epoch = foldLog(f.controller.id, { chain: [f.inception], events: [add] })
    if (!epoch.ok) throw new Error(epoch.reason)
    const rotate = createRotate({
      seed: new Uint8Array(32).fill(31),
      profile: 0,
      did: f.controller.id,
      prior: f.inception.event,
      snapshot: snapshotOf(epoch.head),
    })
    const prefix = [f.inception, rotate]
    const folded = foldLog(f.controller.id, { chain: prefix, events: [] })
    if (!folded.ok) throw new Error(folded.reason)
    expect(rotate.event.m).toEqual([
      {
        did: f.trusted.id,
        key: encodeKey(f.trusted.publicKey, 'EdDSA'),
        add: digestOf(add.event),
        lease: 10000,
      },
    ])
    expect(folded.head.members.get(digestOf(add.event))?.effective).toBe(true)
    const capability = stringifyToken(
      await f.trusted.signToken({
        ...f.childPayload,
        cap: undefined,
        mbr: { add: digestOf(add.event), g: folded.head.gen },
      }),
    )
    const original = f.credential(capability)
    const parsed = JSON.parse(
      new TextDecoder().decode((original as { identity: Uint8Array }).identity),
    )
    parsed.controller.prefix = prefix
    const credential: Credential = {
      credentialType: defaultCredentialTypes.basic,
      identity: new TextEncoder().encode(JSON.stringify(parsed)),
    }
    const error = await verifyLeafCredential(credential, f.device.publicKey).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(LeafBindingError)
    expect(error).toMatchObject({ reason: 'controller-mismatch' })
    expect(
      await createDIDAuthenticationService().validateCredential(credential, f.device.publicKey),
    ).toBe(false)
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
    const credentials = [
      f.credential(),
      makeMLSCredential(agent(41), {
        id: f.controller.id,
        prefix: [f.inception],
        capability: stringifyToken(direct),
      }),
    ]
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
  await expect(verifyLeafCredential(f.credential(raw), f.device.publicKey)).rejects.toMatchObject({
    reason: 'signature-invalid',
  })
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
  const revoke = revokeChain({
    seed: new Uint8Array(32).fill(31),
    profile: 0,
    did: f.controller.id,
    chain: [f.inception],
    subject: f.trusted.id,
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
  const rotate = rotateChain({
    seed: new Uint8Array(32).fill(31),
    profile: 0,
    did: f.controller.id,
    chain: [f.inception],
  })
  const direct = await f.controller.signToken({ ...f.childPayload, cap: undefined })
  for (const original of [
    f.credential(),
    makeMLSCredential(agent(41), {
      id: f.controller.id,
      prefix: [f.inception],
      capability: stringifyToken(direct),
    }),
  ]) {
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

test.each([{ act: 'manage' }, { aud: 'did:key:wrong-audience' }, { cnf: { kid: 'invalid' } }])(
  'capability entry failures require a new binding: %j',
  async (child) => {
    const fixture = await leafCapabilityFixture({ child })
    const { rejectionReason } = await import('../src/lifecycle.js')
    const error = await verifyLeafCredential(fixture.credential(), fixture.device.publicKey).catch(
      (error: unknown) => error,
    )
    expect(rejectionReason(error)).toBe('binding')
  },
)

test('a bad capability signature requires a new binding', async () => {
  const fixture = await leafCapabilityFixture()
  const corrupted = fixture.rawChild(
    JSON.stringify({ ...fixture.childPayload, iss: fixture.trusted.id }),
    new Uint8Array(32).fill(41),
  )
  const { rejectionReason } = await import('../src/lifecycle.js')
  const error = await verifyLeafCredential(
    fixture.credential(corrupted),
    fixture.device.publicKey,
  ).catch((error: unknown) => error)
  expect(rejectionReason(error)).toBe('binding')
})

async function memberLeafFixture() {
  const epoch = await buildEpoch({ members: 2, renewEvery: 4_000_000 })
  const [member, other] = epoch.members
  if (member == null || other == null) throw new Error('Missing members')
  const f = await leafCapabilityFixture()
  const payload = {
    ...f.childPayload,
    sub: epoch.did,
    cap: undefined,
    iat: 100,
    nbf: 100,
    exp: 200,
    mbr: { add: member.add, g: epoch.head.gen },
  }
  const capability = stringifyToken(
    await member.identity.signToken(payload, { embedLongForm: true }),
  )
  const binding = { id: epoch.did, prefix: epoch.log.chain, capability }
  const credential = makeMLSCredential(agent(41), binding)
  const registry = registryForLog(epoch.did, epoch.log)
  const removedLog = {
    chain: epoch.log.chain,
    events: [
      ...epoch.log.events,
      createRemove({
        did: epoch.did,
        head: epoch.head,
        parents: epochHeads(epoch.did, epoch.log),
        signer: { member: other },
        add: member.add,
      }),
    ],
  }
  const removed = registryForLog(epoch.did, removedLog)
  const judging: JudgingContext = { registry, stage: 'full', mode: 'admit' }
  const verify = (context: JudgingContext = judging, raw = capability) =>
    verifyLeafCredential(
      makeMLSCredential(agent(41), { ...binding, capability: raw }),
      f.device.publicKey,
      {
        judging: () => context,
      },
    )
  return {
    ...epoch,
    member,
    other,
    f,
    payload,
    capability,
    binding,
    credential,
    registry,
    removed,
    judging,
    verify,
  }
}

test('direct mbr leaf capability authenticates', async () => {
  const f = await memberLeafFixture()
  await expect(f.verify()).resolves.toBeUndefined()
  expect(
    await createDIDAuthenticationService({ judging: () => f.judging }).validateCredential(
      f.credential,
      f.f.device.publicKey,
    ),
  ).toBe(true)
})

test('direct mbr leaf refused when the issuer is not an effective member', async () => {
  const f = await memberLeafFixture()
  await expect(f.verify({ ...f.judging, registry: f.removed })).rejects.toMatchObject({
    reason: 'member-removed',
  })
})

test('mbr grant past the lease is refused', async () => {
  const f = await memberLeafFixture()
  const capability = stringifyToken(
    await f.member.identity.signToken(
      { ...f.payload, iat: 3_999_900, nbf: 3_999_900, exp: 4_000_001 },
      { embedLongForm: true },
    ),
  )
  await expect(f.verify(f.judging, capability)).rejects.toMatchObject({
    reason: 'signature-invalid',
    cause: expect.objectContaining({
      message: expect.stringContaining('expires after the issuer'),
    }),
  })
})

test('admission refuses a removed member root whose own evidence still verifies', async () => {
  const f = await memberLeafFixture()
  const holderGrant = stringifyToken(
    await f.f.controller.signToken({ ...f.payload, mbr: undefined }),
  )
  const parent = stringifyToken(
    await f.member.identity.signToken(
      {
        ...f.payload,
        aud: f.f.trusted.id,
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.f.trusted.publicKey }),
        exp: 1000,
      },
      { embedLongForm: true },
    ),
  )
  const capability = stringifyToken(
    await f.f.trusted.signToken({ ...f.payload, mbr: undefined, cap: parent }),
  )
  const credential = makeMLSCredential(agent(41), { ...f.binding, capability, holderGrant })
  const root = { kind: 'member' as const, did: f.member.did, add: f.member.add, gen: 0 }
  expect(memberRootStatus(f.removed, f.did, root)).toEqual({ status: 'removed' })
  expect(
    f.removed.controllers.get(f.did)?.recordedLog?.events.some(({ event }) => event.t === 'rmv'),
  ).toBe(true)
  for (const mode of ['retain', 'rejudge'] as const) {
    await expect(
      verifyLeafCredential(credential, f.f.device.publicKey, {
        judging: () => ({ registry: f.removed, stage: 'full', mode }),
      }),
    ).resolves.toBeUndefined()
  }
  await expect(
    verifyLeafCredential(credential, f.f.device.publicKey, {
      judging: () => ({ registry: f.removed, stage: 'full', mode: 'admit' }),
    }),
  ).rejects.toMatchObject({ reason: 'member-removed' })
})

test('admit refuses on an unavailable registry', async () => {
  const f = await memberLeafFixture()
  await expect(f.verify({ ...f.judging, registry: registrySeed() })).rejects.toMatchObject({
    reason: 'member-unavailable',
  })
})

test('retain keeps an unchanged leaf on an unavailable registry', async () => {
  const f = await memberLeafFixture()
  await expect(
    f.verify({ registry: registrySeed(), stage: 'full', mode: 'retain' }),
  ).resolves.toBeUndefined()
})

test('rejudge refuses it', async () => {
  const f = await memberLeafFixture()
  await expect(
    f.verify({ registry: registrySeed(), stage: 'full', mode: 'rejudge' }),
  ).rejects.toMatchObject({ reason: 'member-unavailable' })
})

test('structural stage accepts an mbr leaf without a registry and refuses a tampered mbr signature', async () => {
  const f = await memberLeafFixture()
  const judging: JudgingContext = { stage: 'structural', mode: 'admit' }
  await expect(
    verifyLeafCredential(f.credential, f.f.device.publicKey, {
      judging: () => judging,
      deviceDenySet: () => {
        throw new Error('Structural verification read denials')
      },
    }),
  ).resolves.toBeUndefined()
  await expect(f.verify(judging, `${f.capability}x`)).rejects.toMatchObject({
    reason: 'signature-invalid',
  })
})

test('standard group refuses a member-rooted leaf and an mbr manage capability', async () => {
  const f = await memberLeafFixture()
  const { group } = await pipelineGroup({ standard: true })
  const bundle = await rawBundle(group, agent(41), f.binding)
  await expect(validateEntry(group, bundle.publicPackage.leafNode)).rejects.toMatchObject({
    reason: 'controller-mismatch',
  })
  const { verifyManagementCapability } = await import('../src/authentication.js')
  const capability = stringifyToken(
    await f.member.identity.signToken(
      { ...f.payload, act: 'manage', res: 'kumiai/devices' },
      { embedLongForm: true },
    ),
  )
  expect(
    await verifyManagementCapability({
      capability,
      prefix: f.log.chain,
      controllerID: f.did,
      audience: f.f.device.id,
      leafKey: f.f.device.publicKey,
    }),
  ).toBe(false)
})

test.each(['member-removed', 'member-unavailable', 'epoch-cap'] as const)(
  '%s requires a new binding',
  (reason) => {
    expect(rejectionReason(new LeafBindingError(reason))).toBe('binding')
  },
)

test('a parent active at leaf issuance may start after its own issuance', async () => {
  const f = await leafCapabilityFixture({ parent: { nbf: 2000 } })
  await expect(verifyLeafCredential(f.credential(), f.device.publicKey)).resolves.toBeUndefined()
})

test('standard group root grants ignore lifecycle floors in the default judging context', async () => {
  const f = await memberLeafFixture()
  const { group } = await pipelineGroup({ standard: true })
  const held = group.state.ratchetTree[0]
  if (held?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
  const projection = f.registry.controllers.get(f.did)
  if (projection == null) throw new Error('Missing projection')
  ;(group.registry.controllers as Map<string, ControllerProjection>).set(f.did, {
    ...projection,
    genFloor: 99,
    timeFloor: 1000,
  })
  const capability = stringifyToken(
    await f.f.controller.signToken({ ...f.payload, mbr: undefined }),
  )
  const leaf = {
    ...held.leaf,
    credential: makeMLSCredential(agent(41), { ...f.binding, capability }),
  }
  await expect(validateEntry(group, leaf, held.leaf)).resolves.toBeUndefined()
})

test.each(['retain', 'rejudge'] as const)(
  '%s refuses an admitted credential after removal despite an unavailable survivor',
  async (mode) => {
    const f = await memberLeafFixture()
    const survivor = stringifyToken(
      await f.f.trusted.signToken({ ...f.payload, mbr: { add: 'never-added', g: 0 } }),
    )
    const projection = f.removed.controllers.get(f.did)
    if (projection?.recordedLog == null) throw new Error('Missing recorded log')
    const after = {
      ...f.removed,
      controllers: new Map([
        [f.did, { ...projection, survivorGrants: new Map([[f.f.device.id, survivor]]) }],
      ]),
    }
    const leaf = {
      did: f.f.device.id,
      binding: f.binding,
      leafKey: f.f.device.publicKey,
      leafIndex: 1,
    }
    const claims = claimsFor(f.did, f.log, projection.recordedLog, 0)
    expect(claims).toHaveLength(1)
    for (const claim of claims) effectOf(f.did, projection.recordedLog, claim, 0)
    await expect(
      verifyLeafCredential(f.credential, leaf.leafKey, { judging: () => f.judging }),
    ).resolves.toBeUndefined()
    await expect(
      verifyLeafCredential(f.credential, leaf.leafKey, {
        judging: () => ({ registry: after, stage: 'full', mode }),
      }),
    ).rejects.toMatchObject({ reason: 'member-removed' })
    expect(effectiveAuthorityOf(leaf, after, f.did)).toEqual({ status: 'removed' })
    expect(cascadeOf([leaf], claims, f.registry, after, f.did)).toEqual({
      revoked: [],
      removed: [{ did: leaf.did, cascadedFrom: f.member.identity.id }],
      removeLeafIndices: [1],
    })
  },
)

test.each(['retain', 'rejudge'] as const)(
  '%s refuses a removed primary even when the carried prefix is ahead',
  async (mode) => {
    const f = await memberLeafFixture()
    const rotation = createRotate({
      seed: f.seed,
      profile: 0,
      did: f.did,
      prior: f.inception.event,
      snapshot: snapshotOf(f.head),
      seal: 'unrecorded',
    })
    const binding = { ...f.binding, prefix: [f.inception, rotation] }
    await expect(
      verifyLeafCredential(makeMLSCredential(agent(41), binding), f.f.device.publicKey, {
        judging: () => ({ registry: f.removed, stage: 'full', mode }),
      }),
    ).rejects.toMatchObject({ reason: 'member-removed' })
    expect(
      effectiveAuthorityOf(
        { did: f.f.device.id, binding, leafKey: f.f.device.publicKey },
        f.removed,
        f.did,
      ),
    ).toEqual({ status: 'removed' })
  },
)

test('authentication refuses a saturated recorded log with a caller-provided deny set', async () => {
  const f = await memberLeafFixture()
  const projection = f.registry.controllers.get(f.did)
  if (projection == null) throw new Error('Missing projection')
  const registry = {
    ...f.registry,
    controllers: new Map([[f.did, { ...projection, recordedLog: await saturatedLog() }]]),
  }
  const capability = stringifyToken(
    await f.f.controller.signToken({ ...f.payload, mbr: undefined }),
  )
  await expect(
    verifyLeafCredential(
      makeMLSCredential(agent(41), { ...f.binding, capability }),
      f.f.device.publicKey,
      {
        judging: () => ({ registry, stage: 'full', mode: 'admit' }),
        deviceDenySet: () => new Set(),
      },
    ),
  ).rejects.toMatchObject({
    reason: 'signature-invalid',
    cause: { message: expect.stringContaining(EPOCH_SATURATED) },
  })
})

test.each(['admit', 'retain', 'rejudge'] as const)(
  'standard group authentication refuses a member-rooted leaf in %s',
  async (mode) => {
    const f = await memberLeafFixture()
    const { group } = await pipelineGroup({ standard: true })
    const holder = deviceDenyHolderFor(group.context)
    if (holder == null) throw new Error('Missing deny holder')
    holder.judging = () => ({ stage: 'full', mode })
    expect(
      await group.context.authService.validateCredential(f.credential, f.f.device.publicKey),
    ).toBe(false)
    await expect(
      verifyLeafCredential(f.credential, f.f.device.publicKey, { judging: holder.judging }),
    ).rejects.toMatchObject({ reason: 'controller-mismatch' })
  },
)

test.each(['retain', 'rejudge'] as const)(
  '%s refuses a removed primary without a substitute',
  async (mode) => {
    const f = await memberLeafFixture()
    await expect(f.verify({ registry: f.removed, stage: 'full', mode })).rejects.toMatchObject({
      reason: 'member-removed',
    })
  },
)

test.each(['retain', 'rejudge'] as const)(
  '%s refuses holder and survivor substitutes bound to another leaf',
  async (mode) => {
    const f = await memberLeafFixture()
    const parent = stringifyToken(
      await f.member.identity.signToken(
        {
          ...f.payload,
          aud: f.f.trusted.id,
          cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.f.trusted.publicKey }),
          exp: 1000,
        },
        { embedLongForm: true },
      ),
    )
    const capability = stringifyToken(
      await f.f.trusted.signToken({ ...f.payload, mbr: undefined, cap: parent }),
    )
    const projection = f.removed.controllers.get(f.did)
    if (projection == null) throw new Error('Missing projection')
    for (const field of ['aud', 'cnf'] as const) {
      const substitute = stringifyToken(
        await f.other.identity.signToken(
          {
            ...f.payload,
            mbr: { add: f.other.add, g: 0 },
            [field]:
              field === 'aud'
                ? f.f.trusted.id
                : audienceConfirmation({ alg: 'EdDSA', publicKey: f.f.trusted.publicKey }),
          },
          { embedLongForm: true },
        ),
      )
      await expect(
        verifyLeafCredential(
          makeMLSCredential(agent(41), { ...f.binding, capability, holderGrant: substitute }),
          f.f.device.publicKey,
          { judging: () => ({ registry: f.removed, stage: 'full', mode }) },
        ),
      ).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
      const registry = {
        ...f.removed,
        controllers: new Map([
          [f.did, { ...projection, survivorGrants: new Map([[f.f.device.id, substitute]]) }],
        ]),
      }
      await expect(f.verify({ registry, stage: 'full', mode })).rejects.toMatchObject({
        reason: 'member-removed',
      })
    }
  },
)

test.each(['retain', 'rejudge'] as const)(
  '%s verifies the full signature of an effective survivor substitute',
  async (mode) => {
    const f = await memberLeafFixture()
    const survivor = stringifyToken(
      await f.other.identity.signToken(
        {
          ...f.payload,
          mbr: { add: f.other.add, g: 0 },
        },
        { embedLongForm: true },
      ),
    )
    const projection = f.removed.controllers.get(f.did)
    if (projection == null) throw new Error('Missing projection')
    const registry = {
      ...f.removed,
      controllers: new Map([
        [f.did, { ...projection, survivorGrants: new Map([[f.f.device.id, `${survivor}x`]]) }],
      ]),
    }
    await expect(f.verify({ registry, stage: 'full', mode })).rejects.toMatchObject({
      reason: 'holder-evidence-mismatch',
    })
  },
)
