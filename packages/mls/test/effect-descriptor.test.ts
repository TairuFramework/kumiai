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

async function fold(did: string, log: ControllerLog) {
  const result = await foldControllerLog(did, log)
  if (!result.ok) throw new Error(result.reason)
  return result
}

async function effects() {
  const f = await buildEpoch({ members: 2 })
  const [a, b] = f.members
  if (a == null || b == null) throw new Error('Missing members')
  const base = { did: f.did, head: f.head, parents: await epochHeads({ did: f.did, log: f.log }) }
  const rev = await createRevoke({ ...base, signer: { member: b }, target: 'did:key:edge' })
  const rmv = await createRemove({ ...base, signer: { member: b }, add: a.add })
  const log = { chain: f.log.chain, events: [...f.log.events, rev, rmv] }
  return { ...f, a, b, rev, rmv, merged: log }
}

test('effectOf accepts a member rev by event digest', async () => {
  const f = await effects()
  await expect(
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
  ).resolves.not.toThrow()
})

test('effectOf refuses an applied but unrelated event digest', async () => {
  const f = await effects()
  expect((await fold(f.did, f.merged)).applied).toContain(f.b.add)
  await expect(
    async () =>
      await api.effectOf(
        f.did,
        f.merged,
        {
          kind: 'deny',
          did: 'did:key:edge',
          ref: { event: f.b.add },
        },
        0,
      ),
  ).rejects.toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
})

test('effectOf refuses an rmv ref under a deny claim', async () => {
  const f = await effects()
  await expect(
    async () =>
      await api.effectOf(
        f.did,
        f.merged,
        {
          kind: 'deny',
          did: f.a.did,
          ref: { event: digestOf(f.rmv.event) },
        },
        0,
      ),
  ).rejects.toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
})

test('effectOf checks the incarnation DID and generation of an event ref', async () => {
  const f = await effects()
  const claim: EffectClaim = {
    kind: 'remove',
    member: { did: f.a.identity.id, add: f.a.add },
    ref: { event: digestOf(f.rmv.event) },
  }
  await expect(api.effectOf(f.did, f.merged, claim, 0)).resolves.not.toThrow()
  await expect(
    async () =>
      await api.effectOf(
        f.did,
        f.merged,
        { ...claim, member: { ...claim.member, did: f.b.did } },
        0,
      ),
  ).rejects.toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  await expect(async () => await api.effectOf(f.did, f.merged, claim, 1)).rejects.toThrow(
    expect.objectContaining({ reason: 'generation-floor' }),
  )
})

test('settled rmv is proved by chain index', async () => {
  const f = await effects()
  const first = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf({ state: f.head }),
  })
  const prior = { chain: [...f.log.chain, first], events: [] }
  const rmv = await createRemove({
    did: f.did,
    head: (await fold(f.did, prior)).head,
    parents: [digestOf(first.event)],
    signer: { member: f.b },
    add: f.a.add,
  })
  const removed = { ...prior, events: [rmv] }
  const settle = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: first.event,
    snapshot: snapshotOf({ state: (await fold(f.did, removed)).head }),
  })
  const log = { chain: [...prior.chain, settle], events: [] }
  expect(await api.memberDropIndices(f.did, log.chain, f.a.add)).toEqual([2])
  await expect(
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
  ).resolves.not.toThrow()
  const claims = await api.claimsFor(f.did, prior, log, 0)
  expect(claims).toEqual([
    { kind: 'remove', member: { did: f.a.identity.id, add: f.a.add }, ref: { chainIndex: 2 } },
  ])
  for (const claim of claims)
    await expect(api.effectOf(f.did, log, claim, 0)).resolves.not.toThrow()
})

test('settled rmv of a never-snapshotted incarnation keeps its epoch proof', async () => {
  const f = await effects()
  const settle = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf({ state: (await fold(f.did, f.merged)).head }),
  })
  const log = { chain: [...f.log.chain, settle], events: f.merged.events }
  const claim: EffectClaim = {
    kind: 'remove',
    member: { did: f.a.did, add: f.a.add },
    ref: { event: digestOf(f.rmv.event), epoch: digestOf(f.inception.event) },
  }
  expect(await api.memberDropIndices(f.did, log.chain, f.a.add)).toEqual([])
  await expect(api.effectOf(f.did, log, claim, 0)).resolves.not.toThrow()
  await expect(
    async () => await api.effectOf(f.did, { ...log, events: [] }, claim, 0),
  ).rejects.toThrow(expect.objectContaining({ reason: 'no-rev' }))
  await expect(
    async () =>
      await api.effectOf(f.did, log, { ...claim, ref: { event: digestOf(f.rmv.event) } }, 0),
  ).rejects.toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  expect(await api.claimsFor(f.did, f.log, log, 0)).toContainEqual({
    ...claim,
    member: { did: f.a.identity.id, add: f.a.add },
  })
})

test('member rev of a member DID is never applied', async () => {
  const f = await effects()
  for (const removed of [false, true]) {
    const log = { ...f.log, events: [...f.log.events, ...(removed ? [f.rmv] : [])] }
    const rev = await createRevoke({
      did: f.did,
      head: (await fold(f.did, log)).head,
      parents: await epochHeads({ did: f.did, log: log }),
      signer: { member: f.b },
      target: f.a.identity.id,
    })
    log.events.push(rev)
    const result = await fold(f.did, log)
    expect(result.applied).not.toContain(digestOf(rev.event))
    expect(result.rejected).toBe(1)
    expect(result.head.deny.size).toBe(0)
    await expect(
      async () =>
        await api.effectOf(
          f.did,
          log,
          {
            kind: 'deny',
            did: f.a.did,
            ref: { event: digestOf(rev.event) },
          },
          0,
        ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  }
})

test('reset snapshot refs authenticate the target, generation and signature', async () => {
  const f = await buildEpoch({ members: 1 })
  const denied = f.members[0]
  if (denied == null) throw new Error('Missing member')
  const reset = await createReset({
    seed: f.seed,
    profile: 0,
    gen: 1,
    snapshot: { members: [], deny: [denied.did] },
  })
  const log = { chain: [f.inception, reset], events: [] }
  const claim: EffectClaim = { kind: 'deny', did: denied.identity.id, ref: { snapshot: 1 } }
  expect(await deviceRevokeIndices({ did: f.did, chain: log.chain, subject: denied.did })).toEqual(
    [],
  )
  expect(await api.claimsFor(f.did, undefined, log, 0)).toEqual([claim])
  await expect(api.effectOf(f.did, log, claim, 0)).resolves.not.toThrow()
  await expect(
    async () => await api.effectOf(f.did, log, { ...claim, did: 'did:key:other' }, 0),
  ).rejects.toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  await expect(async () => await api.effectOf(f.did, log, claim, 2)).rejects.toThrow(
    expect.objectContaining({ reason: 'generation-floor' }),
  )
  await expect(
    async () =>
      await api.effectOf(
        f.did,
        { ...log, chain: [f.inception, { ...reset, sigs: f.inception.sigs }] },
        claim,
        0,
      ),
  ).rejects.toThrow(expect.objectContaining({ reason: 'effects-mismatch' }))
  await expect(
    async () => await api.effectOf(f.did, log, { ...claim, ref: { chainIndex: 1 } }, 0),
  ).rejects.toThrow(expect.objectContaining({ reason: 'no-rev' }))
})

test('re-revoke after reset is proved at gen 2', async () => {
  const f = await buildEpoch({ members: 0 })
  const target = 'did:key:edge'
  const first = await createDeviceRevoke({
    seed: f.seed,
    profile: 0,
    did: f.did,
    chain: f.log.chain,
    subject: target,
  })
  const reset = await createReset({ seed: f.seed, profile: 0, gen: 2 })
  const chain = [f.inception, first, reset]
  chain.push(
    await createDeviceRevoke({ seed: f.seed, profile: 0, did: f.did, chain, subject: target }),
  )
  const log = { chain, events: [] }
  const claims = await api.claimsFor(f.did, { chain: chain.slice(0, 3), events: [] }, log, 2)
  expect(claims).toEqual([{ kind: 'deny', did: target, ref: { chainIndex: 3 } }])
  for (const claim of claims)
    await expect(api.effectOf(f.did, log, claim, 2)).resolves.not.toThrow()
  await expect(
    async () =>
      await api.effectOf(f.did, log, { kind: 'deny', did: target, ref: { chainIndex: 1 } }, 2),
  ).rejects.toThrow(expect.objectContaining({ reason: 'generation-floor' }))
})

test('claimsFor output passes effectOf for every claim', async () => {
  const f = await effects()
  const claims = await api.claimsFor(f.did, f.log, f.merged, 0)
  expect(claims).toEqual([
    { kind: 'deny', did: 'did:key:edge', ref: { event: digestOf(f.rev.event) } },
    {
      kind: 'remove',
      member: { did: normalizeDID(f.a.did), add: f.a.add },
      ref: { event: digestOf(f.rmv.event) },
    },
  ])
  for (const claim of claims)
    await expect(api.effectOf(f.did, f.merged, claim, 0)).resolves.not.toThrow()
  expect(await api.claimsFor(f.did, f.merged, f.merged, 0)).toEqual([])
  expect(await api.claimsFor(f.did, undefined, f.merged, 0)).toEqual(claims)
})

test('claimsFor orders denies by DID then removals by add digest', async () => {
  const f = await buildEpoch({ members: 3 })
  const events = [...f.log.events]
  for (const target of ['did:key:z', 'did:key:a'])
    events.push(
      await createRevoke({
        did: f.did,
        head: f.head,
        parents: await epochHeads({ did: f.did, log: f.log }),
        signer: f.root,
        target,
      }),
    )
  for (const member of f.members)
    events.push(
      await createRemove({
        did: f.did,
        head: f.head,
        parents: await epochHeads({ did: f.did, log: f.log }),
        signer: f.root,
        add: member.add,
      }),
    )
  const log = { chain: f.log.chain, events }
  const claims = await api.claimsFor(f.did, f.log, log, 0)
  expect(claims.slice(0, 2).map((claim) => claim.kind === 'deny' && claim.did)).toEqual([
    'did:key:a',
    'did:key:z',
  ])
  expect(claims.slice(2).map((claim) => claim.kind === 'remove' && claim.member.add)).toEqual(
    f.members.map((member) => member.add).sort(),
  )
  for (const claim of claims)
    await expect(api.effectOf(f.did, log, claim, 0)).resolves.not.toThrow()
})

test('claimsFor proves a carried denial at the reset that introduces its generation', async () => {
  const f = await buildEpoch({ members: 0 })
  const target = 'did:key:edge'
  const rev = await createDeviceRevoke({
    seed: f.seed,
    profile: 0,
    did: f.did,
    chain: f.log.chain,
    subject: target,
  })
  const reset = await createReset({
    seed: f.seed,
    profile: 0,
    gen: 1,
    snapshot: { members: [], deny: [target] },
  })
  const log = { chain: [f.inception, rev, reset], events: [] }
  expect(await api.claimsFor(f.did, undefined, log, 0)).toEqual([
    { kind: 'deny', did: target, ref: { snapshot: 2 } },
  ])
})

test('memberDropIndices ignores resets and refuses unauthenticated snapshots', async () => {
  const f = await buildEpoch({ members: 1 })
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const snapshot = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf({ state: f.head }),
  })
  const reset = await createReset({ seed: f.seed, profile: 0, gen: 1 })
  expect(await api.memberDropIndices(f.did, [f.inception, snapshot, reset], member.add)).toEqual([])
  const drop = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: snapshot.event,
    snapshot: { members: [], deny: [] },
  })
  expect(
    await api.memberDropIndices(
      f.did,
      [f.inception, snapshot, { ...drop, sigs: f.inception.sigs }],
      member.add,
    ),
  ).toEqual([])
})

test('claimsFor uses digest order independent of locale collation', async () => {
  const f = await buildEpoch({ members: 2 })
  const members = snapshotOf({ state: f.head }).members.map((member, index) => ({
    ...member,
    add: index === 0 ? 'Z' : 'a',
  }))
  const snapshot = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: { members, deny: [] },
  })
  const prior = { chain: [f.inception, snapshot], events: [] }
  const dropped = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: snapshot.event,
    snapshot: { members: [], deny: [] },
  })
  const claims = await api.claimsFor(
    f.did,
    prior,
    { chain: [...prior.chain, dropped], events: [] },
    0,
  )
  expect(claims.map((claim) => claim.kind === 'remove' && claim.member.add)).toEqual(['Z', 'a'])
})

test('claimsFor folds once when deriving and validating many event effects', async () => {
  const f = await buildEpoch({ members: 1, revokes: 8 })
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const rmv = await createRemove({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: f.root,
    add: member.add,
  })
  const log = { ...f.log, events: [...f.log.events, rmv] }
  const spy = vi.spyOn(controller, 'foldLog')
  spy.mockClear()
  let claims: Array<EffectClaim>
  try {
    claims = await api.claimsFor(f.did, undefined, log, 0)
    expect(claims).toHaveLength(9)
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  for (const claim of claims)
    await expect(api.effectOf(f.did, log, claim, 0)).resolves.not.toThrow()
})

test('claimsFor indexes snapshot drops once across repeated member snapshots', async () => {
  const f = await buildEpoch({ members: 3 })
  const first = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf({ state: f.head }),
  })
  const second = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: first.event,
    snapshot: snapshotOf({ state: f.head }),
  })
  const drop = await createRotate({
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
    claims = await api.claimsFor(f.did, undefined, log, 0)
    expect(claims).toHaveLength(3)
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  for (const claim of claims) {
    expect(claim.ref).toEqual({ chainIndex: 3 })
    await expect(api.effectOf(f.did, log, claim, 0)).resolves.not.toThrow()
  }
})

test('claimsFor keeps no-rev for an explicit removal without an admissible ref', async () => {
  const f = await effects()
  const removed = { ...f.log, events: [...f.log.events, f.rmv] }
  await expect(async () => await api.claimsFor(f.did, undefined, removed, 1)).rejects.toThrow(
    expect.objectContaining({ reason: 'no-rev' }),
  )
  const reset = {
    chain: [f.inception, await createReset({ seed: f.seed, profile: 0, gen: 1 })],
    events: removed.events,
  }
  await expect(async () => await api.claimsFor(f.did, f.log, reset, 1)).rejects.toThrow(
    expect.objectContaining({ reason: 'no-rev' }),
  )
  const settle = async (drop: Array<string>) =>
    await createRotate({
      seed: f.seed,
      profile: 0,
      did: f.did,
      prior: f.inception.event,
      snapshot: snapshotOf({ state: (await fold(f.did, f.merged)).head, members: drop }),
    })
  await expect(
    async () =>
      await api.claimsFor(
        f.did,
        f.log,
        { chain: [...f.log.chain, await settle([f.rmv.event.add])], events: [] },
        0,
      ),
  ).rejects.toThrow(expect.objectContaining({ reason: 'no-rev' }))
  // Keeping the tombstone (the default) proves the removal from the chain.
  expect(
    await api.claimsFor(f.did, f.log, { chain: [...f.log.chain, await settle([])], events: [] }, 0),
  ).toContainEqual(expect.objectContaining({ kind: 'remove', ref: { chainIndex: 1 } }))
})

test('claimsFor folds a refused historical epoch once and still uses an authenticated snapshot', async () => {
  const f = await buildEpoch({ members: 0 })
  const rev = await createRevoke({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: f.root,
    target: 'did:key:edge',
  })
  const settle = await createRotate({
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
    claims = await api.claimsFor(f.did, undefined, log, 0)
    expect(claims).toEqual([{ kind: 'deny', did: 'did:key:edge', ref: { chainIndex: 1 } }])
    expect(spy).toHaveBeenCalledTimes(2)
  } finally {
    spy.mockRestore()
  }
  for (const claim of claims)
    await expect(api.effectOf(f.did, log, claim, 0)).resolves.not.toThrow()
})
