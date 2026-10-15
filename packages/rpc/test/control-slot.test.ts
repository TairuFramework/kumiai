import { expect, test, vi } from 'vitest'

import { encodeControlFixtureState } from '../../rpc-conformance/src/control-store.js'
import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { forkEventID } from '../src/control/safety.js'
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
  let safety = false
  const deps: ControlSlotDeps = {
    control: store,
    safetyHold: () => (safety ? 'fork-halted' : null),
    haltFork: async (evidence) => {
      safety = true
      await store.apply(
        { forkHalt: { eventID: forkEventID(store.key), evidence, detectedAt: 1 } },
        'halt',
      )
    },
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

test('fork halts survive restart and copy evidence defensively', async () => {
  const f = await fixture()
  const evidence = {
    kind: 'epoch-authenticator' as const,
    epoch: 1,
    local: new Uint8Array([7]),
    remote: new Uint8Array([8]),
  }
  await f.deps.haltFork(evidence)
  evidence.local.fill(0)
  const snapshot = await f.store.load()
  expect(snapshot.forkHalt?.evidence).toEqual({
    kind: 'epoch-authenticator',
    epoch: 1,
    local: new Uint8Array([7]),
    remote: new Uint8Array([8]),
  })
  if (snapshot.forkHalt?.evidence.kind !== 'epoch-authenticator')
    throw new Error('missing evidence')
  snapshot.forkHalt.evidence.remote.fill(0)
  expect((await f.store.load()).forkHalt?.evidence).toMatchObject({ remote: new Uint8Array([8]) })
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
  'an op slot mismatch preserves unknown work without a halt: %s',
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
    const after = await f.store.load()
    expect(after.forkHalt).toBeNull()
    expect(after.controlHold?.reason).toBe('acceptance-unknown')
    expect(after.commitOnce).toEqual(f.slot)
    expect(after.operations).toHaveLength(1)
    expect(after.outcomes).toEqual([])
    expect(f.deps.adoption.adopt).not.toHaveBeenCalled()
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

test.each(['fork-halted', 'recovery-unavailable'] as const)(
  'exact applied slot cleans up under %s with storage evidence',
  async (reason) => {
    const f = await fixture()
    await f.store.apply(
      {
        putApplied: [
          {
            epoch: f.slot.epoch,
            digest: f.slot.digest,
            payloadDigest: f.slot.payloadDigest,
            sequenceID: f.proof.position,
            opID: f.op.id,
            removed: false,
          },
        ],
      },
      'applied',
    )
    f.deps.safetyHold = () => reason
    f.deps.haltFork = async () => {}
    const read = vi.spyOn(f.deps, 'readEvidence')
    const before = await f.store.load()
    expect(await settleControlSlot(f.deps)).toBe('landed')
    expect(read).not.toHaveBeenCalled()
    expect(f.deps.search.searchLog).not.toHaveBeenCalled()
    expect(f.deps.adoption.adopt).not.toHaveBeenCalled()
    const after = await f.store.load()
    expect(after.operations).toEqual([])
    expect(after.commitOnce).toEqual(before.commitOnce)
    expect(after.outcomes).toEqual(before.outcomes)
    expect(after.cursor).toEqual(before.cursor)
  },
)

test('direct slot authenticator divergence halts with exact evidence and preserves cursor and strand', async () => {
  const f = await fixture()
  const read = f.deps.readEvidence
  f.deps.readEvidence = async () => {
    const value = await read()
    if (value.source.identity === null) throw new Error('Missing source')
    return {
      ...value,
      source: {
        ...value.source,
        identity: { ...value.source.identity, authenticator: new Uint8Array([9]) },
      },
    }
  }
  const before = await f.store.load()
  expect(await settleControlSlot(f.deps)).toBe('unknown')
  const after = await f.store.load()
  expect(after.forkHalt?.evidence).toEqual({
    kind: 'epoch-authenticator',
    epoch: f.slot.epoch,
    local: f.slot.authenticatorBefore,
    remote: new Uint8Array([9]),
  })
  expect(after.cursor).toEqual(before.cursor)
  expect(after.strand).toEqual(before.strand)
  expect(after.controlHold).toBeNull()
  expect(f.deps.search.searchLog).not.toHaveBeenCalled()
  expect(f.deps.adoption.adopt).not.toHaveBeenCalled()
})
