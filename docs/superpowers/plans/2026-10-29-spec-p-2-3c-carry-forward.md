# Plan 2.3c carry-forward (decisions, rulings, deferred minors, obligations)

Plan 2.3c (durable publication and settlement, resync/retirement drain of opened records) complete on `feat/spec-p-phase-2` (range `0747b204..HEAD`, not pushed). Tasks 0-8 reviewed clean; Task 7 and Task 8 ran in lanes merged at `b7dd5ad7` and `d930ba80`. Opus final review C0 I2 M7; final fix `13267bbc` (I1 live-peer fallback, M2/M3 byte copies) and docs `b6595535` (I2); scoped re-review found I1-R1 (disposed peer's fallback still admitted records), fixed `46c1d2c3`. Ephemeral: delete with the other phase-2 plans.

## User decisions

- Q2 (from 2.3b) **resolved** by spec r28i (`99639b45`): a failed or unreadable delivered own/foreign copy counts as non-delivery. Hub faults no longer strand the cursor or let resync discard a live build on that basis alone.
- 2026-10-24: milestone paused for other sessions; resumed 2026-10-29. Heavy runs follow the machine-wide protocol (Sakui first, controller work second, this milestone low).

## Obligations for later sub-plans

1. Merge held until phase 2 is complete. Do not merge or push after 2.3c alone.
2. Next: 2.3d (`HandlerCompletion` atomicity, handler metadata, frame-ref migration, poison removal), 2.3e (restore rows and seam), then 2.4 (HTTP smoke, provider faults, SIGKILL). Not claimed by 2.3c: S:2800/2801/2835/2737, restore rows, batching, HTTP, provider and SIGKILL evidence.
3. Next main merge brings kokuin 0.11 (controller-log.ts; `createRotate` needs `snapshotOf(head)`; `createRevoke` is an EPOCH event) and the management tier (band 0.12, published). Run repo-wide `test:types` after; the milestone band becomes 0.12. `@kumiai/mls` version drift from 2.3b obligation 4 also resolves there.
4. Hosts with durable handlers must pass `openedDeliveryContext` (`TypeError` otherwise), implement the four new `AppOutbox` methods (`recordSettlement`, `loadSettlement`, `events`, `ackEvent`) and supply the `appPublication` port. Exhaustive host status switches need the `switch-blocked` arm.
5. Retirement lifecycle has no timeout: resync, delete and successor wait until opened records drain. A live attached peer's handler serves its own backlog; an explicit registry `deliverOpened` takes precedence. With no handler at all the lifecycle waits.
6. `Peer.drainOpened()` permanently stops new opens on that peer.
7. Controller-log persisted format unchanged by 2.3c; the kokuin-probe version tag stays out of scope until a sub-plan changes that format.
8. Carried from 2.3b: obligations 5-16 still stand (legacy journal decision, `internalOperations` forwarding, `restoreCandidate` envelope, registry port additions, hub-conformance rerun at phase end, 2.3a carry-overs).

## Rulings worth re-checking

- I1 fix uses option (b): the attached live peer's handler is the storage worker's fallback, removed on detach and withdrawn synchronously at peer dispose start. Option (a) (drain the peer before the freeze) still hangs on blocked records.
- M2 regraded Important (Buffer alias left an entry stuck on 'Publication entry moved' until restart); all added host-edge byte copies use `Uint8Array.from`.
- Execution order 0,1,2,3,4,7,8,5,6 (Tasks 5/6 consume Task 8's `inspectCapture` and F > E authority).
- Certified finalisation uses a private coordinator argument, never a request property.
- Administrative versions are authoritative for state reads and saves; an unreadable version row makes ordinary observation unreadable.
- Registry deletion startup finalises persisted certified debt before clearing.
- Task 8 added a public candidate-free GroupInfo inspection helper to `@kumiai/mls`.
- Ownership preflight is synchronous (`450f674a`); a handler-originated `dispose` is refused (restart witness `88a5ff69` crashes outside the handler).
- Task 7 SQL gate requires PostgreSQL actually executed; a skipped backend is not a pass.
- Workers run full package `test:unit` after scoped runs missed 17 regressions (Task 1 commit-cas x2, Task 3 control-store x15).

## Final review minors (deferred)

- M1: `switch-blocked` status outlives a failed retirement attempt (`registry-peer.ts:320`, `registry.ts:625-650`); republish in `finally`.
- M4: rejoin resends become durable outbox entries, consuming capacity and emitting host status events (`log-delivery.ts:398-411`).
- M5: registry `drainOpened` without a delivery context polls storage every 100 ms (`registry.ts:602-610`); use backoff or observe.
- M6: opened-delivery state per (binding, key) is never pruned (`opened-delivery.ts:55-67`).
- M7: switch-side F > E gate is keyed on a caller-filled WeakSet (`switch.ts:42,56`); derive from the persisted record's trigger.
- Task 1: `fork-halt.test.ts:82` biome `useMathMinMax` warning (pre-existing).
- Task 6: rpc suite emits push-lane termination / invalid-event diagnostics; capture and assert, or fix teardown.
- Integration recovery test failed once at default concurrency (load-timing class); recheck at phase-end gates.
- Opus declined to judge: stale-epoch own commit installed by coverage after `ahead` stops stranding (spec S:2826 concession); `sealVersion` starvation; permanently failing initial finaliser silently blocks `access(groupID)`; `retryRolledBack` masks the original error on an unexpected phase.
- Recommended: one assembled integration witness for publish → certify → finalise → publish on a registry peer.

## Gates

Run 2026-10-29 on `46c1d2c3` in a coordinated heavy-run slot: build ok; repo-wide `test:types` 30/30; rpc 2774; mls-rpc 7888 (2 skipped); mls 1361; hub-server 265; hub-tunnel 106; mls-hub 184; hub-client 22; hub-protocol 51; broadcast 92; hub-store 186 with `CI=true` (Postgres via testcontainers executed, not skipped). rpc-conformance has no `test:unit` script and runs through its consumers. Integration 495/497: both `group-conditions` failures were stale fixture wiring (two distinct opened-delivery contexts; reachable since Task 5's retirement drain), fixed in `3d1b1ed8`, file 51/51 after. Integration global teardown sometimes exits 1 on Docker HTTP 404 (container already gone); recheck at phase end.
