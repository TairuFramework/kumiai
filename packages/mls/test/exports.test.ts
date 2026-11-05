import { expect, test } from 'vitest'

import {
  type ControllerProjection,
  cascadeOf,
  claimsFor,
  createDIDAuthenticationService,
  createRegistryControllerResolver,
  type DIDAuthenticationDependencies,
  type EvidenceSlot,
  effectDelta,
  effectiveAuthorityOf,
  effectOf,
  epochEventCount,
  type FoldOk,
  ingestControllerLog,
  type JudgingContext,
  type LeafRef,
  MAX_EPOCH_EVENTS_FOR_LEAVES,
  type MemberRootStatus,
  memberDropIndices,
  memberRootStatus,
  prefixRelation,
  proofSize,
  type RemovalEvidence,
  recordedLogOf,
  registryForLog,
  removalEvidence,
  SETTLE_PROMPT_EPOCH_EVENTS,
  settleAdvisory,
  survivorTargets,
} from '../src/index.js'
import { buildEpoch } from './fixtures/controller-epoch.js'

test('removal evidence and survivor targets are available through the package entry point', async () => {
  const { did, log, members } = await buildEpoch({ members: 1 })
  const member = members[0]
  if (member == null) throw new Error('Missing member')
  const evidence: RemovalEvidence | undefined = await removalEvidence({
    controller: did,
    log,
    rmv: member.add,
  })
  expect(evidence).toBeUndefined()
  expect(survivorTargets).toEqual(expect.any(Function))
})

test('controller log helpers are available through the package entry point', async () => {
  const { did, log } = await buildEpoch({ members: 0 })
  const ingested = await ingestControllerLog({ controller: did, recorded: undefined, proof: log })
  const after: FoldOk = ingested.after
  expect(after.ok).toBe(true)
  expect(effectDelta({ before: undefined, after: after.head })).toEqual({
    denied: [],
    removed: [],
    generation: false,
  })

  const registry = await registryForLog({ controller: did, log })
  const projection: ControllerProjection | undefined = registry.controllers.get(did)
  expect(projection?.recordedLog).toEqual(log)
  expect(recordedLogOf({ registry, controller: did })).toEqual(log)
})

test('member authority and effect helpers are available through the package entry point', async () => {
  const { did, log, members } = await buildEpoch({ members: 1 })
  const member = members[0]
  if (member == null) throw new Error('Missing member')
  const registry = await registryForLog({ controller: did, log })
  const leaf: LeafRef = {
    did: member.did,
    leafKey: member.identity.publicKey,
    binding: { id: did, prefix: log.chain, member: { add: member.add, g: 0 }, iat: 100 },
  }
  const status: MemberRootStatus = await memberRootStatus({
    registry,
    controller: did,
    root: {
      kind: 'member',
      did: member.did,
      add: member.add,
      gen: 0,
    },
  })
  expect(status.status).toBe('effective')
  const slot: EvidenceSlot = 'membership'
  expect(await effectiveAuthorityOf({ leaf, registry, controller: did })).toMatchObject({ slot })
  expect(await memberDropIndices({ did, chain: log.chain, add: member.add })).toEqual([])
  expect(
    await claimsFor({ controller: did, recorded: undefined, merged: log, genFloor: 0 }),
  ).toEqual([])
  await expect(
    async () =>
      await effectOf({
        controller: did,
        log,
        claim: { kind: 'deny', did: member.did, ref: { chainIndex: 0 } },
        genFloor: 0,
      }),
  ).rejects.toThrow(expect.objectContaining({ reason: 'no-rev' }))
  expect(
    await cascadeOf({
      leaves: [{ ...leaf, leafIndex: 0 }],
      claims: [],
      before: registry,
      after: registry,
      controller: did,
    }),
  ).toEqual({
    revoked: [],
    removed: [],
    removeLeafIndices: [],
  })
})

test('proof sizing is available through the package entry point', () => {
  expect(proofSize({ chain: [], events: [] })).toBe(0)
})

test('epoch cap helpers are available through the package entry point', async () => {
  const { log } = await buildEpoch({ members: 0, revokes: SETTLE_PROMPT_EPOCH_EVENTS })
  expect(await epochEventCount({ log })).toBe(24)
  expect(await settleAdvisory({ log })).toBe('prompt')
  expect(await epochEventCount({ log })).toBeLessThan(MAX_EPOCH_EVENTS_FOR_LEAVES)
})

test('registry controller resolution is available through the package entry point', async () => {
  const { did, log } = await buildEpoch({ members: 0 })
  expect(prefixRelation({ recorded: log, prefix: log.chain })).toBe('contained')
  const resolver = createRegistryControllerResolver({
    controllerID: did,
    prefix: log.chain,
    registry: await registryForLog({ controller: did, log }),
  })
  await expect(resolver.frozen().resolve({ did: did, header: {} })).resolves.toMatchObject({
    alg: 'EdDSA',
  })
})

test('judging context is available through the package entry point', () => {
  const judging: JudgingContext = { stage: 'structural', mode: 'retain' }
  const dependencies: DIDAuthenticationDependencies = { judging: () => judging }
  expect(createDIDAuthenticationService(dependencies).validateCredential).toEqual(
    expect.any(Function),
  )
})
