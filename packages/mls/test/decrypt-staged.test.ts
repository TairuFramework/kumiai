import { randomIdentity } from '@kokuin/token'
import { nodeTypes } from 'ts-mls'
import { describe, expect, test, vi } from 'vitest'

import { decodeClientState, encodeClientState } from '../src/codec.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
  restoreGroup,
} from '../src/group.js'
import { deviceDenyHolderFor } from '../src/group-context.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

const utf8 = new TextEncoder()

async function fixture(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })
  const publish = (invite: Invite) => {
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
  }
  const { group: created } = await createGroup(alice, groupID, { resolveLedgerEntries })
  const { invite } = await createInvite({
    group: created,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  publish(invite)
  const bundle = await createKeyPackageBundle(bob)
  const added = await commitInvite(created, bundle.publicPackage, invite)
  const { group: receiver } = await processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })
  const sealed = await added.newGroup.encrypt(utf8.encode('staged payload'), {
    aad: utf8.encode('app topic'),
  })
  const restore = async (encoded: Uint8Array) => {
    const state = decodeClientState(encoded)
    if (state == null) throw new Error('failed to decode stored state')
    return restoreGroup({ state, credential: receiver.credential })
  }
  return { alice, receiver, sealed, restore }
}

describe('GroupHandle.decryptStaged', () => {
  test('persists an openable post-state before adopting it, without replacing the deny provider', async () => {
    const { alice, receiver, sealed, restore } = await fixture('staged-success')
    const before = encodeClientState(receiver.state)
    const holder = deviceDenyHolderFor(receiver.context)
    const liveProvider = holder?.provider
    expect(liveProvider).toBeDefined()
    const oldSecrets = [
      ...Object.values(receiver.state.secretTree.intermediateNodes),
      ...Object.values(receiver.state.secretTree.leafNodes).flatMap(
        ({ handshake, application }) => [handshake.secret, application.secret],
      ),
    ].map((bytes) => ({ bytes, original: bytes.slice() }))
    let saved: Uint8Array | undefined

    const opened = await receiver.decryptStaged(
      sealed,
      { expectedAAD: utf8.encode('app topic') },
      async (state, result) => {
        expect(encodeClientState(receiver.state)).toEqual(before)
        expect(holder?.provider).toBe(liveProvider)
        expect(result).toEqual({
          payload: utf8.encode('staged payload'),
          senderDID: alice.id,
          aad: utf8.encode('app topic'),
        })
        saved = state
      },
    )

    expect(opened.senderDID).toBe(alice.id)
    expect(saved).toBeDefined()
    expect(saved).not.toEqual(before)
    expect(encodeClientState(receiver.state)).toEqual(saved)
    expect(holder?.provider).toBe(liveProvider)
    expect(
      oldSecrets.some(
        ({ bytes, original }) =>
          original.some((byte) => byte !== 0) && bytes.every((byte) => byte === 0),
      ),
    ).toBe(true)
    await expect(receiver.decrypt(sealed)).rejects.toThrow()
    await expect((await restore(saved as Uint8Array)).decrypt(sealed)).rejects.toThrow()
  })

  test('a failed persist leaves both the live and stored pre-open states able to open', async () => {
    const { receiver, sealed, restore } = await fixture('staged-failure')
    const before = encodeClientState(receiver.state)
    const holder = deviceDenyHolderFor(receiver.context)
    const liveProvider = holder?.provider
    const persist = vi.fn(async () => {
      throw new Error('storage unavailable')
    })

    await expect(receiver.decryptStaged(sealed, {}, persist)).rejects.toThrow('storage unavailable')
    expect(persist).toHaveBeenCalledOnce()
    expect(encodeClientState(receiver.state)).toEqual(before)
    expect(holder?.provider).toBe(liveProvider)
    await expect((await restore(before)).decrypt(sealed)).resolves.toMatchObject({
      payload: utf8.encode('staged payload'),
    })
    await expect(receiver.decrypt(sealed)).resolves.toMatchObject({
      payload: utf8.encode('staged payload'),
    })
  })

  test('an unnamed sender fails before persistence and does not consume the frame', async () => {
    const { alice, receiver, sealed } = await fixture('staged-unnamed')
    const tree = receiver.state.ratchetTree
    const aliceLeaf = receiver.listMembers().find((member) => member.id === alice.id)?.leafIndex
    if (aliceLeaf == null) throw new Error('missing sender leaf')
    const node = tree[aliceLeaf * 2]
    if (node == null || node.nodeType !== nodeTypes.leaf || !('identity' in node.leaf.credential)) {
      throw new Error('missing sender credential')
    }
    const credential = node.leaf.credential
    const originalIdentity = credential.identity
    credential.identity = utf8.encode('not-json-garbage')
    const persist = vi.fn(async () => {})
    const before = encodeClientState(receiver.state)

    await expect(receiver.decryptStaged(sealed, {}, persist)).rejects.toThrow('sender')
    expect(persist).not.toHaveBeenCalled()
    expect(encodeClientState(receiver.state)).toEqual(before)
    credential.identity = originalIdentity
    await expect(receiver.decrypt(sealed)).resolves.toMatchObject({ senderDID: alice.id })
  })
})
