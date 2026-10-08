# Spec P2a: crash-safe group control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every group-control operation, rejoin, outcome, owed Welcome and applied commit in
`@kumiai/rpc` is durable in a transactional `ControlStore`, committed with the group state it
changes, and replayed per stage after a crash.

**Architecture:** New state machines in `packages/rpc/src/control/`, called by `peer.ts` under the
commit mutex and closing over none of its state. Adoption control changes travel as an
`AdoptionWrite` through the host's state save (`mls-rpc` access, `GroupMLS.processCommit`,
recovery `onAccepted`, host `adopt`) so state, control and the anchor landed mark commit in one
transaction. Kumiai has no host database yet (Spec P is unimplemented): every host here is a memory
double sharing one in-memory transaction.

**Tech Stack:** TypeScript, vitest, ts-mls, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-08-spec-p2a-crash-safe-control-design.md` (draft r6).
Sibling: `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` (r5, amended).

## Global Constraints

- Packages touched: `mls`, `mls-hub`, `mls-rpc`, `rpc`, `rpc-conformance`, `tests/integration`.
  Kubun is out of scope: no Kubun plan, no Kubun edits.
- The version band moves from 0.10 to 0.11 (spec Phasing 3); every package takes the bump.
- `ControlStore` keeps the newest **64** epochs of `applied` and `responses`; the fork window is 64.
- Ambiguous `apply` read-back backoff caps at **15 s**.
- Operation deadline: `enqueuedAt + operationTimeoutMs`.
- Operation and rejoin IDs: random 128-bit. `payloadDigest` is SHA-256 of the framed payload.
- Changing a port means running both contract suites against the real implementation and every
  double (`docs/agents/architecture.md`).
- Every vitest step is paired with the package's `test:types`; vitest strips types. Before the
  final commit of any task that changes a port type: `rtk proxy pnpm run test:types` at the repo
  root (repo-wide; a per-package filter hid un-migrated consumers before).
- Lint before staging: `rtk proxy pnpm run lint`.
- Test run for one file: `pnpm --filter @kumiai/<pkg> exec vitest run test/<file>.test.ts`;
  integration: `pnpm --filter @kumiai/integration-tests exec vitest run test/<file>.test.ts`.
  `pnpm test` reports turbo-cached results; when verifying a whole package, check `Cached: 0` or
  run vitest directly.
- A test double may be stricter than its port, never more permissive.
- Terse code comments: keep the non-obvious why.
- Commits end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01QNKrDfFoVDpZLtLyvPMoEo`.

## Decisions this plan fixes (spec leaves them open)

- **`AdoptionWriteFactory` crosses packages without `mls`.** rpc cannot import `GroupHandle`, so the
  factory takes a staged summary: `type StagedAdoption = {epochAfter: number; removed: boolean;
  epochAuthenticator: Uint8Array}` and `type AdoptionWriteFactory = (staged: StagedAdoption) =>
  AdoptionWrite`. `mls-rpc` builds `StagedAdoption` from the staged handle before the commit (spec D1).
- **`processCommit(frame, write)`** is realised as a new optional `adoption?: AdoptionWriteFactory`
  field on the existing `CommitContext` argument, so the two-argument shape stays. Result gains
  `applied: boolean`.
- **Candidate codec.** No codec exists for the whole `RecoveryCandidate` (probe). `serialize()`
  encodes `{state: encodeClientState, sourceTree: ts-mls ratchetTreeEncoder, groupInfo,
  knownRegistry (new codec), replyLedger, signer, commit, epoch, requestID, bound commit tuple}`.
  `markBindingUnusable`, `confirmationKey` and `judgeVerdict` are rebuilt on restore
  (`createVerdictJudge`, the binding source), never serialised.
- **Host deletion refusal.** Kumiai has no `GroupStateStore`; rpc exports
  `controlSettled(snapshot): boolean` and the memory host database refuses `delete` with
  `GroupControlUnsettledError` when it is false.
- **Module layout** (spec D1 list plus a types file): `rpc/src/control/{types,store,operations,
  welcome,forks,rejoin}.ts`.

## Review Focus

1. **Startup on a restart with mixed stages** (a `built` operation, an `accepted` one, a `built`
   rejoin): expected settle-before-walk, never a strand on our own commit. Owner: Task 9
   (`startup settles own work before the seed walk`).
2. **Ratchet carry under concurrent opens and seals between build and adopt:** expected no sender
   generation sealed twice and no spent generation opening again. Owner: Task 1
   (`carry under interleaved seal`).
3. **Ambiguous storage at every write boundary** (state-free `apply`, adoption save, anchor save):
   expected one settled outcome, no duplicate row, sends paused until known. Owner: Tasks 3, 8, 9
   (`ambiguous apply`, `ambiguous adoption save`, `ambiguous anchor save`).
4. **Hostile hub** (re-wrapped bodies, purged dedup, forged fork frame): expected no false `landed`
   or `lost`, forged evidence costs one heal. Owner: Tasks 5 and 10 (`Codex r4 blockers` rows).
5. **Group deletion with unsettled control:** expected refusal, then success after `abandon()` and
   acks, tombstone carries no control. Owner: Task 9 (`delete refused until abandon`).

---

### Task 1: `mls` — `carryReceiveProgress`

**Files:**
- Modify: `packages/mls/src/group-handle.ts` (new method next to the write-gated methods,
  `mutexFor(this)` as at `:948/:996/:1051`)
- Modify: `packages/mls/src/index.ts`
- Test: `packages/mls/test/carry-receive-progress.test.ts`

**Interfaces:**
- Produces: `GroupHandle.carryReceiveProgress(candidate: GroupHandle): Promise<void>` — under the
  current handle's write gate, copies `this.state.secretTree` into `candidate`'s
  `historicalReceiverData.get(E).secretTree` (`E` = current epoch) and each earlier epoch's tree
  `candidate` also retains; leaves `candidate`'s `E + 1` state; adds no epoch `this` evicted.
  Throws `CarryIdentityError` (new, `mls/src/errors.ts`) unless `candidate`'s history at `E` has
  the current epoch's `epochAuthenticator`.

- [ ] **Step 1: Write the failing tests** — three cases from spec Conformance (`mls` row), plus
  Review Focus 2:
  - `open after build does not reopen`: alice builds an invite commit (candidate), bob seals two
    frames at `E`, alice opens frame 1, `alice.carryReceiveProgress(candidate)`, adopt candidate,
    reopen frame 1 at `E` from candidate history → rejects (generation consumed).
  - `seal after build never repeats a generation`: alice builds, seals two frames at `E`, carries;
    candidate's history tree at `E` has alice's sender generation equal to the current handle's
    (2), not the build-time value (0).
  - `evicted epoch not resurrected`: an epoch the candidate retains but the current handle has
    evicted keeps the candidate's own tree (not copied, not deleted); after carry, the candidate's
    history epochs equal its epochs before carry.
  - `carry under interleaved seal`: start carry and a `decrypt` concurrently; assert both serialise
    (decrypt result consumed in the carried tree).
  - `identity mismatch`: candidate built from another state → `CarryIdentityError`.
- [ ] **Step 2: Run** `pnpm --filter @kumiai/mls exec vitest run test/carry-receive-progress.test.ts`
  Expected: FAIL, `carryReceiveProgress is not a function`.
- [ ] **Step 3: Implement** in `group-handle.ts`; export the error from `index.ts`.
- [ ] **Step 4: Run** the test, then `pnpm --filter @kumiai/mls run test:types`. Expected: PASS, no
  type errors.
- [ ] **Step 5: Commit** `feat(mls): carry receive progress into an adoption candidate`.

### Task 2: `mls-hub` — `openWelcome`, `consume`, `receipt`

**Files:**
- Modify: `packages/mls-hub/src/pool-store.ts:53-66` (port + memory store)
- Modify: `packages/mls-hub/src/join.ts:18-102` (split `processWelcomeFromSources`)
- Modify: `packages/mls-hub/src/pool.ts:213`, `packages/mls-hub/src/provisioner.ts:265`,
  `packages/mls-hub/src/store.ts:68`, `packages/mls-hub/src/records.ts`
- Create: `packages/mls-hub/src/admission.ts`
- Test: `packages/mls-hub/test/consume.test.ts`, `packages/mls-hub/test/admission.test.ts`

**Interfaces:**
- Produces (spec D4, verbatim):
  - `KeyPackagePoolStore.consume(ref: string, groupID: string): Promise<void>` and
    `receipt(ref: string): Promise<{groupID: string} | null>`; `consume` deletes the package and
    writes the receipt in one memory transaction; on an injected ambiguous outcome it reads
    `receipt` back.
  - `BundleSource.sourceID: string`, `consume`, `receipt` (same signatures). Last-resort sources:
    `consume` writes the receipt only and keeps the package (`provisioner.ts:65`).
  - `openWelcome(sources, welcome): Promise<{joined: JoinedWelcome; joinRef: {sourceID; ref}} |
    {alreadyJoined: string}>` — reads refs via `mls/src/welcome-refs.ts`, returns
    `alreadyJoined` for a receipted ref without decrypting, never releases.
  - `judgeWelcomeAdmission(held: {epoch: number; deleted: boolean} | null, welcomeEpoch: number):
    'join' | 'alreadyJoined' | 'replace' | 'refused'` in `admission.ts` (rules: spec D4
    "Admission against held state"; tombstone joins only above its epoch).
  - `processWelcomeFromSources` is removed (breaking; Task 13 records it).
- Consumes: none.

- [ ] **Step 1: Write the failing tests:**
  - `consume atomic (pool store)` and `consume atomic (bundle source)`: failure injected between
    delete and receipt → package survives, `receipt(ref)` null.
  - `consume ambiguous reads back`: commit-then-reject → `consume` resolves, receipt present.
  - `receipted ref is alreadyJoined without decrypt`: spy on decrypt, assert not called.
  - `last-resort consume keeps package`.
  - admission table: `none → join`; `live E, welcome E → alreadyJoined`; `live E, welcome E+3 →
    replace`; `tombstone E, welcome E → refused`; `tombstone E, welcome E+1 → join`.
  - `holder evidence`: a Welcome to a chained leaf without holder evidence → `openWelcome`
    rejects, package kept, no receipt.
- [ ] **Step 2: Run** both files. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement.** Migrate in-repo callers of `processWelcomeFromSources`
  (`rg processWelcomeFromSources packages tests`) to `openWelcome` + host save + `consume`.
- [ ] **Step 4: Run** both files, `pnpm --filter @kumiai/mls-hub run test:types`, and repo-wide
  `rtk proxy pnpm run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mls-hub): split Welcome open from an atomic key-package consume`.

### Task 3: `rpc` control types, `ControlStore`, conformance suite, memory host database

**Files:**
- Create: `packages/rpc/src/control/types.ts`, `packages/rpc/src/control/store.ts`
- Modify: `packages/rpc/src/index.ts`, `packages/rpc/src/errors.ts`
- Create: `packages/rpc-conformance/src/control-store.ts`,
  `packages/rpc-conformance/src/memory-control-store.ts`
- Modify: `packages/rpc-conformance/src/index.ts`
- Create: `packages/rpc/test/fixtures/host-db.ts`
- Test: `packages/rpc/test/control-store-conformance.test.ts`,
  `packages/rpc/test/control-store.test.ts`

**Interfaces:**
- Produces (spec D2, D3, D5, D6 types verbatim in `control/types.ts`): `ControlSnapshot`,
  `ForkEvidence`, `ControlChanges`, `AdoptionWrite`, `ControlStore`, `OperationRequest`,
  `Operation`, `BuiltCommit`, `Outcome`, `WelcomeObligation = {opID: string; welcome: Uint8Array;
  recipients: Array<string>}`, `AppliedCommit = {epoch: number; digest: string; payloadDigest:
  string; sequenceID: string; opID: string | null; removed: boolean}`, `ExternalResponse`,
  `CommitCursor = {position: LogPosition; epoch: number; stranded?: true; fork?: ForkEvidence}`,
  `RejoinRecord`, plus `StagedAdoption` and `AdoptionWriteFactory` (Decisions above).
- Errors in `errors.ts`: `StorageOutcomeUnknownError`, `OperationRejectedError`,
  `OperationOutcomeError {outcome: Outcome}`.
- `control/store.ts`:
  - `applyChanges(snapshot: ControlSnapshot, changes: ControlChanges): ControlSnapshot` — pure;
    deletes before puts; `deleteAppliedFrom` drops `epoch >= n`; `deleteResponsesBelow` drops
    `epoch < n`; operations kept FIFO by `seq`.
  - `controlSettled(snapshot: ControlSnapshot): boolean` — no operation, rejoin, outcome or
    Welcome obligation.
  - `applyResolved(store: ControlStore, changes, mutationID, sleep?): Promise<void>` — on
    `StorageOutcomeUnknownError` reads `lastMutation()` with exponential backoff capped at 15 000 ms
    until a read succeeds; resolves if equal, throws `StorageOutcomeUnknownError`-free retry
    signal `ControlWriteNotCommittedError` otherwise.
  - `pruneWindow(snapshot, newestEpoch: number): ControlChanges` — rows and responses older than
    `newestEpoch - 63`.
- `rpc-conformance`: `testControlStoreConformance(params: {open(): Promise<ConformanceControlHost>;
  reopen(): Promise<ConformanceControlHost>; injectFailure(point: 'mid-apply' | 'mid-save'): void;
  commitThenReject(): void})` where `ConformanceControlHost = {control: ConformanceControlStore;
  saveState(state: Uint8Array, write?: ConformanceAdoptionWrite): Promise<void>; loadState():
  Promise<Uint8Array | null>; anchor: ConformanceAnchorStore}` — structural re-declarations, no
  rpc import. `createMemoryControlStore()` lives in `memory-control-store.ts`.
- `rpc/test/fixtures/host-db.ts`: `createMemoryHostDatabase(): MemoryHostDatabase` — one
  in-memory database holding per-group `{state, anchorSlot, control}`; every write copies, mutates
  and swaps the whole group record (one transaction). Exposes `control(groupID): ControlStore`,
  `anchorStore(groupID): AnchorStore`, `saveState(groupID, state, write?: AdoptionWrite)` (also
  sets `pending.landed` when `write.anchorLanded` equals the slot's `pending.advance`),
  `delete(groupID)` (throws `GroupControlUnsettledError` unless `controlSettled`), and injectors
  `failNext(point)`, `commitThenRejectNext(point)`, `seam(name, hook)`.

- [ ] **Step 1: Write the failing tests** — spec Conformance `testControlStoreConformance` rows
  (`all or nothing`, `durable`, `ambiguous commit`, `co-commit with the state save`, `outcomes
  persist until deleted`, `secrets`); unit tests for `applyChanges` (deletes before puts: a
  `deleteAppliedFrom: 5` with `putApplied` at 5 keeps the put), `pruneWindow` at 64,
  `controlSettled`, and `ambiguous apply`: commit-then-reject → `applyResolved` resolves; reject
  without commit → `ControlWriteNotCommittedError`; read failures retry with delays capped at
  15 000.
- [ ] **Step 2: Run** `pnpm --filter @kumiai/rpc exec vitest run test/control-store-conformance.test.ts test/control-store.test.ts`. Expected: FAIL (missing modules).
- [ ] **Step 3: Implement**; wire the suite against both `createMemoryControlStore` (with a trivial
  state slot) and `createMemoryHostDatabase`.
- [ ] **Step 4: Run** the tests; `pnpm --filter @kumiai/rpc run test:types`;
  `pnpm --filter @kumiai/rpc-conformance run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rpc): ControlStore port, co-commit contract and conformance suite`.

### Task 4: `mls-rpc` — adoption write threading and `processCommit` `applied`

**Files:**
- Modify: `packages/rpc/src/crypto.ts:465` (`CommitContext.adoption?`, `ProcessCommitResult.applied`)
- Modify: `packages/mls-rpc/src/access.ts:12-70`, `packages/mls-rpc/src/apply-commit.ts:55, 113-143`,
  `packages/mls-rpc/src/mls.ts:308-340`
- Modify: `packages/rpc/test/fixtures/memory-group-mls.ts` (double honours `adoption`)
- Modify: `packages/rpc-conformance/src/group-mls.ts:212`
- Test: `packages/mls-rpc/test/adoption-write.test.ts`

**Interfaces:**
- Consumes: Task 3 `AdoptionWrite`, `AdoptionWriteFactory`, `StagedAdoption`.
- Produces:
  - `HandleAccess.mutate(fn, adoption?: AdoptionWriteFactory)`,
    `HandleAccess.replace(next, adoption?: AdoptionWriteFactory)`;
    `SimpleHandleAccessParams.persist?: (handle: GroupHandle, write?: AdoptionWrite) => void |
    Promise<void>`. The factory runs on the staged handle before `persist`; `removed` is true when
    the staged roster no longer holds the own leaf.
  - `ProcessCommitResult` gains `applied: boolean`; a self-removal returns `applied: true,
    advanced: false` and still saves (spec D5).
  - `MemoryGroupMLS` double: when `context.adoption` is set, calls its host-db `saveState` with the
    write; a failed save leaves the double's state unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `persist receives the write`: processCommit with `adoption` → persist called once with
    `write.mutationID` equal to the factory's.
  - `factory sees staged epoch`: factory receives `epochAfter = E + 1` for an advancing commit.
  - `self-removal`: removal commit of own leaf → `{applied: true, advanced: false}`, factory got
    `removed: true`.
  - `failed save leaves handle`: persist throws → epoch, roster, ledger unchanged
    (`group-handle.ts:1629-1656` rollback).
  - conformance: add `processCommit reports applied` to `testGroupMLSConformance`.
- [ ] **Step 2: Run** `pnpm --filter @kumiai/mls-rpc exec vitest run test/adoption-write.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement**; update both contract suites' doubles.
- [ ] **Step 4: Run** the new test, `pnpm --filter @kumiai/mls-rpc exec vitest run test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts`, `pnpm --filter @kumiai/rpc exec vitest run test/ports-conformance.test.ts`, repo-wide `rtk proxy pnpm run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mls-rpc): commit an AdoptionWrite with every adoption save`.

### Task 5: `rpc` — operations module

**Files:**
- Create: `packages/rpc/src/control/operations.ts`
- Test: `packages/rpc/test/control-operations.test.ts`

**Interfaces:**
- Consumes: Task 3 types and `applyResolved`.
- Produces (pure-ish; every effect injected, no `peer.ts` state):
  - `type OperationDeps = {control: ControlStore; build(op: Operation): Promise<HostBuilt>;
    adopt(journal: Uint8Array, expected: {epoch: number; authenticatorBefore: Uint8Array; lineage:
    number}, write: AdoptionWrite): Promise<'installed' | 'noop' | 'moved'>; frame(built:
    HostBuilt): Promise<{payload: Uint8Array; publishID: string; expectedHead: LogPosition |
    null}>; publish(payload, publishID, expectedHead): Promise<PublishOutcome>; searchLog(from:
    LogPosition | null, payloadDigest: string): Promise<{found: LogPosition} | 'absent' | 'gap'>;
    appliedAt(epoch: number): AppliedCommit | undefined; pullToHead(): Promise<void>; now(): number;
    operationTimeoutMs: number; newID(): string; emit(outcome: Outcome): void}`.
  - `HostBuilt = {commit: Uint8Array; bodies: Array<string>; journal: Uint8Array; welcome:
    {bytes; recipients} | null; epoch; authenticatorBefore; lineage; digest}`.
  - `enqueueOperation(deps, request): Promise<Operation>` (stage `intent`, next `seq`).
  - `stepOperation(deps, op): Promise<Operation | null>` — one stage transition per spec D3 steps
    2–4 and replay rules; returns the stored next stage, or null when settled.
  - `landedChanges(op, position, applied: AppliedCommit): ControlChanges` — delete op, put
    `landed`, put row, set cursor (for the adoption write and the no-op repair).

- [ ] **Step 1: Write the failing tests** with fake deps (spec D3 behaviour):
  - `intent → built → accepted → landed`, Welcome obligation put with `accepted`.
  - `refused build → rejected outcome, operation deleted in one apply`; holder-evidence refusal
    surfaces as `rejected`.
  - `head mismatch, search finds payload → accepted at found position`.
  - `head mismatch, absent → back to intent; past deadline → lost`.
  - `head mismatch, retention gap → unknown`.
  - `other publish error keeps built`.
  - `built replay republishes the same payload at a moved epoch` (no `JournalEpochError`).
  - `re-wrapped bodies never clear`: hub returns a frame with the same commit digest, different
    payload → search treats as absent.
  - `moved, same digest at built.epoch → landed`; `moved, different digest → stays accepted`.
  - `noop adopt repairs missing changes`.
  - `deadline from enqueuedAt survives restart`.
- [ ] **Step 2: Run** `pnpm --filter @kumiai/rpc exec vitest run test/control-operations.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** test + `pnpm --filter @kumiai/rpc run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rpc): durable operation stages`.

### Task 6: `rpc` peer — operations replace the commit journal

**Files:**
- Modify: `packages/rpc/src/peer.ts` (journal wrapper `:239-252`, `replayJournal :1806-1921`,
  `commit`/`commitHeld :2083-2272`, `takeLost :1927`, startup `ready :2783`)
- Modify: `packages/rpc/src/peer-types.ts:76-110, 305-332`, `packages/rpc/src/commit.ts`,
  `packages/rpc/src/index.ts:27-38`
- Delete: `packages/rpc/test/fixtures/journal.ts`, `packages/rpc-conformance/src/commit-journal.ts`,
  `packages/rpc/test/commit-journal-conformance.test.ts`
- Modify: `packages/rpc/test/fixtures/peer.ts` (`makeMLSPeer` over `createMemoryHostDatabase`;
  `restartOf` reuses the database), every rpc test using `journal`/`adoptJournalled`/`commit(build)`
- Test: `packages/rpc/test/peer-operations.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `GroupPeerMLSParams`: remove `journal`, `adoptJournalled`; add `control: ControlStore`,
    `build(op: Operation): Promise<HostBuilt>`, `adopt(journal, expected, write)`,
    `operationTimeoutMs?: number` (default: today's `commitDeadlineMs` default).
  - `GroupPeer.enqueue(op: OperationRequest): Promise<void>`, `outcomes(): Promise<Array<Outcome>>`,
    `ack(id: string): Promise<void>`, event `outcome`.
  - `GroupPeer.commit(op: OperationRequest): Promise<{position: LogPosition}>` — enqueue then wait
    in-process; rejects `OperationOutcomeError` for any non-`landed` outcome.
  - Removed exports: `CommitJournal`, `JournalEntry`, `JournalEpochError`, `LostCommit`,
    `PendingCommit`, `LaneResult` (where only journal-related; keep `isHeadMismatch`,
    `CommitDeadlineError`, `RecoveryRequiredError`).
  - Queue runner: one operation per `runSerial` task; waits outside `runSerial`; gates before
    `build` in order: settle-first, `ensureLedger`, strand/anchor-recovery holds, rejoin record
    (spec D1 Gates).
  - `AppOutbox` keeps `getCommitCursor`/`putCommitCursor` until Task 8.

- [ ] **Step 1: Write the failing tests** (crash rows owned here, spec Crash seams):
  `intent written`, `built, before publish`, `hub accepted, before accepted`, `hub forgot the ID`,
  `accepted, before adopt`, `own adoption committed`, `adoption save, mid-transaction`,
  `restart with an operation past its deadline`, and `commit() rejects with
  OperationOutcomeError on lost`. Each: seam via `host-db` injectors or `RecordingHub`, dispose,
  restart with `restartOf`, assert the row's "Expected after restart".
- [ ] **Step 2: Run** `pnpm --filter @kumiai/rpc exec vitest run test/peer-operations.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** in `peer.ts` by calling `control/operations.ts`; delete the journal path.
- [ ] **Step 4: Migrate** every test and fixture that used the journal API:
  `rg -l "journal|adoptJournalled|takeLost|JournalEpochError" packages tests`. Tests whose subject
  was journal behaviour are rewritten against operations (`peer-commit-replay`,
  `peer-first-commit-crash`, `peer-commit-cas`, `peer-locked-commit-epoch`), not deleted.
- [ ] **Step 5: Run** `pnpm --filter @kumiai/rpc exec vitest run`,
  `pnpm --filter @kumiai/integration-tests exec vitest run`, repo-wide
  `rtk proxy pnpm run test:types`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(rpc)!: durable operations replace the commit journal`.

### Task 7: `rpc` — revoke hold

**Files:**
- Modify: `packages/rpc/src/peer.ts` (`revokeHolds :2083/:2087`, `heldJournalID :241-251`,
  `logSendsHeld :255`, delivery `held :586-594`, `submit :637`, `publishRevokeProof`)
- Test: `packages/rpc/test/peer-revoke-hold.test.ts`

**Interfaces:**
- Consumes: Task 6 `enqueue`, stored `Operation.revokes`.
- Produces: `revokeHeld(snapshot): boolean` in `control/operations.ts` (any unsettled op with
  `revokes: true`); `held()` reads it; recomputed at `start` before delivery;
  `publishRevokeProof` enqueues with `revokes: true`.

- [ ] **Step 1: Write the failing tests:** spec rows `rejected revoke`, `revoke hold` (across
  restart; `settleLogSubmissions` drains handed-off entries first), `two revokes`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement**; remove the journal restart hold.
- [ ] **Step 4: Run** file + `pnpm --filter @kumiai/rpc run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rpc): durable revoke hold`.

### Task 8: `rpc` — Welcome obligations

**Files:**
- Create: `packages/rpc/src/control/welcome.ts`
- Modify: `packages/rpc/src/peer.ts`, `packages/rpc/src/peer-types.ts`
- Modify: `packages/rpc/test/fixtures/peer.ts` (`deliverWelcome` records into `TestPeer.welcomes`)
- Modify: `tests/integration/test/app-lane-e2e.ts:366-388` (deliver from obligations)
- Test: `packages/rpc/test/peer-welcome-obligations.test.ts`,
  `tests/integration/test/welcome-after-crash.test.ts`

**Interfaces:**
- Consumes: Task 5 (obligation put with `accepted`), Task 2 (`openWelcome`/`consume`).
- Produces: `GroupPeerMLSParams.deliverWelcome(obligation: WelcomeObligation): Promise<void>`;
  `deliverObligations(deps: {control; deliverWelcome}, snapshot): Promise<void>` — after each
  `apply` that puts obligations and at every `start`; deletes each after its delivery resolves.

- [ ] **Step 1: Write the failing tests:** spec crash rows `Welcome accepted by transport, before
  obligation deletion`, `Welcome obligation, before delivery`, `invitee joined, before consume`,
  `invitee consume, mid-transaction`, `invitee consumed, before ack`; integration `Welcome after
  crash` (inviter crashes after `accepted`, invitee joins after restart).
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files + repo-wide `rtk proxy pnpm run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rpc): durable Welcome obligations`.

### Task 9: `rpc` — applied rows, durable effects, anchor landed mark, startup order

**Files:**
- Create: `packages/rpc/src/control/forks.ts` (row classification inputs only; settlement in Task 10)
- Modify: `packages/rpc/src/peer.ts` (`appliedByEpoch :748` and writers, `commitOutcomes :932-978`,
  `saveCommitCursor`/`persistStrand :704-721`, `walkCommits :1239-1571`, `advanceHandle
  :1148-1217`, `captureAnchor`/`keepAnchor :386-409`, `resolveAnchorRotation :416-448`,
  `initControlLanes :1733-1756`, `ready :2783-2798`, new `abandon`)
- Modify: `packages/rpc/src/anchor.ts` (`pending.landed?: true`),
  `packages/rpc-conformance/src/anchor-store.ts`, `packages/rpc-conformance/src/app-outbox.ts`
  and `memory-app-outbox.ts` (commit cursor removed), `packages/rpc/src/app-outbox.ts`
- Modify: `packages/rpc/src/recovery-confirmation.ts:30-64` (responses from `ControlStore`)
- Test: `packages/rpc/test/peer-durable-effects.test.ts`, `packages/rpc/test/peer-startup-order.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  - Every adoption's `AdoptionWrite` holds the `applied` row (`removed` from `StagedAdoption`), the
    cursor, the `landed` change for a matching `accepted` op, the adopted `ExternalResponse` with
    `epochAfter`, and `anchorLanded` unless `removed` (spec D5 Adoption writes).
  - Responder skips write `ExternalResponse` with the cursor in one `apply`; `commitOutcomes` map
    and `appliedByEpoch` are read from the snapshot (memory caches rebuilt at start).
  - `GroupPeer.abandon(): Promise<void>` (spec D1).
  - Removal effect from the newest row with `removed: true`; terminal group at start.
  - `captureAnchor`/`keepAnchor` save first, then publish memory (spec D5 anchor bullet).
  - Startup steps 1–11 (spec D5 Startup order) in `ready`; `initControlLanes` only subscribes.
  - `AppOutbox` loses `getCommitCursor`/`putCommitCursor`; the cursor lives in `ControlStore`.

- [ ] **Step 1: Write the failing tests** (spec crash rows): `incoming adoption committed`,
  `ambiguous adoption save`, `ambiguous apply at acceptance`, `external commit adopted`,
  `self-removal committed, before host deletion`, `host deletes a group with unsettled control`
  (Review Focus 5: `delete refused until abandon`), `hub accepted, before accepted, restart`
  (Review Focus 1: `startup settles own work before the seed walk`), `ambiguous anchor save`,
  `live self-removal with a pending rotation`, `anchor capture save fails live`, `anchor keep save
  fails live`, `anchor resolved, before rebuildEpoch`, `responder refusal, before cursor skip`;
  spec test rows `removal effect`, `moved`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement**, migrating `persistStrand`/`saveCommitCursor` to `apply`.
- [ ] **Step 4: Migrate** outbox-cursor users (`rg -l "CommitCursor|getCommitCursor" packages tests`).
- [ ] **Step 5: Run** `pnpm --filter @kumiai/rpc exec vitest run`, integration suite, repo-wide
  `rtk proxy pnpm run test:types`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(rpc)!: applied rows, effects from durable state, anchor landed mark`.

### Task 10: `rpc` — strands, fork evidence and settlement

**Files:**
- Modify: `packages/rpc/src/control/forks.ts`, `packages/rpc/src/peer.ts` (`walkCommits` strand
  paths `:1280/:1425`, `classifyCommit` call sites `:1326/:1366/:1416`)
- Test: `packages/rpc/test/peer-fork-settlement.test.ts`

**Interfaces:**
- Consumes: Task 9 rows.
- Produces: `forkSettlement(snapshot: ControlSnapshot, conflictEpoch: number, rejoinRow:
  AppliedCommit): ControlChanges` — `unknown` for every `accepted` op and every row at or above
  `conflictEpoch` with an `opID`, `deleteAppliedFrom: conflictEpoch`, then `putApplied:
  [rejoinRow]`; strand writes `cursor.stranded` and `cursor.fork` in one `apply`.

- [ ] **Step 1: Write the failing tests:** spec rows `fork settlement`, `winner at divergence`,
  `late-revealed divergence`, `forged conflict`, `Codex r4 blockers` (hub fork accepting our
  invite on the losing branch → `unknown`), crash rows `strand and fork evidence written, before
  rejoin built`, `rejoin row at the framed epoch of an own landed row`, `rejoin final apply,
  rejoin row at or above E`, `fork loser, restart, winner shown`. Settlement assertions run once
  Task 12 wires the rejoin; until then call `forkSettlement` directly and mark the peer-level cases
  `it.todo` with the Task 12 name.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** file + `pnpm --filter @kumiai/rpc run test:types`. Expected: PASS (todos
  listed).
- [ ] **Step 5: Commit** `feat(rpc): durable fork evidence and settlement`.

### Task 11: `mls-rpc` — recovery keys explicit, candidate codec, `restoreRecovery`

**Files:**
- Modify: `packages/rpc/src/crypto.ts:354-368, 404, 482, 509, 556`
- Modify: `packages/mls-rpc/src/mls.ts:127-170, 237-255, 359-468`, `packages/mls-rpc/src/recovery.ts`
- Create: `packages/mls-rpc/src/recovery-codec.ts`, `packages/mls/src/registry-codec.ts`
  (export from `mls/src/index.ts`)
- Modify: `packages/rpc/test/fixtures/memory-group-mls.ts`, `packages/rpc-conformance/src/group-mls.ts`
- Test: `packages/mls-rpc/test/recovery-codec.test.ts`, `packages/mls/test/registry-codec.test.ts`

**Interfaces:**
- Produces:
  - `createRecoveryRequest(requestID, deadlineMs?): Promise<{request: Uint8Array; requestKey:
    Uint8Array}>`; `applyRecovery(sealed, requestID, requestKey)`; `openRecoveryVerdict(sealed,
    requestID, requestKey)`; `openSealedLedger(sealed, requestID, requestKey)`; the 120 s map is
    deleted.
  - `PendingRecovery.serialize(): Uint8Array` (fields: Decisions → Candidate codec).
  - `GroupMLS.restoreRecovery(candidate: Uint8Array, requestKey: Uint8Array):
    Promise<PendingRecovery>`; its `onAccepted(write: AdoptionWriteFactory)` adopts through
    `access.replace(group, write)` (Task 4), idempotent by `epochAuthenticator`.
  - `encodeDeviceRegistry(registry: DeviceRegistry): Uint8Array` /
    `decodeDeviceRegistry(bytes): DeviceRegistry` in `mls`.

- [ ] **Step 1: Write the failing tests:** registry codec round-trip; candidate
  `serialize → restoreRecovery` round-trip byte-exact on state and tree, verdict judged identically
  before and after; `holderGrant` survives round-trip and a binding refreshed with evidence is
  usable (spec `holder evidence` row); restored `onAccepted` twice adopts once; readers without the
  key fail.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement**; update rpc's in-flight callers to pass keys (memory only until
  Task 12); doubles and suites follow.
- [ ] **Step 4: Run** both files, mls-rpc and rpc conformance tests, repo-wide
  `rtk proxy pnpm run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mls-rpc)!: explicit recovery keys and a restorable candidate`.

### Task 12: `rpc` — durable rejoin record

**Files:**
- Create: `packages/rpc/src/control/rejoin.ts`
- Modify: `packages/rpc/src/peer.ts` (`activeRecovery :757`, `refusalHeld :758`, `pendingRecovery
  :759`, `attemptBody :2341-2677`, `runRecovery :2680-2708`, `recover :2716`,
  `healIfRequested :2731`, barrier at `:966, 1394`)
- Test: `packages/rpc/test/peer-rejoin-record.test.ts`,
  `tests/integration/test/recovery-requester-restart.test.ts`

**Interfaces:**
- Consumes: Tasks 9–11.
- Produces:
  - `stepRejoin(deps, record): Promise<RejoinRecord | null>` — spec D6 stage table; settle-first
    rule; barrier `rejoinBarrier(record): LogPosition | null` (stage `published`/`confirmed`);
    `sourceRecheck(scan, record): 'pass' | 'fail'` over `[source.head, record.position)` with the
    exact predicate in spec D6 `confirmed` row.
  - Rejoin adoption `AdoptionWrite`: row, cursor, `adopted` stage, `forkSettlement` when
    `conflictEpoch` is set (Task 10), `anchorLanded`.
  - `adopted` stage: `bootstrapLedger`, then one `apply` with `reenact` outcomes, cleared
    `stranded`, deleted record.
  - `refused` stage durable; `recover()` deletes it and starts afresh.
  - Startup step 7 moves a `built` rejoin found published to `published`; step 10 replays the rest,
    exempt from the anchor-recovery gate.

- [ ] **Step 1: Write the failing tests:** spec crash rows `rejoin built, before publish`, `rejoin
  published, before confirm`, `rejoin published, before published write, restart`, `rejoin
  confirmed, state moved, before adopt`, `rejoin confirmed, before adopt`, `rejoin refused by
  policy, restart, outcome acked`, `rejoin adopted, before bootstrap`, `rejoin state committed`,
  `ledger bootstrapped, before final rejoin apply`, `same-number rejoin committed, before anchor
  resolution`, `same-number rejoin save fails`, `same-number rejoin, external successor`; spec test
  rows `source re-check`, `refused rejoin`, `Codex r4 blockers` (no adoption without
  confirmation); integration `requester restart`. Turn Task 10's `it.todo` cases into tests.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @kumiai/rpc exec vitest run`,
  `pnpm --filter @kumiai/integration-tests exec vitest run` (the `recovery-confirmation` suite
  unchanged and green), repo-wide `rtk proxy pnpm run test:types`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rpc): durable rejoin record`.

### Task 13: Welcome re-admission reset, docs, band move

**Files:**
- Modify: `packages/rpc/src/control/store.ts` (`readmissionChanges(snapshot): ControlChanges`)
- Modify: `packages/rpc/test/fixtures/host-db.ts` (`seed(groupID, state, {replace: true})` uses it
  with the anchor slot cleared, one transaction)
- Modify: `docs/agents/architecture.md:52`, `docs/reference/mls-lifecycle.md:91-110`,
  `packages/rpc/README.md` and `packages/mls-hub/README.md` if they name removed APIs
- Create: `.changeset/version-band-0-11.md` (shape: `.changeset/version-band-0-5.md`), plus one
  intent per package describing its change (`pnpm change` or by hand)
- Test: `packages/rpc/test/peer-readmission.test.ts`

**Interfaces:**
- Produces: `readmissionChanges` — open ops and rejoin → `unknown` outcomes, deleted; `applied`,
  `responses`, cursor cleared; outcomes and obligations kept (spec D4).

- [ ] **Step 1: Write the failing test:** crash row `Welcome re-admission committed`; `mls-hub`
  `re-admission` row end to end (held at `E`, last-resort Welcome at `E + 3` replaces; at `E`
  `alreadyJoined`).
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement**; update the docs (no `CommitJournal`, `adoptJournalled`, `takeLost`).
- [ ] **Step 4: Write the changesets** naming every package at `minor` for the 0.11 band.
- [ ] **Step 5: Run** `rtk proxy pnpm run lint`, `rtk proxy pnpm run test:types`, `pnpm test`
  forced uncached (`Cached: 0`). Expected: all green.
- [ ] **Step 6: Commit** `feat: Welcome re-admission reset; docs and 0.11 band intents`.

---

## Spec coverage

| Spec item | Task |
|---|---|
| D1 placement, peer surface, gates, `abandon`, ports | 3, 6, 9 |
| D2 `ControlStore`, co-commit, ambiguity owners, windows, secrets | 3, 4, 9 |
| D3 operations, carry, outcomes, revoke hold, replay | 1, 5, 6, 7 |
| D4 inviter obligations, invitee consume, admission, re-admission | 2, 8, 13 |
| D5 rows, responses, adoption writes, effects, startup, strands, forks, cursor | 9, 10 |
| D6 rejoin record, stages, barrier, keys, responders, anchor | 11, 12 |
| D7 errors | 3, 6 |
| Crash seams | rows assigned in 6, 8, 9, 10, 12, 13 |
| Conformance and tests | 1, 2, 3, 4, 7, 10, 11, 12, 13 |
| Phasing 3 band move | 13 |
