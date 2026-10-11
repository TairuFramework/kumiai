import { randomIdentity } from '@kokuin/token'
import { commitLedgerEntries, createGroup, decodeClientState, signLedgerEntry } from '@kumiai/mls'
import {
  asLogPosition,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { expect, test } from 'vitest'

import {
  createDurableHandleAccess,
  createMemoryStateStore,
  createOperationHost,
  encodeJournal,
  operationIntent,
  operationRequest,
} from './app-lane-e2e.js'

test('restart reads the state co-committed with a landed outcome after an after-save crash', async () => {
  const identity = randomIdentity()
  const current = (await createGroup(identity, 'adoption-crash-restart')).group
  const store = createMemoryStateStore()
  await store.save(current)
  const token = await signLedgerEntry(identity, {
    groupID: current.groupID,
    type: 'note',
    subject: identity.id,
    value: 'crash-safe',
  })
  const committed = await commitLedgerEntries(current, [token])
  const next = committed.newGroup
  const outcome = {
    id: 'landed-op',
    opID: 'landed-op',
    kind: 'landed' as const,
    position: asLogPosition('00000000000000000001'),
    at: 1,
  }
  store.database.seam('after-save', () => {
    throw new Error('Crash after adoption transaction')
  })
  await expect(
    store.save(next, {
      mutationID: 'landed-adoption',
      changes: { putOutcomes: [outcome], cursor: { position: outcome.position, epoch: 1 } },
    }),
  ).rejects.toThrow('Crash after adoption transaction')
  expect((await store.control.load()).outcomes).toEqual([outcome])
  expect(await store.control.lastMutation()).toBe('landed-adoption')
  const saved = await store.saved()
  if (saved == null) throw new Error('Missing durable state')
  expect(decodeClientState(saved.state)?.groupContext.epoch).toBe(1n)
  expect((await store.control.load()).cursor?.epoch).toBe(1)
})

test('standalone operation adoption co-commits the anchor landed mark with control', async () => {
  const identity = randomIdentity()
  let current = (await createGroup(identity, 'standalone-operation-host')).group
  const access = createDurableHandleAccess({
    handle: () => current,
    adopt: (next) => {
      current = next
    },
  })
  const host = createOperationHost(access, identity)
  const token = await signLedgerEntry(identity, {
    groupID: current.groupID,
    type: 'note',
    subject: identity.id,
    value: 'atomic',
  })
  const committed = await commitLedgerEntries(current, [token])
  const next = committed.newGroup
  const epochBefore = Number(current.epoch)
  const op = operationIntent(operationRequest('ledger', {}))
  host.builders.set(op.id, async () => ({
    commit: committed.commitMessage,
    journal: encodeJournal(next),
    bodies: [token],
    welcome: null,
    epoch: epochBefore,
    authenticatorBefore: current.state.keySchedule.epochAuthenticator.slice(),
    incarnation: 1,
    digest: digestAppliedCommit(committed.commitMessage),
  }))
  await host.control.apply({ putOperations: [op] }, 'intent')
  const prepared = await host.prepareBuild(op, async (built, seal) => ({
    payload: encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(built.commit, (await seal(encodeLedgerEntries(built.bodies))).sealed),
    ),
    publishID: 'own-publish',
    expectedHead: null,
  }))
  expect(prepared.kind).toBe('saved')
  const slot = (await host.control.load()).commitOnce
  if (slot === null) throw new Error('Missing saved build')
  const proof = {
    source: (await host.readEvidence()).source,
    from: slot.searchFrom,
    position: asLogPosition('001'),
    payloadDigest: slot.payloadDigest,
  }
  await host.control.apply({ commitOnceAcceptance: proof }, 'accepted')
  const expected = { ...(await host.readEvidence()).source, acceptance: proof }
  await host.anchorStore.save({
    anchor: { epoch: epochBefore, secret: new Uint8Array(32).fill(1) },
    pending: {
      epochBefore,
      epochAfter: Number(next.epoch),
      rosterBefore: [identity.id],
      forced: false,
      advance: 'own-commit',
    },
  })
  await expect(
    host.adopt(slot.journal, expected, {
      mutationID: 'adoption-mutation',
      anchorLanded: 'own-commit',
      changes: { putOutcomes: [{ id: 'own-op', opID: 'own-op', kind: 'unknown', at: 1 }] },
    }),
  ).resolves.toBe('installed')
  expect(await host.control.lastMutation()).toBe('adoption-mutation')
  expect((await host.anchorStore.load())?.pending?.landed).toBe(true)
  expect((await host.control.load()).outcomes).toEqual([
    { id: 'own-op', opID: 'own-op', kind: 'unknown', at: 1 },
  ])
  expect(current.epoch).toBe(next.epoch)
})
