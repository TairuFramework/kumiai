# Import MLS Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## ✅ STATUS — COMPLETE (2026-06-22)

All remaining work (R1/R2/R3) landed on `chore/import-tests`:
- **R1 — 2 gap tests** — commit `9299380`. `hub-server/test/hub.test.ts` now covers unacked redelivery on reconnect (B5) and topic exclusion (B9). 13 tests pass.
- **R2 — e2e-expo MLS harness** — commit `54263f5`. New private `tests/e2e-expo` workspace (group-e2ee Maestro flow only; kokuin sign-verify dropped; appId rebranded `dev.kumiai.e2e`). expo SDK 56 / RN 0.85.3 added to catalog + release-age excludes; `@kumiai/mls` linked `workspace:^`. `tsc -p` clean → MLS API confirmed a match on Hermes. `test` = maestro (needs simulator), not in turbo `test:unit`, so `pnpm test` stays green headless.
- **R3 — lint scope** — commit `2fff52c`. Root `lint` → `biome check --write ./packages ./tests`.

Full suite green: `turbo run test:types test:unit` = 14/14 tasks pass; biome clean over packages + tests.

Branch ready for PR. Historical context below.

---

## ⚠️ STATUS — revised direction (paused 2026-06-21)

The original 3-task plan below is **partly superseded**. What actually happened:

- **Task 1 (catalog) — DONE & kept.** Commit `5699426`. All `@enkaku/*`/`@kokuin/*`/`@sozai/*` deps now `catalog:` across the 7 packages; reviewed clean. Workspace green.
- **Task 2 (verbatim import of the 2 `integration-mls` hub tests) — ATTEMPTED then REVERTED.** Commits `c615a7a` (import) + `a4a01e4` (revert). Reason: those tests target kumiai's **old hub API**. Kumiai's hub is now **topic-based pub/sub** (`HubClient.publish(topicID)/subscribe/receive({after})`; `HubStore.publish/fetch/ack/purge`; routing by `topicID`, not recipient-DID/group). Group ops moved to `@kumiai/rpc` `GroupPeer`. The staged tests don't compile and are ~fully duplicated by existing kumiai tests anyway.
- **Task 3 (lint scope) — NOT DONE.** Deferred; revisit once `tests/` exists again.

### Coverage finding (why the import was abandoned)

The 2 `integration-mls` tests' behaviors are already covered by `hub-server/test/hub.test.ts`, `hub-server/test/memoryStore.test.ts`, `hub-client/test/client.test.ts`, `rpc/test/integration.test.ts`, `hub-tunnel/test/{echo-protocol,encrypted-transport-e2e}.test.ts`. Only **2 real gaps** remain (see Remaining Work).

### Remaining work (agreed with user — DO THIS NEXT)

**R1 — Add 2 gap tests at the current topic-based API** to `packages/hub-server/test/hub.test.ts` (follow its `createTestHub`/`connect`/`createChannel('hub/receive')` fixture patterns; `encodePayload` helper; `TOPIC` const):
  - **B5 — unacked re-delivery on reconnect:** `connect(bob)` + `hub/subscribe` to TOPIC; `connect(alice)` publishes; bob opens `hub/receive`, reads the message but does **NOT** `channel.send({ ack: [...] })`; close + (re)`connect(bobIdentity)`; open `hub/receive` again → the same message is delivered again. (Contrast with the existing "ack drains the store" test at hub.test.ts:181.)
  - **B9 — topic-exclusion negative:** bob `hub/subscribe` to `topic:A` only; alice `hub/publish` to `topic:B`; after a `delay`, bob's receive yields nothing AND `store.fetch({ recipientDID: bobIdentity.id })` is empty.

**R2 — Import the e2e-expo MLS harness (group-e2ee flow only)** as a new `tests/e2e-expo` workspace. Source: `/Users/paul/dev/yulsi/enkaku/tests/_ported/e2e-expo/`. This flow is a **CLEAN MATCH** against current `@kumiai/mls` (verified) and is the one genuinely-unique import: it proves the MLS group lifecycle (`createGroup→createInvite→createKeyPackageBundle→commitInvite→processWelcome→encrypt/decrypt` with `nobleCryptoProvider`) runs on **Hermes/React Native** — no kumiai Node test can. Recipe:
  - Add `tests/*` to the `pnpm-workspace.yaml` `packages:` glob.
  - Copy verbatim: `components/GroupEncryption.tsx`, `.maestro/group-e2ee.yaml`, `app.json`, `tsconfig.json`, `index.ts`, `assets/`.
  - **Trim (kokuin, not kumiai):** drop `components/SignVerify.tsx` and `.maestro/sign-verify.yaml`; edit `App.tsx` to remove the `SignVerify` import + `<SignVerify />` usage.
  - `package.json`: private; `@kumiai/mls` → `workspace:^`; `@kokuin/expo`, `@sozai/runtime-expo`, `@kokuin/token` → `catalog:`; `expo`/`react`/`react-native`/`expo-status-bar`/`@types/react`/`typescript` → `catalog:`. **These deps are NOT yet in kumiai's catalog or in `minimumReleaseAgeExclude`** — add them (pull versions from `enkaku`'s `pnpm-workspace.yaml` catalog). `test` script = `maestro test .maestro/` (NOT vitest; NOT part of turbo `test:unit`, so `pnpm test` stays green without a simulator).
  - Note: `app.json`/maestro `appId` use `dev.enkaku.e2e` — decide whether to rebrand to a kumiai id.

**R3 — Extend lint scope** (old Task 3): root `package.json` `lint` → `biome check --write ./packages ./tests` once `tests/` exists.

### Resume pointers
- Branch: `chore/import-tests`. HEAD after revert: `a4a01e4` (net change vs base = catalog only).
- Scratch ledger (gitignored): `.superpowers/sdd/progress.md`.
- The original Task 1/2/3 bodies below are kept for reference; **Task 1 is done, Task 2 is void, Task 3 → R3**.

---

**Goal:** Import the two cross-package hub/MLS integration tests from `enkaku` into a new `tests/` workspace in `kumiai`, and centralize all cross-repo dependency versions through the pnpm catalog.

**Architecture:** Three independent changes. (1) Move every `@enkaku/*`/`@kokuin/*`/`@sozai/*` version range out of individual `package.json` files into the `pnpm-workspace.yaml` catalog, replacing each with `catalog:`. (2) Add a private `tests/integration` workspace package holding the two ported test files (copied verbatim) plus vitest/tsconfig config. (3) Extend the root `lint` script to cover `tests/`.

**Tech Stack:** pnpm workspaces + catalog, turbo, vitest, TypeScript, biome.

## Global Constraints

- pnpm only. Node ESM (`"type": "module"`).
- Cross-repo deps (`@enkaku/*`, `@kokuin/*`, `@sozai/*`) referenced as `catalog:` — never inline ranges. Internal `@kumiai/*` deps stay `workspace:^`.
- Catalog versions (verbatim, no bumps): `@enkaku/*` = `^0.18.0`; `@kokuin/*` = `^0.1.0`; `@sozai/*` = `^0.1.0`.
- Test files copied byte-for-byte from `/Users/paul/dev/yulsi/enkaku/tests/_ported/integration-mls/` — no edits to test bodies.
- Conventions: `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`. Do not edit generated `lib/`.

---

### Task 1: Centralize cross-repo deps in the pnpm catalog

**Files:**
- Modify: `pnpm-workspace.yaml` (add catalog entries)
- Modify: `packages/broadcast/package.json`
- Modify: `packages/hub-client/package.json`
- Modify: `packages/hub-protocol/package.json`
- Modify: `packages/hub-server/package.json`
- Modify: `packages/hub-tunnel/package.json`
- Modify: `packages/mls/package.json`
- Modify: `packages/rpc/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: catalog entries `@enkaku/client`, `@enkaku/protocol`, `@enkaku/server`, `@enkaku/transport`, `@kokuin/capability`, `@kokuin/token`, `@sozai/async`, `@sozai/codec`, `@sozai/event`, `@sozai/runtime`, `@sozai/schema`, `@sozai/stream` — referenced as `catalog:` by Task 2.

- [ ] **Step 1: Add catalog entries to `pnpm-workspace.yaml`**

Under the existing `catalog:` block (which already holds `@noble/*`, `ts-mls`, `vitest`), add these twelve entries:

```yaml
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

- [ ] **Step 2: Rewrite the seven package.json files to use `catalog:`**

In each file, replace the version range of every dep below with the literal string `catalog:` (e.g. `"@enkaku/protocol": "^0.18.0"` → `"@enkaku/protocol": "catalog:"`). Leave `@kumiai/*` (`workspace:^`), `@noble/*`, `ts-mls`, and `vitest` untouched. Exact deps per file:

- `packages/broadcast/package.json` — deps: `@sozai/async`, `@sozai/codec`, `@enkaku/protocol`, `@enkaku/transport`
- `packages/hub-client/package.json` — deps: `@enkaku/client`; devDeps: `@sozai/codec`, `@enkaku/protocol`, `@kokuin/token`, `@enkaku/transport`
- `packages/hub-protocol/package.json` — deps: `@sozai/event`, `@enkaku/protocol`
- `packages/hub-server/package.json` — deps: `@sozai/codec`, `@sozai/event`, `@enkaku/protocol`, `@enkaku/server`, `@sozai/stream`, `@kokuin/token`; devDeps: `@enkaku/client`, `@enkaku/transport`
- `packages/hub-tunnel/package.json` — deps: `@sozai/async`, `@sozai/codec`, `@sozai/schema`, `@enkaku/transport`; devDeps: `@enkaku/client`, `@enkaku/protocol`, `@enkaku/server`, `@kokuin/token`
- `packages/mls/package.json` — deps: `@kokuin/capability`, `@sozai/runtime`, `@kokuin/token`
- `packages/rpc/package.json` — deps: `@enkaku/client`, `@sozai/codec`, `@enkaku/protocol`, `@enkaku/server`, `@enkaku/transport`

- [ ] **Step 3: Verify no inline cross-repo ranges remain**

Run: `grep -rERn "\"@(enkaku|kokuin|sozai)/[^\"]+\": \"\\^" packages/*/package.json`
Expected: no output (every match now reads `"catalog:"`).

- [ ] **Step 4: Reinstall and confirm resolution**

Run: `pnpm install`
Expected: completes without `ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC` or unresolved-spec errors; lockfile updates to point catalog refs at the pinned versions.

- [ ] **Step 5: Confirm nothing broke**

Run: `pnpm test`
Expected: `test:types` and `test:unit` pass across all seven packages (same result as before the change — versions are identical, only the reference indirection changed).

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml packages/*/package.json pnpm-lock.yaml
git commit -m "chore: centralize cross-repo deps via pnpm catalog"
```

---

### Task 2: Add the `tests/integration` workspace with the two ported tests

**Files:**
- Modify: `pnpm-workspace.yaml` (add `tests/*` to the `packages:` glob)
- Create: `tests/integration/package.json`
- Create: `tests/integration/vitest.config.ts`
- Create: `tests/integration/tsconfig.json`
- Create: `tests/integration/hub-agent-scenarios.test.ts`
- Create: `tests/integration/hub-tunnel-echo.test.ts`

**Interfaces:**
- Consumes: catalog entries from Task 1; workspace packages `@kumiai/hub-client`, `@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-tunnel`, `@kumiai/mls`.
- Produces: a `@kumiai/integration-tests` package exposing `test:types`, `test:unit`, `test` scripts (picked up by `turbo run test:types test:unit`).

- [ ] **Step 1: Add the `tests/*` glob to the workspace**

In `pnpm-workspace.yaml`, change the `packages:` list from:

```yaml
packages:
  - packages/*
```

to:

```yaml
packages:
  - packages/*
  - tests/*
```

- [ ] **Step 2: Create `tests/integration/package.json`**

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

- [ ] **Step 3: Create `tests/integration/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
```

- [ ] **Step 4: Create `tests/integration/tsconfig.json`**

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

- [ ] **Step 5: Copy the two test files verbatim**

Run:

```bash
cp /Users/paul/dev/yulsi/enkaku/tests/_ported/integration-mls/hub-agent-scenarios.test.ts tests/integration/hub-agent-scenarios.test.ts
cp /Users/paul/dev/yulsi/enkaku/tests/_ported/integration-mls/hub-tunnel-echo.test.ts tests/integration/hub-tunnel-echo.test.ts
```

- [ ] **Step 6: Confirm imports already target the right packages (no edits expected)**

Run: `grep -hE "^import|from '" tests/integration/*.test.ts | grep -oE "@(enkaku|kokuin|kumiai)/[a-z-]+" | sort -u`
Expected exactly:
```
@enkaku/client
@enkaku/protocol
@enkaku/server
@enkaku/transport
@kokuin/capability
@kokuin/token
@kumiai/hub-client
@kumiai/hub-protocol
@kumiai/hub-server
@kumiai/hub-tunnel
@kumiai/mls
```
Every one is declared in the Step 2 `package.json`. If anything else appears, add it to the catalog (Task 1) and to this package's deps.

- [ ] **Step 7: Install so the new package links**

Run: `pnpm install`
Expected: `@kumiai/integration-tests` appears in the workspace; `@kumiai/*` deps link to local packages.

- [ ] **Step 8: Run the integration tests**

Run: `pnpm --filter @kumiai/integration-tests test`
Expected: `test:types` clean; `vitest` runs both files — `hub-tunnel echo` (1 test) and the `hub-agent-scenarios` suites (Scenario A multi-device + group, Scenario B delegation, Store eviction) all PASS.

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml tests/integration pnpm-lock.yaml
git commit -m "test: import hub/MLS integration tests into tests workspace"
```

---

### Task 3: Extend lint scope to `tests/`

**Files:**
- Modify: root `package.json` (`lint` script)

**Interfaces:**
- Consumes: the `tests/` directory created in Task 2.
- Produces: nothing downstream.

- [ ] **Step 1: Update the `lint` script**

In the root `package.json`, change:

```json
"lint": "biome check --write ./packages",
```

to:

```json
"lint": "biome check --write ./packages ./tests",
```

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: biome checks `packages/` and `tests/`; reports clean (the ported files are already biome-formatted from enkaku) with no files rewritten.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: extend lint scope to tests"
```

---

## Notes for the implementer

- Task order matters: Task 1 must land before Task 2 (the tests package references catalog entries created in Task 1).
- `@enkaku@0.18.0` and `@kokuin@0.1.0` are already in `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`, so installs won't be blocked by the release-age guard.
- If `pnpm test` (Task 1, Step 5) was already failing before your change for unrelated reasons, note it but don't attempt fixes here — this plan only changes dependency indirection and adds a test package.
