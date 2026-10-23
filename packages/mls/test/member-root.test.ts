import { audienceConfirmation } from '@kokuin/capability'
import {
  type ControllerLog,
  createRemove,
  createReset,
  createRotate,
  digestOf,
  epochHeads,
  snapshotOf,
} from '@kokuin/controller'
import { normalizeDID, type SigningIdentity, stringifyToken } from '@kokuin/token'
import { beforeAll, expect, test } from 'vitest'

import { foldControllerLog } from '../src/controller-log.js'
import type { ControllerBinding } from '../src/credential.js'
import * as api from '../src/index.js'
import { memberRootsOf } from '../src/index.js'
import type { EffectClaim, LeafRef, MemberRoot } from '../src/member-root.js'
import {
  controllerProjection,
  type DeviceRegistry,
  registryForLog,
  registrySeed,
} from '../src/registry.js'
import { buildEpoch, saturatedLog } from './fixtures/controller-epoch.js'
import { leafCapabilityFixture } from './fixtures/leaf-capability.js'

test('memberRootsOf reads direct, parent, holder, membership and root roots', async () => {
  const f = await leafCapabilityFixture()
  const memberToken = stringifyToken(
    await f.trusted.signToken({
      ...f.childPayload,
      cap: undefined,
      mbr: { add: 'member-add', g: 2 },
    }),
  )
  const child = stringifyToken(await f.device.signToken({ ...f.childPayload, cap: memberToken }))
  const binding = { id: f.controller.id, prefix: [] }
  const member = { kind: 'member', did: f.trusted.id, add: 'member-add', gen: 2 }
  const root = { kind: 'root', controller: f.controller.id }
  const cases: Array<{ binding: ControllerBinding; expected: unknown }> = [
    {
      binding: { ...binding, capability: memberToken },
      expected: [{ slot: 'capability', root: member }],
    },
    {
      binding: { ...binding, capability: child },
      expected: [{ slot: 'parent', root: member }],
    },
    {
      binding: { ...binding, capability: child, holderGrant: f.parent },
      expected: [
        { slot: 'parent', root: member },
        { slot: 'holder', root },
      ],
    },
    {
      binding: { ...binding, member: { add: 'own-add', g: 0 }, iat: 100 },
      expected: [
        { slot: 'membership', root: { kind: 'member', did: f.device.id, add: 'own-add', gen: 0 } },
      ],
    },
    {
      binding: { ...binding, capability: f.parent, holderGrant: memberToken },
      expected: [
        { slot: 'capability', root },
        { slot: 'holder', root: member },
      ],
    },
  ]
  for (const entry of cases) {
    expect(memberRootsOf(entry.binding, f.device.id)).toEqual(entry.expected)
  }
})

function head(did: string, log: ControllerLog) {
  const folded = foldControllerLog(did, log)
  if (!folded.ok) throw new Error(folded.reason)
  return folded.head
}

async function authorityFixture() {
  const f = await buildEpoch({ members: 2, renewEvery: 1000, until: 1000 })
  const [a, b] = f.members
  if (a == null || b == null) throw new Error('Missing members')
  const tokens = await leafCapabilityFixture()
  const grant = async (
    signer: SigningIdentity,
    audience: SigningIdentity,
    add: string,
    extra: Record<string, unknown> = {},
  ) =>
    stringifyToken(
      await signer.signToken({
        sub: f.did,
        aud: audience.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: audience.publicKey }),
        iat: 100,
        exp: 900,
        mbr: { add, g: 0 },
        ...extra,
      }),
    )
  const parent = await grant(a.identity, tokens.trusted, a.add)
  const direct = await grant(a.identity, tokens.trusted, a.add)
  const child = stringifyToken(
    await tokens.trusted.signToken({ ...tokens.childPayload, sub: f.did, cap: parent }),
  )
  const holder = await grant(b.identity, tokens.device, b.add)
  const binding = { id: f.did, prefix: f.log.chain }
  const leaf: LeafRef = {
    did: tokens.device.id,
    binding: { ...binding, capability: child },
    leafKey: tokens.device.publicKey,
  }
  const rmv = createRemove({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { member: b },
    add: a.add,
  })
  const removedLog = { chain: f.log.chain, events: [...f.log.events, rmv] }
  const before = registryForLog(f.did, f.log)
  const after = registryForLog(f.did, removedLog)
  return { ...f, a, b, tokens, grant, direct, holder, leaf, binding, removedLog, before, after }
}

let f: Awaited<ReturnType<typeof authorityFixture>>
let saturated: ControllerLog
beforeAll(async () => {
  f = await authorityFixture()
  saturated = await saturatedLog()
})

test.each([
  'root',
  'effective',
  'rmv',
  'generation',
  'tombstone',
  'unknown-incarnation',
  'no-log',
  'saturated',
] as const)('memberRootStatus table: %s', (row) => {
  let registry = f.before
  let root: MemberRoot = { kind: 'member', did: f.a.identity.id, add: f.a.add, gen: 0 }
  let expected: unknown
  switch (row) {
    case 'root':
      root = { kind: 'root', controller: f.did }
      expected = { status: 'root' }
      break
    case 'effective':
      expected = { status: 'effective', key: f.a.identity.publicKey, lease: 2000 }
      break
    case 'rmv':
      registry = f.after
      expected = { status: 'removed' }
      break
    case 'generation':
      registry = registryForLog(f.did, {
        chain: [f.inception, createReset(f.seed, 0, 1)],
        events: [],
      })
      expected = { status: 'removed' }
      break
    case 'tombstone': {
      const settle = createRotate({
        seed: f.seed,
        profile: 0,
        did: f.did,
        prior: f.inception.event,
        snapshot: snapshotOf(head(f.did, f.removedLog)),
      })
      registry = registryForLog(f.did, { chain: [f.inception, settle], events: [] })
      const projection = registry.controllers.get(f.did)
      if (projection == null) throw new Error('Missing projection')
      registry = {
        ...registry,
        controllers: new Map([
          [
            f.did,
            {
              ...projection,
              removedMembers: new Map([
                [
                  f.a.add,
                  {
                    did: f.a.identity.id,
                    gen: 0,
                    proofRef: { event: 'recorded-removal', epoch: digestOf(f.inception.event) },
                  },
                ],
              ]),
            },
          ],
        ]),
      }
      expected = { status: 'removed' }
      break
    }
    case 'unknown-incarnation':
      root = { ...root, add: 'unknown' }
      expected = { status: 'unavailable', why: row }
      break
    case 'no-log':
      registry = registrySeed()
      expected = { status: 'unavailable', why: row }
      break
    case 'saturated':
      registry = {
        devices: new Map(),
        controllers: new Map([[f.did, { ...controllerProjection(), recordedLog: saturated }]]),
      }
      expected = { status: 'unavailable', why: row }
      break
  }
  expect(api.memberRootStatus(registry, f.did, root)).toEqual(expected)
})

test('memberRootStatus refuses a DID that does not name the incarnation', () => {
  expect(
    api.memberRootStatus(f.before, f.did, { kind: 'member', did: f.b.did, add: f.a.add, gen: 0 }),
  ).toEqual({ status: 'unavailable', why: 'unknown-incarnation' })
})

test('member introduced through a settlement snapshot is effective with no epoch events', () => {
  const settle = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
  })
  const registry = registryForLog(f.did, { chain: [f.inception, settle], events: [] })
  expect(
    api.memberRootStatus(registry, f.did, { kind: 'member', did: f.a.did, add: f.a.add, gen: 0 }),
  ).toEqual({ status: 'effective', key: f.a.identity.publicKey, lease: 2000 })
})

test('memberRootStatus treats a canonically denied member as removed', () => {
  const reset = createReset(f.seed, 0, 1, { ...snapshotOf(f.head), deny: [f.a.identity.id] })
  const registry = registryForLog(f.did, { chain: [f.inception, reset], events: [] })
  expect(
    api.memberRootStatus(registry, f.did, { kind: 'member', did: f.a.did, add: f.a.add, gen: 1 }),
  ).toEqual({ status: 'removed' })
})

test("effectiveAuthorityOf uses the holder substitute when the parent's member is removed", () => {
  const leaf = { ...f.leaf, binding: { ...f.leaf.binding, holderGrant: f.holder } }
  expect(api.effectiveAuthorityOf(leaf, f.before, f.did)).toEqual({
    root: { kind: 'member', did: f.a.did, add: f.a.add, gen: 0 },
    slot: 'parent',
  })
  expect(api.effectiveAuthorityOf(leaf, f.after, f.did)).toEqual({
    root: { kind: 'member', did: f.b.did, add: f.b.add, gen: 0 },
    slot: 'holder',
  })
})

test('effectiveAuthorityOf uses a registered survivor grant', () => {
  const projection = f.after.controllers.get(f.did)
  if (projection == null) throw new Error('Missing projection')
  const registry = {
    ...f.after,
    controllers: new Map([
      [f.did, { ...projection, survivorGrants: new Map([[normalizeDID(f.leaf.did), f.holder]]) }],
    ]),
  }
  expect(api.effectiveAuthorityOf(f.leaf, registry, f.did)).toEqual({
    root: { kind: 'member', did: f.b.did, add: f.b.add, gen: 0 },
    slot: 'survivor',
  })
})

test.each(['aud', 'cnf'] as const)(
  "effectiveAuthorityOf refuses a substitute whose %s is another leaf's",
  async (field) => {
    const holder = await f.grant(f.b.identity, f.tokens.device, f.b.add, {
      [field]:
        field === 'aud'
          ? f.tokens.trusted.id
          : audienceConfirmation({ alg: 'EdDSA', publicKey: f.tokens.trusted.publicKey }),
    })
    const leaf = { ...f.leaf, binding: { ...f.leaf.binding, holderGrant: holder } }
    expect(api.effectiveAuthorityOf(leaf, f.after, f.did)).toEqual({ status: 'removed' })
    const projection = f.after.controllers.get(f.did)
    if (projection == null) throw new Error('Missing projection')
    const registry = {
      ...f.after,
      controllers: new Map([
        [f.did, { ...projection, survivorGrants: new Map([[f.leaf.did, holder]]) }],
      ]),
    }
    expect(api.effectiveAuthorityOf(f.leaf, registry, f.did)).toEqual({ status: 'removed' })
  },
)

test('effectiveAuthorityOf reports a prefix absent from the recorded chain as unavailable', () => {
  const fork = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
    seal: 'unrecorded',
  })
  const leaf = {
    ...f.leaf,
    binding: { ...f.leaf.binding, prefix: [f.inception, fork], holderGrant: f.holder },
  }
  expect(api.effectiveAuthorityOf(leaf, f.after, f.did)).toEqual({ status: 'unavailable' })
})

function removal(): EffectClaim {
  return {
    kind: 'remove',
    member: { did: f.a.did, add: f.a.add },
    ref: { event: 'recorded-removal' },
  }
}

function removalLeaves() {
  return [
    {
      did: f.tokens.trusted.id,
      leafKey: f.tokens.trusted.publicKey,
      leafIndex: 3,
      binding: { ...f.binding, capability: f.direct },
    },
    { ...f.leaf, leafIndex: 4 },
    {
      did: f.a.did,
      leafIndex: 6,
      leafKey: f.a.identity.publicKey,
      binding: { ...f.binding, member: { add: f.a.add, g: 0 }, iat: 100 },
    },
  ]
}

test("cascadeOf: rmv cascades a direct mbr leaf, a leaf whose parent came from the removed member, and the member's own membership leaf", () => {
  const leaves = removalLeaves()
  const result = api.cascadeOf(leaves, [removal()], f.before, f.after, f.did)
  expect(result.removeLeafIndices).toEqual([3, 4, 6])
  expect(result.removed).toEqual(
    leaves.map((leaf) => ({
      did: normalizeDID(leaf.did),
      cascadedFrom: f.a.identity.id,
    })),
  )
  expect(result.revoked).toEqual([])
})

test('cascadeOf: rmv keeps a leaf whose holder grant came from another effective member', () => {
  const leaf = { ...f.leaf, leafIndex: 1, binding: { ...f.leaf.binding, holderGrant: f.holder } }
  expect(api.cascadeOf([leaf], [removal()], f.before, f.after, f.did)).toEqual({
    revoked: [],
    removed: [],
    removeLeafIndices: [],
  })
})

test('cascadeOf: edge deny cascades its chained leaves only', async () => {
  const target = f.tokens.trusted.id
  const claims: Array<EffectClaim> = [
    { kind: 'deny', did: target, ref: { event: 'edge-revocation' } },
  ]
  const after: DeviceRegistry = {
    ...f.before,
    devices: new Map([[target, { controller: f.did, status: 'revoked' }]]),
  }
  const leaves = [
    { ...f.leaf, leafIndex: 1 },
    {
      did: f.b.did,
      leafKey: f.b.identity.publicKey,
      leafIndex: 2,
      binding: { ...f.binding, capability: await f.grant(f.a.identity, f.b.identity, f.a.add) },
    },
  ]
  expect(api.cascadeOf(leaves, claims, f.before, after, f.did)).toEqual({
    revoked: [{ did: target }, { did: f.leaf.did, cascadedFrom: target }],
    removed: [],
    removeLeafIndices: [1],
  })
  leaves[0] = {
    ...leaves[0],
    ...f.leaf,
    leafIndex: 1,
    binding: { ...f.leaf.binding, holderGrant: f.holder },
  }
  expect(api.cascadeOf(leaves, claims, f.before, after, f.did)).toEqual({
    revoked: [{ did: target }],
    removed: [],
    removeLeafIndices: [],
  })
})

test('cascadeOf: rmv writes no revoked device records', () => {
  const before = structuredClone(f.before)
  const after = structuredClone(f.after)
  expect(api.cascadeOf(removalLeaves(), [removal()], before, after, f.did).revoked).toEqual([])
  expect(before).toEqual(f.before)
  expect(after).toEqual(f.after)
  expect(api.denySetOf(after)).toEqual(new Set())
})
