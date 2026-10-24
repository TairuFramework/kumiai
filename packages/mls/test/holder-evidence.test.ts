import { audienceConfirmation, checkCapability } from '@kokuin/capability'
import { createControllerIdentity } from '@kokuin/controller'
import { stringifyToken } from '@kokuin/token'
import { defaultCredentialTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import {
  type DIDAuthenticationDependencies,
  type JudgingContext,
  verifyLeafCredential,
} from '../src/authentication.js'
import { mintLeafCapability, mintTrustedGrant, readCapability } from '../src/capability.js'
import { asControllerLog } from '../src/controller-log.js'
import type { ControllerBinding } from '../src/credential.js'
import { createRegistryControllerResolver } from '../src/embedded-resolver.js'
import { LeafBindingError } from '../src/errors.js'
import { makeMLSCredential } from '../src/group-credential.js'
import {
  CommitRejectedError,
  commitInvite,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
  renewLeaf,
  revokeWithProof,
} from '../src/index.js'
import { registryForLog, registrySeed } from '../src/registry.js'
import { revokeChain } from './fixtures/controller-chain.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { leafCapabilityFixture } from './fixtures/leaf-capability.js'
import { controllerSeed, inception } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  controllerID,
  lowLevelExternal,
  pipelineGroup,
  rawAdd,
  rawBundle,
  rawCommit,
  timedBinding,
  welcomeBoundary,
} from './fixtures/lifecycle-pipeline.js'

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(150000)
  const { group, identity } = await pipelineGroup()
  const holder = agent(61)
  const device = agent(62)
  const parent = await timedBinding({ identity: holder, iat: 100, exp: 1000 })
  const binding = await timedBinding({
    identity: device,
    issuer: holder,
    parent: parent.capability,
    iat: 110,
    exp: 200,
  })
  delete binding.holderGrant
  const grant = await timedBinding({ identity: device, iat: 100, exp: 1000 })
  if (grant.capability == null) throw new Error('Missing holder grant')
  const evidenced: ControllerBinding & { holderGrant: string } = {
    ...binding,
    holderGrant: grant.capability,
  }
  return { group, identity, holder, device, binding, evidenced }
}

test.each(['build', 'receipt', 'Welcome'] as const)(
  'freshKeyMintedByTrustedGrantRefused: %s',
  async (path) => {
    const f = await fixture()
    if (path === 'build') {
      const bundle = await rawBundle(f.group, f.device, f.binding)
      const { invite } = await createInvite({
        group: f.group,
        identity: f.identity,
        recipientDID: f.device.id,
      })
      await expect(
        commitInvite(f.group, bundle.publicPackage, invite).then(() => undefined),
      ).rejects.toMatchObject({
        reason: 'missing-holder-evidence',
      })
    } else if (path === 'receipt') {
      const forged = await rawAdd(f.group, f.device, f.binding)
      await expect(f.group.processMessage(forged.message)).rejects.toMatchObject({
        reason: 'binding',
        cause: { reason: 'missing-holder-evidence' },
      })
      expect(f.group.listMembers()).toHaveLength(1)
    } else {
      const boundary = await welcomeBoundary(f.group, f.device, f.binding)
      await expect(boundary.process()).rejects.toMatchObject({ reason: 'missing-holder-evidence' })
    }
  },
)

test('boundDeviceRenewedByPeerAccepted', async () => {
  const f = await fixture()
  const bundle = await createKeyPackageBundle(f.device, { controller: f.evidenced })
  const { invite } = await createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: f.device.id,
  })
  const added = await commitInvite(f.group, bundle.publicPackage, invite)
  const { group: joined } = await processWelcome({
    identity: f.device,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: f.device.id },
  })
  expect(joined.bindingOfDID(f.device.id)).toMatchObject({ holderGrant: f.evidenced.holderGrant })
  expect(added.newGroup.bindingOfDID(f.device.id)).toMatchObject({
    holderGrant: f.evidenced.holderGrant,
  })
  const updatedBinding = {
    ...(await timedBinding({
      identity: f.device,
      issuer: f.holder,
      parent: (await timedBinding({ identity: f.holder, iat: 100, exp: 1000 })).capability,
      iat: 120,
      exp: 250,
    })),
    holderGrant: f.evidenced.holderGrant,
  }
  const renewed = await renewLeaf(joined, updatedBinding)
  await added.newGroup.processMessage(renewed.commitMessage)
  expect(added.newGroup.bindingOfDID(f.device.id)).toMatchObject({
    capability: updatedBinding.capability,
    holderGrant: f.evidenced.holderGrant,
  })
  expect(renewed.newGroup.bindingOfDID(f.device.id)).toMatchObject({
    holderGrant: f.evidenced.holderGrant,
  })
})

test.each(['aud', 'cnf'] as const)('holderGrantMustNameLeafKey: %s', async (claim) => {
  const f = await fixture()
  const controller = createControllerIdentity({
    seed: controllerSeed,
    profile: 0,
    log: asControllerLog([inception]),
  })
  const holderGrant = stringifyToken(
    await controller.signToken({
      sub: controllerID,
      aud: claim === 'aud' ? f.holder.id : f.device.id,
      act: 'authenticate',
      res: 'kumiai/mls-leaf',
      iat: 100,
      exp: 1000,
      cnf: audienceConfirmation({
        alg: 'EdDSA',
        publicKey: claim === 'cnf' ? f.holder.publicKey : f.device.publicKey,
      }),
    }),
  )
  await expect(
    verifyLeafCredential(
      makeMLSCredential(f.device, { ...f.evidenced, holderGrant }),
      f.device.publicKey,
    ),
  ).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
})

test('deniedHolderGrantRefused', async () => {
  const f = await fixture()
  const revoke = revokeChain({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    chain: [inception],
    subject: f.device.id,
  })
  const revoked = await revokeWithProof(f.group, {
    deny: [f.device.id],
    log: asControllerLog([inception, revoke]),
  })
  if (revoked.status !== 'built') throw new Error(`Revocation was not built: ${revoked.status}`)
  const group = revoked.result.newGroup
  expect(group.currentDenySet().has(f.device.id)).toBe(true)
  expect(group.currentDenySet().has(f.holder.id)).toBe(false)
  const bundle = await rawBundle(group, f.device, f.evidenced)
  const { invite } = await createInvite({ group, identity: f.identity, recipientDID: f.device.id })
  await expect(commitInvite(group, bundle.publicPackage, invite)).rejects.toMatchObject({
    reason: 'denied-id',
  })
})

test('directCLeafUnchanged', async () => {
  const f = await fixture()
  const binding = await timedBinding({ identity: f.device, iat: 100, exp: 200 })
  const credential = makeMLSCredential(f.device, binding)
  await expect(verifyLeafCredential(credential, f.device.publicKey)).resolves.toBeUndefined()
  expect(credential.credentialType).toBe(defaultCredentialTypes.basic)
})

test.each(['signature', 'issuer', 'subject', 'chain', 'permission', 'lifetime'] as const)(
  'invalid holder evidence refused: %s',
  async (fault) => {
    const f = await fixture()
    const controller = createControllerIdentity({
      seed: controllerSeed,
      profile: 0,
      log: asControllerLog([inception]),
    })
    const payload = {
      sub: fault === 'subject' ? f.holder.id : controllerID,
      aud: f.device.id,
      act: fault === 'permission' ? 'manage' : 'authenticate',
      res: 'kumiai/mls-leaf',
      iat: 100,
      exp: fault === 'lifetime' ? 31_536_101 : 1000,
      cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.device.publicKey }),
      ...(fault === 'chain' ? { cap: f.evidenced.holderGrant } : {}),
    }
    const signer = fault === 'issuer' ? f.holder : controller
    let holderGrant = stringifyToken(await signer.signToken(payload))
    if (fault === 'signature') {
      const forged = await f.holder.signToken(payload)
      holderGrant = `${holderGrant.slice(0, holderGrant.lastIndexOf('.') + 1)}${forged.signature}`
    }
    await expect(
      verifyLeafCredential(
        makeMLSCredential(f.device, { ...f.evidenced, holderGrant }),
        f.device.publicKey,
      ),
    ).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
  },
)

test('missing evidence refused on a forged update', async () => {
  const f = await fixture()
  const replacement = await timedBinding({
    identity: f.identity,
    issuer: f.holder,
    parent: (await timedBinding({ identity: f.holder, iat: 100, exp: 1000 })).capability,
    iat: 110,
    exp: 200,
  })
  delete replacement.holderGrant
  const forged = await rawCommit({ group: f.group, binding: replacement })
  const processing = f.group.processMessage(encode(mlsMessageEncoder, forged.commit))
  await expect(processing).rejects.toMatchObject({
    reason: 'binding',
    cause: { reason: 'missing-holder-evidence' },
  })
  await expect(processing).rejects.toHaveProperty('cause', expect.any(LeafBindingError))
  expect(f.group.listMembers()).toHaveLength(1)
})

test('public key package builder refuses missing evidence', async () => {
  const f = await fixture()
  await expect(
    createKeyPackageBundle(f.device, { controller: f.binding }).then(() => undefined),
  ).rejects.toMatchObject({
    reason: 'missing-holder-evidence',
  })
})

test('external replacement refuses missing evidence', async () => {
  const f = await fixture()
  const bundle = await rawBundle(f.group, f.device, f.evidenced)
  const { invite } = await createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: f.device.id,
  })
  const { newGroup: author } = await commitInvite(f.group, bundle.publicPackage, invite)
  const replacement = await timedBinding({
    identity: f.identity,
    issuer: f.holder,
    parent: (await timedBinding({ identity: f.holder, iat: 100, exp: 1000 })).capability,
    iat: 110,
    exp: 200,
  })
  delete replacement.holderGrant
  const message = await lowLevelExternal({
    group: author,
    identity: f.identity,
    binding: replacement,
  })
  const processing = author.processMessage(message)
  await expect(processing).rejects.toMatchObject({
    reason: 'binding',
    cause: { reason: 'missing-holder-evidence' },
  })
  await expect(processing).rejects.toHaveProperty('cause', expect.any(LeafBindingError))
})

test.each(
  ['key-package build', 'Add build', 'Add receipt', 'Welcome'].flatMap((path) =>
    [
      { validity: 'expired', iat: 10, exp: 50 },
      { validity: 'expires at leaf issuance', iat: 10, exp: 110 },
      { validity: 'issued after leaf', iat: 111, exp: 1000 },
    ].map((grant) => ({ path, ...grant })),
  ),
)('expiredHolderGrantRefused: $validity / $path', async ({ path, iat, exp }) => {
  const f = await fixture()
  const grant = await timedBinding({ identity: f.device, iat, exp })
  const binding = { ...f.binding, holderGrant: grant.capability }
  if (path === 'key-package build') {
    await expect(
      createKeyPackageBundle(f.device, { controller: binding }).then(() => undefined),
    ).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
  } else if (path === 'Add build') {
    const bundle = await rawBundle(f.group, f.device, binding)
    const { invite } = await createInvite({
      group: f.group,
      identity: f.identity,
      recipientDID: f.device.id,
    })
    await expect(
      commitInvite(f.group, bundle.publicPackage, invite).then(() => undefined),
    ).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
  } else if (path === 'Add receipt') {
    const forged = await rawAdd(f.group, f.device, binding)
    const processing = f.group.processMessage(forged.message)
    await expect(processing).rejects.toMatchObject({
      reason: 'binding',
      cause: { reason: 'holder-evidence-mismatch' },
    })
    await expect(processing).rejects.toHaveProperty('cause', expect.any(LeafBindingError))
    expect(f.group.listMembers()).toHaveLength(1)
  } else {
    const boundary = await welcomeBoundary(f.group, f.device, binding)
    await expect(boundary.process()).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
  }
})

test.each([
  { iat: 110, exp: 111 },
  { iat: 10, exp: 111 },
])('holder grant valid at leaf issuance accepted: $iat/$exp', async ({ iat, exp }) => {
  const f = await fixture()
  const grant = await timedBinding({ identity: f.device, iat, exp })
  await expect(
    createKeyPackageBundle(f.device, {
      controller: { ...f.binding, holderGrant: grant.capability },
    }),
  ).resolves.toBeDefined()
})

test.each(['key-package build', 'Add receipt'] as const)(
  'holder grant not yet active at leaf issuance refused: %s',
  async (path) => {
    const f = await fixture()
    const controller = createControllerIdentity({
      seed: controllerSeed,
      profile: 0,
      log: asControllerLog([inception]),
    })
    const holderGrant = stringifyToken(
      await controller.signToken({
        sub: controllerID,
        aud: f.device.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        iat: 100,
        nbf: 120,
        exp: 1000,
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.device.publicKey }),
      }),
    )
    const binding = { ...f.binding, holderGrant }
    if (path === 'key-package build') {
      const building = createKeyPackageBundle(f.device, { controller: binding })
      await expect(building).rejects.toBeInstanceOf(LeafBindingError)
      await expect(building).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
      // Pinned verification also refuses nbf; this cause proves the structural gate ran.
      await expect(building).rejects.toHaveProperty('cause', expect.any(LeafBindingError))
      await expect(building).rejects.toMatchObject({
        cause: { reason: 'holder-evidence-mismatch' },
      })
    } else {
      const forged = await rawAdd(f.group, f.device, binding)
      const processing = f.group.processMessage(forged.message)
      await expect(processing).rejects.toBeInstanceOf(CommitRejectedError)
      await expect(processing).rejects.toMatchObject({
        reason: 'binding',
        cause: { reason: 'holder-evidence-mismatch' },
      })
      await expect(processing).rejects.toHaveProperty('cause', expect.any(LeafBindingError))
      await expect(processing).rejects.toHaveProperty('cause.cause', expect.any(LeafBindingError))
      await expect(processing).rejects.toMatchObject({
        cause: { cause: { reason: 'holder-evidence-mismatch' } },
      })
      expect(f.group.listMembers()).toHaveLength(1)
    }
  },
)

test('expired holder grant refused on renewal', async () => {
  const f = await fixture()
  const grant = await timedBinding({ identity: f.identity, iat: 10, exp: 50 })
  const binding = {
    ...(await timedBinding({
      identity: f.identity,
      issuer: f.holder,
      parent: (await timedBinding({ identity: f.holder, iat: 100, exp: 1000 })).capability,
      iat: 110,
      exp: 200,
    })),
    holderGrant: grant.capability,
  }
  const epoch = f.group.epoch
  const renewing = renewLeaf(f.group, binding)
  await expect(renewing).rejects.toBeInstanceOf(LeafBindingError)
  await expect(renewing).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
  expect(f.group.epoch).toBe(epoch)
})

test('expired holder grant refused on external replacement', async () => {
  const f = await fixture()
  const bundle = await rawBundle(f.group, f.device, f.evidenced)
  const { invite } = await createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: f.device.id,
  })
  const { newGroup: author } = await commitInvite(f.group, bundle.publicPackage, invite)
  const grant = await timedBinding({ identity: f.identity, iat: 10, exp: 50 })
  const binding = {
    ...(await timedBinding({
      identity: f.identity,
      issuer: f.holder,
      parent: (await timedBinding({ identity: f.holder, iat: 100, exp: 1000 })).capability,
      iat: 110,
      exp: 200,
    })),
    holderGrant: grant.capability,
  }
  const message = await lowLevelExternal({ group: author, identity: f.identity, binding })
  const epoch = author.epoch
  const processing = author.processMessage(message)
  await expect(processing).rejects.toBeInstanceOf(CommitRejectedError)
  await expect(processing).rejects.toMatchObject({
    reason: 'binding',
    cause: { reason: 'holder-evidence-mismatch' },
  })
  await expect(processing).rejects.toHaveProperty('cause', expect.any(LeafBindingError))
  expect(author.epoch).toBe(epoch)
})

async function memberHolderFixture() {
  const epoch = await buildEpoch({ members: 1, renewEvery: 4_000_000 })
  const member = epoch.members[0]
  if (member == null) throw new Error('Missing member')
  const f = await leafCapabilityFixture()
  const payload = {
    ...f.childPayload,
    sub: epoch.did,
    iat: 100,
    nbf: 100,
    exp: 2_592_100,
    cap: undefined,
    mbr: { add: member.add, g: 0 },
  }
  const parent = stringifyToken(
    await member.identity.signToken(
      {
        ...payload,
        aud: f.trusted.id,
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: f.trusted.publicKey }),
      },
      { embedLongForm: true },
    ),
  )
  const holderGrant = stringifyToken(
    await member.identity.signToken(payload, { embedLongForm: true }),
  )
  const leafPayload = { ...payload, mbr: undefined, iat: 200, nbf: 200, exp: 3800, cap: parent }
  const capability = stringifyToken(await f.trusted.signToken(leafPayload))
  const binding = { id: epoch.did, prefix: epoch.log.chain, capability, holderGrant }
  const registry = registryForLog(epoch.did, epoch.log)
  const deps: DIDAuthenticationDependencies = {
    judging: () => ({ registry, stage: 'full' as const, mode: 'admit' as const }),
    leafLifetime: () => 3600,
    trustedGrantLifetime: () => 2_592_000,
  }
  const verify = (overrides = {}, dependencies = deps) =>
    verifyLeafCredential(
      makeMLSCredential(agent(41), { ...binding, ...overrides }),
      f.device.publicKey,
      dependencies,
    )
  return { ...epoch, member, f, parent, holderGrant, leafPayload, binding, registry, deps, verify }
}

test('holder grant minted by a member authenticates a chained leaf', async () => {
  const f = await memberHolderFixture()
  await expect(f.verify()).resolves.toBeUndefined()
})

test('30-day member parent with a one-hour leaf authenticates', async () => {
  const f = await memberHolderFixture()
  const frozen = createRegistryControllerResolver({
    controllerID: f.did,
    prefix: f.log.chain,
    registry: f.registry,
  }).frozen()
  const payload = readCapability(f.binding.capability).payload
  await expect(
    checkCapability({ act: 'authenticate', res: 'kumiai/mls-leaf' }, payload, {
      atTime: payload.iat,
      methods: [frozen],
      maxDepth: 1,
      maxMemberGrantLifetime: 604_800,
    }),
  ).rejects.toThrow('member grant lifetime exceeds the maximum')
  await expect(f.verify()).resolves.toBeUndefined()
})

test('member holder grant over the group trustedGrantLifetime is refused', async () => {
  const f = await memberHolderFixture()
  const holderGrant = stringifyToken(
    await f.member.identity.signToken(
      {
        ...readCapability(f.holderGrant).payload,
        exp: 2_592_101,
      },
      { embedLongForm: true },
    ),
  )
  await expect(f.verify({ holderGrant })).rejects.toMatchObject({ reason: 'lifetime-cap' })
})

test('longer holder grant does not lengthen the leaf', async () => {
  const f = await memberHolderFixture()
  const capability = stringifyToken(await f.f.trusted.signToken({ ...f.leafPayload, exp: 3801 }))
  await expect(f.verify({ capability })).rejects.toMatchObject({ reason: 'lifetime-cap' })
})

test('leaf minting accepts a well-formed member-rooted parent', async () => {
  const f = await memberHolderFixture()
  vi.spyOn(Date, 'now').mockReturnValue(200_000)
  const parent = await mintTrustedGrant({
    signer: f.member.identity,
    controllerID: f.did,
    audience: f.f.trusted.id,
    leafKey: f.f.trusted.publicKey,
    exp: 2_592_100,
    member: { add: f.member.add, g: 0 },
  })
  await expect(
    mintLeafCapability({
      signer: f.f.trusted,
      controllerID: f.did,
      audience: f.f.device.id,
      leafKey: f.f.device.publicKey,
      exp: 3800,
      parent,
    }),
  ).resolves.toEqual(expect.any(String))
})

test.each([
  ['structural', false],
  ['structural', true],
  ['full', false],
  ['full', true],
] as const)(
  '%s refuses a holder grant on a direct member binding (forged: %s)',
  async (stage, forged) => {
    const f = await memberHolderFixture()
    const capability = stringifyToken(
      await f.member.identity.signToken(
        {
          ...readCapability(f.holderGrant).payload,
          exp: 200,
        },
        { embedLongForm: true },
      ),
    )
    await expect(
      f.verify(
        { capability, holderGrant: forged ? `${f.holderGrant}x` : f.holderGrant },
        {
          ...f.deps,
          judging: () => ({ registry: f.registry, stage, mode: 'admit' }),
        },
      ),
    ).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
  },
)

test.each(['retain', 'rejudge'] as const)(
  '%s judges a member holder on a root-kind primary with an unavailable registry',
  async (mode) => {
    const f = await memberHolderFixture()
    const parent = stringifyToken(
      await f.f.controller.signToken({
        ...readCapability(f.parent).payload,
        iss: f.f.controller.id,
        mbr: undefined,
      }),
    )
    const capability = stringifyToken(
      await f.f.trusted.signToken({ ...f.leafPayload, cap: parent }),
    )
    const judging: JudgingContext = { registry: registrySeed(), stage: 'full', mode }
    const checking = f.verify({ capability }, { ...f.deps, judging: () => judging })
    if (mode === 'retain') await expect(checking).resolves.toBeUndefined()
    else await expect(checking).rejects.toMatchObject({ reason: 'member-unavailable' })
    await expect(
      f.verify(
        { capability, holderGrant: `${f.holderGrant}x` },
        {
          ...f.deps,
          judging: () => judging,
        },
      ),
    ).rejects.toMatchObject({ reason: 'holder-evidence-mismatch' })
  },
)
