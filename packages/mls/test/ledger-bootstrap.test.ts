import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import {
  CommitRejectedError,
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  exportGroupInfo,
  type GroupHandle,
  joinGroupExternal,
  processWelcome,
  restoreGroup,
} from '../src/group.js'
import { computeHead, genesisHead, LedgerIncompleteError, readLedgerHead } from '../src/head.js'
import { ledgerEntryDigest, signLedgerEntry, verifyLedgerEntry } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Fixture = {
  /** Record an invite's entries so every peer can resolve their bodies. */
  publish: (invite: Invite) => void
  /** Record a standalone entry token (a promotion, a demotion). */
  record: (token: string) => void
  resolveLedgerEntries: (ids: Array<string>) => Promise<Array<string>>
}

function createFixture(): Fixture {
  const tokens = new Map<string, string>()
  return {
    publish: (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    },
    record: (token: string) => {
      tokens.set(ledgerEntryDigest(token), token)
    },
    resolveLedgerEntries: async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      }),
  }
}

/**
 * Admin invites `invitee`, commits the add, and hands the commit to every
 * `others` handle so the whole group stays at one epoch. Returns the admin's
 * post-commit handle and the invitee's fresh one.
 */
async function inviteMember(
  fixture: Fixture,
  admin: GroupHandle,
  adminIdentity: OwnIdentity,
  invitee: OwnIdentity,
  others: Array<GroupHandle> = [],
): Promise<{ admin: GroupHandle; group: GroupHandle }> {
  const { invite } = await createInvite({
    group: admin,
    identity: adminIdentity,
    recipientDID: invitee.id,
    permission: 'member',
  })
  fixture.publish(invite)
  const bundle = await createKeyPackageBundle(invitee)
  const commit = await commitInvite(admin, bundle.publicPackage, invite)
  for (const other of others) {
    await other.processMessage(commit.commitMessage)
  }
  const { group } = await processWelcome({
    identity: invitee,
    invite,
    welcome: commit.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: commit.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries: fixture.resolveLedgerEntries },
  })
  return { admin: commit.newGroup, group }
}

/** An admin writes one role entry and commits it; every `others` handle applies it. */
async function commitRole(
  fixture: Fixture,
  admin: GroupHandle,
  adminIdentity: OwnIdentity,
  subject: OwnIdentity,
  value: 'admin' | 'member',
  others: Array<GroupHandle> = [],
): Promise<{ admin: GroupHandle; token: string }> {
  const token = await signLedgerEntry(adminIdentity, {
    type: 'kumiai.role',
    groupID: admin.groupID,
    subject: subject.id,
    value,
  })
  fixture.record(token)
  const commit = await commitLedgerEntries(admin, [token])
  for (const other of others) {
    await other.processMessage(commit.commitMessage)
  }
  return { admin: commit.newGroup, token }
}

/** Rejoin by external commit: the state a bootstrapping peer is in — a live MLS
 *  state and an EMPTY ledger. The live members apply the rejoin commit. */
async function rejoin(
  fixture: Fixture,
  identity: OwnIdentity,
  stale: GroupHandle,
  live: GroupHandle,
  others: Array<GroupHandle> = [],
): Promise<GroupHandle> {
  const { groupInfo } = await exportGroupInfo({ group: live })
  const { commitMessage, group } = await joinGroupExternal({
    identity,
    groupInfo,
    credential: stale.credential,
    resync: true,
    options: { resolveLedgerEntries: fixture.resolveLedgerEntries },
  })
  await live.processMessage(commitMessage)
  for (const other of others) {
    await other.processMessage(commitMessage)
  }
  return group
}

/**
 * Alice (creator, admin), Bob and Carol (members). Alice promotes Bob to admin,
 * then demotes him back to member. Carol then rejoins by external commit, so she
 * holds a live MLS state and an empty ledger. The group's ledger, in order:
 *
 *   0 role(bob, member)   — his invite
 *   1 role(carol, member) — her invite
 *   2 role(bob, admin)    — the promotion
 *   3 role(bob, member)   — the demotion  ← the entry a lying responder omits
 */
async function demotedAdminGroup(groupID: string) {
  const fixture = createFixture()
  const alice = randomIdentity()
  const bob = randomIdentity()
  const carol = randomIdentity()

  const { group: created } = await createGroup(alice, groupID, {
    resolveLedgerEntries: fixture.resolveLedgerEntries,
  })
  const withBob = await inviteMember(fixture, created, alice, bob)
  const withCarol = await inviteMember(fixture, withBob.admin, alice, carol, [withBob.group])

  const promoted = await commitRole(fixture, withCarol.admin, alice, bob, 'admin', [
    withBob.group,
    withCarol.group,
  ])
  const demoted = await commitRole(fixture, promoted.admin, alice, bob, 'member', [
    withBob.group,
    withCarol.group,
  ])

  const aliceGroup = demoted.admin
  const carolRejoined = await rejoin(fixture, carol, withCarol.group, aliceGroup, [withBob.group])

  return {
    fixture,
    groupID,
    alice,
    bob,
    carol,
    aliceGroup,
    carolRejoined,
    honestLedger: await aliceGroup.getLedger(),
  }
}

// ---------------------------------------------------------------------------
// The security test: a doctored ledger is genuinely signed, and still rejected
// ---------------------------------------------------------------------------

describe('bootstrapping a ledger from an untrusted responder', () => {
  test('rejects a genuinely-signed ledger with one demotion omitted, and folds nothing', async () => {
    const { groupID, alice, bob, carol, carolRejoined, honestLedger } =
      await demotedAdminGroup('bootstrap-omission')

    expect(honestLedger).toHaveLength(4)

    // The doctored ledger: the group's own tokens with the demotion dropped. No
    // token is forged — forgery is not required, which is the whole point.
    const doctored = [...honestLedger.slice(0, 3)]
    expect(doctored).toHaveLength(3)

    // Every token in it genuinely verifies and is correctly scoped to this group.
    // If they did not, the test would prove nothing: signature verification would
    // have caught the attack on its own.
    for (const token of doctored) {
      const verified = await verifyLedgerEntry(token)
      expect(verified).not.toBeNull()
      expect(verified?.entry.groupID).toBe(groupID)
      expect(verified?.issuer).toBe(normalizeDID(alice.id))
    }

    // What a signature-only bootstrap would install: fold the doctored ledger and
    // the demoted admin is an admin again. This is the attack, demonstrated.
    const folded = await restoreGroup({
      state: carolRejoined.state,
      credential: carolRejoined.credential,
      ledgerEntries: doctored,
    })
    expect(folded.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    // The head check catches it.
    await expect(carolRejoined.bootstrapLedger(doctored)).rejects.toThrow(LedgerIncompleteError)

    // And nothing was folded. Not "the throw happened" — the handle is untouched.
    expect(carolRejoined.ledger).toHaveLength(0)
    expect(carolRejoined.ledgerTokens).toEqual([])
    // The roster is still the anchor's: the creator, alone. The demoted admin is
    // not in it at any role, and neither is anyone else the doctored ledger names.
    expect([...carolRejoined.roster.roles.entries()]).toEqual([[normalizeDID(alice.id), 'admin']])
    expect(carolRejoined.roster.roles.get(normalizeDID(bob.id))).toBeUndefined()
    expect(carolRejoined.roster.roles.get(normalizeDID(carol.id))).toBeUndefined()
    // Still incomplete, so the caller keeps bootstrapping from the next responder.
    await expect(carolRejoined.isLedgerComplete()).resolves.toBe(false)
  })

  test('rejects a reordered ledger — every entry present, every signature valid', async () => {
    const { alice, bob, carol, carolRejoined, honestLedger } =
      await demotedAdminGroup('bootstrap-reorder')

    // Same four tokens, promotion and demotion transposed. Signatures are untouched
    // and all verify; only the order changed — and the order is what decides whether
    // Bob ends up admin or member.
    const reordered = [
      honestLedger[0] as string,
      honestLedger[1] as string,
      honestLedger[3] as string,
      honestLedger[2] as string,
    ]
    expect([...reordered].sort()).toEqual([...honestLedger].sort())
    for (const token of reordered) {
      expect(await verifyLedgerEntry(token)).not.toBeNull()
    }

    // Folding the permutation would leave the demoted admin an admin.
    const folded = await restoreGroup({
      state: carolRejoined.state,
      credential: carolRejoined.credential,
      ledgerEntries: reordered,
    })
    expect(folded.roster.roles.get(normalizeDID(bob.id))).toBe('admin')

    await expect(carolRejoined.bootstrapLedger(reordered)).rejects.toThrow(LedgerIncompleteError)

    expect(carolRejoined.ledger).toHaveLength(0)
    expect([...carolRejoined.roster.roles.entries()]).toEqual([[normalizeDID(alice.id), 'admin']])
    expect(carolRejoined.roster.roles.get(normalizeDID(bob.id))).toBeUndefined()
    expect(carolRejoined.roster.roles.get(normalizeDID(carol.id))).toBeUndefined()
  })

  test('accepts the honest ledger and rebuilds the roster the group actually has', async () => {
    const { alice, bob, carol, carolRejoined, honestLedger } =
      await demotedAdminGroup('bootstrap-honest')

    await expect(carolRejoined.isLedgerComplete()).resolves.toBe(false)

    await carolRejoined.bootstrapLedger(honestLedger)

    expect(carolRejoined.ledgerTokens).toEqual(honestLedger)
    expect(carolRejoined.roster.roles.get(normalizeDID(alice.id))).toBe('admin')
    // The demotion is in the ledger, so Bob is a member again — not the admin the
    // omitted-entry ledger would have made him.
    expect(carolRejoined.roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(carolRejoined.roster.roles.get(normalizeDID(carol.id))).toBe('member')
    await expect(carolRejoined.isLedgerComplete()).resolves.toBe(true)
  })
})

/**
 * A HEAL TELLS THE HOST WHAT IT MISSED.
 *
 * `onLedgerEntries` is how a consumer learns that a notarized, admin-authored, non-`kumiai.*`
 * entry was enacted. The commit path fires it; `bootstrapLedger` did not — so the peer that was
 * away, rejoined, and gathered the whole ledger ended up holding every entry in its state with
 * its host never told about any of them. State right, host blind, which is the worst combination:
 * nothing reports an error and nothing is missing to look at.
 *
 * A heal is the ONLY way a peer that missed commits catches up, so this is not an edge case of
 * the migration that surfaced it — it is every heal.
 */
describe('bootstrapLedger surfaces what it brought in', () => {
  test('the host is told about entries enacted while it was away, once', async () => {
    const fixture = createFixture()
    const alice = randomIdentity()
    const carol = randomIdentity()
    const groupID = 'bootstrap-surfaces'

    const { group: created } = await createGroup(alice, groupID, {
      resolveLedgerEntries: fixture.resolveLedgerEntries,
    })
    const withCarol = await inviteMember(fixture, created, alice, carol)

    // An app-level entry: notarized, admin-authored, and NOT `kumiai.*`, so it is the kind a
    // consumer is told about rather than one the fold consumes itself.
    const appToken = await signLedgerEntry(alice, {
      type: 'note',
      groupID,
      subject: carol.id,
      value: 'enacted while carol was away',
    })
    fixture.record(appToken)
    const enacted = await commitLedgerEntries(withCarol.admin, [appToken])
    const aliceGroup = enacted.newGroup

    const surfaced: Array<string> = []
    // The rejoined handle carries no sink, so nothing before the bootstrap can fire one.
    const carolRejoined = await rejoin(fixture, carol, withCarol.group, aliceGroup)

    const healed = await restoreGroup({
      state: carolRejoined.state,
      credential: carolRejoined.credential,
      ledgerEntries: [],
      options: {
        resolveLedgerEntries: fixture.resolveLedgerEntries,
        onLedgerEntries: (entries) => {
          for (const entry of entries) surfaced.push(String(entry.entry.value))
        },
      },
    })

    await healed.bootstrapLedger(await aliceGroup.getLedger())

    // The app entry, and only it: the invite's role entries are `kumiai.*`, which the roster fold
    // consumes rather than surfacing.
    expect(surfaced).toEqual(['enacted while carol was away'])
    expect(healed.roster.roles.get(normalizeDID(carol.id))).toBe('member')

    // Bootstrapping again over the same ledger says nothing more — a peer is not re-notified of
    // entries it already holds.
    await healed.bootstrapLedger(await aliceGroup.getLedger())
    expect(surfaced).toEqual(['enacted while carol was away'])
  })
})

// ---------------------------------------------------------------------------
// The liveness test: an empty ledger is a roster reset, not a blank slate
// ---------------------------------------------------------------------------

/**
 * Alice (creator) promotes Bob to admin; Carol rejoins by external commit and so
 * holds an empty ledger; Bob — an admin only the ledger knows about — then authors
 * a commit. Returns the world at that instant: Carol's rejoined handle, the honest
 * ledger as it stood before Bob's commit, and Bob's commit bytes.
 */
async function promotedAdminWorld(groupID: string) {
  const fixture = createFixture()
  const alice = randomIdentity()
  const bob = randomIdentity()
  const carol = randomIdentity()

  const { group: created } = await createGroup(alice, groupID, {
    resolveLedgerEntries: fixture.resolveLedgerEntries,
  })
  const withBob = await inviteMember(fixture, created, alice, bob)
  const withCarol = await inviteMember(fixture, withBob.admin, alice, carol, [withBob.group])

  // Promoted after genesis: nothing but the ledger says Bob is an admin.
  const promoted = await commitRole(fixture, withCarol.admin, alice, bob, 'admin', [
    withBob.group,
    withCarol.group,
  ])
  const aliceGroup = promoted.admin
  const bobGroup = withBob.group

  const carolRejoined = await rejoin(fixture, carol, withCarol.group, aliceGroup, [bobGroup])
  // The ledger as the group holds it at the moment Carol must bootstrap: an
  // external commit enacts no entries, so it does not move the head.
  const honestLedger = await aliceGroup.getLedger()

  // Bob, the promoted admin, authors a commit.
  const bobToken = await signLedgerEntry(bob, {
    type: 'kumiai.role',
    groupID,
    subject: carol.id,
    value: 'admin',
  })
  fixture.record(bobToken)
  const bobCommit = await commitLedgerEntries(bobGroup, [bobToken])
  // A peer with the whole ledger accepts it — Bob is an admin there.
  await aliceGroup.processMessage(bobCommit.commitMessage)
  expect(aliceGroup.roster.roles.get(normalizeDID(carol.id))).toBe('admin')

  return { alice, bob, carol, carolRejoined, honestLedger, bobCommit: bobCommit.commitMessage }
}

describe("a rejoined peer's empty ledger is a roster reset", () => {
  test('an empty-ledger peer rejects the promoted admin’s commit; a bootstrapped one applies it', async () => {
    // Two worlds, because one handle cannot do both legs: processing a commit
    // consumes its secret-tree key, so the same frame cannot be replayed into the
    // same handle after a rejection. The worlds are built by one function and
    // differ in exactly one act — whether Carol bootstraps.

    // Leg 1 — no bootstrap. The empty ledger folds to the anchor alone, so the
    // promoted admin is not an admin to this peer, and it REJECTS his commit. The
    // rejoined peer does not merely lack history: it rejects the live group's
    // commits and re-strands itself.
    const stranded = await promotedAdminWorld('bootstrap-liveness-stranded')
    expect(stranded.carolRejoined.ledger).toHaveLength(0)
    await expect(stranded.carolRejoined.isLedgerComplete()).resolves.toBe(false)
    expect(stranded.carolRejoined.roster.roles.get(normalizeDID(stranded.bob.id))).toBeUndefined()
    await expect(stranded.carolRejoined.processMessage(stranded.bobCommit)).rejects.toThrow(
      CommitRejectedError,
    )

    // Leg 2 — bootstrap first, from an honest responder. The ledger is complete,
    // the promoted admin is an admin again, and the same commit APPLIES.
    const healed = await promotedAdminWorld('bootstrap-liveness-healed')
    await healed.carolRejoined.bootstrapLedger(healed.honestLedger)
    await expect(healed.carolRejoined.isLedgerComplete()).resolves.toBe(true)
    expect(healed.carolRejoined.roster.roles.get(normalizeDID(healed.bob.id))).toBe('admin')

    const epochBefore = healed.carolRejoined.epoch
    await healed.carolRejoined.processMessage(healed.bobCommit)
    expect(healed.carolRejoined.epoch).toBe(epochBefore + 1n)
    expect(healed.carolRejoined.roster.roles.get(normalizeDID(healed.carol.id))).toBe('admin')
    await expect(healed.carolRejoined.isLedgerComplete()).resolves.toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The invariant is local
// ---------------------------------------------------------------------------

describe('the ledger-completeness invariant', () => {
  test('a genesis-only group is complete against a real, group-bound head', async () => {
    const dave = randomIdentity()
    const { group } = await createGroup(dave, 'bootstrap-genesis-only', {
      resolveLedgerEntries: async () => {
        throw new Error('the completeness invariant consulted a peer')
      },
    })

    expect(group.ledger).toHaveLength(0)
    await expect(group.isLedgerComplete()).resolves.toBe(true)

    // Not "vacuously true because both sides are empty": the empty fold is the
    // genesis head — SHA-256 over a domain separator and the group id — so the
    // comparison is between two real 32-byte digests bound to THIS group.
    const authenticated = readLedgerHead(group)
    expect(authenticated?.head).toHaveLength(32)
    expect(authenticated?.head).toEqual(computeHead('bootstrap-genesis-only', []))
    expect(authenticated?.head).toEqual(genesisHead('bootstrap-genesis-only'))
    expect(authenticated?.head).not.toEqual(genesisHead('some-other-group'))
    expect(authenticated?.head).not.toEqual(new Uint8Array(32))
  })

  test('true for a healthy handle, false for a rejoined one, and it consults no peer', async () => {
    const fixture = createFixture()
    let resolverCalls = 0
    const spied: Fixture = {
      ...fixture,
      resolveLedgerEntries: async (ids) => {
        resolverCalls += 1
        return fixture.resolveLedgerEntries(ids)
      },
    }

    const alice = randomIdentity()
    const bob = randomIdentity()
    const { group: created } = await createGroup(alice, 'bootstrap-invariant', {
      resolveLedgerEntries: spied.resolveLedgerEntries,
    })
    const withBob = await inviteMember(spied, created, alice, bob)
    const aliceGroup = withBob.admin

    // The healthy handle: its ledger folds to the head its own GroupContext carries.
    await expect(aliceGroup.isLedgerComplete()).resolves.toBe(true)

    const bobRejoined = await rejoin(spied, bob, withBob.group, aliceGroup)
    expect(bobRejoined.ledger).toHaveLength(0)
    expect(readLedgerHead(bobRejoined)?.head).not.toEqual(genesisHead('bootstrap-invariant'))

    const callsBefore = resolverCalls
    await expect(bobRejoined.isLedgerComplete()).resolves.toBe(false)
    await expect(aliceGroup.isLedgerComplete()).resolves.toBe(true)
    // No peer, no network: the invariant is a fold over what the handle already holds.
    expect(resolverCalls).toBe(callsBefore)
  })

  test('the ledger a responder serves is the ordered token log', async () => {
    const { aliceGroup, honestLedger } = await demotedAdminGroup('bootstrap-getledger')
    expect(await aliceGroup.getLedger()).toEqual(aliceGroup.ledgerTokens)
    expect(await aliceGroup.getLedger()).toEqual(honestLedger)
    // Order is load-bearing: the head is a chain digest over the ids in order.
    expect(computeHead(aliceGroup.groupID, honestLedger.map(ledgerEntryDigest))).toEqual(
      readLedgerHead(aliceGroup)?.head,
    )
  })
})
