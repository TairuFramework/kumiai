import {
  type ControllerLog,
  createRemove,
  createRenew,
  createReset,
  createRevoke,
  createRotate,
  digestOf,
  MAX_EPOCH_EVENTS,
  MAX_EVENT_PARENTS,
  snapshotOf,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'
import { expect, test } from 'vitest'

import { foldControllerLog } from '../src/controller-log.js'
import type { FoldDrop, FoldInput } from '../src/fold.js'
import { authenticateLifecycleProof } from '../src/lifecycle-proof.js'
import * as registry from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'

const groupID = 'registry-log'

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

test('foldControl keeps a log entry in a lifecycle group', async () => {
  const { did, log } = await buildEpoch({ members: 1 })
  const result = replay(did, [
    entry(did, 'seed', log),
    entry(did, 'log', { chain: [], events: [] }),
  ])
  expect(result.drops).toEqual([])
  expect(registry.recordedLogOf(result.registry, did)).toEqual(log)
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

test('pending event is not stored', async () => {
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
  expect(result.drops).toEqual([])
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
