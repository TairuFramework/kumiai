# Anycast soundness — complete

**Status:** complete
**Date:** 2026-07-24
**Branch:** `fix/anycast-soundness` (PR #11)
**Roadmap:** Phase 1 item 4 (see `../roadmap.md`); milestone
`../milestones/2026-07-audit-remediation.md`. Origin: the 2026-07-02 audit (`bb343d9`), the
`next/2026-07-07-anycast-soundness.md` doc, now removed — its substance is inlined below. The
authenticated-reply-identity half of the original finding shipped earlier on `feat/app-lane-delivery`
(`a85c0fa`); this work closed the rest.

## Goal

Make suppressible anycast **sound**: a responder that fails must not silence the ones that would
succeed. Fold in the medium findings on the same code paths (the duplicated bus responder, unvalidated
bus-lane input, a dead cancellation signal), and adopt `@sozai/event`'s `EventEmitter` where the code
hand-rolled listener fan-out.

## Findings and how each was resolved

- **High — error replies suppressed healthy responders.** Suppressible anycast collapses a storm of
  responders to one reply by having a responder that observes another's reply stop replying. The
  suppression fired on **any** observed reply, errors included, so one fast *failing* responder
  suppressed every healthy one and the client timed out — the group looked dead when one member was
  broken. Resolved by gating both mark-replied sites (a responder's own reply, and an observed peer
  reply) on `err == null`. First-writer-wins on the suppress timer is preserved, so a late success
  still registers after an early error.

- **Medium — the bus responder was duplicated.** `@kumiai/rpc`'s `createGroupBusServer`
  re-implemented ~70 lines of `@kumiai/broadcast`'s `createBroadcastResponder` (jitter, suppression,
  reply shape) and carried the same suppression bug. Resolved by deleting `bus-server.ts` entirely and
  extending the broadcast responder to be a superset: it gained an optional `@sozai/event`
  `EventEmitter` for fire-and-forget event fan-out and a dispose-aborted `AbortSignal` in the handler
  context, and renamed `handlers` → `requestHandlers`. `peer.ts` now builds `createBroadcastResponder`
  directly. Net ~452 lines removed vs ~133 added; the suppression logic lives in exactly one place.
  Hardening caught in review: a malformed control frame (a `req`/`res` shape with an invalid `rid`) is
  dropped rather than forwarded to event listeners, and a handler that resolves on abort after dispose
  no longer registers a stray suppress timer or writes on a tearing-down transport.

- **Medium — bus-lane input was unvalidated.** Requests and events reached host handlers with no
  check against the protocol's declared JSON schemas (the directed inbox server does validate).
  Resolved in `adaptBusHandlers` with per-procedure `@sozai/schema` validators: an invalid request
  rejects — surfacing as an error reply, which (per the High fix) does not suppress healthy
  responders — and an invalid event is dropped and logged under `['kumiai', 'rpc']`.

- **Medium — `ctx.signal` never fired.** Bus handlers received a fresh `AbortController().signal`
  that nothing aborted. Resolved by making it the responder's real signal: the responder owns a set of
  in-flight controllers and aborts them on dispose (epoch teardown, the one genuine cancellation
  source — suppression fires before the handler runs, so it is deliberately not a cancel source).

## Key design decisions (preserved from the spec)

- **Same door.** Validation and adaptation live inside the `EventEmitter` listeners that
  `adaptBusHandlers` registers, so a live-pushed frame and a retained frame replayed by the app-lane
  drain reach host handlers by identical code. The drain and the live bus use separate emitter
  instances (the drain built once, the live one per epoch) so a per-epoch responder's disposal cannot
  strip the drain's listeners.

- **Emitter exposure.** An emitter that is a public subscription surface is exposed through a
  `get events(): EventEmitter<…>` accessor over a private field; an emitter that is internal plumbing
  stays a passed value with no accessor. The bus emitter is plumbing (passed from `adaptBusHandlers`
  into the responder and drain). `@kumiai/hub-tunnel`'s `MailboxHub` connection events are a public
  surface, so they became `EventEmitter<{ status: MailboxHubEvent }>` behind a `get events()` getter
  (single-key because the sole consumer switches on `event.type`); `HubBase.events` is now `readonly`,
  and the encrypting wrapper forwards the emitter inside its object literal.

- **`@sozai/event` usage is contextual, not uniform.** The drain `await`s `emit()` inside a
  try/catch (it must deliver-then-consume and swallow a throwing host handler); the live responder
  uses `void emit().catch(() => {})` (fire-and-forget); the hub fixture uses `fire()` (a `0.1.2` API
  that swallows and logs, avoiding the unhandled rejection a bare `void emit()` would produce). This
  drove a catalog bump to `@sozai/event ^0.1.2`.

## Known follow-on (not a regression here)

The bus tells control messages (req/res) apart from app events by inspecting `data.kind` — an in-band
discriminator that shares the app-data namespace, so an app event whose `data` legitimately carries a
top-level `kind` valued `'req'`/`'res'` collides with it. This branch made live push and drain
**agree** (both drop such payloads), closing the same-door divergence a whole-branch review found. The
structural fix — reserving the discriminator out of app reach (a distinct `typ` or a `ctrl` envelope)
— is a wire-format break, filed under `@kumiai/rpc` in `../milestones/pre-1.0-breaking-api.md`.

## Testing

New/updated across `@kumiai/broadcast`, `@kumiai/rpc`, `@kumiai/hub-tunnel`: a mixed error/success
anycast test (the gap the audit named — a fast erroring responder plus a slower succeeding one, the
client must get the success); observed-error-does-not-suppress; event dispatch through the emitter on
both the live and drain paths; invalid request → error reply and invalid event → dropped;
signal-aborts-on-dispose; the `MailboxHub` `on('status', …)` transitions with the reconnect wiring
intact; and the two contract suites (`rpc-conformance`, `hub-conformance`) against the real
implementation **and** the doubles.

Verification (uncached): broadcast 54, rpc 372 (incl. both conformance suites, real ports and
doubles), hub-tunnel 78, mls-rpc 48; `build:types` 10/10; biome clean. CI (PR #11) green on Node 24 /
Node 26 build-test and both E2E jobs.

## Process note

Executed subagent-driven: each of five tasks gated by a spec+quality review, then an opus
whole-branch review. Two Important findings surfaced and were fixed with regression tests (malformed
control frames leaking to the event lane; a post-dispose stray timer/write), plus the same-door
divergence above. All resolved and re-reviewed clean before merge.
