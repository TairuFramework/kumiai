# Plan 2.2d carry-forward (rulings, deferred minors, obligations)

Plan 2.2d (captured head resync recovery) complete at `b189111` (range `ebdda50..b189111`). Final Opus review: 1C/1I fixed in b189111, re-review clean. Ephemeral: delete with the other phase-2 plans.

## Obligations for later sub-plans

- 2.2e: fork checkpoints (input: docs/superpowers/specs/2026-10-14-spec-p-fork-checkpoints-design.md, untracked).
- 2.2e/2.3: switch-proof resolution has no count/elapsed bound; RegistryPeer.status() exposes 'pending'. Decide whether a bound is wanted.
- 2.3: full registry crypto/application adapters (Task 18 fixture refuses app opens).
- Evidence claimed is phase-2 memory reconstruction, never phase-6 child-process SIGKILL.
- Merge held until phase 2 complete (user decision). Order 2.2d -> 2.2e -> 2.3.

## Final review minors (deferred)


1. **Settlement and floor refusal paths are silent.**
   - Below-floor recapture returns without `emitRecovery` (`peer.ts:4443-4450`).
   - A legacy record behind a captured port returns `{advanced:false}` with no event (`peer.ts:4373`, `:4871-4876`).
   - The "same epoch, different authenticator" reconcile returns plain `retry`, with no diagnostic (`recovery.ts:713-716`).
   - The plan table asks for a "Diagnostic and bounded retry" here. The retry is backoff-capped, but it is neither bounded nor diagnosed.
2. **Settled rows are never pruned.**
   - `settledRejoins` (`store.ts:376`) keeps every owed token forever in a non-registry incarnation, and each later fresh attempt re-unions them (`peer.ts:4458`).
   - The device ledger is append-only (`mls/src/group-device.ts:205`), so the stale tokens are filtered and do not re-enact.
   - Cost is storage growth bounded by the device's own entries. Acceptable, but the spec says "bounded" and nothing bounds it.
3. **The settlement signature makes the floor optional.** `settleAcceptedRecovery`'s fourth parameter `recoveryEpochFloor?` is optional
   in `rejoin.ts:322-327` and `registry-peer.ts:72-77`. A custom implementation can drop it and write a lower floor (the 14b deferred minor).
   Make it required.
4. **`createRegistryGroupMLS` requires an unused parameter.** It requires `onConfirmedRecovery` (`registry-group-mls.ts:32,36`) but never uses it.
   The README example threads it through. Either use it or drop the requirement.
5. **Re-entry deadlock is undocumented (Task 16 suspicion).**
   - `registry-group-mls.ts:239-257` `recoveryAdoption.accept` calls `switchIncarnation`, and that runs `onRetire`, which awaits `peer.drained()`.
     Called from a peer serial op, that would deadlock until the 5 s timeout.
   - Through documented composition this is unreachable: `createRegistryPeer` always supplies `onConfirmedRecovery`, so `adopt` returns `handoff` before `onAccepted`.
     Without a registry peer, no `onRetire` hook exists.
   - The remaining real exposure is the pre-existing one: a retained app handler that awaits a peer serial operation (`commit`, `recover`) deadlocks.
     That was already true for pull-driven drains at HEAD (`ebdda50` `peer.ts:2053`). 5e adds autonomous drains under `runSerial` (`peer.ts:509-515`), so it is now reachable without traffic.
   - Document it in the rpc README handler section.
6. **The memory GroupMLS double is more permissive on signer authority** (`trust.members.includes`) than the real retained-tree and
   controller eligibility check (Task 12 deferred). This breaks the "double stricter, never more permissive" rule. It is unexercised by conformance today.
   Add a conformance case for an ineligible signer, or tighten the double.
7. **`requestKey` can leak in memory on an early throw.** In `capturedAttempt`, `requestKey` is not zeroised if `requestGroupInfo` or `assertSafetyOpen` throws
   (`peer.ts:4378-4384`). It is in-memory only.


## Deferred minors weighed across the branch (final reviewer)


Rulings I re-checked against the built code, with nothing to add:
- 5b-I2 (applied-state superseded);
- 5c-I1 rejection (own copy tamper);
- 8b redesign (refusals on request);
- 13-I2 (capture walk under runSerial);
- 16 option 1 (rolled-back proof by settled Read). This is implemented at `recovery-coordinator.ts:112-122`, with `proof !== 'committed'`;
- 14b leaf-absent `not-accepted` row;
- confirmed leaf-absent as accepted.

Two rulings fall outside the threat model: 6-I2 (Proxy) and the 5d `commitPolicy` throw. Both are acceptable.

| Deferred minor | Verdict |
| --- | --- |
| **5b M5**: `acceptance-unknown` hold stalls new intents until land/epoch advance | **Upgrade to Critical (C1).** With the registry, the stall becomes a permanent stop after restart. |
| **14b M4**: `acceptance-unknown` blocks registry settle | **Upgrade to Critical (C1)**, same root. |
| **16**: unbounded retry without surfaced state; start returning silently without peer | **Upgrade to Important (I1)** for the coordinator. |
| 1a validation timeouts; 8a grouped real-gate timeouts; 5a crash-replay race | Still minor: test infrastructure. |
| 2 S-m1/m2/m6/m7 | Still minor. |
| 5a M1: onStrand per divergent frame | Still minor: proportional to hub volume, already accepted. |
| 5b R1: one republish per restart | Still minor: hub cannot force restarts. |
| 5b M4: own-unmerged skip relies on later ahead-heal | Still minor. |
| 5c: search keeps fetching after unsupported frame; one planted frame keeps acceptance unknown | Still minor. The planted frame takes the reason-null path, so it causes no hold and does not trigger C1. |
| 5d: openEntries resolver untested; ownVerification comment; bad-blob witness bypasses validateFrame | Still minor: test precision. |
| 5e: blind minors 1/2/3/5; reset-skipped retry; scheduleDrain skip clears `retryRequested`; async pruned notice | Still minor. |
| 5e: handler re-entry into serial ops | Still minor (pre-existing), but now also reachable on autonomous drains. Document it (Minor 5). |
| 5e clockfix: freeze after a backwards wall-clock jump | Still minor. It only lengthens future-frame holds. |
| 7: controller-less captured replies accept any origin-tree signer; M7 malformed key; empty replyLedger alone | Still minor: legacy parity, outside the hub threat model. |
| 8b N2: publish ack beyond the 64-char limit | Still minor: own-commit search recovers. |
| 12: M1 head-only backwards replay; M5 WeakMap per environment; M6 post-close rejection | Still minor: liveness only. |
| 12: memory double lenient on signer eligibility | Minor, but it breaks the strictness rule (Minor 6). |
| 13: capture walk under endless pages | Still minor: same bound as ordinary sync. |
| 16: GroupStateUncertainError conflation; dropped handoff leaving failure set; post-timeout drain rejection swallowed; start finally masks error; mls dispose no-op | Still minor, though the dropped-handoff case feeds I1. |
| 16: serial-deadlock suspicion at `registry-group-mls.ts` ~257 | Minor. Unreachable through documented composition (Minor 5). |
| 14b M1: deterministic retry unbounded | Still minor. Backoff is capped and `failed` events are surfaced, except the silent cases in Minor 1. |
| 14b M5: settleRecovery silent id mismatch | Still minor: unreachable, because `reconcile` rechecks the id under `runSerial` first. |
| 14b M6: head-only keeps position; M7 not-accepted restart test | Still minor. |
| 14b: custom settle ignoring the floor | Minor 3: make the parameter required. |
| 14b: group without ledger-head extension defers walks forever | Still minor. Identical to HEAD `pullCommits` gating (`ebdda50` `peer.ts:2041`). |
| 14b: recoveryOnly external walk/search throws; built-branch save lacks post-await hold recheck | Still minor. |
| 18: live-safety witness awaits reportFork; restart-floor witness bypasses peer forwarding | Still minor: test-only. |


## Declined to judge (final reviewer)


- **Signed floor inflation by a removed-after-origin signer.** It would strand a group permanently, with no escape before 2.2e. This is an explicit user-accepted residual (D4), outside the hub threat model.
- **Fork detection and checkpoints.** Deferred to 2.2e by user decision.
- **Busy-group accepted-unadoptable churn.** An accepted liveness residual (D4).
- **Legacy unadopted records stopping until 2.2e.** Accepted compatibility cost (D6).
- **Codec, trust projection and GroupInfo framing internals.** These had clean per-task reviews with mutation checks. I did not re-derive RFC 9420 framing.
- **8b responder dry-run budget and signing details.** Reviewed in three lane-B rounds. I only checked the requester-side call (`peer.ts:4229-4252`).


## Re-review residuals

### New Critical/Important

None. One new Minor: R1 above, where soft-hold clearance at settlement relies on the strand gate.

**Verdict:** C1 and I1 are addressed. The branch is ready to merge from this review's standpoint, with R1 tracked as a minor.

## Rulings (ledger, verbatim)

- Task 1a: Ruling: implementer asked whether invariant tests belong in additive 1a — 1a adds pure helpers in rpc src/recovery-types.ts (captureHead validation, defensive source/origin copies, assign-once switchMutationID, nondecreasing floor) with unit tests; store wiring lands in 1b/6b/14b — cost if wrong: helpers unused/relocated later
- Ruling: task reviews = sol high on every unit; add parallel Sonnet blind reviewer on high-risk units (5a-5e, 7, 8b, 14b, 16) — cost if wrong: missed test-structure defects on other units, caught by final Opus review
- Task 1a: Ruling: review F2 (six brief-listed files without hunks) — audit-only closure accepted: additive optional declarations need no store/double/peer/retired hunks; 1b owns store+double wiring, 6b readers — cost if wrong: 1b gate surfaces missing wiring
- Task 1b: Ruling: rpc-conformance double cannot import rpc helpers (no dependency; mirrors are independent by design) — double re-implements floor-raise/settlement-union/defensive-copy independently, may be stricter never more permissive — cost if wrong: duplicated logic drift, caught by conformance contract
- Task 2: Ruling: HPKE open failure stays 'not-for-me' (null reply) exactly as HEAD recovery.ts:518-523 — wire rejection and backend failure inside hpke.open are indistinguishable under the ts-mls contract; 'provider/policy I/O retains error identity' covers trust/policy/registry/binding readers, signature verification and provider construction OUTSIDE hpke.open; no crypto.ts change — cost if wrong: custom-provider HPKE backend fault looks like non-delivery (D0-consistent, bounded retry)
- Task 2: Ruling: S-I2 controller-less signer eligibility must match legacy recoverySignerEligible (false) unless spec says otherwise — parity with HEAD verdict rule — cost if wrong: controller-less verdicts refuse (fail closed)
- Task 5a: Ruling: accept 2 extra files (control-search.test.ts, peer-rejoin-record.test.ts) outside the 20-file closure — both migrate past-divergence setup/expectation only; own/search/version rows untouched — cost if wrong: later-owner tasks see a pre-migrated row
- Task 5a: Ruling: blind M1 (unbounded onStrand per divergent frame) deferred to final review — one callback per hub-sent frame is proportional, not amplification; hub can already flood frames; non-delivery/DoS-by-volume accepted in threat model — cost if wrong: host callback flood, fixable by epoch+digest dedupe
- Task 5b: Ruling: accept 3 extra test files (peer-control-settlement, peer-durable-effects, peer-safety-startup) — fixture/assertion migrations off delivery-derived halts, required by full rpc gate — cost if wrong: a dropped halt-coverage row, caught in review
- Task 5b: Ruling: reject blind I2 (superseded ignores copyMismatch) — superseded requires committedWinner = locally MLS-applied winner at exact position/digest, applied state not hub bytes — cost if wrong: a lost verdict after a tampered copy under hub CAS violation
- Task 5b: Ruling: blind I1 (unbounded republish on any unknown) accepted as Important — self-amplifying log growth, DoS primary threat
- Task 5b: Ruling: accept R1 (republish-once-per-head set lost on peer recreation; one extra identical copy per restart under hub replay of altered copy) — findings brief authorized in-memory tracking with bounded restart; hub cannot force restarts so no hub-driven amplification; durable fix needs control-store schema/port change — cost if wrong: log growth proportional to host restart count; revisit in final review
- Task 5c: Ruling: upgrade-required = additive optional diagnostic: 'upgrade-required' on StrandObservation, emitted with kind 'unknown-version' via emitStrand (no episode); +1 file peer-types.ts — spec r19 lines 42/58/164 name a distinct upgrade-required host diagnostic — cost if wrong: one optional field to rename
- Task 5c: Ruling: accept extra file standalone-helpers.test.ts (byte-0 malformed fixture now unsupported-version; migrated to byte 1) — cost if wrong: one fixture
- Task 5c: Ruling: reject sol I1 (own named-entry copy with altered sealed-entry version gets 5b retryHead) — saved own payload authoritative; differing own copy is a tampered copy, 5b's one republish per head applies; version poison rule targets foreign/unknown authorship — cost if wrong: one identical republish per head and an own-copy instead of upgrade-required diagnostic
- Task 5c: Ruling: accept Sonnet I1 (first-valid/superseded past a skipped earlier unknown-version same-epoch frame) — hub-flippable version byte could make us adopt our commit over the true winner: fork
- Task 5c: Ruling: accept residual — one hub-planted unsupported same-epoch frame keeps acceptance unknown for that search (no hold); liveness only, equivalent to hub non-delivery accepted in threat model — cost if wrong: an op unresolved until epoch advance/deadline unknown
- Task 5d: Ruling: keep host commitPolicy throws propagating (blind minor 2) — only authenticated members can craft commits; same policy runs on the real apply path so a throwing policy is a host bug either way — cost if wrong: backoff-retry loop on a member-crafted commit until host fixes policy
- Task 5e: Ruling: blind minors 1/2/3/5 not fixed — 2 and 3 are brief-mandated (hold before catch-up; lag suspends enforcement), 1 is HEAD-equivalent liveness, 5 conflicts runtime-neutral — cost if wrong: forged far-future frame held while hub reports a gap; deferred to final review
- Task 5e: Ruling: second consecutive round where a fix opened a new hole -> root cause = round-2 detachment of non-durable handlers (scope creep beyond N1). Revert it to d8b5958 inline-awaited semantics; keep N1 observer notice + N2 generation fence. Handler/host-callback re-entry into peer serial ops (handler awaiting resync; readEvidence/prepareBuild/adopt/deliverWelcome callbacks) is a PRE-EXISTING constraint, deferred to final review — cost if wrong: host code awaiting resync inside a retained handler deadlocks (already true for explicit drains before 2.2d)
- Ruling: gate gap — every task touching packages/rpc must also run full mls-rpc suite (runtime-neutral guard lives there) — cost if wrong: none
- Ruling: under parallel lanes, full mls-rpc gate may use --maxWorkers=4 --testTimeout=30000 — machine load from two concurrent lanes, not regressions; isolated reruns required for any timeout — cost if wrong: a real slow-path regression masked
- Task 6: re-review fix1: I1 NOT fully addressed (binding event payload k/ka bytes and a bigint collide; unknown props unpoliced). Ruling: bytes/bigint only at schema-typed positions, plain JSON elsewhere, digest format unchanged — cost if wrong: genuine-trust digest drift (pinned by test). fix round 2/5 dispatched (sol xhigh)
- (lane B) Task 8b: sol review I1 (copied commit at same position replaces authenticated refusal; position-only response replace); blind Sonnet approve + M1-M3. Ruling: fix I1 + M2 (authority only for genuine MLS/policy rejection, never faults) + M3 + M1 in round 1 — cheap, M2 is a provenance mislabel. fix round 1/5 dispatched (sol xhigh)
- (lane B) Task 8b: re-review fix1: I1/M1/M2/M3 ADDRESSED; new I2 (position veto skips genuine applicable commit). Ruling: hub position is not ownership; key response outcomes by (position,digest), remove veto, bound per-position rows; ControlStore contract change -> both contract families real+doubles — cost if wrong: store format churn before 2.2e. fix round 2/5 dispatched (sol xhigh)
- Task 6: re-review fix3: I1a/b/c RESOLVED; fresh projection, genuine-digest compat, legacy OK. Residual I2 (Proxy-virtualised reflection/iterators can make inspected vs projected disagree). Ruling: exotic in-process objects (Proxy) out of threat model — trust reaches the digest only from the persistence codec (never yields Proxies) or the local producer; an actor who can plant Proxies already runs code in-process; no runtime-neutral brand check for Proxy exists — cost if wrong: in-process caller could digest-launder trust it already controls. M1 (projection exceptions leak TypeError/raw Error) fixed by controller in 2269826 (RED verified, focused 98/98, types, lint).
- (lane B) Task 8b: re-review fix2: I2 ADDRESSED, I1 holds; R1 pre-existing amplifying storage DoS (one genuine refused commit relayed at fresh positions -> unbounded rows). Ruling: fix in 8b — digest dedupe per epoch + total row budget, no-evict overflow = advisory silence — cost if wrong: another store contract churn. fix round 3/5 dispatched (sol xhigh)
- Task 7: re-reviews fix1: all 7 ADDRESSED (sol), Sonnet approved. Ruling: controller-less captured verification keeps legacy judge parity (confirmed via tuple+tag; refused needs origin signer-tree membership); Task 2 ruling covered eligibility only — cost if wrong: controller-less recovery accepts tag-bound confirmations as before. fix round 2/5 dispatched (C1 + M7, sol high)
- (lane B) Task 8b redesign: sol 3 Important (I1 unbounded dry-run work, I2 no inbound frame size limit, I3 cursor keeps unbounded sequenceID) + Sonnet F1 (=I1, root: confirmation frame position/digest/commit unsigned, hub replays one signed ask with junk), F2 legacy refused row epoch steers pruning, F3/F4 minor. Ruling: requester signs (groupID, requestID, position, commitDigest) per ask, verified before hashing; cheap epoch check before state copy; in-flight dedupe + global bound, excess silent; inbound frame size limit; fetched position length limit (64) advisory; prune from applied rows only — cost if wrong: wire change to ask. redesign fix round 1/5 dispatched (sol xhigh)
- Task 9: BLOCKED (sync createRegistryGroupMLS vs sync sendAdmission vs async registry.access that restores private state). Ruling: constructor becomes async Promise<GroupMLS>; validate params (sink TypeError) before any await; initial cached SendAdmission from registry entry/control/safety reads + trust installed epoch without private restore; null/corrupt -> admissible:false existing reason; cache follows access open, safety subscriptions, admission changes — spec r20 edit staged (commit with Task 9; pre-commit types fail on RED tests) — cost if wrong: callers await construction. Resumed (sol xhigh)
- (lane B) Task 8b redesign re-checks: Sonnet F1-F4 ADDRESSED (minors R1 epoch precheck after runSerial+reconcile, bounded by 8; N1 oversized position rejects whole page; N2 publish asserts position after hub accepted). sol: all ADDRESSED except I3 progress: one oversized sequenceID rejects the whole page, blocking later valid commits while the hub keeps serving it. Ruling: accept as non-delivery — only a misbehaving hub serves >64-char positions (honest hub never does), and a hub can already withhold pages; threat model accepts non-delivery; no durable state grows — cost if wrong: a buggy hub implementation stalls a group until fixed. N2 deferred minor (publish ack beyond limit = lost ack, own-commit search recovers).
- Lane merge: started merging feat/spec-p-phase-2 (caa0b11) INTO lane B worktree (--no-ff --no-commit; 3 conflicts mls.ts, rpc-conformance group-mls.ts, host-boundary.ts); sol resolving + full gates. Ruling: merge (not rebase) — one resolution, keeps lane B history; then fast-forward feat/spec-p-phase-2 to the merge commit before Task 12 — cost if wrong: merge commit in history
- (lane B) Re-merge 2008865 into lane B: 14ba691 (clean auto-merge; build+types OK; mls 1008, mls-rpc 3677, rpc 1819 pass). feat/spec-p-phase-2 fast-forwarded to 14ba691; lanes unified. Ruling: lane A continues single-lane from 14ba691 — both lanes done, no parallel work left before Task 12 — cost if wrong: none.
- Ruling: buildRecoveryCandidate takes `sealed: Uint8Array` instead of parsed `reply` and authenticates it under source trust itself, storing those exact bytes as attestedReply — one authentication point, parsed reply never detached from its attestation (applied-state-over-hub-bytes) — cost if wrong: one signature change. Spec r21 8bd8b54.
- Ruling: factories take `environment: CapturedRecoveryEnvironment = RecoveryEnvironment & { accept: RecoveryAdoptionDependencies['accept'] }`; onAccepted narrows expected to RegistryRecoverySource inside mls-rpc then delegates to environment.accept; registry constructor passes its injected accept; plain constructor without recoveryAdoption never reaches the factories — cost if wrong: one environment type. Spec r21 8bd8b54.
- Ruling: controller-less (standard) captured candidates bootstrap their ledger AFTER the switch, as legacy does (rejoin.ts bootstrapLedger after adopt; spec "Compute reenact after destination bootstrap"). Verifier standardCapture branch accepts candidate.ledgerTokens empty (incomplete, isLedgerComplete false, bootstrapLedger head-checks later) OR a ledger reproducing the authenticated head; any other non-empty ledger refuses `candidate`. Reply ledger must stay empty. Candidate built from captured reply starts with empty ledger, never the retained-trust ledger. ledgerBefore remains the obligation union for reenact. Task 14b must run destination bootstrapLedger after the captured switch before reenact — why: pre-switch completeness was an implementer ruling not in spec; incomplete-ledger handles already cannot fold rosters/judge commits until head-verified bootstrap — cost if wrong: a pre-switch gather step added to 14b.
- Ruling: I2 rejected — every existing reconcileCommits caller (peer.ts ~628, ~830, ~1287) fetches under runSerial; the brief's "no network I/O under ownership" means the group ownership gate, which capture releases before sealing/publishing. Restructuring the walk to fetch outside the lane is new design for all sync paths — cost if wrong: capture blocks other serial ops for one bounded walk, same as ordinary sync. Deferred minor: capture walk under a hub serving endless full pages is bounded only like ordinary sync.
- Ruling: option 1 — once the unhooked fence has settled (or after process restart, which ends every prior transaction in a local transactional store), a fresh registry Read showing the source still confirmed with that switchMutationID, no adopted record, no spent candidate and no destination initial identity counts as explicit rolled-back proof for that ID; the existing restricted same-ID switch (CAS on the confirmed record) may then retry the identical candidate/proof/ID after origin/target checks. Applies on startup and after unhooked uncertainty. Any other combination stays pending/terminal; accepted X, ledger and obligations always preserved — why: a CAS-guarded same-ID write cannot apply twice, and a settled local store has no hidden in-flight transaction; option 2 adds schema for no safety gain; option 3 strands every crash between confirm and switch — cost if wrong: a provider with detached in-flight commits across restart would need option 2's durable attempt marker. Spec r22 29dbf31.
- Ruling: blind I1 (onConfirmedRecovery has no production caller) is Task 14b activation scope — carried to 14b brief; blind I3 (terminal stop after source peer stopped leaves group stopped across restarts) is the coordinator table's specified behaviour (stop with diagnostic, preserve X; manual 2.2e) — fix only ensures the diagnostic surfaces — cost if wrong: an extra restart path in 14b. Blind I2 -> F3, I4 -> F4, start-failure leak -> F5. Deferred minors: GroupStateUncertainError conflation, start returning silently without peer, dropped handoff leaving failure set, unused settleAcceptedRecovery option (14b), unbounded retry count without surfaced state, unconfirmed serial-deadlock suspicion via registry-group-mls.ts ~257 switchIncarnation.
- Ruling: reuse the spec's existing settledRejoins cumulative row — discard writes provenance {kind:'not-accepted', epoch: authenticated recapture epoch} with ledgerBefore unioned, clears the active rejoin and raises recoveryEpochFloor in ONE ControlStore transition; Y's first save unions every settled obligation; later accepted settlements replace provenance and keep the union — why: spec already defines this row as the cumulative obligation carrier for accepted-unadoptable X; one discriminator beats a new carrier, and deferring deletion would leave X active across policy refusals — cost if wrong: one provenance arm in codec/conformance. Spec r23 04a6ced.
- Ruling: confirmed/adopted X + authenticated later leaf absence settles as accepted-unadoptable (saved confirmation epoch, X's own leaf digest), floor raised, then fresh Y — spec line 82 says confirmed X retains accepted settlement; returning current stalled forever — cost if wrong: provenance kind change in one branch + test.

## Deferred-minor ledger lines (verbatim)

- Task 1a: minor (deferred): validation timeouts under default worker load (report :369)
- Task 2: minor (deferred): S-m1 RecoveryTrustInputs.ledger unread; S-m2 authenticator snapshot before await relies on owner gate; S-m6 regex isolation; S-m7 bare toThrow
- Task 5a: complete (commits 3366378..cabf6ad, review clean after 1 fix round). Deferred minor: crash-test replay may race a non-PeerDisposedError disposal error (fails loud, not masking)
- Task 5b: blind M4 (own-unmerged skip relies on later ahead-heal) and M5 (acceptance-unknown hold stalls new intents until land/epoch advance) accepted as brief-mandated; deferred to final review
- Task 5c: blind M4 (diagnostic volume) deferred per 5a ruling
- Task 5c: deferred minor: search keeps fetching after first unsupported frame (bounded by maxFetches/maxFrames)
- Task 5d: deferred minors: openEntries non-tag crypto error -> resolver untested; ownVerification rejected-promise cache comment
- Task 5d: deferred minor: registry-safety-admission bad-blob witness bypasses validateFrame (calls openEntries directly)
- Task 5e: fix2 re-review: N1 N2 ADDRESSED; new R1 Important (cursor passes uninvoked deferred handlers: event loss on handover), R2 Important (no backpressure: unbounded memory)
- Task 5e: deferred minors: reset-skipped queued retry waits for next takeHead/pull (self-healing); scheduleDrain skip on hold clears retryRequested; pruned notice now async-ordered
- 5e clockfix: Sonnet review ADDRESSED, no crit/imp; deferred minor: clock.ts comment on freeze-after-backwards-jump
- (lane B) Task 8a: complete (commits 5dff789..5b26536, sol review approved clean; deferred minor: grouped real gate timeouts under contention)
- Task 7: Sonnet re-check fix2 APPROVED. Deferred minors: controller-less captured replies accept any origin-tree signer (legacy parity, broader than verdicts); M7 no registry-level malformed-key test (safe mapping); controller-less replyLedger.length===0 untested alone.
- Task 12: blind Sonnet review: 0 Critical, 1 Important, 6 Minor. Triage: blind I1 (empty-ledger candidate before bootstrap) = Task 14b scope per prior ruling, carried to 14b brief. M2 promoted to Important F1 (reconcile trusts recaptured GroupInfo tree/epoch without MLS signature/tree-hash verification — applied-state principle). M3 promoted F2 (corrupt record loops as retry). Q6 test gaps F3. Deferred minors: M1 head-only backwards replay (DoS), M5 WeakMap binding state per environment object, M6 async post-close rejection in captured host-boundary wrappers, memory double lenient on signer eligibility (unexercised by conformance).
- Task 16: blind re-check of ba0fa7e: 0 C, 2 I (deterministic decode/owner/restore/auth failures still retry forever; recovery-only host paths dropAppFrame/reconcileCommitPrefix/abandon reach private MLS, abandon can delete confirmed X), 5 M. Q1 confirmed: retry cannot switch while earlier source work runs (stopPeer awaited outside slot; matchSource backstop). Q4 confirmed: 2 surviving conjunct mutations logically redundant. Deferred minors: post-timeout hook drain rejection swallowed; start finally masks error; mls dispose cleanup no-op for real adapters.
- Task 14b: implementer NEEDS_CONTEXT (leaf-absent discard of unconfirmed X loses ledgerBefore before Y exists; options: separate carrier vs deferred atomic X->Y replacement).
- Task 14b: fix round 1/5 (F1 hold recheck after recapture, F2 confirmed leaf-absent stall, F3 isLedgerComplete in walkCommits/searchControlLog/finalizeBootstrap, F4 test bite, F5 backoff scope, F6 settle sink required). Deferred minors: blind M1 deterministic retry unbounded, M4 acceptance-unknown hold blocks registry settle, M5 settleRecovery silent id mismatch, M6 head-only keeps position, M7 not-accepted restart test.
- Task 14b: complete (commits 4c8f4a7..96ccbab, main 274b507 + fix 96ccbab; blind re-review F1-F6 addressed, 0 new C/I). Deferred minors: custom settleAcceptedRecovery ignoring 4th floor arg writes lower floor; group without ledger-head extension defers walkCommits/searchControlLog forever (same as pullCommits); recoveryOnly external walkCommits/searchControlLog throw RecoveryRequiredError; built-branch save after searchLog hit lacks post-await hold recheck (pre-existing).
- Task 18: complete (commits 96ccbab..d35959a, sol approved 0/0/2). Deferred minors: live-safety witness awaits reportFork (not pre-write isolated); restart-floor witness calls reconcileRecoveryCapture directly, bypassing peer floor forwarding.
