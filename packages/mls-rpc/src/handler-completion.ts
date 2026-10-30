import {
  type AppCompletionCoverage,
  type AppCompletionCoverageSource,
  type BatchBudget,
  compareLogPositions,
  type HandlerCompletion,
  registerAppCompletionCoverage,
  sortPendingAppFrames,
} from '@kumiai/rpc'

import {
  coordinatorBinding,
  type EntryCapability,
  type EntryReads,
  entryCapability,
} from './entry-capability.js'
import { groupBatchFor } from './group-batch-binding.js'
import { copyStoredValue, sameStoredValue } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type {
  AppPoisonRecord,
  GroupKey,
  GroupPersistence,
  GroupStores,
  GroupTransaction,
  PendingAppFrame,
  PreOpenAppFrameRef,
} from './persistence-types.js'

type Registration = { source: AppCompletionCoverageSource; active: boolean }
type Capture = { registration: Registration; coverage: AppCompletionCoverage }
type Saved = { pending: PendingAppFrame | null; poison: AppPoisonRecord | null }
type Staged = {
  saved: Map<string, Saved>
  records: Array<PendingAppFrame>
  consumed: Array<Capture>
  remaining: Array<string>
}
class NoCompletion extends Error {}
class CoverageMoved extends Error {}
const services = new WeakMap<object, Map<string, unknown>>()
function occurrence(frame: PreOpenAppFrameRef): string {
  return JSON.stringify([
    frame.groupID,
    frame.incarnation,
    frame.topicID,
    frame.segment,
    frame.position,
    frame.id,
    frame.protocol,
  ])
}
function sameKey(a: GroupKey, b: GroupKey): boolean {
  return a.groupID === b.groupID && a.incarnation === b.incarnation
}
function frameOf(saved: Saved): PreOpenAppFrameRef | undefined {
  return saved.pending?.frame ?? saved.poison?.frame
}

export function createHandlerCompletion<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): HandlerCompletion<TTx> {
  const capability = entryCapability(params.persistence)
  const binding = coordinatorBinding(params.persistence)
  if (capability === null || binding === null)
    throw new GroupStateConflictError('Completion requires registered entry capability')
  return handlerCompletionForEntry({ capability, binding, key: params.key })
}

export function handlerCompletionForEntry<TTx extends GroupTransaction>(params: {
  capability: EntryCapability<TTx>
  binding: object
  key: GroupKey
}): HandlerCompletion<TTx> {
  const { capability, binding } = params
  const key = { ...params.key }
  const cacheKey = JSON.stringify([key.groupID, key.incarnation])
  let cached = services.get(binding)
  if (cached === undefined) {
    cached = new Map()
    services.set(binding, cached)
  }
  const existing = cached.get(cacheKey) as HandlerCompletion<TTx> | undefined
  if (existing !== undefined) return existing
  const scheduler = groupBatchFor(binding, key.groupID)
  const registrations = new Set<Registration>()
  let aggregateSource = 0
  const sourceID = JSON.stringify(['kumiai/completion/v1', key.groupID, key.incarnation])

  function capture(ids: Array<string>, only?: Registration): Array<Capture> {
    const result: Array<Capture> = []
    for (const registration of only === undefined ? registrations : [only]) {
      if (!registration.active) continue
      for (const coverage of registration.source.capture([...ids])) {
        if (!sameKey(coverage.key, key)) continue
        result.push({ registration, coverage: copyStoredValue(coverage) })
      }
    }
    return result
  }
  function current(captured: Capture): boolean {
    return captured.registration.active && captured.registration.source.current(captured.coverage)
  }
  async function validate(reads: EntryReads, captures: Array<Capture>): Promise<void> {
    for (const captured of captures) {
      if (!current(captured)) throw new CoverageMoved()
      if (
        (await reads.appCursor(key.incarnation, captured.coverage.topicID)) !==
        captured.coverage.previous
      )
        throw new GroupStateConflictError('Completion cursor moved')
    }
  }
  async function stage(
    reads: EntryReads,
    ids: Array<string>,
    captures: Array<Capture>,
    budget: BatchBudget,
    atomic: boolean,
    advance: boolean,
  ): Promise<Staged> {
    const saved = new Map<string, Saved>()
    budget.begin()
    const found: Array<{ frame: PreOpenAppFrameRef; value: Saved }> = []
    for (const id of ids) {
      const value = await reads.appFrame(key.incarnation, id)
      const frame = frameOf(value)
      if (frame !== undefined) {
        if (!sameKey(frame, key) || frame.id !== id)
          throw new GroupStateConflictError('Saved completion identity mismatch')
        found.push({ frame, value })
      }
    }
    if (found.length === 0 && !advance) throw new NoCompletion()
    await validate(reads, captures)
    if (atomic && new Set(found.map(({ frame }) => occurrence(frame))).size > budget.maxFrames)
      throw new RangeError('Atomic completion exceeds frame budget')
    const charged = new Set<string>()
    const take = (frame: PreOpenAppFrameRef) => {
      const id = occurrence(frame)
      if (charged.has(id)) return true
      if (!budget.take()) return false
      charged.add(id)
      return true
    }
    // Saved order is independent of the caller's array order.
    const ordered = found.sort(
      (a, b) =>
        a.frame.segment - b.frame.segment ||
        (a.frame.topicID < b.frame.topicID ? -1 : a.frame.topicID > b.frame.topicID ? 1 : 0) ||
        compareLogPositions(a.frame.position, b.frame.position),
    )
    for (const { frame, value } of ordered) {
      if (!take(frame)) {
        if (atomic) throw new RangeError('Atomic completion exceeds work budget')
        break
      }
      saved.set(frame.id, value)
    }
    if (saved.size === 0 && !advance) throw new NoCompletion()
    const consumed: Array<Capture> = []
    for (const captured of captures) {
      const coverage = captured.coverage
      if (coverage.through === null) continue
      const prefix: AppCompletionCoverage['prefix'] = []
      for (const member of coverage.prefix) {
        const frame = member.frame
        if (!sameKey(frame, key) || frame.topicID !== coverage.topicID) break
        const value = saved.get(frame.id) ?? (await reads.appFrame(key.incarnation, frame.id))
        const storedFrame = frameOf(value)
        if (storedFrame !== undefined && occurrence(storedFrame) !== occurrence(frame)) break
        if (member.state === 'pending' && !saved.has(frame.id)) break
        if (member.state === 'completed' && storedFrame !== undefined && !saved.has(frame.id)) break
        if (member.state === 'dead' && value.pending !== null) break
        if (!take(frame)) break
        if (value.poison !== null) saved.set(frame.id, value)
        prefix.push(copyStoredValue(member))
        if (frame.position === coverage.through) break
      }
      if (prefix.length > 0)
        consumed.push({
          registration: captured.registration,
          coverage: {
            ...copyStoredValue(coverage),
            prefix,
            through: prefix.at(-1)?.frame.position ?? null,
          },
        })
    }
    if (saved.size === 0 && consumed.length === 0) throw new NoCompletion()
    const records = sortPendingAppFrames(
      [...saved.values()].flatMap((value) =>
        value.pending === null ? [] : [copyStoredValue(value.pending)],
      ),
    )
    return {
      saved,
      records,
      consumed,
      remaining: found.filter(({ frame }) => !saved.has(frame.id)).map(({ frame }) => frame.id),
    }
  }
  async function recheck(
    stores: GroupStores<TTx>,
    staged: Staged,
    captures: Array<Capture>,
  ): Promise<void> {
    const rows = stores.incarnation(key.incarnation)
    for (const captured of captures) {
      if (!current(captured)) throw new CoverageMoved()
      if ((await rows.cursor.load(captured.coverage.topicID)) !== captured.coverage.previous)
        throw new GroupStateConflictError('Completion cursor moved')
    }
    const pending = await rows.pending.list()
    const poison = await rows.pending.listPoison()
    for (const [id, value] of staged.saved) {
      if (
        !sameStoredValue(pending.find((row) => row.frame.id === id) ?? null, value.pending) ||
        !sameStoredValue(poison.find((row) => row.frame.id === id) ?? null, value.poison)
      )
        throw new GroupStateConflictError('Saved completion changed')
    }
  }
  async function apply(
    stores: GroupStores<TTx>,
    staged: Staged,
    captures: Array<Capture>,
    handle?: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>,
  ): Promise<void> {
    // Keep host invocation in the synchronous entry.callback scope, even without async context.
    for (const captured of captures) if (!current(captured)) throw new CoverageMoved()
    const rows = stores.incarnation(key.incarnation)
    if (handle !== undefined && staged.records.length > 0)
      await handle(stores.tx, copyStoredValue(staged.records))
    // A source may withdraw while a non-preemptible callback is awaiting.
    for (const captured of captures)
      if (
        !current(captured) ||
        (await rows.cursor.load(captured.coverage.topicID)) !== captured.coverage.previous
      )
        throw new GroupStateConflictError('Coverage changed during completion callback')
    await rows.pending.complete([...staged.saved.keys()])
    for (const { coverage } of staged.consumed)
      if (coverage.through !== null) await rows.cursor.save(coverage.topicID, coverage.through)
  }
  async function turn(
    ids: Array<string>,
    captures: Array<Capture>,
    budget: BatchBudget,
    handle: ((tx: TTx, records: Array<PendingAppFrame>) => Promise<void>) | undefined,
    advance: boolean,
  ): Promise<Staged | undefined> {
    try {
      const staged = await capability.run(
        { groupID: key.groupID, mutationID: crypto.randomUUID() },
        async (reads) => {
          const expected = await reads.lifetime()
          const value = await stage(reads, ids, captures, budget, handle !== undefined, advance)
          return { expected, value }
        },
        async (stores, staged) => {
          await recheck(stores, staged, captures)
          return staged
        },
        async (stores, staged) => apply(stores, staged, captures, handle),
      )
      for (const registration of new Set(captures.map((item) => item.registration))) {
        if (registration.active)
          registration.source.committed(
            [...staged.saved.keys()],
            staged.consumed
              .filter((item) => item.registration === registration)
              .map((item) => copyStoredValue(item.coverage)),
          )
      }
      return staged
    } catch (error) {
      if (error instanceof NoCompletion) return undefined
      throw error
    }
  }
  async function run(
    ids: Array<string>,
    initial: Array<Capture>,
    handle?: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>,
    only?: Registration,
    advance = false,
  ): Promise<void> {
    let callback = handle
    let scheduledSource = sourceID
    if (handle !== undefined) {
      const protocols = await scheduler.schedule({
        source: JSON.stringify([sourceID, 'identify']),
        kind: 'completion',
        signal: capability.failureSignal,
        run: () =>
          capability.read(key.groupID, async (reads) => {
            const protocols = new Set<string>()
            for (const id of ids) {
              const saved = await reads.appFrame(key.incarnation, id)
              const frame = frameOf(saved)
              if (frame !== undefined) protocols.add(frame.protocol)
            }
            return [...protocols].sort()
          }),
      })
      if (protocols.length === 0) return
      scheduledSource =
        protocols.length === 1
          ? JSON.stringify([sourceID, 'protocol', protocols[0]])
          : JSON.stringify([sourceID, 'aggregate', ++aggregateSource])
    }
    let remaining = ids
    let captures = initial
    let advancing = advance
    for (;;) {
      let staged: Staged | undefined
      try {
        staged = await scheduler.schedule({
          source: scheduledSource,
          kind: 'completion',
          signal: capability.failureSignal,
          run: (budget) => turn(remaining, captures, budget, callback, advancing),
        })
      } catch (error) {
        if (!(error instanceof CoverageMoved)) throw error
        captures = capture(remaining, only)
        continue
      }
      if (staged === undefined) return
      remaining = staged.remaining
      // One explicit callback owns its complete atomic set, never a collector subset.
      callback = undefined
      scheduledSource = sourceID
      captures = capture(remaining, only)
      if (remaining.length === 0) advancing = true
      if (captures.length === 0 && remaining.length === 0) return
    }
  }
  const completion: HandlerCompletion<TTx> = {
    get key() {
      return { ...key }
    },
    complete(ids) {
      capability.assertRoot()
      const owned = [...new Set(ids)]
      if (owned.length === 0) return Promise.resolve()
      return run(owned, capture(owned))
    },
    transact(ids, handle) {
      capability.assertRoot()
      const owned = [...new Set(ids)]
      if (owned.length === 0) return Promise.resolve()
      return run(owned, capture(owned), handle)
    },
  }
  registerAppCompletionCoverage(completion, (source) => {
    const registration = { source, active: true }
    registrations.add(registration)
    return {
      advance() {
        capability.assertRoot()
        if (!registration.active) throw new GroupStateConflictError('Completion coverage unbound')
        const captured = capture([], registration)
        return captured.length === 0
          ? Promise.resolve()
          : run([], captured, undefined, registration, true)
      },
      unbind() {
        registration.active = false
        registrations.delete(registration)
      },
    }
  })
  cached.set(cacheKey, completion)
  return completion
}
