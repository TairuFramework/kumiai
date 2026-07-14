# Question 5.4 — report

Branch `feat/control-ledger-lane`, tree based on `1347e68`. Scope kept to `packages/hub-tunnel`,
`packages/hub-server`, and the `packages/hub-protocol` contract they touch. No `packages/rpc` or
`packages/mls` source changed (verified: `git diff --stat` on `rpc/src` and `mls/src` is empty).

## Important 1 — `wrapHub` silently drops `retain` / `expectedHead` / `publishID`

**Decision: the tunnel is mailbox-only by design, so the fix is type-level — the fields do not exist
to forward.**

Rationale. `createHubTunnelTransport` (the only consumer `wrapHub` feeds) publishes session frames
with `{ senderDID, topicID, payload }` and nothing else — app-class traffic that is never CAS'd
against a log head. The other `MailboxHub` fronts in the stack (the directed tunnel, the session
hub, the encrypting wrapper) are the same. So a conditional publish should not be *expressible*
through a mailbox lane in the first place, and "make `wrapHub` forward the fields" is the
wrong-but-passing trap the brief flags: it keeps a degradation path alive that should not exist.

Implementation (`packages/hub-tunnel/src/transport.ts`):

- Added `MailboxPublishParams = { senderDID; topicID; payload }` (exported from the package index).
- `MailboxHub.publish` now takes `MailboxPublishParams`, so `retain` / `expectedHead` / `publishID`
  are **not accepted** — handing a mailbox lane a conditional publish is now a compile error, not a
  silent unconditional publish.
- `HubPublishParams` is retained as `MailboxPublishParams & { retain?; expectedHead?; publishID? }`
  (the log-capable, CAS-capable shape).
- `LogHub` is redefined as `Omit<MailboxHub, 'publish'> & { publish(HubPublishParams); fetchTopic }`
  — only a `LogHub` can drive the compare-and-set. This is what keeps `rpc/hub-mux.ts` (which calls
  `LogHub.publish` with `expectedHead` / `publishID`) compiling untouched.

`wrapHub` (`packages/hub-tunnel/src/encrypted-transport.ts`) now types its `publish` param as
`MailboxPublishParams` (nothing left to drop) and its `subscribe` forwards the `HubSubscribeOptions`
argument it was previously discarding.

**Structural check.** A throwaway probe importing `MailboxHub` and calling
`hub.publish({ …, expectedHead: null })` fails to compile:
`TS2353: 'expectedHead' does not exist in type 'MailboxPublishParams'`. The failure mode is now a
type error.

Why this did not ripple into rpc: `MailboxPublishParams` and `HubPublishParams` are mutually
assignable at a call boundary (the extra fields are optional), so `hub-mux`'s `mailbox` view
(`publish: p => hub.publish(p)`), `directed-crypto`'s `sealDirectedHub` (still typed with the wide
`HubPublishParams`, which is assignable where the narrow one is expected), and the rpc/hub-tunnel
`FakeHub`/`DurableFakeHub` fixtures (`implements LogHub`, publish typed `HubPublishParams`) all still
typecheck. Build + full test of `rpc` and `mls` are green with no edits.

## Important 2 — a deduped publish is re-fanned-out to every subscriber

`HubStore.publish` now returns `{ sequenceID, deduped: boolean }` (`PublishResult`, exported from
`@kumiai/hub-protocol`). Threaded through:

- `memoryStore.publish`: `deduped: true` on the `publishID`-replay early return, `deduped: false` on
  every genuine append.
- `handlers.ts` `hub/publish`: destructures the result and **skips the live fan-out loop entirely
  when `deduped`** — a replay no longer pushes an already-applied frame (with a sequenceID whose
  delivery row may be acked and gone) to every connected subscriber. The wire response is unchanged
  (`{ sequenceID }`).
- `types.ts`: `HubStore.publish` return type, plus the `PublishParams.publishID` and `PublishResult`
  docs.

**New conformance clause** (`a deduped publish reports deduped, appends nothing, and creates no new
delivery`): asserts the accepted publish reports `deduped: false`; the replay returns the same
`sequenceID` **and** `deduped: true`; the log is unchanged (`appended nothing`); and — the
load-bearing host-visible half the brief insists on — after the subscriber has acked the original,
the replay creates **no new delivery** (`fetch` stays empty). This is what proves the hub does not
re-emit, over and above the sequenceID equality.

**Mutation check.** Forcing `deduped: false` on the replay path turned exactly this new clause red
(`23 pass / 1 fail`) while the other 23 clauses stayed green.

### Blast radius of the return-shape change

Contained to the hub packages, as required:

- `hub-protocol` — `types.ts`, `index.ts` export, and every `store.publish` call site in
  `conformance.ts` (destructured to `sequenceID`).
- `hub-server` — `memoryStore.ts`, `handlers.ts`, and `test/memoryStore.test.ts` call sites.

It does **not** reach `rpc`/`mls`: they consume the client-side `MailboxHub`/`LogHub.publish`
(return `{ sequenceID }`, unchanged) and the wire `hub/publish` response (`{ sequenceID }`,
unchanged), never `HubStore` (server-storage only). `hub-client.publish` is likewise untouched. The
stop condition (ripple into rpc/mls consumers) was not triggered.

## The Minors

1. **`maxRetention` default was `POSITIVE_INFINITY`, unsettable — FIXED (with test).** Added
   `DEFAULT_MAX_RETENTION = 2_592_000` (30 days); `createMemoryStore` defaults to it and
   `options.retention.max` overrides. Stated in the `MemoryStoreRetention.max` contract (finite by
   default; a host wanting no ceiling sets `POSITIVE_INFINITY` explicitly). `createHub` needs no new
   knob — it takes an already-built store, so the store options *are* the seam. New test
   `the default maximum retention is finite…`; mutation-checked (reverting to `POSITIVE_INFINITY`
   turns it red).
2. **Transient zero-subscriber window collapses the retention window to the hub default —
   DOCUMENTED (design, doc-only).** Added the *consequence* to the `HubStore` retention bullet in
   `types.ts`: because the window is a function of the *current* subscribers, a gap where no
   long-retention subscriber is present collapses to the hub default, and a `purge` landing inside
   it removes frames a returning subscriber was entitled to keep; a host that needs a floor a gap
   cannot lower sets the hub default high enough or does not purge such topics. No behaviour change.
3. **`trim` / depth eviction do not emit `purge`, while `purge` does — DECIDED + STATED.** Decision:
   only the age sweep is observable; `trim` and depth eviction stay silent **by design**, because
   both are the synchronous consequence of the caller's own action (the `before` bound it chose, the
   log-class publish it made) — the caller already knows what left. Documented on `HubStoreEvents`.
   No production consumer exists (only a memoryStore test), and that test stays green. No signature
   churn.
4. **`FetchTopicResult` has no `hasMore`/cursor — LEFT (with reason).** A log reader terminates on
   the `(head, oldest)` pair already returned — both stored state that survives a trim; it is caught
   up when the last sequenceID it saw equals `head`, and a fully-trimmed topic reads forward from a
   null `oldest`. Adding `hasMore` would widen the store contract, the wire response, and every host
   + fixture (including the rpc `LogHub` fakes) for a signal `head`/`oldest` already give. Reason
   recorded in the `FetchTopicResult` doc. (The brief marks this one genuinely optional.)
5. **`fetch`'s `after` fell back to index 0 when the cursor entry is gone — FIXED (with test).** It
   *can* mis-serve a live consumer: if a concurrent ack/trim/purge removes the cursored delivery
   between two pages of a drain, `indexOf(after) === -1` restarted the page from the top, re-serving
   frames already handed out and risking a drain that never makes progress. Replaced with a
   forward-only scan for the first pending sequenceID strictly greater than `after` (pending is in
   append order, so this equals `indexOf+1` when the entry survives, and resumes correctly when it
   does not). New test `fetch resumes past a cursor whose delivery is already gone, not from the
   top`; mutation-checked (the original block turns it red).

## Verify output

`rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

- **build**: `Tasks: 7 successful, 7 total` (includes `rpc`/`mls`, no edits).
- **lint**: `biome check --write ./packages ./tests` → `Checked 195 files … No fixes applied.`
- **test**: `Tasks: 27 successful, 27 total`
  - `rpc` 171 passed + 1 skipped (unchanged)
  - `mls` 298 passed (unchanged)
  - `hub-server` 69 passed (was 66: +1 conformance clause, +2 `memoryStore` tests)
  - conformance suite: **24 clauses** (all 23 prior kept green + the new dedup clause)
  - `hub-protocol` 8, `hub-tunnel` 63, `hub-client` 5, `broadcast` 35 — all passed

No commit made.
