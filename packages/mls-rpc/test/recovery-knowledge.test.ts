import {
  type ControllerLog,
  createRemove,
  createRenew,
  createReset,
  createRevoke,
  createRotate,
  digestOf,
  encodeKey,
  epochHeads,
  foldLog,
  type KeyState,
  snapshotOf,
} from '@kokuin/controller'
import type { OwnIdentity } from '@kokuin/token'
import type {
  ControllerBinding,
  ControllerProjection,
  DeviceRegistry,
  GroupHandle,
} from '@kumiai/mls'
import * as mls from '@kumiai/mls'
import { afterEach, expect, test, vi } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'

const { buildEpoch } = (await import(
  new URL('../../mls/test/fixtures/controller-epoch.ts', import.meta.url).href
)) as {
  buildEpoch: () => Promise<{
    seed: Uint8Array
    did: string
    log: ControllerLog
    inception: ControllerLog['chain'][number]
    head: KeyState
    members: Array<{ identity: OwnIdentity; add: string; privateKey: Uint8Array }>
  }>
}
const fixture = (await import(
  new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
)) as {
  agent: (byte: number) => OwnIdentity
  timedBinding: (params: {
    identity: OwnIdentity
    iat: number
    exp: number
  }) => Promise<ControllerBinding>
}

afterEach(() => vi.restoreAllMocks())

function head(did: string, log: ControllerLog): KeyState {
  const folded = foldLog(did, log)
  if (!folded.ok) throw new Error(folded.reason)
  return folded.head
}

function project(
  registry: DeviceRegistry,
  did: string,
  fields: Partial<ControllerProjection>,
): DeviceRegistry {
  const projection = registry.controllers.get(did)
  if (projection == null) throw new Error('Missing projection')
  return { ...registry, controllers: new Map([[did, { ...projection, ...fields }]]) }
}

async function removal() {
  const f = await buildEpoch()
  const a = f.members[0]
  if (a == null) throw new Error('Missing member')
  const event = createRemove({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: a.add,
  })
  const log = { chain: f.log.chain, events: [...f.log.events, event] }
  return { ...f, a, removedLog: log, known: mls.registryForLog(f.did, log) }
}

test('reply whose ledger omits a known removal is refused', async () => {
  const f = await removal()
  const candidate = mls.registryForLog(f.did, f.log)
  expect(() => mls.assertRetainsKnownEffects(f.did, f.known, candidate)).toThrow(
    new mls.RecoveryKnowledgeError('removal'),
  )
})

test('reply omitting a known renewal is refused', async () => {
  const f = await buildEpoch()
  const a = f.members[0]
  if (a == null) throw new Error('Missing member')
  const event = createRenew({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: a.add,
    lease: 2000,
  })
  const known = mls.registryForLog(f.did, { ...f.log, events: [...f.log.events, event] })
  expect(() =>
    mls.assertRetainsKnownEffects(f.did, known, mls.registryForLog(f.did, f.log)),
  ).toThrow(new mls.RecoveryKnowledgeError('epoch-event'))
})

test('reply omitting a known revocation is refused', async () => {
  const f = await buildEpoch()
  const event = createRevoke({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { root: { seed: f.seed, profile: 0 } },
    target: fixture.agent(81).id,
  })
  const known = mls.registryForLog(f.did, { ...f.log, events: [...f.log.events, event] })
  const reset = mls.registryForLog(f.did, {
    chain: [f.inception, createReset(f.seed, 0, 1)],
    events: [],
  })
  for (const candidate of [mls.registryForLog(f.did, f.log), reset]) {
    expect(() => mls.assertRetainsKnownEffects(f.did, known, candidate)).toThrow(
      new mls.RecoveryKnowledgeError('revocation'),
    )
  }
})

test.each(['attestation', 'timeFloor', 'genFloor'] as const)(
  'reply omitting a known attestation or floor is refused: %s',
  async (kind) => {
    const f = await buildEpoch()
    const member = f.members[0]
    if (member == null) throw new Error('Missing member')
    const key = encodeKey(member.identity.publicKey, 'EdDSA')
    const candidate = mls.registryForLog(f.did, f.log)
    const known = project(candidate, f.did, {
      ...(kind === 'attestation' ? { attestations: new Map([[key, 1200]]) } : { [kind]: 1200 }),
    })
    expect(() => mls.assertRetainsKnownEffects(f.did, known, candidate)).toThrow(
      new mls.RecoveryKnowledgeError(kind === 'attestation' ? 'attestation' : 'floor'),
    )
  },
)

function settle(
  f: Awaited<ReturnType<typeof buildEpoch>>,
  log = f.log,
  drop: Array<string> = [],
): ControllerLog {
  const prior = log.chain.at(-1)
  if (prior == null) throw new Error('Missing chain head')
  const rotation = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: prior.event,
    snapshot: snapshotOf(head(f.did, log), { members: drop }),
  })
  return { chain: [...log.chain, rotation], events: [] }
}

test('an unrelated settlement cannot revive a lapsed signer', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const f = await buildEpoch()
  const signer = f.members[1]
  if (signer == null) throw new Error('Missing signer')
  const candidate = mls.registryForLog(f.did, settle(f))
  const known = project(mls.registryForLog(f.did, f.log), f.did, { timeFloor: 1200 })
  const { group } = await mls.createGroup(signer.identity, 'lapsed-recovery', {
    controller: {
      id: f.did,
      prefix: f.log.chain,
      member: { add: signer.add, g: 0 },
      iat: 100,
    },
    controllerLog: f.log,
  })
  expect(
    mls.recoverySignerEligible({ group, registry: candidate, signer: signer.identity.id }),
  ).toBe(true)
  expect(() => mls.assertRetainsKnownEffects(f.did, known, candidate)).toThrow(
    new mls.RecoveryKnowledgeError('floor'),
  )
  expect(mls.recoverySignerEligible({ group, registry: known, signer: signer.identity.id })).toBe(
    false,
  )
})

test('reply whose chain settles past the omitted epoch events is accepted (its floors and attestations intact)', async () => {
  const f = await buildEpoch()
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const key = encodeKey(member.identity.publicKey, 'EdDSA')
  const clocks = { timeFloor: 1200, attestations: new Map([[key, 1100]]) }
  const known = project(mls.registryForLog(f.did, f.log), f.did, clocks)
  const candidate = project(mls.registryForLog(f.did, settle(f)), f.did, clocks)
  expect(() => mls.assertRetainsKnownEffects(f.did, known, candidate)).not.toThrow()
  expect(() =>
    mls.assertRetainsKnownEffects(
      f.did,
      known,
      project(candidate, f.did, { attestations: new Map() }),
    ),
  ).toThrow(new mls.RecoveryKnowledgeError('attestation'))
})

test('a settlement that leaves the known epoch open cannot supersede its applied events', async () => {
  const f = await buildEpoch()
  const log = settle(f)
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const event = createRenew({
    did: f.did,
    head: head(f.did, log),
    parents: epochHeads(f.did, log),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: member.add,
    lease: 2000,
  })
  const known = mls.registryForLog(f.did, { ...log, events: [event] })
  expect(() => mls.assertRetainsKnownEffects(f.did, known, mls.registryForLog(f.did, log))).toThrow(
    new mls.RecoveryKnowledgeError('epoch-event'),
  )
})

test("reply carrying a reset above the omitted removal's generation is accepted", async () => {
  const f = await removal()
  const candidate = mls.registryForLog(f.did, {
    chain: [f.inception, createReset(f.seed, 0, 1)],
    events: [],
  })
  expect(() => mls.assertRetainsKnownEffects(f.did, f.known, candidate)).not.toThrow()
})

test('a reset at the same generation cannot supersede an omitted removal', async () => {
  const f = await buildEpoch()
  const log = {
    chain: [f.inception, createReset(f.seed, 0, 1, snapshotOf(f.head))],
    events: [],
  }
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const event = createRemove({
    did: f.did,
    head: head(f.did, log),
    parents: epochHeads(f.did, log),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: member.add,
  })
  const known = mls.registryForLog(f.did, { ...log, events: [event] })
  expect(known.controllers.get(f.did)?.removedMembers.get(member.add)?.gen).toBe(1)
  expect(() => mls.assertRetainsKnownEffects(f.did, known, mls.registryForLog(f.did, log))).toThrow(
    new mls.RecoveryKnowledgeError('removal'),
  )
})

test('equivalent authenticated chain representations retain known settlement state', async () => {
  const f = await buildEpoch()
  const log = settle(f)
  const reset = createReset(f.seed, 0, 1)
  const known = mls.registryForLog(f.did, { chain: [...log.chain, reset], events: [] })
  const candidate = mls.registryForLog(f.did, { chain: [f.inception, reset], events: [] })
  expect(() => mls.assertRetainsKnownEffects(f.did, known, candidate)).not.toThrow()
})

test.each(['full', 'pruned'] as const)(
  'a newer reset on a %s chain supersedes the known settlement',
  async (representation) => {
    const f = await buildEpoch()
    const log = settle(f)
    const known = mls.registryForLog(f.did, log)
    const reset = createReset(f.seed, 0, 1)
    const candidate = mls.registryForLog(f.did, {
      chain: representation === 'full' ? [...log.chain, reset] : [f.inception, reset],
      events: [],
    })
    expect(() => mls.assertRetainsKnownEffects(f.did, known, candidate)).not.toThrow()
  },
)

test('a pruned stale reset cannot roll back a later settlement in its generation', async () => {
  const f = await buildEpoch()
  const reset = createReset(f.seed, 0, 1)
  const log = { chain: [...settle(f).chain, reset], events: [] }
  const known = mls.registryForLog(f.did, settle(f, log))
  const candidate = mls.registryForLog(f.did, { chain: [f.inception, reset], events: [] })
  expect(() => mls.assertRetainsKnownEffects(f.did, known, candidate)).toThrow(
    new mls.RecoveryKnowledgeError('forked'),
  )
})

test('settlement does not supersede an omitted removal', async () => {
  const f = await removal()
  const candidate = mls.registryForLog(f.did, settle(f, f.removedLog, [f.a.add]))
  expect(() => mls.assertRetainsKnownEffects(f.did, f.known, candidate)).toThrow(
    new mls.RecoveryKnowledgeError('removal'),
  )
})

test('settlement keeping the tombstone retains the removal', async () => {
  const f = await removal()
  const candidate = mls.registryForLog(f.did, settle(f, f.removedLog))
  expect(candidate.controllers.get(f.did)?.removedMembers.has(f.a.add)).toBe(true)
  expect(() => mls.assertRetainsKnownEffects(f.did, f.known, candidate)).not.toThrow()
})

test('forked reply is refused', async () => {
  const f = await buildEpoch()
  const chain = settle(f).chain
  const fork = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf(f.head),
    seal: digestOf('fork'),
  })
  expect(() =>
    mls.assertRetainsKnownEffects(
      f.did,
      mls.registryForLog(f.did, { chain, events: [] }),
      mls.registryForLog(f.did, { chain: [...f.log.chain, fork], events: [] }),
    ),
  ).toThrow(new mls.RecoveryKnowledgeError('forked'))
})

test('unapplied event bytes confer no recovery knowledge', async () => {
  const f = await buildEpoch()
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const event = createRenew({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: member.add,
    lease: 2000,
  })
  const forged = { ...event, sigs: ['forged'] }
  const known = mls.registryForLog(f.did, { ...f.log, events: [...f.log.events, forged] })
  expect(() =>
    mls.assertRetainsKnownEffects(f.did, known, mls.registryForLog(f.did, f.log)),
  ).not.toThrow()
})

async function recoveryGroup(f: Awaited<ReturnType<typeof buildEpoch>>, log = f.log) {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const identity = fixture.agent(41)
  const signer = f.members[1]
  if (signer == null) throw new Error('Missing signer')
  let known = (
    await mls.createGroup(identity, 'recovery-knowledge', {
      controller: await fixture.timedBinding({ identity, iat: 100, exp: 2000 }),
      controllerLog: log,
    })
  ).group
  const bundle = await mls.createKeyPackageBundle(signer.identity, {
    controller: { id: f.did, prefix: log.chain, member: { add: signer.add, g: 0 }, iat: 100 },
    controllerLog: log,
  })
  const { invite } = await mls.createInvite({
    group: known,
    identity,
    recipientDID: signer.identity.id,
  })
  const added = await mls.commitInvite(known, bundle.publicPackage, invite)
  known = added.newGroup
  let source = (
    await mls.processWelcome({
      identity: signer.identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options: {
        resolveLedgerEntries: async (ids) => {
          return ids.map((id) => {
            const token = known.ledgerTokens.find((token) => mls.ledgerEntryDigest(token) === id)
            if (token == null) throw new Error('Missing test token')
            return token
          })
        },
      },
    })
  ).group
  const requester = createGroupMLS({
    identity,
    entrySlot: createLedgerEntrySlot(),
    access: simpleHandleAccess({
      handle: () => known,
      adopt: (next) => {
        known = next
      },
    }),
  })
  const responder = createGroupMLS({
    identity: signer.identity,
    entrySlot: createLedgerEntrySlot(),
    access: simpleHandleAccess({
      handle: () => source,
      adopt: (next) => {
        source = next
      },
    }),
  })
  return {
    signer,
    requester,
    responder,
    group: () => known,
    source: () => source,
    adopt: (next: GroupHandle) => {
      known = next
    },
    adoptSource: (next: GroupHandle) => {
      source = next
    },
    publish: (message: Uint8Array) => source.processMessage(message),
    pending: async () => {
      const request = await requester.createRecoveryRequest('knowledge')
      return requester.applyRecovery(await responder.sealGroupInfo(request), 'knowledge')
    },
  }
}

async function recovery() {
  const f = await removal()
  const r = await recoveryGroup(f)
  const removed = await mls.revokeWithProof(r.group(), {
    log: f.removedLog,
    remove: [{ did: f.a.identity.id, add: f.a.add }],
  })
  if (removed.status !== 'built') throw new Error('Expected removal')
  r.adopt(removed.result.newGroup)
  return {
    ...f,
    ...r,
    publish: () => r.publish(removed.result.commitMessage),
  }
}

test('recovery cannot roll back a published settlement to revive a lapsed signer', async () => {
  const f = await buildEpoch()
  const log = settle(f)
  const r = await recoveryGroup(f, log)
  const prior = log.chain.at(-1)
  if (prior == null) throw new Error('Missing chain head')
  const snapshot = snapshotOf(head(f.did, log))
  snapshot.members = snapshot.members.map((member) =>
    member.add === r.signer.add ? { ...member, lease: 200 } : member,
  )
  const settled = {
    chain: [
      ...log.chain,
      createRotate({
        seed: f.seed,
        profile: 0,
        did: f.did,
        prior: prior.event,
        snapshot,
      }),
    ],
    events: [],
  }
  const published = await mls.publishControllerLog(r.group(), settled)
  if (published == null) throw new Error('Expected settlement publication')
  r.adopt(published.newGroup)
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const lease = (registry: DeviceRegistry) => {
    const recorded = registry.controllers.get(f.did)?.recordedLog
    if (recorded == null) throw new Error('Missing log')
    return head(f.did, recorded).members.get(r.signer.add)?.lease
  }
  expect(lease(r.group().registry)).toBe(200)
  expect(lease(r.source().registry)).toBe(1000)
  expect(
    mls.recoverySignerEligible({
      group: r.group(),
      registry: r.group().registry,
      signer: r.signer.identity.id,
    }),
  ).toBe(false)
  expect(
    mls.recoverySignerEligible({
      group: r.group(),
      registry: r.source().registry,
      signer: r.signer.identity.id,
    }),
  ).toBe(true)
  const retention = vi.spyOn(mls, 'assertRetainsKnownEffects')
  const pending = await r.pending()
  if (pending != null && !('renewalRequired' in pending)) await pending.onAccepted()
  expect(lease(r.group().registry)).toBe(200)
  expect(pending).toBeNull()
  expect(retention.mock.results).toContainEqual({
    type: 'throw',
    value: new mls.RecoveryKnowledgeError('forked'),
  })
  expect(retention.mock.results[0]?.value).toBeInstanceOf(mls.RecoveryKnowledgeError)
  expect(retention.mock.results[0]?.value).toHaveProperty('reason', 'forked')
  expect(
    mls.recoverySignerEligible({
      group: r.group(),
      registry: r.group().registry,
      signer: r.signer.identity.id,
    }),
  ).toBe(false)
})

// Recovery round trips exceed 5s on shared CI runners.
test.each(['at', 'ahead'] as const)(
  'a responder %s the known chain is accepted',
  async (position) => {
    const f = await buildEpoch()
    const log = settle(f)
    const r = await recoveryGroup(f, log)
    if (position === 'ahead') {
      const published = await mls.publishControllerLog(r.source(), settle(f, log))
      if (published == null) throw new Error('Expected settlement publication')
      r.adoptSource(published.newGroup)
    }
    const pending = await r.pending()
    if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
    await pending.onAccepted()
    const recorded = r.group().registry.controllers.get(f.did)?.recordedLog
    expect(recorded?.chain.length).toBe(position === 'ahead' ? 3 : 2)
  },
  30_000,
)

test('an effective member reply omitting the known removal is ineligible', async () => {
  const f = await recovery()
  const retention = vi.spyOn(mls, 'assertRetainsKnownEffects')
  await expect(f.pending()).resolves.toBeNull()
  expect(retention.mock.results).toContainEqual({
    type: 'throw',
    value: new mls.RecoveryKnowledgeError('removal'),
  })
  expect(retention.mock.results[0]?.value).toBeInstanceOf(mls.RecoveryKnowledgeError)
  expect(retention.mock.results[0]?.value).toHaveProperty('reason', 'removal')
  expect(f.group().registry.controllers.get(f.did)?.removedMembers.has(f.a.add)).toBe(true)
}, 30_000)

test('known removal survives adoption and restore', async () => {
  const f = await recovery()
  await f.publish()
  const retention = vi.spyOn(mls, 'assertRetainsKnownEffects')
  const pending = await f.pending()
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  const candidate = pending as typeof pending & {
    group: GroupHandle
    knownRegistry: DeviceRegistry
  }
  expect(candidate.knownRegistry).toBe(candidate.group.registry)
  const checked = retention.mock.calls[0]?.[2]
  expect(checked).toBeDefined()
  expect(candidate.group.registry).toEqual(checked)
  expect(candidate.group.ledgerTokens).toEqual(f.source().ledgerTokens)
  await pending.onAccepted()
  expect(f.group().registry).toBe(candidate.group.registry)
  expect(f.group().registry).toEqual(checked)
  expect(f.group().registry.controllers.get(f.did)?.removedMembers.get(f.a.add)).toMatchObject({
    did: f.a.identity.id,
    gen: 0,
  })
  const restored = await mls.restoreGroup({
    state: f.group().state,
    credential: f.group().credential,
    ledgerEntries: f.group().ledgerTokens,
  })
  expect(restored.registry.controllers.get(f.did)?.removedMembers.get(f.a.add)).toEqual(
    f.group().registry.controllers.get(f.did)?.removedMembers.get(f.a.add),
  )
}, 30_000)

test('recovery adoption refuses knowledge bootstrapped after preparation, including retries', async () => {
  const f = await removal()
  const r = await recoveryGroup(f)
  const request = await r.requester.createRecoveryRequest('adoption-race')
  const sealed = await r.responder.sealGroupInfo(request)
  const partialLedger = r.group().ledgerTokens
  const removed = await mls.revokeWithProof(r.group(), {
    log: f.removedLog,
    remove: [{ did: f.a.identity.id, add: f.a.add }],
  })
  if (removed.status !== 'built') throw new Error('Expected removal')
  const completeLedger = removed.result.newGroup.ledgerTokens
  const partial = await mls.restoreGroup({
    state: removed.result.newGroup.state,
    credential: removed.result.newGroup.credential,
    ledgerEntries: partialLedger,
  })
  r.adopt(partial)
  expect(await partial.isLedgerComplete()).toBe(false)
  const pending = await r.requester.applyRecovery(sealed, 'adoption-race')
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  await partial.bootstrapLedger(completeLedger)
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(pending.onAccepted()).rejects.toThrow(new mls.RecoveryKnowledgeError('removal'))
    expect(r.group()).toBe(partial)
    expect(r.group().registry.controllers.get(f.did)?.removedMembers.size).toBe(1)
  }
}, 30_000)
