import * as tokenModule from '@kokuin/token'
import { randomIdentity } from '@kokuin/token'
import {
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  getOwnLeafNode,
} from 'ts-mls'
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
import { deviceDenyHolderFor } from '../src/group-context.js'
import {
  deriveGroup,
  emitterOf,
  GroupHandle,
  mutexFor,
  VERIFIED_LEDGER_TOKEN_CACHE_SIZE,
} from '../src/group-handle.js'
import * as ledgerModule from '../src/ledger.js'
import { ledgerEntryDigest, signLedgerEntry } from '../src/ledger.js'

vi.mock('@kokuin/token', { spy: true })

const utf8 = new TextEncoder()
afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const alice = randomIdentity()
  const bob = randomIdentity()
  const tokens = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = tokens.get(id)
      if (token == null) throw new Error('Missing entry')
      return token
    })
  const onLedgerEntries = vi.fn()
  const commitPolicy = vi.fn(() => 'accept' as const)
  const { group: created } = await createGroup(alice, 'clone', {
    resolveLedgerEntries,
    onLedgerEntries,
    commitPolicy,
  })
  const { invite } = await createInvite({
    group: created,
    identity: alice,
    recipientDID: bob.id,
    permission: 'member',
  })
  for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
  const bundle = await createKeyPackageBundle(bob)
  const added = await commitInvite(created, bundle.publicPackage, invite)
  const { group: receiver } = await processWelcome({
    identity: bob,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
    ratchetTree: added.newGroup.state.ratchetTree,
    options: { resolveLedgerEntries, onLedgerEntries, commitPolicy },
  })
  added.newGroup.confirmAdopted()
  return { sender: added.newGroup, receiver, alice, bob, tokens }
}

function objects(value: unknown, seen = new Set<object>()): Set<object> {
  if (value == null || typeof value !== 'object' || seen.has(value)) return seen
  seen.add(value)
  if (ArrayBuffer.isView(value)) objects(value.buffer, seen)
  else if (value instanceof Map) {
    for (const [key, item] of value) {
      objects(key, seen)
      objects(item, seen)
    }
  } else if (value instanceof Set) {
    for (const item of value) objects(item, seen)
  } else {
    for (const item of Object.values(value)) objects(item, seen)
  }
  return seen
}

describe('GroupHandle.clone', () => {
  test('matches a serialized restore and shares no mutable state objects or buffers', async () => {
    const { receiver } = await fixture()
    const state = decodeClientState(encodeClientState(receiver.state))
    if (state == null) throw new Error('Missing state')
    const restored = await restoreGroup({
      state,
      credential: receiver.credential,
      ledgerEntries: [...receiver.ledgerTokens],
    })
    const clone = receiver.clone()
    expect(clone.epoch).toBe(restored.epoch)
    expect(clone.listMembers()).toEqual(restored.listMembers())
    expect(clone.roster).toEqual(restored.roster)
    expect(clone.registry).toEqual(restored.registry)
    expect(clone.ledgerTokens).toEqual(restored.ledgerTokens)
    expect(clone.sendAdmission()).toEqual(receiver.sendAdmission())
    expect(encodeClientState(clone.state)).toEqual(encodeClientState(restored.state))
    const originalObjects = objects({
      state: receiver.state,
      credential: receiver.credential,
      anchor: receiver.anchor,
      ledger: receiver.ledger,
      roster: receiver.roster,
      registry: receiver.registry,
    })
    for (const object of objects({
      state: clone.state,
      credential: clone.credential,
      anchor: clone.anchor,
      ledger: clone.ledger,
      roster: clone.roster,
      registry: clone.registry,
    }))
      expect(originalObjects.has(object)).toBe(false)
  })

  test.each(['original', 'clone'])(
    'deep-copies populated proposals, history, keys and reservation when mutating the %s',
    async (side) => {
      const { sender, receiver } = await fixture()
      const proposal = await receiver.proposeSelfRemoval()
      await sender.processMessage(proposal.frame)
      sender.state.handshakeReservation = { epoch: sender.epoch, generation: 3, consumed: false }
      expect(Object.keys(sender.state.unappliedProposals).length).toBeGreaterThan(0)
      expect(sender.state.historicalReceiverData.size).toBeGreaterThan(0)
      const clone = sender.clone()
      expect(clone.state).toEqual(sender.state)
      const originalObjects = objects(sender.state)
      for (const object of objects(clone.state)) expect(originalObjects.has(object)).toBe(false)
      const mutated = side === 'original' ? sender : clone
      const untouched = side === 'original' ? clone : sender
      const before = encodeClientState(untouched.state)
      for (const object of objects(mutated.state)) {
        if (object instanceof Uint8Array) object.fill(0)
      }
      mutated.state.unappliedProposals = {}
      mutated.state.historicalReceiverData.clear()
      if (mutated.state.handshakeReservation != null) {
        mutated.state.handshakeReservation.consumed = true
      }
      expect(encodeClientState(untouched.state)).toEqual(before)
    },
  )

  test('isolates receive and send ratchets in both directions, including erased secrets', async () => {
    const { sender, receiver } = await fixture()
    const clone = receiver.clone()
    const before = encodeClientState(receiver.state)
    const first = await sender.encrypt(utf8.encode('first'))
    await expect(clone.decrypt(first)).resolves.toMatchObject({ payload: utf8.encode('first') })
    expect(encodeClientState(receiver.state)).toEqual(before)
    await expect(receiver.decrypt(first)).resolves.toMatchObject({ payload: utf8.encode('first') })
    const clonedBefore = encodeClientState(clone.state)
    const second = await sender.encrypt(utf8.encode('second'))
    await receiver.decrypt(second)
    expect(encodeClientState(clone.state)).toEqual(clonedBefore)
    await expect(clone.decrypt(second)).resolves.toMatchObject({ payload: utf8.encode('second') })
    const receiverBeforeSend = encodeClientState(receiver.state)
    const sent = await clone.encrypt(utf8.encode('reply'))
    expect(encodeClientState(receiver.state)).toEqual(receiverBeforeSend)
    await expect(sender.decrypt(sent)).resolves.toMatchObject({ payload: utf8.encode('reply') })
    const cloneBeforeSend = encodeClientState(clone.state)
    await receiver.encrypt(utf8.encode('independent reply'))
    expect(encodeClientState(clone.state)).toEqual(cloneBeforeSend)
  })

  test.each(['original', 'clone'])(
    'isolates commits and ledger appends on the %s',
    async (side) => {
      const { sender, receiver, alice, bob, tokens } = await fixture()
      const clone = receiver.clone()
      const advanced = side === 'original' ? receiver : clone
      const untouched = side === 'original' ? clone : receiver
      const before = encodeClientState(untouched.state)
      const ledger = untouched.ledgerTokens
      const role = await signLedgerEntry(alice, {
        type: 'kumiai.role',
        groupID: sender.groupID,
        subject: bob.id,
        value: 'admin',
      })
      tokens.set(ledgerEntryDigest(role), role)
      const commit = await commitLedgerEntries(sender, [role])
      await advanced.processMessage(commit.commitMessage)
      expect(advanced.epoch).toBe(untouched.epoch + 1n)
      expect(advanced.ledgerTokens).toHaveLength(ledger.length + 1)
      expect(untouched.ledgerTokens).toEqual(ledger)
      expect(encodeClientState(untouched.state)).toEqual(before)
      await untouched.processMessage(commit.commitMessage)
      const sealed = await commit.newGroup.encrypt(utf8.encode('after commit'))
      await expect(receiver.decrypt(sealed)).resolves.toMatchObject({
        payload: utf8.encode('after commit'),
      })
      await expect(clone.decrypt(sealed)).resolves.toMatchObject({
        payload: utf8.encode('after commit'),
      })
    },
  )

  test('isolates events, mutexes, deny holders and context configuration', async () => {
    const { receiver } = await fixture()
    receiver.context.clientConfig = {
      keyRetentionConfig: { ...defaultKeyRetentionConfig },
      keyPackageEqualityConfig: { ...defaultKeyPackageEqualityConfig },
      lifetimeConfig: { ...defaultLifetimeConfig },
      paddingConfig: { ...defaultPaddingConfig },
    }
    receiver.context.externalPsks = { example: new Uint8Array([1, 2]) }
    const holder = deviceDenyHolderFor(receiver.context)
    const provider = holder?.provider
    const clone = receiver.clone()
    expect(deviceDenyHolderFor(clone.context)).not.toBe(holder)
    expect(holder?.provider).toBe(provider)
    const originalDeny = new Set(['did:example:original'])
    const clonedDeny = new Set(['did:example:clone'])
    vi.spyOn(receiver, 'currentDenySet').mockReturnValue(originalDeny)
    vi.spyOn(clone, 'currentDenySet').mockReturnValue(clonedDeny)
    expect(holder?.provider()).toBe(originalDeny)
    expect(deviceDenyHolderFor(clone.context)?.provider()).toBe(clonedDeny)
    if (clone.context.clientConfig == null) throw new Error('Missing config')
    const bundle = await createKeyPackageBundle(randomIdentity())
    const equality = clone.context.clientConfig.keyPackageEqualityConfig
    expect(equality.compareKeyPackages(bundle.publicPackage, bundle.publicPackage)).toBe(true)
    expect(
      equality.compareKeyPackageToLeafNode(bundle.publicPackage, bundle.publicPackage.leafNode),
    ).toBe(true)
    equality.compareKeyPackages = () => false
    expect(
      receiver.context.clientConfig?.keyPackageEqualityConfig.compareKeyPackages(
        bundle.publicPackage,
        bundle.publicPackage,
      ),
    ).toBe(true)
    clone.context.clientConfig.keyRetentionConfig.retainKeysForEpochs = 99
    expect(receiver.context.clientConfig?.keyRetentionConfig.retainKeysForEpochs).toBe(4)
    clone.context.externalPsks?.example?.fill(0)
    expect(receiver.context.externalPsks.example).toEqual(new Uint8Array([1, 2]))
    expect(mutexFor(clone)).not.toBe(mutexFor(receiver))
    const originalEvent = vi.fn()
    const clonedEvent = vi.fn()
    receiver.events.on('controllerBeaconChanged', originalEvent)
    clone.events.on('controllerBeaconChanged', clonedEvent)
    const event = { controller: receiver.credential.id, logLength: 1, headDigest: 'head' }
    emitterOf(clone).fire('controllerBeaconChanged', event)
    expect(clonedEvent).toHaveBeenCalledOnce()
    expect(originalEvent).not.toHaveBeenCalled()
    emitterOf(receiver).fire('controllerBeaconChanged', event)
    expect(originalEvent).toHaveBeenCalledOnce()
    expect(clonedEvent).toHaveBeenCalledOnce()
  })

  test('preserves externally supplied authentication behaviour in a fresh service wrapper', async () => {
    const { receiver } = await fixture()
    const authService = { validateCredential: vi.fn(async () => false) }
    const external = new GroupHandle({
      state: structuredClone(receiver.state),
      credential: structuredClone(receiver.credential),
      context: { ...receiver.context, authService },
      ledger: receiver.ledger,
    })
    const clone = external.clone()
    expect(clone.context).not.toBe(external.context)
    expect(clone.context.authService).not.toBe(authService)
    const leaf = getOwnLeafNode(clone.state)
    await expect(
      clone.context.authService.validateCredential(leaf.credential, leaf.signaturePublicKey),
    ).resolves.toBe(false)
    expect(authService.validateCredential).toHaveBeenCalledOnce()
    await expect(
      clone
        .clone()
        .context.authService.validateCredential(leaf.credential, leaf.signaturePublicKey),
    ).resolves.toBe(false)
    clone.context.authService.validateCredential = async () => true
    await expect(
      external.context.authService.validateCredential(leaf.credential, leaf.signaturePublicKey),
    ).resolves.toBe(false)
  })

  test('inherits callbacks, supports overrides, and starts non-speculative', async () => {
    const { receiver } = await fixture()
    const staged = deriveGroup(receiver, structuredClone(receiver.state))
    const beacon = {
      issuer: receiver.credential.id,
      entry: {
        type: 'kumiai.device',
        groupID: receiver.groupID,
        subject: receiver.credential.id,
        value: { op: 'beacon', logLength: 1, headDigest: 'head' },
      },
    }
    staged.emitControlEvents([beacon])
    const clone = staged.clone()
    expect(clone.commitPolicy).toBe(receiver.commitPolicy)
    expect(clone.resolveLedgerEntries).toBe(receiver.resolveLedgerEntries)
    expect(clone.onLedgerEntries).toBe(receiver.onLedgerEntries)
    const resolveLedgerEntries = vi.fn(async () => [])
    const onLedgerEntries = vi.fn()
    const overridden = receiver.clone({ resolveLedgerEntries, onLedgerEntries })
    expect(overridden.resolveLedgerEntries).toBe(resolveLedgerEntries)
    expect(overridden.onLedgerEntries).toBe(onLedgerEntries)
    const event = vi.fn()
    clone.events.on('controllerBeaconChanged', event)
    clone.confirmAdopted()
    expect(event).not.toHaveBeenCalled()
    const sourceEvent = vi.fn()
    staged.events.on('controllerBeaconChanged', sourceEvent)
    staged.confirmAdopted()
    expect(sourceEvent).toHaveBeenCalledOnce()
    expect(event).not.toHaveBeenCalled()
    clone.emitControlEvents([beacon])
    expect(event).toHaveBeenCalledOnce()
    clone.confirmAdopted()
    expect(event).toHaveBeenCalledOnce()
  })

  test('does no token decode, verification, digest or time-claim work', async () => {
    const { receiver } = await fixture()
    const decode = vi.mocked(tokenModule.decodeSignedToken).mockClear()
    const time = vi.mocked(tokenModule.assertTimeClaimsValid).mockClear()
    const verify = vi.spyOn(ledgerModule, 'verifyLedgerEntry')
    const digest = vi.spyOn(ledgerModule, 'ledgerEntryDigest')
    // Await also catches an accidental asynchronous serialize/restore implementation.
    const clone = await receiver.clone()
    expect(clone.ledgerTokens).toEqual(receiver.ledgerTokens)
    expect(decode).not.toHaveBeenCalled()
    expect(time).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(digest).not.toHaveBeenCalled()
  })

  test('retains verification provenance independently of exposed claims', async () => {
    const { receiver, alice } = await fixture()
    // Evict the content cache so only the per-entry provenance can preserve this snapshot.
    const { group: filler } = await createGroup(alice, 'clone-cache-eviction')
    const fillers: Array<string> = []
    for (let index = 0; index <= VERIFIED_LEDGER_TOKEN_CACHE_SIZE; index++) {
      fillers.push(
        await signLedgerEntry(alice, {
          type: 'app.record',
          groupID: filler.groupID,
          subject: alice.id,
          value: index,
        }),
      )
    }
    await filler.applyLedgerEntries(fillers)
    const clone = receiver.clone()
    const held = clone.ledger[0]
    if (held == null) throw new Error('Missing entry')
    const originalSubject = held.verified.entry.subject
    held.verified.entry.subject = 'did:example:tampered'
    expect(receiver.ledger[0]?.verified.entry.subject).toBe(originalSubject)
    const tokens = clone.ledgerTokens
    const verify = vi.spyOn(ledgerModule, 'verifyLedgerEntry')
    await clone.applyLedgerEntries(tokens)
    expect(clone.ledger.at(-1)?.verified.entry.subject).toBe(originalSubject)
    expect(verify).not.toHaveBeenCalled()
  })
})
