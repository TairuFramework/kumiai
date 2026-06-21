# Import MLS integration tests into kumiai — design

Status: approved design (brainstorm complete, 2026-06-21)
Scope: bring the two cross-package hub/MLS integration tests over from the `enkaku` repo
(where they were pre-staged for the monorepo split) into a new `tests/` workspace in `kumiai`.

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
    "@enkaku/client": "^0.18.0",
    "@enkaku/protocol": "^0.18.0",
    "@enkaku/server": "^0.18.0",
    "@enkaku/transport": "^0.18.0",
    "@kokuin/capability": "^0.1.0",
    "@kokuin/token": "^0.1.0",
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

All `@enkaku@0.18.0` and `@kokuin@0.1.0` versions are already present in
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

1. `pnpm install` — resolves the new workspace package, links `@kumiai/*` locally.
2. `pnpm --filter @kumiai/integration-tests test` — `test:types` clean, both suites green.
3. `pnpm lint` — `tests/` now in scope, reports clean.

## Out of scope

- The ten `@enkaku`-core integration tests (stay in `enkaku`).
- `broadcast` and `rpc` (`group-rpc`) integration coverage — no integration test imported them;
  their behavior is covered by per-package `test/` suites already in `kumiai`.
- Any edit to the test bodies beyond what `enkaku` already staged.
