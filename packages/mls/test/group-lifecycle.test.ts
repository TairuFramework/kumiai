import {
  type ControllerLog,
  createControllerIdentity,
  createInception,
  createReset,
  createRevoke,
  createRotate,
  digestOf,
  epochHeads,
  type SignedEvent,
  snapshotOf,
} from '@kokuin/controller'
import { createIdentity, type OwnIdentity } from '@kokuin/token'
import { createProposal, defaultProposalTypes, encode, mlsMessageEncoder, nodeTypes } from 'ts-mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { mintTrustedGrant } from '../src/capability.js'
import { asControllerLog, foldChain, foldControllerLog } from '../src/controller-log.js'
import { parseMLSCredentialIdentity } from '../src/credential.js'
import { commitWithEntries } from '../src/group-commit.js'
import { createGroup } from '../src/group-create.js'
import { deriveGroup } from '../src/group-handle.js'
import { removeLapsedLeaves, renewLeaf, revokeWithProof } from '../src/group-lifecycle.js'
import { controllerLogSize, HISTORY_HORIZON, historySize } from '../src/history.js'
import { isLapsed, leafAt, treeTime } from '../src/lifecycle.js'
import { verifyLifecycleProof } from '../src/lifecycle-proof.js'
import { revocationOf } from '../src/registry.js'
import {
  denyEffects,
  revokeChain,
  rotateChain,
  snapshotForChain,
} from './fixtures/controller-chain.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { controllerSeed } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  belowGateWelcome,
  controllerID,
  inception,
  lowLevelExternal,
  lowLevelWelcome,
  pipelineGroup,
  rawApplication,
  rawBundle,
  rawCommit,
  timedBinding,
  withoutHolderEvidence,
} from './fixtures/lifecycle-pipeline.js'

function revoke(log: Array<SignedEvent>, subject: string): SignedEvent {
  return revokeChain({ seed: controllerSeed, profile: 0, did: controllerID, chain: log, subject })
}

function rotation(log: Array<SignedEvent>, bytes?: number) {
  const folded = foldChain(controllerID, log)
  const head = folded.ok ? folded.states.at(-1) : undefined
  const prior = log.at(-1)
  if (head == null || prior == null) throw new Error('Missing head')
  const options = { seal: '' }
  let event = createRotate({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: prior.event,
    snapshot: snapshotForChain(controllerID, log),
    seal: options.seal,
  })
  if (bytes != null) {
    options.seal = 's'.repeat(bytes - new TextEncoder().encode(JSON.stringify(event)).length)
    event = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: prior.event,
      snapshot: snapshotForChain(controllerID, log),
      seal: options.seal,
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
    const bundle = await rawBundle(
      setup.group,
      candidate,
      await timedBinding({ identity: candidate, iat: 100, exp: 200 }),
    )
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
    const result = await renewLeaf(group, await timedBinding({ identity, iat: 250, exp: 350 }))
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
    await expect(
      renewLeaf(group, await timedBinding({ identity, iat: 99, exp: 200 })),
    ).rejects.toMatchObject({
      reason: 'renewal-order',
    })
    await expect(
      renewLeaf(group, await timedBinding({ identity, iat: 151, exp: 201 })),
    ).rejects.toThrow('authoring time')
    await expect(
      renewLeaf(group, await timedBinding({ identity, iat: 100, exp: 150 })),
    ).rejects.toThrow('authoring time')
  })

  test('old epoch messages still decrypt after renewal', async () => {
    const { group, identity } = await pipelineGroup()
    const peer = agent(51)
    const fixture = await lowLevelWelcome(
      group,
      peer,
      await timedBinding({ identity: peer, iat: 90, exp: 190 }),
    )
    const delayed = await rawApplication(fixture.joined)
    const result = await renewLeaf(
      fixture.author,
      await timedBinding({ identity, iat: 150, exp: 250 }),
    )
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
    const fixture = await lowLevelWelcome(
      group,
      peer,
      await timedBinding({ identity: peer, iat: 90, exp: 110 }),
    )
    const advanced = await renewLeaf(
      fixture.author,
      await timedBinding({ identity, iat: 150, exp: 250 }),
    )
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
    const fixture = await lowLevelWelcome(
      group,
      target,
      await timedBinding({ identity: target, iat: 90, exp: 190 }),
    )
    const log = [inception, revoke([inception], target.id)]
    const snapshot = structuredClone(fixture.author.state)
    const built = await revokeWithProof(fixture.author, {
      deny: [target.id],
      log: asControllerLog(log),
    })
    expect(built.status).toBe('built')
    if (built.status !== 'built') throw new Error('Missing proof')
    expect(built.result.epoch).toBe(fixture.author.epoch + 1n)
    expect(built.result.newGroup.findMemberLeafIndex(target.id)).toBeUndefined()
    expect(revocationOf(built.result.newGroup, target.id)?.proofRef).toEqual({ chainIndex: 1 })
    expect(fixture.author.state).toEqual(snapshot)
    for (const held of built.result.newGroup.ledger) tokens.set(held.entryID, held.token)
    await fixture.joined.processMessage(built.result.commitMessage)
    expect(fixture.joined.state.groupActiveState.kind).toBe('removedFromGroup')
    expect(
      await revokeWithProof(built.result.newGroup, {
        deny: [target.id],
        log: asControllerLog(log),
      }),
    ).toEqual({
      status: 'already-revoked',
    })
    const absent = agent(61).id
    const full = [...log, revoke(log, absent)]
    const next = await revokeWithProof(built.result.newGroup, {
      deny: [absent],
      log: asControllerLog(full),
    })
    expect(next.status).toBe('built')
    if (next.status !== 'built') throw new Error('Missing proof')
    expect(revocationOf(next.result.newGroup, absent)?.proofRef).toEqual({ chainIndex: 2 })
    expect(next.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
      proof: asControllerLog(JSON.parse(JSON.stringify([full[2]]))),
    })
    expect(identity.id).toBe(group.credential.id)
  })

  test('returns typed no-rev and self-affected outcomes', async () => {
    const { group, identity } = await pipelineGroup()
    expect(
      await revokeWithProof(group, { deny: [agent(51).id], log: asControllerLog([inception]) }),
    ).toEqual({
      status: 'not-provable',
      reason: 'no-rev',
    })
    expect(
      await revokeWithProof(group, {
        deny: [identity.id],
        log: asControllerLog([inception, revoke([inception], identity.id)]),
      }),
    ).toEqual({ status: 'self-affected', subject: identity.id })
    expect(
      await revokeWithProof(group, {
        reset: true,
        log: asControllerLog([inception, createReset(controllerSeed, 0, 1)]),
      }),
    ).toEqual({ status: 'self-affected', subject: identity.id })
  })

  test('reset after renewal raises the floor without evicting a retained member', async () => {
    const { group, identity } = await pipelineGroup()
    const log = [inception, createReset(controllerSeed, 0, 1)]
    const renewal = await renewLeaf(
      group,
      await timedBinding({ identity, iat: 150, exp: 250, prefix: log }),
    )
    const reset = await revokeWithProof(renewal.newGroup, {
      reset: true,
      log: asControllerLog(log),
    })
    expect(reset.status).toBe('built')
    if (reset.status !== 'built') throw new Error('Missing reset')
    expect(reset.result.newGroup.registry.controllers.get(controllerID)?.genFloor).toBe(1)
    expect(treeTime(reset.result.newGroup, controllerID)).toBe(150)
  })
})

test('renewal and proof growth fail one byte above the exact history horizon, while shrinking reopens room', async () => {
  const { group, identity } = await pipelineGroup()
  const [seed] = structuredClone(group.ledger)
  expect(seed?.verified.entry.value).toMatchObject({
    op: 'seed',
    proof: asControllerLog([inception]),
  })
  const entries = group.ledger.map(({ verified }) => verified)
  const base = historySize(group.state.ratchetTree, entries)
  const room = 2_048
  const large = [inception, rotation([inception], HISTORY_HORIZON - room - base)]
  const near = await renewLeaf(
    group,
    await timedBinding({ identity, iat: 150, exp: 250, prefix: large }),
  )
  expect(historySize(near.newGroup.state.ratchetTree, entries)).toBe(HISTORY_HORIZON - room)
  const atBoundary = [...large, rotation(large, room)]
  const accepted = await renewLeaf(
    near.newGroup,
    await timedBinding({ identity, iat: 150, exp: 250, prefix: atBoundary }),
  )
  expect(historySize(accepted.newGroup.state.ratchetTree, entries)).toBe(HISTORY_HORIZON)
  const overBoundary = [...large, rotation(large, room + 1)]
  await expect(
    renewLeaf(
      near.newGroup,
      await timedBinding({ identity, iat: 150, exp: 250, prefix: overBoundary }),
    ),
  ).rejects.toMatchObject({ reason: 'history-horizon' })
  const target = agent(51).id
  const proofLog = (bytes: number): Array<SignedEvent> => {
    const probe = [inception, rotation([inception], 1_024)]
    const revBytes = controllerLogSize([revoke(probe, target)])
    const log: Array<SignedEvent> = [inception, rotation([inception], bytes - revBytes)]
    log.push(revoke(log, target))
    expect(controllerLogSize(log.slice(1))).toBe(bytes)
    return log
  }
  const exactProof = proofLog(room)
  const proof = await revokeWithProof(near.newGroup, {
    deny: [target],
    log: asControllerLog(exactProof),
  })
  expect(proof.status).toBe('built')
  if (proof.status !== 'built') throw new Error('Missing boundary proof')
  expect(proof.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
    proof: asControllerLog(JSON.parse(JSON.stringify(exactProof.slice(1)))),
  })
  expect(
    historySize(
      proof.result.newGroup.state.ratchetTree,
      proof.result.newGroup.ledger.map(({ verified }) => verified),
    ),
  ).toBe(HISTORY_HORIZON)
  const tooLargeProof = proofLog(room + 1)
  await expect(
    verifyLifecycleProof(near.newGroup, {
      issuer: identity.id,
      entry: {
        type: 'kumiai.device',
        groupID: group.groupID,
        subject: controllerID,
        value: {
          effects: denyEffects(tooLargeProof.slice(1), target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog(tooLargeProof.slice(1)),
          revoked: [{ did: target }],
        },
      },
    }),
  ).rejects.toMatchObject({ reason: 'too-large' })
  expect(
    await revokeWithProof(near.newGroup, { deny: [target], log: asControllerLog(tooLargeProof) }),
  ).toEqual({
    status: 'not-provable',
    reason: 'too-large',
  })
  const resetLog = [inception, createReset(controllerSeed, 0, 1)]
  const shrunk = await renewLeaf(
    near.newGroup,
    await timedBinding({ identity, iat: 150, exp: 250, prefix: resetLog }),
  )
  const reset = await revokeWithProof(shrunk.newGroup, {
    reset: true,
    log: asControllerLog(resetLog),
  })
  expect(reset.status).toBe('built')
  if (reset.status !== 'built') throw new Error('Missing reset')
  const reopened: Array<SignedEvent> = [...resetLog, rotation(resetLog, room)]
  reopened.push(revoke(reopened, target))
  expect(
    (
      await revokeWithProof(reset.result.newGroup, {
        deny: [target],
        log: asControllerLog(reopened),
      })
    ).status,
  ).toBe('built')
  expect(group.ledger).toEqual([seed])
  const node = shrunk.newGroup.state.ratchetTree[0]
  expect(node?.nodeType).toBe(nodeTypes.leaf)
  if (node?.nodeType === nodeTypes.leaf && 'identity' in node.leaf.credential)
    expect(parseMLSCredentialIdentity(node.leaf.credential.identity).controller?.prefix).toEqual(
      resetLog,
    )
})

async function parentGrant(identity: OwnIdentity, prefix: Array<SignedEvent>, iat: number) {
  vi.spyOn(Date, 'now').mockReturnValue(iat * 1000)
  const grant = await mintTrustedGrant({
    signer: createControllerIdentity({
      seed: controllerSeed,
      profile: 0,
      log: asControllerLog(prefix),
    }),
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
  const fixture = await lowLevelWelcome(
    group,
    trusted,
    await timedBinding({ identity: trusted, iat: 80, exp: 200 }),
  )
  const parent = await parentGrant(trusted, [inception], 90)
  const renewal = await renewLeaf(
    fixture.author,
    await timedBinding({ identity, iat: 110, exp: 210, issuer: trusted, parent }),
  )
  expect(renewal.newGroup.registry.controllers.get(controllerID)?.timeFloor).toBe(100)
  expect(treeTime(renewal.newGroup, controllerID)).toBe(100)
  for (const held of renewal.newGroup.ledger) tokens.set(held.entryID, held.token)
  await fixture.joined.processMessage(renewal.commitMessage)
  expect(fixture.joined.registry).toEqual(renewal.newGroup.registry)
  await expect(
    renewLeaf(
      renewal.newGroup,
      await timedBinding({ identity, iat: 109, exp: 220, issuer: trusted, parent }),
    ),
  ).rejects.toMatchObject({ reason: 'renewal-order' })
})

test('a lapsed member can renew itself and resume sending', async () => {
  const { group } = await pipelineGroup()
  const child = agent(61)
  const fixture = await lowLevelWelcome(
    group,
    child,
    await timedBinding({ identity: child, iat: 90, exp: 99 }),
  )
  const old = leafAt(fixture.joined.state.ratchetTree, fixture.joined.state.privatePath.leafIndex)
  if (old == null) throw new Error('Missing own leaf')
  expect(isLapsed(fixture.joined, old)).toBe(true)
  const renewal = await renewLeaf(
    fixture.joined,
    await timedBinding({ identity: child, iat: 100, exp: 200 }),
  )
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
  const binding = await timedBinding({
    identity: child,
    iat: 110,
    exp: 210,
    prefix: reset,
    issuer: agent(41),
    parent,
  })
  const unevidenced = await belowGateWelcome(group, child, withoutHolderEvidence(binding))
  expect(
    await revokeWithProof(unevidenced.joined, { reset: true, log: asControllerLog(reset) }),
  ).toEqual({
    status: 'self-affected',
    subject: child.id,
  })
  // A child carrying its holder's evidence is not cascaded, so it publishes the reset itself.
  const evidenced = await lowLevelWelcome(group, child, binding)
  const built = await revokeWithProof(evidenced.joined, {
    reset: true,
    log: asControllerLog(reset),
  })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing reset')
  expect(built.result.newGroup.listMembers().map(({ id }) => id)).toEqual([child.id])
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
  const built = await revokeWithProof(group, { deny: [target], log: asControllerLog(padded) })
  expect(built.status).toBe('built')
  expect(padded).toHaveLength(3)
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.registry.controllers.get(controllerID)?.recordedLog).toEqual({
    chain: JSON.parse(JSON.stringify([inception, rev])),
    events: [],
  })
  const foreign = createInception(new Uint8Array(32).fill(99), 0)
  expect(await revokeWithProof(group, { deny: [target], log: asControllerLog([foreign]) })).toEqual(
    {
      status: 'not-provable',
      reason: 'wrong-controller',
    },
  )
  const other = agent(71).id
  expect(
    await revokeWithProof(built.result.newGroup, {
      deny: [other],
      log: asControllerLog([inception, revoke([inception], other)]),
    }),
  ).toEqual({ status: 'not-provable', reason: 'detached' })
  const reset = [inception, createReset(controllerSeed, 0, 1)]
  expect(
    await revokeWithProof(built.result.newGroup, {
      deny: [other],
      log: asControllerLog([...reset, revoke(reset, other)]),
    }),
  ).toEqual({ status: 'not-provable', reason: 'needs-reset' })
})

test('exact-size Add and external replacement growth reject on author and receive paths', async () => {
  const { group, identity } = await pipelineGroup()
  const peer = agent(51)
  const fixture = await lowLevelWelcome(
    group,
    peer,
    await timedBinding({ identity: peer, iat: 100, exp: 200 }),
  )
  const base = historySize(fixture.author.state.ratchetTree, [])
  const prefix = [inception, rotation([inception], HISTORY_HORIZON - 1_024 - base)]
  const near = (
    await renewLeaf(fixture.author, await timedBinding({ identity, iat: 150, exp: 250, prefix }))
  ).newGroup
  const newDevice = agent(61)
  const small = [inception, rotation([inception], 2_048 - historySize(group.state.ratchetTree, []))]
  const bundle = await rawBundle(
    near,
    newDevice,
    await timedBinding({ identity: newDevice, iat: 150, exp: 250, prefix: small }),
  )
  const proposals = [
    { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
  ] as const
  await expect(
    commitWithEntries({
      group: near,
      extraProposals: [...proposals],
      enacted: [],
      requireAdmin: false,
    }),
  ).rejects.toMatchObject({ reason: 'history-horizon' })
  const hostile = await rawCommit({ group: near, proposals: [...proposals] })
  await expect(
    near.processMessage(encode(mlsMessageEncoder, hostile.commit)),
  ).rejects.toMatchObject({ reason: 'binding' })
  const longer = [...prefix, rotation(prefix, 2_048)]
  const external = await lowLevelExternal({
    group: near,
    identity,
    binding: await timedBinding({ identity, iat: 150, exp: 250, prefix: longer }),
  })
  await expect(near.processMessage(external)).rejects.toMatchObject({ reason: 'binding' })
})

test('a proof removing the newest leaf preserves tree time for the removed receiver', async () => {
  const { group, tokens } = await pipelineGroup()
  const target = agent(61)
  const fixture = await lowLevelWelcome(
    group,
    target,
    await timedBinding({ identity: target, iat: 150, exp: 250 }),
  )
  const built = await revokeWithProof(fixture.author, {
    deny: [target.id],
    log: asControllerLog([inception, revoke([inception], target.id)]),
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
  const inflated = await rawCommit({
    group,
    binding: await timedBinding({ identity, iat: 150, exp: 250, prefix }),
  })
  const oversized = deriveGroup(group, inflated.newState)
  expect(historySize(oversized.state.ratchetTree, [])).toBeGreaterThan(HISTORY_HORIZON)
  const shrunk = await renewLeaf(oversized, await timedBinding({ identity, iat: 150, exp: 250 }))
  expect(historySize(shrunk.newGroup.state.ratchetTree, [])).toBe(
    historySize(group.state.ratchetTree, []),
  )
})

test('a deny after a recorded reset uses an attached suffix', async () => {
  const { group, identity } = await pipelineGroup()
  const current: Array<SignedEvent> = [inception, createReset(controllerSeed, 0, 1)]
  const target = agent(61).id

  const renewed = await renewLeaf(
    group,
    await timedBinding({ identity, iat: 150, exp: 250, prefix: current }),
  )
  const reset = await revokeWithProof(renewed.newGroup, {
    reset: true,
    log: asControllerLog(current),
  })
  if (reset.status !== 'built') throw new Error('Missing reset')
  current.push(revoke(current, target))
  const built = await revokeWithProof(reset.result.newGroup, {
    deny: [target],
    log: asControllerLog(current),
  })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
    proof: asControllerLog(JSON.parse(JSON.stringify(current.slice(2)))),
  })
  expect(revocationOf(built.result.newGroup, target)?.proofRef).toEqual({ chainIndex: 2 })
})

test('invalid signatures, missing resets and old generations return proof reasons', async () => {
  const { group, identity } = await pipelineGroup()
  const target = agent(61).id
  expect(await revokeWithProof(group, { deny: [target], log: asControllerLog([]) })).toEqual({
    status: 'not-provable',
    reason: 'no-rev',
  })
  expect(await revokeWithProof(group, { reset: true, log: asControllerLog([inception]) })).toEqual({
    status: 'not-provable',
    reason: 'no-rev',
  })
  const invalid = revoke([inception], target)
  invalid.sigs = []
  expect(
    await revokeWithProof(group, { deny: [target], log: asControllerLog([inception, invalid]) }),
  ).toEqual({
    status: 'not-provable',
    reason: 'not-authority-signed',
  })
  const log = [inception, createReset(controllerSeed, 0, 1)]
  const renewed = await renewLeaf(
    group,
    await timedBinding({ identity, iat: 150, exp: 250, prefix: log }),
  )
  const reset = await revokeWithProof(renewed.newGroup, { reset: true, log: asControllerLog(log) })
  if (reset.status !== 'built') throw new Error('Missing reset')
  expect(
    await revokeWithProof(reset.result.newGroup, {
      deny: [target],
      log: asControllerLog([inception, revoke([inception], target)]),
    }),
  ).toEqual({ status: 'not-provable', reason: 'generation-floor' })
})

test('a member without a role builds a cascading proof and observes another member winning', async () => {
  const { group, identity, tokens } = await pipelineGroup()
  const child = agent(61)
  const parent = await parentGrant(identity, [inception], 100)
  // Only a child without its holder's evidence cascades, so every join here skips the gate.
  const first = await belowGateWelcome(
    group,
    child,
    withoutHolderEvidence(
      await timedBinding({ identity: child, iat: 110, exp: 210, issuer: identity, parent }),
    ),
  )
  const publisher = agent(71)
  const second = await belowGateWelcome(
    first.author,
    publisher,
    await timedBinding({ identity: publisher, iat: 100, exp: 200 }),
  )
  const competitor = agent(81)
  const third = await belowGateWelcome(
    second.author,
    competitor,
    await timedBinding({ identity: competitor, iat: 100, exp: 200 }),
  )
  await second.joined.processMessage(third.message)
  const log = [inception, revoke([inception], identity.id)]
  expect(second.joined.roster.roles.has(publisher.id)).toBe(false)
  const before = structuredClone(second.joined.state)
  const built = await revokeWithProof(second.joined, {
    deny: [identity.id],
    log: asControllerLog(log),
  })
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
  expect(
    await revokeWithProof(competing, { deny: [identity.id], log: asControllerLog(log) }),
  ).toEqual({
    status: 'already-revoked',
  })
})

test('peer:4 members sign self-verifying proof entries using their leaf long form', async () => {
  const identity = await createIdentity({
    didMethod: 'peer:4',
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(121) }],
  })
  const { group } = await createGroup(identity, 'peer-proof', {
    controller: await timedBinding({ identity, iat: 100, exp: 200 }),
    controllerLog: { chain: [inception], events: [] },
  })
  const target = agent(61).id
  const built = await revokeWithProof(group, {
    deny: [target],
    log: asControllerLog([inception, revoke([inception], target)]),
  })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.ledger.at(-1)?.verified.issuer).toBe(identity.id)
})

test.each(['revoke', 'reset'] as const)(
  'the first %s proof selects the latest reset segment for a repeated subject',
  async (op) => {
    const { group, identity } = await pipelineGroup()
    const target = agent(61).id
    const oldRevoke = revoke([inception], target)
    const reset = createReset(controllerSeed, 0, 1)
    const current = [inception, reset]
    const currentRevoke = revoke(current, target)
    const log = [inception, oldRevoke, reset, currentRevoke]
    const renewed = await renewLeaf(
      group,
      await timedBinding({ identity, iat: 150, exp: 250, prefix: current }),
    )
    let proofGroup = renewed.newGroup
    if (op === 'revoke') {
      const recordedReset = await revokeWithProof(proofGroup, {
        reset: true,
        log: asControllerLog(current),
      })
      expect(recordedReset.status).toBe('built')
      if (recordedReset.status !== 'built') throw new Error('Missing reset')
      proofGroup = recordedReset.result.newGroup
    }
    const before = structuredClone(proofGroup.state)
    const ledgerBefore = [...proofGroup.ledgerTokens]
    expect(proofGroup.ledger[0]?.verified.entry.value).toMatchObject({ op: 'seed' })
    const originalLog = structuredClone(log)
    const built = await revokeWithProof(
      proofGroup,
      op === 'reset'
        ? { reset: true, log: asControllerLog(log) }
        : { deny: [target], log: asControllerLog(log) },
    )
    expect(built.status).toBe('built')
    if (built.status !== 'built') throw new Error('Missing proof')
    const expected = JSON.parse(JSON.stringify([inception, reset, currentRevoke]))
    expect(built.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
      proof: asControllerLog(op === 'revoke' ? expected.slice(2) : expected),
    })
    expect(built.result.newGroup.ledgerTokens).toEqual([
      ...ledgerBefore,
      built.result.newGroup.ledger.at(-1)?.token,
    ])
    expect(built.result.newGroup.registry.controllers.get(controllerID)?.recordedLog).toEqual({
      chain: expected,
      events: [],
    })
    expect(built.result.newGroup.registry.controllers.get(controllerID)?.genFloor).toBe(1)
    if (op === 'revoke') {
      expect(revocationOf(built.result.newGroup, target)?.proofRef).toEqual({ chainIndex: 2 })
      expect(built.result.newGroup.registry.devices.get(target)?.proofRef).toEqual({
        chainIndex: 2,
      })
    }
    expect(proofGroup.state).toEqual(before)
    expect(log).toEqual(originalLog)
  },
)

test('a first proof cannot use a subject revoke before the latest reset', async () => {
  const reset = createReset(controllerSeed, 0, 1)
  const { group } = await pipelineGroup({ controllerLog: asControllerLog([inception, reset]) })
  const [seed] = structuredClone(group.ledger)
  expect(seed?.verified.entry.value).toMatchObject({
    op: 'seed',
    proof: asControllerLog([inception, reset]),
  })
  expect(group.ledger).toEqual([seed])
  const target = agent(61).id
  const log = [inception, revoke([inception], target), reset]
  expect(await revokeWithProof(group, { deny: [target], log: asControllerLog(log) })).toEqual({
    status: 'not-provable',
    reason: 'no-rev',
  })
  expect(group.ledger).toEqual([seed])
})

test('proof construction carries the retaining rotate after a deny gain', async () => {
  const { group } = await pipelineGroup()
  const subject = agent(61).id
  const chain: Array<SignedEvent> = [inception]
  chain.push(revokeChain({ seed: controllerSeed, profile: 0, did: controllerID, chain, subject }))
  chain.push(rotateChain({ seed: controllerSeed, profile: 0, did: controllerID, chain }))
  const built = await revokeWithProof(group, { deny: [subject], log: asControllerLog(chain) })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(revocationOf(built.result.newGroup, subject)?.proofRef).toEqual({ chainIndex: 1 })
  expect(built.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
    proof: asControllerLog(JSON.parse(JSON.stringify(chain.slice(1)))),
  })
})

test('proof construction refuses a reset snapshot denial as a revoke', async () => {
  const subject = agent(61).id
  const log = [inception, createReset(controllerSeed, 0, 1, { members: [], deny: [subject] })]
  const { group } = await pipelineGroup({
    controllerLog: asControllerLog([inception]),
  })
  expect(await revokeWithProof(group, { deny: [subject], log: asControllerLog(log) })).toEqual({
    status: 'not-provable',
    reason: 'needs-reset',
  })
})

test('replayed deny is already-revoked', async () => {
  const { group } = await pipelineGroup()
  const target = agent(51).id
  const log = asControllerLog([inception, revoke([inception], target)])
  const snapshot = structuredClone(log)
  const built = await revokeWithProof(group, { log, deny: [target] })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(log).toEqual(snapshot)
  expect(await revokeWithProof(built.result.newGroup, { log, deny: [target] })).toEqual({
    status: 'already-revoked',
  })
})

test('revokeWithProof declares both denials carried by the closure', async () => {
  const f = await buildEpoch({ members: 2 })
  const { group } = await pipelineGroup({ controllerLog: f.log })
  const a = f.members[0]
  const b = f.members[1]
  if (a == null || b == null) throw new Error('Missing members')
  const targets = [agent(61).id, agent(71).id].sort()
  const first = createRevoke({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { member: a },
    target: targets[0] as string,
  })
  const log: ControllerLog = { chain: f.log.chain, events: [...f.log.events, first] }
  const folded = foldControllerLog(f.did, log)
  if (!folded.ok) throw new Error(folded.reason)
  const second = createRevoke({
    did: f.did,
    head: folded.head,
    parents: epochHeads(f.did, log),
    signer: { member: b },
    target: targets[1] as string,
  })
  log.events.push(second)
  const copy = structuredClone(log)
  const built = await revokeWithProof(group, { log, deny: [targets[0] as string] })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.ledger.at(-1)?.verified.entry).toMatchObject({
    subject: f.did,
    value: {
      effects: [
        { kind: 'deny', did: targets[0], ref: { event: digestOf(first.event) } },
        { kind: 'deny', did: targets[1], ref: { event: digestOf(second.event) } },
      ],
      revoked: targets.map((did) => ({ did })),
      removed: [],
    },
  })
  expect(built.effects).toEqual([
    { kind: 'deny', did: targets[0], ref: { event: digestOf(first.event) } },
    { kind: 'deny', did: targets[1], ref: { event: digestOf(second.event) } },
  ])
  expect(log).toEqual(copy)
})

test('revokeWithProof deny of a member DID by a member is not provable', async () => {
  const f = await buildEpoch({ members: 2 })
  const { group } = await pipelineGroup({ controllerLog: f.log })
  const a = f.members[0]
  const b = f.members[1]
  if (a == null || b == null) throw new Error('Missing members')
  const rev = createRevoke({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { member: a },
    target: b.did,
  })
  const log = { chain: f.log.chain, events: [...f.log.events, rev] }
  expect(await revokeWithProof(group, { log, deny: [b.did] })).toEqual({
    status: 'not-provable',
    reason: 'no-rev',
  })
  const settle = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: { ...snapshotOf(f.head), deny: [b.did] },
  })
  const built = await revokeWithProof(group, {
    log: asControllerLog([f.inception, settle]),
    deny: [b.did],
  })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
    effects: [{ kind: 'deny', did: b.identity.id, ref: { chainIndex: 1 } }],
  })
})

test('re-revoke after reset accepted at gen 2', async () => {
  const { group, identity } = await pipelineGroup()
  const target = agent(61).id
  const first = await revokeWithProof(group, {
    log: asControllerLog([inception, revoke([inception], target)]),
    deny: [target],
  })
  if (first.status !== 'built') throw new Error('Missing first denial')
  const prefix = [inception, createReset(controllerSeed, 0, 2)]
  const renewed = await renewLeaf(
    first.result.newGroup,
    await timedBinding({ identity, iat: 150, exp: 250, prefix }),
  )
  const reset = await revokeWithProof(renewed.newGroup, {
    reset: true,
    log: asControllerLog(prefix),
  })
  if (reset.status !== 'built') throw new Error('Missing reset')
  const log = asControllerLog([...prefix, revoke(prefix, target)])
  const built = await revokeWithProof(reset.result.newGroup, { log, deny: [target] })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing repeated denial')
  expect(built.result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
    effects: [{ kind: 'deny', did: target, ref: { chainIndex: 2 } }],
  })
  expect(built.result.newGroup.registry.controllers.get(controllerID)?.genFloor).toBe(2)
})

test('deny of a long-form did:peer:4 matches the short-form leaf', async () => {
  const { group } = await pipelineGroup()
  const peer = await createIdentity({
    didMethod: 'peer:4',
    keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(122) }],
  })
  if (peer.longForm == null) throw new Error('Missing peer long form')
  const fixture = await lowLevelWelcome(
    group,
    peer,
    await timedBinding({ identity: peer, iat: 100, exp: 200 }),
  )
  const built = await revokeWithProof(fixture.author, {
    log: asControllerLog([inception, revoke([inception], peer.longForm)]),
    deny: [peer.longForm],
  })
  expect(built.status).toBe('built')
  if (built.status !== 'built') throw new Error('Missing proof')
  expect(built.result.newGroup.findMemberLeafIndex(peer.id)).toBeUndefined()
  expect(revocationOf(built.result.newGroup, peer.id)).toEqual({
    controller: controllerID,
    proofRef: { chainIndex: 1 },
  })
})
