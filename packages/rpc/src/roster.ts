/**
 * Detect a roster CHANGE by diffing the roster around a Commit's application: the DIDs a handle
 * held before applying against the DIDs it holds after. `true` iff the two sets differ at all —
 * a leaf gained, a leaf lost, or both.
 *
 * Set inequality, not set difference: an Add rotates the app-lane anchor just as a Remove does.
 * A Remove must rotate it for forward secrecy — the evicted member keeps every topic ID it ever
 * derived, so the group has to stop using them. An Add must rotate it because the anchor secret
 * is the anchor epoch's exported secret, and MLS ratchets forward: a member added at epoch E can
 * never export the secret of an epoch before E, so an anchor the group left behind is one the
 * newest member cannot derive. The two constraints intersect at `max(last add, last remove)` —
 * the last roster change — which is the only epoch that is both ≥ every current member's join
 * and after every removal.
 *
 * A set, not a count: a Commit carrying both an Add and a Remove leaves the leaf count unchanged
 * and still changes the roster, and a count check would miss it.
 *
 * Pure: no state, no order dependence (the inputs are compared as sets), duplicates ignored.
 * Because it compares DIDs and not leaves, a change that leaves the DID set intact is invisible
 * to it — an external-commit rejoin by a member the roster still holds is exactly that, and so is
 * a stale-leaf replacement (a Remove and an Add of the same DID in one Commit), which
 * {@link detectLeafAdmission} sees.
 */
export function detectRosterChange(before: Array<string>, after: Array<string>): boolean {
  const held = new Set(before)
  const present = new Set(after)
  if (held.size !== present.size) return true
  for (const did of held) {
    if (!present.has(did)) return true
  }
  return false
}

/**
 * Detect an ADD by diffing the leaf admissions around a Commit's application (see the rpc
 * `RosterEntry.admission`): `true` iff a value is present after that was absent before.
 *
 * Only an Add puts a KeyPackage leaf node into the tree, so a new admission is an Add, and every
 * Add brings one. It sees the Add a DID diff cannot: a Remove and an Add of the same DID in one
 * Commit, whose re-added member joins by Welcome at the post-commit epoch and can never export the
 * anchor the group would otherwise keep. A value that disappears is a member's own path or Update
 * replacing the leaf node it was Added with, or a Remove — neither is an Add, and the first must
 * not rotate.
 */
export function detectLeafAdmission(before: Array<string>, after: Array<string>): boolean {
  const held = new Set(before)
  for (const admission of after) {
    if (!held.has(admission)) return true
  }
  return false
}
