import { type ClientState, decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import { clientStateEncoder, encode } from 'ts-mls'
import { expect, test } from 'vitest'

import {
  controlCompatible,
  controlProjection,
  ownHandshakeGeneration,
} from '../src/control-compat.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'

function copy(state: ClientState): ClientState {
  const decoded = decodeClientState(encodeClientState(state))
  if (decoded === undefined) throw new Error('Invalid state')
  return decoded
}

async function setup() {
  const group = await createRealGroup(2, 'control-compat')
  const local = group.members[0]?.handle
  const foreign = group.members[1]?.handle
  if (local === undefined || foreign === undefined) throw new Error('Missing member')
  expect(local.state.privatePath.leafIndex).toBe(1)
  return { group, local, foreign }
}

test('an app receive keeps control compatibility', async () => {
  const { local, foreign } = await setup()
  const source = copy(local.state)
  await local.decrypt(await foreign.encrypt(new Uint8Array([1])))
  expect(encodeClientState(local.state)).not.toEqual(encodeClientState(source))
  expect(controlProjection(local.state)).toEqual(controlProjection(source))
  expect(controlCompatible(source, local.state)).toBe(true)
})

test('an own app send keeps control compatibility', async () => {
  const { local } = await setup()
  const source = copy(local.state)
  expect(ownHandshakeGeneration(source)).toBe(0)
  await local.encrypt(new Uint8Array([1]))
  expect(encodeClientState(local.state)).not.toEqual(encodeClientState(source))
  expect(ownHandshakeGeneration(local.state)).toBe(0)
  expect(controlCompatible(source, local.state)).toBe(true)
})

test('an own self-removal proposal breaks control compatibility', async () => {
  const { local } = await setup()
  const source = copy(local.state)
  await local.proposeSelfRemoval()
  expect(ownHandshakeGeneration(local.state)).toBe(1)
  expect(controlCompatible(source, local.state)).toBe(false)
})

test('a received foreign proposal keeps control compatibility', async () => {
  const { local, foreign } = await setup()
  const source = copy(local.state)
  await local.processMessage((await foreign.proposeSelfRemoval()).frame)
  expect(Object.values(local.state.unappliedProposals)).toMatchObject([{ senderLeafIndex: 2 }])
  expect(controlCompatible(source, local.state)).toBe(true)
})

test('removing a referenced proposal breaks control compatibility', async () => {
  const { local, foreign } = await setup()
  await local.processMessage((await foreign.proposeSelfRemoval()).frame)
  const source = copy(local.state)
  const refs = Object.keys(source.unappliedProposals)
  expect(refs).toHaveLength(1)
  expect(controlCompatible(source, local.state, refs)).toBe(true)
  const current = { ...copy(source), unappliedProposals: {} }
  expect(controlCompatible(source, current, refs)).toBe(false)
  expect(controlCompatible(source, current)).toBe(false)
})

test('only explicit references allow an unreferenced source proposal to disappear', async () => {
  const { local, foreign } = await setup()
  await local.processMessage((await foreign.proposeSelfRemoval()).frame)
  const source = copy(local.state)
  expect(Object.keys(source.unappliedProposals)).toHaveLength(1)
  const current = { ...copy(source), unappliedProposals: {} }
  expect(controlCompatible(source, current, [])).toBe(true)
  expect(controlCompatible(source, current)).toBe(false)
})

test('a referenced sender changing from zero to absent breaks control compatibility', async () => {
  const { local, foreign } = await setup()
  await local.processMessage((await foreign.proposeSelfRemoval()).frame)
  const source = copy(local.state)
  for (const proposal of Object.values(source.unappliedProposals)) proposal.senderLeafIndex = 0
  const current = copy(source)
  const refs = Object.keys(source.unappliedProposals)
  expect(refs).toHaveLength(1)
  for (const proposal of Object.values(current.unappliedProposals)) {
    expect(proposal.senderLeafIndex).toBe(0)
    delete proposal.senderLeafIndex
  }
  expect(encode(clientStateEncoder, current)).toEqual(encode(clientStateEncoder, source))
  expect(controlCompatible(source, current, refs)).toBe(false)
})

test('a referenced proposal with changed content breaks control compatibility', async () => {
  const { local, foreign } = await setup()
  await local.processMessage((await foreign.proposeSelfRemoval()).frame)
  const source = copy(local.state)
  const current = copy(source)
  for (const row of Object.values(current.unappliedProposals)) {
    row.proposal = { proposalType: 3, remove: { removed: 1 } }
  }
  expect(controlCompatible(source, current, Object.keys(source.unappliedProposals))).toBe(false)
})

test('an own-sender proposal added without ratchet progress breaks control compatibility', async () => {
  const { local, foreign } = await setup()
  await local.processMessage((await foreign.proposeSelfRemoval()).frame)
  const current = copy(local.state)
  const source = { ...copy(current), unappliedProposals: {} }
  for (const proposal of Object.values(current.unappliedProposals)) proposal.senderLeafIndex = 1
  expect(controlProjection(current)).toEqual(controlProjection(source))
  expect(controlCompatible(source, current, [])).toBe(false)
})

test('retained epoch eviction keeps compatibility but added history breaks it', async () => {
  const { group, local } = await setup()
  await local.processMessage(await buildRealCommit(group))
  const source = copy(local.state)
  expect(source.historicalReceiverData.size).toBeGreaterThan(0)
  const current = { ...copy(source), historicalReceiverData: new Map() }
  expect(controlCompatible(source, current)).toBe(true)
  expect(controlCompatible(current, source)).toBe(false)
})

test('a processed commit breaks control compatibility', async () => {
  const { group, local } = await setup()
  const source = copy(local.state)
  await local.processMessage(await buildRealCommit(group))
  expect(controlCompatible(source, local.state)).toBe(false)
})

test('projection keeps control secrets and the own handshake generation', async () => {
  const { local } = await setup()
  await local.encrypt(new Uint8Array([1]))
  const source = copy(local.state)
  const current = copy(source)
  current.keySchedule.epochAuthenticator[0] = (current.keySchedule.epochAuthenticator[0] ?? 0) ^ 1
  expect(controlCompatible(source, current)).toBe(false)
  const restored = await restoreGroup({
    state: copy(source),
    credential: local.credential,
    ledgerEntries: local.ledgerTokens,
  })
  await restored.proposeSelfRemoval()
  expect(controlProjection(restored.state)).not.toEqual(controlProjection(source))
})
