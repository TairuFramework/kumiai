import { randomIdentity } from '@kokuin/token'
import { greaseValues } from 'ts-mls'
import { describe, expect, test } from 'vitest'

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
})
