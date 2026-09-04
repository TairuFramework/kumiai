# `GroupMLS` roster leaf identity — complete

**Date:** 2026-09-04
**Status:** complete
**Packages:** `@kumiai/rpc`, `@kumiai/mls-rpc`, `@kumiai/rpc-conformance` (all minor, breaking at 0.x)
**Milestone:** [pre-1.0 breaking API surface](../milestones/pre-1.0-breaking-api.md) — the
`GroupMLS.rosterDIDs` item under the `@kumiai/rpc` section.
**Backlog origin:** [rpc API surface](../backlog/rpc-api-surface.md), finding "`GroupMLS.rosterDIDs`
carries no leaf identity."
**Design:** [docs/superpowers/specs/2026-09-04-roster-leaf-identity-design.md](../../../superpowers/specs/2026-09-04-roster-leaf-identity-design.md)

## Goal

`GroupMLS.rosterDIDs(): Promise<Array<string>>` was documented as "one entry per leaf," so a DID
holding two leaves appeared twice — but nothing said *which* leaf each entry was: no leaf index, no
per-leaf metadata. Not a correctness bug (no filed consumer needed to disambiguate two leaves for the
same DID), but the return shape would have to widen the moment one did, and widening it later is a
breaking change. Taken now because the 0.x window is the last cheap moment to spend that break, and
because moving to an object return is what lets any later per-leaf field ride in additively.

## What was built

- **New type, `@kumiai/rpc`:** `RosterEntry = { did: string; leafIndex: number; longForm: string }`,
  declared in `packages/rpc/src/crypto.ts` and exported from `packages/rpc/src/index.ts`. `leafIndex`
  is stable while a leaf remains present; a remove-then-rejoin of that member may reassign it (not a
  stable per-member identity across a membership gap). `longForm` is the leaf credential's long form
  when it carries one, else its `id` (`parsed.longForm ?? parsed.id`) — never absent, but not a
  resolvability guarantee.
- **Port rename, `@kumiai/rpc`:** `GroupMLS.rosterDIDs(): Promise<Array<string>>` →
  `rosterEntries(): Promise<Array<RosterEntry>>`, taken in the same break since the old name was
  already a misnomer for what it returned. **Ordering is part of the contract:** entries are returned
  in ascending `leafIndex` order, matching what the real implementation already did.
- **Consumer, `@kumiai/rpc`:** `detectRosterChange` is unchanged — still a pure `Array<string>`
  DID-set comparison, on purpose (an external-commit rejoin by a member the roster still holds leaves
  the DID set unchanged either way, so leaf identity would not help it; `CommitHeader.external` still
  owns rejoin detection). The two `advanceHandle` call sites (`peer.ts`) now extract `.did` from
  `rosterEntries()` before normalizing.
- **Real implementation, `@kumiai/mls-rpc`:** `rosterEntries()` maps `listMembers()`'s `GroupMember`
  records (`id`, `leafIndex`, `longForm`) directly onto `RosterEntry` — mechanical, since
  `GroupMember` already carried all three fields.
- **Double, `@kumiai/rpc` fixtures:** the memory `GroupMLS` double's compact `Array<string>` roster
  became a hole-preserving leaf-slot model (`Map<number, string>`, holes as absent keys, never
  compacted) so `leafIndex` is stable-while-present and reused via lowest-free-index, matching real
  MLS. All six roster-mutating paths (ordinary remove/add, external-rejoin, direct evict,
  self-removal, recovery adoption) were converted from `splice`/`push` (which shift or append
  positions) to blank-in-place / fill-lowest-free-slot. `leaves()` now projects the occupied DIDs in
  ascending slot-index order; the three exact-array test assertions that consumed it were traced
  against the new model and still hold. This was required, not optional, under the test-doubles
  strictness rule (a double may be stricter than its port, never more permissive) — a compact array
  reindexed on every removal would have made the double accept index-reshuffling behavior the real
  port never exhibits.
- **Conformance, `@kumiai/rpc-conformance`:** the port type row and the `describe('rosterDIDs')`
  block rekey to `rosterEntries`/`.did`. New clauses assert both structural and value properties:
  every entry has a unique non-negative integer `leafIndex`; entries come back in ascending
  `leafIndex` order; a member's `leafIndex` is stable across a commit that does not touch that member;
  every entry has a non-empty `longForm` (presence only, not resolvability — the contract is
  long-form-or-id fallback); a freshly created `n`-member group has `leafIndex` values exactly
  `{0..n-1}`; and an add after a removal reuses the freed leaf index (RFC 9420 leftmost-blank), for
  the ordinary different-DID case.
- **Type-level test, `@kumiai/rpc`:** `test/roster-entries.type.test.ts` pins `rosterEntries()` to
  `Promise<Array<RosterEntry>>` with `.did`/`.leafIndex`/`.longForm` typed, gated by the repo-wide
  `test:types` run.
- **Adjacent fix, `@kumiai/mls`:** `group-handle.ts`'s `listMembers` doc comment overstated that an
  external-commit rejoin always takes "the leftmost blank — the one just blanked," implying the
  member's leaf index never changes. Corrected: if an earlier blank exists, the rejoin takes *that*
  one instead, moving the index. The rejoin-invisibility argument the comment supports still holds via
  the DID set and `CommitHeader.external`; this was a comment-accuracy fix, not a behavior change.

## Known coverage gap (deliberately scoped out)

The double addresses roster removal by DID and blanks every slot matching that DID; real MLS removal
is leaf-index-addressed and can remove *one* of two leaves a single DID holds — the exact case
`leafIndex` exists to disambiguate. Making the double faithful to that case would mean rewriting its
commit representation to leaf-index-addressed removal, raising the conformance bar for every external
double, for a semantic no consumer uses today (the lane rotates on `CommitHeader.external`, not on
leaf identity). This is recorded as a known double-coverage gap, not a defect: nothing in the decision
changes the port shape or what any consumer receives (`RosterEntry` always carries both `did` and
`leafIndex`), and the real `@kumiai/mls-rpc` implementation is already faithful via ts-mls. Close it
(double + conformance clause, additive to test infra, non-breaking to the API) when a consumer first
needs duplicate-DID leaf disambiguation.

## Verification

- Repo-wide `turbo run test:types` (no `--filter`) — 26/26 tasks across all 14 packages, clean.
- Repo-wide `turbo run test:unit --force` — 34/34 tasks, `Cached: 0`, all green (`@kumiai/rpc`,
  `@kumiai/mls-rpc`, `@kumiai/rpc-conformance`, and every downstream/consumer package unaffected).
- `rtk proxy pnpm run lint` — clean, no fixes applied.
- Both contract suites (`@kumiai/rpc-conformance`, `@kumiai/hub-conformance` where applicable) run
  against the real implementation and the double, per `AGENTS.md`'s port-change obligation.

## Release

Recorded as a single `minor` change intent (`.changeset/roster-leaf-identity.md`) across
`@kumiai/rpc`, `@kumiai/mls-rpc`, and `@kumiai/rpc-conformance` — the twelve-package version band
means this is a `minor` today and would be a `major` after 1.0.

## Deferred / out of scope (none blocking)

- Any per-leaf credential field beyond `longForm` — deferred, additive when a consumer needs it (the
  object return is what makes that free).
- `detectRosterChange` staying leaf-aware — deliberately not done; it stays a DID-set compare.
- Rejoin/leaf-reuse detection in the lane — already owned by `CommitHeader.external`, unchanged.
- The duplicate-DID-leaf-removal double/conformance gap above.
