# HubStore + HubClient Params-Object Uniformity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the seven remaining positional `HubStore` methods and the positional `HubClient` methods (plus `HubClient.publish`'s `payload` type) to single named params objects, so both hub surfaces are uniform and extensible without a further break.

**Architecture:** Pure API-shape refactor — no behavioral change, no wire-schema change. Each task is one atomic breaking change across a port and all its consumers, kept compile-green per commit (a signature change breaks every consumer at once, so a port and its callers migrate together). Verification is `turbo run test:types` + the existing test suites, not new red-green behavior tests.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, vitest, biome. `@sozai/codec` for Base64.

**Spec:** `docs/agents/plans/2026-09-04-hub-params-objects.design.md`

## Global Constraints

- pnpm only. Run repo scripts via `rtk proxy pnpm run <script>` (the `rtk` shim otherwise redirects to the wrong tool); or invoke tools directly (`pnpm exec biome check ...`).
- Do not edit generated files (`lib/`).
- Internal `@kumiai/*` deps are `workspace:^`; cross-repo `@sozai/*` deps go through the workspace catalog as published `^` ranges.
- Wire schemas are **untouched** — this is a TypeScript-signature reshape on top of the same wire. `HubClient.publish` encodes with **standard Base64** (`toB64` from `@sozai/codec`), never `toB64U`: the wire declares `contentEncoding: 'base64'` (`hub-protocol/src/protocol.ts:35`) and the server decodes with `fromB64` (`hub-server/src/handlers.ts:392`); `toB64U`'s `-`/`_` alphabet would typecheck then fail `fromB64` at runtime.
- Return types of all reshaped methods are unchanged.
- Verify test runs are not cached turbo results: force the run and confirm `Cached: 0` (`pnpm test -- --force` is broken; use the per-package vitest run or clear the turbo cache).
- Branch: `refactor/hubstore-params-objects` (already created and checked out).

---

## File Structure

- `packages/hub-protocol/src/types.ts` — `HubStore` port: 7 method signatures + 7 new param types.
- `packages/hub-protocol/src/index.ts` — barrel: export the 7 new param types.
- `packages/hub-server/src/memoryStore.ts` — the only real `HubStore` impl: 7 method bodies.
- `packages/hub-server/src/handlers.ts` — 9 internal `store.*` call sites.
- `packages/hub-conformance/src/index.ts` — ~35 `HubStore` call sites (the contract).
- `packages/hub-client/src/client.ts` — 5 method signatures + `publish` payload type + internal `toB64`.
- `packages/hub-client/src/index.ts` — barrel: new client param types, drop `SubscribeOptions`.
- `packages/hub-client/README.md` — positional examples + caller-encoding section.
- `packages/mls-hub/src/pool.ts`, `packages/mls-hub/src/provisioner.ts` — client call sites.
- Test files: `hub-server/test/*`, `mls-hub/test/*`, `hub-client/test/*` — store & client call sites + Proxy fault injectors.

---

## Task 1: HubStore port → params objects (port + impl + all consumers)

Atomic breaking change: the `HubStore` type, its one implementation, the server's internal callers, the conformance suite, and every store call site in tests migrate together. Ends compile-green.

**Files:**
- Modify: `packages/hub-protocol/src/types.ts:219-251`
- Modify: `packages/hub-protocol/src/index.ts:25-39`
- Modify: `packages/hub-server/src/memoryStore.ts:482-541`
- Modify: `packages/hub-server/src/handlers.ts` (lines `458,557,822,825,886,913,920,957,958`)
- Modify: `packages/hub-conformance/src/index.ts` (~35 sites; see Step 4)
- Modify: `packages/hub-server/test/*`, `packages/mls-hub/test/*` (store call sites + Proxy fault injectors)

**Interfaces:**
- Produces (new param types in `@kumiai/hub-protocol`):
  ```ts
  export type UnsubscribeParams = { subscriberDID: string; topicID: string }
  export type GetSubscribersParams = { topicID: string }
  export type StoreKeyPackageParams = { ownerDID: string; keyPackage: string; notAfter?: number }
  export type FetchKeyPackagesParams = { ownerDID: string; count?: number }
  export type CountKeyPackagesParams = { ownerDID: string }
  export type StoreLastResortKeyPackageParams = { ownerDID: string; keyPackage: string }
  export type FetchLastResortKeyPackageParams = { ownerDID: string }
  ```
- Produces (new `HubStore` method signatures):
  ```ts
  unsubscribe(params: UnsubscribeParams): Promise<void>
  getSubscribers(params: GetSubscribersParams): Promise<Array<string>>
  storeKeyPackage(params: StoreKeyPackageParams): Promise<void>
  fetchKeyPackages(params: FetchKeyPackagesParams): Promise<Array<string>>
  countKeyPackages(params: CountKeyPackagesParams): Promise<number>
  storeLastResortKeyPackage(params: StoreLastResortKeyPackageParams): Promise<void>
  fetchLastResortKeyPackage(params: FetchLastResortKeyPackageParams): Promise<string | null>
  ```

- [ ] **Step 1: Add the 7 param types and reshape the 7 signatures in `types.ts`**

In `packages/hub-protocol/src/types.ts`, add the param types above (place each beside the existing `SubscribeParams`/`AckParams` group for locality — a `type` block near line 149–172 is fine). Then change the `HubStore` method lines (`219,220,235,236,238,248,251`) to the new signatures. **Preserve every existing doc-comment** on these methods verbatim (the `notAfter` expiry contract on `storeKeyPackage`, the reuse/no-consume note on `fetchLastResortKeyPackage`, the cap note on `subscribe`/`storeKeyPackage`) — only the parameter list changes. Example, before/after:

```ts
// before
unsubscribe(subscriberDID: string, topicID: string): Promise<void>
// after
unsubscribe(params: UnsubscribeParams): Promise<void>
```
```ts
// before
storeKeyPackage(ownerDID: string, keyPackage: string, notAfter?: number): Promise<void>
// after
storeKeyPackage(params: StoreKeyPackageParams): Promise<void>
```

- [ ] **Step 2: Export the 7 new param types from the barrel**

In `packages/hub-protocol/src/index.ts`, extend the `export type { ... } from './types.js'` block (lines 25-39) with the seven new names, keeping alphabetical order:

```ts
export type {
  AckParams,
  CountKeyPackagesParams,
  FetchKeyPackagesParams,
  FetchLastResortKeyPackageParams,
  FetchParams,
  FetchResult,
  FetchTopicParams,
  FetchTopicResult,
  GetSubscribersParams,
  HubStore,
  HubStoreEvents,
  PublishParams,
  PublishResult,
  PurgeParams,
  StoreKeyPackageParams,
  StoreLastResortKeyPackageParams,
  StoredMessage,
  SubscribeParams,
  TrimParams,
  UnsubscribeParams,
} from './types.js'
```

- [ ] **Step 3: Reshape the 7 `memoryStore` method bodies**

In `packages/hub-server/src/memoryStore.ts`, change each method to destructure from a params object. Bodies are otherwise identical. Full replacements for lines 482-541:

```ts
    async getSubscribers({ topicID }: GetSubscribersParams): Promise<Array<string>> {
      const subscribers = subscriptions.get(topicID)
      return subscribers == null ? [] : [...subscribers.keys()]
    },

    async storeKeyPackage({ ownerDID, keyPackage, notAfter }: StoreKeyPackageParams): Promise<void> {
      let packages = keyPackages.get(ownerDID)
      if (packages == null) {
        packages = []
        keyPackages.set(ownerDID, packages)
      }
      const nowSeconds = Math.floor(Date.now() / 1000)
      const live = packages.filter((entry) => isLive(entry, nowSeconds))
      if (live.length !== packages.length) {
        packages.length = 0
        packages.push(...live)
      }
      if (packages.length >= maxKeyPackagesPerDID) {
        throw new KeyPackageQuotaExceededError(
          `DID ${ownerDID} exceeds the maximum of ${maxKeyPackagesPerDID} stored key packages`,
        )
      }
      packages.push({ keyPackage, ...(notAfter != null ? { notAfter } : {}) })
    },

    async fetchKeyPackages({ ownerDID, count }: FetchKeyPackagesParams): Promise<Array<string>> {
      const packages = keyPackages.get(ownerDID)
      if (packages == null || packages.length === 0) return []
      const nowSeconds = Math.floor(Date.now() / 1000)
      const served: Array<string> = []
      const n = count ?? 1
      while (packages.length > 0 && served.length < n) {
        const entry = packages.shift() as StoredKeyPackage
        if (isLive(entry, nowSeconds)) served.push(entry.keyPackage)
      }
      return served
    },

    async countKeyPackages({ ownerDID }: CountKeyPackagesParams): Promise<number> {
      const packages = keyPackages.get(ownerDID)
      if (packages == null) return 0
      const nowSeconds = Math.floor(Date.now() / 1000)
      return packages.filter((entry) => isLive(entry, nowSeconds)).length
    },

    async storeLastResortKeyPackage({
      ownerDID,
      keyPackage,
    }: StoreLastResortKeyPackageParams): Promise<void> {
      lastResortKeyPackages.set(ownerDID, keyPackage)
    },

    async fetchLastResortKeyPackage({
      ownerDID,
    }: FetchLastResortKeyPackageParams): Promise<string | null> {
      return lastResortKeyPackages.get(ownerDID) ?? null
    },
```

Also reshape `unsubscribe` (near line 460-480, currently `async unsubscribe(subscriberDID: string, topicID: string)`) to `async unsubscribe({ subscriberDID, topicID }: UnsubscribeParams)`, body unchanged. Preserve the `fetchLastResortKeyPackage` "No splice, ever" comment. Add the seven type names to the existing `@kumiai/hub-protocol` type import at the top of `memoryStore.ts`.

- [ ] **Step 4: Reshape the 9 `handlers.ts` internal call sites**

In `packages/hub-server/src/handlers.ts`, convert each positional call to a params object. Exact edits:

```ts
// :458   subscribers = await store.getSubscribers(topicID)
subscribers = await store.getSubscribers({ topicID })
// :557   await store.unsubscribe(clientDID, topicID)
await store.unsubscribe({ subscriberDID: clientDID, topicID })
// :822   await store.storeLastResortKeyPackage(clientDID, lastResortPackage)
await store.storeLastResortKeyPackage({ ownerDID: clientDID, keyPackage: lastResortPackage })
// :825   keyPackages.map((kp: string) => store.storeKeyPackage(clientDID, kp, notAfter))
keyPackages.map((kp: string) => store.storeKeyPackage({ ownerDID: clientDID, keyPackage: kp, notAfter }))
// :886   lastResort = await store.fetchLastResortKeyPackage(targetDID)
lastResort = await store.fetchLastResortKeyPackage({ ownerDID: targetDID })
// :913   consumed = await store.fetchKeyPackages(targetDID, cappedCount)
consumed = await store.fetchKeyPackages({ ownerDID: targetDID, count: cappedCount })
// :920   lastResort = await store.fetchLastResortKeyPackage(targetDID)
lastResort = await store.fetchLastResortKeyPackage({ ownerDID: targetDID })
// :957   store.countKeyPackages(clientDID)
store.countKeyPackages({ ownerDID: clientDID })
// :958   store.fetchLastResortKeyPackage(clientDID)
store.fetchLastResortKeyPackage({ ownerDID: clientDID })
```

(Line numbers drift as you edit; the nine calls are the only `store.<method>(` positional invocations of the seven methods in the file — re-grep `store\.(getSubscribers|unsubscribe|storeKeyPackage|fetchKeyPackages|countKeyPackages|storeLastResortKeyPackage|fetchLastResortKeyPackage)\(` to confirm none remain positional.)

- [ ] **Step 5: Reshape all `HubStore` call sites in the conformance suite and tests**

Mechanical transform, applied to every positional call of the seven methods. The argument-name mapping is fixed:
- `getSubscribers(t)` → `getSubscribers({ topicID: t })`
- `unsubscribe(s, t)` → `unsubscribe({ subscriberDID: s, topicID: t })`
- `storeKeyPackage(o, kp)` / `(o, kp, na)` → `storeKeyPackage({ ownerDID: o, keyPackage: kp })` / `({ ..., notAfter: na })`
- `fetchKeyPackages(o)` / `(o, c)` → `fetchKeyPackages({ ownerDID: o })` / `({ ownerDID: o, count: c })`
- `countKeyPackages(o)` → `countKeyPackages({ ownerDID: o })`
- `storeLastResortKeyPackage(o, kp)` → `storeLastResortKeyPackage({ ownerDID: o, keyPackage: kp })`
- `fetchLastResortKeyPackage(o)` → `fetchLastResortKeyPackage({ ownerDID: o })`

Concrete examples from `packages/hub-conformance/src/index.ts`:
```ts
// :898  expect(await store.getSubscribers(TOPIC)).toEqual([])
expect(await store.getSubscribers({ topicID: TOPIC })).toEqual([])
// :920  await store.storeKeyPackage(ALICE, 'kp-1')
await store.storeKeyPackage({ ownerDID: ALICE, keyPackage: 'kp-1' })
// :947  await store.storeKeyPackage(ALICE, 'kp-dead', past)
await store.storeKeyPackage({ ownerDID: ALICE, keyPackage: 'kp-dead', notAfter: past })
// :923  const first = await store.fetchKeyPackages(ALICE, 1)
const first = await store.fetchKeyPackages({ ownerDID: ALICE, count: 1 })
// :959  expect(await store.countKeyPackages(ALICE)).toBe(1)
expect(await store.countKeyPackages({ ownerDID: ALICE })).toBe(1)
```

Apply identically to the remaining `hub-conformance/src/index.ts` sites and to every store call site in: `hub-server/test/handlers.test.ts`, `hub-server/test/hub.test.ts`, `hub-server/test/memoryStore.test.ts`, `mls-hub/test/join.test.ts`, `mls-hub/test/pool.test.ts`, `mls-hub/test/provisioner.test.ts`. Find them all with:
```bash
rg -n '\.(getSubscribers|unsubscribe|storeKeyPackage|fetchKeyPackages|countKeyPackages|storeLastResortKeyPackage|fetchLastResortKeyPackage)\(' packages/hub-conformance packages/hub-server/test packages/mls-hub/test --type ts
```
For the Proxy-based fault injectors (`failingStore(method: keyof HubStore)` in `handlers-store-errors.test.ts:56`, and the `new Proxy(createMemoryStore(), …)` stores in `hub.test.ts:636,673` and `handlers.test.ts:645`): these forward calls generically, so the Proxy handlers themselves need no signature edit — but any direct positional call *through* them does. Re-grep to confirm.

- [ ] **Step 6: Typecheck the affected packages**

Run: `rtk proxy pnpm exec turbo run test:types --filter=@kumiai/hub-protocol --filter=@kumiai/hub-server --filter=@kumiai/hub-conformance --filter=@kumiai/mls-hub`
Expected: PASS. Any residual positional call surfaces here as a TS argument-count error — fix and re-run.

- [ ] **Step 7: Run the affected test suites (force, no cache)**

Run: `rtk proxy pnpm exec turbo run test --filter=@kumiai/hub-server --filter=@kumiai/hub-conformance --filter=@kumiai/mls-hub --force`
Expected: PASS, `Cached: 0`. Behavior is unchanged, so every existing test stays green; a failure means a call-site was mis-mapped (wrong field name).

- [ ] **Step 8: Lint**

Run: `rtk proxy pnpm run lint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/hub-protocol packages/hub-server packages/hub-conformance packages/mls-hub
git commit -m "refactor(hub-protocol)!: HubStore methods take params objects

Convert the seven positional HubStore methods (unsubscribe, getSubscribers,
storeKeyPackage, fetchKeyPackages, countKeyPackages, storeLastResortKeyPackage,
fetchLastResortKeyPackage) to single named params objects, matching every other
HubStore method. Pure signature reshape, no behavioral or wire change.

BREAKING CHANGE: HubStore implementors and callers must pass params objects."
```

---

## Task 2: HubClient positional methods → params objects (methods only, not publish)

**Files:**
- Modify: `packages/hub-client/src/client.ts` (`subscribe` :100, `unsubscribe` :113, `uploadKeyPackages` :137, `uploadLastResortKeyPackage` :163, `fetchKeyPackages` :184; add param types near the top type block)
- Modify: `packages/hub-client/src/index.ts:3-12`
- Modify: `packages/mls-hub/src/pool.ts:174-177`, `packages/mls-hub/src/provisioner.ts:147`
- Modify: `packages/hub-client/test/client.test.ts`, `packages/mls-hub/test/pool.test.ts`, `packages/mls-hub/test/provisioner.test.ts`

**Interfaces:**
- Produces (new client param types in `@kumiai/hub-client`):
  ```ts
  export type SubscribeParams = { topicID: string; retention?: number }
  export type UnsubscribeParams = { topicID: string }
  export type UploadKeyPackagesParams = { keyPackages: Array<string>; notAfter?: number }
  export type UploadLastResortKeyPackageParams = { keyPackage: string }
  export type FetchKeyPackagesParams = { did: string; count?: number }
  ```
- Produces (new method signatures): `subscribe(params: SubscribeParams)`, `unsubscribe(params: UnsubscribeParams)`, `uploadKeyPackages(params: UploadKeyPackagesParams)`, `uploadLastResortKeyPackage(params: UploadLastResortKeyPackageParams)`, `fetchKeyPackages(params: FetchKeyPackagesParams)`. Return types unchanged. `SubscribeParams` folds in and replaces the old `SubscribeOptions`.

- [ ] **Step 1: Add the param types and reshape the five methods in `client.ts`**

Replace `SubscribeOptions` (lines 22-25) with `SubscribeParams`, and add the other four param types beside it. Reshape the method bodies (they only re-source their fields):

```ts
export type SubscribeParams = {
  topicID: string
  /** Requested retention in seconds. Above the hub's maximum the subscribe is refused. */
  retention?: number
}
export type UnsubscribeParams = { topicID: string }
export type UploadKeyPackagesParams = { keyPackages: Array<string>; notAfter?: number }
export type UploadLastResortKeyPackageParams = { keyPackage: string }
export type FetchKeyPackagesParams = { did: string; count?: number }
```
```ts
  subscribe(params: SubscribeParams): RequestCall<{ subscribed: boolean }> {
    return this.#client.request('hub/v1/subscribe', {
      param: { topicID: params.topicID, retention: params.retention },
    })
  }

  unsubscribe(params: UnsubscribeParams): RequestCall<{ unsubscribed: boolean }> {
    return this.#client.request('hub/v1/unsubscribe', {
      param: { topicID: params.topicID },
    })
  }

  uploadKeyPackages(params: UploadKeyPackagesParams): RequestCall<{ stored: number }> {
    return this.#client.request('hub/v1/keypackage/upload', {
      // An explicit `notAfter: undefined` fails the wire schema's `integer` check on some
      // transports (unlike JSON, they don't drop `undefined` properties) — omit the key instead.
      param: {
        keyPackages: params.keyPackages,
        ...(params.notAfter != null ? { notAfter: params.notAfter } : {}),
      },
    })
  }

  uploadLastResortKeyPackage(
    params: UploadLastResortKeyPackageParams,
  ): RequestCall<{ stored: number }> {
    return this.#client.request('hub/v1/keypackage/upload', {
      param: { keyPackages: [params.keyPackage], lastResort: true },
    })
  }

  fetchKeyPackages(params: FetchKeyPackagesParams): RequestCall<{ keyPackages: Array<string> }> {
    return this.#client.request('hub/v1/keypackage/fetch', {
      param: { did: params.did, count: params.count },
    })
  }
```
Preserve the existing doc-comments on `uploadKeyPackages`, `uploadLastResortKeyPackage`, and `keyPackageStatus` verbatim.

- [ ] **Step 2: Update the barrel**

In `packages/hub-client/src/index.ts`, drop `SubscribeOptions` and add the five new param types:
```ts
export {
  type FetchKeyPackagesParams,
  type FetchTopicParams,
  type FetchTopicResult,
  HubClient,
  type HubClientParams,
  type PublishParams,
  type ReceiveOptions,
  type RegisterWakeParams,
  type SubscribeParams,
  type UnsubscribeParams,
  type UploadKeyPackagesParams,
  type UploadLastResortKeyPackageParams,
} from './client.js'
```

- [ ] **Step 3: Update the mls-hub src callers**

```ts
// pool.ts:174 — client.uploadKeyPackages(records.map((r) => r.keyPackage), notAfter)
client.uploadKeyPackages({ keyPackages: records.map((record) => record.keyPackage), notAfter })
// provisioner.ts:147 — client.uploadLastResortKeyPackage(record.keyPackage)
client.uploadLastResortKeyPackage({ keyPackage: record.keyPackage })
```

- [ ] **Step 4: Update the client + mls-hub test call sites**

Transform every positional call of the five methods. Mapping:
- `subscribe(t, { retention })` → `subscribe({ topicID: t, retention })`
- `unsubscribe(t)` → `unsubscribe({ topicID: t })`
- `uploadKeyPackages(kps)` / `(kps, na)` → `uploadKeyPackages({ keyPackages: kps })` / `({ keyPackages: kps, notAfter: na })`
- `uploadLastResortKeyPackage(kp)` → `uploadLastResortKeyPackage({ keyPackage: kp })`
- `fetchKeyPackages(did, c)` → `fetchKeyPackages({ did, count: c })`

Examples from `hub-client/test/client.test.ts`:
```ts
// :136  await client.uploadKeyPackages(['kp-1', 'kp-2'])
await client.uploadKeyPackages({ keyPackages: ['kp-1', 'kp-2'] })
// :139  await client.fetchKeyPackages(identity.id, 1)
await client.fetchKeyPackages({ did: identity.id, count: 1 })
// :149  await client.uploadLastResortKeyPackage('kp-lr')
await client.uploadLastResortKeyPackage({ keyPackage: 'kp-lr' })
// :164  await client.uploadKeyPackages(['kp-1', 'kp-2'], future)
await client.uploadKeyPackages({ keyPackages: ['kp-1', 'kp-2'], notAfter: future })
```
And `mls-hub/test/pool.test.ts:539-540`:
```ts
await hub.client.uploadKeyPackages({ keyPackages: Array.from({ length: 50 }, (_, index) => `a-${index}`) })
```
Find every site: `rg -n 'client\.(subscribe|unsubscribe|uploadKeyPackages|uploadLastResortKeyPackage|fetchKeyPackages)\(' packages --type ts`. Also sweep any `.subscribe(`/`.unsubscribe(` on a `HubClient` instance in `hub-client/test/*` and `hub-client/test/wake.test.ts`.

- [ ] **Step 5: Typecheck**

Run: `rtk proxy pnpm exec turbo run test:types --filter=@kumiai/hub-client --filter=@kumiai/mls-hub`
Expected: PASS.

- [ ] **Step 6: Test (force)**

Run: `rtk proxy pnpm exec turbo run test --filter=@kumiai/hub-client --filter=@kumiai/mls-hub --force`
Expected: PASS, `Cached: 0`.

- [ ] **Step 7: Commit**

```bash
git add packages/hub-client/src packages/mls-hub/src packages/hub-client/test packages/mls-hub/test
git commit -m "refactor(hub-client)!: positional client methods take params objects

subscribe/unsubscribe/uploadKeyPackages/uploadLastResortKeyPackage/fetchKeyPackages
now take single named params objects; SubscribeOptions is folded into SubscribeParams.

BREAKING CHANGE: HubClient callers must pass params objects."
```

---

## Task 3: HubClient.publish payload → Uint8Array (client encodes)

**Files:**
- Modify: `packages/hub-client/src/client.ts` (`PublishParams` :8-20, `publish` :86-98; add `toB64` import)
- Modify: `packages/hub-client/README.md`
- Modify: publish call sites that currently pass a pre-encoded base64 string (grep — mostly `hub-client/test/*`)

**Interfaces:**
- Consumes: `toB64` from `@sozai/codec` (`toB64(bytes: Uint8Array): string`, standard Base64, `../sozai/packages/codec/src/index.ts:149`).
- Produces: `PublishParams.payload` is now `Uint8Array`; `HubClient.publish` encodes internally. On-wire bytes unchanged.

- [ ] **Step 1: Change the payload type and encode inside `publish`**

In `packages/hub-client/src/client.ts`:
```ts
import { toB64 } from '@sozai/codec'
```
```ts
export type PublishParams = {
  topicID: string
  payload: Uint8Array
  /** Retention class. Absent: 'mailbox' — the frame dies with its last ack. */
  retain?: 'log' | 'mailbox'
  expectedHead?: string | null
  publishID?: string
}
```
```ts
  publish(params: PublishParams): RequestCall<{ sequenceID: string }> {
    return this.#client.request('hub/v1/publish', {
      param: {
        topicID: params.topicID,
        // Standard Base64 — the wire schema declares contentEncoding 'base64' and the server
        // decodes with fromB64; toB64U's -/_ alphabet would fail that decode.
        payload: toB64(params.payload),
        retain: params.retain,
        ...('expectedHead' in params ? { expectedHead: params.expectedHead } : {}),
        publishID: params.publishID,
      },
    })
  }
```
Confirm `@sozai/codec` is already a dependency (`hub-client/package.json:41`); it is — no manifest change.

- [ ] **Step 2: Update publish call sites**

Find them: `rg -n '\.publish\(' packages/hub-client/test packages/mls-hub --type ts`. Any call passing `toB64(x)` (or an already-encoded string) as `payload` now passes the raw `Uint8Array x`. Example:
```ts
// before: await client.publish({ topicID, payload: toB64(bytes) })
await client.publish({ topicID, payload: bytes })
```
A call site that only had a string literal payload must produce bytes instead (`new TextEncoder().encode('...')`). Do **not** touch rpc/hub-tunnel `.publish` calls — those are the hub-tunnel `LogHub`/`MailboxHub` port (`HubPublishParams`, already `Uint8Array`), a different surface.

- [ ] **Step 3: Rewrite the README payload section and examples**

In `packages/hub-client/README.md`:
- Line 24 example: `await hub.publish({ topicID, payload: bytes, retain: 'log' })` (drop `toB64`).
- Line 23 example: `await hub.subscribe({ topicID, retention: 86400 })`.
- Replace the whole "## Payloads are base64 strings, and the caller encodes them" section (lines 35-40) with:
  ```markdown
  ## Payloads are bytes; the client encodes them

  `payload` is `Uint8Array`. The wire schema declares it `contentEncoding: 'base64'`, and
  `HubClient.publish` encodes with standard Base64 (`toB64` from `@sozai/codec`) before sending —
  the caller hands over raw bytes. On the read side, `receive`/`fetchTopic` still surface the wire's
  base64 `payload` string; decode those with `fromB64`.
  ```
- Update the `## Exports` bullet (lines 8-13) so the method list and the `PublishParams` note reflect params objects and the `Uint8Array` payload.

- [ ] **Step 4: Typecheck + test (force)**

Run: `rtk proxy pnpm exec turbo run test:types test --filter=@kumiai/hub-client --filter=@kumiai/mls-hub --force`
Expected: PASS, `Cached: 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/hub-client
git commit -m "refactor(hub-client)!: publish takes Uint8Array payload, encodes internally

HubClient.publish now accepts raw bytes and standard-Base64-encodes them with
toB64 before sending, instead of requiring the caller to pre-encode. On-wire
bytes are unchanged.

BREAKING CHANGE: HubClient.publish payload is now Uint8Array, not a base64 string."
```

---

## Task 4: Full-repo verification + milestone bookkeeping

**Files:**
- Modify: `docs/agents/plans/milestones/pre-1.0-breaking-api.md`

- [ ] **Step 1: Repo-wide type check**

Run: `rtk proxy pnpm exec turbo run test:types --force`
Expected: PASS across **every** package, `Cached: 0`. A consumer package can hide an un-migrated site a per-package filter missed; this is the gate that catches it. Fix any residual site (mapping per Tasks 1-3) and re-run.

- [ ] **Step 2: Full test + lint (force)**

Run: `rtk proxy pnpm exec turbo run test --force` then `rtk proxy pnpm run lint`
Expected: all suites PASS with `Cached: 0`; lint clean. Both contract suites (`@kumiai/hub-conformance`, `@kumiai/rpc-conformance`) run here — AGENTS.md requires both on any port change. `HubStore` conformance runs against `createMemoryStore` (its only registered implementation, `hub-server/test/conformance.test.ts:10`); there are no conformance doubles for this port.

- [ ] **Step 3: Record a release intent**

Run: `rtk proxy pnpm change` and record a `minor` bump for the affected packages (`@kumiai/hub-protocol`, `@kumiai/hub-client`, and any package whose published surface changed), with a summary naming the breaking signature reshape. (0.x → a breaking change is a `minor`.)

- [ ] **Step 4: Mark the milestone entries taken**

In `docs/agents/plans/milestones/pre-1.0-breaking-api.md`, strike through the two now-taken entries with a `*Taken 2026-09-04:*` note and a link to this plan (and the eventual completion doc):
- The `HubStore` "four positional methods" bullet (record the premise correction: **four → seven** positional methods, since `countKeyPackages`, `storeLastResortKeyPackage`, `fetchLastResortKeyPackage`, and `storeKeyPackage`'s `notAfter` postdated `5eb220a`).
- The `HubClient.publish` "pre-base64 `payload: string`" bullet (note the full client sweep rode along in the same PR, and that the encoding is standard Base64 via `toB64`).

- [ ] **Step 5: Commit**

```bash
git add docs/agents/plans/milestones/pre-1.0-breaking-api.md .changes
git commit -m "docs: mark HubStore/HubClient params-object items taken; record minor intent"
```

---

## Self-Review

**Spec coverage:**
- HubStore 7 methods → params objects — Task 1. ✓
- HubStore param types exported from barrel — Task 1 Step 2. ✓
- memoryStore impl, handlers 9 sites, conformance ~35 sites, store test sites — Task 1. ✓
- HubClient 5 positional methods → params objects — Task 2. ✓
- HubClient barrel (drop SubscribeOptions, add param types) — Task 2 Step 2. ✓
- HubClient.publish payload → Uint8Array via `toB64` — Task 3. ✓
- README update — Task 3 Step 3. ✓
- Out-of-scope hub-tunnel port left untouched — noted in Task 3 Step 2. ✓
- Testing: both contract suites + repo-wide `test:types`; no HubStore doubles — Task 4. ✓
- Milestone bookkeeping incl. four→seven correction — Task 4 Step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step carries verbatim code or an explicit transform + grep to enumerate sites. The call-site sweeps (Task 1 Step 5, Task 2 Step 4, Task 3 Step 2) are mechanical and enumerated by grep rather than transcribed — the field-name mapping is given in full so no judgement is left to the implementer.

**Type consistency:** `HubStore` param type names (Task 1) match their use in memoryStore (Step 3), handlers (Step 4), and conformance (Step 5). Client param type names (Task 2) match the barrel (Step 2) and the mls-hub callers (Step 3). `toB64(bytes: Uint8Array): string` (Task 3) matches the `@sozai/codec` signature. `SubscribeParams` is deliberately defined in both `@kumiai/hub-protocol` ({subscriberDID, topicID, retention?}) and `@kumiai/hub-client` ({topicID, retention?}) — different module-scoped types for the store port vs the client surface; this is intentional and mirrors the existing `PublishParams` split between the two packages.

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute in this session with checkpoints.
