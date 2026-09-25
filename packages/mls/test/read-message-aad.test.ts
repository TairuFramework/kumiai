import { randomIdentity } from '@kokuin/token'
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, wireformats } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  ledgerEntryDigest,
  processWelcome,
  readMessageAAD,
} from '../src/index.js'

describe('readMessageAAD', () => {
  test('reads an application frame before opening and without a receiving key', async () => {
    const { group } = await createGroup(randomIdentity(), 'read-aad')
    const aad = new Uint8Array([1, 1, 0, 255])
    const sealed = await group.encrypt(new Uint8Array([42]), { aad })
    expect(readMessageAAD(sealed)).toEqual(aad)
  })

  test('returns null without throwing for garbage or non-application frames', () => {
    // ts-mls throws before parsing an oversized declared length. A tiny typed array with a
    // forged length exercises that branch without allocating a 64 MB fixture.
    const oversized = new Uint8Array(1)
    Object.defineProperty(oversized, 'length', { value: 64_000_001 })
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0xff]),
      new Uint8Array(256),
      oversized,
    ]) {
      expect(readMessageAAD(bytes)).toBeNull()
    }
  })

  test('rewriting the cleartext intent byte cannot authenticate on open', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const tokens = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`missing entry ${id}`)
        return token
      })
    const { group } = await createGroup(alice, 'rewrite-aad', { resolveLedgerEntries })
    const { invite } = await createInvite({
      group,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(group, bundle.publicPackage, invite)
    expect(readMessageAAD(added.commitMessage)).toBeNull()
    const { group: receiver } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })
    const originalAAD = new Uint8Array([1, 1, 97])
    const sealed = await added.newGroup.encrypt(new Uint8Array([42]), { aad: originalAAD })
    const decoded = decode(mlsMessageDecoder, sealed.slice())
    if (decoded?.wireformat !== wireformats.mls_private_message) throw new Error('expected private')
    decoded.privateMessage.authenticatedData[1] = 0
    const rewritten = encode(mlsMessageEncoder, decoded)
    expect(readMessageAAD(rewritten)).toEqual(new Uint8Array([1, 0, 97]))
    await expect(
      receiver.decrypt(rewritten, { expectedAAD: new Uint8Array([1, 0, 97]) }),
    ).rejects.toThrow()
    // A rejected rewrite must not consume the original frame's key.
    await expect(receiver.decrypt(sealed, { expectedAAD: originalAAD })).resolves.toMatchObject({
      payload: new Uint8Array([42]),
    })
  })
})
