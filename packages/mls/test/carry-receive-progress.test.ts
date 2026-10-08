import { randomIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { decodeClientState, encodeClientState } from '../src/codec.js'
import type { GroupHandle, Invite } from '../src/index.js'
import * as mls from '../src/index.js'

const utf8 = new TextEncoder()

async function restore(group: GroupHandle) {
  const state = decodeClientState(encodeClientState(group.state))
  if (state == null) throw new Error('failed to decode state')
  return mls.restoreGroup({ state, credential: group.credential })
}

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
  const buildInvite = async (group: GroupHandle, recipientDID: string) => {
    const { invite } = await mls.createInvite({
      group,
      identity: alice,
      recipientDID,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) tokens.set(mls.ledgerEntryDigest(token), token)
    return invite
  }
  const { group: created } = await mls.createGroup(alice, groupID, { resolveLedgerEntries })
  const earlierSender = await restore(created)
  const invite: Invite = await buildInvite(created, bob.id)
  const bundle = await mls.createKeyPackageBundle(bob)
  const added = await mls.commitInvite(created, bundle.publicPackage, invite)
  const { group: bobGroup } = await mls.processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries },
  })
  const aliceGroup = added.newGroup
  const charlie = randomIdentity()
  const nextInvite = await buildInvite(aliceGroup, charlie.id)
  const nextBundle = await mls.createKeyPackageBundle(charlie)
  const { newGroup: candidate } = await mls.commitInvite(
    aliceGroup,
    nextBundle.publicPackage,
    nextInvite,
  )
  return { aliceGroup, bobGroup, candidate, earlierSender }
}

describe('GroupHandle.carryReceiveProgress', () => {
  test('open after build does not reopen', async () => {
    const { aliceGroup, bobGroup, candidate } = await fixture('carry-open')
    const frame1 = await bobGroup.encrypt(utf8.encode('one'))
    const frame2 = await bobGroup.encrypt(utf8.encode('two'))
    const nextTree = structuredClone(candidate.state.secretTree)
    const nextAuthenticator = candidate.state.keySchedule.epochAuthenticator.slice()
    await expect(aliceGroup.decrypt(frame1)).resolves.toMatchObject({ payload: utf8.encode('one') })

    await aliceGroup.carryReceiveProgress(candidate)
    expect(candidate.epoch).toBe(2n)
    expect(candidate.state.secretTree).toEqual(nextTree)
    expect(candidate.state.keySchedule.epochAuthenticator).toEqual(nextAuthenticator)
    const adopted = await restore(candidate)
    await expect(adopted.decrypt(frame1)).rejects.toThrow()
    await expect(adopted.decrypt(frame2)).resolves.toMatchObject({ payload: utf8.encode('two') })
  })

  test('seal after build never repeats a generation', async () => {
    const { aliceGroup, candidate } = await fixture('carry-seal')
    const epoch = aliceGroup.epoch
    const leaf = aliceGroup.state.privatePath.leafIndex * 2
    // An unexpanded leaf has not consumed an application generation.
    expect(
      candidate.state.historicalReceiverData.get(epoch)?.secretTree.leafNodes[leaf]?.application
        .generation ?? 0,
    ).toBe(0)
    await aliceGroup.encrypt(utf8.encode('one'))
    await aliceGroup.encrypt(utf8.encode('two'))

    await aliceGroup.carryReceiveProgress(candidate)
    expect(aliceGroup.state.secretTree.leafNodes[leaf]?.application.generation).toBe(2)
    expect(
      candidate.state.historicalReceiverData.get(epoch)?.secretTree.leafNodes[leaf]?.application
        .generation,
    ).toBe(2)
  })

  test('evicted epoch not resurrected', async () => {
    const { aliceGroup, candidate } = await fixture('carry-evicted')
    const retained = structuredClone(candidate.state.historicalReceiverData.get(0n))
    expect(retained).toBeDefined()
    const epochs = [...candidate.state.historicalReceiverData.keys()]
    aliceGroup.state.historicalReceiverData.delete(0n)

    await aliceGroup.carryReceiveProgress(candidate)
    expect([...candidate.state.historicalReceiverData.keys()]).toEqual(epochs)
    expect(candidate.state.historicalReceiverData.get(0n)).toEqual(retained)
    expect(aliceGroup.state.historicalReceiverData.has(0n)).toBe(false)
  })

  test('carries earlier retained epoch progress without adding absent epochs', async () => {
    const { aliceGroup, candidate, earlierSender } = await fixture('carry-earlier')
    const frame = await earlierSender.encrypt(utf8.encode('earlier'))
    await aliceGroup.decrypt(frame)
    await aliceGroup.carryReceiveProgress(candidate)
    await expect(candidate.decrypt(frame)).rejects.toThrow()

    candidate.state.historicalReceiverData.delete(0n)
    await aliceGroup.carryReceiveProgress(candidate)
    expect([...candidate.state.historicalReceiverData.keys()]).toEqual([1n])
  })

  test('carry under interleaved seal serialises with an in-flight decrypt', async () => {
    const { aliceGroup, bobGroup, candidate } = await fixture('carry-interleaved')
    const frame1 = await bobGroup.encrypt(utf8.encode('one'))
    const frame2 = await bobGroup.encrypt(utf8.encode('two'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const opening = aliceGroup.decryptStaged(frame1, {}, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const decrypting = aliceGroup.decrypt(frame2)
    const carrying = aliceGroup.carryReceiveProgress(candidate)
    const sealing = aliceGroup.encrypt(utf8.encode('after carry'))
    release.resolve()
    await Promise.all([opening, decrypting, carrying, sealing])

    await expect(candidate.decrypt(frame1)).rejects.toThrow()
    await expect(candidate.decrypt(frame2)).rejects.toThrow()
  })

  test('copied secrets survive later use of the current handle', async () => {
    const { aliceGroup, bobGroup, candidate } = await fixture('carry-copy')
    const frame1 = await bobGroup.encrypt(utf8.encode('one'))
    const frame2 = await bobGroup.encrypt(utf8.encode('two'))
    await aliceGroup.decrypt(frame1)
    await aliceGroup.carryReceiveProgress(candidate)
    await aliceGroup.decrypt(frame2)
    await expect(candidate.decrypt(frame2)).resolves.toMatchObject({ payload: utf8.encode('two') })
  })

  test('identity mismatch rejects without changing the candidate', async () => {
    const { aliceGroup } = await fixture('carry-identity')
    const { candidate } = await fixture('carry-identity')
    const before = encodeClientState(candidate.state)
    await expect(aliceGroup.carryReceiveProgress(candidate)).rejects.toBeInstanceOf(
      mls.CarryIdentityError,
    )
    expect(encodeClientState(candidate.state)).toEqual(before)
  })

  test('missing current epoch history rejects without changing the candidate', async () => {
    const { aliceGroup, candidate } = await fixture('carry-missing')
    candidate.state.historicalReceiverData.delete(aliceGroup.epoch)
    const before = encodeClientState(candidate.state)
    await expect(aliceGroup.carryReceiveProgress(candidate)).rejects.toBeInstanceOf(
      mls.CarryIdentityError,
    )
    expect(encodeClientState(candidate.state)).toEqual(before)
  })
})
