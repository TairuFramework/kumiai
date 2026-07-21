import { normalizeDID } from '@kokuin/token'

import type { GroupAnchor } from './anchor.js'
import { type FoldDrop, type FoldInput, foldLedger, type LedgerReducer } from './fold.js'

/** The permission a DID holds in the group: full control, or membership only. */
export type GroupPermission = 'admin' | 'member'

/** The ledger entry `type` the roster projects. */
export const ROLE_ENTRY_TYPE = 'kumiai.role'

/** A role claim's value: the permission the subject is granted. */
export type RoleValue = GroupPermission

/**
 * Folded roster: every DID that has been granted a permission, keyed by
 * normalized DID. The map is DID-keyed rather than leaf-keyed, so it can hold a
 * role for a DID that has no MLS membership yet.
 */
export type RosterState = { roles: ReadonlyMap<string, GroupPermission> }

/** Count the admins in a roster state. */
export function adminCount(state: RosterState): number {
  let count = 0
  for (const permission of state.roles.values()) {
    if (permission === 'admin') {
      count += 1
    }
  }
  return count
}

/**
 * Self-referential role reducer. Authority is rooted at the genesis anchor (the
 * creator is the epoch-0 admin) and grows only through admins-so-far: every
 * grant or demotion must be issued by a DID already an admin in the state
 * accumulated from strictly-earlier entries. That state-so-far check is what
 * makes rotation sound — an admin can demote the very admin that promoted them
 * without retroactively voiding their own earlier grants.
 *
 * This reducer knows neither the group it belongs to nor the empty-admin guard.
 * {@link foldRoster} is the safe entry point that adds both; this piece is the
 * composable seed / authority / apply the fold turns on.
 */
export const roleReducer: LedgerReducer<RoleValue, RosterState> = {
  type: ROLE_ENTRY_TYPE,
  seed: (anchor) => ({ roles: new Map([[normalizeDID(anchor.creatorDID), 'admin']]) }),
  verifyAuthority: (verified, stateSoFar) =>
    stateSoFar.roles.get(normalizeDID(verified.issuer)) === 'admin',
  apply: (verified, stateSoFar) => {
    const roles = new Map(stateSoFar.roles)
    roles.set(normalizeDID(verified.entry.subject), verified.entry.value)
    return { roles }
  },
}

/**
 * Fold a group's `kumiai.role` ledger into the current roster.
 *
 * The reducer cannot filter by `groupID` on its own — the anchor carries no
 * group id — so the group is passed explicitly and closed over here: an entry
 * signed for another group is dropped even though its signature verifies, since
 * the signed `groupID` is the only defence against a replayed grant. The
 * empty-admin guard is layered in the same place: an entry that would leave the
 * roster with zero admins is dropped, so the group can never be bricked into a
 * state where nobody can add, remove, promote, or demote. Both drops are routed
 * through `verifyAuthority` so they reach the optional `onDrop` observer that
 * {@link foldLedger} calls; only there does the fold surface a skip.
 */
export function foldRoster(
  entries: Array<FoldInput<RoleValue>>,
  anchor: GroupAnchor,
  groupID: string,
  onDrop?: (drop: FoldDrop) => void,
): RosterState {
  const scoped: LedgerReducer<RoleValue, RosterState> = {
    type: roleReducer.type,
    seed: roleReducer.seed,
    verifyAuthority: (verified, stateSoFar) => {
      if (verified.entry.groupID !== groupID) {
        return false
      }
      if (!roleReducer.verifyAuthority(verified, stateSoFar)) {
        return false
      }
      // Fold-step guard: reject a claim whose would-be next state has no admin.
      return adminCount(roleReducer.apply(verified, stateSoFar)) > 0
    },
    apply: roleReducer.apply,
  }
  return foldLedger(entries, anchor, scoped, onDrop)
}
