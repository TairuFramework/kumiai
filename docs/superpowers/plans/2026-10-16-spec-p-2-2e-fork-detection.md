# Spec P 2.2e Fork Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans for approved implementation. Track tasks with checkboxes.

**Status:** APPROVED 2026-10-16 (revision 3 + controller addenda A1–A4). DN1–DN5 and R1–R10 applied; R6–R10 supersede
conflicting R1–R5 wording. Task 0 records the normative amendments in Spec P r24.
**Goal:** Detect forks without interrupting groups, report abandoned work, and provide explicit recovery, migration and halt-clearing controls.
**Architecture:** Installations capture sealed roster facts and publication debt atomically. An independent checkpoint worker publishes and compares signed statements.
Durable notices carry evidence without controlling MLS continuation. Existing captured recovery follows the hub log, with separately authorised manual actions.
**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, existing noble cryptography, transactional memory persistence.
**Spec:** [Approved design](../specs/2026-10-16-spec-p-2-2e-fork-resolution-design.md), [checkpoint format/storage reference](../specs/2026-10-14-spec-p-fork-checkpoints-design.md), [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md), r23 body → r24 in Task 0.

Baseline: `feat/spec-p-phase-2`, HEAD `1a36349`. Existing file coordinates refer to this HEAD.
Authority, highest first: `.superpowers/sdd/plan-2-2e-draft/rulings-r3.md` (R6–R10), `rulings-r2.md` (R1–R5), `rulings.md` (DN1–DN5), approved design, applicable checkpoint reference, Spec P r23.
Review inputs: `.superpowers/sdd/plan-2-2e-draft/{rereview-opus,rereview-sol}.md`, then `{review-opus,review-sol}.md`.
Carry-forwards remain applicable where those authorities agree.
The design header's approval wording and Spec P's r20 header are stale. The brief supplies approval and r23 authority.
Inventory: `.superpowers/sdd/plan-2-2e-draft/inventory.md`.

## Global Constraints

The following sentences and values are copied from the binding design or applicable reference:

- “The hub is blind: one append-only log per topic, CAS on head, opaque bytes.”
- “Non-delivery is accepted and undetectable in-band.”
- “No single peer may roll the group back or steer it.”
- “Consequences: checkpoints never pick a winner, never halt, never switch. There is no fork handler and no ranking.”
- “Any checkpoint, frame or hub-delivered byte causing a halt, discard, rebuild or stranding.” is an anti-goal.
- “The hub `authorize` hook gates the checkpoint topic exactly like the commit topic.”
- “The only transport worker uses `deriveTopicID(configuredRecoverySecret, 0, 'kumiai/checkpoint/v1')`, with empty scope.”
- “Publish unconditionally with `retain: 'log'`, without `expectedHead`. Subscribe before draining and request seven days.”
- “Verification uses strict Ed25519 (`zip215: false`). Other signature algorithms require a new checkpoint version.”
- “Maximum complete frame: 4,096 raw bytes.”
- “Publish once for every eligible installation. Drain at one checkpoint/second, burst eight, without coalescing retained unsent installations.”
- “An eligible online member republishes its exact current checkpoint every 30 minutes with ±20% jitter and a fresh heartbeat publishID.”
- “Retry exponentially, capped at 15 seconds, within the same rate budget.”
- “Receive at most 32 frames, 128 KiB and 64 signature checks per turn. Release the owner gate between turns.”
- “Current counts towards the newest 256 installations across the group.”
- “Superseded facts expire seven days after local supersession or outside those newest 256 installations, whichever occurs first.”
- “Remote input never induces new signing.”
- “Seal group-level `checkpoints` records with null incarnation in AAD and GroupKey inside the value.”
- “No fixed history byte cap silently truncates rosters.”
- “If sent plaintext is not retained, report message IDs and the app resends from its copy.”
- “Nothing is copied. The app may clear the tombstone explicitly.”
- “failure leaves the prior state and any halt intact.”
- “No forced resync.”
- “Undeclared backup restore (outside the model, spec D1).”

Operational constraints: pnpm only, `rtk proxy`, no generated-file edits, no new dependencies, scripts, configuration or version changes.
Keep internal `workspace:^` and external catalogued published `^` ranges. Use existing runtime-neutral owner/coordinator boundaries.
Release ownership before network work and notifications. Only proven commits release events, routing changes or destination peers.
A double may be stricter than its port, never more permissive. Preserve owed outcomes, Welcomes, certified settlements and source history.
Ordinary store callers cannot lower floors, clear safety records or fabricate installation provenance.
Do not import MLS implementation types into rpc or implementation helpers into independent conformance mirrors.
Phase 2.3 application crypto/batching/leases/package burn/restore work and phase 3 providers remain excluded.

Binding amendments from `rulings-r3.md`, then `rulings-r2.md`, supersede conflicting design and DN wording:

- DN1: Call-time resync uses `target: {targetID, hub, commitTopicID}`. Persist only targetID and sealed commitTopicID.
  The existing `resolveTarget(targetID)` reconstructs that exact binding. Unresolved attempts stay visibly paused without fallback.
- DN2 + R1: Former-member disclosure requires the requester's DID **and key hash** in the responder's retained earlier roster.
  Replies bind the request, signed public tree, authenticated role-ledger head/entries and responder lineage. They disclose no secrets or messages.
  R6 freshness: same lineage at the newest common retained epoch requires reply epoch > our latest installed epoch.
  Different lineage at any retained epoch needs no epoch-number condition. Unequal authHash or authenticated confirmedTranscriptHash establishes that difference.
  `not-member` is NON-terminal and diagnostic only (R8). Require eligible signing, verified head/tree/ledger and own-DID absence.
  Admission retains existing stranded/hold rules. Recovery continues at capped backoff.
  Any successful install, head-only reconcile or re-anchor clears the condition. Failure or pending proof never clears it.
  Status/events carry responder keyHash, epoch, local observedAt and distinct responder DIDs/count. Status retains optional pendingReason (R9).
  Emit once per new evidence, with notice-style coalescing. Advise apps against disposal/deletion on first evidence.
  Apps can wait for another responder DID or persistence. App policy owns disposal, deletion and re-invitation.
- R2: Automatic floor lowering requires an open notice with other-branch hash at E, attested by an eligible, non-equivocating signer.
  The recovery reply must carry its signing key's signed checkpoint at E, matching that hash and differing from our fact at E.
  That reply signer must occur in our pre-E roster. The authenticated reply lineage must bind the E checkpoint to its offered state.
  Settle saved X of any stage as `{kind:'superseded-branch', epoch:E}` in the cumulative row. Union all obligations and retain exact saved history/outcomes.
  R7: Retained local facts also store installed GroupContext.confirmedTranscriptHash. Checkpoints never publish that field.
  Require offered GroupInfo epoch F >= E. Within retained coverage, its confirmedTranscriptHash must differ from our fact at F.
  Below the oldest retained fact, refuse with `'target-behind'`. A hole within the retained range grants no exception.
  Recheck E-lineage and MLS transcript binding for every capture while Y carries forkRecovery, including retries and restarts.
  Atomically settle X, clear its pointer and persist Y's bound attempt intent. Only that attempt gets effective floor E.
  Keep the ordinary control floor unchanged. Settlement or abandonment of Y removes its exception. Never infer `not-accepted`.
  Without all preconditions, preserve X/floor and retry with `'target-behind'`. Checkpoint intake alone cannot execute recovery transitions.
  No distinct-DID threshold applies. Deliberately forged coherent GroupInfo plus checkpoint chains remain an accepted insider residual.
  Peers are trusted in intent. Such fake Y cannot be confirmed by honest members and affects only the attacker's fake state.
- R3: A current move requires no hard hold, condition, open notice or active rejoin, alongside the local freshness checks.
  `recover({... , allowOpenFork:true})` overrides only the open-notice check. Otherwise rejoin through responders on the selected destination.
  Same-key movement preserves holds and refuses while held. A completed rejoin creates a fresh incarnation without source holds.
  Hard-held responders never serve recovery replies. If every device is halted, successor mode supplies the exit.
  Partial migration can create an undetectable cross-hub split. An ahead arrival stays pending with `'target-behind'` unless R2/R7 applies.
- DN3 + R4: Journal own-send IDs per epoch prospectively. Store only per-epoch counts for others, never per-received-message rows or plaintext.
  Reports declare complete/partial coverage. Ephemeral sends remain unpersisted and uncovered. Unknown ancestry reports range `'unknown'` without delaying the switch.
  Bound evidence by 256 installations / seven days after supersession, even while unacknowledged. Acknowledgement never extends those bounds.
  Closed evidence expires at the earlier of acknowledgement-plus-seven-days and its checkpoint bounds. Unacknowledged summaries retain explicit coverage gaps.
  R4 removes DN3's former unacknowledged-evidence exception. Replays cannot refresh installation identities or supersession clocks.
- R9: Recovery requests carry comparisonEpoch: split E for fork recovery, otherwise the newest retained epoch.
  Send only signed lineage frames from that epoch through offered F. Keep complete replies within 786432 bytes.
  Expired fork evidence leaves automatic healing target-behind. Explicit manual resync supplies the exit.
- R4: Dedupe roster replies per responder/requestID and share existing bounded recovery admission/suppression budgets.
  Distinguish `'no-reply'` (nothing received) from `'no-eligible-responder'` (received replies, none eligible). Neither proves removal.
- DN4: New ForkHalt records identify `producer: 'app-report' | 'internal'`. Only matching app-report provenance permits clearHold.
  Legacy records remain uncleareable through clearHold. Successful manual rejoin retires their source. Event IDs never imply ownership.
- DN5: Unreadable combined trust envelopes remain recovery-unavailable. Decrypted missing/malformed spent sets produce spent-set-corrupt.
  Projection precedence remains hard safety holds > spent-set-corrupt > not-member > recovery-unavailable > pending.
  Precedence never converts non-terminal not-member into a hard hold or cancels recovery.
- R5: Checkpoint detection includes the real split witness. Absence and floor tasks immediately follow the checkpoint core.
  Each behavioural task owns its real witnesses, conflicting assertion migrations and exhaustive host-boundary entries.
- R10: Task 11 owns real MLS dependency/adapter wiring, both real port runners and transcript checks through those adapters.
  Registry-owned facts/frames reach ordinary sealing. Hosts cannot inject signing, disclosure or floor authority.

## Review Focus

- An advanced losing device is absent from a lower continuing branch. Task 10: `advanced losing device removed on continuing branch surfaces not-member`.
- A retry after X settlement offers our old lineage. Task 11: `retry after settlement cannot accept own lineage capture above E`.
- Real adapters must supply authority and bounded v3 lineage. Task 11: `real adapters heal no X and saved X without capability replacement`.
- A held or diagnosed device reaches an empty migration target. Task 16b: `current move refuses every hold condition notice and active rejoin`.
- A warmed registry observes decrypted empty spent data. Task 18: `warm observation persists spent corruption across restart`.

## File Structure

| Boundary | Files and responsibility |
| --- | --- |
| MLS checkpoint crypto | New `packages/mls/src/checkpoint.ts`, `checkpoint-codec.ts`, `checkpoint-types.ts`: canonical hashes, facts, strict signatures and standalone verification. |
| Portable rpc checkpoint surface | New `packages/rpc/src/checkpoint.ts`, `checkpoint-types.ts`, `checkpoint-worker.ts`, `fork-notice.ts`: opaque port, worker and notification fold. |
| Group-level sealed records | New `packages/mls-rpc/src/checkpoint-store.ts`, `checkpoint-capture.ts`, `checkpoint.ts`, `branch-history.ts`, `manual-recovery.ts`: ownership-bound storage and actions. |
| Existing installation/recovery | `packages/mls-rpc/src/registry/{access,seed,switch,trust,registry,runtime,safety,retired}.ts`, `registry-peer.ts`, `recovery.ts`, `mls.ts`, `registry-group-mls.ts`; extend transitions and wire private authority/lineage. |
| Restricted safety changes | `packages/rpc/src/control/{safety,types,store}.ts`; new `packages/mls-rpc/src/clear-hold.ts`, `safety-conditions.ts`, `successor.ts`. |
| Contract suites | New `packages/rpc-conformance/src/checkpoint.ts`, `fork-notice.ts`, `manual-recovery.ts`; extend existing independent storage/safety/registry mirrors. |
| Hub boundary | Extend `packages/hub-conformance/src/{index,log-hub}.ts`; add authorisation contract fixture and real server runner. No server MLS awareness. |
| Integration | New checkpoint, abandonment, migration and group-condition tests under `tests/integration/test/`, using real MLS and conforming hub views. |

Tasks declare implementation, mirror and fixture closures. Task 3a inventories direct installation writers before mandatory capture activates.
Its mechanical migration exceeds 20 files and has a separate green gate. No universal under-20-file claim applies.
Additive capabilities land before activation. Existing unavailable manual modes become usable only in their owning tasks.

## Interfaces shared by tasks

These are planned signatures, not existing APIs. Types without an import location below belong to the named new file.
`GroupKey`, `ControlSnapshot`, `LogPosition` and `CapturedRejoinRecord` retain their existing rpc meanings.
Byte-returning APIs always return defensive copies. Canonical fact bytes are local-only.
Encode fact confirmedTranscriptHash as canonical unpadded base64url of the installed MLS bytes, without rehashing.
An empty genesis transcript encodes as the empty string. Never substitute authHash or publish this field in checkpoint frames.

```ts
// mls/src/checkpoint-types.ts -- structural key, no upward dependency on rpc
type CheckpointKey = { groupID: string; incarnation: number }
type EpochCheckpointBodyV1 = {
  v: 1; type: 'kumiai/checkpoint/v1'; groupID: string; genesisHash: string
  ciphersuite: number; epoch: number; authHash: string; parentAuthHash: string | null
  keyHash: string; leafIndex: number
}
type CheckpointMember = {
  signerDID: string; keyHash: string; leafIndex: number; signaturePublicKey: string
}
type EpochRosterFactV1 = {
  v: 1; key: CheckpointKey; genesisHash: string; ciphersuite: number
  epoch: number; authHash: string; parentAuthHash: string | null; confirmedTranscriptHash: string
  members: Array<CheckpointMember>; installation: { mutationID: string; stateVersion: number }
}
// rpc/src/checkpoint-types.ts -- no MLS imports
type CheckpointComparison =
  | { kind: 'agreement'; epoch: number; signerDID: string; keyHash: string }
  | { kind: 'conflict'; epoch: number; signerDID: string; keyHash: string;
      localAuthHash: string; remoteAuthHash: string; parentAuthHash: string | null }
  | { kind: 'invalid' | 'coverage-gap' }
type CheckpointCoverage = {
  groupID: string; current: { key: GroupKey; epoch: number } | null
  retained: Array<{ key: GroupKey; from: number; through: number }>
  effectiveFloor: number | null
  gaps: Array<{ key: GroupKey; from: number; through: number; reason: 'pre-join' | 'skipped' | 'expired' }>
}
type CheckpointPort = {
  signInstalled(factID: string): Promise<Uint8Array | null>
  compare(key: GroupKey, frame: Uint8Array): Promise<CheckpointComparison>
  exportCheckpoints(key: GroupKey, epochs?: Array<number>): Promise<Array<Uint8Array>>
  checkpointFact(key: GroupKey, epoch: number): Promise<Uint8Array | null>
  checkpointCoverage(groupID: string): Promise<CheckpointCoverage>
}
type OwnBranchMessage = { id: string; epoch: number; authHash: string }
type CoverageGapReason =
  | 'pre-journal-history' | 'retention-gap' | 'unknown-ancestry' | 'ephemeral-uncovered'
type ReportCoverage = { kind: 'complete' } | { kind: 'partial'; reasons: Array<CoverageGapReason> }
type BranchReportCoverage = {
  ancestry: ReportCoverage; ownMessages: ReportCoverage; othersSeen: ReportCoverage
  membership: ReportCoverage; ephemeral: ReportCoverage
}
type AbandonedEpochRange = { from: number; through: number } | 'unknown'
type ForkBranch = {
  authHash: string; signers: Array<{ signerDID: string; keyHash: string }>
  firstSeenAt: number; lastCheckpointAt: number
}
type ForkNotice = {
  id: string; groupID: string; splitEpoch: number; branches: Array<ForkBranch>
  deviceAuthHash: string; detectedAt: number; lastEvidenceAt: number
  atRisk: Array<OwnBranchMessage>; revision: number; acknowledgedRevision: number
  acknowledgedAt: number | null
  coverage: { evidence: ReportCoverage; ownMessages: ReportCoverage; ephemeral: ReportCoverage }
  closedAt: number | null; equivocations: Array<{ signerDID: string; keyHash: string }>
}
type ForkNoticeEvent = { id: string; kind: 'fork-detected' | 'fork-updated'; notice: ForkNotice }
```

`CheckpointComparison` has an equivalent structural result exported from MLS without an rpc import.
Standalone `verifyCheckpointPair` additionally accepts optional `eligibilityRosterFact: Uint8Array` for the shared prior roster.
`localRosterFact` always binds the compared epoch/hash. The eligibility fact never replaces that binding.
The stateful importer chooses both from stored local facts, never from incoming input.
Partial coverage requires at least one reason. Counts and lists under partial coverage describe observed metadata, without claiming completeness.
Ephemeral coverage is always `{kind:'partial', reasons:['ephemeral-uncovered']}`. No durable row records an ephemeral send.
Task 12b defines BranchAbandonedEvent using these exact coverage/range types. Historical gaps never manufacture zero counts or exact branch-only deltas.

Public `ManualRecovery` in `mls-rpc/src/safety.ts` becomes:

```ts
type ManualRecovery =
  | { mode: 'resync'; targetID: string; allowOpenFork?: boolean }
  | { mode: 'resync'; target: { targetID: string; hub: LogHub & MailboxHub; commitTopicID: string }; allowOpenFork?: boolean }
  | { mode: 'successor'; successor: GroupKey }
```

Keep `RecoveryTarget = {id: string; commitTopicID: string; hub: LogHub & MailboxHub}` and
`resolveTarget: (targetID: string) => Promise<RecoveryTarget>` unchanged.
The resolved `id` and topic must match the saved targetID/topic. Failure or mismatch pauses that same authorised attempt.
Persist `allowOpenFork` as explicit app authority. It bypasses only the current-move open-notice predicate.
Coverage uses group-wide installation retention across incarnations. `effectiveFloor` is the earliest ordinary comparable epoch, or null without facts.
Ranges remain incarnation-specific. Gaps include pre-join/skipped epochs and expired installations. Evidence summaries never imply comparable facts.

## Verification commands

Run these functions in a Bash shell at the repo root. They are exact reusable commands, not new repository scripts.
Every task's verification step calls them explicitly. `ktest` pairs each Vitest run with its package typecheck.

```bash
export SWC_NATIVE_BINDING_CACHE=/private/tmp/kumiai-2-2d-swc
ktest() {
  local package_name="$1"
  shift
  rtk proxy pnpm --filter "$package_name" exec vitest run --maxWorkers=4 --testTimeout=30000 "$@" &&
    rtk proxy pnpm --filter "$package_name" run test:types
}
kbuild() {
  rtk proxy pnpm turbo run build:js build:types --env-mode=loose
}
kfinish() {
  rtk proxy pnpm turbo run test:types --env-mode=loose && rtk proxy pnpm run lint
}
kports() {
  ktest @kumiai/mls-rpc test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts test/registry-conformance.test.ts &&
  ktest @kumiai/rpc test/ports-conformance.test.ts test/hub-conformance.test.ts &&
  ktest @kumiai/hub-server test/conformance.test.ts test/log-hub-conformance.test.ts &&
  ktest @kumiai/hub-store test/conformance.test.ts &&
  ktest @kumiai/integration-tests test/hub-log-conformance.test.ts
}
kcontrol() {
  ktest @kumiai/rpc test/control-store-conformance.test.ts test/commit-once-conformance.test.ts &&
  ktest @kumiai/mls-rpc test/control-store-conformance.test.ts test/control-crash.test.ts
}
ksafety() {
  ktest @kumiai/mls-rpc test/control-safety-conformance.test.ts test/safety-conformance.test.ts
}
```

Expected: every selected test PASS, package and repo typechecks exit 0, lint exits 0, no unhandled rejection.
Run `kbuild` before cross-package tests, including each RED run after changing tests that use sibling exports.
Every port/store task runs `kports` and its new contract runner. Any rpc source/test task also runs full `ktest @kumiai/mls-rpc`.
New contract rows must run against both real MLS and independent doubles.
Each new checkpoint/storage/notice/manual runner explicitly enumerates real-mls/double fixture modes and supplied/absent ownership-context modes where applicable.
MLS port contracts run both real runners and the independent rpc double. SQL gates require SQLite/PostgreSQL infrastructure.
Unavailable infrastructure is a blocked gate, never a pass. Re-run any timeout in isolation before diagnosing a regression.
Real behavioural witnesses land in their owning tasks. Keep signing, registry installation, CAS and proof barriers real.
A missing-export RED starts development. Each eventual behavioural assertion must also fail when its owning guard is locally bypassed and restored.

## Controller addenda (final re-review minors)

Binding on the named tasks; from `rereview2-opus.md` m1–m4.

- **A1 (Task 0, Task 20; m1):** document that a continuing-branch head F falling in a retained-range hole (epochs crossed
  by external commit) is refused until that branch reaches a retained epoch or passes our newest; manual resync is the
  exit.
- **A2 (Task 11, Task 20; m2):** `F ≥ E` uses the notice's best-known split. Add test
  `earlier-moving notice re-enables fork recovery authorisation` (head in [S, E) refused, then accepted once the notice
  moves E to S); document manual resync as the exit otherwise.
- **A3 (Tasks 15a, 15b, 16b; m3):** a pending `forkRecoveryAttempt` counts as active rejoin: `activeRejoin` passed to
  `canMoveCurrent` is true and Task 15a's "no slot/rejoin/operation" checks treat it as active. An authorised manual
  recovery abandons Y's intent (removing the exception, per R7) in the same transition that persists the manual
  attempt. Test: `manual recovery abandons pending fork recovery intent`.
- **A4 (Task 0, Task 20; m4):** list `comparisonEpoch` in the rendezvous disclosure surface (cleartext, visible to the
  hub and subscribers, alongside DID and ephemeral key).

## Tasks

### Task 0: Amend Spec P to r24

**Files:** Modify `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md:4,10,32,73,88,111,184,215,223,849,1113,1388,1412,1484,1497`.
**Interfaces:** Consumes approved design, Spec P r23 and all three ruling files. Produces normative r24 text with R1/R6–R10 amendments.

- [ ] **Step 1: Mark contradictory clauses against the design.** Cover Model/D1, manual modes, clearHold, not-member, spent-set-corrupt and floor lowering.
- [ ] **Step 2: Record DN1–DN5 and R1–R10 in normative r24 text and history.** Use these binding amendments:
  **R1 controller change from approved design §4 and Goal 3:** Replace terminal `not-member` and “stop retrying” with a non-terminal condition.
  A signed roster authenticates a responder's view. It cannot prove that the hub kept that branch.
  Require request binding, eligible signer, head/tree/ledger verification and own-DID absence.
  **R6:** Same lineage at the newest common retained epoch requires reply epoch > latest installed epoch.
  Different lineage at a retained epoch has no epoch-number condition. Compare authenticated authHash or GroupContext.confirmedTranscriptHash.
  **R8:** Keep not-member diagnostic only. Admission retains existing stranded/hold rules.
  Continue capped-backoff recovery. Clear on every successful install, head-only reconcile or re-anchor. Preserve history.
  **R9 M-a/M-d:** Surface responder keyHash/epoch/observedAt and distinct responder DIDs/count. Preserve optional pendingReason in status.
  Coalesce new evidence events. Advise apps against dispose/delete on first evidence. Another DID or persistence can inform app policy.
  No roster reply supplies terminal continuation authority.
  **R2:** Add `{kind:'superseded-branch', epoch:E}` settlement provenance and sealed exact-X history for built/published/confirmed/adopted-incomplete stages.
  Require the open notice's eligible non-equivocating other-branch testimony and the reply signer's matching E checkpoint on its authenticated lineage.
  Require reply-signer eligibility in our pre-E roster and inequality with our own E fact. Equivocation-only notices grant nothing.
  **R7:** Capture installed confirmedTranscriptHash in retained local roster facts only. Checkpoint testimony alone grants no exception.
  Require offered GroupInfo epoch F >= E and a different confirmedTranscriptHash from our fact at F within retained coverage.
  Below the oldest retained fact, or within a coverage hole, refuse with `'target-behind'`.
  Recheck offered E-lineage and transcript binding for every Y capture carrying forkRecovery, including after restart.
  Union obligations, preserve unknown/accepted outcomes and exact X, clear X and persist Y's bound intent atomically.
  Effective floor E belongs only to that attempt. Keep the ordinary control floor unchanged. Remove the exception on settlement/abandonment.
  Permit lower/equal-number different-branch captures only under these predicates. Missing evidence preserves X/floor with `'target-behind'`.
  Require no second DID, preserving two-member healing. Accept deliberately forged coherent GroupInfo plus checkpoint chains as outside the intent-trusted model.
  Their effect stays within the attacker's fake state. Honest members never confirm fake Y.
  **R9 M-b/M-c:** Sign request comparisonEpoch, selecting split E or newest retained epoch. Return only that lineage span within 786432 bytes.
  After evidence expiry, automatic healing stays target-behind. Explicit manual resync supplies the exit.
  **R10:** Require registry-owned installed lineage and private authority through real MLS adapters, including per-capture transcript checks.
  **R3:** Define current-move exclusions, persisted `allowOpenFork` scope, same-key hold preservation and hold-free new-incarnation rejoin.
  Hard-held devices do not answer recovery requests. All-held groups require successor mode. Document partial migration and ahead-arrival pending limits.
  **R4:** Require DID+key historical disclosure gating, bounded requestID reply dedupe and shared recovery budgets.
  Store own IDs and other-message counters per epoch. Distinguish `'no-reply'` from `'no-eligible-responder'`.
  Cap unacknowledged evidence at ordinary checkpoint retention. This explicitly supersedes DN3's unbounded pinning exception.
  **DN1:** Persist targetID/topic and the open-notice override. Reconstruct through the unchanged resolver, with visible pause and no fallback.
  **DN2:** Authorise former-member-only public roster/ledger disclosure. Preserve ordinary candidate admission and no-reply for never-seen DID/key pairs.
  **DN3:** Specify prospective metadata, coverage reasons, unpersisted ephemeral sends and unknown-range abandonment without changing established switches.
  Apply acknowledgement-plus-604800000 ms only within the 256-installation/seven-day bounds. Summaries show pruned evidence as partial.
  **DN4:** Require new producer provenance and app-report-only clear. Legacy halts require completed manual rejoin or successor retirement.
  **DN5:** Keep unreadable envelopes recovery-unavailable. Diagnose spent corruption only after successful envelope decoding.
  Record precedence: hard safety holds > spent-set-corrupt > not-member > recovery-unavailable > pending. Preserve non-terminal retry semantics.
- [ ] **Step 3: Amend all affected clauses, interfaces and contract/crash tables.** Include Model, D1/D2, manual modes and cumulative settlement rules.
  Replace out-of-band deferral with detection-only in-band checkpoints. Keep app/internal halts and retained evidence distinct from notices.
  Replace unconditional monotone-floor and no-public-clear clauses with the restricted exceptions. Require bound external confirmation for every rejoin installation.
  Preserve exact saved history for superseded branches, overriding r23's compact-settlement omission rule only for that provenance.
  Describe current movement, target recovery, successor tombstones, clearHold, spent diagnosis and complete comparison coverage.
  R5 requires real/double rows for each changed port and restart seam. Correct the total-loss/successor README ruling.
- [ ] **Step 4: Verify the amendment.** Run `rg -n 'r24|checkpoint|confirmedTranscriptHash|comparisonEpoch|forkRecovery|pendingReason|clearHold|not-member|spent-set-corrupt|ManualRecovery|recoveryEpochFloor|superseded-branch|allowOpenFork' docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md`.
  Expected: r24 header/history, explicit R1 design departure and no contradictory normative clauses. Historical revision notes may describe superseded contracts.
  Match every DN1–DN5/R1–R10 sentence against all three ruling files, applying R6–R10 first.
  Require normative text, rather than only planning-file references. Run `kfinish`.
- [ ] **Step 5: Future commit.** `git add docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` then `git commit -m 'docs: amend persistence contract for fork detection and manual recovery'`.

### Task 1: Define canonical checkpoint crypto and portable verification

**Files:** Create `packages/mls/src/{checkpoint-types,checkpoint-codec,checkpoint}.ts`, `packages/mls/test/checkpoint.test.ts`. Modify `packages/mls/src/index.ts`, `packages/mls/test/authentication.test.ts`.
**Interfaces:** Consumes validated public roster tuples and Ed25519 key material. Produces:
`encodeEpochRosterFact(fact: EpochRosterFactV1): Uint8Array`, `decodeEpochRosterFact(bytes: Uint8Array): EpochRosterFactV1`,
`encodeEpochCheckpoint(body: EpochCheckpointBodyV1, signature: Uint8Array): Uint8Array`,
`decodeEpochCheckpoint(frame: Uint8Array): { body: EpochCheckpointBodyV1; bodyBytes: Uint8Array; signature: Uint8Array }`,
`verifyCheckpointPair(params: { first: Uint8Array; second: Uint8Array; localRosterFact: Uint8Array; eligibilityRosterFact?: Uint8Array }): Promise<CheckpointComparison>`.

- [ ] **Step 1: Add failing vectors and rejection tests.** `canonical checkpoint domains round trip` pins LP/u32/u64/H and exact bytes.
  `frame bound includes every header byte`: `expect(frame.byteLength).toBe(4096)` passes; 4097 rejects before parsing.
  `strict signatures and private signer resolution`: `expect(body).not.toHaveProperty('signerDID')`; non-strict signature variants reject.
  Parameterise duplicate/extra fields, bad UTF-8/surrogates, padded/noncanonical hashes, unknown suite/version, fractional/unsafe epochs and leaf overflow.
  `local facts constrain pair verification`: `expect(result.kind).toBe('coverage-gap')` for missing history; mismatched group/anchor/epoch rejects.
  `local transcript codec preserves MLS bytes` round-trips empty genesis and non-empty transcript bytes without hashing or checkpoint disclosure.
```ts
expect(decoded.body).not.toHaveProperty('signerDID')
expect(await verifyCheckpointPair(nonStrictPair)).toMatchObject({ kind: 'invalid' })
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls test/checkpoint.test.ts`. Expected: missing checkpoint exports/assertions fail.
- [ ] **Step 3: Implement the interfaces.** Use canonicalStringify, existing noble SHA-256/Ed25519 and strict decoding.
  Preserve reference hash/signature domains and framing. Add signed parentAuthHash. Reject ambiguous local key-to-DID resolution.
  Signer leaf indices need not equal local indices. Facts sort DID/key/leaf and reject duplicate pairs/leaves.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls test/checkpoint.test.ts test/authentication.test.ts && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: add canonical signed checkpoint verification'`.

### Task 2: Add sealed group checkpoint storage and portable ports

**Files:** Create `packages/rpc/src/checkpoint-types.ts`, `packages/mls-rpc/src/checkpoint-store.ts`, `packages/rpc-conformance/src/checkpoint.ts`, `packages/mls-rpc/test/checkpoint-storage-conformance.test.ts`.
Modify `packages/rpc/src/index.ts`, `packages/mls-rpc/src/{persistence-types,entry-capability,memory-group-state,memory-group-persistence,memory-rows,index}.ts`,
`packages/rpc-conformance/src/{persistence-fixture,index}.ts`, `packages/mls-rpc/test/fixtures/{storage-persistence,transactional-access}.ts`, `packages/mls-rpc/test/{group-namespaces,storage-codec-reopen}.test.ts`.
**Interfaces:** Consumes Task 1 canonical bytes and GroupKey. Produces CheckpointPort, CheckpointComparison and:
`CheckpointStore.load(id: string): Promise<CheckpointRecord | null>`, `list(): Promise<Array<CheckpointRecord>>`,
`put(record: CheckpointRecord): Promise<void>`, `remove(ids: Array<string>): Promise<void>`.
`CheckpointRecord` lives in rpc/src/checkpoint-types.ts. Its initial union is:
fact `{kind:'fact';id:string;key:GroupKey;epoch:number;canonical:Uint8Array;supersededAt:number|null}`;
publication `{kind:'publication';id:string;key:GroupKey;factID:string;frame:Uint8Array|null;publishID:string|null;accepted:boolean;nextHeartbeatAt:number|null}`;
cursor `{kind:'cursor';id:string;key:GroupKey;topicID:string;position:string|null}`.
`CheckpointFactRecord = Extract<CheckpointRecord, {kind:'fact'}>`.
GroupStores gains `checkpoints: CheckpointStore`; EntryReads gains `checkpoints(): Promise<Array<CheckpointRecord>>`.

- [ ] **Step 1: Add failing shared storage rows.** `checkpoint rows are sealed and group scoped`: wrong group/namespace/record AAD rejects.
  `checkpoint snapshot and transaction roll back together`: `expect(await reopen()).toEqual(before)` after injected side-write failure.
  `unknown proof releases no rows` checks both late commit and rollback. `group checkpoint records survive incarnation retirement` checks null AAD incarnation.
  `prepare and expired capabilities cannot write checkpoints` checks D8 operation locking and group independence.
  `checkpoint metadata needs no private state open` permits safety/intake/history writes with unreadable private state and no fabricated handle.
```ts
expect(await reopenedStore.list()).toEqual(before)
expect(physicalRecord.address.incarnation).toBeNull()
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-storage-conformance.test.ts`. Expected: missing store/capability members fail.
- [ ] **Step 3: Implement sealed stores and independent mirrors.** Register the namespace in scope filtering, prepare snapshots, account validation and fixture byte inspection.
  Copies cannot mutate canonical facts. Generic writes cannot mint installation/signing authority. New storage is initially unused by installations.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-storage-conformance.test.ts test/group-namespaces.test.ts test/storage-codec-reopen.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: add sealed group checkpoint records and contracts'`.

### Task 3a: Prepare capture and migrate direct installation writers

**Files:** Create `packages/mls-rpc/src/checkpoint-capture.ts`, `packages/mls-rpc/test/checkpoint-writer-migration.test.ts`.
Modify `packages/rpc-conformance/src/{group-storage,persistence-fixture,ownership-phases}.ts`,
`packages/mls-rpc/test/fixtures/{storage-seed,storage-persistence,sealed-control-access,codec-reopen,sealed-memory-mls,registry}.ts`,
`packages/mls-rpc/test/{device-persistence,control-build,control-adoption,group-safety,registry-fixture,registry-retirement-writes,storage-fixture,registry-delete,registry-retired,registry-retirement,registry-runtime,registry-cold,registry-safety-admission,group-namespaces,final-review,storage-conformance,ownership-phases-conformance,control-safety-conformance}.test.ts`,
`tests/integration/test/fixtures/fork-halt.ts`.
**Interfaces:** Consumes Task 2 stores. Produces
`prepareCheckpointInstallation(params: { handle: GroupHandle; key: GroupKey; mutationID: string; stateVersion: number; previousFact: Uint8Array | null }): Promise<CheckpointFactRecord>`
and local `prepareCheckpointInstallationFromTrust(params: { key: GroupKey; trust: GroupRecoveryTrust; confirmedTranscriptHash: Uint8Array; mutationID: string; stateVersion: number; previousFact: Uint8Array | null }): Promise<CheckpointFactRecord>`.
The latter takes transcript bytes from the same installed GroupContext, including explicit public context inputs in storage-only fixtures.
GroupRecoveryTrust at HEAD omits this field. Do not infer it from trust or authHash. This helper grants no signing authority.
The independent fixture mirror adds `prepareInstallationCheckpoint(params: { key: ConformanceGroupKey; trust: ConformanceGroupRecoveryTrust; confirmedTranscriptHash: Uint8Array; mutationID: string; stateVersion: number; previousFact: Uint8Array | null }): Promise<ConformanceCheckpointFactRecord>`.
Declare the structural fact-record mirror in persistence-fixture.ts. Inject fixture preparation into shared writers, without importing mls-rpc helpers into contracts.

- [ ] **Step 1: Inventory successful writers and add migration assertions.** Search state/trust/lifetime writes throughout `packages/` and `tests/integration/` with `rg`.
  Classify each site as identity installation, same-identity progress, tombstone, or intentionally invalid guard witness.
  Include control-safety-conformance.test.ts's real-mode adoption callback, which directly writes changed epoch/state/trust.
  Low-level `packages/mls-rpc/test/group-state-persistence.test.ts` exercises raw codec/guard rows, without coordinator installation finalisation.
  `packages/mls-rpc/test/registry-seed.test.ts` forwards saves. `packages/mls-rpc/test/registry-source.test.ts` writes a tombstone.
  `packages/mls-rpc/test/registry-switch.test.ts` marks terminal at unchanged identity. These sites need no fabricated installation capture.
  The Files block lists all reviewed omissions, including writeStorageInstall, codec reopen, direct adoption and combined device/group transitions.
  `direct successful installations prepare matching fact and debt` checks mutationID, identity, canonical fact, confirmedTranscriptHash and one publication obligation.
  `trust only fixtures supply exact installed transcript` asserts fixture GroupContext bytes survive capture and reopen without substitution.
  `ratchet progress preserves fact without recapture` checks actual unchanged epoch/authenticator. Genuine identity changes never qualify as progress.
- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-writer-migration.test.ts`.
  Expected: direct writers omit prepared capture. Public installation enforcement remains disabled in this task.
- [ ] **Step 3: Migrate the declared writer inventory.** Co-write prepared fact/debt with each successful identity installation.
  Read handle.state.groupContext.confirmedTranscriptHash for handle-backed capture. Pass identical bytes explicitly to trust-only fixture preparation.
  Use independent fixture preparation for shared contracts. Keep intentionally invalid writes invalid for their original reason.
  Include newly discovered successful writers in this preparation closure before proceeding. No bypass flag permits uncaptured installations.
- [ ] **Step 4: Verify GREEN before activation.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-writer-migration.test.ts test/storage-conformance.test.ts test/ownership-phases-conformance.test.ts && kports && ktest @kumiai/mls-rpc && ktest @kumiai/integration-tests && kfinish`.
  Require real-mls/double fixture modes and supplied/absent ownership-context rows. Reconcile the search inventory with every migrated site.
- [ ] **Step 5: Future commit.** Stage this preparation closure. `git commit -m 'refactor: prepare every installation writer for checkpoint capture'`.

### Task 3b: Enforce capture at every installation and expose retention coverage

**Files:** Create `packages/mls-rpc/test/checkpoint-installation.test.ts`. Modify `packages/mls-rpc/src/checkpoint-capture.ts`.
Modify `packages/mls-rpc/src/registry/{access,seed,switch,trust}.ts`, `packages/mls-rpc/src/memory-group-persistence.ts`,
`packages/mls-rpc/src/checkpoint-store.ts`, `packages/rpc-conformance/src/checkpoint.ts`,
`packages/mls-rpc/test/fixtures/{storage-seed,sealed-memory-mls,registry}.ts`, `packages/mls-rpc/test/{registry-switch-write,checkpoint-storage-conformance}.test.ts`.
**Interfaces:** Consumes Task 3a preparation and its verified writer inventory. Produces coordinator-private installation authority and mandatory finalisation checks.
Record IDs hash immutable canonical facts. Task 2's CheckpointCoverage reports group-wide retained ranges, effectiveFloor and explicit holes.
`readCheckpointCoverage(groupID: string, records: Array<CheckpointRecord>): CheckpointCoverage` in checkpoint-store.ts computes this projection. Task 4 forwards it publicly.
HEAD has no checkpoint fact store yet. Add fact/debt writes beside existing state/trust writes at these verified coordinates:
`packages/mls-rpc/src/registry/access.ts:210-220`, `packages/mls-rpc/src/registry/seed.ts:292-305` and `packages/mls-rpc/src/registry/switch.ts:283-286`.
`packages/mls-rpc/src/registry/trust.ts:24-28,95-118` prepares public trust, not retained epoch facts.
Installed bytes are available through `packages/mls/src/group-handle.ts:470` and its ClientState.groupContext.
Pinned ts-mls 2.0.0-rc.13 exposes `GroupContext.confirmedTranscriptHash: Uint8Array` at `node_modules/ts-mls/dist/src/groupContext.d.ts:13`.
`node_modules/ts-mls/dist/src/groupInfo.d.ts:10-20` includes that context in signed GroupInfoTBS. These dependency files are read-only references.

- [ ] **Step 1: Add failing installation matrix.** `every installation co writes fact and debt` covers genesis, Welcome, own/received commit and confirmed resync.
  `progress save preserves immutable fact` asserts equal canonical bytes and no second publication obligation.
  `installed transcript fact survives reopen without publication` checks exact confirmedTranscriptHash across installation writers, progress saves and restart.
  Assert checkpoint frames omit confirmedTranscriptHash. Offered GroupInfo and rolled-back candidates never replace retained local transcript facts.
  `unproven candidates never become facts` covers rejected commits, speculative builds, offered GroupInfo, rollback and pending proof.
  `consecutive parent hashes identify retained lineage`: `expect(next.parentAuthHash).toBe(previous.authHash)`; skipped/pre-join parent is null.
  `self removal captures without publication`: installed fact survives, `expect(signable).toBe(false)`.
  `group history keeps current within count and age bounds` tests 257 installations across incarnations and expiry exactly 604800000 ms after supersession.
  `coverage query exposes effective floor and holes` checks count/age expiry, skipped/pre-join epochs and retained ranges across incarnations.
  At installation 257, expect 256 facts and effectiveFloor equal to the oldest remaining fact. Age expiry removes the same comparable range.
  Task 5's evidence copies obey these bounds even before acknowledgement.
```ts
expect(nextFact.confirmedTranscriptHash).toBe(installedTranscriptBase64url)
expect(publishedCheckpointBody).not.toHaveProperty('confirmedTranscriptHash')
expect(nextFact.parentAuthHash).toBe(previousFact.authHash)
expect(afterProgress.canonical).toEqual(beforeProgress.canonical)
expect(retainedFactsIncludingCurrent).toHaveLength(256)
expect(await factAtSupersessionExpiry()).toBeNull()
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-installation.test.ts`. Expected: installation omits fact/debt.
- [ ] **Step 3: Prepare canonical public facts outside provider work.** Include the installed GroupContext transcript bytes.
  Co-write facts/debt with state/trust at the verified writer sites, using the same mutationID/stateVersion.
  Activate finalisation rejection only after Task 3a is green. Require matching capture for every genuine identity installation.
  Preserve progress only when the actual epoch/authenticator remain unchanged. No fixture-only enforcement bypass exists.
  Retain newest 256 installations group-wide, current included. Expire superseded facts at seven days or the count boundary.
  Retain non-roster coverage watermarks for expiry/skipped/pre-join ranges, including restart. Do not retain expired facts to answer the query.
  Prune associated unsent work and return effective comparison coverage. Task 5 applies the same bounds to unacknowledged evidence.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-installation.test.ts test/checkpoint-storage-conformance.test.ts test/registry-switch-write.test.ts test/storage-conformance.test.ts test/ownership-phases-conformance.test.ts && kports && ktest @kumiai/mls-rpc && ktest @kumiai/integration-tests && kfinish`.
  Require both fixture modes and ownership-context variants after enforcement activates.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: capture checkpoint facts with installed group state'`.

### Task 4: Bind installed-only signing and strict eligibility contracts

**Files:** Create `packages/mls-rpc/src/checkpoint.ts`, `packages/mls-rpc/test/checkpoint-port-conformance.test.ts`.
Modify `packages/mls-rpc/src/{index,registry/registry}.ts`, `packages/rpc-conformance/src/checkpoint.ts`,
`packages/mls-rpc/test/fixtures/{registry,sealed-memory-mls}.ts`, `packages/rpc/test/fixtures/{memory-group-mls,memory-captured-recovery}.ts`,
`packages/rpc-conformance/src/group-mls.ts`, `packages/rpc/test/recovery-binding-double.test.ts`,
`packages/mls-rpc/test/ports-conformance.test.ts`, `packages/mls-rpc/test/ports-conformance-transactional.test.ts`.
**Interfaces:** Consumes Tasks 1–3b. Produces `createCheckpointPort(params: { registry: GroupHandleRegistry; key: GroupKey; identity: OwnIdentity }): CheckpointPort`.
Its registry registration supplies the bound coordinator. A copied or unregistered registry refuses construction.
`signInstalled(factID)` resolves proven coordinator-owned installation inputs, never arbitrary statements or candidate handles.

- [ ] **Step 1: Add failing shared port rows.** `signing requires proven installed fact` rejects speculative, rolled-back, foreign-key and fabricated-fact provenance.
  `rapid advances sign the captured installation`: `expect(decoded.epoch).toBe(capturedEpoch)`, not the latest handle epoch.
  `shared roster controls eligibility after divergent membership` uses DID+key from E−1, fallback E only if unavailable, once per DID.
  `retired workers cannot sign for replacement` fences stale ports. Signing leaves every MLS generation unchanged.
  `ineligible retained recovery signer is refused` requires controller/tree authority in real and independent recovery doubles.
  `public comparison coverage survives pruning and restart` calls checkpointCoverage, checking effectiveFloor and holes across incarnations at count/age boundaries.
```ts
expect(comparison.signerDID).toBe(sharedRosterDID)
expect(generationsAfterSigning).toEqual(generationsBeforeSigning)
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-port-conformance.test.ts && ktest @kumiai/rpc test/recovery-binding-double.test.ts`.
  Expected: missing installed port and too-permissive signer-double assertions fail.
- [ ] **Step 3: Implement signing outside provider transactions.** Save exact frames/IDs under the owner gate before network release.
  Keep installed inputs available after rapid advance, but never persist signing secrets in facts. Input comparison cannot request signing.
  Implement the independent model without importing real verifier/authority helpers. Tighten recovery signer eligibility too.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/checkpoint-port-conformance.test.ts && ktest @kumiai/rpc test/recovery-binding-double.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: bind checkpoint signing to proven installations'`.

### Task 5: Persist detection-only notices and portable comparison APIs

**Files:** Create `packages/rpc/src/{fork-notice,checkpoint}.ts`, `packages/rpc/test/fork-notice.test.ts`,
`packages/rpc-conformance/src/fork-notice.ts`, `packages/mls-rpc/test/fork-notice-conformance.test.ts`.
Modify `packages/rpc/src/{checkpoint-types,index}.ts`, `packages/mls-rpc/src/{checkpoint,checkpoint-store,persistence-types}.ts`,
`packages/rpc-conformance/src/{checkpoint,persistence-fixture,index}.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
**Interfaces:** Consumes CheckpointPort, checkpoint records and the resolved DN3 coverage/retention rules. Produces ForkNotice/ForkNoticeEvent and
`importCheckpoint(key: GroupKey, frame: Uint8Array): Promise<void>`, `forkNotices(groupID: string): Promise<Array<ForkNotice>>`,
`ackForkNotice(groupID: string, id: string, revision: number): Promise<void>`.
Extend CheckpointRecord with `{kind:'notice';id:string;key:GroupKey;notice:ForkNotice}`,
`{kind:'evidence';id:string;key:GroupKey;noticeID:string;first:Uint8Array;second:Uint8Array;localRosterFact:Uint8Array;eligibilityRosterFact:Uint8Array|null}`,
and `{kind:'notice-event';id:string;key:GroupKey;event:ForkNoticeEvent;emitAt:number;acknowledged:boolean}`.
All remain sealed group records. Export/fact methods retain Task 2 signatures.
`CheckpointService` in rpc/src/checkpoint-types.ts extends CheckpointPort with this task's import/notice/events methods and
`readRecords(): Promise<Array<CheckpointRecord>>`, `updateRecords(change: { put?: Array<CheckpointRecord>; remove?: Array<string> }): Promise<void>`.
All record access uses the bound owner. Task 6 consumes this type without redefining it.
`createCheckpointService(params: { registry: GroupHandleRegistry; key: GroupKey; identity: OwnIdentity; onForkNotice?: (event: ForkNoticeEvent) => void }): CheckpointService`
owns intake. `events(groupID: string): Promise<Array<ForkNoticeEvent>>` replays unacknowledged material revisions.

- [ ] **Step 1: Add failing notice tests under fake timers.** `lone unequal statement only notifies`: no halt, resync, candidate build, slot deletion or transport stop.
  `material updates coalesce for 30000 milliseconds`: branch/signer/earlier split/device-branch changes increment revision, unchanged heartbeats do not.
  `replay after ack preserves revision`: old frames do not recreate acknowledged events. New material changes notify at the saved deadline.
  `one active branch closes after 86400000 milliseconds` uses only local observation time, requires one branch actually continuing, and retains evidence.
  `closed evidence obeys ack and retention bounds` prunes evidence at installation 257 or supersession + 604800000 ms, even without acknowledgement.
  After acknowledgement at A, expire at the earlier of A + 604800000 ms and either supporting installation's checkpoint boundary.
  Preserve replayable unacknowledged summaries with partial coverage. Restart, retirement, new evidence and late acknowledgement cannot extend retention.
  `at risk coverage exposes missing history and ephemeral exclusion` asserts pre-journal/retention gaps and no durable ephemeral metadata.
  `import cannot supply roster provenance` refuses injected facts. Export returns exact defensive frames, never rosters.
  `coverage query excludes summary only epochs` checks effectiveFloor and holes after count/age pruning across retired incarnations.
```ts
expect(haltAfterIntake).toBeNull()
expect(eventsAfterUnchangedReplay).toEqual([])
expect(coalescedEmissionAt - previousEmissionAt).toBeGreaterThanOrEqual(30000)
expect(notice.coverage.ephemeral).toEqual({ kind: 'partial', reasons: ['ephemeral-uncovered'] })
expect(await evidenceAfterUnackedPruning()).toBeNull()
expect(unackedSummary.coverage.evidence).toEqual({ kind: 'partial', reasons: ['retention-gap'] })
expect(await evidenceAfterAckBeyondBounds()).toBeNull()
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/rpc test/fork-notice.test.ts && ktest @kumiai/mls-rpc test/fork-notice-conformance.test.ts`.
  Expected: missing APIs and notice state machine fail.
- [ ] **Step 3: Implement the fold and owner-bound intake.** Deduplicate exact frame hashes and persist evidence copies, cursor, notice and event atomically.
  Traverse parent links only while retained evidence supports them. Never claim ancestry across missing links.
  Stable notice identity survives an earlier split estimate. Replays update local evidence timestamps without notification noise.
  Emit only after proof. Retain closed notices/evidence until latest-revision acknowledgement plus seven days, subject to checkpoint bounds.
  Apply count/age bounds before acknowledgement too. Keep summary/event history with explicit gaps after supporting evidence expires.
  Disclosure and floor authority use ordinary retained facts only. Summaries cannot resurrect pruned eligibility or extend former-member access.
  Derive count/age eligibility from supporting installation identities and supersession times, never reset by copying evidence or acknowledgement.
  Track acknowledgedAt for the latest material revision. New material evidence resets it and requires acknowledgement again.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/rpc test/fork-notice.test.ts && ktest @kumiai/mls-rpc test/fork-notice-conformance.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: persist fork notices without changing group safety'`.

### Task 6: Schedule independent checkpoint transport

**Files:** Create `packages/rpc/src/checkpoint-worker.ts`, `packages/rpc/test/checkpoint-worker.test.ts`.
Modify `packages/rpc/src/{checkpoint,checkpoint-types,topic,index}.ts`, `packages/mls-rpc/src/checkpoint.ts`,
`packages/rpc-conformance/src/checkpoint.ts`, `packages/mls-rpc/test/checkpoint-port-conformance.test.ts`,
`packages/rpc/src/{peer,peer-types}.ts`, `packages/mls-rpc/src/registry-peer.ts`,
`packages/mls-rpc/test/registry-peer.test.ts`, `tests/integration/test/fixtures/fork-halt.ts`,
`tests/integration/test/hub-log-conformance.test.ts`,
`packages/rpc/src/host-boundary.ts`, `packages/rpc/test/host-boundary.test.ts`, `packages/rpc/test/fixtures/durable-fake-hub.ts`.
Create `tests/integration/test/fork-checkpoint.test.ts`, `tests/integration/test/fixtures/checkpoint-split-view.ts`.
**Interfaces:** Consumes CheckpointPort and owner-bound record access. Produces
`checkpointTopic(recoverySecret: Uint8Array): string`,
`createCheckpointWorker(params: { key: GroupKey; mux: Pick<HubMux, 'onInbound' | 'fetchTopic' | 'publish'>; recoverySecret: Uint8Array; checkpoints: CheckpointService; networkAllowed: () => boolean; now: () => number; random: () => number }): { start(): Promise<void>; resume(): Promise<void>; dispose(): Promise<void> }`.
The peer owns the sole underlying receive drain and mux disposal. The worker releases only its onInbound subscription and in-flight work.
Its push listener acknowledges each wakeup through the mux. Only retained fetch plus proven persistence advances its cursor.
Never call hub.receive from the worker. Current HubMux onInbound/fetchTopic/publish already supply the required view.
`CheckpointService` retains Task 5's exact signature and bound record methods.
RegistryPeerOptions gains `checkpoints: CheckpointService`. GroupPeerParams gains optional `checkpoints: CheckpointService`.
Registry peers create a key-bound service automatically. Their peer factories forward it. Plain peer hosts may provide their own conforming service.
Add `checkpoints: 'port'` to peerHostFields in host-boundary.ts, with exhaustive per-method classification and defensive data copies.
The wrapper tracks/drains host promises and rejects late calls after disposal. No callback/service escapes its lifecycle fence.

- [ ] **Step 1: Add failing clock/transport tests.** `installation debt is never coalesced` drains burst 8 then at most one/second.
  `heartbeat deadline persists across restart` pins 1,440,000–2,160,000 ms and a new ID with exact current bytes.
  `ambiguous handoff retries identical frame and ID` resumes saved in-flight work. Overdue restart produces one heartbeat, no catch-up burst.
  `flood yields after bounded verification` asserts ≤32 frames, ≤131072 bytes and ≤64 signature checks per turn.
  `checkpoint traffic never moves commit head` checks topic/retain/no expectedHead. Live pushes wake fetch and never advance the saved cursor directly.
  `checkpoint outage leaves ordinary sends open` checks no hold or signing induced by remote frames.
  `backwards clock and reconnect storm preserve budgets` rewinds fake time and repeats reconnect, without extra heartbeat debt or verification work.
  `checkpoint worker shares one receive channel` uses one-writer DurableFakeHub with commit/app/rendezvous traffic during worker start/disposal.
  Assert exactly one hub.receive call and uninterrupted ordinary delivery after worker disposal. The worker cannot dispose the peer mux.
  `checkpoint service survives host wrapping` checks every service method, promise drainage and no late callbacks after peer disposal.
  Real MLS: `both installed split views detect without halting` installs divergent states and exchanges checkpoints in both directions.
  `buggy signer can only notify` asserts unchanged holds, exact saved work, zero rebuild/discard/switch and continuing ordinary sends.
  `refused CAS loser never creates checkpoint installation` traverses historical/own-slot paths and verifies unchanged facts and no frame-triggered recovery.
```ts
expect(framesProcessed).toBeLessThanOrEqual(32)
expect(bytesProcessed).toBeLessThanOrEqual(131072)
expect(signatureChecks).toBeLessThanOrEqual(64)
expect(retry.frame).toEqual(saved.frame)
expect(retry.publishID).toBe(saved.publishID)
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/rpc test/checkpoint-worker.test.ts`. Expected: missing worker/topic fails.
- [ ] **Step 3: Implement scheduling.** Subscribe for 604800 seconds before fetch, paginate boundedly, dedupe and release ownership between turns.
  Persist sampled deadlines and retry state. Cap exponential retry at 15000 ms within the same rate budget.
  Reject positions longer than 64 characters before persisting. Clock/reconnect storms cannot bypass rate or work budgets.
  Start the worker from peer startup after safety/ownership readiness. Dispose/drain it with that peer and fence on retirement.
  Move transport through the saved routing binding in Task 16b, retaining group evidence.
  The split-view fixture routes opaque logs across conforming hubs. Keep real signing, roster verification and registry installation in its witnesses.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/rpc test/checkpoint-worker.test.ts test/host-boundary.test.ts && ktest @kumiai/integration-tests test/fork-checkpoint.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
  Require real split signatures and one-writer receive behaviour. A multiple-sink FakeHub alone cannot establish this gate.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: publish and receive bounded checkpoint traffic'`.

### Task 7: Extend hub contracts for checkpoint retention and authorisation

**Files:** Create `packages/hub-conformance/src/topic-authorization.ts`, `packages/hub-server/test/checkpoint-authorization.test.ts`.
Modify `packages/hub-conformance/src/{index,log-hub}.ts`, `packages/hub-server/test/log-hub-conformance.test.ts`,
`packages/rpc/test/hub-conformance.test.ts`, `tests/integration/test/hub-log-conformance.test.ts`, `tests/integration/test/log-hub-over-wire.ts`.
**Interfaces:** Consumes generic LogHub/HubStore contracts. Produces
`testTopicAuthorizationConformance(params: { createFixture(): Promise<{ commitTopicID: string; checkpointTopicID: string; allowed: ConformanceLogHub; denied: ConformanceLogHub; dispose(): Promise<void> }> }): void`.
The fixture installs identical policy for the two opaque topic IDs. This helper does not claim authorisation exists on bare LogHub.

- [ ] **Step 1: Add failing contract rows.** `independent retained topics have independent heads and cursors` publishes opaque checkpoint bytes without CAS.
  `checkpoint dedup survives acknowledgement and unrelated topic writes` checks same-ID original position and topic scope.
  `commit and checkpoint access use the same configured policy` checks subscribe/fetch/publish/receive as allowed and denied DIDs.
  `retained checkpoint replay survives reconnect` covers seven-day subscription within supported retention.
```ts
expect(commitHeadAfterCheckpoint).toBe(commitHeadBeforeCheckpoint)
expect(replayedPublish.sequenceID).toBe(firstPublish.sequenceID)
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/hub-server test/checkpoint-authorization.test.ts`. Expected: absent fixture/export fails.
  Existing compliant hub rows may already pass. Temporarily disable topic separation/authorisation in the test fixture to prove those assertions fail.
- [ ] **Step 3: Implement fixture wiring and shared rows.** Keep authorisation app-owned, using the existing server hook.
  Feed new generic rows through all existing runners, including SQL and both rpc doubles. Do not add branch semantics to HubStore.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/hub-server test/checkpoint-authorization.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'test: extend hub contracts for checkpoint traffic'`.

### Task 8: Authenticate former-member roster replies and retained lineage

**Files:** Create `packages/mls/src/recovery-absence.ts`, `packages/mls/test/recovery-absence.test.ts`.
Modify `packages/mls/src/{recovery,recovery-trust,index}.ts`, `packages/mls-rpc/src/{recovery,recovery-public-state}.ts`,
`packages/mls-rpc/test/recovery-retained-trust.test.ts`, `packages/mls-rpc/test/fixtures/captured-recovery.ts`.
**Interfaces:** Consumes authenticated requests and locally retained Task 3b facts/installed signed checkpoints. Produces
`AuthenticatedRosterAbsence = { groupID: string; requesterDID: string; requestID: string; epoch: number; captureHead: string | null; groupInfoAuthenticator: Uint8Array; confirmedTranscriptHash: string; responderDID: string; responderKeyHash: string; lineage: Array<{epoch:number;authHash:string}>; evidence: Uint8Array }`,
`verifyRosterAbsence(params: { trust: RecoveryTrustInputs; requestID: string; requestKey: Uint8Array; evidence: Uint8Array; options: GroupOptions }): Promise<AuthenticatedRosterAbsence | null>` and
`sealRosterAbsenceReply(params: { group: GroupHandle; identity: SigningIdentity; request: string; captureHead: string | null; retainedRosterFacts: Array<Uint8Array>; lineage: Array<Uint8Array> }): Promise<Uint8Array | null>`.
`verifyRecoveryLineage(params: { trust: RecoveryTrustInputs; frames: Array<Uint8Array>; signerKeyHash: string; epoch: number; authHash: string }): Promise<Array<{epoch:number;authHash:string}> | null>` supplies shared strict lineage verification.
Add `comparisonEpoch?: number` to RecoveryRequest, VerifiedRecoveryRequest and CreateRecoveryRequestParams in mls/src/recovery.ts.
Add the same option to CreateRecoveryRequestFromTrustParams in mls/src/recovery-trust.ts. Preserve it in signed request creation/verification.
Validate a non-negative safe integer. New requests select split E when recovering a fork, otherwise their newest retained epoch.
Legacy requests without the field retain ordinary recovery, without lineage-exception authority. Signatures bind the comparisonEpoch against tampering.

Disclosure requires the signed request's DID **and signature-key hash** in an ordinary retained earlier local roster.
The coordinator supplies only proven local facts. Imported rosters, notice summaries and expired evidence never authorise disclosure.
Current DID presence uses ordinary recovery. Never-seen DID/key pairs receive null. A changed leaf alone never proves DID absence.
A present DID with an obsolete incarnation can therefore remain pending. Public documentation states that limit.
The verifier authenticates the request, signer eligibility, captured head/tree and complete role ledger, refolded from genesis.
It returns authenticated observations, never a surviving-branch certificate or mutation authority. Task 10 applies R6 freshness.
Extract confirmedTranscriptHash from verified GroupInfo.groupContext, never from an unsigned field or a checkpoint assertion.
Resolve responderDID through the verified signer key. Encode transcript bytes using the local fact convention.

Wire: token type `'kumiai.recovery-roster'`, frame version 1, HPKE info `'kumiai/mls/recovery-roster/v1'`, AAD `'kumiai/mls/recovery-roster-aad/v1'`.
Reuse signed-request ephemeral-key sealing and group/requester/requestID AAD framing. Sign group/request/head/authenticator/tree/ledger/lineage digests.
Payload: `u32(tokenLength) || UTF8(token) || u32(GroupInfoLength) || GroupInfo || u32(ledgerLength) || encodedLedgerTokens || encodedCheckpointList`.
The checkpoint list is `u32(count)` followed by `u32(length) || frame` entries, at most 256, each at most 4096 bytes.
Select only the inclusive signed-request span [comparisonEpoch, offered epoch F]. Never append older retained frames or silently truncate this span.
Require contiguous parentAuthHash links within that span, matching the offered authenticator and reply signing key. No request induces signing.
When F < comparisonEpoch or required frames are unavailable, the reply grants no lineage exception.
Use existing SHA-256/multibase encoding. Require full consumption and total frame ≤786432 bytes, including request-reply framing.
Overflow/missing lineage yields no qualifying absence proof, never truncated state. Ordinary captured recovery retains its existing availability.
Capture public tree, reconciled prefix/head, complete ledger and retained signed lineage under one responder owner gate.
Distinct domains exclude roster replies from candidate-building GroupInfo, ledger and confirmation consumers. Transmit no historical roster facts or secrets.

- [ ] **Step 1: Add failing proof tests.** `retained former member receives request bound public roster` checks historical DID+key membership.
  `never seen requester receives no roster reply` includes an unseen device sharing a former member's DID.
  `expired requester history cannot authorise disclosure` prunes eligibility despite an unacknowledged notice summary.
  `absence proof binds exact request head ledger and lineage` mutates every binding independently and expects null.
  `roster reply discloses only current public state` excludes historical rosters, messages, private tree and secrets.
  `roster reply cannot cross recovery domains` rejects cross-domain input. `oversized public state yields no truncated roster` pins 786432 bytes.
  `present DID with a changed leaf is not absent` preserves DID-level semantics. `provider faults retain error identity` preserves typed failures.
  `lineage cannot be spliced across signers or parents` refuses missing links, wrong group/suite/anchor and mismatched current authenticator.
  `comparison span is signed and validated` rejects altered, negative, fractional and unsafe comparisonEpoch values.
  `large group roster reply fits requested lineage span` retains epochs 0–255 and requests 250 through offered 255.
  Use a verified large public tree/ledger whose full-history reply exceeds 786432 bytes, while its six-frame reply fits.
  Assert exactly epochs [250,251,252,253,254,255], valid proof and complete frame byteLength <= 786432, including sealing overhead.
  `old comparison requests never truncate oversized state` requires null proof when even the exact span cannot fit.
```ts
expect(returnedLineageEpochs).toEqual([250, 251, 252, 253, 254, 255])
expect(fullHistoryReplyBytes).toBeGreaterThan(786432)
expect(sealedRosterReply.byteLength).toBeLessThanOrEqual(786432)
expect(verifiedRosterAbsence).not.toBeNull()
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls test/recovery-absence.test.ts`. Expected: missing former-member/lineage primitives fail.
- [ ] **Step 3: Implement strict additive proof verification.** Reuse retained signer, public tree/signature and authenticated role-ledger verification.
  Preserve ordinary requireMember admission. Missing ledger/lineage remains unqualified evidence. A signed head proves only that responder's view.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls test/recovery-absence.test.ts && ktest @kumiai/mls-rpc test/recovery-retained-trust.test.ts && kports && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: verify request bound public roster and lineage evidence'`.

### Task 9: Define non-terminal condition and independent absence contracts

**Files:** Modify `packages/rpc/src/{control/safety,crypto,recovery-types,errors,index,host-boundary,checkpoint-types}.ts`,
`packages/rpc-conformance/src/{group-mls,control-store,memory-control-store,safety}.ts`,
`packages/rpc/test/fixtures/{memory-group-mls,memory-captured-recovery}.ts`, `packages/mls-rpc/src/{recovery,mls,registry-group-mls}.ts`,
`packages/mls-rpc/test/{ports-conformance,ports-conformance-transactional}.test.ts`, `packages/rpc/test/host-boundary.test.ts`.
Create `packages/rpc/test/recovery-absence.test.ts`, `packages/mls-rpc/test/recovery-absence-conformance.test.ts`.
**Interfaces:** Consumes Task 8's proof and structural lineage result. Produces
`GroupCondition = 'not-member' | 'spent-set-corrupt'`,
`NotMemberEvidence = { responderKeyHash: string; epoch: number; authHash: string; observedAt: number; responderDIDs: Array<string>; responderCount: number }`,
`GroupConditionEvent = GroupKey & { id: string; kind: GroupCondition; detectedAt: number; evidence: NotMemberEvidence | null }`.
Define `GroupNotMemberError` and `SpentSetCorruptError`, constructed with `{key:GroupKey;cause?:unknown}` and defensive key properties.
Add only spent-set-corrupt to SendAdmission, its independent mirrors and SafetyHold.
Not-member is diagnostic only. Existing stranded/hold rules govern admission. No admission path throws GroupNotMemberError solely for this condition.
Keep GroupNotMemberError as a diagnostic type. Spent corruption remains a hard restriction.
CheckpointRecord gains `{kind:'condition';id:string;key:GroupKey;event:GroupConditionEvent;active:boolean;sealedProof:Uint8Array|null}`.
Add optional `CapturedRecoveryPort.checkRosterAbsence(evidence: Uint8Array, requestID: string, requestKey: Uint8Array): Promise<AuthenticatedRosterAbsence | null>` and
`CapturedRecoveryPort.sealRosterAbsence(request: Uint8Array, captureHead: LogPosition | null): Promise<Uint8Array | null>`.
Registry adapters obtain local historical facts and installed checkpoints themselves. Hosts cannot inject disclosure rosters.
Portable proof types mirror Task 8 without MLS imports. Classify both new port methods as host operations in host-boundary.ts.
Extend `GroupMLS.createRecoveryRequest(requestID: string, deadlineMs?: number, comparisonEpoch?: number): Promise<{request:Uint8Array;requestKey:Uint8Array}>`.
Wire that third argument through real mls.ts and retained-trust request creation. Mirror it independently and classify it as host data.

- [ ] **Step 1: Add failing shared contracts.** `ineligible signer cannot assert absence`, `wrong request cannot assert absence`,
  `changed leaf for present DID never means removed` and `absence verification cannot mutate recovery attempt` pin real/double parity.
  `condition errors preserve exact group key` checks defensive properties. `former member disclosure requires responder local DID and key history` covers expiry/imports.
  Preserve the existing sealGroupInfo removed-requester refusal. Only the separate roster port gains former-member disclosure.
  `not member diagnostic adds no admission refusal` compares admission with and without the diagnostic under identical stranded/hold facts.
  `request comparison span reaches real and double roster sealers` checks signed comparisonEpoch and the exact returned lineage span.
- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/rpc test/recovery-absence.test.ts test/host-boundary.test.ts && ktest @kumiai/mls-rpc test/recovery-absence-conformance.test.ts`.
  Expected: missing proof capabilities and independent type mirrors fail.
- [ ] **Step 3: Implement additive types, adapters and independent models.** Include mutual-assignability checks in both real port runners.
  Classify every new captured-port member at the exhaustive host boundary. Disposal fences/drains their promises.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/rpc test/recovery-absence.test.ts test/host-boundary.test.ts && ktest @kumiai/mls-rpc test/recovery-absence-conformance.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: define non terminal group condition and absence contracts'`.

### Task 10: Surface non-terminal not-member while recovery continues

**Files:** Create `packages/mls-rpc/src/safety-conditions.ts`, `packages/mls-rpc/test/not-member.test.ts`, `tests/integration/test/group-conditions.test.ts`.
Modify `packages/mls-rpc/src/{safety,persistence-types,checkpoint-store,registry-peer,registry-group-mls,recovery,index,entry-capability,memory-group-persistence}.ts`,
`packages/mls-rpc/src/registry/{runtime,registry,access,seed,switch,runtime-facts}.ts`, `packages/rpc/src/{peer,peer-types,host-boundary}.ts`,
`packages/rpc-conformance/src/{safety,registry-fixture,persistence-fixture}.ts`,
`packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/test/safety-conformance.test.ts`, `packages/rpc/test/host-boundary.test.ts`.
**Interfaces:** Consumes Task 9 contracts. Produces
`GroupSafety.status(key: GroupKey): Promise<{ hold: SafetyHold; condition: GroupCondition | null; evidence: NotMemberEvidence | null }>` at this stage.
Task 15a adds `manualRecovery: ManualRecoveryStatus | null` after defining that type, in the same closure as its independent safety mirror.
`onNotMember?: (params: { evidence: Uint8Array; requestID: string; requestKey: Uint8Array }) => Promise<void>` belongs to GroupPeerParams and RegistryPeerOptions.
Classify onNotMember as a drained callback in host-boundary.ts. Registry peer factories forward it.
The coordinator re-verifies the sealed reply, source incarnation, latest installed epoch and ordinary retained comparison facts before committing condition/event.
`persistGroupCondition(key: GroupKey, condition: GroupCondition, evidence: NotMemberEvidence | null): Promise<void>` remains coordinator-private after proof verification.
Callers cannot manufacture the authority by supplying a condition string or evidence object.
Define `RecoveryPendingReason = 'no-reply' | 'no-eligible-responder'` in mls-rpc/src/registry-peer.ts at this stage.
Export RecoveryPendingReason through mls-rpc/src/index.ts. Keep its independent status mirror aligned at each later extension.
RegistryPeerStatus gains `{kind:'not-member';eventID:string;evidence:NotMemberEvidence;retrying:true;pendingReason?:RecoveryPendingReason}`.
Use the same union in the pending status arm. Task 11 adds target-behind. Task 15b adds target-unresolved to both projections.
Silence sets no-reply. Received but unqualified replies set no-eligible-responder. Absence status preserves the current retry reason.
AccountedGroupObservation gains optional `condition: GroupCondition | null`. Runtime/status caches project it without inventing a hard hold.
The peer selects comparisonEpoch from its bound CheckpointService.readRecords(): open split E, otherwise the newest retained fact.
Without retained comparison facts, ordinary requests remain available without exception authority.
Registry-owned factories supply that local comparison epoch. Hosts never supply disclosure facts or signing authority.

- [ ] **Step 1: Add failing non-terminal tests.** `fresh unequal roster absence surfaces evidence and keeps retries` applies R6's two freshness arms.
  Same lineage at the newest common retained epoch requires reply epoch > latest installed. Different retained lineage has no epoch-number test.
  Unequal authHash or verified offered confirmedTranscriptHash at a retained epoch establishes different lineage. Missing comparison evidence grants nothing.
  `stale responder below requester join epoch cannot prove absence` uses removal at 5, reinvite at 8, requester at 12 and responder at 6.
  Supply a valid request-bound span through 6 with matching own lineage. Assert freshness rejection independently of missing-frame rejection.
  `same lineage older roster cannot prove absence` and `hub withholding from one responder leaves requester pending` reject stale claims.
  `equal epoch same lineage fails absence freshness` rejects epoch equality without a retained difference.
  Real MLS: `advanced losing device removed on continuing branch surfaces not-member` uses X at 20, continuing branch at 12 and split E=10.
  Request comparisonEpoch=10 from the open notice. Assert retained unequal lineage, own-DID absence, evidence and retries without changing X/floor.
  `equal epoch different lineage surfaces absence` and `transcript difference proves retained branch freshness` exercise both unequal-branch comparisons.
  `newer same lineage absence passes freshness` pins the same-lineage arm without requiring an unequal checkpoint.
  Real MLS: `losing branch absence keeps retrying and continuing recovery clears condition` uses Alice at epoch 12 and an excluding losing-branch reply at 13.
  Their retained comparison at split epoch 10 differs. The continuing branch still includes Alice.
  Assert surfaced evidence, continuing requests at capped backoff, intact saved X and automatic clearance after continuing-branch installation.
  `new absence evidence coalesces once` dedupes keyHash/epoch/authHash across fresh request IDs and restart. observedAt never creates novelty itself.
  `silence and ineligible replies have distinct hints` checks no-reply versus no-eligible-responder over many capped retries.
  `former requester receives roster but never seen requester stays pending` uses real signed replies and public-only disclosure.
  `not member ack preserves evidence until successful recovery` keeps event history, retries and source work intact. Task 14 owns public clearHold assertions.
  `every successful installation clears not member` covers seed, own/received commit and confirmed recovery in the active lineage.
  `head-only recovery clears not-member` proves condition/evidence clearance and ordinary admission under existing stranded/hold rules.
  `successful re-anchor clears not-member` covers cursor re-anchoring without a new installation. Rollback/pending proof keeps the condition.
  `diagnostic absence alone never refuses admission` checks unchanged SendAdmission before/after evidence under identical runtime facts.
  `not member retains pending reason` checks no-reply/no-eligible-responder, then target-behind in Task 11 and target-unresolved in Task 15b.
  `absence event counts distinct responder DIDs` checks one DID with multiple keys counts once, a second DID counts twice, and restart preserves counts.
  `late condition proof cannot affect replacement incarnation` and `dispose drains late condition callbacks` fence source/lifecycle changes.
  `replayed former member request does not re seal` checks one seal per requestID within the bounded window, including concurrent replays.
  `roster reply flood shares bounded group admission` mixes unique requests and ordinary recovery without bypassing eight-operation admission.
```ts
expect(status).toMatchObject({ hold: null, condition: 'not-member', evidence: { responderKeyHash, epoch, observedAt } })
expect(retriesAfterCondition).toBeGreaterThan(0)
expect(statusAfterRecovery).toMatchObject({ condition: null, evidence: null })
expect(statusAfterSilence).toMatchObject({ kind: 'pending', reason: 'no-reply' })
expect(notMemberStatus).toMatchObject({ kind: 'not-member', pendingReason: 'no-reply', retrying: true })
expect(secondResponderEvent.evidence.responderDIDs).toEqual([aliceDID, bobDID].sort())
expect(secondResponderEvent.evidence.responderCount).toBe(2)
expect(admissionWithDiagnostic).toEqual(admissionWithoutDiagnostic)
expect(advancedLosingStatus).toMatchObject({ kind: 'not-member', evidence: { epoch: 12 }, retrying: true })
expect(staleSameLineageCondition).toBeNull()
expect(equalEpochSameLineageCondition).toBeNull()
expect(afterHeadOnlyRecovery).toMatchObject({ condition: null, evidence: null })
expect(afterReanchor).toMatchObject({ condition: null, evidence: null })
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/not-member.test.ts`.
  Expected: missing evidence/status or stop-on-absence behaviour fails. No direct condition writes satisfy the real branch witness.
- [ ] **Step 3: Activate diagnostic persistence and reply handling.** Keep the recovery loop running regardless of condition persistence or event acknowledgement.
  Never reject recovery or ordinary admission solely because not-member is set. Preserve existing stranded/hold admission guards.
  Apply R6 freshness after comparing the newest common retained epoch and any authenticated retained difference.
  Aggregate distinct verified responder DIDs in canonical sorted order. Replays and extra keys for one DID never inflate responderCount.
  Reuse recovery suppression's 1024-entry bound and eight-operation admission bound for roster reply work. Reserve admission before verification/folding/sealing.
  Retain bounded per-responder requestID completions, including refused/oversize requests. Release in-flight admission after completion.
  Use the existing bounded recovery cache for completed requestIDs. Deduplication precedes ledger folds and HPKE sealing.
  Try roster replies only after authenticated current membership absence. Provider failures never enter that fallback.
  Hard-held devices never serve either reply. Recheck the hold after awaits and before publication.
  Coalesce new evidence at forkNoticeMinInterval (default 30000 ms). A new responder DID is material evidence.
  Clear active condition/evidence after proven install, head-only reconcile or re-anchor, preserving event history. Include every successful recovery path.
  Failure or pending proof never clears it. clearHold cannot clear conditions. A plain peer without a persistence callback keeps diagnostic evidence and retries.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/not-member.test.ts && ktest @kumiai/rpc test/host-boundary.test.ts && ktest @kumiai/integration-tests test/group-conditions.test.ts && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: surface roster absence without stopping recovery'`.

### Task 11: Settle saved branch attempts and lower floors only with bound evidence

**Files:** Modify `packages/rpc/src/{recovery-types,peer,peer-types,host-boundary,checkpoint-types,index}.ts`, `packages/rpc/src/control/{types,store,rejoin}.ts`,
`packages/rpc-conformance/src/{group-mls,control-store,memory-control-store,registry,persistence-fixture}.ts`,
`packages/mls-rpc/src/{recovery,registry-peer,mls,registry-group-mls,checkpoint-store,memory-incarnation-stores}.ts`, `packages/mls-rpc/src/registry/{continuation,recovery-coordinator}.ts`,
`packages/mls/src/recovery.ts`, `packages/rpc/test/fixtures/{memory-group-mls,memory-captured-recovery}.ts`,
`packages/rpc/test/{peer-rejoin-record,recovery-capture-reconcile,host-boundary}.test.ts`,
`packages/mls-rpc/test/{control-store-conformance,registry-switch-write,recovery-retained-trust,ports-conformance,ports-conformance-transactional,not-member}.test.ts`,
`packages/mls-rpc/test/fixtures/captured-recovery.ts`.
Create `tests/integration/test/branch-abandoned.test.ts` for the real floor/heal witness. Task 12b later adds report assertions.
**Interfaces:** Consumes open retained notice evidence, Task 8 lineage verification and ordinary captured recovery. Produces
`ForkRecoveryAuthorisation = { attemptID: string; noticeID: string; splitEpoch: number; otherAuthHash: string; responderKeyHash: string; source: GroupKey; evidence: Uint8Array }`,
`CapturedRejoinRecord.forkRecovery?: ForkRecoveryAuthorisation` and
`RecoveryReconciliation` arm `{kind:'superseded-branch';epoch:number;authorisation:ForkRecoveryAuthorisation}`.
Define `ForkRecoveryAttempt = { id: string; source: GroupKey; forkRecovery: ForkRecoveryAuthorisation }` in rpc/src/recovery-types.ts.
Add `ControlSnapshot.forkRecoveryAttempt?: ForkRecoveryAttempt | null`, decoding legacy snapshots as null in real and independent stores.
This durable Y intent bridges settlement to candidate construction. Its id equals authorisation.attemptID and the later CapturedRejoinRecord.id.
Only private coordinator authority may write/clear this intent. Bare ControlChanges cannot mint it or attach forkRecovery to an unrelated record.
`effectiveRecoveryEpochFloor(snapshot: ControlSnapshot, attempt: {id:string;source:GroupKey}): number | null` in rpc/src/control/rejoin.ts returns E only for that bound Y.
Otherwise it returns the unchanged ordinary snapshot.recoveryEpochFloor. Candidate construction, recapture and restoration all use the same binding.
AcceptedRejoinSettlement gains `{kind:'superseded-branch';epoch:number}` alongside its existing origin/id/ledgerBefore fields.
CheckpointRecord gains `{kind:'superseded-rejoin';id:string;key:GroupKey;record:CapturedRejoinRecord;authorisation:ForkRecoveryAuthorisation}`.
Provider-private authority settles X/history, clears its active pointer and saves Y's forkRecovery intent in one proven transition.
The ordinary control floor remains unchanged. No-X authorisation persists the same bound Y intent without inventing an X settlement.
RecoveryPendingReason and RecoveryFailureReason gain `'target-behind'` here. Both pending and not-member.pendingReason retain it.
Require `settleAcceptedRecovery(record: CapturedRejoinRecord, acceptedEpoch: number, leafDigest: string, recoveryEpochFloor: number): Promise<void>` everywhere.
Ordinary raiseRecoveryEpochFloor remains monotone. Bare ControlStore.apply cannot fabricate either exception.
The fourth settlement argument preserves the ordinary floor. Never write Y's temporary effective E into the ordinary floor.

Recovery reply v3 adds a signed lineageDigest and the same encoded checkpoint list as Task 8.
Use HPKE domains `kumiai/mls/recovery/v3` and `kumiai/mls/recovery-aad/v3`, retaining v2 readability/restoration for ordinary saved attempts.
Emit v3 when supplying lineage. v2 replies remain eligible for ordinary recovery, with no exception authority.
Extend `sealCapturedGroupInfo(params: SealGroupInfoParams & {captureHead:string|null;lineage?:Array<Uint8Array>}): Promise<Uint8Array>` in mls/src/recovery.ts.
Select Task 8's exact signed comparison span before sealing. Export portable authorisation/result types through rpc/index.ts.
CapturedRecoveryPort gains optional `authoriseForkRecovery(reply: CapturedRecapture, noticeID: string): Promise<ForkRecoveryAuthorisation | null>`.
The bound registry reads local notice/facts and verifies the reply before any fresh build, including when X is null.
The coordinator proves settlement/Y intent before returning authority. Restoring the same Y intent preserves its ID and authorisation across restart.
Classify authoriseForkRecovery as a host method in host-boundary.ts. Mirror it independently. Its sealer sources lineage internally.
The reply signer, current offered authenticator and E checkpoint share a verified signed lineage. Keep the complete reply within the existing 786432-byte bound.
Missing/overflowed evidence cannot grant an exception. Ordinary recovery without that evidence retains normal floors and acceptance rules.
Private coordinator `checkForkRecoveryCapture(params: {attempt:ForkRecoveryAttempt;reply:CapturedRecapture}): Promise<boolean>` enforces the per-capture predicate.
Expose it only through the internal MLS dependency contract. Authorisation calls it before settlement, and every Y build/restore/recapture calls it again.
Existing Y intent makes authorisation idempotent. Valid retries reuse that intent without settling Y as though it were X.

R10 real adapter closure, verified at HEAD:

- `packages/mls-rpc/src/mls.ts:140-159`: add private dependency `authoriseForkRecovery?: (reply: CapturedRecapture, noticeID: string) => Promise<ForkRecoveryAuthorisation | null>`.
  Add owner-bound `readInstalledRecoveryLineage?: (params: {comparisonEpoch:number;throughEpoch:number}) => Promise<Array<Uint8Array>>` to GroupMLSDependencies.
  Bind `checkForkRecoveryCapture?: (params: {attempt:ForkRecoveryAttempt;reply:CapturedRecapture}) => Promise<boolean>` to the same coordinator.
  Legacy direct factories may omit these dependencies. Registry construction supplies all three. Hosts cannot inject them through registry parameters.
- `packages/mls-rpc/src/registry-group-mls.ts:24-33`: omit all three new dependency names from RegistryGroupMLSParams.
  Construct and override them from the registered capability. Host-supplied object fields never become registry signing or floor authority.
- `packages/mls-rpc/src/registry-group-mls.ts:240-266`: bind authoriseForkRecovery to the private recovery coordinator and lineage reads to installed checkpoint storage.
  Validate the active key and installed snapshot under ownership. Never use notice summaries or imported frames as local installation provenance.
- `packages/mls-rpc/src/mls.ts:308-356`: expose the real capturedRecovery.authoriseForkRecovery by delegating to that bound coordinator.
  Gate applyRecovery, restoreRecovery and reconcileCapture through R7 while forkRecovery is present. Missing checker refuses the capture.
- `packages/mls-rpc/src/mls.ts:598-637`: capture requested installed lineage alongside public state/head/ledger under the same owner snapshot.
  Pass those frames to ordinary sealCapturedGroupInfo. Without a lineage reader, legacy factories emit ordinary v2 without fork authority.
- `packages/mls-rpc/test/fixtures/captured-recovery.ts:94-110`: bind the same dependencies in both real port runners, including direct createGroupMLS construction.
  Supply real registry/coordinator-backed state for the new rows. Never decorate or replace the port capability inside a test.

- [ ] **Step 1: Add failing real/double recovery rows.** `every saved X stage settles superseded branch before fresh Y` covers built/published/confirmed/adopted-incomplete.
  Parameterise X at 20, repaired capture at 12, split E=10, plus equal-number/different-authenticator captures.
  Restart before/after settlement commit and during uncertain proof. Assert exact X/history, preserved acceptance/unknown outcomes and cumulative obligation union.
  `lower floor and authorise switch commit together` exposes no pointer/intent/history change before proof. Fresh Y starts only afterwards.
  Assert ordinary floor unchanged throughout. Only the persisted Y intent gives its matching attempt effective floor E.
  `ahead device without X requires bound branch reply` keeps X null and floor unchanged until the same R2 predicate succeeds.
  `archived exact X survives live key zeroisation` reopens history after settlement proof and checks every saved byte against X.
  `same lineage stale responder cannot use lowered floor` preserves X/floor with target-behind.
  `own-lineage stale capture refused by transcript hash` supplies otherwise matching checkpoint testimony with GroupInfo F=12 on our retained lineage.
  Assert equal confirmedTranscriptHash at F refuses authority, leaves X/floor intact and performs zero fresh builds.
  `retry after settlement cannot accept own lineage capture above E` first settles X=20 using split E=10 and other-branch F=12.
  Offer our retained own-lineage F=13 next. Assert retry/target-behind, unchanged Y intent and zero acceptance/installation from that capture.
  `retry after settlement cannot accept own lineage capture above E after restart before Y` repeats after reopening between settlement and Y installation.
  Cover restart both before candidate construction and with Y built/published. Restore rechecks the captured GroupInfo before reuse.
  `capture below oldest retained fact stays target-behind` uses authorised E=10, retained epochs 13–20 and capture F=12.
  Cover F<E, retained holes, retained unequal transcripts and F above newest with valid E-lineage. No gap invents a transcript comparison.
  `fork floor expires with its attempt` settles or abandons Y, then offers a lower capture to unrelated Z. Assert the ordinary floor applies.
  `two member fork recovery needs no distinct witness DID` heals with one eligible responder supplying testimony and the reply.
  `equivocation only notice grants no floor authority` rejects a lone unequal equivocating signer.
  `wrong branch checkpoint or reply signer cannot lower floor` mutates E/hash/key/eligibility/request/lineage independently.
  `closed or unproven notice cannot lower floor` rejects expired evidence and stale source keys.
  `saved v2 X restores after lineage reply activation` preserves exact candidate/request/target. v2 replies grant no floor exception.
  `v3 lineage cannot escape reply size bound` rejects oversized/spliced lists without disabling ordinary v2 recovery.
  `real responder emits v3 lineage bounded to requested span` uses E=10/F=12 and verifies epochs [10,11,12], signature and <=786432 bytes.
  `real captured port exposes bound fork authority` asserts typeof realPort.capturedRecovery.authoriseForkRecovery === 'function' and calls it through real storage.
  `real adapters heal no X and saved X without capability replacement` covers X=null and all saved-X stages through both real runners.
  Keep real sealing, coordinator authorisation, per-capture transcript checks, settlement proof and external confirmation in that witness.
  `v2 or missing real authority preserves X and ordinary floor` asserts target-behind, capped retries, no Y intent and unchanged exact X.
  `heal after evidence expiry stays target behind` advances supersession age to 604800000 ms, prunes E evidence and preserves pending X/floor.
  Task 15b completes the manual-resync exit witness after that API activates.
  `not member retains target behind reason` checks status.pendingReason while the diagnostic remains active.
  `checkpoint intake alone cannot start recovery` asserts zero builds and unchanged active pointer/floor.
  `peer forwards floor after reconstruction` checks the real peer's required fourth argument.
  Real MLS: `hub repair moves advanced losing branch` installs actual divergent states and proves external application on the repaired hub.
  `unproven branch exception stays visibly target behind` runs many capped retries without relabelling X not-accepted.
```ts
expect(after.recoveryEpochFloor).toBe(before.recoveryEpochFloor)
expect(after.forkRecoveryAttempt).toMatchObject({ id: yID, forkRecovery: { attemptID: yID, splitEpoch } })
expect(effectiveRecoveryEpochFloor(after, { id: yID, source: activeKey })).toBe(splitEpoch)
expect(effectiveRecoveryEpochFloor(after, { id: zID, source: activeKey })).toBe(before.recoveryEpochFloor)
expect(after.rejoin).toBeNull()
expect(after.settledRejoins[0]).toMatchObject({ kind: 'superseded-branch', epoch: splitEpoch })
expect(savedHistory.record).toEqual(exactX)
expect(afterRollback).toEqual(before)
expect(afterOwnLineageCapture).toMatchObject({ kind: 'retry' })
expect(buildsFromOwnLineageCapture).toBe(0)
expect(typeof realPort.capturedRecovery.authoriseForkRecovery).toBe('function')
expect(realResponderReply.version).toBe(3)
expect(realResponderLineageEpochs).toEqual([10, 11, 12])
expect(realResponderSealedReply.byteLength).toBeLessThanOrEqual(786432)
expect(afterYAbandonment.forkRecoveryAttempt).toBeNull()
expect(belowOldestStatus).toMatchObject({ kind: 'pending', reason: 'target-behind' })
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/rpc test/recovery-capture-reconcile.test.ts test/peer-rejoin-record.test.ts && ktest @kumiai/mls-rpc test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts`.
  Expected: lower/equal-different captures retry despite evidence. Existing type guards also reject the new settlement provenance.
- [ ] **Step 3: Implement the restricted evidence transition.** Require open other-branch testimony from an eligible non-equivocating signer.
  Verify the reply key's E checkpoint equals that other hash, differs from our E fact and binds its offered lineage.
  Require reply-key eligibility in our roster before E. Missing pre-E facts cannot use the ordinary compared-epoch fallback for this authority.
  Authenticate GroupInfo before reading F and confirmedTranscriptHash. Require F >= E.
  If F is retained, require its transcript hash differs from the installed local fact at F. Equal bytes reject despite unequal checkpoint claims.
  If F is below our oldest fact, or inside a retained-range hole, return retry with target-behind.
  If F exceeds the newest fact, require the verified E-to-F other-branch lineage. Do not invent a local fact at F.
  Repeat these checks on every accepted Y capture carrying forkRecovery, including apply, restore, recapture and post-restart retries.
  Update the real lower/equal-epoch guard at `packages/mls-rpc/src/recovery.ts:706-716` and independent guard at `packages/rpc/test/fixtures/memory-group-mls.ts:1454-1467` only for this predicate.
  Revalidate under the owner immediately before settlement. Preserve exact X in sealed history, cumulative obligations and unknown/accepted outcomes.
  Never call the existing not-accepted path. Atomically clear X and save Y's bound intent, then build Y with that fresh ID.
  Compute effective floor E only for that source/ID carrying forkRecovery. Keep the ordinary control floor unchanged.
  On Y settlement or abandonment, remove the intent/exception atomically. Unrelated attempts always use the ordinary floor.
  Equal-number rebuilding requires the different authenticated branch identity. It never rebuilds X on its original capture identity.
  Retain superseded-rejoin history under source-history policy, independently of checkpoint pruning. Never prune owed obligations with evidence expiry.
  For adopted-incomplete X, resolve its saved switch proof first. Use the proven active destination as Y's source, without reinstalling X.
  Retire its unfinished continuation pointer in the same group transition. Bind Y's forkRecovery intent to the proven active destination.
  Authorisation.source fences that active incarnation. Exact X history retains its original source unchanged. Pending switch proof preserves X.
  Without authority, keep ordinary retry semantics and target-behind. Manual authority remains separately scoped in Tasks 15a–15b.
  Wire all R10 adapters and direct real fixtures in this task. Later manual-recovery tasks cannot repair this gate.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/rpc test/recovery-capture-reconcile.test.ts test/peer-rejoin-record.test.ts test/host-boundary.test.ts && ktest @kumiai/mls && ktest @kumiai/mls-rpc test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts test/not-member.test.ts && ktest @kumiai/integration-tests test/branch-abandoned.test.ts && kcontrol && kports && ktest @kumiai/mls-rpc && kfinish`.
  Both real port runners and the independent double execute the new shared recovery rows, including every saved-X stage and restart seam.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: reconcile superseded branch attempts with bound floor evidence'`.

### Task 12a: Journal prospective own IDs and aggregate other-message counts

**Files:** Create `packages/mls-rpc/src/branch-history.ts`, `packages/mls-rpc/test/branch-history.test.ts`.
Modify `packages/mls-rpc/src/{persistence-types,checkpoint-store,memory-incarnation-stores,memory-group-ports,index}.ts`,
`packages/rpc/src/checkpoint-types.ts`, `packages/rpc-conformance/src/{persistence-fixture,group-storage}.ts`,
`packages/mls-rpc/test/fixtures/{storage-persistence,registry}.ts`.
**Interfaces:** Consumes Task 3b installed facts and the existing durable message admission/dedup boundary. Produces
`recordOwnBranchMessage<TTx extends GroupTransaction>(stores: GroupStores<TTx>, params: { key: GroupKey; message: OwnBranchMessage }): Promise<void>` and
`incrementOthersSeen<TTx extends GroupTransaction>(stores: GroupStores<TTx>, params: { key: GroupKey; epoch: number; authHash: string }): Promise<void>`.
CheckpointRecord gains `{kind:'own-branch-messages';id:string;key:GroupKey;epoch:number;authHash:string;messages:Array<OwnBranchMessage>}`,
`{kind:'others-seen';id:string;key:GroupKey;epoch:number;authHash:string;count:number}` and
`{kind:'branch-coverage';id:string;key:GroupKey;startedEpoch:number;startedAuthHash:string}`.
Own IDs come from lastAttempt.publishID, saved before handoff. They report possible sends, without claiming delivery.
Other-message increments co-commit only after existing durable dedup accepts authenticated metadata. No other-sender IDs or per-received-message rows are added.
Rows follow supporting installation retention. Missing older metadata produces explicit partial coverage. Ephemeral sends create no rows.

- [ ] **Step 1: Add failing journal rows.** `acked app events do not erase prospective message IDs` removes outbox/event rows, retaining own IDs/epochs.
  `ten thousand received messages keep one epoch counter` checks count=10000 and fixed checkpoint-row count for others.
  `received replay never increments twice` uses existing dedup and rollback/restart seams. No parallel per-message dedup journal may satisfy it.
  `ephemeral sends leave no journal rows` checks unchanged physical storage. `own message journal contains no plaintext` inspects sealed decoded rows.
  `own messages update at risk without notification` preserves notice revision while updating its local at-risk projection.
- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/branch-history.test.ts`. Expected: absent prospective metadata fails.
- [ ] **Step 3: Co-write ID metadata and epoch counters.** Keep own IDs after event acknowledgement, without adding payload retention.
  Preserve existing message dedup/phase contracts. Do not introduce per-received-message checkpoint rows or new ephemeral persistence.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/branch-history.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: journal own branch IDs and aggregate observed counts'`.

### Task 12b: Report abandonment with confirmed switching

**Files:** Create `packages/mls-rpc/test/branch-abandoned.test.ts`.
Modify `packages/mls-rpc/src/{branch-history,registry-peer,persistence-types,safety,index}.ts`, `packages/mls-rpc/src/registry/{switch,retired}.ts`,
`packages/rpc-conformance/src/{persistence-fixture,registry,safety}.ts`, `packages/rpc/src/{checkpoint-types,index}.ts`,
`packages/mls-rpc/test/fixtures/registry.ts`, `tests/integration/test/{branch-abandoned,recovery-capture-head,recovery-requester-restart}.test.ts`.
**Interfaces:** Consumes Task 12a metadata, Task 5 notices and Task 11's proven branch transition. Produces
`BranchAbandonedEvent = GroupKey & { id: string; kind: 'branch-abandoned'; noticeID: string | null; epochs: AbandonedEpochRange; ownMessages: Array<OwnBranchMessage>; othersSeen: number; membersAdded: Array<string>; membersRemoved: Array<string>; coverage: BranchReportCoverage }`.
Declare it in rpc/src/checkpoint-types.ts. Extend PersistenceEvent and GroupSafety.events/ack with independent structural mirrors.
`prepareBranchAbandonment(params: { source: GroupKey; destination: GroupKey; mutationID: string }): Promise<BranchAbandonedEvent | null>` runs through the bound coordinator.
It uses authenticated retained local history and the established destination, never checkpoint testimony alone.

- [ ] **Step 1: Add failing report rows.** `hub heal reports branch only messages` checks exact own IDs, aggregate others count and authenticated membership delta.
  `ordinary descendant resync has no abandonment` checks ancestry rather than numerical epoch alone.
  `abandonment and destination install share proof` emits nothing before proof/after rollback, then one stable event after late commit/restart.
  `resend output contains only own IDs` excludes other-sender payloads. `partial journal never claims exact historical totals` covers pre-upgrade/pruned metadata.
  Real MLS: `missing ancestry still switches with partial abandonment` proves identical destination, floor, switch proof and timing with missing parent links.
```ts
expect(event.ownMessages.map(({ id }) => id)).toEqual(ownOnlyIDs)
expect(event.othersSeen).toBe(otherBranchMessageCount)
expect(eventsBeforeProof).toEqual([])
expect(unknownEvent.epochs).toBe('unknown')
expect(unknownEvent.coverage.ancestry).toEqual({ kind: 'partial', reasons: ['unknown-ancestry'] })
expect(unknownEvent.coverage.ephemeral).toEqual({ kind: 'partial', reasons: ['ephemeral-uncovered'] })
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/branch-abandoned.test.ts`. Expected: absent report/proof co-write fails.
- [ ] **Step 3: Prepare reports from authenticated history.** Omit unproven branch-only IDs/deltas. Partial counts describe only known observations.
  Unknown ancestry never delays, rejects or redirects an established switch. R2/R7 lineage and transcript authority remain independently required for floor exceptions.
  Co-write report and notice closure with destination installation. Preserve failed-outbox events, certified settlements and every owed token.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/branch-abandoned.test.ts test/registry-retirement-writes.test.ts && ktest @kumiai/integration-tests test/branch-abandoned.test.ts test/recovery-capture-head.test.ts test/recovery-requester-restart.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: report abandoned work with confirmed branch switches'`.

### Task 13: Add guarded app-halt release with durable history

**Files:** Create `packages/mls-rpc/src/clear-hold.ts`, `packages/mls-rpc/test/clear-hold-storage.test.ts`.
Modify `packages/mls-rpc/src/{safety,checkpoint-store,memory-incarnation-stores}.ts`, `packages/rpc/src/control/{safety,types,store}.ts`, `packages/rpc/src/peer.ts`,
`packages/rpc-conformance/src/{control-store,memory-control-store,safety,persistence-fixture}.ts`,
`packages/mls-rpc/test/{control-store-conformance,group-safety}.test.ts`, `packages/rpc/test/control-safety-fields.test.ts`, `packages/rpc/src/checkpoint-types.ts`.
**Interfaces:** Consumes GroupSafety reports and D8 coordinator. Produces internal
`clearReportedHold(key: GroupKey): Promise<void>` and sealed provenance `{kind:'app-hold',id:string,key:GroupKey,producer:'app-report',eventID:string,reportMutationID:string,clearedAt:number|null}`.
Extend ForkHalt with `producer?: 'app-report' | 'internal'` in rpc/src/control/safety.ts and the independent control-store mirror.
Every new producer writes its literal. The optional field exists solely to read legacy records, which never qualify for clearHold.
CheckpointRecord gains this provenance arm and `{kind:'hold-history';id:string;key:GroupKey;halt:ForkHalt;reportMutationID:string}`.
Add a restricted `ControlChanges.clearAppHold?: { eventID: string; reportMutationID: string }`.
The real provider requires private, attempt-scoped authority after reading matching provenance. Bare ControlStore callers cannot clear.
The independent double enforces the equivalent rule without importing the real authority helper.

- [ ] **Step 1: Add failing storage tests.** `only matching app report can be cleared` checks source key, report mutation and event identity.
  `clear keeps immutable evidence in history`: current halt can be released only after its exact evidence/provenance co-write.
  `rollback and uncertain clear preserve hold` exposes no clearance until proof, including late commit.
  `legacy halt with app event ID remains uncleareable` loads a pre-2.2e ForkHalt without producer and asserts byte-identical halt/history after clear.
  `internal provenance cannot inherit app ownership` uses matching event IDs but producer `'internal'`, mismatched report mutations and concurrent app reports.
  `non app conditions survive clear` covers unsupported-version, recovery-unavailable and internal latches. Tasks 10/18 cover their new conditions.
  `repeated reports after clear preserve both incidents` checks separate history identities and replayable current event.
```ts
expect(await history()).toContainEqual(originalAppHalt)
expect(internalHoldAfterClear).toEqual(internalHoldBeforeClear)
expect(legacyHaltAfterClear).toEqual(legacyHaltBeforeClear)
expect(newAppHalt.producer).toBe('app-report')
expect(newInternalHalt.producer).toBe('internal')
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/clear-hold-storage.test.ts`. Expected: immutable-only halt cannot clear.
- [ ] **Step 3: Implement storage authority and history.** Mark new GroupSafety halts and provenance as `producer: 'app-report'`.
  Mark peer invariant halts as `producer: 'internal'`. Decode legacy producer absence unchanged, without migration or event-ID inference.
  Internal writers cannot inherit old app provenance. Raw null, mismatched provenance and stale clear attempts reject unchanged. No active app report makes clearHold an idempotent no-op.
  Legacy halts therefore remain held after clearHold. Document manual recovery as their only recovery path.
  Keep this internal until Task 14 supplies live release propagation. Existing report/ack behaviour remains usable after this task.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/clear-hold-storage.test.ts test/group-safety.test.ts && kcontrol && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: preserve app halt provenance and guarded release history'`.

### Task 14: Expose clearHold and resume live peers and subscriptions

**Files:** Modify `packages/mls-rpc/src/{safety,index,mls,registry-group-mls}.ts`,
`packages/mls-rpc/src/registry/{runtime,registry,safety,consumers}.ts`, `packages/rpc/src/{crypto,host-boundary,peer,hub-mux}.ts`,
`packages/rpc-conformance/src/{group-mls,safety}.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`.
Create `packages/mls-rpc/test/clear-hold-live.test.ts`, `packages/rpc/test/hub-mux-clear-hold.test.ts`.
Modify `packages/mls-rpc/test/not-member.test.ts`, `tests/integration/test/group-conditions.test.ts`.
**Interfaces:** Consumes Task 13. Produces `GroupSafety.clearHold(key: GroupKey): Promise<void>`.
Add `onSafetyChanged(key: GroupKey, sink: (reason: SafetyHold) => void): () => void` alongside the existing non-null hold subscription.
Add optional `GroupMLS.onSafetyChanged(sink: (reason: SafetyHold) => void): () => void`, with host-bound defensive wrappers.
Add `HubMux.resume(): void` to retry deferred subscriptions and resume the receive drain after a proven release.

- [ ] **Step 1: Add failing live tests.** `clear app halt resumes ordinary walk` resumes same-key work without forced resync.
  `clear before proof leaves every live lane closed` tests sends/opens/build/adoption/ephemeral paths and deferred subscription work.
  `clear cannot erase a newer internal latch` suspends proof, raises another latch and asserts it survives.
  `legacy halt stays held live and after restart` confirms no release notification, network resume or provenance reconstruction.
  `clearHold cannot erase retrying not member condition` checks unchanged evidence, active retries and unchanged stranded/hold admission rules.
  `clear during pending subscribe retains exactly one holder` checks retain/release/rearm/dispose balance and reconnect.
  `deferred holder released before clear never subscribes` rejects resurrection. Unchanged heartbeat replay does not affect holds.
```ts
expect(subscribeCallsAfterClear).toBe(1)
expect(subscribeCallsForReleasedHolder).toBe(0)
expect(internalHoldAfterAppClear).not.toBeNull()
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/clear-hold-live.test.ts test/not-member.test.ts && ktest @kumiai/rpc test/hub-mux-clear-hold.test.ts`.
  Expected: missing clear notification and dropped gated refcount fail.
- [ ] **Step 3: Replace irreversible runtime caching with provenance-aware state.** Release only the proven cleared app incident.
  Recompute admission from remaining persistent/volatile holds and refresh the ordinary commit walk.
  A gated retain records its holder/options before deferring network work. Resume only demanded subscriptions.
  Existing onSafetyHold consumers still receive non-null latches. The new nullable subscription carries release without weakening stale-owner fencing.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/clear-hold-live.test.ts test/not-member.test.ts && ktest @kumiai/rpc test/hub-mux-clear-hold.test.ts && ktest @kumiai/integration-tests test/group-conditions.test.ts && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: clear app reported holds across live group consumers'`.

### Task 15a: Persist isolated manual attempts and target selection

**Files:** Create `packages/mls-rpc/src/manual-recovery.ts`, `packages/rpc-conformance/src/manual-recovery.ts`,
`packages/mls-rpc/test/manual-recovery-conformance.test.ts`.
Modify `packages/mls-rpc/src/{checkpoint-store,index}.ts`, `packages/rpc-conformance/src/{registry-fixture,safety,persistence-fixture,index}.ts`,
`packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/src/{persistence-types,safety}.ts`, `packages/rpc/src/{checkpoint-types,index}.ts`.
**Interfaces:** Consumes D8, captured recovery and DN1's existing host resolver. Produces
`ManualRecoveryRecord = { id: string; source: GroupKey; choice: PersistedManualRecovery; stage: 'authorised' | 'completed'; pauseReason: 'target-unresolved' | null; destination: GroupKey | null; attempt: CapturedRejoinRecord | null; epochFloor: number | null; settlements: Array<AcceptedRejoinSettlement>; mutationID: string }`.
`PersistedManualRecovery` is `{mode:'resync';targetID:string;commitTopicID:string;allowOpenFork:boolean}` or `{mode:'successor';successor:GroupKey}`.
Both record types live in rpc/src/checkpoint-types.ts. CheckpointRecord gains `{kind:'manual-recovery';id:string;key:GroupKey;value:ManualRecoveryRecord}`.
Only targetID and sealed commitTopicID identify resync transport. Persist allowOpenFork separately as explicit current-move authority. Hub methods and reconstruction descriptors never enter this record.
`ManualRecoveryStatus = { id: string; kind: 'pending' | 'paused' | 'completed'; reason: 'target-unresolved' | null }`
also lives in rpc/src/checkpoint-types.ts. Add `manualRecovery: ManualRecoveryStatus | null` to Task 10's GroupSafety.status result now.
Derive paused status from saved pauseReason without deleting or replacing authorisation.
`authoriseManualRecovery(key: GroupKey, choice: PersistedManualRecovery): Promise<ManualRecoveryRecord>` saves this record.
`manualRecoveryControl(id: string): ControlStore` overlays only rejoin/floor/settled rows on the unchanged source snapshot.
Its writes permit only the corresponding recovery changes, bound to this authorisation. Ordinary operations/holds remain untouched.

- [ ] **Step 1: Add failing storage-only authorisation/overlay rows.** Call authoriseManualRecovery and manualRecoveryControl directly, without network/executor calls.
  `manual overlay requires committed authorisation` rejects use before proof. `manual saved target survives reopen` preserves source/choice/authorisationID.
  `manual transport binding persists no hub methods` inspects targetID/commitTopicID plus explicit allowOpenFork, without serialised methods.
  `manual attempt cannot overwrite ordinary X` checks byte-identical ordinary control across overlay save/retry/rollback.
  `manual floor authority is isolated from ordinary recovery` changes only the authorised overlay and carries cumulative obligations.
- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/manual-recovery-conformance.test.ts`.
  Expected: missing storage APIs/overlay fail. GroupSafety.recover intentionally remains unavailable. Network/resolver/restart execution rows belong to Tasks 15b/16a.
- [ ] **Step 3: Implement the sealed record and restricted overlay.** Keep the ordinary X pointer immutable throughout a manual attempt.
  Save fresh manual candidates independently, carrying cumulative ledger obligations. Bind each nested attempt to source, target and authorisationID.
  A provider-scoped capability authorises the manual floor exception. Raw store writes cannot acquire it.
  Persist resolver failure/mismatch as pauseReason `'target-unresolved'`. Successful resolution resumes the identical record and clears only that pause.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/manual-recovery-conformance.test.ts && kcontrol && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: persist isolated manual recovery attempts'`.

### Task 15b: Execute registered-target recovery through restricted switching

**Files:** Modify `packages/mls-rpc/src/{safety,manual-recovery,registry-peer,registry-group-mls,mls,index}.ts`,
`packages/mls-rpc/src/registry/{switch,verdict,switch-write,types,retired,continuation,recovery-coordinator}.ts`,
`packages/rpc/src/{peer,peer-types,host-boundary}.ts`, `packages/rpc-conformance/src/{safety,registry-fixture,manual-recovery}.ts`,
`packages/mls-rpc/test/{manual-recovery-conformance,safety-conformance,group-safety}.test.ts`, `packages/rpc/test/host-boundary.test.ts`.
**Interfaces:** Consumes Task 15a. Produces `runManualRecovery(record: ManualRecoveryRecord): Promise<GroupKey>` and
private coordinator `runManual(record: ManualRecoveryRecord): Promise<GroupKey>`.
Activate the public registered arm `{mode:'resync';targetID:string;allowOpenFork?:boolean}`. Save the override even before current movement activates.
Extend RecoveryPendingReason with `'target-unresolved'`, retaining no-reply/no-eligible-responder/target-behind and optional pending authorisationID.
Both pending and not-member.pendingReason use that union. Test that unresolved manual recovery remains visible while not-member is set.
`reason: 'target-unresolved'` exposes the paused manual record. Ordinary pending behaviour remains unchanged.
`RegistrySwitchWrite.source` gains optional `authorisationID: string`; its presence requires the matching manual record rather than ordinary control.rejoin.
GroupPeerMLSParams gains `manualRecovery?: { authorisationID: string; source: GroupKey }`.
GroupMLS constructor recovery dependencies receive the same bound authority, never an unchecked boolean.
Classify manualRecovery as data in host-boundary.ts. Mirror source.authorisationID in rpc-conformance/src/registry-fixture.ts at this activation.
Migrate `packages/mls-rpc/test/group-safety.test.ts:644-677` now: replace only registered-resync unavailable assertions. Keep successor unavailable until Task 17.

- [ ] **Step 1: Add failing executor tests.** `manual attempt crosses strong holds without opening ordinary work` keeps ordinary sends/opens closed.
  `failed manual recovery preserves prior state and halt` covers trust/refusal/spent/target/proof failures.
  `manual continuation survives source retirement` resumes bootstrap using the saved manual adopted record.
  `manual floor override preserves exact accepted work` keeps ordinary X and ledger obligations while using a fresh selected-target attempt.
  `unresolved registered target pauses visibly` checks pending reason/authorisationID and zero calls to other registered hubs.
  `manual authorisation precedes every network action` suspends proof and asserts zero requests. `restart resumes only authorised target` fences target substitution.
  `successful rejoin leaves source holds in history` checks the new incarnation has no holds, while source app/internal/legacy evidence remains unchanged.
  `all held responders stay silent` checks both ordinary and roster requests. Manual recovery cannot open a responder lane on a held source.
  `heal after evidence expiry stays target-behind; manual resync exits` uses split E=10, X=20 and continuing capture F=12.
  At supersession age 604800000 ms, prune E evidence and assert automatic target-behind, unchanged X/floor and continuing retries.
  Authorise registered-target manual resync, confirm the external candidate and assert a fresh installed incarnation with preserved exact X history/obligations.
  Repeat after restart and count-bound expiry at installation 257. No expired summary restores automatic authority.
```ts
await expect(ordinarySendDuringManualAttempt).rejects.toBeInstanceOf(GroupSafetyHeldError)
expect(sourceAfterFailedAttempt).toEqual(sourceBefore)
expect(completedManual.destination).toEqual(installedKey)
expect(expiredAutomaticStatus).toMatchObject({ kind: 'pending', reason: 'target-behind' })
expect(afterManualExit.installedKey).not.toEqual(sourceBefore.key)
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/manual-recovery-conformance.test.ts`.
  Expected: unavailable recovery and automatic-only switch-write guards fail the manual rows.
- [ ] **Step 3: Activate registered resync.** Accept manual triggers only with a proven matching authorisation through peer, MLS and registry layers.
  Confirm the exact external candidate. Re-read source after hook drainage and resolve saved switchMutationID before retries.
  Recheck source, authorisation and remaining safety conditions after every await and before save/publication.
  Retire ordinary X under explicit app authority, preserving unknown/accepted outcomes and obligations. Never treat it as remotely unapplied.
  Co-write manual adopted destination and continuation identity. The continuation reader selects the authorised manual record without fabricating legacy metadata.
  A successful rejoin installs a new incarnation without source holds. Failure preserves source state/holds and exact ordinary X.
  Keep source internal latches as history. The new incarnation does not clear or mutate those source records.
  Keep successor unavailable until Task 17. Do not open ordinary lanes or serve recovery replies on hard-held devices.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/manual-recovery-conformance.test.ts test/group-safety.test.ts && ktest @kumiai/rpc test/host-boundary.test.ts && kcontrol && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: execute authorised recovery through restricted switches'`.

### Task 16a: Persist and reconstruct call-time target bindings

**Files:** Create `packages/mls-rpc/test/hub-migration.test.ts`, `tests/integration/test/hub-migration.test.ts`.
Modify `packages/mls-rpc/src/{safety,manual-recovery,registry-peer,registry-group-mls,mls,index}.ts`,
`packages/rpc-conformance/src/{manual-recovery,safety}.ts`, `packages/mls-rpc/test/fixtures/registry.ts`.
**Interfaces:** Consumes Task 15b and unchanged `resolveTarget: (targetID: string) => Promise<RecoveryTarget>`.
Produces ManualRecovery's call-time arm `{mode:'resync';target:{targetID:string;hub:LogHub & MailboxHub;commitTopicID:string};allowOpenFork?:boolean}`.
Save targetID/topic plus explicit allowOpenFork before using the supplied live hub. Save no methods or reconstruction descriptors.
On restart, require resolver id/topic equality with the saved binding. RegistryPeerOptions forwards only that resolved binding to peer factories.
Unresolved/mismatched targets persist pauseReason target-unresolved and visible pending status, retaining the same attempt. No fallback exists.

- [ ] **Step 1: Add failing binding rows.** `unresolvable call time target remains paused` restarts without the original hub object and makes resolveTarget reject.
  `resolver cannot substitute saved target or topic` checks unchanged source/routing/holds and zero calls to alternative hubs.
  `restored host handle resumes identical move` preserves authorisationID, source, saved attempt bytes and cumulative obligations.
  `call time authority is saved before hub use` checks zero network calls before proof and durable allowOpenFork scope.
  Real MLS: `unresolved durable target pauses without fallback` restores the same target handle and resumes exact saved work.
- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/hub-migration.test.ts`. Expected: unsupported call-time target fails.
- [ ] **Step 3: Implement binding persistence and resolver reconstruction.** A failed resolver pauses the same record, without deleting or replacing authority.
  Successful resolution clears only that pause. Executor/network restart tests begin here, after Task 15b activates recovery.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/hub-migration.test.ts && ktest @kumiai/integration-tests test/hub-migration.test.ts && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: persist call time recovery target bindings'`.

### Task 16b: Move current devices or rejoin through destination responders

**Files:** Modify `packages/mls-rpc/src/{safety,manual-recovery,registry-peer,registry-group-mls,mls}.ts`,
`packages/rpc/src/{peer-types,peer,checkpoint-worker}.ts`, `packages/rpc-conformance/src/{manual-recovery,safety}.ts`,
`packages/mls-rpc/test/hub-migration.test.ts`, `packages/rpc/test/fixtures/memory-group-mls.ts`,
`packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/README.md`, `packages/rpc/README.md`.
Modify `tests/integration/test/hub-migration.test.ts`.
**Interfaces:** Consumes saved Task 16a bindings and Task 11's restricted floor authority. Produces
`canMoveCurrent(params: { control: ControlSnapshot; activity: { pending: number }; stateReadable: boolean; ledgerComplete: boolean; walkComplete: boolean; outboxUnresolved: boolean; settlementUnresolved: boolean; hardHold: SafetyHold; condition: GroupCondition | null; openForkNotice: boolean; activeRejoin: boolean; allowOpenFork: boolean }): boolean`.
Require readable state, complete ledger/walk, no known lag/slot/operation/unresolved publication or settlement and zero pending owner work.
Also require no hard hold, condition or active ordinary/manual rejoin. Require no open notice unless the saved allowOpenFork is true.
The override affects only that notice predicate. All other exclusions remain mandatory.
Current movement keeps GroupKey and holds unchanged. A rejected current move uses destination responders through a confirmed fresh-incarnation rejoin.
A completed rejoin creates a hold-free incarnation, retaining source holds as history. Failed recovery leaves source/routing/holds intact.

- [ ] **Step 1: Add failing migration rows.** `current device moves without rejoin` preserves GroupKey/authenticator/ratchet generations.
  `current move refuses every hold condition notice and active rejoin` covers app/internal/legacy holds and not-member/spent-set-corrupt/recovery-unavailable.
  Recovery-unavailable already enters through SafetyHold. The other two also have GroupCondition records.
  `allow open fork overrides only notice exclusion` proves other exclusions remain active, including holds, conditions and ordinary X.
  `manual move under legacy halt requires rejoin` never seeds an empty destination. Hold-free new incarnation requires authenticated responders and bound confirmation.
  `known behind device never starts destination log` asserts zero publication before confirmed recovery.
  `restart mid move contacts only saved destination` makes every old-hub method throw.
  `empty topic starts at current state then peers CAS` installs one first publication and requires subsequent processing.
  `destination mismatch preserves saved work` checks exact retries/recapture instead of local rollback.
  `move carries rendezvous and checkpoint workers` keeps derived topics, shares the destination mux and fences old workers.
  Real MLS: `ahead device reaching migrated topic stays visibly pending` checks target-behind without R2/R7 authority, intact X/floor and capped retries.
  `partial migration diverges without notice` partitions devices across hubs and asserts no false halt, rollback or cross-hub detection claim.
```ts
expect(keyAfterCurrentMove).toEqual(keyBefore)
expect(authenticatorAfterCurrentMove).toEqual(authenticatorBefore)
expect(oldHubCallsAfterRestart).toBe(0)
expect(knownBehindPublishBeforeRecovery).toBe(0)
expect(aheadStatus).toMatchObject({ kind: 'pending', reason: 'target-behind' })
expect(sourceInternalLatchAfterSuccessfulRejoin).toEqual(sourceInternalLatchBefore)
expect(destinationHoldAfterSuccessfulRejoin).toBeNull()
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/hub-migration.test.ts`. Expected: movement predicate/routing mechanics fail.
- [ ] **Step 3: Implement proof-gated transport movement.** Persist selected binding before stopping source work. Publish active routing only after proof.
  Current movement resets transport cursors, retaining MLS state. Behind/held/diagnosed devices recover only from authenticated destination responders.
  Treat local freshness as absence of known lag, without claiming proof against selective withholding.
  Document that apps must move every device. Separate hubs cannot exchange checkpoint evidence in-band.
  Document ahead-arrival target-behind and R2/R7's evidence exception. Destination selection and successor creation remain app-owned.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/hub-migration.test.ts && ktest @kumiai/integration-tests test/hub-migration.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: guard current moves and rejoin through selected destinations'`.

### Task 17: Retire to a successor and guard Welcome tombstones

**Files:** Create `packages/mls-rpc/src/successor.ts`, `packages/mls-rpc/test/successor-recovery.test.ts`.
Modify `packages/mls-rpc/src/{safety,manual-recovery,checkpoint-store,index,persistence-errors}.ts`, `packages/mls-rpc/src/registry/{seed,retired,registry}.ts`,
`packages/rpc-conformance/src/{manual-recovery,registry,safety,persistence-fixture}.ts`, `packages/mls-rpc/test/fixtures/registry.ts`, `packages/rpc/src/{checkpoint-types,index}.ts`,
`packages/mls-rpc/test/group-safety.test.ts`, `tests/integration/test/group-conditions.test.ts`, `packages/mls-rpc/README.md`.
**Interfaces:** Consumes a normally admitted available successor and Task 15a authorisation. Produces
`GroupSafety.clearTombstone(groupID: string): Promise<void>` and
`SuccessorTombstone = { kind: 'successor-tombstone'; id: string; source: GroupKey; successor: GroupKey; authorisationID: string; retiredAt: number; clearedAt: number | null }`.
CheckpointRecord gains `{kind:'successor';id:string;key:GroupKey;value:SuccessorTombstone}`, with the portable value type declared alongside it.
GroupSafety.recover's successor arm returns the validated successor key after source retirement proof. SeedAdmissionRefusalReason adds 'successor-tombstone'.
Migrate the remaining successor-unavailable assertion in `packages/mls-rpc/test/group-safety.test.ts:644-677` at this activation, preserving factory-binding refusals.

- [ ] **Step 1: Add failing shared retirement tests.** `successor must already be admitted` rejects missing, wrong-key and unavailable targets before source retirement.
  `successor retires source without copying state` asserts no shared ratchets/messages/roster mutation and no source publishes.
  `old Welcome cannot bypass successor tombstone` covers newer/unspent Welcome, restart and empty private state.
  `explicit tombstone clear preserves spent checks` permits only otherwise admissible fresh invitation, never spent replay.
  `successor retirement preserves owed work and history` drains hooks first and keeps events/Welcomes/certified obligations.
  `source corruption does not require private restoration for successor` uses retained administrative records safely.
  Real MLS: `all devices legacy halted exit through successor` proves every held responder stays silent, resync stays pending and successor retirement succeeds.
  `move restart and successor are app controlled` adds successor/tombstone assertions alongside the already-owned migration witnesses.
```ts
expect(sourceTombstone.successor).toEqual(successorKey)
await expect(sourceReadmission(oldWelcome)).rejects.toBeInstanceOf(SeedAdmissionRefusedError)
expect(successorStateAfterRetirement).toEqual(successorStateBefore)
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/successor-recovery.test.ts`. Expected: no successor/tombstone operation exists.
- [ ] **Step 3: Implement independent source transition.** Validate successor without holding both group gates.
  Drain source hooks before writes. Persist tombstone, selected action completion, failures and routing retirement atomically.
  Preserve the current ordinary delete unsettled-control policy. Successor retirement uses explicit authorised abandonment, not silent ordinary deletion.
  Tombstone clear releases only the successor readmission block, never an internal safety latch or spent set.
  Document successor mode as the exit when every device is halted. Manual resync never opens a held recovery-response lane.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/successor-recovery.test.ts test/group-safety.test.ts && ktest @kumiai/integration-tests test/group-conditions.test.ts && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: retire groups to admitted successors with tombstones'`.

### Task 18: Distinguish surviving-store spent-set corruption

**Files:** Modify `packages/mls-rpc/src/{safety-conditions,persistence-errors,persistence-codec,persistence-guards,memory-group-state,registry-peer,index}.ts`,
`packages/mls-rpc/src/registry/{safety,seed,source-trust,registry,access,cold,runtime-facts}.ts`,
`packages/rpc-conformance/src/{safety,registry,group-storage}.ts`, `packages/mls-rpc/src/entry-capability.ts`.
Create `packages/mls-rpc/test/spent-set-corrupt.test.ts`.
Modify `packages/mls-rpc/test/fixtures/registry.ts`, `packages/mls-rpc/test/{registry-safety-admission,registry-source}.test.ts`,
`tests/integration/test/group-conditions.test.ts`.
**Interfaces:** Consumes Task 10 condition surfaces. Produces SpentSetCorruptError on admission/access after a decrypted envelope reveals missing/malformed spent data, and
RegistryPeerStatus `{kind:'spent-set-corrupt';eventID:string}`. Uses internal `persistGroupCondition(key, 'spent-set-corrupt', null)` without opening corrupt state.
An undecryptable combined trust envelope, including key loss, stays recovery-unavailable. No separate spent store or inferred corruption exists.
Apply this safety/status precedence: hard safety holds > spent-set-corrupt > not-member > recovery-unavailable > pending.
Admission and peer startup retain their stranded/hold rules. Not-member adds no admission error or refusal (R8).
Keep lower-precedence records/evidence intact. `status().condition` selects spent-set-corrupt before not-member, while stronger safety holds still gate work.

- [ ] **Step 1: Add failing corruption rows.** `decrypted trust with missing spent set reports spent corruption`, `unreadable combined envelope stays recovery unavailable`,
  `empty or malformed set never becomes empty baseline`, `clearHold and event ack cannot repair corruption`.
  `condition precedence preserves all evidence` tests each adjacent pair and all five states together across admission, status, startup and restart.
  `total key and database loss permits fresh same group invite` checks old Welcomes cannot decrypt despite retained signing identity.
  `transient provider error is not corruption` preserves typed transient/storage errors without persisting a false condition.
  `warm observation persists spent corruption across restart` primes registry access/runtime caches, then exposes decrypted empty/malformed spent data.
  Assert distinct error, durable event and admission/status projection through access, cold load, runtime facts, observation and peer startup.
  Migrate `packages/mls-rpc/test/registry-safety-admission.test.ts:461-485,873-902,1009-1033` and `packages/mls-rpc/test/registry-source.test.ts:220-257` for decrypted spent corruption.
  Seed/access/source expose SpentSetCorruptError. reportFork exposes GroupSafetyHeldError with reason spent-set-corrupt. Unreadable-envelope assertions retain their old diagnosis.
  Real MLS: `legacy holds and envelope loss retain exact diagnoses` covers source holds and DN5 precedence without direct condition writes.
```ts
await expect(seedWithMissingSpentSet()).rejects.toBeInstanceOf(SpentSetCorruptError)
expect(await clearCannotRepair()).toMatchObject({ condition: 'spent-set-corrupt' })
expect(await unreadableEnvelopeStatus()).toMatchObject({ hold: 'recovery-unavailable', condition: null })
expect(await multipleConditionsStatus()).toMatchObject({ hold: 'fork-halted', condition: 'spent-set-corrupt' })
expect(await statusAfterAppHoldClear()).toMatchObject({ hold: 'spent-set-corrupt', condition: 'spent-set-corrupt' })
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/spent-set-corrupt.test.ts`. Expected: current generic recovery-unavailable diagnosis differs.
- [ ] **Step 3: Classify spent data only after envelope decryption.** Keep envelope/key loss as recovery-unavailable in seed, trust/source reads and startup/status.
  Keep all admission guards and spent-authenticator ordering. No automatic set reconstruction or fallback exists.
  Extend registry.ts diagnoseFailure and diagnoseObservation to persist this distinct diagnosis. Readable empty spent data cannot remain generic trust-unavailable.
  Refresh warmed access/cold/runtime-facts projections and accounted observations. A changed enum alone cannot repair existing caches.
  Persist through safety-only writes. Apply precedence without clearing prior holds or lower-precedence evidence. Not-member remains non-terminal.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/mls-rpc test/spent-set-corrupt.test.ts test/registry-safety-admission.test.ts test/registry-source.test.ts && ktest @kumiai/integration-tests test/group-conditions.test.ts && ksafety && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'feat: expose surviving spent set corruption distinctly'`.

### Task 19: Close recovery diagnostics and constructor/key hygiene

**Files:** Modify `packages/rpc/src/{peer,peer-types}.ts`, `packages/mls-rpc/src/{recovery,registry-group-mls}.ts`,
`packages/rpc/test/fixtures/peer.ts`, `packages/mls-rpc/test/{registry-delivery-safety,registry-peer,registry-recovery-consumer}.test.ts`,
`tests/integration/test/fixtures/fork-halt.ts`, `packages/rpc/test/recovery-capture-reconcile.test.ts`,
`packages/mls-rpc/test/recovery-retained-trust.test.ts`, `packages/rpc/README.md`, `packages/mls-rpc/README.md`.
Create `packages/rpc/test/recovery-key-cleanup.test.ts`, `packages/mls-rpc/test/recovery-diagnostics.test.ts`.
**Interfaces:** Consumes existing RecoveryEvent and RegistryPeerStatus. Produces diagnostic reasons
`'below-epoch-floor' | 'legacy-recovery-record' | 'capture-authenticator-disagreement' | 'target-behind'` in the applicable recovery diagnostic union.
Remove unused `RegistryGroupMLSParams.onConfirmedRecovery` and its validation. Keep createRegistryPeer's actual coordinator callback and createMLS callback intact.

- [ ] **Step 1: Add failing diagnostic tests.** `every floor and legacy retry exposes reason` and `same epoch disagreement diagnoses without halt` assert capped retry and intact X.
  `switch proof remains visibly pending without elapsed bound` advances fake time across many retries, with no new count limit.
  `target behind preserves exact active attempt without authority` distinguishes lower/equal-different captures from no-reply and ineligible-reply hints.
  `early request failure zeroises owned key` covers requestGroupInfo rejection, live hold and dispose before save.
  `durably owned request key survives until settlement proof` prevents finally cleanup from erasing saved X's key prematurely.
```ts
expect(requestKey.every((byte) => byte === 0)).toBe(true)
expect(savedOwnedKey).toEqual(originalKey)
expect(statusAfterManyProofRetries.kind).toBe('pending')
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/rpc test/recovery-key-cleanup.test.ts && ktest @kumiai/mls-rpc test/recovery-diagnostics.test.ts`.
  Expected: missing diagnostics and unzeroised early-throw key fail.
- [ ] **Step 3: Implement finally cleanup and diagnostic emission.** Transfer key ownership only after proven attempt save.
  Remove the unused constructor parameter from the six inventoried caller files. Document serial-handler re-entry constraints in the rpc handler section.
  Keep cumulative settlement rows at the existing one-row fold, preserving every owed token. Do not prune obligations speculatively.
  Zeroise owned live buffers after proven settlement, preserving R2's separately sealed exact-X history.
- [ ] **Step 4: Verify GREEN.** `kbuild && ktest @kumiai/rpc test/recovery-key-cleanup.test.ts && ktest @kumiai/mls-rpc test/recovery-diagnostics.test.ts && kports && ktest @kumiai/mls-rpc && kfinish`.
- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'fix: surface recovery retries and close request key cleanup gaps'`.

### Task 20: Document the shipped surface and run final gates

**Files:** Modify `packages/rpc/README.md`, `packages/mls-rpc/README.md`, `.changeset/spec-p-storage-foundation.md`,
`packages/mls-rpc/test/readme-persistence.test.ts`, `packages/rpc/test/protocol-surface-types.test.ts`.
**Interfaces:** Consumes final public exports. Produces tested examples for checkpoint export/import, notices, all manual modes, clearHold, tombstone clear and condition status/errors.

- [ ] **Step 1: Add example/type checks.** `documented recovery choices compile` exercises targetID/hub/topic and the unchanged resolver signature.
  `documented condition handlers narrow precisely` checks non-terminal evidence/status, retrying:true and defensive fact/export/coverage results.
  `documented absence policy waits for corroboration` checks evidence.responderDIDs, responderCount and optional status.pendingReason in examples.
  `manual surface does not expose generic safety reset` checks there is no numeric floor reset or arbitrary hold-clear API.
```ts
expectTypeOf(resyncChoice).toMatchTypeOf<ManualRecovery>()
expectTypeOf(status.condition).toEqualTypeOf<GroupCondition | null>()
expectTypeOf(abandonment.epochs).toEqualTypeOf<AbandonedEpochRange>()
expectTypeOf(notice.coverage.ownMessages).toEqualTypeOf<ReportCoverage>()
expectTypeOf(notMemberStatus.pendingReason).toEqualTypeOf<RecoveryPendingReason | undefined>()
expectTypeOf(notMemberEvidence.responderDIDs).toEqualTypeOf<Array<string>>()
```

- [ ] **Step 2: Run RED.** `kbuild && ktest @kumiai/mls-rpc test/readme-persistence.test.ts && ktest @kumiai/rpc test/protocol-surface-types.test.ts`.
  Expected: stale examples or absent exports fail. Existing passing examples stay meaningful regressions.
- [ ] **Step 3: Update docs and the existing release intent.** Explain detection limits, signer privacy, retention coverage and local-clock notice timing.
  Replace unavailable-until-2.2e language with implemented behaviour. Distinguish full key/database loss from surviving spent corruption.
  Describe durable target handles, allowOpenFork scope, visible pause, coverage/ephemeral limits and unknown ancestry.
  Document DID+key historical disclosure, obsolete-incarnation pending, legacy manual rejoin and all-held successor exit.
  Explain lineage-relative not-member freshness, continued retries and diagnostic-only admission semantics.
  Document clearance after install, head-only reconcile and re-anchor. Explain responderDIDs/count and optional pendingReason.
  Advise apps against disposal/deletion on first evidence. Wait for another responder DID or persistence before irreversible app action.
  App policy owns disposal/deletion/re-invitation. Corroboration is advice, not a protocol threshold.
  Explain comparisonEpoch selection and bounded requested lineage spans. Never claim 256 maximum-sized frames fit a 786432-byte reply.
  Document expired-evidence target-behind and the explicit manual-resync exit, including seven-day and count-bound expiry.
  Explain per-capture GroupInfo transcript binding and Y-scoped effective floor. Ordinary floors remain unchanged after Y settles or is abandoned.
  Record R7's accepted residual: deliberately malicious coherent fake GroupInfo plus checkpoint chains are outside the intent-trusted peer model.
  Fake Y affects only the attacker's fake state and is never confirmed by honest members. Require no distinct-DID threshold for two-member healing.
  Distinguish no-reply/no-eligible-responder/target-behind, unreadable envelopes and condition precedence.
  State that apps move every device. Cross-hub partial migration cannot reveal forks in-band and ahead arrivals may remain pending.
  Explain per-group checkpoint traffic/subscription multiplication and app/hub-owned retained-log policy. No new global scheduler is included.
  Preserve phase-2.3 exclusions and handler non-reentrancy. Add no new release/version files.
- [ ] **Step 4: Run final verification.** Execute the commands below. Expected: all gates green and no skipped required implementation/double variant.

```bash
rtk proxy pnpm turbo run build:js build:types --force --env-mode=loose
rtk proxy pnpm turbo run test:types --force --env-mode=loose
ktest @kumiai/mls
ktest @kumiai/mls-rpc
ktest @kumiai/rpc
ktest @kumiai/integration-tests
kcontrol
ksafety
kports
rtk proxy pnpm run check:versions
rtk proxy pnpm change status
rtk proxy pnpm run lint
```

- [ ] **Step 5: Future commit.** Stage the declared closure. `git commit -m 'docs: describe fork notices and explicit recovery controls'`.
  Record phase-2.3/provider/SIGKILL exclusions in handoff. Do not merge before all phase-2 work completes.

## Coverage table

| Binding section or finding | Implementing task and decisive evidence |
| --- | --- |
| Intent/threat model/resolution/anti-goals, Goals 1–2 | 0, 5–6, 12b -- real split on both sides, lone buggy signer only notifies, own-only abandonment |
| Goals 3–6, amended by R1/R6/R8 | 10, 14–18 -- diagnostic absence, lineage-relative freshness, manual modes, clearHold and spent diagnosis |
| Non-goals, app-owned routing, undeclared restore | 0, 16a–17, 20 -- explicit destination/successor, no copying or branch ranking |
| §1 format/domains/privacy, parent lineage, My calls 1–2 | 1, 3b–4, 8 -- exact vectors, private signer resolution, pre-split DID+key eligibility |
| §1 atomic capture and installed-only signing, R7 | 1–4 -- installed confirmedTranscriptHash in local facts only, complete writer migration, proven fact/debt, progress unchanged |
| §1 cadence/receive budgets/incarnation fences | 4, 6 -- exact saved bytes/IDs, bounded turns, no remote signing, retired workers fenced |
| §1 retention/sealing/effective comparison floor | 2–5 -- AAD isolation, 256/seven-day pruning, public effectiveFloor/ranges/holes across incarnations |
| §1 authorise policy and independent hub heads | 7 -- same configured commit/checkpoint policy, no CAS/head coupling, real/double/SQL/wire rows |
| §1 portable export/import/standalone verification | 1, 4–5 -- defensive exact frames, local fact binding, no imported provenance |
| §2 notice fields, material changes, ack/restart, My call 3 | 5 -- 30000 ms coalescing, 86400000 ms quiet close, local clocks |
| §2 evidence lifetime, DN3 amended by R4 | 0, 3b, 5 -- count/age bounds apply while unacknowledged, late ack never extends retention |
| §3 abandonment, own IDs/counts/member delta | 12a–12b -- prospective own IDs, fixed other-message counter, authenticated report/proof |
| §3 unknown ancestry, DN3 coverage/ephemeral exclusion | 12b -- unknown range, partial fields, identical established switch, no ephemeral rows |
| §3 floor exception, My call 4 amended by R2/R7 | 11 -- E-lineage plus MLS transcript binding on every Y capture, Y-only effective floor, no equivocation-only authority |
| §3 saved X and r23 cumulative obligations, R2/R7 | 0, 11 -- superseded-branch history/pointer/Y-intent atomicity, ordinary floor unchanged, every X stage/restart, never not-accepted |
| §4/Goal 3 explicitly changed by R1/R6/R8 | 0, 8–10 -- branch-relative evidence, diagnostic condition keeps retries, install/head-only/re-anchor clear it |
| DN2 former-member disclosure, R4 DID+key gate | 8–10 -- request-bound public-only roster/ledger, never-seen/expired/unseen-device refusal |
| R6 / re-review opus N1 | 10 -- X=20/continuing=12/split=10 surfaces absence, reinvite=8/responder=6 rejected, equal-epoch same-lineage rejected |
| R7 / re-review opus N2 | 1, 3a–3b, 11, 20 -- installed transcript fact, own-lineage capture refused despite testimony, two-member healing, explicit insider residual |
| R7 / re-review opus N3 | 11 -- retry/restart per-capture transcript check, target-behind below oldest fact, Y settlement/abandonment removes exception |
| R8 / re-review opus N4 | 9–10, 14, 18 -- no added admission refusal, head-only and re-anchor clearance, failed proof keeps diagnostic |
| R9 / re-review opus M-a | 9–10, 20 -- distinct responder DIDs/count survive restart, docs advise against delete/dispose on first evidence |
| R9 / re-review opus M-b | 8–11 -- signed comparisonEpoch, only requested span, six-frame large-group roster reply <=786432 bytes |
| R9 / re-review opus M-c | 11, 15b, 20 -- seven-day/count-bound expiry remains target-behind, manual resync exits, restart witness |
| R9 / re-review opus M-d | 10–11, 15b, 20 -- optional not-member.pendingReason preserves no-reply/ineligible/target-behind/target-unresolved |
| R10 / re-review sol N1 | 11 -- real mls/registry deps, bounded ordinary v3 sealer, both real runners, authority invocation and no-X/saved-X healing without replacement |
| R4 reply abuse/cost | 10 -- requestID dedupe, shared eight-operation admission, replay does not re-seal |
| §5 selected manual action and strong-hold escape | 15a–15b -- storage-only green gate, authorisation-before-network, isolated overlay and confirmed switch |
| §5 call-time targets, DN1 | 16a -- saved handle/topic, unchanged resolver, mismatch pause without fallback |
| §5 current/behind devices, R3 | 16b -- all hold/condition/notice/X exclusions, persisted allowOpenFork overrides only notice |
| §5 same-key/new-incarnation hold semantics, R3/DN4 | 15b–16b -- current move refuses hard holds, rejoin leaves source history and new incarnation unheld |
| §5 moved derived topics, My call 5 | 6, 16b -- same topic derivation on destination mux, old workers fenced |
| §5 partial migration and ahead arrivals, R3 | 16b, 20 -- cross-hub split has no in-band notice, target-behind without R2/R7 |
| §5 successor/tombstone, My call 6, all-held exit | 17 -- normal successor admission, silent held responders, old Welcome refusal, explicit clear with spent checks |
| §6 scoped clearHold, DN4 | 13–14 -- producer provenance, legacy uncleareable, evidence history, before-proof/live internal-latch barriers |
| §7 spent diagnosis and total loss, DN5 | 18 -- decrypted spent corruption versus unreadable envelope, dispatcher/cache/restart, same-group fresh invite |
| §8 gated retain/README, switch-proof bound, My call 7 | 14, 19–20 -- deferred holders, current docs, unbounded visibly pending proof |
| Reference exact framing/strict signature/no secret facts | 1–4 -- byte vectors, malformed input table, canonical public facts and at-rest inspection |
| Reference obsolete terminal halt/signerDID/same-epoch-only eligibility | 0 -- explicitly superseded, never activated |
| Sol I1/I3, R5 receive ownership/host boundary | 6, 9–10, 15b -- one-writer traffic witness, checkpoints port, manualRecovery data, onNotMember callback |
| Sol I2/M1, R5 capture closure/coverage | 3a–4 -- all successful writers migrated, both storage/ownership modes, public coverage after expiry |
| Sol I4, R5 activation staging/mirrors | 15a–15b, 17 -- storage-only RED, mode-specific group-safety migrations, independent authorisationID mirror |
| Sol I5, R5 diagnosis closure | 18 -- registry dispatcher, warmed access/cold/runtime facts and all four conflicting assertion ranges |
| R5 early risk and owned real witnesses | 6, 8–11, 12b, 16a–18 -- real detection early, then absence/floor, no retrospective witness task |
| 2.2a strong holds/stale source/owed work | 11–12b, 15b -- restricted manual authority, retired source fencing, exact outcomes and cumulative obligations |
| 2.2b drain/source movement/saved-ID/switch mapping | 15b–17 -- source re-read after drain, saved proof identity, no generic adoption bypass |
| 2.2c spent-loss ruling/tombstones/gated retain/past-frame question | 0, 6, 14, 17–18, 20 -- full/partial loss distinction, scoped clear, CAS loser creates no fact |
| 2.2d checkpoint obligation and live/floor witness precision | 1–11, 13–14 -- both contract families, real splits and peer-level proof/floor forwarding |
| 2.2d final minors 1–3 | 11, 19 -- diagnosed retries, one cumulative row with obligation union, required fourth floor argument |
| 2.2d final minors 4–7 | 4, 19 -- unused sink removal, re-entry docs, strict signer double, owned key zeroisation |
| 2.2d floor inflation/legacy records | 15a–17, 19 -- explicit manual attempt/successor escape, no invented provenance |
| Other 2.2d touched-path minors | Inventory dispositions, 6, 14–15b, 19 -- independent budgets, disposal fences, post-await authority checks, retained liveness limits |
| Round-1 opus minors M3–M5 | M3 resolved by 5/8 retention gates. M4 traffic/retention note in 20. M5 deferred explicitly below. |
| Phase 2 scope and merge hold | 20 -- reconstruction evidence only, no phase-2.3/provider/SIGKILL claim, phase-2 merge hold |

Carry-forward policy work and accepted limits (R4/R7/R9):

- Round-1 opus M4: aggregate scheduling across many groups and hub-side retention enforcement remain app/hub policy. Task 20 documents their costs.
- Round-1 opus M5: highest-capture selection and same-lineage limits for explicit manual floor authority remain a manual-recovery hardening follow-up.
  This plan retains the approved isolated app-authorised escape. R2/R7 constrain automatic floor exceptions to evidenced, transcript-checked attempts.
  No new automatic rollback authority follows from a manual request, roster hint or checkpoint.
- R7 accepted insider residual: deliberate coherent fake GroupInfo plus checkpoint chains are outside the intent-trusted peer model.
  Task 0 and Task 20 record the bounded effect: fake Y stays on the attacker's fake state, without honest confirmation.
  No distinct-DID requirement is deferred or implied. Two-member groups remain healable.
- R9 accepted retention limit: healing after seven-day/count-bound evidence expiry stays target-behind until explicit manual resync.
  Tasks 11/15b test the limit and exit. Task 20 documents both. Extending retention is not part of this plan.
- Re-review opus N1–N4/M-a–M-d and sol N1 have owning tasks above. None is deferred to these policy follow-ups.

## Self-review

- Spec coverage: design sections, approved calls, DN1–DN5 and R1–R10 map to owning tasks above.
  Task 0 records non-terminal diagnostic absence, lineage freshness, per-capture transcript checks, scoped floor, retained-span requests and accepted residuals.
  R4's removal of DN3 pinning remains explicit. No design/spec file is edited during this revision.
- Step scan: interfaces and named assertions fix implementation decisions. Test/verification/commit actions remain separate.
  Existing writer preparation precedes enforcement. Storage-only manual tests precede public execution. No retrospective task repairs earlier green gates.
- Type consistency: condition evidence remains separate from hard SafetyHold. Status adds manualRecovery only after its type exists.
  SendAdmission excludes not-member. Evidence includes distinct responder DIDs/count. RecoveryPendingReason extends both status arms together.
  Fact capture/mirrors take installed transcript bytes. ForkRecoveryAttempt.id, authorisation.attemptID and Y.id agree across restart.
  Saved targetID/topic/allowOpenFork, unchanged resolver, lineage proof, settlement provenance and independent mirrors agree across tasks.
- Review Focus: five conditions each have a named owning test. Real branch witnesses use signatures, installations and CAS rather than direct condition writes.
  New runners enumerate both implementation/double modes and ownership variants. All changed ports retain both contract-family gates.
- Proportion: production bodies remain omitted. Signatures, exact protocol values, assertions and closure inventories carry the decisions.
  The expanded capture-writer migration is explicitly mechanical. Journal/report and target-plumbing/move mechanics have independent review gates.
- Source coordinates: HEAD remains 1a36349. Verified GroupContext transcript availability, state/trust writers and every new R10 adapter anchor.
  No retained fact writer exists at HEAD. Task 3b names the existing state/trust writes where fact/debt co-writes will land.
- Green staging: checkpoint core includes real split detection, followed immediately by absence and saved-X floor work.
  Each behavioural owner includes its real witness, host-boundary classification and conflicting existing assertion migration.
- Remaining undecidable items: none within R1–R10. Deferred policy items and accepted R7/R9 limits are explicit above.
  The approved design file and Spec P remain unchanged by this revision. Normative r24 amendments remain future Task 0 work.
