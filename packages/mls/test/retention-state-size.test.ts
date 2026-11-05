import { randomIdentity } from '@kokuin/token'
import { createCommit, encode, mlsMessageEncoder } from 'ts-mls'
import { expect, test } from 'vitest'

import { encodeClientState } from '../src/codec.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
} from '../src/group.js'
import { KUMIAI_KEY_RETENTION_CONFIG } from '../src/group-context.js'
import { deriveGroup } from '../src/group-handle.js'
import { ledgerEntryDigest } from '../src/ledger.js'

async function group(size: number): Promise<Array<GroupHandle>> {
  const admin = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => tokens.get(id) as string)
  let { group: adminGroup } = await createGroup({
    identity: admin,
    groupID: `measure-${size}`,
    resolveLedgerEntries,
  })
  const members: Array<GroupHandle> = []
  for (let i = 1; i < size; i++) {
    const identity = randomIdentity()
    const { invite } = await createInvite({
      group: adminGroup,
      identity: admin,
      recipientDID: identity.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle({ identity })
    const added = await commitInvite({
      group: adminGroup,
      keyPackage: bundle.publicPackage,
      invite,
    })
    for (const member of members) await member.processMessage({ message: added.commitMessage })
    const { group: joined } = await processWelcome({
      identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })
    adminGroup = added.newGroup
    members.push(joined)
  }
  return [adminGroup, ...members]
}

// A sender spends one application ratchet across its tunnels to every peer, so a receiver in a
// group of three or more sees the frames sent to the others as skipped generations no frame will
// claim: each receive ratchet fills its retention window, in every retained epoch.
test('a receiver in a three-member group keeps its persisted state bounded at steady state', async () => {
  const [first, receiver, other] = (await group(3)) as [GroupHandle, GroupHandle, GroupHandle]
  let admin = first
  const peers = 2
  const frames = KUMIAI_KEY_RETENTION_CONFIG.retainKeysForGenerations * 2 + peers
  for (let epoch = 0; epoch < 5; epoch++) {
    for (const sender of [admin, other]) {
      for (let i = 0; i < frames; i++) {
        const sealed = await sender.encrypt({ plaintext: new Uint8Array([i & 0xff]) })
        // Round-robin over the sender's two peers: every other frame is the receiver's.
        if (i % peers === 0) await receiver.decrypt({ message: sealed })
      }
    }
    if (epoch === 4) break
    const built = await createCommit({ context: admin.context, state: admin.state })
    const frame = encode(mlsMessageEncoder, built.commit)
    await receiver.processMessage({ message: frame })
    await other.processMessage({ message: frame })
    admin = await deriveGroup(admin, built.newState)
    admin.confirmAdopted()
  }
  // Two senders, each with a full window in the current and every retained past epoch, at
  // about 37 bytes a key. Measured: 41.6 KB with one past epoch, 103 KB with ts-mls's four.
  expect(encodeClientState(receiver.state).length).toBeLessThan(48 * 1024)
}, 120_000)
