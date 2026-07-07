# Directed inbox session GC / anti-accumulation

**Origin:** final whole-branch review of `rpc-directed-lane-security` (2026-07-07). New
finding, not one of the original audit's four items; the behavior pre-existed in the old
inbox acceptor and was carried forward by the sealed rewrite.

## Problem

The directed inbox acceptor (`packages/rpc/src/directed.ts`) creates one `ServerSession`
(hub-tunnel + `server.handle` promise + in-memory queue) per inbound session, removed only
on a matching `session-end` frame or acceptor dispose. The per-session tunnel is built with
no `idleTimeoutMs`, so idle sessions never GC, and there is no cap on concurrent sessions.

Under the branch's own threat model (malicious hub), an adversary can:
- suppress a legitimate `session-end` so the session leaks for the epoch's life, and/or
- replay a captured `session-open` frame (same epoch) to resurrect a zombie session bound
  to the real sender — potentially re-executing a request.

Result: unbounded per-epoch resource growth. Cross-epoch replay is already blocked by key
rotation; this is a same-epoch lever.

## Options (decide during design)

- **Per-sender session cap** — reject new session-open beyond N concurrent sessions per
  authenticated senderDID. Bounds accumulation without touching idle behavior, so
  long-lived idle channels are unaffected. Needs a policy default.
- **Idle timeout** — pass `idleTimeoutMs` to the per-session `createHubTunnelTransport`.
  Simplest, but risks timing out legitimate long-lived idle channels unless the value is
  generous/tunable.
- Consider both (cap + generous idle timeout) and a replay guard on `session-open` (e.g.
  reject re-open of a sessionID already seen-and-ended this epoch).

## Scope

`@kumiai/rpc` (`directed.ts` acceptor). Add a test for the chosen bound.
