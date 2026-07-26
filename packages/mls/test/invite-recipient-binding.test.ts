import { normalizeDID, randomIdentity } from '@kokuin/token'
import type { KeyPackage } from 'ts-mls'
import { defaultCredentialTypes } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { controlCapabilities } from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type Invite,
  InviteRecipientMismatchError,
  processWelcome,
} from '../src/index.js'
import { signLedgerEntry } from '../src/ledger.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'

describe('InviteRecipientMismatchError', () => {
  test('carries the group and both DIDs, and names both in its message', () => {
    const error = new InviteRecipientMismatchError({
      groupID: 'g-1',
      expectedDID: 'did:key:zBob',
      actualDID: 'did:key:zAlice',
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('InviteRecipientMismatchError')
    expect(error.groupID).toBe('g-1')
    expect(error.expectedDID).toBe('did:key:zBob')
    expect(error.actualDID).toBe('did:key:zAlice')
    expect(error.message).toContain('did:key:zBob')
    expect(error.message).toContain('did:key:zAlice')
  })

  test('exposes its fields as getters, so an assignment cannot rewrite the report', () => {
    const error = new InviteRecipientMismatchError({
      groupID: 'g-1',
      expectedDID: 'did:key:zBob',
      actualDID: 'did:key:zAlice',
    })

    expect(() => {
      ;(error as unknown as { expectedDID: string }).expectedDID = 'did:key:zMallory'
    }).toThrow(TypeError)
    expect(error.expectedDID).toBe('did:key:zBob')
  })
})

describe('commitInvite binds the key package to the invite recipient', () => {
  test('refuses a key package belonging to someone other than the invite recipient', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const mallory = randomIdentity()

    const { group } = await createGroup(alice, 'g-substitution')
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })

    // What a key-package store that dropped its owner predicate would serve.
    const malloryBundle = await createKeyPackageBundle(mallory, {
      capabilities: controlCapabilities(),
    })

    // `.catch` returning the raw error collapses to `unknown`, so `instanceof` is a real narrow
    // rather than an assertion — and it fails the test on the resolve path too.
    const thrown: unknown = await commitInvite(group, malloryBundle.publicPackage, invite).catch(
      (error: unknown) => error,
    )

    if (!(thrown instanceof InviteRecipientMismatchError)) {
      throw new Error(`commitInvite resolved, or rejected with the wrong error: ${String(thrown)}`)
    }
    expect(thrown.groupID).toBe('g-substitution')
    expect(thrown.expectedDID).toBe(bob.id)
    expect(thrown.actualDID).toBe(mallory.id)
  })

  test('the refusal leaves the roster clean and the handle usable for an honest retry', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const mallory = randomIdentity()

    const { group } = await createGroup(alice, 'g-no-advance')
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const malloryBundle = await createKeyPackageBundle(mallory, {
      capabilities: controlCapabilities(),
    })

    await expect(commitInvite(group, malloryBundle.publicPackage, invite)).rejects.toThrow(
      InviteRecipientMismatchError,
    )

    // The rejection left the source handle untouched: the same invite still commits
    // honestly afterward, admitting Bob and never Mallory — proving both that no partial
    // state from the aborted attempt survived and that the mutex released on rejection.
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
    const { newGroup } = await commitInvite(group, bobBundle.publicPackage, invite)
    expect(newGroup.roster.roles.get(normalizeDID(bob.id))).toBe('member')
    expect(newGroup.roster.roles.get(normalizeDID(mallory.id))).toBeUndefined()
  })

  test('the honest path still commits and the recipient joins', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group } = await createGroup(alice, 'g-honest')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })

    const { welcomeMessage, newGroup } = await commitInvite(group, bobBundle.publicPackage, invite)

    const { group: bobGroup } = await processWelcome({
      identity: bob,
      invite,
      welcome: welcomeMessage,
      keyPackageBundle: bobBundle,
    })

    expect(bobGroup.groupID).toBe('g-honest')
    expect(newGroup.roster.roles.get(bob.id)).toBe('member')
  })
})

describe('commitInvite refuses an invite it cannot bind', () => {
  test('refuses an invite that enacts no role entry for this group', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group } = await createGroup(alice, 'g-no-role')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })

    const noteToken = await signLedgerEntry(alice, {
      type: 'app.note',
      groupID: 'g-no-role',
      subject: bob.id,
      value: 'not a role grant',
    })
    const invite: Invite = {
      groupID: 'g-no-role',
      inviterID: alice.id,
      ledgerEntries: [...group.ledgerTokens, noteToken],
    }

    await expect(commitInvite(group, bobBundle.publicPackage, invite)).rejects.toThrow(
      /enacts no kumiai\.role entry for this group/,
    )
  })

  test('an invite carrying a promotion binds to the grant that comes last, not the promotion', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const carol = randomIdentity()

    // Bob joins first, so promoting him is a grant to an existing member.
    const { group } = await createGroup(alice, 'g-promotion-ride')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
    const { invite: bobInvite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const { newGroup: withBob } = await commitInvite(group, bobBundle.publicPackage, bobInvite)

    const promoteBob = await signLedgerEntry(alice, {
      type: ROLE_ENTRY_TYPE,
      groupID: 'g-promotion-ride',
      subject: bob.id,
      value: 'admin',
    })
    const { invite: carolInvite } = await createInvite({
      group: withBob,
      identity: alice,
      recipientDID: carol.id,
      permission: 'member',
    })
    // The promotion rides ahead of Carol's own grant, which stays last — the ordering
    // createInvite documents and the rule the guard reads.
    const carolRoleToken = carolInvite.ledgerEntries[carolInvite.ledgerEntries.length - 1]
    if (carolRoleToken == null) {
      throw new Error('createInvite produced an invite with no ledger entries')
    }
    const withPromotion: Invite = {
      ...carolInvite,
      ledgerEntries: [...carolInvite.ledgerEntries.slice(0, -1), promoteBob, carolRoleToken],
    }

    // Handed the promoted member's key package instead of Carol's, the guard refuses: being
    // *a* role subject in the invite is not enough, it must be the one the invite ends on.
    const bobSecondBundle = await createKeyPackageBundle(bob, {
      capabilities: controlCapabilities(),
    })
    const thrown: unknown = await commitInvite(
      withBob,
      bobSecondBundle.publicPackage,
      withPromotion,
    ).catch((error: unknown) => error)

    if (!(thrown instanceof InviteRecipientMismatchError)) {
      throw new Error(`commitInvite resolved, or rejected with the wrong error: ${String(thrown)}`)
    }
    expect(thrown.expectedDID).toBe(carol.id)
    expect(thrown.actualDID).toBe(bob.id)

    // And handed Carol's, it commits — the promotion riding along is not itself a problem.
    const carolBundle = await createKeyPackageBundle(carol, {
      capabilities: controlCapabilities(),
    })
    const { newGroup } = await commitInvite(withBob, carolBundle.publicPackage, withPromotion)
    expect(newGroup.roster.roles.get(bob.id)).toBe('admin')
    expect(newGroup.roster.roles.get(carol.id)).toBe('member')
  })

  test('refuses a key package whose credential is not a basic credential', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()

    const { group } = await createGroup(alice, 'g-x509')
    const bobBundle = await createKeyPackageBundle(bob, { capabilities: controlCapabilities() })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })

    // Signature is now invalid, which is the point: the guard must refuse before anything
    // reaches a signature check, because a non-basic credential names no DID to bind.
    const x509Package: KeyPackage = {
      ...bobBundle.publicPackage,
      leafNode: {
        ...bobBundle.publicPackage.leafNode,
        credential: { credentialType: defaultCredentialTypes.x509, certificates: [] },
      },
    }

    await expect(commitInvite(group, x509Package, invite)).rejects.toThrow(
      /non-basic credential, which names no DID to bind/,
    )
  })
})
