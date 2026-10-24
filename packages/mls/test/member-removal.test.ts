import { audienceConfirmation } from '@kokuin/capability'
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
  pruneLog,
  snapshotOf,
} from '@kokuin/controller'
import { type OwnIdentity, stringifyToken } from '@kokuin/token'
import { defaultProposalTypes } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import { readCapability } from '../src/capability.js'
import { foldControllerLog } from '../src/controller-log.js'
import type { ControllerBinding } from '../src/credential.js'
import { RevokeProofError } from '../src/errors.js'
import { commitLedgerEntries } from '../src/group.js'
import { restoreGroup } from '../src/group-create.js'
import * as api from '../src/group-lifecycle.js'
import { processWelcome } from '../src/group-welcome.js'
import { computeHead, readLedgerHead } from '../src/head.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'
import * as lifecycle from '../src/lifecycle.js'
import { isLapsed, leafAt, leafExpiry } from '../src/lifecycle.js'
import { authenticateLifecycleProof } from '../src/lifecycle-proof.js'
import { effectiveAuthorityOf } from '../src/member-root.js'
import { recoverySignerEligible } from '../src/recovery-verdict.js'
import { DEVICE_ENTRY_TYPE, denySetOf, registryForLog } from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import {
  agent,
  belowGateWelcome,
  pipelineGroup,
  rawApplication,
  rawBundle,
  rawCommit,
  timedBinding,
  welcomeBoundary,
} from './fixtures/lifecycle-pipeline.js'

afterEach(() => vi.restoreAllMocks())

function head(did: string, log: ControllerLog) {
  const folded = foldControllerLog(did, log)
  if (!folded.ok) throw new Error(folded.reason)
  return folded.head
}

async function fixture(kind: 'direct' | 'parent' | 'membership' | 'holder' = 'direct') {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const epoch = await buildEpoch({ members: 3, renewEvery: 2000 })
  const [a, b, c] = epoch.members
  if (a == null || b == null || c == null) throw new Error('Missing members')
  const setup = await pipelineGroup({ controllerLog: epoch.log })
  const grant = async (pin: typeof a, audience: OwnIdentity, extra: Record<string, unknown> = {}) =>
    stringifyToken(
      await pin.identity.signToken(
        {
          sub: epoch.did,
          aud: audience.id,
          act: 'authenticate',
          res: 'kumiai/mls-leaf',
          cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: audience.publicKey }),
          iat: 100,
          exp: 900,
          mbr: { add: pin.add, g: 0 },
          ...extra,
        },
        { embedLongForm: true },
      ),
    )
  const device = kind === 'membership' ? a.identity : agent(61)
  const parent = await grant(a, agent(71))
  const capability =
    kind === 'parent' || kind === 'holder'
      ? stringifyToken(
          await agent(71).signToken({
            ...readCapability(await grant(a, device)).payload,
            iss: agent(71).id,
            mbr: undefined,
            cap: parent,
          }),
        )
      : await grant(a, device)
  const binding: ControllerBinding = {
    id: epoch.did,
    prefix: epoch.log.chain,
    ...(kind === 'membership' ? { member: { add: a.add, g: 0 }, iat: 100 } : { capability }),
    ...(kind === 'holder' ? { holderGrant: await grant(b, device) } : {}),
  }
  const joined = await belowGateWelcome(setup.group, device, binding)
  const rmv = createRemove({
    did: epoch.did,
    head: epoch.head,
    parents: epochHeads(epoch.did, epoch.log),
    signer: { member: b },
    add: a.add,
  })
  const removedLog = { chain: epoch.log.chain, events: [...epoch.log.events, rmv] }
  const remove = [{ did: a.identity.id, add: a.add }]
  const publish = (group: typeof setup.group) => {
    for (const token of group.ledgerTokens) setup.tokens.set(ledgerEntryDigest(token), token)
  }
  const build = (survivors?: Array<string>, log = removedLog) =>
    api.revokeWithProof(joined.author, { log, remove, survivors })
  return {
    ...epoch,
    ...setup,
    group: joined.author,
    receiver: joined.joined,
    device,
    binding,
    a,
    b,
    c,
    grant,
    rmv,
    removedLog,
    remove,
    publish,
    build,
  }
}

function built(result: Awaited<ReturnType<typeof api.revokeWithProof>>) {
  expect(result.status).toBe('built')
  if (result.status !== 'built') throw new Error(JSON.stringify(result))
  return result.result
}

function settle(f: Awaited<ReturnType<typeof fixture>>, log = f.removedLog) {
  const prior = log.chain.at(-1)
  if (prior == null) throw new Error('Missing chain')
  return {
    chain: [
      ...log.chain,
      createRotate({
        seed: f.seed,
        profile: 0,
        did: f.did,
        prior: prior.event,
        snapshot: snapshotOf(head(f.did, log)),
      }),
    ],
    events: [],
  }
}

test.each([
  ['rmv cascades a direct mbr leaf', 'direct'],
  ['rmv cascades a leaf whose parent came from the removed member', 'parent'],
  ["rmv cascades the member's own membership leaf", 'membership'],
] as const)('%s', async (_name, kind) => {
  const f = await fixture(kind)
  const events = vi.fn()
  f.group.events.on('memberRemoved', events)
  const result = built(await f.build())
  result.newGroup.confirmAdopted()
  expect(result.newGroup.findMemberLeafIndex(f.device.id)).toBeUndefined()
  expect(result.newGroup.registry.devices.has(f.device.id)).toBe(false)
  expect(result.newGroup.registry.controllers.get(f.did)?.removedMembers.get(f.a.add)).toEqual({
    did: f.a.identity.id,
    gen: 0,
    proofRef: { event: digestOf(f.rmv.event) },
  })
  expect(events).toHaveBeenCalledWith([
    { controller: f.did, member: f.remove[0], removedLeaves: [f.device.id] },
  ])
  expect(
    await api.revokeWithProof(result.newGroup, { log: f.removedLog, remove: f.remove }),
  ).toEqual({ status: 'already-revoked' })
})

test('rmv keeps a leaf whose holder grant came from another effective member', async () => {
  const f = await fixture('holder')
  const result = built(await f.build())
  expect(result.newGroup.findMemberLeafIndex(f.device.id)).toBeDefined()
  expect(
    effectiveAuthorityOf(
      { did: f.device.id, binding: f.binding, leafKey: f.device.publicKey },
      result.newGroup.registry,
      f.did,
    ),
  ).toMatchObject({ slot: 'holder', expiry: 900 })
})

test('settled rmv proved by chain index removes the same leaves', async () => {
  const f = await fixture()
  const snapshotted = settle(f, f.log)
  const published = await api.publishControllerLog(f.group, snapshotted)
  if (published == null) throw new Error('Missing settlement')
  const rmv = createRemove({
    did: f.did,
    head: head(f.did, snapshotted),
    parents: epochHeads(f.did, snapshotted),
    signer: { member: f.b },
    add: f.a.add,
  })
  const log = settle(f, { ...snapshotted, events: [rmv] })
  const result = built(await api.revokeWithProof(published.newGroup, { log, remove: f.remove }))
  expect(result.newGroup.findMemberLeafIndex(f.device.id)).toBeUndefined()
  expect(
    result.newGroup.registry.controllers.get(f.did)?.removedMembers.get(f.a.add)?.proofRef,
  ).toEqual({ chainIndex: 2 })
})

test('settled rmv of a never-snapshotted incarnation lands with its epoch proof', async () => {
  const f = await fixture()
  const log = settle(f)
  await expect(api.publishControllerLog(f.group, log)).rejects.toMatchObject({
    reason: 'effects-mismatch',
  })
  const evidence = api.removalEvidence(f.did, f.removedLog, digestOf(f.rmv.event))
  expect(evidence).toBeDefined()
  const result = built(
    await api.revokeWithProof(f.group, {
      log,
      remove: f.remove,
      evidence: evidence == null ? [] : [evidence],
    }),
  )
  const next = await api.publishControllerLog(result.newGroup, settle(f, log))
  expect(
    next?.newGroup.registry.controllers.get(f.did)?.removedMembers.get(f.a.add)?.proofRef,
  ).toEqual({ event: digestOf(f.rmv.event), epoch: digestOf(f.inception.event) })
})

test('revokeWithProof with retained removal evidence lands after a settle, and Welcome and restore agree', async () => {
  const f = await fixture()
  const evidence = api.removalEvidence(f.did, f.removedLog, digestOf(f.rmv.event))
  if (evidence == null) throw new Error('Missing evidence')
  const log = pruneLog(f.did, settle(f))
  expect(log.events).toEqual([])
  expect(await api.revokeWithProof(f.group, { log, remove: f.remove })).toEqual({
    status: 'not-provable',
    reason: 'no-rev',
  })
  const inputs = structuredClone({ log, remove: f.remove, evidence: [evidence] })
  const original = structuredClone(inputs)
  const result = built(await api.revokeWithProof(f.group, inputs))
  expect(inputs).toEqual(original)
  const observer = await belowGateWelcome(
    f.group,
    agent(81),
    await timedBinding({ identity: agent(81), iat: 100, exp: 900 }),
  )
  // Build on the same tree the observer joined.
  const received = built(await api.revokeWithProof(observer.author, inputs))
  f.publish(received.newGroup)
  await observer.joined.processMessage(received.commitMessage)
  const welcome = await welcomeBoundary(
    received.newGroup,
    agent(82),
    await timedBinding({ identity: agent(82), iat: 100, exp: 900 }),
  )
  const joined = await welcome.process()
  const restored = await restoreGroup({
    state: received.newGroup.state,
    credential: received.newGroup.credential,
    ledgerEntries: received.newGroup.ledgerTokens,
  })
  const projection = result.newGroup.registry.controllers.get(f.did)
  for (const group of [observer.joined, joined.group, restored]) {
    expect(group.registry.controllers.get(f.did)?.removedMembers).toEqual(
      projection?.removedMembers,
    )
    expect(group.registry.controllers.get(f.did)?.recordedLog?.events).toEqual([])
  }
})

test('losing a managing device is rmv only', async () => {
  const f = await fixture('membership')
  const earlierGrant = await f.grant(f.b, f.a.identity)
  const result = built(await f.build())
  expect(result.newGroup.findMemberLeafIndex(f.a.identity.id)).toBeUndefined()
  expect(denySetOf(result.newGroup.registry).has(f.a.identity.id)).toBe(false)
  const leaf = (
    await rawBundle(result.newGroup, f.a.identity, {
      id: f.did,
      prefix: f.log.chain,
      capability: earlierGrant,
    })
  ).publicPackage.leafNode
  await expect(
    verifyLeafCredential(leaf.credential, leaf.signaturePublicKey, {
      judging: () => ({ registry: result.newGroup.registry, stage: 'full', mode: 'admit' }),
    }),
  ).resolves.toBeUndefined()
})

test("removed member's earlier-signed leaf arriving after the removal is refused", async () => {
  const f = await fixture()
  const result = built(await f.build())
  // Root can settle a concurrent view that still includes the removed incarnation.
  const published = await api.publishControllerLog(result.newGroup, settle(f, f.log))
  if (published == null) throw new Error('Missing settlement')
  const stale = await rawBundle(published.newGroup, agent(83), {
    id: f.did,
    prefix: f.log.chain,
    capability: await f.grant(f.a, agent(83)),
  })
  for (const mode of ['admit', 'retain', 'rejudge'] as const) {
    await expect(
      verifyLeafCredential(stale.publicPackage.leafNode.credential, agent(83).publicKey, {
        judging: () => ({ registry: published.newGroup.registry, stage: 'full', mode }),
      }),
    ).rejects.toMatchObject({ reason: 'member-removed' })
  }
})

test("removed member's concurrent log entry is refused", async () => {
  const f = await fixture()
  const concurrent = createRenew({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { member: f.a },
    add: f.b.add,
    lease: 2000,
  })
  const result = built(await f.build())
  await expect(
    api.publishControllerLog(result.newGroup, {
      ...f.removedLog,
      events: [...f.removedLog.events, concurrent],
    }),
  ).rejects.toMatchObject({ reason: 'not-endorsed' })
})

test.each([
  "cascaded device returns under another member's grant",
  'removed device returns under a new incarnation',
])('%s', async (name) => {
  const f = await fixture('membership')
  const result = built(await f.build())
  let group = result.newGroup
  let binding: ControllerBinding
  if (name.startsWith('cascaded'))
    binding = { id: f.did, prefix: f.log.chain, capability: await f.grant(f.b, f.device) }
  else {
    const add = createAdd({
      seed: f.seed,
      profile: 0,
      did: f.did,
      head: head(f.did, f.removedLog),
      parents: epochHeads(f.did, f.removedLog),
      member: { did: f.a.did, key: encodeKey(f.device.publicKey, 'EdDSA'), lease: 2000 },
    })
    const published = await api.publishControllerLog(group, {
      ...f.removedLog,
      events: [...f.removedLog.events, add],
    })
    if (published == null) throw new Error('Missing add')
    group = published.newGroup
    binding = {
      id: f.did,
      prefix: f.log.chain,
      member: { add: digestOf(add.event), g: 0 },
      iat: 150,
    }
  }
  const welcome = await welcomeBoundary(group, f.device, binding)
  const joined = await welcome.process()
  expect(joined.group.findMemberLeafIndex(f.device.id)).toBeDefined()
})

test('survivor grant keeps a direct mbr leaf; one from the removed member is refused', async () => {
  const f = await fixture()
  expect(api.survivorTargets(f.group, f.a.add)).toEqual([
    { did: f.device.id, leafKey: f.device.publicKey },
  ])
  const survivor = await f.grant(f.b, f.device)
  const result = built(await f.build([survivor]))
  expect(result.newGroup.registry.controllers.get(f.did)?.survivorGrants.get(f.device.id)).toBe(
    survivor,
  )
  expect(result.newGroup.findMemberLeafIndex(f.device.id)).toBeDefined()
  await expect(f.build([await f.grant(f.a, f.device)])).rejects.toMatchObject({
    reason: 'member-removed',
  })
})

test('survivor grant minted by a member removed in the same window is refused', async () => {
  const f = await fixture()
  const second = createRemove({
    did: f.did,
    head: head(f.did, f.removedLog),
    parents: epochHeads(f.did, f.removedLog),
    signer: { member: f.c },
    add: f.b.add,
  })
  await expect(
    f.build([await f.grant(f.b, f.device)], {
      ...f.removedLog,
      events: [...f.removedLog.events, second],
    }),
  ).rejects.toMatchObject({ reason: 'member-removed' })
})

test.each([
  { aud: agent(99).id },
  { cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: agent(99).publicKey }) },
  { act: 'manage' },
  { res: 'kumiai/devices' },
  { exp: 100 + 2_592_001 },
  { mbr: undefined },
  { cap: 'delegated' },
])('survivor grant refuses invalid claims %j', async (extra) => {
  const f = await fixture()
  await expect(f.build([await f.grant(f.b, f.device, extra)])).rejects.not.toBeInstanceOf(TypeError)
})

test('survivor grant signature is authenticated', async () => {
  const f = await fixture()
  const valid = await f.grant(f.b, f.device)
  const [header, payload] = valid.split('.')
  const invalid = `${header}.${payload}.${'A'.repeat(86)}`
  await expect(f.build([invalid])).rejects.not.toBeInstanceOf(TypeError)
})

test('a substituted capability expires at the earlier of its own and substitute expiry', async () => {
  const f = await fixture()
  for (const expiry of [250, 1200]) {
    const result = built(await f.build([await f.grant(f.b, f.device, { exp: expiry })]))
    expect(leafExpiry(f.binding, result.newGroup.registry, f.did)).toBe(Math.min(900, expiry))
  }
})

test('a later removal cascades through the survivor grant root', async () => {
  const f = await fixture()
  const first = built(await f.build([await f.grant(f.b, f.device)]))
  expect(api.survivorTargets(first.newGroup, f.b.add)).toEqual([
    { did: f.device.id, leafKey: f.device.publicKey },
  ])
  const rmv = createRemove({
    did: f.did,
    head: head(f.did, f.removedLog),
    parents: epochHeads(f.did, f.removedLog),
    signer: { member: f.c },
    add: f.b.add,
  })
  const second = built(
    await api.revokeWithProof(first.newGroup, {
      log: { ...f.removedLog, events: [...f.removedLog.events, rmv] },
      remove: [{ did: f.b.identity.id, add: f.b.add }],
    }),
  )
  expect(second.newGroup.findMemberLeafIndex(f.device.id)).toBeUndefined()
  expect(second.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
    removed: [{ did: f.device.id, cascadedFrom: f.b.identity.id }],
  })
})

test.each(['survivor authors its next commit', 'survivor appears in a later Welcome'])(
  '%s',
  async (name) => {
    const f = await fixture('membership')
    const result = built(await f.build([await f.grant(f.b, f.device)]))
    f.publish(result.newGroup)
    await f.receiver.processMessage(result.commitMessage)
    if (name.includes('authors')) {
      const note = await signLedgerEntry(f.device, {
        type: 'test.note',
        groupID: f.group.groupID,
        subject: f.device.id,
        value: 'survived',
      })
      const commit = await commitLedgerEntries(f.receiver, [note])
      f.publish(commit.newGroup)
      await result.newGroup.processMessage(commit.commitMessage)
      expect(result.newGroup.epoch).toBe(commit.epoch)
    } else {
      const welcome = await welcomeBoundary(
        result.newGroup,
        agent(82),
        await timedBinding({ identity: agent(82), iat: 100, exp: 900 }),
      )
      expect((await welcome.process()).group.findMemberLeafIndex(f.device.id)).toBeDefined()
    }
  },
)

test("membership survivor lapses at its survivor grant's expiry", async () => {
  const f = await fixture('membership')
  const result = built(await f.build([await f.grant(f.b, f.device, { exp: 250 })]))
  f.publish(result.newGroup)
  await f.receiver.processMessage(result.commitMessage)
  const early = await rawApplication(f.receiver)
  expect(
    recoverySignerEligible({
      group: result.newGroup,
      known: result.newGroup.registry,
      signer: f.device.id,
      now: 150,
    }),
  ).toBe(true)
  const leaf = leafAt(
    result.newGroup.state.ratchetTree,
    result.newGroup.findMemberLeafIndex(f.device.id) ?? -1,
  )
  if (leaf == null) throw new Error('Missing survivor')
  expect(leafExpiry(f.binding, result.newGroup.registry, f.did)).toBe(250)
  const clocker = agent(84)
  const later = await belowGateWelcome(
    result.newGroup,
    clocker,
    await timedBinding({ identity: clocker, iat: 251, exp: 900 }),
  )
  const group = later.author
  await f.receiver.processMessage(later.message)
  const late = await rawApplication(f.receiver)
  expect(isLapsed(group, leaf)).toBe(true)
  expect(
    recoverySignerEligible({ group, known: group.registry, signer: f.device.id, now: 252 }),
  ).toBe(false)
  await expect(group.processMessage(early)).resolves.toBeDefined()
  await expect(group.processMessage(late)).rejects.toMatchObject({ reason: 'lapsed' })
  const welcome = await welcomeBoundary(
    group,
    agent(85),
    await timedBinding({ identity: agent(85), iat: 251, exp: 900 }),
  )
  const joined = await welcome.process()
  expect(isLapsed(joined.group, leaf)).toBe(true)
  expect((await api.removeLapsedLeaves(later.joined)).removed).toContain(f.device.id)
})

test('Welcome joiner refuses a leaf the ledger removed', async () => {
  const f = await fixture()
  const token = await signLedgerEntry(f.identity, {
    type: DEVICE_ENTRY_TYPE,
    groupID: f.group.groupID,
    subject: f.did,
    value: {
      op: 'revoke',
      proof: { chain: [], events: [f.rmv] },
      effects: [{ kind: 'remove', member: f.remove[0], ref: { event: digestOf(f.rmv.event) } }],
      revoked: [],
      removed: [{ did: f.device.id, cascadedFrom: f.a.identity.id }],
    },
  })
  const joiner = agent(82)
  const bundle = await rawBundle(
    f.group,
    joiner,
    await timedBinding({ identity: joiner, iat: 100, exp: 900 }),
  )
  const result = await rawCommit({
    group: f.group,
    tokens: [token],
    proposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
  })
  if (result.welcome == null) throw new Error('Missing Welcome')
  const original = lifecycle.validateWelcomeTree
  const observed: Array<boolean> = []
  vi.spyOn(lifecycle, 'validateWelcomeTree').mockImplementation(async (group, judging) => {
    if (judging?.stage !== 'structural') {
      observed.push(group.registry.controllers.get(f.did)?.removedMembers.has(f.a.add) === true)
      expect(readLedgerHead(group)?.head).toEqual(
        computeHead(group.groupID, [...f.group.ledgerTokens, token].map(ledgerEntryDigest)),
      )
    }
    await original(group, judging)
  })
  await expect(
    processWelcome({
      identity: joiner,
      invite: {
        groupID: f.group.groupID,
        inviterID: f.identity.id,
        recipientDID: joiner.id,
        ledgerEntries: [...f.group.ledgerTokens, token],
      },
      welcome: result.welcome.welcome,
      keyPackageBundle: { ...bundle, ownerDID: joiner.id },
    }),
  ).rejects.toMatchObject({ reason: 'member-removed' })
  expect(observed).toEqual([true])
})

test('concurrent mutual rmv: the first to land wins and the second is not-endorsed', async () => {
  const f = await fixture()
  const reverse = createRemove({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: { member: f.a },
    add: f.b.add,
  })
  const result = built(await f.build())
  expect(
    await api.revokeWithProof(result.newGroup, {
      log: { ...f.removedLog, events: [...f.removedLog.events, reverse] },
      remove: [{ did: f.b.identity.id, add: f.b.add }],
    }),
  ).toEqual({ status: 'not-provable', reason: 'not-endorsed' })
})

test('a partial current-epoch removal closure is refused with no-rev', async () => {
  const f = await fixture()
  expect(() =>
    authenticateLifecycleProof(
      f.did,
      {
        issuer: f.identity.id,
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: f.group.groupID,
          subject: f.did,
          value: {
            op: 'revoke',
            proof: { chain: [], events: [f.rmv] },
            effects: [
              {
                kind: 'remove',
                member: { did: f.a.identity.id, add: f.a.add },
                ref: { event: digestOf(f.rmv.event) },
              },
            ],
            revoked: [],
            removed: [],
          },
        },
      },
      registryForLog(f.did, { chain: f.log.chain, events: [] }),
    ),
  ).toThrow(expect.objectContaining({ constructor: RevokeProofError, reason: 'no-rev' }))
})

test('a new denial after reset is not mistaken for an earlier-generation record', async () => {
  const f = await fixture()
  const target = agent(99).id
  const rev = createRevoke({
    did: f.did,
    head: f.head,
    parents: epochHeads(f.did, f.log),
    signer: f.root,
    target,
  })
  const first = built(
    await api.revokeWithProof(f.group, {
      log: { ...f.log, events: [...f.log.events, rev] },
      deny: [target],
    }),
  )
  const log = { chain: [f.inception, createReset(f.seed, 0, 1)], events: [] }
  const renewed = await api.renewLeaf(
    first.newGroup,
    await timedBinding({ identity: f.identity, iat: 150, exp: 900, prefix: log.chain }),
  )
  const reset = built(await api.revokeWithProof(renewed.newGroup, { reset: true, log }))
  const next = createRevoke({
    did: f.did,
    head: head(f.did, log),
    parents: epochHeads(f.did, log),
    signer: f.root,
    target,
  })
  const result = built(
    await api.revokeWithProof(reset.newGroup, { log: { ...log, events: [next] }, deny: [target] }),
  )
  expect(result.newGroup.ledger.at(-1)?.verified.entry.value).toMatchObject({
    effects: [{ kind: 'deny', did: target, ref: { event: digestOf(next.event) } }],
  })
})
