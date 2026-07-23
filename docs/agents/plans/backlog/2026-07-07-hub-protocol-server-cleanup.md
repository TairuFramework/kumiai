# hub protocol/server cleanup

**Priority:** backlog — protocol versioning, shared types, error codes, and API ergonomics
across `@kumiai/hub-protocol`, `@kumiai/hub-client`, `@kumiai/hub-server`. **Scope widened
2026-07-23** to cover `@kumiai/hub-tunnel`'s schema `$id`s, and to record the verification that
retired the "hub-tunnel re-declares the store surface" finding.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### Medium (API / protocol design)

- ~~**`packages/hub-protocol/src/protocol.ts:3-151` — no protocol version anywhere**~~ — **done
  (2026-07-21).** The procedure namespace was versioned (`hub/v1/publish`, `hub/v1/subscribe`, …) by
  `../completed/2026-07-21-forward-compatibility.complete.md`. Kept struck rather than deleted
  because the other findings' line numbers date from before that change.
- ~~**`packages/hub-protocol/src/types.ts:11-15` vs `hub-tunnel/src/transport.ts` vs
  `hub-client/src/client.ts:8-11` — `PublishParams` defined three times** with drifting
  shapes; hub-tunnel's `HubLike` re-declares the store surface. Fix: single home in
  hub-protocol; derive `HubLike`.~~ — **void, verified 2026-07-23.** See below.

  The 2026-07-20 API audits restated this as "hub-tunnel declares `HubBase`/`MailboxHub`/`LogHub`/
  `HubPublishParams` and friends locally rather than importing them from `@kumiai/hub-protocol`".
  Both framings rest on a premise that is false: **`@kumiai/hub-protocol` declares none of those
  types** — not in `types.ts`, not exported from `index.ts`. There is nowhere to move them to.

  They are `@kumiai/hub-tunnel`'s own port, and already the shared one. `@kumiai/rpc` imports
  `LogHub` (`packages/rpc/src/peer.ts:15`), `MailboxHub` (`directed.ts:6`), and
  `HubReceiveSubscription`/`LogHub`/`MailboxHub` (`hub-mux.ts:5-8`) **from `@kumiai/hub-tunnel`**.
  `@kumiai/hub-conformance` re-declares structural subsets deliberately
  (`ConformanceMailboxHub`/`ConformanceLogHub`, `log-hub.ts:41,54`) to avoid a package-graph edge,
  with the reasoning stated at the declaration.

  The two are different ports on opposite sides of the wire, not drifted copies of one:
  `HubStore` is the server-side storage contract (params objects; `fetch`/`ack`/`purge`/`trim`/
  `getSubscribers`/key packages), while `MailboxHub`/`LogHub` is the client-side facade (positional
  `subscribe(subscriberDID, topicID, options?)`, push delivery via `receive()`, `events`).

  Where they genuinely overlap they are **structurally identical**, all three:
  `HubPublishParams` ≡ `PublishParams` (same six fields), `HubFetchTopicParams` ≡
  `FetchTopicParams`, `HubFetchTopicResult` ≡ `FetchTopicResult`.

  Two further details in the original wording are stale: `HubLike` no longer exists — renamed to
  `MailboxHub` in a shipped breaking change (`packages/hub-tunnel/CHANGELOG.md:20`) — and
  `hub-client`'s `PublishParams` differs from the store's for a reason, carrying no `senderDID`
  because the server stamps it from the authenticated caller. The only real drift there is
  `payload: string` vs `Uint8Array`, already tracked as its own item below.

  **One real finding survives**, and it is not a type move — see `LogHub.publish` drops `deduped`
  in the 2026-07-23 section.
- **`packages/hub-client/src/client.ts:8-11,39-43` — `HubClient.publish` takes pre-base64
  `payload: string`,** leaking wire encoding to callers while the rest of the stack uses
  `Uint8Array`. Fix: accept `Uint8Array`, `toB64` internally. (Re-found independently by the
  2026-07-20 API audits; breaking.)

### Low

- `packages/hub-server/src/handlers.ts:125,135,142,224,231,240` — every handler force-cast
  (`as RequestHandler<...>`), suppressing type errors between protocol schema and
  implementation. Fix: type the handlers map as `ProcedureHandlers<HubProtocol>` without
  per-member casts.
- `packages/hub-server/src/handlers.ts:57,93,151` — plain `Error` mixed with
  `HandlerError`; `EK01` doubles for rate-limit and writer-conflict. Fix: `HandlerError`
  with distinct codes throughout.
- `packages/hub-client/src/client.ts:57-65` — `receive()` returns the raw `ChannelCall`;
  correct at-least-once consumption requires hand-crafting `channel.send({ ack: [...] })`.
  Fix: expose an async-iterator wrapper with `ack(sequenceID)`.
- `packages/hub-protocol/src/protocol.ts:88-98` — `hub/receive` push schema omits
  `maxLength` bounds present on request schemas; client-side validation of pushes is
  unbounded. Fix: mirror publish-side bounds.
- `packages/hub-server/src/memoryStore.ts:91-104` — global monotonic `counter` returned as
  `sequenceID` even for dropped publishes leaks hub-wide message volume; caller can't tell
  stored from dropped. Fix: per-topic or randomized sequence IDs and/or a
  `stored: boolean` result. (security)
- `packages/hub-server/src/hub.ts:93` — `server.disposed.then(...)` has no rejection
  handler; the purge `setInterval` is also never `unref`ed. Fix: add `.catch`/`finally`;
  `unref()` where available. (correctness)

## Added 2026-07-23 — deferred forward-compatibility API findings

Folded in from `next/2026-07-20-deferred-api-findings.md` at the 2026-07-23 triage. Origin: the four
API-surface audits of 2026-07-20 that preceded
`../completed/2026-07-21-forward-compatibility.complete.md`. Line numbers are as of `5eb220a`.

Two findings from that batch are **not** repeated here because this doc already carried them — the
hub-tunnel port-type declarations (merged into the `PublishParams`-defined-three-times item above,
and **found void** on verification) and the pre-base64 `payload` (already a Medium item). Everything
below is new. All are **breaking**; see `../milestones/pre-1.0-breaking-api.md`.

- **`HubStore`'s positional methods — four of them, not two.** `packages/hub-protocol/src/types.ts:207`
  (the original finding said `:244` and "every method but two"; both wrong, corrected 2026-07-23 by
  reading the type). Seven methods take a single params object — `publish`, `fetch`, `fetchTopic`,
  `ack`, `purge`, `trim`, `subscribe`. Four stayed positional:

  ```ts
  unsubscribe(subscriberDID: string, topicID: string): Promise<void>
  getSubscribers(topicID: string): Promise<Array<string>>
  storeKeyPackage(ownerDID: string, keyPackage: string): Promise<void>
  fetchKeyPackages(ownerDID: string, count?: number): Promise<Array<string>>
  ```

  Left inconsistent rather than reshaped, since a store-port change has no filed need behind it.
  Reshaping later breaks every implementor *and* every conformance double — and the two key-package
  methods are the ones `../next/2026-07-07-hub-keypackage-subscribe-caps.md` will touch anyway, so
  that work is the cheap moment to take them.
- **`deduped`/`head` absent from the publish wire response.** `HubStore.publish` already returns
  `deduped` (`packages/hub-protocol/src/types.ts:77`, on `PublishResult` at `:66-78` — the original
  finding said `:88`, corrected 2026-07-23), but `hub/v1/publish`'s response schema carries only
  `sequenceID` (`packages/hub-protocol/src/protocol.ts:31-38`). A caller cannot distinguish a
  deduplicated publish from a fresh one, or learn the topic's new head, without a separate
  `fetchTopic` round trip.

  **The wire half is not breaking — the repo already ruled on how to do it.**
  `packages/hub-protocol/src/protocol.ts:3-8` states the discipline outright: "a future shape change
  ships as a new versioned procedure (`hub/v2/publish`, say) — additive in an enkaku protocol —
  never by widening an existing schema. Every `additionalProperties: false` below stays sealed."
  So widening `hub/v1/publish`'s sealed result *would* break older clients' validation, which is
  exactly why that route is closed; the sanctioned route — a new procedure alongside the old — is
  additive. This is a design decision already made, not one this finding gets to reopen.

  **`LogHub.publish` drops it too, and *that* half is breaking** (added 2026-07-23, from verifying
  the port-type finding above). `packages/hub-tunnel/src/transport.ts:139` types `LogHub.publish` as
  `(params: HubPublishParams) => Promise<{ sequenceID: string }>`, strictly narrower than
  `HubStore.publish`'s `Promise<PublishResult>` (`hub-protocol/src/types.ts:66-78`). So the gap is a
  three-layer chain, not a single omission: the **store** computes `deduped`, the **wire schema**
  does not carry it, and the **client facade** cannot surface it.

  Widening the port's return type is backward-compatible for *callers* — they receive a field they
  can ignore — but every *implementor* must now supply it: `hub-mux.ts:501`, `directed.ts:90` and
  `:203` in `@kumiai/rpc`, plus every conformance double. That is the breaking half, and why this
  item stays on the pre-1.0 milestone even though the wire change is additive.

  `MailboxHub.publish` (`transport.ts:126`) has the same return type, but a mailbox lane takes no
  `publishID` and so has nothing to deduplicate against — widening `LogHub` alone is likely right.
  Fix the layers together, or the fix stops at whichever one is left out.
- **`KeyPackageLimits` naming.** `packages/hub-server/src/handlers.ts:72` names its config
  `KeyPackageFetchLimits`, naming only the fetch side. A parallel upload-side config would want a
  sibling name, and renaming an exported type is the break. Premature today since nothing constrains
  uploads — but see `../next/2026-07-07-hub-keypackage-subscribe-caps.md`, which adds exactly that
  upload-side constraint; take the rename with that work rather than separately.
- **`HubRateLimits` is flat.** `packages/hub-server/src/handlers.ts:62` — `{ perDID, perTopic }`. A
  future per-action or per-procedure limit (matching `AuthorizeRequest`'s six actions) has no home
  in the current shape. No filed need for finer-grained limits yet.
- **`hub-client` exposes `rawClient`.** `packages/hub-client/src/client.ts:73` returns the
  underlying `Client<HubProtocol>` through a getter, letting a caller bypass `HubClient`'s typed
  surface — and any authorization or retry logic later layered onto it. An encapsulation gap, not a
  correctness bug; removing the getter is the break.
- **The `urn:enkaku:` schema `$id`s.** `packages/hub-tunnel/src/envelope.ts:14` and `frame.ts:56`
  carry `$id: 'urn:enkaku:hub-tunnel:envelope'` / `'…:frame'`. Whether that is the right identifier
  scheme — versioned, and collision-safe against other enkaku-based protocols outside this repo —
  was never settled. It also names `enkaku` for types that now live in kumiai. Settling it changes
  published identifiers.

## Test hooks

Purge scheduling in `createHub` (`hub.ts:85-94`) untested — see
`next/2026-07-07-test-gaps.md`.
