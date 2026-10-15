import { describe, expect, test } from 'vitest'

import {
  decodeControlFixtureState,
  encodeControlFixtureState,
} from '../../rpc-conformance/src/control-store.js'
import {
  createMemoryControlStore,
  type MemoryControlStore,
} from '../../rpc-conformance/src/memory-control-store.js'
import { applyChanges, applyResolved, controlSettled, pruneWindow } from '../src/control/store.js'
import type {
  AppliedCommit,
  ControlSlot,
  ControlSnapshot,
  ControlStore,
  LegacyRejoinRecord,
  Operation,
} from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import {
  ControlWriteNotCommittedError,
  GroupControlUnsettledError,
  StorageOutcomeUnknownError,
} from '../src/errors.js'
import { createMemoryHostDatabase } from './fixtures/host-db.js'

test.each([undefined, 'authenticated-commit'] as const)(
  'response persistence omits negative rows: %s',
  async (refusalAuthority) => {
    const row = {
      position: asLogPosition('refused'),
      epoch: 1,
      digest: 'commit',
      kind: 'refused' as const,
      reason: 'policy' as const,
      ...(refusalAuthority === undefined ? {} : { refusalAuthority }),
    }
    const real = applyChanges(empty(), { putResponses: [row] })
    const double = createMemoryControlStore({ groupID: 'group-A', incarnation: 1 })
    await double.apply({ putResponses: [row] }, 'response')
    expect(real.responses).toEqual([])
    expect((await double.load()).responses).toEqual([])
  },
)

test('legacy negative aliases cannot erase an applied response during compaction', () => {
  const accepted = {
    position: asLogPosition('shared'),
    epoch: 1,
    digest: 'accepted',
    kind: 'applied' as const,
    epochAfter: 2,
  }
  const negative = {
    position: accepted.position,
    epoch: 1,
    digest: 'refused',
    kind: 'refused' as const,
  }
  expect(
    applyChanges({ ...empty(), responses: [accepted, negative] }, { cursor: null }).responses,
  ).toEqual([accepted])
})

const empty = (): ControlSnapshot => ({
  commitOnce: null,
  commitOnceAcceptance: null,
  controlHold: null,
  forkHalt: null,
  recoveryUnavailable: null,
  strand: null,
  operations: [],
  rejoin: null,
  recoveryEpochFloor: null,
  settledRejoins: [],
  outcomes: [],
  welcomes: [],
  applied: [],
  responses: [],
  cursor: null,
})

test('legacy snapshot changes normalise recovery fields without rewriting the saved rejoin', () => {
  const snapshot = { ...empty(), rejoin }
  const { recoveryEpochFloor: _floor, settledRejoins: _settlements, ...legacy } = snapshot
  const before = structuredClone(legacy)
  const normalised = applyChanges(legacy, {})
  expect(normalised.recoveryEpochFloor).toBeNull()
  expect(normalised.settledRejoins).toEqual([])
  expect(normalised.rejoin).toEqual(before.rejoin)
  expect(legacy).toEqual(before)
})
const operation = (id: string, seq: number): Operation => ({
  id,
  seq,
  kind: 'invite',
  revokes: false,
  body: new Uint8Array([1]),
  enqueuedAt: 100,
  deadline: 30_100,
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

const rejoin: LegacyRejoinRecord = {
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
  source: {
    epoch: 1,
    authenticator: new Uint8Array([5]),
    key: { groupID: 'group-A', incarnation: 1 },
    head: null,
  },
  digest: 'rejoin-digest',
  epochAfter: 2,
  ledgerBefore: [],
  conflictEpoch: null,
}

describe('control changes', () => {
  test('slot survives operation deletion outcome acknowledgement and reopen', async () => {
    const db = createMemoryHostDatabase({
      readIdentity: (state) => decodeControlFixtureState(state),
    })
    const store = db.control('group-A', { groupID: 'group-A', incarnation: 1 })
    const slot: ControlSlot = {
      opID: 'owner',
      incarnation: 1,
      epoch: 4,
      authenticatorBefore: new Uint8Array([1]),
      publishID: 'publish',
      searchFrom: asLogPosition('003'),
      expectedHead: asLogPosition('003'),
      payload: new Uint8Array([2]),
      payloadDigest: 'payload',
      digest: 'commit',
      bodies: ['body'],
      journal: new Uint8Array([3]),
      welcome: { bytes: new Uint8Array([4]), recipients: ['bob'] },
    }
    const expected = structuredClone(slot)
    const intent: Operation & { stage: 'intent' } = { ...operation('owner', 1), stage: 'intent' }
    const key = { groupID: 'group-A', incarnation: 1 }
    const identity = { ...key, epoch: slot.epoch, authenticator: slot.authenticatorBefore }
    await db.saveState('group-A', encodeControlFixtureState(identity))
    await store.apply(
      { putOperations: [intent], cursor: { position: slot.searchFrom, epoch: slot.epoch } },
      'intent',
    )
    await db.saveBuilt(
      'group-A',
      key,
      intent,
      slot,
      { key, identity, stateVersion: await db.loadVersion('group-A') },
      'build',
    )
    slot.payload.fill(0)
    slot.journal.fill(0)
    slot.welcome?.recipients.push('mallory')
    await store.apply(
      {
        deleteOperations: ['owner'],
        putOutcomes: [{ id: 'owner', opID: 'owner', at: 1, kind: 'unknown' }],
      },
      'settle',
    )
    await store.apply({ deleteOutcomes: ['owner'] }, 'ack')
    const reopened = db.control('group-A', { groupID: 'group-A', incarnation: 1 })
    const loaded = await reopened.load()
    expect(loaded.operations).toEqual([])
    expect(loaded.outcomes).toEqual([])
    expect(loaded.commitOnce).toEqual(expected)
    loaded.commitOnce?.authenticatorBefore.fill(0)
    loaded.commitOnce?.welcome?.bytes.fill(0)
    expect((await reopened.load()).commitOnce).toEqual(expected)
  })
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
      deleteAppliedBelow: 5,
      putApplied: [{ ...applied(5), digest: 'replacement' }],
    })
    expect(result.operations.map((row) => row.id)).toEqual(['second', 'first'])
    expect(result.applied).toEqual([{ ...applied(5), digest: 'replacement' }, applied(6)])
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

  test('applied prune-below precedes puts and preserves the retained boundary', () => {
    const snapshot = {
      ...empty(),
      applied: [applied(0), applied(1), applied(2), applied(3), applied(4)],
    }
    const result = applyChanges(snapshot, {
      deleteAppliedBelow: 2,
      putApplied: [{ ...applied(0), digest: 'replacement' }],
    })
    expect(result.applied).toEqual([
      { ...applied(0), digest: 'replacement' },
      applied(2),
      applied(3),
      applied(4),
    ])
    expect(snapshot.applied).toEqual([applied(0), applied(1), applied(2), applied(3), applied(4)])
  })

  test('pruning retains exactly the newest 64 epochs without rewriting applied rows', () => {
    const snapshot = {
      ...empty(),
      applied: Array.from({ length: 65 }, (_, epoch) => applied(epoch)),
      responses: [
        { position: asLogPosition('old'), epoch: 0, digest: 'old', kind: 'applied' as const },
        { position: asLogPosition('one'), epoch: 1, digest: 'one', kind: 'applied' as const },
        { position: asLogPosition('two'), epoch: 1, digest: 'two', kind: 'applied' as const },
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
  test('an already-aborted signal rejects an ambiguous write with its identical reason', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before read-back')
    controller.abort(reason)
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined })
    const store: ControlStore = {
      key: { groupID: 'group-A', incarnation: 1 },
      load: async () => empty(),
      apply: async () => {
        throw new StorageOutcomeUnknownError()
      },
      lastMutation: async () => 'mutation',
    }
    await expect(applyResolved(store, {}, 'mutation', undefined, controller.signal)).rejects.toBe(
      reason,
    )
  })

  test('abort during pending read-back rejects an ambiguous write with its identical reason', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during read-back')
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined })
    let readStarted!: () => void
    const reading = new Promise<void>((resolve) => {
      readStarted = resolve
    })
    const store: ControlStore = {
      key: { groupID: 'group-A', incarnation: 1 },
      load: async () => empty(),
      apply: async () => {
        throw new StorageOutcomeUnknownError()
      },
      lastMutation: () => {
        readStarted()
        return new Promise<string | null>(() => {})
      },
    }
    const result = applyResolved(store, {}, 'mutation', undefined, controller.signal)
    const rejected = expect(result).rejects.toBe(reason)
    await Promise.race([reading, result.catch(() => {})])
    controller.abort(reason)
    await rejected
  })

  test.each([undefined, new Error('cancelled during retry delay'), { cancelled: true }, null])(
    'abort during retry delay rejects an ambiguous write with the expected reason %j',
    async (reason) => {
      const controller = new AbortController()
      Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined })
      if (reason === undefined) {
        Object.defineProperty(controller.signal, 'reason', { value: undefined })
      }
      let sleepStarted!: () => void
      const sleeping = new Promise<void>((resolve) => {
        sleepStarted = resolve
      })
      const store: ControlStore = {
        key: { groupID: 'group-A', incarnation: 1 },
        load: async () => empty(),
        apply: async () => {
          throw new StorageOutcomeUnknownError()
        },
        lastMutation: async () => {
          throw new Error('read unavailable')
        },
      }
      const result = applyResolved(
        store,
        {},
        'mutation',
        () => {
          sleepStarted()
          return new Promise<void>(() => {})
        },
        controller.signal,
      )
      const rejected =
        reason === undefined
          ? expect(result).rejects.toThrowError(
              Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
            )
          : expect(result).rejects.toBe(reason)
      await Promise.race([sleeping, result.catch(() => {})])
      controller.abort(reason)
      await rejected
    },
  )

  test('the structural memory double resolves ambiguity through the RPC ControlStore port', async () => {
    const store: ControlStore & Pick<MemoryControlStore, 'commitThenRejectNext'> =
      createMemoryControlStore({ groupID: 'group-A', incarnation: 1 })
    store.commitThenRejectNext('apply')
    await applyResolved(store, { putOperations: [operation('double', 1)] }, 'double-mutation')
    expect((await store.load()).operations).toEqual([operation('double', 1)])
  })
  test('commit then reject resolves through the committed mutation', async () => {
    const db = createMemoryHostDatabase()
    const store = db.control('group', { groupID: 'group', incarnation: 1 })
    db.commitThenRejectNext('apply')
    await applyResolved(store, { putOperations: [operation('open', 1)] }, 'mutation')
    expect((await store.load()).operations).toEqual([operation('open', 1)])
  })

  test('an ambiguous rejection without a commit signals a safe retry', async () => {
    const store: ControlStore = {
      key: { groupID: 'group-A', incarnation: 1 },
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
      key: { groupID: 'group-A', incarnation: 1 },
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
      key: { groupID: 'group-A', incarnation: 1 },
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
  test.each([
    { groupID: 'other-group', incarnation: 1 },
    { groupID: 'actual', incarnation: 2 },
  ])('refuses adoption for a different bound key: %j', async (expectedKey) => {
    const db = createMemoryHostDatabase({
      readIdentity: (_state, key) => ({
        ...key,
        epoch: 1,
        authenticator: new Uint8Array([7]),
      }),
    })
    const key = { groupID: 'actual', incarnation: 1 }
    const store = db.control('storage', key)
    await db.seed('storage', new Uint8Array([1]))
    const before = await db.snapshot('storage')
    await expect(
      db.saveState('storage', new Uint8Array([2]), {
        expected: {
          key: expectedKey,
          identity: { ...expectedKey, epoch: 1, authenticator: new Uint8Array([7]) },
          stateVersion: before.version,
        },
        changes: { putApplied: [applied(1)] },
        mutationID: 'wrong-key',
      }),
    ).rejects.toMatchObject({ name: 'ControlAdoptionMovedError' })
    expect(await db.snapshot('storage')).toEqual(before)
    expect(await store.lastMutation()).toBeNull()
    await db.saveState('storage', new Uint8Array([2]), {
      expected: {
        key,
        identity: { ...key, epoch: 1, authenticator: new Uint8Array([7]) },
        stateVersion: before.version,
      },
      changes: {},
      mutationID: 'matching-key',
    })
    expect(await db.loadState('storage')).toEqual(new Uint8Array([2]))
    expect(await store.lastMutation()).toBe('matching-key')
  })

  test('unsettled control prevents deletion and settled deletion removes the whole group only', async () => {
    const db = createMemoryHostDatabase()
    await db.saveState('other', new Uint8Array([9]))
    await db.saveState('group', new Uint8Array([1]))
    await db
      .control('group', { groupID: 'group', incarnation: 1 })
      .apply({ putOperations: [operation('open', 1)] }, 'open')
    await expect(db.delete('group')).rejects.toBeInstanceOf(GroupControlUnsettledError)
    expect(await db.loadState('group')).toEqual(new Uint8Array([1]))
    await db
      .control('group', { groupID: 'group', incarnation: 1 })
      .apply({ deleteOperations: ['open'], putApplied: [applied(1)] }, 'settled')
    await db.delete('group')
    expect(await db.loadState('group')).toBeNull()
    expect(
      await db.control('group', { groupID: 'group', incarnation: 1 }).lastMutation(),
    ).toBeNull()
    expect(
      (await db.control('group', { groupID: 'group', incarnation: 1 }).load()).applied,
    ).toEqual([])
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
    expect(
      (await db.control('group', { groupID: 'group', incarnation: 1 }).load()).applied,
    ).toEqual([applied(1)])
    expect(await db.control('group', { groupID: 'group', incarnation: 1 }).lastMutation()).toBe(
      'save',
    )
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

test.each(['built', 'published', 'confirmed', 'adopted', 'refused'] as const)(
  'legacy %s records retain saved bytes and conflict epoch across persistence',
  async (stage) => {
    const store = createMemoryControlStore({ groupID: 'group-A', incarnation: 1 })
    const saved: LegacyRejoinRecord = {
      ...structuredClone(rejoin),
      stage,
      conflictEpoch: 4,
      position: asLogPosition('legacy-position'),
      verdict: new Uint8Array([8, 9]),
      ...(stage === 'refused' ? { refusal: 'policy' as const } : {}),
    }
    const expected = structuredClone(saved)
    await store.apply({ putRejoin: saved }, 'legacy-save')
    saved.requestKey.fill(0)
    saved.candidate.fill(0)
    saved.payload.fill(0)
    saved.source.authenticator.fill(0)
    saved.verdict?.fill(0)
    const loaded = (await store.load()).rejoin
    expect(loaded).toEqual(expected)
    loaded?.requestKey.fill(0)
    expect((await store.load()).rejoin).toEqual(expected)
  },
)
