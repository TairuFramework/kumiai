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

function settle(f: Awaited<ReturnType<typeof buildEpoch>>, log = f.log): ControllerLog {
  const prior = log.chain.at(-1)
  if (prior == null) throw new Error('Missing chain head')
  const rotation = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: prior.event,
    snapshot: snapshotOf(head(f.did, log)),
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

test("reply carrying a reset above the omitted removal's generation is accepted", async () => {
  const f = await removal()
  const candidate = mls.registryForLog(f.did, {
    chain: [f.inception, createReset(f.seed, 0, 1)],
    events: [],
  })
  expect(() => mls.assertRetainsKnownEffects(f.did, f.known, candidate)).not.toThrow()
})

test('settlement does not supersede an omitted removal', async () => {
  const f = await removal()
  const candidate = mls.registryForLog(f.did, settle(f, f.removedLog))
  expect(() => mls.assertRetainsKnownEffects(f.did, f.known, candidate)).toThrow(
    new mls.RecoveryKnowledgeError('removal'),
  )
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

async function recovery() {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const f = await removal()
  const identity = fixture.agent(41)
  const signer = f.members[1]
  if (signer == null) throw new Error('Missing signer')
  let known = (
    await mls.createGroup(identity, 'recovery-knowledge', {
      controller: await fixture.timedBinding({ identity, iat: 100, exp: 900 }),
      controllerLog: f.log,
    })
  ).group
  const bundle = await mls.createKeyPackageBundle(signer.identity, {
    controller: { id: f.did, prefix: f.log.chain, member: { add: signer.add, g: 0 }, iat: 100 },
    controllerLog: f.log,
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
  const removed = await mls.revokeWithProof(known, {
    log: f.removedLog,
    remove: [{ did: f.a.identity.id, add: f.a.add }],
  })
  if (removed.status !== 'built') throw new Error('Expected removal')
  known = removed.result.newGroup
  return {
    ...f,
    requester,
    responder,
    group: () => known,
    publish: () => source.processMessage(removed.result.commitMessage),
    pending: async () => {
      const request = await requester.createRecoveryRequest('knowledge')
      return requester.applyRecovery(await responder.sealGroupInfo(request), 'knowledge')
    },
  }
}

test('an effective member reply omitting the known removal is ineligible', async () => {
  const f = await recovery()
  await expect(f.pending()).resolves.toBeNull()
  expect(f.group().registry.controllers.get(f.did)?.removedMembers.has(f.a.add)).toBe(true)
})

test('known removal survives adoption and restore', async () => {
  const f = await recovery()
  await f.publish()
  const pending = await f.pending()
  if (pending == null || 'renewalRequired' in pending) throw new Error('Expected candidate')
  const candidate = pending as typeof pending & {
    group: GroupHandle
    knownRegistry: DeviceRegistry
  }
  expect(candidate.knownRegistry).toBe(candidate.group.registry)
  await pending.onAccepted()
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
})
