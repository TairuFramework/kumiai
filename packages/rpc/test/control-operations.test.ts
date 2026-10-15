import { expect, test, vi } from 'vitest'

import { encodeControlFixtureState } from '../../rpc-conformance/src/control-store.js'
import { createMemoryControlStore } from '../../rpc-conformance/src/memory-control-store.js'
import { digestAppliedCommit } from '../src/classify.js'
import { decodeCommitFrame, encodeCommitFrame } from '../src/commit-frame.js'
import {
  enqueueOperation,
  landedChanges,
  type OperationDeps,
  stepOperation,
} from '../src/control/operations.js'
import { forkEventID } from '../src/control/safety.js'
import { type ControlSearchDeps, createControlSearch } from '../src/control/search.js'
import { controlBuildRef } from '../src/control/slot.js'
import type {
  ControlChanges,
  ControlSlot,
  FirstValidCommit,
  HostBuilt,
  Operation,
  OperationRequest,
  Outcome,
} from '../src/control/types.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { commitTopic } from '../src/topic.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer, seedBuiltOperation } from './fixtures/peer.js'

const request: OperationRequest = {
  id: 'invite',
  kind: 'invite',
  revokes: false,
  body: new Uint8Array([7]),
}
const key = { groupID: 'group-A', incarnation: 1 }
const head = asLogPosition('004')
const position = asLogPosition('005')
const payload = new TextEncoder().encode('abc')
const payloadDigest = 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0'
const publishID = 'fedcba9876543210fedcba9876543210'

test('own-copy reconciliation advances its cursor without re-entering settlement', async () => {
  const secret = new Uint8Array(32).fill(0xa3)
  const hub = new FakeHub()
  const member = makeMLSPeer(hub, 'alice', secret)
  let restoreFetch = () => {}
  let restorePublish = () => {}
  try {
    await member.peer.replay()
    const op = await seedBuiltOperation(member, buildLedgerCommit(member, ['saved-own-body']))
    const frame = decodeCommitFrame(decodeHandshakeFrame(op.slot.payload).payload)
    const bad = frame.sealedEntries.slice()
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1
    const poison = await hub.publish({
      senderDID: 'replayer',
      topicID: commitTopic(secret),
      retain: 'log',
      payload: encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(frame.commit, bad)),
    })
    const fetch = hub.fetchTopic.bind(hub)
    let fetches = 0
    const fetching = vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
      if (params.topicID === commitTopic(secret) && ++fetches > 12)
        throw new Error('Recursive own-copy reconciliation')
      return fetch(params)
    })
    restoreFetch = () => fetching.mockRestore()
    const publish = hub.publish.bind(hub)
    const publishing = vi.spyOn(hub, 'publish').mockImplementation(async (params) => {
      if (params.senderDID === 'alice' && params.topicID === commitTopic(secret))
        throw Object.assign(new Error('Retry remains undelivered'), { name: 'HeadMismatchError' })
      return publish(params)
    })
    restorePublish = () => publishing.mockRestore()
    await expect(member.peer.replay()).resolves.toEqual({})
    const snapshot = await member.control.load()
    expect(snapshot.cursor?.position).toBe(poison.sequenceID)
    expect(snapshot.commitOnce?.payload).toEqual(op.slot.payload)
    expect(snapshot.commitOnce?.publishID).toBe(op.slot.publishID)
    expect(snapshot.commitOnceAcceptance).toBeNull()
    expect(snapshot.outcomes).toEqual([])
    expect(snapshot.forkHalt).toBeNull()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
    restoreFetch()
    restorePublish()
  }
})

async function setup(framed?: { payload: Uint8Array; digest: string }) {
  const store = createMemoryControlStore<LogPosition>(key)
  let identity = { ...key, epoch: 4, authenticator: new Uint8Array([3]) }
  await store.saveState(encodeControlFixtureState(identity))
  await store.apply({ cursor: { position: head, epoch: 4 } }, 'checkpoint')
  const writes: Array<ControlChanges> = []
  const emitted: Array<Outcome> = []
  let clock = 100
  let serial = 0
  let published: LogPosition | null = null
  const hostBuilt: HostBuilt = {
    commit: new Uint8Array([1]),
    bodies: ['signed-body'],
    journal: new Uint8Array([2]),
    welcome: { bytes: new Uint8Array([9]), recipients: ['bob'] },
    epoch: 4,
    authenticatorBefore: new Uint8Array([3]),
    incarnation: 1,
    digest: framed?.digest ?? 'commit-digest',
  }
  const readEvidence = async () => {
    const snapshot = await store.load()
    return {
      source: { key, identity, stateVersion: await store.loadVersion() },
      applied: snapshot.applied,
      cursor: snapshot.cursor,
      terminal: false,
    }
  }
  const proof = async (slot: ControlSlot): Promise<FirstValidCommit> => ({
    source: (await readEvidence()).source,
    from: slot.searchFrom,
    position,
    payloadDigest: slot.payloadDigest,
  })
  let safety = false
  const deps: OperationDeps = {
    safetyHold: () => (safety ? 'fork-halted' : null),
    haltFork: async (evidence) => {
      safety = true
      await store.apply(
        { forkHalt: { eventID: forkEventID(store.key), evidence, detectedAt: 1 } },
        'halt',
      )
    },
    control: {
      key,
      load: store.load,
      lastMutation: store.lastMutation,
      apply: async (changes, id) => {
        await store.apply(changes, id)
        writes.push(structuredClone(changes))
      },
    },
    prepareBuild: vi.fn<OperationDeps['prepareBuild']>(async (op, frame) => {
      if (op.stage !== 'intent') return { kind: 'moved', operation: op }
      const framed = await frame(hostBuilt, async (bytes) => ({
        sealed: bytes,
        epoch: hostBuilt.epoch,
      }))
      const evidence = await readEvidence()
      const slot: ControlSlot = {
        ...hostBuilt,
        ...framed,
        opID: op.id,
        searchFrom: evidence.cursor?.position ?? null,
        payloadDigest: framed === undefined ? payloadDigest : digestAppliedCommit(framed.payload),
      }
      const kind = await store.saveBuilt(op, slot, evidence.source, deps.newID())
      return {
        kind,
        operation: kind === 'saved' ? { ...op, stage: 'built', built: controlBuildRef(slot) } : op,
      }
    }),
    frame: vi.fn(async () => ({
      payload: framed?.payload ?? payload,
      publishID,
      expectedHead: head,
    })),
    publish: vi.fn(async () => {
      published = position
      return { sequenceID: position }
    }),
    searchLog: vi.fn<OperationDeps['searchLog']>(async (built) =>
      published === null
        ? { kind: 'absent' }
        : { kind: 'first-valid', proof: await proof({ ...built, opID: request.id }) },
    ),
    adopt: vi.fn<OperationDeps['adopt']>(async (_journal, expected, write) => {
      expect(expected.stateVersion).toBe(await store.loadVersion())
      identity = { ...identity, epoch: identity.epoch + 1, authenticator: new Uint8Array([5]) }
      await store.saveState(encodeControlFixtureState(identity), write)
      return 'installed'
    }),
    readEvidence,
    readHead: vi.fn(async () => head),
    pullToHead: vi.fn(async () => {}),
    now: () => clock,
    operationTimeoutMs: 1_000,
    newID: () => String(++serial),
    emit: (outcome) => emitted.push(outcome),
  }
  const enqueue = () => enqueueOperation(deps, request)
  const built = async () => {
    const op = await stepOperation(deps, await enqueue())
    if (op?.stage !== 'built') throw new Error('expected built operation')
    return op
  }
  return {
    store,
    deps,
    emitted,
    writes,
    enqueue,
    built,
    proof,
    mismatch: () => {
      deps.publish = vi.fn(async () => {
        throw Object.assign(new Error('head changed'), { name: 'HeadMismatchError' })
      })
    },
    tick: (now: number) => {
      clock = now
    },
    found: () => {
      published = position
    },
    move: async (epoch: number, authenticator = new Uint8Array([6])) => {
      identity = { ...identity, epoch, authenticator }
      await store.saveState(encodeControlFixtureState(identity))
    },
  }
}

async function searchSetup() {
  const frame = (commit: number, blob = new Uint8Array()) =>
    encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(new Uint8Array([commit]), blob))
  const h = await setup({ payload: frame(1), digest: digestAppliedCommit(new Uint8Array([1])) })
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  if (slot === null) throw new Error('expected saved build')
  let observedHead = head
  const rows: Array<{
    sequenceID: LogPosition
    payload: Uint8Array
    senderDID: string
    topicID: string
    receivedAt: number
  }> = []
  const searchDeps: ControlSearchDeps = {
    budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
    fetch: async (after) => ({
      messages: rows.filter(
        (row) => (after === null || row.sequenceID > after) && row.sequenceID <= observedHead,
      ),
      head: observedHead,
      oldest: rows[0]?.sequenceID ?? head,
      gap: false,
    }),
    validation: {
      restoreValidation: async () => ({
        source: (await h.deps.readEvidence()).source,
        readCommitHeader: async () => ({ epoch: slot.epoch }),
        validateFrame: async () => ({ kind: 'invalid', reason: 'policy' }),
        verifyOwn: async () => false,
      }),
    },
    readEvidence: h.deps.readEvidence,
    followWinner: async () => ({ kind: 'unavailable' }),
    reconcileAbsent: async () => true,
    hold: async (controlHold) => {
      await h.store.apply({ controlHold }, h.deps.newID())
    },
    haltFork: h.deps.haltFork,
    safetyHold: h.deps.safetyHold,
  }
  h.deps.searchLog = createControlSearch(searchDeps).searchLog
  h.deps.readHead = async () => observedHead
  const append = (sequenceID: LogPosition, payload: Uint8Array) => {
    rows.push({ sequenceID, payload, senderDID: 'publisher', topicID: 'commits', receivedAt: 1 })
    observedHead = sequenceID
  }
  return {
    ...h,
    op,
    slot,
    frame,
    searchDeps,
    append,
    observe: (value: LogPosition) => {
      observedHead = value
    },
  }
}

test.each(['fetch', 'frame'] as const)(
  'repeated unknown from %s budget exhaustion publishes no extra copies',
  async (budget) => {
    const h = await searchSetup()
    h.searchDeps.budget = {
      maxPasses: 2,
      maxFetches: budget === 'fetch' ? 1 : 16,
      maxFrames: budget === 'frame' ? 1 : 256,
    }
    const fetch = h.searchDeps.fetch
    if (budget === 'fetch') {
      h.searchDeps.fetch = async (after) => {
        const page = await fetch(after)
        return { ...page, messages: page.messages.slice(0, 1) }
      }
    }
    for (let value = 5; value < 105; value++) {
      h.append(asLogPosition(String(value).padStart(3, '0')), new Uint8Array([0]))
    }
    for (let step = 0; step < 10; step++) {
      expect(await stepOperation(h.deps, h.op)).toEqual(h.op)
    }
    expect(h.deps.publish).not.toHaveBeenCalled()
    expect((await h.store.load()).commitOnce).toEqual(h.slot)
    expect((await h.store.load()).outcomes).toEqual([])
    expect(h.deps.prepareBuild).toHaveBeenCalledOnce()
  },
)

test('a copy mismatch republishes once per distinct head and skips its landed head', async () => {
  const h = await searchSetup()
  h.append(position, h.frame(1, new Uint8Array([9])))
  const landed = asLogPosition('006')
  const fresh = asLogPosition('007')
  h.deps.publish = vi.fn(async () => ({ sequenceID: landed }))
  for (let step = 0; step < 5; step++) await stepOperation(h.deps, h.op)
  expect(h.deps.publish).toHaveBeenCalledOnce()
  h.append(landed, new Uint8Array([0]))
  for (let step = 0; step < 5; step++) await stepOperation(h.deps, h.op)
  expect(h.deps.publish).toHaveBeenCalledOnce()
  h.append(fresh, h.frame(1, new Uint8Array([8])))
  for (let step = 0; step < 5; step++) await stepOperation(h.deps, h.op)
  expect(h.deps.publish).toHaveBeenCalledTimes(2)
  h.observe(position)
  await stepOperation(h.deps, h.op)
  expect(h.deps.publish).toHaveBeenCalledTimes(2)
  expect(h.deps.publish).toHaveBeenNthCalledWith(1, h.slot.payload, h.slot.publishID, position)
  expect(h.deps.publish).toHaveBeenNthCalledWith(2, h.slot.payload, h.slot.publishID, fresh)
  expect(h.deps.prepareBuild).toHaveBeenCalledOnce()
  expect(h.deps.adopt).not.toHaveBeenCalled()
  expect((await h.store.load()).outcomes).toEqual([])
})

test('an identical latest own copy prevents further republishing after reconstruction', async () => {
  const h = await searchSetup()
  h.append(position, h.frame(1, new Uint8Array([9])))
  h.deps.publish = vi.fn(async () => {
    const landed = asLogPosition('006')
    h.append(landed, h.slot.payload)
    return { sequenceID: landed }
  })
  await stepOperation(h.deps, h.op)
  const restarted = {
    ...h.deps,
    control: { ...h.deps.control },
    searchLog: createControlSearch(h.searchDeps).searchLog,
  }
  for (let step = 0; step < 10; step++) await stepOperation(restarted, h.op)
  expect(h.deps.publish).toHaveBeenCalledOnce()
  expect((await h.store.load()).controlHold?.reason).toBe('acceptance-unknown')
  expect((await h.store.load()).outcomes).toEqual([])
})

test.each(['invalid', 'missing-header'] as const)(
  'an identical own copy with %s validation never republishes',
  async (fault) => {
    const h = await searchSetup()
    h.append(position, h.slot.payload)
    if (fault === 'missing-header') {
      const restore = h.searchDeps.validation.restoreValidation
      h.searchDeps.validation.restoreValidation = async (built) => {
        const validation = await restore(built)
        return validation === null ? null : { ...validation, readCommitHeader: async () => null }
      }
    }
    for (let step = 0; step < 10; step++) await stepOperation(h.deps, h.op)
    expect(h.deps.publish).not.toHaveBeenCalled()
    expect((await h.store.load()).commitOnce).toEqual(h.slot)
    expect((await h.store.load()).outcomes).toEqual([])
  },
)

test('unexplained own commits never republish the retained build', async () => {
  const h = await searchSetup()
  const restore = h.searchDeps.validation.restoreValidation
  h.searchDeps.validation.restoreValidation = async (built) => {
    const validation = await restore(built)
    if (validation === null) throw new Error('expected validation')
    return {
      ...validation,
      validateFrame: async () => ({ kind: 'unavailable', reason: 'unexplained-own' }),
    }
  }
  h.append(position, h.frame(2))
  for (let step = 0; step < 10; step++) await stepOperation(h.deps, h.op)
  expect(h.deps.publish).not.toHaveBeenCalled()
  expect((await h.store.load()).commitOnce).toEqual(h.slot)
  expect((await h.store.load()).outcomes).toEqual([])
  expect((await h.store.load()).forkHalt).toBeNull()
})

test.each(['missing-validation', 'header-error'] as const)(
  '%s unknown never republishes the retained build',
  async (fault) => {
    const h = await searchSetup()
    h.append(position, h.frame(1, new Uint8Array([9])))
    const restore = h.searchDeps.validation.restoreValidation
    h.searchDeps.validation.restoreValidation = async (built) => {
      if (fault === 'missing-validation') return null
      const validation = await restore(built)
      if (validation === null) throw new Error('expected validation')
      return {
        ...validation,
        readCommitHeader: async () => {
          throw new Error('header unavailable')
        },
      }
    }
    for (let step = 0; step < 10; step++) await stepOperation(h.deps, h.op)
    expect(h.deps.publish).not.toHaveBeenCalled()
    expect((await h.store.load()).commitOnce).toEqual(h.slot)
    expect((await h.store.load()).outcomes).toEqual([])
  },
)

test('enqueue persists the selected absolute deadline', async () => {
  const h = await setup()
  h.tick(0)
  expect((await h.enqueue()).deadline).toBe(1_000)
  h.deps.operationTimeoutMs = undefined
  expect((await enqueueOperation(h.deps, { ...request, id: 'default' })).deadline).toBe(30_000)
})

test.each([30_000, 100])(
  'deadline survives reconstruction with changed configuration %s',
  async (timeout) => {
    const h = await setup()
    h.tick(0)
    const op = await h.built()
    h.mismatch()
    const restarted = { ...h.deps, operationTimeoutMs: timeout }
    h.tick(999)
    expect((await stepOperation(restarted, op))?.deadline).toBe(1_000)
    expect((await h.store.load()).outcomes).toEqual([])
    h.tick(1_000)
    expect(await stepOperation(restarted, op)).toBeNull()
    expect((await h.store.load()).outcomes).toMatchObject([{ kind: 'lost', at: 1_000 }])
    h.tick(1_001)
    expect((await h.store.load()).operations).toEqual([])
    expect(h.deps.publish).toHaveBeenCalledOnce()
    expect((await h.store.load()).commitOnce).not.toBeNull()
  },
)

test('default timeout expires at the persisted deadline boundary', async () => {
  const h = await setup()
  h.deps.operationTimeoutMs = undefined
  const op = await h.built()
  expect(op.deadline).toBe(30_100)
  h.mismatch()
  h.tick(30_099)
  expect((await stepOperation(h.deps, op))?.stage).toBe('built')
  h.tick(30_100)
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect((await h.store.load()).outcomes).toMatchObject([{ kind: 'lost', at: 30_100 }])
})

test('never-built expired intents lose without building', async () => {
  const h = await setup()
  const op = await h.enqueue()
  h.tick(op.deadline)
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect(h.deps.prepareBuild).not.toHaveBeenCalled()
  expect(h.emitted).toMatchObject([{ kind: 'lost' }])
})

test('enqueue persists FIFO intents and resolves ambiguous committed writes', async () => {
  const h = await setup()
  const first = await h.enqueue()
  h.store.commitThenRejectNext('apply')
  const second = await enqueueOperation(h.deps, {
    ...request,
    id: 'remove',
    kind: 'remove',
    revokes: true,
  })
  expect(first).toEqual({ ...request, seq: 1, enqueuedAt: 100, deadline: 1_100, stage: 'intent' })
  expect(second.seq).toBe(2)
  expect((await h.store.load()).operations).toEqual([first, second])
})

test('saved build references its slot and certified landing co-commits durable effects', async () => {
  const h = await setup()
  const op = await h.built()
  expect(op.built).toEqual({ incarnation: 1, epoch: 4, publishID, payloadDigest })
  expect(h.deps.pullToHead).toHaveBeenCalledOnce()
  expect(h.deps.publish).not.toHaveBeenCalled()
  expect((await h.store.load()).welcomes).toEqual([])
  h.tick(200)
  expect(await stepOperation(h.deps, op)).toBeNull()
  const snapshot = await h.store.load()
  expect(snapshot.operations).toEqual([])
  expect(snapshot.commitOnce).toBeNull()
  expect(snapshot.commitOnceAcceptance).toBeNull()
  const applied = {
    epoch: 4,
    digest: 'commit-digest',
    payloadDigest,
    sequenceID: position,
    opID: request.id,
    removed: false,
  }
  expect(snapshot.applied).toEqual([applied])
  expect(snapshot.cursor).toEqual({ position, epoch: 5 })
  expect(snapshot.outcomes).toEqual([
    {
      id: JSON.stringify(['control:landed', request.id, publishID, position]),
      opID: request.id,
      kind: 'landed',
      position,
      at: 200,
    },
  ])
  expect(snapshot.welcomes).toEqual([
    { opID: request.id, welcome: new Uint8Array([9]), recipients: ['bob'], committed: true },
  ])
  expect(h.deps.adopt).toHaveBeenCalledWith(
    new Uint8Array([2]),
    expect.objectContaining({
      key,
      stateVersion: 1,
      identity: expect.objectContaining({ epoch: 4 }),
      acceptance: expect.objectContaining({ from: head, position, payloadDigest }),
    }),
    expect.objectContaining({
      changes: expect.objectContaining({ deleteOperations: [request.id] }),
    }),
  )
  expect(h.emitted).toEqual(snapshot.outcomes)
  expect(landedChanges(op, position, applied)).toMatchObject({
    deleteOperations: [request.id],
    putApplied: [applied],
    cursor: { position, epoch: 5 },
  })
  expect(landedChanges(op, position, { ...applied, removed: true }).cursor).toEqual({
    position,
    epoch: 5,
    stranded: true,
  })
})

test.each(['not authorised', 'holder evidence refused'])(
  'explicit rejection settles durably: %s',
  async (reason) => {
    const h = await setup()
    h.deps.prepareBuild = async (operation) => ({ kind: 'rejected', operation, reason })
    expect(await stepOperation(h.deps, await h.enqueue())).toBeNull()
    expect((await h.store.load()).operations).toEqual([])
    expect((await h.store.load()).outcomes).toMatchObject([{ kind: 'rejected', reason }])
    expect(h.emitted).toEqual((await h.store.load()).outcomes)
    expect(h.deps.frame).not.toHaveBeenCalled()
  },
)

test.each(['occupied', 'moved'] as const)(
  'preparation %s keeps the intent without an outcome',
  async (kind) => {
    const h = await setup()
    const op = await h.enqueue()
    h.deps.prepareBuild = async (operation) => ({ kind, operation })
    expect(await stepOperation(h.deps, op)).toEqual(op)
    expect((await h.store.load()).operations).toEqual([op])
    expect(h.emitted).toEqual([])
  },
)

test('transient preparation failure keeps the intent', async () => {
  const h = await setup()
  const op = await h.enqueue()
  const error = new Error('state unavailable')
  h.deps.prepareBuild = async () => {
    throw error
  }
  await expect(stepOperation(h.deps, op)).rejects.toBe(error)
  expect((await h.store.load()).operations).toEqual([op])
  expect(h.emitted).toEqual([])
})

test('complete head-only absence refreshes CAS without rebuilding', async () => {
  const h = await setup()
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  h.mismatch()
  const nextHead = asLogPosition('006')
  h.deps.readHead = async () => nextHead
  for (let attempt = 0; attempt < 6; attempt++) expect(await stepOperation(h.deps, op)).toEqual(op)
  expect((await h.store.load()).commitOnce).toEqual({ ...slot, expectedHead: nextHead })
  expect(h.deps.prepareBuild).toHaveBeenCalledOnce()
  expect(h.deps.frame).toHaveBeenCalledOnce()
  expect(h.deps.searchLog).toHaveBeenCalledTimes(12)
  expect(h.deps.publish).toHaveBeenCalledTimes(6)
  expect(h.deps.publish).toHaveBeenLastCalledWith(payload, publishID, nextHead)
})

test('proposal and version changes after built-save retain identical bytes', async () => {
  const h = await setup()
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  h.mismatch()
  await h.store.saveState(
    encodeControlFixtureState({ ...key, epoch: 4, authenticator: new Uint8Array([3]) }),
  )
  expect(await stepOperation(h.deps, op)).toEqual(op)
  expect((await h.store.load()).commitOnce).toEqual(slot)
  expect(h.deps.frame).toHaveBeenCalledOnce()
  expect(h.deps.prepareBuild).toHaveBeenCalledOnce()
  expect(h.deps.publish).toHaveBeenCalledWith(payload, publishID, head)
})

test('gap holds before deadline and settles unknown at deadline', async () => {
  const h = await setup()
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  h.deps.searchLog = async () => ({ kind: 'unknown' })
  expect(await stepOperation(h.deps, op)).toEqual(op)
  h.tick(op.deadline)
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect((await h.store.load()).outcomes).toMatchObject([{ kind: 'unknown' }])
  await h.store.apply({ deleteOutcomes: [request.id] }, 'ack')
  expect((await h.store.load()).commitOnce).toEqual(slot)
  expect(h.deps.publish).not.toHaveBeenCalled()
})

test('unknown copy retries the retained bytes at a fresh head and expires unknown', async () => {
  const h = await setup()
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  h.deps.searchLog = async () => ({ kind: 'unknown', retryHead: position })
  h.deps.readHead = async () => position
  expect(await stepOperation(h.deps, op)).toEqual(op)
  expect(h.deps.publish).toHaveBeenCalledWith(payload, publishID, position)
  expect((await h.store.load()).commitOnce).toEqual({ ...slot, expectedHead: position })
  expect(h.deps.prepareBuild).toHaveBeenCalledOnce()
  expect(h.deps.adopt).not.toHaveBeenCalled()
  h.tick(op.deadline)
  expect(await stepOperation({ ...h.deps }, op)).toBeNull()
  expect((await h.store.load()).outcomes).toMatchObject([{ kind: 'unknown' }])
  expect((await h.store.load()).commitOnce).toEqual({ ...slot, expectedHead: position })
})

test('an absence hint after a copy mismatch cannot erase unknown acceptance on restart', async () => {
  const h = await setup()
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  const owed = { id: 'owed-outcome', opID: 'prior-invite', at: 1, kind: 'unknown' as const }
  const welcome = {
    opID: 'prior-invite',
    welcome: new Uint8Array([8]),
    recipients: ['carol'],
    committed: true as const,
  }
  await h.store.apply(
    {
      controlHold: { reason: 'acceptance-unknown', position },
      putOutcomes: [owed],
      putWelcomes: [welcome],
    },
    'copy-mismatch',
  )
  h.deps.searchLog = async () => ({ kind: 'unknown' })
  h.mismatch()
  expect(await stepOperation(h.deps, op)).toEqual(op)
  h.deps.searchLog = async () => ({ kind: 'absent' })
  h.tick(op.deadline)
  expect(await stepOperation({ ...h.deps }, op)).toBeNull()
  const after = await h.store.load()
  expect(after.outcomes).toEqual([owed, expect.objectContaining({ opID: op.id, kind: 'unknown' })])
  expect(after.welcomes).toEqual([welcome])
  expect(after.commitOnce).toEqual(slot)
  expect(h.deps.prepareBuild).toHaveBeenCalledOnce()
})

test('transport failure retries before expiry and never hands off after expiry', async () => {
  const h = await setup()
  const op = await h.built()
  h.deps.publish = vi.fn(async () => {
    throw new Error('Offline')
  })
  expect(await stepOperation(h.deps, op)).toEqual(op)
  h.tick(op.deadline)
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect(h.deps.publish).toHaveBeenCalledOnce()
  expect((await h.store.load()).outcomes).toMatchObject([{ kind: 'unknown' }])
})

test('ambiguous handoff survives reconstruction and late landing replaces its unknown row', async () => {
  const h = await setup()
  const op = await h.built()
  h.deps.publish = async () => {
    throw new Error('Reply lost while the request can still land')
  }
  await stepOperation(h.deps, op)
  const restarted = { ...h.deps }
  const retained = (await h.store.load()).operations[0]
  if (retained === undefined) throw new Error('Missing retained operation')
  h.tick(op.deadline)
  expect(await stepOperation(restarted, retained)).toBeNull()
  expect((await h.store.load()).outcomes).toEqual([
    { id: op.id, opID: op.id, at: op.deadline, kind: 'unknown' },
  ])
  expect((await h.store.load()).welcomes).toEqual([])
  h.found()
  await stepOperation(restarted, retained)
  expect((await h.store.load()).outcomes).toEqual([
    {
      id: JSON.stringify(['control:landed', op.id, publishID, position]),
      opID: op.id,
      at: op.deadline,
      kind: 'landed',
      position,
    },
  ])
  expect((await h.store.load()).welcomes).toMatchObject([{ opID: op.id, committed: true }])
})

test('complete absence without a handoff loses at expiry and retains the slot', async () => {
  const h = await setup()
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  h.tick(op.deadline)
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect((await h.store.load()).outcomes).toEqual([
    { id: op.id, opID: op.id, at: op.deadline, kind: 'lost' },
  ])
  expect((await h.store.load()).commitOnce).toEqual(slot)
  expect(h.deps.publish).not.toHaveBeenCalled()
})

test.each([null, head])(
  'absence past an ambiguous CAS head %s loses at expiry',
  async (casHead) => {
    const h = await setup()
    const op = await h.built()
    h.deps.readHead = async () => casHead
    h.deps.publish = async () => {
      throw new Error('Reply lost')
    }
    await stepOperation(h.deps, op)
    h.deps.readHead = async () => asLogPosition('006')
    h.tick(op.deadline)
    expect(await stepOperation(h.deps, op)).toBeNull()
    expect((await h.store.load()).outcomes).toMatchObject([{ opID: op.id, kind: 'lost' }])
  },
)

test.each(['HeadMismatchError', 'AuthorizationDeniedError'])(
  'a later %s refusal cannot erase an earlier ambiguous handoff at the same head',
  async (name) => {
    const h = await setup()
    const op = await h.built()
    h.deps.publish = async () => {
      throw new Error('Reply lost')
    }
    await stepOperation(h.deps, op)
    h.deps.publish = async () => {
      throw Object.assign(new Error('Refused'), { name })
    }
    await stepOperation(h.deps, op)
    h.tick(op.deadline)
    expect(await stepOperation(h.deps, op)).toBeNull()
    expect((await h.store.load()).outcomes).toMatchObject([{ opID: op.id, kind: 'unknown' }])
  },
)

test.each(['strand', 'cursor'] as const)(
  'a retained built operation with a durable %s cannot publish or adopt',
  async (evidence) => {
    const h = await setup()
    const op = await h.built()
    await h.store.apply(
      evidence === 'strand'
        ? { strand: { reason: 'ahead' } }
        : { cursor: { position: head, epoch: 4, stranded: true } },
      'strand',
    )
    h.found()
    expect(await stepOperation(h.deps, op)).toEqual(op)
    expect(h.deps.publish).not.toHaveBeenCalled()
    expect(h.deps.adopt).not.toHaveBeenCalled()
    expect((await h.store.load()).commitOnce?.opID).toBe(op.id)
    expect((await h.store.load()).outcomes).toEqual([])
  },
)

test('already handed-off acceptance can land after expiry without another handoff', async () => {
  const h = await setup()
  const op = await h.built()
  h.deps.publish = vi.fn(async () => {
    h.tick(op.deadline + 1)
    h.found()
    return { sequenceID: position }
  })
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect(h.deps.publish).toHaveBeenCalledOnce()
  expect(h.emitted).toMatchObject([{ kind: 'landed' }])
})

test('epoch advance rebuilds only after complete absence and intent revalidation', async () => {
  const h = await setup()
  const op = await h.built()
  await h.move(5)
  h.deps.searchLog = async () => ({ kind: 'unknown' })
  expect(await stepOperation(h.deps, op)).toEqual(op)
  h.deps.searchLog = async () => ({ kind: 'absent' })
  const intent = await stepOperation(h.deps, op)
  expect(intent).toEqual({ ...request, seq: 1, enqueuedAt: 100, deadline: 1_100, stage: 'intent' })
  expect(h.deps.prepareBuild).toHaveBeenCalledOnce()
  if (intent === null) throw new Error('expected intent')
  h.deps.prepareBuild = vi.fn<OperationDeps['prepareBuild']>(async (operation) => ({
    kind: 'rejected',
    operation,
    reason: 'already satisfied',
  }))
  expect(await stepOperation(h.deps, intent)).toBeNull()
  expect(h.emitted).toMatchObject([{ kind: 'rejected', reason: 'already satisfied' }])
  expect(h.deps.publish).not.toHaveBeenCalled()
})

test('same-epoch divergence never republishes', async () => {
  const h = await setup()
  const op = await h.built()
  await h.move(4)
  h.mismatch()
  expect(await stepOperation(h.deps, op)).toEqual(op)
  expect(h.deps.publish).not.toHaveBeenCalled()
  expect((await h.store.load()).forkHalt?.evidence).toMatchObject({ kind: 'epoch-authenticator' })
})

test('accepted replay rechecks proof before adopt or Welcome release', async () => {
  const h = await setup()
  const op = await h.built()
  const slot = (await h.store.load()).commitOnce
  if (slot === null) throw new Error('expected slot')
  const acceptance = await h.proof(slot)
  const accepted: Operation = { ...op, stage: 'accepted', acceptedAs: position, acceptance }
  await h.store.apply({ putOperations: [accepted], commitOnceAcceptance: acceptance }, 'accepted')
  h.deps.searchLog = async () => ({ kind: 'unknown' })
  expect(await stepOperation(h.deps, accepted)).toEqual(accepted)
  expect(h.deps.adopt).not.toHaveBeenCalled()
  expect(h.deps.publish).not.toHaveBeenCalled()
})

test('moved adoption retains accepted work without synthesising branch evidence', async () => {
  const h = await setup()
  const op = await h.built()
  h.found()
  h.deps.adopt = async () => 'moved'
  expect(await stepOperation(h.deps, op)).toEqual(op)
  const snapshot = await h.store.load()
  expect(snapshot.operations).toMatchObject([{ stage: 'accepted', acceptedAs: position }])
  expect(snapshot.applied).toEqual([])
  expect(snapshot.cursor).toEqual({ position: head, epoch: 4 })
  expect(snapshot.outcomes).toEqual([])
})

test('settlement emits only after the outcome is durably committed', async () => {
  const h = await setup()
  const op = await h.built()
  h.deps.searchLog = async () => ({ kind: 'unknown' })
  h.tick(op.deadline)
  h.store.failNext('mid-apply')
  await expect(stepOperation(h.deps, op)).rejects.toThrow('Injected transaction failure')
  expect(h.emitted).toEqual([])
  expect((await h.store.load()).operations).toEqual([op])
  h.store.commitThenRejectNext('apply')
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect(h.emitted).toEqual((await h.store.load()).outcomes)
})

test('runner expiry preserves an existing outcome even when its operation row remains', async () => {
  const h = await setup()
  const op = await h.built()
  const outcome: Outcome = { id: op.id, opID: op.id, at: 200, kind: 'lost' }
  await h.store.apply({ putOutcomes: [outcome] }, 'already-settled')
  h.deps.searchLog = async () => ({ kind: 'unknown' })
  h.tick(op.deadline)
  expect(await stepOperation(h.deps, op)).toBeNull()
  expect((await h.store.load()).outcomes).toEqual([outcome])
  expect((await h.store.load()).operations).toEqual([op])
  expect(h.emitted).toEqual([])
})

test.each(['hold', 'terminal'] as const)(
  'expiry during an intent %s read settles lost',
  async (during) => {
    const h = await setup()
    const op = await h.enqueue()
    if (during === 'hold') {
      const load = h.deps.control.load
      h.deps.control.load = async () => {
        h.tick(op.deadline)
        return { ...(await load()), controlHold: { reason: 'acceptance-unknown', position: null } }
      }
    } else {
      const read = h.deps.readEvidence
      h.deps.readEvidence = async () => {
        h.tick(op.deadline)
        return { ...(await read()), terminal: true }
      }
    }
    expect(await stepOperation(h.deps, op)).toBeNull()
    expect(h.emitted).toMatchObject([{ kind: 'lost' }])
    expect(h.deps.prepareBuild).not.toHaveBeenCalled()
  },
)

test.each(['RecoveryRequiredError', 'AuthorizationDeniedError', 'Error'])(
  'a %s publication failure produces a diagnostic and retains its build',
  async (name) => {
    const h = await setup()
    const op = await h.built()
    const error = Object.assign(new Error('publication refused'), { name })
    const seen: Array<unknown> = []
    Object.assign(h.deps, {
      publishFailed: (id: string, failure: unknown) => {
        seen.push({ id, failure })
      },
    })
    h.deps.publish = async () => {
      throw error
    }
    expect(await stepOperation(h.deps, op)).toEqual(op)
    expect(seen).toEqual([{ id: op.id, failure: error }])
    expect((await h.store.load()).operations).toEqual([
      name === 'Error' ? { ...op, pendingPublish: { expectedHead: head } } : op,
    ])
  },
)

test.each(['intent', 'built', 'pending', 'accepted'] as const)(
  'expired %s under volatile safety settles using storage only',
  async (stage) => {
    const f = await setup()
    let op = stage === 'intent' ? await f.enqueue() : await f.built()
    if (op.stage !== 'intent' && stage === 'pending') {
      op = { ...op, pendingPublish: { expectedHead: head } }
    }
    if (op.stage !== 'intent' && stage === 'accepted') {
      const slot = (await f.store.load()).commitOnce
      if (slot === null) throw new Error('missing slot')
      const proof = {
        source: (await f.deps.readEvidence()).source,
        from: slot.searchFrom,
        position,
        payloadDigest: slot.payloadDigest,
      }
      op = { ...op, stage: 'accepted', acceptedAs: position, acceptance: proof }
    }
    op = { ...op, deadline: 0 }
    await f.store.apply({ putOperations: [op] }, 'expire')
    f.deps.safetyHold = () => 'fork-halted'
    f.deps.haltFork = async () => {}
    const read = vi.spyOn(f.deps, 'readEvidence')
    vi.mocked(f.deps.pullToHead).mockClear()
    vi.mocked(f.deps.prepareBuild).mockClear()
    const before = await f.store.load()
    expect(await stepOperation(f.deps, op)).toBeNull()
    const after = await f.store.load()
    expect(after.outcomes).toMatchObject([{ kind: stage === 'intent' ? 'lost' : 'unknown' }])
    expect(after.commitOnce).toEqual(before.commitOnce)
    expect(after.cursor).toEqual(before.cursor)
    expect(after.strand).toEqual(before.strand)
    expect(read).not.toHaveBeenCalled()
    expect(f.deps.pullToHead).not.toHaveBeenCalled()
    expect(f.deps.searchLog).not.toHaveBeenCalled()
    expect(f.deps.prepareBuild).not.toHaveBeenCalled()
    expect(f.deps.readHead).not.toHaveBeenCalled()
    expect(f.deps.publish).not.toHaveBeenCalled()
    await f.store.apply({ deleteOutcomes: after.outcomes.map((row) => row.id) }, 'ack')
    expect((await f.store.load()).commitOnce).toEqual(before.commitOnce)
  },
)
