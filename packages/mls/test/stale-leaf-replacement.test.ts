import { normalizeDID, type OwnIdentity } from '@kokuin/token'
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
import { commitInvite, createInvite, processWelcome } from '../src/group.js'
import { commitWithEntries } from '../src/group-commit.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { deriveGroup, type GroupHandle } from '../src/group-handle.js'
import { leafAt } from '../src/lifecycle.js'
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

/** An own-agents group of A, a stale leaf for B whose handle is lost, and a live C. */
async function staleGroup() {
  const setup = await pipelineGroup()
  const bob = agent(51)
  const carol = agent(52)
  const withBob = await lowLevelWelcome(
    setup.group,
    bob,
    await timedBinding({ identity: bob, iat: 100, exp: 200 }),
  )
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
