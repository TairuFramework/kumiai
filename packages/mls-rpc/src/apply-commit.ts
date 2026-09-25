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
 * handle where it was. `MissingLedgerEntriesError` propagates for the caller to classify. Any
 * other refusal returns `advanced: false`, and a throw after the handle advanced (a callback
 * after durable acceptance) reports the advance rather than inviting a replay.
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

  const header = await handle.readCommitHeader(commit)
  if (header == null || readMessageEpoch(commit) !== before) return refused()
  const committerDID = header.committerDID
  if (committerDID != null && committerDID === context.ownDID) return refused(committerDID)

  let persistFailed = false
  context.entrySlot.install(context.resolveLedgerEntries)
  try {
    await handle.processMessage(commit, {
      ...(persist != null && {
        persist: async (current: GroupHandle) => {
          try {
            await persist(current)
          } catch (error) {
            persistFailed = true
            throw error
          }
        },
      }),
    })
  } catch (error) {
    if (error instanceof MissingLedgerEntriesError || persistFailed) throw error
    if (handle.epoch === before) return refused(committerDID)
  } finally {
    context.entrySlot.install(undefined)
  }
  // A commit removing this member changes the tree without ratcheting the handle.
  if (handle.epoch === before) {
    return { ...refused(committerDID), applied: true, rosterAfter: rosterOf(handle) }
  }

  return {
    applied: true,
    advanced: true,
    epochBefore: Number(before),
    epochAfter: Number(handle.epoch),
    rosterBefore,
    rosterAfter: rosterOf(handle),
    surfacedEntries: handle.ledger
      .slice(ledgerLengthBefore)
      .map((entry) => entry.verified)
      .filter((verified) => !verified.entry.type.startsWith(CONTROL_TYPE_PREFIX)),
    ledgerLengthBefore,
    ...(committerDID != null && { committerDID }),
  }
}
