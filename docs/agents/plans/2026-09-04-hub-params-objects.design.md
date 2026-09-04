# Design: HubStore + HubClient params-object uniformity

**Status:** design, pending implementation plan
**Milestone item:** [pre-1.0 breaking API surface](milestones/pre-1.0-breaking-api.md) —
`@kumiai/hub-*` "HubStore's four positional methods" and "HubClient.publish's pre-base64
`payload: string`".
**Branch:** `refactor/hubstore-params-objects`

## Why now

Every item on the pre-1.0 breaking-API milestone costs a `minor` today and a `major` after 1.0.
This item is the heaviest deadline blocker still open: reshaping `HubStore` breaks every
implementor *and* every conformance double, and the milestone's own note records that its cheap
bundling moment already passed once (`hub-keypackage-subscribe-caps` shipped without taking it, and
in fact *added* a positional `notAfter` to `storeKeyPackage`). There is no scheduled work opening
this surface again, so it keeps slipping. Taking it now, deliberately, is the point of the
milestone.

**Premise re-verification (2026-09-04):** the milestone entry (written against `5eb220a`) says
*four* positional `HubStore` methods. The current source has **seven** — `unsubscribe`,
`getSubscribers`, `storeKeyPackage` (which gained a positional `notAfter`), `fetchKeyPackages`,
`countKeyPackages`, `storeLastResortKeyPackage`, `fetchLastResortKeyPackage`
(`packages/hub-protocol/src/types.ts:207-252`). The item is larger than filed, not smaller. Every
*other* `HubStore` method already takes a single params object.

## Goal

Make both hub surfaces uniform: every non-trivial method takes exactly one named params object.
This is a pure API-shape change — no behavioral change, no new capability. Uniformity is not
cosmetic: a params object lets any method gain a field later with no further break. The positional
`notAfter` bolt-on is precisely the recurrence this prevents.

## Scope

### In scope — `HubStore` port (`packages/hub-protocol/src/types.ts`)

Convert all seven positional methods to single params objects. Return types unchanged.

| Method | New signature | Params fields |
|---|---|---|
| `unsubscribe` | `(params: UnsubscribeParams)` | `subscriberDID`, `topicID` |
| `getSubscribers` | `(params: GetSubscribersParams)` | `topicID` |
| `storeKeyPackage` | `(params: StoreKeyPackageParams)` | `ownerDID`, `keyPackage`, `notAfter?` |
| `fetchKeyPackages` | `(params: FetchKeyPackagesParams)` | `ownerDID`, `count?` |
| `countKeyPackages` | `(params: CountKeyPackagesParams)` | `ownerDID` |
| `storeLastResortKeyPackage` | `(params: StoreLastResortKeyPackageParams)` | `ownerDID`, `keyPackage` |
| `fetchLastResortKeyPackage` | `(params: FetchLastResortKeyPackageParams)` | `ownerDID` |

Single-field methods (`getSubscribers`, `countKeyPackages`, `fetchLastResortKeyPackage`) are wrapped
too — uniformity is the whole objective, and each is then extensible without a future break.

### In scope — `HubClient` surface (`packages/hub-client/src/client.ts`)

Full params-object sweep of the remaining positional methods, plus the one filed payload break:

| Method | New signature | Params fields | Note |
|---|---|---|---|
| `subscribe` | `(params: SubscribeParams)` | `topicID`, `retention?` | folds today's `SubscribeOptions` in |
| `unsubscribe` | `(params: UnsubscribeParams)` | `topicID` | |
| `uploadKeyPackages` | `(params: UploadKeyPackagesParams)` | `keyPackages`, `notAfter?` | |
| `uploadLastResortKeyPackage` | `(params: UploadLastResortKeyPackageParams)` | `keyPackage` | |
| `fetchKeyPackages` | `(params: FetchKeyPackagesParams)` | `did`, `count?` | |
| `publish` | `(params: PublishParams)` — already a params object | `payload` type `string` → `Uint8Array` | client standard-Base64-encodes internally; caller stops pre-encoding |

Already params-object or no-arg — **untouched**: `fetchTopic`, `receive`, `keyPackageStatus`,
`registerWake`, `unregisterWake`.

The `publish.payload` change moves **standard Base64** encoding from the caller into
`HubClient.publish` itself, using `toB64` from `@sozai/codec` (already a `hub-client` dependency,
`hub-client/package.json:41`). This preserves identical on-wire bytes: the wire schema declares
standard Base64 (`hub-protocol/src/protocol.ts:35`) and the server decodes with `fromB64`
(`hub-server/src/handlers.ts:392`), so `toB64U` is **wrong** — its `-`/`_` alphabet would typecheck
and then fail `fromB64` at runtime. `@kumiai/hub-protocol` exports no payload encoder
(`hub-protocol/src/index.ts:7`); `toB64` is what today's callers already use. `HubClient`'s callers
in `src` are few; most `publish` call sites are tests. Note the rpc/hub-tunnel `.publish` calls
(`peer.ts`, `transport.ts`, `directed.ts`, `hub-mux.ts`) go through the hub-tunnel `LogHub`/
`MailboxHub` port (`HubPublishParams`, already `Uint8Array` via `encodeFrame`) — a **different**
surface, out of scope here.

### Out of scope

- The other open hub-* milestone items (`deduped` port half, flat `HubRateLimits`, `urn:enkaku:`
  `$id`s) — independent, take their own PRs.
- The hub-tunnel `LogHub`/`MailboxHub`/`HubBase` port and its `HubPublishParams`.
- Any behavioral change to storage semantics, retention, head/CAS, or wire schemas. Wire schemas
  are untouched — this is a TypeScript-signature reshape on top of the same wire.

## Considered and rejected

- **Method overloads (accept both positional and params).** Keeps old callers compiling, but leaves
  the port permanently ambiguous for implementors and doubles, and the milestone's cost (breaking
  every implementor) is paid the moment an implementor must satisfy both shapes anyway. Defeats the
  uniformity goal.
- **Deprecate-and-add (new params methods beside the old).** Doubles the surface, and pre-1.0 there
  is no deprecation audience to protect. A clean break is cheaper now than carrying both to 1.0.

## Blast radius

All within the hub-* cluster plus mls-hub tests — no cross-repo, single PR.

| Site | Change |
|---|---|
| `hub-protocol/src/types.ts` | 7 `HubStore` sigs + 7 new param types |
| `hub-protocol/src/index.ts` | export the 7 new `HubStore` param types from the barrel (`:25`) |
| `hub-server/src/memoryStore.ts` | 7 impl defs (the only real `HubStore`) |
| `hub-server/src/handlers.ts` | 9 internal `store.*` call sites (`:458,557,822,825,886,913,920,957,958`) |
| `hub-conformance/src/index.ts` | ~35 `HubStore` call sites — **the contract** |
| `hub-client/src/client.ts` | 5 method sigs + `publish` payload type + internal `toB64` encode |
| `hub-client/src/index.ts` | export new client param types; drop the obsolete `SubscribeOptions` export (`:3`) |
| `hub-client/README.md` | update positional `subscribe` example (`:23`) and the caller-side `toB64` pre-encode guidance (`:24,:35`) to the params-object + raw-`Uint8Array` API |
| `mls-hub/src/pool.ts`, `mls-hub/src/provisioner.ts` | client call sites (`uploadKeyPackages`, `uploadLastResortKeyPackage`) |
| `hub-server/test/*`, `mls-hub/test/*`, `hub-client/test/*` | call sites + Proxy-based fault injectors typed `keyof HubStore` (`failingStore`) |

## Testing

Per AGENTS.md, a port change runs the contract suite against the real implementation. For `HubStore`
that suite (`@kumiai/hub-conformance`) is registered against exactly one implementation,
`createMemoryStore` (`hub-server/test/conformance.test.ts:10`) — there are **no** conformance
doubles for this port. The Proxy-based stores in `hub-server/test/*` are fault-injection regression
tests, deliberately *not* offered to the suite (`handlers-store-errors.test.ts:51`); they must still
be migrated to the new signatures, but they are not "doubles" in the contract-suite sense.

Regression gates:

1. `@kumiai/hub-conformance` green against `createMemoryStore` (the real impl).
2. Both contract suites run (per AGENTS.md, any port change).
3. Repo-wide `turbo run test:types` — a breaking type change must be verified repo-wide; a consumer
   package can hide un-migrated sites a per-package `--filter` misses.

TDD order per surface:

1. Reshape the `hub-conformance` call sites first (they *are* the contract) and watch them fail to
   typecheck / run against the un-reshaped port.
2. Reshape `HubStore` type + `hub-protocol` barrel → `memoryStore` impl → `handlers.ts` callers
   until the suite is green.
3. Reshape `HubClient` methods + `publish` payload (`toB64`) + `hub-client` barrel; update mls-hub
   src callers, the README, and all tests.
4. Run the regression gates above.

## Milestone bookkeeping

On completion, mark the two entries taken in
[`milestones/pre-1.0-breaking-api.md`](milestones/pre-1.0-breaking-api.md) with the completion-doc
link, and record the premise correction (four → seven positional methods) inline, per the milestone's
own convention of noting corrections where they were found.
