import { createAdd, createRemove, digestOf, encodeKey, epochHeads } from '@kokuin/controller'
import { type ClientState, nodeTypes } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import { mintLeafCapability } from '../src/capability.js'
import { deriveGroup } from '../src/group-handle.js'
import { attestedTreeTime, isLapsed, leafAt, treeTime } from '../src/lifecycle.js'
import { registryForLog } from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { agent, pipelineGroup, rawBundle, timedBinding } from './fixtures/lifecycle-pipeline.js'

afterEach(() => vi.restoreAllMocks())

type Epoch = Awaited<ReturnType<typeof buildEpoch>>

async function memberLeaf(f: Epoch, index: number, iat: number, add?: string) {
  const member = f.members[index]
  if (member == null) throw new Error('Missing member')
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { group } = await pipelineGroup()
  vi.spyOn(Date, 'now').mockReturnValue(iat * 1000)
  const identity = agent(70 + index)
  const capability = await mintLeafCapability({
    signer: member.identity,
    controllerID: f.did,
    audience: identity.id,
    leafKey: identity.publicKey,
    exp: 1000,
    member: { add: add ?? member.add, g: 0 },
  })
  return (await rawBundle(group, identity, { id: f.did, prefix: f.log.chain, capability }))
    .publicPackage.leafNode
}

function tree(
  ...leaves: Array<NonNullable<ReturnType<typeof leafAt>>>
): ClientState['ratchetTree'] {
  return leaves.flatMap((leaf, index) => [
    ...(index === 0 ? [] : [undefined]),
    { nodeType: nodeTypes.leaf, leaf } as const,
  ])
}

test('single member of two with iat = lease - 60 does not lapse other leaves', async () => {
  const f = await buildEpoch({ members: 2 })
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { group } = await pipelineGroup({ controllerLog: f.log })
  const own = leafAt(group.state.ratchetTree, 0)
  if (own == null) throw new Error('Missing leaf')
  const high = await memberLeaf(f, 0, 940)
  const candidate = deriveGroup(group, { ...group.state, ratchetTree: tree(own, high) })
  expect(treeTime(candidate, f.did)).toBe(100)
  expect(isLapsed(candidate, own)).toBe(false)
})

test('two members agreeing advance tree time to the lower of their attestations', async () => {
  const f = await buildEpoch({ members: 2 })
  const leaves = tree(await memberLeaf(f, 0, 200), await memberLeaf(f, 1, 150))
  expect(attestedTreeTime(leaves, registryForLog(f.did, f.log), f.did)).toBe(150)
})

test('sole effective member advances tree time', async () => {
  const f = await buildEpoch({ members: 1 })
  expect(
    attestedTreeTime(tree(await memberLeaf(f, 0, 200)), registryForLog(f.did, f.log), f.did),
  ).toBe(200)
})

test('two incarnations of one pinned key count once', async () => {
  const f = await buildEpoch({ members: 2 })
  const a = f.members[0]
  if (a == null || a.event.event.t !== 'add') throw new Error('Missing add')
  const concurrent = createAdd({
    seed: f.seed,
    profile: 0,
    did: f.did,
    head: f.head,
    parents: [f.head.epoch],
    member: { did: a.did, key: encodeKey(a.identity.publicKey, 'EdDSA'), lease: 1100 },
  })
  const log = { chain: f.log.chain, events: [...f.log.events, concurrent] }
  const leaves = tree(
    await memberLeaf(f, 0, 200),
    await memberLeaf(f, 0, 250, digestOf(concurrent.event)),
  )
  const registry = registryForLog(f.did, log)
  expect(attestedTreeTime(leaves, registry, f.did)).toBe(0)
})

test('root-issued leaves still advance tree time (0.11 behaviour)', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { group } = await pipelineGroup()
  const identity = agent(71)
  const leaf = (
    await rawBundle(group, identity, await timedBinding({ identity, iat: 150, exp: 250 }))
  ).publicPackage.leafNode
  expect(attestedTreeTime(tree(leaf), group.registry, group.anchor.controller as string)).toBe(150)
})

test("removed member's attestation stops counting; the preserved floor stays", async () => {
  const f = await buildEpoch({ members: 2 })
  const a = f.members[0]
  const b = f.members[1]
  if (a == null || b == null) throw new Error('Missing member')
  const leaves = tree(await memberLeaf(f, 0, 200), await memberLeaf(f, 1, 150))
  const removal = createRemove({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: f.root,
    add: a.add,
  })
  const registry = registryForLog(f.did, { chain: f.log.chain, events: [...f.log.events, removal] })
  const projection = registry.controllers.get(f.did)
  if (projection == null) throw new Error('Missing projection')
  const attestations = new Map([[encodeKey(a.identity.publicKey, 'EdDSA'), 900]])
  const withClock = {
    ...registry,
    controllers: new Map([[f.did, { ...projection, attestations }]]),
  }
  expect(attestedTreeTime(leaves, withClock, f.did)).toBe(150)
  const { group } = await pipelineGroup()
  vi.spyOn(Date, 'now').mockReturnValue(999_000)
  const membership = await rawBundle(group, b.identity, {
    id: f.did,
    prefix: f.log.chain,
    member: { add: b.add, g: 0 },
    iat: 999,
  })
  expect(
    attestedTreeTime(
      tree(membership.publicPackage.leafNode),
      {
        ...registry,
        controllers: new Map([[f.did, { ...projection, timeFloor: 150, attestations }]]),
      },
      f.did,
    ),
  ).toBe(150)
})
