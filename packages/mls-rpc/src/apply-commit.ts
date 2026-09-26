import { normalizeDID } from '@kokuin/token'
import {
  type GroupHandle,
  MissingLedgerEntriesError,
  readMessageEpoch,
  type VerifiedLedgerEntry,
} from '@kumiai/mls'
import type { CommitContext, RosterEntry } from '@kumiai/rpc'

import type { LedgerEntrySlot } from './mls.js'

/** Reserved by `@kumiai/mls` for its own control entries; never surfaced to a host. */
const CONTROL_TYPE_PREFIX = 'kumiai.'

export type ApplyCommitContext = CommitContext & {
  entrySlot: LedgerEntrySlot
  /** This member's DID: its own authenticated commit is never applied as received. */
  ownDID: string
}

export type ApplyCommitResult = {
  /** The handle took the commit's state. A host keeps it even when `advanced` is false. */
  applied: boolean
  /** The epoch moved. A commit removing this member is applied without advancing it. */
  advanced: boolean
  epochBefore: number
  epochAfter: number
  rosterBefore: Array<RosterEntry>
  rosterAfter: Array<RosterEntry>
  /** Verified non-control entries the commit appended, in log order, repeats kept. */
  surfacedEntries: Array<VerifiedLedgerEntry>
  ledgerLengthBefore: number
  committerDID?: string
}

function rosterOf(handle: GroupHandle): Array<RosterEntry> {
  return handle.listMembers().map((member) => ({
    did: member.id,
    leafIndex: member.leafIndex,
    longForm: member.longForm,
  }))
}

/**
 * Apply a received Commit to `handle` in place, for a caller that already holds the handle's
 * lock and owns the surrounding transaction. `context.resolveLedgerEntries` runs inside that lock
 * and must not take it again.
 *
 * `persist` runs before the handle adopts the new state; its failure propagates and leaves the
 * handle where it was. `MissingLedgerEntriesError` and resolver faults propagate for the caller to
 * classify. Any other refusal returns `applied: false`, and a throw after the handle took the
 * commit (a callback after durable acceptance) reports it applied rather than inviting a replay.
 */
export async function applyCommit(
  handle: GroupHandle,
  commit: Uint8Array,
  context: ApplyCommitContext,
  persist?: (handle: GroupHandle) => Promise<void>,
): Promise<ApplyCommitResult> {
  const before = handle.epoch
  const rosterBefore = rosterOf(handle)
  const ledgerLengthBefore = handle.ledger.length
  const refused = (committerDID?: string): ApplyCommitResult => ({
    applied: false,
    advanced: false,
    epochBefore: Number(before),
    epochAfter: Number(before),
    rosterBefore,
    rosterAfter: rosterBefore,
    surfacedEntries: [],
    ledgerLengthBefore,
    ...(committerDID != null && { committerDID }),
  })

  const surfaced = (): Array<VerifiedLedgerEntry> =>
    handle.ledger
      .slice(ledgerLengthBefore)
      .map((entry) => entry.verified)
      .filter((verified) => !verified.entry.type.startsWith(CONTROL_TYPE_PREFIX))

  const header = await handle.readCommitHeader(commit)
  if (header == null || readMessageEpoch(commit) !== before) return refused()
  const committerDID = header.committerDID
  if (committerDID != null && normalizeDID(committerDID) === normalizeDID(context.ownDID)) {
    return refused(committerDID)
  }

  let persistFailed = false
  let persisted = false
  let resolverFailed = false
  let threw = false
  const resolve = context.resolveLedgerEntries
  context.entrySlot.install(
    resolve &&
      (async (ids) => {
        try {
          return await resolve(ids)
        } catch (error) {
          // A fault fetching bodies says nothing about the commit, which may apply on retry.
          resolverFailed = true
          throw error
        }
      }),
  )
  try {
    await handle.processMessage(commit, {
      ...(persist != null && {
        persist: async (current: GroupHandle) => {
          try {
            await persist(current)
            persisted = true
          } catch (error) {
            persistFailed = true
            throw error
          }
        },
      }),
    })
  } catch (error) {
    if (error instanceof MissingLedgerEntriesError || persistFailed || resolverFailed) throw error
    threw = true
  } finally {
    context.entrySlot.install(undefined)
  }
  if (handle.epoch === before) {
    // A commit removing this member changes the tree without ratcheting the handle, and a host
    // callback may throw after that state was stored.
    const rosterAfter = rosterOf(handle)
    const changed =
      rosterAfter.length !== rosterBefore.length ||
      rosterAfter.some((entry, index) => entry.did !== rosterBefore[index]?.did)
    if (threw && !persisted && !changed) return refused(committerDID)
    return { ...refused(committerDID), applied: true, rosterAfter, surfacedEntries: surfaced() }
  }

  return {
    applied: true,
    advanced: true,
    epochBefore: Number(before),
    epochAfter: Number(handle.epoch),
    rosterBefore,
    rosterAfter: rosterOf(handle),
    surfacedEntries: surfaced(),
    ledgerLengthBefore,
    ...(committerDID != null && { committerDID }),
  }
}
