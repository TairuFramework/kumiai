# HubStore + HubClient params-object uniformity — complete

**Status:** complete
**Completed:** 2026-09-04
**Packages (minor bump):** `@kumiai/hub-protocol`, `@kumiai/hub-client` (with a band-alignment intent
carrying `@kumiai/hub-server`, `@kumiai/hub-tunnel`, `@kumiai/hub-wake`, `@kumiai/mls-hub`,
`@kumiai/hub-conformance` to the same minor, so all twelve band packages land at `0.9.0` together)
**Milestone discharged:** the `@kumiai/hub-*` "HubStore's positional methods" and "HubClient.publish's
pre-base64 `payload: string`" items of
[pre-1.0 breaking API surface](../milestones/pre-1.0-breaking-api.md).
**PR:** TairuFramework/kumiai#44 (branch `refactor/hubstore-params-objects`).

## Goal

Make both hub surfaces uniform: every non-trivial method on the `HubStore` port and the `HubClient`
wrapper takes exactly one named params object, and `HubClient.publish` accepts raw bytes. Pure
signature/type reshape — no behavioral change and no wire-format change. Uniformity is not cosmetic:
a params object lets any method gain a field later with no further break, and a positional
`notAfter` bolt-on (added to `storeKeyPackage` since the milestone was filed) was precisely the
recurrence this prevents.

## What was built

- **`@kumiai/hub-protocol` — `HubStore` (7 methods):** `unsubscribe`, `getSubscribers`,
  `storeKeyPackage`, `fetchKeyPackages`, `countKeyPackages`, `storeLastResortKeyPackage`,
  `fetchLastResortKeyPackage` each now take a single params object, matching every other `HubStore`
  method. Seven new param types added and exported from the barrel. Return types unchanged;
  doc-comments preserved verbatim.
- **`@kumiai/hub-client` — `HubClient` (5 methods):** `subscribe`, `unsubscribe`,
  `uploadKeyPackages`, `uploadLastResortKeyPackage`, `fetchKeyPackages` each now take a params
  object; the old `SubscribeOptions` is folded into `SubscribeParams`.
- **`HubClient.publish` payload:** changed from a pre-encoded base64 `string` to `Uint8Array`. The
  client encodes internally so callers hand over raw bytes.
- Migrated the reference implementation (`createMemoryStore`), the server handlers, the
  `@kumiai/hub-conformance` contract suite, the mls-hub consumers, the README, and all tests.

## Key design decisions

- **Standard Base64, not base64url, inside `publish`.** The client encodes with `toB64` (standard
  Base64, `+`/`/`, padded) from `@sozai/codec`, never `toB64U`. The wire schema declares
  `contentEncoding: 'base64'` and the server decodes with `fromB64`; `toB64U`'s `-`/`_` alphabet
  would typecheck and then fail `fromB64` at runtime. Moving the callers' existing `toB64` operation
  into `publish` keeps the on-wire bytes byte-for-byte identical.
- **Two `SubscribeParams` are deliberately distinct.** `@kumiai/hub-protocol`'s
  `{ subscriberDID, topicID, retention? }` (the store port) and `@kumiai/hub-client`'s
  `{ topicID, retention? }` (the client surface) are separate module-scoped types, mirroring the
  existing `PublishParams` split between the two packages. The subscriber DID is the authenticated
  identity at the client boundary, never a client-supplied field.
- **The `HubStore` reshape carried no conformance doubles.** The `hub-conformance` suite runs against
  exactly one registered implementation, `createMemoryStore`. The Proxy-based stores in the
  hub-server tests are fault-injection regression tests, not contract doubles; they were migrated to
  the new signatures but are not offered to the suite.
- **In-scope was the whole client surface, not just the filed `publish` break.** The milestone filed
  only `HubClient.publish`'s payload type, but the client's other positional methods were unfiled
  neighbours reshaped in the same branch — one break instead of several later.

## Premise correction

The milestone entry (written against `5eb220a`) listed *four* positional `HubStore` methods. Three
methods (`countKeyPackages`, `storeLastResortKeyPackage`, `fetchLastResortKeyPackage`) and one
positional parameter (`storeKeyPackage`'s `notAfter`) were added between then and now, so the true
count was *seven* — all converted here. The milestone doc records this inline.

## Verification

- Repo-wide `turbo run test:types` and `test:unit`, both contract suites (`hub-conformance`,
  `rpc-conformance`), and lint pass, uncached. The **repo-wide** type gate is load-bearing: it caught
  four residual un-migrated call sites in `tests/integration` that a per-package `--filter` misses —
  a breaking type change must be verified repo-wide.
- Reviewed per-task, whole-branch (independent agent), and independently by Codex. No code defects
  found; Base64 flavour, wire invariance, field-name mappings, runtime-only call shapes, the two
  `SubscribeParams`, docs, and the four→seven history all verified. Codex's one finding — the release
  version band would fail its check because five band members lacked a minor intent — was fixed with
  the `band-align-0-9` intent before the PR.

## Follow-on

None. The remaining open `@kumiai/hub-*` milestone items (`deduped` port half, flat `HubRateLimits`,
`urn:enkaku:` schema `$id`s) are independent and stay in the milestone for their own PRs.
