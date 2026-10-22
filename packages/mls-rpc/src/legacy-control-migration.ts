import {
  type ControlSnapshot,
  type LegacyControlSnapshot,
  type LegacyMainJournal,
  migrateLegacyControl,
} from '@kumiai/rpc'

import { createUnlockedGroupStateStores } from './memory-group-state.js'
import { emptyControl, memoryRecordTable } from './memory-incarnation-stores.js'
import { GroupStateConflictError, StorageOutcomeUnknownError } from './persistence-errors.js'
import type {
  AtRestCodec,
  GroupKey,
  MemoryDatabase,
  MemoryTransaction,
} from './persistence-types.js'

/** Supply before the first opening of a legacy main-backed incarnation.
 * Both callbacks operate on this provider's transaction. Clearing also releases holdsLogSends.
 * Adapting an external get()/clear() pair is insufficient: rollback must restore the slot and hold. */
export type LegacyCommitJournalBoundary<TTx> = {
  /** Load only the originating incarnation's slot; return null for all others. */
  load(tx: TTx, key: GroupKey): Promise<LegacyMainJournal | null>
  clear(tx: TTx, key: GroupKey, publishID: string): Promise<void>
}

export class LegacyJournalDecisionRequiredError extends Error {
  override name = 'LegacyJournalDecisionRequiredError'
}

export class LegacyControlActivationError extends Error {
  override name = 'LegacyControlActivationError'
}

/** Called under group ownership, before any prepare read, callback or worker can run. */
export async function activateLegacyControl(params: {
  db: MemoryDatabase
  atRest: AtRestCodec
  groupID: string
  legacyCommitJournal?: LegacyCommitJournalBoundary<MemoryTransaction> | null
}): Promise<void> {
  const { db, atRest, groupID } = params
  const scope = { groupID, devicePackages: false }
  const lifetime = await db.transact(scope, (tx) =>
    createUnlockedGroupStateStores({ tx, groupID, atRest }).lifetime.load(),
  )
  if (lifetime === null) return
  for (let incarnation = 1; incarnation <= lifetime.latestIncarnation; incarnation++) {
    const key = { groupID, incarnation }
    let unknownAttempts = 0
    for (;;) {
      try {
        await db.transact(scope, async (tx) => {
          const control = memoryRecordTable<{
            snapshot: LegacyControlSnapshot | ControlSnapshot
            mutationID: string
          }>({ tx, key, atRest, namespace: 'control' })
          const record = await control.load('current')
          if (record?.snapshot.schemaVersion === 1) return
          // No snapshot needs migration; supplied adapters still discover main-only journals.
          if (record === null && params.legacyCommitJournal === undefined) return
          if (params.legacyCommitJournal === undefined)
            throw new LegacyJournalDecisionRequiredError(
              'Legacy activation requires a main-journal adapter or explicit null',
            )
          const mainJournal = (await params.legacyCommitJournal?.load(tx, key)) ?? null
          if (record === null && mainJournal === null) return
          const state = await createUnlockedGroupStateStores({ tx, groupID, atRest })
            .state(incarnation)
            .load()
          const retired = lifetime.activeIncarnation !== incarnation
          if (
            !retired &&
            (state === null || state.deleted) &&
            (record?.snapshot.commitOnce != null || record?.snapshot.operations.length)
          )
            throw new GroupStateConflictError('Legacy migration requires source state')
          const snapshot = migrateLegacyControl({
            snapshot: record?.snapshot ?? { ...emptyControl(), schemaVersion: undefined },
            source: {
              key,
              epoch: state !== null && !state.deleted ? state.epoch : null,
              terminal: state !== null && !state.deleted && state.terminal,
              retired,
            },
            mainJournal,
            at: Date.now(),
            outcomeID: () => crypto.randomUUID(),
          })
          await control.save('current', { snapshot, mutationID: crypto.randomUUID() })
          if (mainJournal !== null)
            await params.legacyCommitJournal?.clear(tx, key, mainJournal.publishID)
        })
        break
      } catch (error) {
        if (
          !(error instanceof StorageOutcomeUnknownError) &&
          !(error instanceof Error && error.name === 'StorageOutcomeUnknownError')
        )
          throw error
        // Completion owns the backend. Re-read the mark only after its outcome is established.
        await db.completionBarrier(scope)
        if (++unknownAttempts >= 3)
          throw new LegacyControlActivationError('Legacy activation completion retry limit', {
            cause: error,
          })
      }
    }
  }
}
