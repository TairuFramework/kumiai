# Directed-lane minor cleanups + durable-hub readiness

**Origin:** final whole-branch review of `rpc-directed-lane-security` (2026-07-07). Minor
findings deferred from that branch (see
`docs/agents/plans/completed/2026-07-07-rpc-directed-lane-security.complete.md`).

## Items

- **Durable-hub readiness (highest of these).** `sealDirectedHub`'s returned `HubLike`
  (`packages/rpc/src/directed-crypto.ts`) does not proxy `hub.events` or expose the receive
  `ack`. Inert on today's in-memory `mux.hubLike`, but against a real durable hub the
  directed lane would never `ack` (redelivery storms) and reconnect timers would never arm.
  Fix before a durable hub backs the directed lane.
- **Dedupe `normalizeUnwrap`.** Duplicated in `directed-crypto.ts` and `directed.ts` because
  the broadcast helper is not exported. Export it from `@kumiai/broadcast` and reuse.
- **Client directed-receive drains the whole mux un-topic-filtered.** `mux.hubLike.receive`
  pushes every inbound message to every sink; `sealDirectedHub` then attempts `unwrap` on
  every frame (broadcast/handshake included) before the tunnel drops non-matching topics —
  wasted crypto per inbound frame on every directed client. Consider topic pre-filtering.

## Scope

`@kumiai/rpc`, possibly a small `@kumiai/broadcast` export. Low priority; no correctness or
security impact today.
