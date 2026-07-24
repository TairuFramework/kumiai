# Anycast soundness: success-only suppression (design)

**Date:** 2026-07-24
**Branch:** `fix/anycast-soundness`
**Origin:** Roadmap Phase 1, item 4 (`docs/agents/plans/next/2026-07-07-anycast-soundness.md`);
2026-07-02 audit, milestone `2026-07-audit-remediation.md`.

## Problem

Suppressible anycast collapses a storm of responders down to one reply: a responder that sees
another's reply for the same request ID stops replying. The suppression fires on **any** observed
reply, errors included. So one fast *failing* responder suppresses every healthy one and the client
times out — the group looks dead when a single member is broken.

The reply-identity half of the original finding already shipped on `feat/app-lane-delivery`
(`a85c0fa`): replies are attributed to the MLS-authenticated `senderDID`, never a self-asserted
`from`. This design covers what remains — success-only suppression — plus the medium findings on the
same code paths, and adopts `@sozai/event`'s `EventEmitter` where the code hand-rolls listener
fan-out.

The bug lives in duplicated form: `packages/broadcast/src/responder.ts` and
`packages/rpc/src/bus-server.ts` carry near-identical `handleRequest` bodies (jitter, suppression,
reply shape). Fixing it twice is the smell the dedup removes.

## Decisions (settled in brainstorming)

1. **Scope:** all four findings (one High, three Medium) land on this branch, plus the extra
   `EventEmitter` adoption below.
2. **Dedup shape:** delete `bus-server.ts`; extend `createBroadcastResponder` to own events too;
   `peer.ts` calls the responder directly. The clone existed because there were two factories —
   deleting removes the reason.
3. **Suppression fix:** gate both mark-replied sites on success (`err == null`).
4. **Events:** replace the hand-rolled `eventHandlers` map with a typed `@sozai/event`
   `EventEmitter`, across both the live push and the drain (the "same door").
5. **Validation:** validate bus-lane input against the protocol's declared JSON schemas via
   `@sozai/schema`'s `createValidator`.
6. **`ctx.signal`:** wire to responder dispose (epoch teardown), the one real cancellation source —
   not to suppression, which fires before the handler runs.
7. **Extra adoption:** convert `MailboxHub`'s connection-event `subscribe` API to an `EventEmitter`
   (candidate A) as a distinct commit on this branch, and update the `fake-hub` fixture to match.
   Leave `hub-mux`'s topic-listener map (candidate B) untouched — see "Explicitly out of scope".
8. **Emitter exposure:** an emitter that is a *public subscription surface* is exposed through a
   `get events(): EventEmitter<…>` accessor over a private field (MailboxHub, §6); an emitter that is
   *internal plumbing* stays a passed value with no accessor (the bus emitter, §3).

## Design

### 1. One responder — delete the duplicate

`createGroupBusServer` carries no logic `createBroadcastResponder` lacks except event dispatch, and
event fan-out is exactly `@kumiai/broadcast`'s "generic fan-out" mandate. Fold events into the
responder and delete `bus-server.ts`.

`createBroadcastResponder` param changes (`@kumiai/broadcast`, `0.x` — only `@kumiai/rpc` and
broadcast's own tests consume it):

- `handlers` → `requestHandlers` (rename for symmetry with events).
- add `events?: EventEmitter<BusEvents>` (see §3).
- `BroadcastHandler` context grows a signal: `(prm, { senderDID?, signal? })` (see §5).

`peer.ts` constructs the responder directly (`createBroadcastResponder({ transport, from,
requestHandlers, events })`) in place of `createGroupBusServer`. `hub-conformance` /
`rpc-conformance` names and the `busServer` runtime slot stay; only the factory it points at changes.

### 2. Success-only suppression (the High finding)

A request ID is marked replied only when a reply *succeeded*. Both sites:

- **Own reply** (`handleRequest`): mark only when the handler returned a value.
  ```ts
  if (!isGather && reply.err == null) markReplied(request.rid, ttlMs)
  ```
  A handler that threw produces an `err` reply and leaves the rid open, so a later healthy responder
  still answers.

- **Observed reply** (inbound loop): a `res` frame from another responder suppresses only if it
  carried no error.
  ```ts
  if (data?.kind === 'res' && data.err == null && typeof data.rid === 'string') {
    markReplied(data.rid, DEFAULT_SUPPRESS_TTL_MS)
    continue
  }
  ```
  A peer's error frame no longer suppresses this responder.

The jitter-window guard (`if (suppressTimers.has(rid)) return`) is unchanged in code but stronger in
meaning: a live timer now proves *someone succeeded*, not merely *someone spoke*.

`markReplied`'s first-writer-wins semantics stay: an `err`-reply that arrives before a later success
sets nothing, so the success still registers.

### 3. Events through `@sozai/event`

Replace `eventHandlers: Record<string, (data, senderDID) => …>` with a typed emitter:

```ts
type BusEvent = { data: unknown; senderDID?: string }
type BusEvents = Record<string, BusEvent>   // keyed by procedure name (prc)
```

- `adaptBusHandlers` (`@kumiai/rpc/handlers.ts`) builds the `EventEmitter<BusEvents>`, registering
  each `event` procedure as a listener: `events.on(prc, ({ data, senderDID }) => hostHandler(...))`.
  It returns `{ events, requestHandlers }`.
- **Live push** (the merged responder): on an inbound event frame,
  `void events.emit(prc, { data, senderDID }).catch(() => {})` — fire-and-forget, matching today's
  `void Promise.resolve(handler(...)).catch(() => {})`.
- **Drain** (`app-lane.ts`): emits into its emitter inside the existing per-frame `try/catch`. When
  no listener is registered for `prc`, `emit` is a no-op — the current `handler == null` skip
  becomes implicit.

Structure is preserved: two emitters, one built once for the drain and one rebuilt per epoch for the
live bus, both produced by the same `adaptBusHandlers` — the "same door" invariant (a drained frame
and a pushed frame reach the host by identical adaptation) holds. They are separate instances by
lifecycle: the per-epoch responder's disposal must not tear down the drain's listeners.

`app-lane.ts`'s `appEventHandlers: Map<string, BusHandlerMaps['eventHandlers']>` becomes
`Map<string, EventEmitter<BusEvents>>`.

**Exposure — internal, not a getter.** This emitter is plumbing, never a subscription surface a
caller reaches for. `adaptBusHandlers` constructs it and hands it back as a plain value on its return
object (`{ events, requestHandlers }`); `peer.ts` passes it into the responder (a constructor param)
and stores the drain's copy in `appEventHandlers`. Nobody outside the rpc wiring subscribes to it, so
it stays a passed value — the merged responder does **not** expose a `get events()` accessor, and
neither does `adaptBusHandlers`'s return beyond the field already named. Contrast §6, where the
emitter *is* the public surface.

### 4. Bus-lane input validation (Medium)

The directed inbox server validates request/event payloads against the protocol schema; the bus lane
does not. Close the gap in `adaptBusHandlers`, which already holds the `ProtocolDefinition`:

- Build a `Validator` (`@sozai/schema`'s `createValidator`) per procedure from its declared schema —
  `param` for `request` procedures, `data` for `event` procedures.
- **Request** with invalid `prm`: the request handler rejects, producing an `err` reply. Combined
  with §2 this is safe — a validation-failing responder does not suppress healthy ones, and the
  client sees a rejection rather than a timeout.
- **Event** with invalid `data`: dropped (fire-and-forget has no reply channel), logged via
  `@sozai/log` under `['kumiai', 'rpc']`. Mirrors how the directed path refuses a malformed event.

### 5. `ctx.signal` (Medium)

Today `handlers.ts` hands each bus request a fresh `AbortController().signal` that nothing ever
aborts. Wire it to the one genuine cancellation source — responder dispose (epoch teardown):

- The merged responder owns a `Set<AbortController>`, one per in-flight request, and aborts them all
  in `dispose()`. Each controller is removed when its request settles.
- The signal reaches the handler through §1's extended context: `(prm, { senderDID?, signal? })`.
- `adaptBusHandlers` drops its own dead `new AbortController()` and forwards `context.signal` into
  the enkaku handler call.

Suppression is deliberately **not** a cancellation source: it fires in the jitter window before the
handler runs, so there is nothing in flight to abort.

### 6. `MailboxHub` connection events → `EventEmitter` (extra adoption)

`hub-tunnel/transport.ts` exposes connection state through a hand-rolled listener registry:

```ts
export type MailboxHubEvents = { subscribe: (listener: MailboxHubEventListener) => () => void }
```

with a `MailboxHubEvent` union (`reconnecting` | `connected` | `disconnected`). Convert to a
single-key emitter, because the sole internal consumer (`transport.ts:484`) switches on
`event.type` with shared arms — one listener that switches fits better than three per-type listeners:

```ts
export type MailboxHubEvents = EventEmitter<{ status: MailboxHubEvent }>
```

**Exposure — a `get events()` accessor.** Here the emitter *is* the public surface: external code
(`encrypted-transport.ts`'s pass-through, tests, any host) reads `hub.events` to subscribe. On a type
that owns and publishes an emitter, expose it through a getter over a private field rather than a
public mutable property — the field cannot be reassigned from outside, and the getter is the read-only
subscription handle:

```ts
class FakeHub /* …, and any real MailboxHub */ {
  #events = new EventEmitter<{ status: MailboxHubEvent }>()
  get events(): EventEmitter<{ status: MailboxHubEvent }> {
    return this.#events
  }
  // internal state transitions emit:  this.#events.emit('status', { type: 'connected' })
}
```

On the shared type, `HubBase.events` becomes `readonly events?: MailboxHubEvents` — still optional
(a hub may front a lane with no connection events; the `hub.events != null` guard at
`transport.ts:475` stays), now read-only to match the getter.

- Emitters (`fake-hub` fixture, any real hub) transition state through `this.#events.emit('status',
  { type: 'connected' })`, replacing today's `#emitEvent` loop over `#eventListeners`.
- The consumer at `transport.ts:484` becomes `hub.events.on('status', (event) => { switch … })`;
  the returned unsubscribe is `EventEmitter`'s `off` function.
- `encrypted-transport.ts` forwards the same emitter reference. `wrapped` is a plain object literal,
  not a class, so no getter applies — but making `HubBase.events` `readonly` breaks its current
  post-construction mutation (`wrapped.events = hub.events`). Forward it inside the literal instead:
  `...(hub.events != null ? { events: hub.events } : {})`.
- Update the `fake-hub` fixture: drop `#eventListeners` / `#emitEvent` / the `events = { subscribe }`
  field, add `#events` + `get events()`, and point `simulateReconnecting/Connected/Disconnected` at
  `this.#events.emit('status', …)`.

This lands as its own commit, separate from the anycast fix, to keep the two concerns legible in the
branch history.

## Explicitly out of scope

- **`hub-mux`'s `listeners: Map<string, Set<InboundListener>>`** (`hub-mux.ts:298`). It looks like a
  keyed emitter but is entangled with `refcount`, `subscriptions`, holder-sets, and the ack
  lifecycle that commit #10 just stabilized. Swapping it for an `EventEmitter` fights that coupling
  and risks regression, with no relation to anycast soundness. Leave it.
- **`client.ts` reply identity** — already shipped (`a85c0fa`). No change here.

## Testing

New and updated tests (`@kumiai/broadcast`, `@kumiai/rpc`, `@kumiai/hub-tunnel`):

- **Mixed error/success anycast** (the gap named in the doc — `responder.test.ts` currently tests
  only a lone erroring responder): a fast erroring responder plus a slower succeeding one → the
  client resolves with the success, never a timeout. Directly guards §2.
- **Observed error frame does not suppress**: a responder that sees a peer's `err` frame still
  answers.
- **Event dispatch through the emitter**, both the live push and the drain path, including the
  `senderDID` carried on `BusEvent`.
- **Validation**: an invalid request yields an `err` reply (and does not suppress); an invalid event
  is dropped and logged.
- **Signal**: an in-flight bus handler observes `signal.aborted` after responder `dispose()`.
- **`MailboxHub` events**: `on('status', …)` receives `connected`/`reconnecting`/`disconnected`;
  the reconnect-timer wiring in `transport.ts` behaves as before.
- **Contract suites**: `rpc-conformance` and `hub-conformance` run against the real implementation
  **and** the doubles (AGENTS.md port rule — changing a port means running both suites both ways).

## Files touched

- `@kumiai/broadcast`
  - `responder.ts` — extend (events, request/event routing, in-flight controllers), both suppression
    fixes, `requestHandlers` rename, context `signal`.
  - `index.ts` — export changes.
  - `client.ts` — unchanged (reply identity already shipped).
- `@kumiai/rpc`
  - `bus-server.ts` — **deleted**.
  - `handlers.ts` — emitter construction, per-procedure validators, signal forward, drop dead
    controller.
  - `peer.ts` — call `createBroadcastResponder`; wire the emitter; adjust `appEventHandlers` type.
  - `app-lane.ts` — emit into the emitter in the drain loop; `appEventHandlers` type.
- `@kumiai/hub-tunnel`
  - `transport.ts` — `MailboxHubEvents` → `EventEmitter`; `HubBase.events` → `readonly …?`; consumer
    at :484; exports.
  - `encrypted-transport.ts` — forward `events` inside the object literal (readonly-safe).
  - `test/fixtures/fake-hub.ts` — fixture to `#events` + `get events()`.

## Risks

- The largest blast radius is the `adaptBusHandlers` return-shape change rippling into `peer.ts` and
  `app-lane.ts`, not the one-line suppression fixes. Wiring, not logic.
- The drain and live emitters must stay separate instances; a shared emitter would let a per-epoch
  responder's dispose strip the drain's listeners.
