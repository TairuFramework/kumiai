import { randomIdentity, stringifyToken } from '@kokuin/token'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { decodeClientState, encodeClientState } from '../src/codec.js'
import {
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
  restoreGroup,
} from '../src/group.js'
import { deriveGroup } from '../src/group-handle.js'
import * as ledger from '../src/ledger.js'

async function fixture(groupID = 'ledger-memo') {
  const identity = randomIdentity()
  const { group } = await createGroup(identity, groupID)
  const restore = (tokens: Array<string>) => {
    const state = decodeClientState(encodeClientState(group.state))
    if (state == null) throw new Error('invalid stored state')
    return restoreGroup({ state, credential: group.credential, ledgerEntries: tokens })
  }
  const sign = (value: string) =>
    ledger.signLedgerEntry(identity, {
      type: 'app.value',
      groupID: group.groupID,
      subject: identity.id,
      value,
    })
  return { identity, group, restore, sign }
}

afterEach(() => vi.restoreAllMocks())

describe('verified ledger replay', () => {
  test('reopens and clones verify only new token bytes', async () => {
    const { group, restore, sign } = await fixture()
    const tokens = await Promise.all(['one', 'two', 'three'].map(sign))
    const verify = vi.spyOn(ledger, 'verifyLedgerEntry')
    const first = await restore(tokens)
    expect(verify).toHaveBeenCalledTimes(3)
    verify.mockClear()

    const reopened = await restore(tokens)
    const clone = deriveGroup(first, group.state)
    const cloned = await restore(clone.ledgerTokens)
    expect(reopened.ledgerTokens).toEqual(tokens)
    expect(cloned.ledgerTokens).toEqual(tokens)
    expect(verify).not.toHaveBeenCalled()

    tokens.push(await sign('four'))
    const extended = await restore(tokens)
    expect(extended.ledgerTokens).toEqual(tokens)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  test('restoring newly deserialised token arrays reuses verified content', async () => {
    const { restore, sign } = await fixture()
    const tokens = await Promise.all(['one', 'two', 'three'].map(sign))
    const verify = vi.spyOn(ledger, 'verifyLedgerEntry')

    expect((await restore(tokens)).ledgerTokens).toEqual(tokens)
    expect(
      (await restore(JSON.parse(JSON.stringify(tokens)) as Array<string>)).ledgerTokens,
    ).toEqual(tokens)
    expect(verify).toHaveBeenCalledTimes(tokens.length)
  })

  test('does not cache failed token verification', async () => {
    const { restore } = await fixture()
    const verify = vi.spyOn(ledger, 'verifyLedgerEntry')

    expect((await restore(['not-a-token'])).ledgerTokens).toEqual([])
    expect((await restore(['not-a-token'])).ledgerTokens).toEqual([])
    expect(verify).toHaveBeenCalledTimes(2)
  })

  test('rechecks expiry when content is reused by a new token array', async () => {
    const { identity, group, restore } = await fixture()
    const now = Math.floor(Date.now() / 1000)
    const tokens = [
      stringifyToken(
        await identity.signToken({
          type: 'app.value',
          groupID: group.groupID,
          subject: identity.id,
          value: 'one',
          exp: now + 60,
        }),
      ),
    ]
    expect((await restore(tokens)).ledgerTokens).toEqual(tokens)
    vi.spyOn(Date, 'now').mockReturnValue((now + 61) * 1000)
    expect(
      (await restore(JSON.parse(JSON.stringify(tokens)) as Array<string>)).ledgerTokens,
    ).toEqual([])
  })

  test('a tampered token at a memoised position is dropped', async () => {
    const { restore, sign } = await fixture()
    const original = await sign('one')
    const tokens = [original]
    await restore(tokens)
    expect((await restore(tokens)).ledgerTokens).toEqual([original])

    const start = original.lastIndexOf('.') + 1
    tokens[0] = `${original.slice(0, start)}${original[start] === 'A' ? 'B' : 'A'}${original.slice(start + 1)}`
    const restored = await restore(tokens)
    expect(restored.ledgerTokens).toEqual([])
  })

  test('a different issuer at a memoised position requires its own signature', async () => {
    const { restore, sign, group } = await fixture()
    const original = await sign('one')
    const tokens = [original]
    await restore(tokens)
    const other = randomIdentity()
    const replacement = await ledger.signLedgerEntry(other, {
      type: 'app.value',
      groupID: group.groupID,
      subject: other.id,
      value: 'two',
    })
    tokens[0] = replacement
    const restored = await restore(tokens)
    expect(restored.ledger[0]?.verified.issuer).toBe(other.id)
    expect(restored.ledger[0]?.verified.entry.value).toBe('two')

    tokens[0] = `${replacement.slice(0, replacement.lastIndexOf('.'))}${original.slice(original.lastIndexOf('.'))}`
    expect((await restore(tokens)).ledgerTokens).toEqual([])
  })

  test('mutating a returned claim cannot poison a later replay', async () => {
    const { restore, sign } = await fixture()
    const tokens = [await sign('one')]
    const first = await restore(tokens)
    const held = first.ledger[0]
    if (held == null) throw new Error('missing entry')
    held.verified.entry.value = 'forged'
    expect((await restore(first.ledgerTokens)).ledger[0]?.verified.entry.value).toBe('one')
  })

  test('mutating a memo hit cannot poison a later replay', async () => {
    const { restore, sign } = await fixture()
    const first = await restore([await sign('one')])
    const tokens = first.ledgerTokens
    const verify = vi.spyOn(ledger, 'verifyLedgerEntry')
    const reopened = await restore(tokens)
    expect(verify).not.toHaveBeenCalled()
    const held = reopened.ledger[0]
    if (held == null) throw new Error('missing entry')
    held.verified.entry.value = 'forged'
    expect((await restore(first.ledgerTokens)).ledger[0]?.verified.entry.value).toBe('one')
    expect(verify).not.toHaveBeenCalled()
  })

  test('a memo hit still rejects entries from another group', async () => {
    const alice = await fixture()
    const bob = await fixture('other-ledger-memo')
    expect(alice.group.groupID).not.toBe(bob.group.groupID)
    const token = await alice.sign('one')
    const first = await alice.restore([token])
    expect(first.ledgerTokens).toEqual([token])
    const tokens = first.ledgerTokens
    const verify = vi.spyOn(ledger, 'verifyLedgerEntry')

    const memoised = await bob.restore(tokens)
    expect(verify).not.toHaveBeenCalled()
    const uncached = await bob.restore([...tokens])
    expect(verify).not.toHaveBeenCalled()
    expect(uncached.ledger).toEqual([])
    expect(memoised.ledger).toEqual(uncached.ledger)
    expect(memoised.ledgerTokens).toEqual([])
  })

  test('re-enacting a token cannot memoise a mutated public claim', async () => {
    const { identity, group, sign } = await fixture()
    const bob = randomIdentity()
    const { invite } = await createInvite({
      group,
      identity,
      recipientDID: bob.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(bob)
    const added = await commitInvite(group, bundle.publicPackage, invite)
    const bodies = new Map<string, string>()
    const { group: receiver } = await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: added.newGroup.state.ratchetTree,
      options: {
        resolveLedgerEntries: async (ids) =>
          ids.map((id) => {
            const token = bodies.get(id)
            if (token == null) throw new Error('missing ledger token')
            return token
          }),
      },
    })
    const token = await sign('signed-value')
    bodies.set(ledger.ledgerEntryDigest(token), token)
    const first = await commitLedgerEntries(added.newGroup, [token])
    await receiver.processMessage(first.commitMessage)
    const held = receiver.ledger.find((entry) => entry.token === token)
    if (held == null) throw new Error('missing entry')
    held.verified.entry.value = 'forged-value'

    const second = await commitLedgerEntries(first.newGroup, [token])
    await receiver.processMessage(second.commitMessage)
    const state = decodeClientState(encodeClientState(receiver.state))
    if (state == null) throw new Error('invalid stored state')
    const restored = await restoreGroup({
      state,
      credential: receiver.credential,
      ledgerEntries: receiver.ledgerTokens,
    })
    expect(
      restored.ledger
        .filter((entry) => entry.token === token)
        .map(({ verified }) => verified.entry.value),
    ).toEqual(['signed-value', 'signed-value'])
  })

  test('a memo hit still checks token expiry', async () => {
    const { identity, group, restore } = await fixture()
    const now = Math.floor(Date.now() / 1000)
    const tokens = [
      stringifyToken(
        await identity.signToken({
          type: 'app.value',
          groupID: group.groupID,
          subject: identity.id,
          value: 'one',
          exp: now + 60,
        }),
      ),
    ]
    expect((await restore(tokens)).ledgerTokens).toEqual(tokens)
    vi.spyOn(Date, 'now').mockReturnValue((now + 61) * 1000)
    expect((await restore(tokens)).ledgerTokens).toEqual([])
  })
})
