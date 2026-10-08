import { audienceConfirmation } from '@kokuin/capability'
import { createControllerIdentity, createRevoke } from '@kokuin/controller'
import { stringifyToken } from '@kokuin/token'
import { defaultCredentialTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import type { ControllerBinding } from '../src/credential.js'
import { LeafBindingError } from '../src/errors.js'
import { makeMLSCredential } from '../src/group-credential.js'
import {
  commitInvite,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
  renewLeaf,
  revokeWithProof,
} from '../src/index.js'
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
    log: [inception],
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
  const revoke = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    target: f.device.id,
    keyPosition: { gen: 0, seq: 0 },
  })
  const revoked = await revokeWithProof(f.group, { subject: f.device.id, log: [inception, revoke] })
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
      log: [inception],
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
