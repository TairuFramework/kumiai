import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { randomIdentity } from '@kokuin/token'
import type { CryptoProvider, GenerationSecret } from 'ts-mls'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { decodeClientState, encodeClientState } from '../src/codec.js'
import { nobleCryptoProvider } from '../src/crypto.js'
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
import { deriveGroup } from '../src/group-handle.js'
import { proposeSelfRemoval } from '../src/index.js'
import { ledgerEntryDigest } from '../src/ledger.js'
import type { Invite } from '../src/types.js'
import {
  agent,
  lowLevelWelcome,
  pipelineGroup,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

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

/** A sender whose leaf binding expired before the tree's clock — the lapse `encrypt` refuses. */
async function lapsedSender(): Promise<GroupHandle> {
  vi.spyOn(Date, 'now').mockReturnValue(100_000)
  const { group } = await pipelineGroup()
  const bob = agent(61)
  const first = await lowLevelWelcome(
    group,
    bob,
    await timedBinding({ identity: bob, iat: 90, exp: 99 }),
  )
  const carol = agent(71)
  const second = await lowLevelWelcome(
    first.author,
    carol,
    await timedBinding({ identity: carol, iat: 95, exp: 200 }),
  )
  await first.joined.processMessage(second.message)
  return first.joined
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

/** Wraps the noble provider so a test can make `kdf.expand` throw at a chosen call. */
function faultyProvider() {
  const control = { failAt: -1, calls: 0, derived: [] as Array<Uint8Array> }
  const provider: CryptoProvider = {
    async getCiphersuiteImpl(id) {
      const suite = await nobleCryptoProvider.getCiphersuiteImpl(id)
      const kdf = suite.kdf
      return {
        ...suite,
        kdf: {
          size: kdf.size,
          extract: (salt, ikm) => kdf.extract(salt, ikm),
          expand: async (prk, info, length) => {
            if (control.failAt >= 0 && control.calls++ === control.failAt) {
              throw new Error('injected kdf failure')
            }
            const out = await kdf.expand(prk, info, length)
            if (control.failAt >= 0) control.derived.push(out)
            return out
          },
        },
      }
    },
  }
  return { control, provider }
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

  test('refuses a target that is not a uint32 generation with one after it', async () => {
    const { bobGroup } = await twoMemberGroup('advance-range')
    for (const target of [-1, 1.5, Number.NaN, 0xffffffff, 2 ** 32]) {
      await expect(bobGroup.advanceSenderGeneration(target)).rejects.toThrow(RangeError)
    }
    expect(ownApplication(bobGroup)).toBeUndefined()
  })

  test('maxSteps refuses a longer advance before taking any step', async () => {
    const { bobGroup } = await twoMemberGroup('advance-max-steps')
    // Underived leaf: the distance is measured from generation 0.
    await expect(bobGroup.advanceSenderGeneration(201, { maxSteps: 200 })).rejects.toThrow(
      RangeError,
    )
    expect(ownApplication(bobGroup)).toBeUndefined()

    await emptyEncrypts(bobGroup, 3)
    const before = encodeClientState(bobGroup.state)
    await expect(bobGroup.advanceSenderGeneration(204, { maxSteps: 200 })).rejects.toThrow(
      RangeError,
    )
    for (const maxSteps of [-1, 1.5, Number.NaN]) {
      await expect(bobGroup.advanceSenderGeneration(10, { maxSteps })).rejects.toThrow(RangeError)
    }
    expect(encodeClientState(bobGroup.state)).toEqual(before)

    await bobGroup.advanceSenderGeneration(203, { maxSteps: 200 })
    expect(senderGeneration(bobGroup)).toBe(203)
    // No default cap: a stored high-water mark may sit far past every receiver.
    await bobGroup.advanceSenderGeneration(1203)
    expect(senderGeneration(bobGroup)).toBe(1203)
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

  describe('refuses exactly where encrypt refuses', () => {
    afterEach(() => vi.restoreAllMocks())

    test.each([
      {
        label: 'removed from the group',
        setup: async () => {
          const { aliceGroup, bobGroup } = await twoMemberGroup('advance-refuse-removed')
          const removed = await removeMember(aliceGroup, bobGroup.state.privatePath.leafIndex)
          await bobGroup.processMessage(removed.commitMessage)
          expect(bobGroup.state.groupActiveState.kind).toBe('removedFromGroup')
          return bobGroup
        },
      },
      {
        label: 'holding unapplied proposals',
        setup: async () => {
          const { bobGroup } = await twoMemberGroup('advance-refuse-proposals')
          await proposeSelfRemoval(bobGroup)
          expect(Object.keys(bobGroup.state.unappliedProposals)).not.toHaveLength(0)
          return bobGroup
        },
      },
      {
        label: 'suspended pending reinit',
        setup: async () => {
          const { bobGroup } = await twoMemberGroup('advance-refuse-suspended')
          const { groupContext } = bobGroup.state
          return deriveGroup(bobGroup, {
            ...bobGroup.state,
            groupActiveState: {
              kind: 'suspendedPendingReinit',
              reinit: {
                groupId: groupContext.groupId,
                version: groupContext.version,
                cipherSuite: groupContext.cipherSuite,
                extensions: [],
              },
            },
          })
        },
      },
      { label: 'on a lapsed leaf', setup: lapsedSender },
    ])('when $label', async ({ setup }) => {
      const group = await setup()
      const before = encodeClientState(group.state)
      const encryptError = await rejection(group.encrypt(new Uint8Array()))
      expect(encodeClientState(group.state)).toEqual(before)

      const advanceError = await rejection(
        group.advanceSenderGeneration(senderGeneration(group) + 10),
      )
      expect(advanceError.constructor).toBe(encryptError.constructor)
      expect(advanceError.name).toBe(encryptError.name)
      expect(advanceError.message).toBe(encryptError.message)
      expect(encodeClientState(group.state)).toEqual(before)
    })

    test('the mirrored send check matches the ts-mls release it was copied from', () => {
      const entry = createRequire(import.meta.url).resolve('ts-mls')
      let directory = dirname(entry)
      while (!directory.endsWith(join('node_modules', 'ts-mls'))) directory = dirname(directory)
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      expect(manifest.version).toBe('2.0.0-rc.13')
    })
  })

  describe('a KDF failure midway leaves the handle as it was', () => {
    test('zeroes every secret the loop derived on an already-derived leaf', async () => {
      const { aliceGroup, bobGroup } = await twoMemberGroup('advance-fault-derived')
      await emptyEncrypts(bobGroup, 2)
      const { control, provider } = faultyProvider()
      const state = decodeClientState(encodeClientState(bobGroup.state))
      if (state == null) throw new Error('state did not round-trip')
      const group = await restoreGroup({
        state,
        credential: bobGroup.credential,
        ledgerEntries: bobGroup.ledgerTokens,
        options: { cryptoProvider: provider },
      })
      const chainSecret = ownApplication(group)?.secret.slice()
      const before = encodeClientState(group.state)

      control.failAt = 5
      await expect(group.advanceSenderGeneration(40)).rejects.toThrow('injected kdf failure')
      expect(control.derived).toHaveLength(5)
      for (const secret of control.derived) expect(secret.every((byte) => byte === 0)).toBe(true)
      expect(encodeClientState(group.state)).toEqual(before)
      expect(ownApplication(group)?.secret).toEqual(chainSecret)

      control.failAt = -1
      const opened = await aliceGroup.decrypt(await group.encrypt(utf8.encode('still sends')))
      expect(new TextDecoder().decode(opened.payload)).toBe('still sends')
    })

    test('keeps the leaf underived when the failure follows its derivation', async () => {
      const { aliceGroup, bobGroup } = await twoMemberGroup('advance-fault-underived')
      const { control, provider } = faultyProvider()
      const state = decodeClientState(encodeClientState(bobGroup.state))
      if (state == null) throw new Error('state did not round-trip')
      const group = await restoreGroup({
        state,
        credential: bobGroup.credential,
        ledgerEntries: bobGroup.ledgerTokens,
        options: { cryptoProvider: provider },
      })
      const before = encodeClientState(group.state)

      const counting = faultyProvider()
      const twin = await restoreGroup({
        state: decodeClientState(before) ?? state,
        credential: bobGroup.credential,
        ledgerEntries: bobGroup.ledgerTokens,
        options: { cryptoProvider: counting.provider },
      })
      counting.control.failAt = Number.POSITIVE_INFINITY
      await twin.encrypt(new Uint8Array())
      const encryptCalls = counting.control.calls

      control.failAt = encryptCalls + 5
      await expect(group.advanceSenderGeneration(400)).rejects.toThrow('injected kdf failure')
      expect(ownApplication(group)).toBeUndefined()
      expect(encodeClientState(group.state)).toEqual(before)
      const chain = control.derived.slice(encryptCalls)
      expect(chain).toHaveLength(5)
      for (const secret of chain) expect(secret.every((byte) => byte === 0)).toBe(true)

      control.failAt = -1
      const opened = await aliceGroup.decrypt(await group.encrypt(utf8.encode('still sends')))
      expect(new TextDecoder().decode(opened.payload)).toBe('still sends')
    })
  })

  test('costs hash steps, not encrypts', async () => {
    const steps = 500
    const rounds = 3
    const { bobGroup } = await twoMemberGroup('advance-cost')
    await emptyEncrypts(bobGroup, 1)
    const advanced = await reload(bobGroup)
    const encrypted = await reload(bobGroup)
    // Warm both paths so neither pays first-call JIT cost inside the timed region.
    await advanced.advanceSenderGeneration(senderGeneration(advanced) + 10)
    await emptyEncrypts(encrypted, 10)

    const median = (values: Array<number>): number =>
      values.sort((a, b) => a - b)[values.length >> 1] ?? Number.NaN
    const advanceMs: Array<number> = []
    const encryptMs: Array<number> = []
    for (let round = 0; round < rounds; round++) {
      let started = performance.now()
      await advanced.advanceSenderGeneration(senderGeneration(advanced) + steps)
      advanceMs.push(performance.now() - started)
      started = performance.now()
      await emptyEncrypts(encrypted, steps)
      encryptMs.push(performance.now() - started)
    }

    expect(senderGeneration(advanced)).toBe(senderGeneration(encrypted))
    expect(median(encryptMs) / median(advanceMs)).toBeGreaterThanOrEqual(5)
  }, 60_000)
})
