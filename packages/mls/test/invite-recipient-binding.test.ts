import { normalizeDID, randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { controlCapabilities } from '../src/anchor.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  InviteRecipientMismatchError,
  processWelcome,
} from '../src/index.js'

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
