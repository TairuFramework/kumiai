# infra cleanup (lower-priority tooling/docs debt)

**Priority:** backlog — everything infra the `next/2026-07-07-infra-batch.md` PR doesn't
cover.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### Medium

- kigu `build-test.yml` — CI caches only the pnpm store; no turbo cache persistence, so
  full build+test reruns on both Node 24 and 26 every run. Fix: cache `.turbo` or wire a
  remote cache. (kigu-side change.)
- `.github/workflows/e2e-android.yml`, `e2e-ios.yml` — full emulator/simulator E2E on
  every push/PR with no path filters, for an app exercising only `@kumiai/mls`. Fix: gate
  on `paths:` (packages/mls, tests/e2e-expo) or a label.
- `AGENTS.md` — references `../kigu/docs/repo-split-design.md`, which does not exist. Fix:
  point to `kigu/docs/stack.md` or restore the file.

### Low

- `package.json:7` — `packageManager` pin has no integrity hash. Add the `+sha512.…`
  suffix.
- `package.json:10` — lint covers only `./packages ./tests`; root-level files never
  linted. Run biome on `.`.
- `pnpm-workspace.yaml:38` — `minimumReleaseAgeExclude` configured but
  `minimumReleaseAge` unset — dead config. Set it or delete the block.
- `pnpm-workspace.yaml` catalog — `react` pinned exact (`19.2.3`) and `ts-mls` on an RC
  (`2.0.0-rc.13`) while everything else is `^`; the RC upgrade is tracked in
  `backlog/ts-mls-v2-stable-upgrade.md`. Worth a comment.
- All packages — `"exports": { ".": "./lib/index.js" }` has no `types` condition and no
  `"./package.json"` export. Fix:
  `{ ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }, "./package.json": "./package.json" }`.
- `packages/{hub-protocol,hub-client,hub-server}` — no `README.md` (blank npm pages).
- `packages/hub-tunnel/package.json:47` — `test:types` omits `--skipLibCheck` unlike the
  other 6. Align.
- tsconfig drift — `hub-protocol`/`hub-client` main tsconfigs lack
  `"lib": ["es2025","dom"]` (only in tsconfig.test.json); `hub-server/tsconfig.json`
  uniquely bakes `"types": ["node"]`. Align on one shape.
- `tests/e2e-expo/package.json:2-3` — name `e2e-expo`/version `1.0.0` vs the
  `@kumiai/integration-tests`/`0.1.0` convention. Rename.
- kigu `build-test.yml` — TS-readiness step is `continue-on-error: true`;
  `--stableTypeOrdering` regressions invisible unless someone opens the log. Surface as a
  job summary/annotation. (kigu-side change.)
- `docs/index.md` — omits `agents/development.md` from the doc map.
