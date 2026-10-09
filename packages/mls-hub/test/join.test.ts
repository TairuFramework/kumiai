import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeKeyPackage,
  encodeClientState,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type GroupHandle,
  type Invite,
  keyPackageRef,
  ledgerEntryDigest,
  welcomeKeyPackageRefs,
} from '@kumiai/mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { judgeWelcomeAdmission } from '../src/admission.js'
import { openWelcome } from '../src/join.js'
import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore } from '../src/pool-store.js'
import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub, type TestHub } from './fixtures/hub.js'

let hub: TestHub

beforeEach(() => {
  hub = createTestHub()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await hub.dispose()
})

/** A base64 ref may contain `+`, `/`, `=` — all regex metacharacters. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type InviteAndCommit = {
  welcome: Uint8Array
  invite: Invite
  ratchetTree: unknown
}

/**
 * Create a group as a fresh inviter, invite `recipientDID`, and commit the invite with
 * `keyPackage` (the framed key-package bytes an inviter would have fetched from the hub).
 */
async function inviteWith(
  recipientDID: string,
  keyPackage: string,
  groupID = `group:join-test-${recipientDID}`,
): Promise<InviteAndCommit> {
  const inviter = randomIdentity()
  const publicPackage = decodeKeyPackage(keyPackage)
  if (publicPackage == null) throw new Error('test setup: fetched key package did not decode')

  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })

  const { group } = await createGroup(inviter, groupID, {
    resolveLedgerEntries,
  })
  const { invite } = await createInvite({
    group,
    identity: inviter,
    recipientDID,
    permission: 'member',
  })
  for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)

  const added = await commitInvite(group, publicPackage, invite)
  return {
    welcome: added.welcomeMessage,
    invite,
    ratchetTree: added.newGroup.state.ratchetTree,
  }
}

/** An inviter fetches an ordinary package for `hub.identity` from the hub's own store, as a real
 *  inviter would through the fetch endpoint, and commits an invite with it. */
async function inviteFromPool(): Promise<InviteAndCommit & { usedRef: string }> {
  const [keyPackage] = await hub.hubStore.fetchKeyPackages({ ownerDID: hub.identity.id, count: 1 })
  if (keyPackage == null) throw new Error('test setup: the pool has nothing to fetch')
  const publicPackage = decodeKeyPackage(keyPackage)
  if (publicPackage == null) throw new Error('test setup: fetched key package did not decode')
  const usedRef = await keyPackageRef(publicPackage)

  const { welcome, invite, ratchetTree } = await inviteWith(hub.identity.id, keyPackage)
  return { welcome, invite, ratchetTree, usedRef }
}

/** Same, but from the hub's last-resort slot, which a fetch does not consume. */
async function inviteFromLastResortSlot(): Promise<InviteAndCommit> {
  const keyPackage = await hub.hubStore.fetchLastResortKeyPackage({ ownerDID: hub.identity.id })
  if (keyPackage == null) throw new Error('test setup: the last-resort slot is empty')
  return await inviteWith(hub.identity.id, keyPackage)
}

/** An invite for someone else entirely, so none of `hub.identity`'s retained bundles match it. */
async function inviteAStranger(): Promise<InviteAndCommit> {
  const stranger = randomIdentity()
  const bundle = await createKeyPackageBundle(stranger)
  return await inviteWith(stranger.id, encodeKeyPackage(bundle.publicPackage))
}

describe('openWelcome', () => {
  test('a saved join remains consumable after the expired package is pruned', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const bundle = await createKeyPackageBundle(hub.identity)
    const ref = await keyPackageRef(bundle.publicPackage)
    const keyPackage = encodeKeyPackage(bundle.publicPackage)
    const notAfter = Number(bundle.publicPackage.leafNode.lifetime.notAfter)
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref,
      keyPackage,
      privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
      notAfter,
    })
    const poolParams = {
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
      retainAfterExpiryDays: 0,
    }
    const pool = createKeyPackagePool(poolParams)
    const welcome = await inviteWith(hub.identity.id, keyPackage)
    // A delayed Welcome can authenticate after its package's invitation lifetime ends.
    vi.spyOn(Date, 'now').mockReturnValue((notAfter + 1) * 1000)
    const result = await openWelcome([pool], { identity: hub.identity, ...welcome })
    if (!('joined' in result)) throw new Error('Expected a new join')
    const saved = {
      state: encodeClientState(result.joined.group.state),
      groupID: result.joined.group.groupID,
      joinRef: result.joinRef,
    }
    await pool.ensureStocked().value
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).not.toContain(ref)
    expect(await pool.receipt(ref)).toBeNull()

    // Recreate the helper: consumption cannot depend on an in-process open reservation.
    const restarted = createKeyPackagePool(poolParams)
    await expect(restarted.consume(saved.joinRef.ref, saved.groupID)).resolves.toBeUndefined()
    expect(await restarted.receipt(ref)).toEqual({ groupID: saved.groupID })
    await expect(restarted.consume(saved.joinRef.ref, saved.groupID)).resolves.toBeUndefined()
    await expect(restarted.consume(ref, 'group:other')).rejects.toThrow('another group')
    await expect(openWelcome([restarted], { identity: hub.identity, ...welcome })).resolves.toEqual(
      {
        alreadyJoined: saved.groupID,
      },
    )
  })

  test('two groups can open one ordinary package before host-owned consumption', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked().value
    const [record] = await store.list(hub.identity.id)
    if (record == null) throw new Error('Expected an ordinary package')
    const welcomeA = await inviteWith(hub.identity.id, record.keyPackage, 'group:reuse-a')
    const welcomeB = await inviteWith(hub.identity.id, record.keyPackage, 'group:reuse-b')
    const a = await openWelcome([pool], { identity: hub.identity, ...welcomeA })
    const b = await openWelcome([pool], { identity: hub.identity, ...welcomeB })
    if (!('joined' in a) || !('joined' in b)) throw new Error('Expected two authenticated joins')
    expect(a.joined.group.groupID).toBe('group:reuse-a')
    expect(b.joined.group.groupID).toBe('group:reuse-b')
    expect(a.joinRef).toEqual(b.joinRef)
    expect(await pool.receipt(record.ref)).toBeNull()
    const saved = [a, b].map((opened) => ({
      state: encodeClientState(opened.joined.group.state),
      groupID: opened.joined.group.groupID,
      joinRef: opened.joinRef,
    }))
    await pool.consume(a.joinRef.ref, a.joined.group.groupID)
    await expect(pool.consume(b.joinRef.ref, b.joined.group.groupID)).rejects.toThrow(
      'another group',
    )
    expect(saved.map((entry) => entry.groupID)).toEqual(['group:reuse-a', 'group:reuse-b'])
    await expect(openWelcome([pool], { identity: hub.identity, ...welcomeB })).resolves.toEqual({
      alreadyJoined: 'group:reuse-a',
    })
  })

  test('opens without consuming, then the host saves before consume', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store,
      target: 2,
      lowWater: 2,
    })
    await pool.ensureStocked().value
    const { welcome, invite, ratchetTree, usedRef } = await inviteFromPool()
    const result = await openWelcome([pool], {
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
    })
    if (!('joined' in result)) throw new Error('Expected a new join')
    expect(result.joined.group.groupID).toBe(invite.groupID)
    expect(result.joinRef).toEqual({ sourceID: 'ordinary', ref: usedRef })
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).toContain(usedRef)
    expect(await pool.receipt(usedRef)).toBeNull()

    const saved = new Map<string, { group: GroupHandle; joinRef: typeof result.joinRef }>()
    saved.set(result.joined.group.groupID, { group: result.joined.group, joinRef: result.joinRef })
    await pool.consume(result.joinRef.ref, result.joined.group.groupID)
    expect(saved.get(invite.groupID)?.joinRef).toEqual(result.joinRef)
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).not.toContain(usedRef)
    expect(await pool.receipt(usedRef)).toEqual({ groupID: invite.groupID })
    await expect(
      openWelcome([pool], { identity: hub.identity, invite, welcome, ratchetTree }),
    ).resolves.toEqual({ alreadyJoined: invite.groupID })
  })

  test('a failed host save leaves a Welcome retryable', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked().value
    const welcome = await inviteFromPool()
    const result = await openWelcome([pool], { identity: hub.identity, ...welcome })
    if (!('joined' in result)) throw new Error('Expected a new join')
    const save = async () => {
      throw new Error('host save failed')
    }
    await expect(save()).rejects.toThrow('host save failed')
    expect(await pool.receipt(result.joinRef.ref)).toBeNull()
    const retry = await openWelcome([pool], { identity: hub.identity, ...welcome })
    expect('joined' in retry && retry.joined.group.groupID).toBe(result.joined.group.groupID)
  })

  test('a consume failure propagates after the group is saved', async () => {
    const inner = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store: {
        ...inner,
        consume: async () => {
          throw new Error('store offline')
        },
      },
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked().value
    const welcome = await inviteFromPool()
    const result = await openWelcome([pool], { identity: hub.identity, ...welcome })
    if (!('joined' in result)) throw new Error('Expected a new join')
    const saved = { group: result.joined.group, joinRef: result.joinRef }
    await expect(pool.consume(saved.joinRef.ref, saved.group.groupID)).rejects.toThrow(
      'store offline',
    )
    expect(saved.group.groupID).toBe(welcome.invite.groupID)
    expect(await pool.receipt(saved.joinRef.ref)).toBeNull()
    expect(await inner.list(hub.identity.id)).toHaveLength(1)
  })

  test('scans past an unmatched source before opening the last-resort Welcome', async () => {
    const poolStore = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store: poolStore,
      target: 2,
      lowWater: 2,
    })
    await pool.ensureStocked().value
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      sourceID: 'fallback',
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const { ref } = await provisioner.ensureProvisioned().value
    const before = await poolStore.list(hub.identity.id)
    const welcome = await inviteFromLastResortSlot()
    const result = await openWelcome([pool, provisioner], { identity: hub.identity, ...welcome })
    if (!('joined' in result)) throw new Error('Expected a new join')
    expect(result.joinRef).toEqual({ sourceID: 'fallback', ref })
    expect(result.joined.group.groupID).toBe(welcome.invite.groupID)
    await provisioner.consume(ref, result.joined.group.groupID)
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).toContain(ref)
    expect(await poolStore.list(hub.identity.id)).toEqual(before)
  })

  test('last-resort repeats reopen for admission after consume', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      sourceID: 'fallback',
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const { ref } = await provisioner.ensureProvisioned().value
    const welcome = await inviteFromLastResortSlot()
    const first = await openWelcome([provisioner], { identity: hub.identity, ...welcome })
    if (!('joined' in first)) throw new Error('Expected a new join')
    await provisioner.consume(ref, first.joined.group.groupID)
    const repeated = await openWelcome([provisioner], { identity: hub.identity, ...welcome })
    if (!('joined' in repeated)) throw new Error('Expected a repeat to reach admission')
    expect(
      judgeWelcomeAdmission(
        { epoch: Number(first.joined.group.epoch), deleted: false },
        Number(repeated.joined.group.epoch),
      ),
    ).toBe('alreadyJoined')
    const later = await inviteFromLastResortSlot()
    const reopened = await openWelcome([provisioner], { identity: hub.identity, ...later })
    if (!('joined' in reopened)) throw new Error('Expected another Welcome to open')
    expect(reopened.joined.group.groupID).toBe(later.invite.groupID)
    expect(await provisioner.receipt(ref)).toBeNull()
  })

  test('a corrupt pool does not block an independent fallback', async () => {
    const poolStore = createMemoryKeyPackagePoolStore()
    await poolStore.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'corrupt',
      keyPackage: 'bad',
      privatePackage: 'bad',
      notAfter: 100,
    })
    const pool = createKeyPackagePool({
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store: poolStore,
    })
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      sourceID: 'fallback',
      identity: hub.identity,
      client: hub.client,
      store,
    })
    await provisioner.ensureProvisioned().value
    const welcome = await inviteFromLastResortSlot()
    const result = await openWelcome([pool, provisioner], { identity: hub.identity, ...welcome })
    if (!('joined' in result)) throw new Error('Expected a new join')
    expect(result.joined.sourceErrors).toHaveLength(1)
    expect(result.joined.sourceErrors?.[0]?.message).toMatch(/did not decode/)
    expect(result.joined.group.groupID).toBe(welcome.invite.groupID)
  })

  test('names sought refs and unreadable sources when nothing matches', async () => {
    const store = createMemoryKeyPackagePoolStore()
    await store.put(hub.identity.id, {
      kind: 'ordinary',
      ref: 'corrupt',
      keyPackage: 'bad',
      privatePackage: 'bad',
      notAfter: 100,
    })
    const pool = createKeyPackagePool({
      sourceID: 'ordinary',
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const welcome = await inviteAStranger()
    const [sought] = welcomeKeyPackageRefs(welcome.welcome)
    if (sought == null) throw new Error('Welcome names no refs')
    await expect(openWelcome([pool], { identity: hub.identity, ...welcome })).rejects.toThrow(
      new RegExp(
        `no retained key package matches.*${escapeRegExp(sought)}.*source\\(s\\) could not be read.*did not decode`,
      ),
    )
  })
})
