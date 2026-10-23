# Spec P 2.3c: durable publication, settlement and opened drain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make application publication proofs durable and drain opened records before lifecycle handoff, including reconstruction without an old peer.

**Architecture:** Rpc owns portable publication contracts and proof orchestration. Registry adapters compose attempts with committed application state and leases through the existing D8 coordinator. Storage-only services finish certified publications and opened plaintext under their originating key, independently of crypto access and peer lifetime.

**Tech Stack:** TypeScript, pnpm 12.15.0, Vitest, ts-mls, sealed transactional memory persistence, existing rpc/hub conformance runners.

**Spec:** [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md), r28h baseline plus the r28i amendment applied by Task 0. Source/spec coordinates below refer to `5a2c7431` before that amendment.

Baseline: `feat/spec-p-phase-2`, HEAD `5a2c7431`, 2026-10-23.
Status: revised draft under binding `rulings-r1.md` (R1-R5), `rulings-r2.md` (A1-A8, O1-O5) and Q2 = B in `.superpowers/sdd/plan-2-3c-draft/questions.md`.
Nine tasks, numbered 0-8. Task 0 applies r28i; Task 8 is executable against that amendment, with no outstanding product decision.
Tasks 1-7 preserve the R1 interaction boundaries listed below.

This document plans future implementation. This revision permits writes only to this plan and `.superpowers/sdd/plan-2-3c-draft/revise-notes.md`. It authorises no source/spec edits, git commands, tests or commits.
Commit steps and verification commands below apply to a subsequent authorised implementation session.

## Global Constraints

- Applied state decides acceptance, fork, absence and settlement. Hub-delivered bytes never supply that authority (S:14-18,78-123).
- Every hub fault means non-delivery. Never derive durable halt/hold, discard, rebuild, owed-work deletion or permanent stranding from it (S:14-18).
- Q2-B/R1 cover failed OWN and foreign delivered copies: coverage-only skip with explicit `retryForbidden: false` unless already prohibited; preserve live saved work. Task 0 ratifies this as r28i.
- Group namespaces share one transaction. Crypto preparation holds the owner slot outside the provider transaction (S:497-502).
- Runtime state, plaintext, events and network bytes become visible only after proven commit (S:501-502).
- Control build/publish/fetch/confirm, Welcome delivery and default handlers run outside provider transactions (S:502,531-539).
- Batch defaults remain `maxBatchFrames: 64`, `maxBatchDelayMs: 2`, `maxBatchWorkMs: 8` (S:506-515).
- Application leases remain `16`, renewal below `4`, ceiling `500`. A reservation advances committed state (S:771-785).
- Registry retention/forward steps remain `>=1000`. Ordinary maximum-forward floor remains `500` (S:795-798).
- Client-state format remains v2 only. Recovery candidate remains v3 with AAD `kumiai/recovery-candidate/v3` (S:740-759).
- No per-seal burn, restore skip, new reservation API, historical control search or retained-build mechanism (S:569-575,773-785).
- A build closes through authenticated consumption or explicit host retirement/`abandon()`. Automatic recovery retirement of a live build needs request-bound MLS-verified member-signed same-group GroupInfo at F > source E, then bound confirmation and source revalidation (r28i). Proven Welcome obligations survive.
- `skipped` and `retryForbidden` stay separate. Absent `retryForbidden` defaults to `skipped` for older rows (S:624-677).
- Operation timeout stays `30 s` by default. Expiry reports once and never frees a live build (S:652-673).
- Proof binds incarnation/epoch/authenticator, `sealVersion` and acknowledgement cutoff (S:808-816).
- Outbox persists immutable plaintext. Prepared application ciphertext stays in memory (S:802-806).
- App status flow remains `pending → accepted → published` or `accepted → failed` (S:821-822).
- Frozen proof persists `{sequenceID, attemptID, topicID, outcome: 'published'}` before removal (S:812-821).
- Memory hub dedup becomes `(topicID, publishID)`, with original acceptance time and inclusive `365-day` purge (S:825-827).
- The client publish result remains `{sequenceID}`. HTTP gains no `deduped` field (S:810).
- At-rest AAD remains UTF-8 JSON `['kumiai/at-rest/v1', groupID, incarnationOrNull, namespace, recordID]` (S:837-840).
- Keep all persisted values sealed, including retired plaintext, topicIDs, obligations and events. Never add plaintext shadow maps (S:831-842).
- Unknown completion retains ownership and hooks. Proof retries start at `100 ms`, doubling to `15 s` (S:844-855,968-984).
- Handlers and lifecycle drain wait outside owner slots. Timeouts never prove completion or authorise erasure (S:543-547,873-876,986-990).
- A double may be stricter than its port, never more permissive. Changed ports run both contract families on real implementations and doubles (S:2753-2758).
- Use memory reconstruction for phase-2 crash evidence. Real provider faults and child SIGKILL belong to phases 3 and 6 (S:2719-2720,2851-2858).
- Use pnpm through `rtk proxy pnpm ...`. Never edit generated `lib/`, package scripts or build/lint configuration.
- Internal dependencies remain `workspace:^`. Published cross-repo dependencies use catalog `^` ranges. This plan adds no dependency.
- Keep comments terse. Keep versions in the shared band. Do not merge or push before phase 2 completes.

## Review Focus

These five failure modes lack assembled witnesses at this baseline. Each has a test in its owning task.

1. **Late ack crosses an identity or seal replacement.** It must not certify the replacement attempt. Task 2: `late acknowledgement cannot certify a replacement attempt`; the separate `same-epoch expected authenticator alone refuses certification` isolates authenticator equality.
2. **Certification rolls back while retirement is queued.** Retry must retain the owner entry. Retirement cannot fail an already queued valid proof. Task 2: `certification rollback keeps retirement behind its retry`.
3. **Restart under a hold loses volatile proof.** A persisted obligation must publish its original status without opening crypto or contacting the hub. Task 3: `held reconstruction finalises only persisted publication obligations`.
4. **A handler outlives peer disposal.** Drain must await the handler and its completion, including rejected or ambiguous completion. Task 4: `disposal does not release an opened drain waiter`.
5. **A frozen source has no live peer.** Unknown protocol or a failed handler must visibly block switching and deletion while retaining plaintext. Task 5: `cold opened work blocks switching without starting an old peer`.

---

## Scope and evidence

The inventory contains 25 candidates: 4 DONE, 12 PARTIAL, 9 OPEN.
Several partial candidates share one implementation task. Counts are not task counts.

| Requirement | Task | Binding spec |
| --- | --- | --- |
| Apply the reviewed r28i amendment (doc-only) | 0 | Q2-B, R1-R2; amendment draft below |
| Complete outbox shape, decoding, events | 1 | S:802-827,2367-2434 |
| Atomic attempt plus state/lease | 1 | S:497-502,771-785,802-806 |
| Prepared retry, active restart | 1 | S:802-810,2840 |
| Both proof paths and acquired-gate orders | 2 | S:808-816,2838 |
| Frozen finalisation, O1/O3, O4 reconstruction | 3 | S:126-133,479-486,818-821,2739,2839 |
| Opened-only delivery and `drainOpened` | 4 | S:531-547,2736,2738,2803 |
| Retirement/readmission/delete/successor and `switch-blocked` | 5 | S:476-483,521-547,873-876,986-990 |
| Superseded manual attempts, N3/O8 | 6 | S:406-408,479-480 |
| Memory hub dedup parity | 7 | S:825-827,2842 |
| Failed own/foreign delivered copies and authenticated recovery authority | 8, after 0 | r28i D1/D4 and amended S:2819-2829 |

Old scope Conformance :1904-1905 now means S:2838-2839. Old crash :1806 now means S:2739.
Terminal-open reconstruction also owns S:2738/2803. Transactional handler policy remains 2.3d.

Already implemented: `BuiltCommit`, walker-only consumption, provisional/final outcomes, `abandon()`/`spentSource`, independent Welcome obligations and byte-level leases.
O4 therefore needs a restart witness, not restoration of the old own-operation settlement loop.

### Explicit out-of-scope work and owners (R3)

| Work / baseline rows or seam | Owner | Remaining witness / boundary |
| --- | --- | --- |
| HandlerCompletion, atomic completion/cursor, transactional exactly-once effect and registration: S:2800,2801,2835; seam 2737 | **2.3d — HandlerCompletion** | Future witness `transactional completion commits effect pending and cursor atomically`; remove cursor co-write (or move effect outside the transaction): that witness must fail. Task 4 supplies only opened drainage and at-least-once reconstruction, not completion atomicity. |
| Handler metadata/frame-ref migration, poison pruning, scheduler/fair batching S:2798; handler metadata S:2836 and host-facing S:2802 (`epoch`/`idempotencyKey` on live delivery) | **2.3d — handler/batch work**, per 2.3b carry-forward obligation 2 | Preserve existing metadata here; cold-drain evidence does not close live-delivery metadata rows. No metadata migration, fairness or batching completion claim. |
| Restore declarations/participants, device packages and atomic Welcome burn; S:2792-2793, seam 2745, `database-restored` | **2.3e — restore/device work** | Future witness `declared restore atomically fails certified and unproven entries`; remove certified-entry inclusion: the witness must fail. Task 3 only defers while restore is pending, leaving this transition to its owner. |
| Buffered hub lift and HTTP smoke S:2843 | **2.4 — integration** | Affected memory reconstruction does not satisfy full HTTP smoke. |
| Real-provider row S:2817 and SIGKILL row S:2845 | **2.4 — track/hand off evidence** | Actual execution belongs to spec phases 3 (providers) and 6 (child kills); memory tests cannot satisfy either. |
| Async root re-entry after an await without `ownershipContext` | **D8 host integration — accepted spec limitation**, S:992-999 | Same-group root re-entry can self-wait; document the optional-context limitation. Absent-context mode guarantees synchronous refusal only; no change in 2.3c. |
| Withheld commits stall future-epoch application frames | **Existing app-lane policy — retained** | Caught-up observations gate expiry/progress; opened-only drainage does not process sealed future-epoch frames. Note only; no policy change in 2.3c. |
| Accepted-but-uncertified publication reseals with a fresh ID after restart | **Existing publication contract — accepted at least once** | A second occurrence remains possible; hub publish-ID dedup applies per topic/ID for a bounded 365 days and cannot dedup a fresh ID. Note only; no stronger publication guarantee in 2.3c. |
| Duplicate host effects for default handlers, external events and Welcome | **Existing delivery contract — accepted at least once**, S:531-541,821-822 | Host effects can repeat before completion/ack; note only. Transactional status effects retain their specified atomic guarantee. |

Default handlers and external event/Welcome delivery remain at least once. No duplicate-host-effect-free claim is made.
Declared restore must eventually fail even certified restored entries (S:224); ordinary finalisation cannot run ahead of that policy.

### R1 interaction check across all tasks

| Task | Interaction with the own-copy policy |
| --- | --- |
| 0 | Amend every contradictory normative own-copy statement, interface comment and conformance row once, in the referenced draft. |
| 1 | App publication preparation/retry is separate from the control `BuiltCommit`; its strict app decoder must not classify control copies or reset an existing ban. |
| 2 | Application proof authority stays authenticated applied state plus acknowledgement fences; a copy skip never certifies app publication or changes an expected snapshot. |
| 3 | Replay only committed outcomes/obligations. O4's witness closes via authenticated consumption, never a damaged own copy; no finaliser deletes speculative control work. |
| 4 | Deliver only already-persisted opened application plaintext; no control-copy validation, new open or control settlement in this service. |
| 5 | Drain mechanics do not grant retirement authority. Automatic recovery with a live build must pass Task 8's r28i gate before starting retirement; explicit host lifecycle requests retain their authority. |
| 6 | Ordinary automatic recovery must already be authorised by that gate; collecting superseded manual outcomes cannot manufacture authorisation or close a build from hub claims. |
| 7 | Idempotent retries must retain identical control bytes/ID on the originating topic. Hub dedup supplies no settlement/retirement authority. |
| 8 | Update both own-recognition paths and r28h failed-own-copy tests listed in Step 1; preserve authenticated foreign refusal, applied consumption and legacy absent-field bans. |

**Controller logs:** no task introduces or changes a persisted `prefix`/`recordedLog` format.
The existing client-state, registry, checkpoint and recovery codecs remain unchanged.
The separate controller 0.2 adapter keeps the existing array shape. No format-tag or dependency-bump task belongs here.

## File Structure

Paths in this table describe implementation scope, not permission to edit them during drafting.

| Responsibility | Files |
| --- | --- |
| Normative r28i amendment (Task 0 only) | `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md`; exact text in `.superpowers/sdd/plan-2-3c-draft/spec-r28i-draft.md` |
| Portable outbox values and strict decoder | `packages/rpc/src/app-outbox.ts`, new `packages/rpc/src/app-entry.ts`, `packages/rpc/src/index.ts` |
| Portable publication preparation and proof snapshots | New `packages/rpc/src/app-publication.ts`, `packages/rpc/src/peer-types.ts` |
| One registry attempt/state/lease entry | New `packages/mls-rpc/src/registry/app-publication.ts`, `registry/live-send.ts`, `registry/access.ts`, `registry/types.ts`, `registry/registry.ts` |
| Contract aliases and adapter factory | `packages/mls-rpc/src/persistence-types.ts`, new `packages/mls-rpc/src/app-publication.ts`, `packages/mls-rpc/src/index.ts` |
| Worker retry and durable certification | `packages/rpc/src/log-delivery.ts`, `packages/rpc/src/peer.ts`, `packages/rpc/src/peer-epoch.ts` |
| Gate-retained settlement retry | `packages/mls-rpc/src/memory-group-ports.ts`, `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/owner-queue.ts` |
| Storage-only publication service and coordinator accounting | New `packages/mls-rpc/src/app-settlement.ts`, `entry-capability.ts`, `memory-group-persistence.ts`, `memory-group-state.ts`, `persistence-guards.ts`, `registry/retired.ts`, registry lifecycle integration |
| Plaintext handler reuse and drain tracking | New `packages/rpc/src/opened-delivery.ts`, `packages/rpc/src/app-lane.ts`, `packages/rpc/src/peer.ts`, `packages/rpc/src/peer-types.ts` |
| Storage-only pending completion | New `packages/mls-rpc/src/opened-delivery.ts`, `memory-incarnation-stores.ts` only for erasure guards |
| Lifecycle drain and visible status | `packages/mls-rpc/src/registry/{registry,retirement,retired,seed,switch,types}.ts`, `registry-peer.ts`, `successor.ts` |
| N3 source-bound attempt collection | `packages/mls-rpc/src/registry/switch.ts`, `registry/retired.ts`, `successor.ts` |
| Hub dedup including rpc doubles | `packages/hub-server/src/memoryStore.ts`, `packages/hub-protocol/src/types.ts`, `packages/hub-conformance/src/index.ts`, `packages/rpc/test/fixtures/{fake-hub,durable-fake-hub}.ts` |
| Shared persistence/publication witnesses | New `packages/rpc-conformance/src/app-publication.ts`, `persistence-fixture.ts`, `group-storage.ts`, `registry-fixture.ts`, `index.ts` |
| Rpc double migrations | `packages/rpc-conformance/src/{app-outbox,memory-app-outbox}.ts`, `packages/rpc/test/fixtures/{outbox,peer}.ts`, affected consumers found by typecheck |
| Assembled real/double fixtures | New `packages/mls-rpc/test/fixtures/app-publication.ts`, existing `fixtures/{registry,storage-persistence,registry-lease}.ts` |
| Behaviour tests | New `packages/rpc/test/app-entry.test.ts`, `packages/rpc/test/app-publication.test.ts`, `packages/rpc/test/opened-delivery.test.ts`, `packages/mls-rpc/test/{app-publication,app-settlement,opened-delivery,app-publication-conformance}.test.ts` |
| Existing regression tests | `packages/rpc/test/{peer-log-delivery,peer-control-settlement,peer-drained}.test.ts`, `packages/mls-rpc/test/{registry-retirement,registry-retirement-writes,registry-retired,registry-peer,registry-delete,manual-recovery-conformance}.test.ts` |
| Documentation and existing release intent | `packages/{rpc,mls-rpc}/README.md`, `.changeset/spec-p-storage-foundation.md`, `.changeset/version-band-0-11.md` only if its existing API summary needs alignment |

Mechanical fixture/type migrations may touch consumers named by the repo-wide typecheck.
Such edits preserve assertions and implement the same port contract. They do not widen product behaviour.

## Shared interface decisions

### Portable types and ownership

Task 1 moves the existing D6 shapes into rpc's `app-outbox.ts` as the portable owner.
Mls-rpc imports/re-exports aliases. Conformance independently mirrors them without importing implementation packages.
All listed fields are mandatory except the optional `outcome` parameter on `remove`.

```ts
export type AppAttempt = {
  incarnation: number
  epoch: number
  floor: string | null
  attempts: number
  publishID: string
  segment: number
  topicID: string
}
export type AppOutboxEntry = {
  seq: number
  protocol: string
  prc: string
  data: Uint8Array
  lastAttempt: AppAttempt | null
  status: 'accepted' | 'failed'
}
export type AppPublicationOutcome = {
  incarnation: number
  segment: number
  topicID: string
  position: string
}
export type AppSettlementObligation = {
  sequenceID: string
  attemptID: string
  topicID: string
  outcome: 'published'
}
export type AppSettlementExpected = {
  identity: EpochIdentity
  stateVersion: number
  attemptID: string
}
export type AppSettlementResult =
  | { recorded: true }
  | {
      recorded: false
      reason: 'identity-changed' | 'state-version-changed' | 'attempt-changed' | 'entry-missing'
    }
export type AppStatusEvent = GroupKey & { id: string; entry: AppOutboxEntry } & (
  | { kind: 'accepted' }
  | { kind: 'published'; occurrence: AppPublicationOutcome }
  | {
      kind: 'failed'
      reason: 'incarnation-abandoned' | 'removed' | 'deleted' | 'database-restored'
      nextIncarnation?: number
    }
)
export type AppOutbox = {
  put(entry: AppOutboxEntry): Promise<void>
  list(): Promise<Array<AppOutboxEntry>>
  recordSettlement(seq: number, obligation: AppSettlementObligation, expected: AppSettlementExpected): Promise<AppSettlementResult>
  loadSettlement(seq: number): Promise<AppSettlementObligation | null>
  remove(seq: number, outcome?: AppPublicationOutcome): Promise<void>
  clear(): Promise<void>
  events(): Promise<Array<AppStatusEvent>>
  ackEvent(id: string): Promise<void>
}
```

`EpochIdentity` and `GroupKey` already belong to rpc's control types.
`segment` remains the persisted field name for authenticated anchor epoch. Do not introduce a second persisted anchor field.
`sequenceID` is the hub acceptance position. `attemptID` equals that attempt's `publishID`.

### New preparation port

Task 1 Cycle B adds this portable port. It is mandatory with the durable MLS outbox, never an optional fallback to unsafe wrapping.
Non-MLS peers retain their existing construction shape.

```ts
export type AppPublicationSnapshot = {
  identity: EpochIdentity
  stateVersion: number
  sealVersion: number
  segment: number
  topicID: string
}
export type PreparedAppPublication = {
  entry: AppOutboxEntry
  payload: Uint8Array
  snapshot: AppPublicationSnapshot
}
export type AppPublicationPort = {
  prepare(entry: AppOutboxEntry, floor: string | null): Promise<PreparedAppPublication>
  snapshot(protocol: string): Promise<AppPublicationSnapshot | null>
}
```

The registry derives topicID/AAD from its committed anchor and `entry.protocol`.
Hosts cannot inject an incarnation, identity, topic or lease. `floor` is retry/proof bookkeeping, never acceptance authority.
The returned payload has crossed the attempt transaction's commit proof. No payload is persisted.

`sealVersion` is a process-local monotone seal frontier. It changes on a newly sealed frame, identity replacement or uncertainty.
It is not an MLS state version and creates no persisted format.
`snapshot()` returns null during unresolved completion, unavailable state or anchor repair.
Snapshot byte arrays are defensive copies.

### Drain and finalisation boundaries

Task 3 adds:

```ts
export function finaliseAppSettlements<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): Promise<void>
```

It serves the exact key, active or retired. It performs no transport publication.
"Publication" here means committing the published status and effects for an already certified occurrence.

Task 4 adds:

```ts
export function drainStoredOpened<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
  deliver(record: PendingAppFrame): Promise<void>
  openedDeliveryContext: OpenedDeliveryContext
}): Promise<void>
```

This mls-rpc function consumes the richer persisted `PendingAppFrame`, including epoch and idempotencyKey.
It never changes that record's shape. Rpc's existing smaller frame type remains until 2.3d.

Task 4 adds `Peer.drainOpened(): Promise<void>`.
Task 5 adds `GroupHandleRegistry.drainOpened(key: GroupKey): Promise<void>` and the optional factory callback
`deliverOpened?: (record: PendingAppFrame) => Promise<void>`.
An absent callback with pending records blocks visibly. It never acknowledges an unknown protocol.
Task 4 also defines `openedDeliveryContext` and `OpenedDeliveryReentryError` for drain-enabled peer/registry factories.
Use an async delivery token separate from the D8 owner token; D8's supplied/absent context matrix remains unchanged.

## Verification commands and gates

Run none of these during drafting. Implementation uses bounded worker counts and no load tests.
Run builds before cross-package tests because several runners consume package exports.

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
    test/ownership-phases-conformance.test.ts test/safety-conformance.test.ts \
    test/control-consumption-conformance.test.ts test/registry-crypto-conformance.test.ts \
    test/registry-lease-conformance.test.ts test/app-publication-conformance.test.ts &&
  ktest @kumiai/rpc test/ports-conformance.test.ts test/hub-conformance.test.ts &&
  ktest @kumiai/hub-server test/conformance.test.ts test/log-hub-conformance.test.ts &&
  ktest @kumiai/hub-tunnel test/hub-conformance.test.ts &&
  ktest @kumiai/integration-tests test/hub-log-conformance.test.ts
}
kfinish() { ktypes && rtk proxy pnpm run lint; }
```

Task 1 creates `app-publication-conformance.test.ts` before the first full port gate.
Expected GREEN: every selected test passes. No meaningful new row is skipped. Every type task succeeds, with `Cached: 0` under `--force`.
Hub-conformance has no standalone `test:unit`. Run its store/log/view wrappers above.

For each changed public type, run repo-wide `rtk proxy pnpm exec turbo run test:types`, not just package typechecks.
Every changed port runs both contract families against real implementations and every affected double before its commit.
New persistence rows run real-MLS/double × supplied/absent ownership context.
SQL/provider fault evidence remains phase 3; SQL publish-ID parity row S:2842 is a mandatory Task 7 gate in this phase. If a wrapper skips a required backend, report BLOCKED rather than claiming that backend passed.

Every guard test needs a mutation check before its owning commit.
Break one guard, run its named witness and require assertion failure, then restore the guard and rerun GREEN.
Compilation failure is not mutation evidence. Record the failing assertion in implementation handoff notes.
Never leave mutations, `test.fails`, focused `.only` or removed meaningful assertions behind.

Every task follows RED -> minimal implementation -> GREEN -> applicable port/type gates -> commit.
Use ordinary signed commits with hooks. Do not bypass hooks or change git configuration.

## Tasks

### Task 0: Apply the reviewed Spec P r28i amendment

**Files:**

- Modify (future implementation only): `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md`.
- Read: [exact r28i replacement text](../../../.superpowers/sdd/plan-2-3c-draft/spec-r28i-draft.md), `rulings-r1.md` R1-R2 and `questions.md` final decision.

**Interfaces:** Consumes Q2-B/R1; produces the normative r28i contract Task 8 implements. No source API or persisted format changes.

- [ ] **Step 1: Apply the draft's baseline-numbered replacements and History entry.** Use textual anchors or descending ranges so earlier edits cannot shift later targets. Do not copy the amendment into this plan.
- [ ] **Step 2: Review documentation consistency.** Confirm failed own/foreign copies are coverage-only; authenticated refusal/consumption, local failure identity, old-row defaults and coverage-dependent Welcome concession remain distinct. Search current normative prose/comment/rows for obsolete failed-own-copy bans and foreign-copy stranding. Historical r28h entries remain historical. No test suite is needed for this doc-only task.
- [ ] **Step 3: Commit only the spec amendment.** `git commit -m 'docs: amend Spec P r28i delivered-copy and recovery authority'`. Do not mix implementation into this commit. Task 8 now has its normative prerequisite.

### Task 1: Wire durable application contracts, atomic preparation and prepared retries

This is one atomic public API cutover, with three focused TDD cycles and one final commit.
The reduced rpc attempt type cannot be removed independently of its producer and peer adapter.
Do not add optional fields, fabricated IDs, unsafe casts or temporary permissive adapters to split this task.
The Files and Interfaces blocks in cycles A-C together define this task's complete scope.

#### Cycle A: Contracts and immutable plaintext

**Files:**

- Modify: `packages/rpc/src/app-outbox.ts:13-35,120-136`, `packages/rpc/src/index.ts`, `packages/rpc/src/testing.ts`.
- Create: `packages/rpc/src/app-entry.ts`, `packages/rpc/test/app-entry.test.ts`.
- Modify: `packages/mls-rpc/src/persistence-types.ts:395-464`, `packages/mls-rpc/src/index.ts`.
- Modify: `packages/rpc-conformance/src/{persistence-fixture,app-outbox,memory-app-outbox}.ts`.
- Modify: `packages/rpc/test/fixtures/{outbox,peer}.ts` and mechanically affected typed consumers.
- Test: `packages/rpc/test/peer-outbox-dispatch.test.ts`, shared outbox storage rows.

**Interfaces:**

- Consumes: existing `EpochIdentity`, `GroupKey`, `InvalidAppEntryError`, broadcast `decodeFrame` and the v2 event encoding.
- Produces: all portable outbox signatures in Shared interface decisions.
- Produces: `decodeAppEntry(entry: AppOutboxEntry): { procedure: string; payload: unknown }`.
- Preserves: `AppOutboxAcceptance.accept(input: Pick<AppOutboxEntry, 'protocol' | 'prc' | 'data'>): Promise<void>`.
- Changes conformance double factory to `createMemoryAppOutbox(params: { key: ConformanceGroupKey; snapshot(): {identity: ConformanceEpochIdentity; stateVersion: number} | null }): MemoryAppOutbox`.
- Preserves its test fault method `failNextPut(): void`. Callers supply their actual model identity/version, never placeholders.

- [ ] **Step 1: Add failing decoder and contract witnesses.**

| Test name | Assertions |
| --- | --- |
| `acceptance validates a broadcast v2 log event before writing` | A valid encoded `posted` event produces `{procedure: entry.prc, payload: data}`. Acceptance persists status `accepted` before resolving. |
| `absent event data decodes to an empty object` | Missing or null data returns `{}`. Existing false/zero/string data is retained through `??`, not replaced. |
| `invalid app plaintext never reaches storage` | Invalid UTF-8, malformed JSON, unsupported broadcast version, non-event type and mismatched procedure throw `InvalidAppEntryError`. Outbox, events, markers and host effects remain unchanged. |
| `outbox values cannot mutate stored plaintext or an obligated attempt` | Mutating input/listed byte arrays changes no stored value. Replacing protocol, prc or data rejects. An obligated attempt rejects any differing replacement. |
| `unknown remove and event acknowledgement are harmless` | Repeated remove/ack adds no event or effect. App ack cannot delete a safety event. |

Typecheck fixtures with every mandatory field. Do not make `recordSettlement`, status or events optional to preserve old doubles.

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/app-entry.test.ts test/peer-outbox-dispatch.test.ts`.
Expected RED: missing decoder or accepted invalid input. Retain the exact failing assertion.
Cycles A-C share one cutover. Complete their source migration before requiring repo-wide type GREEN.

- [ ] **Step 3: Implement the portable contract and decoder.**

Use fatal UTF-8 decoding, existing broadcast parsing and event/procedure validation before `outbox.put`.
Mls-rpc aliases the portable types. The conformance mirror remains independent.
Acceptance loads only unresolved accepted entries for publication. Failed entries remain available through their status events.
Implement the double's full guard semantics and event/settlement behaviour, rather than returning unconditional success.
Its snapshot reader observes the caller's current memory MLS model. Null or mismatched state refuses certification.
Serialize double operations so its positive certification has the same acquired-gate meaning as the real facade.

- [ ] **Step 4: Verify the cycle and mutate.**

Run Cycle A's decoder/contract tests GREEN after implementing the complete cutover below.
Mutate fatal UTF-8 handling and procedure comparison separately. Require each named invalid-input assertion to fail.
Keep all cycle changes uncommitted until Cycle C's integration and repo-wide type gates pass.

#### Cycle B: Attempt/state/lease composition

**Files:**

- Create: `packages/rpc/src/app-publication.ts`, `packages/mls-rpc/src/app-publication.ts`, `packages/mls-rpc/src/registry/app-publication.ts`.
- Modify: `packages/rpc/src/{peer-types,index}.ts`, `packages/mls-rpc/src/registry/{live-send,access,types,registry}.ts`, both package barrels.
- Create: `packages/mls-rpc/test/{app-publication,app-publication-conformance}.test.ts`, `packages/mls-rpc/test/fixtures/app-publication.ts`.
- Create: `packages/rpc-conformance/src/app-publication.ts`. Modify its `index.ts` and independent fixture mirrors.

**Interfaces:**

- Consumes: Task 1 types, `reserveFromBytes(environment, record, floor)` at `registry/reserve.ts:115`, existing private live-send accounting/run hooks.
- Produces: `AppPublicationPort`, `AppPublicationSnapshot`, `PreparedAppPublication` from Shared interface decisions.
- Produces registry methods: `preparePublication(entry: AppOutboxEntry, floor: string | null): Promise<PreparedAppPublication>` and `publicationSnapshot(protocol: string): Promise<AppPublicationSnapshot | null>`.
- Produces adapter: `createRegistryAppPublication(access: RegistryHandleAccess): AppPublicationPort`.
- Adds to durable `GroupPeerMLSParams`: `appPublication: AppPublicationPort`.
- Produces independent suite: `testAppPublicationConformance(params: { label: string; createFixture(): Promise<AppPublicationFixture> }): void`.

The suite owns independent `ConformanceAppPublicationPort`, snapshot and prepared-value mirrors of the signatures above.
Its exact fixture contract is:

```ts
export type AppPublicationFixture = {
  key: ConformanceGroupKey
  publication: ConformanceAppPublicationPort
  outbox: ConformanceAppOutbox
  state(): Promise<{
    snapshot: ConformanceAppPublicationSnapshot | null
    senderHWM: number
    storedGeneration: number
    stateBytes: Uint8Array
  }>
  rows(): Promise<Array<{ namespace: string; key: string; value: Uint8Array }>>
  gateNext(stage: 'prepare' | 'before-commit' | 'after-commit' | 'proof'): {
    entered: Promise<void>
    release(): void
  }
  failNext(stage: 'seal' | 'attempt' | 'certification' | 'remove' | 'effect', outcome: 'rollback' | 'unknown-commit' | 'unknown-rollback'): void
  change(kind: 'version' | 'attempt' | 'epoch' | 'incarnation' | 'anchor'): Promise<void>
  counts(): { seals: number; transactions: number; publishes: number; effects: number }
  reopen(): Promise<AppPublicationFixture>
  close(): Promise<void>
}
```

`ConformanceGroupKey` and full outbox mirrors use the existing conformance type owner, without implementation imports.
The production adapter wraps `createRegistryFixture`/`createStorageFixture`, not replacement crypto.
`change('epoch'|'incarnation'|'anchor')` performs genuine fixture adoption/switches. It cannot bypass source guards.
For the authenticator-only refusal, construct a real split branch at the same epoch and pass its authenticator as the captured **expected** snapshot to `recordSettlement`.
Keep the installed incarnation, epoch, stateVersion, attempt, topic and sealVersion unchanged. Never install the split branch in place or switch incarnation for this witness.
For worker pre/post-snapshot tests, vary only the captured expected authenticator through the test port wrapper, using that real branch value; storage remains genuine.
Fault and gate helpers instrument the existing test provider. They never become product configuration.
Keep control-specific deferred promises in the owning test instead of expanding this fixture with untyped callbacks.

- [ ] **Step 1: Add failing atomicity witnesses in both modes.**

| Test name | Assertions |
| --- | --- |
| `attempt and required lease state commit before payload release` | Suspend outcome before proof. No returned payload or transport call occurs. Commit reveals one attempted entry, exact topicID, new publishID and matching incarnation/epoch. Rollback reveals neither attempt nor new reservation. |
| `refill and attempt share one mutation and one owner entry` | Position the send copy below 4 remaining. Suspend its independent maintenance with the existing fixture gate. Preparation combines required renewal/state and attempt writes in one transition. Host effects see the same mutation. |
| `a committed range is reused without a per-message lease burn` | Send several durable entries from a warmed range. Generations are unique and below the committed limit. Preparing each entry does not allocate another 16-generation range. |
| `prepare refuses moved identity and anchor` | Queue preparation behind genuine epoch/incarnation or anchor-topic movement; test authenticator mismatch via captured expectation as above. No old payload escapes or mismatched attempt is written. |
| `preparation rejects an obligated entry before seal or put` | Certify the entry first, then instrument the real seal and `outbox.put` to count attempted calls. Preparation refuses with both counts zero and unchanged obligation. Do not weaken the existing put guard; its later refusal cannot mask this assertion. |
| `publication accounting finishes before owner acquisition` | Suspend accounting at a required group read, with the owner slot initially free. That read must finish before preparation takes the owner; then sealing and the short transaction finish. No recursive root `seal` is invoked. |
| `ambiguous preparation releases no payload before proof` | Late commit returns the saved attempt once. Late rollback exposes no prepared frame. Marker conflict fail-stops with no payload. |
| `ephemeral seal does not acquire a publication transaction` | Existing warmed ephemeral tests still observe zero provider transactions and zero outbox writes. |

Use real-MLS/double × supplied/absent ownership context. Inspect persisted encrypted rows after `reopen()`.
Extend the fixture with typed defer/fault controls, following existing registry-lease/storage fixtures.

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/mls-rpc test/app-publication.test.ts test/app-publication-conformance.test.ts`.
Expected: missing adapter or attempt/state not sharing a proven transaction.

- [ ] **Step 3: Implement registry preparation.**

Keep live-send accounting outside entry acquisition. Never call the root `access.seal()` recursively from `capability.run`.
Extend the private live sender with a preparation path that snapshots its committed range and serialises the seal against other send use.
Generate one publishID for that prepared frame. Derive topic/AAD from the captured committed anchor and entry protocol.
Prepare crypto outside storage under the owner slot. Work revalidates state, admission, immutable entry and absence of settlement.
Co-write the full attempt with every state/lease change required by this attempt.
An already committed, sufficient lease needs no additional generation reservation. Preserve its advanced durable state and validate its ceiling in the attempt transaction.
When renewal is required, compose `reserveFromBytes` and the attempt write through the existing live-send proof funnel.
Keep copy-limit publication behind commit proof. A failed seal/save wastes its consumed generation and releases no ciphertext.
Copy returned values and bind the snapshot to the committed state version and process seal frontier.

The new helper must preserve remaining send-copy headroom. A fresh 16-generation reservation for every log seal is prohibited.
Do not save the private send copy's lower ratchet over the advanced committed lease state.

- [ ] **Step 4: Verify and mutate.**

Run Cycle B's publication tests and registry lease/crypto tests GREEN.
Remove the commit-proof release fence: `attempt and required lease state commit before payload release` must fail.
Remove the preparation obligated-entry check, retaining `outbox.put`'s guard: `preparation rejects an obligated entry before seal or put` must fail its zero-call assertion.
Move accounting inside the owner entry: `publication accounting finishes before owner acquisition` must fail the asserted read/acquisition order (use gates, not a hung test).
Remove the state-version comparison: the queued version-move refusal must fail with a changed row or released payload.
Keep these changes uncommitted until Cycle C completes.

#### Cycle C: Prepared retries and active reconstruction

**Files:**

- Modify: `packages/rpc/src/log-delivery.ts:24-44,158-200`, `packages/rpc/src/peer.ts:895-1041`, `packages/rpc/src/peer-epoch.ts:355-379` only where log preparation is separated.
- Create: `packages/rpc/test/app-publication.test.ts`.
- Modify: `packages/rpc/test/peer-log-delivery.test.ts`, durable peer fixture factories and assembled mls-rpc publication tests.

**Interfaces:**

- Consumes: Task 1 `AppPublicationPort.prepare` and `.snapshot`, Task 1 full outbox.
- Changes `LogDeliveryParams.prepare(entry: AppOutboxEntry, floor: string | null): Promise<PreparedAppPublication>`.
- Changes `LogDeliveryParams.publish(frame: { topicID: string; payload: Uint8Array; publishID: string }): Promise<{ sequenceID: string }> | null`.
- Produces: worker-owned prepared-frame cache keyed by seq and exact attempt publishID.
- Preserves: `trigger(): void`, `beginWalk(): number`, `removed(): void`, `close(): void` until Task 3 adds drain semantics.

- [ ] **Step 1: Add failing retry/restart tests.**

| Test name | Assertions |
| --- | --- |
| `failed and null handoff retry the same prepared bytes and ID` | Fail one handoff, refuse the next with null, then accept. All submitted bytes/topicID/publishID match. Prepare and attempt update happen once. |
| `head-only movement keeps prepared app bytes` | Change only commit head. Repeat handoff uses identical bytes/ID. No extra seal or attempt counter increment. |
| `identity or anchor movement invalidates an unproven prepared frame` | Change epoch, same-number authenticator, or anchor topic. Old prepared bytes never hand off again. Fresh frame uses a new ID and the new stored topic. |
| `active reconstruction reseals unproven plaintext under a new ID` | Reconstruct after attempted publication without obligation. Reuse immutable plaintext, increment attempts, use fresh bytes/ID. |
| `retired reconstruction never reseals an old entry` | Retire before retry. Observe no prepare/wrap/publish call for the source. Only owed finalisation is eligible. |
| `a frame sealed below 500 can still hand off` | Admission becomes `rotation-required` after sealing. Existing prepared frame still hands off. New durable acceptance refuses. Other safety holds prevent handoff. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/app-publication.test.ts test/peer-log-delivery.test.ts`.
Expected: retry seals again or omits publishID. Preserve existing per-sender queue-order assertions.

- [ ] **Step 3: Implement the prepared-frame cache.**

Replace separate worker seal/put with the Task 1 preparation result.
Retain that exact prepared object after rejected/null transport handoff.
Never persist ciphertext or accept a hub hint as proof. Do not convert CAS/head movement into a reseal trigger.
Invalidate only on identity/authenticator or anchor-topic change, definitive attempt replacement, retirement or disposal.
A version-only progress write does not by itself require resealing. It does require fresh proof snapshots in Task 2.
On restart, inspect obligations before preparing. Task 3 owns those obligations.
Continue carrying rejoin resend-window behaviour only for eligible current-incarnation plaintext, through the same preparation boundary.
Do not resurrect the unjournalled `seq: -1` publication route.

- [ ] **Step 4: Verify and mutate.**

Run all three cycles GREEN, assembled mls-rpc publication tests, `kbuild`, `kports`, `kfinish`.
Mutate prepared-cache retention and topic/authenticator invalidation separately. Require failures in their named witnesses.

- [ ] **Step 5: Commit.**

Stage all three cycles and their mechanical consumer migrations.
Run `git commit -m 'feat(rpc,mls-rpc): prepare and retry durable app publications'`.

### Task 2: Persist both publication proof paths under the acquired gate

**Files:**

- Modify: `packages/rpc/src/log-delivery.ts:97-101,210-223`, `packages/rpc/src/peer.ts:1915,1956-1976`.
- Modify: `packages/mls-rpc/src/memory-group-ports.ts:144-186`, `packages/mls-rpc/src/memory-group-persistence.ts:1485-1507`, `packages/mls-rpc/src/owner-queue.ts`.
- Test: `packages/mls-rpc/test/ownership-phases-conformance.test.ts` for retry-attempt capability expiry.
- Modify: `packages/rpc-conformance/src/{app-publication,group-storage,persistence-fixture}.ts` and stricter memory outbox implementation.
- Test: `packages/rpc/test/app-publication.test.ts`, `packages/mls-rpc/test/app-publication{,-conformance}.test.ts`.

**Interfaces:**

- Consumes: full `AppOutbox.recordSettlement`, `AppPublicationPort.snapshot(protocol)`, exact transport `{sequenceID}`.
- Changes worker `certify(epoch: number, started: number): Promise<void>`. Every caller awaits it.
- Preserves `beginWalk(): number` as the acknowledgement cutoff captured before the walk.
- Produces: durable `recordSettlement` success before any in-memory proven mark or removal.
- Extends private `MemoryGroupAccess.write` options with `retryOnRollback?: boolean`, default false.
- Adds private `OwnerEntry.retryRolledBack(): Promise<void>` to start another attempt without releasing its owner slot.
- Preserves public `AppSettlementExpected` and `AppSettlementResult` exactly. No new provider primitive.

- [ ] **Step 1: Add the two-path/order matrix.**

Parameterise by proof path `no-new-head` / `covered-walk` and owner acquisition order `certification-first` / `adoption-first`.

| Test name | Assertions |
| --- | --- |
| `both proof paths persist an obligation before freezing proof` | Store exact ack sequenceID, attempt publishID, sealed topicID and `published`. Suspend that commit: no removal, published event, effect or proven mark yet. |
| `late acknowledgement cannot certify a replacement attempt` | Delay ack, then replace identity or attempt. No obligation for replacement. |
| `same-epoch expected authenticator alone refuses certification` | Capture expected authenticator from a real split branch. Installed key/epoch/version/attempt/topic/sealVersion stay unchanged; expect `identity-changed` and no marker/event/hook/obligation. Positive control uses the installed authenticator. |
| `adoption-first certification changes no row or hook` | Capture expected before queueing. Move identity first. Expect `{recorded:false,reason:'identity-changed'}` and byte-identical marker/events/obligations/hooks. |
| `version-only and attempt-only changes refuse certification` | Version move returns `state-version-changed`. Attempt move or topic mismatch returns `attempt-changed`. Missing entry returns `entry-missing`. No writes occur. |
| `certification-first retirement preserves the certified occurrence` | Queue retirement behind the proof entry. Once committed, retirement preserves the obligation and cannot emit failed for that entry. |
| `certification rollback keeps retirement behind its retry` | First COMMIT proves rollback. Keep the entry's owner slot, back off and rerun work. A queued retirement cannot pass. Commit retry persists proof. A changed expected value returns the exact false reason. |
| `crossed walk cannot certify` | Advance only sealVersion (then separately identity) during walk/probe; no proof freezes. |
| `acknowledgement after walk cutoff cannot certify unchanged state` | Keep identity/stateVersion/sealVersion/attempt/topic and both snapshots byte-identical. Capture `started`, then deliver the ack. Neither proof path certifies in that window; a fresh window that includes the ack succeeds. |
| `transactional settlement effects refuse root reentry` | In a published effect, attempt root store/peer entry: synchronous reentry rejects; with supplied async ownershipContext, reentry after an await also rejects under D8's typed phase error. Entry-bound side-row work remains valid. No callback is placed under commitTail that awaits that same tail. |
| `uncertain snapshots cannot certify` | Snapshot returns null during storage ambiguity. Both proof paths leave all evidence unchanged and retry after proof. |
| `duplicate settlement is idempotent and conflicting position rejects` | Exact repeat returns recorded true with no marker change. Different sequenceID/outcome for the same obligation rejects and leaves rows unchanged. |

Keep calibrated positive controls for each refusal. A test with no actual publication cannot prove ack fencing.
For worker-side snapshot refusal variants of `late acknowledgement cannot certify a replacement attempt`, `same-epoch expected authenticator alone refuses certification`, `version-only and attempt-only changes refuse certification`, `crossed walk cannot certify` and `uncertain snapshots cannot certify`, spy on the genuine outbox and assert zero `recordSettlement` calls in both proof paths. Keep separate direct-storage refusal/reason assertions; storage rejection must not mask a removed worker comparison.

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/app-publication.test.ts` and the mls-rpc publication/conformance files.
Expected: volatile proof, missing pre/post fence, or queued retirement passes a rollback retry.

- [ ] **Step 3: Implement awaited durable certification.**

Capture defensive identity/stateVersion/attempt and worker ack cutoff before queueing certification.
Capture snapshots around sealing and each proof-producing probe/walk. Compare identity, stateVersion, sealVersion and topic/segment.
The no-new-head fast path requires the same snapshot and that attempt's acknowledged publication.
The walk path additionally requires covered authenticated applied state and acknowledgement at or before its captured cutoff.
Call `recordSettlement` and await commit proof. Only `{recorded:true}` freezes proof and enables finalisation.
On a false result, discard that proof window and re-evaluate. It does not imply non-publication or permit retiring saved work.
Do not manufacture a proof position from the commit head. The app occurrence uses its publish acknowledgement's sequenceID.

Keep the facade's existing inside-gate checks at `memory-group-ports.ts:153-183`.
Set private `retryOnRollback: true` only for `recordSettlement`.
Use `retryRolledBack()` only after rollback and its hook queue are proven settled.
It retains the FIFO slot, revokes the old attempt, resets the phase to work and opens a fresh transaction.
Re-run the facade check and work with the same captured expected values. Existing false-result checks end the entry without mutation.
Back off outside provider transactions, retaining ownership. Do not call the root facade again for that retry.
Add a stale-attempt capability witness alongside the Review Focus test. Old stores must reject after retry starts.
Ambiguity resolves in the original owner entry. Marker conflict still fail-stops the factory.

- [ ] **Step 4: Verify and mutate.**

Run the matrix GREEN, `kbuild`, `kports`, `kfinish`.
Mutate identity, stateVersion, attempt/topic, sealVersion, cutoff and retained-retry guards individually.
Require a specific assertion failure for every guard. Remove each worker identity/authenticator/stateVersion/sealVersion/topic comparison or null-snapshot guard separately, retaining all storage guards: the matching worker witness must fail its zero-`recordSettlement`-calls assertion. In particular, remove only storage authenticator equality: the direct-storage variant of `same-epoch expected authenticator alone refuses certification` must fail; remove only acknowledgement cutoff: `acknowledgement after walk cutoff cannot certify unchanged state` must fail.
Remove effect-phase root reentry refusal: `transactional settlement effects refuse root reentry` must fail its typed rejection assertion (assert before allowing a cyclic wait). Async-after-await detection uses supplied context; the absent-context D8 mode keeps its existing synchronous guarantee.
An unchanged false reason is not sufficient if a marker was written.

- [ ] **Step 5: Commit.**

Run `git commit -m 'feat(rpc): certify app publication through durable gate-checked obligations'`.

### Task 3: Finalise frozen publications and replay committed bookkeeping

**Files:**

- Create: `packages/mls-rpc/src/app-settlement.ts`, `packages/mls-rpc/test/app-settlement.test.ts`.
- Modify: `packages/rpc/src/log-delivery.ts`, `packages/rpc/src/peer.ts:1030-1036,2875-2902,5342-5354,5561-5567,5750-5777`.
- Modify: `packages/mls-rpc/src/{entry-capability,memory-group-persistence,memory-group-state,persistence-guards}.ts` for the narrowly scoped state-independent coordinator path.
- Modify: `packages/mls-rpc/src/registry/retired.ts` for service exports and `packages/mls-rpc/src/registry/registry.ts` for per-key startup ordering.
- Test: `packages/rpc/test/{peer-log-delivery,peer-control-settlement,peer-drained}.test.ts`, assembled publication conformance.

**Interfaces:**

- Consumes: exact-key outbox/obligation/event records and full Task 1 types; ordinary root `outbox.remove` is insufficient.
- Adds private `EntryCapability.finaliseCertifiedApp(key: GroupKey, seq: number): Promise<void>`; it owns the complete certified transition, not an arbitrary caller-supplied work closure. Real coordinator and independent persistence double implement the same restricted semantics.
- Produces: `finaliseAppSettlements<TTx>(params: {persistence: GroupPersistence<TTx>; key: GroupKey}): Promise<void>`.
- Adds worker `drained(): Promise<void>` that joins submitted certification/finalisation after `close()` stops new work.
- Preserves: existing `serveRetiredObligations`, `listRetiredOutcomes`, `ackRetiredOutcome` and immutable control outcomes.

- [ ] **Step 1: Add frozen reconstruction and O4 witnesses.**

| Test name | Assertions |
| --- | --- |
| `held reconstruction finalises only persisted publication obligations` | Commit certification, fail removal, dispose and reconstruct. Under each hold below, produce exactly one published status/effect with original incarnation/segment/topicID/position. No prepare, seal, decrypt, probe, subscription, recovery or transport publish occurs. An unproven sibling remains unresolved. |
| `corrupt source state cannot block certified finalisation` | After certification, corrupt only the source state envelope; keep lifetime/state-version metadata/outbox/obligation/event records readable. Reconstruct active, terminal and retired service under every hold below. Assert the at-rest codec never opens the `state` namespace, source state bytes stay identical, and exactly one original published event/effect plus atomic co-deletion commits. An unproven sibling stays unresolved. Subscribe an observer so accounting/notification also exercise the path. |
| `certified finalisation advances metadata CAS without rewriting state` | With a healthy envelope, finalise, reopen and perform a normal state CAS using the advanced administrative version. The original envelope stays byte-identical until that normal write; stale pre-finalisation CAS refuses. |
| `certified finalisation cannot widen into another transition` | Try uncertified seq, conflicting attempt/topic, restore-pending source, and reserved-namespace writes from an effect. Each refuses without marker/event/version/effect changes; opaque entry-bound host side rows remain legal. |
| `blocked startup finalisation in group A does not block group B admission` | Seed certified debt in A and B before registry reconstruction. Suspend A's startup finalisation COMMIT, then admit/send in B through the actual startup service: B finishes its own finalisation and proceeds while A admission remains pending. Release/prove A and assert its admission then proceeds. No direct-persistence shortcut. |
| `retired finalisation needs no registry access or old peer` | Switch to n+1 and reconstruct. Service n through its key. No `registry.access` or `createPeer` invocation for n. Current state/trust/lease/anchor remain unchanged. |
| `removal effect and obligation deletion commit together` | Throw from transactional outbox effect. Entry/obligation/events/effect all roll back. On retry commit exactly one effect and published event, then co-delete entry/obligation. |
| `disposal retains submitted settlement completion` | Dispose during certification/finalisation ambiguity. `drained()` stays pending until owner proof and hooks settle. No late unproven handoff occurs. |
| `post-apply latch reconstructs committed control bookkeeping` | Pause after the consuming adoption commit but before runtime notification/head update. Latch safety, dispose, reconstruct. Replay the stored outcome/cursor/Welcome obligation without another adoption, closure or publication. Acked provisional unknown cannot delete the final outcome. |
| `backup-restored entries do not use the ordinary finalisation exemption` | Mark restore pending. Service refuses/defer before publishing status. It leaves entries/obligations for 2.3e's database-restored transition. |

Allowed hold matrix: `fork-halted`, `recovery-unavailable`, `spent-set-corrupt`, existing legacy control hold, revoke hold and `rotation-required`.
Also cover terminal and retired source keys. In the corrupt-state witness, cross the full hold matrix with that corrupt envelope rather than relying on healthy state plus a flag. The service opens only sealed administrative lifetime/version and outbox/meta records, never the MLS state envelope.
Wrong codec/AAD and factory fail-stop still refuse. They are not safety-gate exemptions.

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/mls-rpc test/app-settlement.test.ts` and the named rpc tests.
Expected: no frozen proof after reconstruction, omitted occurrence, or premature disposal drain.

- [ ] **Step 3: Implement storage-only finalisation and startup ordering.**

List the exact key's entries and obligations before enabling active sends, terminal clearing or lifecycle completion.
For each obligation, require its saved attempt ID/topic/incarnation and build the occurrence from that attempt plus `sequenceID`.
Invoke `EntryCapability.finaliseCertifiedApp(key, seq)`, which rereads and validates that exact obligation/attempt under the acquired owner before writing the original published event, running its transactional effect and co-deleting entry/obligation. Reuse the storage occurrence checks, not the ordinary root remove/accounting route.
The coordinator must bypass `loadAffectedState` in BOTH work and effect accounting for this narrow transition, and skip state opening in observation capture as well. Keep D8 lifetime revision, owner marker, proof, rollback/ambiguity and hook ordering.
Add `stateStatus: 'unobserved'` to `AccountedGroupObservation` for this administrative observation. Consumers invalidate version-dependent snapshots without interpreting an omitted state open as missing/unreadable state or creating a new hold.
Advance the sealed administrative state-version metadata without reading or rewriting the state envelope. Make subsequent readable state load/save CAS use that metadata version (project it on the record); update `memory-group-state.ts` and version guards together so no stale envelope version can pass a later CAS.
Restrict this path to validated certified outbox/meta finalisation and entry-bound host side rows; reject other reserved-namespace writes, new certification, restore-pending work and generic mutation callbacks. It must not become a general no-state mutation bypass.
Never call `recordSettlement`, reseal, fetch or republish from the finaliser.
Retry failures through the existing D8 owner mechanism. Keep outstanding finalisation joinable after peer disposal.
Registry storage service works without loading MLS state or trusting an active-incarnation replacement.
At startup, enumerate incarnations from each sealed lifetime and resume certified finalisation for every originating key.
Join that group's initial finalisation before its active sends or clearing. Do not wait on another group's service before admitting this group.
Retired services run without creating retired peers. A failed finaliser retains debt and retries on the same coordinator.

Enumerated exemption: already-certified app status/effect finalisation; already-persisted opened plaintext delivery and its exact-key completion; existing outcome/event replay/ack; and proven Welcome delivery remain serviceable under holds.
This permits no new opens, certification, app seals, control build/adoption/publication, automatic recovery or active transport.
Restore-pending/device restore ordering and provider fail-stop take precedence over that exemption.

Reuse `refreshControl` outcome replay for O4. Do not reconstruct an obsolete accepted-stage operation or rerun adoption from a hub ack.
Restore the in-memory reconciled head from the durable cursor when ordinary walking later resumes.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN, frozen conformance rows, `kbuild`, `kports`, `kfinish`.
Mutate persisted-obligation filtering, original-topic use, co-deletion and disposal join separately.
Replace per-group startup joins with one global finalisation wait: `blocked startup finalisation in group A does not block group B admission` must fail its B-admission-before-A-release assertion.
Restore ordinary state-opening/accounting for certified removal (including either accounting loop or observation capture): `corrupt source state cannot block certified finalisation` must fail its no-state-open assertion and finalisation result.
Remove the restricted-path obligation/namespace or restore checks: `certified finalisation cannot widen into another transition` must fail the corresponding no-write assertion.
Remove metadata version advancement or the subsequent load/save projection: `certified finalisation advances metadata CAS without rewriting state` must fail its CAS/version assertion.
The O4 test is a regression guard if the implementation already passes; remove pre-hold durable outcome replay and `post-apply latch reconstructs committed control bookkeeping` must fail.

- [ ] **Step 5: Commit.**

Run `git commit -m 'feat(mls-rpc): finalise frozen app publications without a live peer'`.

### Task 4: Drain persisted opened plaintext without crypto or a live peer

**Files:**

- Create: `packages/rpc/src/opened-delivery.ts`, `packages/rpc/test/opened-delivery.test.ts`.
- Create: `packages/mls-rpc/src/opened-delivery.ts`, `packages/mls-rpc/test/opened-delivery.test.ts`.
- Modify: `packages/rpc/src/app-lane.ts:785-889,1355-1395`, `packages/rpc/src/peer.ts:5316-5354,5750-5782`, `packages/rpc/src/{peer-types,index}.ts`.
- Modify: `packages/mls-rpc/src/index.ts`, `registry/{app-open,types}.ts`, `registry-peer.ts` for completion handoff/context plumbing, and test fixture adapters.

**Interfaces:**

- Consumes: persisted `PendingAppFrame`, existing `PendingAppFrames.list/complete`, original stable frame IDs and idempotencyKey.
- Produces: `drainStoredOpened<TTx>(params: {persistence: GroupPersistence<TTx>; key: GroupKey; deliver(record: PendingAppFrame): Promise<void>; openedDeliveryContext: OpenedDeliveryContext}): Promise<void>`.
- Adds `Peer.drainOpened(): Promise<void>`. It stops new opens and waits for every already admitted handler/completion.
- Adds exported `OpenedDeliveryReentryError extends Error` with constructor `(key: GroupKey)`, plus a shared per-coordinator delivery-call context. Drain/retirement, peer `dispose()`/`drained()` and registry disposal entry checks it before joining work that owns that callback.
- Exports `OpenedDeliveryContext = {run<T>(token: object, fn: () => T): T; get(): object | undefined}` from rpc `opened-delivery.ts`. For durable handler dispatch, require `openedDeliveryContext: OpenedDeliveryContext` at the peer/registry drain factory boundary; its contract propagates the token across awaits. Hosts may reuse their async ownership-context implementation, but use distinct delivery tokens. Reject a missing binding with TypeError when durable handlers are configured, rather than silently accepting undetectable self-waits. This is independent of D8's optional ownershipContext modes; no Node import or new dependency in portable rpc.
- Produces reusable handler factory:

```ts
export function createOpenedAppHandler<P extends Record<string, GroupProtocolDefinition>>(params: {
  localDID: string
  protocols: P
  handlers: { [K in keyof P]: GroupProcedureHandlers<P[K]> }
  suppress?: SuppressConfig
}): (record: PendingAppFrame) => Promise<void>
```

This rpc callback accepts its existing smaller `PendingAppFrame`. Mls-rpc records extend it structurally.
Extra authenticated epoch/idempotency metadata remains attached through dispatch. No frame-ref migration occurs here.
Unknown protocol/procedure refuses completion. Self-sent/suppressed valid events follow existing live handler policy.

- [ ] **Step 1: Add failing opened-only drain witnesses.**

| Test name | Assertions |
| --- | --- |
| `reconstruction drains stored plaintext without reopening frames` | Persist multiple opened records, stop before callbacks, reconstruct service only. Deliver original plaintext/sender/epoch/idempotencyKey. Assert zero crypto, hub, registry-access and peer-construction calls. |
| `disposal does not release an opened drain waiter` | Suspend a handler, request drain, dispose peer. Waiter remains pending. Release handler but suspend completion COMMIT. Waiter still remains pending. Only proven completion releases it. |
| `failed old anchor blocks newer work in the same protocol only` | Persist protocol A at old anchor segment 4/topic A4 and newer segment 5/topic A5, plus protocol B. Fail/suspend A4: A5 never runs while B completes. Retry A4 with unchanged metadata, then A5, ordered by segment and code-unit position. Run live-to-cold handoff and reconstruction variants. |
| `handler cannot await its own opened drain or retirement` | Inside a callback, after an await, separately call same-key peer drain, peer `dispose()`/`drained()`, registry drain, registry disposal, then each lifecycle entry covered by Task 5. Each promptly rejects with `OpenedDeliveryReentryError`, before taking a fence/owner, changing disposal state or joining its own task. Catch refusal, return handler; normal completion and external drain/retirement/disposal then succeed. A different group's drain remains allowed. |
| `unknown protocol blocks without deleting or fetching` | No registered handler: drain remains pending and record stays sealed/durable. No new fetch or decrypt is attempted. |
| `rejected handler never completes its pending record` | Reject the handler before completion. Assert zero pending-completion calls and unchanged durable pending/cursor; reconstruct, let the handler succeed, and only then complete the original record. |
| `effect before completion crash redelivers the same record` | Run default handler effect, reject completion, reconstruct. Callback repeats with identical record key/sender/epoch/incarnation. No exactly-once callback claim. |
| `completion ambiguity retains the drain until proof` | Negative raw marker reads cannot release it. Late commit or rollback follows D8. Fail-stop rejects the drain with `GroupStateConflictError`. |
| `retired completion cannot advance an unread frontier` | Seed a cursor behind an unopened occurrence. Draining later persisted plaintext removes only its pending row. It never guesses a new cursor or skips unread frames. |
| `already running live delivery and cold drain never overlap a callback` | Transfer after source freeze. One in-memory claim per frame under the shared coordinator prevents concurrent live/storage callbacks. A crash can still redeliver. |

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/opened-delivery.test.ts test/peer-drained.test.ts`.
Run `ktest @kumiai/mls-rpc test/opened-delivery.test.ts`.
Expected: disposal releases waiters or no storage-only path exists.

- [ ] **Step 3: Implement handler reuse and drain.**

Extract existing plaintext dispatch from `app-lane.ts:807-833`. Live and stored delivery call the same validation/suppression path.
Track whole handler promises as well as `finishingRecords`. Existing `idle()` tracking of finishing transactions alone is insufficient.
Stop pulls/new opens before handing callbacks to the storage worker. Await active live callbacks outside all lane/owner locks.
Key workers by coordinator + GroupKey + **protocol**, spanning all anchor topics/segments for that protocol.
Within the source key, order by segment then code-unit log position, matching `orderedRecords` at `app-lane.ts:759-766`.
A failed earlier segment blocks newer records in the same protocol; independent protocols progress. TopicID identifies the original occurrence, not a worker boundary.
Coalesce concurrent drain calls by coordinator binding plus GroupKey. Never acquire two group scopes for delivery.

Invoke handlers outside D8 entries. Complete only the exact saved frame after success, through a short key-bound entry.
Reread pending inside work. Unknown/double completion writes nothing. Preserve all original metadata on retry.
The cold terminal/retired drain has no encrypted read frontier. It preserves its historical cursor rather than inventing contiguous coverage.
Where the live lane has a known safe cursor advance, keep awaiting that save before reporting drained.
General atomic live completion/cursor and transactional handler policy remain 2.3d. This task must not claim that row complete.

Retry handler/completion failures without erasure. An unresolved drain has no timeout that counts as success.
Disposal stops new admission but retains already owned completion/finalisation until proven completion or a propagated failure.
Never issue a disposed/retiring live `access.pending.complete` for admitted records. Before a retirement fence makes that facade unavailable, hand their completion continuation to the exact key's entry-bound pending store, retaining frame claims and handler promises. Task 5 orders this handoff before waiting for live work.
Run callbacks in the delivery-call context; before peer/registry drains, peer `dispose()`/`drained()`, registry disposal or same-group retirement change disposal state or take any fence/join, reject a matching live token with `OpenedDeliveryReentryError`. Preserve the token across awaits. Unrelated external callers can still begin retirement while a handler is suspended; this is not a global "handler running" refusal.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN, terminal/opened reconstruction rows, `kbuild`, `kports`, `kfinish`.
Remove full-handler tracking or disposal waiter retention: `disposal does not release an opened drain waiter` must fail its pending-waiter assertions.
Allow completion after a rejected/missing handler: `rejected handler never completes its pending record` and `unknown protocol blocks without deleting or fetching` must fail. Remove retained pending after a failed completion commit: `effect before completion crash redelivers the same record` must fail its identical-record redelivery assertion.
Let cold completion save a guessed cursor: `retired completion cannot advance an unread frontier` must fail its unchanged-cursor assertion.
Release the drain on a negative marker read before proof: `completion ambiguity retains the drain until proof` must fail.
Remove protocol-wide cross-segment serialisation (key jobs by topic): `failed old anchor blocks newer work in the same protocol only` must fail its A5-not-run assertion.
Remove the delivery-context reentry check at each entry separately, including peer `dispose()`/`drained()` and registry disposal: `handler cannot await its own opened drain or retirement` must fail its prompt typed-refusal assertion (gate/inspect before a self-wait; no unbounded test hang).
Require each other matching witness to fail. Assert no network/crypto on both positive and blocked paths.

- [ ] **Step 5: Commit.**

Run `git commit -m 'feat(rpc): drain persisted opened delivery independently of peer lifetime'`.

### Task 5: Await opened work at every retirement and expose blocked switching

**Files:**

- Modify: `packages/mls-rpc/src/registry/{types,registry,retirement,retired,seed,switch}.ts`.
- Modify: `packages/mls-rpc/src/registry-peer.ts:118-138,442-449,502-528,873-905`, `packages/mls-rpc/src/successor.ts`.
- Modify: `packages/mls-rpc/src/memory-incarnation-stores.ts:609-618` only for pending-erasure refusal.
- Test: `packages/mls-rpc/test/{registry-retirement,registry-retirement-writes,registry-retired,registry-delete,registry-peer}.test.ts`, shared registry/storage rows.

**Interfaces:**

- Consumes: Task 3 `finaliseAppSettlements`, Task 4 `Peer.drainOpened`, `drainStoredOpened`, delivery-call context and `OpenedDeliveryReentryError`.
- Adds `GroupHandleRegistry.drainOpened(key: GroupKey): Promise<void>`.
- Adds factory `deliverOpened?: (record: PendingAppFrame) => Promise<void>` and Task 4's `openedDeliveryContext` binding when a delivery callback is configured.
- Adds to `RegistryPeerStatus` this status arm:

```ts
| {
    kind: 'switch-blocked'
    key: GroupKey
    reason: 'opened-records' | 'publication-settlement'
    pending: number
  }
```

`pending` counts durable outstanding records/obligations, not an elapsed timeout.
Status is a runtime projection of durable rows. It reconstructs after restart without another persisted status format.
Other `pending` proof status remains unbounded as S:408 requires.

- [ ] **Step 1: Add failing lifecycle matrix.**

Parameterise by `resync`, `Welcome-readmission`, `delete`, `successor`, plus terminal self-removal where installation already committed.

| Test name | Assertions |
| --- | --- |
| `cold opened work blocks switching without starting an old peer` | Persist opens, remove live peer, request retirement. Status exposes exact source key/count and `opened-records`. No old-peer construction/crypto/network occurs. Destination/routing stay unavailable until drain proof. |
| `retirement hands suspended live delivery to exact-key completion` | Start a real live handler and suspend it. Begin actual retirement so live `access.pending.complete` now refuses. Release the handler: its retained continuation completes through the exact-key store; retirement/drain finishes once, without re-invoking the callback or requiring rollback of retirement. Assert handoff occurred before the retirement waiter joined live tasks. |
| `each erasure primitive independently refuses pending rows` | In separate direct coordinator transactions, seed pending then invoke `retireIncarnation`, deletion's erasing work, or `clearTransport` without lifecycle orchestration. Each must refuse before any pending/outbox/meta/tombstone mutation. For deletion specifically, assert its own canonical pending-erasure refusal and zero attempted `clearTransport` calls before rejection, retaining the nested `clearTransport` guard. Calibrated empty-pending control succeeds. Do not share a wrapper pending check between these calls. |
| `every retirement drains pending before transport clearing` | Pause callback/completion. Source rows remain addressable. Release it: lifecycle revalidates then completes once. Old pending cannot erase silently. |
| `terminal reconstruction drains before clearing` | Commit self-removal, reconstruct before handlers. Deliver saved plaintext under original key, then clear. No new seal/open/publish. Terminal control closure stays unchanged. |
| `late cursor save is awaited before lifecycle handoff` | Suspend an already admitted cursor save. `drainOpened` and switch/delete remain pending. No destination cursor inherits source progress. |
| `new pending work found by lifecycle recheck causes another drain` | Arrange an admitted open committing at freeze. Recheck releases slot and drains again. Deletion's existing three-attempt bound still refuses canonically. |
| `timeout never erases opened records or certifies retirement` | Advance beyond old five-second peer timeout while handler remains suspended. No switch/delete/clear or failed app event occurs. Visible block remains. |
| `failed retirement releases creation block only after rollback proof` | Inject rollback/cancellation/fail-stop. No guessed handoff. D8 deletion unblock rules remain intact. |
| `retired services do not write the active incarnation` | Finalise/drain n with n+1 installed. Only n's pending/meta changes. New state/lease/cursor/anchor are byte-identical. |

- [ ] **Step 2: Run RED.**

Run the named mls-rpc lifecycle files and new opened-delivery tests.
Expected: timeout/failure instead of blocked status, erased pending, or `drained()` returning too early.

- [ ] **Step 3: Wire one lifecycle drain path.**

First reject same-group delivery-call reentry using Task 4's typed error, before acquiring a retirement fence.
For automatic recovery, require r28i's authenticated advancing-state inspection before beginning retirement; explicit host requests are independently authorised.
Close transport/open admission and synchronously transfer every admitted pending completion continuation/frame claim to Task 4's exact-key store path as part of installing the retirement fence. `beginRetirement` bars the live pending facade; it must not strand a running handler's completion there.
Only AFTER that handoff, await submitted source network operations and full live handler/completion tasks outside locks. A handler suspended when actual retirement begins must finish through that key-bound path.
Dispose the old peer only after its opened-work ownership transfers or drains.
Run exact-key storage opened drain and certified finalisation outside the owner slot.
With no peer, use the optional factory handler callback. Missing callback retains work and the visible block.
Project counts through `EntryReads.pendingFrames` and exact-key outbox obligations while waiting.
Surface status before awaiting the drain. Refresh it after proven completion and on restart.
Handler/codec/provider failures never count as successful drain.
Do not convert the old five-second timeout into a completion or erasure rule.

After drainage, acquire the lifecycle transition and revalidate identity/lifetime/version plus empty source pending/unresolved finalisers.
If work appeared meanwhile, release ownership and repeat the drain. Keep deletion's three recheck attempts and canonical refusal.
Guard `retireIncarnation`, deletion and `clearTransport` against pending erasure even when called without a live registry peer.
Do not place handlers in these guards. They refuse before mutation, leaving orchestration to drain outside the entry.
Apply the same helper to switch, replace-seed and successor. No path may bypass it because its source is already retired or terminal.
Retired backlog from earlier versions remains serviceable until explicitly drained.

Source control may close only in authenticated consumption or an authorised retirement transaction. Tasks 5/6 must not convert a hub-copy/gap/ahead observation into automatic retirement before Task 8's authority check.
Destination creation/routing and successful lifecycle notification remain behind installation proof.
Current-move host cursor clear behaviour and source-key binding remain unchanged.

- [ ] **Step 4: Verify and mutate.**

Run the lifecycle matrix GREEN in both crypto/context modes, `kbuild`, `kports`, `kfinish`.
Remove only the pre-wait completion handoff: `retirement hands suspended live delivery to exact-key completion` must fail after release (the live facade refuses, so completion/retirement cannot finish).
Remove each primitive's own pending-erasure guard independently, retaining orchestration and all other guards: that primitive's direct-transaction case in `each erasure primitive independently refuses pending rows` must fail. For the deletion-only mutation, its specific-refusal and zero-`clearTransport`-calls assertions must fail even though the nested guard still refuses and rolls back. Assert no earlier shared guard masks it.
Mutate each lifecycle pending recheck: `new pending work found by lifecycle recheck causes another drain` must fail. Remove the no-timeout-erasure rule: `timeout never erases opened records or certifies retirement` must fail.
Remove each same-group lifecycle reentry guard separately and run Task 4's typed-refusal witness. Preserve immutable outcome/Welcome/history assertions.

- [ ] **Step 5: Commit.**

Run `git commit -m 'feat(mls-rpc): await opened drains before incarnation handoff'`.

### Task 6: Preserve superseded manual-attempt outcomes on ordinary switch

**Files:**

- Modify: `packages/mls-rpc/src/registry/switch.ts:397-405`, `registry/retired.ts:139-158`, `successor.ts:105-119` only if a shared collector is extracted.
- Test: `packages/mls-rpc/test/registry-retirement-writes.test.ts`, `packages/mls-rpc/test/manual-recovery-conformance.test.ts`.
- Modify: `packages/rpc-conformance/src/registry.ts` for the portable lifecycle witness and fixture controls.

**Interfaces:**

- Consumes: `retireIncarnation(stores, params)` with existing `abandonedAttempts?: Array<string>`.
- Produces: ordinary switch passes source-bound superseded accepted/unadopted manual attempt IDs through that existing parameter.
- If shared, private helper signature: `abandonedManualAttemptIDs(records: Array<CheckpointRecord>, source: GroupKey, adoptedAttemptID: string): Array<string>`.
- No public port or persisted format change.

- [ ] **Step 1: Add the N3 regression.**

`ordinary switch preserves the unknown outcome of a superseded manual attempt`:

Create manual resync X with an accepted-unadopted candidate. Supersede X through the existing successor-choice path.
Before successor execution, complete ordinary recovery Y into n+1.
Assert X gets exactly one owed `{id: X.id, opID:null, kind:'unknown'}` under source n.
Preserve an existing outcome with its exact timestamp instead of replacing it.
Assert Y is adopted and never also reported abandoned. Exclude another group's/incarnation's manual rows.
Reconstruct, list retired outcomes, ack X and confirm only that row disappears.
Candidate/history, accepted facts and Welcome obligations follow the existing manual-retirement preservation rules.

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/mls-rpc test/registry-retirement-writes.test.ts test/manual-recovery-conformance.test.ts`.
Expected: X's unknown outcome is missing on ordinary switch.

- [ ] **Step 3: Pass the bound abandoned attempts.**

Collect from transaction-visible checkpoint records after source/authorisation revalidation.
Filter source GroupKey, superseded authorised attempts and the adopted attempt ID. Automatic Y must already pass r28i advancing-state/confirmed-recovery authorisation; the collector cannot infer it from supersession or hub claims.
Deduplicate IDs. Existing retirement logic preserves existing outcomes/timestamps.
Share the predicate with successor only if that avoids divergent authority checks. Never infer non-acceptance from supersession.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN, registry shared rows, `kbuild`, `kports`, `kfinish`.
Remove the switch's `abandonedAttempts` argument and require the exact missing-outcome assertion to fail.
Mutate source/adopted-ID filtering and require the isolation assertions to fail.

- [ ] **Step 5: Commit.**

Run `git commit -m 'fix(mls-rpc): retain superseded manual outcomes during ordinary switch'`.

### Task 7: Match memory hub and rpc double publish-ID scope and expiry to SQL

**Files:**

- Modify: `packages/hub-server/src/memoryStore.ts:130-136,215-238,421-441`.
- Modify: `packages/rpc/test/fixtures/fake-hub.ts:250-272`, `packages/rpc/test/fixtures/durable-fake-hub.ts:48,86-106` and their existing hub-conformance wrappers.
- Create: `packages/rpc/test/hub-publish-id.test.ts` for portable double clock/purge witnesses.
- Modify: `packages/hub-protocol/src/types.ts:43-57` contract prose.
- Modify: `packages/hub-conformance/src/index.ts` shared HubStore rows and wrapper clock injection where missing.
- Test: `packages/hub-server/test/{conformance,log-hub-conformance}.test.ts`, `packages/hub-tunnel/test/hub-conformance.test.ts`, `tests/integration/test/hub-log-conformance.test.ts`.
- Test: `packages/hub-store/test/conformance.test.ts` SQL wrapper (mandatory row S:2842; provide the controlled clock for shared expiry rows).
- Read-only reference: `packages/hub-store/src/store.ts:63,190-214,493-498`.

**Interfaces:**

- Preserves: `HubStore.publish(params: PublishParams): Promise<PublishResult>`, with store-level `{sequenceID, deduped}`.
- Preserves: client `publish` result `{sequenceID}`.
- Preserves: `purge(params: PurgeParams): Promise<Array<string>>`.
- Produces: memory idempotency records keyed by a collision-safe `(topicID,publishID)` tuple, carrying original sequenceID and recordedAt.
- Uses existing conformance `setTime?: (milliseconds: number) => void`; affected wrappers must provide it for the new clock rows.
- FakeHub/DurableFakeHub retain their LogHub client result and gain test-only `purgePublishIDs(now: number): void`; record original acceptance time using the controlled clock. Expose purge through fixture controls, not a new network/client port.

- [ ] **Step 1: Add failing shared dedup rows.**

| Test name | Assertions |
| --- | --- |
| `the same publish ID is independent on two topics` | Same ID on A/B yields distinct positions and one frame per topic. Retry on each returns its own original position. Delimiter-bearing tuple values do not collide. |
| `refused CAS does not claim a publish ID` | Reject A with wrong expected head. The same ID can then be accepted at A's correct head. No sequence/event was minted by rejection. |
| `dedup expiry uses the original acceptance time` | Accept at t0. Trim, ack and retry at later times. At `t0 + 365*24*60*60*1000 - 1`, purge retains ID. At the exact cutoff, purge expires it. Retry never refreshes recordedAt. |
| `accepted retry precedes CAS and preserves fanout` | Retry accepted ID with stale expectedHead returns original sequenceID/deduped true and creates no new delivery. Fresh acceptance reports false at store level only. |

Keep existing post-trim/post-purge-before-expiry tests. Expiry is independent of message retention.
Run each shared applicable row against memoryStore, FakeHub and DurableFakeHub, not just the store.
Add `expired double publish ID cannot bypass stale-head CAS`: after exact-cutoff purge, retry that ID with stale expectedHead must reject and write nothing; before expiry it returns the original position. Parameterise by both doubles.

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/hub-server test/conformance.test.ts test/log-hub-conformance.test.ts` and `ktest @kumiai/rpc test/hub-publish-id.test.ts test/hub-conformance.test.ts`.
Expected: cross-topic reuse returns the wrong position or exact-cutoff record never expires in the store or either double.

- [ ] **Step 3: Implement memory parity.**

Use a nested map or JSON tuple key. Record time once at successful acceptance, after CAS succeeds.
Look up dedup before CAS within each topic. Purge IDs with `recordedAt <= now - 365*24*60*60*1000`.
Leave log trim/ack independent. Apply the same tuple/time rules to BOTH double maps, including the explicit purge control. Do not opportunistically expire before purge where SQL would still dedup.
Update the obsolete indefinite-retention recommendation in the port documentation and fixture comments.
Keep SQL behaviour unchanged unless the shared contract identifies a concrete mismatch.

- [ ] **Step 4: Verify and mutate.**

Run Step 2 GREEN, both contract families through `kports`, and `kfinish`.
For each of memoryStore, FakeHub and DurableFakeHub, remove topic scope: `the same publish ID is independent on two topics` must fail. Change inclusive expiry to exclusive or refresh timestamp on retry: `dedup expiry uses the original acceptance time` must fail at cutoff.
Disable either double's purge: `expired double publish ID cannot bypass stale-head CAS` must fail. Keep the other implementation unchanged in each mutation.
Unconditionally run `ktest @kumiai/hub-store test/conformance.test.ts` against the SQL conformance wrapper for row S:2842, including topic scope, original acceptance time and exact-cutoff expiry. This gate is mandatory in addition to `kports`; unavailable/skipped engines block Task 7 completion and must be reported explicitly, never counted as a pass or deferred as phase-3 parity evidence.

- [ ] **Step 5: Commit.**

Run `git commit -m 'fix(hub-server): scope and expire memory publish IDs like SQL'`.

### Task 8: Implement r28i own/foreign copy non-delivery and recovery authority

**Dependency:** Task 0's doc-only r28i commit. Q2 = B and R1 are decided; there is no external amendment blocker.

**Files:**

- Modify: `packages/rpc/src/{ledger-entries,recovery-types,peer}.ts`; walker coverage/cursor transaction and recovery triggers.
- Modify: `packages/rpc/src/control/slot.ts:42-87` only where own-copy versus local-unavailable classification must survive `consumeOwnOccurrence`.
- Modify: `packages/mls-rpc/src/{recovery,registry-group-mls,crypto,control-validation}.ts` and captured-recovery double factories.
- Test: `packages/rpc/test/{peer-control-retry,peer-control-settlement}.test.ts`, `packages/mls-rpc/test/{own-commit-copy,control-validation,control-crash}.test.ts`, new `packages/mls-rpc/test/delivered-entry-copy.test.ts`.
- Modify shared control/safety and captured-recovery conformance mirrors for the same real/double evidence. No further spec change is needed beyond Task 0.

**Interfaces:**

- Consumes r28i and existing authenticated recovery/confirmation contracts. Preserve `BuiltCommit`, `OwnOccurrence` and walker-only settlement; no new persisted failure cache or recovery proof arm.
- Adds internal `DeliveredEntryCopyError extends Error` in `rpc/src/ledger-entries.ts`, constructor `(message?: string, options?: ErrorOptions)`, minted only at delivered-byte decode/authentication/reference failures.
- Extends `consumeOwnOccurrence`'s internal result with `'copy-failed'`: `Promise<'installed' | 'noop' | 'moved' | 'invalid' | 'unavailable' | 'copy-failed'>`. Map DeliveredEntryCopyError and delivered own blob/reference diagnostics (`unexplained-own`, unsupported copy version) to that arm. The walker atomically skips it with explicit false. Other unrecognised own copies also skip coverage-only. Keep `ControlFrameValidation`'s existing shape; local null validation/provider failures remain `'unavailable'` and retain identity at their throwing boundary. Real validation and independent mirrors must make this same distinction.
- Adds `CapturedRecoveryPort.inspectCapture(reply: CapturedRecapture): Promise<{groupID: string; epoch: number; authenticator: Uint8Array} | null>`; it verifies the request-bound member-signed GroupInfo through retained trust and existing MLS signature/tree/credential/replacement checks WITHOUT constructing a candidate.
- Preserve local provider error identity. Header/key derivation/verifier/provider I/O throws keep local retry/backstop policy. Neither commit-content signature success alone nor sender-data classification authenticates a failed blob.

The advancing-state predicate is fixed: verified same-group GroupInfo at F > the live build's source E. Return defensive public facts only after authentication. Same/lower epochs and same-number authenticator disagreement grant no authority. Inspection only permits the normal recovery sequence; final retirement still requires bound confirmation and source revalidation.

- [ ] **Step 1: Update r28h regressions and add named r28i witnesses.**

Existing tests whose failed-own-copy ban must change (baseline names/coordinates):

| Existing test | Required update |
| --- | --- |
| `packages/rpc/test/peer-control-retry.test.ts:539`, `a classified altered own copy prevents identical retry and later own installation closes unknown (restart=%s)` | Rename to `failed own copy permits identical retry and later installation closes unknown (restart=%s)`; assert explicit false and identical bytes/ID retry before/after reconstruction. Remove the blanket mocked invalid classification if it hides actual copy eligibility. Keep unknown-by-coverage and no receive-apply assertions. |
| `packages/mls-rpc/test/own-commit-copy.test.ts:157`, `failed own copy blocks identical retry and a later exact occurrence installs unknown (delivered: %s)` | Rename to `failed own copy permits identical retry and later exact installation closes unknown (delivered: %s)`; update the manually mirrored cursor/build transaction at :218-224 to explicit false and assert publication, not merely absence of failure. Keep the real named-entry corruption/reference checks and candidate-authenticator assertions. |

Re-check adjacent r28h tests without weakening valid bans: `an older saved skipped build never republishes after restart before its deadline` (:418) and the schema-version-1/legacy cases keep absent-field defaults; `coverage-only $kind skip permits identical saved host bytes after hub recovery (restart=$restart)` (:457) gains own-blob variants. `commit-cas-generation.test.ts`'s policy-refused case retains true because it is an authenticated COMMIT refusal. `control-validation.test.ts:1972`'s sealed-entry-version poison currently expects true at :2090; change to false because the unsupported delivered blob is not a commit refusal, even with a verified commit signature. Retain provider-identity tests and control-store monotonicity guards.

| Witness test name | Assertions |
| --- | --- |
| `unreadable own and foreign copies preserve live invite material across restart` | Parameterise own/foreign and corrupt/withheld/malformed/version/reference failure. Drive the assembled peer walker and real own validation path, without manually writing skip state or mocking away copy checks. Keep an Invite live at E. Assert the walker persists `retryForbidden: false` for an initially eligible own build before/after reconstruction (prior/legacy bans stay prohibited); cursor, coverage and retry distinction commit together. Reconstruct exact bytes/ID/candidate/deadline/speculative Welcome; no strand/hold/halt, rebuild, retirement or new build. Identical saved retry remains eligible before deadline. |
| `legacy delivery-stranded cursor resumes valid own consumption without advancing capture` | Seed the pre-upgrade persisted `cursor.stranded: true` and delivery-only strand reason (`ahead`/`retention-gap`) with a live build at E and saved cursor position, crossing present/absent old `incomplete` flags; reconstruct before valid bytes return. Restore a valid own occurrence to the ordinary walker, supplying no F > E capture. Migration clears only the delivery-derived block; the saved candidate installs and closes `unknown` by incomplete coverage without a new candidate, rebuild or automatic retirement. Preserve all saved material until authenticated consumption and keep independent Welcome obligations. Reconstruct again to prove the migration is durable; genuine local/safety/legacy-hold controls remain blocked. Blocked control: a legacy `unprocessable-gap` row (no persisted discriminator; baseline local retry exhaustion writes the same reason, `peer.ts:1946`) stays stranded under existing policy. |
| `copy skip cursor and coverage roll back together` | Suspend/inject rollback after cursor work but before commit. Cursor/coverage/retry field/build all remain byte-identical; commit exposes the three together. No status/host effect leaks before proof. |
| `later hub gap claims cannot retire a live build without authenticated advancement` | After skip, serve forged ahead epochs, empty mid-walk/prefix gaps and inflated/regressing heads. No destructive strand/retirement or candidate construction; bounded-backoff inspection only, no hot loop/new ordinary build. Wrong request/group/signature/trust, F <= E and same-number authenticator mismatch give no authority. Verified F > E permits candidate preparation, but failed confirmation/source revalidation still prevents retirement. Only confirmed recovery closes unknown. |
| `valid consumption after a copy skip closes unknown and preserves owed obligations` | Later valid own occurrence installs saved candidate with no receive-apply; valid competitor/recovery consumption closes by coverage. No new speculative-Welcome obligation behind incomplete coverage; existing independent obligations remain deliverable. Unknown never means absence and preservation is not promised after authenticated consumption. |
| `local input and provider failures retain identity and retry policy` | Inject local key derivation/storage/verifier errors instead of delivered-byte failure. No DeliveredEntryCopyError, premature cursor advance or fabricated hold. Hold/retry with capped backoff; local backstop cannot bypass live-build authenticated retirement authority. Deadline reports unknown once while build remains live. |
| `authenticated foreign refusal and legacy retry bans survive copy skips` | Real content-signature-verified refusal of the commit itself still sets true; later failed copies cannot clear it. Sender-data or signature success plus a failed blob alone sets false. Legacy skipped absent-field rows remain forbidden. Applied consumption never resurrects retry. |

Update `control-crash.test.ts:30`'s `unavailable authenticated earlier frame strands before own installation or Welcome (${mode})`: delivered/missing-proposal inputs now skip by coverage; a later own installation may close unknown without Welcome, rather than stranding. Keep genuinely local failures in a separate backstop variant. Run all new witnesses real-MLS/double and restart/no-restart; persistence boundaries also cross supplied/absent D8 context.

- [ ] **Step 2: Run RED.**

Run `ktest @kumiai/rpc test/peer-control-retry.test.ts test/peer-control-settlement.test.ts` and the named mls-rpc files above. Expected baseline failure: own retry ban, foreign unprocessable-gap, or recovery construction/retirement from hub claims.

- [ ] **Step 3: Implement classification, atomic skip and authenticated inspection.**

Audit BOTH `peer.ts:2135-2159` (header-unavailable recognition) and `:2178-2244` (`own-unmerged`/`consumeOwnOccurrence`), plus foreign resolver/unavailable/missing/unsupported cases at `:2334-2405`. Only genuine local failure enters `ownUnavailable`; failed own named-entry recognition must reach the coverage-only cursor path, never `saveCommitCursor(..., true)` solely from copy failure.
Classify at the delivered-byte boundary; never infer policy from a catch-all error name or from successful commit signature authentication alone. Distinguish a refusal of the authenticated foreign commit itself from unusable delivered entries.
Commit cursor advance, `incomplete` as applicable, `skipped` and explicit false together, preserving all saved material. Do not downgrade an existing/legacy ban or clear coverage on head refresh/restart.
For pre-existing persisted `cursor.stranded` rows, atomically normalise a recorded delivery-only `ahead`/`retention-gap` reason (legacy `unprocessable-gap` is ambiguous with local retry exhaustion and keeps existing policy) to a non-stranded cursor plus `incomplete: true` and clear only that delivery strand. Preserve cursor position, build bytes/ID/candidate/deadline/speculative Welcome and all retry-prohibition defaults; this is no retry-ban migration. Resume the ordinary walker so returning valid bytes can authenticate consumption without F > E inspection. Do not infer complete coverage, construct recovery or retire a live build from migration; the F > E gate still applies to automatic recovery retirement. Missing/ambiguous provenance, lost-local-state, fork/local-invariant, safety and immutable legacy holds retain their existing policy.
Before gap/ahead/copy-triggered automatic recovery can construct a candidate or begin retirement of a live build, require `inspectCapture`'s F > E predicate. Preserve normally bound confirmation, source revalidation, capped backoff, default deadline reporting and explicit host exits. Do not implement a delivery-derived durable hold/strand, busy loop or replacement ordinary build. Re-check Tasks 5/6 entry points so they cannot bypass this authorisation.

- [ ] **Step 4: Verify and mutate each authority separately.**

Run Step 2 GREEN, shared Control/Safety/full port gates via `kports`, `ktypes` and affected memory integration reconstruction.

| Mutation (restore each before the next) | Witness that must fail |
| --- | --- |
| Restore own-unmerged retry prohibition or send a failed own copy to local-unavailable | `unreadable own and foreign copies preserve live invite material across restart` (assembled own walker variants, including the explicit `retryForbidden: false` assertion); the renamed manual-skip test is supporting copy validation only |
| Restore foreign failed-copy unprocessable-gap / treat signature success alone as refusal | The foreign variants of the same preservation witness; `authenticated foreign refusal and legacy retry bans survive copy skips` |
| Retain the legacy delivery-derived stranded gate, or require F > E capture before normal walking/own installation | `legacy delivery-stranded cursor resumes valid own consumption without advancing capture` must fail its valid-consumption assertion; clear a genuine local/safety/legacy hold instead and its blocked control must fail |
| Move coverage/retry update outside the cursor transaction | `copy skip cursor and coverage roll back together` |
| Remove advancing-state pre-candidate gate, request/group/trust/epoch checks, then confirmation/source revalidation separately | Corresponding independent cases of `later hub gap claims cannot retire a live build without authenticated advancement` |
| Convert local provider throws to copy skips | `local input and provider failures retain identity and retry policy` |
| Release speculative Welcome after incomplete coverage, or delete an independent obligation on closure | `valid consumption after a copy skip closes unknown and preserves owed obligations` |
| Clear a prior/legacy ban on a later skip | `authenticated foreign refusal and legacy retry bans survive copy skips` |

- [ ] **Step 5: Commit.**

Run `git commit -m 'fix(rpc): preserve live work across failed delivered control copies'` after Task 0 and these gates.

## Completion gates and handoff

- [ ] Run `kbuild`, affected rpc/mls-rpc/hub-server unit suites, `kports` and repo-wide `ktypes` after all approved tasks.
- [ ] Run affected integration reconstruction tests. Keep the full HTTP smoke in 2.4.
- [ ] Confirm each new guard's mutation failure and restored GREEN result.
- [ ] Confirm no generated files, controller-log format, dependency or configuration changed.
- [ ] Update rpc/mls-rpc READMEs with preparation adapter, frozen finaliser, `drainOpened`, blocked status and lifecycle requirements.
- [ ] Document `OpenedDeliveryReentryError` and the async delivery-context binding, with the executable Task 4 refusal witness; no documentation-only self-wait constraint.
- [ ] Extend the existing Spec P release intent. Do not create a new version band or release.
- [ ] Record the completed inventory mapping, Q2 ruling and remaining 2.3d/2.3e/2.4 obligations.
- [ ] Record unavailable provider/backend evidence explicitly. Never count a skipped backend as a pass.
- [ ] Commit documentation with `git commit -m 'docs(mls-rpc): document durable settlement and retirement drain'`.

The last documentation commit is a completion step, not another task. Task 0 plus implementation Tasks 1-8 make nine tasks.
Do not claim S:2800/2801/2835/2737, restore rows/seam, batching, HTTP, provider or SIGKILL evidence complete under this plan; their owners are listed above.
Do not merge or push this branch before all phase-2 work and its final gates complete.
