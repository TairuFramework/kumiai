import { createIdentity, normalizeDID, type OwnIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import type { GroupAnchor } from '../src/anchor.js'
import type { FoldDrop, FoldInput } from '../src/fold.js'
import { ledgerEntryDigest, signLedgerEntry, verifyLedgerEntry } from '../src/ledger.js'
import { foldRoster, ROLE_ENTRY_TYPE, type RoleValue } from '../src/roster.js'

const GROUP = 'group-1'

function makeSigner(): Promise<OwnIdentity> {
  return createIdentity({ keys: [{ purpose: 'sig', alg: 'EdDSA' }], didMethod: 'key' })
}

/**
 * Hand-build a verified fold input. The issuer is the authenticated author (as
 * a real verifier would hand it over, normalized); the claim binds a subject to
 * a role in one group.
 */
function roleEntry(
  issuer: string,
  groupID: string,
  subject: string,
  value: RoleValue,
  entryID: string,
): FoldInput<RoleValue> {
  return {
    verified: {
      issuer: normalizeDID(issuer),
      entry: { type: ROLE_ENTRY_TYPE, groupID, subject, value },
    },
    entryID,
  }
}

describe('foldRoster', () => {
  test('an empty ledger seeds the creator as admin and nobody else', async () => {
    const alice = await makeSigner()
    const stranger = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    const roster = foldRoster([], anchor, GROUP)

    expect(roster.roles.get(normalizeDID(alice.id))).toBe('admin')
    expect(roster.roles.get(normalizeDID(stranger.id))).toBeUndefined()
  })

  test('an admin promotes a member to admin (through real signing)', async () => {
    const alice = await makeSigner()
    const bob = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    // The one case that goes through the real sign/verify wiring: Alice signs a
    // grant, the verifier recovers it, and the fold reads Bob back as an admin.
    const token = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID: GROUP,
      subject: bob.id,
      value: 'admin',
    })
    const verified = await verifyLedgerEntry<RoleValue>(token)
    expect(verified).not.toBeNull()
    if (verified == null) throw new Error('expected a verified entry')

    const roster = foldRoster([{ verified, entryID: ledgerEntryDigest(token) }], anchor, GROUP)

    expect(roster.roles.get(normalizeDID(bob.id))).toBe('admin')
  })

  test('any admin may demote another admin, leaving the demoter untouched', async () => {
    const alice = await makeSigner()
    const bob = await makeSigner()
    const carol = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    // Alice promotes Bob and Carol, then Bob (an admin) demotes Carol.
    const roster = foldRoster(
      [
        roleEntry(alice.id, GROUP, bob.id, 'admin', 'e1'),
        roleEntry(alice.id, GROUP, carol.id, 'admin', 'e2'),
        roleEntry(bob.id, GROUP, carol.id, 'member', 'e3'),
      ],
      anchor,
      GROUP,
    )

    expect(roster.roles.get(normalizeDID(carol.id))).toBe('member')
    expect(roster.roles.get(normalizeDID(bob.id))).toBe('admin')
  })

  test('a grant survives its issuer being demoted later (state-so-far, not final)', async () => {
    const alice = await makeSigner()
    const bob = await makeSigner()
    const carol = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    // Alice promotes Bob; Bob (then an admin) promotes Carol; Alice demotes Bob.
    // Carol keeps admin — her grant was authorized when Bob made it. Evaluating
    // against the final state would drop her.
    const roster = foldRoster(
      [
        roleEntry(alice.id, GROUP, bob.id, 'admin', 'e1'),
        roleEntry(bob.id, GROUP, carol.id, 'admin', 'e2'),
        roleEntry(alice.id, GROUP, bob.id, 'member', 'e3'),
      ],
      anchor,
      GROUP,
    )

    expect(roster.roles.get(normalizeDID(carol.id))).toBe('admin')
    expect(roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('a role entry from a non-admin issuer is dropped', async () => {
    const alice = await makeSigner()
    const bob = await makeSigner()
    const carol = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    // Bob is a plain member; his grant of Carol is dropped with a notice.
    const drops: Array<FoldDrop> = []
    const roster = foldRoster(
      [
        roleEntry(alice.id, GROUP, bob.id, 'member', 'e1'),
        roleEntry(bob.id, GROUP, carol.id, 'admin', 'e2'),
      ],
      anchor,
      GROUP,
      (drop) => drops.push(drop),
    )

    expect(drops).toHaveLength(1)
    expect(roster.roles.get(normalizeDID(carol.id))).toBeUndefined()
    expect(roster.roles.get(normalizeDID(bob.id))).toBe('member')
  })

  test('an entry signed for another group is dropped', async () => {
    const alice = await makeSigner()
    const bob = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    const drops: Array<FoldDrop> = []
    const roster = foldRoster(
      [roleEntry(alice.id, 'other-group', bob.id, 'admin', 'e1')],
      anchor,
      GROUP,
      (drop) => drops.push(drop),
    )

    expect(drops).toHaveLength(1)
    expect(roster.roles.get(normalizeDID(bob.id))).toBeUndefined()
  })

  test('an entry may name a DID not otherwise present (DID-keyed, not leaf-keyed)', async () => {
    const alice = await makeSigner()
    const dave = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    // Dave has no Add and no prior entry; the grant still records his role.
    const roster = foldRoster([roleEntry(alice.id, GROUP, dave.id, 'admin', 'e1')], anchor, GROUP)

    expect(roster.roles.get(normalizeDID(dave.id))).toBe('admin')
  })

  test('the last admin cannot demote themselves to zero admins', async () => {
    const alice = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    const drops: Array<FoldDrop> = []
    const roster = foldRoster(
      [roleEntry(alice.id, GROUP, alice.id, 'member', 'e1')],
      anchor,
      GROUP,
      (drop) => drops.push(drop),
    )

    expect(drops).toHaveLength(1)
    expect(roster.roles.get(normalizeDID(alice.id))).toBe('admin')
  })

  test('demoting the only other admin is allowed while one admin remains', async () => {
    const alice = await makeSigner()
    const bob = await makeSigner()
    const anchor: GroupAnchor = { creatorDID: alice.id, version: 1 }

    // Only the transition to zero admins is blocked; one admin left is fine.
    const roster = foldRoster(
      [
        roleEntry(alice.id, GROUP, bob.id, 'admin', 'e1'),
        roleEntry(alice.id, GROUP, bob.id, 'member', 'e2'),
      ],
      anchor,
      GROUP,
    )

    expect(roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(roster.roles.get(normalizeDID(alice.id))).toBe('admin')
  })
})
