/**
 * Detect a Remove by diffing the roster around a Commit's application: the DIDs a handle held
 * before applying against the DIDs it holds after. `true` iff some DID present before is absent
 * after — a non-empty set difference `before \ after`.
 *
 * A set difference, not a count: a Commit that carries both an Add and a Remove leaves the leaf
 * count unchanged, and a count check would miss it. It is also right for a self-removal or leave
 * — the leaf disappears for every member — and for an external-commit rejoin, which only adds a
 * leaf and so is never flagged.
 *
 * Pure: no state, no order dependence (the inputs are compared as sets), duplicates ignored.
 */
export function detectRemoval(before: Array<string>, after: Array<string>): boolean {
  const present = new Set(after)
  for (const did of before) {
    if (!present.has(did)) return true
  }
  return false
}
