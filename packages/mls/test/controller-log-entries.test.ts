import { audienceConfirmation } from '@kokuin/capability'
import {
  type ControllerLog,
  createControllerIdentity,
  createInception,
  createRemove,
  createRenew,
  createReset,
  createRevoke,
  createRotate,
  didFromInception,
  digestOf,
  epochHeads,
  snapshotOf,
} from '@kokuin/controller'
import { type OwnIdentity, stringifyToken } from '@kokuin/token'
import { defaultProposalTypes, encode, joinGroup, mlsMessageEncoder, nodeTypes } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import type { JudgingContext } from '../src/authentication.js'
import { foldControllerLog } from '../src/controller-log.js'
import type { ControllerBinding } from '../src/credential.js'
import { commitWithEntries } from '../src/group-commit.js'
import { deviceDenyHolderFor, resolveMlsContext, withJudging } from '../src/group-context.js'
import { createGroup } from '../src/group-create.js'
import { deriveGroup, GroupHandle } from '../src/group-handle.js'
import { computeHead, extendHead, genesisHead, readLedgerHead } from '../src/head.js'
import * as api from '../src/index.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'
import * as lifecycle from '../src/lifecycle.js'
import { leafAt, validateEntry } from '../src/lifecycle.js'
import { verifyLifecycleProof } from '../src/lifecycle-proof.js'
import { DEVICE_ENTRY_TYPE, recordedLogOf } from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import {
  agent,
  lowLevelWelcome,
  rawBundle,
  rawCommit,
  rawUpdate,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

afterEach(() => vi.restoreAllMocks())

test.each(['first', 'second'] as const)(
  'judging scopes stay isolated when %s finishes first',
  async (finishesFirst) => {
    const f = await fixture()
    const context = f.group.context
    const holder = deviceDenyHolderFor(context)
    if (holder == null) throw new Error('Missing holder')
    const previous = { judging: holder.judging, provider: holder.provider }
    const denied = {
      ...f.group.registry,
      devices: new Map([[f.identity.id, { controller: f.did, status: 'revoked' as const }]]),
    }
    const judgements: Array<JudgingContext> = [
      { registry: denied, stage: 'full', mode: 'admit' },
      { registry: f.group.registry, stage: 'full', mode: 'retain' },
    ]
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const scopes = judgements.map((judging, index) =>
      withJudging(context, judging, async (scoped) => {
        await gates[index]?.promise
        const leaf = leafAt(f.group.state.ratchetTree, 0)
        if (leaf == null) throw new Error('Missing leaf')
        return {
          judging: deviceDenyHolderFor(scoped)?.judging?.(),
          denied: deviceDenyHolderFor(scoped)?.provider(),
          valid: await scoped.authService.validateCredential(
            leaf.credential,
            leaf.signaturePublicKey,
          ),
        }
      }),
    )
    const during = { judging: holder.judging, provider: holder.provider }
    const first = finishesFirst === 'first' ? 0 : 1
    gates[first]?.resolve()
    const finished = await scopes[first]
    const between = { judging: holder.judging, provider: holder.provider }
    gates[1 - first]?.resolve()
    const results = await Promise.all(scopes)
    expect(finished).toEqual(results[first])
    expect(results).toEqual([
      { judging: judgements[0], denied: new Set([f.identity.id]), valid: false },
      { judging: judgements[1], denied: new Set(), valid: true },
    ])
    expect(during).toEqual(previous)
    expect(between).toEqual(previous)
    expect({ judging: holder.judging, provider: holder.provider }).toEqual(previous)
  },
)

test('a throwing judging scope leaves the original context unchanged', async () => {
  const f = await fixture()
  const holder = deviceDenyHolderFor(f.group.context)
  if (holder == null) throw new Error('Missing holder')
  const previous = { judging: holder.judging, provider: holder.provider }
  const failure = new Error('Judging failed')
  await expect(
    withJudging(f.group.context, { stage: 'structural', mode: 'admit' }, async () => {
      throw failure
    }),
  ).rejects.toBe(failure)
  expect({ judging: holder.judging, provider: holder.provider }).toEqual(previous)
})

function head(did: string, log: ControllerLog) {
  const folded = foldControllerLog(did, log)
  if (!folded.ok) throw new Error(folded.reason)
  return folded.head
}

async function fixture({ members = 1, creatorMember = false } = {}) {
  vi.spyOn(Date, 'now').mockReturnValue(150000)
  const epoch = await buildEpoch({ members })
  const member = epoch.members[0]
  if (member == null) throw new Error('Missing member')
  const identity = creatorMember ? member.identity : agent(41)
  const binding: ControllerBinding = creatorMember
    ? { id: epoch.did, prefix: epoch.log.chain, member: { add: member.add, g: 0 }, iat: 100 }
    : await timedBinding({ identity, iat: 100, exp: 900 })
  const tokens = new Map<string, string>()
  const { group } = await createGroup(identity, 'controller-logs', {
    controller: binding,
    controllerLog: epoch.log,
    resolveLedgerEntries: async (ids) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error('Missing token')
        return token
      }),
  })
  const publish = (entries: Array<string>) => {
    for (const token of entries) tokens.set(ledgerEntryDigest(token), token)
  }
  return { ...epoch, group, identity, binding, member, publish }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function grant(f: Fixture, identity: OwnIdentity, exp = 800): Promise<ControllerBinding> {
  return {
    id: f.did,
    prefix: f.log.chain,
    capability: stringifyToken(
      await f.member.identity.signToken({
        sub: f.did,
        aud: identity.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: identity.publicKey }),
        iat: 150,
        exp,
        mbr: { add: f.member.add, g: 0 },
      }),
    ),
  }
}

function renewed(f: Fixture): ControllerLog {
  return {
    chain: f.log.chain,
    events: [
      ...f.log.events,
      createRenew({
        did: f.did,
        head: head(f.did, f.log),
        parents: epochHeads(f.did, f.log),
        signer: f.root,
        add: f.member.add,
        lease: 2000,
      }),
    ],
  }
}

async function logToken(f: Fixture, proof: ControllerLog, op: 'log' | 'seed' = 'log') {
  return signLedgerEntry(f.identity, {
    type: DEVICE_ENTRY_TYPE,
    groupID: f.group.groupID,
    subject: f.did,
    value: { op, proof },
  })
}

async function receiver(f: Fixture) {
  const identity = agent(61)
  return lowLevelWelcome(f.group, identity, await timedBinding({ identity, iat: 100, exp: 900 }))
}

test('createGroup with a membership creator seeds the registry from controllerLog', async () => {
  const f = await fixture({ creatorMember: true })
  expect(f.group.ledger).toHaveLength(1)
  const entry = f.group.ledger[0]
  if (entry == null) throw new Error('Missing seed')
  expect(entry?.verified.entry.value).toMatchObject({ op: 'seed' })
  expect(readLedgerHead(f.group)?.head).toEqual(
    extendHead(genesisHead(f.group.groupID), [entry.entryID]),
  )
  expect(
    recordedLogOf(f.group.registry, f.did)?.events.map(({ event }) => digestOf(event)),
  ).toContain(f.member.add)
})

test('createGroup with a creator log that already denies an edge device seeds the denial', async () => {
  const f = await fixture()
  const denied = agent(62)
  const log = {
    chain: f.log.chain,
    events: [
      ...f.log.events,
      createRevoke({
        did: f.did,
        head: f.head,
        parents: epochHeads(f.did, f.log),
        signer: f.root,
        target: denied.id,
      }),
    ],
  }
  const { group } = await createGroup(f.identity, 'seed-denial', {
    controller: f.binding,
    controllerLog: log,
  })
  const peer = agent(61)
  const { invite } = await api.createInvite({ group, identity: f.identity, recipientDID: peer.id })
  const bundle = await rawBundle(
    group,
    peer,
    await timedBinding({ identity: peer, iat: 100, exp: 900 }),
  )
  const result = await api.commitInvite(group, bundle.publicPackage, invite)
  const { group: joined } = await api.processWelcome({
    identity: peer,
    invite,
    welcome: result.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: peer.id },
  })
  const deniedBundle = await rawBundle(
    joined,
    denied,
    await timedBinding({ identity: denied, iat: 100, exp: 900 }),
  )
  const next = await api.createInvite({ group: joined, identity: peer, recipientDID: denied.id })
  await expect(
    api.commitInvite(joined, deniedBundle.publicPackage, next.invite),
  ).rejects.toMatchObject({ reason: 'denied-id' })
})

test('lifecycle createGroup without controllerLog is refused', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150000)
  const identity = agent(41)
  await expect(
    createGroup(identity, 'missing-log', {
      controller: await timedBinding({ identity, iat: 100, exp: 900 }),
    }),
  ).rejects.toMatchObject({ reason: 'member-unavailable' })
})

test('renewLeaf with a new grant past the recorded lease succeeds when the bundled renewal covers it', async () => {
  const f = await fixture()
  const binding = await grant(f, f.identity, 1500)
  const leaf = leafAt(f.group.state.ratchetTree, 0)
  if (leaf == null) throw new Error('Missing leaf')
  const credential = {
    ...leaf.credential,
    identity: new TextEncoder().encode(JSON.stringify({ id: f.identity.id, controller: binding })),
  }
  await expect(validateEntry(f.group, { ...leaf, credential })).rejects.toThrow()
  const result = await api.renewLeaf(f.group, binding, { controllerLog: renewed(f) })
  const log = recordedLogOf(result.newGroup.registry, f.did)
  if (log == null) throw new Error('Missing recorded log')
  expect(head(f.did, log).members.get(f.member.add)?.lease).toBe(2000)
})

test('commitWithEntries validates an Add against the candidate registry', async () => {
  const f = await fixture()
  const empty = { chain: f.log.chain, events: [] }
  const { group } = await createGroup(f.identity, 'add-candidate', {
    controller: f.binding,
    controllerLog: empty,
  })
  const bob = agent(62)
  const bundle = await rawBundle(group, bob, await grant(f, bob))
  const { invite } = await api.createInvite({
    group,
    identity: f.identity,
    recipientDID: bob.id,
    controllerLog: f.log,
  })
  const result = await api.commitInvite(group, bundle.publicPackage, invite)
  expect(result.newGroup.findMemberLeafIndex(bob.id)).toBeDefined()
  expect(recordedLogOf(result.newGroup.registry, f.did)?.events).toHaveLength(1)
})

test("member processes an invite commit whose log entry carries the issuing member's renewal", async () => {
  const f = await fixture()
  const { author, joined } = await receiver(f)
  const bob = agent(62)
  const bundle = await rawBundle(author, bob, await grant(f, bob, 1500))
  const { invite } = await api.createInvite({
    group: author,
    identity: f.identity,
    recipientDID: bob.id,
    controllerLog: renewed(f),
  })
  const result = await api.commitInvite(author, bundle.publicPackage, invite)
  f.publish(result.newGroup.ledgerTokens)
  await joined.processMessage(result.commitMessage)
  expect(joined.findMemberLeafIndex(bob.id)).toBeDefined()
  expect(joined.registry).toEqual(result.newGroup.registry)
})

test('commit adding an mbr leaf without the needed log entry is refused', async () => {
  const f = await fixture()
  const bob = agent(62)
  const bundle = await rawBundle(f.group, bob, await grant(f, bob, 1500))
  const result = await rawCommit({
    group: f.group,
    proposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
  })
  await expect(
    f.group.processMessage(encode(mlsMessageEncoder, result.commit)),
  ).rejects.toMatchObject({ name: 'CommitRejectedError', reason: 'binding' })
})

test('author refuses to build a commit its receivers would reject', async () => {
  const f = await fixture()
  const bob = agent(62)
  const bundle = await rawBundle(f.group, bob, await grant(f, bob, 1500))
  const { invite } = await api.createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: bob.id,
  })
  const previous = f.group.state
  await expect(api.commitInvite(f.group, bundle.publicPackage, invite)).rejects.toThrow()
  expect(f.group.state).toBe(previous)
})

test('publishControllerLog settles without a revoke', async () => {
  const f = await fixture()
  const { author, joined } = await receiver(f)
  const rotation = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
  })
  const log = { chain: [...f.log.chain, rotation], events: [] }
  const result = await api.publishControllerLog(author, log)
  expect(result).not.toBeNull()
  if (result == null) throw new Error('Missing log commit')
  f.publish(result.newGroup.ledgerTokens)
  await joined.processMessage(result.commitMessage)
  expect(recordedLogOf(joined.registry, f.did)?.chain).toEqual(log.chain)
  expect(await api.publishControllerLog(result.newGroup, log)).toBeNull()
})

test('log entry from a device bound to another controller is refused', async () => {
  const f = await fixture()
  const outsider = agent(62)
  const seed = new Uint8Array(32).fill(32)
  const inception = createInception(seed, 0)
  const did = didFromInception(inception.event)
  const signer = createControllerIdentity({
    seed,
    profile: 0,
    log: { chain: [inception], events: [] },
  })
  const binding = {
    id: did,
    prefix: [inception],
    capability: stringifyToken(
      await signer.signToken({
        sub: did,
        aud: outsider.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: outsider.publicKey }),
        iat: 100,
        exp: 900,
      }),
    ),
  }
  const bundle = await rawBundle(f.group, outsider, binding)
  f.group.state.ratchetTree.push(undefined, {
    nodeType: nodeTypes.leaf,
    leaf: bundle.publicPackage.leafNode,
  })
  await expect(
    verifyLifecycleProof(f.group, {
      issuer: outsider.id,
      entry: {
        type: DEVICE_ENTRY_TYPE,
        groupID: f.group.groupID,
        subject: f.did,
        value: { op: 'log', proof: { chain: [], events: [] } },
      },
    }),
  ).rejects.toMatchObject({ reason: 'wrong-controller' })
})

test('two log entries in one commit are refused', async () => {
  const f = await fixture()
  const token = await logToken(f, { chain: [], events: [] })
  await expect(
    commitWithEntries({ group: f.group, extraProposals: [], enacted: [token, token] }),
  ).rejects.toMatchObject({ reason: 'effects-mismatch' })
})

test('log entry beside a proof is refused', async () => {
  const f = await fixture()
  const target = agent(62).id
  const revoked = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: { ...snapshotOf(f.head), deny: [target] },
  })
  const proof = await signLedgerEntry(f.identity, {
    type: DEVICE_ENTRY_TYPE,
    groupID: f.group.groupID,
    subject: target,
    value: { op: 'revoke', proof: [revoked], revoked: [{ did: target }] },
  })
  await expect(
    commitWithEntries({
      group: f.group,
      extraProposals: [],
      enacted: [await logToken(f, { chain: [], events: [] }), proof],
    }),
  ).rejects.toMatchObject({ reason: 'effects-mismatch' })
})

test('lapsed sender cannot publish a log entry', async () => {
  const f = await fixture()
  const { author } = await lowLevelWelcome(
    f.group,
    agent(61),
    await timedBinding({ identity: agent(61), iat: 901, exp: 1000 }),
  )
  await expect(api.publishControllerLog(author, renewed(f))).rejects.toMatchObject({
    reason: 'lapsed',
  })
})

test('renewLeaf with controllerLog carries the renewal the new grant needs', async () => {
  const f = await fixture()
  const { author, joined } = await receiver(f)
  const result = await api.renewLeaf(author, await grant(f, f.identity, 1500), {
    controllerLog: renewed(f),
  })
  f.publish(result.newGroup.ledgerTokens)
  await joined.processMessage(result.commitMessage)
  expect(joined.registry).toEqual(result.newGroup.registry)
  expect(joined.state.groupContext.treeHash).toEqual(result.newGroup.state.groupContext.treeHash)
})

test.each(['deny', 'remove', 'generation'] as const)(
  'publishControllerLog refuses %s effects before emitting',
  async (kind) => {
    const f = await fixture()
    let log: ControllerLog
    if (kind === 'generation') log = { chain: [f.inception, createReset(f.seed, 0, 1)], events: [] }
    else {
      const params = { did: f.did, head: f.head, parents: epochHeads(f.did, f.log), signer: f.root }
      log = {
        chain: f.log.chain,
        events: [
          ...f.log.events,
          kind === 'deny'
            ? createRevoke({ ...params, target: agent(62).id })
            : createRemove({ ...params, add: f.member.add }),
        ],
      }
    }
    await expect(api.publishControllerLog(f.group, log)).rejects.toMatchObject({
      reason: 'effects-mismatch',
    })
    expect(f.group.ledger).toHaveLength(1)
  },
)

test('controllerLogDelta returns missing events, a chain suffix, null and refuses a fork', async () => {
  const f = await fixture()
  const log = renewed(f)
  expect(api.controllerLogDelta(f.group, log)).toEqual({ chain: [], events: log.events.slice(1) })
  expect(api.controllerLogDelta(f.group, f.log)).toBeNull()
  const rotation = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
  })
  const result = await api.publishControllerLog(f.group, {
    chain: [f.inception, rotation],
    events: [],
  })
  if (result == null) throw new Error('Missing log commit')
  const fork = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
    seal: 'fork',
  })
  expect(() =>
    api.controllerLogDelta(result.newGroup, { chain: [f.inception, fork], events: [] }),
  ).toThrowError(expect.objectContaining({ reason: 'detached' }))
})

test('live lifecycle gate refuses a seed after ledger position zero', async () => {
  const f = await fixture()
  await expect(
    commitWithEntries({
      group: f.group,
      extraProposals: [],
      enacted: [await logToken(f, f.log, 'seed')],
    }),
  ).rejects.toMatchObject({ reason: 'detached' })
})

test('an unchanged evidenced child retains its binding against the candidate registry', async () => {
  const f = await fixture()
  const issuer = agent(61)
  const parent = await timedBinding({ identity: issuer, iat: 90, exp: 900 })
  const withIssuer = await lowLevelWelcome(f.group, issuer, parent)
  const bystander = agent(63)
  const withBystander = await lowLevelWelcome(
    withIssuer.author,
    bystander,
    await timedBinding({ identity: bystander, iat: 100, exp: 900 }),
  )
  const child = agent(62)
  const childBinding = await timedBinding({
    identity: child,
    iat: 100,
    exp: 800,
    issuer,
    parent: parent.capability,
  })
  const withChild = await lowLevelWelcome(withBystander.author, child, childBinding)
  await withBystander.joined.processMessage(withChild.message)
  const revoke = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: { ...snapshotOf(f.head), deny: [issuer.id] },
  })
  const result = await api.revokeWithProof(withChild.author, {
    subject: issuer.id,
    log: [f.inception, revoke],
  })
  expect(result.status).toBe('built')
  if (result.status !== 'built') throw new Error('Missing revoke')
  f.publish(result.result.newGroup.ledgerTokens)
  await withChild.joined.processMessage(result.result.commitMessage)
  await withBystander.joined.processMessage(result.result.commitMessage)
  expect(withChild.joined.findMemberLeafIndex(child.id)).toBeDefined()
  const proposal = await rawUpdate(withChild.joined, child, childBinding)
  await result.result.newGroup.processMessage(proposal)
  await withBystander.joined.processMessage(proposal)
  const update = await commitWithEntries({
    group: result.result.newGroup,
    extraProposals: [],
    pendingProposals: result.result.newGroup.state.unappliedProposals,
    enacted: [],
  })
  await withBystander.joined.processMessage(encode(mlsMessageEncoder, update.commit))
  expect(withBystander.joined.epoch).toBe(update.newState.groupContext.epoch)
  expect(withBystander.joined.state.groupContext.treeHash).toEqual(
    update.newState.groupContext.treeHash,
  )
  const childIndex = withBystander.joined.findMemberLeafIndex(child.id)
  expect(childIndex).toBe(withChild.author.findMemberLeafIndex(child.id))
  if (childIndex == null) throw new Error('Missing retained child')
  expect(leafAt(withBystander.joined.state.ratchetTree, childIndex)?.credential).toEqual(
    leafAt(update.newState.ratchetTree, childIndex)?.credential,
  )
  expect(withBystander.joined.bindingOfDID(child.id)?.capability).toBe(childBinding.capability)
})

test.each(['author', 'receiver'] as const)(
  '%s retains an unchanged membership Update when authority is unavailable',
  async (side) => {
    const f = await fixture()
    const binding: ControllerBinding = {
      id: f.did,
      prefix: f.log.chain,
      member: { add: f.member.add, g: 0 },
      iat: 100,
    }
    const bundle = await rawBundle(f.group, f.member.identity, binding)
    const added = await rawCommit({
      group: f.group,
      proposals: [
        { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
      ],
    })
    if (added.welcome == null) throw new Error('Missing Welcome')
    const context = await resolveMlsContext()
    const welcome = added.welcome.welcome
    const state = await withJudging(
      context,
      { registry: f.group.registry, stage: 'full', mode: 'admit' },
      (judgedContext) =>
        joinGroup({
          context: judgedContext,
          welcome,
          keyPackage: bundle.publicPackage,
          privateKeys: bundle.privatePackage,
        }),
    )
    const member = new GroupHandle({
      state,
      context,
      credential: { id: f.member.identity.id, groupID: f.group.groupID },
      ledger: [...f.group.ledger],
    })
    const firstAuthor = deriveGroup(f.group, added.newState)
    const peer = agent(63)
    const peerBundle = await rawBundle(
      firstAuthor,
      peer,
      await timedBinding({ identity: peer, iat: 100, exp: 900 }),
    )
    const peerCommit = await rawCommit({
      group: firstAuthor,
      proposals: [
        { proposalType: defaultProposalTypes.add, add: { keyPackage: peerBundle.publicPackage } },
      ],
    })
    if (peerCommit.welcome == null) throw new Error('Missing peer Welcome')
    const peerWelcome = peerCommit.welcome.welcome
    const peerContext = await resolveMlsContext()
    const peerState = await withJudging(
      peerContext,
      { registry: firstAuthor.registry, stage: 'full', mode: 'admit' },
      (judgedContext) =>
        joinGroup({
          context: judgedContext,
          welcome: peerWelcome,
          keyPackage: peerBundle.publicPackage,
          privateKeys: peerBundle.privatePackage,
        }),
    )
    const receiver = new GroupHandle({
      state: peerState,
      context: peerContext,
      credential: { id: peer.id, groupID: f.group.groupID },
      ledger: [...f.group.ledger],
    })
    await member.processMessage(encode(mlsMessageEncoder, peerCommit.commit))
    const author = deriveGroup(firstAuthor, peerCommit.newState)
    for (const group of [member, author, receiver])
      (group.registry.controllers as Map<string, unknown>).clear()
    const proposal = await rawUpdate(member, f.member.identity, binding)
    await author.processMessage(proposal)
    await receiver.processMessage(proposal)
    for (const group of [author, receiver])
      (group.registry.controllers as Map<string, unknown>).clear()
    const result = await commitWithEntries({
      group: author,
      extraProposals: [],
      pendingProposals: author.state.unappliedProposals,
      enacted: [],
    })
    if (side === 'receiver') {
      await receiver.processMessage(encode(mlsMessageEncoder, result.commit))
      expect(receiver.epoch).toBe(result.newState.groupContext.epoch)
      expect(receiver.state.groupContext.treeHash).toEqual(result.newState.groupContext.treeHash)
      const index = receiver.findMemberLeafIndex(f.member.identity.id)
      expect(index).toBe(member.state.privatePath.leafIndex)
      if (index == null) throw new Error('Missing retained member')
      expect(leafAt(receiver.state.ratchetTree, index)?.credential).toEqual(
        leafAt(result.newState.ratchetTree, index)?.credential,
      )
      expect(receiver.bindingOfDID(f.member.identity.id)?.member).toEqual(binding.member)
    }
    expect(result.newState.groupContext.epoch).toBe(author.epoch + 1n)
  },
)

test.each(['completed', 'failed'] as const)(
  'retrying an invite after a %s build uses its pristine entries',
  async (firstAttempt) => {
    const f = await fixture()
    vi.mocked(Date.now).mockReturnValue(170000)
    const stale = await lowLevelWelcome(
      f.group,
      f.member.identity,
      await timedBinding({ identity: f.member.identity, iat: 150, exp: 900 }),
    )
    const peer = agent(62)
    const receiving = await lowLevelWelcome(
      stale.author,
      peer,
      await timedBinding({ identity: peer, iat: 100, exp: 900 }),
    )
    const binding: ControllerBinding = {
      id: f.did,
      prefix: f.log.chain,
      member: { add: f.member.add, g: 0 },
      iat: 160,
    }
    const bundle = await rawBundle(receiving.author, f.member.identity, binding)
    const { invite } = await api.createInvite({
      group: receiving.author,
      identity: f.identity,
      recipientDID: f.member.identity.id,
    })
    const originalInvite = structuredClone(invite)
    if (firstAttempt === 'failed') {
      const failure = new Error('Commit build failed')
      vi.spyOn(lifecycle, 'prepareLifecycleGate').mockRejectedValueOnce(failure)
      await expect(api.commitInvite(receiving.author, bundle.publicPackage, invite)).rejects.toBe(
        failure,
      )
    } else {
      const completed = await api.commitInvite(receiving.author, bundle.publicPackage, invite)
      expect(completed.invite).toBe(invite)
      expect(invite.ledgerEntries).toEqual(completed.newGroup.ledgerTokens)
    }
    if (firstAttempt === 'failed') expect(invite).toEqual(originalInvite)
    vi.mocked(Date.now).mockReturnValue(180000)
    const result = await api.commitInvite(receiving.author, bundle.publicPackage, invite)
    expect(result.newGroup.ledger.at(-1)?.verified.entry.value).toEqual({ op: 'clock', time: 150 })
    expect(result.invite).toBe(invite)
    expect(result.invite.ledgerEntries).toEqual(result.newGroup.ledgerTokens)
    const clock = await signLedgerEntry(f.identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: f.group.groupID,
      subject: f.did,
      value: { op: 'clock', time: 150 },
    })
    expect(result.newGroup.ledgerTokens).toEqual([...originalInvite.ledgerEntries, clock])
    f.publish(result.newGroup.ledgerTokens)
    await receiving.joined.processMessage(result.commitMessage)
    expect(receiving.joined.registry).toEqual(result.newGroup.registry)
    expect(readLedgerHead(result.newGroup)?.head).toEqual(
      computeHead(f.group.groupID, result.invite.ledgerEntries.map(ledgerEntryDigest)),
    )
    const renewed = await api.renewLeaf(
      receiving.author,
      await timedBinding({ identity: f.identity, iat: 175, exp: 900 }),
    )
    const deliveredInvite = structuredClone(invite)
    const failure = new Error('Retry build failed')
    vi.spyOn(lifecycle, 'prepareLifecycleGate').mockRejectedValueOnce(failure)
    await expect(api.commitInvite(renewed.newGroup, bundle.publicPackage, invite)).rejects.toBe(
      failure,
    )
    expect(invite).toEqual(deliveredInvite)
    const withoutClock = await api.commitInvite(renewed.newGroup, bundle.publicPackage, invite)
    expect(withoutClock.invite).toBe(invite)
    expect(withoutClock.newGroup.ledgerTokens).toEqual(originalInvite.ledgerEntries)
    expect(withoutClock.invite).toEqual(originalInvite)
    expect(invite).toEqual(originalInvite)
  },
)

test.each(['completed', 'failed'] as const)(
  'retrying removeMember after a %s build leaves caller entries unchanged',
  async (firstAttempt) => {
    const f = await fixture()
    const peer = agent(62)
    const members = await lowLevelWelcome(
      f.group,
      peer,
      await timedBinding({ identity: peer, iat: 150, exp: 900 }),
    )
    const index = members.author.findMemberLeafIndex(peer.id)
    if (index == null) throw new Error('Missing member')
    const token = await signLedgerEntry(f.identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: f.group.groupID,
      subject: peer.id,
      value: {
        op: 'revoke',
        proof: [
          createRotate({
            seed: f.seed,
            profile: 0,
            did: f.did,
            prior: f.inception.event,
            snapshot: { ...snapshotOf(f.head), deny: [peer.id] },
          }),
        ],
        revoked: [{ did: peer.id }],
      },
    })
    const entries = [token]
    if (firstAttempt === 'failed') {
      const failure = new Error('Commit build failed')
      vi.spyOn(lifecycle, 'prepareLifecycleGate').mockRejectedValueOnce(failure)
      await expect(api.removeMember(members.author, index, entries)).rejects.toBe(failure)
    } else {
      await api.removeMember(members.author, index, entries)
    }
    expect(entries).toEqual([token])
    vi.mocked(Date.now).mockReturnValue(180000)
    const result = await api.removeMember(members.author, index, entries)
    const clock = await signLedgerEntry(f.identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: f.group.groupID,
      subject: f.did,
      value: { op: 'clock', time: 150 },
    })
    expect(entries).toEqual([token])
    expect(result.newGroup.ledgerTokens).toEqual([...members.author.ledgerTokens, token, clock])
    expect(result.newGroup.findMemberLeafIndex(peer.id)).toBeUndefined()
    expect(result.newGroup.registry.controllers.get(f.did)?.timeFloor).toBe(150)
    const renewed = await api.renewLeaf(
      members.author,
      await timedBinding({ identity: f.identity, iat: 175, exp: 900 }),
    )
    const withoutClock = await api.removeMember(renewed.newGroup, index, entries)
    expect(withoutClock.newGroup.ledgerTokens).toEqual([...members.author.ledgerTokens, token])
    expect(withoutClock.newGroup.registry.controllers.get(f.did)?.timeFloor).toBe(0)
    expect(entries).toEqual([token])
  },
)
