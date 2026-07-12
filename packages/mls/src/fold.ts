import type { GroupAnchor } from './anchor.js'
import type { VerifiedLedgerEntry } from './ledger.js'

/**
 * A per-type projection over the control ledger. The fold stays free of any
 * admin/circle semantics: a reducer owns its own initial state (derived from
 * the genesis anchor), its authority rule, and its fold step, so a new ledger
 * type plugs in as a parameter with zero edits to {@link foldLedger}.
 */
export type LedgerReducer<TValue, TState> = {
  /** Ledger entry `type` this reducer projects; entries of any other type are dropped. */
  type: string
  /**
   * Initial fold state, derived from the genesis anchor. The anchor is the
   * authenticated epoch-0 root (e.g. the creator DID is the first admin), so
   * seeding from it is what makes the very first claims evaluable.
   */
  seed(anchor: GroupAnchor): TState
  /** Is the verified issuer allowed to make this claim, given the state so far? */
  verifyAuthority(verified: VerifiedLedgerEntry<TValue>, stateSoFar: TState): boolean
  /** Fold step: return the next state after applying an authorized claim. */
  apply(verified: VerifiedLedgerEntry<TValue>, stateSoFar: TState): TState
}

/**
 * A verified entry paired with its content-addressed id. The id identifies the
 * entry in drop notices. Order is the caller's responsibility — see
 * {@link foldLedger}.
 */
export type FoldInput<TValue = unknown> = {
  verified: VerifiedLedgerEntry<TValue>
  entryID: string
}

/** Why an entry was skipped during the fold, for an optional observer. */
export type FoldDrop = {
  entryID: string
  type: string
  reason: string
}

/**
 * Replay the ledger into a single reducer's projection.
 *
 * Signatures are verified at ingest, not here — this fold evaluates AUTHORITY:
 * whether each issuer was allowed to make its claim given the state accumulated
 * from strictly-earlier entries. Evaluating against state-so-far (never the
 * final state) is what makes rotation sound: a key authorized when it made a
 * claim can be revoked later without retroactively invalidating that claim.
 *
 * Folds `entries` in exactly the order given — it imposes no order of its own.
 * The caller supplies the total order (kumiai derives it from the authenticated
 * epoch chain), so ordering lives with the caller, not the fold. Full replay
 * only: it takes the whole entry set and folds it. There is no incremental
 * apply, per-type watermark, or dependency entry point by design — a reducer
 * whose authority reads another entry type cannot be driven safely by a
 * per-type incremental applier, so the only fold entry point replays everything.
 *
 * The fold itself does not filter by `groupID`: the caller passes only entries
 * for the group being folded, so a `groupID` mismatch is dropped by the caller
 * before the fold, or by a reducer's own `type` / `verifyAuthority` check. No
 * group logic lives here.
 *
 * Pure — no clock, no randomness, no I/O — and the input array is never mutated
 * (nothing here writes to it, and there is no copy-to-sort). A claim of an
 * unrelated type or one whose authority fails is dropped (never thrown) so a
 * single bad entry can never abort the projection. Drops are silent unless an
 * `onDrop` observer is supplied — the fold runs on every authority check, where
 * authority-failed drops are expected, so the caller decides whether to surface
 * them rather than the fold emitting to the console.
 */
export function foldLedger<TValue, TState>(
  entries: Array<FoldInput<TValue>>,
  anchor: GroupAnchor,
  reducer: LedgerReducer<TValue, TState>,
  onDrop?: (drop: FoldDrop) => void,
): TState {
  let state = reducer.seed(anchor)
  for (const { verified, entryID } of entries) {
    const { entry } = verified
    if (entry.type !== reducer.type) {
      onDrop?.({
        entryID,
        type: entry.type,
        reason: `unrelated type '${entry.type}' for reducer '${reducer.type}'`,
      })
      continue
    }
    if (!reducer.verifyAuthority(verified, state)) {
      onDrop?.({ entryID, type: entry.type, reason: `issuer '${verified.issuer}' not authorized` })
      continue
    }
    state = reducer.apply(verified, state)
  }
  return state
}
