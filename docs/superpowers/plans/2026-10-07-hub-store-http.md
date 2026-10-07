# kumiai Hub Store and HTTP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the kumiai hub deployable as a production HTTP service: a hozon-backed `HubStore` (`@kumiai/hub-store`), `createHub` teardown and revocation support, and a `'kumiai:hub'` teikyo plugin with a `createHubServer` entry point (`@kumiai/hub-http`).

**Architecture:** `@kumiai/hub-store` ports kubun's SQL hub store onto a hozon `StoreDefinition` and passes `@kumiai/hub-conformance`. `createHub` gains `verifyToken` and an awaited `dispose()` that settles background work. `@kumiai/hub-http` mounts the enkaku transport with `@teikyo/enkaku`'s `mountTransport`, builds the hub on the hozon store, and wires optional teikyo access plugins.

**Tech Stack:** TypeScript, kysely ^0.29.6, `@hozon/db`/`@hozon/provider` ^0.1.0, `@sozai/http-server` ^0.1.0, `@teikyo/hozon`/`@teikyo/access`/`@teikyo/enkaku`/`@teikyo/rate-limit` ^0.1.0, vitest, testcontainers ^12.1.0.

**Spec:** `/Users/paul/dev/yulsi/kigu/docs/agents/plans/2026-10-07-teikyo-repo.md`, section *Downstream acceptance consumers → kumiai*.

## Global Constraints

- Prerequisite: `@sozai/http-server` 0.1.0 and `@teikyo/*` 0.1.0 are published. Tasks 1–2 may start earlier (they need only hozon).
- Branch `feat/hub-store-http` in kumiai (already created).
- New packages version `0.10.0` (matching the repo's line), `"engines": { "node": ">=24" }`, layout copied from `packages/hub-server/package.json`. Add `kysely`, `@hozon/*`, `@sozai/http-server`, `@teikyo/*`, `testcontainers`, `@testcontainers/postgresql` to the catalog.
- Store name `'kumiai-hub'`. Tables are named unprefixed in migrations (`hub_messages`, …); hozon's `TablePrefixPlugin` applies the prefix.
- Plugin name `'kumiai:hub'`; default mount path `/hub`.
- Conventions (`kigu:conventions`); no plan references in code or test names; British prose.

## Review Focus

- **Two hub processes on one Postgres database** -- `publish` CAS and sequence minting must stay correct; port kubun's `conformance-postgres-race.test.ts`. Owned by Task 1.
- **Restart with pending deliveries** -- a reopened store returns undelivered messages; port kubun's `restart-durability.test.ts`. Owned by Task 1.
- **`dispose()` while a purge is mid-flight** -- `dispose()` resolves only after the purge settles, and no new purge starts. Owned by Task 2.
- **Wake send resolving after dispose** -- no registry write happens after `dispose()` resolved. Owned by Task 2.
- **Client reconnect during server shutdown** -- new connections are refused and the client sees a transport error, not a hang. Owned by Task 4.

---

### Task 1: `@kumiai/hub-store`

**Files:**
- Create: `packages/hub-store/{package.json,tsconfig.json,tsconfig.test.json,README.md}`, `src/{tables,migrations,store,definition,index}.ts`
- Test: `packages/hub-store/test/{conformance,migrations,restart-durability,sweep-chunking,postgres-race}.test.ts`

**Interfaces:**
- Produces:

```ts
export type HubStoreOptions = {
  defaultRetention?: number          // seconds
  maxRetention?: number              // seconds; absent = no maximum
  maxDepth?: number                  // absent = unbounded
  maxKeyPackagesPerDID?: number      // default 100
  maxSubscriptionsPerDID?: number    // default 1000
}
export const HUB_STORE = 'kumiai-hub'
export function createHubStoreDefinition(options?: HubStoreOptions): StoreDefinition<HubTables, HubStore>
export function getHubStore(provider: StoreProvider): Promise<HubStore>
```

- Port `kubun/packages/hub/src/hub-store.ts` and `src/migrations.ts`. Changes: table names drop the `kubun_` prefix (`hub_messages`, `hub_deliveries`, `hub_key_packages`, `hub_last_resort_key_packages`, `hub_subscriptions`, `hub_topics`, `hub_sequence`, `hub_publish_ids`); index and constraint names use `${ctx.tablePrefix}_` like `hozon/packages/store-log`; migration key `'0-init'`; column types from `ctx.types`; the kysely instance comes from `createAPI(db, adapter)` instead of a lazy promise; drop `purgeSubscribers` (kubun-only). Keep `PUBLISH_ID_RETENTION_SECONDS` and `DELETE_CHUNK_SIZE`.

- [ ] **Step 1: Write failing tests:**
  - `conformance.test.ts`: `testHubStoreConformance` and `testLogHubConformance` with the same limits and fake-`Date` setup as `packages/hub-server/test/conformance.test.ts`, run for two backends: node-sqlite `:memory:` (always) and Postgres (from `@testcontainers/postgresql`, skipped unless Docker or `HOZON_POSTGRES_URL` is available, required when `CI=true`). `createStore` builds a fresh `HozonDB` (Postgres: a fresh `tablePrefix` per store) and returns `getHubStore(db)`.
  - Port kubun's `migrations.test.ts`, `restart-durability.test.ts`, `sweep-chunking.test.ts`, `conformance-postgres-race.test.ts` to the hozon setup, keeping their test names and assertions.
- [ ] **Step 2: Run** `pnpm exec vitest run` in `packages/hub-store` -- expect FAIL.
- [ ] **Step 3: Implement** the port.
- [ ] **Step 4: Run** -- expect PASS on node-sqlite, and on Postgres where available.
- [ ] **Step 5: Commit** -- `git add packages/hub-store pnpm-workspace.yaml pnpm-lock.yaml && git commit -m "feat(hub-store): add hozon-backed hub store"`

### Task 2: `createHub` revocation hook and awaited teardown

**Files:**
- Modify: `packages/hub-server/src/hub.ts`, `src/wake.ts`
- Test: `packages/hub-server/test/hub-dispose.test.ts`, `test/wake.test.ts` (extend)

**Interfaces:**
- Produces:
  - `CreateHubParams.verifyToken?: VerifyTokenHook` (type from `@kokuin/capability`), forwarded to `serve()`.
  - `HubInstance = { registry: HubClientRegistry; server: Server<HubProtocol>; dispose(): Promise<void> }`.
  - `WakeDispatcher.dispose(): Promise<void>` -- marks disposed, clears debounce timers, awaits every in-flight send (tracked in a `Set<Promise<void>>`); a send that resolves after `disposed` skips registry writes.
- `dispose()` order: clear the purge interval; await the in-flight purge promise (tracked when started); `await wakeDispatcher?.dispose()`; `await server.dispose()`. Idempotent (returns the same promise). The existing `server.disposed.then(...)` cleanups call the same internal teardown so disposing the server directly still stops purge and wake.

- [ ] **Step 1: Write failing tests:**
  - `hub-dispose.test.ts`: `dispose waits for an in-flight purge` (store `purge` returns a deferred; advance fake timers past `purge.interval`; `dispose()` stays pending until the deferred resolves); `no purge starts after dispose` (purge spy call count unchanged after advancing timers); `dispose disposes the server` (`server.disposed` resolved); `dispose is idempotent`; `verifyToken is applied to delegated capabilities` (hook spy called when a client uses a delegated capability).
  - `wake.test.ts`: `dispose waits for in-flight sends`; `no registry write after dispose` (sender resolves `'gone'` after `dispose()` was called → `registry.delete` not called).
- [ ] **Step 2: Run** -- expect FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm exec vitest run` in `packages/hub-server` -- expect all PASS.
- [ ] **Step 5: Commit** -- `git commit -am "feat(hub-server): add verifyToken and awaited hub teardown"`

### Task 3: `@kumiai/hub-http`

**Files:**
- Create: `packages/hub-http/{package.json,...}`, `src/plugin.ts`, `src/server.ts`, `src/index.ts`
- Test: `packages/hub-http/test/plugin.test.ts`

**Interfaces:**
- Consumes: `HOZON_DB` (`@teikyo/hozon`), `ACCESS_GRANTS`, `ACCESS_REVOCATION` (`@teikyo/access`), `mountTransport`, `buildAccessRules` (`@teikyo/enkaku`), `createHubStoreDefinition`, `getHubStore` (Task 1), `createHub` (Task 2).
- Produces:

```ts
export type KumiaiHub = { registry: HubClientRegistry; server: Server<HubProtocol> }
export const KUMIAI_HUB: PluginName<'kumiai:hub', KumiaiHub>
export type HubPluginParams = Omit<CreateHubParams, 'transport' | 'store' | 'verifyToken'> & {
  path?: string                                   // default '/hub'
  store?: HubStoreOptions
  transport?: ServerTransportOptions
  access?: { grants?: true | Array<string>; revocation?: true }
}
export function hubPlugin(params: HubPluginParams): AnyHTTPPlugin
export type CreateHubServerParams = HubPluginParams & {
  db: HozonDBInput
  rateLimit?: { windowMs: number; limit: number } | false        // default { windowMs: 60_000, limit: 600 }
} & Omit<CreateServerParams, 'plugins'>
export function createHubServer(params: CreateHubServerParams): Promise<HTTPServer>
```

- Plugin setup: `db = ctx.use(HOZON_DB)`; `db.register(createHubStoreDefinition(params.store))`; `store = await getHubStore(db)`; `transport = mountTransport(ctx, path, params.transport)`; access rules = `buildAccessRules({ accessRules: params.accessRules, gated, allow: grants.allow() })` when `access.grants` (`gated` = `['hub/*']` for `true`; `DEFAULT_HUB_ACCESS_RULES` is not applied because it would overlap the gated patterns), else `params.accessRules` (which `createHub` defaults to `DEFAULT_HUB_ACCESS_RULES`); `verifyToken` from `ACCESS_REVOCATION` when `access.revocation`. `onShutdown` starts `hub.dispose()` and awaits `transport.dispose()`; `onClose` awaits the kept dispose promise with `{ timeoutMs: params.limits?.cleanupTimeoutMs ?? 30_000 }`.
- `createHubServer` composes `[hozonDBPlugin({ db }), accessGrantsPlugin() (if access.grants), accessRevocationPlugin() (if access.revocation), rateLimitPlugin(...) (unless false), hubPlugin(params)]` and calls `createServer`.

- [ ] **Step 1: Write failing tests** (`createHubServer` on `:memory:`, `listen()`, hub client over `@enkaku/http-fetch` `ClientTransport` at `${server.url}/hub`):
  - `publishes and fetches over HTTP`;
  - `denies clients without grants when grant-gated` / `allows them after a grant`;
  - `denies a revoked delegated capability`;
  - `rejects caller access rules overlapping the gated hub patterns` (factory throws);
  - `readiness reflects the database` (`/health/ready` `checks['hozon:db'] === true`);
  - `shuts down gracefully with subscribed clients` (client subscribed to a topic; `dispose()` → `shutdownReport.forced === false`, hub `dispose` completed).
- [ ] **Step 2: Run** -- expect FAIL. **Step 3: Implement.** **Step 4: Run** -- expect PASS.
- [ ] **Step 5: Commit** -- `git commit -m "feat(hub-http): add kumiai:hub plugin and createHubServer"`

### Task 4: Production-shape integration test

**Files:**
- Create: `tests/integration/test/hub-http.test.ts` (or the repo's existing integration package if one exists; else add `tests/integration` mirroring hozon's)

- [ ] **Step 1: Write failing tests**, over node-sqlite file and Postgres backends:
  - `messages survive a server restart` (publish, dispose, recreate on the same database, recipient fetches the message);
  - `two servers share one Postgres database` (publish via server A, fetch via server B);
  - `reconnects fail fast during shutdown` (after `dispose()` starts, a new client call rejects within 1 s).
- [ ] **Step 2: Run** -- expect FAIL, then fix until PASS.
- [ ] **Step 3: Commit** -- `git commit -m "test: add hub HTTP deployment tests"`

### Task 5: Docs and versioning

- [ ] **Step 1:** READMEs for `hub-store` and `hub-http` (a `createHubServer` deployment example with `trustProxy`, `handleSignals()`, grant-gating and revocation). Update `docs/agents/architecture.md` with the two packages and the new dependency on hozon and teikyo.
- [ ] **Step 2:** `pnpm change` -- minor intents for `@kumiai/hub-store`, `@kumiai/hub-http`, `@kumiai/hub-server`.
- [ ] **Step 3:** `rtk proxy pnpm run test` and `rtk proxy pnpm run lint` -- expect success.
- [ ] **Step 4: Commit** -- `git commit -am "docs: document hub store and HTTP server"`
