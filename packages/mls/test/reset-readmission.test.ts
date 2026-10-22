import { audienceConfirmation } from '@kokuin/capability'
import {
  createControllerIdentity,
  createInception,
  createReset,
  createRevoke,
  didFromInception,
  foldLog,
  type SignedEvent,
} from '@kokuin/controller'
import { stringifyToken } from '@kokuin/token'
import { defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createDIDAuthenticationService } from '../src/authentication.js'
import { mintTrustedGrant } from '../src/capability.js'
import { commitInvite, commitWithEntries, createInvite } from '../src/group-commit.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { deriveGroup } from '../src/group-handle.js'
import {
  commitSelfRemovals,
  proposeSelfRemoval,
  removeLapsedLeaves,
  renewLeaf,
  revokeWithProof,
} from '../src/group-lifecycle.js'
import { processWelcome } from '../src/group-welcome.js'
import { validateEntry } from '../src/lifecycle.js'
import {
  authority,
  DEVICE_ENTRY_TYPE,
  denySetOf,
  mayReadmitResetDevice,
  registryApply,
  registrySeed,
} from '../src/registry.js'
import { controllerSeed } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  belowGateWelcome,
  controllerID,
  inception,
  lowLevelWelcome,
  pipelineGroup,
  rawBundle,
  timedBinding,
  welcomeBoundary,
  withoutHolderEvidence,
} from './fixtures/lifecycle-pipeline.js'

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(150_000))
afterEach(() => vi.restoreAllMocks())

function revoke(log: Array<SignedEvent>, subject: string) {
  const folded = foldLog(controllerID, log)
  const head = folded.ok ? folded.states.at(-1) : undefined
  const prior = log.at(-1)
  if (head == null || prior == null) throw new Error('Missing head')
  return createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: prior.event,
    target: subject,
    keyPosition: { gen: head.keyGen, seq: head.keySeq },
  })
}

async function resetRemoved() {
  const setup = await pipelineGroup()
  const target = agent(51)
  const old = await timedBinding({ identity: target, iat: 100, exp: 200 })
  const fixture = await lowLevelWelcome(setup.group, target, old)
  const log = [inception, createReset(controllerSeed, 0, 1)]
  const renewed = await renewLeaf(
    fixture.author,
    await timedBinding({ identity: setup.identity, iat: 150, exp: 250, prefix: log }),
  )
  const reset = await revokeWithProof(renewed.newGroup, { reset: true, log })
  expect(reset.status).toBe('built')
  if (reset.status !== 'built') throw new Error('Missing reset')
  const group = reset.result.newGroup
  expect(group.registry.devices.get(target.id)).toMatchObject({
    status: 'revoked',
    reason: 'reset',
  })
  expect(authority(group.registry, target.id)).toBe(target.id)
  return { ...setup, group, target, old, log }
}

test('resetRemovedDeviceReaddedWithPostResetEvidence', async () => {
  const { group, identity, target, log } = await resetRemoved()
  const binding = await timedBinding({ identity: target, iat: 150, exp: 250, prefix: log })
  const bundle = await rawBundle(group, target, binding)
  const { invite } = await createInvite({ group, identity, recipientDID: target.id })
  const added = await commitInvite(group, bundle.publicPackage, invite)
  const receiver = deriveGroup(group, structuredClone(group.state))
  await receiver.processMessage(added.commitMessage)
  const { group: joined } = await processWelcome({
    identity: target,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: target.id },
  })
  for (const member of [added.newGroup, receiver, joined]) {
    expect(member.registry.devices.get(target.id)).toEqual({
      controller: controllerID,
      status: 'active',
    })
    expect(authority(member.registry, target.id)).toBe(controllerID)
  }
  const commit = await commitWithEntries({
    group: joined,
    extraProposals: [],
    enacted: [],
    requireAdmin: false,
  })
  await added.newGroup.processMessage(encode(mlsMessageEncoder, commit.commit))
  expect(added.newGroup.epoch).toBe(joined.epoch + 1n)
})

test('resetRemovedDeviceRefusedWithOldGenerationEvidence', async () => {
  const { group, target, old } = await resetRemoved()
  const bundle = await rawBundle(group, target, old)
  expect(mayReadmitResetDevice(group.registry, { id: target.id, controller: old })).toBe(false)
  await expect(
    commitWithEntries({
      group,
      extraProposals: [
        { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
      ],
      enacted: [],
      requireAdmin: false,
    }),
  ).rejects.toMatchObject({ reason: 'denied-id' })
  const welcome = await welcomeBoundary(group, target, old)
  await expect(welcome.process()).rejects.toThrow()
})

test('authentication validateCredential agrees with checkBinding for reset evidence', async () => {
  const { group, target, old, log } = await resetRemoved()
  const fresh = await timedBinding({ identity: target, iat: 150, exp: 250, prefix: log })
  for (const [binding, accepted] of [
    [old, false],
    [fresh, true],
  ] as const) {
    const bundle = await rawBundle(group, target, binding)
    expect(
      await group.context.authService.validateCredential(
        makeMLSCredential(target, binding),
        target.publicKey,
      ),
    ).toBe(accepted)
    if (accepted)
      await expect(validateEntry(group, bundle.publicPackage.leafNode)).resolves.toBeUndefined()
    else
      await expect(validateEntry(group, bundle.publicPackage.leafNode)).rejects.toMatchObject({
        reason: 'denied-id',
      })
  }
})

test('subjectRevokedDeviceStillRefused', async () => {
  const setup = await pipelineGroup()
  const target = agent(51)
  const log = [inception, revoke([inception], target.id)]
  const result = await revokeWithProof(setup.group, { subject: target.id, log })
  expect(result.status).toBe('built')
  if (result.status !== 'built') throw new Error('Missing revoke')
  const bundle = await rawBundle(
    result.result.newGroup,
    target,
    await timedBinding({ identity: target, iat: 150, exp: 250 }),
  )
  await expect(
    validateEntry(result.result.newGroup, bundle.publicPackage.leafNode),
  ).rejects.toMatchObject({ reason: 'denied-id' })
  expect(
    await result.result.newGroup.context.authService.validateCredential(
      bundle.publicPackage.leafNode.credential,
      target.publicKey,
    ),
  ).toBe(false)
})

test('cascadeRevokedDeviceStillRefused', async () => {
  const setup = await pipelineGroup()
  const issuer = agent(61)
  const target = agent(51)
  const parent = await trustedGrant(issuer, [inception])
  const chained = await timedBinding({ identity: target, iat: 150, exp: 250, issuer, parent })
  const fixture = await belowGateWelcome(setup.group, target, withoutHolderEvidence(chained))
  const result = await revokeWithProof(fixture.author, {
    subject: issuer.id,
    log: [inception, revoke([inception], issuer.id)],
  })
  expect(result.status).toBe('built')
  if (result.status !== 'built') throw new Error('Missing cascade')
  const group = result.result.newGroup
  expect(group.registry.devices.get(target.id)).toMatchObject({
    status: 'revoked',
    cascadedFrom: issuer.id,
  })
  const binding = await timedBinding({ identity: target, iat: 150, exp: 250 })
  const bundle = await rawBundle(group, target, binding)
  await expect(validateEntry(group, bundle.publicPackage.leafNode)).rejects.toMatchObject({
    reason: 'denied-id',
  })
  expect(
    await group.context.authService.validateCredential(
      bundle.publicPackage.leafNode.credential,
      target.publicKey,
    ),
  ).toBe(false)
  const resetLog = [inception, createReset(controllerSeed, 0, 1)]
  const resetCascade = registryApply(
    {
      issuer: group.credential.id,
      entry: {
        groupID: group.groupID,
        type: DEVICE_ENTRY_TYPE,
        subject: controllerID,
        value: {
          op: 'reset',
          proof: resetLog,
          revoked: [{ did: target.id, cascadedFrom: issuer.id }],
        },
      },
    },
    registrySeed(),
    controllerID,
  )
  const fresh = await timedBinding({ identity: target, iat: 150, exp: 250, prefix: resetLog })
  expect(mayReadmitResetDevice(resetCascade, { id: target.id, controller: fresh })).toBe(false)
  expect(
    await createDIDAuthenticationService({ deviceRegistry: () => resetCascade }).validateCredential(
      makeMLSCredential(target, fresh),
      target.publicKey,
    ),
  ).toBe(false)
  const registry = registryApply(
    {
      issuer: group.credential.id,
      entry: {
        groupID: group.groupID,
        type: DEVICE_ENTRY_TYPE,
        subject: controllerID,
        value: { op: 'reset', proof: resetLog, revoked: [{ did: target.id }] },
      },
    },
    group.registry,
    controllerID,
  )
  const added = registryApply(
    {
      issuer: group.credential.id,
      entry: {
        groupID: group.groupID,
        type: DEVICE_ENTRY_TYPE,
        subject: target.id,
        value: { op: 'add', controller: controllerID },
      },
    },
    registry,
  )
  expect(added.devices.get(target.id)).toMatchObject({ status: 'revoked', cascadedFrom: issuer.id })
  expect(
    mayReadmitResetDevice(added, {
      id: target.id,
      controller: await timedBinding({ identity: target, iat: 150, exp: 250, prefix: resetLog }),
    }),
  ).toBe(false)
})

async function trustedGrant(identity: ReturnType<typeof agent>, prefix: Array<SignedEvent>) {
  return mintTrustedGrant({
    signer: createControllerIdentity({ seed: controllerSeed, profile: 0, log: prefix }),
    controllerID,
    audience: identity.id,
    leafKey: identity.publicKey,
    exp: 1000,
  })
}

test('chained post-reset holder evidence permits re-entry and authentication agrees', async () => {
  const { group, identity, target, log } = await resetRemoved()
  const issuer = agent(61)
  const parent = await trustedGrant(issuer, log)
  const old = await timedBinding({
    identity: target,
    iat: 150,
    exp: 250,
    issuer,
    parent: await trustedGrant(issuer, [inception]),
  })
  const fresh = await timedBinding({
    identity: target,
    iat: 150,
    exp: 250,
    issuer,
    parent,
    prefix: log,
  })
  for (const [binding, accepted] of [
    [old, false],
    [fresh, true],
    [withoutHolderEvidence(fresh), false],
  ] as const) {
    const credential = makeMLSCredential(target, binding)
    expect(await group.context.authService.validateCredential(credential, target.publicKey)).toBe(
      accepted,
    )
    const bundle = await rawBundle(group, target, binding)
    if (accepted)
      await expect(validateEntry(group, bundle.publicPackage.leafNode)).resolves.toBeUndefined()
    else await expect(validateEntry(group, bundle.publicPackage.leafNode)).rejects.toThrow()
  }
  const bundle = await rawBundle(group, target, fresh)
  const { invite } = await createInvite({ group, identity, recipientDID: target.id })
  const added = await commitInvite(group, bundle.publicPackage, invite)
  const { group: joined } = await processWelcome({
    identity: target,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: target.id },
  })
  expect(joined.registry.devices.get(target.id)?.status).toBe('active')
  expect(group.registry.devices.get(target.id)?.status).toBe('revoked')
  // Bare deny-set consumers remain conservative without registry evidence.
  expect(
    await createDIDAuthenticationService({
      deviceDenySet: () => group.currentDenySet(),
    }).validateCredential(bundle.publicPackage.leafNode.credential, target.publicKey),
  ).toBe(false)
})

test('resetThenSubjectRevokedStaysTerminal', async () => {
  const { group, target, log } = await resetRemoved()
  const result = await revokeWithProof(group, {
    subject: target.id,
    log: [...log, revoke(log, target.id)],
  })
  expect(result.status).toBe('built')
  if (result.status !== 'built') throw new Error('Missing revoke')
  expect(result.result.newGroup.registry.devices.get(target.id)?.reason).toBeUndefined()
  const bundle = await rawBundle(
    result.result.newGroup,
    target,
    await timedBinding({ identity: target, iat: 150, exp: 250, prefix: log }),
  )
  await expect(
    validateEntry(result.result.newGroup, bundle.publicPackage.leafNode),
  ).rejects.toMatchObject({ reason: 'denied-id' })
  const plain = registryApply(
    {
      issuer: group.credential.id,
      entry: {
        groupID: group.groupID,
        type: DEVICE_ENTRY_TYPE,
        subject: target.id,
        value: { op: 'revoke' },
      },
    },
    group.registry,
  )
  expect(plain.devices.get(target.id)?.reason).toBeUndefined()
  const add = (registry: typeof group.registry) =>
    registryApply(
      {
        issuer: group.credential.id,
        entry: {
          groupID: group.groupID,
          type: DEVICE_ENTRY_TYPE,
          subject: target.id,
          value: { op: 'add', controller: controllerID },
        },
      },
      registry,
    )
  expect(add(group.registry).devices.get(target.id)).toEqual({
    controller: controllerID,
    status: 'active',
  })
  expect(add(plain).devices.get(target.id)?.status).toBe('revoked')
})

test.each(['ordinary Remove', 'self-removal'] as const)(
  'reset re-admission followed by %s has a reproducible registry',
  async (removal) => {
    const { group, identity, target, log, tokens } = await resetRemoved()
    const observer = agent(61)
    const observerBundle = await rawBundle(
      group,
      observer,
      await timedBinding({ identity: observer, iat: 150, exp: 350, prefix: log }),
    )
    const { invite: observerInvite } = await createInvite({
      group,
      identity,
      recipientDID: observer.id,
    })
    const observerAdd = await commitInvite(group, observerBundle.publicPackage, observerInvite)
    const { group: receiver } = await processWelcome({
      identity: observer,
      invite: observerInvite,
      welcome: observerAdd.welcomeMessage,
      keyPackageBundle: { ...observerBundle, ownerDID: observer.id },
    })
    const binding = await timedBinding({ identity: target, iat: 150, exp: 200, prefix: log })
    const bundle = await rawBundle(observerAdd.newGroup, target, binding)
    const { invite } = await createInvite({
      group: observerAdd.newGroup,
      identity,
      recipientDID: target.id,
    })
    const added = await commitInvite(observerAdd.newGroup, bundle.publicPackage, invite)
    await receiver.processMessage(added.commitMessage)
    const { group: joined } = await processWelcome({
      identity: target,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: { ...bundle, ownerDID: target.id },
    })
    let author = added.newGroup
    if (removal === 'ordinary Remove') {
      vi.spyOn(Date, 'now').mockReturnValue(210_000)
      const renewal = await renewLeaf(
        author,
        await timedBinding({ identity, iat: 210, exp: 310, prefix: log }),
      )
      for (const held of renewal.newGroup.ledger) tokens.set(held.entryID, held.token)
      await receiver.processMessage(renewal.commitMessage)
      author = renewal.newGroup
    }
    if (removal === 'self-removal') {
      const proposal = await proposeSelfRemoval(joined)
      await author.processMessage(proposal.frame)
      await receiver.processMessage(proposal.frame)
    }
    const removed =
      removal === 'ordinary Remove'
        ? (await removeLapsedLeaves(author)).result
        : await commitSelfRemovals(author)
    if (removed == null) throw new Error('Missing removal')
    for (const held of removed.newGroup.ledger) tokens.set(held.entryID, held.token)
    await receiver.processMessage(removed.commitMessage)
    author = removed.newGroup
    const reconstructed = deriveGroup(author, structuredClone(author.state))
    const later = agent(71)
    const laterBinding = await timedBinding({
      identity: later,
      iat: removal === 'ordinary Remove' ? 210 : 150,
      exp: 310,
      prefix: log,
    })
    const laterBundle = await rawBundle(author, later, laterBinding)
    const { invite: laterInvite } = await createInvite({
      group: author,
      identity,
      recipientDID: later.id,
    })
    const laterAdd = await commitInvite(author, laterBundle.publicPackage, laterInvite)
    const { group: laterJoiner } = await processWelcome({
      identity: later,
      invite: laterInvite,
      welcome: laterAdd.welcomeMessage,
      keyPackageBundle: { ...laterBundle, ownerDID: later.id },
    })
    const expected = author.registry.devices.get(target.id)
    expect(expected).toMatchObject({ status: 'revoked', reason: 'reset' })
    for (const member of [author, receiver, reconstructed, laterJoiner]) {
      expect(member.registry.devices.get(target.id)).toEqual(expected)
      expect(denySetOf(member.registry)).toEqual(denySetOf(author.registry))
      expect(authority(member.registry, target.id)).toBe(target.id)
      expect(
        await member.context.authService.validateCredential(
          makeMLSCredential(target),
          target.publicKey,
        ),
      ).toBe(false)
    }
  },
)

test('ordinary Add refuses expired post-reset evidence', async () => {
  const { group, identity, target, log } = await resetRemoved()
  vi.spyOn(Date, 'now').mockReturnValue(210_000)
  const renewed = await renewLeaf(
    group,
    await timedBinding({ identity, iat: 210, exp: 310, prefix: log }),
  )
  const binding = await timedBinding({ identity: target, iat: 150, exp: 200, prefix: log })
  const bundle = await rawBundle(renewed.newGroup, target, binding)
  await expect(
    commitWithEntries({
      group: renewed.newGroup,
      extraProposals: [
        { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
      ],
      enacted: [],
      requireAdmin: false,
    }),
  ).rejects.toMatchObject({ reason: 'lapsed' })
})

test('authentication refuses reset readmission under a different genuine controller', async () => {
  const { group, target } = await resetRemoved()
  const seed = new Uint8Array(32).fill(91)
  const inception = createInception(seed, 0)
  const id = didFromInception(inception.event)
  const prefix = [inception, createReset(seed, 0, 1)]
  const signer = createControllerIdentity({ seed, profile: 0, log: prefix })
  const binding = {
    id,
    prefix,
    capability: stringifyToken(
      await signer.signToken({
        sub: id,
        aud: target.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: target.publicKey }),
        iat: 150,
        exp: 250,
      }),
    ),
  }
  const credential = makeMLSCredential(target, binding)
  expect(
    await createDIDAuthenticationService().validateCredential(credential, target.publicKey),
  ).toBe(true)
  expect(await group.context.authService.validateCredential(credential, target.publicKey)).toBe(
    false,
  )
  const bundle = await rawBundle(group, target, binding)
  await expect(validateEntry(group, bundle.publicPackage.leafNode)).rejects.toMatchObject({
    reason: 'controller-mismatch',
  })
})
