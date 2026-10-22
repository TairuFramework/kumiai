import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomIdentity } from '@kokuin/token'
import {
  createProposal,
  decode,
  defaultProposalTypes,
  mlsMessageDecoder,
  wireformats,
} from 'ts-mls'
import { expect, test } from 'vitest'

import {
  commitInvite,
  commitKeyRotation,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  GroupHandle,
  processWelcome,
  restoreGroup,
  restrictCommitAuthoring,
  withCommitPermit,
} from '../src/index.js'
import { advanceSendingRatchet } from '../src/secret-tree.js'

const entry = createRequire(import.meta.url).resolve('ts-mls')
const { decryptSenderData } = (await import(
  new URL('./privateMessage.js', pathToFileURL(entry)).href
)) as {
  decryptSenderData: (
    message: unknown,
    secret: Uint8Array,
    suite: unknown,
  ) => Promise<{ generation: number } | undefined>
}

async function generation(source: GroupHandle, frame: Uint8Array): Promise<number> {
  const message = decode(mlsMessageDecoder, frame)
  if (message?.wireformat !== wireformats.mls_private_message) throw new Error('Not private')
  const sender = await decryptSenderData(
    message.privateMessage,
    source.state.keySchedule.senderDataSecret,
    source.context.cipherSuite,
  )
  if (sender === undefined) throw new Error('Missing sender data')
  return sender.generation
}

async function imported(params: {
  current: number
  reserved: number
  consumed: boolean
  epochDelta: bigint
  initialPeers?: number
}) {
  const creator = randomIdentity()
  const sender = randomIdentity()
  const { group } = await createGroup(creator, 'imported-reservation')
  let author = group
  for (let i = 0; i < (params.initialPeers ?? 0); i++) {
    const peer = randomIdentity()
    const { invite } = await createInvite({
      group: author,
      identity: creator,
      recipientDID: peer.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(peer)
    author = (await commitInvite(author, bundle.publicPackage, invite)).newGroup
  }
  const { invite } = await createInvite({
    group: author,
    identity: creator,
    recipientDID: sender.id,
    permission: 'member',
  })
  const bundle = await createKeyPackageBundle(sender)
  const added = await commitInvite(author, bundle.publicPackage, invite)
  const { group: source } = await processWelcome({
    identity: sender,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
  })
  let state = source.state
  for (let step = 0; step < params.current; step++) {
    const result = await createProposal({
      context: source.context,
      state,
      proposal: {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: state.privatePath.leafIndex },
      },
    })
    state = { ...state, secretTree: result.newState.secretTree }
  }
  // This encoder is main's unchanged v2 encoder, over real MLS keys and ratchets.
  const bytes = encodeClientState({
    ...state,
    handshakeReservation: {
      epoch: source.epoch + params.epochDelta,
      generation: params.reserved,
      consumed: params.consumed,
    },
  })
  expect(bytes[0]).toBe(2)
  expect(bytes[1]).toBe(1)
  expect(new DataView(bytes.buffer).getUint32(10)).toBe(params.reserved)
  expect(bytes[14]).toBe(Number(params.consumed))
  const restore = async (saved = bytes) => {
    const decoded = decodeClientState(saved)
    if (decoded === undefined) throw new Error('Invalid imported state')
    return restoreGroup({
      state: decoded,
      credential: source.credential,
      ledgerEntries: source.ledgerTokens,
    })
  }
  const construct = () => {
    const decoded = decodeClientState(bytes)
    if (decoded === undefined) throw new Error('Invalid imported state')
    return new GroupHandle({
      state: decoded,
      credential: source.credential,
      context: source.context,
      ledger: source.ledger,
    })
  }
  return { bytes, restore, construct, receiver: added.newGroup, epoch: source.epoch }
}

for (const path of ['restore', 'constructor'] as const) {
  for (const consumed of [false, true]) {
    for (const epochDelta of [0n, -1n]) {
      test.each(['commit', 'proposal'] as const)(
        `${path} clears a reservation before an unrestricted %s (consumed: ${consumed}, epoch delta: ${epochDelta})`,
        async (kind) => {
          const f = await imported({ consumed, current: 3, reserved: 3, epochDelta })
          const original = f.bytes.slice()
          const open = path === 'restore' ? f.restore : f.construct
          const restored = await open()
          const want = epochDelta === 0n ? 4 : 3
          if (kind === 'commit') {
            const built = await commitKeyRotation(restored)
            expect(await generation(restored, built.commitMessage)).toBe(want)
            await f.receiver.processMessage(built.commitMessage)
            expect(f.receiver.epoch).toBe(f.epoch + 1n)
            expect(f.receiver.state.keySchedule.epochAuthenticator).toEqual(
              built.newGroup.state.keySchedule.epochAuthenticator,
            )
          } else {
            const proposal = await restored.proposeSelfRemoval()
            expect(await generation(restored, proposal.frame)).toBe(want)
            await f.receiver.processMessage(proposal.frame)
            expect(f.receiver.epoch).toBe(f.epoch)
            expect(Object.values(f.receiver.state.unappliedProposals)).toEqual(
              Object.values(restored.state.unappliedProposals),
            )
            expect(Object.values(f.receiver.state.unappliedProposals)).toHaveLength(1)
          }
          expect(restored.state.handshakeReservation).toBeUndefined()
          expect(encodeClientState(restored.state)[1]).toBe(0)
          expect(f.bytes).toEqual(original)
          // Access restrictions must not defer normalisation until a permit is acquired.
          const restricted = restrictCommitAuthoring(await open())
          expect(restricted.state.handshakeReservation).toBeUndefined()
          expect(
            restricted.state.secretTree.leafNodes[2 * restricted.state.privatePath.leafIndex]
              ?.handshake.generation,
          ).toBe(want)
        },
      )
    }
  }
}

test.each([false, true])(
  'constructor, restore and permit advance only once (consumed: %s)',
  async (consumed) => {
    const f = await imported({ consumed, current: 3, reserved: 3, epochDelta: 0n })
    const constructed = f.construct()
    expect(constructed.state.handshakeReservation).toBeUndefined()
    const normalised = encodeClientState(constructed.state)
    expect(normalised[1]).toBe(0)
    const { value: built } = await withCommitPermit(
      () => f.restore(normalised),
      async (permitted) => {
        expect(encodeClientState(permitted.state)).toEqual(normalised)
        const result = await commitKeyRotation(permitted)
        expect(await generation(permitted, result.commitMessage)).toBe(4)
        return result
      },
    )
    await f.receiver.processMessage(built.commitMessage)
    expect(f.receiver.epoch).toBe(f.epoch + 1n)
    expect(f.receiver.state.keySchedule.epochAuthenticator).toEqual(
      built.newGroup.state.keySchedule.epochAuthenticator,
    )
  },
)

test.each([false, true])(
  'constructor expands an unexpanded leaf safely (consumed: %s)',
  async (consumed) => {
    const f = await imported({ consumed, current: 0, reserved: 0, epochDelta: 0n, initialPeers: 3 })
    const handle = f.construct()
    expect(handle.state.privatePath.leafIndex).toBe(4)
    expect(handle.state.secretTree.leafWidth).toBe(8)
    const application = new Uint8Array([42])
    expect(await f.receiver.decrypt(await handle.encrypt(application))).toMatchObject({
      payload: application,
    })
    const proposal = await handle.proposeSelfRemoval()
    expect(await generation(handle, proposal.frame)).toBe(1)
    await f.receiver.processMessage(proposal.frame)
    expect(Object.values(f.receiver.state.unappliedProposals)).toEqual(
      Object.values(handle.state.unappliedProposals),
    )
    expect(Object.values(f.receiver.state.unappliedProposals)).toHaveLength(1)
    expect(handle.state.handshakeReservation).toBeUndefined()
  },
)

test.each([
  { hash: 'SHA-256', size: 32 },
  { hash: 'SHA-384', size: 48 },
  { hash: 'SHA-512', size: 64 },
])('constructor ratchet matches asynchronous HKDF-$hash', async ({ hash, size }) => {
  const f = await imported({ consumed: true, current: 3, reserved: 4, epochDelta: 0n })
  const base = await f.restore()
  const state = decodeClientState(f.bytes)
  if (state === undefined) throw new Error('Invalid imported state')
  const own = 2 * state.privatePath.leafIndex
  const leaf = state.secretTree.leafNodes[own]
  if (leaf === undefined) throw new Error('Missing sender leaf')
  leaf.handshake = { secret: new Uint8Array(size).fill(0x55), generation: 3, unusedGenerations: {} }
  const context = {
    ...base.context,
    cipherSuite: {
      ...base.context.cipherSuite,
      kdf: {
        ...base.context.cipherSuite.kdf,
        size,
        expand: async (secret: Uint8Array, info: Uint8Array, length: number) => {
          // RFC 5869: an Nh-byte expand is one HMAC block, independently through WebCrypto.
          expect(length).toBe(size)
          const key = await webcrypto.subtle.importKey(
            'raw',
            new Uint8Array(secret),
            { name: 'HMAC', hash },
            false,
            ['sign'],
          )
          return new Uint8Array(
            await webcrypto.subtle.sign('HMAC', key, new Uint8Array([...info, 1])),
          )
        },
      },
    },
  }
  const expected = await advanceSendingRatchet(context, leaf.handshake, 5)
  const constructed = new GroupHandle({
    state,
    credential: base.credential,
    ledger: base.ledger,
    context,
  })
  expect(constructed.state.secretTree.leafNodes[own]?.handshake).toEqual(expected.ratchet)
  expect(constructed.state.handshakeReservation).toBeUndefined()
})

test.each([
  { name: 'consumed', consumed: true, current: 3, reserved: 3, epochDelta: 0n, want: 4 },
  { name: 'unconsumed', consumed: false, current: 3, reserved: 3, epochDelta: 0n, want: 4 },
  { name: 'already past', consumed: true, current: 3, reserved: 2, epochDelta: 0n, want: 3 },
  { name: 'past epoch', consumed: true, current: 3, reserved: 25, epochDelta: -1n, want: 3 },
  { name: 'future epoch', consumed: false, current: 3, reserved: 25, epochDelta: 1n, want: 3 },
  { name: 'unexpanded leaf', consumed: false, current: 0, reserved: 0, epochDelta: 0n, want: 1 },
])('the permit clears an imported $name reservation before building', async (params) => {
  const f = await imported(params)
  const original = f.bytes.slice()
  const { value: built } = await withCommitPermit(f.restore, async (permitted) => {
    expect(encodeClientState(permitted.state)[1]).toBe(0)
    const result = await commitKeyRotation(permitted)
    expect(await generation(permitted, result.commitMessage)).toBe(params.want)
    return result
  })
  expect(encodeClientState(built.newGroup.state)[1]).toBe(0)
  expect(f.bytes).toEqual(original)
  await f.receiver.processMessage(built.commitMessage)
  expect(f.receiver.epoch).toBe(f.epoch + 1n)
  expect(f.receiver.state.keySchedule.epochAuthenticator).toEqual(
    built.newGroup.state.keySchedule.epochAuthenticator,
  )
})

test.each([false, true])(
  'a crash before permit save repeats the skip (consumed: %s)',
  async (consumed) => {
    const f = await imported({ consumed, current: 3, reserved: 3, epochDelta: 0n })
    const original = f.bytes.slice()
    const failure = new Error('crash before save')
    const generations: Array<number> = []
    await expect(
      withCommitPermit(f.restore, async (permitted) => {
        const built = await commitKeyRotation(permitted)
        generations.push(await generation(permitted, built.commitMessage))
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(f.bytes).toEqual(original)
    const { value: built } = await withCommitPermit(f.restore, async (permitted) => {
      const result = await commitKeyRotation(permitted)
      generations.push(await generation(permitted, result.commitMessage))
      return result
    })
    expect(generations).toEqual([4, 4])
    expect(encodeClientState(built.newGroup.state)[1]).toBe(0)
    await f.receiver.processMessage(built.commitMessage)
    expect(f.receiver.epoch).toBe(f.epoch + 1n)
    expect(f.receiver.state.keySchedule.epochAuthenticator).toEqual(
      built.newGroup.state.keySchedule.epochAuthenticator,
    )
  },
)
