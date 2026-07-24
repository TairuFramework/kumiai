# Hub receive lifecycle — complete

**Status:** complete
**Date:** 2026-07-24
**Branch:** `fix/hub-receive-lifecycle`
**Roadmap:** Phase 1 item 3 (see `../roadmap.md`); milestone
`../milestones/2026-07-audit-remediation.md`. Origin: the 2026-07-02 audit finding set
(the `next/2026-07-07-hub-receive-lifecycle.md` doc, now removed — its substance is inlined below).

## Goal

Make the hub push lane deliver each frame **exactly once, in order, with bounded memory and typed
errors** — closing five receive/publish lifecycle findings. This item led Phase 1 because the
retention semantics shipped in `5eb220a` define mailbox reclamation in terms of a delivery path this
work corrects.

## Findings and how each was resolved

The audit named six findings against the pre-topic-based tree; re-verified against HEAD, five were
live and one was already fixed:

- **H1 — duplicate / unordered delivery.** The receive handler bound the live-delivery writer before
  draining the backlog, so a frame published during the drain shipped twice (once via the publish
  fan-out's live push, once from the drain's `store.fetch`) and could arrive out of order; the client
  does no dedup. Resolved with a two-phase delivery state machine (see Design below).
- **H3 — swallowed fan-out writes, no backpressure.** Live writes were `writer.write(...).catch(() => {})`,
  so a slow/broken receiver accumulated unbounded writes and kept receiving. Resolved with a bounded,
  serialized write queue that tears the channel down on saturation or write rejection, falling back to
  store-and-forward.
- **H2 — pre-aborted signal leaked the handler.** Cleanup relied solely on an `'abort'` listener; an
  already-aborted `ctx.signal` never fired it, orphaning the writer/reader/registry entry. Resolved
  with an `if (ctx.signal.aborted) { finish(); return }` guard before the listener registration.
- **M1 — ack loop conflated `store.ack` failure with channel close.** One `catch` wrapped the whole
  loop, so a single `store.ack` throw exited it and silently dropped all later acks. Resolved: only a
  `reader.read()` error closes the loop; a `store.ack` failure is caught inside and the loop continues
  (the frame stays pending and the client re-acks next round).
- **M3 — unguarded `fromB64`.** A malformed base64 payload threw a raw decode error instead of a typed
  error. Resolved with a new Kumiai-namespaced `HUB_INVALID_PAYLOAD` code + `InvalidPayloadError` class
  in `@kumiai/hub-protocol` (a fourth member of the existing `HUB_*` family, with the same
  `hubErrorCodeOf` / `hubErrorFromCode` round-trip), thrown through the existing `rethrowAsHandlerError`
  path in the publish handler.
- **M2 — `fetch` cursor via `indexOf` redelivering the backlog — dropped.** `memoryStore.fetch`
  already scans `sequenceID > after` (the exact proposed fix); no work needed.

## Design decisions

**Two-phase buffer-then-flush delivery (H1).** The receive handler runs the `bindReceiveWriter`
callback through three phases:
- *draining* — live pushes are buffered into `liveBuffer`, not written; the drain writes the backlog
  in order, tracking `lastServed` = the highest sequenceID written.
- *flush* — buffered frames with `sequenceID > lastServed` are written in order (frames `<= lastServed`
  were already served by the drain — this comparison **is** the dedup); the phase flips to *live* only
  when `liveBuffer` is observed empty in the **same synchronous step** as the flip (no `await` between
  the empty check and the assignment).
- *live* — the callback writes directly.

**Soundness invariant.** Correctness rests on live-push order equalling sequence order: the store mints
sequenceIDs from a monotonic counter and JS is single-threaded, so the publish fan-out must keep a
**fixed await-depth between minting the sequenceID and calling `sendMessage`**. If a future change
inserts a conditional `await` there, concurrent publishes could reach the callback out of sequence
order and the `> lastServed` flush dedup would silently **drop** a lower-seq frame (not merely reorder
it). A code comment at the fan-out boundary records this.

**Bounded write queue (H3).** All writes serialize through a single `writeChain` (preserving order).
A `receiveBufferLimit` param on `CreateHandlersParams` (default `DEFAULT_RECEIVE_BUFFER_LIMIT = 256`,
which must stay ≥ the 50-frame fetch page) caps queued-but-unflushed frames; the cap is enforced in
**both** the live-phase `pushWrite` and the draining-phase buffer path. Over the cap, or on a write
rejection, an idempotent `finish()` teardown releases the registry writer, unregisters the DID,
cancels the reader, and aborts the writer — frames stay pending in the store and redeliver on the next
connect.

## What was built

- `packages/hub-protocol/src/errors.ts`, `.../index.ts` — `HUB_INVALID_PAYLOAD` + `InvalidPayloadError`
  + round-trip + public export.
- `packages/hub-server/src/handlers.ts` — publish-handler decode guard; full `hub/v1/receive` rewrite
  (state machine, bounded queue, ack-loop isolation, pre-abort guard, `toReceiveFrame` helper);
  `receiveBufferLimit` param + `DEFAULT_RECEIVE_BUFFER_LIMIT` (exported from `index.ts`).
- Tests: `packages/hub-server/test/handlers-receive.test.ts` (new — deterministic gate-driven unit
  tests for ordering/dedup, backpressure, draining-phase cap, ack isolation, pre-abort),
  `packages/hub-server/test/hub.test.ts` (malformed-base64 over the wire; multi-page 60-frame drain),
  `packages/hub-protocol/test/errors.test.ts` (round-trip).

No change to the `HubStore` surface, `memoryStore.ts`, or either conformance suite. No client-side
dedup — the server no longer emits duplicates.

## Review record

Six tasks, each individually reviewed; a whole-branch review at the end. The review process caught two
real correctness defects, both originating in the plan's design rather than transcription, each fixed
with a discriminating regression test:

1. **Critical — drain→live phase-flip stranding.** The flush had an `await writeChain` between clearing
   `liveBuffer` and setting `phase = 'live'`; a frame published into that write window was buffered while
   still *draining*, then stranded because `liveBuffer` was never read again. Fixed by making the flip a
   synchronous empty-check loop.
2. **Important — unbounded `liveBuffer` during the drain.** The cap lived only in `pushWrite`, which
   buffered frames never reached, so a stalled-but-connected reader (hung `writeChain`) let the drain
   never finish and the buffer grow without bound — re-opening the exact DoS H3 targets. Fixed by
   enforcing the cap in the draining buffer path.

Non-blocking note recorded during review: a genuinely never-resolving write leaves the handler's
returned promise pending (the async body parks at `await writeChain`); this is an artifact of the
synthetic test — a real transport rejects a stalled write, unblocking the drain into its `catch`.
Memory is bounded regardless, because the cap fires before any accumulation.

## Verification

Full hub stack, fresh (no turbo cache): hub-server 96, hub-protocol 9, hub-client 5, hub-tunnel 77 —
all pass; both conformance suites green (store surface unchanged); tsc + biome clean.
