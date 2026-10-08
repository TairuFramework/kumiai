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
