import type { MigrationFixture, MigrationResult } from './control-migration.js'
import type { MigrationPending } from './control-migration-activation.js'
import { migrateMemoryControl } from './memory-control-migration.js'

function copy<TValue>(value: TValue): TValue {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as TValue
  if (Array.isArray(value)) return value.map(copy) as TValue
  if (value instanceof Map)
    return new Map([...value].map(([key, child]) => [copy(key), copy(child)])) as TValue
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, copy(child)]),
    ) as TValue
  return value
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Independent transaction double shared by the two in-memory control hosts. */
export function createMemoryMigrationBackend(seed: MigrationFixture) {
  const key = { ...seed.source.key }
  let committed = copy(seed)
  let active: Promise<MigrationResult> | null = null
  let fail = false
  let rejectAfter = false
  let pause: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null =
    null
  let pending: {
    rejected: ReturnType<typeof deferred>
    waiting: ReturnType<typeof deferred>
    finish: ReturnType<typeof deferred>
    outcome: 'commit' | 'rollback'
  } | null = null
  return {
    get key() {
      return { ...key }
    },
    async activate(): Promise<MigrationResult> {
      if (active !== null) return active
      active = (async () => {
        if (committed.snapshot.schemaVersion === 1)
          return copy(committed.snapshot) as MigrationResult
        for (;;) {
          const next = {
            ...committed,
            snapshot: migrateMemoryControl(committed),
            mainJournal: null,
          }
          if (pause !== null) {
            const held = pause
            pause = null
            held.started.resolve()
            await held.release.promise
          }
          if (fail) {
            fail = false
            throw new Error('before-commit')
          }
          if (pending !== null) {
            const held = pending
            pending = null
            held.rejected.resolve()
            held.waiting.resolve()
            await held.finish.promise
            if (held.outcome === 'rollback') continue
          }
          committed = copy(next)
          if (rejectAfter) {
            rejectAfter = false
            throw Object.assign(new Error('Committed migration outcome unknown'), {
              name: 'StorageOutcomeUnknownError',
            })
          }
          return copy(committed.snapshot) as MigrationResult
        }
      })()
      try {
        return await active
      } catch (error) {
        active = null
        // A completed backend's durable mark proves this rejection, without repeating migration.
        if (
          error instanceof Error &&
          error.name === 'StorageOutcomeUnknownError' &&
          committed.snapshot.schemaVersion === 1
        ) {
          active = Promise.resolve(copy(committed.snapshot) as MigrationResult)
          return await active
        }
        throw error
      }
    },
    bytes: () => copy(committed),
    reopen() {
      // A reconstructed host shares unfinished backend ownership; a negative snapshot proves nothing.
      if (committed.snapshot.schemaVersion === 1) active = null
    },
    journal: async () => copy(committed.mainJournal ?? null),
    beforeCommit() {
      fail = true
    },
    afterCommit() {
      rejectAfter = true
    },
    pause() {
      const started = deferred()
      const release = deferred()
      pause = { started, release }
      return { started: started.promise, release: release.resolve }
    },
    ambiguous(): MigrationPending {
      const held = {
        rejected: deferred(),
        waiting: deferred(),
        finish: deferred(),
        outcome: 'commit' as 'commit' | 'rollback',
      }
      pending = held
      return {
        rejected: held.rejected.promise,
        barrierWaiting: held.waiting.promise,
        async finish(outcome) {
          held.outcome = outcome
          held.finish.resolve()
        },
      }
    },
  }
}
export type MemoryMigrationBackend = ReturnType<typeof createMemoryMigrationBackend>
