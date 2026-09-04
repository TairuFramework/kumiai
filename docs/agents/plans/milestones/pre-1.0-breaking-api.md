# Milestone: pre-1.0 breaking API surface

**Origin:** four parallel API-surface audits over all ten packages that existed then, 2026-07-20,
run ahead of
`../completed/2026-07-21-forward-compatibility.complete.md`. That work took only the items where
deferring makes the later fix *impossible* rather than merely expensive; this milestone tracks what
it left, filed at the 2026-07-23 triage into the per-package backlog docs.

Line numbers here and in the linked docs reference `5eb220a`. Every structural claim below was
re-verified against the source on 2026-07-23; the corrections that pass produced are noted inline
and in the linked docs.

## What this milestone is for

Every item indexed here costs a **breaking change** whenever it is finally taken. Every package in
this repo is 0.x today, so that cost is a `minor` bump. After 1.0 the identical change costs a
`major`.

That is the whole deadline, and it is the only reason these are grouped: not urgency, not severity.
**None of these is a correctness bug.** Each is a shape a filed consumer would force a break to fix,
and none has one yet.

## The standing ruling this milestone sits under

> Do not pile up breaking changes with every follow-up doc; address necessary changes as they are
> discovered.

That ruling is why these were deferred rather than taken in July, and it still holds. This milestone
does **not** say "do all of these". It says: whichever of them are still open when 1.0 approaches,
that release is the last cheap chance, and the choice to carry one past it should be deliberate
rather than accidental.

The practical consequence for anyone touching one of these packages: if you are already breaking
that package's surface for a filed reason, check this list for a neighbour worth taking in the same
`minor`. Bundling is nearly free; a second break later is not.

## Index

### `@kumiai/mls` — [mls API hardening](../backlog/2026-07-07-mls-api-hardening.md)

- A third `GroupPermission` — widening a union consumers exhaustively `switch` over
  (`packages/mls/src/roster.ts:7`, exactly `'admin' | 'member'`).
- ~~AAD on `GroupHandle.encrypt`/`decrypt` — **blocks** the rpc-side AAD binding; this is the change
  that must come first.~~ *Taken 2026-09-03:* AAD threaded through `encrypt`/`decrypt` and the rpc
  `GroupCrypto` port, each app frame bound to its topicID, in the same `minor` — see
  `../completed/2026-09-02-mls-encrypt-aad.complete.md`.

*Taken 2026-08-02:* the dead `GroupSyncScope` export, deleted ahead of the 0.5 band release — see
`../completed/2026-08-02-trim-dead-api-surface.complete.md`.

### `@kumiai/hub-*` — [hub protocol/server cleanup](../backlog/2026-07-07-hub-protocol-server-cleanup.md)

- `HubStore`'s **four** positional methods — `unsubscribe`, `getSubscribers`, `storeKeyPackage`,
  `fetchKeyPackages`. Reshaping breaks every implementor *and* every conformance double.

  **The cheap moment passed (noted 2026-07-28).** This item said to take the reshape with
  `hub-keypackage-subscribe-caps`, which touches the two key-package methods anyway. That work
  [shipped 2026-07-25](../completed/2026-07-25-hub-keypackage-subscribe-caps.complete.md) and did
  not take it — `storeKeyPackage` in fact *gained* a positional `notAfter` parameter
  (`hub-protocol/src/types.ts:235`) rather than moving to a params object. The item stands; the
  argument for when to take it does not. The next work to open `HubStore` is the new moment.
- `deduped` surfaced end-to-end. Three layers, and only one of them is breaking: the store computes
  `deduped` (`types.ts:77`), the wire schema drops it (`protocol.ts:31-38`), and `LogHub.publish`
  (`hub-tunnel/src/transport.ts:139`) is typed narrower than `HubStore.publish`. The **wire** half is
  additive by the repo's own rule — `protocol.ts:3-8` requires a new versioned procedure rather than
  widening a sealed schema. The **port** half is what breaks: widening the return type is fine for
  callers but forces every implementor and double to supply the field.
- Flat `HubRateLimits` — no home for a per-action limit matching `AuthorizeRequest`'s six actions.
- `HubClient.publish`'s pre-base64 `payload: string` — accepting `Uint8Array` is the break.
- The `urn:enkaku:` schema `$id`s — an unsettled identifier scheme that also names `enkaku` for
  types now living in kumiai.

*Taken 2026-08-02:* `hub-client`'s `rawClient` getter, removed ahead of the 0.5 band release — see
`../completed/2026-08-02-trim-dead-api-surface.complete.md`.

*Dropped from this milestone 2026-08-02:* `KeyPackageFetchLimits` → `KeyPackageLimits`. **The
premise was false.** The entry claimed the type "sits beside upload-side limits its name excludes",
carried over from the 2026-07-28 note. It does not. All four fields are fetch-side — `maxCount`,
`maxRequests`, `maxPerTargetConsumed`, `windowMs` (`hub-server/src/handlers.ts:168`) — and every
read of them is on the fetch path (`handlers.ts:271-321`). The upload side is limited by three
things none of which touch this type: the `authorize` hook, the generic per-DID limiter from
`HubRateLimits.perDID` (`handlers.ts:712`), and the store's own per-DID cap. `KeyPackageFetchLimits`
names exactly what it holds; `KeyPackageLimits` would name more. If upload-side limits are ever
folded into one config type, the rename comes with that work and is motivated by it — refile then.

*Dropped from this milestone 2026-07-23:* "hub port types moving out of `hub-tunnel`" was listed
here pending a structural check. The check found the premise false — `@kumiai/hub-protocol` declares
none of `HubBase`/`MailboxHub`/`LogHub`/`HubReceiveSubscription`/`HubPublishParams`, so there is
nowhere to move them to, and hub-tunnel is already their shared home (`@kumiai/rpc` imports them
from it). The three data types the two packages genuinely share are structurally identical. Details
in the linked doc; the one real defect the check turned up is folded into the `deduped` item above.

### `@kumiai/rpc` — [rpc API surface](../backlog/rpc-api-surface.md)

- ~~`ProtocolSurface` ignores its own type parameter (`peer.ts:254-258`) — `prc: string`,
  `prm?: unknown`, `Promise<unknown>`. The largest single item on this milestone, and the one least
  doable after 1.0.~~ *Taken 2026-09-04:* `ProtocolSurface` is now typed against the protocol's
  procedure map — `dispatch`/`request`/`gather` take an enkaku-style config object keyed off the
  concrete protocol, and the `GroupPeer`/`GroupPeerParams` `Protocols` bound tightens to
  `GroupProtocolDefinition`. See
  [../completed/2026-09-04-rpc-protocol-surface-typing.complete.md](../completed/2026-09-04-rpc-protocol-surface-typing.complete.md).
- `open-once`/`directed` still typed against the optional-sender `UnwrapResult`
  (`open-once.ts:15`, `directed.ts:35`) — has a runtime guard under it already, so it is
  type-safety debt rather than a live gap.
- `GroupMLS.rosterDIDs` carries no leaf identity (`rpc/src/crypto.ts:240`). **Refiled from mls
  2026-07-23** — `@kumiai/mls` has no such method; it is `@kumiai/rpc`'s consumer port, so the
  change also hits `@kumiai/mls-rpc` and the `@kumiai/rpc-conformance` contract suite.
- **Bus control-frame `kind` discriminator shares the app-data namespace** (spans `@kumiai/broadcast`
  + `@kumiai/rpc`). **Filed 2026-07-24** from the `fix/anycast-soundness` whole-branch review (see
  `../completed/2026-07-24-anycast-soundness.complete.md`). On the bus, req/res
  control messages ride as `typ:'event'` frames told apart from app events by inspecting `data.kind`
  (`packages/broadcast/src/responder.ts`; the `ReplyData`/`RequestData` shapes in `client.ts`). An app
  event whose `data` legitimately carries a top-level `kind` valued `'req'`/`'res'` — reachable
  whenever the procedure's `data` schema is permissive — is dropped by the live responder as a
  control frame, so the discriminator is an in-band signal colliding with app data. The structural
  fix reserves it out of app reach: a distinct `typ` for control messages, or a `ctrl` envelope
  separate from `payload.data`. That is a **wire-format break** (and touches every bus producer and
  consumer). Interim same-door consistency — the drain drops control-shaped payloads exactly as live
  push does — shipped on `fix/anycast-soundness` (2026-07-24); the envelope is the real fix, and it
  makes that interim drop-classification deletable. Not a correctness bug once live and drain agree:
  the only symptom is that an app cannot use `kind: 'req'|'res'` as an event-data key.

### `@kumiai/mls-hub` — audited 2026-08-02, nothing carried forward

**Was** the one package no audit had read for shape, having postdated the 2026-07-20 sweep. Read in
full ahead of its first publish, since the 0.5 band release is what makes its surface public and
every reshape free until then. Four findings, all settled — none is open, and none is deferred to
1.0.

- **The two storage ports were silently interchangeable.** `LastResortRecord` was `KeyPackageRecord`
  plus `uploadedAt`, so method bivariance made `LastResortStore` assignable to
  `KeyPackagePoolStore`: a host wiring one store to both got a diagnostic on one half and silence on
  the other. The defaults contained the consequence by an exact tie rather than by design — an
  ordinary package lives 30 days, the default `rotateWithinDays` is also 30, and the gate is
  strictly greater — so any value from 1 to 29 admitted a single-use package into the reusable
  last-resort slot. Fixed by a `kind` discriminant on both record types plus a re-check on every
  store read, `fix/mls-hub-record-kind`. Breaking for a store adapter, which is why it had to land
  before the first publish rather than after.
- **`AsyncResult` does not carry the `HubRefusedError` that throws through it.** Settled as
  deliberate, not deferred. The throw is what reaches a host that wrote no handler, and TypeScript
  cannot express it in a return type; `@throws` tags carry the warning to the call site. This is the
  `AsyncResult` question the entry used to flag as most likely to want revisiting — it was revisited
  and kept. Independent of [stack-wide `Result`
  adoption](../backlog/2026-07-28-stack-wide-result-adoption.md), which is about which packages
  return `Result` at all, not about this split.
- **Withdrawn:** relocating the in-memory reference stores off the package root. The premise was
  that this repo puts doubles behind a boundary, citing the two conformance packages. Those are
  contract suites, not reference implementations. `@kumiai/hub-server` exports `createMemoryStore`
  from its root (`hub-server/src/index.ts:19`) — same situation, same shape. Nothing to take later.
- **Half withdrawn:** declaring `BundleSource` conformance on `KeyPackagePool` and
  `LastResortProvisioner`. Documented, but not declared and not separately tested: drift is already
  caught by the join tests that pass each as a source, and a `B & {...}` intersection would not
  error on an incompatible member the way `interface extends` does.

Clean on everything else read: internals stay internal, error messages name refs and never key
material, and the publish metadata is correct. **Coverage limit:** the package's test suite was not
read, so nothing above is a claim about its coverage.

### Adjacent, tracked elsewhere

- `to()` gaining `withReady` ([high-severity
  correctness](../completed/2026-07-24-high-severity-correctness.complete.md), **shipped 2026-07-24**)
  changed a sync method to `Promise`-returning — a break landed as a correctness fix (minor at 0.x).
  The `ProtocolSurface` retyping it opens the door to is still worth bundling if it lands soon.

## Sequencing

None of these blocks another, with one exception: the mls AAD parameter must land before
`@kumiai/rpc` can bind its sealed bytes to a topic/segment context.

Otherwise sequence by package, not by this milestone — each linked doc is roughly one PR, and a
breaking change is cheapest when it rides along with work already opening that package's surface.

## Exit criteria

Before the first 1.0 release in this repo: every item above is either taken, or explicitly recorded
as carried past 1.0 with the reason. An item silently still open at 1.0 is the failure this
milestone exists to prevent.
