import type { FoldInput } from './fold.js'
import type { VerifiedLedgerEntry } from './ledger.js'
import {
  adminCount,
  type GroupPermission,
  ROLE_ENTRY_TYPE,
  type RoleValue,
  type RosterState,
  roleReducer,
} from './roster.js'

/**
 * The outcome of folding an envelope's control entries. On accept: the candidate
 * roster (base ∪ this envelope's group.role entries) and the non-group entries to
 * surface to the consumer, in envelope order. On reject: a reason and the offending
 * entry id. A rejection is a value — the caller turns it into a commit rejection.
 */
export type EnvelopeFoldResult =
  | { ok: true; roster: RosterState; surfaced: Array<VerifiedLedgerEntry> }
  | { ok: false; reason: string; entryID: string }

const GROUP_TYPE_PREFIX = 'group.'

function isRoleValue(value: unknown): value is GroupPermission {
  return value === 'admin' || value === 'member'
}

/**
 * Fold an envelope's verified entries against a base roster, enforcing that every
 * entry is admin-authored in state-so-far. Pure, never throws.
 *
 * The strict, commit-side counterpart to {@link foldRoster}: where the roster fold
 * silently drops an unauthorized or unrelated entry (correct for hostile ingest),
 * a commit envelope must reject the moment anything is off, so `ledger_head` never
 * covers an entry the ledger does not hold.
 *
 * One pass, one rule. `baseRoster` is the state folded from the ledger the handle
 * already holds; this reasons only about *this* envelope's new entries, using it as
 * the starting state-so-far and mutating a copy as `group.role` entries apply. Every
 * entry's issuer must be an admin at its own position — the universal invariant that
 * subsumes `group.role`'s own authority rule. State-so-far, not a pre-commit
 * snapshot, so an envelope of `[promote Bob, entry-issued-by-Bob]` is accepted.
 */
export function foldEnvelope(
  baseRoster: RosterState,
  entries: Array<FoldInput>,
  groupID: string,
): EnvelopeFoldResult {
  let workingRoster: RosterState = { roles: new Map(baseRoster.roles) }
  const surfaced: Array<VerifiedLedgerEntry> = []

  for (const { verified, entryID } of entries) {
    const { entry, issuer } = verified

    // An entry signed for another group is a replay, even though it verified.
    if (entry.groupID !== groupID) {
      return { ok: false, reason: 'cross-group entry', entryID }
    }

    // The universal invariant: the issuer must be an admin in state-so-far.
    if (workingRoster.roles.get(issuer) !== 'admin') {
      return { ok: false, reason: `non-admin issuer '${issuer}'`, entryID }
    }

    if (entry.type === ROLE_ENTRY_TYPE) {
      if (!isRoleValue(entry.value)) {
        return { ok: false, reason: 'invalid role value', entryID }
      }
      const roleEntry: VerifiedLedgerEntry<RoleValue> = {
        issuer,
        entry: { ...entry, value: entry.value },
      }
      workingRoster = roleReducer.apply(roleEntry, workingRoster)
      // A group with zero admins can never again add, remove, promote, or demote.
      if (adminCount(workingRoster) === 0) {
        return { ok: false, reason: 'would empty the admin set', entryID }
      }
      continue
    }

    // `group.*` is reserved for @kumiai/mls; an unknown one fails closed.
    if (entry.type.startsWith(GROUP_TYPE_PREFIX)) {
      return { ok: false, reason: 'unknown group.* type', entryID }
    }

    // Notarized (verified, admin-authored, group-scoped) and handed on unread.
    surfaced.push(verified)
  }

  return { ok: true, roster: workingRoster, surfaced }
}
