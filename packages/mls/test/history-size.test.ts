// Set KUMIAI_PROBE_REPORT=1 to print measurement tables.

import type { ControllerLog } from '@kokuin/controller'
import { createReset, createRotate } from '@kokuin/controller'
import { nodeTypes } from 'ts-mls'
import { expect, test } from 'vitest'

import { foldChain } from '../src/controller-log.js'
import type { FoldDrop } from '../src/fold.js'
import { createGroup } from '../src/group-create.js'
import { createKeyPackageBundle } from '../src/group-credential.js'
import * as history from '../src/history.js'
import { HISTORY_HORIZON } from '../src/history.js'
import type { VerifiedLedgerEntry } from '../src/ledger.js'
import { signLedgerEntry, verifyLedgerEntry } from '../src/ledger.js'
import { foldControl, recordedLogOf } from '../src/registry.js'
import { revokeChain, snapshotForChain } from './fixtures/controller-chain.js'
import { buildEpoch } from './fixtures/controller-epoch.js'
import { buildLog, historyBytes, logMeasurements } from './fixtures/history-probe.js'
import {
  addMember,
  agent,
  bindingFor,
  controllerID,
  controllerSeed,
  enact,
  inception,
  lifecycleGroup,
} from './fixtures/lifecycle-ledger.js'

test('mixed history gains a distinct denial every fourth event', () => {
  const folded = foldChain(controllerID, buildLog(13, agent(71).id, true))
  expect(folded.ok).toBe(true)
  if (!folded.ok) throw new Error(folded.reason)
  expect(folded.states.map((state) => state.deny.size)).toEqual([
    0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3,
  ])
})

test('measures signed controller history and repeated copies', async () => {
  const rows = await logMeasurements()
  expect(HISTORY_HORIZON).toBe(393_216)
  expect(rows.every((row) => row.historyBytes > 0)).toBe(true)
}, 180_000)

test('historyCountsUtf8AndEveryCopy', async () => {
  const rotation = createRotate({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    snapshot: snapshotForChain(controllerID, [inception]),
    seal: '組合 café 🚀',
  })
  const prefix = [inception, rotation]
  const alice = agent(41)
  const initial = await lifecycleGroup(prefix)
  const added = await addMember(initial.group, agent(51), await bindingFor(agent(51), prefix))
  const revoke = revokeChain({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    chain: [inception, rotation],
    subject: agent(61).id,
  })
  const oldProof = [...prefix, revoke]
  const resetPrefix = [inception, createReset(controllerSeed, 0, 1)]
  const entries: Array<VerifiedLedgerEntry> = []
  const tokens: Array<string> = []
  for (const value of [
    { op: 'revoke', proof: oldProof.slice(1), revoked: [{ did: agent(61).id }] },
    { op: 'reset', proof: resetPrefix, revoked: [] },
  ]) {
    const token = await signLedgerEntry(alice, {
      type: 'kumiai.device',
      groupID: initial.group.groupID,
      subject: value.op === 'revoke' ? agent(61).id : controllerID,
      value,
    })
    const verified = await verifyLedgerEntry(token)
    if (verified == null) throw new Error('Invalid test proof token')
    entries.push(verified)
    tokens.push(token)
  }
  const proofUtf8Bytes = historyBytes(oldProof.slice(1)) + historyBytes(resetPrefix)
  expect(historyBytes(prefix)).toBeGreaterThan(
    prefix.reduce((size, event) => size + JSON.stringify(event).length, 0),
  )
  expect(history.historySize(added.group.state.ratchetTree, entries)).toBe(
    historyBytes(prefix) * 2 + proofUtf8Bytes,
  )
  const resetGroup = await lifecycleGroup(resetPrefix)
  const renewed = await addMember(
    resetGroup.group,
    agent(51),
    await bindingFor(agent(51), resetPrefix),
  )
  const revoked = await enact(renewed.group, [tokens[0] as string])
  const recorded = await enact(revoked.group, [tokens[1] as string])
  expect(recorded.group.ledgerTokens).toEqual([...renewed.group.ledgerTokens, ...tokens])
  expect(history.historySize(recorded.group.state.ratchetTree, entries)).toBe(
    historyBytes(resetPrefix) * 2 + proofUtf8Bytes,
  )
  const consumer: VerifiedLedgerEntry = {
    issuer: alice.id,
    entry: {
      type: 'consumer.data',
      groupID: initial.group.groupID,
      subject: alice.id,
      value: { data: '組'.repeat(65536), proof: oldProof },
    },
  }
  expect(history.historySize(renewed.group.state.ratchetTree, [...entries, consumer])).toBe(
    historyBytes(resetPrefix) * 2 + proofUtf8Bytes,
  )
  const floating = await createGroup(agent(71), 'floating-history')
  expect(history.historySize(floating.group.state.ratchetTree, [consumer])).toBe(0)
})

test('history shares the UTF-8 log size primitive with proof accounting', async () => {
  const proof = await import('../src/lifecycle-proof.js')
  expect(history.HISTORY_HORIZON).toBe(proof.HISTORY_HORIZON)
  expect(history.controllerLogSize).toBe(proof.controllerLogSize)
  expect(history.controllerLogSize([inception])).toBe(historyBytes([inception]))
})

function logEntry(
  controller: string,
  op: 'seed' | 'log',
  proof: ControllerLog,
): VerifiedLedgerEntry {
  return {
    issuer: controller,
    entry: {
      type: 'kumiai.device',
      groupID: 'history-log',
      subject: controller,
      value: { op, proof },
    },
  }
}

test('history counts every proof copy', async () => {
  const { did, log } = await buildEpoch({ members: 1 })
  const repeated = { chain: [], events: log.events }
  const entries = [logEntry(did, 'seed', log), logEntry(did, 'log', repeated)]
  const each = history.controllerLogSize(log.chain) + history.controllerLogSize(log.events)
  expect(history.proofSize(log)).toBe(each)
  expect(history.historySize([], entries)).toBe(each + history.controllerLogSize(repeated.events))
  expect(history.proofSize(log.chain)).toBe(history.controllerLogSize(log.chain))
  for (const value of [null, {}, 'proof', { chain: [], events: null }]) {
    expect(history.proofSize(value)).toBe(0)
  }
})

test('history does not shrink after a settlement', async () => {
  const { seed, did, log, head, inception } = await buildEpoch({ members: 1 })
  const seedEntry = logEntry(did, 'seed', log)
  const rotate = createRotate({
    seed,
    profile: 0,
    did,
    prior: inception.event,
    snapshot: {
      members: [...head.members.values()].map(
        ({ removed: _removed, effective: _effective, ...member }) => member,
      ),
      deny: [...head.deny],
    },
  })
  const entries = [seedEntry, logEntry(did, 'log', { chain: [rotate], events: [] })]
  const state = foldControl(
    entries.map((verified, index) => ({ verified, entryID: String(index) })),
    { creatorDID: did, controller: did, version: 1 },
    'history-log',
  )
  expect(recordedLogOf(state.registry, did)?.events).toEqual([])
  expect(recordedLogOf(state.registry, did)?.chain).toHaveLength(2)
  expect(history.historySize([], entries)).toBe(
    history.historySize([], [seedEntry]) + history.controllerLogSize([rotate]),
  )
})

test('P2 workload fits the horizon held once', async () => {
  const day = 86_400
  const { did, genesis, deltas, log } = await buildEpoch({
    members: 3,
    renewEvery: 21 * day,
    until: 168 * day,
    revokes: 4,
  })
  const entries = [
    logEntry(did, 'seed', genesis),
    ...deltas.map((proof) => logEntry(did, 'log', proof)),
  ]
  const drops: Array<FoldDrop> = []
  const state = foldControl(
    entries.map((verified, index) => ({ verified, entryID: String(index) })),
    { creatorDID: did, controller: did, version: 1 },
    'history-log',
    (drop) => drops.push(drop),
  )
  expect(drops).toEqual([])
  expect(recordedLogOf(state.registry, did)?.events).toHaveLength(31)
  expect(deltas).toHaveLength(24)
  const tree = []
  for (let index = 0; index < 50; index++) {
    const identity = agent(80 + index)
    const bundle = await createKeyPackageBundle(identity, {
      controller: await bindingFor(identity, log.chain),
    })
    if (index > 0) tree.push(undefined)
    tree.push({ nodeType: nodeTypes.leaf, leaf: bundle.publicPackage.leafNode })
  }
  const bytes = history.historySize(tree, entries)
  expect(bytes).toBe(
    50 * history.controllerLogSize(log.chain) +
      history.controllerLogSize(log.chain) +
      history.controllerLogSize(log.events),
  )
  expect(bytes).toBeLessThan(HISTORY_HORIZON)
})
