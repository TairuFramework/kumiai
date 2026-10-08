import { audienceConfirmation } from '@kokuin/capability'
import { createControllerIdentity } from '@kokuin/controller'
import { stringifyToken } from '@kokuin/token'
import { defaultCredentialTypes, encode, mlsMessageEncoder, nodeTypes } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import type { ControllerBinding } from '../src/credential.js'
import { parseMLSCredentialIdentity } from '../src/credential.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { HISTORY_HORIZON, historySize } from '../src/history.js'
import {
  commitInvite,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
  renewLeaf,
} from '../src/index.js'
import { decodeKeyPackage, encodeKeyPackage } from '../src/key-package-codec.js'
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

test('binding format probe', async () => {
  const f = await fixture()
  const plain = makeMLSCredential(f.device, f.binding)
  const evidence = makeMLSCredential(f.device, f.evidenced)
  if (!('identity' in plain) || !('identity' in evidence)) throw new Error('Missing basic identity')
  const bundle = await rawBundle(f.group, f.device, f.evidenced)
  const plainEncoded = encodeKeyPackage({
    ...bundle.publicPackage,
    leafNode: { ...bundle.publicPackage.leafNode, credential: plain },
  })
  const encoded = encodeKeyPackage(bundle.publicPackage)
  const decoded = decodeKeyPackage(encoded)
  expect(decoded?.leafNode.credential).toEqual(bundle.publicPackage.leafNode.credential)
  if (decoded == null || !('identity' in decoded.leafNode.credential))
    throw new Error('Missing decoded credential')
  expect(parseMLSCredentialIdentity(decoded.leafNode.credential.identity).controller).toMatchObject(
    { holderGrant: f.evidenced.holderGrant },
  )
  const direct = await timedBinding({ identity: f.device, iat: 100, exp: 200 })
  const directCredential = makeMLSCredential(f.device, direct)
  if (!('identity' in directCredential)) throw new Error('Missing identity')
  expect(parseMLSCredentialIdentity(directCredential.identity).controller).toEqual(direct)
  const node = f.group.state.ratchetTree[0]
  if (node?.nodeType !== nodeTypes.leaf) throw new Error('Missing leaf')
  const historyWithout = historySize([{ ...node, leaf: { ...node.leaf, credential: plain } }], [])
  const historyWith = historySize([{ ...node, leaf: { ...node.leaf, credential: evidence } }], [])
  console.log(
    JSON.stringify({
      format: 'v1 controller.holderGrant optional compact token string',
      grantBytes: f.evidenced.holderGrant.length,
      credentialWithout: plain.identity.length,
      credentialWith: evidence.identity.length,
      increase: evidence.identity.length - plain.identity.length,
      keyPackageBase64Without: plainEncoded.length,
      keyPackageBase64Bytes: encoded.length,
      historyWithout,
      historyWith,
      horizon: HISTORY_HORIZON,
      parsedEvidenceRetained:
        'holderGrant' in (parseMLSCredentialIdentity(evidence.identity).controller ?? {}),
    }),
  )
})

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
  const credential = makeMLSCredential(f.device, f.evidenced)
  await expect(
    verifyLeafCredential(credential, f.device.publicKey, {
      deviceDenySet: () => new Set([f.device.id]),
    }),
  ).rejects.toMatchObject({ reason: 'denied-id' })
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
  await expect(
    f.group.processMessage(encode(mlsMessageEncoder, forged.commit)),
  ).rejects.toMatchObject({ reason: 'binding' })
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
  await expect(author.processMessage(message)).rejects.toMatchObject({ reason: 'binding' })
})
