import { decodeClientState, encodeClientState, type GroupHandle, restoreGroup } from '@kumiai/mls'
import type { PendingAppFrame } from '@kumiai/rpc'

import type { HandleAccess } from '../../src/access.js'
import type { RealMember } from './real-group.js'

export class RevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`state revision ${expected} is stale; the row is at ${actual}`)
    this.name = 'RevisionConflictError'
  }
}

export type StoredRow = { state: Uint8Array; ledger: Array<string>; revision: number }

/**
 * A host's durable group row plus pending table. Every write is conditional on the revision the
 * writer read and bumps it, so a same-epoch stale state cannot land after a newer one. Writes are
 * serialised, which orders an earlier save ahead of a later open.
 */
export type TransactionalStore = {
  snapshot(): StoredRow
  save(
    expected: number,
    state: Uint8Array,
    ledger: Array<string>,
    record?: PendingAppFrame,
  ): Promise<void>
  records: Map<string, PendingAppFrame>
  /** Another connection's commit to the row: same state, next revision. */
  bump(): void
  /**
   * Once queued writes settle, a store over a copy of the row and the same pending table: a
   * restarted process reads what was committed, and its writes stay its own.
   */
  fork(): Promise<TransactionalStore>
  /** Runs inside a write, before the row changes. Tests throw, wait or bump from here. */
  beforeWrite?: (() => void | Promise<void>) | undefined
}

export function createTransactionalStore(handle: GroupHandle): TransactionalStore {
  return storeOver(
    { state: encodeClientState(handle.state), ledger: handle.ledgerTokens, revision: 0 },
    new Map(),
  )
}

function storeOver(initial: StoredRow, records: Map<string, PendingAppFrame>): TransactionalStore {
  let row = initial
  let tail: Promise<void> = Promise.resolve()
  const store: TransactionalStore = {
    snapshot: () => row,
    records,
    bump: () => {
      row = { ...row, revision: row.revision + 1 }
    },
    fork: async () => {
      await tail
      return storeOver({ ...row, state: row.state.slice() }, records)
    },
    save: (expected, state, ledger, record) => {
      const write = tail.then(async () => {
        await store.beforeWrite?.()
        if (row.revision !== expected) throw new RevisionConflictError(expected, row.revision)
        // One transaction: the state row and the pending row together. A duplicate frame ID keeps
        // its first record; the key is still consumed once, by this state.
        row = { state: state.slice(), ledger, revision: expected + 1 }
        if (record != null && !store.records.has(record.frame.id)) {
          store.records.set(record.frame.id, record)
        }
      })
      tail = write.catch(() => {})
      return write
    },
  }
  return store
}

export type TransactionalAccess = {
  access: HandleAccess
  pending: {
    persistOpened(stagedState: Uint8Array, record: PendingAppFrame): Promise<void>
    list(): Promise<Array<PendingAppFrame>>
    complete(id: string): Promise<void>
  }
  live(): GroupHandle
}

/**
 * A transactional {@link HandleAccess}: every mutation and open works on a handle restored from
 * the stored row and is published only after its conditional write commits. An open holds the
 * handle lock only to read the row and to publish, never across the write.
 */
export async function createTransactionalAccess(
  member: RealMember,
  store: TransactionalStore,
): Promise<TransactionalAccess> {
  const restore = async (row: StoredRow): Promise<GroupHandle> => {
    const state = decodeClientState(row.state)
    if (state == null) throw new Error('bad stored state')
    return await restoreGroup({
      state,
      credential: member.handle.credential,
      ledgerEntries: row.ledger,
      options: { resolveLedgerEntries: member.slot.resolve },
    })
  }

  let live = await restore(store.snapshot())
  let publishedEpoch = Number(live.epoch)
  let tail: Promise<void> = Promise.resolve()
  const locked = async <TValue>(fn: () => Promise<TValue>): Promise<TValue> => {
    const previous = tail
    let release: () => void = () => {}
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
  const publish = (next: GroupHandle): void => {
    live = next
    publishedEpoch = Number(next.epoch)
  }

  // Opens are serialised among themselves, so the revision below belongs to the one in flight.
  let openTail: Promise<void> = Promise.resolve()
  let openRevision = -1

  const access: HandleAccess = {
    epoch: () => publishedEpoch,
    read: (fn) => locked(async () => await fn(live)),
    mutate: (fn) =>
      locked(async () => {
        const row = store.snapshot()
        const working = await restore(row)
        let saved = false
        const result = await fn(working, async (current) => {
          await store.save(row.revision, encodeClientState(current.state), current.ledgerTokens)
          saved = true
        })
        if (!saved) {
          await store.save(row.revision, encodeClientState(working.state), working.ledgerTokens)
        }
        publish(working)
        return result
      }),
    replace: (next) =>
      locked(async () => {
        const row = store.snapshot()
        await store.save(row.revision, encodeClientState(next.state), next.ledgerTokens)
        publish(next)
      }),
    open: (fn, persistOpened) => {
      const run = openTail.then(async () => {
        while (true) {
          const row = await locked(async () => store.snapshot())
          const working = await restore(row)
          let staged: { state: Uint8Array; record: PendingAppFrame } | undefined
          const result = await fn(working, async (state, record) => {
            staged = { state, record }
          })
          if (staged == null) return result
          openRevision = row.revision
          try {
            await persistOpened(staged.state, staged.record)
          } catch (error) {
            if (error instanceof Error && error.cause instanceof RevisionConflictError) continue
            throw error
          }
          await locked(async () => publish(working))
          return result
        }
      })
      openTail = run.then(
        () => {},
        () => {},
      )
      return run
    },
  }

  return {
    access,
    pending: {
      persistOpened: (state, record) =>
        store.save(openRevision, state, store.snapshot().ledger, record),
      list: async () => [...store.records.values()],
      complete: async (id) => {
        store.records.delete(id)
      },
    },
    live: () => live,
  }
}
