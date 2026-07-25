import { randomIdentity } from '@kokuin/token'
import { greaseValues } from 'ts-mls'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  createLastResortKeyPackageBundle,
  LAST_RESORT_EXTENSION_TYPE,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

describe('createLastResortKeyPackageBundle', () => {
  test('stamps the last_resort extension, carrying no data', async () => {
    const identity = randomIdentity()
    const bundle = await createLastResortKeyPackageBundle(identity)

    const extension = bundle.publicPackage.extensions.find(
      (ext) => ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
    )
    expect(extension).toBeDefined()
    expect(extension?.extensionData).toEqual(new Uint8Array(0))
    expect(bundle.ownerDID).toBe(identity.id)
  })

  test('an ordinary bundle carries no last_resort extension', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    expect(
      bundle.publicPackage.extensions.some(
        (ext) => ext.extensionType === LAST_RESORT_EXTENSION_TYPE,
      ),
    ).toBe(false)
  })

  /**
   * Passing `extensions` at all suppresses ts-mls's own default of `greaseExtensions(...)`, so an
   * implementation that hands over a bare `[last_resort]` list silently drops the stack's GREASE.
   * Grease is probabilistic (0.1 per value over 15 values), so presence is asserted across a
   * sample: P(no grease in any of 30 packages) = 0.9^(15*30), which is not a flake risk.
   */
  test('keeps the GREASE extensions ts-mls would otherwise have added', async () => {
    const identity = randomIdentity()
    const seen = new Set<number>()
    for (let i = 0; i < 30; i++) {
      const bundle = await createLastResortKeyPackageBundle(identity)
      for (const ext of bundle.publicPackage.extensions) {
        if (ext.extensionType !== LAST_RESORT_EXTENSION_TYPE) seen.add(ext.extensionType)
      }
    }
    expect(seen.size).toBeGreaterThan(0)
    // Whatever showed up is grease and nothing else — no stray extension type leaked in.
    for (const type of seen) expect(greaseValues).toContain(type)
  })

  /**
   * The premise GREASE rests on, verified rather than assumed: a peer that has never heard of
   * extension 0x000A still adds the leaf to an anchored group. If this ever fails, the flag is
   * unusable and the hub-side plumbing has nothing safe to serve.
   */
  test('a peer that knows nothing about the extension still admits the member', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()
    const publish = (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    }
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    const { group } = await createGroup(alice, 'group:last-resort', { resolveLedgerEntries })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publish(invite)

    const bundle = await createLastResortKeyPackageBundle(bob)
    const added = await commitInvite(group, bundle.publicPackage, invite)
    const { group: joined } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })

    expect(joined.findMemberLeafIndex(bob.id)).not.toBeNull()
  })

  /**
   * The feature's central claim is that the SAME bundle joins a second group after the first —
   * not just that the hub will hand it out twice, but that MLS itself accepts it a second time.
   * Every other test here proves the hub side; this proves the bundle is actually reusable by
   * joining two independent groups, created by two different inviters, with one bundle.
   */
  test('the same last-resort bundle joins two different groups', async () => {
    const alice = randomIdentity()
    const carol = randomIdentity()
    const bob = randomIdentity()

    const tokens = new Map<string, string>()
    const publish = (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    }
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    const bundle = await createLastResortKeyPackageBundle(bob)

    const { group: groupA } = await createGroup(alice, 'group:last-resort-a', {
      resolveLedgerEntries,
    })
    const { invite: inviteA } = await createInvite({
      group: groupA,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    publish(inviteA)
    const addedA = await commitInvite(groupA, bundle.publicPackage, inviteA)
    const { group: joinedA } = await processWelcome({
      identity: bob,
      invite: inviteA,
      welcome: addedA.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: addedA.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })

    const { group: groupB } = await createGroup(carol, 'group:last-resort-b', {
      resolveLedgerEntries,
    })
    const { invite: inviteB } = await createInvite({
      group: groupB,
      identity: carol,
      recipientDID: bob.id,
      permission: 'member',
    })
    publish(inviteB)
    const addedB = await commitInvite(groupB, bundle.publicPackage, inviteB)
    const { group: joinedB } = await processWelcome({
      identity: bob,
      invite: inviteB,
      welcome: addedB.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: addedB.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })

    expect(joinedA.findMemberLeafIndex(bob.id)).not.toBeNull()
    expect(joinedB.findMemberLeafIndex(bob.id)).not.toBeNull()
  })
})

describe('last-resort key package lifetime', () => {
  afterEach(() => vi.useRealTimers())

  /**
   * A last-resort package is a standing availability floor, so its lifetime IS the feature's expiry
   * date. ts-mls's `defaultLifetime()` is ~15 days ("Half month"), which would quietly turn the slot
   * into a full-but-dead one a fortnight after upload — worse than an empty slot, because the hub
   * keeps serving it and every Add fails at the inviter.
   */
  test('carries an explicit ~90-day lifetime, not ts-mls default ~15-day one', async () => {
    const bundle = await createLastResortKeyPackageBundle(randomIdentity())
    const { notBefore, notAfter } = bundle.publicPackage.leafNode.lifetime
    const days = Number(notAfter - notBefore) / 86400
    // 90 days forward, plus the one day of back-dating that absorbs clock skew between peers.
    expect(days).toBeCloseTo(91, 1)
  })

  test('an ordinary bundle keeps the ts-mls default lifetime', async () => {
    const bundle = await createKeyPackageBundle(randomIdentity())
    const { notBefore, notAfter } = bundle.publicPackage.leafNode.lifetime
    const days = Number(notAfter - notBefore) / 86400
    // Untouched: ordinary packages are single-use and short-lived by design.
    expect(days).toBeCloseTo(16.2, 1)
  })

  /**
   * The lifetime is enforced by the INVITER (ts-mls checks it when `sentByClient`), so this asserts
   * the end-to-end consequence rather than a field: the package must still be usable well past the
   * old 15-day cliff.
   */
  test('is still addable 60 days after it was generated', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`unknown ledger entry ${id}`)
        return token
      })

    const bundle = await createLastResortKeyPackageBundle(bob)
    const { group } = await createGroup(alice, 'group:lifetime', { resolveLedgerEntries })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60 * 86400 * 1000)

    const added = await commitInvite(group, bundle.publicPackage, invite)
    expect(added.welcomeMessage).toBeDefined()
  })
})
