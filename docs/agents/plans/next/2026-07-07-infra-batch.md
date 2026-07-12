# Infra batch (mechanical, one PR)

**Priority:** 6 — CI/tooling fixes; mechanical, land as one PR.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### High

- **`package.json:10` — lint cannot fail in CI.** `lint` is `biome check --write ...` and
  CI runs `pnpm run lint`, so auto-fixable violations are silently fixed on the runner and
  exit 0. Fix: add a non-writing `biome ci ./packages ./tests` for CI.
- **No release workflow.** `.github/workflows/` has no publish flow (kigu offers none
  either); `pnpm release` is manual with no changesets automation and `.changeset/` has
  zero pending changesets. Fix: add a `changesets/action`-based release workflow with npm
  provenance.
- **vitest undeclared in 5 of 7 packages** (`mls`, `hub-protocol`, `hub-client`,
  `hub-server`, `hub-tunnel` run `vitest run` without declaring it; works only via
  `nodeLinker: hoisted`). Fix: add `"vitest": "catalog:"` to each.

### Medium — turbo task graph

Mostly **done** on `feat/mls-permission-enforcement` (commit `62c524e`), after the stale-hit
bug below actually fired: a warm cache replayed a passing `test:types` for `e2e-expo` across
the branch's whole MLS API reshape, so a broken consumer reached an open PR reporting green.

- ~~`turbo.json:8-9` — `test:types`/`test:unit` lack `dependsOn: ["^build:types"]` and
  dependency-aware inputs: warm-cache runs give stale hits for downstream packages; fresh
  clones fail before building.~~ **Done.** `build:types` is now a turbo task and both test
  tasks depend on `^build:types`, so an upstream source change invalidates every downstream
  typecheck and a cold cache bootstraps the build.
- ~~`turbo.json:7` — `build:js` outputs `lib/**` capture `.d.ts` emitted by the non-turbo
  `build:types`; a cache restore can overwrite fresh declarations with stale ones.~~ **Done.**
  The two builds now claim disjoint outputs (`lib/**/*.js` and `lib/**/*.d.ts`).
- **Still open** — `build:js` depended on `^clean`, but no package defines a `clean` script
  (all define `build:clean`), so cleaning never happened and stale files persist in `lib/`.
  The dead `^clean` was dropped rather than wired up, because root `build` runs `build:types`
  before `build:js`: a clean hung off `build:js` would delete the declarations `build:types`
  just emitted. Wiring cleaning in needs the build restructured — e.g. a single `build:clean`
  both builds depend on, with root `build` becoming one `turbo run build:types build:js`.

### Medium — hooks and licensing

- `.githooks/pre-commit:6` — `biome check --write --staged` fixes files but never
  re-stages them, so the unfixed version is committed. Fix: `git add -u` after the fix
  step, or run non-writing and fail.
- `.githooks/pre-commit:13` — runs `build:types` (mutating `lib/`) instead of a `--noEmit`
  check. Use the `test:types` scripts.
- No `LICENSE` file at root or in any package despite `"license": "MIT"` in all 7
  manifests — npm tarballs ship no license text. Fix: root LICENSE, included per package.

### Low — conventions (one-liner)

- `packages/rpc/src/hub-mux.ts:19-20` — `readonly bus` / `readonly hubLike` use the
  prohibited `readonly` keyword. Fix: drop the modifiers.

## Scope

Root `package.json`, `turbo.json`, `.githooks/`, `.github/workflows/`, package manifests.
Remaining lower-priority infra items live in `backlog/2026-07-07-infra-cleanup.md`.
