import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createLastResortKeyPackageBundle,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type Invite,
  keyPackageRef,
  ledgerEntryDigest,
  processWelcome,
} from '@kumiai/mls'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { createLastResortProvisioner } from '../src/provisioner.js'
import { createMemoryLastResortStore } from '../src/store.js'
import { createTestHub, type TestHub } from './fixtures/hub.js'

/** The ledger-entry plumbing every kumiai join needs, shared by the tests below. */
function createLedger() {
  const tokens = new Map<string, string>()
  return {
    publish: (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    },
    resolveLedgerEntries: async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      }),
  }
}

let hub: TestHub

beforeEach(() => {
  hub = createTestHub()
})

afterEach(async () => {
  await hub.dispose()
})

describe('bundles', () => {
  test('returns the retained bundles newest first', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    const first = await provisioner.ensureProvisioned()
    const original = (await store.list(hub.identity.id))[0]
    expect(original).toBeDefined()
    if (original == null) return
    await store.put(hub.identity.id, {
      ...original,
      notAfter: Math.floor(Date.now() / 1000) + 10 * 86_400,
    })
    const second = await provisioner.ensureProvisioned()

    const bundles = await provisioner.bundles()
    expect(bundles).toHaveLength(2)
    expect(bundles.map((b) => b.ownerDID)).toEqual([hub.identity.id, hub.identity.id])

    expect(await Promise.all(bundles.map((b) => keyPackageRef(b.publicPackage)))).toEqual([
      second.ref, // the rotation's package leads
      first.ref, // the retired one follows
    ])
  })

  /**
   * The tie-break half of the same comparator: two records sharing a `notAfter` must still resolve
   * to one order, and it must be the SAME order `pickCandidate` uses to decide which record wins the
   * hub's slot — otherwise `bundles()[0]` and "the package the hub is currently serving" could
   * silently disagree. The expected leader is derived from a plain array sort over the two refs
   * (an independent comparison from the hand-written ternaries in both `provisioner.ts` call
   * sites), not asserted by construction.
   */
  test('a notAfter tie breaks on ref, agreeing with which record holds the slot', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const first = (await store.list(hub.identity.id))[0]
    expect(first).toBeDefined()
    if (first == null) return

    // A second, genuinely distinct last-resort bundle, forced to share `first`'s `notAfter` exactly
    // so the ref tie-break — not the notAfter ordering — is what decides.
    const secondBundle = await createLastResortKeyPackageBundle(hub.identity)
    const secondRecord = {
      ref: await keyPackageRef(secondBundle.publicPackage),
      keyPackage: encodeKeyPackage(secondBundle.publicPackage),
      privatePackage: encodePrivateKeyPackage(secondBundle.privatePackage),
      notAfter: first.notAfter,
      uploadedAt: Date.now(),
    }
    await store.put(hub.identity.id, secondRecord)

    const bundles = await provisioner.bundles()
    expect(bundles).toHaveLength(2)
    const [leader] = bundles
    expect(leader).toBeDefined()
    if (leader == null) return
    const leaderRef = await keyPackageRef(leader.publicPackage)
    const expectedLeader = [first.ref, secondRecord.ref].sort().at(-1)
    expect(leaderRef).toBe(expectedLeader)

    // The same ref must be the one `ensureProvisioned` reports as the slot's occupant — the sort in
    // `bundles()` and the tie-break in `pickCandidate` must agree, not just each be internally
    // consistent.
    const settled = await provisioner.ensureProvisioned()
    expect(settled.ref).toBe(expectedLeader)
  })

  /**
   * A store handing back bytes it did not round-trip is broken, and reporting that as "you appear to
   * have no last-resort package" would recreate exactly the silent failure this feature removes.
   */
  test('throws on a record whose private package will not decode', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const record = (await store.list(hub.identity.id))[0]
    expect(record).toBeDefined()
    if (record == null) return
    await store.put(hub.identity.id, { ...record, privatePackage: 'not base64 !!!' })

    await expect(provisioner.bundles()).rejects.toThrow(record.ref)
  })

  test('throws on a record whose public package will not decode', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })

    await provisioner.ensureProvisioned()
    const record = (await store.list(hub.identity.id))[0]
    expect(record).toBeDefined()
    if (record == null) return
    await store.put(hub.identity.id, { ...record, keyPackage: 'not base64 !!!' })

    await expect(provisioner.bundles()).rejects.toThrow(record.ref)
  })

  test('an owner with no records returns an empty array', async () => {
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store: createMemoryLastResortStore(),
    })

    expect(await provisioner.bundles()).toEqual([])
  })
})

describe('a provisioned bundle against real MLS', () => {
  /**
   * THE CENTRAL CLAIM. The bundle used here came out of the store — encoded on the way in, decoded
   * on the way out — so a lossy private-package codec fails here and nowhere else. The join is
   * carried through `processWelcome` so the invitee actually derives the epoch secrets.
   */
  test('joins a group using only what the store gave back', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    await provisioner.ensureProvisioned()

    const [bundle] = await provisioner.bundles()
    expect(bundle).toBeDefined()
    if (bundle == null) return

    const alice = randomIdentity()
    const ledger = createLedger()
    const { group } = await createGroup(alice, 'group:provisioned', {
      resolveLedgerEntries: ledger.resolveLedgerEntries,
    })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: hub.identity.id,
      permission: 'member',
    })
    ledger.publish(invite)

    const added = await commitInvite(group, bundle.publicPackage, invite)
    const { group: joined } = await processWelcome({
      identity: hub.identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries: ledger.resolveLedgerEntries },
    })

    expect(joined.findMemberLeafIndex(hub.identity.id)).not.toBeNull()
  })

  /**
   * Reusability, at this layer rather than in `@kumiai/mls`: the point of the slot is that ONE
   * package serves join after join, so a round-tripped bundle must join two independent groups with
   * two different inviters.
   */
  test('the same provisioned bundle joins two different groups', async () => {
    const store = createMemoryLastResortStore()
    const provisioner = createLastResortProvisioner({
      identity: hub.identity,
      client: hub.client,
      store,
    })
    await provisioner.ensureProvisioned()

    const [bundle] = await provisioner.bundles()
    expect(bundle).toBeDefined()
    if (bundle == null) return

    const ledger = createLedger()
    const join = async (inviter: ReturnType<typeof randomIdentity>, groupID: string) => {
      const { group } = await createGroup(inviter, groupID, {
        resolveLedgerEntries: ledger.resolveLedgerEntries,
      })
      const { invite } = await createInvite({
        group,
        identity: inviter,
        recipientDID: hub.identity.id,
        permission: 'member',
      })
      ledger.publish(invite)
      const added = await commitInvite(group, bundle.publicPackage, invite)
      const { group: joined } = await processWelcome({
        identity: hub.identity,
        invite,
        welcome: added.welcomeMessage,
        keyPackageBundle: bundle,
        ratchetTree: added.newGroup.state.ratchetTree,
        options: { resolveLedgerEntries: ledger.resolveLedgerEntries },
      })
      return joined
    }

    const joinedA = await join(randomIdentity(), 'group:provisioned-a')
    const joinedB = await join(randomIdentity(), 'group:provisioned-b')

    expect(joinedA.findMemberLeafIndex(hub.identity.id)).not.toBeNull()
    expect(joinedB.findMemberLeafIndex(hub.identity.id)).not.toBeNull()
  })
})
