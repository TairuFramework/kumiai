import { randomIdentity } from '@kokuin/token'
import { createCommit, createUpdateProposal, encode, mlsMessageEncoder, wireformats } from 'ts-mls'
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
import { MissingLedgerEntriesError } from '../src/policy.js'

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

  test('persists a public member commit and rolls it back on failure', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const { group: original } = await createGroup(alice, 'persist-public-member')
    const { invite } = await createInvite({
      group: original,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(original, bundle.publicPackage, invite)
    const { group: receiver } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
    })
    const made = await createCommit({
      context: added.newGroup.context,
      state: added.newGroup.state,
      wireAsPublicMessage: true,
    })
    expect(made.commit.wireformat).toBe(wireformats.mls_public_message)
    const message = encode(mlsMessageEncoder, made.commit)
    const before = receiver.state
    const persist = vi.fn(async () => {
      throw new Error('disk failed')
    })
    await expect(receiver.processMessage(message, { persist })).rejects.toThrow('disk failed')
    expect(persist).toHaveBeenCalledOnce()
    expect(receiver.state).toBe(before)
    const saved = vi.fn()
    await receiver.processMessage(message, { persist: saved })
    expect(saved).toHaveBeenCalledOnce()
    expect(receiver.epoch).toBe(before.groupContext.epoch + 1n)
  })

  test('persists an accepted standalone proposal and rolls it back on failure', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const { group: original } = await createGroup(alice, 'persist-proposal')
    const { invite } = await createInvite({
      group: original,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(original, bundle.publicPackage, invite)
    const { group: receiver } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
    })
    const proposal = await createUpdateProposal({
      context: added.newGroup.context,
      state: added.newGroup.state,
    })
    const message = encode(mlsMessageEncoder, proposal.message)
    const before = receiver.state
    const persist = vi.fn(async () => {
      throw new Error('disk failed')
    })
    await expect(receiver.processMessage(message, { persist })).rejects.toThrow('disk failed')
    expect(persist).toHaveBeenCalledOnce()
    expect(receiver.state).toBe(before)
    expect(Object.keys(receiver.state.unappliedProposals)).toHaveLength(0)
    const saved = vi.fn()
    await receiver.processMessage(message, { persist: saved })
    expect(saved).toHaveBeenCalledOnce()
    expect(Object.keys(receiver.state.unappliedProposals)).toHaveLength(1)
  })

  test('failed persist does not retain a newly resolved entry body', async () => {
    const alice = randomIdentity()
    const bob = randomIdentity()
    const bodies = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.flatMap((id) => {
        const body = bodies.get(id)
        return body == null ? [] : [body]
      })
    const { group: original } = await createGroup(alice, 'persist-body-rollback', {
      resolveLedgerEntries,
    })
    const { invite } = await createInvite({
      group: original,
      identity: alice,
      recipientDID: bob.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) bodies.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(original, bundle.publicPackage, invite)
    const { group: receiver } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: { resolveLedgerEntries },
    })
    const note = await signLedgerEntry(alice, {
      type: 'note',
      groupID: receiver.groupID,
      subject: bob.id,
      value: 'body',
    })
    const id = ledgerEntryDigest(note)
    bodies.set(id, note)
    const committed = await commitLedgerEntries(added.newGroup, [note])
    await expect(
      receiver.processMessage(committed.commitMessage, {
        persist: () => {
          throw new Error('disk failed')
        },
      }),
    ).rejects.toThrow('disk failed')
    bodies.delete(id)
    await expect(receiver.processMessage(committed.commitMessage)).rejects.toThrow(
      MissingLedgerEntriesError,
    )
    bodies.set(id, note)
    await receiver.processMessage(committed.commitMessage)
  })
})
