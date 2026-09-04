# Directed-lane sender attribution (`iss`) — complete

**Status:** complete
**Completed:** 2026-09-04
**Package (patch, non-breaking, additive):** `@kumiai/rpc`

The directed 1:1 inbox lane now threads the MLS-recovered caller DID into each handler's
`message.payload.iss`, matching what the broadcast lane already exposes. Filed from the Kubun
workflow control-plane spike (Q1.1), which observed a directed handler reading `iss` as `undefined`.
Builds on the directed-inbox isolation shipped 2026-09-03
([per-protocol inbox](./2026-09-03-per-protocol-inbox.complete.md)).

## Goal

Symmetric attribution across both lanes: a handler reads the same `message.payload.iss` (the
authenticated sender) regardless of whether the broadcast or directed lane served it. Broadcast
injects it via `adaptBusHandlers`; the directed lane served handlers through a raw `@enkaku/server`
`Server` and never threaded the sender it had already authenticated, so directed attribution was
blind. This blocked per-command audit and any future per-DID command policy on the directed lane.

## Key design decisions (preserved)

- **The sender rides the frame HEADER, never the call payload.** enkaku validates the call payload
  against a closed schema (`additionalProperties: false`; `iss` is legal only on a *signed* message,
  and directed frames are unsigned), so an `iss` written onto the payload is rejected as
  `INVALID_MESSAGE` before any handler runs — this was the first attempt, and it broke every directed
  request. The unsigned *header* schema (`@kokuin/token` `unsignedHeaderSchema`) is
  `additionalProperties: true`, so a stamped header field survives AJV validation (no
  `removeAdditional`) and reaches the handler context. The acceptor stamps the recovered sender into
  `frame.body.header` under the reserved key `kumiai/senderDID`, re-encodes, and feeds the frame; a
  single wrapper on the shared `Server` copies that header field into the handler context's
  `message.payload.iss`. The value is injected into the CONTEXT, never surfaced on the wire payload.

- **One shared Server, not one per session.** A per-session `Server` (each carrying its session's
  constant sender) was implemented and passed tests, but two independent blind reviews found it
  regressed resource safety: enkaku builds a resource limiter *per* `Server` (not injectable — the
  public API takes only a `limits` config), so per-session Servers turn the collective
  100-handler / 10k-controller cap into `sessions × cap`, letting an authenticated member bypass
  backpressure by opening many session IDs; and a `session-end` frame's fire-and-forget
  `server.dispose()` was never drained on teardown. The shared Server restores enkaku's collective
  limiter and lets acceptor `dispose()` drain in-flight handlers. Because the sender is read
  per-frame from the header, one shared Server attributes each frame independently — no per-session
  Server needed for correctness.

- **Un-spoofable by overwrite.** The header field is caller-writable on the wire (the header schema
  is open), so the acceptor overwrites it unconditionally with the MLS-recovered sender before the
  frame reaches enkaku; the acceptor is the authority on who sent the frame. The overwrite order is
  the security invariant. The splice-drop (sender mismatch on an established session) runs *before*
  re-encoding, so a hostile spliced frame is dropped without serialization cost.

- **`kumiai/` header namespace reserved.** The stamp key is namespaced and documented as
  acceptor-reserved (overwritten on every inbound directed frame), so a host must not use it for its
  own metadata. It travels inbound only — replies build a fresh header, so it never echoes outward or
  into hub-visible metadata.

- **Runtime-only; no compile-time lane distinction.** enkaku's handler-context type still carries no
  `iss` field, exactly as on the broadcast lane. Adding a type-level signal distinguishing the lanes
  would be a breaking change to the shared handler-context type — out of scope; the symmetric runtime
  shape is what keeps this change non-breaking and additive.

## What was built

- `@kumiai/rpc` `directed.ts` — `createInboxAcceptor` stamps `kumiai/senderDID` into each inbound
  message frame's header (splice-drop first), keeps one shared `Server`, and wraps its handlers once
  (`withHeaderSenderIss`) to surface the stamped sender as `message.payload.iss`.
- Tests: request attribution; overlapping distinct-sender attribution (both handlers held in flight
  at once, killing a shared-mutable-sender regression); channel attribution + stream round-trip
  (directed is the only lane serving channel/stream, so this guards that threading `iss` preserves
  `writable`/`readable`); caller-forged header overwrite.

## Verification

TDD throughout. Final: `@kumiai/rpc` 453 tests, `test:types` clean, biome clean. Mutation-checks
confirmed to bite (constant/local/first-sender attribution; context-drop; header overwrite order).
Reviewed by two independent blind reviewers and two adversarial Codex passes: the first round found
the per-session-Server resource-limiter multiplication and the unawaited-dispose defect (both fixed
by moving to the shared Server); the second round found the pre-re-encode splice cost, the
undocumented header-name reservation, and a concurrency test gap (all fixed). Final verdict: sound —
overwrite authoritative, survives real schema validation, per-frame, no outbound leak.

## Follow-ups

- **Event-procedure attribution is untested** (minor). The handler wrapper is generic across
  procedure kinds and request + channel are covered (channel being the hardest context, with
  streams); a directed event handler's `iss` is exercised only indirectly. Cheap to add if a directed
  event consumer appears.
- **No compile-time lane signal** — a handler reading `message.payload.iss` on the directed lane must
  annotate the type itself, same as broadcast. A shared handler-context type carrying `iss` would be
  the fix but is breaking; take it only alongside other breaking API work.
