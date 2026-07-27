import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeKeyPackage,
  encodeKeyPackage,
  type Invite,
  keyPackageRef,
  ledgerEntryDigest,
  welcomeKeyPackageRefs,
} from '@kumiai/mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { processWelcomeFromSources } from '../src/join.js'
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
async function inviteWith(recipientDID: string, keyPackage: string): Promise<InviteAndCommit> {
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

  const { group } = await createGroup(inviter, `group:join-test-${recipientDID}`, {
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
  const [keyPackage] = await hub.hubStore.fetchKeyPackages(hub.identity.id, 1)
  if (keyPackage == null) throw new Error('test setup: the pool has nothing to fetch')
  const publicPackage = decodeKeyPackage(keyPackage)
  if (publicPackage == null) throw new Error('test setup: fetched key package did not decode')
  const usedRef = await keyPackageRef(publicPackage)

  const { welcome, invite, ratchetTree } = await inviteWith(hub.identity.id, keyPackage)
  return { welcome, invite, ratchetTree, usedRef }
}

/** Same, but from the hub's last-resort slot, which a fetch does not consume. */
async function inviteFromLastResortSlot(): Promise<InviteAndCommit> {
  const keyPackage = await hub.hubStore.fetchLastResortKeyPackage(hub.identity.id)
  if (keyPackage == null) throw new Error('test setup: the last-resort slot is empty')
  return await inviteWith(hub.identity.id, keyPackage)
}

/** An invite for someone else entirely, so none of `hub.identity`'s retained bundles match it. */
async function inviteAStranger(): Promise<InviteAndCommit> {
  const stranger = randomIdentity()
  const bundle = await createKeyPackageBundle(stranger)
  return await inviteWith(stranger.id, encodeKeyPackage(bundle.publicPackage))
}

describe('processWelcomeFromSources', () => {
  test('joins with the ordinary bundle the Welcome names, and releases it', async () => {
    const store = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 2,
      lowWater: 2,
    })
    await pool.ensureStocked()
    const { welcome, invite, ratchetTree, usedRef } = await inviteFromPool()

    const result = await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [pool],
    })

    expect(result.group).toBeDefined()
    expect(result.releaseError).toBeUndefined()
    // A single-use private half is gone once its Welcome is processed. That deletion is the whole
    // forward-secrecy point of replenishing the pool at all.
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).not.toContain(usedRef)
  })

  test('retains a last-resort bundle after its Welcome', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const { ref } = await provisioner.ensureProvisioned()
    const { welcome, invite, ratchetTree } = await inviteFromLastResortSlot()

    await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [provisioner],
    })

    // Deleting it would make the owner silently unaddable forever — the outage the slot exists to
    // prevent.
    expect((await store.list(hub.identity.id)).map((entry) => entry.ref)).toContain(ref)
  })

  test('throws naming the refs sought when nothing matches', async () => {
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store: createMemoryKeyPackagePoolStore(),
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked()
    const { welcome, invite, ratchetTree } = await inviteAStranger()

    // Trying every bundle until one decrypts would turn "wrong Welcome" into a crypto error with no
    // diagnosis; naming the refs says which package the sender expected. Pinning only the fixed
    // wording would let the interpolated refs silently be dropped from the message, so this also
    // requires the Welcome's own sought ref to actually appear in it.
    const [sought] = welcomeKeyPackageRefs(welcome)
    if (sought == null) throw new Error('test setup: the Welcome names no refs')

    await expect(
      processWelcomeFromSources({
        identity: hub.identity,
        invite,
        welcome,
        ratchetTree,
        sources: [pool],
      }),
    ).rejects.toThrow(new RegExp(`no retained key package matches.*${escapeRegExp(sought)}`))
  })

  test('a failed release surfaces on the result rather than failing the join', async () => {
    const inner = createMemoryKeyPackagePoolStore()
    const store = {
      ...inner,
      delete: vi.fn(async () => {
        throw new Error('store offline')
      }),
    }
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked()
    const { welcome, invite, ratchetTree } = await inviteFromPool()

    const result = await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [pool],
    })

    // The join succeeded and the caller must get their group; the undeleted private half is a real
    // problem they still need told about, so it rides a separate channel.
    expect(result.group).toBeDefined()
    expect(result.releaseError?.message).toMatch(/store offline/)
  })

  test('a release rejecting with a non-Error value is still wrapped as an Error', async () => {
    const inner = createMemoryKeyPackagePoolStore()
    const store = {
      ...inner,
      // A store implementation is free to reject with anything; the wrapper must not assume Error.
      delete: vi.fn(async () => {
        throw 'store offline: not an Error instance'
      }),
    }
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store,
      target: 1,
      lowWater: 1,
    })
    await pool.ensureStocked()
    const { welcome, invite, ratchetTree } = await inviteFromPool()

    const result = await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [pool],
    })

    expect(result.group).toBeDefined()
    expect(result.releaseError).toBeInstanceOf(Error)
    expect(result.releaseError?.message).toMatch(/store offline: not an Error instance/)
  })

  test('scans past a source that does not match before checking one that does', async () => {
    const poolStore = createMemoryKeyPackagePoolStore()
    const pool = createKeyPackagePool({
      identity: hub.identity,
      client: hub.client,
      store: poolStore,
      target: 2,
      lowWater: 2,
    })
    await pool.ensureStocked()
    const lastResortStore = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store: lastResortStore,
    })
    const { ref } = await provisioner.ensureProvisioned()
    const poolRefsBefore = (await poolStore.list(hub.identity.id)).map((entry) => entry.ref)

    // The Welcome names the PROVISIONER's bundle, not any of the pool's. A `[x].slice(0, 1)`-style
    // regression that only ever checks the first source would report no match here.
    const { welcome, invite, ratchetTree } = await inviteFromLastResortSlot()

    const result = await processWelcomeFromSources({
      identity: hub.identity,
      invite,
      welcome,
      ratchetTree,
      sources: [pool, provisioner],
    })

    expect(result.group).toBeDefined()
    expect(result.releaseError).toBeUndefined()
    // Retained: the match came from the provisioner, whose release is a no-op.
    expect((await lastResortStore.list(hub.identity.id)).map((entry) => entry.ref)).toContain(ref)
    // Untouched: the pool was scanned (and skipped) but nothing in it matched, so nothing released.
    expect((await poolStore.list(hub.identity.id)).map((entry) => entry.ref)).toEqual(
      poolRefsBefore,
    )
  })
})
