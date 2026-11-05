import { randomIdentity } from '@kokuin/token'
import * as mls from '@kumiai/mls'
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
import { type BundleSource, openWelcome } from '../src/join.js'
import { createKeyPackagePool } from '../src/pool.js'
import { createMemoryKeyPackagePoolStore } from '../src/pool-store.js'
import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub, type TestHub } from './fixtures/hub.js'

vi.mock('@kumiai/mls', { spy: true })

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
  test.each(['ordinary', 'last-resort'] as const)(
    'opened Welcome identifies source ref and kind: %s',
    async (kind) => {
      const source =
        kind === 'ordinary'
          ? createKeyPackagePool({
              sourceID: 'ordinary',
              identity: hub.identity,
              client: hub.client,
              store: createMemoryKeyPackagePoolStore(),
              target: 1,
              lowWater: 1,
            })
          : createLastResortProvisioner({
              sourceID: 'fallback',
              identity: hub.identity,
              client: hub.client,
              store: createMemoryLastResortStore(),
            })
      if ('ensureStocked' in source) await source.ensureStocked().value
      else await source.ensureProvisioned().value
      const [bundle] = await source.bundles()
      if (bundle == null) throw new Error('Missing retained bundle')
      const ref = await keyPackageRef(bundle.publicPackage)
      const welcome = await inviteWith(hub.identity.id, encodeKeyPackage(bundle.publicPackage))
      const consume = vi.spyOn(source, 'consume')
      const receipt = vi.spyOn(source, 'receipt')
      const decrypt = vi.mocked(mls.processWelcome)
      decrypt.mockClear()

      const result = await openWelcome([source], { identity: hub.identity, ...welcome })

      expect(result).toHaveProperty('packageUse', {
        sourceID: kind === 'ordinary' ? 'ordinary' : 'fallback',
        ref,
        kind,
      })
      if (!('joined' in result)) throw new Error('Expected a verified Welcome')
      expect(Object.keys(result).sort()).toEqual(['joined', 'packageUse'])
      expect(result.joined.group.groupID).toBe(welcome.invite.groupID)
      expect(result.joined.group.epoch).toBe(1n)
      expect(result.joined.credential.id).toBe(hub.identity.id)
      expect(decrypt).toHaveBeenCalledTimes(1)
      expect(consume).not.toHaveBeenCalled()
      expect(receipt).toHaveBeenCalledTimes(kind === 'ordinary' ? 1 : 0)
    },
  )

  test('last resort remains reusable without receipt admission', async () => {
    const source = createLastResortProvisioner({
      sourceID: 'fallback',
      identity: hub.identity,
      client: hub.client,
      store: createMemoryLastResortStore(),
    })
    const { ref } = await source.ensureProvisioned().value
    const welcome = await inviteFromLastResortSlot()
    const receipt = vi.spyOn(source, 'receipt').mockResolvedValue({ groupID: 'unrelated' })
    const consume = vi.spyOn(source, 'consume')
    const decrypt = vi.mocked(mls.processWelcome)
    decrypt.mockClear()

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await openWelcome([source], { identity: hub.identity, ...welcome })
      expect(result).toHaveProperty('packageUse', {
        sourceID: 'fallback',
        ref,
        kind: 'last-resort',
      })
      if (!('joined' in result)) throw new Error('Expected a reusable Welcome to open')
      expect(result.joined.group.groupID).toBe(welcome.invite.groupID)
    }
    expect(decrypt).toHaveBeenCalledTimes(2)
    expect(receipt).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
  })

  test.each([
    { name: 'empty ID', descriptors: [{ sourceID: '', kind: 'ordinary' }], error: /sourceID/ },
    {
      name: 'duplicate IDs',
      descriptors: [
        { sourceID: 'same', kind: 'ordinary' },
        { sourceID: 'same', kind: 'last-resort' },
      ],
      error: /sourceID/,
    },
    {
      name: 'unknown kind',
      descriptors: [
        { sourceID: 'valid', kind: 'ordinary' },
        { sourceID: 'invalid', kind: 'unknown' },
      ],
      error: /kind/,
    },
    { name: 'missing kind', descriptors: [{ sourceID: 'invalid' }], error: /kind/ },
  ])(
    'invalid source descriptors refuse before callbacks: $name',
    async ({ descriptors, error }) => {
      const sources = descriptors.map((descriptor) => ({
        ...descriptor,
        bundles: vi.fn(async () => []),
        consume: vi.fn(async () => {}),
        receipt: vi.fn(async () => null),
      }))
      const welcome = await inviteAStranger()
      const decrypt = vi.mocked(mls.processWelcome)
      decrypt.mockClear()

      await expect(
        openWelcome(sources as Array<BundleSource>, {
          identity: hub.identity,
          ...welcome,
        }),
      ).rejects.toThrow(error)
      for (const source of sources) {
        expect(source.bundles).not.toHaveBeenCalled()
        expect(source.consume).not.toHaveBeenCalled()
        expect(source.receipt).not.toHaveBeenCalled()
      }
      expect(decrypt).not.toHaveBeenCalled()
    },
  )

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
      packageUse: result.packageUse,
    }
    await pool.ensureStocked().value
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).not.toContain(ref)
    expect(await pool.receipt(ref)).toBeNull()

    // Recreate the helper: consumption cannot depend on an in-process open reservation.
    const restarted = createKeyPackagePool(poolParams)
    await expect(restarted.consume(saved.packageUse.ref, saved.groupID)).resolves.toBeUndefined()
    expect(await restarted.receipt(ref)).toEqual({ groupID: saved.groupID })
    await expect(restarted.consume(saved.packageUse.ref, saved.groupID)).resolves.toBeUndefined()
    await expect(restarted.consume(ref, 'group:other')).rejects.toThrow('another group')
    await expect(openWelcome([restarted], { identity: hub.identity, ...welcome })).resolves.toEqual(
      {
        refused: 'package-consumed',
        packageUse: { sourceID: 'ordinary', ref, kind: 'ordinary' },
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
    expect(a.packageUse).toEqual(b.packageUse)
    expect(await pool.receipt(record.ref)).toBeNull()
    const saved = [a, b].map((opened) => ({
      state: encodeClientState(opened.joined.group.state),
      groupID: opened.joined.group.groupID,
      packageUse: opened.packageUse,
    }))
    await pool.consume(a.packageUse.ref, a.joined.group.groupID)
    await expect(pool.consume(b.packageUse.ref, b.joined.group.groupID)).rejects.toThrow(
      'another group',
    )
    expect(saved.map((entry) => entry.groupID)).toEqual(['group:reuse-a', 'group:reuse-b'])
    await expect(openWelcome([pool], { identity: hub.identity, ...welcomeB })).resolves.toEqual({
      refused: 'package-consumed',
      packageUse: { sourceID: 'ordinary', ref: record.ref, kind: 'ordinary' },
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
    expect(result.packageUse).toEqual({ sourceID: 'ordinary', ref: usedRef, kind: 'ordinary' })
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).toContain(usedRef)
    expect(await pool.receipt(usedRef)).toBeNull()

    const saved = new Map<string, { group: GroupHandle; packageUse: typeof result.packageUse }>()
    saved.set(result.joined.group.groupID, {
      group: result.joined.group,
      packageUse: result.packageUse,
    })
    await pool.consume(result.packageUse.ref, result.joined.group.groupID)
    expect(saved.get(invite.groupID)?.packageUse).toEqual(result.packageUse)
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).not.toContain(usedRef)
    expect(await pool.receipt(usedRef)).toEqual({ groupID: invite.groupID })
    await expect(
      openWelcome([pool], { identity: hub.identity, invite, welcome, ratchetTree }),
    ).resolves.toEqual({
      refused: 'package-consumed',
      packageUse: { sourceID: 'ordinary', ref: usedRef, kind: 'ordinary' },
    })
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
    expect(await pool.receipt(result.packageUse.ref)).toBeNull()
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
    const saved = { group: result.joined.group, packageUse: result.packageUse }
    await expect(pool.consume(saved.packageUse.ref, saved.group.groupID)).rejects.toThrow(
      'store offline',
    )
    expect(saved.group.groupID).toBe(welcome.invite.groupID)
    expect(await pool.receipt(saved.packageUse.ref)).toBeNull()
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
    expect(result.packageUse).toEqual({ sourceID: 'fallback', ref, kind: 'last-resort' })
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
      judgeWelcomeAdmission({
        held: {
          incarnation: 1,
          epoch: Number(first.joined.group.epoch),
          deleted: false,
          forkHalted: false,
        },
        spentEpochAuthenticators: [first.joined.group.state.keySchedule.epochAuthenticator.slice()],
        welcome: {
          epoch: Number(repeated.joined.group.epoch),
          epochAuthenticator: repeated.joined.group.state.keySchedule.epochAuthenticator,
        },
      }),
    ).toBe('refused')
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
