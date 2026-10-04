import {
  createControllerIdentity,
  createInception,
  createReset,
  createRevoke,
  createRotate,
  foldLog,
  type SignedEvent,
} from '@kokuin/controller'
import { createIdentity } from '@kokuin/token'
import { createProposal, defaultProposalTypes, encode, mlsMessageEncoder, nodeTypes } from 'ts-mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { mintTrustedGrant } from '../src/capability.js'
import { parseMLSCredentialIdentity } from '../src/credential.js'
import { commitWithEntries } from '../src/group-commit.js'
import { createGroup } from '../src/group-create.js'
import { deriveGroup } from '../src/group-handle.js'
import { removeLapsedLeaves, renewLeaf, revokeWithProof } from '../src/group-lifecycle.js'
import { HISTORY_HORIZON, historySize } from '../src/history.js'
import { isLapsed, leafAt, treeTime } from '../src/lifecycle.js'
import { revocationOf } from '../src/registry.js'
import { controllerSeed } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  controllerID,
  inception,
  lowLevelExternal,
  lowLevelWelcome,
  pipelineGroup,
  rawApplication,
  rawBundle,
  rawCommit,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

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

function rotation(log: Array<SignedEvent>, bytes?: number) {
  const folded = foldLog(controllerID, log)
  const head = folded.ok ? folded.states.at(-1) : undefined
  const prior = log.at(-1)
  if (head == null || prior == null) throw new Error('Missing head')
  const options = { keyPosition: { gen: head.keyGen, seq: head.keySeq }, seal: '' }
  let event = createRotate({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: prior.event,
    options,
  })
  if (bytes != null) {
    options.seal = 's'.repeat(bytes - new TextEncoder().encode(JSON.stringify(event)).length)
    event = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: prior.event,
      options,
    })
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBe(bytes)
  }
  return event
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('leaf renewal', () => {
  test('renews after expiry without mutating the old tree or absorbing a pending Add', async () => {
    const setup = await pipelineGroup()
    const identity = setup.identity
    const candidate = agent(61)
    const bundle = await rawBundle(setup.group, candidate, await timedBinding(candidate, 100, 200))
    const pending = await createProposal({
      context: setup.group.context,
      state: setup.group.state,
      proposal: {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: bundle.publicPackage },
      },
    })
    const group = deriveGroup(setup.group, pending.newState)
    expect(Object.keys(group.state.unappliedProposals)).toHaveLength(1)
    const own = group.state.ratchetTree[0]
    const snapshot = structuredClone(group.state)
    vi.spyOn(Date, 'now').mockReturnValue(250_000)
    const result = await renewLeaf(group, await timedBinding(identity, 250, 350))
    expect(result.epoch).toBe(group.epoch + 1n)
    expect(group.state).toEqual(snapshot)
    expect(group.state.ratchetTree[0]).toBe(own)
    expect(result.newGroup.listMembers()).toHaveLength(1)
    expect(result.newGroup.state.unappliedProposals).toEqual({})
    const historical = result.newGroup.state.historicalReceiverData.get(group.epoch)
    expect(historical?.ratchetTree).toEqual(group.state.ratchetTree)
    expect(historical?.ratchetTree[0]).toBe(own)
  })

  test('rejects a decreasing child issuance time and author-time invalid grants', async () => {
    const { group, identity } = await pipelineGroup()
    await expect(renewLeaf(group, await timedBinding(identity, 99, 200))).rejects.toMatchObject({
      reason: 'identity-change',
    })
    await expect(renewLeaf(group, await timedBinding(identity, 151, 201))).rejects.toThrow(
      'authoring time',
    )
    await expect(renewLeaf(group, await timedBinding(identity, 100, 150))).rejects.toThrow(
      'authoring time',
    )
  })

  test('old epoch messages still decrypt after renewal', async () => {
    const { group, identity } = await pipelineGroup()
    const peer = agent(51)
    const fixture = await lowLevelWelcome(group, peer, await timedBinding(peer, 90, 190))
    const delayed = await rawApplication(fixture.joined)
    const result = await renewLeaf(fixture.author, await timedBinding(identity, 150, 250))
    expect(await result.newGroup.decrypt(delayed)).toBeDefined()
  })
})

describe('lapse removal', () => {
  test('returns no result when nothing has lapsed', async () => {
    const { group } = await pipelineGroup()
    expect(await removeLapsedLeaves(group)).toEqual({ removed: [] })
  })

  test('any active member removes every lapsed leaf in one epoch', async () => {
    const { group, identity } = await pipelineGroup()
    const peer = agent(51)
    const fixture = await lowLevelWelcome(group, peer, await timedBinding(peer, 90, 110))
    const advanced = await renewLeaf(fixture.author, await timedBinding(identity, 150, 250))
    const snapshot = structuredClone(advanced.newGroup.state)
    const removed = await removeLapsedLeaves(advanced.newGroup)
    expect(removed.removed).toEqual([peer.id])
    expect(removed.result?.epoch).toBe(advanced.epoch + 1n)
    expect(removed.result?.newGroup.listMembers()).toHaveLength(1)
    expect(advanced.newGroup.state).toEqual(snapshot)
  })
})

describe('proof builders', () => {
  test('evicts a leaf once, records a leafless subject and returns already-revoked for a winning proof', async () => {
    const { group, identity, tokens } = await pipelineGroup()
    const target = agent(51)
    const fixture = await lowLevelWelcome(group, target, await timedBinding(target, 90, 190))
    const log = [inception, revoke([inception], target.id)]
    const snapshot = structuredClone(fixture.author.state)
    const built = await revokeWithProof(fixture.author, { subject: target.id, log })
    expect(built.status).toBe('built')
    if (built.status !== 'built') throw new Error('Missing proof')
    expect(built.result.epoch).toBe(fixture.author.epoch + 1n)
    expect(built.result.newGroup.findMemberLeafIndex(target.id)).toBeUndefined()
    expect(revocationOf(built.result.newGroup, target.id)?.logPosition).toBe(1)
    expect(fixture.author.state).toEqual(snapshot)
    for (const held of built.result.newGroup.ledger) tokens.set(held.entryID, held.token)
    await fixture.joined.processMessage(built.result.commitMessage)
    expect(fixture.joined.state.groupActiveState.kind).toBe('removedFromGroup')
    expect(await revokeWithProof(built.result.newGroup, { subject: target.id, log })).toEqual({
      status: 'already-revoked',
    })
    const absent = agent(61).id
    const full = [...log, revoke(log, absent)]
    const next = await revokeWithProof(built.result.newGroup, { subject: absent, log: full })
    expect(next.status).toBe('built')
    if (next.status !== 'built') throw new Error('Missing proof')
    expect(revocationOf(next.result.newGroup, absent)?.logPosition).toBe(2)
    expect(next.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
      proof: JSON.parse(JSON.stringify([full[2]])),
    })
    expect(identity.id).toBe(group.credential.id)
  })

  test('returns typed no-rev and self-affected outcomes', async () => {
    const { group, identity } = await pipelineGroup()
    expect(await revokeWithProof(group, { subject: agent(51).id, log: [inception] })).toEqual({
      status: 'not-provable',
      reason: 'no-rev',
    })
    expect(
      await revokeWithProof(group, {
        subject: identity.id,
        log: [inception, revoke([inception], identity.id)],
      }),
    ).toEqual({ status: 'self-affected', subject: identity.id })
    expect(
      await revokeWithProof(group, {
        reset: true,
        log: [inception, createReset(controllerSeed, 0, 1)],
      }),
    ).toEqual({ status: 'self-affected', subject: identity.id })
  })

  test('reset after renewal raises the floor without evicting a retained member', async () => {
    const { group, identity } = await pipelineGroup()
    const log = [inception, createReset(controllerSeed, 0, 1)]
    const renewal = await renewLeaf(group, await timedBinding(identity, 150, 250, { prefix: log }))
    const reset = await revokeWithProof(renewal.newGroup, { reset: true, log })
    expect(reset.status).toBe('built')
    if (reset.status !== 'built') throw new Error('Missing reset')
    expect(reset.result.newGroup.registry.controllers.get(controllerID)?.genFloor).toBe(1)
    expect(treeTime(reset.result.newGroup, controllerID)).toBe(150)
  })
})

test('renewal and proof growth fail at the exact history horizon boundary, while shrinking reopens room', async () => {
  const { group, identity } = await pipelineGroup()
  const base = historySize(group.state.ratchetTree, [])
  const large = [inception, rotation([inception], HISTORY_HORIZON - 1_024 - base)]
  const near = await renewLeaf(group, await timedBinding(identity, 150, 250, { prefix: large }))
  expect(historySize(near.newGroup.state.ratchetTree, [])).toBe(HISTORY_HORIZON - 1_024)
  const grown = [...large, rotation(large, 2_048)]
  await expect(
    renewLeaf(near.newGroup, await timedBinding(identity, 150, 250, { prefix: grown })),
  ).rejects.toMatchObject({ reason: 'history-horizon' })
  const target = agent(51).id
  const resetLog = [inception, createReset(controllerSeed, 0, 1)]
  const eventBytes = (events: Array<SignedEvent>) =>
    events.reduce(
      (total, event) => total + new TextEncoder().encode(JSON.stringify(event)).length,
      0,
    )
  const probe = [...resetLog, rotation(resetLog, 1024)]
  const revBytes = eventBytes([revoke(probe, target)])
  const proofLog: Array<SignedEvent> = [
    ...resetLog,
    rotation(resetLog, 2_048 - eventBytes(resetLog) - revBytes),
  ]
  proofLog.push(revoke(proofLog, target))
  expect(eventBytes(proofLog)).toBe(2_048)
  expect(await revokeWithProof(near.newGroup, { subject: target, log: proofLog })).toEqual({
    status: 'not-provable',
    reason: 'too-large',
  })
  const shrunk = await renewLeaf(
    near.newGroup,
    await timedBinding(identity, 150, 250, { prefix: resetLog }),
  )
  const reset = await revokeWithProof(shrunk.newGroup, { reset: true, log: resetLog })
  expect(reset.status).toBe('built')
  if (reset.status !== 'built') throw new Error('Missing reset')
  expect(
    (await revokeWithProof(reset.result.newGroup, { subject: target, log: proofLog })).status,
  ).toBe('built')
  const node = shrunk.newGroup.state.ratchetTree[0]
  expect(node?.nodeType).toBe(nodeTypes.leaf)
  if (node?.nodeType === nodeTypes.leaf && 'identity' in node.leaf.credential)
    expect(parseMLSCredentialIdentity(node.leaf.credential.identity).controller?.prefix).toEqual(
      resetLog,
    )
})

async function parentGrant(
  identity: ReturnType<typeof agent>,
  prefix: Array<SignedEvent>,
  iat: number,
) {
  vi.spyOn(Date, 'now').mockReturnValue(iat * 1000)
  const grant = await mintTrustedGrant({
    signer: createControllerIdentity({ seed: controllerSeed, profile: 0, log: prefix }),
    controllerID,
    audience: identity.id,
    leafKey: identity.publicKey,
    exp: 1000,
  })
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  return grant
}

test('direct-to-chain renewal installs a clock and child renewal cannot lower iat', async () => {
  const { group, identity, tokens } = await pipelineGroup()
  const trusted = agent(61)
  const fixture = await lowLevelWelcome(group, trusted, await timedBinding(trusted, 80, 200))
  const parent = await parentGrant(trusted, [inception], 90)
  const renewal = await renewLeaf(
    fixture.author,
    await timedBinding(identity, 110, 210, { issuer: trusted, parent }),
  )
  expect(renewal.newGroup.registry.controllers.get(controllerID)?.timeFloor).toBe(100)
  expect(treeTime(renewal.newGroup, controllerID)).toBe(100)
  for (const held of renewal.newGroup.ledger) tokens.set(held.entryID, held.token)
  await fixture.joined.processMessage(renewal.commitMessage)
  expect(fixture.joined.registry).toEqual(renewal.newGroup.registry)
  await expect(
    renewLeaf(
      renewal.newGroup,
      await timedBinding(identity, 109, 220, { issuer: trusted, parent }),
    ),
  ).rejects.toMatchObject({ reason: 'identity-change' })
})

test('a lapsed member can renew itself and resume sending', async () => {
  const { group } = await pipelineGroup()
  const child = agent(61)
  const fixture = await lowLevelWelcome(group, child, await timedBinding(child, 90, 99))
  const old = leafAt(fixture.joined.state.ratchetTree, fixture.joined.state.privatePath.leafIndex)
  if (old == null) throw new Error('Missing own leaf')
  expect(isLapsed(fixture.joined, old)).toBe(true)
  const renewal = await renewLeaf(fixture.joined, await timedBinding(child, 100, 200))
  const next = leafAt(
    renewal.newGroup.state.ratchetTree,
    renewal.newGroup.state.privatePath.leafIndex,
  )
  if (next == null) throw new Error('Missing own leaf')
  expect(isLapsed(renewal.newGroup, next)).toBe(false)
  await fixture.author.processMessage(renewal.commitMessage)
  expect(fixture.author.epoch).toBe(renewal.epoch)
})

test('reset identifies the author through a cascade from an older trusted issuer', async () => {
  const { group } = await pipelineGroup()
  const reset = [inception, createReset(controllerSeed, 0, 1)]
  const child = agent(61)
  const parent = await parentGrant(agent(41), reset, 100)
  const fixture = await lowLevelWelcome(
    group,
    child,
    await timedBinding(child, 110, 210, { prefix: reset, issuer: agent(41), parent }),
  )
  expect(await revokeWithProof(fixture.joined, { reset: true, log: reset })).toEqual({
    status: 'self-affected',
    subject: child.id,
  })
})

test('strips skipped events, and rejects wrong-controller, detached and higher-generation proofs', async () => {
  const { group } = await pipelineGroup()
  const target = agent(61).id
  const rev = revoke([inception], target)
  const skipped = {
    ...rev,
    event: { ...rev.event, t: 'future', crit: false },
  } as unknown as SignedEvent
  const padded = [inception, skipped, rev]
  const built = await revokeWithProof(group, { subject: target, log: padded })
  expect(built.status).toBe('built')
  expect(padded).toHaveLength(3)
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.registry.controllers.get(controllerID)?.recordedLog).toEqual(
    JSON.parse(JSON.stringify([inception, rev])),
  )
  const foreign = createInception(new Uint8Array(32).fill(99), 0)
  expect(await revokeWithProof(group, { subject: target, log: [foreign] })).toEqual({
    status: 'not-provable',
    reason: 'wrong-controller',
  })
  const other = agent(71).id
  expect(
    await revokeWithProof(built.result.newGroup, {
      subject: other,
      log: [inception, revoke([inception], other)],
    }),
  ).toEqual({ status: 'not-provable', reason: 'detached' })
  const reset = [inception, createReset(controllerSeed, 0, 1)]
  expect(
    await revokeWithProof(built.result.newGroup, {
      subject: other,
      log: [...reset, revoke(reset, other)],
    }),
  ).toEqual({ status: 'not-provable', reason: 'needs-reset' })
})

test('exact-size Add and external replacement growth reject on author and receive paths', async () => {
  const { group, identity } = await pipelineGroup()
  const peer = agent(51)
  const fixture = await lowLevelWelcome(group, peer, await timedBinding(peer, 100, 200))
  const base = historySize(fixture.author.state.ratchetTree, [])
  const prefix = [inception, rotation([inception], HISTORY_HORIZON - 1_024 - base)]
  const near = (await renewLeaf(fixture.author, await timedBinding(identity, 150, 250, { prefix })))
    .newGroup
  const newDevice = agent(61)
  const small = [inception, rotation([inception], 2_048 - historySize(group.state.ratchetTree, []))]
  const bundle = await rawBundle(
    near,
    newDevice,
    await timedBinding(newDevice, 150, 250, { prefix: small }),
  )
  const proposals = [
    { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
  ] as const
  await expect(
    commitWithEntries(near, [...proposals], [], { requireAdmin: false }),
  ).rejects.toMatchObject({ reason: 'history-horizon' })
  const hostile = await rawCommit(near, [...proposals])
  await expect(
    near.processMessage(encode(mlsMessageEncoder, hostile.commit)),
  ).rejects.toMatchObject({ reason: 'binding' })
  const longer = [...prefix, rotation(prefix, 2_048)]
  const external = await lowLevelExternal(
    near,
    identity,
    await timedBinding(identity, 150, 250, { prefix: longer }),
  )
  await expect(near.processMessage(external)).rejects.toMatchObject({ reason: 'binding' })
})

test('a proof removing the newest leaf preserves tree time for the removed receiver', async () => {
  const { group, tokens } = await pipelineGroup()
  const target = agent(61)
  const fixture = await lowLevelWelcome(group, target, await timedBinding(target, 150, 250))
  const built = await revokeWithProof(fixture.author, {
    subject: target.id,
    log: [inception, revoke([inception], target.id)],
  })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.registry.controllers.get(controllerID)?.timeFloor).toBe(150)
  expect(treeTime(built.result.newGroup, controllerID)).toBe(150)
  for (const held of built.result.newGroup.ledger) tokens.set(held.entryID, held.token)
  await fixture.joined.processMessage(built.result.commitMessage)
  expect(fixture.joined.registry).toEqual(built.result.newGroup.registry)
})

test('renewal can shorten history while the group is already above the horizon', async () => {
  const { group, identity } = await pipelineGroup()
  const prefix = [inception, rotation([inception], HISTORY_HORIZON + 2_048)]
  const inflated = await rawCommit(group, [], await timedBinding(identity, 150, 250, { prefix }))
  const oversized = deriveGroup(group, inflated.newState)
  expect(historySize(oversized.state.ratchetTree, [])).toBeGreaterThan(HISTORY_HORIZON)
  const shrunk = await renewLeaf(oversized, await timedBinding(identity, 150, 250))
  expect(historySize(shrunk.newGroup.state.ratchetTree, [])).toBe(
    historySize(group.state.ratchetTree, []),
  )
})

test('an empty suffix can prove a revocation already held by the recorded reset chain', async () => {
  const { group, identity } = await pipelineGroup()
  const current: Array<SignedEvent> = [inception, createReset(controllerSeed, 0, 1)]
  const target = agent(61).id
  current.push(revoke(current, target))
  const renewed = await renewLeaf(
    group,
    await timedBinding(identity, 150, 250, { prefix: current }),
  )
  const reset = await revokeWithProof(renewed.newGroup, { reset: true, log: current })
  if (reset.status !== 'built') throw new Error('Missing reset')
  const built = await revokeWithProof(reset.result.newGroup, { subject: target, log: current })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({ proof: [] })
  expect(revocationOf(built.result.newGroup, target)?.logPosition).toBe(2)
})

test('invalid signatures, missing resets and old generations return proof reasons', async () => {
  const { group, identity } = await pipelineGroup()
  const target = agent(61).id
  expect(await revokeWithProof(group, { subject: target, log: [] })).toEqual({
    status: 'not-provable',
    reason: 'no-rev',
  })
  expect(await revokeWithProof(group, { reset: true, log: [inception] })).toEqual({
    status: 'not-provable',
    reason: 'no-rev',
  })
  const invalid = revoke([inception], target)
  invalid.sigs = []
  expect(await revokeWithProof(group, { subject: target, log: [inception, invalid] })).toEqual({
    status: 'not-provable',
    reason: 'not-authority-signed',
  })
  const log = [inception, createReset(controllerSeed, 0, 1)]
  const renewed = await renewLeaf(group, await timedBinding(identity, 150, 250, { prefix: log }))
  const reset = await revokeWithProof(renewed.newGroup, { reset: true, log })
  if (reset.status !== 'built') throw new Error('Missing reset')
  expect(
    await revokeWithProof(reset.result.newGroup, {
      subject: target,
      log: [inception, revoke([inception], target)],
    }),
  ).toEqual({ status: 'not-provable', reason: 'generation-floor' })
})

test('a member without a role builds a cascading proof and observes another member winning', async () => {
  const { group, identity, tokens } = await pipelineGroup()
  const child = agent(61)
  const parent = await parentGrant(identity, [inception], 100)
  const first = await lowLevelWelcome(
    group,
    child,
    await timedBinding(child, 110, 210, { issuer: identity, parent }),
  )
  const publisher = agent(71)
  const second = await lowLevelWelcome(
    first.author,
    publisher,
    await timedBinding(publisher, 100, 200),
  )
  const competitor = agent(81)
  const third = await lowLevelWelcome(
    second.author,
    competitor,
    await timedBinding(competitor, 100, 200),
  )
  await second.joined.processMessage(third.message)
  const log = [inception, revoke([inception], identity.id)]
  expect(second.joined.roster.roles.has(publisher.id)).toBe(false)
  const before = structuredClone(second.joined.state)
  const built = await revokeWithProof(second.joined, { subject: identity.id, log })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.listMembers().map(({ id }) => id)).toEqual([
    publisher.id,
    competitor.id,
  ])
  expect(revocationOf(built.result.newGroup, child.id)?.cascadedFrom).toBe(identity.id)
  expect(second.joined.state).toEqual(before)
  for (const held of built.result.newGroup.ledger) tokens.set(held.entryID, held.token)
  const competing = third.joined
  await competing.processMessage(built.result.commitMessage)
  expect(await revokeWithProof(competing, { subject: identity.id, log })).toEqual({
    status: 'already-revoked',
  })
})

test('peer:4 members sign self-verifying proof entries using their leaf long form', async () => {
  const identity = await createIdentity({
    didMethod: 'peer:4',
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(121) }],
  })
  const { group } = await createGroup(identity, 'peer-proof', {
    controller: await timedBinding(identity, 100, 200),
  })
  const target = agent(61).id
  const built = await revokeWithProof(group, {
    subject: target,
    log: [inception, revoke([inception], target)],
  })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.ledger.at(-1)?.verified.issuer).toBe(identity.id)
})
