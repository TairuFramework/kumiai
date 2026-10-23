import { expect, test } from 'vitest'

import {
  type ControllerProjection,
  cascadeOf,
  claimsFor,
  createRegistryControllerResolver,
  type EvidenceSlot,
  effectDelta,
  effectiveAuthorityOf,
  effectOf,
  type FoldOk,
  ingestControllerLog,
  type LeafRef,
  type MemberRootStatus,
  memberDropIndices,
  memberRootStatus,
  prefixRelation,
  proofSize,
  recordedLogOf,
  registryForLog,
} from '../src/index.js'
import { buildEpoch } from './fixtures/controller-epoch.js'

test('controller log helpers are available through the package entry point', async () => {
  const { did, log } = await buildEpoch({ members: 0 })
  const ingested = ingestControllerLog(did, undefined, log)
  const after: FoldOk = ingested.after
  expect(after.ok).toBe(true)
  expect(effectDelta(undefined, after.head)).toEqual({
    denied: [],
    removed: [],
    generation: false,
  })

  const registry = registryForLog(did, log)
  const projection: ControllerProjection | undefined = registry.controllers.get(did)
  expect(projection?.recordedLog).toEqual(log)
  expect(recordedLogOf(registry, did)).toEqual(log)
})

test('member authority and effect helpers are available through the package entry point', async () => {
  const { did, log, members } = await buildEpoch({ members: 1 })
  const member = members[0]
  if (member == null) throw new Error('Missing member')
  const registry = registryForLog(did, log)
  const leaf: LeafRef = {
    did: member.did,
    leafKey: member.identity.publicKey,
    binding: { id: did, prefix: log.chain, member: { add: member.add, g: 0 }, iat: 100 },
  }
  const status: MemberRootStatus = memberRootStatus(registry, did, {
    kind: 'member',
    did: member.did,
    add: member.add,
    gen: 0,
  })
  expect(status.status).toBe('effective')
  const slot: EvidenceSlot = 'membership'
  expect(effectiveAuthorityOf(leaf, registry, did)).toMatchObject({ slot })
  expect(memberDropIndices(did, log.chain, member.add)).toEqual([])
  expect(claimsFor(did, undefined, log, 0)).toEqual([])
  expect(() =>
    effectOf(did, log, { kind: 'deny', did: member.did, ref: { chainIndex: 0 } }, 0),
  ).toThrow(expect.objectContaining({ reason: 'no-rev' }))
  expect(cascadeOf([{ ...leaf, leafIndex: 0 }], [], registry, registry, did)).toEqual({
    revoked: [],
    removed: [],
    removeLeafIndices: [],
  })
})

test('proof sizing is available through the package entry point', () => {
  expect(proofSize({ chain: [], events: [] })).toBe(0)
})

test('registry controller resolution is available through the package entry point', async () => {
  const { did, log } = await buildEpoch({ members: 0 })
  expect(prefixRelation(log, log.chain)).toBe('contained')
  const resolver = createRegistryControllerResolver({
    controllerID: did,
    prefix: log.chain,
    registry: registryForLog(did, log),
  })
  await expect(resolver.frozen().resolve(did, {})).resolves.toMatchObject({ alg: 'EdDSA' })
})
