# Infra batch (mechanical, one PR)

**Priority:** low — mechanical; land opportunistically rather than as its own PR. **Both High
findings were retired 2026-07-23** (one void, one decided against); what remains is Medium and
below.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### Retired 2026-07-23

- ~~**`package.json:10` — lint cannot fail in CI.**~~ — **void, verified.** The finding assumed CI
  runs `pnpm run lint`. It does not: `.github/workflows/build-test.yml` delegates to kigu's shared
  workflow, which runs `pnpm exec biome ci .`
  (`../kigu/.github/workflows/build-test.yml:54`) — non-writing, and it fails on violations. The
  root `lint` script is still `biome check --write ./packages ./tests`, but that is developer
  convenience, not a CI hole. (Local note: an `rtk` shim intercepts `pnpm run lint`; use
  `rtk proxy pnpm run lint` for real output.)
- ~~**No release workflow.**~~ — **decided against 2026-07-23.** Releases stay manual
  (`pnpm release` → `changeset publish`). Confirmed still true that no stack repo has a publish
  workflow, kigu included, so automating it would be a stack-wide change rather than a kumiai one.
  Revisit only if the stack decides to automate releases everywhere.

### Medium — package manifests

- **vitest undeclared in 4 of 10 packages** — `mls`, `hub-client`, `hub-server`, `hub-tunnel` run
  `vitest run` without declaring it; works only via `nodeLinker: hoisted`. Fix: add
  `"vitest": "catalog:"` to each. (Corrected 2026-07-23: the audit said "5 of 7" and named
  `hub-protocol`, which now declares it; the repo has since grown to ten packages.)

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
- No `LICENSE` file at root or in any package despite `"license": "MIT"` in all **10**
  manifests — npm tarballs ship no license text. Fix: root LICENSE, included per package.
  (Re-verified 2026-07-23: still no `LICENSE` anywhere in the tree.)

### Low — conventions (one-liner)

- `packages/rpc/src/hub-mux.ts:174,176` — `readonly bus` / `readonly mailbox` use the
  prohibited `readonly` keyword. Fix: drop the modifiers. (Lines and the second field name
  corrected 2026-07-23; the audit said `:19-20` / `hubLike`.) Note `packages/rpc/src/cursor.ts:23,26`
  also read `readonly`, but as index signatures inside branded-type declarations — the idiomatic
  branding pattern, not the prohibited property modifier. Leave those alone.

## Scope

`turbo.json`, `.githooks/`, package manifests, root `LICENSE`. No longer touches
`.github/workflows/` — see the retired findings above. Remaining lower-priority infra items live in
`backlog/2026-07-07-infra-cleanup.md`.
