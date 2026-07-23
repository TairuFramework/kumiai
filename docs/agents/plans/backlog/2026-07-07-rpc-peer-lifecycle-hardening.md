# rpc peer lifecycle hardening

**Priority:** backlog — lifecycle, leak, and error-path hardening in `@kumiai/rpc`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

> **The two high-severity items moved out (2026-07-23).** `to()` gating and `resync()`
> serialization were promoted to `../next/2026-07-23-high-severity-correctness.md`, where both are
> re-verified against `5eb220a` with current line numbers (the `resync()` finding is restated —
> `handshakeTail` no longer exists; the mutex is now `commitTail`/`runSerial`). Everything below
> stays here. Line numbers below are still `bb343d9` and have drifted.

> Typing debt on the public surface — `ProtocolSurface`, and the residual `UnwrapResult`
> declarations — is tracked separately in `rpc-api-surface.md`.

## Findings

### Medium (correctness)

- `packages/rpc/src/peer.ts:196,229` — `suppressedRequests` only grows (cleared only on
  dispose) — unbounded leak on a long-lived peer. Fix: TTL-expire like `pendingReplies`.
- `packages/rpc/src/peer.ts:377-387` — `dispose()` neither awaits nor cancels
  `handshakeTail`; a queued inbound Commit can rebuild and re-subscribe topics after
  dispose (`hub-mux.ts:49-52` `retain` has no disposed check). Fix: `disposed` flag
  checked in tail ops; guard `retain`.
- `packages/rpc/src/directed.ts:71-92` — acceptor tunnels are removed only on an explicit
  `session-end` frame and no `idleTimeoutMs` is passed, so a vanished client leaks its
  tunnel and map entry forever; a self-torn-down tunnel leaves its `sessionID` dead-ended
  in `tunnels`. Fix: pass `idleTimeoutMs`; remove the entry via `onSessionEnd`/teardown.
- `packages/rpc/src/peer.ts:166-178` — cached directed clients never invalidated when the
  remote ends the session; `to(memberDID)` returns a dead client until the next epoch
  rebuild. Fix: evict on session-end/teardown.
- `packages/rpc/src/hub-mux.ts:52` — first-retain `hub.subscribe` rejection swallowed
  while the refcount records the topic as subscribed — delivery silently never happens.
  Fix: retry or propagate.

### Low

- `packages/rpc/src/hub-mux.ts:163-165` — two concurrent `next()` calls on a sink iterator
  overwrite `resolveNext`, hanging the first caller; single-consumer assumption
  unenforced. Fix: queue waiters or throw. (correctness)
- `packages/rpc/src/hub-mux.ts:108` — every sink receives every inbound message on every
  topic; filtering deferred to each tunnel — O(tunnels × messages). Fix: filter sink
  pushes by retained topics. (API design)

## Test hooks

Peer concurrency tests (`resync()` racing an inbound Commit, `dispose()` during in-flight
handshake, `to()` before init) and an acceptor-tunnel leak/idle-teardown test — see
`next/2026-07-07-test-gaps.md`.
