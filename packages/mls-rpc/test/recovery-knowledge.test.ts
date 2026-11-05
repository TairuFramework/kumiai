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

async function head(did: string, log: ControllerLog): Promise<KeyState> {
  const folded = await foldLog({ did: did, input: log })
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
  const event = await createRemove({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: a.add,
  })
  const log = { chain: f.log.chain, events: [...f.log.events, event] }
  return { ...f, a, removedLog: log, known: await mls.registryForLog({ controller: f.did, log }) }
}

test('reply whose ledger omits a known removal is refused', async () => {
  const f = await removal()
  const candidate = await mls.registryForLog({ controller: f.did, log: f.log })
  await expect(
    async () =>
      await mls.assertRetainsKnownEffects({ controller: f.did, known: f.known, candidate }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('removal'))
})

test('reply omitting a known renewal is refused', async () => {
  const f = await buildEpoch()
  const a = f.members[0]
  if (a == null) throw new Error('Missing member')
  const event = await createRenew({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: a.add,
    lease: 2000,
  })
  const known = await mls.registryForLog({
    controller: f.did,
    log: { ...f.log, events: [...f.log.events, event] },
  })
  await expect(
    async () =>
      await mls.assertRetainsKnownEffects({
        controller: f.did,
        known,
        candidate: await mls.registryForLog({ controller: f.did, log: f.log }),
      }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('epoch-event'))
})

test('reply omitting a known revocation is refused', async () => {
  const f = await buildEpoch()
  const event = await createRevoke({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: { root: { seed: f.seed, profile: 0 } },
    target: fixture.agent(81).id,
  })
  const known = await mls.registryForLog({
    controller: f.did,
    log: { ...f.log, events: [...f.log.events, event] },
  })
  const reset = await mls.registryForLog({
    controller: f.did,
    log: {
      chain: [f.inception, await createReset({ seed: f.seed, profile: 0, gen: 1 })],
      events: [],
    },
  })
  for (const candidate of [await mls.registryForLog({ controller: f.did, log: f.log }), reset]) {
    await expect(
      async () => await mls.assertRetainsKnownEffects({ controller: f.did, known, candidate }),
    ).rejects.toThrow(new mls.RecoveryKnowledgeError('revocation'))
  }
})

test.each(['attestation', 'timeFloor', 'genFloor'] as const)(
  'reply omitting a known attestation or floor is refused: %s',
  async (kind) => {
    const f = await buildEpoch()
    const member = f.members[0]
    if (member == null) throw new Error('Missing member')
    const key = encodeKey({ publicKey: member.identity.publicKey, alg: 'EdDSA' })
    const candidate = await mls.registryForLog({ controller: f.did, log: f.log })
    const known = project(candidate, f.did, {
      ...(kind === 'attestation' ? { attestations: new Map([[key, 1200]]) } : { [kind]: 1200 }),
    })
    await expect(
      async () => await mls.assertRetainsKnownEffects({ controller: f.did, known, candidate }),
    ).rejects.toThrow(
      new mls.RecoveryKnowledgeError(kind === 'attestation' ? 'attestation' : 'floor'),
    )
  },
)

async function settle(
  f: Awaited<ReturnType<typeof buildEpoch>>,
  log = f.log,
): Promise<ControllerLog> {
  const prior = log.chain.at(-1)
  if (prior == null) throw new Error('Missing chain head')
  const rotation = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: prior.event,
    snapshot: snapshotOf({ state: await head(f.did, log) }),
  })
  return { chain: [...log.chain, rotation], events: [] }
}

test('an unrelated settlement cannot revive a lapsed signer', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const f = await buildEpoch()
  const signer = f.members[1]
  if (signer == null) throw new Error('Missing signer')
  const candidate = await mls.registryForLog({ controller: f.did, log: await settle(f) })
  const known = project(await mls.registryForLog({ controller: f.did, log: f.log }), f.did, {
    timeFloor: 1200,
  })
  const { group } = await mls.createGroup({
    identity: signer.identity,
    groupID: 'lapsed-recovery',
    controller: {
      id: f.did,
      prefix: f.log.chain,
      member: { add: signer.add, g: 0 },
      iat: 100,
    },
    controllerLog: f.log,
  })
  expect(
    await mls.recoverySignerEligible({ group, registry: candidate, signer: signer.identity.id }),
  ).toBe(true)
  await expect(
    async () => await mls.assertRetainsKnownEffects({ controller: f.did, known, candidate }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('floor'))
  expect(
    await mls.recoverySignerEligible({ group, registry: known, signer: signer.identity.id }),
  ).toBe(false)
})

test('reply whose chain settles past the omitted epoch events is accepted (its floors and attestations intact)', async () => {
  const f = await buildEpoch()
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const key = encodeKey({ publicKey: member.identity.publicKey, alg: 'EdDSA' })
  const clocks = { timeFloor: 1200, attestations: new Map([[key, 1100]]) }
  const known = project(await mls.registryForLog({ controller: f.did, log: f.log }), f.did, clocks)
  const candidate = project(
    await mls.registryForLog({ controller: f.did, log: await settle(f) }),
    f.did,
    clocks,
  )
  await expect(
    mls.assertRetainsKnownEffects({ controller: f.did, known, candidate }),
  ).resolves.not.toThrow()
  await expect(
    async () =>
      await mls.assertRetainsKnownEffects({
        controller: f.did,
        known,
        candidate: project(candidate, f.did, { attestations: new Map() }),
      }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('attestation'))
})

test('a settlement that leaves the known epoch open cannot supersede its applied events', async () => {
  const f = await buildEpoch()
  const log = await settle(f)
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const event = await createRenew({
    did: f.did,
    head: await head(f.did, log),
    parents: await epochHeads({ did: f.did, log: log }),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: member.add,
    lease: 2000,
  })
  const known = await mls.registryForLog({ controller: f.did, log: { ...log, events: [event] } })
  await expect(
    async () =>
      await mls.assertRetainsKnownEffects({
        controller: f.did,
        known,
        candidate: await mls.registryForLog({ controller: f.did, log }),
      }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('epoch-event'))
})

test("reply carrying a reset above the omitted removal's generation is accepted", async () => {
  const f = await removal()
  const candidate = await mls.registryForLog({
    controller: f.did,
    log: {
      chain: [f.inception, await createReset({ seed: f.seed, profile: 0, gen: 1 })],
      events: [],
    },
  })
  await expect(
    mls.assertRetainsKnownEffects({ controller: f.did, known: f.known, candidate }),
  ).resolves.not.toThrow()
})

test('a reset at the same generation cannot supersede an omitted removal', async () => {
  const f = await buildEpoch()
  const log = {
    chain: [
      f.inception,
      await createReset({
        seed: f.seed,
        profile: 0,
        gen: 1,
        snapshot: snapshotOf({ state: f.head }),
      }),
    ],
    events: [],
  }
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const event = await createRemove({
    did: f.did,
    head: await head(f.did, log),
    parents: await epochHeads({ did: f.did, log: log }),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: member.add,
  })
  const known = await mls.registryForLog({ controller: f.did, log: { ...log, events: [event] } })
  expect(known.controllers.get(f.did)?.removedMembers.get(member.add)?.gen).toBe(1)
  await expect(
    async () =>
      await mls.assertRetainsKnownEffects({
        controller: f.did,
        known,
        candidate: await mls.registryForLog({ controller: f.did, log }),
      }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('removal'))
})

test('equivalent authenticated chain representations retain known settlement state', async () => {
  const f = await buildEpoch()
  const log = await settle(f)
  const reset = await createReset({ seed: f.seed, profile: 0, gen: 1 })
  const known = await mls.registryForLog({
    controller: f.did,
    log: { chain: [...log.chain, reset], events: [] },
  })
  const candidate = await mls.registryForLog({
    controller: f.did,
    log: { chain: [f.inception, reset], events: [] },
  })
  await expect(
    mls.assertRetainsKnownEffects({ controller: f.did, known, candidate }),
  ).resolves.not.toThrow()
})

test.each(['full', 'pruned'] as const)(
  'a newer reset on a %s chain supersedes the known settlement',
  async (representation) => {
    const f = await buildEpoch()
    const log = await settle(f)
    const known = await mls.registryForLog({ controller: f.did, log })
    const reset = await createReset({ seed: f.seed, profile: 0, gen: 1 })
    const candidate = await mls.registryForLog({
      controller: f.did,
      log: {
        chain: representation === 'full' ? [...log.chain, reset] : [f.inception, reset],
        events: [],
      },
    })
    await expect(
      mls.assertRetainsKnownEffects({ controller: f.did, known, candidate }),
    ).resolves.not.toThrow()
  },
)

test('a pruned stale reset cannot roll back a later settlement in its generation', async () => {
  const f = await buildEpoch()
  const reset = await createReset({ seed: f.seed, profile: 0, gen: 1 })
  const log = { chain: [...(await settle(f)).chain, reset], events: [] }
  const known = await mls.registryForLog({ controller: f.did, log: await settle(f, log) })
  const candidate = await mls.registryForLog({
    controller: f.did,
    log: { chain: [f.inception, reset], events: [] },
  })
  await expect(
    async () => await mls.assertRetainsKnownEffects({ controller: f.did, known, candidate }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('forked'))
})

test('settlement does not supersede an omitted removal', async () => {
  const f = await removal()
  const candidate = await mls.registryForLog({
    controller: f.did,
    log: await settle(f, f.removedLog),
  })
  await expect(
    async () =>
      await mls.assertRetainsKnownEffects({ controller: f.did, known: f.known, candidate }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('removal'))
})

test('forked reply is refused', async () => {
  const f = await buildEpoch()
  const chain = (await settle(f)).chain
  const fork = await createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: snapshotOf({ state: f.head }),
    seal: digestOf('fork'),
  })
  await expect(
    async () =>
      await mls.assertRetainsKnownEffects({
        controller: f.did,
        known: await mls.registryForLog({ controller: f.did, log: { chain, events: [] } }),
        candidate: await mls.registryForLog({
          controller: f.did,
          log: { chain: [...f.log.chain, fork], events: [] },
        }),
      }),
  ).rejects.toThrow(new mls.RecoveryKnowledgeError('forked'))
})

test('unapplied event bytes confer no recovery knowledge', async () => {
  const f = await buildEpoch()
  const member = f.members[0]
  if (member == null) throw new Error('Missing member')
  const event = await createRenew({
    did: f.did,
    head: f.head,
    parents: await epochHeads({ did: f.did, log: f.log }),
    signer: { root: { seed: f.seed, profile: 0 } },
    add: member.add,
    lease: 2000,
  })
  const forged = { ...event, sigs: ['forged'] }
  const known = await mls.registryForLog({
    controller: f.did,
    log: { ...f.log, events: [...f.log.events, forged] },
  })
  await expect(
    mls.assertRetainsKnownEffects({
      controller: f.did,
      known,
      candidate: await mls.registryForLog({ controller: f.did, log: f.log }),
    }),
  ).resolves.not.toThrow()
})

async function recoveryGroup(f: Awaited<ReturnType<typeof buildEpoch>>, log = f.log) {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const identity = fixture.agent(41)
  const signer = f.members[1]
  if (signer == null) throw new Error('Missing signer')
  let known = (
    await mls.createGroup({
      identity,
      groupID: 'recovery-knowledge',
      controller: await fixture.timedBinding({ identity, iat: 100, exp: 2000 }),
      controllerLog: log,
    })
  ).group
  const bundle = await mls.createKeyPackageBundle({
    identity: signer.identity,
    controller: { id: f.did, prefix: log.chain, member: { add: signer.add, g: 0 }, iat: 100 },
    controllerLog: log,
  })
  const { invite } = await mls.createInvite({
    group: known,
    identity,
    recipientDID: signer.identity.id,
  })
  const added = await mls.commitInvite({ group: known, keyPackage: bundle.publicPackage, invite })
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
    publish: (message: Uint8Array) => source.processMessage({ message }),
    pending: async () => {
      const request = await requester.createRecoveryRequest({ requestID: 'knowledge' })
      return requester.applyRecovery({
        sealed: await responder.sealGroupInfo(request),
        requestID: 'knowledge',
      })
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
  const log = await settle(f)
  const r = await recoveryGroup(f, log)
  const prior = log.chain.at(-1)
  if (prior == null) throw new Error('Missing chain head')
  const snapshot = snapshotOf({ state: await head(f.did, log) })
  snapshot.members = snapshot.members.map((member) =>
    member.add === r.signer.add ? { ...member, lease: 200 } : member,
  )
  const settled = {
    chain: [
      ...log.chain,
      await createRotate({
        seed: f.seed,
        profile: 0,
        did: f.did,
        prior: prior.event,
        snapshot,
      }),
    ],
    events: [],
  }
  const published = await mls.publishControllerLog({ group: r.group(), log: settled })
  if (published == null) throw new Error('Expected settlement publication')
  r.adopt(published.newGroup)
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const lease = async (registry: DeviceRegistry) => {
    const recorded = registry.controllers.get(f.did)?.recordedLog
    if (recorded == null) throw new Error('Missing log')
    return (await head(f.did, recorded)).members.get(r.signer.add)?.lease
  }
  expect(await lease(r.group().registry)).toBe(200)
  expect(await lease(r.source().registry)).toBe(1000)
  expect(
    await mls.recoverySignerEligible({
      group: r.group(),
      registry: r.group().registry,
      signer: r.signer.identity.id,
    }),
  ).toBe(false)
  expect(
    await mls.recoverySignerEligible({
      group: r.group(),
      registry: r.source().registry,
      signer: r.signer.identity.id,
    }),
  ).toBe(true)
  const retention = vi.spyOn(mls, 'assertRetainsKnownEffects')
  const pending = await r.pending()
  if (pending != null && !('renewalRequired' in pending)) await pending.onAccepted()
  expect(await lease(r.group().registry)).toBe(200)
  expect(pending).toBeNull()
  expect(retention.mock.settledResults).toContainEqual({
    type: 'rejected',
    value: new mls.RecoveryKnowledgeError('forked'),
  })
  expect(retention.mock.settledResults[0]?.value).toBeInstanceOf(mls.RecoveryKnowledgeError)
  expect(retention.mock.settledResults[0]?.value).toHaveProperty('reason', 'forked')
  expect(
    await mls.recoverySignerEligible({
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
    const log = await settle(f)
    const r = await recoveryGroup(f, log)
    if (position === 'ahead') {
      const published = await mls.publishControllerLog({
        group: r.source(),
        log: await settle(f, log),
      })
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
  expect(retention.mock.settledResults).toContainEqual({
    type: 'rejected',
    value: new mls.RecoveryKnowledgeError('removal'),
  })
  expect(retention.mock.settledResults[0]?.value).toBeInstanceOf(mls.RecoveryKnowledgeError)
  expect(retention.mock.settledResults[0]?.value).toHaveProperty('reason', 'removal')
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
  const request = await r.requester.createRecoveryRequest({ requestID: 'adoption-race' })
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
  const pending = await r.requester.applyRecovery({ sealed, requestID: 'adoption-race' })
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  await partial.bootstrapLedger({ tokens: completeLedger })
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(pending.onAccepted()).rejects.toThrow(new mls.RecoveryKnowledgeError('removal'))
    expect(r.group()).toBe(partial)
    expect(r.group().registry.controllers.get(f.did)?.removedMembers.size).toBe(1)
  }
}, 30_000)
