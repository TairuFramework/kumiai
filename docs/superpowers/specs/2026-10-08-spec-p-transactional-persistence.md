# Spec P: transactional persistence — design

Date: 2026-10-08
Status: draft r1
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
(phase 0)

Spec P fixes the durable contracts that the host stack (`mls-rpc` registry, `rpc-store`, `client`,
`messaging`) builds on: what is written, in which transaction, in which order, and what a crash
between two writes leaves behind. Phase 2 implements its port changes on memory doubles; phase 3
implements them on Hozon.

## Context

Checked against source on 2026-10-08. Paths are relative to `packages/` unless rooted elsewhere.

### rpc's durable writes today

- **Durable app-frame open.** rpc never writes the pending record. The `GroupCrypto` implementation
  creates it inside `unwrap` when given a `frame` ref; the port contract is "Present iff opened app
  frames and their consumed handle state are saved atomically" (`rpc/src/crypto.ts:79`). A failed
  write surfaces as `AppFrameStorageError`, after which the same frame may be retried
  (`rpc/src/crypto.ts:199`; rethrown at `rpc/src/app-lane.ts:757-759`).
- The drain builds `ref = {id, topicID, protocol, segment: anchor().epoch, position}`
  (`rpc/src/app-lane.ts:724-733`), so `segment` is the **anchor** epoch. The record rpc keeps is
  `{frame, payload, senderDID}` (`rpc/src/app-lane.ts:770-774`): the opened epoch returned in
  `GroupUnwrapResult.epoch` (`rpc/src/crypto.ts:245-253`) is dropped.
- Handlers run later in a per-protocol worker (`rpc/src/app-lane.ts:547-596`). `complete(id)` runs
  only after the handler resolves (`rpc/src/app-lane.ts:498, 544`); a throwing handler is retried
  with backoff (`rpc/src/app-lane.ts:576-589`). Schema-invalid events, malformed JSON, own frames
  and non-log frames are completed without a handler call (`rpc/src/handlers.ts:76-81`,
  `rpc/src/app-lane.ts:521-545`).
- `AppCursorStore.save` runs after `complete` (`rpc/src/app-lane.ts:500-513`). The cursor never
  passes a pending frame (`rpc/src/app-lane.ts:470, 812`). `complete` and the cursor save are
  ordered, not atomic; "Unknown IDs resolve successfully" (`rpc/src/crypto.ts:195`).
- Handlers get `{data, message: {payload: {iss: senderDID}}, frame?}` (`rpc/src/handlers.ts:83-87`).
  No path forwards the opened epoch: the live path keeps it in `openedFrames`
  (`rpc/src/peer-epoch.ts:177`) but the adapter drops it.
- **Outbox.** `accept` reserves a sequence, awaits `outbox.put`, then admits the entry to memory
  (`rpc/src/app-outbox.ts:118-128`). Each delivery pass removes proven entries, seals, `put`s the
  updated `lastAttempt`, publishes, probes the commit log for proof, then removes
  (`rpc/src/log-delivery.ts:80-207`). `put` is atomic per call (`rpc/src/app-outbox.ts:36`).
  `putCommitCursor` is "Durable after the paired MLS state" (`rpc/src/app-outbox.ts:34`): ordered,
  not atomic.
- "Publication evidence stays in memory. A prepared durable attempt proves nothing."
  (`rpc/src/log-delivery.ts:43`). The only read of `lastAttempt` is its `attempts` counter
  (`rpc/src/log-delivery.ts:167`).
- **Commit journal.** In `commit()`: `put` (`rpc/src/peer.ts:2169`), publish with a fresh
  `publishID` and `expectedHead` (`rpc/src/peer.ts:2159, 2187`), `markAccepted`
  (`rpc/src/peer.ts:2216`), `advanceHandle` (deliver, anchor save, adoption, `putCommitCursor`;
  `rpc/src/peer.ts:2236-2245`), `clear` (`rpc/src/peer.ts:2247`). Replay reuses the original
  `publishID` (`rpc/src/peer.ts:1869`) and keeps the same order (`rpc/src/peer.ts:1897-1919`). The
  contract is ordering only (`rpc/src/commit.ts:93-109`).
- **Anchor.** `save({anchor, pending})` before the ratchet (`rpc/src/peer.ts:1179`), then
  `{anchor}` on resolution (`rpc/src/peer.ts:399-408`). Ordering only (`rpc/src/anchor.ts:23-26`).

### Publication identity

- App-lane publishes carry **no** `publishID`: `mux.publish({ ...frame, retain: 'log' })`
  (`rpc/src/peer.ts:648`). Only commits use one; external rejoin mints a fresh, unjournalled ID
  (`rpc/src/peer.ts:2458, 2471`). The mux forwards it when non-null (`rpc/src/hub-mux.ts:792`).
- `hub-store` deduplicates by primary key `(topic_id, publish_id)`
  (`hub-store/src/migrations.ts:99`; claim at `hub-store/src/store.ts:195-215`) and purges records
  older than `PUBLISH_ID_RETENTION_SECONDS = 365 * 24 * 60 * 60` (`hub-store/src/store.ts:63,
  494-497`). `hub-server` skips fan-out for a deduplicated publish (`hub-server/src/handlers.ts:446`).
- The `hub-server` memory store keys dedup records by `publishID` **alone** and keeps them forever
  (`hub-server/src/memoryStore.ts:131-136, 215-218`): a double that differs from the real store.

### Handle state in kumiai

- `GroupHandle` state is memory only (`mls/src/group-handle.ts:356-374`). `restoreGroup({state,
  credential, ledgerEntries})` rebuilds a handle and re-verifies the ledger tokens
  (`mls/src/group-create.ts:155-176`, `mls/src/group-handle.ts:483-490`). `ClientState` includes the
  leaf signing key (`mls/src/group-lifecycle.ts:43`); `MemberCredential` is `{id, groupID}`
  (`mls/src/credential.ts:11-14`). Ordered tokens come from `handle.ledgerTokens`.
- `encodeClientState`/`decodeClientState` exist with a 1-byte version prefix
  (`mls/src/codec.ts:25-54`). No codec exists for credential or ledger tokens.
- Not persisted and re-supplied by the host on restore: `MlsContext`, `commitPolicy`, ledger
  resolvers (`mls/src/group-handle.ts:343-348`), the mls-rpc `LedgerEntrySlot`, own signing identity
  and recovery config (`mls-rpc/src/mls.ts:62-109`). Recovery-request ephemeral keys live in a
  120 s in-memory map (`mls-rpc/src/mls.ts:135-173`).
- `simpleHandleAccess` serialises calls in memory and calls an optional host `persist` after every
  `mutate` and before `replace` adopts (`mls-rpc/src/access.ts:28-78`). `wrap` is
  `access.mutate(encrypt)` (`mls-rpc/src/crypto.ts:148`), so with `persist` set a sealed frame is
  returned only after the advanced sender ratchet is saved.
- Durable open: `mls-rpc` takes `pending: {persistOpened(stagedState, record), list, complete}`
  (`mls-rpc/src/crypto.ts:96-101`). `decryptStaged` decrypts against a staged state, awaits
  `persistOpened`, and only then adopts it (`mls/src/group-handle.ts:1015-1048`). A persist failure
  leaves the key unspent (`mls-rpc/src/crypto.ts:192-224`). mls-rpc writes nothing durable itself.

### Kubun's registry (behaviours to lift)

All under `kubun/packages/plugin-p2p/src/groups/` unless noted.

- Persisted row: `{mlsState, credential (JSON), epoch, ledgerEntries (JSON), stateVersion,
  senderGenerationHWM, isDeleted}` (`mls-state.ts:17-40`; `kubun/packages/store-p2p/src/ops/mls.ts`).
- **CAS writes.** `saveMLSState(insert, expected {epoch, stateVersion})` with
  `stateVersion = expected + 1`; `UPDATE … WHERE epoch = ? AND state_version = ?`; `expected = null`
  is insert-if-absent (`store-p2p/src/ops/mls.ts:52-96`). A miss throws `GroupHandleConflictError`
  and the base path re-reads (`group-handle-registry.ts:1324-1332, 1941-1971`). Mutations run on a
  restored copy and install only after the save (`group-handle-registry.ts:1170-1337`).
  Same-group writers are gated (`group-handle-registry.ts:1205-1220`).
- **Sender lease.** Reserves 64 generations ahead via a CAS on `sender_generation_hwm`, renewing
  below 16 (`group-handle-registry.ts:78-79, 812-905`; `store-p2p/src/ops/mls.ts:151-194`). On
  restore the handle burns `encrypt(empty)` up to the HWM (`group-handle-registry.ts:1912-1919`).
  The ratchet is not saved per send.
- **Atomic open.** `saveOpenedAppFrame` does the state CAS and `INSERT … ON CONFLICT DO NOTHING` of
  the pending record in one transaction (`store-p2p/src/ops/app-lane.ts:70-91`), retried up to 8
  times on conflict (`group-handle-registry.ts:372, 446`). An unknown outcome marks the group
  uncertain; every access throws `GroupStateUncertainError` until a status read resolves it, with
  backoff up to 15 s (`group-handle-registry.ts:423-433, 493-530`).
- **Receive batching.** Live receives mutate the cached handle and flush at 64 frames or 250 ms;
  after an open conflict, secret trees are merged (`mergeReceiveTrees`: max generation, keep a
  skipped key only if neither side spent it) before a CAS save (`group-handle-registry.ts:80-81,
  122-172, 533-743`).
- **Displacement.** A lineage counter; `seed({replace})` bumps it and `wrap` on a stale crypto
  rejects with `DisplacedGroupHandleError` (`group-handle-registry.ts:1739-1811`;
  `group-crypto.ts:165-178`). Replacement is epoch-monotonic (`group-handle-registry.ts:1627-1647`).
- **Deletion.** CAS soft-delete (empty state, credential and ledger; zero HWM; bump version), with
  pending frames deleted in the same transaction (`group-handle-registry.ts:1650-1719`;
  `store-p2p/src/ops/mls.ts:206-226`; `manager.ts:1085-1101`).
- Kubun-specific: `@kubun/logger`, `store-p2p` rows and `markGroupProjectionsDirty`
  (`group-handle-registry.ts:3, 1955-1957`).

### Hozon

All under `hozon/packages/` (sibling repo).

- Stores are bound to a transaction by taking them **from** the transaction:
  `db.withTransaction(async (tx) => tx.getStore(name))` creates the store API on the transaction's
  Kysely handle (`db/src/db.ts:195-222`). A store from `db.getStore` auto-commits each write and is
  never part of another call's transaction (`db/src/db.ts:149-166`).
- `tx.withTransaction(fn)` runs `fn` inline on the same provider, without a savepoint
  (`db/src/db.ts:230-237`). The inner promise resolves **before** the outer commit; commit happens
  after the outer callback returns (`db/src/db.ts:195-275`). `onCommit` hooks run after commit
  (`db/src/db.ts:291`). `db.withTransaction` called from inside a callback opens an independent
  transaction, documented as a bug (`db/src/db.ts:174-176`).
- `withSavepoint` exists; overlapping savepoints throw `SavepointOverlapError`
  (`db/src/db.ts:238-269`).
- Store helpers join an enclosing transaction via `withStoreTransaction`
  (`db/src/store-transaction.ts:3-8`).
- Isolation: Hozon sets none. node-sqlite is one `DatabaseSync` connection, WAL except `:memory:`,
  `busy_timeout` 5000 (`node-sqlite/src/index.ts:36-67`). Postgres uses a postgres.js pool, so
  transactions run concurrently at the server default (`postgres/src/index.ts:73-82`). Expo has one
  connection behind a `ConnectionMutex`; every transaction and standalone query is exclusive, with
  plain deferred `begin transaction` (`expo/src/driver.ts:53-148`). Kysely's SQLite BEGIN mode was
  not verifiable locally.
- No CAS helper or conflict error; `hub-store` builds its own conditional writes and
  `HeadMismatchError` (`hub-store/src/store.ts:190-305`).

### Conformance today

`rpc-conformance` covers:

- `AppOutbox`: 4 cases (`rpc-conformance/src/app-outbox.ts:29-86`).
- `CommitJournal`: 1 case (`rpc-conformance/src/commit-journal.ts:28`).
- `AnchorStore`: 1 case (`rpc-conformance/src/anchor-store.ts:26`).
- Durable open (`PendingAppFrames`): 8 cases (`rpc-conformance/src/pending-group-crypto.ts:73-215`).

There is no `AppCursorStore` suite.

## Decisions

### D1. One owner per database

A device's Hozon database is written by one live process. Within it, each group has one owner: the
`GroupHandleRegistry` instance, which serialises that group's writes behind a per-group mutex. CAS
versions catch bugs and displaced handles; they are not a multi-process protocol. Two processes on
one database are unsupported, and `createDevice` holds an advisory lock row to refuse a second one.

### D2. Transactions come from the root database, never from inside one

Hozon resolves an inner `tx.withTransaction` before the outer commit, and a store taken from the
root `db` while a transaction is open is not part of it. On the single-connection providers that
second store either waits on the connection (expo: deadlock behind `ConnectionMutex`) or runs on the
same connection inside the open `BEGIN` (node-sqlite: silently joins it). So:

- Every multi-store write is one call to `db.withTransaction` on the **root** provider, and every
  store it writes is taken from that callback's `tx`.
- Code holding a `tx` never awaits network, timers or another group's mutex.
- A port method that must be atomic (`saveOpened`, `delete`, the coordinated outbox `put`) opens its
  own root transaction and resolves after it commits. It never accepts a caller's `tx`.
- `rpc-store` constructors take the root provider and refuse a transaction-scoped one. Phase 1
  confirms Hozon exposes a discriminator; if it does not, Hozon adds one (cross-repo, published
  before phase 3).

### D3. `GroupStateStore`

Lives in `mls-rpc` (`mls-rpc/src/state-store.ts`); bytes only, no `mls` import.

```ts
export type GroupStateRecord = {
  groupID: string
  /** MLS epoch of `state`. */
  epoch: number
  /** Per-group, strictly increasing across saves, reservations and deletion. Starts at 1. */
  version: number
  /** Random per write; lets an ambiguous write be resolved exactly. */
  writeID: string
  /** `encodeClientState` output. Includes the leaf signing key: encrypt at rest. */
  state: Uint8Array
  credential: { id: string; groupID: string }
  /** Signed ledger tokens in enactment order, repeats kept (`handle.ledgerTokens`). */
  ledger: Array<string>
  /** Sender generations at `epoch` are reserved below this. Reset to 0 when `epoch` changes. */
  senderHWM: number
}

/** `null`: the group must have no live record (absent or deleted). */
export type GroupStateExpected = { version: number } | null

export type GroupStateSummary = { groupID: string; epoch: number; version: number; deleted: boolean }

export type GroupStateStore = {
  load(groupID: string): Promise<GroupStateRecord | null>
  /** Inventory, including tombstones. */
  list(): Promise<Array<GroupStateSummary>>
  /** CAS on `expected`; `record.version` must exceed every stored version. */
  save(record: GroupStateRecord, expected: GroupStateExpected): Promise<void>
  /** `save` plus an insert of `pending`, idempotent by `pending.frame.id`, in one transaction. */
  saveOpened(record: GroupStateRecord, expected: GroupStateExpected, pending: PendingAppFrame): Promise<void>
  /** Uncompleted records of one group in `(segment, position)` order. */
  listPending(groupID: string): Promise<Array<PendingAppFrame>>
  /** Unknown IDs resolve. */
  completePending(groupID: string, id: string): Promise<void>
  /**
   * CAS tombstone: clears state, credential, ledger and HWM, keeps the version (bumped), and in the
   * same transaction deletes the group's pending records and every rpc-store row keyed by the group.
   */
  delete(groupID: string, expected: { version: number }): Promise<void>
}

/** A CAS miss. Storage is unchanged. */
export class GroupStateConflictError extends Error {}
```

Rules:

- **CAS.** `save` succeeds iff the stored live record has `expected.version` (or there is no live
  record and `expected` is `null`) and `record.version` is greater than every version ever stored
  for the group, tombstone included. A miss throws `GroupStateConflictError` and writes nothing.
- **Ambiguous write.** Any other error leaves the outcome unknown. The registry marks the group
  uncertain (every access throws `GroupStateUncertainError`), then `load`s: the stored `writeID`
  equal to the attempt's means it landed; the stored version equal to `expected.version` means it
  did not; anything else is a conflict. It retries the read with backoff up to 15 s per attempt and
  stays uncertain until one read succeeds.
- **Mutations on a copy.** The registry runs every MLS mutation on a restored copy and installs it
  only after the save resolves (Kubun's rule). A failed or conflicting save leaves the live handle
  unchanged.
- **Sender reservation.** Before sealing, the registry needs a reservation at the current epoch
  with at least 16 generations left; otherwise it saves the record with `senderHWM` raised by 64
  (state unchanged, version bumped). The ratchet is not saved per send. On restore the registry burns
  generations up to `senderHWM`, so no generation is ever sealed twice. This replaces
  `simpleHandleAccess`'s save-per-`wrap` for registry-owned groups.
- **Durable open.** `saveOpened` is the only writer of pending records. mls-rpc's
  `pending.persistOpened(stagedState, record)` maps to it. Conflicts retry up to 8 times on a fresh
  copy, merging receive trees as Kubun does.
- **Receive batching** (live, non-durable opens): flush at 64 frames or 250 ms, as Kubun.
- **Displacement.** A per-group lineage counter; a `GroupCrypto` built before a `seed({replace})`
  rejects `wrap` with `DisplacedGroupHandleError`. Replacement is epoch-monotonic.
- **Inventory.** `list()` drives restore: every live record is restored with `restoreGroup` and its
  pending records are handed to that group's peer. Tombstones are kept so a stale writer's CAS fails
  and a re-join continues the version sequence.

### D4. Opened epoch on pending records and handlers

```ts
export type PendingAppFrame = {
  frame: AppFrameRef
  payload: Uint8Array
  senderDID: string
  /** The authenticated epoch the frame opened at (`GroupUnwrapResult.epoch`). */
  epoch: number
}
```

The app lane copies `opened.epoch` into the record (`rpc/src/app-lane.ts:770-774`). Handler context
gains `epoch: number` on every path: durable delivery reads it from the record, the non-durable
drain and the live path from `GroupUnwrapResult`. A breaking change to an rpc port type: both
contract suites and every double are migrated in the same change, verified repo-wide with
`turbo run test:types`.

### D5. Idempotent Welcome and commit adoption

- **Welcome.** Joining saves with `expected: null`. If a live record exists at an epoch at or above
  the Welcome's, the join is a no-op success (a duplicate Welcome). A live record at a lower epoch
  is replaced only through `seed({replace: true})` (rejoin), CAS on its version.
- **Commit adoption.** Adoption is a CAS save from the pre-commit version. A replayed commit at an
  epoch the record already passed is reported as applied by `GroupMLS`, and nothing is written.
- **Journal recovery.** `CommitJournal` keeps rpc's contract. The `journal` blob `client` writes is
  `{kind, groupID, targets}`. On `LostCommit` for `invite`/`remove`, `client` re-enacts while the
  actor is still authorised, and otherwise emits `commit:lost` with the blob. `ledger` losses are
  re-issued by rpc's existing path.

### D6. Outgoing attempt identity and publication status

`AppOutboxEntry.lastAttempt` grows into the durable attempt:

```ts
export type AppAttempt = {
  epoch: number
  floor: string | null
  attempts: number
  /** Fresh per attempt; the hub dedups by (topicID, publishID). */
  publishID: string
  topicID: string
  /** The exact frame published under `publishID`. */
  sealed: Uint8Array
  /** Host clock, ms. */
  preparedAt: number
  /** The hub's sequenceID once it acknowledged this attempt. */
  acceptedAs?: string
}
```

Delivery pass, per entry:

1. Seal at the current epoch, mint `publishID`, `put` the entry with the new `lastAttempt`.
2. Publish `sealed` with `publishID`.
3. On acknowledgement, `put` the entry with `acceptedAs` set. This is the durable "published,
   position known" status.
4. Proof and `remove` as today.

Restart and retries:

- `lastAttempt` without `acceptedAs`, same epoch and same `topicID` as now: publish the **same**
  `sealed` under the **same** `publishID`. A landed attempt is deduplicated by the hub and returns
  its original sequenceID.
- Epoch or topic moved, or a deliberate rejoin resend: seal again under a **new** `publishID`. The
  old attempt may also have landed; receivers dedup by message identity.
- `now - preparedAt` beyond 364 days (one day short of `hub-store`'s 365-day dedup retention):
  abandon the attempt and seal a new one.
- `lastAttempt` with `acceptedAs`: never republish; continue at proof.

`AppOutbox`'s method signatures are unchanged; only the entry type grows. The `hub-server` memory
store's dedup keys by `publishID` alone; it is re-keyed by `(topicID, publishID)` with the same
365-day expiry, so the double is no more permissive than `hub-store`.

### D7. Coordinated acceptance adapter

Generic, in `rpc-store`:

```ts
export type CoordinatedOutboxParams = {
  /** Root provider. */
  db: HozonDB
  groupID: string
  /** Called inside the same transaction as the outbox write, for every put. */
  onPut: (tx: StoreProvider, entry: AppOutboxEntry) => Promise<void>
}
export function createCoordinatedOutbox(params: CoordinatedOutboxParams): AppOutbox
```

- `put(entry)` runs `db.withTransaction(tx => { outboxOf(tx).put(entry); onPut(tx, entry) })` and
  resolves after the commit. A throw from either rolls back both and rejects `put`.
- rpc's `accept` already holds the sequence reservation until `put` resolves
  (`rpc/src/app-outbox.ts:118-128`), so nothing is published before the commit.
- `messaging`'s `onPut` decodes the entry (rpc exports `decodeAppEntry(entry): {procedure,
  payload}`, added in phase 2 if missing) and writes the message row: `accepted` with
  `outboxSeq` when `lastAttempt` is `null`, `published` with the position when `acceptedAs` is set.
  Status and position therefore ride the same transaction as the outbox write.
- `pending` status lives in memory between `send()` and the first `put`'s commit; a crash there
  loses an unaccepted send, and `send()` never resolved.
- Memory doubles: `createMemoryTransaction()` gives a shared in-memory store set with snapshot and
  rollback, used by the memory outbox and the memory `MessageStore`.

### D8. Provider guarantees

| Claim | node-sqlite | postgres | expo |
|---|---|---|---|
| One root transaction commits all its stores or none | yes, one connection | yes | yes, exclusive connection |
| Root `withTransaction` resolves after commit | yes | yes | yes |
| CAS by conditional `UPDATE … WHERE version = ?` and row count | yes, single writer | yes at READ COMMITTED: the `UPDATE` re-checks its `WHERE` on the latest row version | yes, serialised |
| Concurrent transactions | serialised by one connection | concurrent (pool) | serialised by mutex |
| Root-store call while a transaction is open | joins the open transaction (D2 forbids) | separate connection | deadlocks (D2 forbids) |

Postgres is the only provider with concurrent transactions; with D1 they only occur across groups,
which share no rows except the advisory lock.

## Crash seams

No production hooks. Every seam is a test-only wrapping store in `tests/e2e` that awaits
`seam(name)` before or after delegating; the child-process agent blocks there, reports the seam and
is killed. "After" means after the delegated promise resolved, which for every wrapped method is
after its transaction committed.

| Scenario 8 point | Wrapped method | When |
|---|---|---|
| After decrypt, before the ratchet-plus-pending save | `GroupStateStore.saveOpened` | before |
| After that save, before message persist | `GroupStateStore.saveOpened` | after |
| After message persist, before pending completion | `MessageStore.put` | after |
| After pending completion, before cursor advance | `GroupStateStore.completePending` | after |
| After outbox accept, before publish | `AppOutbox.put` with `lastAttempt` set and no `acceptedAs` | after |
| After hub acknowledgement, before status persist and outbox removal | `AppOutbox.put` with `acceptedAs` | before |
| Mid-commit, after journal put | `CommitJournal.put` | after |

## Conformance additions

| Suite (`rpc-conformance`) | Case | Assertion |
|---|---|---|
| `testGroupStateStoreConformance` (new) | CAS conflict leaves storage unchanged | wrong `expected` throws `GroupStateConflictError`; `load` returns the prior record |
| | versions never repeat | a save with a version at or below any stored one, tombstone included, conflicts |
| | ambiguous write resolves by `writeID` | a store that commits then throws: `load` shows the attempt's `writeID` |
| | sender HWM survives restart | reserve, reopen the store, `load().senderHWM` is the reserved value; a registry built on it seals at a generation at or above it |
| | `saveOpened` is atomic | inject a failure in the pending insert: neither the record nor the pending row changes |
| | `saveOpened` is idempotent by frame ID | a second call with the same `frame.id` and a new version keeps one pending row |
| | pending order and completion | after reopen, `listPending` is in `(segment, position)` order; `completePending` twice resolves |
| | pending keeps the opened epoch | the record read back has the same `epoch` |
| | delete is one transaction | after `delete`, pending rows and group-keyed rows are gone and a stale CAS fails |
| | per-provider run | the suite runs on node-sqlite, postgres and expo (expo via its node test shim, or BLOCKED in phase 3 with the reason) |
| `testAppOutboxConformance` (extended) | attempt round-trip | `lastAttempt` with `sealed`, `publishID`, `acceptedAs` reads back byte-equal |
| `testCoordinatedOutboxConformance` (new) | rollback is total | `onPut` throws: the outbox has no new entry and the side row is absent |
| | visibility after commit | while `put` is pending, a root reader sees neither row; after it resolves, both |
| | nested transaction refused | constructing over a transaction-scoped provider throws |
| `testAppCursorStoreConformance` (new) | durable, per topic | `save` then reopen: `load(topicID)` returns it; other topics stay `null` |
| `testPendingGroupCryptoConformance` (extended) | opened epoch | the durable record's `epoch` equals the epoch `unwrap` returned |
| rpc peer tests | same-attempt replay | restart with an unacknowledged attempt at the same epoch republishes the same `publishID` and bytes |
| | re-seal is a new attempt | an epoch change before acknowledgement publishes under a new `publishID` |
| | horizon | an attempt with `preparedAt` 364 days old is re-sealed, not replayed |
| `hub-conformance` | dedup scope | the same `publishID` on two topics appends on both, on the memory store and `hub-store` |
