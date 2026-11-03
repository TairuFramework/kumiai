import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { decodeClientState, encodeClientState } from '../src/codec.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
  restoreGroup,
} from '../src/group.js'
import { KUMIAI_KEY_RETENTION_CONFIG } from '../src/group-context.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

const utf8 = new TextEncoder()
const text = new TextDecoder()

async function twoMemberGroup(groupID: string) {
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
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })
  return { aliceGroup: added.newGroup, bobGroup, resolveLedgerEntries }
}

async function sealMany(sender: GroupHandle, count: number): Promise<Array<Uint8Array>> {
  const sealed: Array<Uint8Array> = []
  for (let i = 0; i < count; i++) sealed.push(await sender.encrypt(utf8.encode(`frame ${i}`)))
  return sealed
}

// One sender ratchet is spent across several lanes; a newer frame on one lane can be
// opened before an older backlog on another. Every frame of the backlog must still open.
describe('out-of-order receive within an epoch', () => {
  test('a receiver opens an older backlog after a newer frame', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('out-of-order-backlog')
    const backlog = await sealMany(aliceGroup, 20)
    const newest = await aliceGroup.encrypt(utf8.encode('newest'))

    expect(text.decode((await bobGroup.decrypt(newest)).payload)).toBe('newest')
    for (const [index, frame] of backlog.entries()) {
      expect(text.decode((await bobGroup.decrypt(frame)).payload)).toBe(`frame ${index}`)
    }
  })

  test('a backlog the size of the retention window opens after a newer frame', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('out-of-order-window')
    const size = KUMIAI_KEY_RETENTION_CONFIG.retainKeysForGenerations
    const backlog = await sealMany(aliceGroup, size)
    const newest = await aliceGroup.encrypt(utf8.encode('newest'))

    await bobGroup.decrypt(newest)
    // The first frame is the oldest key the window keeps.
    expect(text.decode((await bobGroup.decrypt(backlog[0] as Uint8Array)).payload)).toBe('frame 0')
    expect(text.decode((await bobGroup.decrypt(backlog[size - 1] as Uint8Array)).payload)).toBe(
      `frame ${size - 1}`,
    )
  })

  test('a frame older than the retention window is refused as in the past', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('out-of-order-expired')
    const size = KUMIAI_KEY_RETENTION_CONFIG.retainKeysForGenerations
    const backlog = await sealMany(aliceGroup, size + 1)
    const newest = await aliceGroup.encrypt(utf8.encode('newest'))

    await bobGroup.decrypt(newest)
    await expect(bobGroup.decrypt(backlog[0] as Uint8Array)).rejects.toThrow(
      'Desired gen in the past',
    )
    expect(text.decode((await bobGroup.decrypt(backlog[1] as Uint8Array)).payload)).toBe('frame 1')
  })

  test('the retention survives a persist and restore of the receiver', async () => {
    const { aliceGroup, bobGroup, resolveLedgerEntries } =
      await twoMemberGroup('out-of-order-restore')
    const restored = await restoreGroup({
      state: decodeClientState(encodeClientState(bobGroup.state)) as typeof bobGroup.state,
      credential: bobGroup.credential,
      ledgerEntries: bobGroup.ledgerTokens,
      options: { resolveLedgerEntries },
    })
    const backlog = await sealMany(aliceGroup, 20)
    await restored.decrypt(await aliceGroup.encrypt(utf8.encode('newest')))
    // Persisted with the skipped keys, then restored again: they still open.
    const again = await restoreGroup({
      state: decodeClientState(encodeClientState(restored.state)) as typeof restored.state,
      credential: restored.credential,
      ledgerEntries: restored.ledgerTokens,
      options: { resolveLedgerEntries },
    })
    for (const [index, frame] of backlog.entries()) {
      expect(text.decode((await again.decrypt(frame)).payload)).toBe(`frame ${index}`)
    }
  })

  test('a newer frame beyond the ts-mls default forward window still opens', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('out-of-order-forward')
    // ts-mls refuses a jump beyond 200 generations by default.
    await sealMany(aliceGroup, 300)
    const newest = await aliceGroup.encrypt(utf8.encode('newest'))
    expect(text.decode((await bobGroup.decrypt(newest)).payload)).toBe('newest')
  })
})
