# Directed lane — session accumulation and minor cleanups

**Priority:** backlog — one resource bound worth deciding, plus small cleanups. No correctness or
security impact on today's in-memory mux.
**Origin:** final whole-branch review of `rpc-directed-lane-security` (2026-07-07); see
`../completed/2026-07-07-rpc-directed-lane-security.complete.md`.
**Merged 2026-07-28** from `rpc-directed-lane-cleanups.md` and `rpc-directed-session-gc.md`, which
came out of the same review of the same lane. The session-GC finding was **also** carried as a
medium in `2026-07-07-rpc-peer-lifecycle-hardening.md` (`directed.ts:71-92`); that duplicate was
removed in favour of this doc.

## Session accumulation / anti-replay

The directed inbox acceptor (`packages/rpc/src/directed.ts`) creates one `ServerSession`
(hub-tunnel + `server.handle` promise + in-memory queue) per inbound session, removed only on a
matching `session-end` frame or acceptor dispose. The per-session tunnel is built with no
`idleTimeoutMs`, so idle sessions never GC, and there is no cap on concurrent sessions.

Under the branch's own threat model (malicious hub), an adversary can:

- suppress a legitimate `session-end` so the session leaks for the epoch's life, and/or
- replay a captured `session-open` frame (same epoch) to resurrect a zombie session bound to the real
  sender — potentially re-executing a request.

Result: unbounded per-epoch resource growth. Cross-epoch replay is already blocked by key rotation;
this is a same-epoch lever.

**Options (decide during design):**

- **Per-sender session cap** — reject new `session-open` beyond N concurrent sessions per
  authenticated `senderDID`. Bounds accumulation without touching idle behaviour, so long-lived idle
  channels are unaffected. Needs a policy default.
- **Idle timeout** — pass `idleTimeoutMs` to the per-session `createHubTunnelTransport`. Simplest,
  but risks timing out legitimate long-lived idle channels unless the value is generous/tunable.
- Consider both (cap + generous idle timeout) and a replay guard on `session-open` (e.g. reject
  re-open of a `sessionID` already seen-and-ended this epoch).

A self-torn-down tunnel also leaves its `sessionID` dead-ended in `tunnels`; remove the entry via
`onSessionEnd`/teardown whichever bound is chosen.

## Durable-hub readiness — highest of the cleanups

`sealDirectedHub`'s returned `HubLike` (`packages/rpc/src/directed-crypto.ts`) does not proxy
`hub.events` or expose the receive `ack`. Inert on today's in-memory `mux.hubLike`, but against a
real durable hub the directed lane would never `ack` (redelivery storms) and reconnect timers would
never arm. **Fix before a durable hub backs the directed lane.**

## Minor cleanups

- **Cached directed clients are never invalidated when the remote ends the session.**
  `to(memberDID)` returns a dead client until the next epoch rebuild. Fix: evict on
  session-end/teardown. (Carried over from `rpc-peer-lifecycle-hardening.md`, where it sat beside
  the acceptor-leak finding this doc absorbed.)
- **Dedupe `normalizeUnwrap`.** Duplicated in `directed-crypto.ts` and `directed.ts` because the
  broadcast helper is not exported. Export it from `@kumiai/broadcast` and reuse.
- **Client directed-receive drains the whole mux un-topic-filtered.** `mux.hubLike.receive` pushes
  every inbound message to every sink; `sealDirectedHub` then attempts `unwrap` on every frame
  (broadcast/handshake included) before the tunnel drops non-matching topics — wasted crypto per
  inbound frame on every directed client. Consider topic pre-filtering.

## Scope

`@kumiai/rpc` (`directed.ts`, `directed-crypto.ts`, `peer.ts`'s directed-client cache), possibly a
small `@kumiai/broadcast` export. Add a test for whichever session bound is chosen.
