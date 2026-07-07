# Fix the hub `receive` lifecycle

**Priority:** 4 — duplicate/unordered delivery, leaked handlers, swallowed writes.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### High (correctness)

- **`packages/hub-server/src/handlers.ts:160-187` — duplicate/unordered delivery.** The
  live-delivery writer is registered *before* the backlog drain, so a message published
  during `store.fetch` paging is delivered twice with no dedup, and can interleave out of
  order. Fix: drain first, then attach the live writer with a cursor/high-water-mark
  handoff (or dedup by sequenceID at write time).
- **`packages/hub-server/src/handlers.ts:211-223` — pre-aborted signal leaks the
  handler.** Resolution relies solely on an `'abort'` listener; if `ctx.signal` is already
  aborted when the drain finishes, cleanup never runs and the promise, writer, and
  registry entry leak forever. Fix: check `ctx.signal.aborted` before `addEventListener`.
- **`packages/hub-server/src/handlers.ts:118-121,161-168` — fan-out errors swallowed, no
  backpressure.** `sendMessage` does `writer.write(...).catch(() => {})`, so a slow or
  broken receiver accumulates unbounded writes and keeps receiving forever. Fix: track
  `desiredSize`/write completion; clear the receive writer (fall back to
  store-and-forward) on saturation or rejection.

### Medium (same code paths, fold in)

- `packages/hub-server/src/handlers.ts:197-209` — the detached ack-loop's
  `catch { /* Channel closed */ }` conflates `store.ack` failures with channel closure and
  exits, silently dropping all subsequent acks. Fix: catch `store.ack` errors inside the
  loop; only treat reader errors as close.
- `packages/hub-server/src/memoryStore.ts:152-158` — `fetch` resolves the `after` cursor
  via `indexOf`; if the cursor message was acked/purged the index is `-1` and the fetch
  restarts from 0, redelivering the whole backlog. Fix: sequenceIDs are monotonic — select
  `sequenceID > after`.
- `packages/hub-server/src/handlers.ts:111` — `fromB64(payload)` on client input unguarded
  (JSON Schema `contentEncoding` is annotation-only); invalid base64 throws a raw decode
  error instead of a typed `HandlerError`. Fix: wrap and rethrow with a validation code.

## Scope

`@kumiai/hub-server` (`handlers.ts`, `memoryStore.ts`).

## Test hooks

`hub/receive` `after` cursor, multi-page backlog drain (>50 messages), abort-cleanup,
publish-during-drain window — see `next/2026-07-07-test-gaps.md`.
