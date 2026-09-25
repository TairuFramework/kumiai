import { randomIdentity } from '@kokuin/token'
import { describe, expect, test, vi } from 'vitest'

import {
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '../src/group.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'

describe('received commit persistence boundary', () => {
  test('rolls back a failed persist, then applies once; persistence sees the new state before notification', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const bodies = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = bodies.get(id)
        if (token == null) throw new Error(`missing ${id}`)
        return token
      })
    const { group: created } = await createGroup(alice, 'persist-received', {
      resolveLedgerEntries,
    })
    const bobInvite = await createInvite({
      group: created,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    for (const token of bobInvite.invite.ledgerEntries) bodies.set(ledgerEntryDigest(token), token)
    const bobBundle = await createKeyPackageBundle(bob)
    const addedBob = await commitInvite(created, bobBundle.publicPackage, bobInvite.invite)
    const notified = vi.fn()
    const { group: receiver } = await processWelcome({
      identity: bob,
      invite: bobInvite.invite,
      welcome: addedBob.welcomeMessage,
      keyPackageBundle: bobBundle,
      ratchetTree: addedBob.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries, onLedgerEntries: notified },
    })
    const note = await signLedgerEntry(alice, {
      type: 'note',
      groupID: receiver.groupID,
      subject: bob.id,
      value: 'durable',
    })
    bodies.set(ledgerEntryDigest(note), note)
    const addedNote = await commitLedgerEntries(addedBob.newGroup, [note])
    const controlEvents = vi.spyOn(receiver, 'emitControlEvents')
    const before = {
      state: receiver.state,
      ledger: receiver.ledger,
      roster: receiver.roster,
      registry: receiver.registry,
      epoch: receiver.epoch,
    }
    const failed = vi.fn(async () => {
      throw new Error('disk failed')
    })
    await expect(
      receiver.processMessage(addedNote.commitMessage, { persist: failed }),
    ).rejects.toThrow('disk failed')
    expect(failed).toHaveBeenCalledOnce()
    expect(receiver.state).toBe(before.state)
    expect(receiver.ledger).toBe(before.ledger)
    expect(receiver.roster).toBe(before.roster)
    expect(receiver.registry).toBe(before.registry)
    expect(receiver.epoch).toBe(before.epoch)
    expect(notified).not.toHaveBeenCalled()
    expect(controlEvents).not.toHaveBeenCalled()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const persist = vi.fn(async (handle: typeof receiver) => {
      expect(handle).toBe(receiver)
      expect(handle.epoch).toBe(before.epoch + 1n)
      expect(handle.ledger.length).toBe(before.ledger.length + 1)
      expect(notified).not.toHaveBeenCalled()
      await pending
    })
    const applying = receiver.processMessage(addedNote.commitMessage, { persist })
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    expect(notified).not.toHaveBeenCalled()
    expect(controlEvents).not.toHaveBeenCalled()
    release()
    await applying
    expect(notified).toHaveBeenCalledOnce()
    expect(controlEvents).toHaveBeenCalledOnce()
  })
})
