# Spec P 2.3d: handlers and fair adaptive batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authenticated handler metadata and atomic completion policies through a fair, bounded group batching scheduler.

**Architecture:** Rpc owns portable frame, policy and completion contracts. Mls-rpc implements exact-key completion through the existing D8 coordinator. A shared per-group scheduler arbitrates work before FIFO owner admission. Live and storage-only delivery share policy dispatch and completion without opening old crypto.

**Tech Stack:** TypeScript, pnpm 12.15.0, Vitest, ts-mls, sealed memory persistence, existing rpc/hub conformance runners.

**Spec:** [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md), binding r28i through History S:2922.

Baseline: `feat/spec-p-phase-2`, HEAD `162d6fd2`, 2026-10-29. Main 0.12.1 is already merged at `535ad3ef`.
Status: **revision 3 draft; Q1=A and Q2=A settled** in `.superpowers/sdd/plan-2-3d-draft/decisions-for-review.md`.
Inventory: `.superpowers/sdd/plan-2-3d-draft/inventory.md` -- 28 candidates: 10 DONE, 11 PARTIAL, 7 OPEN.
Nine implementation tasks. Review dispositions: `.superpowers/sdd/plan-2-3d-draft/{revise1-notes,revise2-notes,revise3-notes}.md`.

This revision permits writes only to this plan and the draft's `inventory.md` and `revise3-notes.md`.
Source/test/spec edits, git mutations and package test suites are unauthorised during drafting.
Commands and commit steps below apply only to a subsequent implementation session.

## Global Constraints

- Applied authenticated state supplies authority. Hub bytes, positions and claimed epochs supply no acceptance or lifecycle authority (S:10-18).
- Hub faults mean non-delivery. Never infer durable halt/hold, discard, rebuild, owed-work deletion or permanent stranding (S:14-18).
- Keep r28i saved-work preservation, retry bans, authenticated recovery authority and independent Welcome obligations unchanged (S:2922).
- Group writes and supplied host effects share one transaction. Crypto prepares under ownership outside storage (S:497-502).
- Publish plaintext, runtime changes, acknowledgements and events only after proven commit (S:501).
- Default durable handlers are at least once, outside both owner scope and transaction (S:531-535).
- Transactional opt-in co-commits effect, completion and eligible cursor. Callback invocation may repeat after rollback (S:537-540).
- Transactional handlers stay short, use supplied tx stores and perform no network I/O, root-store call, cross-group wait or timer (S:538-539).
- Invoke transactional handlers in D8 `effects`, after `finalise`. Domain writes refuse with `PersistencePhaseError` through every transaction view (S:913-970).
- A failed handler blocks its lane, not other lanes. Unknown/duplicate completion is harmless (S:534-535).
- Multiple listeners declare one completion policy. Mixed policies refuse registration (S:539,2840).
- Frame key is JSON `['kumiai/frame/v1', groupID, incarnation, topicID, position, protocol, procedure]` (S:540).
- Defaults remain `maxBatchFrames: 64`, `maxBatchDelayMs: 2`, `maxBatchWorkMs: 8` (S:506-510).
- Size/work bounds are finite/positive; delay is finite/non-negative. Idle lone work starts immediately (S:512-515).
- `openBatch` accepts at most 64 inputs and rejects larger arrays before reads (S:1460). Supplied atomic calls never split.
- At each batch boundary, release owner/transaction, service ready control, then round-robin ready sources (S:517-520).
- With only A/B/control ready, B and control finish within three batches including active A (S:519-520).
- Enqueue and completion receive service before repeated burst batches. Groups have independent schedulers and owners (S:517-521).
- D8 FIFO remains authoritative once work is admitted. Scheduler priority cannot reorder admitted owner entries or unresolved proof.
- Buffered control advertises before ownership-dependent prerequisites. Its selected entry performs local reads, authentication and adoption through entry-bound preparation.
- Metadata uses original authenticated frame epoch and origin incarnation, with no current-epoch fallback (S:883-885,2841).
- Ephemeral requests/responses/signals/streams/channels/decrypt batches initiate zero persistence transactions (S:525-529,2842).
- Only authenticated malformed plaintext persists poison. Other refusals/expiry persist no poison row (S:1393,1476-1483).
- Validated rowless dead prefixes complete through the canonical coverage binding, independently of saved-ID completion (S:1393,1463,1476).
- Pending/poison/cursor writes stay off the MLS state-version clock (S:1165,1981).
- Positions remain opaque, ordered by the existing code-unit comparator within a topic (S:488-493,1483).
- Drain persisted plaintext before terminal/lifecycle clearing. No new crypto/fetch/publication and no timeout erasure (S:543-547,878-881).
- Keep the required shared openedDeliveryContext and optional D8 ownershipContext contracts (S:997-1005; 2.3c carry-forward).
- Scheduled root facades call `capability.assertRoot()` before collecting, enqueueing or yielding. Entry-bound helpers remain direct (S:997-1008).
- Seal every persisted namespace with existing AAD. Retain D8 proof ownership, hooks and fail-stop rules (S:836-861).
- Preserve leases `16`, renewal below `4`, ceiling `500`, codec v2, candidate v3 and controller/management knowledge.
- Doubles may be stricter than ports, never more permissive. Port changes gate both contract families on real implementations and doubles.
- Memory reconstruction supplies phase-2 crash evidence. Real provider faults and SIGKILL remain phases 3 and 6 (S:2724-2725,2850).
- Use pnpm through `rtk proxy`. Heavy gates require the existing machine-wide slot protocol. Never run concurrent heavy lanes without its permission.
- Do not edit generated `lib/`, dependency versions, package scripts or build/lint configuration.
- Internal dependencies remain `workspace:^`. Cross-repo dependencies remain catalog published `^` ranges. Add no dependency here.
- Keep the existing shared version band and release intent. Do not merge or push before phase 2 completes.

## Review Focus

Each failure mode has an explicit owning-task witness.

1. **A held occurrence precedes a completed record.** Cursor must not cross it, including after cold handoff. Task 2: `completion cannot cross a held prefix`.
2. **COMMIT rejects after a transactional effect was staged.** Pending/cursor/effect remain hidden until proof, then settle together. Task 2: `unknown completion exposes no effect before proof`.
3. **A frame opens from a retained epoch after an anchor or runtime advance.** Handler metadata must retain that frame's authenticated epoch. Task 4: `retained frame metadata survives runtime advance`.
4. **Burst A holds ownership when buffered control and B arrive.** Task 7 advertises control before root reads and proves `[A, control, B]`.
5. **A transactional handler starts during live-to-cold retirement handoff.** Exactly one delivery owner awaits completion proof before clearing. Task 8: `transactional handoff commits once before retirement clears`.

---

## Scope and evidence

| Requirement | Tasks | Current spec |
| --- | --- | --- |
| Full rpc frame/ref/result migration, portable batch consumption | 1,6 | S:1351-1405,1361,1974-1975 |
| Atomic completion/cursor, poison removal and exact-key service | 2,6,8 | S:531-540,1393,1950-1956,2752,2805 |
| Public policy union, legacy functions, mixed-policy refusal | 1,3 | S:1412-1433,1924-1964,2840 |
| Authenticated metadata on durable/live/anycast/all directed kinds | 3,4,8 | S:883-885,1406-1433,2841 |
| Adaptive 64/2/8, idle latency, work bounds | 5,6,7 | S:504-515,2802-2803 |
| Control priority, topic readiness, round-robin, enqueue/completion, independent groups | 5,6,7 | S:517-521,2803-2804 |
| Original completion and batch bindings reach the wrapped peer's lane | 4,6 | S:531-540,901-902 |
| Terminal and cold-drain integration of both policies | 8 | S:543-547,2743,2808 |
| Conformance, opaque side rows, ambiguity and mutation evidence | Every task, assembled in 9 | S:2739-2743,2801-2809,2840-2842 |

The old scope's complete registry crypto, leases and terminal-drain implementation are already present.
This plan connects them to rpc's richer handler boundary. It does not replace them.
Historical 2.3c row references shifted after r28i: use the current coordinates above.

### Settled decisions

- **Q1=A -- cold completion coverage:** advance only with surviving ordered-prefix proof.
  Without proof, remove completed rows and preserve the cursor. Add no persisted frontier or namespace.
- **Q2=A -- multiple listeners:** use `combineDurableHandlers`, unchanged mapped handler types, and a retained-emitter registration guard.
  Hosts wrap homogeneous listener lists explicitly. Mixed policies refuse before registration.

Builder decisions within r28i:

- Move shared transaction/frame/result types to rpc. Mls-rpc imports/re-exports aliases. Conformance mirrors independently.
- Reserve `completion` for HandlerCompletion as specified. Rename the existing recovery callback field to `recoveryCompletion` everywhere.
- Keep GroupUnwrapResult.epoch as the locked handle epoch. Add required `frameEpoch` for the authenticated opened frame's epoch.
- Resolve incarnation from the exact completion/access GroupKey. Never infer incarnation 1 or use a current registry pointer during old delivery.
- Preserve explicit atomic `openBatch` calls. A separate internal streaming seam applies the budget inside owned preparation.
- Arbitrate above D8 admission. Do not add priority to owner-queue acquisition or retain ownership across distinct streaming batches.
- Use fake clocks, deferred stages and structural transaction/batch logs. No wall-clock performance thresholds or load benchmark.
- Keep controller-log persisted format and management policies unchanged. Retain knowledge when staged MLS state is saved.

### Out of scope and handoff owners

2.3e owns restore declarations/participants, package burn/cleanup and restore failure rows/seams.
2.4 owns the buffered hub lift and HTTP smoke, and tracks later provider/SIGKILL evidence.
Host MessageStore semantic dedup and local read-mark/receipt integration remain phases 4/5.
Upstream fetch cancellation, transport decode bounds and past-retention product policy retain their existing owners.
No task revisits commit-once, source retirement authority, revoke holds or the main merge.

## File Structure

Paths below describe future implementation, not current write permission.

| Responsibility | Files |
| --- | --- |
| Portable contracts | `packages/rpc/src/crypto.ts`, new `handler-completion.ts`, `app-batch.ts` and `control-batch.ts`, `handlers.ts`, `peer-types.ts`, `index.ts` |
| Type aliases and registry integration | `packages/mls-rpc/src/persistence-types.ts`, `registry/types.ts`, `registry-crypto.ts`, `crypto.ts`, `index.ts` |
| Completion implementation | New `packages/mls-rpc/src/handler-completion.ts`, existing `entry-capability.ts`, `memory-group-persistence.ts`, `opened-delivery.ts` |
| Coverage binding and live ordering | New `packages/rpc/src/app-completion-coverage.ts`, existing `app-lane.ts`, `opened-delivery.ts` |
| Metadata transport | `packages/broadcast/src/{transport,responder}.ts`, `packages/rpc/src/{peer,peer-epoch,directed,open-once}.ts` |
| Scheduler | New `packages/mls-rpc/src/group-batch.ts`, new `group-batch-binding.ts`, `registry/types.ts`, `registry/registry.ts` |
| Streaming open staging | `packages/mls-rpc/src/registry/app-open.ts`, new `registry/app-open-binding.ts`, `registry/access.ts`, `registry-crypto.ts`, `packages/rpc/src/app-lane.ts` |
| Other scheduled sources | `packages/mls-rpc/src/{memory-group-persistence,memory-group-ports,app-settlement,entry-capability}.ts`, `registry/{access,app-publication}.ts` |
| Buffered control producer and preparation | `packages/rpc/src/peer.ts`, `control-batch.ts`, `packages/mls-rpc/src/{mls,crypto,control-adoption}.ts`, new `registry/control-batch.ts`, existing `registry/access.ts` |
| Peer host/lifecycle integration | `packages/rpc/src/{peer,peer-types,host-boundary,opened-delivery}.ts`, `packages/mls-rpc/src/{registry-peer,opened-delivery}.ts` |
| Completion-only persistence guard | `packages/mls-rpc/src/memory-incarnation-stores.ts` only if exact retired-key cursor completion requires a narrow capability |
| Shared contracts | New `packages/rpc-conformance/src/handler-completion.ts`, new `handler-batching.ts`, existing `{group-crypto,persistence-fixture,pending-group-crypto,registry-crypto,index}.ts` |
| Real/double adapters | `packages/mls-rpc/test/fixtures/{storage-persistence,registry-crypto,registry}.ts`, new `handler-completion.ts`; rpc `test/fixtures/{peer,fake-crypto}.ts` and actual callers from typecheck |
| Focused tests | New rpc `test/{handler-types,handler-metadata}.test.ts`, existing `test/{handlers,opened-delivery,durable-drain}.test.ts`; new mls-rpc `test/{handler-completion,group-batch,group-batch-integration,handler-batching-conformance}.test.ts` |
| Existing regression witnesses | `packages/mls-rpc/test/{registry-open-batch,registry-crypto-conformance,opened-delivery,registry-opened-lifecycle}.test.ts`, rpc directed/peer drain tests, `tests/integration/test/{app-lane-delivery,directed-lane,terminal-drain}.test.ts` |
| Documentation/release intent | `packages/{rpc,mls-rpc,broadcast}/README.md`, `docs/reference/app-lane.md`, `.changeset/spec-p-storage-foundation.md`, existing `.changeset/version-band-0-13.md` only if summary alignment is needed |

Mechanical type migrations may touch callers found by repository typechecking. Preserve their assertions and port strictness.

## Shared interface decisions

### Portable types (Task 1)

Copy the spec's PreOpenAppFrameRef, AppFrameRef, PendingAppFrame, GroupHandlerMetadata and DurableHandler shapes exactly.
Pre-open references include GroupKey and exclude procedure. Opened references add procedure.
Keep OpenAppResult's current `handleEpoch` on the opened arm because rpc catch-up decisions already require that locked answer.
Move OpenAppInput/OpenAppResult into rpc and re-export them from mls-rpc without a reverse dependency.

```ts
export type GroupTransaction = {
  providerID: string
  groupID: string | null
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}
export type HandlerCompletion<TTx extends GroupTransaction> = {
  key: GroupKey
  complete(ids: Array<string>): Promise<void>
  transact(
    ids: Array<string>,
    handle: (tx: TTx, records: Array<PendingAppFrame>) => Promise<void>,
  ): Promise<void>
}
```

GroupCrypto.unwrap opts.frame becomes PreOpenAppFrameRef.
Add optional `unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>` to the portable crypto port.
Registry crypto always supplies it. Other adapters may retain singleton unwrap, with one atomic open per scheduling turn.
There is no sequential single-open emulation promising multi-frame atomicity.
The singleton compatibility path reloads the saved full record after unwrap; it never fabricates procedure/epoch/key from current runtime state.
GroupUnwrapResult gains required `frameEpoch: number`; its existing `epoch` retains locked-handle semantics.

GroupProcedureHandlers gains `TTx extends GroupTransaction = GroupTransaction`, with the exact log-event policy conditional in S:1927-1940.
GroupPeerParams and createPeer thread the same transaction generic to handlers/completion.
GroupPeerParams.completion is required and origin-key-bound. The MLS recovery option becomes `recoveryCompletion?: RecoveryCompletion | null`.
Rename `RegistryPeerOptions.completion` and its producer/consumer arguments to `recoveryCompletion`.
Do not rename `ConfirmedRecoveryHandoff.completion`'s promise.

`adaptBusHandlers(protocol, handlers, { completion, suppress? }): BusHandlerMaps` replaces positional suppress.
Ephemeral paths may receive the port for key metadata but never call complete/transact.

### Exact-key completion (Task 2, Q1=A)

```ts
export function createHandlerCompletion<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): HandlerCompletion<TTx>
```

The factory requires registered entry capability and coordinator binding. It does not load or manufacture a crypto handle.
Return the canonical service for `(coordinator binding, groupID, incarnation)`, retaining its coverage binding across repeated factory calls.
Both callers use the module export `handlerCompletionForEntry<TTx extends GroupTransaction>(params: { capability: EntryCapability<TTx>; binding: object; key: GroupKey }): HandlerCompletion<TTx>`.
The public factory resolves capability/binding from persistence. RegistryPeer resolves them from registrySafety's existing entry/binding fields.
Both paths use the same canonical cache. Neither requires a root load or a reconstructed crypto handle.
Complete delegates to the same internal runner as transact, with no host callback.
Extend the internal `EntryCapability.run` contract with an entry-bound effects callback:

```ts
run<P, T>(
  request: { groupID: string; mutationID: string | null },
  prepare: (reads: EntryReads) => Promise<Prepared<P>>,
  work: (stores: GroupStores<TTx>, prepared: P) => Promise<T>,
  effects?: (stores: GroupStores<TTx>, prepared: P, result: T) => Promise<void>,
): Promise<T>
```

Capture the callable before `finalise`. `memory-group-persistence.ts` invokes it through `entry.callback` only after entering `effects`.
Run this entry-bound callback before the existing outbox/delete effects. Never expose the private coordinator writer to it.
Keep existing outbox/delete effects, drainage, account validation, proof and hooks in their existing order.
Completion `work` rechecks saved records and coverage. Its `effects` callback invokes the handler, then completes pending/poison and saves eligible cursors.
All three side writes use the same supplied transaction. Domain stores remain refused throughout that callback.
The runner snapshots unique IDs, loads saved pending/poison by exact key, and invokes callbacks only for still-pending records.
All missing IDs is a no-op, including when live dead-prefix coverage exists. Only the internal binding explicitly requests rowless advancement.
Poison never invokes a handler. Mixed IDs use existing records in stable occurrence order.
Provider/group mismatch refuses before the callback. No caller-provided plaintext replaces saved records.

The internal coverage contract lives in rpc's new `app-completion-coverage.ts`:

```ts
export type AppCompletionCoverage = {
  key: GroupKey
  topicID: string
  generation: number
  previous: string | null
  through: string | null
  prefix: Array<{ frame: PreOpenAppFrameRef; state: 'pending' | 'dead' | 'completed' }>
}
export type AppCompletionCoverageSource = {
  capture(ids: Array<string>): Array<AppCompletionCoverage>
  current(coverage: AppCompletionCoverage): boolean
  committed(ids: Array<string>, coverage: Array<AppCompletionCoverage>): void
}
export type AppCompletionCoverageBinding = {
  advance(): Promise<void>
  unbind(): void
}
export function registerAppCompletionCoverage<TTx extends GroupTransaction>(
  completion: HandlerCompletion<TTx>,
  bind: (source: AppCompletionCoverageSource) => AppCompletionCoverageBinding,
): void
export function bindAppCompletionCoverage<TTx extends GroupTransaction>(
  completion: HandlerCompletion<TTx>,
  source: AppCompletionCoverageSource,
): AppCompletionCoverageBinding
```

The factory calls registerAppCompletionCoverage once per canonical service. Rpc stores that source-binding callback by completion identity in a WeakMap.
`bindAppCompletionCoverage` requires that registration and forwards to it. The canonical service retains the source for complete/transact and advance.
Its returned `advance()` assertsRoot, then captures `source.capture([])` synchronously before its first await.
It enters the service's runner without a host callback or completion IDs. Wrappers cannot manufacture a replacement identity.
An empty capture is a no-op. `unbind()` withdraws the source and invalidates queued captures. Later advance calls refuse.
The binding accepts no caller-supplied coverage or positions. It does not extend the public HandlerCompletion port.
`capture([])` includes validated dead/completed prefixes even when no pending/poison rows exist. Pending or held members still block crossing.

The prefix contains the lane's validated ordered traversal from its durable cursor, not consecutive numeric positions.
`through` is the last eligible position after this completion, or `previous` when an earlier member blocks it.
Capture is synchronous and reads only a maintained immutable lane snapshot. It cannot acquire the app mutex while holding the owner.
Under ownership, compare key, topic, generation/cursor and saved pending/poison occurrence identities.
Use source.current before callbacks and final writes to detect lane reset without acquiring another mutex.
Capture retains the traversed suffix when an earlier pending member prevents advancement.
Every crossed member must be validated dead, already completed, or belong to this successful completion set.
Rowless dead classification requires the lane's validated traversal and settled refusal/expiry. Hub hints cannot supply it.
Held/sealed inputs terminate eligible advancement. They do not erase later completed coverage.
Stale proof refuses/re-prepares without calling the transactional handler on an invalid prefix.
For a proven prefix, pending/poison removal and cursor save occur in the same transaction as host effects.
The committed notification marks completed occurrences even when the cursor cannot advance yet.
Retain their occurrence identity until a later prefix closes, or an explicit generation reset invalidates the proof.
The notification updates only volatile state after proof. It performs no durable repair transaction.
With no surviving proof, preserve the durable cursor. Never select max(pending.position) as inferred coverage.
Dead-only live prefix advancement uses binding.advance through the same internal runner, even when no pending ID remains.
The runner rechecks key, generation, durable cursor and any saved occurrence identities under ownership before saving the eligible cursor.
That path removes covered poison in the cursor transaction. It creates no pending/poison rows and invokes no handler.
Rollback retains volatile coverage for retry. Only proven commit calls `source.committed([], coverage)` and retires the traversed prefix.

The coverage binding is an internal coordination channel, not a public hub-attestation or host security proof.
Copied/unbound completion wrappers must not silently lose it. Attach it to the stable original port before host wrapping.
Retired-key completion may service saved rows but cannot follow activeIncarnation or clear another incarnation's cursor.
If the provider's active-only cursor guard needs an exception, grant only this completion entry the exact-key operation.
Do not weaken public root cursor.save or all inactive-incarnation writes.

### Scheduler and compatible batch boundaries (types in Task 1, implementation in Tasks 5-7)

```ts
export type BatchBudget = {
  maxFrames: number
  maxWorkMs: number
  now(): number
  begin(): void
  take(): boolean
}
export type BatchKind = 'control' | 'open' | 'completion' | 'settlement' | 'enqueue'
export type GroupBatchScheduler = {
  schedule<T>(work: {
    source: string
    kind: BatchKind
    signal?: AbortSignal
    run(budget: BatchBudget): Promise<T>
  }): Promise<T>
  close(reason: Error): void
}
export type StreamingOpenResult = {
  consumed: number
  results: Array<OpenAppResult>
}
export type AppBatchBinding = {
  key: GroupKey
  scheduler: GroupBatchScheduler
  openReady(frames: Array<OpenAppInput>, budget: BatchBudget): Promise<StreamingOpenResult>
}
export function bindAppBatch(crypto: GroupCrypto, binding: AppBatchBinding): void
export function appBatch(crypto: GroupCrypto): AppBatchBinding | undefined
```

`app-batch.ts` supplies these rpc coordination types and a WeakMap binding, like the existing opened-delivery binding.
The registry adapter binds its crypto object before host wrapping. Task 4 captures this binding from the original crypto.
Task 4 supplies the canonical completion and captured batch binding explicitly to AppLane before Task 6 begins.
No new method is required on the published `RegistryHandleAccess` shape.

Task 6 adds internal `RegistryStreamingOpen = AppBatchBinding['openReady']` in `registry/app-open-binding.ts`.
`bindRegistryStreamingOpen(access: RegistryHandleAccess, binding: AppBatchBinding): void` registers key, scheduler and prepared-open implementation.
`registryStreamingOpen(access: RegistryHandleAccess): AppBatchBinding | undefined` retrieves that binding for registry crypto.
`registry/access.ts` binds `{ key: owner.key, scheduler: groupBatchFor(params.binding, owner.key.groupID), openReady }` from createRegistryAppOpen.
Registry crypto forwards that retrieved binding through bindAppBatch. Its existing access-only parameters need no unpublished coordinator token.

`openReady` considers an input prefix in order. Each attempted input, including a refusal or replay, consumes one operation.
For k consumed inputs, `results.length === consumed === k`. Results correspond exactly to `frames.slice(0, k)`.
The caller owns the unchanged suffix. It resubmits that suffix on its next source turn, after releasing ownership.
Empty input returns `{ consumed: 0, results: [] }`. Non-empty input consumes at least one operation unless the call rejects.
Rejection exposes no results and consumes no caller inputs. Unknown COMMIT retains ownership and publishes nothing until proof.
All staged state/pending/poison for that prefix co-commit. A refusal-only prefix uses the existing no-write path.
Receive conflicts return to the scheduler for a fresh turn. Streaming opens cannot hide additional committed batches inside one run.
Explicit `openBatch` retains its whole-array contract, hard limit, and existing retry semantics.

`createGroupBatchScheduler({ options?, now? }): GroupBatchScheduler` normalises GroupBatchOptions.
Use monotone performance time in production and an injected clock in tests.
`groupBatchFor(binding: object, groupID: string): GroupBatchScheduler` supplies one coordinator-shared arbiter.
Initialise its options from createGroupHandleRegistry's new batch parameter before application work starts.
Conflicting options on an already-live binding refuse instead of creating a second scheduler.
Registry disposal closes its runtime sources, not unrelated storage-only obligations on the shared binding.
Use each runtime source's abort signal to withdraw its queued work. Scheduler.close applies only to shutdown of the whole binding.

One run callback executes one bounded compatible transaction. The source owns its queued inputs and resolves individual caller promises after proof.
Domain collectors snapshot ready inputs before scheduling. Owned preparation decides how many opens fit the actual staging budget.
Every scheduled root facade calls `capability.assertRoot()` synchronously before collector insertion, scheduler.schedule or its first await.
This includes complete/transact, coverage advance, pending.complete, outbox enqueue/certification/removal, certified finalisation and scheduled registry control/publication roots.
Retain the owner-queue admission check as well. Checking only inside a scheduled run callback cannot diagnose scheduler self-wait.
Collector flushes call entry-bound primitives directly. They never invoke another scheduled root facade from their owned callback.
Default completions and compatible settlement operations collect homogeneously.
Transactional completions combine only when policy, origin and callback ordering are compatible. They never nest transactions.
Different domains may take separate transactions. Do not invent a universal transaction-command language.
Call `budget.begin()` once on entering owned staging, excluding scheduler and owner-queue waiting time.
For opens, begin in `prepare`, before isolated-handle preparation. Call `take()` inside the decrypt loop before each input.
For completion/settlement work, begin at owned operation staging. Do not charge work twice across prepare and effects.
`begin()` cannot reset an active budget. Each new scheduled batch receives a fresh budget.
`take()` counts operations and refuses another operation at count/work bounds, including equality at 8 ms.
The first operation starts even when setup has consumed the work budget, because admitted calls cannot be pre-empted.
Stop waiting for additional compatible inputs at the coalescing bound. End immediately when none are ready.
An in-progress operation may exceed 8 ms; it cannot be pre-empted. No timer or network wait occurs inside the storage callback.
The 2 ms bound limits deliberate coalescing, excluding active work. Idle work starts without installing a batching delay timer.
The public 64-input openBatch remains one atomic call. The separate streaming seam stops its preparation loop at host caps.
Values above 64 cannot produce a registry open batch above 64. Fractional frame limits are invalid; valid work budgets may be fractional.

The scheduler admits only one batch at a time to D8. Arrivals during active work remain outside its FIFO.
At release, choose ready control first, then ordinary sources round-robin, at most one capped batch per source per round.
Control is also limited to one turn per source per round. Replenished control cannot starve ordinary sources.
Repeated readiness in one source cannot acquire a second turn before other already-ready sources.
No ready batch waits for a source's network fetch or default handler. Control inputs must already be locally actionable.
Select control before owner admission. Its crypto preparation still runs under that selected entry's owner, outside storage.
Priority supplies no authentication authority. Actual adoption validates the commit before domain writes.
Existing certification retry retains its owner entry until proof, as 2.3c requires. Fairness assumes settling operations.
Atomic seed/switch/terminal transitions and external root calls keep D8 admission semantics; backlog cannot be pre-admitted ahead of them.

### Buffered control preparation (types in Task 1, implementation and peer wiring in Task 7)

Rpc's internal `control-batch.ts` binds the original GroupMLS to a ControlBatchBinding through a WeakMap.
These coordination types do not extend the published GroupMLS or RegistryHandleAccess ports.
The scope exposes local reads and provisional staging, distinct from durable root operations.

```ts
export type ReadyControlScope = {
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
export type ControlBatchBinding = {
  key: GroupKey
  run<T>(input: {
    source: string
    signal?: AbortSignal
    prepare(scope: ReadyControlScope): Promise<T>
  }): Promise<{ value: T; epoch: number; control: ControlSnapshot; anchor: AnchorSlot | null }>
}
export function bindControlBatch(mls: GroupMLS, binding: ControlBatchBinding): void
export function controlBatch(mls: GroupMLS): ControlBatchBinding | undefined
```

The registry implements run with synchronous assertRoot, then the shared scheduler's `kind: 'control'`, then one `live.run` entry.
The registry access binding supplies that entry and its isolated-handle preparation to the MLS adapter.
One control occurrence consumes one operation. A replenished commit source still gets only one turn per round.
Rpc buffers checked fetch results independently of runSerial's persistence work. Pushed metadata only wakes that fetch.
For each next buffered occurrence, advertise run synchronously before any root read, including pull/walker prologues.
Readiness means the occurrence and local inputs are available for an attempt. It implies neither authentication nor acceptance.
Startup replay, ledger bootstrap or confirmed recovery still pending are protocol prerequisites, outside the three-batch adoption bound.
They cannot hide an already-buffered actionable occurrence behind a fresh control.load, isLedgerComplete or readEpoch call.

The selected entry uses EntryReads for source/control/anchor/lifetime and restores its isolated handle under ownership.
The callback classifies against that handle, verifies commit-content signatures, and prepares the existing foreign or recognised-own adoption.
prepareCommit refactors processCommit's eligibility read and mutation into this same prepare scope.
Its named-entry resolver uses scope.openEntries on the isolated pre-adoption handle, never the root crypto.openEntries.
prepareOwn reuses journal, occurrence, compatibility and saved-candidate validation through entry-bound staging, never root adopt/replace.
Scope control/anchor reads observe staged changes. Stage methods change only the prepared write set, with one consistent mutation identity.
Read-only validation/candidate restoration stays local. No fetch, ledger bootstrap, confirmation, handler, timer or root store runs in the callback.
When a prerequisite is missing, return a prerequisite outcome without staging adoption. Request external work after run releases.
Refusal/skip changes follow existing r28i rules. Failed delivered copies preserve live bytes, retry eligibility and independent obligations.

Move advanceHandle's local roster/anchor preparation into this scope for buffered occurrences.
Stage the pending/landed anchor and final capture or keep decision using the existing AnchorSlot shape, preserving departing anchors.
The work callback revalidates source key, identity/version, lifetime and safety before atomically writing state/control/anchor/checkpoint changes.
Reuse existing inbound-commit provenance, receive-progress handoff, controller retention, finalise/account and proof handling.
Scope capabilities expire when prepare ends. Exceptions discard staged results. No staged result or peer mutation escapes before proof.
After run proves, apply returned control/anchor/epoch observations and schedule runtime rebuilds outside ownership.
Do not call the root advanceHandle or entire walker from the selected entry. Their root calls and external continuations remain unlawful there.
Unbound adapters keep their existing path. Registry MLS adapters must register this binding before peer construction.

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

Task 9 adds its new conformance wrapper to these gates once created.
Both contract packages run through consumers; they have no standalone test:unit shortcut.
SQL wrappers require configured engines actually executing, including PostgreSQL where required. Skipped/unavailable engines remain an explicit incomplete gate.
Build package exports before cross-package tests. Run repo-wide `rtk proxy pnpm exec turbo run test:types` for public type changes.
The forced helper records uncached evidence. Do not replace this gate with package-only typechecks.
Use one portable-contract gate after Task 1, then focused tests and relevant package typechecks during Tasks 2-8.
Refresh prerequisite builds only when exported code changes or a focused import needs them.
Run both contract families, full affected suites and the final forced repo-wide typecheck once at Task 9.
Repeat a broad gate only when a later change or unresolved failure invalidates its evidence.
Run full affected package suites at the assembled gate, following 2.3c's missed-regression lesson.
For each guard mutation, capture named-test RED, restore the guard and capture GREEN. A timeout alone is not the expected RED reason.

## Tasks

### Task 1: Unify portable frame, handler and completion contracts

**Files:**

- Modify rpc `src/{crypto,handlers,peer,peer-types,host-boundary,index}.ts`; create `src/handler-completion.ts`.
- Create rpc `src/app-batch.ts` for the portable scheduler types and stable crypto coordination binding.
- Create rpc `src/control-batch.ts` for the internal ready-control scope and original-MLS binding types above.
- Modify mls-rpc `src/{persistence-types,crypto,registry-crypto,registry-peer,index}.ts` aliases/call sites.
- Modify conformance `src/{group-crypto,pending-group-crypto,persistence-fixture,registry-crypto,index}.ts` independent mirrors.
- Test new `packages/rpc/test/handler-types.test.ts`; migrate existing real/double crypto and peer fixture callers named by typechecking.

**Interfaces:**

- Produces the portable contracts and generic mapping defined above, including frameEpoch and optional unwrapBatch.
- Produces recoveryCompletion rename throughout GroupPeerMLSParams/RegistryPeerOptions/createPeer adapters and no-MLS union branch.
- Produces BatchBudget, GroupBatchScheduler, StreamingOpenResult and AppBatchBinding for Tasks 5/6.
- Produces ReadyControlScope, ControlBatchBinding and bindControlBatch/controlBatch for Task 7.
- Requires `ConformanceUnwrapResult.frameEpoch: number` in the independent base crypto mirror, including every fake/adapter implementation.
- Classifies new port members in host-boundary.ts. Completion is a port; recoveryCompletion remains a callback.

- [ ] **Step 1: Write failing type and shape witnesses.**

Use expectTypeOf and necessary @ts-expect-error assertions for these cases:

| Witness | Assertions |
| --- | --- |
| `pre-open refs exclude procedure and opened refs require origin` | Missing GroupKey refuses. Pre-open object needs no procedure; opened record requires procedure/epoch/key. |
| `transactional policy is available only on retained events` | A log event infers tx. Legacy functions remain valid. Ephemeral event/request/stream/channel transactional declarations refuse. |
| `recovery and handler completion occupy distinct fields` | Both can coexist with distinct types. The no-MLS branch still accepts handler completion. |
| `registry durable unwrap preserves saved record metadata` | Replayed singleton/batch use saved sender/frame epoch/procedure/key; supplied wrong key is a storage failure. |
| `base crypto reports authenticated retained frame epoch despite false hints` | Seal distinct frames at E, advance once to E+1, then open them with hint offsets `[0, -1, 1]`. Assert `result.frameEpoch === E` and `result.epoch === E+1` for each. Same-epoch success also asserts `frameEpoch === epoch`. |

- [ ] **Step 2: Run RED.**

Run the focused type fixture through repo-wide ktypes.
Run the named base-epoch witness in rpc's ports-conformance and mls-rpc's ports/transactional/registry-crypto wrappers.
Expected failures are absent contracts or incompatible shapes, not runtime fixture import failures.

- [ ] **Step 3: Implement the portable contracts and migrate callers.**

Move/re-export shared types without circular imports. Preserve locked-handle epoch semantics separately from frameEpoch.
For successful non-registry decrypt, derive frameEpoch from the successfully authenticated sealed frame, never an unverified hint fallback.
Preserve full saved records on durable replay. Reject genuinely incomplete legacy records instead of fabricating metadata from current state.
Current registry persisted records already have the required fields; do not add a migration or rewrite sealed rows unnecessarily.
Update fixtures to supply actual origin/transaction providers. Never fabricate a lost-state crypto handle.

- [ ] **Step 4: Verify and mutate.**

Run the focused tests GREEN and one kbuild/ktypes portable-contract gate. Defer both-family execution to Task 9.
Remove the retained-event policy conditional: the ephemeral transactional type witness must fail.
Overwrite saved frameEpoch with runtime epoch: the replay metadata assertion must fail.
Omit frameEpoch, substitute the current handle epoch, or copy the false hint separately in the base crypto adapter.
Each mutation must fail the new base-conformance assertion, independently of durable replay tests.
Record any external host compatibility work in the handoff.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): define durable handler and completion contracts`.

### Task 2: Implement exact-key atomic completion and poison pruning

**Dependency:** Task 1. Q1=A is settled.

**Files:**

- Create `packages/mls-rpc/src/handler-completion.ts` and `packages/rpc/src/app-completion-coverage.ts`.
- Export the internal coverage coordination functions from `packages/rpc/src/index.ts` for mls-rpc consumers.
- Modify mls-rpc `src/{entry-capability,memory-group-persistence,opened-delivery,index}.ts`, `registry/app-open.ts`.
- Narrowly modify memory-incarnation-stores.ts if the exact-key cursor capability requires it.
- Test new `packages/mls-rpc/test/handler-completion.test.ts` and `test/fixtures/handler-completion.ts`, using existing storage-persistence.ts faults/side rows.

**Interfaces:**

- Consumes HandlerCompletion and registered EntryCapability; produces createHandlerCompletion, internal handlerCompletionForEntry and the coverage binding contract above.
- Produces one internal transaction-bound completion routine shared by complete, transact and AppCompletionCoverageBinding.advance.
- Produces the binding's callable advance/unbind lifecycle without changing the public HandlerCompletion shape.
- Extends EntryCapability.run with the effects callback specified above. The production coordinator owns its phase transition.
- Existing PendingAppFrames.complete(id) delegates through the same completion service for its originating key.

- [ ] **Step 1: Write production-boundary failure witnesses.**

Run every storage case in real-MLS/double modes and supplied/absent ownershipContext.

| Test name | Assertions |
| --- | --- |
| `transactional completion commits effect pending and cursor atomically` | Open two records. Complete a proven prefix with a supplied-tx side row. Fail after first write/before commit: all rows equal pre-state. Commit: effect exists, pending/covered poison absent, cursor equals proven prefix. |
| `transactional completion enters effects with domain writes refused` | Enter through completion.transact. Observe phase order `work, finalise, effects, account`. Capture the actual supplied stores in the fixture. Callback state/trust/lifetime writes through supplied, copied and independently constructed tx stores reject with `PersistencePhaseError`. Domain rows remain byte-identical. A lawful supplied-tx side row and completion commit together. |
| `completion cannot cross a held prefix` | Held/sealed A precedes opened B. Completing B never advances past A. Test opaque positions `10` and `2` by code-unit order and separate topics. No numeric successor assumption. |
| `later completion retains live coverage until the earlier prefix closes` | Persist A at `10` and B at `2` in one topic, cursor null. Complete B first: B absent, A pending, cursor null, B coverage retained. Complete A: A absent and cursor `2` in that same proven transaction. Reopen: cursor `2`, neither pending/effect repeats. A later held `20` stays uncrossed, using code-unit order `10 < 2 < 20`. |
| `unknown completion exposes no effect before proof` | Backend COMMIT remains unfinished, then commits or rolls back. Before proof no handler result/hook/cursor is visible. Resolve both outcomes; repeated proof does not duplicate effect/hook. Conflict fail-stops. |
| `unknown and duplicate IDs never invoke a completed handler` | Empty/missing/duplicate IDs are harmless. Mixed IDs invoke once with only saved still-pending records. Restart after committed completion does not invoke again. |
| `poison pruning and cursor roll back together` | Authenticated malformed plaintext produces poison. Cover its contiguous dead prefix; prune in cursor transaction. Rollback retains row/cursor. Wrong-AAD/junk/expired future inputs create no poison. |
| `coverage binding advances without saved IDs and preserves unknown-ID no-op` | Bind validated dead occurrences at positions `10`, `2`, with no pending/poison. `complete(['missing'])` leaves cursor null and coverage intact. Fail binding.advance before COMMIT: cursor stays null and coverage remains. Retry commits cursor `2` without handler/MLS writes; reopen preserves `2`. Empty capture does nothing. Unbound/stale-generation/wrong-key captures cannot save a cursor. |
| `stale coverage cannot cross a moved cursor or incarnation` | Change cursor/lane generation/current hub between capture and work. Reject/re-prepare. Late old completion changes no new-incarnation state/cursor. |
| `cold completion without coverage preserves the cursor` | Saved record has an unknown preceding gap. Complete without crypto/fetch; row disappears, cursor stays. Reconstruction/refetch never repeats its committed transactional effect. |
| `transactional root reentry obeys ownership diagnostics` | Synchronous same-group root calls refuse with both context modes. After await, refuse with supplied ownershipContext. Retained tx/store access expires. Document absent-context async limitation, without a hanging test. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/mls-rpc test/handler-completion.test.ts`.
Baseline fails at missing runner or pending/cursor split. Raw manual stores composition is not an acceptable substitute witness.

- [ ] **Step 3: Implement one retained D8 entry per compatible completion batch.**

Prepare saved records and coverage under ownership. Revalidate them in work and capture the entry-bound callback before finalise.
Implement binding.advance as an explicit runner mode, independent of the missing-ID no-op. Capture from its bound source only.
Invoke the handler only in effects with stores.tx and defensive saved records.
After handler success, complete pending/covered poison and save eligible cursors through lawful effects-phase side stores.
Use existing proof/account/hooks. Never call GroupPersistence.transition or root cursor.save from an entry callback.
Only proof updates volatile coverage. Completion-only writes preserve MLS version, receive state, retained trust and controller knowledge.
Keep exact-key service available during retirement. Preserve fail-stop and provider error identity.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN and focused affected storage/ownership phase witnesses. Use relevant package typechecks.
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

- Produces the specified adaptBusHandlers options signature and GroupProcedureHandlers runtime normalisation.
- Owns every event/request context projection in handlers.ts. Task 4 supplies authenticated transit and depends on this task.
- Produces `groupHandlerMetadata(transit: { epoch?: number }, key: GroupKey): GroupHandlerMetadata`.
- This projection requires authenticated epoch and obtains incarnation from key. Missing epoch refuses group delivery.
- Produces `combineDurableHandlers<TContext, TTx extends GroupTransaction>(handlers: [DurableHandler<TContext, TTx>, ...Array<DurableHandler<TContext, TTx>>]): DurableHandler<TContext, TTx>`.
- Produces the following dispatcher and raw-callback normaliser. Both require the shared context explicitly.

```ts
export type OpenedAppHandler<TTx extends GroupTransaction> = {
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  deliver(record: PendingAppFrame): Promise<void>
}
export function createOpenedAppHandler<
  P extends Record<string, GroupProtocolDefinition>, TTx extends GroupTransaction,
>(params: {
  localDID: string
  protocols: P
  handlers: { [K in keyof P]: GroupProcedureHandlers<P[K], TTx> }
  suppress?: SuppressConfig
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx>
export function normaliseOpenedAppHandler<TTx extends GroupTransaction>(params: {
  deliver: OpenedAppHandler<TTx> | ((record: PendingAppFrame) => Promise<void>)
  completion: HandlerCompletion<TTx>
  openedDeliveryContext: OpenedDeliveryContext
  owner?: object
}): OpenedAppHandler<TTx>
```

- A successful durable dispatch includes proven completion. Callers must not append a second complete step.
- Existing raw deliverOpened callbacks remain at-least-once callbacks. Normalise them into an OpenedAppHandler using the exact-key completion service.
- Reject a dispatcher with a mismatched key, completion identity or shared context before invocation.

- [ ] **Step 1: Write policy and registration witnesses.**

| Test name | Assertions |
| --- | --- |
| `legacy and omitted mode handlers complete after success outside ownership` | Legacy and mode omitted are at least once. Handler runs with no owner/tx and receives persisted frame/key/epoch/incarnation. Failure retains pending. |
| `transactional dispatch uses saved records and one supplied transaction` | Handler context comes from records loaded by transact. Effect/completion share tx. No second completion. Duplicate completed dispatch invokes no host callback. |
| `production transactional handler preserves effects-phase restrictions` | Enter through createOpenedAppHandler backed by createHandlerCompletion. Repeat Task 2's supplied/copied/constructed domain-write refusals after await. Assert `PersistencePhaseError`, unchanged domain bytes and one committed side row/completion. Run with and without ownershipContext. |
| `mixed durable listener policies refuse before registration` | Helper rejects mixed policy, empty runtime list and invalid modes before any listener/source installation. Same-policy listeners run in declaration order and complete once. |
| `retained event listeners cannot bypass completion policy` | Attempt extra unclassified registration through returned events.on. Reject for retained procedure; ordinary ephemeral listener use remains available. |
| `ephemeral handlers never invoke completion` | Event/request/stream/channel metadata path has no tx/frame/key or complete/transact call. Transactional object on ephemeral procedure refuses registration. A retained-procedure input on ephemeral ingress cannot invoke its durable policy. |
| `handler failure isolates its lane` | Failing A keeps pending and blocks later A, while B succeeds. Default fan-out failure can repeat earlier callbacks; transactional fan-out rolls back all durable side effects. |
| `standalone opened helper retains lifecycle context after await` | Use the required shared context with default and transactional handlers. After await, same-group lifecycle entry rejects with `OpenedDeliveryReentryError`. Independent callers/groups remain unbound. Missing context refuses construction. |
| `handler adapter projects authenticated event and request transit` | Transit epoch `7`, completion key incarnation `3`: host context has `{epoch: 7, incarnation: 3}`. Missing epoch invokes no host callback. Durable saved frame/key survive. Ephemeral contexts omit frame/key/tx. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/handlers.test.ts test/opened-delivery.test.ts` and the new mls-rpc production-handler witness.
Expected missing policy support or missing metadata/completion, not an unrelated transport timeout.

- [ ] **Step 3: Implement policy registration and durable dispatch.**

Normalise legacy functions to at-least-once. Validate policy and retention at registration.
Build one owned durable listener boundary per procedure. Schema/retention checks remain rpc responsibilities.
Unknown protocol or missing handler keeps the record pending, matching current cold drain behaviour.
Use completion.transact for transactional dispatch. Default dispatch awaits the handler outside ownership, then completion.complete.
Adapt the raw emitter surface so adding listeners cannot introduce undeclared retained effects.
Validate required openedDeliveryContext at dispatcher/normaliser construction and retain its identity on the resulting dispatcher.
Project event/request host metadata in handlers.ts, including saved durable metadata from createOpenedAppHandler.
Preserve the shared context around each actual host callback, including transactional fan-out listeners.
The dispatcher owns that callback scope. Enter completion from outside it; do not wrap the whole dispatcher in runOpenedDelivery.
Otherwise the completion entry would diagnose its own callback scope as forbidden root re-entry.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN and relevant package typechecks.
Remove mixed-mode refusal: its registration test must fail before any handler runs.
Invoke transactional callback outside transact or append duplicate default completion: the respective boundary witness must fail.
Move the actual coordinator callback into work: the assembled production-handler phase assertion must fail.
Add no policy to ephemeral paths and confirm complete/transact spies remain zero.
Drop the helper's shared context or defer entry until after the callback: the standalone lifecycle witness must fail.
Drop handlers.ts event/request metadata projection: the authenticated transit context assertions must fail.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): dispatch durable handler completion policies`.

### Task 4: Wire original peer coordination and carry authenticated transit metadata

**Dependency:** Tasks 2/3's canonical completion, dispatcher and context contracts. Task 5 remains independent after Task 1.
This task completes shared peer wiring before Task 6. Tasks 4/6 must execute sequentially.

**Files:**

- Modify `packages/broadcast/src/{transport,responder}.ts` and rpc `src/{peer,peer-epoch,directed,open-once,host-boundary,app-lane}.ts`.
- Modify mls-rpc `src/registry-peer.ts` to supply canonical completion to peer adapters independently of recoveryCompletion.
- Extend `packages/mls-rpc/test/registry-peer.test.ts` with the exact-key canonical completion option witness.
- Test broadcast `test/{transport,responder}.test.ts`, new rpc `test/handler-metadata.test.ts`, rpc `test/{host-boundary,directed,directed-isolation}.test.ts`, integration `test/directed-lane.test.ts`.
- Migrate direct AppLane test constructors to the required completion-owning dispatcher inputs.

**Interfaces:**

- `AppLaneParams<TTx extends GroupTransaction = GroupTransaction>` requires `completion: HandlerCompletion<TTx>`. Its `openedHandler?: OpenedAppHandler<TTx>` is required when crypto.pending exists.
- It accepts `batch?: AppBatchBinding`. `createAppLane<TTx extends GroupTransaction>(params: AppLaneParams<TTx>): AppLane` retains those identities.
- Capture `input.completion` and `appBatch(input.crypto)` before wrapPeerHost.
- Pass the original completion and captured batch directly to AppLane.
- Validate each present binding's exact key against completion.key and the origin control key before installing sources.
- For pending-backed delivery, create the live OpenedAppHandler with canonical completion, required shared openedDeliveryContext and openedScope.owner.
- Replace the peer's split deliverOpened/completeOpenedRecord lane plumbing with this dispatcher. Successful delivery completes exactly once.
- Use canonical completion for bindAppCompletionCoverage. Never register coverage against params.completion's host wrapper.
- Classify completion's key/complete/transact in host-boundary.ts. Preserve existing boundary drainage and claim admission checks.
- RegistryPeerOptions/RegistryPeerParams gain the same transaction generic as GroupPeerParams and the origin-key completion alongside recoveryCompletion.
- The registry adapter calls handlerCompletionForEntry with registrySafety's entry/binding and requested key before createPeer, forwarding that canonical service unchanged.
- Task 8 owns cold fallback/resolver integration, rather than these prerequisites for live peers.
- Add optional `epoch?: number` to broadcast UnwrapResult/BroadcastMessage/BusEvent/request-handler transit context.
- Group adapters populate transit epoch from GroupUnwrapResult.frameEpoch after successful open and require its presence.
- OpenedInbound carries required `epoch: number` and `incarnation: number`, provided by the origin group adapter.
- EpochRuntimeParams/InboxPathParams receive the origin GroupKey. Peer forwards its completion.key explicitly.
- Directed acceptor stamps `kumiai/epoch` and `kumiai/incarnation` per invoking frame, overriding supplied headers.
- GroupHandlerMetadata remains required in group host contexts, optional transit metadata remains generic broadcast-compatible.
- Consumes `groupHandlerMetadata` and event/request projection from Task 3. This task does not edit handlers.ts.
- The retained singleton/non-pending app-lane producer is assigned to Task 6, using this same authenticated transit contract.

- [ ] **Step 1: Write a metadata matrix.**

| Test name | Assertions |
| --- | --- |
| `peer captures original coordination before host wrapping` | Construct the real rpc peer with bound test crypto and a registered canonical completion. Exercise actual wrapPeerHost. Spy on createOpenedAppHandler while forwarding to its real implementation; assert constructor completion `=== input.completion`. A saved record reaches that dispatcher with one completion. Wrong-key inputs reject before any source/handler registration. Task 6 supplies actual streaming/coverage witnesses after implementing those consumers. |
| `registry peer forwards the canonical completion for its requested key` | Through actual createRegistryPeer, capture createPeer's RegistryPeerOptions. Assert options.completion `=== createHandlerCompletion({persistence: persistence.groups, key: requested})`. The recoveryCompletion callback remains separate. Repeat with another group/key and assert distinct canonical identities. |
| `retained frame metadata survives runtime advance` | Open a frame at E after local handle advances; durable/live handler gets authenticated frame E, originating incarnation, stable frame/key where durable. No current-epoch fallback. |
| `anycast metadata survives suppression delay` | Delay jitter while runtime advances. Handler receives invoking frame epoch/incarnation. Sender and abort signal remain unchanged. |
| `directed invocation metadata is per frame across a surviving session` | Parameterise event/request/stream/channel. Start separate invocations before/after rotation on one surviving session. Each handler gets its invoking frame metadata, never session creation epoch. An existing stream/channel context keeps its original invocation metadata. |
| `wire and header metadata cannot override authenticated transit facts` | Spoof epoch/incarnation/sender in broadcast bytes and directed headers. Authenticating transport overwrites them. Missing authenticated epoch refuses group delivery with no persistence work. |
| `metadata-only ephemeral delivery persists nothing` | Warm lease/receive path, exercise all kinds and replies. Zero group transition/outbox/pending/cursor calls. Exact successful-open counts remain unchanged. |

- [ ] **Step 2: Run RED.**

Run focused broadcast transport/responder and rpc directed metadata tests.
Expected metadata absence/current-epoch substitution, not signature or session setup failure.
The coordination witness must fail for missing original identities or split delivery, independently of transport metadata.

- [ ] **Step 3: Implement transport projection and per-frame stamping.**

Capture original coordination before wrapping, then thread the explicit lane inputs and live dispatcher defined above.
Obtain canonical completion in the registry peer adapter. Preserve its identity when forwarding options into the actual rpc peer.
Keep optional singleton compatibility only when the original crypto has no batch binding.
Do not look up batch coordination on wrapped crypto or create a replacement completion service during wrapping.
Forward epoch alongside authenticated sender from unwrap into bus events and request contexts.
Delete any decoded epoch when authenticated unwrap supplies none. Group adapters then refuse missing authenticated metadata.
Preserve it through suppressible wrappers. Preserve incarnation from the bound completion/access key, not wire data.
At the directed ingress, overwrite reserved headers on every accepted frame before server validation.
Supply authenticated transit to Task 3's event/request projection and the directed invocation adapter.
Preserve original invocation metadata for every kind. Do not invent durable frame/key/tx for ephemeral calls.
Keep retained procedures on the durable dispatcher. Wrong-retention ephemeral inputs are dropped without creating a hold or completion row.
Preserve one consuming open per topic, sender splice checks, stale reply retirement and tunnel survival across ordinary rotation.

- [ ] **Step 4: Verify and mutate.**

Run the metadata matrix GREEN and relevant package typechecks. Defer both-family and full build gates to Task 9.
Replace frame epoch with runtime/session epoch: retained/per-frame tests must fail.
Stop overwriting headers or drop metadata during suppression: spoof/jitter tests must fail.
Pass wrapped completion to the live dispatcher: the original-coordination witness must fail its identity or completion assertion.
Task 6 separately mutates batch propagation and coverage registration after their production consumers exist.
Repeat ephemeral zero-transaction witnesses after the metadata changes.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): preserve authenticated metadata on every invocation path`.

### Task 5: Build the per-group adaptive fairness arbiter

**Dependency:** Task 1's portable budget/scheduler contracts and existing GroupBatchOptions. May overlap Tasks 2-4.

**Files:**

- Create `packages/mls-rpc/src/{group-batch,group-batch-binding}.ts` and `test/group-batch.test.ts`.
- Modify `registry/types.ts` and `registry/registry.ts` only for batch options and initialisation.

**Interfaces:**

- Produces GroupBatchScheduler, BatchBudget, createGroupBatchScheduler and groupBatchFor as defined above.
- GroupHandleRegistryParams gains `batch?: GroupBatchOptions`.
- The scheduler never enters provider storage, calls handlers, or changes owner-queue.ts.

- [ ] **Step 1: Write deterministic scheduler tests.**

| Test name | Assertions |
| --- | --- |
| `idle lone work starts without advancing batching timers` | First run begins immediately. No pending coalescing timer must fire first. |
| `active arrivals coalesce without waiting beyond two milliseconds` | Deferred A lets arrivals collect. Release A, then flush ready work immediately or by remaining deadline; count cap flushes first. No active-transition duration is charged as avoidable delay. |
| `count and staging work stop at the next operation boundary` | Exercise begin/take. Defaults 64/2/8. Begin after an arbitrary queued delay. Reach 8 during a stage; no next operation. Count 64 stops before 65. Repeated begin cannot reset the budget. Task 6 separately proves this inside actual decrypt staging. |
| `active A then control then B fits three batches` | Hold first A. Mark control/B ready and replenish A continuously. Batch log equals A,control,B before next A. No timers advanced to hide starvation. |
| `each ready source gets one turn per round` | Multiple ordinary sources, including enqueue/completion/settlement, receive a turn before A repeats. Replenished control cannot starve them. |
| `group B progresses while A is suspended` | Separate group bindings; A's callback/proof stays unresolved, B completes. No global mutex. |
| `invalid bounds refuse before ownership` | Reject NaN/infinity/nonpositive count/work, fractional count and negative delay. Accept zero delay and positive fractional work budget. |
| `closing a source cannot reroute queued work to a new incarnation` | Queued work rejects exact source; no silent key substitution. Storage-only owed work can still run through the shared arbiter. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/mls-rpc test/group-batch.test.ts`.
Expected absent scheduler. Keep tests free of real crypto and wall-clock thresholds.

- [ ] **Step 3: Implement ready-source rounds and options binding.**

Take ownership of no more than one scheduled batch at a time. Resolve each scheduled promise from its own run result.
Track round service before accepting a replenished source's next turn. Give ready control first service at each boundary.
Keep pending source collections outside admitted D8 entries. Do not change D8 FIFO or proof retention.

- [ ] **Step 4: Verify and mutate.**

Run scheduler tests GREEN and relevant typechecks within the allowed slot.
Remove control priority, per-round service memory and independent binding separately: their named tests must fail.
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

- Consumes AppBatchBinding.openReady, full PendingAppFrame, AppCompletionCoverageBinding and Task 3's metadata projection contract.
- Consumes Task 4's explicit canonical completion, dispatcher and batch inputs. No peer.ts or host-boundary.ts wiring remains deferred.
- Registry streaming uses the internal owned preparation seam. Optional unwrapBatch remains an explicit atomic API, not the streaming budget seam.
- Unbound singleton adapters get one turn per open. When pending exists, reload full saved records after singleton unwrap.
- Produces immutable coverage snapshots at lane boundaries and source IDs containing exact key/topic/segment identity.
- Produces independent topic readiness and one in-flight reservation per topic, while preserving order within each protocol lane.
- Existing explicit openBatch remains atomic. Streaming returns a proven processed prefix and leaves its suffix with the producer.

- [ ] **Step 1: Write real/double streaming witnesses.**

| Test name | Assertions |
| --- | --- |
| `streaming burst uses bounded atomic open batches` | Offer 130 already-ready frames to the streaming seam, with a deferred first stage and fixed work clock. Default committed sizes are `[64, 64, 2]`. Host frame cap 32 gives `[32, 32, 32, 32, 2]`. Every returned record is the saved full record. |
| `real peer keeps registry batching and completion through host wrapping` | Assemble actual registry crypto, canonical completion and rpc createPeer in real-MLS/double modes. Feed 130 buffered retained occurrences through hub ingress, with count-bound clock and withheld handler starts. Actual committed open sizes are `[64, 64, 2]`. Singleton unwrap calls are `0`. Release delivery and assert the canonical service receives coverage and completes each saved record once. No direct seam calls or test rebinding of wrapped crypto. |
| `actual decrypt staging crosses eight milliseconds before the next batch` | Drive the registry streaming seam with three valid frames. Advance the injected clock from 0 to 8 inside the first actual decryptStaged call. First committed result consumes exactly 1, next consumes 2. Assert decrypt-starts belong to committed batch groups `[[1], [2, 3]]`. Decrypt runs outside the provider transaction. Caller suffix remains untouched before resubmission. Repeat at host work cap 3, advancing 0 to 3. Explicit openBatch still returns all three atomically. |
| `streaming remainder belongs to its original source through rollback` | Stop a five-input offer at count 2. Assert two ordered results and three untouched inputs. Rollback exposes no prefix/results; retry starts from input 1. A new source generation cannot inherit the remainder. Mixed refusals also count toward consumed. |
| `one peer discovers both ready protocols before awaiting a source` | Use actual retained-fetch app-lane ingress. Buffer A and B, suspend A's first owned batch, replenish A. B is registered before A finishes. Batch order starts A then B when no control is ready. Do not submit B directly to the scheduler. |
| `retained singleton without pending projects authenticated metadata` | Use the non-pending compatibility branch with opened frameEpoch `7`, handle epoch `8`, origin incarnation `3`. The legacy event handler receives `{epoch: 7, incarnation: 3}` through Task 3's projection. No current-epoch substitution. |
| `mixed refusal keeps valid siblings and holds incomplete prefix` | Valid/poison/wrong-AAD/future/duplicate inputs preserve input result order and independent valid records. Held member remains uncompleted. No handler before proof. |
| `scheduled N open rollback exposes no plaintext` | Fail after first write/before COMMIT, then retry/reconstruct. All N key advances/pending/poison commit or none. No handler/ack/output leaks. |
| `dead prefix prunes poison in the cursor transaction` | Scheduled malformed frame becomes dead. Covered poison removal and cursor advance roll back/commit together using Task 2. No accumulation behind a passed cursor. |
| `rowless dead-only peer prefix commits its cursor and survives reopen` | Use real retained-fetch peer ingress and canonical completion in both fixture modes. Fetch only wrong-AAD, invalid-ciphertext, unsupported outer-version and expired-future occurrences at ordered positions `10`, `2`, `20`, `3`. No pending/poison exists. Handler calls stay zero. Fail the cursor transaction before COMMIT: durable cursor stays null, volatile coverage remains retryable. Retry commits cursor `3`; reconstruct persistence/peer and observe `3`, with the next fetch starting after `3`. No valid record or poison may trigger advancement for this test. |
| `future expiry alone requests rowless completion` | Through the same peer path, catch up at locked epoch E. E+3 completes immediately. E+2 remains held at 29,999 ms and completes at 30,000 ms without new traffic. Each case commits cursor `2` with no pending/poison/handler. The age case attempts open again before expiring. |
| `coverage capture cannot deadlock completion behind app mutex` | Suspend app delivery while completion prepares. Capture is synchronous, no mutex/gate cycle. Cursor/source reset invalidates captured proof before writes. |
| `batching preserves controller knowledge and control progress` | Use current management/controller fixture, advance retained controller knowledge, then batch opens. Knowledge survives. Block handler A and confirm authenticated control still applies. |

- [ ] **Step 2: Run RED.**

Run the targeted app-lane and registry/group-batch files.
Expected singleton transaction counts, narrow record projection or split cursor/poison handling.

- [ ] **Step 3: Implement bounded collection and exact saved-record delivery.**

Use Task 4's captured batch and canonical completion. Bind the lane's coverage source to that exact service.
Discover every ready topic in a short runAppLane snapshot before awaiting pull(), any open, or any handler.
Register one scheduled turn for each ready source before awaiting their completion. Do not exhaust A before discovering B.
Reserve each topic's input snapshot under runAppLane, then release the mutex before owned crypto or storage work.
After proof, merge only the consumed prefix under the mutex. Leave the suffix queued and advertise a fresh turn.
Preserve protocol/anchor ordering and generation checks. Independent protocols can advertise readiness simultaneously.
Pull merges advertise newly buffered sources immediately. An unresolved topic fetch cannot hide already-buffered work in another topic.
Hub I/O runs outside lane reservations, owner scope and scheduler callbacks. Do not await one pull before serving buffered sources.
Collect only validated fetched durable occurrences. Push log metadata remains a wakeup, never durable coverage authority.
Pass the same BatchBudget into registry openReady's owned preparation loop, calling take before each actual input stage.
Refactor reusable staging within app-open.ts rather than bypassing CAS, safety, lease projection or controller retention.
Do not split a caller's explicit atomic batch. A slow stage may overrun work budget; start no additional stage afterward.
Use each opened result's full saved record. Do not reconstruct it from plaintext and a pre-open ref.
For the retained singleton/non-pending branch, emit authenticated frameEpoch and origin incarnation through the shared metadata projection.
Register immutable coverage outside the owner/app mutex cycle. Advance volatile state only from proven completion.
After marking rowless refusals or expiry dead, request binding.advance outside runAppLane, the current scheduler run and owner scope.
Request advancement even when an open batch used its no-write path or no saved record was delivered.
Future-expiry and fetched dead-only paths use this channel. Preserve coverage until its cursor commit is proven.
Preserve caught-up future window 2, 30,000 ms age, retained epochs, departing topics and independent commit scheduling.
Replace independent durable cursor saves, including drain/sync/expiry paths, with the binding before removing duplicate pending completion.

- [ ] **Step 4: Verify and mutate.**

Run focused tests GREEN, relevant package typechecks and the existing registry crypto/open tests affected by preparation changes.
Revert to singleton consumption: transaction-count witness must fail.
Charge only array collection time, or omit take inside decrypt preparation: the actual-stage boundary assertion must fail.
Consume the whole offered array on a short result: the remainder ownership assertion must fail.
Restore whole-lane draining before advertising B: the real producer readiness assertion must fail.
Remove original batch propagation in createPeer while leaving the registry streaming seam intact.
The real-peer witness must fail `[64, 64, 2]` or zero singleton calls, even if direct streaming tests pass.
Substitute wrapped completion at the lane input: canonical coverage/completion assertions and the rowless peer cursor witness must fail.
Drop metadata only in the non-pending branch: its handler-context assertion must fail.
Expose one result before commit or remove a sibling from rollback: N-open witness must fail.
Skip saved procedure/epoch/key projection, poison prune or held-prefix stop separately: corresponding witnesses must fail.
Remove the dead-prefix advance request: the rowless peer test must fail at expected cursor `3`, without a timeout.
Remove expiry's advance request separately: the 30,000 ms cursor assertion must fail. Restore each request and require GREEN.

- [ ] **Step 5: Commit.**

Commit with `feat(rpc): consume retained frames through adaptive open batches`.

### Task 7: Schedule control, completion, settlement and enqueue together

**Dependency:** Tasks 2/4/5/6. Task 4's original peer coordination is complete before assembled single-peer witnesses run.

**Files:**

- Modify `packages/mls-rpc/src/{handler-completion,memory-group-persistence,memory-group-ports,app-settlement,entry-capability}.ts` and `registry/{access,app-publication}.ts`.
- Modify `packages/rpc/src/peer.ts` for buffered control intake, selected preparation and post-proof observation.
- Modify mls-rpc `src/{mls,crypto,control-adoption}.ts` and create `src/registry/control-batch.ts` for entry-bound control preparation.
- Extend `test/group-batch-integration.test.ts` and existing `test/app-publication-conformance.test.ts`.

**Interfaces:**

- Consumes groupBatchFor and the existing transaction-bound mutation routines.
- Produces compatible default-completion and settlement collectors, each staging N operations in one D8 transaction.
- Outbox enqueue becomes a ready scheduled source. Buffered control registers before ownership-dependent reads through ControlBatchBinding.run.
- Capture `controlBatch(input.mls)` before wrapPeerHost and validate its exact key against the originating completion.
- Produces ReadyControlScope and its one-entry control preparation contract above, including foreign and recognised-own paths.
- Registry access supplies the internal bridge below. MLS builds its scope from attempt-bound access and pure adapter helpers.
- Root facades assertRoot before any yield, collector insertion or schedule call, including complete/transact and coverage binding.advance.
- Guard pending.complete, outbox.put/recordSettlement/remove, finaliseAppSettlements and finaliseCertifiedApp at their outermost scheduled entry.
- Guard registry control/publication roots moved behind scheduling. Preserve existing preparePublication/publicationSnapshot checks before their waits.
- Transaction-bound methods remain direct and never recursively schedule or acquire an owner.

```ts
// Internal registry/control-batch.ts bridge. None of these views escapes prepare.
export type RegistryControlBatchEntry = {
  key: GroupKey
  run<T>(input: {
    source: string
    signal?: AbortSignal
    prepare(scope: {
      access: ControlHandleAccess
      control: ControlStore
      anchor: AnchorStore
    }): Promise<T>
  }): Promise<{ value: T; epoch: number; control: ControlSnapshot; anchor: AnchorSlot | null }>
}
export function bindRegistryControlBatch(access: RegistryHandleAccess, entry: RegistryControlBatchEntry): void
export function registryControlBatch(access: RegistryHandleAccess): RegistryControlBatchEntry | undefined
```

The internal control/anchor views read staged snapshots and stage writes without claiming durable success outside prepare.
Attempt-bound access.read/readControl reuse EntryReads and the isolated handle. Mutate/replace stage through existing registry validation.
The MLS adapter uses these views to build ReadyControlScope and registers ControlBatchBinding on its original returned GroupMLS.
Its binding forwards one run to the registry bridge, adding no second scheduler submission or owner entry.
The bridge assertsRoot before scheduling. Its selected callback runs one live.run prepare/work transition with existing proof semantics.

Certified finalisation has these internal contracts. `FinaliseBatchResult` uses Task 1's processed-prefix convention.

```ts
type CertifiedFinalisationResult = { seq: number; status: 'published' | 'already-complete' }
type FinaliseBatchResult = { consumed: number; results: Array<CertifiedFinalisationResult> }
// EntryCapability member, implemented in memory-group-persistence.ts:
finaliseCertifiedAppBatch(
  key: GroupKey, seqs: Array<number>, budget: BatchBudget,
): Promise<FinaliseBatchResult>
// Transaction-bound primitive in app-settlement.ts:
function finaliseCertifiedAppInTransaction<TTx extends GroupTransaction>(params: {
  stores: GroupStores<TTx>
  key: GroupKey
  seq: number
  mutationID: string
}): Promise<CertifiedFinalisationResult>
```

The primitive validates saved obligation/attempt/topic, writes the stable published event, then removes entry/obligation.
Both entry and obligation absent yields `already-complete`, with no effect. Duplicate seqs preserve input order and publish once.
A missing counterpart or conflicting obligation throws `GroupStateConflictError`. It rolls back the entire staged prefix, returning no partial outcomes.
All-no-op batches preserve markers/hooks. Successful mixed batches mutate only valid seqs and publish outcomes after proof.
The existing singleton finaliseCertifiedApp becomes a collector client. Cold finaliseAppSettlements queues ready seqs together rather than awaiting each.
The batch entry freezes its processed prefix before outcome. Known backend rollback retries exactly that prefix under the same retained owner.
Retries use fresh tx/store bindings and existing 100 ms doubling to 15 s backoff. Never add suffix inputs during a retained retry.
Ambiguity retains that owner and both hook queues until proof. Invalid obligation errors do not enter backend-rollback retry.

D6 `recordSettlement` certification remains a separate scheduled operation with its current retained retry and exact mismatch results.
Do not merge certification with finalisation or convert its `recorded: false` into success.
Identity/version/attempt mismatches still change no rows, hooks, markers or evidence. Certification rollback retains its original admission.

- [ ] **Step 1: Write assembled fairness and atomicity witnesses.**

| Test name | Assertions |
| --- | --- |
| `one peer advertises buffered B before replenishing A` | Construct one peer with two log protocols and real retained-fetch ingress. Buffer A/B through the hub. Hold A's first owned preparation. Deliver a valid control occurrence through the peer's actual commit-topic wakeup/fetch while A still holds ownership. After fetch completion, before releasing A, assert one ready control source, B already ready, and zero prerequisite root-read admissions. Release A: selected mutation sources are exactly `[A, control, B]`, including active A, with no intervening prerequisite Read/anchor-save entries. Control's proven epoch is E+1 and its cursor names that occurrence. A keeps replenishing. No manual control/B scheduler submission or direct registry opens. |
| `selected control performs all local prerequisites in its entry` | In both fixture modes, count root readEpoch/readCommitHeader/readControl, control.load, isLedgerComplete, rosterEntries, anchor load/save and crypto.openEntries calls for the buffered occurrence. Counts stay `0`; attempt-bound preparation uses one owner, with crypto before the mutation transaction opens. The named-entry resolver succeeds from the selected source handle. Work commits prepared state/control/anchor together. No nested scheduler submission, root reentry or output before proof. Retained scope access rejects after prepare. |
| `ready control revalidates source and preserves authentication` | Let A change stateVersion without changing epoch: control uses that newly committed source and adopts. Change epoch/authenticator or retire the incarnation separately: reclassify/reprepare or refuse, never commit a stale candidate or change another key. Inject an expected-version conflict at work: no stale writes commit. Valid sender-data with a bad commit-content signature grants no adoption, obligation deletion or retry prohibition. Failed named-entry copies preserve live bytes/ID/candidate/deadline and `retryForbidden: false` unless already prohibited. Re-run recognised-own consumption and self-removal, preserving saved-candidate installation and drain-before-clear. |
| `control prerequisites never hold a selected turn across network work` | With ledger/bootstrap or recovery genuinely unavailable, the selected local attempt returns its prerequisite outcome and releases owner/scheduler. External fetch/confirmation stays unresolved while already-ready B/enqueue proves. No held owner, staged adoption, destructive lifecycle transition or repeated control turn before B. A wakeup without fetched bytes does not advertise adoptable work. |
| `enqueue progresses before burst exhaustion` | Extend that peer scenario with log dispatch while A remains replenished. Enqueue acceptance proves before a second further A batch and while A backlog remains. Handler completion gets a turn without backlog exhaustion. |
| `compatible completions and settlements share bounded transactions` | Queue homogeneous same-key operations during an active batch. At least two ready operations co-commit; none exceed count/work bounds. Each batch's entry-bound helpers add zero nested scheduler submissions and succeed under ownership. Rollback leaves every entry/effect/event unchanged. |
| `certified finalisation batch preserves per-item outcomes and retry ownership` | Queue seqs `[1, 2, 1, 3]`, with 1/2 certified and 3 absent. One batch returns statuses `['published', 'published', 'already-complete', 'already-complete']` and publishes each valid seq once. Inject before-COMMIT rollback: same owner retries the frozen prefix before queued retirement. Reconstruction preserves original topics/occurrences. Corrupt seq 2's obligation separately: all rows/events unchanged, no partial outcomes. |
| `certification mismatch remains a no-write result beside batching` | Parameterise identity/version/attempt/missing-entry mismatches through production recordSettlement. Assert `{recorded: false, reason}` with reasons `identity-changed`, `state-version-changed`, `attempt-changed`, `entry-missing` respectively. Rows/markers/hooks remain byte-identical. A valid certification rollback still retries before later lifecycle work. |
| `certification rollback keeps its existing owner precedence` | Existing 2.3c proof retries retain admission and block same-group retirement until settled. Scheduler cannot let later control/retirement invalidate that guarantee. |
| `one failed batch leaves unrelated sources serviceable` | Default handler failure has no owner. Known rolled-back work backs off outside storage, other sources can run unless retained proof specifically requires otherwise. |
| `withheld topic fetch cannot block already-ready peer sources` | Keep A's hub fetch unresolved. In the same peer, already-buffered B, authenticated control and enqueue prove before A's fetch resolves or its timeout fires. Repeat with damaged A bytes. Assert no durable hold, deleted obligation, replacement build or lifecycle transition. Existing r28i preservation witnesses remain required. |
| `scheduled completion roots reject reentry before admission` | Enter a production transactional handler through the assembled scheduler. Parameterise complete, transact, pending.complete and bound coverage.advance, with valid same-key target work. Call synchronously with ownershipContext absent/present, then after await with it present. Each call rejects `ReentrantOwnershipError`. Scheduler submissions and collector insertions each increase by `0`; target rows/cursor remain unchanged and no nested callback runs. The outer lawful effect/completion can commit once after catching the refusal. |
| `scheduled enqueue and settlement roots reject reentry before admission` | Repeat that handler/context matrix for outbox.put, recordSettlement, remove with a certified obligation, finaliseAppSettlements and capability.finaliseCertifiedApp. Use otherwise-valid inputs and real production facades. Assert `ReentrantOwnershipError`, zero collector/scheduler submissions and unchanged target entries/events/obligations. Include any registry control/publication root newly scheduled here. |

Observe recursive results without awaiting an unresolved child while the outer batch is held. Flush microtasks before releasing that batch.
Assert rejection and zero admission at that checkpoint. A missing result or an enqueued operation fails an assertion, not a timeout.
Without ownershipContext, after-await root diagnosis remains limited by S:1006-1007. Do not invent a stronger guarantee or hanging witness.

- [ ] **Step 2: Run RED.**

Run group-batch-integration and app-publication-conformance focused tests.
Expected absent shared admission, per-item transaction counts or a missing reentry diagnostic, not an altered 2.3c certification result.

- [ ] **Step 3: Integrate at pre-admission boundaries.**

Extract transaction-bound settlement/completion operations only where necessary for compatible grouping.
Split commit intake from persistence-driven walking. Fetch and buffer ordered occurrences without awaiting runSerial's root prerequisites.
Advertise the next buffered occurrence before pullCommits/walkCommitLog prologue reads or per-occurrence classification reads.
Preserve control replay ordering and locally known prerequisite gates. Revalidate those gates inside the selected entry.
Install the registry bridge on access and the MLS binding on the original port before constructing a registry peer.
Capture that binding before host wrapping. The buffered walker uses it directly, preserving the source's exact key and occurrence order.
Refactor readEpoch/readCommitHeader/processCommit and pure exporter helpers to accept the attempt-bound access used by ReadyControlScope.
Refactor ordinary own-candidate staging for prepareOwn. Never call the root control-adoption adapter from an owned callback.
Perform advanceHandle's local preconditions and anchor staging inside the scope. Defer runtime mutation, events and rebuilding until proof.
Return unmet prerequisites before any staged adoption. Request bootstrap/recovery outside both owner and scheduler, then re-advertise when actionable.
Place capability.assertRoot at each scheduled root facade before reading targets, collecting work, calling schedule or yielding.
Keep the check in the caller's synchronous context. A check deferred to the selected run callback is too late.
Audit every new schedule/collector ingress, including rowless advance and aliases. Keep lawful transaction-bound helpers free of root checks.
Move certified finalisation's existing body into the named primitive and implement the batch entry in memory-group-persistence.ts.
Preserve the coordinator's administrative validation, effects/account restrictions and original-occurrence event construction.
Keep network/crypto publication preparation outside storage and all external publication bytes behind proof.
Select buffered actionable control before the next ordinary round. Complete its local preparation and adoption in the same selected entry.
Do not prequeue burst source batches into EntryCapability.run. Never put independent groups behind one application mutex.
Preserve frozen original-topic settlement, exact attempt/version checks, retained certification rollback retry and post-proof events.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN, focused publication/retirement regressions and relevant package typechecks. Defer broad gates to Task 9.
Bypass shared arbitration for control or enqueue: corresponding batch-count witness must fail.
Restore any control prologue/per-occurrence root read before run: readiness/zero-admission and `[A, control, B]` assertions must fail.
Remove control binding capture before wrapping: the actual-peer readiness assertion must fail despite manually-ready scheduler tests passing.
Call root crypto.openEntries or root advanceHandle inside prepare: the selected-prerequisites witness must fail its zero-root or reentry assertion.
Skip source revalidation or commit-content signature verification separately: the source/authentication witness must fail its unchanged-state assertion.
Await external bootstrap/confirmation inside the selected turn: the prerequisite witness must fail B's completion checkpoint before external release.
Restore one transaction per compatible completion/settlement: grouping witness must fail.
Release certification ownership on rollback: the retained-precedence witness must fail.
Partially commit finalisation siblings, retry under a new owner, or return success on mismatch: corresponding batch/mismatch witnesses must fail.
Await A's network fetch before discovering B: the withheld-fetch witness must fail on its completion-order assertion.
For each scheduled root path, bypass its pre-admission guards separately, leaving the D8 queue check intact.
Its named reentry witness must fail on missing ReentrantOwnershipError or a nonzero submission count while the outer batch remains held.
Move the check after a yield: the synchronous absent-context witness must fail. Restore each guard and require GREEN.

- [ ] **Step 5: Commit.**

Commit with `feat(mls-rpc): share fair admission across durable work sources`.

### Task 8: Integrate both handler policies into peer and cold lifecycle drains

**Dependency:** Tasks 2/3/4/6/7. Q1=A applies to absent cold coverage.

**Files:**

- Modify `packages/rpc/src/{peer,opened-delivery}.ts` and mls-rpc `src/{registry-peer,opened-delivery}.ts` for lifecycle-specific claims/fallbacks.
- Modify `packages/mls-rpc/src/registry/types.ts` and `registry/registry.ts` for a key-neutral dispatcher resolver alongside legacy raw callbacks.
- Test mls-rpc `test/{opened-delivery,registry-opened-lifecycle}.test.ts`, rpc `test/{peer-drained,opened-delivery}.test.ts`, integration `test/terminal-drain.test.ts`.

**Interfaces:**

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
Resolve once per exact-key drain, after obtaining that key's canonical createHandlerCompletion service and coverage binding.
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
| `default effect before completion crash preserves complete handler metadata` | Effect occurs, completion rolls back, process reconstructed. Handler receives byte-identical key/sender/frame epoch/incarnation/procedure again. |
| `transactional handoff commits once before retirement clears` | Suspend a live transactional callback or proof, request resync/delete/successor. No overlapping cold callback, cursor loss or clear before proof. Restart leaves exactly one durable effect. |
| `terminal restart drains both policies without crypto or network` | Open batch, commit self-removal, reconstruct before handlers. Drain persisted records/completion, then clear. Decrypt/fetch/publish spies stay zero. Handler failure preserves pending indefinitely. |
| `disposed fallback refuses unadmitted records but keeps admitted completion` | Preserve 46c1d2c3 behaviour under new policy dispatch. Disposal cannot release a drain waiter early or invoke new live handlers. |
| `old completion cannot write the new incarnation cursor` | Old saved-key callback finishes while lifecycle runs. Exact origin receives eligible completion; new cursor/state/history remain untouched. |
| `handler lifecycle reentry refuses instead of self-waiting` | After await, same-group dispose/recover/delete from an opened callback rejects with the existing delivery diagnostic. Unrelated caller/group remains independent. Transactional root diagnosis follows Task 2's D8 contract and Task 7's scheduler admission witnesses. |
| `attached fallback and registry override retain context after await` | Cross both policies with attached fallback and explicit resolver. Test legacy raw override as default policy. After await, same-group lifecycle call rejects `OpenedDeliveryReentryError`. Verify no self-wait and no independent caller contamination. Standalone helper is pinned in Task 3. |
| `registry resolves cold dispatchers independently for two groups` | One registry drains two distinct group keys through openedHandler. Each resolver gets its own completion/key and shared context. Each transactional side row commits once and its own pending rows disappear. Wrong-key/context resolver output rejects TypeError before any handler or completion call. |
| `cold dispatcher after incarnation switch uses the requested key` | Drain old incarnation, perform an authorised switch, then persist/drain new-incarnation records. Assert separate resolver keys/completion identities. New pending clears, old effect remains single, and neither cursor is written under the other key. Reconstruct before the new cold drain. |

- [ ] **Step 2: Run RED.**

Run focused rpc/mls-rpc opened/lifecycle files and terminal-drain integration.
Expected missing transactional completion or metadata. Do not mask a deadlock with a larger timeout.

- [ ] **Step 3: Replace split completion with the common boundary.**

Reuse Task 4's original completion/batch capture and live dispatcher. No shared host-boundary wiring is deferred to this task.
Propagate the required context through fallback and registry resolver.
Dispatch one policy-aware delivery per claim. Stop the cold worker from completing again after successful dispatch.
Migrate remaining cold createOpenedAppHandler call sites to its explicit deliver method and required context/owner inputs.
Resolve registry dispatchers for each requested key. Preserve legacy raw callback behaviour through exact-key normalisation.
Remove outer runOpenedDelivery scopes around the dispatcher; the dispatcher binds only the actual host callback.
Await persisted completion proof and volatile notification before releasing ownership of the delivery claim.
Retain the attached live handler fallback, explicit registry override precedence and synchronous withdrawal at disposal start.
Retirement/drain wait outside the owner. Do not open/fetch more records or grant automatic recovery authority.
Preserve visible switch-blocked reporting and no-timeout erasure, including terminal reconstruction.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN, affected integration tests and relevant package typechecks.
Allow cold/live overlap, detach coverage, release a waiter early or append a duplicate completion separately: respective witnesses must fail.
Restore a new-open call during terminal drain: the zero-crypto/network witness must fail.
Reuse a registry-wide dispatcher across keys or cache by groupID alone: two-group/post-switch cold-drain assertions must fail.
Drop context in fallback or override normalisation: its after-await reentry assertion must fail.

- [ ] **Step 5: Commit.**

Commit with `feat(mls-rpc): use handler policies throughout opened lifecycle drains`.

### Task 9: Publish shared conformance and assembled reconstruction evidence

**Dependency:** Tasks 1-8. Implement the settled Q1=A/Q2=A contracts.

**Files:**

- Create `packages/rpc-conformance/src/{handler-completion,handler-batching}.ts`; modify `{group-crypto,persistence-fixture,pending-group-crypto,index}.ts`.
- Create `packages/mls-rpc/test/handler-batching-conformance.test.ts`; extend existing real/double fixture constructors and rpc port wrappers.
- Extend memory integration witnesses for durable delivery, directed metadata and terminal drain.
- Update rpc/mls-rpc/broadcast READMEs, docs/reference/app-lane.md and existing release intent.

**Interfaces:**

- Extend the persistence test aggregate with `completion(key): HandlerCompletion<TTx>` and existing crypto(key) binding used by these suites.
- Export `testHandlerCompletionConformance` and `testHandlerBatchingConformance` with independent mirrored contracts and supplied fixture constructors.
- Reuse side-row/fault hooks. Tests must enter through public production handlers and completion, not handwritten storage transactions.

- [ ] **Step 1: Add shared behavioural assertions and wire real/double adapters.**

Cover current S:2801-2809 and S:2840-2842, preserving S:2800 ordering scope and S:2819 reentrancy limits.
Each row maps to an earlier named witness. Assert identical required behaviour on real MLS and every relevant double.
Include default effect-before-completion, N-frame open rollback, transactional effect around COMMIT and terminal restart seams.
Include the effects-phase refusal, actual decrypt-work cutoff, real peer readiness, per-key cold dispatch and later-prefix closure witnesses.
Include original binding propagation through actual host wrapping and control readiness before prerequisite root reads.
Require selected control's entry-bound authentication/preparation and unmet-prerequisite release witnesses on both fixture modes.
Include dead-only rowless cursor rollback/reopen and scheduled-root reentry with zero admission, through the production adapters.
Keep the base crypto mirror's required frameEpoch assertion independent from saved-record replay.
Keep semantic chat dedup/read marks, provider faults and SIGKILL explicitly unclaimed.

- [ ] **Step 2: Run RED.**

Temporarily discard completed B's live coverage after its pending row disappears.
Run `ktest @kumiai/mls-rpc test/handler-batching-conformance.test.ts -t 'later completion retains live coverage until the earlier prefix closes'`.
Expected behavioural RED: completing A leaves the cursor at `10`, instead of the required `2`, in both fixture modes.
Restore coverage retention. The same named assertion must pass before proceeding.

- [ ] **Step 3: Document host migration against the wired fixtures.**

Use exact group keys, actual supplied tx side rows and current controller-aware fixtures.
Document completion versus recoveryCompletion, options-based adaptBusHandlers, policy fan-out and required authenticated metadata.
Document GroupUnwrapResult's locked epoch versus frameEpoch, required openedDeliveryContext and optional ownershipContext's async limitation.
Describe Q1=A's conservative cold cursor guarantee, poison lifetime and current-move coverage invalidation.
Document the key-neutral registry openedHandler resolver and explicit shared delivery context through every dispatcher path.
Add release text to `.changeset/spec-p-storage-foundation.md`. Do not release or raise the band.

- [ ] **Step 4: Verify complete assembled evidence.**

Run kbuild, the new conformance wrapper, kports and repo-wide ktypes in a coordinated slot.
Treat these commands as the final gate. The checklist below records that evidence without rerunning the same commands.
Run affected full rpc/mls-rpc/broadcast unit suites and affected integration files with bounded workers.
Record every guard mutation from Tasks 1-8, including RED cause and restored GREEN.
Inspect the final diff for permissive double fallbacks, generated files, stale recovery field names and hidden format/dependency changes.

- [ ] **Step 5: Commit.**

Commit with `test(rpc): enforce handler completion and batching contracts`.

## Parallel lanes

These are future implementation lanes, not permission to run tests concurrently.

- **Initial:** Task 1, portable contracts, callers and app-batch coordination types.
- **After Task 1, lane A:** Tasks 2 → 3, completion and policy/context projection.
- **After Task 1, lane B:** Task 5, scheduler implementation and registry batch options.
- **After Task 3:** Task 4 supplies live peer coordination and transit metadata. Task 5 may continue independently.
- **After Tasks 4/5:** Task 6 consumes completed peer wiring, then implements streaming and coverage. No Task 4/6 overlap.
- **Assembled join:** Task 7 follows Task 6, supplying buffered control intake/preparation through the actual peer producer.
- **Final sequential joins:** Task 8, then Task 9 and recorded completion evidence.

Reserve handlers.test.ts edits for Task 3; Task 4 owns handler-metadata.test.ts and its transport/directed files.
Task 3 owns handlers.ts projection. Task 6 owns app-lane.ts, including the singleton/non-pending metadata producer.
Task 4 first owns AppLane's completion/dispatcher/batch input migration. Task 6 takes that file only after Task 4 finishes.
Task 2 finishes coordinator and handler-completion tests before Task 3 extends its production-handler witness.
Task 1 finishes generic peer/host-boundary migrations before Task 4. Task 4 finishes common peer wiring before Task 7's control integration.
Task 8 changes only lifecycle integration after those joins. It owns no prerequisite binding propagation for earlier task gates.
Use file-disjoint implementation workspaces under the session's allowed roots. Do not create them during drafting.

## Completion gates and handoff

- [ ] Confirm implemented contracts retain settled Q1=A/Q2=A. Record any spec-dependent departure as a new question.
- [ ] Map inventory candidates and current conformance rows to actual implementation/test evidence.
- [ ] Run repo-wide `rtk proxy pnpm exec turbo run test:types` after final public-type changes, with uncached evidence.
- [ ] Run both contract families on real implementations and doubles, including registry crypto, completion, hub memory/SQL/log/view wrappers.
- [ ] Run affected full package suites and assembled memory reconstruction tests in the coordinated heavy-run slot.
- [ ] Confirm each guard mutation fails for its intended assertion and restored code passes.
- [ ] Confirm idle-immediate, count/work bounds and A/control/B batch counts without wall-clock flake thresholds.
- [ ] Confirm actual decrypt staging enforces 8 ms and the same peer advertises B before awaiting A or its fetch.
- [ ] Confirm actual wrapped-peer ingress commits open sizes `[64, 64, 2]`, with original completion identity and zero singleton calls.
- [ ] Confirm buffered control advertises while A owns, before any prerequisite root-read admission, then proves `[A, control, B]`.
- [ ] Confirm control's local reads/crypto/anchor staging use one selected entry and missing network prerequisites release its turn.
- [ ] Confirm completion effects/pending/poison/cursors share proof, including rejected/unknown COMMIT and cold handoff.
- [ ] Confirm transactional handlers run in effects and every domain-store view refuses writes with PersistencePhaseError.
- [ ] Confirm B-first/A-later completion closes surviving live coverage through position `2` and preserves that cursor after reopen.
- [ ] Confirm rowless dead-only peer prefixes advance via binding.advance, including rollback/reopen and expiry without new traffic.
- [ ] Confirm scheduled roots reject detectable reentry before any collector/scheduler admission, preserving lawful entry-bound operations.
- [ ] Confirm cold dispatch resolves two groups and successive incarnations with distinct exact-key completion services.
- [ ] Confirm all metadata paths use authenticated original frame epoch/incarnation, overriding spoofed headers and wire values.
- [ ] Confirm ephemeral metadata paths perform zero persistence and keep exact receive counts.
- [ ] Confirm completion-only work does not rewrite MLS/controller state and batched MLS writes retain controller/management knowledge.
- [ ] Run `rtk proxy pnpm run lint` in implementation scope and inspect formatting changes before commit.
- [ ] Record skipped/unavailable backend evidence as incomplete. Never count it as a pass.
- [ ] Record host API migration, Q1/Q2 decisions and remaining 2.3e/2.4 obligations in the implementation carry-forward.
- [ ] Preserve provider-fault and SIGKILL handoffs to phases 3/6. Memory reconstruction cannot close those rows.
- [ ] Do not merge, push, release or edit generated files as part of completing this sub-plan.

Draft verification: source/spec/history inspection only. No tests, builds, typechecks or mutations ran during drafting.
The existing machine-wide slot mechanism and all runtime verification remain unverified until implementation.
