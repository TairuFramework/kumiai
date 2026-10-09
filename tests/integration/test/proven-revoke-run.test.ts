import type { OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  type GroupHandle,
  processWelcome,
  restoreGroup,
} from '@kumiai/mls'
import * as adapter from '@kumiai/mls-rpc'
import { createLedgerEntrySlot } from '@kumiai/mls-rpc'
import { type AdoptionWrite, commitTopic, PeerDisposedError } from '@kumiai/rpc'
import { testControlStoreConformance } from '@kumiai/rpc-conformance'
import { afterEach, expect, test, vi } from 'vitest'

import { encodeJournal, type Member, makeMember } from './app-lane-e2e.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './host-db.js'
import { createWireHub } from './log-hub-over-wire.js'

const fixture = (await import(
  new URL('../../../packages/mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
)) as {
  agent(byte: number): OwnIdentity
  inception: ControllerBinding['prefix'][number]
  timedBinding(params: {
    identity: OwnIdentity
    iat: number
    exp: number
  }): Promise<ControllerBinding>
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
      controller: await fixture.timedBinding({ identity: identity, iat: 100, exp: 200 }),
      resolveLedgerEntries: entrySlot.resolve,
    })
  ).group
  const subjectBundle = await createKeyPackageBundle(subjectIdentity, {
    controller: await fixture.timedBinding({ identity: subjectIdentity, iat: 100, exp: 200 }),
  })
  const subjectInvite = await createInvite({ group, identity, recipientDID: subject })
  group = (await commitInvite(group, subjectBundle.publicPackage, subjectInvite.invite)).newGroup
  const carol = fixture.agent(81)
  const bundle = await createKeyPackageBundle(carol, {
    controller: await fixture.timedBinding({ identity: carol, iat: 100, exp: 200 }),
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
    const result = await adapter.publishRevokeProof({
      peer: s.member.peer,
      mls: s.mls,
      input: { subject: s.subject, log: s.log },
    })
    expect(result).toEqual({ status: 'committed', epoch: epoch + 1 })
    expect(s.member.handle().registry.devices.get(s.subject)?.status).toBe('revoked')
    expect(s.member.handle().findMemberLeafIndex(s.subject)).toBeUndefined()
    expect(
      await adapter.publishRevokeProof({
        peer: s.member.peer,
        mls: s.mls,
        input: { subject: s.subject, log: s.log },
      }),
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

test('restart restores co-committed revoke proof state before volatile adoption or anchor repair', async () => {
  const s = await setup()
  let replacement: Member | undefined
  try {
    await s.member.peer.replay()
    const before = [...s.member.handle().ledgerTokens]
    const epoch = s.member.handle().epoch
    const credential = structuredClone(s.member.handle().credential)
    let crashed = false
    s.member.stateStore.database.seam('after-save', () => {
      crashed = true
      void s.member.peer.dispose()
      throw new Error('Crash after adoption transaction')
    })
    await expect(
      adapter.publishRevokeProof({
        peer: s.member.peer,
        mls: s.mls,
        input: { subject: s.subject, log: s.log },
      }),
    ).rejects.toBeInstanceOf(PeerDisposedError)
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.member.disconnect()
    expect(crashed).toBe(true)
    expect(s.member.handle().epoch).toBe(epoch)
    expect(s.member.handle().registry.devices.get(s.subject)?.status).not.toBe('revoked')
    expect((await s.member.stateStore.database.anchorStore('state').load())?.pending).toMatchObject(
      { landed: true, epochAfter: Number(epoch + 1n) },
    )
    const saved = await s.member.stateStore.saved()
    if (saved == null) throw new Error('Missing persisted revoke state')
    const state = decodeClientState(saved.state)
    if (state == null) throw new Error('Invalid persisted revoke state')
    const entrySlot = createLedgerEntrySlot()
    const restored = await restoreGroup({
      state,
      credential,
      ledgerEntries: saved.ledger,
      options: { resolveLedgerEntries: entrySlot.resolve },
    })
    expect(restored.epoch).toBe(epoch + 1n)
    expect(restored.ledgerTokens.length).toBeGreaterThan(before.length)
    expect(restored.registry.devices.get(s.subject)?.status).toBe('revoked')
    expect(restored.findMemberLeafIndex(s.subject)).toBeUndefined()
    expect(await restored.isLedgerComplete()).toBe(true)
    const persisted = await s.member.control.load()
    expect(persisted.operations).toEqual([])
    expect(persisted.outcomes).toEqual([expect.objectContaining({ kind: 'landed' })])
    replacement = makeMember({
      hub: s.hub,
      identity: s.member.identity,
      group: restored,
      entrySlot,
      restartOf: s.member,
    })
    await replacement.peer.replay()
    expect(replacement.handle().epoch).toBe(epoch + 1n)
    expect(replacement.handle().registry.devices.get(s.subject)?.status).toBe('revoked')
    expect(await replacement.handle().isLedgerComplete()).toBe(true)
    expect((await replacement.control.load()).outcomes).toEqual(persisted.outcomes)
    expect(
      (await replacement.stateStore.database.anchorStore('state').load())?.pending,
    ).toBeUndefined()
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
    s.member.hostHooks.serializeJournal = async (candidate) => {
      derived.push(candidate)
      if (derived.length === 1) {
        await adapter.publishRevokeProof({
          peer: s.other.peer,
          mls: s.other.mls,
          input: { subject: s.subject, log: s.log },
        })
      }
      return encodeJournal(candidate)
    }

    const result = await adapter.publishRevokeProof({
      peer: s.member.peer,
      mls: s.mls,
      input: { subject: target, log: [...s.log, nextRev] },
    })
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
    s.member.hostHooks.serializeJournal = async (candidate) => {
      builds++
      await adapter.publishRevokeProof({
        peer: s.other.peer,
        mls: s.other.mls,
        input: { subject: s.subject, log: s.log },
      })
      return encodeJournal(candidate)
    }

    expect(
      await adapter.publishRevokeProof({
        peer: s.member.peer,
        mls: s.mls,
        input: { subject: s.subject, log: s.log },
      }),
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

let controlDatabase: MemoryHostDatabase
const controlHost = () => ({
  control: controlDatabase.control('state'),
  anchor: controlDatabase.anchorStore('state'),
  saveState: (state: Uint8Array, write?: AdoptionWrite) =>
    controlDatabase.saveState('state', state, write),
  loadState: () => controlDatabase.loadState('state'),
})
testControlStoreConformance({
  open: async () => {
    controlDatabase = createMemoryHostDatabase()
    return controlHost()
  },
  reopen: async () => controlHost(),
  injectFailure: (point) => controlDatabase.failNext(point),
  commitThenReject: () => controlDatabase.commitThenRejectNext('apply'),
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
    s.member.hostHooks.serializeJournal = options.serializeJournal
    const epoch = s.member.handle().epoch
    expect(
      await adapter.publishRevokeProof({
        peer: s.member.peer,
        mls: s.mls,
        input: { subject: s.subject, log: [fixture.inception] },
      }),
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
      await adapter.publishRevokeProof({
        peer: s.member.peer,
        mls: s.mls,
        input: { subject: s.member.identity.id, log: [fixture.inception, selfRev] },
      }),
    ).toEqual({ status: 'self-affected', subject: s.member.identity.id })
    expect(serializations).toBe(0)
    expect(s.member.handle().epoch).toBe(epoch)
    expect((await s.member.control.load()).operations).toEqual([])
    await expect(
      adapter.publishRevokeProof({
        peer: s.member.peer,
        mls: { ...s.mls },
        input: { subject: s.subject, log: s.log },
      }),
    ).rejects.toThrow('adapter-created GroupMLS')
  } finally {
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})

test('a serializer failure keeps the caller waiting until the same operation retries', async () => {
  const s = await setup()
  try {
    const epoch = s.member.handle().epoch
    let failures = 0
    s.member.hostHooks.serializeJournal = () => {
      failures++
      throw new Error('cannot persist journal')
    }
    let settled = false
    const publishing = adapter
      .publishRevokeProof({
        peer: s.member.peer,
        mls: s.mls,
        input: { subject: s.subject, log: s.log },
      })
      .finally(() => {
        settled = true
      })
    void publishing.catch(() => {})
    await expect.poll(() => failures).toBeGreaterThan(0)
    expect(settled).toBe(false)
    expect((await s.member.control.load()).operations[0]?.stage).toBe('intent')
    expect(s.member.handle().epoch).toBe(epoch)
    s.member.hostHooks.serializeJournal = encodeJournal
    await s.member.peer.replay()
    await publishing
    await expect.poll(() => s.member.handle().epoch).toBe(epoch + 1n)
    expect((await s.member.control.load()).outcomes).toContainEqual(
      expect.objectContaining({ kind: 'landed' }),
    )
  } finally {
    await s.member.peer.dispose()
    await s.member.peer.drained()
    await s.other.peer.dispose()
    await s.other.peer.drained()
    await s.hub.dispose()
  }
})
