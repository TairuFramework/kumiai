# Bus control-frame `typ` discriminator — design

**Status:** spec
**Date:** 2026-09-04
**Branch:** `feat/bus-control-typ`
**Milestone:** `../../agents/plans/milestones/pre-1.0-breaking-api.md` (the `@kumiai/broadcast` +
`@kumiai/rpc` bus-discriminator item)
**Origin:** the follow-on filed by `../../agents/plans/completed/2026-07-24-anycast-soundness.complete.md`
— that branch made live push and the app-lane drain *agree* on dropping control-shaped app data; this
is the structural fix that removes the collision instead of making both halves live with it.

## Problem

The broadcast bus carries three logical frame kinds, and today all three ride `typ: 'event'`:

- an app fire-and-forget event — `{ typ: 'event', prc, data }`, where `data` is arbitrary app payload;
- a request control frame — `{ typ: 'event', prc, data: { kind: 'req', rid, prm, gather? } }`;
- a reply control frame — `{ typ: 'event', prc, data: { kind: 'res', rid, ok?, err? } }`.

Every classifier tells control from app by peeking at `payload.data.kind`:

- `packages/broadcast/src/responder.ts` inbound loop — `data?.kind === 'res'` / `=== 'req'`;
- `packages/broadcast/src/client.ts` `#read` — `data?.kind !== 'res'`;
- `packages/rpc/src/app-lane.ts:460-471` drain — drops a retained frame whose `data.kind` is
  `'req'`/`'res'`.

`kind` is app-reachable: whenever a procedure's `data` schema is permissive, an app event whose `data`
legitimately carries a top-level `kind` valued `'req'` or `'res'` is misclassified as a control frame
and silently dropped — live and (since the anycast-soundness branch) on replay. The discriminator is
an in-band signal sharing the application-data namespace.

This is not a correctness bug in the current stack: the only symptom is that an app cannot use
`kind: 'req' | 'res'` as an event-data key. It is filed as a pre-1.0 breaking change because moving
the discriminator off the app-data namespace is a wire-format break, cheapest while every package is
still 0.x.

## Fix: a distinct `typ` for control frames

Control frames move to their own top-level `typ: 'ctrl'`, keeping their existing inner
`kind: 'req' | 'res'` sub-discriminator. App events keep `typ: 'event'`. Classification then keys on
`payload.typ` alone; `payload.data` is app-exclusive, and `data.kind` is read only *after*
`typ === 'ctrl'` has already established the frame is control — so it can never collide with app data.

```
app event:  { typ: 'event', prc, data: { ...arbitrary app data, kind free... } }
request:     { typ: 'ctrl',  prc, data: { kind: 'req', rid, prm, gather? } }
reply:       { typ: 'ctrl',  prc, data: { kind: 'res', rid, ok?, err? } }
```

`typ` is already the top-level discriminant every classifier switches on, so a distinct control `typ`
is the honest shape rather than a second slot layered under a `typ` that no longer means what it says.
The inner `kind` is retained (not collapsed into two `typ` values `req`/`res`) to keep the change to
the classifiers' branch conditions and the writable allow-list, leaving the `RequestData` / `ReplyData`
bodies otherwise intact.

### Wire version

`BROADCAST_VERSION` goes `1 → 2` (`packages/broadcast/src/transport.ts`). The version discriminant
exists for exactly this — reinterpreting or removing a wire field; here `typ` is reinterpreted (control
frames leave the `event` typ) and `data.kind` is removed from the app-data namespace. On the live
transport, `decodeFrame` (`transport.ts:86`) refuses any version it does not speak, so a retained v1
frame reaching a v2 reader over the live path is refused, not best-effort read.

**The app-lane drain does not go through `decodeFrame`.** It calls `JSON.parse` directly
(`app-lane.ts:452-457`) and classifies solely by `payload.typ` (`:459`), never inspecting `v`. This is
a pre-existing gap, not introduced here, and it is *benign for this change*: only control frames move
`typ`, and control frames are never retained (see the drain data-flow below), so every retained frame
is a `typ:'event'` app event whose shape is identical under v1 and v2. A v1 app frame replayed by a v2
drain is therefore read correctly. This design deliberately does **not** add version enforcement to the
drain — doing so would be scope creep and would reject already-persisted, still-valid app history. If
the drain ever needs to refuse a version, that is its own separate change. Acceptable pre-1.0 on
today's in-memory bus and logs either way.

*Ruling (2026-09-04, final-review adjudication).* A whole-branch review raised the mirror case: the
live broadcast path refuses a v1 frame at `decodeFrame`, while the drain (no version gate) would
deliver one — so could a **v1 control frame** (which in v1 rode `typ:'event'` with `data.kind`) be
retained and, under v2, delivered into an app handler? Verified against source and judged benign in
every reachable case, so **not** fixed in code:

- Control frames are never retained, and this is structural, not conventional. The broadcast bus
  publishes control (req/res) through `BroadcastBus.publish(topicID, payload)` (`bus.ts:6`,
  `transport.ts:194`), which has no `retain` parameter — bus traffic is ephemeral fan-out. Every
  `retain:'log'` publish is a `mux.publish({…, retain:'log'})` in `peer.ts` (the app lane `:794`, the
  commit lane), carrying app-lane or commit bytes, never a bus control frame. A legitimate v1 control
  frame therefore cannot be in any log.
- The only control-shaped bytes that can reach the drain are an app event whose *app data* legitimately
  carries `kind:'req'|'res'` (exactly the case this change exists to deliver), or an adversarial member
  hand-publishing control-shaped bytes with `retain:'log'`. In both, the drain only ever `events.emit`s
  the payload to an app-event listener — there is no control processing on the drain, the recovered
  `senderDID` is authenticated by `crypto.unwrap` (never read from the frame body), and no reply or
  correlation is produced. The payload arrives as ordinary app data, which is the same guarantee the
  feature gives every app event.
- Fixing this in code would mean version-gating the drain, which would reject already-persisted valid
  v1 **app** history — the very outcome the paragraph above deliberately avoids. The asymmetry only
  ever concerns v1 frames, whose meaning is unchanged for app events; there is no reachable
  mis-delivery. Recorded here so carrying it is deliberate, not accidental.

## Components touched

### `@kumiai/broadcast`

- **`transport.ts`**
  - `BROADCAST_VERSION` 1→2; update the doc comment to record the `typ`/`data.kind` reinterpretation.
  - Writable guard (`:184`) currently throws unless `typ === 'event'`. Widen to the two-value
    allow-list `{ 'event', 'ctrl' }`; update the error message accordingly. The readable side is
    typ-agnostic and needs no change.
- **`responder.ts`**
  - Inbound loop (`:145`) branches on `payload.typ`: `'event'` → emit to the event fan-out; `'ctrl'` →
    dispatch req / observe res on the inner `kind`; anything else → drop.
  - Reply write (`:135`) changes `typ: 'event'` → `typ: 'ctrl'`.
  - Delete the malformed-control fallthrough (`:164-167`, the `data?.kind === 'req' || 'res'` drop):
    unreachable once a control frame is identified by `typ`, since an app `typ: 'event'` frame is never
    inspected for `kind`.
- **`client.ts`**
  - `#read` (`:65`) reads replies from `typ === 'ctrl'` && `data.kind === 'res'`.
  - Request write (`:123`) and gather write (`:171`) change `typ: 'event'` → `typ: 'ctrl'`.
  - `RequestData` / `ReplyData` keep `kind` — it is now a sub-discriminator scoped under `typ: 'ctrl'`,
    no longer sharing the app-data namespace. Update their doc comments to say so.
  - `dispatch` and `buildEventMessage` are unchanged: app events stay `typ: 'event'`.
- **`event-frame.ts`** — unchanged. It builds app events only.

### `@kumiai/rpc`

- **`app-lane.ts`**
  - Keep the drain's `payload.typ !== 'event'` guard (`:459`) — it already skips the new `typ: 'ctrl'`
    frames.
  - Delete the `data.kind` control-shape drop (`:460-471`): unreachable, since control frames are now
    filtered out by the `typ` guard above before `data` is inspected. This is the interim same-door
    classification the anycast-soundness doc flagged as deletable once the discriminator moved.

### Doubles / conformance

No dedicated bus wire double reimplements the classification: `rpc-conformance` and `hub-conformance`
drive the real `BroadcastClient` / `createBroadcastResponder`, and the memory bus (`bus.ts`) is
byte-opaque to `typ`. Both suites are re-run against real ports and doubles as the regression gate, not
patched.

### Not touched

`packages/rpc/src/directed.ts` reads `payload.typ` (`:533`) against its own frame vocabulary
(`session-open`, `session-end`, request-like typs) on the directed lane, which is a separate transport
from the broadcast bus. Out of scope.

## Data flow after the change

- **Live app event:** producer `dispatch` → `buildEventMessage` (`typ: 'event'`) → transport write →
  responder inbound loop sees `typ === 'event'` → emits `{ data, senderDID }` to the event fan-out,
  regardless of any `kind` key inside `data`.
- **Live request/reply:** `BroadcastClient.request`/`gather` writes `typ: 'ctrl'`, `kind: 'req'` →
  responder sees `typ === 'ctrl'` → runs the handler → writes `typ: 'ctrl'`, `kind: 'res'` → client
  `#read` sees `typ === 'ctrl'`, `kind: 'res'` → collects, attributed by transport `senderDID`.
- **Retained replay (drain):** the app-lane log holds only `retain: 'log'` app events, all
  `typ: 'event'`; a `typ: 'ctrl'` frame is skipped by the `:459` guard. An app event whose `data.kind`
  is `'req'`/`'res'` is now replayed to listeners, matching the live path.

## Error handling

Unchanged. Malformed frames drop and keep the subscription (as today); a version mismatch throws the
existing message-bearing `decodeFrame` error and the frame is dropped. Best-effort writes still swallow
transport-teardown rejections.

## Testing

- **Regression pinning the fix (new):** an app event whose `data` is `{ kind: 'req', ... }` and one
  whose `data` is `{ kind: 'res', ... }` are **delivered** to event listeners on the live push path,
  and **replayed** by the app-lane drain on the retained path. Both are dropped today; both must pass
  after. This is the single test that would fail if the discriminator regressed to reading
  `data.kind`.
- **Updated existing tests:** responder/client anycast + reply tests and the drain tests move their
  control frames to `typ: 'ctrl'`. The transport version-refusal test asserts the live path speaks
  `v2` and refuses `v1`. Note this covers only the `decodeFrame` ingress; the drain's `JSON.parse`
  ingress has no version gate by design (see Wire version), so no drain version test is added.
- **A control frame is never misread as an app event and vice versa:** assert a `typ: 'ctrl'` frame
  does not reach the event fan-out, and a `typ: 'event'` frame is never dispatched as a request.
- **Conformance:** `rpc-conformance` and `hub-conformance` run uncached against the real
  implementation **and** the doubles.

## Breaking-change record

- Wire: `BROADCAST_VERSION` 1→2; `typ: 'ctrl'` introduced; `data.kind` removed from the app-data
  namespace. Every bus producer and consumer on this build. Live path refuses v1 (`decodeFrame`); the
  drain replays v1 app frames unchanged (no drain version gate, by design — see Wire version).
- The `minor` bump is recorded in a `pnpm change` intent as the work lands.
- On completion, mark the milestone item taken and note that the two interim drop-classifications
  (`app-lane.ts` control-shape drop, responder malformed-control fallthrough) are now deleted, per the
  anycast-soundness follow-on.

## Exit criteria

- All classifiers key on `payload.typ`; no live code reads `data.kind` before `typ === 'ctrl'`.
- The two interim drop-classifications are deleted.
- The regression test delivers `kind: 'req' | 'res'` app events live and on replay.
- Both conformance suites green (real + doubles), `build:types` clean, biome clean.
