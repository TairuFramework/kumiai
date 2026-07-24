# Hub `receive` lifecycle — design

**Date:** 2026-07-24
**Branch:** `fix/hub-receive-lifecycle`
**Origin:** roadmap Phase 1 item 3; source doc
`docs/agents/plans/next/2026-07-07-hub-receive-lifecycle.md` (2026-07-02 audit against `bb343d9`).

## Problem

The audit named six findings in the hub `receive`/`publish` lifecycle. Re-verified against HEAD
(the hub was rewritten to topic-based pub/sub since the audit; line numbers and mechanisms drifted):

| # | Finding | HEAD location | Status |
|---|---------|---------------|--------|
| H1 | Duplicate + unordered delivery: live writer bound before backlog drain | `handlers.ts:309` bind, drain `333-349` | live |
| H2 | Pre-aborted signal leaks the handler (no `signal.aborted` check) | `handlers.ts:385` | live |
| H3 | Fan-out writes swallowed (`.catch(() => {})`), no backpressure | `handlers.ts:312-322` + publish `220-233` | live |
| M1 | Ack loop conflates `store.ack` failure with channel close | `handlers.ts:359-371` | live |
| M2 | `fetch` cursor via `indexOf` → `-1` redelivers whole backlog | `memoryStore.ts:291-301` | **already fixed** |
| M3 | Unguarded `fromB64` → raw decode error, not a typed `HandlerError` | `handlers.ts:169` | live |

M2 is dropped: `memoryStore.fetch` already scans `sequenceID > after` (the exact proposed fix). The
remaining five are in `packages/hub-server/src/handlers.ts`, plus one new error code in
`packages/hub-protocol/src/errors.ts` for M3. Single PR. The store surface (`memoryStore.ts`) and
both conformance suites are untouched.

### H1 mechanism at HEAD

The `hub/v1/receive` handler binds the live-delivery writer (`registry.bindReceiveWriter`,
`handlers.ts:309`) **before** draining the backlog (`store.fetch` loop, `333-349`). The bind-first
order is deliberate (comment `326-329`: it avoids a gap where a mailbox frame arriving between drain
and bind would have no writer and be dropped). But while the drain runs, a publish to a subscribed
topic:

1. live-pushes the frame to that same bound writer, via the publish handler's fan-out (`220-233`), **and**
2. leaves the frame pending in the store, so the drain's `store.fetch` serves it too.

The live push never drops the pending delivery, so the frame ships **twice**, and the live copy can
land before older backlog frames (**out of order**). `HubClient.receive()` does no client-side
dedup, so the consumer eats both. The fix must preserve "no gap" while adding "no dup, in order".

## Design

All changes are within `hub/v1/receive`'s handler and the `publish` handler's decode step, in
`handlers.ts`.

### 1. Receive delivery state machine (H1 + H3)

Wrap the `bindReceiveWriter` callback in a three-phase writer:

- **DRAINING** — the callback (invoked by the publish fan-out) **enqueues** live frames into an
  in-memory buffer instead of writing. The drain loop writes the backlog from `store.fetch`,
  tracking `lastServed` = the max `sequenceID` written.
- **FLUSH** — write buffered frames whose `sequenceID > lastServed`, in order. Frames
  `<= lastServed` were already served by the drain, so this comparison **is** the dedup. Loop until
  the buffer is empty, then flip to LIVE.
- **LIVE** — the callback writes directly.

Soundness: live-push order equals sequence order (the store mints from a monotonic counter and JS is
single-threaded), so the buffer stays ordered and the `> lastServed` dedup is exact — a live frame
with `sequenceID <= lastServed` was within the drained range and therefore already served. The
phase flip is a synchronous assignment with no `await` between the empty-buffer check and the flip,
so a concurrently-invoked callback cannot slip a direct write in before the buffer is fully drained.

Any frame that arrives via the callback during FLUSH is appended and picked up by the same flush
loop before the flip.

### 2. Backpressure and teardown (H3)

Both silent `.catch(() => {})` sites are removed. Every write awaits and respects the writer's
`desiredSize`. Track `outstanding writes + buffer length` against a cap.

- **New param:** `receiveBufferLimit` on `CreateHandlersParams`, default **256** frames.
- On **saturation** (count exceeds the cap) **or** a **write rejection** (broken writer), run the
  shared teardown: `releaseReceiveWriter` + `unregisterIfIdle` + `reader.cancel()` +
  `writer.abort()`, and resolve the handler promise. Frames remain pending in the store and
  redeliver when the client reconnects (store-and-forward is the safety net).

The publish handler's fan-out stays fire-and-forget into the callback — it must not block the
publisher on a slow subscriber's delivery. Cap enforcement and teardown live inside the receive
handler's own write path, where the writer and registry token are in scope.

### 3. Pre-aborted signal (H2)

Before registering the abort listener (`~385`):

```ts
if (ctx.signal.aborted) { finish(); return }
ctx.signal.addEventListener('abort', finish, { once: true })
```

Closes the leak where an already-aborted signal never fires `finish`, orphaning the writer, reader,
and registry entry.

### 4. Ack-loop error isolation (M1)

In the detached ack loop (`359-371`), wrap `store.ack` in its own try/catch **inside** the loop:
swallow (or log) the ack error and continue reading. Only a `reader.read()` error breaks the loop
(a genuine channel close). This fixes the conflation where one `store.ack` throw silently drops all
subsequent acks.

### 5. Decode guard (M3)

Add a Kumiai-namespaced code to the existing `HUB_*` family in `hub-protocol/src/errors.ts`,
consistent with the three codes already there (each has a code, an error class, and a
`hubErrorFromCode` round-trip entry):

```ts
// hub-protocol/src/errors.ts
HUB_ERROR_CODES = { ..., invalidPayload: 'HUB_INVALID_PAYLOAD' }
export class InvalidPayloadError extends Error { override name = 'InvalidPayloadError' }
// hubErrorCodeOf / hubErrorFromCode gain the InvalidPayloadError <-> HUB_INVALID_PAYLOAD entry
```

The `HUB_` prefix keeps it Kumiai-namespaced (the enkaku `EK0x` codes are enkaku's — `EK03` is
already `CONTROLLER_LIMIT`) and sidesteps any two-letter scheme entirely.

In the publish handler, `fromB64(payload)` (`169`) — which sits *before* the `store.publish`
try/catch, so it is not yet on any rethrow path — gets its own try/catch that raises
`InvalidPayloadError` and routes it through the existing `rethrowAsHandlerError` helper
(`107-117`). `hubErrorCodeOf` now maps `InvalidPayloadError` to `HUB_INVALID_PAYLOAD`, so the client
receives a typed `HandlerError` with that code instead of a raw decode error. The
decode-before-authorize ordering (deliberate, per comment `159-168`) is unchanged.

## Non-goals

- No change to the `HubStore` surface, `memoryStore.ts`, or either conformance suite. (Both suites
  are rerun as a regression check, not modified.)
- No client-side dedup in `HubClient` — the fix makes the server not emit duplicates, so the client
  need not filter them.
- No enkaku `EK0x` code for M3 — that namespace is enkaku's (`EK03` is already taken).

## Testing

New tests in `packages/hub-server` covering the receive lifecycle:

- **publish-during-drain** — a publish landing mid-drain is delivered exactly once, in order (H1).
- **multi-page backlog** — a backlog larger than the 50-frame `store.fetch` page drains fully and in
  order, with live frames buffered across pages.
- **abort-before-listener** — an already-aborted `ctx.signal` runs cleanup (writer/reader/registry
  released), no leak (H2).
- **saturation** — a stalled writer exceeding `receiveBufferLimit` triggers teardown; the frames
  stay pending and redeliver on a fresh `receive` (H3).
- **ack-failure mid-loop** — a `store.ack` throw does not stop later acks from being applied (M1).
- **malformed base64** — a bad `payload` yields a `HandlerError` with code `HUB_INVALID_PAYLOAD`,
  not a raw decode error (M3).

Regression: rerun `hub-conformance` and `rpc-conformance` against the real implementation and the
doubles (unchanged store surface, so both must stay green).

## Files touched

- `packages/hub-server/src/handlers.ts` — the five handler fixes.
- `packages/hub-protocol/src/errors.ts` — `HUB_INVALID_PAYLOAD` code + `InvalidPayloadError` class +
  round-trip (M3).
- `packages/hub-server/src/*` tests — new lifecycle coverage.
- Source doc `docs/agents/plans/next/2026-07-07-hub-receive-lifecycle.md` moves to `completed/` at
  the completing stage (M2 noted already-fixed, M1/H1 restated per HEAD).
