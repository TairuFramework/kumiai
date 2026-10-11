import { createHash } from 'node:crypto'
import { HeadMismatchError } from '@kumiai/hub-protocol'
import { describe, expect, test, vi } from 'vitest'

import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import {
  enqueueOperation,
  type HostBuilt,
  landedChanges,
  type OperationDeps,
  stepOperation,
} from '../src/control/operations.js'
import type {
  AppliedCommit,
  ControlChanges,
  OperationRequest,
  Outcome,
} from '../src/control/types.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import { OperationRejectedError } from '../src/errors.js'

const request: OperationRequest = {
  id: '0123456789abcdef0123456789abcdef',
  kind: 'invite',
  revokes: false,
  body: new Uint8Array([7]),
}
const hostBuilt: HostBuilt = {
  commit: new Uint8Array([1]),
  bodies: ['signed-body'],
  journal: new Uint8Array([2]),
  welcome: { bytes: new Uint8Array([9]), recipients: ['bob'] },
  epoch: 4,
  authenticatorBefore: new Uint8Array([3]),
  incarnation: 1,
  digest: 'commit-digest',
}
const head = asLogPosition('004')
const position = asLogPosition('005')
const payload = new TextEncoder().encode('abc')
// Independently known SHA-256 of "abc", encoded as base64url.
const payloadDigest = 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0'
const publishID = 'fedcba9876543210fedcba9876543210'
const applied: AppliedCommit = {
  epoch: 4,
  digest: 'commit-digest',
  payloadDigest,
  sequenceID: position,
  opID: request.id,
  removed: false,
}

test('enqueue persists the selected absolute deadline', async () => {
  const host = setup()
  host.tick(0)
  host.deps.operationTimeoutMs = 1_000
  const selected = await enqueueOperation(host.deps, request)
  expect(selected.deadline).toBe(1_000)
  expect((await host.store.load()).operations[0]?.deadline).toBe(1_000)
  host.deps.operationTimeoutMs = undefined
  const defaulted = await enqueueOperation(host.deps, { ...request, id: 'default' })
  expect(defaulted.deadline).toBe(30_000)
})

function setup() {
  const store = createMemoryControlStore<LogPosition>({ groupID: 'group-A', incarnation: 1 })
  const writes: Array<ControlChanges> = []
  const emitted: Array<Outcome> = []
  let clock = 100
  let serial = 0
  const deps: OperationDeps = {
    control: {
      key: store.key,
      load: store.load,
      lastMutation: store.lastMutation,
      apply: async (changes, mutationID) => {
        await store.apply(changes, mutationID)
        writes.push(structuredClone(changes))
      },
    },
    build: vi.fn(async () => structuredClone(hostBuilt)),
    frame: vi.fn(async () => ({ payload, publishID, expectedHead: head })),
    publish: vi.fn(async () => ({ sequenceID: position })),
    searchLog: vi.fn(async (_from, _digest, position) => {
      return position == null ? ('absent' as const) : { found: position }
    }),
    adopt: vi.fn(async (_journal, _expected, write) => {
      await store.saveState(new Uint8Array([5]), write)
      return 'installed' as const
    }),
    appliedAt: (epoch) => (epoch === 4 ? applied : undefined),
    pullToHead: vi.fn(async () => {}),
    now: () => clock,
    operationTimeoutMs: 1_000,
    newID: () => (++serial).toString(16).padStart(32, '0'),
    emit: (outcome) => emitted.push(outcome),
  }
  const enqueue = () => enqueueOperation(deps, request)
  const built = async () => {
    const op = await stepOperation(deps, await enqueue())
    if (op?.stage !== 'built') throw new Error('expected built operation')
    return op
  }
  const accepted = async () => {
    const op = await stepOperation(deps, await built())
    if (op?.stage !== 'accepted') throw new Error('expected accepted operation')
    return op
  }
  const mismatch = () => {
    deps.publish = async () => {
      // Remote hubs reconstruct the error by name.
      const error = new Error('head changed')
      error.name = 'HeadMismatchError'
      throw error
    }
  }
  return {
    deps,
    store,
    writes,
    emitted,
    enqueue,
    built,
    accepted,
    mismatch,
    tick: (at: number) => {
      clock = at
    },
  }
}

describe('durable operations', () => {
  test('enqueue persists FIFO intents before returning, including the revoke hold', async () => {
    const h = setup()
    const first = await h.enqueue()
    h.store.commitThenRejectNext('apply')
    const second = await enqueueOperation(h.deps, {
      ...request,
      id: 'abcdef0123456789abcdef0123456789',
      kind: 'remove',
      revokes: true,
    })
    expect(first).toEqual({ ...request, stage: 'intent', seq: 1, enqueuedAt: 100, deadline: 1_100 })
    expect(second.seq).toBe(2)
    expect((await h.store.load()).operations).toEqual([first, second])
  })

  test('intent, built, accepted and landed each commit one durable transition', async () => {
    const h = setup()
    const op = await h.built()
    expect(op.built).toEqual({
      publishID,
      expectedHead: head,
      searchFrom: head,
      epoch: 4,
      authenticatorBefore: new Uint8Array([3]),
      incarnation: 1,
      payload,
      payloadDigest,
      digest: 'commit-digest',
      bodies: ['signed-body'],
      journal: new Uint8Array([2]),
      welcome: { bytes: new Uint8Array([9]), recipients: ['bob'] },
    })
    expect(h.deps.pullToHead).toHaveBeenCalledOnce()
    expect(h.deps.publish).not.toHaveBeenCalled()
    expect((await h.store.load()).welcomes).toEqual([])
    const accepted = await stepOperation(h.deps, op)
    expect(accepted).toEqual({ ...op, stage: 'accepted', acceptedAs: position })
    expect(h.writes.at(-1)).toEqual({
      putOperations: [accepted],
      putWelcomes: [{ opID: request.id, welcome: new Uint8Array([9]), recipients: ['bob'] }],
    })
    if (accepted?.stage !== 'accepted') throw new Error('expected accepted operation')
    h.tick(200)
    expect(await stepOperation(h.deps, accepted)).toBeNull()
    const snapshot = await h.store.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.outcomes).toMatchObject([
      { opID: request.id, at: 200, kind: 'landed', position },
    ])
    expect(snapshot.applied).toEqual([applied])
    expect(snapshot.cursor).toEqual({ position, epoch: 5 })
    expect(snapshot.welcomes).toHaveLength(1)
    expect(await h.store.loadState()).toEqual(new Uint8Array([5]))
    expect(h.deps.adopt).toHaveBeenCalledWith(
      new Uint8Array([2]),
      {
        epoch: 4,
        authenticatorBefore: new Uint8Array([3]),
        incarnation: 1,
      },
      expect.objectContaining({
        changes: expect.objectContaining({ deleteOperations: [request.id] }),
      }),
    )
    expect(h.writes).toHaveLength(3)
    expect(h.emitted).toEqual(snapshot.outcomes)
  })

  test.each(['not authorised', 'holder evidence refused'])(
    'build refusal settles as rejected: %s',
    async (reason) => {
      const h = setup()
      h.deps.build = async () => {
        throw new OperationRejectedError(reason)
      }
      expect(await stepOperation(h.deps, await h.enqueue())).toBeNull()
      const snapshot = await h.store.load()
      expect(snapshot.operations).toEqual([])
      expect(snapshot.outcomes).toMatchObject([{ kind: 'rejected', reason, opID: request.id }])
      expect(h.writes).toHaveLength(2)
      expect(h.writes[1]).toMatchObject({
        deleteOperations: [request.id],
        putOutcomes: snapshot.outcomes,
      })
      expect(h.emitted).toEqual(snapshot.outcomes)
      expect(h.deps.frame).not.toHaveBeenCalled()
    },
  )

  test('transient build errors keep the intent and do not emit rejection', async () => {
    const h = setup()
    const op = await h.enqueue()
    const error = new Error('state unavailable')
    h.deps.build = async () => {
      throw error
    }
    await expect(stepOperation(h.deps, op)).rejects.toBe(error)
    expect((await h.store.load()).operations).toEqual([op])
    expect(h.emitted).toEqual([])
  })

  test('head mismatch discovers the exact framed payload and accepts at its found position', async () => {
    const h = setup()
    const op = await h.built()
    h.mismatch()
    const found = asLogPosition('006')
    h.deps.searchLog = vi.fn(async () => ({ found }))
    const next = await stepOperation(h.deps, op)
    expect(next).toEqual({ ...op, stage: 'accepted', acceptedAs: found })
    expect(h.deps.searchLog).toHaveBeenCalledWith(head, payloadDigest)
    expect((await h.store.load()).welcomes).toHaveLength(1)
  })

  test('proven absence retries from the original intent and pulls only on the next step', async () => {
    const h = setup()
    const op = await h.built()
    h.mismatch()
    const next = await stepOperation(h.deps, op)
    expect(next).toEqual({ ...request, stage: 'intent', seq: 1, enqueuedAt: 100, deadline: 1_100 })
    expect(h.deps.pullToHead).toHaveBeenCalledTimes(1)
    expect((await h.store.load()).outcomes).toEqual([])
    if (next == null) throw new Error('expected retry')
    await stepOperation(h.deps, next)
    expect(h.deps.pullToHead).toHaveBeenCalledTimes(2)
  })

  test('a deadline based on persisted enqueue time survives rebuilding and a restart', async () => {
    const h = setup()
    h.mismatch()
    const first = await h.built()
    h.tick(500)
    const intent = await stepOperation(h.deps, first)
    if (intent == null) throw new Error('expected intent')
    await stepOperation(h.deps, intent)
    const restored = (await h.store.load()).operations[0]
    if (restored == null) throw new Error('expected persisted operation')
    h.tick(1_101)
    const restarted = { ...h.deps, now: () => 1_101 }
    expect(await stepOperation(restarted, restored)).toBeNull()
    expect((await h.store.load()).outcomes).toMatchObject([
      { kind: 'lost', opID: request.id, at: 1_101 },
    ])
    expect((await h.store.load()).operations).toEqual([])
    expect(h.emitted).toHaveLength(1)
  })

  test('retention gaps settle unknown, even after the deadline', async () => {
    const h = setup()
    const op = await h.built()
    h.mismatch()
    h.deps.searchLog = async () => 'gap'
    h.tick(10_000)
    expect(await stepOperation(h.deps, op)).toBeNull()
    expect((await h.store.load()).outcomes).toMatchObject([{ kind: 'unknown', opID: request.id }])
    expect(h.emitted).toHaveLength(1)
  })

  test('other publish errors keep built, including after the deadline', async () => {
    const h = setup()
    const op = await h.built()
    h.deps.publish = async () => {
      throw new Error('network unavailable')
    }
    h.tick(10_000)
    expect(await stepOperation(h.deps, op)).toEqual(op)
    expect((await h.store.load()).operations).toEqual([op])
    expect(h.writes).toHaveLength(2)
    expect(h.emitted).toEqual([])
  })

  test('built replay republishes the same bytes and ID after the host moves epoch', async () => {
    const h = setup()
    await h.built()
    const op = (await h.store.load()).operations[0]
    if (op == null) throw new Error('expected persisted operation')
    const moved = { ...h.deps, build: vi.fn(async () => ({ ...hostBuilt, epoch: 99 })) }
    const next = await stepOperation(moved, op)
    expect(next?.stage).toBe('accepted')
    expect(h.deps.publish).toHaveBeenCalledWith(payload, publishID, head)
    expect(moved.build).not.toHaveBeenCalled()
    expect(h.deps.frame).toHaveBeenCalledOnce()
  })

  test('re-wrapped bodies with the same MLS digest cannot establish acceptance', async () => {
    const h = setup()
    const op = await h.built()
    h.deps.publish = async () => {
      throw new HeadMismatchError()
    }
    const rewrapped = new TextEncoder().encode('abc-corrupted-bodies')
    const rewrappedDigest = createHash('sha256').update(rewrapped).digest('base64url')
    // The MLS commit is unchanged, but its frame bytes no longer match.
    h.deps.searchLog = async (_from, digest) => {
      if (digest === 'commit-digest' || digest === rewrappedDigest) return { found: position }
      expect(digest).toBe(payloadDigest)
      return 'absent'
    }
    expect((await stepOperation(h.deps, op))?.stage).toBe('intent')
    expect((await h.store.load()).welcomes).toEqual([])
    expect(h.emitted).toEqual([])
  })

  test.each([true, false])(
    'moved adoption consults the framed epoch and leaves branch evidence alone (match=%s)',
    async (match) => {
      const h = setup()
      const op = await h.accepted()
      const laterCursor = { position: asLogPosition('010'), epoch: 10, stranded: true as const }
      const row = { ...applied, digest: match ? 'commit-digest' : 'other-commit', opID: null }
      await h.store.apply({ putApplied: [row], cursor: laterCursor }, 'incoming')
      h.deps.adopt = async () => 'moved'
      h.deps.pullToHead = vi.fn(async () => {})
      h.deps.appliedAt = vi.fn((epoch) => (epoch === 4 ? row : undefined))
      expect(await stepOperation(h.deps, op)).toEqual(match ? null : op)
      const snapshot = await h.store.load()
      expect(snapshot.applied).toEqual([row])
      expect(snapshot.cursor).toEqual(laterCursor)
      expect(h.deps.appliedAt).toHaveBeenCalledWith(4)
      expect(h.deps.pullToHead).toHaveBeenCalledOnce()
      expect(snapshot.operations).toHaveLength(match ? 0 : 1)
      expect(snapshot.outcomes).toMatchObject(match ? [{ kind: 'landed', position }] : [])
      expect(h.emitted).toHaveLength(match ? 1 : 0)
    },
  )

  test('moved adoption without an applied witness remains accepted', async () => {
    const h = setup()
    const op = await h.accepted()
    h.deps.adopt = async () => 'moved'
    h.deps.appliedAt = () => undefined
    expect(await stepOperation(h.deps, op)).toEqual(op)
    expect((await h.store.load()).operations).toEqual([op])
    expect((await h.store.load()).cursor).toBeNull()
    expect(h.emitted).toEqual([])
  })

  test('noop adoption repairs missing control changes without writing host state', async () => {
    const h = setup()
    const op = await h.accepted()
    h.deps.adopt = async () => 'noop'
    expect(await stepOperation(h.deps, op)).toBeNull()
    const snapshot = await h.store.load()
    expect(snapshot.operations).toEqual([])
    expect(snapshot.outcomes).toMatchObject([{ kind: 'landed', position, opID: request.id }])
    expect(snapshot.applied).toEqual([applied])
    expect(snapshot.cursor).toEqual({ position, epoch: 5 })
    expect(await h.store.loadState()).toBeNull()
    expect(h.emitted).toEqual(snapshot.outcomes)
  })

  test('noop repair preserves an existing outcome, applied row and later cursor', async () => {
    const h = setup()
    const op = await h.accepted()
    const outcome: Outcome = {
      id: 'prior-outcome',
      opID: request.id,
      at: 150,
      kind: 'landed',
      position,
    }
    const row = { ...applied, opID: null }
    const laterCursor = { position: asLogPosition('010'), epoch: 10 }
    await h.store.apply({ putOutcomes: [outcome], putApplied: [row], cursor: laterCursor }, 'prior')
    h.deps.adopt = async () => 'noop'
    expect(await stepOperation(h.deps, op)).toBeNull()
    const snapshot = await h.store.load()
    expect(snapshot.outcomes).toEqual([outcome])
    expect(snapshot.applied).toEqual([row])
    expect(snapshot.cursor).toEqual(laterCursor)
    expect(snapshot.operations).toEqual([])
    expect(h.emitted).toEqual([])
  })

  test.each(['installed', 'noop'] as const)(
    'landing prunes applied and response windows in the same transaction (%s)',
    async (adoption) => {
      const h = setup()
      h.deps.build = async () => ({ ...hostBuilt, epoch: 64, welcome: null })
      const op = await h.accepted()
      await h.store.apply(
        {
          putApplied: Array.from({ length: 64 }, (_, epoch) => ({ ...applied, epoch })),
          putResponses: [
            { epoch: 0, position: asLogPosition('old'), digest: 'old', kind: 'refused' },
            { epoch: 1, position: asLogPosition('boundary'), digest: 'boundary', kind: 'refused' },
          ],
        },
        'seed-window',
      )
      if (adoption === 'noop') h.deps.adopt = async () => 'noop'
      expect(await stepOperation(h.deps, op)).toBeNull()
      const snapshot = await h.store.load()
      expect(snapshot.applied.map((row) => row.epoch)).toEqual(
        Array.from({ length: 64 }, (_, index) => index + 1),
      )
      expect(snapshot.applied.at(-1)).toMatchObject({ epoch: 64, opID: request.id })
      expect(snapshot.responses.map((row) => row.position)).toEqual(['boundary'])
      expect(snapshot.operations).toEqual([])
      expect(snapshot.welcomes).toEqual([])
    },
  )

  test('settlement emits only after the outcome is durably committed', async () => {
    const h = setup()
    const op = await h.built()
    h.mismatch()
    h.deps.searchLog = async () => 'gap'
    h.store.failNext('mid-apply')
    await expect(stepOperation(h.deps, op)).rejects.toThrow('Injected transaction failure')
    expect(h.emitted).toEqual([])
    expect((await h.store.load()).operations).toEqual([op])
    h.store.commitThenRejectNext('apply')
    expect(await stepOperation(h.deps, op)).toBeNull()
    expect(h.emitted).toEqual((await h.store.load()).outcomes)
  })

  test('landed changes bind the framed epoch row and next-epoch cursor in one write', async () => {
    const h = setup()
    const op = await h.accepted()
    const changes = landedChanges(op, position, applied)
    expect(changes).toMatchObject({
      deleteOperations: [request.id],
      putOutcomes: [{ kind: 'landed', opID: request.id, position }],
      putApplied: [applied],
      cursor: { position, epoch: 5 },
    })
    expect(landedChanges(op, position, { ...applied, removed: true }).cursor).toEqual({
      position,
      epoch: 5,
      stranded: true,
    })
  })
})
