# Spec P: transactional persistence — design

Date: 2026-10-08
Status: draft r3 (Codex r1, r2 folded in)
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

### Commit journal and key retention

- `PendingCommit.journal` is "everything needed to adopt this commit after a restart: the
  serialized post-commit handle and any Welcome to deliver" (`rpc/src/commit.ts:23-29`).
- On replay after a head mismatch, rpc clears the journal **then** keeps the lost-commit notice in
  memory (`rpc/src/peer.ts:1883-1888`); `takeLost` drops it from memory on read
  (`rpc/src/peer.ts:1927`). A crash between the two loses the intent.
- Commit replay re-frames the same MLS commit with fresh ledger-body nonces under the original
  `publishID` (`rpc/src/peer.ts:1859`, `mls-rpc/src/crypto.ts:64`); the hub returns the first
  acceptance and drops the rest (`hub-store/src/store.ts:195`).
- rpc separates a hub acknowledgement from delivery **proof** and re-seals an acknowledged entry
  from an older epoch until proof arrives (`rpc/src/log-delivery.ts:145-207`; regression at
  `rpc/test/peer-log-delivery.test.ts:667`). Publication evidence is memory only
  (`rpc/src/log-delivery.ts:43-45`), so a restart re-seals every entry still in the outbox.
- ts-mls keeps 10 skipped generation keys and refuses more than 200 forward ratchet steps by
  default (`ts-mls/dist/src/keyRetentionConfig.js`); kumiai does not override it
  (`mls/src/group-context.ts:59`). A decrypt refusal is consumed as dead
  (`rpc/src/app-lane.ts:761`).

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
  `busy_timeout` 5000 (`node-sqlite/src/index.ts:36-67`); Kysely's SQLite driver holds a connection
  mutex and issues plain `begin` (`hozon/node_modules/kysely/dist/driver/runtime-driver.js:49`,
  `.../dialect/sqlite/sqlite-driver.js:26`), so a root-store call made while a transaction is open
  waits for it. Postgres uses a postgres.js pool, so transactions run concurrently at the client's
  configured isolation, which Hozon passes through (`postgres/src/index.ts:61-82`). Expo has one
  connection behind a `ConnectionMutex`; every transaction and standalone query is exclusive, with
  plain deferred `begin transaction` (`expo/src/driver.ts:53-148`).
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
one database are unsupported and not detected.

### D2. Transactions and ambiguous outcomes

- Every multi-store write is one `db.withTransaction` on the **root** provider, and every store it
  writes is taken from that callback's `tx`. Each callback awaits every write it starts.
- Code holding a `tx` never awaits network, timers, another group's mutex, or a store taken from the
  root provider: on node-sqlite and expo the root store waits for the connection the transaction
  holds, so awaiting it deadlocks. Test barriers inside a transaction are the only exception.
- An atomic port method opens its own root transaction, resolves after it commits, and never
  accepts a caller's `tx`. `rpc-store` constructors take the root provider and refuse a
  transaction-scoped one; `StoreProvider` has no discriminator today (`hozon/packages/db/src/db.ts:31`),
  so Hozon adds one before phase 3.
- CAS updates read the affected-row count of a plain `UPDATE` (expo reports no count with
  `RETURNING`, `hozon/packages/expo/src/driver.ts:103`).
- **Ambiguous outcome.** A root transaction that rejects after its callback completed (a connection
  lost during `COMMIT`) may have committed; only postgres can produce one. Each port names its
  owner:
  - `GroupStateStore` rejects with `StorageOutcomeUnknownError`; the registry resolves it (D3).
  - The coordinated outbox resolves it internally (D7), so `AppOutbox`'s "a rejection leaves storage
    unchanged" still holds.

### D3. `GroupStateStore`

Lives in `mls-rpc` (`mls-rpc/src/state-store.ts`); bytes only, no `mls` import.

```ts
export type GroupStateRecord = {
  groupID: string
  /** Strictly increasing per group across every write, tombstones included. Starts at 1. */
  version: number
  /** Random per write. */
  writeID: string
  deleted: boolean
  /** MLS epoch of `state`. A tombstone keeps the last live epoch as an admission floor. */
  epoch: number
  /** `encodeClientState` output; empty when deleted. Includes the leaf signing key: encrypt at rest. */
  state: Uint8Array
  credential: { id: string; groupID: string } | null
  /** Signed ledger tokens in enactment order, repeats kept (`handle.ledgerTokens`). */
  ledger: Array<string>
  /** Sender generations at `epoch` are reserved below this. */
  senderHWM: number
}

/** A host operation recorded before its commit and cleared only by the adopting save. */
export type GroupIntent = { id: string; groupID: string; body: Uint8Array }

export type GroupStateWrite = {
  /** The version the caller read; `null` only when no record exists at all. */
  expected: { version: number } | null
  putIntent?: GroupIntent
  clearIntent?: string
}

export type GroupStateStore = {
  /** Returns tombstones too. */
  load(groupID: string): Promise<GroupStateRecord | null>
  /** Inventory, tombstones included. */
  list(): Promise<Array<Pick<GroupStateRecord, 'groupID' | 'version' | 'epoch' | 'deleted'>>>
  /** CAS write of the record and any intent change, in one transaction. */
  save(record: GroupStateRecord, write: GroupStateWrite): Promise<void>
  /** `save` plus an insert of `pending` that is a no-op if `pending.frame.id` exists. */
  saveOpened(record: GroupStateRecord, write: GroupStateWrite, pending: PendingAppFrame): Promise<void>
  /** Saves a tombstone (`deleted: true`), deleting the group's pending records, intents and every
   * rpc-store row keyed by the group, in one transaction. */
  delete(record: GroupStateRecord, write: GroupStateWrite): Promise<void>
  /** Uncompleted records of one group in `(segment, position)` order. */
  listPending(groupID: string): Promise<Array<PendingAppFrame>>
  /** Unknown IDs resolve. */
  completePending(groupID: string, id: string): Promise<void>
  /** Standalone intent write (no state change). */
  putIntent(intent: GroupIntent): Promise<void>
  listIntents(groupID: string): Promise<Array<GroupIntent>>
  clearIntent(groupID: string, id: string): Promise<void>
}

/** A CAS miss. Storage is unchanged. */
export class GroupStateConflictError extends Error {}
/** The transaction may or may not have committed. */
export class StorageOutcomeUnknownError extends Error {}
```

Rules:

- **CAS.** A write succeeds iff the stored version equals `expected.version` (or `expected` is
  `null` and no record exists) and `record.version` exceeds it. Within one epoch the store keeps
  `senderHWM` at the maximum of stored and written. A miss throws `GroupStateConflictError` and
  writes nothing. On postgres a serialization failure under a stricter isolation level is a
  conflict.
- **Ambiguous write.** On `StorageOutcomeUnknownError` the registry marks the group uncertain (every
  access throws `GroupStateUncertainError`) and `load`s: the attempt's `writeID` means it landed; the
  expected version (or no record) means it did not; anything else is a conflict. Reads retry with
  backoff up to 15 s; the group stays uncertain until one succeeds. Only the registry writes a group
  (D1), so no later write can hide the attempt's `writeID` before this read.
- **`saveOpened` retries.** A retry for the same frame is a CAS from the version the registry now
  holds; the pending insert is a no-op if the frame is already recorded, so one row remains.
- **Installation.**
  - Commits, Welcomes, durable opens and deletion run on a copy cloned from the **current cached**
    handle and install only after their save resolves.
  - Sends seal on the cached handle under the sender lease; the ratchet is not saved per send.
  - Non-durable live receives install immediately and flush in batches of 64 frames or 250 ms. A
    crash loses unflushed receive progress; those frames reopen after restart and message identity
    deduplicates them.
  - A durable-open conflict retries up to 8 times on a fresh clone, merging receive trees
    (application and handshake chains) as Kubun does, and never lowers sender progress.
  - Same-epoch adoption never reinstalls an older sender state.
- **Key retention.** `mls` makes key retention configurable on `MlsContext` (today
  `group-context.ts:59` takes ts-mls's defaults of 10 retained generations and 200 forward steps).
  `client` sets `retainKeysForGenerations: 1000` and `maximumForwardRatchetSteps: 1000`.
- **Sender lease.** Every sealing path reserves first. Before sealing, the registry needs a
  reservation at the current epoch with at least 4 generations left; otherwise it saves `senderHWM`
  raised by 16 (state unchanged). On restore the registry burns generations up to `senderHWM` before
  any seal. No generation is sealed twice.
- **Rotation.** When the next sender generation at the current epoch would reach 500
  (`ROTATE_AT`), the registry reports `SendAdmission` not admissible with reason
  `rotation-required`. rpc then holds app sends as it does for any inadmissible reason, and
  `client` commits a key rotation (D5). The new epoch resets every ratchet. This bounds:
  - any receiver's forward gap to 500 steps, under the 1000 limit, however many generations were
    burned by restores or consumed by seals that never landed;
  - skipped keys: fewer than 1000 generations exist per epoch, so live ephemeral frames can never
    push a retained frame out of the retention window.
- **Displacement.** A per-group lineage counter; a `GroupCrypto` built before a `seed({replace})`
  rejects `wrap` with `DisplacedGroupHandleError`. Replacement is epoch-monotonic.
- **Restore.** `list()` drives restore: each live record goes through `restoreGroup`, its pending
  records to its peer, and its intents to `client` (D5).

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
gains `epoch: number` on every path: durable delivery from the record, the non-durable drain and the
live path from `GroupUnwrapResult`. This breaks an rpc port type. Migrated in one change with both
contract suites and every double, including `rpc/test/fixtures/fake-crypto.ts:368`,
`mls-rpc/test/handle-access.test.ts:194` and `tests/integration`, verified with repo-wide
`turbo run test:types`.

### D5. Commits: journal, intents, adoption, Welcome

- **Operations.** `client`'s group operations (invite, remove, setRole, device add/revoke, leave,
  key rotation) each become one intent and one rpc `commit()`. Ledger operations sign their tokens
  **before** the intent is written.
- **Intent body.** `{kind, targets, role?, tokens?}`: the exact signed tokens for ledger
  operations, the target DIDs for invite/remove, nothing else for rotation. Written with `putIntent`
  before `commit()`.
- **Journal blob.** `encodeJournal({state, ledger, epochBefore, welcome?, intentID})`: the
  post-commit MLS state and ledger tokens, the epoch the commit was framed at, the Welcome with its
  recipients, and the intent it fulfils. No storage version is journalled.
- **Adoption** (`onAccepted` and `adoptJournalled`). The registry loads the current record:
  - `current.epoch === epochBefore`: save the journalled state as `version = current.version + 1`
    with `expected: current.version` and `clearIntent: intentID`. Durable opens at the departing
    epoch since the build (rpc delivers before adopting, `rpc/src/peer.ts:1161, 2236`) only bumped the
    version; their plaintext is already in pending records.
  - `current.epoch > epochBefore`: already adopted. The hub's head CAS lets only one commit land at
    `epochBefore`, and acceptance is journalled, so that commit is ours. Clear the intent if still
    present.
  - In both cases publish the Welcome, then rpc clears the journal. Welcome delivery is
    at-least-once; joining is idempotent.
- **Rotation commits** use a new `mls` builder, `commitKeyRotation(group)`: a proposal-free commit
  with an update path. Any member may issue one; receiving policy already accepts it
  (`mls/src/policy.ts:317-342`). `commitLedgerEntries` refuses empty token lists and requires admin
  rights by default (`mls/src/group-commit.ts:196, 375`), so it is not reused. It travels as rpc kind
  `ledger` with empty `bodies`.
- **Lost work.** On restart, and on rpc's lost-commit notice, `client` lists intents. An intent with
  a journal entry is left to rpc's replay. An intent without one is reconciled against the group's
  **authenticated state**, never against the actor's authorization:
  - invite: done if every target device is a member;
  - remove: done if no target device is a member;
  - ledger: done if every token is already in `handle.ledgerTokens` (by token identity);
  - rotation: done if the sender generation is below `ROTATE_AT`.

  Done intents are cleared. Others are re-enacted while the actor is still authorised, or reported
  as `commit:lost` and then cleared (at-least-once). A landed operation is never re-enacted, even
  past the hub's 365-day `publishID` horizon: its effect is visible in authenticated state. This
  closes rpc's clear-before-notice window (`rpc/src/peer.ts:1883-1888`) without changing rpc.
- **Welcome join.** The registry checks the stored record first:
  - none: save with `expected: null`;
  - live, at or above the Welcome's epoch: no-op success;
  - live, below: replaced only by `seed({replace: true})` (rejoin), CAS on its version;
  - tombstone: accepted only if the Welcome's epoch exceeds the tombstone's epoch, so a replayed old
    Welcome cannot resurrect a deleted group.
  
  A real re-invite is a new commit, so its epoch is higher. Key-package private keys are deleted on
  use; phase 1 confirms `mls-hub` does this.
- **Others' commits.** Adoption is a CAS save from the version read. A replayed older commit returns
  `advanced: false` from `GroupMLS` as today, and nothing is written.

### D6. Outgoing attempts and publication status

- **Restart never replays stored ciphertext.** Every entry still in the outbox is re-sealed after
  restart, as rpc does today. A landed earlier attempt is a duplicate occurrence that message
  identity absorbs; with D3's retention bounds, at least one occurrence decrypts.
- **Attempt identity.** Each seal gets a fresh `publishID`; an in-process retry of the same bytes
  reuses it, so the hub appends it once. `AppOutboxEntry.lastAttempt` gains `publishID` and
  `segment`. No ciphertext is stored.
- **Publication record.** rpc's in-memory `Publication` (`rpc/src/log-delivery.ts:17`) gains
  `{publishID, segment, sequenceID}`, filled from the hub's acknowledgement. `publish` returns the
  `PublishResult` instead of `unknown`.
- **Acknowledgement is not proof.** rpc's proof logic is unchanged: an acknowledged entry from an
  older epoch is re-sealed until proof.
- **Status.** `pending` (memory, until the first `put` commits) → `accepted` (that `put`) →
  `published` at proof. rpc calls `remove(seq, {segment, position})`, an optional second parameter,
  with the `segment` and `sequenceID` of the publication that proof certified. It retries the same
  call on failure. `published` and the position are written in the same transaction as the removal
  (D7).
- **Which occurrence.** The sender's position is the proven publication's. An earlier attempt that
  also landed is a duplicate occurrence: receivers keep their first, as in the umbrella's ordering
  rule.
- **Clear.** When rpc clears the outbox (removal from the group), unpublished messages become
  `failed` in the same transaction.
- **Hub double.** The `hub-server` memory store's dedup is re-keyed by `(topicID, publishID)` with
  `hub-store`'s 365-day expiry, so the double is no more permissive than the real store.

### D7. Coordinated outbox adapter

Generic, in `rpc-store`:

```ts
export type CoordinatedOutboxHooks = {
  onPut(tx: StoreProvider, entry: AppOutboxEntry): Promise<void>
  onRemove(tx: StoreProvider, entry: AppOutboxEntry, outcome?: { segment: number; position: string }): Promise<void>
  onClear(tx: StoreProvider, entries: Array<AppOutboxEntry>): Promise<void>
}
export function createCoordinatedOutbox(params: {
  db: HozonDB // root provider
  groupID: string
  hooks: CoordinatedOutboxHooks
}): AppOutbox
```

- `put`, `remove`, `clear` and `putCommitCursor` each run one root transaction: read the affected
  entries from the `tx` outbox, write the outbox, await the hook, and write a fresh `mutationID` to
  the group's outbox meta row.
- **Ambiguous commit.** The adapter reads the meta row in a fresh transaction. Its `mutationID`
  equal to the attempt's means committed and the call resolves; otherwise it did not commit and the
  call rejects. Only this adapter writes the outbox (D1), so no later write can hide the
  attempt. If the read itself fails, the adapter retries with backoff (cap 15 s), keeps the call
  pending, and refuses other calls on that outbox until it settles. rpc's sequence reservation stays
  held meanwhile.
- rpc's `accept` holds the sequence reservation until `put` resolves
  (`rpc/src/app-outbox.ts:118-128`), so nothing is published before the commit.
- `messaging`'s hooks correlate by **message identity** decoded from `entry.data` (rpc exports
  `decodeAppEntry(entry): {procedure, payload}`, added in phase 2 if missing), never by `seq`,
  which restarts at 0 once the outbox empties (`rpc/src/app-outbox.ts:66-81`):
  - `onPut` inserts the row as `accepted` once and ignores later puts of the same message;
  - `onRemove` with an outcome sets `published` and the position unless one is already set;
  - `onClear` sets unpublished rows `failed`.
- Memory doubles: `createMemoryTransaction()` gives a shared in-memory store set with snapshot and
  rollback, used by the memory outbox and the memory `MessageStore`.

### D8. Provider guarantees

| Claim | node-sqlite | postgres | expo |
|---|---|---|---|
| One root transaction commits all its stores or none | yes | yes | yes |
| Root `withTransaction` resolves after commit | yes | yes | yes |
| CAS by plain conditional `UPDATE` and affected-row count | yes, one connection | yes at READ COMMITTED; stricter levels raise serialization failures, mapped to conflict | yes, serialised; no `RETURNING` |
| Concurrent transactions | serialised by connection mutex | concurrent (pool) | serialised by `ConnectionMutex` |
| Root-store call while a transaction is open | waits; deadlocks if awaited inside (D2) | separate connection | waits; deadlocks if awaited inside (D2) |
| Commit outcome can be ambiguous | no (in-process) | yes (network) | no (in-process) |

## Crash seams

No production hooks. Every seam is a test-only wrapping store (or wrapped hub client) in
`tests/e2e` that awaits `seam(name)` before or after delegating; the child-process agent blocks
there, reports the seam and is killed. "After" means after the delegated promise resolved, which
for every wrapped store method is after its transaction committed.

| Point | Wrapped method | When |
|---|---|---|
| After decrypt, before the ratchet-plus-pending save | `GroupStateStore.saveOpened` | before |
| After that save, before message persist | `GroupStateStore.saveOpened` | after |
| After message persist, before pending completion | `MessageStore.put` | after |
| After pending completion, before cursor advance | `GroupStateStore.completePending` | after |
| After outbox accept, before publish | `AppOutbox.put` with `lastAttempt: null` | after |
| After hub acknowledgement, before local bookkeeping | hub client `publish` on an app topic | after |
| After proof, before status persist and outbox removal | `AppOutbox.remove` | before |
| Mid-commit, after journal put | `CommitJournal.put` | after |
| After intent, before journal put | `GroupStateStore.putIntent` | after |
| After acceptance, before adoption | `CommitJournal.markAccepted` | after |
| After adoption, before journal clear | `CommitJournal.clear` | before |
| After journal clear on a lost commit, before the intent is reconciled | `CommitJournal.clear` with no adoption | after |
| After a lease reservation, before the first seal | `GroupStateStore.save` raising `senderHWM` | after |

The first seven are the umbrella's scenario-8 points (its acknowledgement point now has two seams,
acknowledgement and proof); the rest cover D3 and D5.

## Conformance additions

Harness requirements: a reopen/restart factory per store (including `CommitJournal`, whose suite
has none today, `rpc-conformance/src/commit-journal.ts:21`); failure injection inside the second
write of an atomic method; a commit-then-reject injector for ambiguous outcomes; seeding and
inspection of group-keyed rows; a real registry over real MLS for generation cases; clock control;
the expo provider through a node shim (or BLOCKED in phase 3 with the reason); and a test barrier
inside a transaction for the postgres isolation case (the only D2 exception).

| Suite | Case | Assertion |
|---|---|---|
| `testGroupStateStoreConformance` (new, `rpc-conformance`) | CAS conflict leaves storage unchanged | wrong `expected` throws `GroupStateConflictError`; `load` returns the prior record |
| | versions never repeat | a write at or below the stored version, tombstone included, conflicts |
| | ambiguous outcome is reported, not guessed | commit-then-reject on a save, an `expected: null` save and a delete: the store throws `StorageOutcomeUnknownError` and `load` shows the attempt's `writeID` |
| | rollback is total | failure injected in the intent half of a save: neither the record nor the intent changes |
| | sender HWM never decreases | a same-epoch save with lower `senderHWM` stores the maximum |
| | `saveOpened` is atomic | failure injected in the pending insert: neither record nor pending row changes |
| | `saveOpened` retry keeps one row | a second call for the same `frame.id`, CAS from the current version, succeeds with one pending row |
| | pending order, epoch and completion | after reopen, `listPending` is `(segment, position)` ordered, keeps `epoch`; `completePending` twice resolves |
| | delete is one transaction | after `delete`, pending rows, intents and group-keyed rows are gone; the tombstone keeps its epoch; a stale CAS fails |
| | per provider | the suite runs on node-sqlite, postgres and expo |
| `testCommitJournalConformance` (extended) | durable across reopen | `put`, `markAccepted`, reopen: `get` returns the entry with `acceptedAs` |
| `testAppOutboxConformance` (extended) | attempt round-trip | `lastAttempt.publishID` and `segment` read back |
| `testCoordinatedOutboxConformance` (new) | rollback is total | each hook throwing leaves the outbox and side rows unchanged |
| | resolves after commit | an `onCommit` hook registered inside `onPut` has fired before `put` resolves |
| | isolation (postgres) | while `onPut` is held at a test barrier, a reader on another connection sees neither row |
| | ambiguous commit | commit-then-reject on `put` (including an attempt replacement with the same `seq` and `data`), `remove`, `clear`: resolves iff the write committed |
| | outcome reaches the hook | `remove(seq, outcome)` passes `outcome` to `onRemove`; a retried remove passes it again |
| | nested transaction refused | constructing over a transaction-scoped provider throws |
| `testAppCursorStoreConformance` (new) | durable, per topic | `save` then reopen: `load(topicID)` returns it; other topics stay `null` |
| `testPendingGroupCryptoConformance` (extended) | opened epoch | the durable record's `epoch` equals the epoch `unwrap` returned |
| registry tests (`mls-rpc`) | lease survives restart | reserve, restart, seal: the generation is at or above the stored `senderHWM` |
| | rotation bound | seals reaching `ROTATE_AT`, with restarts and unpublished seals in between, make admission report `rotation-required`; no receiver sees a forward gap above 500 |
| | live overtaking retained | a receiver opens later ephemeral frames before pulling an earlier retained frame from the same sender at the same epoch: the retained frame still opens |
| | same-epoch adoption keeps sender progress | seal, adopt a same-epoch replacement, seal: generations strictly increase |
| | adoption after intervening opens | durable opens at the departing epoch between build and acceptance: adoption succeeds |
| | adoption is recognised later | adopt, more writes, crash before journal clear: replay skips the save and resends the Welcome |
| | tombstone floor | after delete, a replayed Welcome at or below the tombstone epoch is refused; a higher one joins |
| `client` tests | lost ledger operation | head mismatch on replay, crash after journal clear: the intent's tokens are re-issued exactly |
| | landed operation is not re-enacted | a promotion landed, a later demotion landed, the promotion's journal is gone: reconciliation clears the intent and the demotion stands |
| | rotation | `rotation-required` leads to a key-rotation commit by a non-admin member, and sends resume at the new epoch |
| rpc peer tests | restart re-seals | an unproven entry after restart is sealed under a new `publishID`, never republished as stored bytes |
| | acknowledged but unproven | acknowledgement at E, epoch moves to E+1 before proof, restart: re-sealed at E+1, removed only at proof |
| | position is the proven publication | proof calls `remove(seq, outcome)` with the certified publication's `segment` and `sequenceID` |
| `hub-conformance` | dedup scope | the same `publishID` on two topics appends on both, on the memory store and `hub-store` |

## Umbrella amendments

Applied to the parent in phase 1's reconciliation step:

- [Semantics → Attempt identity]: no replay of the same attempt after a restart; no 365-day horizon
  rule; ciphertext is not stored.
- [Semantics → Publish status]: `published` at proof, written with the outbox removal; the
  `AppOutbox` change is an optional `remove` parameter, and rpc's `publish` returns the hub's
  `PublishResult`.
- [Package layout → `mls`]: configurable key retention on `MlsContext`; `commitKeyRotation`.
- Scenario 8: the acknowledgement point splits into acknowledgement and proof; add the D3 and D5
  seams.
- [Flows]: group operations go through durable intents (D5).

## Review log

- **Codex r1** (blockers): D5's blob could not adopt an accepted commit (journal must carry the
  post-commit state and Welcome) — fixed. Acknowledgement treated as proof — fixed (D6). Replaying
  stored ciphertext after restart can fall below receivers' 10-key window — fixed by never
  replaying. High: lease burns can exceed the 200 forward-step limit — burn budget; lost-intent
  window — intents; D7 ignored remove/clear and correlated by `seq` — hooks and identity
  correlation; ambiguous commit outcome — read-back; advisory lock unspecified — dropped (D1).
  Medium: node-sqlite waits rather than joins; visibility test untestable on single-connection
  providers; migration sites named; `GroupMLS` "applied" wording. All verified in source and folded.
- **Codex r2** (blockers): adoption CAS on a journalled version goes stale when rpc delivers durable
  opens before adopting — adoption now keys on epoch and allocates against the current record. The
  empty ledger commit has no builder (`commitLedgerEntries` refuses empty lists, admin by default) —
  new `commitKeyRotation`. High: lease burns and unlanded seals can exceed the forward limit, and live
  ephemeral frames can push retained frames out of the 10-key window — configurable retention
  (1000/1000) plus rotation at generation 500. Intents lacked the exact tokens, and authorization
  alone could re-enact a landed operation — tokens in the intent and reconciliation against
  authenticated state. rpc's `Publication` has no app `sequenceID` — kept from the acknowledgement.
  Outbox read-back could not tell attempt replacements apart — `mutationID` meta row. A tombstone let
  an old Welcome resurrect a group — epoch floor. D2 and D3 disagreed on who resolves ambiguity —
  named per port. Medium/low: expo `RETURNING` counts, `saveOpened` retry semantics, test barrier
  exception, missing cases. All verified in source and folded.
