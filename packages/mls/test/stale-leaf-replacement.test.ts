import { createAdd, digestOf, encodeKey, foldLog } from '@kokuin/controller'
import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type DefaultProposal,
  defaultProposalTypes,
  encode,
  generateKeyPackageWithKey,
  type KeyPackage,
  mlsMessageEncoder,
  nodeTypes,
} from 'ts-mls'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ControllerBinding } from '../src/credential.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'
import { commitWithEntries } from '../src/group-commit.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { deriveGroup, type GroupHandle } from '../src/group-handle.js'
import { bindingIssuedAt } from '../src/index.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'
import { leafAt, validateEntry } from '../src/lifecycle.js'
import { assertNewerBinding } from '../src/stale-leaf.js'
import { controllerID, controllerSeed, inception } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  lowLevelWelcome,
  pipelineGroup,
  rawBundle,
  rawCommit,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(150_000))
afterEach(() => vi.restoreAllMocks())

const utf8 = new TextEncoder()

test('assertNewerBinding orders a membership binding against a capability binding by bindingIssuedAt', async () => {
  const { group, identity } = await pipelineGroup()
  const capability = await timedBinding({ identity, iat: 100, exp: 200 })
  const membership: ControllerBinding = {
    id: capability.id,
    prefix: capability.prefix,
    member: { add: 'member-add', g: 0 },
    iat: 120,
  }
  const old = (await rawBundle(group, identity, capability)).publicPackage.leafNode
  const next = { ...old, credential: makeMLSCredential(identity, membership) }
  expect(bindingIssuedAt(capability)).toBe(100)
  expect(bindingIssuedAt(membership)).toBe(120)
  expect(() => assertNewerBinding(next, old)).not.toThrow()
  expect(() => assertNewerBinding(old, next)).toThrow(
    expect.objectContaining({ reason: 'renewal-order' }),
  )
  expect(() => assertNewerBinding(next, next)).toThrow(
    expect.objectContaining({ reason: 'renewal-order' }),
  )
})

/** An own-agents group of A, a stale leaf for B whose handle is lost, and a live C. */
async function staleGroup(bobIssuedAt = 100) {
  const setup = await pipelineGroup()
  const bob = agent(51)
  const carol = agent(52)
  const bobBinding = await timedBinding({ identity: bob, iat: bobIssuedAt, exp: 200 })
  const withBob = await lowLevelWelcome(setup.group, bob, bobBinding)
  const withCarol = await lowLevelWelcome(
    withBob.author,
    carol,
    await timedBinding({ identity: carol, iat: 100, exp: 200 }),
  )
  const author = withCarol.author
  const staleIndex = author.findMemberLeafIndex(bob.id)
  if (staleIndex == null) throw new Error('Missing stale leaf')
  const { invite } = await createInvite({
    group: author,
    identity: setup.identity,
    recipientDID: bob.id,
  })
  return {
    ...setup,
    author,
    bob,
    bobBinding,
    carol,
    carolGroup: withCarol.joined,
    invite,
    staleIndex,
  }
}

function leavesOf(group: GroupHandle, did: string) {
  return group.listMembers().filter(({ id }) => normalizeDID(id) === normalizeDID(did))
}

function replacement(staleIndex: number, keyPackage: KeyPackage): Array<DefaultProposal> {
  return [
    { proposalType: defaultProposalTypes.remove, remove: { removed: staleIndex } },
    { proposalType: defaultProposalTypes.add, add: { keyPackage } },
  ]
}

/** A key package naming `holder` and `binding`, signed by `signer`. */
async function packageFor(
  group: GroupHandle,
  holder: OwnIdentity,
  binding: ControllerBinding,
  signer: OwnIdentity,
) {
  const own = group.state.ratchetTree[0]
  return generateKeyPackageWithKey({
    credential: makeMLSCredential(holder, binding),
    signatureKeyPair: { signKey: signer.privateKey, publicKey: signer.publicKey },
    cipherSuite: group.context.cipherSuite,
    capabilities: own?.nodeType === nodeTypes.leaf ? own.leaf.capabilities : undefined,
  })
}

test('admitting a fresh key package replaces the stale leaf of the same DID', async () => {
  const { author, bob, carol, carolGroup, invite, staleIndex } = await staleGroup()
  const bundle = await rawBundle(
    author,
    bob,
    await timedBinding({ identity: bob, iat: 120, exp: 200 }),
  )
  const result = await commitInvite(author, bundle.publicPackage, invite)

  for (const group of [result.newGroup]) {
    expect(leavesOf(group, bob.id)).toHaveLength(1)
    const index = group.findMemberLeafIndex(bob.id)
    expect(index).toBeDefined()
    expect(leafAt(group.state.ratchetTree, index ?? -1)?.hpkePublicKey).toEqual(
      bundle.publicPackage.leafNode.hpkePublicKey,
    )
  }
  await expect(carolGroup.processMessage(result.commitMessage)).resolves.toBeNull()
  expect(carolGroup.epoch).toBe(result.newGroup.epoch)
  expect(leavesOf(carolGroup, bob.id)).toHaveLength(1)
  expect(
    leafAt(carolGroup.state.ratchetTree, carolGroup.findMemberLeafIndex(bob.id) ?? -1)
      ?.hpkePublicKey,
  ).toEqual(bundle.publicPackage.leafNode.hpkePublicKey)
  expect(carolGroup.listMembers()).toHaveLength(3)
  expect(staleIndex).toBeGreaterThan(0)

  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: result.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: bob.id },
  })
  expect(bobGroup.epoch).toBe(result.newGroup.epoch)
  const fromBob = await bobGroup.encrypt(utf8.encode('back again'))
  for (const receiver of [result.newGroup, carolGroup]) {
    const opened = await receiver.decrypt(fromBob)
    expect(new TextDecoder().decode(opened.payload)).toBe('back again')
    expect(opened.senderDID).toBe(bob.id)
  }
  const fromCarol = await carolGroup.encrypt(utf8.encode('welcome back'))
  const opened = await bobGroup.decrypt(fromCarol)
  expect(new TextDecoder().decode(opened.payload)).toBe('welcome back')
  expect(opened.senderDID).toBe(carol.id)
})

test('the delivered input invite includes the stale replacement preservation clock', async () => {
  const f = await staleGroup(140)
  const parent = f.author.bindingOfDID(f.identity.id)?.capability
  if (parent == null) throw new Error('Missing inviter capability')
  const bundle = await rawBundle(
    f.author,
    f.bob,
    await timedBinding({ identity: f.bob, iat: 145, exp: 200, parent, issuer: f.identity }),
  )
  const before = [...f.invite.ledgerEntries]
  const result = await commitInvite(f.author, bundle.publicPackage, f.invite)
  const clock = await signLedgerEntry(f.identity, {
    type: 'kumiai.device',
    groupID: f.author.groupID,
    subject: controllerID,
    value: { op: 'clock', time: 140 },
  })
  expect(result.newGroup.ledgerTokens).toEqual([...before, clock])
  for (const token of f.invite.ledgerEntries) f.tokens.set(ledgerEntryDigest(token), token)
  const { group: joined } = await processWelcome({
    identity: f.bob,
    invite: f.invite,
    welcome: result.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: f.bob.id },
  })
  expect(result.invite).toBe(f.invite)
  expect(joined.ledgerTokens).toEqual([...before, clock])
  expect(joined.registry.controllers.get(controllerID)?.timeFloor).toBe(140)
  await f.carolGroup.processMessage(result.commitMessage)
  expect(f.carolGroup.registry).toEqual(joined.registry)
  const payload = utf8.encode('replacement with preserved time')
  await expect(f.carolGroup.decrypt(await joined.encrypt(payload))).resolves.toMatchObject({
    payload,
    senderDID: f.bob.id,
  })
})

function admissionsOf(group: GroupHandle): Array<string> {
  return group.listMembers().flatMap(({ admission }) => (admission == null ? [] : [admission]))
}

test("a replacement brings a fresh admission; the re-added member's own path only drops it", async () => {
  const { author, bob, carolGroup, invite } = await staleGroup()
  const before = admissionsOf(carolGroup)
  const bundle = await rawBundle(
    author,
    bob,
    await timedBinding({ identity: bob, iat: 120, exp: 200 }),
  )
  const result = await commitInvite(author, bundle.publicPackage, invite)
  await carolGroup.processMessage(result.commitMessage)

  // The DID set did not move; the fresh KeyPackage leaf is what says a leaf was Added.
  for (const group of [result.newGroup, carolGroup]) {
    expect(new Set(group.listMembers().map(({ id }) => normalizeDID(id)))).toEqual(
      new Set(carolGroup.listMembers().map(({ id }) => normalizeDID(id))),
    )
    const fresh = admissionsOf(group).filter((admission) => !before.includes(admission))
    expect(fresh).toHaveLength(1)
    expect(leavesOf(group, bob.id)[0]?.admission).toBe(fresh[0])
  }

  // Bob's first commit is a path, not an Add: his admission leaves the tree and none enters it.
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: result.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: bob.id },
  })
  const replaced = admissionsOf(carolGroup)
  const path = await commitWithEntries({ group: bobGroup, extraProposals: [], enacted: [] })
  await carolGroup.processMessage(encode(mlsMessageEncoder, path.commit))
  expect(carolGroup.epoch).toBe(result.newGroup.epoch + 1n)
  expect(admissionsOf(carolGroup).filter((admission) => !replaced.includes(admission))).toEqual([])
  expect(leavesOf(carolGroup, bob.id)[0]?.admission).toBeUndefined()
})

test('a Remove paired with an Add of a different DID stays unauthorised', async () => {
  const { author, carolGroup, staleIndex } = await staleGroup()
  const dave = agent(53)
  const bundle = await rawBundle(
    author,
    dave,
    await timedBinding({ identity: dave, iat: 120, exp: 200 }),
  )
  const proposals = replacement(staleIndex, bundle.publicPackage)
  await expect(
    commitWithEntries({ group: author, extraProposals: proposals, enacted: [] }),
  ).rejects.toThrow('Unauthorised Remove')
  const forged = await rawCommit({ group: author, proposals })
  const snapshot = structuredClone(carolGroup.state)
  await expect(
    carolGroup.processMessage(encode(mlsMessageEncoder, forged.commit)),
  ).rejects.toMatchObject({ name: 'CommitRejectedError', reason: 'invalid' })
  expect(carolGroup.state).toEqual(snapshot)
})

test.each([
  {
    name: 'a key the DID does not hold',
    build: async (group: GroupHandle, bob: OwnIdentity) =>
      packageFor(group, bob, await timedBinding({ identity: bob, iat: 120, exp: 200 }), agent(66)),
    reason: 'identity-change',
  },
  {
    name: 'a controller binding for another DID',
    build: async (group: GroupHandle, bob: OwnIdentity) =>
      packageFor(group, bob, await timedBinding({ identity: agent(52), iat: 120, exp: 200 }), bob),
    reason: 'audience-mismatch',
  },
  {
    name: 'a binding older than the stale leaf',
    build: async (group: GroupHandle, bob: OwnIdentity) =>
      packageFor(group, bob, await timedBinding({ identity: bob, iat: 90, exp: 200 }), bob),
    reason: 'renewal-order',
  },
])('a replacement with $name is refused', async ({ build, reason }) => {
  const { author, bob, carolGroup, invite, staleIndex } = await staleGroup()
  const bundle = await build(author, bob)
  const authorSnapshot = structuredClone(author.state)
  await expect(commitInvite(author, bundle.publicPackage, invite)).rejects.toMatchObject({
    name: 'LeafBindingError',
    reason,
  })
  expect(author.state).toEqual(authorSnapshot)

  const forged = await rawCommit({
    group: author,
    proposals: replacement(staleIndex, bundle.publicPackage),
  })
  const snapshot = structuredClone(carolGroup.state)
  const rejected = await carolGroup.processMessage(encode(mlsMessageEncoder, forged.commit)).then(
    () => null,
    (error: unknown) => error,
  )
  expect(rejected).toMatchObject({ name: 'CommitRejectedError' })
  expect((rejected as Error).cause).toMatchObject({ name: 'LeafBindingError', reason })
  expect(carolGroup.state).toEqual(snapshot)
  expect(carolGroup.findMemberLeafIndex(bob.id)).toBe(staleIndex)
})

test("a key package under the live leaf's own binding cannot evict that leaf", async () => {
  const { author, bob, bobBinding, carolGroup, invite, staleIndex } = await staleGroup()
  const bundle = await rawBundle(author, bob, bobBinding)
  const authorSnapshot = structuredClone(author.state)
  await expect(commitInvite(author, bundle.publicPackage, invite)).rejects.toMatchObject({
    name: 'LeafBindingError',
    reason: 'renewal-order',
  })
  expect(author.state).toEqual(authorSnapshot)

  const forged = await rawCommit({
    group: author,
    proposals: replacement(staleIndex, bundle.publicPackage),
  })
  const snapshot = structuredClone(carolGroup.state)
  const rejected = await carolGroup.processMessage(encode(mlsMessageEncoder, forged.commit)).then(
    () => null,
    (error: unknown) => error,
  )
  expect(rejected).toMatchObject({ name: 'CommitRejectedError' })
  expect((rejected as Error).cause).toMatchObject({
    name: 'LeafBindingError',
    reason: 'renewal-order',
  })
  expect(carolGroup.state).toEqual(snapshot)
  expect(carolGroup.findMemberLeafIndex(bob.id)).toBe(staleIndex)
})

test('a group without a lifecycle controller still refuses re-adding a present DID', async () => {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error('Missing test token')
      return token
    })
  const { group: created } = await createGroup(alice, 'stale-leaf-standard', {
    resolveLedgerEntries,
  })
  const first = await createInvite({
    group: created,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  for (const token of first.invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
  const added = await commitInvite(
    created,
    (await createKeyPackageBundle(bob)).publicPackage,
    first.invite,
  )
  const group = added.newGroup
  expect(group.anchor.controller).toBeUndefined()
  expect(leavesOf(group, bob.id)).toHaveLength(1)
  const second = await createInvite({
    group,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  const snapshot = structuredClone(group.state)
  await expect(
    commitInvite(group, (await createKeyPackageBundle(bob)).publicPackage, second.invite),
  ).rejects.toThrow('Commit cannot contain an Add proposal for someone already in the group')
  expect(group.state).toEqual(snapshot)
  expect(leavesOf(group, bob.id)).toHaveLength(1)
})

test('two leaves for the admitted DID are refused as ambiguous', async () => {
  const { author, bob, carol, invite, staleIndex } = await staleGroup()
  const carolIndex = author.findMemberLeafIndex(carol.id)
  if (carolIndex == null) throw new Error('Missing leaf')
  const tree = author.state.ratchetTree.slice()
  tree[carolIndex * 2] = tree[staleIndex * 2]
  const duplicated = deriveGroup(author, { ...author.state, ratchetTree: tree })
  expect(leavesOf(duplicated, bob.id)).toHaveLength(2)
  const bundle = await rawBundle(
    author,
    bob,
    await timedBinding({ identity: bob, iat: 120, exp: 200 }),
  )
  await expect(commitInvite(duplicated, bundle.publicPackage, invite)).rejects.toMatchObject({
    name: 'DuplicateMemberLeafError',
  })
  await expect(
    commitWithEntries({
      group: duplicated,
      extraProposals: replacement(staleIndex, bundle.publicPackage),
      enacted: [],
    }),
  ).rejects.toThrow('Unauthorised Remove')
})

async function staleMembership() {
  const f = await staleGroup()
  const folded = foldLog(controllerID, { chain: [inception], events: [] })
  if (!folded.ok) throw new Error(folded.reason)
  const add = createAdd({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    head: folded.head,
    parents: [folded.head.epoch],
    member: { did: f.bob.id, key: encodeKey(f.bob.publicKey, 'EdDSA'), lease: 1000 },
  })
  await f.author.applyLedgerEntries([
    await signLedgerEntry(f.identity, {
      type: 'kumiai.device',
      groupID: f.author.groupID,
      subject: controllerID,
      value: { op: 'log', proof: { chain: [], events: [add] } },
    }),
  ])
  const binding: ControllerBinding = {
    id: controllerID,
    prefix: [inception],
    member: { add: digestOf(add.event), g: 0 },
    iat: 100,
  }
  const old = leafAt(f.author.state.ratchetTree, f.staleIndex)
  if (old == null) throw new Error('Missing stale leaf')
  old.credential = makeMLSCredential(f.bob, binding)
  const { invite } = await createInvite({
    group: f.author,
    identity: f.identity,
    recipientDID: f.bob.id,
  })
  return { ...f, binding, old, invite }
}

test('membership key package replaces a stale leaf only when newer', async () => {
  const f = await staleMembership()
  for (const iat of [90, 100, 120]) {
    const bundle = await rawBundle(f.author, f.bob, { ...f.binding, iat })
    const result = commitInvite(f.author, bundle.publicPackage, f.invite)
    if (iat <= 100) await expect(result).rejects.toMatchObject({ reason: 'renewal-order' })
    else {
      const { newGroup } = await result
      expect(leavesOf(newGroup, f.bob.id)).toHaveLength(1)
      expect(newGroup.bindingOfDID(f.bob.id)).toMatchObject({ member: f.binding.member, iat })
    }
  }
})

test('membership renewal with an older iat is refused', async () => {
  const f = await staleMembership()
  const leaf = (await rawBundle(f.author, f.bob, { ...f.binding, iat: 99 })).publicPackage.leafNode
  await expect(validateEntry(f.author, leaf, f.old)).rejects.toMatchObject({
    reason: 'renewal-order',
  })
})
