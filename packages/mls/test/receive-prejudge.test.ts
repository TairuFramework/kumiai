import { randomIdentity } from '@kokuin/token'
import { decode, mlsMessageDecoder, processMessage, wireformats } from 'ts-mls'
import { expect, test } from 'vitest'

import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

async function threeMemberGroup(groupID: string) {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const carol = randomIdentity()
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
  const { group: created } = await createGroup({ identity: alice, groupID, resolveLedgerEntries })
  const { invite: bobInvite } = await createInvite({
    group: created,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  publish(bobInvite)
  const bobBundle = await createKeyPackageBundle({ identity: bob })
  const added = await commitInvite({
    group: created,
    keyPackage: bobBundle.publicPackage,
    invite: bobInvite,
  })
  const { group: bobGroup } = await processWelcome({
    identity: bob,
    invite: bobInvite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bobBundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })
  const { invite: carolInvite } = await createInvite({
    group: added.newGroup,
    identity: alice,
    recipientDID: carol.id,
    permission: 'member',
  })
  publish(carolInvite)
  const carolBundle = await createKeyPackageBundle({ identity: carol })
  const next = await commitInvite({
    group: added.newGroup,
    keyPackage: carolBundle.publicPackage,
    invite: carolInvite,
  })
  return { aliceGroup: next.newGroup, bobGroup, commit: next.commitMessage }
}

test('the judging pass leaves the receiver state unchanged and burns no generation', async () => {
  const { aliceGroup, bobGroup, commit } = await threeMemberGroup('prejudge-state')
  const message = decode(mlsMessageDecoder, commit)
  if (message?.wireformat !== wireformats.mls_private_message) {
    throw new Error('Expected a private commit')
  }
  const before = structuredClone(bobGroup.state)

  let judged = 0
  await processMessage({
    context: bobGroup.context,
    state: bobGroup.state,
    message,
    callback: () => {
      judged++
      return 'reject'
    },
  })

  expect(judged).toBe(1)
  expect(bobGroup.state).toEqual(before)

  await bobGroup.processMessage({ message: commit })
  expect(bobGroup.epoch).toBe(aliceGroup.epoch)
  const sealed = await aliceGroup.encrypt({
    plaintext: new TextEncoder().encode('after the commit'),
  })
  expect(new TextDecoder().decode((await bobGroup.decrypt({ message: sealed })).payload)).toBe(
    'after the commit',
  )
})

test('receiving a commit judges it once before applying it', async () => {
  const { aliceGroup, bobGroup, commit } = await threeMemberGroup('prejudge-order')
  const events: Array<string> = []
  const before = bobGroup.epoch
  await bobGroup.processMessage({
    message: commit,
    commitPolicy: (incoming) => {
      events.push(incoming.kind)
      expect(bobGroup.epoch).toBe(before)
      return 'accept'
    },
  })
  expect(events).toEqual(['commit'])
  expect(bobGroup.epoch).toBe(aliceGroup.epoch)
})
