import { audienceConfirmation } from '@kokuin/capability'
import {
  type ControllerLog,
  createRenew,
  createRotate,
  epochHeads,
  snapshotOf,
} from '@kokuin/controller'
import { type OwnIdentity, stringifyToken } from '@kokuin/token'
import { encode, mlsMessageEncoder } from 'ts-mls'
import { afterEach, expect, test, vi } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import { asControllerLog, foldControllerLog } from '../src/controller-log.js'
import type { ControllerBinding } from '../src/credential.js'
import { commitWithEntries } from '../src/group-commit.js'
import { createGroup } from '../src/group-create.js'
import { makeMLSCredential } from '../src/group-credential.js'
import * as api from '../src/index.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import { recordedLogOf, registryForLog } from '../src/registry.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { agent, rawBundle, timedBinding } from './fixtures/lifecycle-pipeline.js'

afterEach(() => vi.restoreAllMocks())

async function fixture(events = 33, creatorMember = false) {
  vi.spyOn(Date, 'now').mockReturnValue(150000)
  const epoch = await buildEpoch({ members: 1, revokes: events - 1 })
  const member = epoch.members[0]
  if (member == null) throw new Error('Missing member')
  const identity = creatorMember ? member.identity : agent(41)
  const binding: ControllerBinding = creatorMember
    ? { id: epoch.did, prefix: epoch.log.chain, member: { add: member.add, g: 0 }, iat: 100 }
    : await timedBinding({ identity, iat: 100, exp: 900 })
  const tokens = new Map<string, string>()
  const { group } = await createGroup(identity, 'epoch-cap', {
    controller: binding,
    controllerLog: epoch.log,
    resolveLedgerEntries: async (ids) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error('Missing token')
        return token
      }),
  })
  const publish = (entries: Array<string>) => {
    for (const token of entries) tokens.set(ledgerEntryDigest(token), token)
  }
  return { ...epoch, member, identity, group, publish }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function grant(f: Fixture, identity: OwnIdentity): Promise<ControllerBinding> {
  return {
    id: f.did,
    prefix: f.log.chain,
    capability: stringifyToken(
      await f.member.identity.signToken({
        sub: f.did,
        aud: identity.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: identity.publicKey }),
        iat: 100,
        exp: 800,
        mbr: { add: f.member.add, g: 0 },
      }),
    ),
  }
}

function renewed(f: Fixture): ControllerLog {
  return {
    chain: f.log.chain,
    events: [
      ...f.log.events,
      createRenew({
        did: f.did,
        head: f.head,
        parents: epochHeads(f.did, f.log),
        signer: f.root,
        add: f.member.add,
        lease: 2000,
      }),
    ],
  }
}

function settled(f: Fixture): ControllerLog {
  return {
    chain: [
      ...f.log.chain,
      createRotate({
        seed: f.seed,
        profile: 0,
        did: f.did,
        prior: f.inception.event,
        snapshot: snapshotOf(f.head),
      }),
    ],
    events: [],
  }
}

test.each([
  [0, 'ok'],
  [23, 'ok'],
  [24, 'prompt'],
  [32, 'prompt'],
  [33, 'blocked'],
] as const)('settleAdvisory thresholds: %i events gives %s', async (count, advisory) => {
  const { log } = await buildEpoch({ members: 0, revokes: count })
  expect(api.epochEventCount(log)).toBe(count)
  expect(api.settleAdvisory(log)).toBe(advisory)
})

test('epochEventCount counts distinct authenticated applied events of the current epoch', async () => {
  const f = await fixture(32)
  const first = f.log.events[0]
  if (first == null) throw new Error('Missing event')
  const extra = renewed(f).events.at(-1)
  if (extra == null) throw new Error('Missing renewal')
  const padded = {
    chain: f.log.chain,
    events: [
      ...f.log.events,
      first,
      { ...extra, sigs: [] },
      createRenew({
        did: f.did,
        head: f.head,
        parents: ['missing-parent'],
        signer: f.root,
        add: f.member.add,
        lease: 2000,
      }),
    ],
  }
  expect(api.epochEventCount(padded)).toBe(32)
  expect(api.settleAdvisory(padded)).toBe('prompt')
  expect(api.epochEventCount({ ...settled(f), events: f.log.events })).toBe(0)
})

test('GroupHandle.settleAdvisory reads the recorded log and defaults to ok without one', async () => {
  const f = await fixture()
  expect(f.group.settleAdvisory()).toBe('blocked')
  const result = await api.publishControllerLog(f.group, settled(f))
  if (result == null) throw new Error('Missing settlement')
  expect(result.newGroup.settleAdvisory()).toBe('ok')
  const { group } = await createGroup(agent(62), 'standard')
  expect(group.settleAdvisory()).toBe('ok')
})

test.each(['direct mbr capability', 'member-rooted parent', 'membership binding'] as const)(
  'member-rooted Add refused with epoch-cap at 33 events: %s',
  async (form) => {
    const f = await fixture()
    const identity = form === 'membership binding' ? f.member.identity : agent(62)
    let binding: ControllerBinding
    if (form === 'membership binding') {
      binding = {
        id: f.did,
        prefix: f.log.chain,
        member: { add: f.member.add, g: 0 },
        iat: 100,
      }
    } else if (form === 'member-rooted parent') {
      const issuer = agent(61)
      binding = await timedBinding({
        identity,
        issuer,
        parent: (await grant(f, issuer)).capability,
        iat: 150,
        exp: 700,
      })
    } else binding = await grant(f, identity)
    await expect(
      verifyLeafCredential(makeMLSCredential(identity, binding), identity.publicKey, {
        judging: () => ({ registry: f.group.registry, stage: 'full', mode: 'admit' }),
      }),
    ).rejects.toMatchObject({ name: 'LeafBindingError', reason: 'epoch-cap' })
    for (const mode of ['retain', 'rejudge'] as const) {
      await expect(
        verifyLeafCredential(makeMLSCredential(identity, binding), identity.publicKey, {
          judging: () => ({ registry: f.group.registry, stage: 'full', mode }),
        }),
      ).resolves.toBeUndefined()
    }
    await expect(
      verifyLeafCredential(makeMLSCredential(identity, binding), identity.publicKey, {
        judging: () => ({ stage: 'structural', mode: 'admit' }),
      }),
    ).resolves.toBeUndefined()
    const bundle = await rawBundle(f.group, identity, binding)
    const { invite } = await api.createInvite({
      group: f.group,
      identity: f.identity,
      recipientDID: identity.id,
    })
    await expect(api.commitInvite(f.group, bundle.publicPackage, invite)).rejects.toMatchObject({
      reason: 'epoch-cap',
    })
  },
)

test('root-issued Add accepted at 33 events', async () => {
  const f = await fixture()
  const identity = agent(62)
  const bundle = await rawBundle(
    f.group,
    identity,
    await timedBinding({ identity, iat: 100, exp: 900 }),
  )
  const { invite } = await api.createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: identity.id,
  })
  const result = await api.commitInvite(f.group, bundle.publicPackage, invite)
  expect(result.newGroup.findMemberLeafIndex(identity.id)).toBeDefined()
})

test('admission cap reads the candidate registry when a log entry crosses 32 events', async () => {
  const f = await fixture(32)
  const identity = agent(62)
  const binding = await grant(f, identity)
  await expect(
    verifyLeafCredential(makeMLSCredential(identity, binding), identity.publicKey, {
      judging: () => ({ registry: f.group.registry, stage: 'full', mode: 'admit' }),
    }),
  ).resolves.toBeUndefined()
  const bundle = await rawBundle(f.group, identity, binding)
  const { invite } = await api.createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: identity.id,
    controllerLog: renewed(f),
  })
  await expect(api.commitInvite(f.group, bundle.publicPackage, invite)).rejects.toMatchObject({
    reason: 'epoch-cap',
  })
})

test('unchanged member-rooted committer still commits at 33 events', async () => {
  const f = await fixture(32, true)
  const identity = agent(62)
  const bundle = await rawBundle(
    f.group,
    identity,
    await timedBinding({ identity, iat: 100, exp: 900 }),
  )
  const { invite } = await api.createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: identity.id,
  })
  const added = await api.commitInvite(f.group, bundle.publicPackage, invite)
  const { group: joined } = await api.processWelcome({
    identity,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: identity.id },
    options: { resolveLedgerEntries: f.group.resolveLedgerEntries },
  })
  const grown = await api.publishControllerLog(added.newGroup, renewed(f))
  if (grown == null) throw new Error('Missing log commit')
  f.publish(grown.newGroup.ledgerTokens)
  await joined.processMessage(grown.commitMessage)
  const result = await commitWithEntries({ group: grown.newGroup, extraProposals: [], enacted: [] })
  f.publish(result.enacted)
  await joined.processMessage(encode(mlsMessageEncoder, result.commit))
  expect(joined.epoch).toBe(grown.newGroup.epoch + 1n)
  expect(joined.findMemberLeafIndex(f.identity.id)).toBeDefined()
})

test('Welcome with member-rooted tree leaves joins at 33 events', async () => {
  const f = await fixture(32, true)
  const grown = await api.publishControllerLog(f.group, renewed(f))
  if (grown == null) throw new Error('Missing log commit')
  const identity = agent(62)
  const bundle = await rawBundle(
    grown.newGroup,
    identity,
    await timedBinding({ identity, iat: 100, exp: 900 }),
  )
  const { invite } = await api.createInvite({
    group: grown.newGroup,
    identity: f.identity,
    recipientDID: identity.id,
  })
  const added = await api.commitInvite(grown.newGroup, bundle.publicPackage, invite)
  const { group: joined } = await api.processWelcome({
    identity,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: { ...bundle, ownerDID: identity.id },
  })
  expect(joined.findMemberLeafIndex(f.identity.id)).toBeDefined()
  expect(recordedLogOf(joined.registry, f.did)?.events).toHaveLength(33)
})

test('log and revoke entries still land at 33 events', async () => {
  const f = await fixture()
  const result = await api.publishControllerLog(f.group, renewed(f))
  if (result == null) throw new Error('Missing log commit')
  expect(recordedLogOf(result.newGroup.registry, f.did)?.events).toHaveLength(34)
  const subject = agent(63).id
  const rotation = createRotate({
    seed: f.seed,
    profile: 0,
    did: f.did,
    prior: f.inception.event,
    snapshot: { ...snapshotOf(f.head), deny: [...f.head.deny, subject] },
  })
  const revoked = await api.revokeWithProof(f.group, {
    deny: [subject],
    log: asControllerLog([f.inception, rotation]),
  })
  expect(revoked.status).toBe('built')
  if (revoked.status !== 'built') throw new Error('Missing revoke')
  expect(revoked.result.newGroup.registry.devices.get(subject)?.status).toBe('revoked')
})

test('after a root settlement the refused Add is accepted', async () => {
  const f = await fixture()
  const identity = agent(62)
  const binding = await grant(f, identity)
  const bundle = await rawBundle(f.group, identity, binding)
  const { invite } = await api.createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: identity.id,
  })
  await expect(api.commitInvite(f.group, bundle.publicPackage, invite)).rejects.toMatchObject({
    reason: 'epoch-cap',
  })
  const repaired = await api.createInvite({
    group: f.group,
    identity: f.identity,
    recipientDID: identity.id,
    controllerLog: settled(f),
  })
  const accepted = await api.commitInvite(f.group, bundle.publicPackage, repaired.invite)
  expect(accepted.newGroup.findMemberLeafIndex(identity.id)).toBeDefined()
  const recorded = recordedLogOf(accepted.newGroup.registry, f.did)
  if (recorded == null) throw new Error('Missing log')
  const folded = foldControllerLog(f.did, recorded)
  expect(folded.ok && folded.applied.length).toBe(0)
  await expect(
    verifyLeafCredential(makeMLSCredential(identity, binding), identity.publicKey, {
      judging: () => ({ registry: registryForLog(f.did, recorded), stage: 'full', mode: 'admit' }),
    }),
  ).resolves.toBeUndefined()
})
