import * as controller from '@kokuin/controller'
import {
  type ControllerLog,
  createDeviceRevoke,
  createRemove,
  createReset,
  createRevoke,
  createRotate,
  deviceRevokeIndices,
  digestOf,
  epochHeads,
  MAX_FAILED_SIGNATURES,
  snapshotOf,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'
import { expect, test, vi } from 'vitest'

import { foldControllerLog } from '../src/controller-log.js'
import * as api from '../src/index.js'
import type { EffectClaim } from '../src/member-root.js'
import { buildEpoch } from './fixtures/controller-epoch.js'

vi.mock('@kokuin/controller', { spy: true })

function fold(did: string, log: ControllerLog) {
  const result = foldControllerLog(did, log)
  if (!result.ok) throw new Error(result.reason)
  return result
}

async function effects() {
  const f = await buildEpoch({ members: 2 })
  const [a, b] = f.members
  if (a == null || b == null) throw new Error('Missing members')
  const base = { did: f.did, head: f.head, parents: epochHeads(f.did, f.log) }
  const rev = createRevoke({ ...base, signer: { member: b }, target: 'did:key:edge' })
  const rmv = createRemove({ ...base, signer: { member: b }, add: a.add })
  const log = { chain: f.log.chain, events: [...f.log.events, rev, rmv] }
  return { ...f, a, b, rev, rmv, merged: log }
}

test('effectOf accepts a member rev by event digest', async () => {
  const f = await effects()
  expect(() =>
    api.effectOf(
      f.did,
      f.merged,
      {
        kind: 'deny',
        did: 'did:key:edge',
        ref: { event: digestOf(f.rev.event) },
      },
      0,
    ),
  ).not.toThrow()
})

test('effectOf refuses an applied but unrelated event digest', async () => {
  const f = await effects()
  expect(fold(f.did, f.merged).applied).toContain(f.b.add)
  expect(() =>
    api.effectOf(
      f.did,
      f.merged,
      {
        kind: 'deny',
        did: 'did:key:edge',
        ref: { event: f.b.add },
      },
      0,
    ),
  ).toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
})

test('effectOf refuses an rmv ref under a deny claim', async () => {
  const f = await effects()
  expect(() =>
    api.effectOf(
      f.did,
      f.merged,
      {
        kind: 'deny',
        did: f.a.did,
        ref: { event: digestOf(f.rmv.event) },
      },
      0,
    ),
  ).toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
})

test('effectOf checks the incarnation DID and generation of an event ref', async () => {
  const f = await effects()
  const claim: EffectClaim = {
    kind: 'remove',
    member: { did: f.a.identity.id, add: f.a.add },
    ref: { event: digestOf(f.rmv.event) },
  }
  expect(() => api.effectOf(f.did, f.merged, claim, 0)).not.toThrow()
  expect(() =>
    api.effectOf(f.did, f.merged, { ...claim, member: { ...claim.member, did: f.b.did } }, 0),
  ).toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  expect(() => api.effectOf(f.did, f.merged, claim, 1)).toThrow(
    expect.objectContaining({ reason: 'generation-floor' }),
  )
})

test('settled rmv is proved by chain index', async () => {
  const f = await effects()
  const first = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
  })
  const prior = { chain: [...f.log.chain, first], events: [] }
  const rmv = createRemove({
    did: f.did,
    head: fold(f.did, prior).head,
    parents: [digestOf(first.event)],
    signer: { member: f.b },
    add: f.a.add,
  })
  const removed = { ...prior, events: [rmv] }
  const settle = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: first.event,
    snapshot: snapshotOf(fold(f.did, removed).head),
  })
  const log = { chain: [...prior.chain, settle], events: [] }
  expect(api.memberDropIndices(f.did, log.chain, f.a.add)).toEqual([2])
  expect(() =>
    api.effectOf(
      f.did,
      log,
      {
        kind: 'remove',
        member: { did: f.a.did, add: f.a.add },
        ref: { chainIndex: 2 },
      },
      0,
    ),
  ).not.toThrow()
  const claims = api.claimsFor(f.did, prior, log, 0)
  expect(claims).toEqual([
    { kind: 'remove', member: { did: f.a.identity.id, add: f.a.add }, ref: { chainIndex: 2 } },
  ])
  for (const claim of claims) expect(() => api.effectOf(f.did, log, claim, 0)).not.toThrow()
})

test('settled rmv of a never-snapshotted incarnation keeps its epoch proof', async () => {
  const f = await effects()
  const settle = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(fold(f.did, f.merged).head),
  })
  const log = { chain: [...f.log.chain, settle], events: f.merged.events }
  const claim: EffectClaim = {
    kind: 'remove',
    member: { did: f.a.did, add: f.a.add },
    ref: { event: digestOf(f.rmv.event), epoch: digestOf(f.inception.event) },
  }
  expect(api.memberDropIndices(f.did, log.chain, f.a.add)).toEqual([])
  expect(() => api.effectOf(f.did, log, claim, 0)).not.toThrow()
  expect(() => api.effectOf(f.did, { ...log, events: [] }, claim, 0)).toThrow(
    expect.objectContaining({ reason: 'no-rev' }),
  )
  expect(() =>
    api.effectOf(f.did, log, { ...claim, ref: { event: digestOf(f.rmv.event) } }, 0),
  ).toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  expect(api.claimsFor(f.did, f.log, log, 0)).toContainEqual({
    ...claim,
    member: { did: f.a.identity.id, add: f.a.add },
  })
})

test('member rev of a member DID is never applied', async () => {
  const f = await effects()
  for (const removed of [false, true]) {
    const log = { ...f.log, events: [...f.log.events, ...(removed ? [f.rmv] : [])] }
    const rev = createRevoke({
      did: f.did,
      head: fold(f.did, log).head,
      parents: epochHeads(f.did, log),
      signer: { member: f.b },
      target: f.a.identity.id,
    })
    log.events.push(rev)
    const result = fold(f.did, log)
    expect(result.applied).not.toContain(digestOf(rev.event))
    expect(result.rejected).toBe(1)
    expect(result.head.deny.size).toBe(0)
    expect(() =>
      api.effectOf(
        f.did,
        log,
        {
          kind: 'deny',
          did: f.a.did,
          ref: { event: digestOf(rev.event) },
        },
        0,
      ),
    ).toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  }
})

test('reset snapshot refs authenticate the target, generation and signature', async () => {
  const f = await buildEpoch({ members: 1 })
  const denied = f.members[0]
  if (denied == null) throw new Error('Missing member')
  const reset = createReset(f.seed, 0, 1, { members: [], deny: [denied.did] })
  const log = { chain: [f.inception, reset], events: [] }
  const claim: EffectClaim = { kind: 'deny', did: denied.identity.id, ref: { snapshot: 1 } }
  expect(deviceRevokeIndices(f.did, log.chain, denied.did)).toEqual([])
  expect(api.claimsFor(f.did, undefined, log, 0)).toEqual([claim])
  expect(() => api.effectOf(f.did, log, claim, 0)).not.toThrow()
  expect(() => api.effectOf(f.did, log, { ...claim, did: 'did:key:other' }, 0)).toThrow(
    expect.objectContaining({ reason: 'effects-mismatch' }),
  )
  expect(() => api.effectOf(f.did, log, claim, 2)).toThrow(
    expect.objectContaining({ reason: 'generation-floor' }),
  )
  expect(() =>
    api.effectOf(
      f.did,
      { ...log, chain: [f.inception, { ...reset, sigs: f.inception.sigs }] },
      claim,
      0,
    ),
  ).toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  expect(() => api.effectOf(f.did, log, { ...claim, ref: { chainIndex: 1 } }, 0)).toThrow(
    expect.objectContaining({ reason: 'no-rev' }),
  )
})

test('re-revoke after reset is proved at gen 2', async () => {
  const f = await buildEpoch({ members: 0 })
  const target = 'did:key:edge'
  const first = createDeviceRevoke({
    seed: f.seed,
    profile: 0,
    did: f.did,
    chain: f.log.chain,
    subject: target,
  })
  const reset = createReset(f.seed, 0, 2)
  const chain = [f.inception, first, reset]
  chain.push(createDeviceRevoke({ seed: f.seed, profile: 0, did: f.did, chain, subject: target }))
  const log = { chain, events: [] }
  const claims = api.claimsFor(f.did, { chain: chain.slice(0, 3), events: [] }, log, 2)
  expect(claims).toEqual([{ kind: 'deny', did: target, ref: { chainIndex: 3 } }])
  for (const claim of claims) expect(() => api.effectOf(f.did, log, claim, 2)).not.toThrow()
  expect(() =>
    api.effectOf(f.did, log, { kind: 'deny', did: target, ref: { chainIndex: 1 } }, 2),
  ).toThrow(expect.objectContaining({ reason: 'generation-floor' }))
})

test('claimsFor output passes effectOf for every claim', async () => {
  const f = await effects()
  const claims = api.claimsFor(f.did, f.log, f.merged, 0)
  expect(claims).toEqual([
    { kind: 'deny', did: 'did:key:edge', ref: { event: digestOf(f.rev.event) } },
    {
      kind: 'remove',
      member: { did: normalizeDID(f.a.did), add: f.a.add },
      ref: { event: digestOf(f.rmv.event) },
    },
  ])
  for (const claim of claims) expect(() => api.effectOf(f.did, f.merged, claim, 0)).not.toThrow()
  expect(api.claimsFor(f.did, f.merged, f.merged, 0)).toEqual([])
  expect(api.claimsFor(f.did, undefined, f.merged, 0)).toEqual(claims)
})

test('claimsFor orders denies by DID then removals by add digest', async () => {
  const f = await buildEpoch({ members: 3 })
  const events = [...f.log.events]
  for (const target of ['did:key:z', 'did:key:a'])
    events.push(
      createRevoke({
        did: f.did,
        head: f.head,
        parents: epochHeads(f.did, f.log),
        signer: f.root,
        target,
      }),
    )
  for (const member of f.members)
    events.push(
      createRemove({
        did: f.did,
        head: f.head,
        parents: epochHeads(f.did, f.log),
        signer: f.root,
        add: member.add,
      }),
    )
  const log = { chain: f.log.chain, events }
  const claims = api.claimsFor(f.did, f.log, log, 0)
  expect(claims.slice(0, 2).map((claim) => claim.kind === 'deny' && claim.did)).toEqual([
    'did:key:a',
    'did:key:z',
  ])
  expect(claims.slice(2).map((claim) => claim.kind === 'remove' && claim.member.add)).toEqual(
    f.members.map((member) => member.add).sort(),
  )
  for (const claim of claims) expect(() => api.effectOf(f.did, log, claim, 0)).not.toThrow()
})

test('claimsFor proves a carried denial at the reset that introduces its generation', async () => {
  const f = await buildEpoch({ members: 0 })
  const target = 'did:key:edge'
  const rev = createDeviceRevoke({
    seed: f.seed,
    profile: 0,
    did: f.did,
    chain: f.log.chain,
    subject: target,
  })
  const reset = createReset(f.seed, 0, 1, { members: [], deny: [target] })
  const log = { chain: [f.inception, rev, reset], events: [] }
  expect(api.claimsFor(f.did, undefined, log, 0)).toEqual([
    { kind: 'deny', did: target, ref: { snapshot: 2 } },
  ])
})

test('memberDropIndices ignores resets and refuses unauthenticated snapshots', async () => {
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
  const reset = createReset(f.seed, 0, 1)
  expect(api.memberDropIndices(f.did, [f.inception, snapshot, reset], member.add)).toEqual([])
  const drop = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: snapshot.event,
    snapshot: { members: [], deny: [] },
  })
  expect(
    api.memberDropIndices(
      f.did,
      [f.inception, snapshot, { ...drop, sigs: f.inception.sigs }],
      member.add,
    ),
  ).toEqual([])
})

test('claimsFor uses digest order independent of locale collation', async () => {
  const f = await buildEpoch({ members: 2 })
  const members = snapshotOf(f.head).members.map((member, index) => ({
    ...member,
    add: index === 0 ? 'Z' : 'a',
  }))
  const snapshot = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: { members, deny: [] },
  })
  const prior = { chain: [f.inception, snapshot], events: [] }
  const dropped = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: snapshot.event,
    snapshot: { members: [], deny: [] },
  })
  const claims = api.claimsFor(f.did, prior, { chain: [...prior.chain, dropped], events: [] }, 0)
  expect(claims.map((claim) => claim.kind === 'remove' && claim.member.add)).toEqual(['Z', 'a'])
})

test('claimsFor folds once when deriving and validating many event effects', async () => {
  const f = await buildEpoch({ members: 1, revokes: 8 })
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const rmv = createRemove({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: f.root,
    add: member.add,
  })
  const log = { ...f.log, events: [...f.log.events, rmv] }
  const spy = vi.spyOn(controller, 'foldLog')
  spy.mockClear()
  let claims: Array<EffectClaim>
  try {
    claims = api.claimsFor(f.did, undefined, log, 0)
    expect(claims).toHaveLength(9)
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  for (const claim of claims) expect(() => api.effectOf(f.did, log, claim, 0)).not.toThrow()
})

test('claimsFor indexes snapshot drops once across repeated member snapshots', async () => {
  const f = await buildEpoch({ members: 3 })
  const first = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
  })
  const second = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: first.event,
    snapshot: snapshotOf(f.head),
  })
  const drop = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: second.event,
    snapshot: { members: [], deny: [] },
  })
  const log = { chain: [f.inception, first, second, drop], events: [] }
  const spy = vi.spyOn(controller, 'foldLog')
  spy.mockClear()
  let claims: Array<EffectClaim>
  try {
    claims = api.claimsFor(f.did, undefined, log, 0)
    expect(claims).toHaveLength(3)
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  for (const claim of claims) {
    expect(claim.ref).toEqual({ chainIndex: 3 })
    expect(() => api.effectOf(f.did, log, claim, 0)).not.toThrow()
  }
})

test('claimsFor keeps no-rev for an explicit removal without an admissible ref', async () => {
  const f = await effects()
  const removed = { ...f.log, events: [...f.log.events, f.rmv] }
  expect(() => api.claimsFor(f.did, undefined, removed, 1)).toThrow(
    expect.objectContaining({ reason: 'no-rev' }),
  )
  const reset = {
    chain: [f.inception, createReset(f.seed, 0, 1)],
    events: removed.events,
  }
  expect(() => api.claimsFor(f.did, f.log, reset, 1)).toThrow(
    expect.objectContaining({ reason: 'no-rev' }),
  )
  const settle = (drop: Array<string>) =>
    createRotate({
      seed: f.seed,
      profile: 0,
      did: f.did,
      prior: f.inception.event,
      snapshot: snapshotOf(fold(f.did, f.merged).head, { members: drop }),
    })
  expect(() =>
    api.claimsFor(
      f.did,
      f.log,
      { chain: [...f.log.chain, settle([f.rmv.event.add])], events: [] },
      0,
    ),
  ).toThrow(expect.objectContaining({ reason: 'no-rev' }))
  // Keeping the tombstone (the default) proves the removal from the chain.
  expect(
    api.claimsFor(f.did, f.log, { chain: [...f.log.chain, settle([])], events: [] }, 0),
  ).toContainEqual(expect.objectContaining({ kind: 'remove', ref: { chainIndex: 1 } }))
})

test('claimsFor folds a refused historical epoch once and still uses an authenticated snapshot', async () => {
  const f = await buildEpoch({ members: 0 })
  const rev = createRevoke({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: f.root,
    target: 'did:key:edge',
  })
  const settle = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: { members: [], deny: ['did:key:edge'] },
  })
  const log = {
    chain: [f.inception, settle],
    events: Array.from({ length: MAX_FAILED_SIGNATURES + 1 }, (_, index) => ({
      ...rev,
      event: { ...rev.event, x: `did:key:unrelated-${index}` },
    })),
  }
  const spy = vi.spyOn(controller, 'foldLog')
  spy.mockClear()
  let claims: Array<EffectClaim>
  try {
    claims = api.claimsFor(f.did, undefined, log, 0)
    expect(claims).toEqual([{ kind: 'deny', did: 'did:key:edge', ref: { chainIndex: 1 } }])
    expect(spy).toHaveBeenCalledTimes(2)
  } finally {
    spy.mockRestore()
  }
  for (const claim of claims) expect(() => api.effectOf(f.did, log, claim, 0)).not.toThrow()
})
