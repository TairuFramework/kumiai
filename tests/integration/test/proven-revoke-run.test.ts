import type { OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
} from '@kumiai/mls'
import * as adapter from '@kumiai/mls-rpc'
import { createGroupMLS, createLedgerEntrySlot, simpleHandleAccess } from '@kumiai/mls-rpc'
import { commitTopic } from '@kumiai/rpc'
import { testCommitJournalConformance } from '@kumiai/rpc-conformance'
import { afterEach, expect, test, vi } from 'vitest'

import { createMemoryCommitJournal, encodeJournal, makeMember } from './app-lane-e2e.js'
import { createWireHub } from './log-hub-over-wire.js'

const fixture = (await import(
  new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
)) as {
  agent(byte: number): OwnIdentity
  inception: ControllerBinding['prefix'][number]
  timedBinding(identity: OwnIdentity, iat: number, exp: number): Promise<ControllerBinding>
}
const controller = (await import(
  new URL('../../../packages/mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
)) as {
  controllerSeed: Uint8Array
  controllerID: string
}
const events = (await import(
  new URL('../../../node_modules/@kokuin/controller/lib/index.js', import.meta.url).href
)) as {
  createRevoke(params: {
    seed: Uint8Array
    profile: number
    did: string
    prior: ControllerBinding['prefix'][number]['event']
    target: string
    keyPosition: { gen: number; seq: number }
  }): ControllerBinding['prefix'][number]
}

afterEach(() => vi.restoreAllMocks())

async function setup() {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  const identity = fixture.agent(41)
  const subjectIdentity = fixture.agent(61)
  const subject = subjectIdentity.id
  const entrySlot = createLedgerEntrySlot()
  let group = (
    await createGroup(identity, 'proven-revoke', {
      controller: await fixture.timedBinding(identity, 100, 200),
      resolveLedgerEntries: entrySlot.resolve,
    })
  ).group
  const subjectBundle = await createKeyPackageBundle(subjectIdentity, {
    controller: await fixture.timedBinding(subjectIdentity, 100, 200),
  })
  const subjectInvite = await createInvite({ group, identity, recipientDID: subject })
  group = (await commitInvite(group, subjectBundle.publicPackage, subjectInvite.invite)).newGroup
  const carol = fixture.agent(81)
  const bundle = await createKeyPackageBundle(carol, {
    controller: await fixture.timedBinding(carol, 100, 200),
  })
  const { invite } = await createInvite({ group, identity, recipientDID: carol.id })
  const added = await commitInvite(group, bundle.publicPackage, invite)
  group = added.newGroup
  const carolSlot = createLedgerEntrySlot()
  const joined = await processWelcome({
    identity: carol,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: group.state.ratchetTree,
    options: { resolveLedgerEntries: carolSlot.resolve },
  })
  const revoke = events.createRevoke({
    seed: controller.controllerSeed,
    profile: 0,
    did: controller.controllerID,
    prior: fixture.inception.event,
    target: subject,
    keyPosition: { gen: 0, seq: 0 },
  })
  const hub = createWireHub()
  const member = makeMember({ hub, identity, group, entrySlot })
  const other = makeMember({ hub, identity: carol, group: joined.group, entrySlot: carolSlot })
  return { hub, member, other, mls: member.mls, subject, log: [fixture.inception, revoke] }
}

test('publisher lands one proof commit and a duplicate is already revoked', async () => {
  expect(adapter).toHaveProperty('publishRevokeProof')
  const s = await setup()
  try {
    const epoch = Number(s.member.handle().epoch)
    const result = await adapter.publishRevokeProof(
      s.member.peer,
      s.mls,
      { subject: s.subject, log: s.log },
      { serializeJournal: encodeJournal },
    )
    expect(result).toEqual({ status: 'committed', epoch: epoch + 1 })
    expect(s.member.handle().registry.devices.get(s.subject)?.status).toBe('revoked')
    expect(s.member.handle().findMemberLeafIndex(s.subject)).toBeUndefined()
    expect(
      await adapter.publishRevokeProof(
        s.member.peer,
        s.mls,
        { subject: s.subject, log: s.log },
        { serializeJournal: encodeJournal },
      ),
    ).toEqual({ status: 'already-revoked' })
    expect(Number(s.member.handle().epoch)).toBe(epoch + 1)
  } finally {
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})

test('restart adopts the journalled derived state with its proof ledger entries', async () => {
  expect(adapter).toHaveProperty('publishRevokeProof')
  const s = await setup()
  let replacement: ReturnType<typeof makeMember> | undefined
  try {
    const before = [...s.member.handle().ledgerTokens]
    await s.member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'after revoke' } })
    let delivered = (): void => {}
    const delivery = new Promise<void>((resolve) => {
      delivered = resolve
    })
    const remove = s.member.appOutbox.remove
    s.member.appOutbox.remove = async (seq) => {
      await remove(seq)
      delivered()
    }
    const access = simpleHandleAccess({
      handle: s.member.handle,
      adopt: async () => {
        throw new Error('crash before adoption')
      },
    })
    const mls = createGroupMLS({
      access,
      identity: s.member.identity,
      entrySlot: s.member.entrySlot,
    })
    await expect(
      adapter.publishRevokeProof(
        s.member.peer,
        mls,
        { subject: s.subject, log: s.log },
        { serializeJournal: encodeJournal },
      ),
    ).rejects.toThrow('crash before adoption')
    expect(s.member.journal.slot()?.holdsLogSends).toBe(true)
    await s.member.peer.dispose()
    await s.member.peer.drained()
    replacement = makeMember({
      hub: s.hub,
      identity: s.member.identity,
      group: s.member.handle(),
      entrySlot: s.member.entrySlot,
      restartOf: s.member,
    })
    await replacement.peer.replay()
    expect(replacement.handle().ledgerTokens.length).toBeGreaterThan(before.length)
    expect(replacement.handle().registry.devices.get(s.subject)?.status).toBe('revoked')
    expect(await replacement.handle().isLedgerComplete()).toBe(true)
    await delivery
    expect(await replacement.appOutbox.list()).toEqual([])
  } finally {
    if (replacement != null) {
      await replacement.peer.dispose()
      await replacement.peer.drained()
    }
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})

test('a lost epoch race rebuilds and serialises the proof against the winning recorded log', async () => {
  const s = await setup()
  const target = fixture.agent(71).id
  const prior = s.log[1]
  if (prior == null) throw new Error('Missing revoke event')
  const nextRev = events.createRevoke({
    seed: controller.controllerSeed,
    profile: 0,
    did: controller.controllerID,
    prior: prior.event,
    target,
    keyPosition: { gen: 0, seq: 0 },
  })
  const derived: Array<GroupHandle> = []
  try {
    const epoch = Number(s.member.handle().epoch)
    const result = await adapter.publishRevokeProof(
      s.member.peer,
      s.mls,
      { subject: target, log: [...s.log, nextRev] },
      {
        serializeJournal: async (candidate) => {
          derived.push(candidate)
          if (derived.length === 1) {
            await adapter.publishRevokeProof(
              s.other.peer,
              s.other.mls,
              { subject: s.subject, log: s.log },
              { serializeJournal: encodeJournal },
            )
          }
          return encodeJournal(candidate)
        },
      },
    )
    expect(result).toEqual({ status: 'committed', epoch: epoch + 2 })
    expect(derived).toHaveLength(2)
    expect(derived[0]?.registry.devices.get(s.subject)?.status).not.toBe('revoked')
    expect(derived[1]?.registry.devices.get(s.subject)?.status).toBe('revoked')
    expect(derived[1]?.registry.devices.get(target)?.status).toBe('revoked')
    const topic = commitTopic(await s.mls.exportRecoverySecret())
    const frames = await s.hub
      .connect(s.member.identity)
      .fetchTopic({ topicID: topic, subscriberDID: s.member.identity.id })
    expect(frames.messages).toHaveLength(2)
  } finally {
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})

test('a winning duplicate proof returns already revoked after the race', async () => {
  const s = await setup()
  let builds = 0
  try {
    expect(
      await adapter.publishRevokeProof(
        s.member.peer,
        s.mls,
        { subject: s.subject, log: s.log },
        {
          serializeJournal: async (candidate) => {
            builds++
            await adapter.publishRevokeProof(
              s.other.peer,
              s.other.mls,
              { subject: s.subject, log: s.log },
              { serializeJournal: encodeJournal },
            )
            return encodeJournal(candidate)
          },
        },
      ),
    ).toEqual({ status: 'already-revoked' })
    expect(builds).toBe(1)
  } finally {
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})

testCommitJournalConformance({
  label: 'integration host journal',
  createJournal: createMemoryCommitJournal,
})

test('non-building outcomes do not serialize or advance', async () => {
  const s = await setup()
  let serializations = 0
  const options = {
    serializeJournal: (group: GroupHandle) => {
      serializations++
      return encodeJournal(group)
    },
  }
  try {
    const epoch = s.member.handle().epoch
    expect(
      await adapter.publishRevokeProof(
        s.member.peer,
        s.mls,
        { subject: s.subject, log: [fixture.inception] },
        options,
      ),
    ).toMatchObject({ status: 'not-provable', reason: 'no-rev' })
    const selfRev = events.createRevoke({
      seed: controller.controllerSeed,
      profile: 0,
      did: controller.controllerID,
      prior: fixture.inception.event,
      target: s.member.identity.id,
      keyPosition: { gen: 0, seq: 0 },
    })
    expect(
      await adapter.publishRevokeProof(
        s.member.peer,
        s.mls,
        { subject: s.member.identity.id, log: [fixture.inception, selfRev] },
        options,
      ),
    ).toEqual({ status: 'self-affected', subject: s.member.identity.id })
    expect(serializations).toBe(0)
    expect(s.member.handle().epoch).toBe(epoch)
    expect(s.member.journal.slot()).toBeNull()
    await expect(
      adapter.publishRevokeProof(
        s.member.peer,
        { ...s.mls },
        { subject: s.subject, log: s.log },
        options,
      ),
    ).rejects.toThrow('adapter-created GroupMLS')
  } finally {
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})

test('a serializer failure publishes nothing and the caller can rerun', async () => {
  const s = await setup()
  try {
    const epoch = s.member.handle().epoch
    await expect(
      adapter.publishRevokeProof(
        s.member.peer,
        s.mls,
        { subject: s.subject, log: s.log },
        {
          serializeJournal: () => {
            throw new Error('cannot persist journal')
          },
        },
      ),
    ).rejects.toThrow('cannot persist journal')
    expect(s.member.journal.slot()).toBeNull()
    expect(s.member.handle().epoch).toBe(epoch)
    expect(
      await adapter.publishRevokeProof(
        s.member.peer,
        s.mls,
        { subject: s.subject, log: s.log },
        { serializeJournal: encodeJournal },
      ),
    ).toEqual({ status: 'committed', epoch: Number(epoch) + 1 })
  } finally {
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})
