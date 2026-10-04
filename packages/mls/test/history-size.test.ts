import { createReset, createRevoke, createRotate } from '@kokuin/controller'
import { expect, test } from 'vitest'

import { createGroup } from '../src/group-create.js'
import * as history from '../src/history.js'
import { HISTORY_HORIZON } from '../src/history.js'
import type { VerifiedLedgerEntry } from '../src/ledger.js'
import { signLedgerEntry, verifyLedgerEntry } from '../src/ledger.js'
import { historyBytes, logMeasurements } from './fixtures/history-probe.js'
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
    options: { seal: '組合 café 🚀' },
  })
  const prefix = [inception, rotation]
  const alice = agent(41)
  const initial = await lifecycleGroup(prefix)
  const added = await addMember(initial.group, agent(51), await bindingFor(agent(51), prefix))
  const revoke = createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: rotation.event,
    target: agent(61).id,
    keyPosition: { gen: 0, seq: 1 },
  })
  const oldProof = [...prefix, revoke]
  const resetPrefix = [inception, createReset(controllerSeed, 0, 1)]
  const entries: Array<VerifiedLedgerEntry> = []
  const tokens: Array<string> = []
  for (const value of [
    { op: 'revoke', proof: oldProof, revoked: [{ did: agent(61).id }] },
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
  const proofUtf8Bytes = historyBytes(oldProof) + historyBytes(resetPrefix)
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
  expect(recorded.group.ledgerTokens).toEqual(tokens)
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
