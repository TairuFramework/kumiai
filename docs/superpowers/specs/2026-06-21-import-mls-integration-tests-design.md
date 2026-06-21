# Import MLS integration tests into kumiai — design

Status: approved design (brainstorm complete, 2026-06-21)
Scope: bring the two cross-package hub/MLS integration tests over from the `enkaku` repo
(where they were pre-staged for the monorepo split) into a new `tests/` workspace in `kumiai`,
and centralize all cross-repo dependency versions through the pnpm catalog.

## Motivation

`kumiai` was split out of the `enkaku` monorepo as the MLS / group-messaging layer (`mls`,
`broadcast`, the `hub-*` subsystem, `rpc`). Per `../kigu/docs/repo-split-design.md`, the hub/MLS
integration tests that previously lived in `enkaku/tests/integration` belong with the code they
exercise. `enkaku` has already pre-staged them under `tests/_ported/integration-mls/` with their
imports rewritten to `@kumiai/*`, `@kokuin/*`, and published `@enkaku/*` ranges. This work moves
those two files into `kumiai` and wires up a workspace to run them.

## Which tests are "relevant"

Of the 12 integration tests in `enkaku/tests/integration`, exactly two import `@kumiai` packages;
the other ten exercise pure `@enkaku` RPC core (client/server/transport/http/socket/node-streams/
otel) and stay in `enkaku`.

| test | kumiai imports | other imports | covers |
|------|----------------|---------------|--------|
| `hub-tunnel-echo.test.ts` | `hub-tunnel`, `hub-protocol` | `@enkaku/client`, `protocol`, `server` | client→server echo round-trip over an in-memory `HubLike` double |
| `hub-agent-scenarios.test.ts` | `mls`, `hub-client`, `hub-server`, `hub-protocol` | `@kokuin/capability`, `token`; `@enkaku/client`, `transport` | multi-device blind relay, store-and-forward, group fan-out / filter / mixed delivery, pagination, ack semantics, store eviction, delegation-chain verification |

Source of truth for the file contents: `enkaku/tests/_ported/integration-mls/<name>.test.ts`
(imports already rewritten — copy verbatim, no edits).

## Decisions

- **Placement: a new dedicated `tests/` workspace**, mirroring `enkaku`'s structure. Chosen over
  per-package `test/` dirs because `hub-agent-scenarios` is cross-package (spans `mls` +
  `hub-client` + `hub-server` + `hub-protocol`) and fits no single package cleanly.
- **Copy both files verbatim.** Including the `Scenario B: Delegation chain` block in
  `hub-agent-scenarios`, which is pure `@kokuin/capability` and touches zero kumiai code. Kept for
  maximum fidelity to the source; it still passes here (kokuin is a dependency).
- **No build / no publish.** Private test-only package; no `lib/`, no `exports`, no build scripts.
- **All cross-repo deps go through the pnpm catalog.** The new tests package — and every existing
  package — references `@enkaku/*`, `@kokuin/*`, and `@sozai/*` as `catalog:` instead of inline
  version ranges, so the whole workspace is pinned to one version per dependency from a single
  source. See "Catalog centralization" below.

## Catalog centralization

Cross-repo dependency versions are currently consistent (one spec per dep) but pinned inline in
each `package.json`, so consistency is unenforced and drift is possible. Move every cross-repo dep
into `pnpm-workspace.yaml`'s `catalog:` and have all packages reference `catalog:`.

Scope: the three external scopes — `@enkaku/*`, `@kokuin/*`, `@sozai/*`. Internal `@kumiai/*` deps
stay `workspace:^` (not catalog — they resolve locally). `@noble/*`, `ts-mls`, and `vitest` are
already in the catalog.

Catalog entries to add (versions taken verbatim from the current consistent specs):

```yaml
catalog:
  # ...existing entries (@noble/*, ts-mls, vitest)...
  '@enkaku/client': ^0.18.0
  '@enkaku/protocol': ^0.18.0
  '@enkaku/server': ^0.18.0
  '@enkaku/transport': ^0.18.0
  '@kokuin/capability': ^0.1.0
  '@kokuin/token': ^0.1.0
  '@sozai/async': ^0.1.0
  '@sozai/codec': ^0.1.0
  '@sozai/event': ^0.1.0
  '@sozai/runtime': ^0.1.0
  '@sozai/schema': ^0.1.0
  '@sozai/stream': ^0.1.0
```

Then, in every `package.json` under `packages/*` (all seven) **and** the new `tests/integration`,
replace each `@enkaku/*` / `@kokuin/*` / `@sozai/*` version range with `catalog:`. No version
changes — pure indirection. Example: `"@enkaku/client": "^0.18.0"` → `"@enkaku/client": "catalog:"`.

This is the full set actually used today; if a package references a cross-repo dep not listed
above, add it to the catalog at its current spec rather than leaving it inline.

## File layout

```
tests/
  integration/
    package.json
    vitest.config.ts
    tsconfig.json
    hub-agent-scenarios.test.ts   # verbatim from enkaku/tests/_ported/integration-mls/
    hub-tunnel-echo.test.ts       # verbatim from enkaku/tests/_ported/integration-mls/
```

### `tests/integration/package.json`

```json
{
  "name": "@kumiai/integration-tests",
  "version": "0.1.0",
  "license": "MIT",
  "private": true,
  "type": "module",
  "scripts": {
    "test:types": "tsc --noEmit --skipLibCheck -p tsconfig.json",
    "test:unit": "vitest run",
    "test": "pnpm run test:types && pnpm run test:unit"
  },
  "dependencies": {
    "@enkaku/client": "catalog:",
    "@enkaku/protocol": "catalog:",
    "@enkaku/server": "catalog:",
    "@enkaku/transport": "catalog:",
    "@kokuin/capability": "catalog:",
    "@kokuin/token": "catalog:",
    "@kumiai/hub-client": "workspace:^",
    "@kumiai/hub-protocol": "workspace:^",
    "@kumiai/hub-server": "workspace:^",
    "@kumiai/hub-tunnel": "workspace:^",
    "@kumiai/mls": "workspace:^"
  },
  "devDependencies": {
    "vitest": "catalog:"
  }
}
```

The `@enkaku@0.18.0` and `@kokuin@0.1.0` versions are already present in
`pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`, so no release-age waiver edits are needed.

### `tests/integration/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
```

### `tests/integration/tsconfig.json`

```json
{
  "extends": "@kigu/dev/tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "lib": ["es2025", "dom"],
    "noEmit": true
  },
  "include": ["./**/*.test.ts"]
}
```

## Root config edits

### `pnpm-workspace.yaml` — add the `tests/*` glob

```yaml
packages:
  - packages/*
  - tests/*
```

### root `package.json` — extend lint scope to `tests/`

```json
"lint": "biome check --write ./packages ./tests"
```

(`format` already runs on `.`, the whole repo, so it needs no change.) The ported files are
already biome-clean, so the first lint run is a no-op.

## How it runs

- `turbo run test:types test:unit` (root `pnpm test`) picks up the new package via the workspace
  glob and runs both tasks; the package exposes both scripts.
- `@enkaku/*` and `@kokuin/*` resolve to published ranges; `@kumiai/*` resolve to the local
  workspace packages.

## Verification

1. `pnpm install` — resolves catalog refs for every package + the new workspace package; links
   `@kumiai/*` locally. A failed catalog lookup errors here, so install is the catalog gate.
2. No remaining inline `@enkaku/`/`@kokuin/`/`@sozai/` version ranges in any `package.json`
   (grep the workspace; every cross-repo dep reads `catalog:`).
3. `pnpm test` (whole workspace via turbo) — `test:types` + `test:unit` green across all packages,
   including `@kumiai/integration-tests`.
4. `pnpm lint` — `tests/` now in scope, reports clean.

## Out of scope

- The ten `@enkaku`-core integration tests (stay in `enkaku`).
- `broadcast` and `rpc` (`group-rpc`) integration coverage — no integration test imported them;
  their behavior is covered by per-package `test/` suites already in `kumiai`.
- Any edit to the test bodies beyond what `enkaku` already staged.
