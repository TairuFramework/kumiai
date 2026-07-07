# broadcast robustness

**Priority:** backlog — ordering, backpressure, and error-path hardening in
`@kumiai/broadcast`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### Medium (correctness)

- `packages/broadcast/src/transport.ts:82-90` — async `unwrap` results enqueue as each
  promise settles, so inbound messages can be delivered out of order under variable
  decrypt latency. Fix: serialize enqueueing through a per-subscription promise tail.
- `packages/broadcast/src/transport.ts:82` — a *synchronously* throwing `unwrap` escapes
  the subscribe callback (only rejections are caught) and, on `createMemoryBus`, aborts
  fan-out mid-loop. Fix: route sync throws into the same drop path.
- `packages/broadcast/src/transport.ts:89` — `controller.enqueue` with no backpressure
  check; a slow reader accumulates an unbounded queue (contrast hub-tunnel's
  `BackpressureError`). Fix: apply a `CountQueuingStrategy` capacity and drop/error on
  overflow.

### Medium (API design)

- **`packages/broadcast/src/bus.ts:12-22` vs `rpc/src/hub-mux.ts:112-116` — loopback
  semantics diverge:** `createMemoryBus` delivers publishes back to the sender; the
  hub-backed bus never does — code tested on the memory bus behaves differently in
  production. Fix: specify loopback on `BroadcastBus`; make the memory bus match the hub.
- **No `AbortSignal` in `RequestOptions`/`GatherOptions`/`GroupPeerParams`**
  (`broadcast/src/client.ts:66,109`, `rpc/src/peer.ts:34-46`), inconsistent with
  `createBroadcastTransport` and hub-tunnel which accept `signal`. Fix: accept an optional
  signal, settle promptly on abort. (Touches `@kumiai/rpc` too.)

### Low (correctness)

- `packages/broadcast/src/client.ts:49-59` — when transport iteration ends (hub
  disconnect), `#read` returns silently; in-flight requests linger until timeout. Fix:
  settle all `#pending` on loop exit.
- `packages/broadcast/src/responder.ts:66,122` (same in `rpc/src/bus-server.ts:59,96`) —
  `await sleep(...)` sits outside the try/catch and `handleRequest` is `void`ed without
  `.catch`; an injected jitter rejection becomes an unhandled rejection. Fix: wrap the
  jitter phase or add `.catch`.
- `packages/broadcast/src/bus.ts:18-20` — a throwing subscriber aborts `createMemoryBus`
  fan-out and rejects `publish` (hub-mux try/catches listeners; memory bus doesn't). Fix:
  try/catch each callback.
- `packages/broadcast/src/transport.ts:107-111` — a single non-`event` write errors the
  whole `WritableStream`, killing the transport for one caller mistake. Fix: reject the
  write without erroring the stream, or document.

## Test hooks

`sender.test.ts`/`transport.test.ts` use only synchronous `unwrap`; async-unwrap ordering
untested — see `next/2026-07-07-test-gaps.md`.
