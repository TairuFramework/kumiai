import {
  type ControllerLog,
  createAdd,
  createRemove,
  createRenew,
  createReset,
  createRevoke,
  createRotate,
  digestOf,
  encodeKey,
  epochHeads,
  MAX_EPOCH_EVENTS,
  MAX_EVENT_PARENTS,
  snapshotOf,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'
import { afterEach, expect, test, vi } from 'vitest'

import * as controllerLogModule from '../src/controller-log.js'
import { foldControllerLog } from '../src/controller-log.js'
import type { FoldDrop, FoldInput } from '../src/fold.js'
import { authenticateLifecycleProof, verifyLifecycleProof } from '../src/lifecycle-proof.js'
import { memberRootStatus } from '../src/member-root.js'
import * as registry from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { belowGateWelcome, pipelineGroup } from './fixtures/lifecycle-pipeline.js'

const groupID = 'registry-log'

afterEach(() => vi.restoreAllMocks())

function entry(
  did: string,
  op: 'seed' | 'log',
  proof: ControllerLog,
): FoldInput<registry.DeviceValue> {
  return {
    entryID: digestOf({ op, proof }),
    verified: {
      issuer: did,
      entry: { type: registry.DEVICE_ENTRY_TYPE, groupID, subject: did, value: { op, proof } },
    },
  }
}

function replay(did: string, entries: Array<FoldInput>) {
  const drops: Array<FoldDrop> = []
  const folded = registry.foldControl(
    entries,
    { creatorDID: did, controller: did, version: 1 },
    groupID,
    (drop) => drops.push(drop),
  )
  return { ...folded, drops }
}

function folded(did: string, log: ControllerLog) {
  const result = foldControllerLog(did, log)
  if (!result.ok) throw new Error(result.reason)
  return result
}

test('seed entry at position 0 seeds the recorded log', async () => {
  const { did, log, members } = await buildEpoch({ members: 1 })
  const result = replay(did, [entry(did, 'seed', log)])
  expect(result.drops).toEqual([])
  const recorded = registry.recordedLogOf(result.registry, did)
  const [member] = members
  if (recorded == null || member == null) throw new Error('Missing seeded member')
  expect(recorded?.events).toEqual(log.events)
  expect(folded(did, recorded).head.members.get(member.add)).toMatchObject({
    effective: true,
  })
  expect(result.registry.controllers.get(did)).toMatchObject({
    genFloor: 0,
    timeFloor: 0,
    attestations: new Map(),
    removedMembers: new Map(),
    survivorGrants: new Map(),
  })
  expect(registry.registryForLog(did, log)).toEqual(result.registry)
})

test.each(['re-added', 'concurrent'] as const)(
  'attest replay uses the same pin across %s incarnations of one DID',
  async (kind) => {
    vi.spyOn(Date, 'now').mockReturnValue(150_000)
    const f = await buildEpoch({ members: 1 })
    const member = f.members[0]
    if (member == null) throw new Error('Missing member')
    const key = encodeKey(member.identity.publicKey, 'EdDSA')
    const removal = createRemove({
      did: f.did,
      head: f.head,
      parents: epochHeads(f.did, f.log),
      signer: f.root,
      add: member.add,
    })
    const prior = {
      chain: f.log.chain,
      events: [...f.log.events, ...(kind === 're-added' ? [removal] : [])],
    }
    const add = createAdd({
      seed: f.seed,
      profile: 0,
      did: f.did,
      head: folded(f.did, prior).head,
      parents: kind === 're-added' ? epochHeads(f.did, prior) : [f.head.epoch],
      member: { did: member.did, key, lease: 1100 },
    })
    const log = { chain: prior.chain, events: [...prior.events, add] }
    const members = folded(f.did, log).head.members
    expect(members.get(member.add)).toMatchObject({ effective: kind === 'concurrent', key })
    expect(members.get(digestOf(add.event))).toMatchObject({ effective: true, key })
    expect(new Set([...members.values()].map((value) => value.key))).toEqual(new Set([key]))
    const setup = await pipelineGroup({ controllerLog: log })
    const { author: group } = await belowGateWelcome(setup.group, member.identity, {
      id: f.did,
      prefix: log.chain,
      member: { add: digestOf(add.event), g: 0 },
      iat: 100,
    })
    const clock = {
      issuer: member.identity.id,
      entry: {
        type: registry.DEVICE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: f.did,
        value: { op: 'clock', time: 1050, attest: true } as const,
      },
    }
    await expect(verifyLifecycleProof(group, clock)).resolves.toMatchObject({ timeFloor: 0 })
    const applied = registry.registryApply(clock, group.registry, f.did)
    expect(applied.controllers.get(f.did)?.attestations).toEqual(new Map([[key, 1050]]))
    expect(applied.controllers.get(f.did)?.timeFloor).toBe(0)
  },
)

test('the recorded log refuses another pin for the same member DID', async () => {
  const f = await buildEpoch({ members: 2 })
  const [a, b] = f.members
  if (a == null || b == null) throw new Error('Missing members')
  const add = createAdd({
    seed: f.seed,
    profile: 0,
    did: f.did,
    head: f.head,
    parents: [f.head.epoch],
    member: { did: a.did, key: encodeKey(b.identity.publicKey, 'EdDSA'), lease: 1100 },
  })
  const result = replay(f.did, [entry(f.did, 'seed', { ...f.log, events: [...f.log.events, add] })])
  expect(result.drops).toEqual([])
  const recorded = registry.recordedLogOf(result.registry, f.did)
  if (recorded == null) throw new Error('Missing recorded log')
  expect(folded(f.did, recorded).head.members.has(digestOf(add.event))).toBe(false)
  expect(folded(f.did, recorded).head.members.get(a.add)?.key).toBe(
    encodeKey(a.identity.publicKey, 'EdDSA'),
  )
})

test('attest clock is refused when the issuer has no effective incarnation', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const f = await buildEpoch({ members: 1 })
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const removal = createRemove({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: f.root,
    add: member.add,
  })
  const setup = await pipelineGroup({
    controllerLog: { chain: f.log.chain, events: [...f.log.events, removal] },
  })
  const { author: group } = await belowGateWelcome(setup.group, member.identity, {
    id: f.did,
    prefix: f.log.chain,
    member: { add: member.add, g: 0 },
    iat: 100,
  })
  await expect(
    verifyLifecycleProof(group, {
      issuer: member.identity.id,
      entry: {
        type: registry.DEVICE_ENTRY_TYPE,
        groupID: group.groupID,
        subject: f.did,
        value: { op: 'clock', time: 200, attest: true },
      },
    }),
  ).rejects.toMatchObject({ reason: 'effects-mismatch' })
})

test('seed at a later position, or into a recorded log, is refused', async () => {
  const { did, log } = await buildEpoch({ members: 1 })
  const beacon: FoldInput = {
    entryID: 'beacon',
    verified: {
      issuer: did,
      entry: {
        type: registry.DEVICE_ENTRY_TYPE,
        groupID,
        subject: did,
        value: { op: 'beacon', logLength: 1, headDigest: digestOf(log.chain[0]?.event) },
      },
    },
  }
  for (const prefix of [beacon, entry(did, 'seed', log)]) {
    const result = replay(did, [prefix, entry(did, 'seed', log)])
    expect(result.drops).toHaveLength(1)
    expect(result.drops[0]?.reason).toBe('invalid lifecycle proof')
  }
  const state = registry.registryForLog(did, log)
  expect(() => registry.registryApply(entry(did, 'seed', log).verified, state, did)).toThrow()
})

test('log entry into an empty projection is refused', async () => {
  const { did, log } = await buildEpoch({ members: 1 })
  const result = replay(did, [entry(did, 'log', log)])
  expect(result.drops.map(({ reason }) => reason)).toEqual(['invalid lifecycle proof'])
  expect(registry.recordedLogOf(result.registry, did)).toBeUndefined()
})

test('foldControl keeps an authenticated renewal log entry in a lifecycle group', async () => {
  const f = await buildEpoch({ members: 1 })
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const renewal = createRenew({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: f.root,
    add: member.add,
    lease: 2000,
  })
  const result = replay(f.did, [
    entry(f.did, 'seed', f.log),
    entry(f.did, 'log', { chain: [], events: [renewal] }),
  ])
  expect(result.drops).toEqual([])
  expect(registry.recordedLogOf(result.registry, f.did)?.events).toEqual([...f.log.events, renewal])
})

test('log entry with a chain suffix settles without a revoke', async () => {
  const { seed, did, log, head, inception } = await buildEpoch({ members: 1 })
  const rotation = createRotate({
    seed,
    profile: 0,
    did,
    prior: inception.event,
    snapshot: snapshotOf(head),
  })
  const result = replay(did, [
    entry(did, 'seed', log),
    entry(did, 'log', { chain: [rotation], events: [] }),
  ])
  expect(result.drops).toEqual([])
  expect(registry.recordedLogOf(result.registry, did)).toEqual({
    chain: [...log.chain, rotation],
    events: [],
  })
})

test('log entry renewing a member extends the recorded lease', async () => {
  const { did, genesis, deltas, members } = await buildEpoch({
    members: 2,
    renewEvery: 1000,
    until: 1000,
  })
  const result = replay(did, [
    entry(did, 'seed', genesis),
    ...deltas.map((proof) => entry(did, 'log', proof)),
  ])
  expect(result.drops).toEqual([])
  const log = registry.recordedLogOf(result.registry, did)
  if (log == null) throw new Error('Missing recorded log')
  for (const { add } of members) expect(folded(did, log).head.members.get(add)?.lease).toBe(2000)
})

async function concurrent() {
  const fixture = await buildEpoch()
  const [a, b, c] = fixture.members
  if (a == null || b == null || c == null) throw new Error('Missing members')
  const base = { did: fixture.did, head: fixture.head, parents: [c.add] }
  const remove = createRemove({ ...base, signer: { member: b }, add: a.add })
  const recorded = { chain: fixture.log.chain, events: [...fixture.log.events, remove] }
  return { ...fixture, a, b, c, base, recorded, remove }
}

for (const descendant of [false, true]) {
  test(
    descendant
      ? "removed member's concurrent renewal is refused even under an effective member's descendant"
      : "removed member's concurrent renewal is refused",
    async () => {
      const { ingestControllerLog } = await import('../src/controller-ingest.js')
      const { did, a, b, c, base, recorded } = await concurrent()
      const renew = createRenew({ ...base, signer: { member: a }, add: c.add, lease: 9000 })
      const events = [renew]
      if (descendant)
        events.push(
          createRenew({
            ...base,
            parents: [digestOf(renew.event)],
            signer: { member: b },
            add: c.add,
            lease: 2000,
          }),
        )
      const merged = { chain: recorded.chain, events: [...recorded.events, ...events] }
      expect(folded(did, merged).applied).toContain(digestOf(renew.event))
      expect(folded(did, merged).head.members.get(c.add)?.lease).toBe(9000)
      const before = structuredClone(recorded)
      expect(() => ingestControllerLog(did, recorded, { chain: [], events })).toThrow(
        expect.objectContaining({ reason: 'not-endorsed' }),
      )
      const result = replay(did, [
        entry(did, 'seed', recorded),
        entry(did, 'log', { chain: [], events }),
      ])
      expect(result.drops.map(({ reason }) => reason)).toEqual(['invalid lifecycle proof'])
      expect(registry.recordedLogOf(result.registry, did)).toEqual(before)
      expect(folded(did, recorded).head.members.get(c.add)?.lease).toBe(1000)
      expect(recorded).toEqual(before)
    },
  )
}

test("removed member's concurrent counter-removal is refused even under a descendant", async () => {
  const { ingestControllerLog } = await import('../src/controller-ingest.js')
  const { did, a, b, c, base, recorded } = await concurrent()
  const remove = createRemove({ ...base, signer: { member: a }, add: b.add })
  const renew = createRenew({
    ...base,
    parents: [digestOf(remove.event)],
    signer: { member: c },
    add: a.add,
    lease: 2000,
  })
  const proof = { chain: [], events: [remove, renew] }
  expect(
    folded(did, { chain: recorded.chain, events: [...recorded.events, ...proof.events] }).applied,
  ).toContain(digestOf(remove.event))
  expect(
    folded(did, { chain: recorded.chain, events: [...recorded.events, ...proof.events] }).applied,
  ).toContain(digestOf(renew.event))
  const before = structuredClone(recorded)
  expect(() => ingestControllerLog(did, recorded, proof)).toThrow(
    expect.objectContaining({ reason: 'not-endorsed' }),
  )
  expect(recorded).toEqual(before)
})

test('endorsement checks introduced events beyond the stored saturation prefix', async () => {
  const { ingestControllerLog } = await import('../src/controller-ingest.js')
  const { did, a, c, base, root, recorded } = await concurrent()
  const events: ControllerLog['events'] = []
  let parents: Array<string> = []
  for (let index = 0; index <= MAX_EPOCH_EVENTS; index++) {
    const renew = createRenew({ ...base, signer: root, add: c.add, lease: 2000 + index })
    events.push(renew)
    parents.push(digestOf(renew.event))
  }
  while (parents.length > 1) {
    const next: Array<string> = []
    for (let index = 0; index < parents.length; index += MAX_EVENT_PARENTS) {
      const renew = createRenew({
        ...base,
        parents: parents.slice(index, index + MAX_EVENT_PARENTS),
        signer: root,
        add: c.add,
        lease: 8000,
      })
      events.push(renew)
      next.push(digestOf(renew.event))
    }
    parents = next
  }
  const renew = createRenew({ ...base, parents, signer: { member: a }, add: c.add, lease: 9000 })
  events.push(renew)
  const result = folded(did, { chain: recorded.chain, events: [...recorded.events, ...events] })
  expect(result.applied.indexOf(digestOf(renew.event))).toBeGreaterThan(MAX_EPOCH_EVENTS)
  expect(() => ingestControllerLog(did, recorded, { chain: [], events })).toThrow(
    expect.objectContaining({ reason: 'not-endorsed' }),
  )
}, 180_000)

test('author removed only within the same delta passes', async () => {
  const { ingestControllerLog } = await import('../src/controller-ingest.js')
  const { did, log, a, b, c, base } = await concurrent()
  const renew = createRenew({ ...base, signer: { member: a }, add: c.add, lease: 2000 })
  const remove = createRemove({
    ...base,
    parents: [digestOf(renew.event)],
    signer: { member: b },
    add: a.add,
  })
  const ingested = ingestControllerLog(did, log, { chain: [], events: [renew, remove] })
  expect(ingested.introduced).toEqual(
    expect.arrayContaining([digestOf(renew.event), digestOf(remove.event)]),
  )
  expect(ingested.before?.head.members.get(a.add)?.effective).toBe(true)
  expect(ingested.after.head.members.get(a.add)?.removed).toBe(true)
  expect(ingested.after.head.members.get(c.add)?.lease).toBe(2000)
  expect(ingestControllerLog(did, ingested.log, { chain: [], events: [] }).introduced).toEqual([])
})

test.each([
  { kind: 'denial', name: 'log entry carrying a new denial is refused' },
  {
    kind: 'member drop',
    name: 'log entry whose settlement snapshot drops an effective member is refused',
  },
  { kind: 'generation', name: 'log entry raising the generation is refused' },
])('$name', async ({ kind }) => {
  const { seed, did, log, head, root, inception, members } = await buildEpoch({ members: 1 })
  const [member] = members
  if (member == null) throw new Error('Missing member')
  const proof: ControllerLog =
    kind === 'denial'
      ? {
          chain: [],
          events: [
            createRevoke({
              did,
              head,
              parents: [member.add],
              signer: root,
              target: 'did:key:edge',
            }),
          ],
        }
      : {
          chain: [
            kind === 'generation'
              ? createReset(seed, 0, 1)
              : createRotate({
                  seed,
                  profile: 0,
                  did,
                  prior: inception.event,
                  snapshot: { members: [], deny: [] },
                }),
          ],
          events: [],
        }
  if (kind === 'generation') proof.chain.unshift(inception)
  const state = registry.registryForLog(did, log)
  expect(() => authenticateLifecycleProof(did, entry(did, 'log', proof).verified, state)).toThrow(
    expect.objectContaining({ reason: kind === 'generation' ? 'needs-reset' : 'effects-mismatch' }),
  )
  const result = replay(did, [entry(did, 'seed', log), entry(did, 'log', proof)])
  expect(result.drops.map(({ reason }) => reason)).toEqual(['invalid lifecycle proof'])
  expect(registry.recordedLogOf(result.registry, did)).toEqual(log)
})

test('forged copy beside the genuine one stores the genuine copy', async () => {
  const { did, genesis, deltas } = await buildEpoch({ members: 2, renewEvery: 1000, until: 1000 })
  const genuine = deltas[0]?.events[0]
  const add = genesis.events[0]
  if (genuine == null || add == null) throw new Error('Missing events')
  const forged = { ...genuine, sigs: add.sigs }
  const result = replay(did, [
    entry(did, 'seed', genesis),
    entry(did, 'log', { chain: [], events: [forged, genuine] }),
  ])
  expect(result.drops).toEqual([])
  const stored = registry
    .recordedLogOf(result.registry, did)
    ?.events.find(({ event }) => digestOf(event) === digestOf(genuine.event))
  expect(stored?.sigs).toEqual(genuine.sigs)
})

test('chain fork is refused and the prior log is kept', async () => {
  const { seed, did, log, head, inception } = await buildEpoch({ members: 1 })
  const params = { seed, profile: 0, did, prior: inception.event, snapshot: snapshotOf(head) }
  const left = createRotate({ ...params, seal: 'left' })
  const right = createRotate({ ...params, seal: 'right' })
  const prior = { chain: [...log.chain, left], events: [] }
  const { ingestControllerLog } = await import('../src/controller-ingest.js')
  expect(() =>
    ingestControllerLog(did, prior, { chain: [...log.chain, right], events: [] }),
  ).toThrow(expect.objectContaining({ reason: 'detached' }))
  const result = replay(did, [
    entry(did, 'seed', prior),
    entry(did, 'log', { chain: [...log.chain, right], events: [] }),
  ])
  expect(result.drops).toHaveLength(1)
  expect(registry.recordedLogOf(result.registry, did)).toEqual(prior)
})

test('a log carrying only a pending event is refused', async () => {
  const { did, log, head, members, root } = await buildEpoch({ members: 1 })
  const [member] = members
  if (member == null) throw new Error('Missing member')
  const renew = createRenew({
    did,
    head,
    parents: [digestOf('missing')],
    signer: root,
    add: member.add,
    lease: 2000,
  })
  const result = replay(did, [
    entry(did, 'seed', log),
    entry(did, 'log', { chain: [], events: [renew] }),
  ])
  expect(result.drops).toHaveLength(1)
  expect(registry.recordedLogOf(result.registry, did)).toEqual(log)
})

test('effectDelta normalises DID denials and member effectiveness on both sides', async () => {
  const { effectDelta } = await import('../src/controller-ingest.js')
  const { head, members } = await buildEpoch({ members: 1 })
  const [member] = members
  if (member == null) throw new Error('Missing member')
  const before = { ...head, deny: new Set([member.did, '#key']) }
  const after = {
    ...head,
    gen: 1,
    deny: new Set([member.identity.id, '#other-key', 'did:key:edge']),
    members: new Map(),
  }
  expect(effectDelta(before, after)).toEqual({
    denied: ['did:key:edge'],
    removed: [{ did: normalizeDID(member.identity.id), add: member.add }],
    generation: true,
  })
})

test('seed from [icp, reset(snapshot with a denial)] installs the denial with a snapshot ref', async () => {
  const f = await buildEpoch({ members: 1 })
  const creator = f.members[0]
  if (creator == null) throw new Error('Missing creator')
  const log = {
    chain: [
      f.inception,
      createReset(f.seed, 0, 1, {
        ...snapshotOf(f.head),
        deny: ['did:key:edge'],
      }),
    ],
    events: [],
  }
  const state = registry.registryApply(
    entry(f.did, 'seed', log).verified,
    registry.registrySeed(),
    f.did,
  )
  expect(state.devices.get('did:key:edge')).toEqual({
    controller: f.did,
    status: 'revoked',
    proofRef: { snapshot: 1 },
  })
  expect(
    memberRootStatus(state, f.did, { kind: 'member', did: creator.did, add: creator.add, gen: 1 }),
  ).toMatchObject({ status: 'effective' })
  expect(registry.registryForLog(f.did, log)).toEqual(state)
})

test('genesis seed with an effective creator and a prior denial installs both atomically', async () => {
  const f = await buildEpoch({ members: 2, revokes: 1 })
  const [creator, removed] = f.members
  if (creator == null || removed == null) throw new Error('Missing members')
  const rmv = createRemove({
    did: f.did,
    head: f.head,
    parents: [removed.add],
    signer: f.root,
    add: removed.add,
  })
  const log = { ...f.log, events: [...f.log.events, rmv] }
  const seed = entry(f.did, 'seed', log)
  const state = registry.registryApply(seed.verified, registry.registrySeed(), f.did)
  expect(
    memberRootStatus(state, f.did, { kind: 'member', did: creator.did, add: creator.add, gen: 0 }),
  ).toMatchObject({ status: 'effective' })
  const rev = log.events.find(({ event }) => event.t === 'rev')
  if (rev == null) throw new Error('Missing rev')
  expect(state.devices.get('did:key:denied-0')).toEqual({
    controller: f.did,
    status: 'revoked',
    proofRef: { event: digestOf(rev.event) },
  })
  expect(registry.denySetOf(state)).toEqual(new Set(['did:key:denied-0']))
  expect(state.controllers.get(f.did)?.removedMembers.get(removed.add)).toEqual({
    did: removed.identity.id,
    gen: 0,
    proofRef: { event: digestOf(rmv.event) },
  })
  expect(replay(f.did, [seed])).toMatchObject({ registry: state, drops: [] })
  expect(registry.registryForLog(f.did, log)).toEqual(state)
})

test('seed tombstones a member dropped by settlement without denying its DID', async () => {
  const f = await buildEpoch({ members: 1 })
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const snapshot = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
  })
  const drop = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: snapshot.event,
    snapshot: { members: [], deny: [] },
  })
  const log = { chain: [f.inception, snapshot, drop], events: [] }
  const state = registry.registryApply(
    entry(f.did, 'seed', log).verified,
    registry.registrySeed(),
    f.did,
  )
  expect(state.controllers.get(f.did)?.removedMembers.get(member.add)).toEqual({
    did: member.identity.id,
    gen: 0,
    proofRef: { chainIndex: 2 },
  })
  expect(state.devices.size).toBe(0)
})

test('empty log entries introduce no authenticated data and are refused', async () => {
  const f = await buildEpoch({ members: 1 })
  const seed = entry(f.did, 'seed', f.log)
  const empty = entry(f.did, 'log', { chain: [], events: [] })
  const result = replay(f.did, [seed, empty])
  expect(result.drops).toHaveLength(1)
  expect(registry.recordedLogOf(result.registry, f.did)).toEqual(f.log)
  expect(() =>
    authenticateLifecycleProof(f.did, empty.verified, registry.registryForLog(f.did, f.log)),
  ).toThrow()
})

test('sixteen renewal entries replay with linear authenticated event folding', async () => {
  const count = 16
  const f = await buildEpoch({ members: 1, renewEvery: 100, until: count * 100 })
  const entries = [
    entry(f.did, 'seed', f.genesis),
    ...f.deltas.map((delta) => entry(f.did, 'log', delta)),
  ]
  const fold = vi.spyOn(controllerLogModule, 'foldControllerLog')
  const result = replay(f.did, entries)
  const checks = fold.mock.calls.reduce((count, [, log]) => count + log.events.length, 0)
  expect(result.drops).toEqual([])
  expect(checks).toBeGreaterThan(0)
  expect(checks).toBeLessThanOrEqual(2 * count + 2)
  const log = registry.recordedLogOf(result.registry, f.did)
  if (log == null) throw new Error('Missing log')
  expect(folded(f.did, log).head).toEqual(f.head)
})
