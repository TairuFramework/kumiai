# A version band the tooling enforces, on pnpm's own release management

**Status:** complete
**Date:** 2026-08-02
**Branch:** `chore/pnpm-native-versioning` (19 commits)

## Goal

Two claims the tooling did not back. `docs/agents/development.md` said the eleven packages were
"locked as a group while pre-1.0" while `.changeset/config.json` had `"fixed": []` — and the
versions had drifted accordingly (`rpc` 0.4.3, `mls-rpc` 0.4.2, eight at 0.4.1). Separately
`@kumiai/mls-hub` sat at `0.0.0`, unpublished but not `private`, and would have taken its permanent
first version as `0.1.0` beside a group going to `0.5.0`.

Widened during brainstorming: pnpm 11.13 ships release management that reads the Changesets intent
format, so `@changesets/cli` bought nothing.

## The rule

Every publishable `@kumiai/*` package shares one **meaningful version band** — the same minor while
pre-1.0 (`0.X`), the same major from 1.0 (`X`). The trailing segment diverges freely, so one
package's patch release churns nobody. Raising the band is a group act: every package takes that
bump, in one release.

Deliberately weaker than a lock. A full lock makes every release bump every package, so a consumer
pinning `@kumiai/broadcast` sees churn from work that never touched it. The band keeps the property
the lock was for — a matched band is a coherent set — without that cost. Under it the existing
`0.4.1` / `0.4.2` / `0.4.3` spread was already correct; only `mls-hub` was off band.

## Why the rule is a script and not configuration

Neither pnpm setting expresses it. `versioning.fixed` locks the trailing segment too — the churn the
band exists to avoid. `versioning.epics` bands *majors* only, and numerically (`M*100 … M*100+99`) —
wrong axis pre-1.0 and wrong shape. So the band is a repo convention that
`scripts/check-versions.mjs` makes true: ~50 lines, no dependencies, wired into `pnpm test` and as
the first step of `pnpm release`.

The check validates the outcome, not the intents. An intent-level rule ("a minor intent must name
all eleven") would have failed against the 21 files pending at the time and guarantees nothing the
outcome check does not.

## What was built

- `scripts/check-versions.mjs` and seven tests in `tests/integration`, each proven to bite by
  breaking the guard and watching them fail.
- Changesets removed: `@changesets/cli`, `.changeset/config.json`, and the root `changeset` and
  `version` scripts. `version` is an npm lifecycle hook name — leaving one would make
  `pnpm version -r` fire it as a side effect.
- `versioning:` block in `pnpm-workspace.yaml`: `changelog.storage: repository` (ten packages
  already had committed changelogs; the `registry` default would orphan them), and
  `ignore: [e2e-expo]` — that private test app takes `@kumiai/mls` as a runtime dependency, so bump
  propagation reached it and it appeared in every release plan.
- `publishConfig: { access: public }` on all eleven manifests. Changesets' `"access": "public"` has
  no pnpm counterpart, and a scoped package defaults to **restricted** under `pnpm publish -r` —
  which only surfaces as a failure on a package's *first* publish.
- `mls-hub` from `0.0.0` to `0.4.0`, plus one intent naming all eleven `minor`. Without it the
  pending set would have sent some packages to 0.5.0 and left patch-only ones at 0.4.x, breaking the
  band on the first release under its own rule.
- Docs restated across `development.md`, `architecture.md`, `AGENTS.md`, and `roadmap.md`.

## The discovery that shaped the outcome

pnpm publishes a package that has never been released at the version written in its manifest,
**verbatim** — no change intent bumps it. `mls-hub` showed `0.4.0 → 0.4.0` in the release plan while
every other package moved to `0.5.0`; seeding it at `0.4.1` produced `0.4.1 → 0.4.1`, confirming the
rule rather than an arithmetic bug.

So a first-time package reaches the band by hand, after `pnpm version -r`. A dry release in a
throwaway worktree then showed the hand-fix needs to cover three artifacts, not one: the manifest,
the version heading in the freshly generated `CHANGELOG.md`, and the package's key in
`.changeset/ledger.yaml` (`name@version`). The check reads only manifests, so it catches a forgotten
manifest edit and nothing else — a wrong heading or stale ledger key is a wrong record, not a broken
release, and is on the releaser. `docs/agents/development.md` says all of this.

## Verification

No release was run. A real `pnpm version -r` executed in a discarded git worktree: ten packages
landed at `0.5.0`, `mls-hub` held at `0.4.0`, the band check failed at exactly that point naming it,
and passed after the documented manual bump. Nothing was published.

Branch green at completion: `All 11 publishable packages on band 0.4.`, 42/42 unit and type tasks
uncached, 43/43 integration.

## Residual

`pnpm release` builds, then `pnpm publish -r` fires each package's `prepublishOnly`
(`del lib && swc && tsc`) again. If pnpm publishes concurrently, a dependency's `del lib` could race
a dependent's `tsc`. Not a regression — `changeset publish` fired the same hook — and not observable
without a real publish. See `../backlog/2026-08-02-versioning-residuals.md`.

The stack-wide migration of `sozai`, `kokuin`, and `enkaku` is filed in the kigu repo at
`docs/agents/plans/backlog/2026-08-01-stack-pnpm-versioning.md`, to be taken up once a real kumiai
release has gone out on the new tooling. That file was written but left **untracked** — kigu had
twelve modified skill files in flight at the time, and committing into someone else's working tree
was out of scope.
