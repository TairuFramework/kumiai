import { describe, expect, test } from 'vitest'

import {
  createMemoryControlStore,
  type MemoryControlStore,
} from '../../rpc-conformance/src/memory-control-store.js'
import { applyChanges, applyResolved, controlSettled, pruneWindow } from '../src/control/store.js'
import type {
  AppliedCommit,
  ControlSnapshot,
  ControlStore,
  Operation,
  RejoinRecord,
} from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import {
  ControlWriteNotCommittedError,
  GroupControlUnsettledError,
  StorageOutcomeUnknownError,
} from '../src/errors.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'

const empty = (): ControlSnapshot => ({
  operations: [],
  rejoin: null,
  outcomes: [],
  welcomes: [],
  applied: [],
  responses: [],
  cursor: null,
})
const operation = (id: string, seq: number): Operation => ({
  id,
  seq,
  kind: 'invite',
  revokes: false,
  body: new Uint8Array([1]),
  enqueuedAt: 100,
  stage: 'intent',
})
const applied = (epoch: number): AppliedCommit => ({
  epoch,
  digest: 'commit',
  payloadDigest: 'payload',
  sequenceID: String(epoch),
  opID: null,
  removed: false,
})

const rejoin: RejoinRecord = {
  id: 'rejoin',
  stage: 'built',
  publishID: 'rejoin-publish',
  expectedHead: null,
  payload: new Uint8Array([1]),
  payloadDigest: 'rejoin-payload',
  requestID: 'request',
  request: new Uint8Array([2]),
  requestKey: new Uint8Array([3]),
  candidate: new Uint8Array([4]),
  source: { epoch: 1, authenticator: new Uint8Array([5]), lineage: 0, head: null },
  digest: 'rejoin-digest',
  epochAfter: 2,
  ledgerBefore: [],
  conflictEpoch: null,
}

describe('control changes', () => {
  test('deletes precede puts, operations replace by ID and remain FIFO, and input stays unchanged', () => {
    const before = {
      ...empty(),
      operations: [operation('second', 2), operation('first', 1)],
      applied: [applied(4), applied(5), applied(6)],
    }
    const copy = structuredClone(before)
    const result = applyChanges(before, {
      deleteOperations: ['first'],
      putOperations: [operation('first', 3), operation('second', 2)],
      deleteAppliedFrom: 5,
      putApplied: [{ ...applied(5), digest: 'replacement' }],
    })
    expect(result.operations.map((row) => row.id)).toEqual(['second', 'first'])
    expect(result.applied).toEqual([applied(4), { ...applied(5), digest: 'replacement' }])
    expect(before).toEqual(copy)
  })

  test('deletes and replaces all keyed record kinds, preserves an omitted cursor and clears an explicit null', () => {
    const snapshot = {
      ...empty(),
      outcomes: [{ id: 'old', opID: null, at: 1, kind: 'unknown' as const }],
      welcomes: [{ opID: 'old', welcome: new Uint8Array([1]), recipients: ['bob'] }],
      responses: [
        { position: asLogPosition('001'), epoch: 4, digest: 'old', kind: 'refused' as const },
        { position: asLogPosition('002'), epoch: 5, digest: 'old', kind: 'superseded' as const },
      ],
      cursor: { position: asLogPosition('002'), epoch: 5 },
    }
    const result = applyChanges(snapshot, {
      deleteRejoin: true,
      deleteOutcomes: ['old'],
      putOutcomes: [{ id: 'old', opID: null, at: 2, kind: 'lost' }],
      deleteWelcomes: ['old'],
      putWelcomes: [{ opID: 'old', welcome: new Uint8Array([2]), recipients: ['alice'] }],
      deleteResponsesBelow: 5,
      putResponses: [
        { position: asLogPosition('002'), epoch: 5, digest: 'new', kind: 'applied', epochAfter: 6 },
      ],
    })
    expect(result.outcomes).toEqual([{ id: 'old', opID: null, at: 2, kind: 'lost' }])
    expect(result.welcomes).toEqual([
      { opID: 'old', welcome: new Uint8Array([2]), recipients: ['alice'] },
    ])
    expect(result.responses).toEqual([
      { position: asLogPosition('002'), epoch: 5, digest: 'new', kind: 'applied', epochAfter: 6 },
    ])
    expect(result.cursor).toEqual(snapshot.cursor)
    expect(applyChanges(result, { cursor: null }).cursor).toBeNull()
  })

  test('applied range deletions precede puts and preserve the retained interval', () => {
    const snapshot = {
      ...empty(),
      applied: [applied(0), applied(1), applied(2), applied(3), applied(4)],
    }
    const result = applyChanges(snapshot, {
      deleteAppliedBelow: 2,
      deleteAppliedFrom: 4,
      putApplied: [{ ...applied(0), digest: 'replacement' }],
    })
    expect(result.applied).toEqual([
      { ...applied(0), digest: 'replacement' },
      applied(2),
      applied(3),
    ])
    expect(snapshot.applied).toEqual([applied(0), applied(1), applied(2), applied(3), applied(4)])
  })

  test('pruning retains exactly the newest 64 epochs without rewriting applied rows', () => {
    const snapshot = {
      ...empty(),
      applied: Array.from({ length: 65 }, (_, epoch) => applied(epoch)),
      responses: [
        { position: asLogPosition('old'), epoch: 0, digest: 'old', kind: 'refused' as const },
        { position: asLogPosition('one'), epoch: 1, digest: 'one', kind: 'refused' as const },
        { position: asLogPosition('two'), epoch: 1, digest: 'two', kind: 'refused' as const },
      ],
    }
    const changes = pruneWindow(snapshot, 64)
    expect(changes).toEqual({ deleteAppliedBelow: 1, deleteResponsesBelow: 1 })
    expect(changes.putApplied).toBeUndefined()
    const pruned = applyChanges(snapshot, changes)
    expect(pruned.applied.map((row) => row.epoch)).toEqual(
      Array.from({ length: 64 }, (_, i) => i + 1),
    )
    expect(pruned.responses.map((row) => row.position)).toEqual(['one', 'two'])
    expect(pruneWindow(snapshot, 63)).toEqual({})
  })

  test('only operations, rejoin, outcomes and Welcome obligations prevent settlement', () => {
    expect(controlSettled(empty())).toBe(true)
    expect(controlSettled({ ...empty(), rejoin })).toBe(false)
    expect(
      controlSettled({
        ...empty(),
        applied: [applied(1)],
        cursor: { position: asLogPosition('001'), epoch: 2 },
      }),
    ).toBe(true)
    expect(controlSettled({ ...empty(), operations: [operation('open', 1)] })).toBe(false)
    expect(
      controlSettled({
        ...empty(),
        outcomes: [{ id: 'outcome', opID: null, at: 1, kind: 'unknown' }],
      }),
    ).toBe(false)
    expect(
      controlSettled({
        ...empty(),
        welcomes: [{ opID: 'welcome', welcome: new Uint8Array([1]), recipients: ['bob'] }],
      }),
    ).toBe(false)
  })
})

describe('resolved writes', () => {
  test('the structural memory double resolves ambiguity through the RPC ControlStore port', async () => {
    const store: ControlStore & Pick<MemoryControlStore, 'commitThenRejectNext'> =
      createMemoryControlStore()
    store.commitThenRejectNext('apply')
    await applyResolved(store, { putOperations: [operation('double', 1)] }, 'double-mutation')
    expect((await store.load()).operations).toEqual([operation('double', 1)])
  })
  test('commit then reject resolves through the committed mutation', async () => {
    const db = createMemoryHostDatabase()
    const store = db.control('group')
    db.commitThenRejectNext('apply')
    await applyResolved(store, { putOperations: [operation('open', 1)] }, 'mutation')
    expect((await store.load()).operations).toEqual([operation('open', 1)])
  })

  test('an ambiguous rejection without a commit signals a safe retry', async () => {
    const store: ControlStore = {
      load: async () => empty(),
      apply: async () => {
        throw new StorageOutcomeUnknownError()
      },
      lastMutation: async () => 'previous',
    }
    await expect(applyResolved(store, {}, 'mutation')).rejects.toBeInstanceOf(
      ControlWriteNotCommittedError,
    )
  })

  test('read failures pause resolution with exponential delays capped at 15 seconds', async () => {
    const delays: Array<number> = []
    let reads = 0
    const store: ControlStore = {
      load: async () => empty(),
      apply: async () => {
        throw new StorageOutcomeUnknownError()
      },
      lastMutation: async () => {
        if (++reads <= 12) throw new Error('read unavailable')
        return 'mutation'
      },
    }
    await applyResolved(store, {}, 'mutation', async (delay) => {
      delays.push(delay)
    })
    expect(delays).toHaveLength(12)
    expect(delays[0]).toBeGreaterThan(0)
    for (let i = 1; i < delays.length; i++)
      expect(delays[i]).toBe(Math.min((delays[i - 1] ?? 0) * 2, 15_000))
    expect(delays.at(-1)).toBe(15_000)
  })

  test('known write failures propagate without reading back', async () => {
    const failure = new Error('known rejection')
    const store: ControlStore = {
      load: async () => empty(),
      apply: async () => {
        throw failure
      },
      lastMutation: async () => {
        throw new Error('must not read')
      },
    }
    await expect(applyResolved(store, {}, 'mutation')).rejects.toBe(failure)
  })
})

describe('memory host database', () => {
  test('unsettled control prevents deletion and settled deletion removes the whole group only', async () => {
    const db = createMemoryHostDatabase()
    await db.saveState('other', new Uint8Array([9]))
    await db.saveState('group', new Uint8Array([1]))
    await db.control('group').apply({ putOperations: [operation('open', 1)] }, 'open')
    await expect(db.delete('group')).rejects.toBeInstanceOf(GroupControlUnsettledError)
    expect(await db.loadState('group')).toEqual(new Uint8Array([1]))
    await db
      .control('group')
      .apply({ deleteOperations: ['open'], putApplied: [applied(1)] }, 'settled')
    await db.delete('group')
    expect(await db.loadState('group')).toBeNull()
    expect(await db.control('group').lastMutation()).toBeNull()
    expect((await db.control('group').load()).applied).toEqual([])
    expect(await db.loadState('other')).toEqual(new Uint8Array([9]))
  })

  test('a nonmatching anchor advance is never marked landed', async () => {
    const db = createMemoryHostDatabase()
    const slot = {
      anchor: { secret: new Uint8Array([1]), epoch: 1 },
      pending: {
        advance: 'pending',
        epochBefore: 1,
        epochAfter: 2,
        rosterBefore: ['alice'],
        forced: true,
      },
    }
    await db.anchorStore('group').save(slot)
    await db.saveState('group', new Uint8Array([2]), {
      changes: {},
      mutationID: 'save',
      anchorLanded: 'different',
    })
    expect(await db.anchorStore('group').load()).toEqual(slot)
  })

  test('an ambiguous state save retains the entire committed transaction', async () => {
    const db = createMemoryHostDatabase()
    db.commitThenRejectNext('save')
    await expect(
      db.saveState('group', new Uint8Array([2]), {
        changes: { putApplied: [applied(1)] },
        mutationID: 'save',
      }),
    ).rejects.toBeInstanceOf(StorageOutcomeUnknownError)
    expect(await db.loadState('group')).toEqual(new Uint8Array([2]))
    expect((await db.control('group').load()).applied).toEqual([applied(1)])
    expect(await db.control('group').lastMutation()).toBe('save')
  })

  test('after-commit seams see durable state and run once', async () => {
    const db = createMemoryHostDatabase()
    let calls = 0
    db.seam('after-save', async () => {
      calls++
      expect(await db.loadState('group')).toEqual(new Uint8Array([1]))
    })
    await db.saveState('group', new Uint8Array([1]))
    await db.saveState('group', new Uint8Array([2]))
    expect(calls).toBe(1)
  })
})
