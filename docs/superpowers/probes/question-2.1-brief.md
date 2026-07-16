# Probe brief — detect a Remove by roster-set diff around processCommit

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, package `packages/rpc`, branch
`feat/app-lane-delivery` (do NOT switch branches; leave changes uncommitted for review). Minimal,
focused change — this validates ONE assumption, not a feature.

## The exact question

Does capturing member DIDs **before** `processCommit` and comparing to **after** correctly detect
that a Commit applied a Remove — including a commit carrying **both an Add and a Remove** — while an
add-only, update/no-op, or external-commit (add) does **not** flag a removal?

## Relevant spec section (verbatim)

> Detect a Remove by diffing the roster around application: capture `GroupHandle.listMembers()` DIDs
> before `processCommit`, compare to after; any leaf present-before-and-absent-after means a Remove
> was applied → rotate the anchor. This is robust to the Add+Remove-in-one-commit case (a count check
> is not) and to self-removal/leave (the leaf disappears for everyone). External-commit rejoin only
> adds a leaf, so it correctly does not rotate. No `@kumiai/mls` change.

## Scope boundary (IMPORTANT — do not overreach)

This question is **detection only**. Land: the roster accessor on the port, the pure diff, the
capture at the apply site, and — on a detected removal — record it into peer **anchor state**
(`anchorSecret`, `anchorEpoch`, captured from `crypto.exportSecret()` / `crypto.epoch()` after the
commit advanced). Do NOT derive app topics from the anchor, do NOT rotate/rebuild subscriptions, do
NOT touch the drain — those are later questions (Q2.2/Q2.3/Phase 3). Expose just enough for the test
to assert the verdict per commit shape (see "observable" below).

## Approved approach (follow this; report BLOCKED if it fights the fixtures — do not invent a different design)

1. **Additive port accessor** — `packages/rpc/src/crypto.ts`, `GroupMLS` type (around `crypto.ts:84`):
   add `rosterDIDs(): Promise<Array<string>>` — the current member DIDs (the DIDs
   `GroupHandle.listMembers()` would give). Additive; document it like the neighbouring methods.

2. **Pure diff helper** — a small `detectRemoval(before: Array<string>, after: Array<string>): boolean`
   returning true iff some DID in `before` is absent from `after` (set difference non-empty). Put it in
   a new `packages/rpc/src/roster.ts` (exported for unit-testing) or inline in `peer.ts` — your call;
   keep it pure.

3. **Capture at the apply site** — in `pullCommits` (`peer.ts` ~639-804), around the `processCommit`
   call (~`peer.ts:754`), when a commit **advances** the epoch: read `rosterDIDs()` before applying and
   after applying, run `detectRemoval`. On a detected removal, update peer anchor state:
   `anchorSecret = await crypto.exportSecret()`, `anchorEpoch = crypto.epoch()` (the post-commit epoch
   secret — load-bearing: the per-epoch secret, never the recovery secret). Seed the anchor state at
   peer construction to the initial epoch's secret/epoch (a group with no removals yet has its anchor
   at genesis). Only applied/advancing commits can change the roster, so only diff when advanced.

4. **Observable for the test** — expose the current `anchorEpoch` minimally so the test can assert it
   changes on a removal commit and stays put otherwise. Prefer the least-intrusive surface: a getter on
   the `GroupPeer` (e.g. `anchorEpoch(): number`) or an optional `onAnchorChange?(epoch: number)`
   callback param on `createGroupPeer`. Pick one, keep it small, document why it exists (anchor for the
   app-lane topic derivation that Q2.2 builds on).

## Fixture reality you MUST handle

The fake MLS (`packages/rpc/test/fixtures/memory-group-mls.ts`) models the **control ledger**, not MLS
proposals. Membership (`leaves`, declared ~`:24`, seeded ~`:332`) changes via direct `add()`/`evict()`
helpers (~`:461`), NOT through `processCommit` (`:471`) — the memory commit
(`encodeMemoryCommit`/`decodeMemoryCommit`) encodes `epoch`, `committerDID`, `entryIDs`, `head`, and
carries no roster op. So a roster diff around `processCommit` currently sees nothing change.

To test detection you must **extend the fake commit** to optionally carry roster ops — a set of DIDs
to add and a set to remove — and have `processCommit`'s `enact` apply them to `leaves` when the commit
advances (add appends a leaf, remove evicts). Then `rosterDIDs()` returns `leaves`, and the diff around
`processCommit` observes adds/removes. Keep this additive to the fixture (new optional fields on
`encodeMemoryCommit`); existing commits with no roster op keep behaving exactly as today. The
off-stage-admin helper `publishCommit` (`packages/rpc/test/fixtures/commits.ts`) is how a test frames a
commit onto the lane — thread the roster op through it.

## Done when (all required)

New test `packages/rpc/test/peer-remove-detect.test.ts` drives commits through the lane
(`pullCommits`, via the peer + fake hub) and asserts the removal verdict per shape:
- **remove-only** → removal detected (anchor epoch advances / callback fires).
- **add+remove in one commit** → removal detected (the decisive case a count check misses).
- **add-only** → NOT detected.
- **update / no-op** (no roster op) → NOT detected.
- **external-commit rejoin** (an add of a returning member) → NOT detected.

Plus a direct unit test of `detectRemoval` for the set-difference semantics. Existing tests stay green.

## Conventions (MUST follow)

Read `kigu:conventions` and repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`;
capital `ID`; ES `#fields`, never `private`/`readonly`; don't edit `lib/`. Code/comments/test names
**never** reference plan questions or phase labels — capture the invariant directly (e.g. "a commit
that drops a leaf rotates the app-lane anchor").

## Verify (run from repo root, paste real output into the report)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone is hijacked by an `rtk` shim → eslint; use `rtk proxy pnpm run lint`.)

## Report contract

Write the FULL report to `docs/superpowers/probes/question-2.1-report.md` (what changed with file:line,
the fixture extension, the test, pasted verify output, surprises, concerns). Return to me ONLY: status
(`DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED`), uncommitted-changes note, one-line test
summary, concerns. Do not paste the full diff.
