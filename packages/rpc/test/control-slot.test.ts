import { expect, test, vi } from 'vitest'

import { encodeControlFixtureState } from '../../rpc-conformance/src/control-store.js'
import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { type ControlSlotDeps, settleControlSlot } from '../src/control/slot.js'
import type { ControlSlot, FirstValidCommit, Operation } from '../src/control/types.js'
import { deliverObligations } from '../src/control/welcome.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'

async function fixture() {
  const key = { groupID: 'slot', incarnation: 1 }
  const identity = { ...key, epoch: 1, authenticator: new Uint8Array([7]) }
  const store = createMemoryControlStore<LogPosition>(key)
  await store.saveState(encodeControlFixtureState(identity))
  const op: Operation & { stage: 'intent' } = {
    id: 'invite',
    kind: 'invite',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: 1_000,
    stage: 'intent',
  }
  const slot: ControlSlot = {
    opID: op.id,
    incarnation: 1,
    epoch: 1,
    authenticatorBefore: new Uint8Array([7]),
    searchFrom: null,
    expectedHead: null,
    publishID: 'saved-publish',
    payload: new Uint8Array([1]),
    payloadDigest: 'saved-payload',
    digest: 'saved-commit',
    journal: new Uint8Array([2]),
    bodies: [],
    welcome: { bytes: new Uint8Array([9]), recipients: ['invitee'] },
  }
  const source = { key, identity, stateVersion: await store.loadVersion() }
  await store.apply({ putOperations: [op] }, 'enqueue')
  expect(await store.saveBuilt(op, slot, source, 'build')).toBe('saved')
  const proof: FirstValidCommit = {
    source,
    from: null,
    position: asLogPosition('000001'),
    payloadDigest: slot.payloadDigest,
  }
  const emitted: Array<unknown> = []
  const deps: ControlSlotDeps = {
    control: store,
    search: { searchLog: vi.fn(async () => ({ kind: 'unknown' as const })) },
    adoption: {
      adopt: vi.fn(async (_journal, _expected, write) => {
        await store.saveState(
          encodeControlFixtureState({ ...identity, epoch: 2, authenticator: new Uint8Array([8]) }),
          write,
        )
        return 'installed' as const
      }),
    },
    readEvidence: async () => ({
      source,
      applied: (await store.load()).applied,
      cursor: (await store.load()).cursor,
      terminal: false,
    }),
    now: () => 2_000,
    newID: () => crypto.randomUUID(),
    emit: (row) => emitted.push(row),
  }
  return { store, deps, slot, op, proof, emitted }
}

test.each(
  ['unknown', 'lost', 'abandon'].flatMap((prior) =>
    [true, false].map((acked) => [prior, acked] as const),
  ),
)(
  'late first-valid landing of a %s slot adopts and owes its Welcome (acked=%s)',
  async (prior, acked) => {
    const f = await fixture()
    await f.store.apply(
      {
        deleteOperations: [f.op.id],
        putOutcomes: [
          { id: f.op.id, opID: f.op.id, at: 1_000, kind: prior === 'lost' ? 'lost' : 'unknown' },
        ],
      },
      'settle',
    )
    if (acked) await f.store.apply({ deleteOutcomes: [f.op.id] }, 'ack')
    const afterAck = await f.store.load()
    expect(afterAck.operations).toEqual([])
    expect(afterAck.outcomes).toHaveLength(acked ? 0 : 1)
    expect(afterAck.commitOnce?.opID).toBe(f.op.id)
    f.deps.search.searchLog = async () => ({ kind: 'first-valid', proof: f.proof })
    expect(await settleControlSlot(f.deps)).toBe('landed')
    const landed = await f.store.load()
    expect(landed.applied).toMatchObject([{ payloadDigest: 'saved-payload' }])
    expect(landed.outcomes).toEqual([
      {
        id: '["control:landed","invite","saved-publish","000001"]',
        opID: f.op.id,
        at: 2_000,
        kind: 'landed',
        position: f.proof.position,
      },
    ])
    expect(landed.welcomes).toEqual([
      { opID: f.op.id, welcome: new Uint8Array([9]), recipients: ['invitee'], committed: true },
    ])
    await f.store.apply({ deleteOutcomes: landed.outcomes.map((row) => row.id) }, 'ack-landed')
    expect(await settleControlSlot(f.deps)).toBe('empty')
    expect((await f.store.load()).outcomes).toEqual([])
    expect(f.emitted).toHaveLength(1)
  },
)

test('accepted replay rechecks proof before adopt', async () => {
  const f = await fixture()
  await f.store.apply({ commitOnceAcceptance: f.proof }, 'accept')
  expect(await settleControlSlot(f.deps)).toBe('unknown')
  expect(f.deps.adoption.adopt).not.toHaveBeenCalled()
  expect((await f.store.load()).commitOnce).toEqual(f.slot)
  expect((await f.store.load()).applied).toEqual([])
})

test('acknowledging the prior unknown after late landing preserves the landed outcome', async () => {
  const f = await fixture()
  await f.store.apply(
    {
      deleteOperations: [f.op.id],
      putOutcomes: [{ id: f.op.id, opID: f.op.id, at: 1_000, kind: 'unknown' }],
    },
    'unknown',
  )
  f.deps.search.searchLog = async () => ({ kind: 'first-valid', proof: f.proof })
  expect(await settleControlSlot(f.deps)).toBe('landed')
  await f.store.apply({ deleteOutcomes: [f.op.id] }, 'ack-unknown')
  expect((await f.store.load()).outcomes).toEqual([
    expect.objectContaining({ opID: f.op.id, kind: 'landed', position: f.proof.position }),
  ])
})

test('complete absence retains the orphan slot without resurrecting its operation', async () => {
  const f = await fixture()
  await f.store.apply({ deleteOperations: [f.op.id] }, 'abandon')
  f.deps.search.searchLog = async () => ({ kind: 'absent' })
  expect(await settleControlSlot(f.deps)).toBe('absent')
  expect((await f.store.load()).commitOnce).toEqual(f.slot)
  expect((await f.store.load()).operations).toEqual([])
  expect(f.deps.adoption.adopt).not.toHaveBeenCalled()
})

test('control holds survive restart and copy fork evidence defensively', async () => {
  const f = await fixture()
  const evidence = {
    kind: 'epoch-authenticator' as const,
    epoch: 1,
    local: new Uint8Array([7]),
    remote: new Uint8Array([8]),
  }
  await f.store.apply(
    { controlHold: { reason: 'fork-evidence', position: null, evidence } },
    'hold',
  )
  evidence.local.fill(0)
  const snapshot = await f.store.load()
  expect(snapshot.controlHold).toEqual({
    reason: 'fork-evidence',
    position: null,
    evidence: {
      kind: 'epoch-authenticator',
      epoch: 1,
      local: new Uint8Array([7]),
      remote: new Uint8Array([8]),
    },
  })
  if (snapshot.controlHold?.evidence?.kind !== 'epoch-authenticator')
    throw new Error('missing evidence')
  snapshot.controlHold.evidence.remote.fill(0)
  expect((await f.store.load()).controlHold?.evidence).toMatchObject({
    remote: new Uint8Array([8]),
  })
})

test('one pre-adoption Welcome is delivered across moved retries and eventual installation', async () => {
  const f = await fixture()
  f.deps.search.searchLog = async () => ({ kind: 'first-valid', proof: f.proof })
  const install = f.deps.adoption.adopt
  f.deps.adoption.adopt = async () => 'moved'
  const deliveries: Array<string> = []
  const deliver = async () =>
    deliverObligations(
      {
        control: f.store,
        canDeliver: async () => true,
        deliverWelcome: async (row) => {
          deliveries.push(row.opID)
        },
      },
      await f.store.load(),
    )
  for (let retry = 0; retry < 4; retry++) {
    expect(await settleControlSlot(f.deps)).toBe('unknown')
    await deliver()
  }
  expect(deliveries).toEqual([f.op.id])
  f.deps.adoption.adopt = install
  expect(await settleControlSlot(f.deps)).toBe('landed')
  await deliver()
  expect(deliveries).toEqual([f.op.id])
  expect((await f.store.load()).welcomes).toEqual([])
})

test.each([true, false])(
  'an op slot mismatch labels divergence only for differing digests: %s',
  async (sameDigest) => {
    const f = await fixture()
    const operation = (await f.store.load()).operations[0]
    if (operation === undefined || operation.stage === 'intent') throw new Error('missing build')
    await f.store.apply(
      {
        putOperations: [
          { ...operation, built: { ...operation.built, publishID: 'different-publish' } },
        ],
        putApplied: [
          {
            epoch: f.slot.epoch,
            digest: f.slot.digest,
            payloadDigest: sameDigest ? f.slot.payloadDigest : 'different-payload',
            sequenceID: f.proof.position,
            opID: null,
            removed: false,
          },
        ],
      },
      'mismatch',
    )
    expect(await settleControlSlot(f.deps)).toBe('unknown')
    expect((await f.store.load()).controlHold?.reason).toBe(
      sameDigest ? 'acceptance-unknown' : 'fork-evidence',
    )
  },
)

test('ambiguous slot acceptance writes obey their abort signal', async () => {
  const f = await fixture()
  f.deps.search.searchLog = async () => ({ kind: 'first-valid', proof: f.proof })
  const abort = new AbortController()
  const reason = new Error('disposed during acceptance')
  abort.abort(reason)
  f.store.commitThenRejectNext('apply')
  Object.assign(f.deps, { signal: abort.signal })
  await expect(settleControlSlot(f.deps)).rejects.toBe(reason)
  expect((await f.store.load()).commitOnceAcceptance).toEqual(f.proof)
  expect((await f.store.load()).applied).toEqual([])
})
