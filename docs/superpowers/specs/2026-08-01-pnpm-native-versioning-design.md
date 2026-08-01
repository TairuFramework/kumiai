# A version band the tooling enforces, on pnpm's own release management

**Date:** 2026-08-01
**Branch:** `chore/pnpm-native-versioning`
**Origin:** `docs/agents/plans/next/2026-08-01-version-lock-and-mls-hub-first-release.md`, widened
during brainstorming to replace Changesets with pnpm's native versioning.

## Problem

Three things, one root.

`docs/agents/development.md:9` says the eleven packages are "locked as a group while pre-1.0" and
`docs/agents/architecture.md:11` calls them a "Locked group". `.changeset/config.json` has
`"fixed": []` and `"linked": []`, so nothing enforces anything. The versions have diverged: `rpc` at
0.4.3, `mls-rpc` at 0.4.2, eight packages at 0.4.1.

`@kumiai/mls-hub` sits at 0.0.0. It is not `private`, `npm view @kumiai/mls-hub` returns 404, and
two of the 21 pending change intents name it `minor`. The next release would publish it at 0.1.0
while its neighbours go to 0.5.0 — a permanent version history that reads as far less mature than
the 926 lines across eight modules it actually ships. That cannot be taken back once it is on the
registry.

Separately, pnpm 11.13.0 made Changesets redundant. pnpm reads the same `.changeset/` intent format
and adds `pnpm change`, `pnpm version -r`, and `pnpm publish -r`, so the `@changesets/cli`
dependency now buys nothing.

## The rule

Every publishable `@kumiai/*` package shares one **meaningful version band**:

- pre-1.0 — the same minor. All eleven sit at `0.X.*`.
- from 1.0 — the same major. All eleven sit at `X.*.*`.

The trailing segment diverges freely. A single package taking a patch release churns nobody else.
Raising the band is a group act: every package takes that bump, in one release.

Under this rule today's `0.4.1` / `0.4.2` / `0.4.3` spread is already correct — the band is `0.4`.
Only `mls-hub` is off-band, and it moves to `0.4.0`: the band's minor, trailing segment at zero
because it has had no patch releases.

This is deliberately weaker than a full lock. A full lock (`versioning.fixed`) would make every
release bump every package, so a consumer pinning `@kumiai/broadcast` sees churn from work that
never touched it. The band keeps the property the lock was for — a matched band is a coherent set —
without that cost.

## Why not pnpm's built-in grouping

Neither pnpm setting expresses the band:

- `versioning.fixed` — "always release together at one shared version". Locks the trailing segment
  too, which is the churn the band exists to avoid.
- `versioning.epics` — bands *majors* only, and numerically: while the lead is on major `M`, members
  live in `M*100 … M*100+99`. Wrong axis pre-1.0 and wrong shape.

So the band is a repo convention, and a check makes it true.

## Design

### 1. Migrate to pnpm native versioning

`pnpm-workspace.yaml` gains:

```yaml
versioning:
  changelog:
    storage: repository
```

`storage: repository` preserves today's behaviour — ten packages already have a committed
`CHANGELOG.md`, and the default (`registry`) would orphan them. No `fixed`, no `epics`, for the
reasons above.

`.changeset/config.json` is deleted. The 21 pending intent files stay: pnpm reads the Changesets
format unchanged. `pnpm version -r` additionally writes `.changeset/ledger.yaml`, a committed
append-only record of consumed intents.

Two Changesets settings have no pnpm counterpart and need no replacement:

- `"updateInternalDependencies": "patch"` — pnpm propagates to dependents natively, and internal
  deps are `workspace:^`, rewritten at pack time.
- `"privatePackages": { "version": false, "tag": false }` — `tests/*` are `private`, which pnpm
  already skips.

The third, `"access": "public"`, does need replacing. See 3.

### 2. Root manifest

- Remove the `@changesets/cli` devDependency.
- Remove the `changeset` script.
- Remove the `version` script. `version` is an npm lifecycle hook name; leaving it in place means
  `pnpm version -r` fires `changeset version` as a side effect.
- Add `check:versions`, running the band check (see 4).
- `release` becomes: band check, then build, then `pnpm publish -r`.
- `packageManager` moves to `pnpm@11.18.0` (already staged on this branch).

Releasing after this change is: `pnpm change` while working, then `pnpm version -r`, commit, then
`pnpm release`. Releases stay manual — the 2026-07-23 decision is unaffected, and no workflow
publishes.

### 3. `publishConfig` on all eleven packages

No package has a `publishConfig`. Changesets' `"access": "public"` was supplying it. Under
`pnpm publish -r` a scoped package defaults to **restricted**, so `mls-hub`'s first publish would
fail. Every publishable manifest gets:

```json
"publishConfig": { "access": "public" }
```

### 4. The band check

`scripts/check-versions.mjs` — plain Node, no dependencies. It reads every `packages/*/package.json`,
skips `private` ones, derives each version's band (`major.minor` while major is 0, otherwise
`major`), and fails if more than one band is present, printing each package with its version and the
majority band.

Wired in two places:

- root `test`, so drift fails on any ordinary test run;
- the first step of `release`, so a drifted band cannot reach the registry.

The check validates the *outcome*, not the intents. An intent-level check ("a minor intent must name
all eleven") would fail today against the existing 21 files and buys nothing the outcome check does
not already guarantee.

### 5. `mls-hub` to the band, and a group minor for 0.5

`packages/mls-hub/package.json` moves from `0.0.0` to `0.4.0`.

The pending intents alone would break the band on the very first release under this rule: packages
named `minor` would go to 0.5.0 while patch-only packages stayed at 0.4.x. So this branch adds one
intent naming all eleven packages `minor`, with a summary saying the group moved to the 0.5 band.
Every package then lands at exactly `0.5.0`, `mls-hub` included — never at 0.1.0.

### 6. Documentation

- `docs/agents/development.md` — replace "locked as a group while pre-1.0" with the band rule, and
  document the pnpm release procedure that replaces `changeset publish`.
- `docs/agents/architecture.md:11` — "Locked group" becomes the band wording.
- Any other Changesets reference found by grep.

### 7. Stack follow-up

`sozai` and `kokuin` are on Changesets with `fixed: []`; `enkaku` uses `fixed: [["@enkaku/*"]]`.
kumiai is the pilot. A `next/` item filed in `kigu` records the stack-wide migration, to be taken up
once a real kumiai release has gone out on the new tooling.

## Verification

Because nothing here is exercised until a release, the branch proves the outcome before merging:

1. In a throwaway git worktree, run `pnpm version -r`.
2. Assert all eleven publishable packages land at `0.5.0` — `mls-hub` included.
3. Assert `.changeset/ledger.yaml` exists and the 21 + 1 intent files are consumed.
4. Assert every package has an updated `CHANGELOG.md`, `mls-hub` a newly created one.
5. Assert `scripts/check-versions.mjs` passes against the bumped tree.
6. Discard the worktree. Nothing is versioned, committed, or published on this branch.

The check script also gets a direct negative test: it must fail on a tree where one package is off
band, not merely pass on a good one.

## Out of scope

- Running the actual release. `pnpm publish -r` stays a manual user action.
- Migrating `sozai`, `kokuin`, `enkaku` (item 7 files the intent only).
- Rewriting or consolidating the 21 pending intent files.
- Any 1.0 timing decision. The rule states what happens at 1.0; it does not schedule it.
