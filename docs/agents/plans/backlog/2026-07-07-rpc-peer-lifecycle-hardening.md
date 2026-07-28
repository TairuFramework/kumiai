# rpc peer lifecycle hardening

**Priority:** backlog — lifecycle, leak, and error-path hardening in `@kumiai/rpc`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`archive/2026-07-audit-remediation.md`.

> **The two high-severity items shipped (2026-07-24).** `to()` gating and `resync()` serialization
> were fixed on `fix/high-severity-correctness` — see
> [completed](../completed/2026-07-24-high-severity-correctness.complete.md). `to()` now returns a
> Promise (breaking, minor at 0.x); `resync()` runs under `commitTail`/`runSerial` (the `resync()`
> finding was restated — `handshakeTail` no longer exists). Everything below stays here. Line
> numbers below are still `bb343d9` and have drifted.

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
- ~~`packages/rpc/src/directed.ts:71-92` — acceptor tunnels leak without an `idleTimeoutMs`~~ and
  ~~`packages/rpc/src/peer.ts:166-178` — cached directed clients never invalidated~~ — **moved
  2026-07-28** to [rpc directed lane](./rpc-directed-lane.md). The first was a duplicate: the same
  finding was independently filed as `rpc-directed-session-gc.md` from the same branch review, with
  the threat model and the candidate bounds worked out. Both now live with the rest of the directed
  lane's items rather than split across two docs.
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
  **Closed 2026-07-23** by the durable-ack work: `Sink.topicID` carries the scope a
  `mailbox.receive` was opened with, and the drain filters on it. A sink that names no topic
  still takes every message, which is the documented default.

## Added 2026-07-23 — the peer-init drain race

Filed out of the final review of `fix/high-severity-correctness`. **Not a defect in that branch —
it made this strictly better — but the underlying race is still open.**

`createHubMux` runs synchronously in the peer constructor (`packages/rpc/src/peer.ts:361`), so the
drain starts reading the hub subscription immediately. The first `mux.onInbound` lands much later:
inside `initControlLanes`, behind `await anchorStore?.load()` and `await mls.exportRecoverySecret()`,
and the self-inbox listener later still, after `replayJournal` + `ensureLedger` + `pullCommits` —
network round trips. Meanwhile the real hub pushes the recipient's entire undelivered backlog the
instant the channel opens (`packages/hub-server/src/handlers.ts:331-349`).

So a returning member's held mail is drained into a mux with no holders for it.

**Where it stands now.** Those frames used to be acked and reclaimed — permanent loss. They are now
left pending and pruned unacked by the TTL sweep, so the hub keeps them and redelivers on the next
reconnect. Data loss became delay. That is where the branch left it, deliberately.

**What is still wrong.** The frames are dropped *for that session*. A member returning after
downtime does not see its held mail until something forces a reconnect, which nothing does promptly.

**Options, none costed:**

- **Buffer and replay in the mux.** Hold messages that match no holder for an opening window and
  replay them to a listener that registers for that topic. Closes it fully; adds buffering state to
  the drain's hot path, and needs a bound of its own.
- **Defer the drain.** Do not start reading until `initControlLanes` has wired its listeners.
  No buffer and no window — but it changes peer startup ordering, which the commit lane's
  journal-replay invariants sit on top of, so it is not the small change it looks like.
- **Leave it.** Delay-until-reconnect may simply be acceptable, in which case say so where the
  behaviour is documented rather than leaving it implicit.

Pick deliberately. The reason this is worth revisiting is that the *shape* of the bug — "nothing is
listening yet, so nothing ever will be" — is what produced the one critical regression that branch
had to fix.

## Test hooks

`resync()` racing an inbound Commit and `to()` before init are **now covered**
(`peer-resync-serial.test.ts:9`, `peer-to-ready.test.ts:15`, verified 2026-07-28). What remains:
`dispose()` during an in-flight handshake — see `../next/2026-07-07-test-gaps.md` — and an
acceptor-tunnel leak/idle-teardown test, see `../backlog/2026-07-28-test-gaps-low.md`.
