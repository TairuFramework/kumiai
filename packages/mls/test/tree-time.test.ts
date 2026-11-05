import {
  createAdd,
  createInception,
  createRemove,
  createReset,
  didFromInception,
  digestOf,
  encodeKey,
  epochHeads,
  snapshotOf,
} from '@kokuin/controller'
import type { OwnIdentity } from '@kokuin/token'
import { type ClientState, nodeTypes } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import { mintLeafCapability } from '../src/capability.js'
import { foldControllerLog } from '../src/controller-log.js'
import { deriveGroup } from '../src/group-handle.js'
import { attestedTreeTime, isLapsed, leafAt, treeTime } from '../src/lifecycle.js'
import { registryForLog } from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { agent, pipelineGroup, rawBundle, timedBinding } from './fixtures/lifecycle-pipeline.js'

afterEach(() => vi.restoreAllMocks())

type Epoch = Awaited<ReturnType<typeof buildEpoch>>

async function memberLeaf(
  f: Epoch,
  index: number,
  iat: number,
  options: { add?: string; generation?: number; issuer?: OwnIdentity; controllerID?: string } = {},
) {
  const member = f.members[index]
  if (member == null) throw new Error('Missing member')
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { group } = await pipelineGroup()
  vi.spyOn(Date, 'now').mockReturnValue(iat * 1000)
  const identity = agent(70 + index)
  const capability = await mintLeafCapability({
    signer: options.issuer ?? member.identity,
    controllerID: options.controllerID ?? f.did,
    audience: identity.id,
    leafKey: identity.publicKey,
    exp: 1000,
    member: { add: options.add ?? member.add, g: options.generation ?? 0 },
  })
  return (
    await rawBundle(group, identity, {
      id: options.controllerID ?? f.did,
      prefix: f.log.chain,
      capability,
    })
  ).publicPackage.leafNode
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
  const candidate = await deriveGroup(group, { ...group.state, ratchetTree: tree(own, high) })
  expect(await treeTime(candidate, f.did)).toBe(100)
  expect(await isLapsed(candidate, own)).toBe(false)
})

test('two members agreeing advance tree time to the lower of their attestations', async () => {
  const f = await buildEpoch({ members: 2 })
  const leaves = tree(await memberLeaf(f, 0, 200), await memberLeaf(f, 1, 150))
  expect(
    await attestedTreeTime({
      tree: leaves,
      registry: await registryForLog({ controller: f.did, log: f.log }),
      controllerID: f.did,
    }),
  ).toBe(150)
})

test('sole effective member advances tree time', async () => {
  const f = await buildEpoch({ members: 1 })
  expect(
    await attestedTreeTime({
      tree: tree(await memberLeaf(f, 0, 200)),
      registry: await registryForLog({ controller: f.did, log: f.log }),
      controllerID: f.did,
    }),
  ).toBe(200)
})

test('a member token from a stale generation does not advance tree time', async () => {
  const f = await buildEpoch({ members: 1 })
  const reset = await createReset({
    seed: f.seed,
    profile: 0,
    gen: 1,
    snapshot: snapshotOf({ state: f.head }),
  })
  const registry = await registryForLog({
    controller: f.did,
    log: { chain: [f.inception, reset], events: [] },
  })
  expect(
    await attestedTreeTime({
      tree: tree(await memberLeaf(f, 0, 200)),
      registry,
      controllerID: f.did,
    }),
  ).toBe(0)
  expect(
    await attestedTreeTime({
      tree: tree(await memberLeaf(f, 0, 200, { generation: 1 })),
      registry,
      controllerID: f.did,
    }),
  ).toBe(200)
})

test('a token whose issuer differs from the pinned member DID does not advance tree time', async () => {
  const f = await buildEpoch({ members: 1 })
  const registry = await registryForLog({ controller: f.did, log: f.log })
  const leaf = await memberLeaf(f, 0, 200, { issuer: agent(91) })
  expect(await attestedTreeTime({ tree: tree(leaf), registry, controllerID: f.did })).toBe(0)
  expect(
    await attestedTreeTime({
      tree: tree(await memberLeaf(f, 0, 200)),
      registry,
      controllerID: f.did,
    }),
  ).toBe(200)
})

test('a member token for another controller does not advance tree time', async () => {
  const f = await buildEpoch({ members: 1 })
  const registry = await registryForLog({ controller: f.did, log: f.log })
  const other = await createInception({ seed: new Uint8Array(32).fill(32), profile: 0 })
  const leaf = await memberLeaf(f, 0, 200, { controllerID: didFromInception(other.event) })
  expect(await attestedTreeTime({ tree: tree(leaf), registry, controllerID: f.did })).toBe(0)
  expect(
    await attestedTreeTime({
      tree: tree(await memberLeaf(f, 0, 200)),
      registry,
      controllerID: f.did,
    }),
  ).toBe(200)
})

test('a token naming a non-effective member add does not advance tree time', async () => {
  const f = await buildEpoch({ members: 1 })
  const a = f.members[0]
  if (a == null) throw new Error('Missing member')
  const removal = await createRemove({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: f.root,
    add: a.add,
  })
  const removedLog = { chain: f.log.chain, events: [...f.log.events, removal] }
  const removed = await registryForLog({ controller: f.did, log: removedLog })
  const recorded = removed.controllers.get(f.did)?.recordedLog
  if (recorded == null) throw new Error('Missing recorded log')
  const folded = await foldControllerLog(f.did, recorded)
  if (!folded.ok) throw new Error(folded.reason)
  const add = await createAdd({
    seed: f.seed,
    profile: 0,
    did: f.did,
    head: folded.head,
    parents: await epochHeads({ did: f.did, log: removedLog }),
    member: {
      did: a.did,
      key: encodeKey({ publicKey: a.identity.publicKey, alg: 'EdDSA' }),
      lease: 1100,
    },
  })
  const registry = await registryForLog({
    controller: f.did,
    log: {
      ...removedLog,
      events: [...removedLog.events, add],
    },
  })
  expect(
    await attestedTreeTime({
      tree: tree(await memberLeaf(f, 0, 200)),
      registry,
      controllerID: f.did,
    }),
  ).toBe(0)
  expect(
    await attestedTreeTime({
      tree: tree(await memberLeaf(f, 0, 200, { add: digestOf(add.event) })),
      registry,
      controllerID: f.did,
    }),
  ).toBe(200)
})

test('two incarnations of one pinned key count once', async () => {
  const f = await buildEpoch({ members: 2 })
  const a = f.members[0]
  if (a == null || a.event.event.t !== 'add') throw new Error('Missing add')
  const concurrent = await createAdd({
    seed: f.seed,
    profile: 0,
    did: f.did,
    head: f.head,
    parents: [f.head.epoch],
    member: {
      did: a.did,
      key: encodeKey({ publicKey: a.identity.publicKey, alg: 'EdDSA' }),
      lease: 1100,
    },
  })
  const log = { chain: f.log.chain, events: [...f.log.events, concurrent] }
  const leaves = tree(
    await memberLeaf(f, 0, 200),
    await memberLeaf(f, 0, 250, { add: digestOf(concurrent.event) }),
  )
  const registry = await registryForLog({ controller: f.did, log })
  expect(await attestedTreeTime({ tree: leaves, registry, controllerID: f.did })).toBe(0)
})

test('root-issued leaves still advance tree time (0.11 behaviour)', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const { group } = await pipelineGroup()
  const identity = agent(71)
  const leaf = (
    await rawBundle(group, identity, await timedBinding({ identity, iat: 150, exp: 250 }))
  ).publicPackage.leafNode
  expect(
    await attestedTreeTime({
      tree: tree(leaf),
      registry: group.registry,
      controllerID: group.anchor.controller as string,
    }),
  ).toBe(150)
})

test("removed member's attestation stops counting; the preserved floor stays", async () => {
  const f = await buildEpoch({ members: 2 })
  const a = f.members[0]
  const b = f.members[1]
  if (a == null || b == null) throw new Error('Missing member')
  const leaves = tree(await memberLeaf(f, 0, 200), await memberLeaf(f, 1, 150))
  const removal = await createRemove({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: f.root,
    add: a.add,
  })
  const registry = await registryForLog({
    controller: f.did,
    log: {
      chain: f.log.chain,
      events: [...f.log.events, removal],
    },
  })
  const projection = registry.controllers.get(f.did)
  if (projection == null) throw new Error('Missing projection')
  const attestations = new Map([
    [encodeKey({ publicKey: a.identity.publicKey, alg: 'EdDSA' }), 900],
  ])
  const withClock = {
    ...registry,
    controllers: new Map([[f.did, { ...projection, attestations }]]),
  }
  expect(await attestedTreeTime({ tree: leaves, registry: withClock, controllerID: f.did })).toBe(
    150,
  )
  const { group } = await pipelineGroup()
  vi.spyOn(Date, 'now').mockReturnValue(999_000)
  const membership = await rawBundle(group, b.identity, {
    id: f.did,
    prefix: f.log.chain,
    member: { add: b.add, g: 0 },
    iat: 999,
  })
  expect(
    await attestedTreeTime({
      tree: tree(membership.publicPackage.leafNode),
      registry: {
        ...registry,
        controllers: new Map([[f.did, { ...projection, timeFloor: 150, attestations }]]),
      },
      controllerID: f.did,
    }),
  ).toBe(150)
})
