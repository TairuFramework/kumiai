# Bus control-frame `typ` discriminator — complete

**Status:** complete
**Date:** 2026-09-04
**Branch:** `feat/bus-control-typ`
**Milestone:** the `@kumiai/broadcast` + `@kumiai/rpc` bus-discriminator item in
`../milestones/pre-1.0-breaking-api.md` (now marked taken).
**Origin:** the follow-on filed by `./2026-07-24-anycast-soundness.complete.md` — that branch made
live push and the app-lane drain *agree* on dropping control-shaped app data; this is the structural
fix that removes the collision instead of making both halves live with it.

## Goal

Move broadcast-bus control frames off `typ:'event'`/`data.kind` onto a distinct `typ:'ctrl'`, so an
application event whose `data.kind` is `'req'`/`'res'` is no longer misclassified as a control frame
and dropped. Pre-1.0 breaking wire change (a `minor` at 0.x).

## Problem it fixed

The bus carried three frame kinds all as `typ:'event'`: app events (`data` = app payload), request
control (`data.kind:'req'`), reply control (`data.kind:'res'`). Every classifier told control from app
by peeking `payload.data.kind`. Because `kind` is app-reachable whenever a procedure's `data` schema
is permissive, an app event whose data legitimately carried `kind:'req'|'res'` was silently dropped —
live and (since the anycast-soundness branch) on replay. Not a correctness bug in the stack as it
stood; the only symptom was that an app could not use `kind:'req'|'res'` as an event-data key.

## What was built

- **Wire (v2).** `BROADCAST_VERSION` 1→2. Control frames now `{typ:'ctrl', prc, data:{kind:'req'|'res', …}}`;
  app events unchanged `{typ:'event', prc, data}`. Every classifier switches on `payload.typ`;
  `data.kind` is read only after `typ==='ctrl'`, so it can never collide with app data. `decodeFrame`
  refuses any version it does not speak (the live path).
- **`@kumiai/broadcast`.** `transport.ts`: version bump + write guard widened to `{event, ctrl}`.
  `responder.ts`: inbound loop branches on `typ` (event → emit to the fan-out; ctrl → req/res on inner
  `kind`; anything else drop), reply write moved to `typ:'ctrl'`, and the old malformed-control
  fallthrough deleted as unreachable. `client.ts`: `#read` reads replies from `typ:'ctrl'`+`kind:'res'`,
  request/gather writes moved to `typ:'ctrl'`; `RequestData`/`ReplyData` keep their shape (`kind`
  retained as a sub-discriminator scoped under `ctrl`).
- **`@kumiai/rpc`.** `app-lane.ts`: the interim `data.kind` control-shape drop is deleted; the drain
  now classifies retained frames by `payload.typ === 'event'` only (its `typ` guard and the
  `retentionOf(...) === 'log'` guard are unchanged), so a retained app event whose `data.kind` is
  `'req'`/`'res'` is delivered on replay, matching live push.

## Key design decisions

- **Distinct `typ` over a `ctrl` envelope.** `typ` is already the top-level discriminant every
  classifier switches on, so a distinct control `typ` is the honest shape and frees `payload.data`
  entirely. The inner `kind:'req'|'res'` was retained (rather than collapsed into two `typ` values)
  to keep the change to branch conditions and the writable allow-list, leaving `RequestData`/`ReplyData`
  bodies otherwise intact.
- **No version gate on the drain, deliberately.** The app-lane drain uses raw `JSON.parse`
  (`app-lane.ts`), not `decodeFrame`, and does not inspect `v`. This is a pre-existing property, kept:
  only control frames moved `typ`, and control frames are never retained (see the ruling below), so
  every retained frame is a `typ:'event'` app event whose shape is byte-identical under v1 and v2 — a
  v1 app frame replayed by a v2 drain reads correctly. Adding a drain version gate would reject
  already-persisted, still-valid app history, which the design refuses to do.
- **Bonus hardening.** Keying the responder on `typ` also closed a previously reachable
  suppression-poisoning vector: before the change, an app event whose data was
  `{kind:'res', rid, err:null}` reached `markReplied` and could poison a healthy responder's
  suppression map for a colliding `rid`. Under the `typ==='ctrl'` gate, app data can no longer reach
  `markReplied` at all.

## Final-review ruling (2026-09-04)

A whole-branch review asked whether a **v1 control frame** (which in v1 rode `typ:'event'` with
`data.kind`) could be retained and, under v2, delivered into an app handler — since the live path
refuses v1 at `decodeFrame` while the drain has no version gate. Verified against source and judged
benign in every reachable case, so **not** fixed in code:

- Control frames are never retained, structurally. The broadcast bus publishes control through
  `BroadcastBus.publish(topicID, payload)` (no `retain` parameter) — ephemeral fan-out. Every
  `retain:'log'` publish is a `mux.publish({…, retain:'log'})` carrying app-lane or commit bytes, never
  a bus control frame. So a legitimate v1 control frame cannot be in any log.
- The only control-shaped bytes that can reach the drain are an app event whose *app data* carries
  `kind:'req'|'res'` (the intended, delivered case), or an adversarial member hand-publishing
  control-shaped bytes with `retain:'log'`. In both, the drain only `events.emit`s the payload to an
  app-event listener — no control processing, the `senderDID` is authenticated by `crypto.unwrap`
  (never read from the frame body), no reply/correlation produced. The payload arrives as ordinary app
  data.
- The live/drain asymmetry only ever concerns v1 frames, whose meaning is unchanged for app events;
  there is no reachable mis-delivery. Recorded so that carrying it is deliberate, not accidental.

A second review flag — that the release intent named only `@kumiai/broadcast` and `@kumiai/rpc` rather
than every package — was a false positive: per-PR intents record only their changed packages (the
sibling pending intents do the same), while the every-package band-raise intent is a release-time
artifact.

## Testing

- Regression that pins the fix: an app event whose `data` is `{kind:'req', …}` / `{kind:'res', …}` is
  delivered to event listeners on the live push path (`broadcast/test/responder.test.ts`) and replayed
  by the app-lane drain on the retained path (`rpc/test/peer-app-drain-integrity.test.ts`, inverted
  from its former "not delivered" assertion). A companion test keeps the malformed-drop guarantee at
  the new `typ:'ctrl'`.
- The drain test required binding the wrapped frame's AAD to the topic (`{aad: fromUTF(topicID)}`);
  without it the frame is rejected at the drain's `expectedAAD` check before classification, making the
  test vacuous.
- Verification (uncached): broadcast 67, rpc 453 (incl. both conformance suites, real ports and
  doubles — 111 conformance), hub-tunnel 94, mls-rpc 54; repo-wide `turbo run test:types` 26/26; biome
  clean. Confirmed by both the in-session final review and an independent codex whole-branch pass.

## Changeset

`.changeset/loose-memes-say.md` — `@kumiai/broadcast` and `@kumiai/rpc` at `minor`, describing the wire
break (typ:'ctrl' control frames, `BROADCAST_VERSION` 2, `data.kind` freed, v1 decode refusal, drain
fallback removal).

## Follow-on

- `../backlog/2026-09-04-anycast-suppression-auth.md` — the responder's reply-suppression observe path
  marks-replied on `rid` with no `senderDID` authentication (a pre-existing anycast soundness concern
  surfaced by this branch's final review, not introduced by it).
