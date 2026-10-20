import { randomIdentity } from '@kokuin/token'
import type { GenerationSecret } from 'ts-mls'
import { describe, expect, test } from 'vitest'

import { decodeClientState, encodeClientState } from '../src/codec.js'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  type GroupHandle,
  processWelcome,
  removeMember,
  restoreGroup,
} from '../src/group.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'

const utf8 = new TextEncoder()

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
  return { aliceGroup: added.newGroup, bobGroup }
}

/** An independent handle over a byte-for-byte copy of `group`'s persisted state. */
async function reload(group: GroupHandle): Promise<GroupHandle> {
  const state = decodeClientState(encodeClientState(group.state))
  if (state == null) throw new Error('state did not round-trip')
  return await restoreGroup({
    state,
    credential: group.credential,
    ledgerEntries: group.ledgerTokens,
  })
}

/** This member's own application ratchet, or undefined before its leaf secret is derived. */
function ownApplication(group: GroupHandle): GenerationSecret | undefined {
  const node = Number(group.state.privatePath.leafIndex) * 2
  return group.state.secretTree.leafNodes[node]?.application
}

/** The generation the next encrypt will use — the reading kubun's lease keeps. */
function senderGeneration(group: GroupHandle): number {
  return ownApplication(group)?.generation ?? 0
}

async function emptyEncrypts(group: GroupHandle, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await group.encrypt(new Uint8Array())
}

describe('GroupHandle.advanceSenderGeneration', () => {
  test.each([
    { label: 'an already-derived leaf', warmup: 3 },
    { label: 'a leaf whose secret is not yet derived', warmup: 0 },
  ])('matches the same number of empty encrypts from $label', async ({ warmup }) => {
    const { aliceGroup, bobGroup } = await twoMemberGroup(`advance-equivalence-${warmup}`)
    // Bob is the sender: as a fresh joiner he has never derived his own leaf secret.
    await emptyEncrypts(bobGroup, warmup)
    if (warmup === 0) expect(ownApplication(bobGroup)).toBeUndefined()
    const start = senderGeneration(bobGroup)
    expect(start).toBe(warmup)
    const target = start + 57

    const advanced = await reload(bobGroup)
    const encrypted = await reload(bobGroup)
    const replaced = ownApplication(advanced)?.secret
    await advanced.advanceSenderGeneration(target)
    await emptyEncrypts(encrypted, target - start)

    expect(senderGeneration(advanced)).toBe(target)
    // The whole persisted state, not only the ratchet: nothing else moved, and the chain
    // secret plus its retained-key map are exactly what the encrypts left behind.
    expect(encodeClientState(advanced.state)).toEqual(encodeClientState(encrypted.state))
    expect(advanced.epoch).toBe(bobGroup.epoch)
    // The spent chain secret is wiped, as encrypt wipes it.
    if (replaced != null) expect(replaced.every((byte) => byte === 0)).toBe(true)

    // Both now send at `target`, and a receiver at the pre-advance position opens each.
    const receiverA = await reload(aliceGroup)
    const receiverB = await reload(aliceGroup)
    const fromAdvanced = await receiverA.decrypt(await advanced.encrypt(utf8.encode('after')))
    const fromEncrypted = await receiverB.decrypt(await encrypted.encrypt(utf8.encode('after')))
    expect(new TextDecoder().decode(fromAdvanced.payload)).toBe('after')
    expect(new TextDecoder().decode(fromEncrypted.payload)).toBe('after')
    expect(encodeClientState(advanced.state)).toEqual(encodeClientState(encrypted.state))
  })

  test('is a no-op at or below the current generation', async () => {
    const { bobGroup } = await twoMemberGroup('advance-noop')
    // Not derived yet: advancing to 0 must not derive it.
    await bobGroup.advanceSenderGeneration(0)
    expect(ownApplication(bobGroup)).toBeUndefined()

    await emptyEncrypts(bobGroup, 5)
    const before = encodeClientState(bobGroup.state)
    await bobGroup.advanceSenderGeneration(5)
    await bobGroup.advanceSenderGeneration(2)
    await bobGroup.advanceSenderGeneration(0)
    expect(encodeClientState(bobGroup.state)).toEqual(before)
    expect(senderGeneration(bobGroup)).toBe(5)
  })

  test('refuses a target that is not a uint32 generation', async () => {
    const { bobGroup } = await twoMemberGroup('advance-range')
    for (const target of [-1, 1.5, Number.NaN, 2 ** 32]) {
      await expect(bobGroup.advanceSenderGeneration(target)).rejects.toThrow(RangeError)
    }
    expect(ownApplication(bobGroup)).toBeUndefined()
  })

  test('a receiver accepts the first frame across the skipped gap', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('advance-gap')
    const before = await bobGroup.encrypt(utf8.encode('before'))
    expect(new TextDecoder().decode((await aliceGroup.decrypt(before)).payload)).toBe('before')

    // 150 skipped generations: inside ts-mls's default 200-step receive window.
    await bobGroup.advanceSenderGeneration(senderGeneration(bobGroup) + 150)
    expect(senderGeneration(bobGroup)).toBe(151)
    const after = await aliceGroup.decrypt(await bobGroup.encrypt(utf8.encode('after')))
    expect(new TextDecoder().decode(after.payload)).toBe('after')
  })

  test('a removed member cannot advance, with the error encrypt throws', async () => {
    const { aliceGroup, bobGroup } = await twoMemberGroup('advance-removed')
    const removed = await removeMember(aliceGroup, bobGroup.state.privatePath.leafIndex)
    await bobGroup.processMessage(removed.commitMessage)
    expect(bobGroup.state.groupActiveState.kind).toBe('removedFromGroup')

    const encryptError = await bobGroup.encrypt(new Uint8Array()).then(
      () => null,
      (error: unknown) => error,
    )
    expect(encryptError).toBeInstanceOf(Error)
    const before = encodeClientState(bobGroup.state)
    await expect(bobGroup.advanceSenderGeneration(10)).rejects.toMatchObject({
      name: (encryptError as Error).name,
      message: (encryptError as Error).message,
    })
    expect(encodeClientState(bobGroup.state)).toEqual(before)
  })

  test('costs hash steps, not encrypts', async () => {
    const steps = 2000
    const { bobGroup } = await twoMemberGroup('advance-cost')
    await emptyEncrypts(bobGroup, 1)
    const advanced = await reload(bobGroup)
    const encrypted = await reload(bobGroup)
    // Warm both paths so neither pays first-call JIT cost inside the timed region.
    await advanced.advanceSenderGeneration(senderGeneration(advanced) + 10)
    await emptyEncrypts(encrypted, 10)

    let started = performance.now()
    await advanced.advanceSenderGeneration(senderGeneration(advanced) + steps)
    const advanceMs = performance.now() - started
    started = performance.now()
    await emptyEncrypts(encrypted, steps)
    const encryptMs = performance.now() - started

    expect(senderGeneration(advanced)).toBe(senderGeneration(encrypted))
    expect(encryptMs / advanceMs).toBeGreaterThanOrEqual(20)
  }, 60_000)
})
