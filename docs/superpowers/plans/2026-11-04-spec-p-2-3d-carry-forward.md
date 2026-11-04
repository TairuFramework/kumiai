# Plan 2.3d carry-forward (decisions, rulings, deferred minors, obligations)

Plan 2.3d (durable handler completion and batching) complete on `feat/spec-p-phase-2` (range `68b9edea..09222388`, not pushed). Tasks 1-11 reviewed; Task 5 ran in a lane merged at `bf959200`. Final review: Opus C0 I0 M5 plus blind Codex (B1-B6). One fix pass `1268aafe` + changeset `66244bde`; scoped re-review found three residuals from that pass (R1-R3), fixed `09222388`. Ephemeral: delete with the other phase-2 plans.

## Obligations for later sub-plans

1. Merge held until phase 2 is complete. Merge message must note that `8bdfb683..10ad333e` are red intermediate commits (Task 3 changed the delivery contract, Task 4 migrated callers).
2. Next: 2.3e (restore rows and seam), then 2.4 (HTTP smoke, provider faults, SIGKILL).
3. Breaking for hosts: every peer requires `completion: HandlerCompletion<TTx>` bound to `{ groupID, incarnation }`; the former recovery completion callback is now `recoveryCompletion`. Registering any retained handler, plain functions included, requires atomic `crypto.pending` storage (construction refuses otherwise). Unsupported commit/ledger-entry versions report `unknown-version`.
4. Terminal-first self-removal (spec ~2743/~2808): after removal commits, no decrypt, seal, private restore, fetch or publish; saved plaintext drains through canonical completion and clears after proof. Gates: `removalCommitted()` choke points in rpc `peer.ts`, sync `terminal-admission.ts` immediately before raw crypto, `assertNotTerminal` rechecks in recovery, persisted terminal flag checked before any restorer (cold access included). New code paths that await before crypto must recheck after the last await.
5. Registry MLS construction is trust-only; batching and control entry labels resolve lazily. Keep zero-restorer construction witnesses green.
6. Run tests/integration (in-memory app-lane-delivery, directed-lane, terminal-drain, member-persistence) per task when a task changes delivery, completion or persistence contracts. 2.3d skipped this and hid a 7/14 regression until the controller gate.
7. Fix the three load-timing flakes before phase-end gates: manual-recovery restart, rpc failed-put retry, ports-conformance-transactional fork-recovery.
8. Carried from 2.3c: obligations 3-8 still stand (main merge brings kokuin 0.11 + band 0.12, `openedDeliveryContext`, `AppOutbox` methods, no retirement timeout, `drainOpened`, controller-log format, 2.3b obligations 5-16).

## Rulings worth re-checking

- B2: retained handlers, legacy functions included, require `crypto.pending` (spec 531-540, 1983); a frame-less retained event is rejected, never dropped. If the spec intends legacy functions to work without pending storage, restore a non-durable legacy path.
- O2: the unreachable terminal `restorePending` branch in `peer.ts` (~6165) stays; the `finally` restore is the single effective restore point. Delete it in a cleanup.
- Task 4: cold-drain double completion parked to Task 10, fixed there by the key-neutral dispatcher resolver.
- Task 5: scheduler work bound uses a monotonic accumulator of non-negative deltas; round membership fixed at round start, round ends on idle.
- Task 7: buffered control capped at 2 checked pages; retry reuses app-pull backoff (1000 ms doubling, 60 s max).
- Task 8: ahead-claim follow-up grants no durable authority (hub bytes grant nothing); gap plus valid competitor is terminal unknown per r28i ~600-620.
- Task 10: overruled the implementer; self-removal commits keeping pending plaintext, drain outside ownership. Review breaker tripped at round 5; two P3 recovery rechecks fixed without a sixth review (`03485dd2`), covered by the final review.
- Integration fixture now uses production memory persistence and `createHandlerCompletion`; host journal, MLS state and pending plaintext share one transaction and completion proof (R3).

## Final review minors (deferred)

- M4: a custom completion without coverage keeps the cursor volatile (`app-lane.ts:916`); by design (Q1=A), consider a doc note or warning.
- Opus M3 closed by B5/R2/R3.

## Gates

On `09222388`: build ok; rpc 2876; mls-rpc 8639 (2 skipped); integration in-memory 18/18; lint clean except pre-existing `fork-halt.test.ts:82`. Repo-wide `turbo run test:types --force` 30/30, 0 cached, at `66244bde` (`09222388` touches mls-rpc src and test fixtures only; mls-rpc, rpc and integration types re-checked). No SQL/Docker, provider-fault or SIGKILL suite ran.
