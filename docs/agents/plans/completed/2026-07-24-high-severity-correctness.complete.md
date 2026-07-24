# Three high-severity correctness fixes — complete

**Status:** complete
**Completed:** 2026-07-24 on `fix/high-severity-correctness` (branched from `d96dfb1`).
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone `milestones/2026-07-audit-remediation.md`,
Phase 1 item 1 of `roadmap.md`. Promoted out of `backlog/2026-07-07-rpc-peer-lifecycle-hardening.md`
and `backlog/2026-07-07-hub-tunnel-reliability.md` at the 2026-07-23 triage.

## What was fixed

The three highest-severity correctness findings the audit produced, across `@kumiai/rpc`,
`@kumiai/hub-tunnel`, `@kumiai/broadcast`, and `@kumiai/hub-conformance`.

### 1. `to()` gated on peer readiness — `packages/rpc/src/peer.ts`

`peer.protocol(name).to(memberDID)` was the one surface method not wrapped in `withReady`. Called
before init it reached `surfaceFor` with no protocol registered and threw a misleading
`Unknown protocol: <name>` (or `Peer is not started`) for a valid name — a timing bug wearing a
config-error mask. Now wrapped like its three siblings. `ProtocolSurface.to` therefore returns
`Promise<Client<Protocol>>` instead of a sync client: a breaking change on `@kumiai/rpc`'s public
surface, taken as a **minor** while the package is 0.x. Rejected alternatives: keep it sync and
throw one explicit not-ready error (caller still cannot use it pre-init, only learns why); return a
lazy client awaiting `ready` internally (adds a deferral layer and moves failures to first use).

### 2. `resync()` under the commit mutex — `packages/rpc/src/peer.ts`

`resync()` called `rebuildEpoch()` with no lock while every other rebuild path runs under
`runSerial` (the group's commit mutex — `commitTail`). A host-called `resync()` could interleave
with an inbound-commit rebuild and run two concurrent teardown/build cycles over shared
`runtimes`/`secret`/`epoch` state. Now `await runSerial(() => rebuildEpoch())`. Safe because
`runSerial` is **non-reentrant**, `rebuildEpoch` takes no lock itself, and `resync` is a top-level
entry — all three confirmed at implementation and re-confirmed by the review gates.

### 3. Reconnect the durable-ack relay — hub-mux, open-once, broadcast, hub-tunnel, hub-conformance

**The finding's original framing was wrong and was corrected.** The audit called the ack contract
dead. It is live end to end elsewhere — `HubStore.ack`, the wire `{ack: [...]}` channel, the
hub-mux drain, and the commit + rendezvous lanes all use it. What was actually broken was narrower:
**five relay points forwarded a message and dropped its ack** — the app lane (`open-once`), the
inbox lane, the broadcast bus, the mailbox facade, the encrypted wrapper, and the tunnel read pump.
So the audit's "delete the contract" option was never available; deleting it would break a working
commit-lane path. This matters because `5eb220a`'s `retain: 'mailbox'` semantics ("removed once
every delivery is acked, or when it ages out") rest on that contract — on the severed lanes a
mailbox entry was reclaimed only by ageing out.

**The one invariant the whole fix rests on:** never report a frame as durably handled when it was
not. `memoryStore`'s `deliveries` map is keyed by recipient DID, not subscription instance, so an
unacked frame *is* redelivered to a fresh receive — acking an undelivered frame is permanent data
loss, not a missed retry. Everything below derives from it.

Design decisions carried into the implementation:

- **The mux refcount mirrors `memoryStore`'s `pendingFor`** rather than inventing a parallel policy:
  a `Set` of holder identities (not an integer counter, so a double-ack cannot free a frame early),
  keyed by delivery position, acked upstream only when the last holder releases. The free stays
  **class-conditional in the store** — a log-class frame survives every ack; only mailbox frames are
  delivery-derived — so the mux relays the ack and lets the store apply the class rule, assuming
  nothing about class itself.
- **Consumers are filtered before they are counted.** The mux's sinks are not topic-filtered, so
  counting all of them as pending holders would leave a commit frame waiting on tunnels that never
  ack it, making TTL expiry the norm rather than a backstop. `HubBase.receive` gained an optional
  `HubReceiveOptions = { topicID? }` so a sink can be scoped; the tunnel's own consumer-side topic
  filter stays load-bearing (a hub is free to ignore the scope).
- **An empty interested set is left pending, never acked.** That is exactly the shape of a returning
  member's backlog landing the instant the channel opens, ahead of `initControlLanes` wiring the
  first listener. Acking there would report a frame nobody read as durably handled.
- **The TTL sweep prunes without acking** (default 60s, configurable), mirroring the store's `purge`
  age bound. The frame stays in the hub mailbox and is redelivered on reconnect; acking on give-up
  would report a broken consumer as durable success.
- **Every teardown path abandons its claims, never acks** — mailbox-subscription close, mux dispose,
  the tunnel read pump's teardown paths, and `session-end` (which must ack *before* closing the
  iterator, not in a `finally` that runs after). `open-once` retains a frame from an epoch the
  handle has not yet reached — a transient failure, not a permanent one.
- **The drain preserves listeners-before-sinks ordering** so a listener that synchronously creates a
  directed sink still receives the triggering frame: sinks are matched after the listener loop, and
  a drain-held `Symbol` claim is released *last* so a synchronously-acking listener cannot fire the
  upstream ack before sinks merge into the pending entry.

**Enforcement is the conformance suites, not shared code.** New clauses at the LogHub seam assert an
acked mailbox frame is not redelivered to a fresh receive, and a log frame survives every ack.
Extracting a shared refcount primitive was rejected: `memoryStore`'s `removeEntry` is woven into
three maps and pinned by 24 conformance clauses, so pulling a helper out means refactoring the store
as part of a correctness fix. The repo's discipline for keeping independent implementations in sync
is the contract suite. Both suites were run against the real implementations **and** every double,
per `AGENTS.md`.

## Blast radius

- `@kumiai/rpc` — **breaking** (minor while 0.x): `ProtocolSurface.to` returns a Promise.
- `@kumiai/hub-tunnel` — additive: `HubReceiveOptions`, the `receive` parameter, the ack calls.
- `@kumiai/broadcast` — additive: the `subscribe` callback's second (ack) argument. `createMemoryBus`
  unchanged — an in-process bus that never redelivers legitimately omits ack.
- `@kumiai/hub-conformance` — additive: the new mailbox/log ack clauses (opt-in).

## Verification

Ten TDD tasks executed subagent-driven. Four whole-branch review gates: the first three each found
a real defect — two were bugs in the plan/spec text faithfully implemented (an "ack the empty set"
rule that would destroy a returning peer's backlog; a teardown that should abandon, not ack), one a
`session-end` ack hole — the fourth (2026-07-24) came back clean, no Critical or Important. Final
suites: hub-tunnel 77/77, rpc 371/371, integration 35/35, forced conformance gate 40/40 on uncached
runs, lint clean. End-to-end proof lives in the integration wire-hub smoke test: an acked frame is
not redelivered, an unacked frame is, and a log frame survives ack — over the real hub-server across
the Enkaku wire.

## Follow-on work (left open, deliberately)

- **The peer-init drain race.** A returning member's backlog can still land before listeners are
  wired; those frames are left pending and pruned unacked, so the permanent-data-loss path became
  delay-until-next-reconnect — a strict improvement, but the window is unclosed. Costed options are
  in `backlog/2026-07-07-rpc-peer-lifecycle-hardening.md`; the chosen direction is
  delay-until-reconnect over adding buffering to the drain's hot path.
- **Two of the six reconnected relay points carry no in-repo traffic** (`mux.mailbox.receive` and
  `mux.bus.subscribe` have zero production callers) — correctness matters for external consumers
  only. Recorded, not scheduled.
- The `ProtocolSurface` phantom-type-parameter retyping (`backlog/rpc-api-surface.md`) touches the
  same type Fix 1 opened, so bundling is cheap if scheduled — not scheduled here.
- Strengthening the coverage tripwire to catch a hub member with a type counterpart but no
  behavioural clause — the gap that let this defect survive an audit. A change to how the suite
  verifies, not to what it verifies.
