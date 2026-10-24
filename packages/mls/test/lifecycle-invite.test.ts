import { createRenew, createRotate, epochHeads } from '@kokuin/controller'
import { defaultProposalTypes, encode, mlsMessageEncoder, nodeTypes } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import type { ControllerBinding } from '../src/credential.js'
import {
  commitInvite,
  createInvite,
  exportGroupInfo,
  joinGroupExternal,
  processWelcome,
} from '../src/group.js'
import { commitWithEntries } from '../src/group-commit.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { addDevice } from '../src/group-device.js'
import { deriveGroup } from '../src/group-handle.js'
import { HISTORY_HORIZON, historySize } from '../src/history.js'
import { leafExpiry } from '../src/index.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'
import { isLapsed, treeTime, validateEntry } from '../src/lifecycle.js'
import { verifyLifecycleProof } from '../src/lifecycle-proof.js'
import { DEVICE_ENTRY_TYPE } from '../src/registry.js'
import { buildBoundLeaf } from './fixtures/bound-leaf.js'
import { snapshotForChain } from './fixtures/controller-chain.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { buildBoundKeyPackageBundle, joinBoundDevice } from './fixtures/device-harness.js'
import { controllerSeed, inception } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  controllerID,
  lowLevelWelcome,
  pipelineGroup,
  rawAdd,
  rawBundle,
  rawCommit,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'
import { buildManagementCapability } from './fixtures/management-capability.js'

afterEach(() => vi.restoreAllMocks())

function authorClock(time = 150) {
  vi.spyOn(Date, 'now').mockReturnValue(time * 1000)
}

async function admission(entries: Array<string> = []) {
  authorClock()
  const { group, identity } = await pipelineGroup()
  const bob = agent(61)
  const { invite } = await createInvite({ group, identity, recipientDID: bob.id, entries })
  const { bundle } = await rawAdd(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 100, exp: 200 }),
  )
  return { group, identity, bob, invite, bundle }
}

test('membership and Welcome require a recipient and no role token', async () => {
  const { group, bob, invite, bundle } = await admission()
  const [seed] = structuredClone(group.ledger)
  if (seed == null) throw new Error('Missing seed')
  expect(seed.verified.entry.value).toMatchObject({ op: 'seed' })
  expect(group.ledgerTokens).toEqual([seed.token])
  expect(invite.recipientDID).toBe(bob.id)
  expect(invite.ledgerEntries).toEqual([seed.token])
  const result = await commitInvite(group, bundle.publicPackage, invite)
  const { group: joined } = await processWelcome({
    identity: bob,
    invite,
    welcome: result.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: bob.id },
  })
  expect(joined.listMembers()).toHaveLength(2)
  expect(joined.listMembers().every((member) => member.controller === controllerID)).toBe(true)
  expect(joined.ledgerTokens).toEqual([seed.token])
  expect(joined.ledger).toEqual([seed])
  await expect(
    createInvite({ group: joined, identity: bob, recipientDID: agent(62).id }),
  ).resolves.toBeDefined()
})

test('the recipient binds both commit and Welcome, independent of ledger entries', async () => {
  const { group, bob, invite, bundle } = await admission()
  const other = agent(62)
  const wrong = { ...invite, recipientDID: other.id }
  await expect(commitInvite(group, bundle.publicPackage, wrong)).rejects.toMatchObject({
    name: 'InviteRecipientMismatchError',
    expectedDID: other.id,
    actualDID: bob.id,
  })
  const result = await commitInvite(group, bundle.publicPackage, invite)
  await expect(
    processWelcome({
      identity: bob,
      invite: wrong,
      welcome: result.welcomeMessage,
      keyPackageBundle: { ...bundle, ownerDID: bob.id },
    }),
  ).rejects.toThrow(/recipient/)
})

test('consumer entries ride Add atomically and a concurrent consent loses the epoch race', async () => {
  authorClock()
  const setup = await pipelineGroup()
  const carol = agent(62)
  const { author: group, joined: receiver } = await lowLevelWelcome(
    setup.group,
    carol,
    await timedBinding({ identity: carol, iat: 100, exp: 200 }),
  )
  const bob = agent(61)
  const { bundle } = await rawAdd(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 100, exp: 200 }),
  )
  const token = await signLedgerEntry(setup.identity, {
    type: 'app.consumed',
    groupID: group.groupID,
    subject: bob.id,
    value: 'consent-id',
  })
  setup.tokens.set(ledgerEntryDigest(token), token)
  const { invite } = await createInvite({
    group,
    identity: setup.identity,
    recipientDID: bob.id,
    entries: [token],
  })
  const first = await commitInvite(group, bundle.publicPackage, invite)
  const second = await commitInvite(group, bundle.publicPackage, invite)
  const consumer = await processWelcome({
    identity: bob,
    invite,
    welcome: first.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: bob.id },
  })
  expect(consumer.group.ledgerTokens).toEqual([...group.ledgerTokens, token])
  await receiver.processMessage(first.commitMessage)
  await expect(receiver.processMessage(second.commitMessage)).rejects.toThrow()
  const consentConsumptions = receiver.ledger.filter(
    ({ verified }) => verified.entry.type === 'app.consumed',
  ).length
  expect(consentConsumptions).toBe(1)
  expect(receiver.findMemberLeafIndex(bob.id)).toBeDefined()
  expect(first.newGroup.ledgerTokens).toEqual([...group.ledgerTokens, token])
  const retry = await createInvite({ group: receiver, identity: carol, recipientDID: bob.id })
  expect(retry.invite.ledgerEntries).toEqual([...group.ledgerTokens, token])
})

test('an inviter and consumer issuer need a pre-commit leaf', async () => {
  const { group, identity, bob, invite, bundle } = await admission()
  const [seed] = structuredClone(group.ledger)
  if (seed == null) throw new Error('Missing seed')
  expect(seed.verified.entry.value).toMatchObject({ op: 'seed' })
  expect(group.ledgerTokens).toEqual([seed.token])
  const outsider = agent(62)
  await expect(createInvite({ group, identity: outsider, recipientDID: bob.id })).rejects.toThrow(
    /leaf/,
  )
  const token = await signLedgerEntry(outsider, {
    type: 'app.consumed',
    groupID: group.groupID,
    subject: bob.id,
    value: 'consent-id',
  })
  await expect(
    commitInvite(group, bundle.publicPackage, {
      ...invite,
      ledgerEntries: [...group.ledgerTokens, token],
    }),
  ).rejects.toThrow(/pre-commit/)
  expect(group.ledgerTokens).toEqual([seed.token])
  expect(group.ledger).toEqual([seed])
  expect(group.findMemberLeafIndex(identity.id)).toBeDefined()
})

test('Add refuses floating and malformed bindings and expired author capability', async () => {
  const { group, bob, invite } = await admission()
  const floating = await rawAdd(group, bob)
  await expect(commitInvite(group, floating.bundle.publicPackage, invite)).rejects.toMatchObject({
    reason: 'floating-refused',
  })
  const malformed = await rawAdd(group, bob, {
    ...(await timedBinding({ identity: bob, iat: 100, exp: 200 })),
    id: 'did:key:wrong',
  })
  await expect(commitInvite(group, malformed.bundle.publicPackage, invite)).rejects.toThrow()
  const expired = await rawAdd(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 100, exp: 150 }),
  )
  await expect(commitInvite(group, expired.bundle.publicPackage, invite)).rejects.toThrow(
    /authoring time/,
  )
})

test('Welcome admits a live leaf while preserving a lapsed existing leaf', async () => {
  const { group, bob, invite } = await admission()
  const added = await rawAdd(group, bob, await timedBinding({ identity: bob, iat: 201, exp: 300 }))
  if (added.result.welcome == null) throw new Error('Missing Welcome')
  const { group: joined } = await processWelcome({
    identity: bob,
    invite,
    welcome: encode(mlsMessageEncoder, added.result.welcome),
    keyPackageBundle: { ...added.bundle, ownerDID: bob.id },
  })
  const old = joined.state.ratchetTree[0]
  expect(old?.nodeType).toBe(nodeTypes.leaf)
  expect(joined.listMembers()).toHaveLength(2)
})

test.each([99, 100])('Welcome refuses admitted expiry %s at tree time 100', async (exp) => {
  const { group, bob, invite } = await admission()
  const added = await rawAdd(group, bob, await timedBinding({ identity: bob, iat: 90, exp }))
  if (added.result.welcome == null) throw new Error('Missing Welcome')
  await expect(
    processWelcome({
      identity: bob,
      invite,
      welcome: added.result.welcome.welcome,
      keyPackageBundle: { ...added.bundle, ownerDID: bob.id },
    }),
  ).rejects.toMatchObject({ reason: 'lapsed' })
})

test.each([
  { limit: 86400, lifetime: 86400, accepted: true },
  { limit: 86400, lifetime: 86401, accepted: false },
  { limit: 3600, lifetime: 3600, accepted: true },
  { limit: 3600, lifetime: 3601, accepted: false },
])(
  'public Welcome and external direct and chained child limits: $limit/$lifetime',
  async ({ limit, lifetime, accepted }) => {
    authorClock()
    for (const chained of [false, true]) {
      const { group, identity } = await pipelineGroup({ leafLifetime: limit })
      const bob = agent(61)
      const trusted = agent(71)
      const parent = (await timedBinding({ identity: trusted, iat: 90, exp: 2592090 })).capability
      const binding = await timedBinding({
        identity: bob,
        iat: 100,
        exp: 100 + lifetime,
        ...(chained ? { parent, issuer: trusted } : {}),
      })
      const { invite } = await createInvite({ group, identity, recipientDID: bob.id })
      const added = await rawAdd(group, bob, binding)
      if (added.result.welcome == null) throw new Error('Missing Welcome')
      const welcome = processWelcome({
        identity: bob,
        invite,
        welcome: added.result.welcome.welcome,
        keyPackageBundle: { ...added.bundle, ownerDID: bob.id },
      })
      if (accepted) await expect(welcome).resolves.toBeDefined()
      else await expect(welcome).rejects.toMatchObject({ reason: 'lifetime-cap' })
      const { author, joined } = await lowLevelWelcome(
        group,
        bob,
        await timedBinding({ identity: bob, iat: 90, exp: 200 }),
      )
      const { groupInfo } = await exportGroupInfo({ group: author })
      const external = joinGroupExternal({
        identity: bob,
        groupInfo,
        credential: joined.credential,
        controller: binding,
        resync: true,
      })
      if (accepted) {
        const result = await external
        await expect(author.processMessage(result.commitMessage)).resolves.toBeNull()
      } else await expect(external).rejects.toMatchObject({ reason: 'lifetime-cap' })
    }
  },
)

test.each([
  { limit: 2592000, lifetime: 2592000, accepted: true },
  { limit: 2592000, lifetime: 2592001, accepted: false },
  { limit: 86400, lifetime: 86400, accepted: true },
  { limit: 86400, lifetime: 86401, accepted: false },
])(
  'public Welcome and external trusted grant limits: $limit/$lifetime',
  async ({ limit, lifetime, accepted }) => {
    authorClock()
    const { group, identity } = await pipelineGroup({ trustedGrantLifetime: limit })
    const bob = agent(61)
    const trusted = agent(71)
    const parent = (await timedBinding({ identity: trusted, iat: 90, exp: 90 + lifetime }))
      .capability
    const binding = await timedBinding({
      identity: bob,
      iat: 100,
      exp: 200,
      parent,
      issuer: trusted,
    })
    const { invite } = await createInvite({ group, identity, recipientDID: bob.id })
    const added = await rawAdd(group, bob, binding)
    if (added.result.welcome == null) throw new Error('Missing Welcome')
    const welcome = processWelcome({
      identity: bob,
      invite,
      welcome: added.result.welcome.welcome,
      keyPackageBundle: { ...added.bundle, ownerDID: bob.id },
    })
    if (accepted) await expect(welcome).resolves.toBeDefined()
    else await expect(welcome).rejects.toMatchObject({ reason: 'lifetime-cap' })
    const { author, joined } = await lowLevelWelcome(
      group,
      bob,
      await timedBinding({ identity: bob, iat: 90, exp: 200 }),
    )
    const { groupInfo } = await exportGroupInfo({ group: author })
    const external = joinGroupExternal({
      identity: bob,
      groupInfo,
      credential: joined.credential,
      controller: binding,
      resync: true,
    })
    if (accepted) await expect(external).resolves.toBeDefined()
    else await expect(external).rejects.toMatchObject({ reason: 'lifetime-cap' })
  },
)

test.each(['floating', 'foreign', 'malformed'] as const)(
  'Welcome and GroupInfo authenticate a pre-existing %s leaf',
  async (kind) => {
    authorClock()
    const { group, identity } = await pipelineGroup()
    const own = group.state.ratchetTree[0]
    if (own?.nodeType !== nodeTypes.leaf) throw new Error('Missing creator')
    const binding = await timedBinding({ identity, iat: 100, exp: 200 })
    own.leaf.credential = makeMLSCredential(
      identity,
      kind === 'floating'
        ? undefined
        : { ...binding, id: kind === 'foreign' ? 'did:kokuin:foreign' : 'did:key:wrong' },
    )
    const invalid = deriveGroup(group, (await rawCommit({ group })).newState)
    const bob = agent(61)
    const added = await rawAdd(
      invalid,
      bob,
      await timedBinding({ identity: bob, iat: 100, exp: 200 }),
    )
    if (added.result.welcome == null) throw new Error('Missing Welcome')
    const invite = {
      groupID: group.groupID,
      inviterID: identity.id,
      recipientDID: bob.id,
      ledgerEntries: [],
    }
    await expect(
      processWelcome({
        identity: bob,
        invite,
        welcome: added.result.welcome.welcome,
        keyPackageBundle: { ...added.bundle, ownerDID: bob.id },
      }),
    ).rejects.toThrow()
    const { groupInfo } = await exportGroupInfo({ group: invalid })
    await expect(
      joinGroupExternal({
        identity,
        groupInfo,
        credential: group.credential,
        controller: binding,
        resync: true,
      }),
    ).rejects.toThrow()
  },
)

test("Welcome refuses a recipient using another member's joining key package", async () => {
  const { group, bob, invite } = await admission()
  const other = agent(62)
  const added = await rawAdd(
    group,
    other,
    await timedBinding({ identity: other, iat: 100, exp: 200 }),
  )
  if (added.result.welcome == null) throw new Error('Missing Welcome')
  await expect(
    processWelcome({
      identity: bob,
      invite,
      welcome: added.result.welcome.welcome,
      keyPackageBundle: { ...added.bundle, ownerDID: other.id },
    }),
  ).rejects.toThrow(/recipient/)
})

test.each([
  { iat: 100, exp: 151 },
  { iat: 152, exp: 200 },
])('standard addDevice rejects author time $iat/$exp', async ({ iat, exp }) => {
  authorClock()
  const setup = await joinBoundDevice()
  vi.mocked(Date.now).mockReturnValue(151000)
  const seed = new Uint8Array(32).fill(43)
  const leaf = await buildBoundLeaf({ deviceSeed: seed, capabilityOverrides: { iat, exp } })
  const bundle = await buildBoundKeyPackageBundle(leaf, seed)
  const { capability } = await buildManagementCapability({
    managerDID: setup.deviceID,
    managerKey: setup.deviceIdentity.publicKey,
  })
  const previous = setup.deviceGroup.state
  await expect(
    addDevice(setup.deviceGroup, setup.deviceIdentity, {
      keyPackage: bundle.publicPackage,
      device: leaf.deviceID,
      controller: setup.controllerID,
      capability,
    }),
  ).rejects.toThrow(/authoring time/)
  expect(setup.deviceGroup.state).toBe(previous)
})

async function oversizedJoinGroup() {
  authorClock()
  const setup = await pipelineGroup()
  const rotation = createRotate({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    snapshot: snapshotForChain(controllerID, [inception]),
    seal: 'h'.repeat(210000),
  })
  const prefix = [inception, rotation]
  let group = setup.group
  for (let index = 0; index < 3; index++) {
    const identity = agent(80 + index)
    const fixture = await lowLevelWelcome(
      group,
      identity,
      await timedBinding({
        identity,
        iat: index === 0 ? 102 : 100,
        exp: index === 2 ? 101 : 300,
        prefix,
      }),
    )
    group = fixture.author
  }
  expect(historySize(group.state.ratchetTree, [])).toBeGreaterThan(HISTORY_HORIZON)
  return { group, identity: setup.identity, target: agent(82) }
}

test('external replacement may shrink history while remaining above the horizon', async () => {
  const { group, target } = await oversizedJoinGroup()
  const sizeBefore = historySize(group.state.ratchetTree, [])
  const { groupInfo } = await exportGroupInfo({ group })
  const result = await joinGroupExternal({
    identity: target,
    groupInfo,
    credential: { id: target.id, groupID: group.groupID },
    resync: true,
    controller: await timedBinding({ identity: target, iat: 150, exp: 300 }),
  })
  const sizeAfter = historySize(result.group.state.ratchetTree, [])
  expect(sizeAfter).toBeGreaterThan(HISTORY_HORIZON)
  expect(sizeAfter).toBeLessThan(sizeBefore)
  await group.processMessage(result.commitMessage)
  expect(group.epoch).toBe(result.group.epoch)
  expect(group.state.groupContext.treeHash).toEqual(result.group.state.groupContext.treeHash)
  expect(historySize(group.state.ratchetTree, [])).toBe(sizeAfter)
})

test('Welcome may join a shrinking Remove and Add above the horizon', async () => {
  const { group, identity, target } = await oversizedJoinGroup()
  const sizeBefore = historySize(group.state.ratchetTree, [])
  const bob = agent(61)
  const { invite } = await createInvite({ group, identity, recipientDID: bob.id })
  const added = await rawAdd(group, bob, await timedBinding({ identity: bob, iat: 102, exp: 300 }))
  const removed = group.findMemberLeafIndex(target.id)
  if (removed == null) throw new Error('Missing target')
  const result = await commitWithEntries({
    group,
    extraProposals: [
      { proposalType: defaultProposalTypes.remove, remove: { removed } },
      { proposalType: defaultProposalTypes.add, add: { keyPackage: added.bundle.publicPackage } },
    ],
    enacted: [],
    ratchetTreeExtension: true,
  })
  if (result.welcome == null) throw new Error('Missing Welcome')
  const sizeAfter = historySize(result.newState.ratchetTree, [])
  expect(sizeAfter).toBeGreaterThan(HISTORY_HORIZON)
  expect(sizeAfter).toBeLessThan(sizeBefore)
  const { group: joined } = await processWelcome({
    identity: bob,
    invite,
    welcome: encode(mlsMessageEncoder, result.welcome),
    keyPackageBundle: { ...added.bundle, ownerDID: bob.id },
  })
  expect(joined.state.groupContext.treeHash).toEqual(result.newState.groupContext.treeHash)
  expect(joined.epoch).toBe(result.newState.groupContext.epoch)
  expect(historySize(joined.state.ratchetTree, [])).toBe(sizeAfter)
  expect(joined.findMemberLeafIndex(target.id)).toBeUndefined()
  expect(joined.findMemberLeafIndex(bob.id)).toBeDefined()
})

test('the commit gate still refuses growing history above the horizon', async () => {
  const { group } = await oversizedJoinGroup()
  const added = await rawAdd(
    group,
    agent(61),
    await timedBinding({ identity: agent(61), iat: 102, exp: 300 }),
  )
  expect(historySize(added.result.newState.ratchetTree, [])).toBeGreaterThan(
    historySize(group.state.ratchetTree, []),
  )
  const previous = group.state
  await expect(group.processMessage(added.message)).rejects.toMatchObject({ reason: 'binding' })
  expect(group.state).toBe(previous)
  await expect(
    commitWithEntries({
      group,
      extraProposals: [
        { proposalType: defaultProposalTypes.add, add: { keyPackage: added.bundle.publicPackage } },
      ],
      enacted: [],
    }),
  ).rejects.toMatchObject({ reason: 'history-horizon' })
  expect(group.state).toBe(previous)
})

async function membershipLeaf(lease = 1000) {
  authorClock()
  const epoch = await buildEpoch({ members: 1, renewEvery: lease })
  const member = epoch.members[0]
  if (member == null) throw new Error('Missing member')
  const { group, identity } = await pipelineGroup({ controllerLog: epoch.log })
  const binding: ControllerBinding = {
    id: epoch.did,
    prefix: epoch.log.chain,
    member: { add: member.add, g: epoch.head.gen },
    iat: 9_000_000,
  }
  const leaf = (await rawBundle(group, member.identity, binding)).publicPackage.leafNode
  group.state.ratchetTree.push(undefined, { nodeType: nodeTypes.leaf, leaf })
  const floor = (time: number) => {
    const projection = group.registry.controllers.get(epoch.did)
    if (projection == null) throw new Error('Missing projection')
    Object.assign(projection, { timeFloor: time })
  }
  return { ...epoch, group, identity, member, binding, leaf, floor }
}

test('membership leaf lapses at its lease end by tree time', async () => {
  const f = await membershipLeaf()
  expect(leafExpiry(f.binding, f.group.registry, f.did)).toBe(1000)
  f.floor(1000)
  expect(isLapsed(f.group, f.leaf)).toBe(false)
  await expect(validateEntry(f.group, f.leaf)).rejects.toMatchObject({ reason: 'lapsed' })
  f.floor(1001)
  expect(isLapsed(f.group, f.leaf)).toBe(true)
})

test('renewal reaches a membership leaf through a log entry', async () => {
  const f = await membershipLeaf()
  const renew = createRenew({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: f.root,
    add: f.member.add,
    lease: 2000,
  })
  await f.group.applyLedgerEntries([
    await signLedgerEntry(f.identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: f.group.groupID,
      subject: f.did,
      value: { op: 'log', proof: { chain: [], events: [renew] } },
    }),
  ])
  f.floor(1500)
  expect(leafExpiry(f.binding, f.group.registry, f.did)).toBe(2000)
  expect(isLapsed(f.group, f.leaf)).toBe(false)
  await expect(validateEntry(f.group, f.leaf)).resolves.toBeUndefined()
})

test('phone member keeps its leaf 30 days on a 90-day lease', async () => {
  const f = await membershipLeaf(7_776_000)
  f.floor(2_592_000)
  expect(isLapsed(f.group, f.leaf)).toBe(false)
  await expect(validateEntry(f.group, f.leaf)).resolves.toBeUndefined()
})

test('membership leaf attests no tree time', async () => {
  const f = await membershipLeaf()
  expect(treeTime(f.group, f.did)).toBe(100)
  await expect(
    verifyLifecycleProof(f.group, {
      issuer: f.identity.id,
      entry: {
        type: DEVICE_ENTRY_TYPE,
        groupID: f.group.groupID,
        subject: f.did,
        value: { op: 'clock', time: 101 },
      },
    }),
  ).rejects.toMatchObject({ reason: 'effects-mismatch' })
})

test('an unavailable membership lease keeps existing leaves and refuses admission', async () => {
  const f = await membershipLeaf()
  ;(f.group.registry.controllers as Map<string, unknown>).clear()
  expect(leafExpiry(f.binding, f.group.registry, f.did)).toBeUndefined()
  expect(isLapsed(f.group, f.leaf)).toBe(false)
  await expect(validateEntry(f.group, f.leaf)).rejects.toMatchObject({
    reason: 'member-unavailable',
  })
})
