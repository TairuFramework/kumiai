# Spec P 2.3d: handlers and fair adaptive batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authenticated handler metadata and atomic completion policies through a fair, bounded group batching scheduler.

**Architecture:** Rpc owns portable frame, policy and completion contracts. Mls-rpc implements exact-key completion through the existing D8 coordinator. A shared per-group scheduler arbitrates work before FIFO owner admission. Live and storage-only delivery share policy dispatch and completion without opening old crypto.

**Tech Stack:** TypeScript, pnpm 12.15.0, Vitest, ts-mls, sealed memory persistence, existing rpc/hub conformance runners.

**Spec:** [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md), binding r28i through History S:2922.

Baseline: `feat/spec-p-phase-2`, HEAD `77d2b2e9`, 2026-10-29. Main 0.12.1 is already merged at `535ad3ef`.
Status: **revision 6 draft; Q1=A and Q2=A settled** in `.superpowers/sdd/plan-2-3d-draft/decisions-for-review.md`.
Inventory: `.superpowers/sdd/plan-2-3d-draft/inventory.md` -- 28 candidates: 10 DONE, 11 PARTIAL, 7 OPEN.
Eleven implementation tasks. Review6 dispositions: `.superpowers/sdd/plan-2-3d-draft/revise6-notes.md`.

This revision permits writes only to this plan and the draft's `inventory.md` and `revise6-notes.md`.
Source/test/spec edits, git mutations and package test suites are unauthorised during drafting.
Commands and commit steps below apply only to a subsequent implementation session.

## Global Constraints

- Authority comes from authenticated applied state. Hub bytes/positions/epochs grant no acceptance, hold/halt, deletion, rebuild or permanent stranding (S:10-18).
- Preserve r28i saved work, retry prohibition, authenticated recovery and independent Welcome obligations (S:2922).
- Group writes/host effects share one transaction. Prepare crypto under ownership, outside storage. Publish only after proof (S:497-502).
- Default handlers are at least once, outside owner/transaction. Transactional effects/completion/eligible cursor co-commit (S:531-540).
- Transactional callbacks run in D8 effects after finalise. Every domain-store view rejects writes with PersistencePhaseError (S:913-970).
- Callbacks stay short, using supplied stores. No network, root-store calls, cross-group waits or timers (S:538-539).
- Failure blocks only its protocol lane. Unknown/duplicate completion is harmless. Mixed listener policies refuse (S:534-539,2840).
- Frame key is JSON `['kumiai/frame/v1', groupID, incarnation, topicID, position, protocol, procedure]` (S:540).
- Defaults: maxBatchFrames 64, maxBatchDelayMs 2, maxBatchWorkMs 8. Size/work finite/positive; delay finite/non-negative; idle starts immediately (S:506-515).
- Explicit openBatch rejects >64 inputs before reads and never splits. Release transaction/owner between streaming batches (S:1460,517).
- Before repeated bursts, service ready control, then round-robin ordinary sources/enqueue/completion. Only A/B/control: `[A,control,B]` within three batches (S:517-520).
- Select before D8 FIFO admission. Never reorder admitted work or unresolved proof. Groups remain independent (S:517-521,D8).
- Control advertises before ownership-dependent reads. Its selected entry authenticates/prepares/adopts using local entry-bound capabilities.
- Registry observation rechecks enter the same arbiter before FIFO admission, including expected own versions and fallback starts.
- Ordinary known rollbacks release ownership. D6 certification, certified finalisation retry and unresolved proof retain ownership.
- Metadata uses authenticated original frame epoch/origin incarnation. Ephemeral kinds/decrypt batches initiate zero persistence (S:883-885,525-529,2841-2842).
- Only authenticated malformed plaintext persists poison. Canonical rowless dead-prefix advancement uses coverage, independently of saved-ID completion (S:1393,1463,1476).
- Pending/poison/cursors do not advance MLS versions. Positions use code-unit order within one topic (S:1165,1981,488-493).
- Drain saved plaintext before lifecycle clearing. No additional crypto/fetch/publication, timeout erasure or disposal escape (S:543-547,878-881).
- Keep shared required openedDeliveryContext and optional ownershipContext. Scheduled roots assertRoot before reads/collection/scheduling/yielding (S:997-1008).
- Entry-bound helpers stay direct. Seal every namespace with existing AAD; retain proof ownership, hooks and fail-stop (S:836-861).
- Preserve lease size 16, renewal below 4, ceiling 500, codec v2, candidate v3 and controller/management knowledge.
- Doubles cannot weaken ports. Port changes gate both contract families against implementations and doubles.
- Memory reconstruction is phase-2 evidence. Provider faults/SIGKILL remain phases 3/6 (S:2724-2725,2850).
- Use pnpm through rtk proxy and the existing heavy-run slot. No simultaneous heavy lanes without that protocol.
- Leave generated lib/, dependencies, scripts/config and version band unchanged. Internal deps remain workspace:^; cross-repo catalog ranges remain published ^.
- Do not merge, push or release before phase 2 completes.

## Review Focus

Each failure mode has an explicit owning-task witness.

1. **A held occurrence precedes a completed record.** Cursor must not cross it, including after cold handoff. Task 2: `completion cannot cross a held prefix`.
2. **COMMIT rejects after a transactional effect was staged.** Pending/cursor/effect remain hidden until proof, then settle together. Task 2: `unknown completion exposes no effect before proof`.
3. **A frame opens from a retained epoch after an anchor or runtime advance.** Handler metadata must retain that frame's authenticated epoch. Task 4: `retained frame metadata survives runtime advance`.
4. **Burst A holds ownership when buffered control and B arrive.** Tasks 7/8 advertise control before root reads and prove `[A, control, B]`.
5. **A transactional handler starts during live-to-cold retirement handoff.** Exactly one delivery owner awaits completion proof before clearing. Task 10: `transactional handoff commits once before retirement clears`.

---

### Settled decisions

- **Q1=A -- cold completion coverage:** advance only with surviving ordered-prefix proof.
  Without proof, remove completed rows and preserve the cursor. Add no persisted frontier or namespace.
- **Q2=A -- multiple listeners:** use `combineDurableHandlers`, unchanged mapped handler types, and a retained-emitter registration guard.
  Hosts wrap homogeneous listener lists explicitly. Mixed policies refuse before registration.

### Out of scope and handoff owners

2.3e owns restore declarations/participants, package burn/cleanup and restore failure rows/seams.
2.4 owns the buffered hub lift and HTTP smoke, and tracks later provider/SIGKILL evidence.
Host MessageStore semantic dedup and local read-mark/receipt integration remain phases 4/5.
Upstream fetch cancellation, transport decode bounds and past-retention product policy retain their existing owners.
No task revisits commit-once, source retirement authority, revoke holds or the main merge.

## File Structure

Task Files blocks give exact ownership. These are future implementation paths, outside current drafting write permission.

| Unit | Owning source files | Tasks |
| --- | --- | --- |
| Portable contracts/policies | rpc `crypto.ts`, `handler-completion.ts`, `handlers.ts`, `opened-delivery.ts` | 1,3 |
| Atomic completion/coverage | mls-rpc `handler-completion.ts`, `entry-capability.ts`, `memory-group-persistence.ts`; rpc `app-completion-coverage.ts` | 2 |
| Metadata/peer integration | broadcast `transport.ts`, `responder.ts`; rpc `peer.ts`, `directed.ts`, `peer-epoch.ts`, `host-boundary.ts` | 4,10 |
| Scheduler/streaming | mls-rpc `group-batch*.ts`, `registry/app-open*.ts`, `registry-crypto.ts`; rpc `app-batch.ts`, `app-lane.ts` | 5,6 |
| Control intake/preparation/accounting | rpc `buffered-control.ts`, `control-batch.ts`, `peer.ts`; mls-rpc `registry/{control-batch,accounting,live-send,registry}.ts`, `mls.ts`, `crypto.ts`, `control-adoption.ts`, `registry-group-mls.ts` | 7,8 |
| Settlement/conformance | mls-rpc `app-settlement.ts`, `memory-group-ports.ts`; rpc-conformance `handler-{completion,batching}.ts` | 9,11 |

## Verification commands and gates

Run none during drafting. Obtain the existing machine-wide heavy-run slot before implementation builds, suites or broad typechecks.
The carry-forward gives priority to Sakui, then controller work, then this milestone. It supplies no lock-file API.
Do not invent one or interpret an unavailable slot as successful verification.
Use the following helpers only within the granted slot:

```bash
kbuild() { rtk proxy pnpm exec turbo run build:js build:types --env-mode=loose; }
ktest() {
  local package_name="$1"
  shift
  rtk proxy pnpm --filter "$package_name" exec vitest run --maxWorkers=2 "$@"
}
ktypes() { rtk proxy pnpm exec turbo run test:types --force --env-mode=loose; }
kports() {
  ktest @kumiai/mls-rpc test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts \
    test/storage-conformance.test.ts test/registry-conformance.test.ts \
    test/ownership-phases-conformance.test.ts test/registry-crypto-conformance.test.ts \
    test/registry-lease-conformance.test.ts test/app-publication-conformance.test.ts &&
  ktest @kumiai/rpc test/ports-conformance.test.ts test/hub-conformance.test.ts &&
  ktest @kumiai/hub-server test/conformance.test.ts test/log-hub-conformance.test.ts \
    test/purge-race-conformance.test.ts &&
  ktest @kumiai/hub-tunnel test/hub-conformance.test.ts &&
  ktest @kumiai/integration-tests test/hub-log-conformance.test.ts &&
  ktest @kumiai/hub-store test/conformance.test.ts test/purge-race-conformance.test.ts
}
```

Task 11 adds its new conformance wrapper to these gates once created.
Both contract packages run through consumers; they have no standalone test:unit shortcut.
SQL wrappers require configured engines actually executing, including PostgreSQL where required. Skipped/unavailable engines remain an explicit incomplete gate.
Build package exports before cross-package tests. Run repo-wide `rtk proxy pnpm exec turbo run test:types` for public type changes.
The forced helper records uncached evidence. Do not replace this gate with package-only typechecks.
Use one portable-contract gate after Task 1, then focused tests and relevant package typechecks during the remaining tasks.
Refresh prerequisite builds only when exported code changes or a focused import needs them.
Run both contract families, full affected suites and the final forced repo-wide typecheck once at Task 11.
Repeat a broad gate only when a later change or unresolved failure invalidates its evidence.

## Brief dispatch and evidence rules

Each dispatched brief includes binding r28i, its complete task, Global Constraints, settled Q1/Q2 decisions, and verification helpers.
Its Interfaces block repeats every new shared contract it consumes. Existing source/spec types retain their named definitions.
Attach dependency commits and any new question markers. Never dispatch a task with an unresolved spec-dependent contract.
Task test tables are the normative evidence matrix. Later gates reference them without repeating assertions.
Each Step 4 reruns its Step 2 command GREEN plus relevant package typechecks.
Each mutation needs the owning named assertion's RED and restored GREEN. Timeouts alone establish no mutation result.

## Tasks

### Task 1: Unify portable frame, handler and completion contracts

**Files:**

- Modify rpc `src/{crypto,handlers,peer,peer-types,host-boundary,index}.ts`; create `src/handler-completion.ts`.
- Modify mls-rpc `src/{persistence-types,crypto,registry-crypto,registry-peer,index}.ts` aliases/call sites.
- Modify conformance `src/{group-crypto,pending-group-crypto,persistence-fixture,registry-crypto,index}.ts` independent mirrors.
- Test new `packages/rpc/test/handler-types.test.ts`; migrate existing real/double crypto and peer fixture callers named by typechecking.

**Interfaces:**

Produces the following rpc contracts. Mls-rpc imports/re-exports aliases. Conformance mirrors them independently.

```ts
type GroupTransaction = {
  providerID: string; groupID: string | null
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}
type GroupKey = { groupID: string; incarnation: number }
type PreOpenAppFrameRef = GroupKey & {
  id: string; protocol: string; topicID: string; segment: number; position: string
}
type AppFrameRef = PreOpenAppFrameRef & { procedure: string }
type PendingAppFrame = {
  frame: AppFrameRef; payload: Uint8Array; senderDID: string; epoch: number; idempotencyKey: string
}
type OpenAppInput = { frame: PreOpenAppFrameRef; ciphertext: Uint8Array; expectedAAD?: Uint8Array }
type GroupHandlerMetadata = {
  epoch: number; incarnation: number; frame?: AppFrameRef; idempotencyKey?: string
}
type DurableHandler<TContext, TTx extends GroupTransaction> =
  | { mode?: 'at-least-once'; handle(context: TContext & GroupHandlerMetadata & {
      frame: AppFrameRef; idempotencyKey: string
    }): Promise<void> }
  | { mode: 'transactional'; handle(context: TContext & GroupHandlerMetadata & {
      frame: AppFrameRef; idempotencyKey: string; tx: TTx
    }): Promise<void> }
type MetadataHandler<THandler> = THandler extends (context: infer TContext) => infer TResult
  ? (context: TContext & GroupHandlerMetadata) => TResult : never
type GroupProcedureHandlers<TProtocol extends GroupProtocolDefinition, TTx extends GroupTransaction = GroupTransaction> = {
  [TProcedure in keyof TProtocol & string]: TProtocol[TProcedure] extends { type: 'event'; retain: 'log' }
    ? DurableHandler<EventHandlerContext<TProtocol, TProcedure>, TTx>
      | ((context: EventHandlerContext<TProtocol, TProcedure> & GroupHandlerMetadata) => void | Promise<void>)
    : MetadataHandler<ProcedureHandlers<TProtocol>[TProcedure]>
}
function adaptBusHandlers<TProtocol extends GroupProtocolDefinition, TTx extends GroupTransaction>(
  protocol: TProtocol, handlers: GroupProcedureHandlers<TProtocol, TTx>,
  options: { completion: HandlerCompletion<TTx>; suppress?: SuppressConfig },
): BusHandlerMaps
type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>): Promise<void>
}
```

- Move OpenAppResult from mls-rpc into rpc with every S:1367-1391 arm unchanged.
  Retain the existing opened arm's `handleEpoch: number` for locked-handle decisions.
- GroupCrypto.unwrap opts.frame becomes PreOpenAppFrameRef. Add `unwrapBatch?(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>`.
- GroupUnwrapResult adds required `frameEpoch: number`. Existing `epoch` remains the locked handle epoch.
- GroupPeerParams/createPeer thread TTx. Handler `completion: HandlerCompletion<TTx>` is required, including the no-MLS branch.
- Rename recovery callback options to `recoveryCompletion?: RecoveryCompletion | null`, including RegistryPeerOptions and its producer/consumer arguments.
  Keep ConfirmedRecoveryHandoff.completion's promise unchanged. Host-boundary classifies completion as a port and recoveryCompletion as a callback.
- Base `ConformanceUnwrapResult.frameEpoch: number` is required on every implementation/double.

- [ ] **Step 1: Write failing type and shape witnesses.**

Use expectTypeOf and necessary @ts-expect-error assertions for these cases:

| Witness | Assertions |
| --- | --- |
| `pre-open refs exclude procedure and opened refs require origin` | Missing GroupKey rejects. Pre-open needs no procedure; opened records require procedure/epoch/key. |
| `transactional policy is available only on retained events` | A log event infers tx. Legacy functions remain valid. Ephemeral event/request/stream/channel transactional declarations refuse. |
| `recovery and handler completion occupy distinct fields` | Both fields coexist with distinct types. The no-MLS branch accepts handler completion. |
| `registry durable unwrap preserves saved record metadata` | Singleton/batch replay returns saved sender/frame epoch/procedure/key. Wrong origin is a storage failure. |
| `base crypto reports authenticated retained frame epoch despite false hints` | Seal three distinct frames at E; advance to E+1. With hint offsets `[0,-1,1]`, each yields `frameEpoch === E`, `epoch === E+1`. Same-epoch open yields equal epochs. |

- [ ] **Step 2: Run RED.**

Run the focused type fixture through repo-wide ktypes.
Run the named base-epoch witness in rpc's ports-conformance and mls-rpc's ports/transactional/registry-crypto wrappers.
Expected failures are absent contracts or incompatible shapes, not runtime fixture import failures.

- [ ] **Step 3: Implement the portable contracts and migrate callers.**

Move/re-export rpc types without circular imports. Preserve registry sealed records; no format migration is needed.
Derive frameEpoch only from the authenticated open. Singleton replay reloads the full saved record; reject incomplete legacy records.
Registry supplies unwrapBatch. Unbound adapters may remain singleton, without pretending sequential opens are atomic.
Migrate every real/double caller and distinct recoveryCompletion option, preserving assertions and port strictness.

- [ ] **Step 4: Verify and mutate.**

Run one kbuild/ktypes portable-contract gate; both contract families gate at Task 11.
Remove the retained-event policy conditional: the ephemeral transactional type witness must fail.
Overwrite saved frameEpoch with runtime epoch: the replay metadata assertion must fail.
Omit frameEpoch, substitute the current handle epoch, or copy the false hint separately in the base crypto adapter.
Each mutation must fail the new base-conformance assertion, independently of durable replay tests.
Record any external host compatibility work in the handoff.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): define durable handler and completion contracts`.

### Task 2: Implement exact-key atomic completion and poison pruning

**Dependency:** Tasks 1/5. Q1=A: no surviving prefix proof means row removal with the durable cursor unchanged.

**Files:**

- Create `packages/mls-rpc/src/handler-completion.ts` and `packages/rpc/src/app-completion-coverage.ts`.
- Export the internal coverage coordination functions from `packages/rpc/src/index.ts` for mls-rpc consumers.
- Modify mls-rpc `src/{entry-capability,memory-group-persistence,opened-delivery,index}.ts`, `registry/app-open.ts`.
- Narrowly modify memory-incarnation-stores.ts if the exact-key cursor capability requires it.
- Test new `packages/mls-rpc/test/handler-completion.test.ts` and `test/fixtures/handler-completion.ts`, using existing storage-persistence.ts faults/side rows.

**Interfaces:**

Consumes HandlerCompletion and the scheduler contract. Produces both canonical factory paths and optional coverage coordination.

```ts
type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>): Promise<void>
}
function createHandlerCompletion<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>; key: GroupKey
}): HandlerCompletion<TTx>
function handlerCompletionForEntry<TTx extends GroupTransaction>(params: {
  capability: EntryCapability<TTx>; binding: object; key: GroupKey
}): HandlerCompletion<TTx>
type BatchBudget = { maxFrames: number; maxWorkMs: number; now(): number; begin(): void; take(): boolean }
type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'
type GroupBatchScheduler = {
  schedule<T>(work: { source: string; kind: BatchKind; signal?: AbortSignal; run(budget: BatchBudget): Promise<T> }): Promise<T>
  close(reason: Error): void
}
function groupBatchFor(binding: object, groupID: string): GroupBatchScheduler
type AppCompletionCoverage = {
  key: GroupKey; topicID: string; generation: number
  previous: string | null; through: string | null
  prefix: Array<{ frame: PreOpenAppFrameRef; state: 'pending' | 'dead' | 'completed' }>
}
type AppCompletionCoverageSource = {
  capture(ids: Array<string>): Array<AppCompletionCoverage>
  current(coverage: AppCompletionCoverage): boolean
  committed(ids: Array<string>, coverage: Array<AppCompletionCoverage>): void
}
type AppCompletionCoverageBinding = { advance(): Promise<void>; unbind(): void }
function registerAppCompletionCoverage<TTx extends GroupTransaction>(
  completion: HandlerCompletion<TTx>,
  bind: (source: AppCompletionCoverageSource) => AppCompletionCoverageBinding,
): void
function bindAppCompletionCoverage<TTx extends GroupTransaction>(
  completion: HandlerCompletion<TTx>, source: AppCompletionCoverageSource,
): AppCompletionCoverageBinding | undefined
```

EntryCapability.run gains this exact effects parameter. The coordinator owns its phase transition.

```ts
run<P, T>(
  request: { groupID: string; mutationID: string | null },
  prepare: (reads: EntryReads) => Promise<Prepared<P>>,
  work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
  effects?: (stores: GroupStores<TTx>, prepared: P, result: T) => Promise<void>,
): Promise<T>
```

- Cache by `(coordinator binding, groupID, incarnation)`. Both factories return that same identity without loading a crypto handle.
- The factory registers coverage once by completion identity. Bind returns undefined for an independent, unregistered completion port.
- Registered bindings retain the source. advance assertsRoot and captures `source.capture([])` synchronously before awaiting anything.
- unbind withdraws the source and invalidates queued captures. Later advance calls refuse. No public completion-port member is added.
- PendingAppFrames.complete(id) delegates to the exact-key canonical service.
- complete/transact/advance assertRoot synchronously before collector insertion, scheduling, reads or their first await.
- Each complete call snapshots/deduplicates IDs and resolves after every bounded prefix proves. It releases owner/transaction between prefixes.
- Missing IDs never invoke a callback. Duplicate IDs affect a saved row at most once. Each newly completed pending/poison/dead occurrence consumes one shared budget unit, deduplicated by occurrence.
- A failure rejects the call. Earlier proven prefixes remain completed. Retrying the original array safely services its surviving suffix.
- transact is one atomic callback over all its saved pending records, in stable occurrence order. Never split or reinvoke it on subsets.
- Begin the budget at owned record staging. Take before each saved pending/poison occurrence; do not charge it twice.
- Count pending/poison records during owned preparation. If the atomic set exceeds maxFrames, reject RangeError before effects or writes.
- If staging cannot admit the whole atomic set within maxWorkMs, reject RangeError with no callback or durable changes.
  A callback already started is non-preemptible. No further completion operation joins after it exhausts the work budget.
- Defer excess dead-prefix progress to another turn, retaining later completed coverage. Poison never invokes a host callback.
- Empty/all-missing calls are no-ops. Caller arrays and plaintext never replace saved records.
- Use stable per-protocol transactional source IDs containing the exact key. Composite explicit calls own a distinct source.
- Coalesce only callback-free completions. Separate transact calls always use separate transactions, regardless of policy/key/arrival ordering.
  An explicit aggregate transact call retains its host-chosen atomic set. The collector never adds another callback or lane to it.

- [ ] **Step 1: Write production-boundary failure witnesses.**

Run every storage case in real-MLS/double modes and supplied/absent ownershipContext.

| Test name | Assertions |
| --- | --- |
| `one oversized complete call yields bounded proven prefixes` | One complete(130 saved IDs): committed sizes `[64,64,2]`; cap 32: `[32,32,32,32,2]`. Promise settles after all proofs. Ready B commits between prefixes 1/2. Deduplicate IDs; missing IDs invoke nothing. Roll back prefix 2: prefix 1 stays complete, suffix pending. Retry all IDs without repeated effects. Repeat with poison-only rows and dead-only advance. With mixed saved/dead coverage, each transaction completes at most 64/32 distinct occurrences and queues excess proof. |
| `oversized atomic transact refuses without invoking its aggregate callback` | 130 saved IDs/default cap, or 33/cap 32: RangeError, callback count 0, all rows/cursors unchanged. Exactly 64/32: one callback with full ordered array. Advance staging clock to 8/host 3 after record 1: whole call refuses, callback 0, no writes. |
| `transactional failures cannot couple independent protocol lanes` | Queue separate same-key/policy A/B transact calls behind active open. A always throws; retry twice after known rollback. B effect/removal commits once before next A retry. No transaction contains both callbacks. A rows/effect/cursor remain unchanged. |
| `transactional completion commits effect pending and cursor atomically` | Two opened records plus covered poison and supplied-tx side row. Fail first write/before COMMIT: exact pre-state. Proven commit: effect exists, pending/poison absent, cursor equals proven prefix. |
| `transactional completion enters effects with domain writes refused` | Production transact phase order: `work,finalise,effects,account`. Supplied/copied/constructed tx state/trust/lifetime writes reject PersistencePhaseError. Domain bytes unchanged. Lawful side row/completion co-commit. |
| `completion cannot cross a held prefix` | Held/sealed A before opened B blocks B cursor advancement. Exercise opaque `10 < 2` and distinct topics. |
| `later completion retains live coverage until the earlier prefix closes` | A=`10`, B=`2`, held=`20`, cursor null. Complete B: only A pending, cursor null, B coverage retained. Complete A: cursor `2` atomically. Reopen: cursor `2`, no repeated effect/pending; held `20` uncrossed. |
| `unknown completion exposes no effect before proof` | Unfinished COMMIT: no effect/result/hook/cursor visible. Prove commit and rollback separately. Repeated proof duplicates no effect/hook; conflicting proof fail-stops. |
| `unknown and duplicate IDs never invoke a completed handler` | Empty/all-missing/duplicate IDs are harmless. Mixed array invokes once for saved still-pending records only. Committed restart invokes nothing again. |
| `poison pruning and cursor roll back together` | Authenticated malformed plaintext creates poison. Cursor/pruning commit or roll back together. Wrong-AAD/junk/expired future creates no poison. |
| `coverage binding advances without saved IDs and preserves unknown-ID no-op` | Bound dead `10`,`2`, no rows: complete(missing) leaves cursor null/coverage intact. advance rollback retains proof; retry commits cursor `2` with no handler/MLS writes. Reopen preserves `2`. Empty capture does nothing; stale/unbound/wrong-key proof cannot write. |
| `stale coverage cannot cross a moved cursor or incarnation` | Move cursor/generation/current hub between capture/work: reject/reprepare. Old-key completion changes no successor state/cursor. |
| `cold completion without coverage preserves the cursor` | Saved record behind unknown gap: complete without crypto/fetch, remove row, preserve cursor. Reconstruction/refetch repeats no committed transactional effect. |
| `transactional root reentry obeys ownership diagnostics` | Synchronous same-group root calls reject in both context modes; after await reject with ownershipContext. Retained stores/tx expire. No absent-context asynchronous hang witness. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/mls-rpc test/handler-completion.test.ts`.
Baseline fails at missing runner or pending/cursor split. Raw manual stores composition is not an acceptable substitute witness.
Task 2's later-prefix witness binds its explicit ordered-proof fixture to the production completion runner.
Task 6 repeats it through the production AppLane. Storage/crypto ports alone provide no ordered-prefix proof.

- [ ] **Step 3: Implement bounded completion through retained D8 entries.**

Capture immutable lane coverage synchronously, outside any app mutex. Read and revalidate saved occurrence identities under ownership.
The source snapshot records ordered traversal from the durable cursor, including held boundaries and completed suffixes.
`through` is the last eligible position. Never infer it from max(position), numeric succession or hub claims.
Check key/topic/generation/durable cursor and source.current before effects and final writes. Stale captures reprepare without invoking handlers.
Every crossed member must be validated dead, already completed, or in this successful completion set.
Retain completed B's occurrence when earlier A blocks advancement. Only committed prefix retirement or generation reset drops that evidence.
Truncate dead-only advance to the same count/work budget. Re-advertise eligible remainder after release.
Missing-ID complete cannot trigger dead-only advancement. Only the bound advance operation requests that mode.
Capture the entry-bound callable before finalise. Invoke it through entry.callback after entering effects, before existing outbox/delete effects.
Invoke the host with stores.tx and saved records. Complete pending/covered poison and save proven cursor through effects-phase side stores.
Keep existing account/proof/hook ordering and every domain-write restriction. Never call root stores or transition from that callback.
Only proven commit calls source.committed(ids, consumedCoverage). Rollback retains captures for retry and exposes no results.
Without coverage, complete rows and preserve the cursor. Exact retired-key completion cannot follow activeIncarnation or clear another cursor.
If necessary, grant only that entry a narrow retired-key cursor capability. Public root cursor.save remains active-only.
Completion-only work preserves MLS version, receive state, trust and controller knowledge. Preserve provider error identity and fail-stop.

- [ ] **Step 4: Verify and mutate.**

Run affected storage/ownership phase witnesses.
Collapse one complete(130 IDs) into one transaction: its exact size/release assertions must fail.
Split transact's callback or remove its oversize/work refusal: the zero-callback/full-array assertions must fail.
Fuse separate transactional A/B callbacks: B's committed effect assertion must fail after A throws.
Move cursor save or side effect outside the transaction: the atomic witness must fail.
Move the host callback into work: the completion phase/refusal witness must fail.
Advance max(position) across a held gap: the held-prefix witness must fail.
Discard completed B's coverage when A remains pending: the later-prefix cursor assertion must fail.
Remove poison deletion, origin check, pending recheck and proof wait separately: each corresponding named witness must fail.
Route binding.advance through the missing-ID early return: its cursor assertion must fail. Unknown-ID completion must remain harmless.

- [ ] **Step 5: Commit.**

Commit with `feat(mls-rpc): complete handler effects and cursors atomically`.

### Task 3: Dispatch default and transactional policies through one handler adapter

**Dependency:** Tasks 1/2. Q2=A is settled.

**Files:**

- Modify `packages/rpc/src/{handlers,opened-delivery}.ts`, `index.ts` exports; create a small handler-policy.ts only if normalisation needs separation.
- Test `packages/rpc/test/{handlers,opened-delivery}.test.ts`; extend handler-types.test.ts for helper inference.
- Extend `packages/mls-rpc/test/handler-completion.test.ts` with the production dispatcher phase witness after Task 2.

**Interfaces:**

Consumes the following completion and metadata contracts. Produces the dispatcher, normaliser and listener helper.

```ts
type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>): Promise<void>
}
type GroupHandlerMetadata = {
  epoch: number; incarnation: number; frame?: AppFrameRef; idempotencyKey?: string
}
function groupHandlerMetadata(transit: { epoch?: number }, key: GroupKey): GroupHandlerMetadata
type OpenedAppHandler<TTx extends GroupTransaction> = {
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  deliver(record: PendingAppFrame): Promise<void>
}
function createOpenedAppHandler<
  P extends Record<string, GroupProtocolDefinition>, TTx extends GroupTransaction,
>(params: {
  localDID: string; protocols: P
  handlers: { [K in keyof P]: GroupProcedureHandlers<P[K], TTx> }
  suppress?: SuppressConfig
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx>
function normaliseOpenedAppHandler<TTx extends GroupTransaction>(params: {
  deliver: OpenedAppHandler<TTx> | ((record: PendingAppFrame) => Promise<void>)
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx>
function combineDurableHandlers<TContext, TTx extends GroupTransaction>(
  handlers: [DurableHandler<TContext, TTx>, ...Array<DurableHandler<TContext, TTx>>],
): DurableHandler<TContext, TTx>
function adaptBusHandlers<TProtocol extends GroupProtocolDefinition, TTx extends GroupTransaction>(
  protocol: TProtocol, handlers: GroupProcedureHandlers<TProtocol, TTx>,
  options: { completion: HandlerCompletion<TTx>; suppress?: SuppressConfig },
): BusHandlerMaps
```

- DurableHandler uses mode omitted/'at-least-once' without tx, or mode 'transactional' with tx: TTx.
  Both require saved frame/idempotencyKey plus authenticated epoch/incarnation in the callback context.
- Q2=A: unchanged GroupProcedureHandlers mapping, explicit combineDurableHandlers for listener lists, retained-emitter registration guard.
- Successful deliver includes proven completion. Default callbacks run outside ownership, then complete. Transactional callbacks run via transact.
- Raw callbacks normalise to at-least-once. Reject mismatched key, completion identity or shared context before invocation.
- groupHandlerMetadata requires authenticated epoch. It takes incarnation from the supplied key, with no fallback.

- [ ] **Step 1: Write policy and registration witnesses.**

| Test name | Assertions |
| --- | --- |
| `legacy and omitted mode handlers complete after success outside ownership` | Legacy/omitted-mode callback has no owner/tx; gets saved frame/key/epoch/incarnation. Success completes once; failure retains pending. |
| `transactional dispatch uses saved records and one supplied transaction` | Context uses transact-loaded records. Effect/completion share tx; no appended completion. Duplicate completed dispatch invokes no callback. |
| `production transactional handler preserves effects-phase restrictions` | createOpenedAppHandler + createHandlerCompletion: after-await domain writes through supplied/copied/constructed tx reject PersistencePhaseError. Domain unchanged, one side row/completion; both ownershipContext modes. |
| `mixed durable listener policies refuse before registration` | Mixed policy, empty runtime list or invalid mode rejects before listeners/sources install. Homogeneous listeners run in declaration order, one completion. |
| `retained event listeners cannot bypass completion policy` | Extra unclassified retained events.on registration rejects. Ordinary ephemeral listeners remain available. |
| `ephemeral handlers never invoke completion` | All ephemeral kinds omit frame/key/tx and call complete/transact 0 times. Transactional ephemeral registration rejects. Wrong-retention ingress invokes no durable policy. |
| `handler failure isolates its lane` | A failure retains pending/blocks later A; B succeeds. Default fan-out may repeat earlier callbacks. Transactional fan-out rolls back every durable effect. |
| `standalone opened helper retains lifecycle context after await` | Both policies retain required shared context. After await, same-group lifecycle rejects OpenedDeliveryReentryError. Independent callers/groups stay unbound; missing context rejects construction. |
| `handler adapter projects authenticated event and request transit` | Transit epoch 7/key incarnation 3 yields `{epoch:7,incarnation:3}`. Missing epoch invokes nothing. Durable frame/key persist; ephemeral frame/key/tx absent. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/handlers.test.ts test/opened-delivery.test.ts` and the new mls-rpc production-handler witness.
Expected missing policy support or missing metadata/completion, not an unrelated transport timeout.

- [ ] **Step 3: Implement policy registration and durable dispatch.**

Normalise legacy functions to at-least-once; validate policy and retention before listener installation.
Unknown protocol/missing handler retains pending. Default callbacks run outside ownership, then complete; transactional callbacks use transact.
Bind openedDeliveryContext only around actual host callbacks. Enter completion outside that context to avoid diagnosing its own scope.
Guard retained emitter registration; preserve homogeneous listener order and authenticated context projection.

- [ ] **Step 4: Verify and mutate.**

Remove mixed-mode refusal: its registration test must fail before any handler runs.
Invoke transactional callback outside transact or append duplicate default completion: the respective boundary witness must fail.
Move the actual coordinator callback into work: the assembled production-handler phase assertion must fail.
Add no policy to ephemeral paths and confirm complete/transact spies remain zero.
Drop the helper's shared context or defer entry until after the callback: the standalone lifecycle witness must fail.
Drop handlers.ts event/request metadata projection: the authenticated transit context assertions must fail.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): dispatch durable handler completion policies`.

### Task 4: Wire original peer coordination and carry authenticated transit metadata

**Dependency:** Tasks 2/3/5. Finish this wiring before Task 6.

**Files:**

- Modify `packages/broadcast/src/{transport,responder}.ts` and rpc `src/{peer,peer-epoch,directed,open-once,host-boundary,app-lane}.ts`.
- Modify mls-rpc `src/registry-peer.ts` to supply canonical completion to peer adapters independently of recoveryCompletion.
- Extend `packages/mls-rpc/test/registry-peer.test.ts` with the exact-key canonical completion option witness.
- Test broadcast `test/{transport,responder}.test.ts`, new rpc `test/handler-metadata.test.ts`, rpc `test/{host-boundary,directed,directed-isolation}.test.ts`, integration `test/directed-lane.test.ts`.
- Migrate direct AppLane test constructors to the required completion-owning dispatcher inputs.

**Interfaces:**

```ts
type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>): Promise<void>
}
function createHandlerCompletion<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>; key: GroupKey
}): HandlerCompletion<TTx>
function handlerCompletionForEntry<TTx extends GroupTransaction>(params: {
  capability: EntryCapability<TTx>; binding: object; key: GroupKey
}): HandlerCompletion<TTx>
type BatchBudget = { maxFrames: number; maxWorkMs: number; now(): number; begin(): void; take(): boolean }
type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'
type GroupBatchScheduler = {
  schedule<T>(work: { source: string; kind: BatchKind; signal?: AbortSignal; run(budget: BatchBudget): Promise<T> }): Promise<T>
  close(reason: Error): void
}
type StreamingOpenResult = { consumed: number; results: Array<OpenAppResult> }
type AppBatchBinding = {
  key: GroupKey
  scheduler: GroupBatchScheduler
  openReady(frames: Array<OpenAppInput>, budget: BatchBudget): Promise<StreamingOpenResult>
}
function bindAppBatch(crypto: GroupCrypto, binding: AppBatchBinding): void
function appBatch(crypto: GroupCrypto): AppBatchBinding | undefined
type OpenedAppHandler<TTx extends GroupTransaction> = {
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  deliver(record: PendingAppFrame): Promise<void>
}
function createOpenedAppHandler<
  P extends Record<string, GroupProtocolDefinition>, TTx extends GroupTransaction,
>(params: {
  localDID: string; protocols: P
  handlers: { [K in keyof P]: GroupProcedureHandlers<P[K], TTx> }
  suppress?: SuppressConfig
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx>
type GroupHandlerMetadata = {
  epoch: number; incarnation: number; frame?: AppFrameRef; idempotencyKey?: string
}
function groupHandlerMetadata(transit: { epoch?: number }, key: GroupKey): GroupHandlerMetadata
```

- `AppLaneParams<TTx extends GroupTransaction = GroupTransaction>` requires completion, with openedHandler required when crypto.pending exists.
  `createAppLane<TTx extends GroupTransaction>(params: AppLaneParams<TTx>): AppLane` accepts optional `batch?: AppBatchBinding`.
- Capture input.completion/appBatch(input.crypto) before wrapPeerHost; pass originals to lane/dispatcher. Check each binding's key first.
- RegistryPeerOptions/RegistryPeerParams thread TTx, canonical origin-key completion, and distinct recoveryCompletion.
- Live dispatcher uses the shared openedDeliveryContext/openedScope.owner. Its successful deliver includes completion.
- Host-boundary classifies key/complete/transact, preserving drainage/claims. Task 6 binds coverage to the original identity.
- Broadcast UnwrapResult/BroadcastMessage/BusEvent/request transit gains optional epoch. Group adapters require authenticated frameEpoch.
- OpenedInbound requires epoch/incarnation. EpochRuntimeParams/InboxPathParams receive origin GroupKey from completion.key.
- Directed ingress overwrites `kumiai/epoch`/`kumiai/incarnation` per frame. handlers.ts projects event/request transit.

- [ ] **Step 1: Write a metadata matrix.**

| Test name | Assertions |
| --- | --- |
| `peer captures original coordination before host wrapping` | Actual createPeer/wrapPeerHost: real dispatcher receives `completion === input.completion`, saved delivery completes once. Wrong keys reject before source/handler registration. Spy forwards to real dispatcher. |
| `registry peer forwards the canonical completion for its requested key` | Actual createRegistryPeer forwards the identity returned by createHandlerCompletion for requested key. recoveryCompletion stays separate. Another key yields another canonical identity. |
| `retained frame metadata survives runtime advance` | Open retained frame E after handle advancement. Host receives frame E and origin incarnation; durable frame/key remain stable. |
| `anycast metadata survives suppression delay` | Advance runtime during jitter. Callback retains invoking epoch/incarnation, sender and abort signal. |
| `directed invocation metadata is per frame across a surviving session` | Cross event/request/stream/channel on one session across rotation. Each invocation gets its own frame metadata; an existing stream/channel keeps its invocation metadata. |
| `wire and header metadata cannot override authenticated transit facts` | Spoof epoch/incarnation/sender in bytes/headers. Authenticated transit overwrites them. Missing authenticated epoch invokes nothing and persists nothing. |
| `metadata-only ephemeral delivery persists nothing` | Warm leases/receive; exercise all kinds/replies. Group transition/outbox/pending/cursor calls 0. Successful-open counts unchanged. |

- [ ] **Step 2: Run RED.**

Run focused broadcast transport/responder and rpc directed metadata tests.
Expected metadata absence/current-epoch substitution, not signature or session setup failure.
The coordination witness must fail for missing original identities or split delivery, independently of transport metadata.

- [ ] **Step 3: Implement transport projection and per-frame stamping.**

Capture original completion/batch before host wrapping and pass them directly into AppLane and its dispatcher.
RegistryPeer obtains canonical completion for the requested key. Validate key/context before installing sources.
Forward authenticated frameEpoch/sender through broadcast and suppression. Missing epoch removes decoded hints and refuses group delivery.
Stamp directed epoch/incarnation headers for each frame, preserving invocation metadata across streams/channels and runtime rotation.
Keep retained delivery on its durable dispatcher and preserve one consuming open, sender splice checks and tunnel survival.

- [ ] **Step 4: Verify and mutate.**


Replace frame epoch with runtime/session epoch: retained/per-frame tests must fail.
Stop overwriting headers or drop metadata during suppression: spoof/jitter tests must fail.
Pass wrapped completion to the live dispatcher: the original-coordination witness must fail its identity or completion assertion.
Task 6 separately mutates batch propagation and coverage registration after their production consumers exist.
Repeat ephemeral zero-transaction witnesses after the metadata changes.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): preserve authenticated metadata on every invocation path`.

### Task 5: Build the per-group adaptive fairness arbiter

**Dependency:** Task 1 and existing GroupBatchOptions. Execute before Task 2; this task supplies its completion budgets.

**Files:**

- Create `packages/rpc/src/app-batch.ts` and export its coordination types/binding.
- Create `packages/mls-rpc/src/{group-batch,group-batch-binding}.ts` and `test/group-batch.test.ts`.
- Modify `registry/types.ts` and `registry/registry.ts` for batch options and initialisation. Task 8 owns observation/accounting integration.

**Interfaces:**

Produces the exact scheduler, budget and original-crypto coordination contracts consumed by subsequent tasks.

```ts
type BatchBudget = { maxFrames: number; maxWorkMs: number; now(): number; begin(): void; take(): boolean }
type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'
type GroupBatchScheduler = {
  schedule<T>(work: { source: string; kind: BatchKind; signal?: AbortSignal; run(budget: BatchBudget): Promise<T> }): Promise<T>
  close(reason: Error): void
}
type StreamingOpenResult = { consumed: number; results: Array<OpenAppResult> }
type AppBatchBinding = {
  key: GroupKey
  scheduler: GroupBatchScheduler
  openReady(frames: Array<OpenAppInput>, budget: BatchBudget): Promise<StreamingOpenResult>
}
function bindAppBatch(crypto: GroupCrypto, binding: AppBatchBinding): void
function appBatch(crypto: GroupCrypto): AppBatchBinding | undefined
type GroupBatchOptions = { maxBatchFrames?: number; maxBatchDelayMs?: number; maxBatchWorkMs?: number }
function createGroupBatchScheduler(params: { options?: GroupBatchOptions; now?: () => number }): GroupBatchScheduler
function groupBatchFor(binding: object, groupID: string): GroupBatchScheduler
```

- GroupHandleRegistryParams gains `batch?: GroupBatchOptions`. Bind registry options before application work starts.
- groupBatchFor shares one arbiter per coordinator binding/groupID. Without registry options, it uses defaults 64/2/8.
- Refuse conflicting options on an already-live binding. Do not create a second arbiter or reset live budgets.
- One schedule run performs one bounded transaction. Sources own unconsumed inputs and re-advertise only after release.
- begin starts owned staging, excluding queue waits. It never resets an active budget. take counts an operation before staging it.
- At count/work equality, admit no next operation. The first non-preemptible operation may start after setup consumed its budget.
- Defaults: 64 frames, 2 ms delay, 8 ms work. Count is an integer; valid work limits may be fractional.
- Opens additionally obey their hard cap 64. Values above 64 never enlarge a registry open batch.
- Default completions may coalesce. Distinct transact callbacks never coalesce, including equal origin/policy.
- Runtime disposal withdraws its signal-bound sources. close applies only to whole-binding shutdown, preserving cold owed work.
- The scheduler changes no owner-queue FIFO and calls no storage/handlers itself. Unresolved proof retains D8 ownership.
- Accounting is an ordinary source. Within each round, ordinary sources keep readiness order after ready control receives priority.

- [ ] **Step 1: Write deterministic scheduler tests.**

| Test name | Assertions |
| --- | --- |
| `idle lone work starts without advancing batching timers` | First run starts immediately; no coalescing timer fires first. |
| `active arrivals coalesce without waiting beyond two milliseconds` | Hold active A while ready work collects. After release flush immediately or within remaining 2 ms; count cap flushes first. Active time is excluded. |
| `count and staging work stop at the next operation boundary` | Defaults 64/2/8. begin excludes queue delay; take rejects next operation at 8 ms or count 64. Repeated begin cannot reset budget. |
| `active A then control then B fits three batches` | Hold A, ready control/B, continuously replenish A. Batch prefix exactly `[A,control,B]`, without advancing timers. |
| `each ready source gets one turn per round` | Ordinary enqueue/completion/settlement/accounting sources each run before A repeats, in readiness order. Replenished control cannot starve them. |
| `post-release accounting cannot overtake buffered control and B` | Hold A, ready B/control, then offer accounting when A releases. Owner-entry prefix `[A,control,B]`; accounting runs before A repeats. Read callbacks enter only when their turn starts. |
| `group B progresses while A is suspended` | Different binding/group schedulers: B completes while A callback/proof remains unresolved. No global mutex. |
| `invalid bounds refuse before ownership` | Reject NaN/infinity/nonpositive count/work, fractional count, negative delay. Accept delay 0 and positive fractional work. |
| `closing a source cannot reroute queued work to a new incarnation` | Withdrawal rejects only that source. No key substitution. Shared storage-only obligations remain serviceable. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/mls-rpc test/group-batch.test.ts`.
Expected absent scheduler. Keep tests free of real crypto and wall-clock thresholds.

- [ ] **Step 3: Implement ready-source rounds and options binding.**

Take ownership of no more than one scheduled batch at a time. Resolve each scheduled promise from its own run result.
Track round service before accepting a replenished source's next turn. Give ready control first service at each boundary.
Keep ordinary readiness order within the round. Post-release accounting cannot overtake B already ready during A.
Keep pending source collections outside admitted D8 entries. Do not change D8 FIFO or proof retention.

- [ ] **Step 4: Verify and mutate.**

Remove control priority, per-round service memory and independent binding separately: their named tests must fail.
Let late accounting overtake B: the post-release accounting order assertion must fail.
Delay idle work by 2 ms: the no-timer test must fail.

- [ ] **Step 5: Commit.**

Commit with `feat(mls-rpc): arbitrate bounded group batches fairly`.

### Task 6: Batch retained opens and bind live completion coverage

**Dependency:** Tasks 2/3/4/5. Q1=A is settled. Task 4 must finish live peer/host/binding wiring before this task starts.

**Files:**

- Modify rpc `src/app-lane.ts`, mls-rpc `src/registry/{app-open,access}.ts` and `registry-crypto.ts`.
- Create `packages/mls-rpc/src/registry/app-open-binding.ts` for the internal access-to-streaming-preparation binding.
- Test `packages/mls-rpc/test/{registry-open-batch,group-batch-integration}.test.ts`, rpc `test/{durable-drain,app-lane-hub-faults}.test.ts`.
- Extend `packages/mls-rpc/test/fixtures/registry-crypto.ts` with controllable staging/proof boundaries.

**Interfaces:**

Consumes the following completion, streaming, coverage and dispatcher contracts. Q1=A preserves cursors when proof is unavailable.

```ts
type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>): Promise<void>
}
type BatchBudget = { maxFrames: number; maxWorkMs: number; now(): number; begin(): void; take(): boolean }
type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'
type GroupBatchScheduler = {
  schedule<T>(work: { source: string; kind: BatchKind; signal?: AbortSignal; run(budget: BatchBudget): Promise<T> }): Promise<T>
  close(reason: Error): void
}
type StreamingOpenResult = { consumed: number; results: Array<OpenAppResult> }
type AppBatchBinding = {
  key: GroupKey
  scheduler: GroupBatchScheduler
  openReady(frames: Array<OpenAppInput>, budget: BatchBudget): Promise<StreamingOpenResult>
}
function bindAppBatch(crypto: GroupCrypto, binding: AppBatchBinding): void
function appBatch(crypto: GroupCrypto): AppBatchBinding | undefined
type AppCompletionCoverage = {
  key: GroupKey; topicID: string; generation: number
  previous: string | null; through: string | null
  prefix: Array<{ frame: PreOpenAppFrameRef; state: 'pending' | 'dead' | 'completed' }>
}
type AppCompletionCoverageSource = {
  capture(ids: Array<string>): Array<AppCompletionCoverage>
  current(coverage: AppCompletionCoverage): boolean
  committed(ids: Array<string>, coverage: Array<AppCompletionCoverage>): void
}
type AppCompletionCoverageBinding = { advance(): Promise<void>; unbind(): void }
function bindAppCompletionCoverage<TTx extends GroupTransaction>(
  completion: HandlerCompletion<TTx>, source: AppCompletionCoverageSource,
): AppCompletionCoverageBinding | undefined
type OpenedAppHandler<TTx extends GroupTransaction> = {
  completion: HandlerCompletion<TTx>; openedDeliveryContext: OpenedDeliveryContext
  deliver(record: PendingAppFrame): Promise<void>
}
function groupHandlerMetadata(transit: { epoch?: number }, key: GroupKey): GroupHandlerMetadata
type RegistryStreamingOpen = AppBatchBinding['openReady']
function bindRegistryStreamingOpen(access: RegistryHandleAccess, binding: AppBatchBinding): void
function registryStreamingOpen(access: RegistryHandleAccess): AppBatchBinding | undefined
```

- AppLane receives original completion, openedHandler and optional batch directly from peer construction.
- Bind access to `{key: owner.key, scheduler: groupBatchFor(params.binding, owner.key.groupID), openReady}`.
  Registry crypto transfers that binding to its original returned crypto object. Published RegistryHandleAccess stays unchanged.
- Streaming counts each attempted input, including refusal/replay. For a consumed prefix k, results.length === consumed === k.
- Caller retains frames.slice(k). Rejection exposes no results and consumes no caller inputs. Empty input returns 0/[] .
- Nonempty successful streaming consumes at least one. Unknown COMMIT retains ownership and publishes nothing until proof.
- One run returns one atomic prefix. Receive conflicts yield a fresh source turn. Explicit openBatch never splits and rejects >64 before reads.
- Unbound singleton adapters get one open per turn. Pending-backed singleton replay reloads the full saved record.
- bindAppCompletionCoverage returns undefined for an unregistered structural port. Peer construction and policy delivery remain valid.
- In that fallback, await the supplied complete/transact promise, then update volatile completed/dead state.
  Preserve durable cursors and retain no root-cursor repair path. Rowless dead prefixes remain volatile until a coverage-capable adapter exists.
- Document restart/refetch cost. The portable adapter owns idempotent durable completion and may implement equivalent internal cursor proof.
- Registered canonical services use bound advance for rowless dead prefixes. Never silently substitute wrapped identities.

- [ ] **Step 1: Write real/double streaming witnesses.**

| Test name | Assertions |
| --- | --- |
| `structural completion without private registration remains a portable adapter` | Rpc-only fixture implements key/complete/transact, atomic side rows and pending, with no mls-rpc imports/registration. Actual peer delivers both policies: saved metadata exact, original methods called once, pending gone, one transactional effect. Unknown/duplicates no-op. Reconstruct: no repeated handler/effect; durable cursor unchanged. Rowless dead input calls no cursor save/completion. No registration error. |
| `streaming burst uses bounded atomic open batches` | 130 ready frames: sizes `[64,64,2]`; host cap 32: `[32,32,32,32,2]`. Fixed work clock and held first stage. Results equal full saved records. |
| `real peer keeps registry batching and completion through host wrapping` | Actual registry crypto/canonical completion/createPeer in both modes. Feed 130 retained hub occurrences; hold handlers. Open sizes `[64,64,2]`, singleton unwrap calls 0. Release handlers: original canonical service gets coverage and completes each once. No direct seam/test rebinding. |
| `later completion retains live coverage until the earlier prefix closes` | Actual registry-bound peer/retained fetch in both modes. Feed same-topic A=`10`, B=`2`, held future=`20`, cursor null. Hold A's default handler until both saved opens prove and production AppLane captures traversal. Complete B through canonical completion: only A pending, cursor null. Release A: its normal completion commits cursor `2`; held `20` stays uncrossed. Reopen: cursor `2`, no repeated effect/pending. Never install fixture-only coverage or rebind the lane. |
| `actual decrypt staging crosses eight milliseconds before the next batch` | Three valid inputs; advance 0→8 inside first actual decryptStaged: committed groups `[[1],[2,3]]`, consumed 1 then 2. Repeat 0→3 at host cap 3. Decrypt outside tx; suffix untouched until resubmission. Explicit openBatch returns all three atomically. |
| `streaming remainder belongs to its original source through rollback` | Five inputs/count 2: two ordered results, three untouched inputs. Rollback exposes no result/prefix; retry starts at input 1. New generation inherits no suffix. Refusals count as consumed. |
| `one peer discovers both ready protocols before awaiting a source` | Actual retained-fetch ingress buffers A/B. Hold A owned batch, replenish A: B advertises before A finishes; order starts A,B. No direct B scheduler submission. |
| `retained singleton without pending projects authenticated metadata` | Non-pending compatibility: frameEpoch 7/handle epoch 8/origin incarnation 3 yields legacy handler `{epoch:7,incarnation:3}`. |
| `mixed refusal keeps valid siblings and holds incomplete prefix` | Valid/poison/wrong-AAD/future/duplicate preserve result order and valid siblings. Held occurrence remains incomplete; no handler before proof. |
| `scheduled N open rollback exposes no plaintext` | Fail first write/before COMMIT, retry/reconstruct. N key advances/pending/poison co-commit or none. No handler/ack/output leak. |
| `dead prefix prunes poison in the cursor transaction` | Scheduled malformed frame becomes dead. Poison pruning/cursor co-commit or roll back. No poison remains behind committed cursor. |
| `rowless dead-only peer prefix commits its cursor and survives reopen` | Actual peer/retained fetch/canonical completion, both modes: wrong-AAD/invalid-ciphertext/unsupported outer/expired-future at `10,2,20,3`. No pending/poison/handler. Cursor rollback keeps null and volatile proof. Retry commits `3`; reconstruction fetches after `3`. No saved-ID completion triggers this. |
| `future expiry alone requests rowless completion` | Actual peer at E: E+3 completes immediately; E+2 remains held at 29,999 ms, retries open then expires at 30,000 ms without new traffic. Cursor `2`, no rows/handler. |
| `coverage capture cannot deadlock completion behind app mutex` | Hold app delivery while completion prepares. Capture acquires no mutex. Cursor/generation reset invalidates proof before writes. |
| `batching preserves controller knowledge and control progress` | Save current controller knowledge, batch opens: knowledge retained. Block handler A; authenticated control still applies. |

- [ ] **Step 2: Run RED.**

Run the targeted app-lane and registry/group-batch files.
Expected singleton transaction counts, narrow record projection or split cursor/poison handling.

- [ ] **Step 3: Implement bounded collection and exact saved-record delivery.**

Snapshot all ready topics under runAppLane before awaiting a pull, open or handler. Reserve each topic, then release the mutex.
Advertise every ready source before awaiting results. Hub I/O runs outside reservations/ownership/scheduler callbacks.
Pass one budget into owned preparation and take before each attempted input. Reuse app-open CAS/safety/lease/controller validation.
After proof, merge only the consumed prefix under the mutex. Keep suffix ownership/generation and advertise a fresh source turn.
Deliver full saved results; singleton/non-pending delivery projects authenticated frameEpoch and originating incarnation.
Maintain immutable coverage outside the mutex/owner cycle. Only proof retires completed coverage.
Use optional bound advance for dead/refused/expired prefixes outside mutex/scheduler/ownership. Never save durable cursors separately.
Without registration, retain conservative volatile progress and the supplied completion identity. Keep future window 2 and age 30,000 ms.

- [ ] **Step 4: Verify and mutate.**

Run existing registry crypto/open tests affected by preparation changes.
Require private coverage registration at construction: the structural-adapter test must fail at peer construction.
Add a fallback root cursor.save or silently replace its completion: the same test's cursor/method-identity assertions must fail.
Revert to singleton consumption: transaction-count witness must fail.
Charge only array collection time, or omit take inside decrypt preparation: the actual-stage boundary assertion must fail.
Consume the whole offered array on a short result: the remainder ownership assertion must fail.
Restore whole-lane draining before advertising B: the real producer readiness assertion must fail.
Remove original batch propagation in createPeer while leaving the registry streaming seam intact.
The real-peer witness must fail `[64, 64, 2]` or zero singleton calls, even if direct streaming tests pass.
Substitute wrapped completion at the lane input: canonical coverage/completion assertions and the rowless peer cursor witness must fail.
Discard completed B from production AppLane coverage after row removal: the live later-prefix witness must fail cursor `2`.
Drop metadata only in the non-pending branch: its handler-context assertion must fail.
Expose one result before commit or remove a sibling from rollback: N-open witness must fail.
Skip saved procedure/epoch/key projection, poison prune or held-prefix stop separately: corresponding witnesses must fail.
Remove the dead-prefix advance request: the rowless peer test must fail at expected cursor `3`, without a timeout.
Remove expiry's advance request separately: the 30,000 ms cursor assertion must fail. Restore each request and require GREEN.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): consume retained frames through adaptive open batches`.

### Task 7: Separate buffered control intake from persistence-driven walking

**Dependency:** Tasks 4/5/6. This task exposes readiness; Task 8 implements selected owned control preparation.

**Files:**

- Create `packages/rpc/src/{buffered-control,control-batch}.ts` and `test/buffered-control.test.ts`.
- Modify rpc `src/{peer,index}.ts` for checked-page buffering and original-MLS binding capture.
- Extend mls-rpc `test/group-batch-integration.test.ts` with intake checkpoints using a recording control binding.

**Interfaces:**

Produces the intake and internal original-MLS coordination types. Consumes the scheduler contract for pre-admission readiness.
`CoveredFetchResult` and `checkedFetchResult` come from rpc `src/log-delivery.ts`.

```ts
type BatchBudget = { maxFrames: number; maxWorkMs: number; now(): number; begin(): void; take(): boolean }
type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'
type GroupBatchScheduler = {
  schedule<T>(work: { source: string; kind: BatchKind; signal?: AbortSignal; run(budget: BatchBudget): Promise<T> }): Promise<T>
  close(reason: Error): void
}
type ReadyControlScope = {
  source: AdoptionExpected
  control(): ControlSnapshot
  anchor(): AnchorSlot | null
  readEpoch: GroupMLS['readEpoch']
  readCommitHeader: GroupMLS['readCommitHeader']
  rosterEntries: GroupMLS['rosterEntries']
  isLedgerComplete: GroupMLS['isLedgerComplete']
  openEntries: GroupCrypto['openEntries']
  exportSecret: GroupCrypto['exportSecret']
  validation: ControlValidationPort
  prepareCommit: GroupMLS['processCommit']
  prepareOwn: ControlAdoptionPort['adopt']
  stageControl(changes: ControlChanges, mutationID: string): void
  stageAnchor(slot: AnchorSlot): void
}
type ControlBatchBinding = {
  key: GroupKey
  run<T>(input: {
    source: string
    signal?: AbortSignal
    prepare(scope: ReadyControlScope): Promise<T>
  }): Promise<{ value: T; epoch: number; control: ControlSnapshot; anchor: AnchorSlot | null }>
}
function bindControlBatch(mls: GroupMLS, binding: ControlBatchBinding): void
function controlBatch(mls: GroupMLS): ControlBatchBinding | undefined
type BufferedControlPage = {
  topicID: string; after: string | null; generation: number
  result: CoveredFetchResult
}
type BufferedControlIntake = {
  offer(page: BufferedControlPage): void
  next(): { page: BufferedControlPage; index: number } | undefined
  consumed(input: { generation: number; topicID: string; position: string }): void
  reset(generation: number): void
}
function createBufferedControlIntake(params: { key: GroupKey; ready(): void }): BufferedControlIntake
```

- ControlBatchBinding is internal coordination, without new published GroupMLS/RegistryHandleAccess methods.
- Capture controlBatch(input.mls) before wrapPeerHost. Validate its key against input.completion.key before source installation.
- offer stores a checked page and invokes ready synchronously when its next occurrence becomes available.
- next/consumed preserve page order, opaque positions, fetched head/gap facts and exact source generation.
- reset invalidates old pages and acknowledgements. Push metadata only wakes a checked fetch.
- Bound peers invoke run before root readEpoch/readCommitHeader/control.load/isLedgerComplete/roster/anchor prerequisites.
- Missing startup replay/bootstrap/confirmed-recovery prerequisites remain external gates. Already-actionable buffered input cannot wait behind a fresh root read.
- Unbound peers keep their existing walker. No test may bind only the wrapped MLS object.

- [ ] **Step 1: Write failing intake and peer checkpoints.**

| Test name | Assertions |
| --- | --- |
| `buffered control intake preserves checked page order and generation` | Offer positions `10`, `2`, then a second checked page. Observe original order and same fetched head/gap provenance. ready runs before offer returns. Stale consumed/reset cannot acknowledge a new-generation occurrence. Wakeup without fetched bytes produces no next occurrence. |
| `peer advertises buffered control before prerequisite reads` | Use one actual peer, original MLS binding and real commit-topic wakeup/fetch. Hold application A's owner while B is buffered. A recording binding delegates readiness to the real arbiter. After fetch, before releasing A, ready control count is 1, B is ready, prerequisite root-read admissions are 0. No direct scheduler control submission substitutes for ingress. Task 8 supplies actual adoption assertions. |
| `pending control fetch does not hide already-buffered work` | Withhold one fetch while buffered B advertises. No owner/scheduler callback waits on network. Dispose/reset withdraws only that generation; owed storage work remains serviceable. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/buffered-control.test.ts` and the named intake checkpoints in group-batch-integration.
Expected failure: missing buffer or readiness hidden behind prerequisite root admission.

- [ ] **Step 3: Implement intake and original binding capture.**

Fetch/check/buffer pages independently of runSerial's persistence work. Advertise the next actionable occurrence synchronously before walker prologue reads.
Keep fetched coverage and traversal bookkeeping together. Do not classify acceptance from hub bytes or pre-admit queued source turns.
Route bound occurrences through the captured run callback. Retain the existing unbound route.
Unmet external prerequisites release the intake attempt; their continuations request fresh readiness after completion.

- [ ] **Step 4: Verify and mutate.**

Move root control.load/readEpoch before advertising run: the zero-admission/readiness assertion must fail while A owns.
Look up binding only after wrapping: the original-binding checkpoint must fail.
Await the withheld fetch before advertising B or acknowledge the wrong generation: the respective checkpoint must fail without a timeout.

- [ ] **Step 5: Commit.**

Commit with `refactor(rpc): advertise buffered control before persistence prerequisites`.

### Task 8: Prepare and adopt buffered control in one selected owned entry

**Dependency:** Tasks 2/4/5/6/7. Buffered intake and original-MLS binding capture are complete.

**Files:**

- Create `packages/mls-rpc/src/registry/{control-batch,accounting}.ts`. Modify `registry/{access,live-send,registry}.ts`.
- Modify `packages/mls-rpc/src/{mls,crypto,control-adoption,registry-group-mls,registry-handle-access}.ts`.
- Modify rpc `src/peer.ts` for bound local walker preparation and post-proof observations.
- Extend `packages/mls-rpc/test/{group-batch-integration,registry-live-send,registry-live-receive}.test.ts` and fixtures `{registry,storage-persistence}.ts`.
- Extend `packages/mls-rpc/test/{registry-delivery-safety,delivered-entry-copy,control-validation}.test.ts` with explicitly registry-bound scenarios.

**Interfaces:**

Consumes the exact intake, budget and original-MLS contracts. Produces the registry bridge without altering published ports.

```ts
type BatchBudget = { maxFrames: number; maxWorkMs: number; now(): number; begin(): void; take(): boolean }
type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'
type GroupBatchScheduler = {
  schedule<T>(work: { source: string; kind: BatchKind; signal?: AbortSignal; run(budget: BatchBudget): Promise<T> }): Promise<T>
  close(reason: Error): void
}
type ReadyControlScope = {
  source: AdoptionExpected
  control(): ControlSnapshot
  anchor(): AnchorSlot | null
  readEpoch: GroupMLS['readEpoch']
  readCommitHeader: GroupMLS['readCommitHeader']
  rosterEntries: GroupMLS['rosterEntries']
  isLedgerComplete: GroupMLS['isLedgerComplete']
  openEntries: GroupCrypto['openEntries']
  exportSecret: GroupCrypto['exportSecret']
  validation: ControlValidationPort
  prepareCommit: GroupMLS['processCommit']
  prepareOwn: ControlAdoptionPort['adopt']
  stageControl(changes: ControlChanges, mutationID: string): void
  stageAnchor(slot: AnchorSlot): void
}
type ControlBatchBinding = {
  key: GroupKey
  run<T>(input: {
    source: string
    signal?: AbortSignal
    prepare(scope: ReadyControlScope): Promise<T>
  }): Promise<{ value: T; epoch: number; control: ControlSnapshot; anchor: AnchorSlot | null }>
}
function bindControlBatch(mls: GroupMLS, binding: ControlBatchBinding): void
function controlBatch(mls: GroupMLS): ControlBatchBinding | undefined
type BufferedControlPage = {
  topicID: string; after: string | null; generation: number
  result: CoveredFetchResult
}
type BufferedControlIntake = {
  offer(page: BufferedControlPage): void
  next(): { page: BufferedControlPage; index: number } | undefined
  consumed(input: { generation: number; topicID: string; position: string }): void
  reset(generation: number): void
}
function createBufferedControlIntake(params: { key: GroupKey; ready(): void }): BufferedControlIntake
type RegistryControlBatchEntry = {
  key: GroupKey
  run<T>(input: {
    source: string; signal?: AbortSignal
    prepare(scope: { access: ControlHandleAccess; control: ControlStore; anchor: AnchorStore }): Promise<T>
  }): Promise<{ value: T; epoch: number; control: ControlSnapshot; anchor: AnchorSlot | null }>
}
function bindRegistryControlBatch(access: RegistryHandleAccess | ControlHandleAccess, entry: RegistryControlBatchEntry): void
function registryControlBatch(access: RegistryHandleAccess | ControlHandleAccess): RegistryControlBatchEntry | undefined
function groupBatchFor(binding: object, groupID: string): GroupBatchScheduler
function scheduleRegistryAccounting<TTx extends GroupTransaction>(params: {
  capability: EntryCapability<TTx>; binding: object; key: GroupKey
  source: 'live' | 'handoff' | 'trust'; signal?: AbortSignal
  current(): boolean
  read(reads: EntryReads): Promise<void>
}): Promise<void>
run<P, T>(
  request: { groupID: string; mutationID: string | null },
  prepare: (reads: EntryReads) => Promise<Prepared<P>>,
  work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
  effects?: (stores: GroupStores<TTx>, prepared: P, result: T) => Promise<void>,
): Promise<T>
```

- The registry bridge assertsRoot synchronously, schedules kind 'control', and performs one live.run prepare/work transition.
- createLiveSend accepts `binding: object` from createRegistryAccess's existing params. Its observed(version, stillCurrent) signature remains unchanged.
- scheduleRegistryAccounting assertsRoot when started outside ownership and schedules kind 'accounting' on groupBatchFor(binding, key.groupID).
- Its stable source ID is `JSON.stringify(['registry-accounting', key.incarnation, source])`; each selected callback submits at most one capability.read.
- Check current/signal before admission and again inside the read. Stale/cancelled requests perform no classification or handoff.
- Route live-send.observed's read, registry's ownerless handoff read and diagnoseObservation's trust read through this helper.
- onProof only prepares observation/start closures. afterRelease, the 0 ms fallback and live.run's finally start the same idempotent scheduled check.
- Expected own versions still receive proof-gated classification. Never skip rechecks merely because owner.expected contains the version.
- Preserve own-proof settlement, foreign classification, version/generation fences, admission, lease ceilings and cancellation/drain tracking.
- live.run settles its own proof without awaiting queued accounting. No scheduled callback waits for accounting queued behind itself.
- When accounting is a prerequisite, await it outside owner/scheduler callbacks, then advertise a fresh source turn.
- The MLS binding forwards once to that bridge. No second scheduler submission or nested owner entry occurs.
- Forward bridge identity through createRegistryHandleAccess and registry-group-mls's lazy access before constructing a readable-source peer.
  Capture readable-source access during factory setup, never on first buffered intake. Preserve the lost-state recovery-only path without manufacturing a handle.
- Attempt-bound access/control/anchor views reuse EntryReads and an isolated handle. Writes only stage prepared changes.
- scope.source/control/anchor reflect that attempt and staged snapshots. All scope capabilities expire when prepare ends.
- One occurrence consumes one budget operation. Local preparation runs under its selected owner, outside the provider transaction.
- readEpoch/readCommitHeader/roster/ledger/exporter/openEntries use the isolated source, never root methods.
- prepareCommit includes processCommit eligibility and signature validation. Named-entry resolution uses scope.openEntries.
- prepareOwn preserves journal/occurrence/compatibility/saved-candidate checks and stages ordinary adoption without root adopt/replace.
- Local advanceHandle roster/anchor work stages pending/landed/captured/kept AnchorSlot changes, including departing anchors.
- Work revalidates source key/identity/version/lifetime/safety. State/control/anchor/checkpoint changes commit atomically.
- Missing ledger/bootstrap/recovery prerequisites return without staging adoption. Fetch/confirmation continues only after owner/scheduler release.
- Crypto/provenance/receive handoff/controller retention/finalise/account/proof keep their existing validation.
- Only proven results update peer epoch/control/anchor, runtime, events or rebuild scheduling. Exceptions discard all prepared results.
- Hub faults grant no hold/halt, retry ban, deletion, rebuild or permanent stranding. Failed copies preserve independent saved work.

- [ ] **Step 1: Write actual registry-bound control witnesses.**

Every row runs in real-MLS/double modes. Control-route rows obtain access from the actual registry in both modes.
Build MLS through the registry adapter in both modes, using a restored double handle beneath that adapter.
Accounting-only rows exercise their named registry callbacks, including an absent owner.
For actionable, unheld control sources, assert controlBatch(originalMLS) exists and at least one registry bridge run.
Pre-existing safety holds and unmet recovery gates are separate preservation subcases: assert no admission and unchanged saved work.
Existing sealed-control and memory-proxy routes alone cannot satisfy these assertions.

| Test name | Assertions |
| --- | --- |
| `one peer advertises buffered B before replenishing A` | One actual peer/hub ingress buffers A/B. Hold A prepare; fetch valid commit while A owns. Before release: control ready=1, B ready, prerequisite root-read admissions=0. After release: exactly `[A,control,B]`, no intervening Read/anchor-save entry; control epoch E+1/cursor occurrence proven. No manual control/B submission. |
| `own accounting cannot bypass buffered control and B` | Use the preceding actual-peer setup with a committed A-open that registers its own expected version. Assert observation/start coverage, not a mocked live.run. Spy forwards real capability.read and owner-entry admissions. B/control are ready before A releases; the first three actual entries are exactly `[A,control,B]`, Reads included. After service, live.accounting settles and classified version/control match the latest proven state; ready accounting runs before replenished A. |
| `accounting fallback retains arbitration and cancellation` | Repeat with afterRelease withheld in both ownership-context modes. Hold A's post-proof scheduler return; fire the 0 ms fallback: no accounting Read admitted. Release A and drain runnable work with the accounting read backend held: B committed, entry prefix `[A,control,B]`. finally/late afterRelease start no duplicate check. Cancellation settles inflight accounting, prevents stale classification and lets dispose/drain finish. Foreign observations still invalidate incompatible headroom. |
| `ownerless and trust observation reads wait for selection` | Hold a scheduler turn without holding an owner. Trigger actual registry seed/account observation without a live owner, and a persisted unreadable-trust observation separately. Each offers its handoff/trust source; capability.read admissions stay 0 before selection. After release, one selected read revalidates the key/generation. Foreign ownerless state clears incompatible pending handoff. Only typed trust diagnosis may install its existing hold. |
| `selected control performs all local prerequisites in its entry` | Root readEpoch/readCommitHeader/readControl/control.load/isLedgerComplete/roster/anchor/openEntries counts 0. One owner; isolated crypto precedes tx. Named-entry resolution succeeds; state/control/anchor co-commit. No nested schedule/reentry/pre-proof output. Scope access expires. |
| `ready control revalidates source and preserves authentication` | A changes version without epoch: control adopts current source. Epoch/authenticator/retirement or injected version conflict reclassifies/refuses with no stale/cross-key write. Bad content signature grants no adoption/deletion/retry ban. Failed copies preserve saved bytes/ID/candidate/deadline and explicit false unless already prohibited. Valid own consumption/self-removal preserves saved candidate/drain-before-clear. |
| `control prerequisites never hold a selected turn across network work` | Unavailable ledger/bootstrap/recovery: local outcome releases owner/scheduler. While external work stays unresolved, B proves; no staged adoption/destructive transition or repeated control before B. Wakeup alone advertises no occurrence. |
| `withheld topic fetch cannot block already-ready peer sources` | Hold A fetch. Actual peer buffered B/control prove before A resolves or timeout fires; repeat with damaged A bytes. No hold/deletion/rebuild/lifecycle change. Task 9 extends service to enqueue. |
| `registry bound delivery faults preserve saved work and future progress` | Cross unsupported handshake/commit/sealed outer/sealed inner versions, bad commit-content signature, tampered named-entry copy, signed past divergence, retention gap and ahead claim. Cross valid live-build and pending-rejoin fixtures, each with intent/outcome and independent owed Welcome rows. Snapshot bytes/ID/candidate/deadline/retryForbidden, safety/hold/strand, owed rows and incarnation. For actionable cases, assert selected bridge route entered; no new hold/halt/strand, deletion, rebuild, replacement, retry ban or lifecycle switch. Saved bytes/ID/candidate/deadline remain exact. Coverage-only skips persist explicit retryForbidden:false unless already prohibited; legacy defaults remain. Pre-existing authenticated holds remain unchanged and prevent admission; do not clear them to force route coverage. Reopen and assert preserved rows again. For actionable fixtures, a later valid applicable occurrence advances epoch/cursor; independent owed Welcome remains deliverable. No manual recovery authority is granted by the bad page. |
| `registry bound failed own copies cannot strand saved retry or Welcome` | Deliver own-copy version/tamper/unrecognised variants through that same bound route. Expected r28i skip/cursor bookkeeping may change; live payload, candidate, opID and deadline do not. Coverage-only skips preserve explicit false unless already prohibited. No implicit acceptance/absence. A lawful local saved retry and independent Welcome obligation remain available after reconstruction. Recognised valid own consumption installs saved candidate exactly once without rebuilding and preserves independent Welcome work. |

For the fault matrix, carry existing scenario inputs from control-validation, delivered-entry-copy and registry-delivery-safety tests.
Assert preservation at the explicit post-attempt checkpoint, before supplying valid bytes or resolving external prerequisites.
Gap/ahead observations may emit diagnostics and incomplete coverage. They cannot acquire durable safety/lifecycle authority.

- [ ] **Step 2: Run RED.**

Run the named group-batch-integration and registry-bound delivery-fault rows in the listed files.
Baseline fails at absent binding/bridge or prerequisite root admission. Unbound existing regressions are insufficient.

- [ ] **Step 3: Implement selected local preparation and atomic adoption.**

Install registry bridge on access and control binding on the original MLS before peer construction.
Refactor local crypto/eligibility helpers to accept attempt-bound access. Stage foreign/own adoption and local anchors in one prepare.
Revalidate the prepared write set under storage. Apply peer observations only after proof.
Replace all three observation-triggered root-read submissions with scheduleRegistryAccounting, including timer/finally starts.
Keep observation checks in their existing inflight/drain sets until completion or cancellation.
Preserve the accounting wait outside selected work. Never disable observers to obtain the ordering witness.
Never call root crypto.openEntries, advanceHandle, the whole walker, bootstrap or confirmation from that scope.
Preserve recognised-own/self-removal rules, saved-candidate installation and drain-before-clear.

- [ ] **Step 4: Verify and mutate.**

Run focused control/retirement and live-send/live-receive regressions, including skipped-afterRelease and foreign handoff cases.
Restore only live-send.observed's direct capability.read: the actual-entry `[A,control,B]` assertion must fail.
Bypass accounting arbitration only in fallback/finally starts: the fallback no-admission/order assertion must fail.
Restore direct ownerless/trust reads separately: their before-selection admission assertions must fail.
Await live.accounting inside its active scheduler callback: the pre-release B progress checkpoint must fail without a timeout.
Drop accounting cancellation or version fences: its drain/stale-classification assertion must fail.
Bypass arbitration or reintroduce a prerequisite root read: actual-peer readiness/order `[A, control, B]` must fail.
Call root openEntries/advanceHandle: zero-root or reentry assertions must fail. Drop source/signature checks: unchanged-state assertions must fail.
Await bootstrap/confirmation inside run: B's committed checkpoint must fail before external release.
Only in the new bound-route unsupported-version catch, stage controlHold with reason 'unsupported-version'.
The named fault-matrix assertion `expect(after.controlHold).toEqual(before.controlHold)` must fail in both fixture modes.
Separately delete saved commitOnce/Welcome or set retryForbidden from a gap/ahead claim: exact saved-work assertions must fail.
Remove only the bound registration in the double fixture: the route-entry assertion must fail, even if unbound regressions stay green.

- [ ] **Step 5: Commit.**

Commit with `feat(mls-rpc): prepare buffered control under selected ownership`.

### Task 9: Collect settlements and enqueue work through shared fair admission

**Dependency:** Tasks 2/5/6/7/8. Bounded completion and owned control paths already work independently.

**Files:**

- Modify mls-rpc `src/{memory-group-persistence,memory-group-ports,app-settlement,entry-capability}.ts`, `registry/app-publication.ts`.
- Extend `packages/mls-rpc/test/{group-batch-integration,app-publication-conformance,handler-completion}.test.ts`.

**Interfaces:**

Consumes the exact scheduler/completion contracts and coordinator effects seam. Produces the certified processed-prefix entry and primitive.

```ts
type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>): Promise<void>
}
type BatchBudget = { maxFrames: number; maxWorkMs: number; now(): number; begin(): void; take(): boolean }
type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue' | 'accounting'
type GroupBatchScheduler = {
  schedule<T>(work: { source: string; kind: BatchKind; signal?: AbortSignal; run(budget: BatchBudget): Promise<T> }): Promise<T>
  close(reason: Error): void
}
function groupBatchFor(binding: object, groupID: string): GroupBatchScheduler
run<P, T>(
  request: { groupID: string; mutationID: string | null },
  prepare: (reads: EntryReads) => Promise<Prepared<P>>,
  work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
  effects?: (stores: GroupStores<TTx>, prepared: P, result: T) => Promise<void>,
): Promise<T>
type CertifiedFinalisationResult = { seq: number; status: 'published' | 'already-complete' }
type FinaliseBatchResult = { consumed: number; results: Array<CertifiedFinalisationResult> }
// EntryCapability member, implemented in memory-group-persistence.ts:
finaliseCertifiedAppBatch(key: GroupKey, seqs: Array<number>, budget: BatchBudget): Promise<FinaliseBatchResult>
// app-settlement.ts transaction-bound primitive:
function finaliseCertifiedAppInTransaction<TTx extends GroupTransaction>(params: {
  stores: GroupStores<TTx>; key: GroupKey; seq: number; mutationID: string
}): Promise<CertifiedFinalisationResult>
function finaliseAppSettlements<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>; key: GroupKey
}): Promise<void>
```

- Group ports retain `put: AppOutbox['put']`, `recordSettlement: AppOutbox['recordSettlement']`, and `remove: AppOutbox['remove']`.
- Root complete/transact/pending.complete/coverage.advance, outbox roots and finalisers assertRoot before reads, collection, scheduling or yielding.
- Existing scheduled registry control/publication roots retain the same synchronous admission rule. Transaction-bound helpers remain direct.
- Await registry publication's live.accounting prerequisite outside scheduled callbacks. Only the ensuing prepared work enters a selected turn.
- Default completions collect homogeneously. Distinct transact calls remain separate transactions, including independent protocols A/B.
- Settlement batches freeze a bounded prefix. consumed/results match that prefix in input order. The producer owns the untouched suffix.
- Each seq validates saved obligation/attempt/original topic, writes its stable event, then removes entry/obligation.
- Both absent means already-complete with no event. Duplicates publish once and preserve input order.
- Missing counterpart/conflict throws GroupStateConflictError and rolls back the staged prefix, returning no partial results.
- All-no-op batches preserve markers/hooks. Proven mixed batches publish only valid outcomes.
- Singleton finaliseCertifiedApp becomes a collector client. Cold finaliseAppSettlements offers ready seqs together instead of awaiting singletons.
- Certified finalisation's known backend rollback retries the frozen prefix under its retained owner with fresh tx/store bindings.
  Backoff starts at 100 ms, doubles to 15 s. Never add suffix inputs during retained retry.
- During this backoff, all later same-group work queues, including control, other lanes, accounting, enqueue and lifecycle transitions.
- Ordinary open, completion/transact and enqueue failures release after known rollback/hooks. Their caller retries outside ownership through a fresh turn.
- Default handler failure owns no slot. Retained D6 certification/finalisation retry and unresolved proof are explicit serviceability exceptions.
- A validation conflict releases without backend retry. Independent groups remain serviceable during every retained same-group wait.
- Unknown outcomes retain owner and hook queues until proof. Invalid obligations do not enter backend-rollback retry.
- D6 certification stays separate from finalisation, preserving recorded:false mismatch results and retained rollback admission.

- [ ] **Step 1: Write assembled settlement and service witnesses.**

Run storage rows in real-MLS/double modes, with/without ownershipContext where relevant.
Re-run Task 2's oversized-call matrix using the actual peer/registry host options; retain its exact assertions.

| Test name | Assertions |
| --- | --- |
| `enqueue progresses before burst exhaustion` | Actual peer with replenished A: dispatch log enqueue proves before second further A batch, backlog still nonempty. Completion also gets service. |
| `compatible completions and settlements share bounded transactions` | Queue homogeneous same-key work behind active batch. At least two operations co-commit, respecting count/work. Helpers add 0 nested schedules. Rollback preserves all rows/effects/events. |
| `certified finalisation batch preserves per-item outcomes and retry ownership` | Seqs `[1,2,1,3]`, 1/2 certified, 3 absent: statuses `[published,published,already-complete,already-complete]`, one event per valid seq. Before-COMMIT rollback retries frozen prefix/same owner before retirement. Reconstruct retains original topics/occurrences. Corrupt seq 2 obligation: all unchanged, no partial outcomes. |
| `certification mismatch remains a no-write result beside batching` | Production recordSettlement mismatches identity/version/attempt/missing-entry: `{recorded:false,reason}` respectively identity-changed/state-version-changed/attempt-changed/entry-missing. Rows/markers/hooks byte-identical. Valid rollback retries before lifecycle. |
| `certification rollback keeps its existing owner precedence` | 2.3c retained admission blocks same-group retirement until proof/retry settles. Scheduler cannot release it on rollback. |
| `ordinary failed batches release before caller retry` | Cross open/completion/transact/enqueue known rollback. Staged rows/effects unchanged; owner released after hooks. Queue B before caller retry: B proves before retry is advertised. Default handler rejecting before effects owns no slot. Ordinary work retains no backoff slot. Exclude unresolved proof and retained D6 certification/certified finalisation. |
| `certified finalisation backoff retains same-group ownership` | Force before-COMMIT rollback of frozen seqs 1/2. Queue same-group control/B/enqueue/retirement and other-group work. At 99 ms: later same-group admissions 0, other group committed. At 100 ms retry uses the same owner/mutationID, fresh tx/store bindings and only seqs 1/2. Force another rollback: no later admission through the next 199 ms; retry at +200 ms. Subsequent delays cap at 15,000 ms. No published events/results before proof. Successful retry releases, then queued work progresses. |
| `scheduled completion roots reject reentry before admission` | Inside production transactional handler call complete/transact/pending.complete/bound advance on valid targets: sync both context modes, after-await with context. ReentrantOwnershipError; collector/scheduler admissions 0 before outer release; target rows/cursor unchanged. Catch refusal, outer effect completes once. |
| `scheduled enqueue and settlement roots reject reentry before admission` | Same handler/context matrix for outbox.put/recordSettlement/remove(certified), finaliseAppSettlements/finaliseCertifiedApp and newly scheduled control/publication roots. ReentrantOwnershipError, admissions 0, targets/events/obligations unchanged before outer release. |
| `queued transactional A failures cannot roll back transactional B` | Assemble one actual peer/registry with two transactional log protocols. Hold active A-open, then queue separate A/B dispatches. A's callback always rejects. B's effect/removal proves once before A's next retry, while A remains pending through two retries. Tx callback logs never mix A/B. Default-handler isolation alone cannot satisfy this row. |

For reentry tests, inspect results and admission counts before outer release. Flush microtasks without awaiting an unresolved nested batch.
The absent-context after-await limitation remains S:1006-1007. Missing rejection fails an assertion, never a hanging test.

- [ ] **Step 2: Run RED.**

Run focused group-batch-integration and app-publication-conformance rows.
Expected per-item transaction counts or missing pre-admission diagnostics, without changing certification mismatch behaviour.

- [ ] **Step 3: Implement collectors using direct transaction-bound primitives.**

Move finalisation's body into the named primitive. Use its processed-prefix entry for compatible seqs, with retained proof/retry semantics.
Schedule enqueue and certification at outer root boundaries. Preserve original occurrence/version/attempt and post-proof event construction.
Audit every new schedule/collector ingress. Check root authority synchronously in the caller's context.
Never invoke a scheduled root from a collector callback. Do not pre-admit burst backlog into the D8 FIFO.

- [ ] **Step 4: Verify and mutate.**

Run affected publication/retirement regressions.
Bypass enqueue arbitration or restore singleton completion/settlement transactions: service/grouping assertions must fail.
Partially commit finalisation siblings, retry under a new owner or return success on mismatch: their named assertions must fail.
Release/requeue certified finalisation during known-rollback backoff: its zero-admission/same-owner assertions must fail.
Retain an ordinary failed completion/open/enqueue across caller backoff: its B-before-retry checkpoint must fail.
Release certification ownership on rollback: retained-precedence assertion must fail.
Fuse transactional A/B callbacks: the transactional B committed-effect assertion must fail, even if default-handler tests remain green.
Remove per-call prefix splitting or atomic refusal: Task 2's oversized-call matrix must fail under assembled host options.
For every scheduled root, bypass pre-admission guards while retaining D8's queue check: reentry assertions must fail before outer release.
Move a check after yielding: synchronous absent-context reentry must fail. Restore each mutation and require GREEN.

- [ ] **Step 5: Commit.**

Commit with `feat(mls-rpc): collect settlements through fair group admission`.

### Task 10: Integrate both handler policies into peer and cold lifecycle drains

**Dependency:** Tasks 2/3/4/6/7/8/9. Q1=A applies to absent cold coverage.

**Files:**

- Modify `packages/rpc/src/{peer,opened-delivery}.ts` and mls-rpc `src/{registry-peer,opened-delivery}.ts` for lifecycle-specific claims/fallbacks.
- Modify `packages/mls-rpc/src/registry/types.ts` and `registry/registry.ts` for a key-neutral dispatcher resolver alongside legacy raw callbacks.
- Test mls-rpc `test/{opened-delivery,registry-opened-lifecycle}.test.ts`, rpc `test/{peer-drained,opened-delivery}.test.ts`, integration `test/terminal-drain.test.ts`.

**Interfaces:**

```ts
type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>): Promise<void>
}
function createHandlerCompletion<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>; key: GroupKey
}): HandlerCompletion<TTx>
type OpenedAppHandler<TTx extends GroupTransaction> = {
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  deliver(record: PendingAppFrame): Promise<void>
}
function createOpenedAppHandler<
  P extends Record<string, GroupProtocolDefinition>, TTx extends GroupTransaction,
>(params: {
  localDID: string; protocols: P
  handlers: { [K in keyof P]: GroupProcedureHandlers<P[K], TTx> }
  suppress?: SuppressConfig
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx>
function normaliseOpenedAppHandler<TTx extends GroupTransaction>(params: {
  deliver: OpenedAppHandler<TTx> | ((record: PendingAppFrame) => Promise<void>)
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx>
```

- Consumes Task 4's completed live peer wiring and origin-key HandlerCompletion, alongside separately named recoveryCompletion.
- Live and cold opened sources call the same completion-owning dispatcher from Task 3.
- Registry deliverOpened retains its existing raw-callback type. A separate openedHandler resolver binds policy dispatch for each exact drain key.
- Source completion notifications update volatile state only; they never perform a second durable cursor write.
- Existing claim/handoff/source withdrawal and failure-signal contracts retain their lifetimes.

```ts
export type OpenedAppHandlerResolver<TTx extends GroupTransaction> = (params: {
  key: GroupKey
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
}) => OpenedAppHandler<TTx>
// Mutually exclusive registry configuration alternatives:
type RegistryOpenedHandlerOptions<TTx extends GroupTransaction> =
  | { openedHandler: OpenedAppHandlerResolver<TTx>; deliverOpened?: never }
  | { openedHandler?: never; deliverOpened?: (record: PendingAppFrame) => Promise<void> }
```

Intersect these options with GroupHandleRegistryParams. Require shared openedDeliveryContext whenever either alternative is configured.
Resolve once per exact-key drain, after obtaining its canonical createHandlerCompletion service. Coverage is optional under Q1=A.
Validate the dispatcher's completion identity/key and context against the resolver arguments before invoking it.
Cache only by coordinator binding plus `(groupID, incarnation)`. Never reuse a dispatcher by groupID alone.
An explicit resolver/raw callback overrides attached fallback. Otherwise use the still-admissible attached exact-key dispatcher.
Normalise raw callbacks using Task 3's required completion/context inputs. Reuse the same shared context for every drain.
Task 4 already passes resolved context, canonical completion and openedScope.owner into the live createOpenedAppHandler.
The attached fallback retains that dispatcher and context. Cold overrides receive the same context through the resolver or normaliser.

- [ ] **Step 1: Write lifecycle/policy matrix witnesses.**

Cross real-MLS/double, default/transactional policy and supplied/absent ownershipContext.

| Test name | Assertions |
| --- | --- |
| `default effect before completion crash preserves complete handler metadata` | Default effect succeeds/completion rolls back. Reconstruct: byte-identical key/sender/frame epoch/incarnation/procedure on replay. |
| `transactional handoff commits once before retirement clears` | Hold live callback/proof; request resync/delete/successor. No cold overlap/cursor loss/clear before proof. Reconstruct: one durable effect. |
| `terminal restart drains both policies without crypto or network` | Open batch, commit self-removal, reconstruct before handlers. Drain saved plaintext/completion then clear; decrypt/fetch/publish calls 0. Handler failure preserves pending indefinitely. |
| `disposed fallback refuses unadmitted records but keeps admitted completion` | Disposal admits no new live callback and releases no drain waiter before admitted completion proof. |
| `old completion cannot write the new incarnation cursor` | Complete saved old-key callback during lifecycle. Only original cursor receives proof; successor cursor/state/history unchanged. |
| `handler lifecycle reentry refuses instead of self-waiting` | After-await dispose/recover/delete rejects delivery diagnostic for same group. Unrelated caller/group unaffected. D8 scheduler reentry uses its separate diagnostics. |
| `attached fallback and registry override retain context after await` | Both policies × attached fallback/explicit resolver, plus raw default override: after-await lifecycle rejects OpenedDeliveryReentryError. No independent-caller context contamination. |
| `registry resolves cold dispatchers independently for two groups` | One registry/two keys: resolver gets each canonical completion/key and shared context. Each effect once, own pending gone. Wrong key/context rejects TypeError before invocation/completion. |
| `cold dispatcher after incarnation switch uses the requested key` | Drain old key, switch lawfully, persist new records, reconstruct and cold-drain. Separate resolver/completion identities; new pending gone, old effect once; neither cursor crosses keys. |

- [ ] **Step 2: Run RED.**

Run focused rpc/mls-rpc opened/lifecycle files and terminal-drain integration.
Expected missing transactional completion or metadata. Do not mask a deadlock with a larger timeout.

- [ ] **Step 3: Replace split completion with the common boundary.**

Resolve the exact-key dispatcher with canonical completion/shared context, preserving raw override precedence and admissible attached fallback.
Dispatch once per claim. Successful deliver includes completion; remove cold worker's appended complete and outer callback context scope.
Await completion proof/volatile notification before releasing the claim. Withdraw disposed live fallback synchronously.
Lifecycle waits outside ownership and drains saved plaintext before clearing, with visible blocked status and no timeout erasure.

- [ ] **Step 4: Verify and mutate.**

Run affected integration tests.
Allow cold/live overlap, detach coverage, release a waiter early or append a duplicate completion separately: respective witnesses must fail.
Restore a new-open call during terminal drain: the zero-crypto/network witness must fail.
Reuse a registry-wide dispatcher across keys or cache by groupID alone: two-group/post-switch cold-drain assertions must fail.
Drop context in fallback or override normalisation: its after-await reentry assertion must fail.

- [ ] **Step 5: Commit.**

Commit with `feat(mls-rpc): use handler policies throughout opened lifecycle drains`.

### Task 11: Publish shared conformance and assembled reconstruction evidence

**Dependency:** Tasks 1-10. Implement the settled Q1=A/Q2=A contracts.

**Files:**

- Create `packages/rpc-conformance/src/{handler-completion,handler-batching}.ts`; modify `{group-crypto,persistence-fixture,pending-group-crypto,index}.ts`.
- Create `packages/mls-rpc/test/handler-batching-conformance.test.ts`; extend existing real/double fixture constructors and rpc port wrappers.
- Extend memory integration witnesses for durable delivery, directed metadata and terminal drain.
- Update rpc/mls-rpc/broadcast READMEs, docs/reference/app-lane.md and existing release intent.

**Interfaces:**

Consumes independent conformance mirrors, never production imports. Their completion shape remains structurally identical:

```ts
type ConformanceHandlerCompletion<TTx extends ConformanceGroupTransaction> = {
  key: ConformanceGroupKey
  complete(ids: Array<string>): Promise<void>
  transact(ids: Array<string>, handle: (tx: TTx, records: Array<ConformanceStoragePendingAppFrame>) => Promise<void>): Promise<void>
}
type HandlerConformancePorts<TTx extends ConformanceGroupTransaction> = StorageTestPorts<TTx> & {
  completion(key: ConformanceGroupKey): ConformanceHandlerCompletion<TTx>
  crypto(key: ConformanceGroupKey): ConformanceGroupCrypto
}
type HandlerConformanceParams<TTx extends ConformanceGroupTransaction> =
  Omit<StorageConformanceParams<TTx>, 'createFixture'> & {
    createFixture(id: string, options?: FixtureOptions<TTx>): Promise<
      ConformancePersistenceFixture<HandlerConformancePorts<TTx>>
    >
  }
function testHandlerCompletionConformance<TTx extends ConformanceGroupTransaction>(params: HandlerConformanceParams<TTx>): void
function testHandlerBatchingConformance<TTx extends ConformanceGroupTransaction>(params: HandlerConformanceParams<TTx>): void
```

Add completion(key) to the area-specific persistence test aggregate. Retain existing side-row/fault/crypto fixture bindings.
Implementation-specific peer/scheduler/control-route assertions stay in their owning integration tests.
These shared ports provide no traversal ingress or ordered-prefix proof. Never fabricate live coverage in their fixture.
Task 2 owns the local completion/ordered-proof assertion. Task 6 owns its production-AppLane witness and coverage-retention mutation.
Task 11 records both as implementation evidence, separately from the portable shared completion mutation.
Q1=A preserves cursors without proof. Q2=A retains the mapped handler type and homogeneous helper/emitter guard.

- [ ] **Step 1: Add shared behavioural assertions and wire real/double adapters.**

Map every task-owned behavioural/mutation row into shared assertions where portable, and implementation assertions where entry bindings are internal.
Cover S:2801-2809, S:2840-2842 and the S:2819 reentry limits. Preserve S:2800 ordering scope.
Include the independent structural completion adapter, individual oversized calls, transactional A/B failure isolation and registry-bound control fault matrix.
Record both fixture modes and actual route-entry evidence. Raw manual transactions or unbound control regressions cannot close these rows.
Keep semantic chat dedup/read marks, provider faults and SIGKILL explicitly unclaimed.
Add shared `completion removes only saved IDs without prefix proof` in handler-completion.ts.
Arrange full saved A/B records at positions `10`/`2`, same key/topic, with cursor null through fixture.entry().run.
Retain unrelated fixture rows. Capture their exact pre-state. Install no coverage source and drive no lane.
Call ports.completion(key).complete(['B','B','missing']): only B disappears; A and unrelated rows remain exact, cursor stays null.
Complete A: its row disappears and cursor remains null under Q1=A. Reopen: neither row returns and cursor remains null.
Repeat both IDs/missing: no effect, hook, marker or durable-row change. Invoke the production completion adapter throughout.

- [ ] **Step 2: Run RED.**

Temporarily omit saved-row removal in the production handler-completion service, leaving the supplied port and fixture unchanged.
Run `ktest @kumiai/mls-rpc test/handler-batching-conformance.test.ts -t 'completion removes only saved IDs without prefix proof'`.
Expected behavioural RED: B remains pending after complete, in both fixture modes. No live prefix proof is required.
Restore removal. The same named assertion must pass before proceeding.
Separately record Task 6's production-AppLane coverage mutation: A's completion must reach cursor `2`, not stop at `10`.
Do not run that live assertion through HandlerConformancePorts or count a fixture-only coverage source as production evidence.

- [ ] **Step 3: Document host migration against the wired fixtures.**

Use exact group keys, actual supplied tx side rows and current controller-aware fixtures.
Document completion versus recoveryCompletion, options-based adaptBusHandlers, policy fan-out and required authenticated metadata.
Document GroupUnwrapResult's locked epoch versus frameEpoch, required openedDeliveryContext and optional ownershipContext's async limitation.
Describe Q1=A, poison lifetime, generation invalidation and the optional coverage binding for independent adapters.
Document complete's partial-prefix failure/retry semantics, atomic transact refusal and separate callback transactions.
Document the key-neutral registry openedHandler resolver and explicit shared delivery context through every dispatcher path.
Add release text to `.changeset/spec-p-storage-foundation.md`. Do not release or raise the band.

- [ ] **Step 4: Verify complete assembled evidence.**

Run kbuild, the new conformance wrapper, kports and repo-wide ktypes in a coordinated slot.
Treat these commands as the final gate. The checklist below records that evidence without rerunning the same commands.
Run affected full rpc/mls-rpc/broadcast unit suites and affected integration files with bounded workers.
Record every guard mutation from Tasks 1-10, including RED cause and restored GREEN.
Inspect the final diff for permissive double fallbacks, generated files, stale recovery field names and hidden format/dependency changes.

- [ ] **Step 5: Commit.**

Commit with `test(rpc): enforce handler completion and batching contracts`.

## Execution order and final handoff

Execute `1 → 5 → 2 → 3 → 4 → 6 → 7 → 8 → 9 → 10 → 11`.
Tasks 7/8/9 replace the former composite Task 7 and run sequentially.
Task 4 finishes shared peer wiring before Task 6 takes app-lane.ts. Tasks 7/8 take peer.ts only after Task 6.
Task 10 owns lifecycle integration. Task 11 records the single assembled build/contracts/full-suite/typecheck gate.

- [ ] Map all 28 inventory candidates to implementation evidence without promoting unexecuted witnesses to passing results.
- [ ] Record task-owned mutations with named RED causes and restored GREEN.
- [ ] Run `rtk proxy pnpm run lint` in implementation scope; inspect its changes before committing.
- [ ] Record skipped/unavailable backend evidence as incomplete, with 2.3e/2.4 and provider/SIGKILL handoffs.
- [ ] Preserve the version band. Do not merge, push, release or edit generated files during this sub-plan.

Draft verification: read-only source/spec/history and document consistency checks. No build, test, typecheck or implementation mutation ran.
The machine-wide heavy-run slot and all runtime evidence remain unverified until implementation.
