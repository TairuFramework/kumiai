# Spec P: transactional persistence — design

Date: 2026-10-08
Status: draft r12
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
(phase 0)

Spec P fixes the contracts phase 2 implements on memory doubles. P2a crash-safe control has
landed on `feat/spec-p-phase-2` and is binding, with the r10 admission, r11 budget and r12 terminal-settlement amendments below.
This spec adds no second control journal.

## Scope and handoff

| Phase | Work |
|---|---|
| 2 | `rpc`, `mls`, `mls-rpc`, `mls-hub`, `rpc-conformance` and `hub-client` contracts and runtime additions. Version-2 state and recovery codecs first. Registry over `GroupStateStore`, spent-epoch admission, application/handshake reservations, codec-injected shared memory stores including anchors, extracted tunnel encryptor, D4 metadata, D6 attempts/outcomes, D7 decoding and outcome-aware hook fixtures. Both contract suites against real crypto/MLS/HTTP and doubles. Real HTTP hub plus in-process two-device group-peer smoke. |
| 3 | `rpc-store`: Hozon stores, coordinated outbox, state/control/anchor co-commit, tombstones and hooks. Provider discriminator and outcome-aware hook prerequisites in Hozon. sqlite/postgres/expo conformance, persistence and provider failure tests. |
| 4 and 5 | `client` ownership, Welcome inventory/consume wiring, rotation scheduling, deletion orchestration; `messaging` hooks, `MessageStore`, status events and deduplication. Phase 2 tests these contracts with host fixtures, without creating either package. |
| 6 | Child-process driver and every SIGKILL seam. In-process reconstruction is not kill-a-process evidence. |

D4's rpc migration includes only the supporting optional metadata forwarding in `broadcast`.
This is an explicit dependency of exposing epoch on live events and anycast requests (r6 decision).
No broadcast wire-version change or new delivery policy is required.

## Context

Checked on 2026-10-09, branch `feat/spec-p-phase-2`. Code paths are relative to `packages/` unless
prefixed with `../`, `node_modules/` or `tests/`. Destinations in Decisions are proposed unless labelled landed.

### rpc and P2a today

- **Durable open.** `unwrap` owns atomic spent-state plus pending persistence (`rpc/src/crypto.ts:81`,
  `mls-rpc/src/crypto.ts:173`). Failures are retryable `AppFrameStorageError`
  (`rpc/src/crypto.ts:204`, `mls-rpc/src/crypto.ts:195`, `rpc/src/app-lane.ts:757`).
- `frame.segment` is the app anchor epoch (`rpc/src/app-lane.ts:731`). Pending records omit opened
  epoch (`rpc/src/crypto.ts:190`, `rpc/src/app-lane.ts:770`), although unwrap returns it
  (`rpc/src/crypto.ts:253`). Conformance also drops it (`rpc-conformance/src/pending-group-crypto.ts:13`,
  `rpc-conformance/src/pending-group-crypto.ts:24`).
- Durable handlers resolve before completion, then cursor saving (`rpc/src/app-lane.ts:542`,
  `rpc/src/app-lane.ts:498`, `rpc/src/app-lane.ts:513`). Failures retry with backoff
  (`rpc/src/app-lane.ts:574`). Malformed, own and non-log records complete without delivery
  (`rpc/src/app-lane.ts:521`, `rpc/src/app-lane.ts:529`). Unknown completion succeeds
  (`rpc/src/crypto.ts:199`). Completion and cursor saving remain ordered, not atomic.
- Events expose optional `frame`; requests retain Enkaku contexts (`rpc/src/handlers.ts:19`).
  Live opens retain epoch (`rpc/src/peer-epoch.ts:177`), but broadcast transport/responder discard it
  (`broadcast/src/transport.ts:148`, `broadcast/src/responder.ts:180`). Directed projection and
  handler adaptation also omit it (`rpc/src/directed.ts:85`, `rpc/src/directed.ts:273`).
- Acceptance awaits `put` before memory admission (`rpc/src/app-outbox.ts:109`). Delivery persists
  the attempt before publish (`rpc/src/log-delivery.ts:170`). Publication evidence remains in memory;
  persisted attempts contribute only their counter (`rpc/src/log-delivery.ts:43`, `rpc/src/log-delivery.ts:167`).
- **Landed control.** `ControlStore` owns operations, rejoin, outcomes, Welcomes, applied rows,
  responses and cursor (`rpc/src/control/types.ts:4`). `AdoptionWrite` crosses handle persistence
  (`rpc/src/control/types.ts:39`, `mls-rpc/src/access.ts:18`, `mls-rpc/src/access.ts:37`).
  AppOutbox has only `put/list/remove/clear` (`rpc/src/app-outbox.ts:25`).
- Control replay publishes exact saved bytes and ID (`rpc/src/control/types.ts:75`,
  `rpc/src/control/operations.ts:186`). Settlement co-writes durable outcomes before emitting
  (`rpc/src/control/operations.ts:101`). Rejoin persists its request key and candidate
  (`rpc/src/control/types.ts:110`, `rpc/src/control/types.ts:117`); request creation/restore pass keys
  explicitly (`mls-rpc/src/mls.ts:386`, `mls-rpc/src/mls.ts:464`). The old memory-map comment is stale.
- Anchor persistence precedes memory publication (`rpc/src/peer.ts:398`, `rpc/src/peer.ts:410`).
  Adoption co-commits `pending.landed` (`rpc/src/control/types.ts:43`), checked during resolution
  (`rpc/src/peer.ts:426`). The independent revoke hold derives from unsettled operations
  (`rpc/src/control/operations.ts:20`), and gates retained log submissions (`rpc/src/peer.ts:643`).
- Welcome open is non-consuming and returns a source-scoped join ref (`mls-hub/src/join.ts:26`,
  `mls-hub/src/join.ts:31`). `consume/receipt` and admission comparison are landed
  (`mls-hub/src/join.ts:11`, `mls-hub/src/admission.ts:7`). Atomic readmission reset exists in the host
  fixture (`rpc/test/fixtures/host-db.ts:105`, `rpc/test/fixtures/host-db.ts:115`).
- **Welcome replay gap, checked 2026-10-09.** Live admission compares only current epoch (`mls-hub/src/admission.ts:8`).
  Last-resort consume writes no receipt (`mls-hub/src/provisioner.ts:253`); repeats reopen (`mls-hub/test/join.test.ts:320`).
  Welcome reconstruction derives the original encryption secret and creates a fresh tree
  (`node_modules/ts-mls/dist/src/clientState.js:603`, `node_modules/ts-mls/dist/src/clientState.js:607`).
  Thus A3 replay after lower recovery to B2 can reinstate spent sender generations. Lineage does not change MLS secrets.
- **Alternate Welcome representation (r10 decision), checked 2026-10-09.** The author encrypts joiner secrets for recipients
  (`node_modules/ts-mls/dist/src/createCommit.js:143`). Signed GroupInfo extensions are separate from GroupContext
  (`node_modules/ts-mls/dist/src/groupInfo.js:12`). Different valid Welcome bytes can therefore install the same epoch authenticator and secrets.
  An artifact digest cannot identify spent epoch secrets.

### Publication and handle state today

- App publication omits an ID (`rpc/src/peer.ts:656`); mux forwards supplied IDs and returns only
  `{sequenceID}` (`rpc/src/hub-mux.ts:777`, `rpc/src/hub-mux.ts:792`). HTTP has that same result
  (`hub-protocol/src/protocol.ts:49`); store `PublishResult` additionally requires `deduped`
  (`hub-protocol/src/types.ts:66`).
- Real dedup is `(topicID, publishID)` (`hub-store/src/migrations.ts:99`). Purge expires records at
  `recorded_at <= now - 365 days` (`hub-store/src/store.ts:63`, `hub-store/src/store.ts:497`).
  Duplicate fan-out is suppressed (`hub-server/src/handlers.ts:446`). The memory store keys by ID
  alone, indefinitely (`hub-server/src/memoryStore.ts:136`, `hub-server/src/memoryStore.ts:216`).
- Restart resealing and acknowledgement-versus-proof already exist (`rpc/src/log-delivery.ts:145`,
  `rpc/src/log-delivery.ts:194`). Extend existing restart/race tests, rather than count new coverage
  (`rpc/test/peer-log-delivery.test.ts:554`, `rpc/test/peer-log-delivery.test.ts:669`,
  `rpc/test/peer-log-delivery.test.ts:1093`).
- Certification and acknowledged-entry skipping compare epoch numbers only
  (`rpc/src/log-delivery.ts:92`, `rpc/src/log-delivery.ts:146`). The no-new-head proof also lacks identity
  (`rpc/src/log-delivery.ts:194`). Forced recovery recaptures the anchor (`rpc/src/peer.ts:440`).
- Recovery builds from responder GroupInfo (`mls-rpc/src/recovery.ts:146`, `mls/src/group-welcome.ts:328`),
  then installs through `access.replace` (`mls-rpc/src/mls.ts:218`). No local-epoch lower bound applies there.
- HandleAccess lacks record metadata mutation (`mls-rpc/src/access.ts:12`). Durable crypto requires
  host `pending.persistOpened` (`mls-rpc/src/crypto.ts:97`, `mls-rpc/src/crypto.ts:179`).
- Handles are memory-backed (`mls/src/group-handle.ts:367`). Restore takes state, credential and
  ledger tokens separately and re-verifies tokens (`mls/src/group-create.ts:155`,
  `mls/src/group-create.ts:174`). Tokens preserve repeated enactments (`mls/src/group-handle.ts:493`).
  State includes the signing key (`mls/src/group-lifecycle.ts:102`); credential is `{id, groupID}`
  (`mls/src/credential.ts:11`). Policy, context, resolvers, entry slot and recovery configuration
  are host-supplied (`mls/src/group-handle.ts:345`, `mls-rpc/src/mls.ts:104`).
- The state codec is version 1 and delegates to ts-mls (`mls/src/codec.ts:25`, `mls/src/codec.ts:49`).
  Kubun preserves proposal senders in a ledger JSON envelope (`../kubun/packages/plugin-p2p/src/groups/mls-state.ts:39`,
  `../kubun/packages/plugin-p2p/src/groups/mls-state.ts:73`). D3 instead keeps metadata inside state bytes.
- Simple access serialises but mutates the live handle, saving after mutation and before replacement
  (`mls-rpc/src/access.ts:43`, `mls-rpc/src/access.ts:76`, `mls-rpc/src/access.ts:93`). Wrap saves per
  send (`mls-rpc/src/crypto.ts:148`). The persistent registry remains new (`mls-rpc/src/index.ts:22`).
- Same-epoch merge already exists for both chains (`mls/src/secret-tree.ts:17`, `mls/src/secret-tree.ts:35`).
  P2a's carry copies current progress into candidate history; it does not implement current-state
  leases/merging (`mls/src/group-handle.ts:910`, `mls/src/group-handle.ts:929`). Recovery and revoke
  build still report lineage zero (`mls-rpc/src/mls.ts:289`, `mls-rpc/src/revoke.ts:60`).
- **Handshake rebuild gap (r10 decision), checked 2026-10-09.** The helper creates private commits (`mls/src/group-commit.ts:333`).
  ts-mls discards the advanced protection tree (`node_modules/ts-mls/dist/src/createCommit.js:77`); commits consume the handshake chain
  (`node_modules/ts-mls/dist/src/secretTree.js:237`). Head mismatch can rebuild without changing MLS identity (`rpc/src/control/operations.ts:194`).
  Application reservations alone do not protect that rebuild.
- **Handshake forward-window gap (r11 decision), checked 2026-10-09.** Unbounded unpublished reservations can strand receivers at generation zero.
  ts-mls rejects jumps exceeding `maximumForwardRatchetSteps` (`node_modules/ts-mls/dist/src/secretTree.js:104`).
  D3's required receiver configuration is 1000 steps. Today's context omits that override (`mls/src/group-context.ts:59`), leaving the default 200.
- Default retention is 10 skipped keys/200 forward steps (`node_modules/ts-mls/dist/src/keyRetentionConfig.js:2`).
  Context construction omits `clientConfig` (`mls/src/group-context.ts:59`); derivation makes a fresh
  default context (`mls/src/group-handle.ts:1758`). Recovery restore also omits retention
  (`mls-rpc/src/mls.ts:471`, `mls-rpc/src/recovery.ts:166`).

### Hozon and conformance today

- Root stores auto-commit; transaction stores use that callback's Kysely handle
  (`../hozon/packages/db/src/db.ts:148`, `../hozon/packages/db/src/db.ts:208`). Nested transaction-provider
  calls run inline before the outer commit (`../hozon/packages/db/src/db.ts:229`). The root promise
  returns after commit/hooks (`../hozon/packages/db/src/db.ts:274`, `../hozon/packages/db/src/db.ts:290`).
- Providers have no root discriminator (`../hozon/packages/db/src/db.ts:31`). Hozon sets no explicit
  isolation (`../hozon/packages/db/src/db.ts:194`). Postgres passes client options to its pool
  (`../hozon/packages/postgres/src/index.ts:61`, `../hozon/packages/postgres/src/index.ts:73`).
  Spare connection capacity is not guaranteed. Expo serialises connection access and plain begin
  (`../hozon/packages/expo/src/driver.ts:53`, `../hozon/packages/expo/src/driver.ts:72`).
- **At-rest gap, checked 2026-10-09.** Hozon parameters supply adapter/logger/prefix, without an implicit encryption contract
  (`../hozon/packages/db/src/db.ts:72`). Node-sqlite opens stock `DatabaseSync` (`../hozon/packages/node-sqlite/src/index.ts:36`).
  Expo opens `expo-sqlite` (`../hozon/packages/expo/src/index.ts:23`); postgres constructs its client separately (`../hozon/packages/postgres/src/index.ts:73`).
  Kubun generates and persists an outbox key (`../kubun/packages/store-p2p/src/ops/app-outbox.ts:274`); this spec does not adopt that policy.
- Postgres transport errors reject queries without backend-completion evidence
  (`../hozon/node_modules/postgres/src/connection.js:381`). Hozon's catch runs rollback hooks and rethrows
  (`../hozon/packages/db/src/db.ts:275`); that catch alone cannot prove a lost COMMIT rolled back.
- `rpc-conformance`: AppOutbox 3 cases (`rpc-conformance/src/app-outbox.ts:25`), ControlStore 9
  (`rpc-conformance/src/control-store.ts:256`), AnchorStore 1 (`rpc-conformance/src/anchor-store.ts:27`),
  pending crypto 8 (`rpc-conformance/src/pending-group-crypto.ts:73`). ControlStore replaces the
  journal suite (`rpc-conformance/src/index.ts:33`). No AppCursorStore suite is exported
  (`rpc-conformance/src/index.ts:21`); its port exists (`rpc/src/app-cursor.ts:30`).

## Decisions

### D1. One owner per database

A device's Hozon database is written by one live process. Within it, each group has one owner: the
`GroupHandleRegistry` instance, which serialises that group's writes behind a per-group mutex. CAS
versions catch bugs and displaced handles; they are not a multi-process protocol. Two processes on
one database are unsupported and not detected.

**Shared storage gate (r7 decision).** Export this Hozon-free port from rpc:

```ts
export type GroupMutationGate = {
  run<TValue>(groupID: string, work: () => Promise<TValue>): Promise<TValue>
  holdUntil(groupID: string, completion: Promise<void>): void
}
// Phase 3 rpc-store: one WeakMap entry per canonical root HozonDB object.
export function getGroupMutationGate(db: HozonDB): GroupMutationGate
```

Independently constructed state/control/anchor/cursor/outbox adapters obtain that same gate from the same root object.
MemoryDatabase owns the equivalent gate. Factories never create a private per-adapter gate.
Registry operations enter `store.mutationGate.run` across preparation, persistence and ambiguity resolution.
State methods called there do not reacquire it. Coordinated outbox, anchor-save and cursor-save methods acquire it internally.
ControlStore.apply also enters it; lastMutation performs resolver work outside it.
Conformance direct state writes also enter the gate. Reentrant acquisition is refused.

Deletion enters the registry's gate after lifecycle drain; its transaction writes outbox rows directly.
Hooks use transaction stores, never public outbox methods. Keep the gate held through failed barrier/read retries.

`holdUntil` registers a completion latch before the current `run` releases; later runs await it.
The completion promise resolves only after D2's barrier, retrying failures internally.
On ambiguous `ControlStore.apply`, the adapter registers that latch and rejects to the peer.
Its background completion barrier survives peer cancellation; `lastMutation` bypasses the gate and performs D2's barrier/read.
The peer still classifies the result. Deletion cannot overtake an unresolved control transaction.

### D2. Transactions and ambiguous outcomes

- Every multi-store write is one `db.withTransaction` on the **root** provider, and every store it
  writes is taken from that callback's `tx`. Each callback awaits every write it starts.
  Phase 3 persistence uses D2's outcome-aware overload below.
- Code holding a `tx` never awaits network, timers, another group's mutex, or a store taken from the
  root provider: on node-sqlite and expo the root store waits for the connection the transaction
  holds, so awaiting it deadlocks (`../hozon/node_modules/kysely/dist/driver/runtime-driver.js:49`,
  `../hozon/packages/expo/src/driver.ts:66`). Test barriers inside a transaction are the only exception.
- An atomic port method opens its own root transaction, resolves after it commits, and never
  accepts a caller's `tx`. `rpc-store` constructors take the root provider and refuse a
  transaction-scoped one; `StoreProvider` has no discriminator today (`../hozon/packages/db/src/db.ts:31`),
  so Hozon adds `StoreProvider.scope: 'root' | 'transaction'` before phase 3 (r6 decision).
  Factories refuse non-root scope with `NonRootProviderError`, exported by rpc-store with explicit
  `name = 'NonRootProviderError'` and inherited Error constructor. Phase 2 uses MemoryDatabase instead.
- CAS updates read the affected-row count of a plain `UPDATE` (expo reports no count with
  `RETURNING`, `../hozon/packages/expo/src/driver.ts:104`).
- **Ambiguous outcome.** A root transaction that rejects after its callback completed (a connection
  lost during `COMMIT`) may have committed; the supported failure model treats postgres COMMIT
  transport loss as ambiguous.
  SQLite/Expo count as known only after COMMIT/ROLLBACK completion is established (r7 decision).
  Otherwise they use the same completion barrier. Phase 3 verifies each provider's failure paths.
  Each port names its owner:
  - `GroupStateStore` rejects with `StorageOutcomeUnknownError`; the registry resolves it (D3). This
    includes adoption saves carrying P2a's `AdoptionWrite`, whose `mutationID` is the `writeID`.
  - P2a's `ControlStore.apply` (no state change) is resolved by the peer through `lastMutation()`.
    The adapter's `lastMutation()` completes the barrier before returning a negative marker (r7 decision).
  - The coordinated outbox resolves it internally (D7), so `AppOutbox`'s "a rejection leaves storage
    unchanged" contract (`rpc/src/app-outbox.ts:26`) still holds.
  - **Independent anchor/cursor saves (r8 decision).** Their adapters resolve ambiguity internally before settling the save promise.
    Each save records an adapter-private mutationID beside its slot/topic row, within the root transaction.
    D2's barrier precedes readback. Matching mutationID succeeds; the exact previous marker/absence rejects as known rollback.
    Other markers or failed reads keep the caller and group gate paused, using D3's retry backoff.
    Peer cancellation never cancels this resolver. Public `AnchorStore`/`AppCursorStore` signatures stay unchanged
    (`rpc/src/anchor.ts:28`, `rpc/src/app-cursor.ts:30`).
    Today anchor rejection escapes (`rpc/src/peer.ts:376`), and drain counts promise settlement (`rpc/src/host-boundary.ts:149`).
    Kubun writes the anchor independently (`../kubun/packages/plugin-p2p/src/groups/anchor-store.ts:35`).
    Phase 2 implements the shared doubles/cases; phase 3 implements and verifies provider saves.

**Completion barrier (r7 decision).** A negative ordinary read never proves rollback.
Every state/open/Welcome/delete, control apply, anchor save, cursor save and coordinated-outbox transaction first upserts
`groupOwner(groupID PRIMARY KEY, lockValue)` and executes unconditional `UPDATE lockValue = lockValue`.
Keep that row across deletion. An initially absent state/meta/control row still has this locking path.

After an ambiguous rejection, retain the application mutation gate and sequence reservation.
Run a fresh root transaction: upsert/update the same owner row, then read markers in subsequent statements.
Return its result only after that root transaction completes. The barrier never changes logical mutation markers.
On postgres, use READ COMMITTED. The conflicting insert/update waits for the original transaction to finish.
The subsequent SELECT then observes its final outcome, including a late commit.
This follows [PostgreSQL's update and snapshot rules](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED), checked 2026-10-09.
Do not reuse a pre-lock snapshot. Retry serialization, connection or barrier failures without releasing writers.

SQLite uses the same first-write barrier before reading, acquiring its writer lock under
[SQLite's transaction rules](https://www.sqlite.org/lang_transaction.html), checked 2026-10-09.
Hozon node-sqlite uses Kysely's SQLite driver (`../hozon/packages/node-sqlite/src/index.ts:44`),
which awaits BEGIN/COMMIT/ROLLBACK (`../hozon/node_modules/kysely/dist/dialect/sqlite/sqlite-driver.js:26`).
Expo awaits those statements under its connection mutex (`../hozon/packages/expo/src/driver.ts:66`,
`../hozon/packages/expo/src/driver.ts:75`, `../hozon/packages/expo/src/driver.ts:79`).
Successful connection acquisition alone is insufficient after a failed rollback.
Quarantine an uncertain connection until completion or verified disposal, then use a clean root transaction.
Retry busy/locked failures outside the transaction. No timeout or negative read releases a writer.

P2a's peer remains the control ambiguity owner. This refines `lastMutation()` completion semantics;
it changes neither its signature nor P2a's confirmed-recovery/source-check contract.

**Outcome-aware hooks (r8 decision), phase-3 Hozon prerequisite.** Today Hozon runs rollback hooks on every transaction rejection
and commit hooks only on success (`../hozon/packages/db/src/db.ts:275`, `../hozon/packages/db/src/db.ts:286`).
Marker readback cannot recover discarded hooks. Add this optional root `withTransaction` overload option:

```ts
export type TransactionHookSettlement = {
  settle(outcome: 'committed' | 'rolled-back'): void
}
export type OutcomeAwareTransactionOptions = {
  onUnknown(settlement: TransactionHookSettlement): void
}
// Root withTransaction(fn, options?) retains its existing Promise/result and tx hook API.
```

Shared persistence adapters always supply `onUnknown`, including memory adapters' `transact` calls.
Known commit runs commit hooks before resolution. Known rollback runs rollback hooks before rejection.
Uncertain completion retains both queues and calls `onUnknown` before rejecting, without running either queue.
Each persistence adapter retains the settlement token with its write/mutationID until its existing resolver proves the outcome.
After D2's barrier/marker check, `settle` runs only the matching queue, exactly once, before success or known-rollback becomes observable.
Repeated settlement is idempotent. Contradictory settlement is an ownership error. Hook exceptions remain contained.
Barrier/read failure, peer disposal and negative raw reads never settle hooks.
`resolveWrite`/`lastMutation` settle retained tokens before returning. Control's background latch shares that idempotent settlement before releasing writers.
Registry installation and outbox resolution follow hook settlement. No committed marker may resolve success with its hook missing.
Phase 2 mirrors this overload/token in MemoryDatabase and asserts commit/rollback counts. Hozon implementation and provider fault tests remain phase 3.
Hooks remain process-local; phase 5 restores status from durable rows after process death.

### D3. `GroupStateStore` and registry

The byte-only port lives in proposed `mls-rpc/src/state-store.ts`. The registry lives in proposed
`mls-rpc/src/group-handle-registry.ts`. Phase 2 implements the registry against memory stores;
phase 3 implements the Hozon store in `rpc-store`.

**Codec prerequisite (G1).** Implement before registry clones or stores use `encodeClientState`.
Installed ts-mls `2.0.0-rc.13` (`node_modules/ts-mls/package.json:3`) loses pending proposal sender
zero: optional uint32 uses truthiness (`node_modules/ts-mls/dist/src/unappliedProposals.js:8`,
`node_modules/ts-mls/dist/src/codec/optional.js:4`). This affects every proposal from leaf zero.
It breaks self-removal filtering and changes policy attribution (`mls/src/group-lifecycle.ts:61`,
`mls/src/policy.ts:351`).

- `encodeClientState(state): Uint8Array` and `decodeClientState(bytes): ClientState | undefined`
  keep their signatures. Bump `CLIENT_STATE_VERSION` to 2.
- Version 2 is `u8(2) || u32(bodyLength) || ts-mls body || u32(refCount) || refs`.
  Integers are big-endian. Each ref is `u32(UTF8Length) || UTF8(proposalRef)`.
  The sidecar contains exactly refs whose sender is zero, sorted lexically. Refs use the existing
  base64 record keys (`node_modules/ts-mls/dist/src/unappliedProposals.js:15`). No ledger envelope.
- Decode the copied body, then restore `senderLeafIndex: 0` for sidecar refs. Duplicate/unknown refs,
  a ref with a non-absent body sender, bad lengths, invalid UTF-8 or trailing bytes return `undefined`.
  Empty/truncated input returns `undefined`; unsupported versions throw, as today (`mls/src/codec.ts:35`,
  `mls/src/codec.ts:41`). Do not mutate input buffers.
- **Version-1 read policy (r6 decision): refuse all version-1 blobs as unsupported.** Their missing
  sender cannot distinguish absent from zero. No silent migration or guess. Existing hosts need a
  separate migration using their authenticated sidecar, or rejoin, before adopting version 2.
- Round-trip tests cover zero, one and genuinely absent senders; a zero-sender test must fail on
  the current codec. Clone/save/reopen with real MLS must preserve the same proposal ref and sender.
  Include malformed sidecar and version-1 refusal tests.
- **P2a recovery codec (r8 decision), phase 2.** The current serializer subtracts private-state length from the whole envelope
  (`mls-rpc/src/recovery-codec.ts:36`, `mls-rpc/src/recovery-codec.ts:38`). Restore appends private state
  (`mls-rpc/src/recovery-codec.ts:87`, `mls-rpc/src/recovery-codec.ts:92`). Version 2 invalidates both splices, even with no proposals.
  Store `sourceState = encodeClientState({...snapshot.state, ratchetTree: snapshot.sourceTree})` in the encrypted candidate JSON.
  Decode sourceState independently and take its ratchetTree; never splice private bytes or depend on envelope offsets.
  Bump the recovery candidate version to 2 and AAD to `kumiai/recovery-candidate/v2`.
  Refuse version-1 candidates under the same flag-day policy.
  Keep P2a's opaque candidate/requestKey and confirmation/source-check contracts unchanged.
  Extend the exact-state/source-tree test (`mls-rpc/test/recovery-codec.test.ts:65`) with a source tree differing from the candidate's.
  Cover empty proposals and zero/one/absent senders, plus reconstruction from a persisted rejoin candidate/requestKey.
  Preserve bound verdict judgement (`mls-rpc/test/recovery-codec.test.ts:90`). Revise the restored-acceptance case (`mls-rpc/test/recovery-codec.test.ts:99`):
  repeated resolution of one committed write remains idempotent; a newly restored spent candidate refuses installation (r10 decision).
  This adaptation lands with G1, before registry or recovery uses the version-2 envelope.
- Correct the backlog's broad audit claim here, without editing it: no other valid falsy scalar in
  this installed ClientState graph is affected. Own leaf index, epoch and generation are required
  encodings (`node_modules/ts-mls/dist/src/privateKeyPath.js:7`,
  `node_modules/ts-mls/dist/src/groupContext.js:12`, `node_modules/ts-mls/dist/src/secretTree.js:11`).
  Optional tree nodes are objects; hashes are byte arrays, including empty arrays
  (`node_modules/ts-mls/dist/src/ratchetTree.js:87`, `node_modules/ts-mls/dist/src/clientState.js:45`).
  Historical composition uses the same codecs (`node_modules/ts-mls/dist/src/epochReceiverData.js:7`).

```ts
export type GroupStateRecord = {
  groupID: string
  version: number                 // starts at 1, increases across tombstones
  writeID: string                 // fresh per write; adoption.mutationID when present
  deleted: boolean
  epoch: number                   // current MLS epoch; tombstone uses admissionFloor
  admissionFloor: number          // highest installed epoch; never decreases
  state: Uint8Array               // version-2 encodeClientState output; empty when deleted
  credential: { id: string; groupID: string } | null
  ledger: Array<string>           // signed tokens in enactment order, repeats kept
  senderHWM: number               // exclusive application reservation ceiling for this epoch identity
  handshakeHWM: number            // exclusive handshake reservation ceiling (r10 decision)
  anchorOrdinal: number           // local capture counter, starts at 0; retained in tombstones (r12 decision)
  anchorOrdinals: Record<string, number> // topicID -> captured ordinal; retained across recovery/deletion (r12 decision)
  epochAuthenticator: Uint8Array  // empty when deleted
  lineage: number                 // starts at 0; never decreases, tombstones included
  joinRef: { sourceID: string; ref: string } | null
  spentEpochAuthenticators: Array<Uint8Array> // every held epoch; retained across recovery/tombstones (r10 decision)
}
export type GroupStateCAS = { expected: { version: number } | null }
export type GroupStateWrite = GroupStateCAS & (
  | { kind: 'state'; adoption?: AdoptionWrite;
      anchorCapture?: { slot: AnchorSlot; topicIDs: Array<string> } } // r12 decision
  | { kind: 'recovery'; adoption: AdoptionWrite }
  | { kind: 'welcome' }
)
export type GroupStateStore = {
  mutationGate: GroupMutationGate
  load(groupID: string): Promise<GroupStateRecord | null> // includes tombstones
  resolveWrite(groupID: string): Promise<GroupStateRecord | null> // D2 barrier, then load
  list(): Promise<Array<Pick<GroupStateRecord, 'groupID' | 'version' | 'epoch' | 'deleted'>>>
  save(record: GroupStateRecord, write: GroupStateWrite): Promise<void>
  saveOpened(record: GroupStateRecord, write: GroupStateCAS, pending: PendingAppFrame): Promise<void>
  delete(record: GroupStateRecord, write: GroupStateCAS): Promise<void>
  listPending(groupID: string): Promise<Array<PendingAppFrame>>
  completePending(groupID: string, id: string): Promise<void> // unknown IDs succeed
}
// Re-export the canonical rpc errors. Do not redeclare them.
export { StorageOutcomeUnknownError, GroupControlUnsettledError } from '@kumiai/rpc'
export class GroupStateConflictError extends Error { override name = 'GroupStateConflictError' }
export class GroupStateUncertainError extends Error { override name = 'GroupStateUncertainError' }
export class DisplacedGroupHandleError extends Error { override name = 'DisplacedGroupHandleError' }
```

**Host at-rest codec (r9 decision; anchors r10 decision).** Export this Hozon-free port from rpc:

```ts
export type AtRestCodec = {
  seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}
```

State, coordinated-outbox, control and anchor factories require `atRest: AtRestCodec` (r10 decision).
The host owns keys, provisioning, rotation, retention and destruction.
Kumiai never generates or stores at-rest keys. Reconstructed adapters receive a codec capable of opening all retained records.
Deletion never destroys host keys implicitly; remaining groups and tombstones can still require them.

Seal state bytes, complete pending frames, outbox payloads, the serialised control snapshot and complete anchor slots before storage (r10 decision).
Control encryption includes operation bodies/journals and rejoin candidate/requestKey. Ports and transaction hooks still receive logical plaintext values.
Anchor encryption includes `AnchorSlot.anchor.secret`, pending metadata and the landed mark, including adoption co-writes (r10 decision).
The secret feeds app topic derivation (`rpc/src/anchor.ts:6`, `rpc/src/peer-epoch.ts:262`);
the current Kubun adapter writes it directly (`../kubun/packages/plugin-p2p/src/groups/anchor-store.ts:35`).
AAD is `UTF8(JSON.stringify(['kumiai/at-rest/v1', groupID, namespace, recordID]))`.
Namespaces are `state`, `pending`, `outbox`, `control` and `anchor` (r10 decision).
Record IDs are groupID for state/control/anchor, frame.id for pending, and String(seq) for outbox.
Queryable keys, CAS versions and mutation markers may remain clear. Authenticated open must reject altered ciphertext or AAD, without plaintext fallback.
Seal failure rolls back the coupled transaction. Open failure exposes no handle or payload and never rewrites ciphertext as plaintext.

Phase 2 shared memory doubles require an injected deterministic authenticated test codec. Their committed rows contain sealed bytes, with no plaintext shadow copies.
Phase 3 uses the same contract on every Hozon provider. Provider encryption may supplement it.
Rejected alternative: SQLCipher/provider encryption as the only mechanism; Expo and postgres have different adapter paths, cited above.

New errors use `(message?: string, options?: ErrorOptions)` inherited from `Error`.
Canonical errors already have explicit names (`rpc/src/errors.ts:16`, `rpc/src/errors.ts:24`).
Redeclaration breaks ambiguity recognition (`rpc/src/control/store.ts:105`).

**Store rules:**

- **CAS.** `expected: null` means absent, never tombstoned. Otherwise the stored version must match.
  `record.version` must exceed the prior version. Lower lineage or admissionFloor conflicts.
  Lower epoch conflicts except authenticated, confirmed recovery below. A miss writes no logical rows
  and throws `GroupStateConflictError`. Map postgres mutation serialization failures to that conflict.
- **Authorised lineage changes (r10 decision).** Ordinary `kind: 'state'` and `saveOpened` writes retain lineage, even with matching CAS and newer versions.
  Only authenticated recovery or Welcome replacement increments it, exactly once. Deletion retains it; no path decreases it.
  Matching epoch/authenticator never authorises an ordinary lineage increase or progress reset.
- **Same-number identity replacement (r12 decision).** Ordinary `kind: 'state'` and `saveOpened` reject a different authenticator at the stored epoch number.
  Matching CAS and an unspent replacement authenticator grant no exception. Only confirmed, source-checked `kind: 'recovery'` permits this replacement.
  Refusal changes no coupled logical row or hook queue, including pending, control, anchor, cursor, outbox and meta.
- **Lower-epoch recovery (r7 decision).** `kind: 'recovery'` may install a lower or equal epoch with
  a different authenticator. Require a live source, expected version and lineage exactly incremented by one.
  The registry enters this mode only from P2a's confirmed candidate after its read-only source re-check.
  The transaction verifies the stored rejoin is `confirmed`, its source matches the current epoch/authenticator/lineage,
  and `adoption.changes.putRejoin` advances that same rejoin to `adopted` with the candidate's `epochAfter`.

  Candidate authentication and authoritative verdict verification remain the MLS/peer's responsibility
  (`mls-rpc/src/mls.ts:181`, `rpc/src/peer.ts:2712`). Never grant this exception to an ordinary state/open save.
  Refuse a candidate whose authenticator is already spent before epoch comparison; never merge or install it (r10 decision).
  Persist state/control/anchor/marker and the appended spent authenticator together. Reset both HWMs/progress to the candidate identity;
  retain P2a's identity-checked historical carry. An already-committed write resolves through writeID, without reinstalling its candidate.
  P2a stores verified confirmation, then re-checks source before adoption
  (`rpc/src/control/rejoin.ts:127`, `rpc/src/control/rejoin.ts:154`). These guards remain binding alongside the spent-epoch refusal.
  Recovery's `onAccepted` passes `access.replace(data.group, write, undefined, 'recovery')`
  at the existing replacement call (`mls-rpc/src/mls.ts:218`). Registry maps that mode to the recovery store write.
- **Admission floor (r7 decision).** Set `admissionFloor = max(prior admissionFloor, candidate epoch)`.
  Lower recovery preserves it. Tombstones set `epoch = admissionFloor`; Welcome requires strictly greater
  than that tombstone epoch. Unspent live Welcomes still compare current epoch (`mls-hub/src/admission.ts:7`, `mls-hub/src/admission.ts:8`).
  The spent-epoch check below amends P2a D4 admission (r10 decision).
- **Spent epoch identities (r10 decision), amendment to P2a D4.** Each group retains every epoch authenticator this device has held.
  This includes genesis, ordinary/last-resort Welcome, own commit, received commit and recovery, regardless of application sends.
  Every save installing a new epoch appends its authenticator in the same transaction as state and any control/anchor changes.
  Same-identity progress saves, opens and joinRef clearing preserve the set exactly. Recovery and deletion retain all prior entries.
  Welcome admission, recovery candidates and seed refuse any joined/candidate authenticator already in the set before epoch comparison.
  Refusal never merges progress. The store independently conflicts on a spent candidate or a transition reinstalling a spent epoch.
  Ordinary same-identity state saves remain valid; they preserve progress rather than admitting a candidate.
  Retain the set for the group's lifetime, including D3 tombstones and later admissions. Never prune by epoch, lineage or package retention.
  Growth is one authenticator per held epoch, accepted in the same growth class as receipts.
  Known rollback spends nothing. Ambiguous commits resolve state and the appended authenticator together through D2's barrier.
  Source receipts remain consume bookkeeping. A receipted ordinary repeat never installs state; a tombstoned group remains deleted.
  Exact replay and alternate valid representations share an authenticator, so no `welcomeDigest` or digest derivation remains.
  Rejected alternative: artifact digest; repackaging can preserve secrets while changing bytes. The live highest-ever epoch floor remains rejected too.

  **Version-2 record fields (r10 decision).** Replace `spentWelcomeDigests` with required `spentEpochAuthenticators` in persistence serialisation.
  Include required `handshakeHWM` too. Both fields round-trip independently of the MLS ClientState payload.
  Required `anchorOrdinal` and `anchorOrdinals` round-trip outside that payload too (r12 decision).
  Fresh records start at 0/empty. Existing records cannot reset or omit these fields during restore, recovery, Welcome or deletion.
  Store sorted, unique byte arrays in lexicographic byte order, with defensive copies. Live records and tombstones round-trip the complete set.
  State-namespace encryption covers this metadata. No missing-field fallback to an empty set or digest migration is safe.
  The MLS ClientState v2 envelope above remains lossless state encoding; this lifetime set belongs to the group record, outside recovery snapshots.
  The record supplied to save must contain exactly the prior set plus the installed authenticator; reject omissions or unrelated additions.

  **Welcome plumbing (r10 decision), phase-2 mls-hub exports:**

  ```ts
  export type OpenWelcomeParams = Omit<ProcessWelcomeParams, 'keyPackageBundle'>
  export type JoinedWelcome = {
    group: GroupHandle             // group.state.keySchedule.epochAuthenticator carries the authenticated identity
    credential: MemberCredential
    sourceErrors?: Array<Error>
  }
  export type OpenWelcomeResult =
    | { joined: JoinedWelcome; joinRef: { sourceID: string; ref: string } }
    | { alreadyJoined: string }
  export function openWelcome(sources: Array<BundleSource>, welcome: OpenWelcomeParams): Promise<OpenWelcomeResult>
  export type WelcomeAdmissionParams = {
    held: { epoch: number; deleted: boolean; spentEpochAuthenticators: Array<Uint8Array> } | null
    welcome: { epoch: number; epochAuthenticator: Uint8Array }
  }
  export function judgeWelcomeAdmission(params: WelcomeAdmissionParams): 'join' | 'alreadyJoined' | 'replace' | 'refused'
  ```

  Preserve the nested union (`mls-hub/src/join.ts:26`) and joined group/state (`mls/src/group-welcome.ts:45`).
  The comparator replaces today's positional arguments (`mls-hub/src/admission.ts:2`) with the single options object above.
  The host supplies `welcome` from `Number(joined.group.epoch)` and `joined.group.state.keySchedule.epochAuthenticator`.
  Only the authenticated groupID selects held storage. Compare authenticator bytes first, then apply the existing epoch/deletion result rules.
  Seed derives that same authenticator from the handle and rechecks the durable set under the gate.
- **Other historic-state paths, checked 2026-10-09.** Recovery restore can reconstruct a saved candidate (`mls-rpc/src/mls.ts:464`).
  P2a rechecks source epoch/authenticator/lineage before adoption (`rpc/src/control/rejoin.ts:39`, `rpc/src/control/rejoin.ts:154`).
  D3 co-commits that rejoin's `confirmed` → `adopted` transition with the lineage increment; `adopted` only bootstraps/settles (`rpc/src/control/rejoin.ts:203`).
  Pre-commit replay retries only an unspent candidate. Post-commit replay resolves the committed write or follows `adopted`, without reinstalling candidate state (r10 decision).
  Any new candidate installation with a spent authenticator is refused, even with a current source or the same installed identity.
  Later lower recovery cannot restore the old source lineage. Never relabel an old candidate with a new rejoin/source to bypass this check.
  This safety requires D3's lineage plumbing; today's real source still reports zero (`mls-rpc/src/mls.ts:289`).
  Remove the candidate's current-authenticator early success (`mls-rpc/src/mls.ts:212`); it must not bypass spent-candidate refusal (r10 decision).
  Fresh recovery from historic GroupInfo creates an external update path (`mls/src/group-welcome.ts:328`, `node_modules/ts-mls/dist/src/createCommit.js:267`).
  Its path secret is random (`node_modules/ts-mls/dist/src/updatePath.js:26`); its epoch secret tree is newly derived (`node_modules/ts-mls/dist/src/createCommit.js:294`).
  Old confirmation cannot confirm a new candidate: judgement binds requestID, position, commitDigest and tag (`mls-rpc/src/recovery.ts:228`).
  Own journals also carry expected source identity/lineage (`rpc/src/control/operations.ts:235`); ordinary state/open saves cannot lower epoch.
  Registry restore loads only the current committed record. These paths retain their source/CAS/progress guards; none gains Welcome's fresh seed/reset exception.
- **Identity (r6 decision).** Epoch identity is `(groupID, epoch, epochAuthenticator)`; lineage identifies
  ownership, not the epoch secret. Ordinary same-identity/same-lineage saves retain both max HWMs and merged sender/receive
  progress. Only after both checks may `mergeReceiveSecretTree` run (`mls/src/secret-tree.ts:17`).
  Never merge by epoch number alone.
- A new, unspent epoch resets both HWMs to the candidate's own application/handshake generations (r10 decision).
  Recovery may keep the number while changing authenticator: reset both HWMs, bump lineage, discard old current-tree progress.
  Live Welcome replacement requires a strictly higher authenticated current epoch. A spent replacement identity is refused, never merged (r10 decision).
  Recovery/Welcome bumps lineage by one; ordinary commits keep it.
  Tombstones retain admissionFloor/lineage/spentEpochAuthenticators/anchorOrdinal/anchorOrdinals, with both HWMs zero, empty
  state/authenticator/ledger and null credential/joinRef.
- `save(kind: 'state' | 'recovery')` co-commits any `AdoptionWrite`, its mutation marker and matching anchor landed
  mark. `record.writeID === adoption.mutationID`. Keep P2a's carry into retained historical epochs.
  Current-state same-identity merging supplements that carry; it does not replace it.
- **Welcome save (r6 decision; r10 spent identity).** `save(record, {expected, kind: 'welcome'})` is the atomic
  seed/readmission operation. With the old peer stopped/drained, apply
  `readmissionChanges(txControlSnapshot)` (`rpc/src/control/store.ts:67`) and clear the anchor slot
  in the state-save transaction. Set control's mutation marker to `record.writeID`.
  Operations/rejoin become `unknown`; applied/responses/cursor clear; outcomes/Welcomes survive.
  Initial Welcome join uses the same method with absent control. Include the appended spent authenticator set (r10 decision).
  Tombstone admission keeps both its epoch floor and spent set.
  This is not `AdoptionWrite.anchorLanded`, which only marks an advance (`rpc/src/control/types.ts:43`).
- **Local anchor order (r12 decision).** `segment` is a durable local ordinal, independent of MLS epoch and lineage.
  Each initial, rotation or recovery capture increments `GroupStateRecord.anchorOrdinal` by one and records that ordinal on `Anchor`.
  Capture co-writes the counter, topic-to-ordinal entries and encrypted anchor slot through `save(kind: 'state', anchorCapture)` under the registry gate.
  Other state/open/Welcome/recovery/delete writes preserve the counter and existing map entries. Tombstones retain both.
  Every topic derived from one capture has its ordinal. A topic's recorded ordinal never changes.

  Add required `ordinal: number` to rpc's `Anchor`, and `captureID: string` to `AnchorSlot`, including structural mirrors.
  The peer supplies one fresh captureID per logical capture, reused on retries. A matching committed captureID returns its slot without incrementing again.
  Known rollback changes neither counter nor slot. Ambiguity resolves both through D2 before memory publication.
  `keepAnchor`, restoration and pending/landed updates never capture. Independent `AnchorStore.save` preserves the captured identity/ordinal/captureID.
  Registry capture alone creates a new slot. Capture overflow rejects before writing, rather than wrapping or reusing an ordinal.

  An accepted frame uses its authenticated topic's recorded ordinal, including frames arriving late from an older anchor.
  Pending records and local read watermarks compare `(ordinal, position)` with rpc's numeric-position comparator.
  Across a fork this order belongs to one device. Peers never exchange or compare local ordinals.
  For one application protocol, the peer-visible anchor identity is its authenticated `topicID`.
  Exchanged watermarks are `(anchor identity, position)` and compare positions only within the same anchor.

  A superseded-anchor receipt covers only that anchor's occurrences, never the replacement anchor or its local read watermark.
  The MLS, hub and broadcast frame formats stay unchanged. Ordinal/map fields are local persistence and handler metadata.
  The umbrella adds the anchor/position tuple to its messaging receipt payload.
- `saveOpened` co-writes the CAS state and pending record. Duplicate `(groupID, pending.frame.id)`
  insertion is a no-op. Require `pending.frame.segment === record.anchorOrdinals[pending.frame.topicID]` (r12 decision).
  List in `(segment, position)` order, using rpc's numeric-position comparison
  (`rpc/src/crypto.ts:226`). Every read/write owns defensive copies of bytes and nested values.
- **Ambiguity.** The resolving writer stays paused; other access throws `GroupStateUncertainError`.
  Block subsequent writes until `resolveWrite` completes D2's barrier and returns the final record (r7 decision).
  Matching `writeID`: install the committed record and resolve. Expected version/absence: reject
  with the original error, known uncommitted. Anything else: conflict, invalidate and reload.
  Failed barriers/reads retry at 100 ms, doubling to a 15 s cap. Do not expose uncertain state.
- `delete` stores a tombstone, removes pending, applied/responses/cursor, anchor, app cursor/outbox
  and outbox meta rows, and awaits `onDelete` in one transaction. Retain its write marker and spent authenticator set (r10 decision).
  Refuse operations, rejoin, unacked outcomes or Welcomes with canonical `GroupControlUnsettledError`
  (`rpc/src/control/store.ts:57`). Deletion does not abandon control work automatically.

**Construction and runtime surface (r6 decision; r7 handoffs). Async access and membership runtime (r8 decision):**

```ts
// Phase 3, rpc-store. Uses stores obtained from the root callback's tx.
export function createGroupStateStore(params: {
  db: HozonDB
  atRest: AtRestCodec               // required host codec (r9 decision)
  onDelete?: (tx: StoreProvider, groupID: string) => Promise<void>
}): GroupStateStore

// Phase 2, mls-rpc. The host supplies context/policy/resolvers through restore.
export function createGroupHandleRegistry(params: {
  store: GroupStateStore
  restore: (record: GroupStateRecord) => Promise<GroupHandle>
  loadControl: (groupID: string) => Promise<ControlSnapshot> // bound ControlStore.load, same root/gate (r12 decision)
}): GroupHandleRegistry
export type GroupHandleRegistry = {
  access(groupID: string): Promise<RegistryHandleAccess> // loads/restores/validates before returning (r8 decision)
  seed(group: GroupHandle, params: {
    replace?: boolean
    joinRef: GroupStateRecord['joinRef']
  }): Promise<void>
  clearJoinRef(groupID: string, expectedJoinRef: NonNullable<GroupStateRecord['joinRef']>): Promise<void>
  captureAnchor(groupID: string, params: {
    anchor: Omit<Anchor, 'ordinal'>; topicIDs: Array<string>; captureID: string
  }): Promise<AnchorSlot> // state counter/map and slot co-commit, then cache installation (r12 decision)
  delete(groupID: string): Promise<void> // host must stop/drain its peer first
  onAdmissionChanged(listener: (groupID: string, value: SendAdmission) => void): () => void
  onEpochChanged(listener: (groupID: string, snapshot: GroupRuntimeSnapshot | null) => void): () => void
  dispose(): Promise<void> // cancels timers, awaits writes and flushes dirty receives
}
export type GroupRuntimeSnapshot = {
  epoch: number; authenticator: Uint8Array; lineage: number
  members: ReadonlySet<string>        // normalised DIDs, copied from committed membership
  available: boolean                // local member usable; lapse alone does not remove membership
}
export type GroupEpochRuntime = {
  snapshot(): GroupRuntimeSnapshot | null
  onEpochChanged(listener: (snapshot: GroupRuntimeSnapshot | null) => void): () => void
}
export type RegistryHandleAccess = HandleAccess & { pending: PendingAppFrames; runtime: GroupEpochRuntime }
// Add to GroupPeerMLSParams; required for registry-backed durable peers (r12 decision).
captureAnchor: (params: {
  anchor: Omit<Anchor, 'ordinal'>; topicIDs: Array<string>; captureID: string
}) => Promise<AnchorSlot>
// Add to HandleAccess; retain read/mutate and AdoptionWriteFactory.
pending?: PendingAppFrames
lineage(): number
seal<TValue>(fn: (handle: GroupHandle) => Promise<TValue>): Promise<TValue>
buildControl<TValue>(fn: (source: GroupHandle, publishedHandshakeGeneration: number) => Promise<{
  result: TValue; handshakeGeneration: number // source-epoch generation consumed by private commit (r10 decision)
}>): Promise<TValue>
receive<TValue>(fn: (handle: GroupHandle) => Promise<{
  result: TValue; accepted: number   // non-negative integer open count, including batches (r8 decision)
}>): Promise<TValue>
// Fourth replace argument defaults to 'adoption'. Recovery explicitly passes 'recovery'.
replace(next: GroupHandle, adoption?: AdoptionWriteFactory,
  prepare?: (current: GroupHandle) => Promise<boolean>, kind?: 'adoption' | 'recovery'): Promise<void>
// Make the external fallback optional. Registry access supplies its own atomic writer.
open<TValue>(fn: (handle: GroupHandle, persistOpened: (
  stagedState: Uint8Array, record: PendingAppFrame
) => Promise<void>) => Promise<TValue>, persistOpened?: (
  stagedState: Uint8Array, record: PendingAppFrame
) => Promise<void>): Promise<TValue>
// New durable createGroupCrypto overload; retain simple access's external pending overload.
export function createGroupCrypto(params: GroupCryptoParams & {
  access: RegistryHandleAccess; pending?: never
}): GroupCrypto & { pending: PendingAppFrames }
```

- `restore` rejects mismatched groupID, epoch, credential or authenticator. The registry derives
  saved bytes/credential/ledger from the handle. Clones use the version-2 codec and retained options.
  Seed checks the candidate authenticator against the spent set first, including tombstones; a match conflicts without writing (r10 decision).
  Otherwise seed returns without writing for a held live epoch at/above the candidate. Live newer Welcome
  requires `replace: true`; absent/tombstoned joins use the welcome save. At/below a tombstone floor
  or unauthorised replacement throws `GroupStateConflictError`. Existing version/lineage are loaded
  under the gate, never supplied as guessed insert defaults.
  Local genesis requires epoch 0, absent storage, null joinRef and no replacement.
  That seed uses `kind: 'state'` and spends the genesis authenticator. Every Welcome seed derives identity from the authenticated joined handle (r10 decision).
- **Capture handoff (r12 decision).** The host binds the peer's capture callback to `registry.captureAnchor(groupID, params)`.
  It supplies the exported anchor, all derived lane/inbox topicIDs and the captureID before releasing the peer seal barrier.
  Initial capture uses counter 1. Rotation/recovery capture uses the retained counter plus one, even after a lower-epoch recovery or tombstone readmission.
  The store permits counter/map changes only with `anchorCapture`, validating the increment, slot ordinal and unchanged prior mappings.
  Registry capture retains MLS state/progress/lineage, advances CAS/writeID and installs the returned committed metadata before the next mutation.
- One per-group gate spans preparation, save and ambiguity resolution. Durable mutation/open,
  commit replacement, Welcome seed and deletion stage from the current cache; install after commit.
  Recovery replacement checks the spent set before `prepare` or any progress carry/merge (r10 decision).
  Retry durable-open CAS at most eight times on fresh clones. Merge only matching identities/lineages.
- **Registry durable open (r7 decision).** `createGroupCrypto({access: await registry.access(groupID)})` uses
  access-owned pending persistence/list/completion. Refuse an external pending adapter on registry access.
  `open` stages on a current clone. Its internal callback builds a full record from `stagedState`,
  current credential/ledger/metadata, fresh writeID and next CAS version, then calls `store.saveOpened`.
  The registry resolves `StorageOutcomeUnknownError` through `resolveWrite` before the callback returns.
  Install the clone and return plaintext only after proven commit. Known rollback leaves the live key unspent.
  Crypto wraps a resolved storage failure as `AppFrameStorageError`; it must not hide ambiguity from the registry.
  Registry pending `list` delegates to `store.listPending(groupID)`; `complete` enters the same gate.
  Completion ambiguity resolves internally after D2's barrier by pending-row presence; absent means success.
  Simple access still requires the external fallback for durable open. Without it, reject before decrypting.
  This replaces today's required callback wiring (`mls-rpc/src/access.ts:28`, `mls-rpc/src/crypto.ts:209`).
- `wrap` moves from `access.mutate` to `access.seal`; each callback seals at most one application
  frame. Non-durable unwrap uses `receive`, returning count 1 for an accepted open. Receives install immediately
  and flush at 64 frames or 250 ms. Losing unflushed live progress permits replay after restart.
  Simple access implements seal/receive with its existing per-mutation persistence, without leases.
- **Lineage plumbing (r6 decision).** Recovery source and every host build read `access.lineage()`
  inside the same `access.read` callback as epoch/authenticator. Replace the hard-coded zeros
  (`mls-rpc/src/mls.ts:285`, `mls-rpc/src/revoke.ts:60`). Simple access starts at an optional
  `SimpleHandleAccessParams.lineage` (default 0), incrementing on successful recovery replacement.
  Registry access reads the persisted lineage. Queued work captures lineage before waiting and rejects
  if displaced. An owning peer's next call sees its successful recovery's new lineage; external
  Welcome seed retires the old access owner. Creation-time crypto pinning would strand that peer.
- Publish runtime snapshots/notifications only after committed installation. Admission subscription
  immediately supplies loaded groups; epoch subscription fires on identity/lineage/membership/availability changes,
  including same-number recovery (r7 decision). The committed membership handoff extends that contract (r8 decision).
  The group-bound runtime immediately supplies its current snapshot on subscription (r8 decision).
  Snapshot getters/listeners receive defensive copies, including authenticator and normalised member sets.
  Retired, deleted or disposed access publishes null; uncertain adoption exposes no staged membership.
  Contain listener errors. Host schedules work outside the registry gate.
- `list()` drives host restore. Tombstones never start peers. After live restore, the host consumes
  each source-scoped `joinRef`, then calls `registry.clearJoinRef(groupID, consumedRef)` (r7 decision).
  Under the gate, require the exact sourceID/ref; an already-null ref succeeds without writing.
  A different non-null ref conflicts. Save current owner state with null joinRef, fresh writeID and
  next version; preserve identity/lineage/both HWMs/spent set and install the updated cached record after commit.
  The registry owns ambiguity through `resolveWrite`, as for every state save. Never clear before consume.
  A crash after consume repeats its source receipt check, then clears through this operation.
  Restore pending into the peer before P2a replay. Keep P2a's startup order and terminal-removal rule.

**Cold access (r8 decision), phase 2.** `access` awaits load, restore, identity checks and retention validation under the group gate.
Concurrent access calls share that load. Missing/tombstoned records reject with `DisplacedGroupHandleError`; invalid restore/configuration publishes nothing.
No HandleAccess exists before successful loading, so epoch/lineage/admission getters never fabricate pre-load values.
Subscriptions omit unloaded groups. Successful loading publishes the validated snapshot/admission before returning access.
The current synchronous simple access already receives a handle (`mls-rpc/src/access.ts:40`). Its signature stays synchronous.
All registry callers await access before constructing crypto, peers, buffers or encryptors.

**Tunnel encryptor extraction (r8 decision), phase 2.** Export the existing Encryptor adapter from mls-rpc with this group-bound constructor:

```ts
export type MLSEncryptorParams = {
  access: Pick<RegistryHandleAccess, 'seal' | 'receive' | 'runtime'>
  peerDID: string
  role: 'dialer' | 'listener'
}
export class MLSEncryptor implements Encryptor {
  constructor(params: MLSEncryptorParams)
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>
  trackPublish(hub: MailboxHub): MailboxHub
  clear(): void
  watchPeerRemoval(dispose: () => Promise<void>): () => void
}
```

`seal`, `receive` and runtime belong to the same loaded access owner. Encryption uses `access.seal` and D3's lease/admission guard.
Decryption uses `access.receive` in chunks of at most 64. Add the exact successful-open count to the flush budget.
This preserves source batching (`../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:194`,
`../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:243`). Boolean coercion is forbidden.
Adapt the removal watcher to committed snapshots, rather than retaining its old callback arguments
(`../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:149`). Identical snapshots are no-ops.
A sequential `E + 1`, same-lineage update with usable local membership and peer membership keeps the tunnel open.
Null/unavailable snapshots, missing peer membership, non-sequential epochs or changed lineage close it once.
Same-number authenticator replacement also closes it. Unsubscribe disables later closes.
Keep sender/publisher checks, stale outstanding-reply handling and failed-publish retirement
(`../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:105`, `../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:201`,
`../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:211`). No Kubun registry dependency remains.

**Retention, lease and rotation:**

```ts
// mls exports. Add keyRetention?: Partial<KeyRetentionConfig> to GroupOptions.
export type MlsContextOptions = { keyRetention?: Partial<KeyRetentionConfig> }
export function createMlsContext(
  cipherSuite: MlsContext['cipherSuite'], anchor?: GroupAnchor, options?: MlsContextOptions
): MlsContext
// Host example (r7 decision):
createMlsContext(cipherSuite, anchor, { keyRetention: {
  retainKeysForGenerations: 1000, maximumForwardRatchetSteps: 1000,
} })
// rpc SendAdmission; mls's leaf admission remains its existing lapsed check.
export type SendAdmission =
  | { epoch: number; admissible: true }
  | { epoch: number; admissible: false; reason: 'lapsed' | 'rotation-required' }
// rpc SendNotAdmissibleError constructor and reason getter use the same reason union.
const RESERVE = 16
const RENEW_BELOW = 4
const ROTATE_AT = 500
// rpc export, shared by real access and doubles (r11 decision).
export const HANDSHAKE_BURN_BUDGET = 64
```

- Context overlays supplied retention on ts-mls defaults through `clientConfig.keyRetentionConfig`
  (`node_modules/ts-mls/dist/src/mlsContext.d.ts:9`, `node_modules/ts-mls/dist/src/clientConfig.d.ts:7`).
  Preserve other client defaults. Registry sealing requires generation retention and forward steps
  both at least 1000; reject weaker host configuration before asynchronous access resolves. Client/smoke fixtures set
  both to 1000. Ordinary mls callers keep defaults; historical epoch retention remains unchanged.
  The third parameter is the options object above, not a bare retention config (r7 decision).
  Its fields are ts-mls's existing names (`node_modules/ts-mls/dist/src/keyRetentionConfig.d.ts:3`).
- **Receiver window (r11 decision).** The handshake budget relies on `maximumForwardRatchetSteps: 1000` in the host example above.
  Configure every receiver through `createMlsContext`'s `clientConfig.keyRetentionConfig` overlay, including peer/conformance doubles.
  The configuration path is `node_modules/ts-mls/dist/src/mlsContext.d.ts:9` and `node_modules/ts-mls/dist/src/clientConfig.d.ts:7`.
  The real receiver enforces it at `node_modules/ts-mls/dist/src/secretTree.js:104`.
  Require `HANDSHAKE_BURN_BUDGET < maximumForwardRatchetSteps`. Doubles enforce the same configured forward window as real ts-mls, never a more permissive one.
- Carry configuration through create, restore, Welcome, external join, clone and `deriveGroup`, and
  both fresh and deserialised recovery (`mls-rpc/src/recovery.ts:166`, `mls-rpc/src/mls.ts:471`).
- **Lease.** Read the own application chain's next generation `g` (unexpanded means 0).
  Burn to persisted HWM before any real seal. With fewer than four left, CAS reserve
  `min(500, max(g, senderHWM) + 16)` with state unchanged. At the capped final lease, one to three
  remaining generations may be used without another reservation. Seal only below 500.
- **Handshake reservation (r10 decision).** `buildControl` serialises every private rotation/control commit build under the same owner gate.
  **Unpublished budget (r11 decision).** Let `reservedHandshakeGeneration = max(own handshake next generation, handshakeHWM)`.
  Let `publishedHandshakeGeneration` be the highest handshake generation known published by this device in the current epoch identity, or 0 at epoch start.
  Only a hub-confirmed own commit establishes publication. Use P2a's durable accepted build, matched by source epoch/authenticator, never speculative bytes or head movement.
  **Baseline reader (r12 decision).** `buildControl` calls the constructor's `loadControl(groupID)` under `store.mutationGate.run`.
  The host supplies `(groupID) => controlFor(groupID).load()`, using the durable ControlStore on the registry's root.
  `ControlStore.load` does not reacquire the gate (`rpc/src/control/types.ts:45`). The read, budget check, builder and reservation share one critical section.
  Select `operations` with `stage === 'accepted'` and built source epoch/authenticator/lineage matching the current record.
  Baseline is their maximum `built.handshakeGeneration`, or 0 when no matching accepted build exists.
  Ignore intent, speculative built, mismatched identity/lineage and outcomes. Reader failure aborts without a builder or reservation, never a zero fallback.
  The callback receives that baseline as its second argument. The budget check uses the same value before callback invocation.
  D5 carries the generation through `HostBuilt`/`BuiltCommit`. P2a normally settles accepted work first (`rpc/src/peer.ts:2196`).
  Direct `buildControl` requires no such precondition. Source HWM 65 with a matching accepted generation 64 allows build 65 (r12 decision).
  Before staging or invoking the builder, require `reservedHandshakeGeneration - publishedHandshakeGeneration <= HANDSHAKE_BURN_BUDGET`.
  A build exceeding this budget throws canonical `HandshakeBudgetExhaustedError`, with no builder invocation, reservation or ciphertext.
  Stage a source clone at `max(own handshake next generation, handshakeHWM)` before invoking the non-mutating builder.
  Ratchet only the handshake chain, discarding skipped send keys. No application empty-frame burn substitutes for this advance.
  The builder reports the exact consumed `handshakeGeneration`; require it to match the staged source generation.
  Before returning ciphertext/HostBuilt, CAS-save the source identity with `handshakeHWM = max(prior HWM, handshakeGeneration + 1)`.
  Reserve in the same state transaction pattern as the application HWM. Preserve lineage, application HWM, spent set and receive progress.
  Resolve ambiguity through D2/D3 before releasing the build; failed reservations expose no ciphertext and permit no publication.
  Install the committed source metadata, not the speculative next-epoch candidate. The later adoption alone installs/spends that candidate epoch.
  After failure, head mismatch or restart, merge the reserved handshake HWM into the current source before any rebuild.
  Never reset it while identity/lineage stays the same. Exact-byte P2a replay of an already-built operation consumes no new generation.
  A rejected/oversized/unpublished build after reservation still burns its generation. This separate budget caps handshake burns; the application 500 bound remains independent (r11 decision).
  `handshakeHWM` is exclusive; the budget compares the prospective consumed generation, not that ceiling.
  With baseline 0, generations 0–64 are allowed; the next build at 65 fails before reservation (r11 decision).
  A new epoch identity resets the budget and published baseline. Same-epoch reconstruction, failure and outcome acknowledgement never reset it.
  Exhaustion is terminal for that operation. The host uses existing P2a device readmission: fresh leaf, fresh handshake chain and D3's atomic Welcome reset.
  No automatic rebuild or rotation re-enqueue follows exhaustion (r11 decision). Rejected alternative: unbounded reservation; peers cannot follow.
  Simple access advances and persists source handshake progress before returning too; durable control builds require its persist callback.
  Add `loadControl?: (groupID: string) => Promise<ControlSnapshot>` to SimpleHandleAccessParams (r12 decision).
  Durable simple-access builds require that reader too, under their serial persistence gate, with the same baseline/signature rules.
  Externally authored recovery commits retain their existing framing; they consume no local member handshake generation.
- **Deferred burn (r6 decision).** Restore always succeeds for valid lapsed, removed, suspended or
  pending-proposal state. Do not call `encrypt(empty)` until its application-send prerequisites hold.
  Encrypt currently rejects lapse (`mls/src/group-handle.ts:992`); ts-mls rejects pending proposals
  and removed/suspended state (`node_modules/ts-mls/dist/src/clientState.js:131`).
  Keep a runtime burn obligation for that exact identity. Every seal checks it first; a later commit
  at a new identity discards it. Control/recovery and pending receive replay remain usable.
- **Rotation trigger (r6 decision).** Effective next generation is `max(g, pendingBurnHWM)`.
  At 500, registry admission is `rotation-required`, with `lapsed` taking precedence. Emit once
  per identity on transition (including restored inventory). Recompute after successful or failed
  seal callbacks, since a failed seal may still consume a generation. Reject new acceptance with
  `SendNotAdmissibleError`; hold already accepted entries, as the current paths distinguish
  (`rpc/src/app-outbox.ts:101`, `rpc/src/peer.ts:602`). All sealing paths, including ephemeral and
  directed replies, use the lease/admission guard.
- Phase 2 smoke host, later `client`, enqueues one P2a `rotation` per epoch identity outside the gate.
  Build against current state; coalesce notifications, reuse an unsettled rotation after restart,
  re-check admission before building, and retry a rejected/lost rotation only while still required.
  `HandshakeBudgetExhaustedError` stops those retries and exposes readmission-required state to the host (r11 decision).
  P2a's revoke hold remains independent and retains its existing retained-log scope.
- The bound is per epoch identity/lineage, not epoch number. No seal reaches generation 500; lease
  burns and failed/unpublished seals count. Different-authenticator same-number recovery starts fresh.
  Old-lineage app entries reseal (D6); this does not promise old ciphertext remains decryptable.

**Deletion lifecycle (r6 decision).** Later client, and phase 2 fixtures, block peer creation/seed
under the group's lifecycle gate. Call `peer.dispose()`, then `peer.drained()` before registry deletion.
Drain is already the owner-replacement contract (`rpc/src/peer-types.ts:364`). Wait for acceptance,
delivery, invoked handlers, network submissions, frozen proof removals and every adapter's ambiguity resolver to settle. Then enter
the shared root mutation gate once and perform the delete transaction (r7 decision). Never await drain inside a peer
callback. Unsettled control still refuses deletion; resume a peer to settle or explicitly abandon/ack
before retrying. On failure, keep the group stopped until restored. This prevents a late put from
recreating rows. No timeout authorises deletion with outstanding work.
Welcome replacement uses this same stop/drain-before-gate order. A save's rejected raw root promise never authorises lifecycle handoff (r8 decision).

### D4. Opened epoch on pending records and handlers

**Coverage (r6 decision): all inbound group application handler paths**, not control-plane handlers.
Events: durable pending replay, non-durable retained drain and live broadcast (log or ephemeral).
Requests: live anycast broadcast and directed event/request/stream/channel handlers. A directed
handler's epoch is the authenticated frame that invokes it, not subsequent frames or current state.

```ts
export type PendingAppFrame = {
  frame: AppFrameRef
  payload: Uint8Array
  senderDID: string
  epoch: number                    // authenticated GroupUnwrapResult.epoch
}
export type GroupHandlerMetadata = { epoch: number; frame?: AppFrameRef }
// Preserve each existing handler's parameter/result; intersect its context with metadata.
export type WithGroupMetadata<THandler> = THandler extends (context: infer TContext) => infer TResult
  ? (context: TContext & GroupHandlerMetadata) => TResult
  : never
// GroupProcedureHandlers: event contexts use EventHandlerContext & GroupHandlerMetadata;
// other entries use WithGroupMetadata<ProcedureHandlers<Protocol>[Procedure]>.

// Supporting optional broadcast metadata; generic broadcast remains usable without MLS.
// Add epoch?: number to UnwrapResult, BroadcastMessage and BusEvent.
// BroadcastHandler's context becomes:
{ senderDID?: string; signal?: AbortSignal; epoch?: number }
// Directed rpc's OpenedInbound gains required epoch: number.
```

- Write `opened.epoch` at real/fake durable persistence and lane reconstruction. Extend the
  conformance record and its narrowed unwrap result. Durable delivery reads record epoch;
  non-durable drain uses unwrap epoch. Keep `frame.segment` independently anchor-bound.
- Live transport copies epoch only from unwrap metadata, overwriting/removing any wire-carried
  epoch just as sender attribution does (`broadcast/src/transport.ts:148`). Responder forwards it to
  events and request context (`broadcast/src/responder.ts:168`, `broadcast/src/responder.ts:180`).
  `adaptBusHandlers` requires a finite non-negative integer epoch before invoking a group handler;
  absent/invalid metadata drops an event or rejects a request. Never substitute current epoch.
- Directed projection retains `opened.epoch` (`rpc/src/directed.ts:85`). Acceptor overwrites reserved
  header `kumiai/epoch` on every inbound frame, alongside `kumiai/senderDID`; wrapper copies it to
  `ctx.epoch` (`rpc/src/directed.ts:261`, `rpc/src/directed.ts:273`). No peer-controlled header survives.
- This changes no Enkaku wire payload schema. Migrate all adapters/doubles together, including
  integrations. Run both contract suites and repo-wide `pnpm turbo run test:types`.

### D5. Commits (landed P2a prerequisite; rotation and terminal-budget additions)

P2a D2–D6 owns operations, exact control replay, adoption, Welcome obligations/admission, removal
and rejoin. Its `ControlStore`, `AdoptionWrite`, consume/receipt and revoke hold are prerequisites.
Do not reimplement journal replay, add operation IDs to envelopes, or revive lost-work reconciliation.

```ts
// New mls export. No mutation of group; no Welcome or ledger bodies.
export type CommitKeyRotationResult = {
  commitMessage: Uint8Array
  newGroup: GroupHandle
  epoch: bigint
  handshakeGeneration: number      // consumed generation in source epoch (r10 decision)
}
export function commitKeyRotation(group: GroupHandle): Promise<CommitKeyRotationResult>
```

**Builder (r6 decision).** Use the existing lifecycle-gated commit helper with empty proposals and
entries, `requireAdmin: false`, under the handle mutex. Refuse pending proposals rather than silently
clearing/committing them. Require a current member and usable leaf; preserve mandatory lifecycle and
credential checks. Return a derived handle at `E + 1` with an update path and unchanged ledger/roster.
The empty-proposal path requests an update path (`node_modules/ts-mls/dist/src/clientState.js:443`).
Proposal-free receiving policy already accepts (`mls/src/policy.ts:342`); the ledger builder rejects
empty lists (`mls/src/group-commit.ts:397`). The helper defaults to admin and clears its pending
proposal input (`mls/src/group-commit.ts:200`, `mls/src/group-commit.ts:279`), so both choices must be explicit.

**Build persistence (r10 decision).** Keep the helper non-mutating and commits privately framed.
Expose the consumed handshake generation on rotation and every private control-commit builder's result.
Derive it from the source handshake chain, including unexpanded generation zero, or retain the advanced protection-tree progress.
The current ts-mls return discards that tree (`node_modules/ts-mls/dist/src/createCommit.js:77`); returning only the next epoch is insufficient.
The host builds through `access.buildControl`, returning `{result: built, handshakeGeneration}` from its callback.
No callback may publish or expose speculative ciphertext before that access operation resolves its reservation.
P2a frames/persists `built` only after the host build returns (`rpc/src/control/operations.ts:143`, `rpc/src/control/operations.ts:160`).
Head mismatch returns an absent build to intent (`rpc/src/control/operations.ts:194`); the next build must use the reserved source HWM.
Rejected alternative: public framing for member commits, which exposes commit contents to the relay.

**Terminal budget plumbing (r11 decision).** Add required `handshakeGeneration: number` to rpc's `HostBuilt` and `BuiltCommit`, including conformance mirrors.
Persist it with exact built bytes. Accepted records supply the publication baseline only for their matching source identity.
Export canonical `HandshakeBudgetExhaustedError` from rpc and re-export it from mls-rpc:

```ts
export class HandshakeBudgetExhaustedError extends Error { override name = 'HandshakeBudgetExhaustedError' }
// Extend only Outcome's rejected arm, retaining reason and the existing base fields.
{ kind: 'rejected'; reason: string; errorName?: 'HandshakeBudgetExhaustedError' }
```

The error inherits `(message?: string, options?: ErrorOptions)`. The runner catches it as terminal, including explicit-name recognition.
Settle by deleting the intent and persisting the rejected outcome with `errorName: 'HandshakeBudgetExhaustedError'` before emitting.
Today's runner only classifies two build errors (`rpc/src/control/operations.ts:147`); add this classification, rather than letting its retry loop rebuild.
Direct `buildControl` and `peer.commit` callers receive the canonical typed error. Enqueue/outcomes/events retain the identifiable `errorName`, including after reopen.
Other rejected outcomes retain their existing `OperationOutcomeError` behaviour (`rpc/src/peer.ts:2510`, `rpc/src/errors.ts:34`).
The host stops automatic scheduling and requests device readmission. Saved built operations still replay exact bytes without another reservation.

The host converts this result to P2a `HostBuilt`: `commit = commitMessage`, `bodies = []`,
`welcome = null`, `handshakeGeneration = result.handshakeGeneration`, journal is the serialised candidate, and source identity uses D3 lineage (r11 decision).
Use operation `{id, kind: 'rotation', revokes: false, body: new Uint8Array()}`.
A now-unneeded rotation is `OperationRejectedError`, settled by P2a. Rotation leaves the app anchor
unchanged unless another roster/forced-recovery change occurs (`rpc/src/peer.ts:440`).

Incoming commits skip state persistence only for **`applied: false`**, never merely
`advanced: false`. Self-removal is applied and saved without epoch advancement
(`rpc/src/crypto.ts:160`, `mls-rpc/test/adoption-write.test.ts:75`).

### D6. Outgoing attempts and publication status

**App outboxes only:** restart reseals every unproven plaintext entry. Store no app ciphertext or
acknowledgement proof. Retain only D6's minimal certified settlement obligation until entry removal (r12 decision).
P2a commit/rejoin records deliberately store and replay exact ciphertext
(`rpc/src/control/types.ts:75`, `rpc/src/control/types.ts:103`). Message identity absorbs an earlier
app attempt that also landed; the umbrella's first-durable-occurrence ordering stays unchanged.

```ts
// Reuse rpc's landed client result, not hub-protocol's store PublishResult (G2).
export type PublishOutcome = { sequenceID: string } // rpc/src/control/operations.ts:36
export type AppPublicationOutcome = { segment: number; position: string }
export type AppSettlementObligation = { // durable certified result, not acknowledgement evidence (r12 decision)
  sequenceID: string; attemptID: string; outcome: 'published'
}
export type AppAttempt = {
  epoch: number                    // MLS seal/proof epoch
  floor: string | null
  attempts: number
  publishID: string
  segment: number                  // captured local anchor ordinal at seal (r12 decision)
}
// AppOutboxEntry.lastAttempt: AppAttempt | null; other fields unchanged.
// AppOutbox.remove(seq: number, outcome?: AppPublicationOutcome): Promise<void>
// Required AppOutbox additions, including doubles (r12 decision):
recordSettlement(seq: number, obligation: AppSettlementObligation): Promise<void>
loadSettlement(seq: number): Promise<AppSettlementObligation | null>
export type LogFrame = { topicID: string; payload: Uint8Array; publishID: string }
export type AppEpochIdentity = {
  epoch: number; authenticator: Uint8Array; lineage: number // group-bound, defensive copy
}
export type SealedLogFrame = LogFrame & {
  floor: EpochFloor
  identity: AppEpochIdentity
  segment: number
  sealVersion: number              // local invalidation generation; never persisted
}
// LogDeliveryParams:
identity: () => AppEpochIdentity | null
sealVersion: () => number
publish: (frame: LogFrame) => Promise<PublishOutcome> | null
remove: (seq: number, outcome?: AppPublicationOutcome) => Promise<void>
recordSettlement: (seq: number, obligation: AppSettlementObligation) => Promise<void>
loadSettlement: (seq: number) => Promise<AppSettlementObligation | null>
// Keep proof fields and add the accepted app occurrence:
type Publication = {
  identity: AppEpochIdentity; sealVersion: number
  floor: LogPosition | null; acknowledged: number
  publishID: string; segment: number; sequenceID: string
}
type PublicationWalk = {
  started: number; identity: AppEpochIdentity | null; sealVersion: number
}
// createLogDelivery's proof surface (r7 decision):
beginWalk(): PublicationWalk
certify(identity: AppEpochIdentity, walk: PublicationWalk): Promise<void> // awaits obligation persistence (r12 decision)
```

- Each successful seal gets a fresh random `publishID`; persist attempt metadata before transport
  handoff. Publish that ID to the frame's sealed topic. `segment` never substitutes for MLS epoch.
  Mux already returns sequenceID (`rpc/src/hub-mux.ts:777`). HTTP remains `{sequenceID}`; no fabricated
  `deduped` field (`hub-protocol/src/protocol.ts:49`, `hub-protocol/src/types.ts:77`).
- **Retry bytes (r6 decision).** Keep one prepared `{frame, updatedEntry}` in a memory map by seq
  until acknowledgement or invalidation. Failed put/publish or a null handoff retries those exact
  bytes/ID, not another seal/counter increment. The map never survives restart.
  After acknowledgement, store `Publication` with the sealed identity/version and discard prepared bytes.
- **Invalidation (r6 decision).** Increment peer `sealVersion` on every installed MLS epoch
  identity/lineage change and anchor-topic change, including same-number recovery. Capture it with
  each seal; re-check before handoff.
  Invalidate stale prepared frames and unproven publications on a mismatch, then reseal (r7 decision).
  An ordinary floor-position change alone does not invalidate identical bytes. Delivered-entry resends use the same rule with a
  worker-local retry slot, since their `seq: -1` cannot share the outbox map.
- **Identity-bound proof (r7 decision).** Compare authenticator bytes and lineage, never epoch alone.
  Peer snapshots identity from `mls.readRecoverySource()` after committed installation
  (`rpc/src/crypto.ts:427`, `mls-rpc/src/mls.ts:285`). Capture identity/version before sealing;
  read source before and after sealing and require unchanged identity, including lineage.
  The returned frame binds that exact seal identity. Check identity/version immediately before handoff, with no intervening await.
  Suspend the snapshot during adoption/anchor recapture; publish refreshed identity/version before releasing the peer seal barrier.

  Publication acknowledgement retains the frame's identity/version, including when recovery overlaps the await.
  A stale acknowledgement cannot suppress resealing or certify an occurrence under the replacement identity.

  `beginWalk` captures acknowledgement counter, identity and version before fetching.
  `certify` requires publication, walk, covered identity and current snapshot to agree, plus the existing acknowledgement cutoff.
  A walk crossing identity/topic invalidation proves nothing from its old token; schedule a fresh walk/probe.
  Apply the same before/after snapshot checks to the no-new-head probe proof
  (`rpc/src/log-delivery.ts:194`). Preserve existing floor/coverage/hold requirements on both proof paths.
  Already-proven entries bypass invalidation and retain their frozen removal outcome.
- Old-epoch acknowledged but unproven publications reseal. Restart discards unproven publication evidence and reseals with new IDs.
  Entries with a settlement obligation settle their frozen result first, without resealing or recertifying (r12 decision).
  No 365-day ambiguity horizon is needed for app attempt recovery.
- **Status.** `pending` until first atomic put; `accepted` when it commits; `published` only at proof.
  `remove(seq, {segment, position: sequenceID})` names the publication proof certified. Freeze that
  outcome when proven and retry the identical removal after failures, even if the epoch changes.
- D7 writes published status/position with removal. The sender records the proven occurrence;
  receivers keep their first durable occurrence. `clear` and deletion fail unpublished messages.
- **Durable settlement (r12 decision).** Certification records `{sequenceID, attemptID, outcome: 'published'}` in `outboxMeta`.
  It acquires `recordSettlement`'s shared gate before freezing the outcome. Freeze and obligation persistence form one gate-owned action.
  `certify` resolves only after obligation commit. Evidence waiting for that gate remains unproven.
  The row key binds groupID and outbox seq. `sequenceID` is the certified hub position, and `attemptID` is `lastAttempt.publishID`.
  `recordSettlement` validates that exact stored attempt and persists before any removal or terminal state/control adoption may commit.

  Both proof paths await it. Certification and terminal adoption share the group gate, with terminal adoption ordered behind the obligation write.
  Known obligation-write rollback retries while retaining that gate. Unknown outcomes use D2's barrier and D7's marker resolver before releasing it.
  No terminal writer passes a frozen proof awaiting this write. Publication acknowledgement alone never creates an obligation.
  Exact duplicate obligations succeed without another hook. Missing entries or conflicting attempts/results reject without changing rows.

  Once obligated, an entry cannot replace `lastAttempt`. Reconstruct its frozen outcome as `{segment: lastAttempt.segment, position: obligation.sequenceID}`.
  The obligation contains no ciphertext, proof transcript or durable acknowledgement cache. It survives identity invalidation and process death.
  Removal deletes the obligation with its entry, in the published-status transaction. No independent cleanup deletes it.
  Restart loads obligations before resealing or terminal clearing. Terminal clear reports `published` for obligated entries and fails only the remainder.
- **Terminal proof settlement (r8 decision), phase 2 runtime.** Self-removal settles every frozen proof before clearing remaining entries.
  Known rollback retains the proof and retries identical `remove(seq, outcome)`; ambiguity stays inside D7's resolver.
  Clear never overtakes an unsettled proven removal. The current removed branch clears proof first
  (`rpc/src/log-delivery.ts:102`); close cancels retries (`rpc/src/log-delivery.ts:280`, `rpc/src/peer.ts:3341`).
  Disposal stops sending/walking and new certification immediately, but preserves the frozen removals in a storage-only finaliser.
  Before closing the host boundary, register that finaliser as counted work with a scoped remover for those seq/outcome pairs only.
  Its retries survive closure; it cannot accept, seal, publish or clear. `dispose()` never awaits it inside a host callback.
  `drained()` waits for finaliser success, including retry timers, before owner deletion or Welcome replacement.
  In-flight removal joins that finaliser; committed retries skip hooks as D7 requires. No timeout discards proof or authorises cleanup.
  Unproven evidence remains memory-only. The r12 obligation preserves certified settlement across a kill after terminal adoption (r12 decision).
  Phase 2 uses opaque status rows; phase 5 wires MessageStore status.
- **Hub double.** Re-key dedup by `(topicID, publishID)`; retain original acceptance timestamps.
  `purge` expires at the real store's inclusive 365-day cutoff (`hub-store/src/store.ts:497`).
  Trimming/acknowledging frames does not expire dedup; retries do not extend its timestamp.
  Phase 2 changes the memory double and adds shared hub-conformance scope/expiry cases.

### D7. Coordinated outbox contract and decoding

Only rpc's entry/outcome types, decoder/errors and memory contract fixtures land in phase 2.
Hozon factory/hook types are phase 3 `rpc-store` exports; rpc gains no Hozon dependency.
Client/messaging supply hooks later.

```ts
export type CoordinatedOutboxHooks = {
  onPut(tx: StoreProvider, entry: AppOutboxEntry): Promise<void>
  onRemove(tx: StoreProvider, entry: AppOutboxEntry, outcome?: AppPublicationOutcome): Promise<void>
  onClear(tx: StoreProvider, entries: Array<AppOutboxEntry>): Promise<void>
}
export function createCoordinatedOutbox(params: {
  db: HozonDB
  groupID: string
  atRest: AtRestCodec
  hooks: CoordinatedOutboxHooks
}): AppOutbox
// New rpc exports:
export class OutboxReplacementError extends Error { override name = 'OutboxReplacementError' }
export class InvalidAppEntryError extends Error { override name = 'InvalidAppEntryError' }
export function decodeAppEntry(entry: AppOutboxEntry): { procedure: string; payload: unknown }
```

**Decoding (r6 decision).** New errors inherit `(message?: string, options?: ErrorOptions)`.
Decode `entry.data` as fatal UTF-8 JSON; require broadcast version 2, `payload.typ === 'event'`,
and `payload.prc === entry.prc`. Return `{procedure: entry.prc, payload: decoded.payload.data ?? {}}`.
The stored `prc` names the procedure; data contains the encoded event (`rpc/src/app-outbox.ts:16`,
`broadcast/src/transport.ts:75`). This matches lane data normalisation (`rpc/src/app-lane.ts:538`).
Malformed/mismatched/non-event entries throw `InvalidAppEntryError`; no fallback placeholder.
This decoder does not validate a protocol schema or infer authorship. Messaging hooks validate their
payload and derive own author from the host identity; a decode error rolls back acceptance.

- `put/recordSettlement/remove/clear` run one root transaction each. Read affected entries from tx, mutate outbox,
  await applicable hooks, then write fresh `mutationID` to group outbox meta. Resolve after commit/hooks.
  Cursor stays in `ControlStore`; adoption writes remain co-committed with state.
- **Obligation rows (r12 decision).** `recordSettlement` uses the canonical gate and mutation marker, resolving storage ambiguity internally.
  Its known rollback retains the certification gate through retry. It runs no message-status hook.
  `loadSettlement` reads the committed row. A present obligation overrides outcome-free removal and supplies the frozen published outcome.
  Conflicting explicit removal outcomes reject unchanged. Remove co-deletes entry/obligation and awaits `onRemove(tx, entry, frozenOutcome)`.
  `clear` reads entries and obligations in its transaction. It calls outcome-bearing `onRemove` for obligated entries, then `onClear` for the remainder.

  All deletions and hooks co-commit. Known rollback retains obligations. Retries/restart never run a failed hook for an obligated entry.
  Deletion and Welcome replacement drain these obligations, including reconstructed obligations, before erasing outbox/meta rows.
- Serialise each outbox from transaction entry through ambiguous read-back. Unknown remove skips
  its hook and succeeds; retry after reopen cannot write status twice. Replacement may change only
  `lastAttempt`; different protocol, prc or data throws `OutboxReplacementError`, changing nothing.
- On ambiguous COMMIT, use a fresh root transaction. Complete D2's owner-row barrier,
  then read meta in a subsequent statement (r7 decision).
  Equal mutationID resolves. The exact previous marker/absence proves rollback only after this barrier.
  Any other marker violates ownership; keep writers blocked until reconciliation, rather than declaring rollback.
  Failed barriers/reads retry 100 ms, doubling to 15 s. Keep caller and later mutations paused.
  Acceptance retains its sequence reservation meanwhile.
- Messaging correlates by `(groupID, ownAuthor, payload.id)`, never seq. Sequences can restart after
  reopening an empty inventory (`rpc/src/app-outbox.ts:73`). `onPut` inserts accepted once;
  outcome-bearing `onRemove` writes published/position once; `onClear/onDelete` fail unpublished rows.
  Without an obligation, generic outcome-free removal removes the row without claiming publication (r12 decision).
- D3 deletion shares the root's `getGroupMutationGate(db)` through its state store (r7 decision).
  Drain first, then enter that gate once. The delete transaction invokes only tx stores/hooks.
  Peer disposal alone does not justify bypassing unresolved transactions.

**Shared memory transaction (r6 decision). Factories/completion barrier (r7 decision), test support in `rpc-conformance`:**

```ts
export type MemoryStoreRows = Record<string, Map<string, unknown>>
export type MemoryTransaction = {
  rows: MemoryStoreRows
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}
export type MemoryDatabase = {
  mutationGate: GroupMutationGate
  transact<TValue>(fn: (tx: MemoryTransaction) => Promise<TValue>,
    options?: OutcomeAwareTransactionOptions): Promise<TValue>
  completionBarrier(groupID: string): Promise<void>
  snapshot(): MemoryStoreRows
}
export function createMemoryTransaction(params: { rows: MemoryStoreRows }): MemoryDatabase
// Shared adapters (r8 decision). Canonical names below denote conformance structural mirrors.
export function createMemoryControlStore(params: { db: MemoryDatabase; groupID: string; atRest: AtRestCodec }): ControlStore
export function createMemoryAnchorStore(params: { db: MemoryDatabase; groupID: string; atRest: AtRestCodec }): AnchorStore // r10 decision
export function createMemoryAppCursorStore(params: { db: MemoryDatabase; groupID: string }): AppCursorStore
export function createMemoryGroupStateStore(params: {
  db: MemoryDatabase
  atRest: AtRestCodec
  onDelete?: (tx: MemoryTransaction, groupID: string) => Promise<void>
}): GroupStateStore
export function createMemoryCoordinatedOutbox(params: {
  db: MemoryDatabase; groupID: string
  atRest: AtRestCodec
  hooks: {
    onPut(tx: MemoryTransaction, entry: AppOutboxEntry): Promise<void>
    onRemove(tx: MemoryTransaction, entry: AppOutboxEntry, outcome?: AppPublicationOutcome): Promise<void>
    onClear(tx: MemoryTransaction, entries: Array<AppOutboxEntry>): Promise<void>
  }
}): AppOutbox
```

Clone all maps/values at transaction entry; expose only the clone during the callback. Atomically
publish it on success, then run commit hooks before resolving. Callback rejection discards the
clone, runs rollback hooks and discards commit hooks; hook exceptions are contained.
Serialise root transactions; disallow reentrant transactions. `snapshot` returns a defensive copy
of committed rows, including while a callback is held. Test adapters share one `MemoryDatabase`
for state/control/anchor/pending/outbox/meta and opaque host side rows; do not construct separate
memory databases per adapter. Factories take `{db: MemoryDatabase, ...}` with the same group/hook
parameters as their Hozon counterparts, substituting `MemoryTransaction` for `StoreProvider`.

**Shared factory binding (r8 decision).** Phase 3 rpc-store exports:

```ts
export function createControlStore(params: { db: HozonDB; groupID: string; atRest: AtRestCodec }): ControlStore
export function createAnchorStore(params: { db: HozonDB; groupID: string; atRest: AtRestCodec }): AnchorStore // r10 decision
export function createAppCursorStore(params: { db: HozonDB; groupID: string }): AppCursorStore
```

Each adapter binds all operations to groupID, obtains the canonical root gate, and follows D2's owner-row/barrier rules.
Anchor/cursor saves resolve internally; control apply retains P2a's peer-owned resolution. Co-writes use tx rows, never public adapters.
Shared memory adapters read/write MemoryDatabase rows exclusively; no private control/anchor/cursor state participates in persistence fixtures.
Retain the existing no-argument `createMemoryControlStore<Position>(): MemoryControlStore<Position>` as a legacy overload
(`rpc-conformance/src/memory-control-store.ts:68`). It keeps standalone tests compatible and is excluded from shared persistence fixtures.
The `{db, groupID, atRest}` overload returns only the ControlStore port; state and anchor use their separate shared factories (r9 decision).
The legacy no-argument call stays unchanged. D5 adds r11 control metadata. Hozon factories refuse non-root scope with `NonRootProviderError` as D2 specifies.
Use row namespaces `groupOwner`, `state`, `control`, `anchor`, `pending`, `appCursor`, `outbox` and `outboxMeta`.
Owner/state/control/anchor/meta marker keys are groupID; compound keys use JSON arrays `[groupID, id/topicID/seq]`.
Settlement rows use `outboxMeta` keys `JSON.stringify([groupID, 'settlement', seq])` (r12 decision).
Host side rows use a separate namespace. Future memory MessageStore uses that same database.
Reopen wraps the same committed rows, with every runtime cache discarded.

**Unfinished commit faults (r7 decision).** Keep commit-then-reject, and add rejection before backend completion.
The transaction callback has completed but its private rows/hooks remain unpublished and its owner lock remains held.
Reject `transact` with `StorageOutcomeUnknownError` while retaining that pending transaction separately from the caller promise.
`snapshot` may show previous rows/absence. `completionBarrier` and later transactions wait for backend settlement.
The fault controller publishes the saved clone (`commit`) or discards it (`rollback`), retaining both hook queues (r8 decision).
Only then may the barrier finish and the adapter classify markers. D2's retained token settles hooks before caller/gate release.
Commit-then-reject also retains hooks until resolution; it cannot run rollback hooks merely because the root rejected.
Callback failure with completed rollback remains known and runs rollback hooks once.
Memory resolvers must use this barrier, including initially absent owner/state/meta rows.
A negative snapshot alone must fail conformance. Doubles are no more permissive than the provider contract.

### D8. Provider guarantees (phase 3 gate)

These are required supported guarantees, not provider test results. D2's COMMIT ambiguity model
applies. Hozon does not configure transaction isolation (`../hozon/packages/db/src/db.ts:194`).

| Claim | node-sqlite | postgres | expo |
|---|---|---|---|
| Root transaction commits all stores or none; promise resolves after commit/hooks | required | required | required |
| CAS conditional plain UPDATE affected count | required | READ COMMITTED; stricter serialization failure maps to conflict | required; no RETURNING (`../hozon/packages/expo/src/driver.ts:104`) |
| Transaction execution | one-connection serialisation | concurrent when pool capacity permits (`../hozon/packages/postgres/src/index.ts:73`) | connection mutex (`../hozon/packages/expo/src/driver.ts:53`) |
| Root call inside transaction | must not await; connection is held | independent transaction when pool capacity permits; must not await either | must not await; connection is held |
| Supported ambiguous COMMIT model | known only with completed COMMIT/ROLLBACK; otherwise barrier | transport loss can be ambiguous | known only with completed COMMIT/ROLLBACK; otherwise barrier |
| Negative ambiguity result, r7 | writer lock, then final marker read | owner-row conflict wait, then fresh READ COMMITTED statement | connection completion plus writer lock, then final marker read |
| Outcome-aware hooks, r8 | retained token; barrier selects one hook queue | retained token; barrier selects one hook queue | retained token; barrier selects one hook queue |

## Phase 2 implementation order and exit criteria

1. MLS version-2 codec, P2a recovery serializer adaptation and source-tree/rejoin regression. Retention propagation and rotation/control builders exposing handshake generations (r10 decision).
2. D3 port, spent-epoch admission, codec-injected shared state/control/outbox/anchor factories, shared cursor, outcome-aware hooks, async registry/access and lineage plumbing.
   Reuse P2a co-commit. Include spent-authenticator plumbing, durable handshake reservations and the P2a D4 admission amendment (r10 decision).
   Include the 64-generation handshake budget, terminal error/outcome plumbing and receiver-window parity (r11 decision).
   Include atomic local anchor ordinal capture and the gated durable ControlStore baseline reader (r12 decision).
3. D4 pending/handler migration, including optional broadcast metadata and directed stamped headers.
4. D6 entry/publication/removal shapes, prepared-byte retries, durable settlement obligations and terminal proof settlement (r12 decision).
   Preserve memory-hub dedup parity.
5. D7 rpc decoder/error exports and coordinated memory contract fixtures; no production rpc-store adapter.
   Shared fixtures expose physical-record mutation/swaps and transaction-bound side-row writes (r11 decision).
6. MLSEncryptor extraction with committed membership snapshots/numeric receive counts. Hub-client lifts keep epoch inspection injected. Preserve subscription retention
   on first subscribe, reconnect and same-connection retry. The source drops options on replay
   (`../kubun/packages/plugin-p2p/src/hub/hub-like.ts:529`, `../kubun/packages/plugin-p2p/src/hub/hub-like.ts:608`).
7. In-process e2e smoke: standalone devices, real MLS ports/registry on shared memory host stores,
   real HTTP hub, explicit server DID, invite/join, retained send, opened epoch and proof outcome.
   Include non-admin rotation/resume and state/pending replay by rebuilding runtime over stored rows.
   Include A3 install/advance, confirmed lower recovery to B2, exact/alternate A3 refusal, and deletion/reopen/refused Welcome replay (r10 decision).
   A4's `(3,10)` message/read watermark precedes B2's `(4,20)` message, which remains unread (r12 decision).
   Poison-head mismatch rotation rebuilds use strictly increasing handshake generations, including after reconstruction (r10 decision).
   Exhaust the handshake budget deterministically; verify peer decryption at the boundary and typed refusal beyond it (r11 decision).
   This driver is a test host over GroupPeer/registry; it depends on neither Device nor Messenger.

Phase 2 ships no `client`, `messaging`, MessageStore schema, Hozon adapter or child-process driver.
Memory host side rows verify coordination without claiming real messaging status integration.
Both contract suites run against real implementations and every affected double. All affected
package tests, integration tests and repo-wide `pnpm turbo run test:types` must pass.

Hub-client's buffer takes this group-bound runtime port, not a GroupStateStore observer:

```ts
export type BufferedEpochInspection = {
  inspectEpoch: (ciphertext: Uint8Array) => bigint | undefined
  currentEpoch: () => number | null
  onEpochChanged: (listener: () => void) => () => void
}
// hub-client constructor (r7 decision); PeerScopedHubViewParams = {hub: MailboxHub; peerDID: string}.
export type BufferedPeerHubViewParams = PeerScopedHubViewParams & {
  groupID: string
  epochs: BufferedEpochInspection
  reconnectTimeoutMs?: number
  logger?: { warn(message: string, context?: Record<string, unknown>): void }
}
export type BufferedPeerHubView = MailboxHub & { dispose(): void }
export function createBufferedPeerHubView(params: BufferedPeerHubViewParams): BufferedPeerHubView
```

The lifted constructor replaces its registry dependency with `epochs`
(`../kubun/packages/plugin-p2p/src/hub/buffered-peer-hub-view.ts:33`).
Decode the envelope, then pass ciphertext to `epochs.inspectEpoch`, as the existing buffer does
(`../kubun/packages/plugin-p2p/src/hub/buffered-peer-hub-view.ts:47`).
Keep malformed/unknown-epoch passthrough, notification wake/revisit and disposal unsubscribe
(`../kubun/packages/plugin-p2p/src/hub/buffered-peer-hub-view.ts:51`,
`../kubun/packages/plugin-p2p/src/hub/buffered-peer-hub-view.ts:110`,
`../kubun/packages/plugin-p2p/src/hub/buffered-peer-hub-view.ts:235`).
Inspection is an unauthenticated prefilter (`mls/src/group-info.ts:17`). Bind registry notifications
through the loaded access's group-bound runtime in phase 2, later in client (r8 decision).
`currentEpoch` returns null for null/unavailable snapshots; notification payloads wake the buffer without implying peer removal.
Automatic `/info` integration remains BLOCKED in the
umbrella Risks; smoke uses injected server DID, not a new production endpoint.

## Crash seams

Only wrapping stores/hub clients in test support. Phase 2 runs failure/reconstruction tests;
phase 3 runs real-store boundaries; phase 6 arms, reports, blocks and kills a child at each seam.
"After" means the delegated atomic method's root transaction committed. No production pause hooks.

| Point | Wrapped method | When | Coverage / phase |
|---|---|---|---|
| Decrypt, before ratchet-plus-pending save | `GroupStateStore.saveOpened` | before | extend pending crypto failure case; 2/3/6 |
| Saved pending, before host message write | `saveOpened` | after | pending reopen exists; MessageStore integration 5/6 |
| Host message persisted, before completion | `MessageStore.put` | after | 5/6 |
| Pending complete, before cursor advance | `completePending` | after | completion ordered today; durable provider/kill 3/6 |
| Accepted outbox, before publish | `AppOutbox.put(lastAttempt: null)` | after | extend existing restart; coordinated message write 5/6 |
| Hub acknowledgement, before publication bookkeeping | app hub `publish` | after | new ID/status assertions over existing restart; 2/5/6 |
| Proof, before published-status/removal | `AppOutbox.remove(seq, outcome)` | before | outcome contract 2; atomic MessageStore 5/6 |
| Lease reserved, before seal | `save` raising HWM | after | 2/3/6 |
| Handshake generation reserved, before built persistence/publication | source `save` raising handshakeHWM | after | restart/rebuild skips consumed generation; exact saved replay stays byte-identical; 2/3/6 (r10 decision) |
| Joined state saved, before key consume | `save(kind: 'welcome')` | after | state and spent authenticator committed together; replay cannot install again; consume resumes; 2/3/6 |
| Welcome readmission, between state/spent-set/control/anchor writes | `save(kind: 'welcome')` | injected failure | neither state/spent-set/reset/anchor changes; old runtime not installed; 2/3 |
| Welcome readmission committed, before peer restart | `save(kind: 'welcome')` | after | unknown outcomes preserved; reset anchor recaptured at join; 2/3/6 |
| Deletion committed, before restart | `delete` | after | tombstone/rows 2/3; failed messages 5; SIGKILL 6 |
| COMMIT rejected, backend unfinished | root transaction and D2 barrier | raw read shows previous/absent marker, then backend commits or rolls back | no premature rejection/release; 2 memory / 3 providers |
| Anchor/cursor save rejected, backend unfinished | `AnchorStore.save` / `AppCursorStore.save` | disposal/drain then delete or Welcome replacement | late commit/rollback settles first; no deleted rows or old-admission anchor reappear; 2/3 |
| Proven removal rolled back, terminal cleanup requested | `remove(seq, outcome)` | self-removal or dispose/drain/delete | frozen proof settles before clear/delete; published never failed by that cleanup; 2 status double / 5 MessageStore |
| Certified obligation pending, terminal adoption queued | `recordSettlement` | rollback or unfinished COMMIT | gate holds terminal state/control adoption until obligation commit; 2/3 (r12 decision) |
| Certified, remove rolled back, terminal adoption committed | self-removal state/control save | kill before remove retry | obligation survives; restart terminal clear reports published once and co-deletes entry/obligation, never failed; 2 reconstruction / 3 provider / 5 status / 6 SIGKILL (r12 decision) |

Control/rejoin/Welcome-delivery seams remain owned by P2a. Its in-process Welcome crash reconstruction
is existing coverage (`tests/integration/test/welcome-after-crash.test.ts:179`), not child-process coverage.

## Conformance additions

Phase 2 fixtures provide reopen (same committed rows, new runtime), second-write failure,
commit-then-reject, unfinished-commit faults, clock control, physical-record mutation/swaps and transactional side-row writes/inspection (r11 decision). Generation tests use real MLS.
Phase 3 supplies those fixtures on every provider, plus a separate-connection postgres visibility
barrier. Expo uses a node shim or records BLOCKED with its reason. Phase 6 supplies the kill harness.

**Harness/factory contract (r7 decision). Hook counts and shared anchor fixture (r8 decision), rpc-conformance exports:**

```ts
export type RawStoredRecord = {
  groupID: string; namespace: string; recordID: string; key: string; bytes: Uint8Array // physical key, r11 decision
}
export type StoredRecordMutations = { // test-only physical operations (r11 decision)
  mutateStoredRecord(namespace: string, key: string,
    mutate: (bytes: Uint8Array) => Uint8Array): Promise<void>
  swapStoredRecords(namespace: string, keyA: string, keyB: string): Promise<void>
}
export type PersistencePorts = {
  groupID: string
  state: GroupStateStore; registry: GroupHandleRegistry
  control: ControlStore; anchor: AnchorStore; outbox: AppOutbox; cursor: AppCursorStore
}
export type PendingCommitFault = {
  rejected: Promise<void>             // caller's root promise rejected, backend still holds owner lock
  barrierWaiting: Promise<void>       // resolver reached the completion barrier
  finish(outcome: 'commit' | 'rollback'): Promise<void>
}
export type PersistenceFaults = {
  failNext(point: 'after-first-write' | 'before-commit' | 'status-read'): void
  commitThenReject(): void
  rejectCommitPending(): PendingCommitFault // arms the next mutation
}
export type PersistenceFixture<TPorts> = StoredRecordMutations & {
  ports: TPorts
  reopen(): Promise<TPorts>
  faults: PersistenceFaults
  inspectRows(): Promise<MemoryStoreRows> // logical committed rows; deliberately bypasses barrier
  inspectRawBytes(): Promise<Array<RawStoredRecord>> // before codec.open; no logical decoding (r9 decision)
  inspectSideRow(key: string): Promise<Uint8Array | null> // committed bytes; bypasses barrier (r11 decision)
  atRest: AtRestCodec                // same injected codec across reopen
  setTime(now: number): void
  advanceTime(ms: number): Promise<void>
  close(): Promise<void>
}
export type ConformanceTransaction = {
  onCommit(fn: () => void): void
  onRollback(fn: () => void): void
}
export type ConformanceOutboxHooks<TTx extends ConformanceTransaction> = {
  onPut(tx: TTx, entry: AppOutboxEntry): Promise<void>
  onRemove(tx: TTx, entry: AppOutboxEntry, outcome?: AppPublicationOutcome): Promise<void>
  onClear(tx: TTx, entries: Array<AppOutboxEntry>): Promise<void>
}
export type PersistenceConformanceParams<TPorts, TTx extends ConformanceTransaction> = {
  label: string
  writeSideRow(tx: TTx, key: string, bytes: Uint8Array): Promise<void> // awaited inside supplied hook (r11 decision)
  createFixture(id: string, hooks?: {
    outbox?: ConformanceOutboxHooks<TTx>
    onDelete?: (tx: TTx, groupID: string) => Promise<void>
  }): Promise<PersistenceFixture<TPorts>>
}
// TTx is MemoryTransaction in phase 2; StoreProvider in phase 3. Both expose onCommit/onRollback.
// Extend the existing ControlStore harness with the same completion faults.
export type ControlStoreConformanceParams = StoredRecordMutations & {
  open(): Promise<ConformanceControlHost>
  reopen(): Promise<ConformanceControlHost>
  injectFailure(point: 'mid-apply' | 'mid-save'): void
  commitThenReject(): void
  faults: PersistenceFaults
  inspectRows(): Promise<MemoryStoreRows>
  inspectRawBytes(): Promise<Array<RawStoredRecord>>
  atRest: AtRestCodec
  close(): Promise<void>
}
export function testGroupStateStoreConformance<TTx extends ConformanceTransaction>(
  params: PersistenceConformanceParams<PersistencePorts, TTx>
): void
export function testCoordinatedOutboxConformance<TTx extends ConformanceTransaction>(
  params: PersistenceConformanceParams<PersistencePorts, TTx>
): void
export function testAppOutboxConformance<TTx extends ConformanceTransaction>(
  params: PersistenceConformanceParams<{outbox: AppOutbox}, TTx>
): void
export function testAppCursorStoreConformance<TTx extends ConformanceTransaction>(
  params: PersistenceConformanceParams<{cursor: AppCursorStore}, TTx>
): void
export function testAnchorStoreConformance<TTx extends ConformanceTransaction>(
  params: PersistenceConformanceParams<PersistencePorts, TTx>
): void

// Welcome structural mirrors (r10 decision). TGroup is the fixture's actual joined handle.
export type ConformanceWelcomeGroup = {
  groupID: string
  epoch: bigint
  state: { keySchedule: { epochAuthenticator: Uint8Array } }
}
export type ConformanceOpenWelcomeResult<TGroup extends ConformanceWelcomeGroup> =
  | { joined: {
      group: TGroup
      credential: { id: string; groupID: string }
      sourceErrors?: Array<Error>
    }; joinRef: { sourceID: string; ref: string } }
  | { alreadyJoined: string }
export type ConformanceWelcomeAdmissionParams = {
  held: { epoch: number; deleted: boolean; spentEpochAuthenticators: Array<Uint8Array> } | null
  welcome: { epoch: number; epochAuthenticator: Uint8Array }
}
export type ConformanceJudgeWelcomeAdmission = (
  params: ConformanceWelcomeAdmissionParams
) => 'join' | 'alreadyJoined' | 'replace' | 'refused'
```

These signatures replace AppOutbox's synchronous `createOutbox/failNextPut` fixture
(`rpc-conformance/src/app-outbox.ts:18`). Retain its cases with the new fault driver.
ControlStore's existing factory remains, with the additions above (`rpc-conformance/src/control-store.ts:175`).
Its `commitThenReject` method forwards to the same fault controller.
AnchorStore's one-case harness gains the shared fault/reopen fixture (`rpc-conformance/src/anchor-store.ts:20`).
Retain its round-trip case. Shared fixtures use D7's explicit factories, including required control/anchor `atRest` (r10 decision).
Each factory creates an isolated database and all ports over its one root/gate, with supplied hooks.
State/control/outbox/anchor share a host-supplied codec. Phase 2 fixtures inject a deterministic authenticated test codec (r10 decision).
Identity/plaintext codecs cannot satisfy these fixtures.
Use `MemoryTransaction` for memory hooks and `StoreProvider` for Hozon hooks; absent hooks are no-ops.
Memory exports Hozon-free structural mirrors of D2's settlement/options types (r8 decision).
Hook assertions register both queues and count each invocation, including ambiguous delete and outbox mutations.
While outcome remains uncertain, both counts stay zero. Confirmed commit runs each commit hook once, rollback hooks zero, before caller/next-writer release.
Confirmed rollback reverses those counts. Resolver retries, disposal, reopen and repeated remove never duplicate hooks in the surviving process.
`reopen` waits for backend/resolver/hook settlement, discards runtime state and rebuilds ports over the same rows.
Faults/clock follow the rebuilt ports. `inspectRows` normalises provider rows for the same assertions.
`inspectRawBytes` reads committed physical byte values, including duplicate copies, before codec opening or logical normalisation (r9 decision).
Its `key` addresses the physical byte slot, using D7's row key for single-copy records, distinct from the AAD `recordID` (r11 decision).
When providers duplicate a byte value, expose each physical copy with a distinct key addressing that copy.
Scan those bytes for non-empty plaintext and distinctive spans from state, pending frames, outbox payloads, control secrets and `AnchorSlot.anchor.secret` (r10 decision).
Logical port round-trips alone cannot pass encryption conformance. Open stored ciphertext with another group, namespace or record ID's AAD: rejection is required.
Swap ciphertext between physical record identities and assert adapter reads reject too. Reopen with the same host codec preserves logical state and payloads.

**Physical mutation binding (r11 decision).** `mutateStoredRecord` replaces only the addressed committed byte value, using defensive input/output copies.
`swapStoredRecords` atomically exchanges the two addressed byte values. Both preserve keys, unencrypted metadata and mutation markers.
Missing namespace/key rejects without changes; a throwing mutation callback leaves bytes unchanged. Neither operation calls the codec or logical adapters.
Phase 2 binds these operations to shared MemoryDatabase records. Phase 3 binds them to each provider's raw tables/columns.

Bindings remain valid after reopen. Run mutations only with backend/resolvers idle; reopen before adapter reads to discard cached plaintext.
Each encryption fixture supplies two valid physical record identities for its swap cases, seeded through normal adapters in the same database.
Use mutation for byte corruption and cross-namespace substitution; use swaps for same-namespace record/group identity substitutions.
`testGroupStateStoreConformance` uses both operations for state/pending encryption cases. ControlStore's harness uses both for at-rest control.
`testCoordinatedOutboxConformance` and `testAnchorStoreConformance` use both for their at-rest cases, including anchor adoption copies.

**Side-row binding (r11 decision).** Suites call `params.writeSideRow(tx, key, bytes)` inside coordinated-outbox and deletion hooks, awaiting the write before returning.
The writer upserts copied opaque bytes in namespace `sideRows`, on that exact supplied transaction.
Phase 2 writes `tx.rows.sideRows`. Phase 3 uses a test side-row store obtained from `tx.getStore`, sharing its raw transaction.
It never opens a root transaction or publishes a separate map. `inspectRows` includes committed `sideRows`; `inspectSideRow` returns copied bytes or null.
Inspection never resolves ambiguity. Phase-2 snapshots and the independent postgres reader expose prior committed rows while an injected COMMIT remains unfinished.

`testCoordinatedOutboxConformance` uses the writer in rollback/visibility, ambiguous mutations, negative-read/late-completion and shared-deletion-gate cases.
After known commit, read outbox and side row and assert both new values. After rollback, both retain their exact prior values/absence.
During an unfinished COMMIT, both remain prior despite callback completion. After late commit/rollback settlement, every provider's fixture reads both and verifies atomic visibility.
Cover put/replacement/remove/clear/delete using a side-row marker per hook, alongside the existing hook-count assertions.
Postgres additionally reads both through the independent connection before commit. Hook counts alone cannot pass these visibility cases.

`after-first-write` fails between coupled logical writes; owner-row locking statements do not count.
Suites close fixtures in finally blocks. Conformance type mirrors retain every normative field/signature above;
they follow the existing structural mirror approach (`rpc-conformance/src/control-store.ts:168`).
Canonical port names in this block denote those structural `Conformance*` mirrors, not imports from mls-rpc.
The state-record mirror includes `spentEpochAuthenticators` and `handshakeHWM`; the Welcome mirrors above preserve the exact nested union and options shape (r10 decision).
State/anchor mirrors retain `anchorOrdinal`, `anchorOrdinals`, captured ordinal/captureID and capture signatures (r12 decision).
Registry/access mirrors retain `loadControl` and the baseline callback argument. Outbox mirrors retain the obligation type and record/load methods (r12 decision).
Built/outcome mirrors preserve `handshakeGeneration` and rejected `errorName`; fixture mirrors retain physical mutations and the side-row writer (r11 decision).
Ordinary receipts can short-circuit open (`mls-hub/src/join.ts:50`). Test spent admission/seed directly and wire replay before consume.
After consume, assert receipt-only handling never installs state.

| Suite / phase | Case | Assertion / existing coverage |
|---|---|---|
| codec/registry, 2 | lossless sender | zero, one, absent survive clone/save/reopen; malformed sidecar refused; version 1 throws; regression fails on current codec |
| recovery codec, 2 | v2 source-tree/rejoin | full candidate/source state round-trip with different trees, no proposals and zero/one/absent senders; saved candidate/requestKey restores bound verdict and adopts once; v1 candidate refused |
| `testGroupStateStoreConformance`, 2 memory / 3 providers | CAS/version | wrong expected, lower/equal version, ordinary lower epoch, lower lineage/floor and tombstone-as-absent conflict without logical changes |
| | forbidden lineage changes, r10 | matching CAS/new version, unchanged epoch/authenticator, ordinary kind 'state' with increased lineage and reset progress: conflict; any lineage decrease, including recovery/Welcome/open/delete, conflicts; bytes, both HWMs, spent set, control/anchor unchanged; doubles and real stores |
| | forbidden same-number identity replacement (r12 decision) | stored E4/authA, unspent E4/authB, matching CAS/new version, unchanged lineage: ordinary kind 'state' save and saveOpened/open replacement each reject; state bytes/version/writeID, sender/receive progress, both HWMs, floor/lineage/spent set, ordinal/map, pending/control/anchor/cursor/outbox/meta/side rows and hook counts all unchanged; real stores and every double; only authorised recovery can replace |
| | confirmed lower recovery | real source at 4, responder at 1, unspent candidate at 2: confirmation/source check permits atomic adoption; version/lineage increase, floor stays 4, both candidate HWMs reset; reopen at 2; tombstone refuses Welcome at/below 4 |
| | refused lower recovery | unconfirmed/refused candidate, stale source/version, absent/tombstoned source or missing adopted co-write changes nothing |
| | spent Welcome after lower recovery, r10 | install A3 (ordinary and last-resort), seal, advance A4, recover onto B2, reopen, replay A3: admission refused and seed/save conflict; B2, both HWMs, lineage, control/anchor and spent set unchanged; unspent B3 remains admissible despite floor 4 |
| | alternate A3 representation, r10 | after A3 → A4 → B2, author produces valid alternate A3 using changed signed GroupInfo extensions and regenerated recipient encryption: same authenticator, different bytes; admission refused, seed/save conflict, never merge; ordinary and last-resort, after restart |
| | deleted-group Welcome replay, r10 | install, stop/drain, settle control, delete, reopen: spent authenticator remains in tombstone; exact/alternate replay refused without resurrection; spent check precedes floor; unspent Welcome above floor joins and retains prior set |
| | spent epoch atomicity/growth, r10 | genesis/Welcome/own commit/received commit/recovery each append installed authenticator with state; failed coupled save spends nothing; ambiguous commit resolves both together; ordinary progress/open/clearJoinRef/delete retain prior set; v2 record codec round-trips unique sorted byte arrays across reopen/tombstones |
| | recovery candidate replay, r10 | confirmed candidate retry across ambiguous commit resolves writeID and installs once; any newly attempted spent candidate, including same-current identity or current-source relabelling, refused before epoch comparison; both HWMs/progress unchanged; adopted replay never reinstalls candidate |
| | at-rest state/pending, r9/r11 | raw stored bytes contain no state/pending plaintext or distinctive spans; logical reopen succeeds with host codec; mutateStoredRecord corruption/cross-namespace substitution and swapStoredRecords cross-record/group substitution reject on adapter reads after reopen |
| | ambiguous saves | commit-then-reject for insert/state/open/Welcome/joinRef-clear/delete exposes exact writeID; registry resolves committed/uncommitted before another writer |
| | negative read, late completion | unfinished insert/state/open/Welcome/delete shows previous/absent rows; barrier and next writer stay pending; late commit resolves/install once, rollback alone rejects unchanged; initially absent owner covered |
| | adoption co-commit | reuse P2a case (`rpc-conformance/src/control-store.ts:321`), now against D3 stores/providers; state/control/anchor/marker all commit or roll back |
| | Welcome reset atomic/reopen | failure in reset or anchor clear rolls back state; success preserves outcomes/Welcomes, settles open work unknown, clears applied/responses/cursor/anchor; restart joins once |
| | identity/HWM | ordinary same identity/lineage preserves both max HWMs; unspent different-authenticator same-number recovery resets both and bumps lineage; no cross-identity tree merge |
| | atomic open and duplicate | second-write failure changes neither state nor pending; same-frame CAS retry leaves one row; extend existing key-unspent case (`rpc-conformance/src/pending-group-crypto.ts:137`) |
| | pending reopen | numeric `(segment, position)` order, epoch retained, unknown/double completion succeeds; extend existing case (`rpc-conformance/src/pending-group-crypto.ts:177`) |
| | lower recovery order/watermark (r12 decision) | accept A4 message at local `(3,'10')`, mark read there, recover to B2 and capture ordinal 4; later B2 `(4,'20')` sorts after A4 and is not covered by prior read watermark; reconstruction preserves order/map; late A4 frame keeps ordinal 3; superseded-A4 receipt cannot cover B2; different anchors never compare peer positions |
| | owner handoffs | consume then clearJoinRef then seal/reserve works without stale CAS; stale ref conflicts; ambiguous clear/open/completion resolves before cache/payload publication; registry crypto needs no external pending callback |
| | delete | stopped/drained owner; atomic tombstone/row cleanup/hook; epoch/lineage floor and spent authenticators survive; stale write fails; no late put recreates rows |
| | independent save versus lifecycle | absent/existing anchor and per-topic cursor save receives ambiguous rejection; dispose/drain/delete and Welcome replacement stay pending; late commit/rollback settles first; delete removes anchor/cursor rows, Welcome clears anchor and new-topic cursor stays null; reopen never installs an old anchor into new admission |
| | unsettled delete | operations, rejoin, outcomes and Welcomes each refuse; reuse predicate/host tests (`rpc/test/control-store.test.ts:253`) |
| P2a ControlStore, 2 / 3 | negative marker barrier | state-free apply rejects before backend completion; lastMutation stays pending despite raw previous marker; late commit resolves once, rollback alone returns previous marker; deletion cannot overtake |
| | at-rest control, r9/r11 | raw snapshot contains no operation body/journal or rejoin candidate/requestKey plaintext; same-codec reopen round-trips; mutateStoredRecord corruption/substitution and swapStoredRecords reject on adapter reads after reopen |
| `testAppOutboxConformance`, 2 / 3 | attempt/outcome | all attempt fields round-trip; outcome reaches remove; unknown removal remains harmless |
| | settlement obligation (r12 decision) | certified sequenceID/attemptID/published round-trips and copies defensively; matching duplicate idempotent, wrong/missing attempt conflicts; obligated lastAttempt cannot change; entry removal co-deletes obligation; generic remove honours its published outcome |
| `testCoordinatedOutboxConformance`, 2 memory / 3 Hozon | rollback/visibility, r11 | hooks await writeSideRow on supplied tx; outbox plus inspectSideRow show both new values after commit, exact prior values/absence after hook failure/rollback; commit/rollback hooks select exactly one queue before resolution; postgres independent reader sees neither change before commit |
| | at-rest outbox, r9/r11 | raw stored bytes contain no payload plaintext or distinctive spans; hooks/list still see logical payloads; same-codec reopen succeeds; mutateStoredRecord corruption/substitution and swapStoredRecords reject on adapter reads after reopen |
| | ambiguous mutations | put, same-data replacement, remove, clear and group delete commit-then-reject resolve iff committed; each registered commit hook fires once before success, rollback hooks never; failed barrier/status read leaves hooks/caller/later writer pending |
| | negative read, late completion, r11 | put (initially absent meta), replacement, remove, clear and delete hooks await writeSideRow; pending COMMIT leaves outbox/side row prior, queues zero and gate held; late commit exposes both changes and commit hooks once; late rollback keeps both prior and runs rollback hooks once |
| | overlap/removal/replacement | B waits through A's readback; repeated remove skips hook; changed protocol/prc/data rejects unchanged |
| | shared deletion gate | construct state/outbox independently over one root; delete waits through pending put/barrier, then atomically clears rows/meta; no later recreation |
| | settlement/terminal gate (r12 decision) | blocked or rolled-back obligation write holds terminal adoption pending; known/late commit persists exact obligation before state/control terminal commit; no publication-status hook during obligation write; ambiguous retries never lose or duplicate settlement |
| | reconstructed terminal clear (r12 decision) | certify, remove rolls back, terminal adoption commits, discard runtime before retry, rebuild terminal peer: obligated entry publishes its frozen ordinal/sequenceID once, never fails; remaining entries fail; entry/obligation/status co-commit; clear rollback retains all rows |
| | root-only constructor, 3 | transaction-scoped provider refused |
| `testAppCursorStoreConformance`, 2 / 3 | durable per topic | reopen saved position; other topics remain null |
| | ambiguous save | commit-then-reject resolves once; unfinished save remains pending through barrier/read failures; late rollback rejects unchanged |
| `testAnchorStoreConformance`, 2 / 3 | ambiguous save/lifecycle | first insert and replacement hold save/drain/gate through pending COMMIT; late commit/rollback resolves before deletion/readmission; no stale slot/secret survives cleanup |
| | capture ordinal (r12 decision) | registry initial/rotation/recovery captures co-increment state counter and slot ordinal; same captureID retry/reopen increments once; keep/restore changes neither; rollback changes neither; tombstone/readmission retain counter/map and next capture exceeds prior maximum; direct save cannot replace captured identity/ordinal |
| | at-rest anchor, r10/r11 | inspect all physical copies after save and adoption landed co-write: no AnchorSlot.anchor.secret plaintext or distinctive spans; same-codec reopen round-trips full slot; mutateStoredRecord corruption/substitution and swapStoredRecords reject on adapter reads after reopen |
| pending/group crypto, 2 | opened epoch | extend record and narrowed unwrap types together; stored epoch equals authenticated unwrap epoch |
| rpc handler tests, 2 | every D4 path | durable replay, retained drain, live log/ephemeral, anycast request and directed kinds expose original epoch; spoofed wire/header epoch cannot win |
| registry real-MLS tests, 2 | lease/restart | reserve, reconstruct, seal at or above HWM; no generation repeats; failed reservations prevent sealing |
| | cold access | fresh registry awaits async load/restore before returning access or publishing getters; concurrent calls share load; weak retention and missing/tombstoned records reject without admission |
| | blocked restore | lapsed, removed, suspended and pending-proposal restores keep control/receive usable; deferred burn completes before an eligible same-identity seal |
| | rotation | 500 admission trigger, rejected new acceptance, held accepted queue; non-admin rotation resumes; restarts/unpublished seals obey the bound |
| | handshake reservation/rebuild, r10 | poison/refused frame advances hub head without MLS advancement; rotation publish head-mismatches, absence returns to intent; rebuilds have strictly increasing authenticated handshake generations, also across restart; failed/unfinished reservation exposes no build/publication; exact saved replay uses identical bytes |
| | handshake budget boundary, r11 | baseline 0: post-reservation crashes/rebuilds burn generations 0–63, including reconstruction; next commit at 64 publishes and an untouched peer decrypts/adopts; new epoch resets budget |
| | handshake budget exhaustion, r11 | separate unpublished run reserves generations 0–64; attempted 65 throws HandshakeBudgetExhaustedError before builder/save, with unchanged HWM/version/source bytes and no publication; terminal rejected errorName survives reopen and peer.commit rejects typed error; no automatic rebuild/re-enqueue; fresh-leaf readmission restores builds |
| | handshake baseline reader (r12 decision) | durable source HWM 65 plus identity/lineage-matched accepted build at generation 64: direct buildControl invokes callback with baseline 64, reserves 66 and permits consumed generation 65; no matching accepted build gives 0 and rejects 65 unchanged; built-only/mismatched accepted records do not count; read failure invokes/reserves nothing; shared gate prevents control writes overtaking the read/check/reservation |
| | receiver-window parity, r11 | real ts-mls and every peer double use configured 1000-step window; direct ratchet/receive test accepts the boundary and rejects a jump above 1000; doubles never accept a jump real ts-mls rejects |
| | overtaking/derivation | raw MLS context tests (outside the registry 500 guard) retain an earlier key after generation 600; derive invite/remove/rotation and fresh/restored recovery retain 1000/1000 |
| | ordinary adoption progress | intervening seal/open remains spent after ordinary replacement; same-identity state save merges both chains; extend P2a historical carry test (`mls/test/carry-receive-progress.test.ts:80`); recovery/Welcome candidates still refuse spent identity |
| | tombstone Welcome floor | reuse comparison (`mls-hub/test/admission.test.ts:10`); add delete/save/rejoin integration |
| rpc delivery tests, 2 | retry bytes/restart | failed or null handoff retries byte-exact with same ID; reconstruction reseals/new ID; extend restart test (`rpc/test/peer-log-delivery.test.ts:554`) |
| | acknowledgement/proof | extend overtaken-epoch restart (`rpc/test/peer-log-delivery.test.ts:1093`); acknowledgement never removes; proof freezes correct segment/sequenceID through failed removal |
| | same-number recovery proof | A at E acknowledged before or during recovery to B at E; B walk and no-new-head probe cannot prove A; reseal/new ID under B before published outcome; old walk token cannot certify B; already-proven A retries its frozen outcome |
| | terminal proof | proof then removal rollback then self-removal retries frozen outcome before clear; disposal cancels send retries but drain waits proof finaliser before delete/Welcome replacement; published hook once, no failed hook for proven seq; unproven rows fail normally |
| | terminal proof restart (r12 decision) | certify and persist obligation, removal rolls back, self-removal state/control commits, kill before retry; restart runs terminal clear without sealing/probing, reports published at the frozen ordinal/sequenceID, deletes obligation with entry and never reports failed; phase 2 reconstructs, phase 6 actually kills |
| MLSEncryptor, 2 | runtime/batch | 64 successful opens flush as 64, mixed batches count exact successes; rotation E+1 with peer retained stays open; committed removal/unavailability, epoch jump and same-number recovery close once; rollback/staged membership never closes; unsubscribe disables watcher |
| `hub-conformance`, 2 | dedup scope/expiry | same ID on two topics appends on both; purge just before cutoff dedups, at cutoff appends; retry does not refresh timestamp; real hub-store and memory |
| hub-client, 2 | retention/buffer | reconnect and retry preserve retention; injected epoch notifications wake held frames; disposal unsubscribes |
| client/messaging, 4/5 | lifecycle/status | rotation scheduling, Welcome consume sweep, deletion fails accepted messages; published status/position co-commit with removal |
| e2e, 2 then 6 | smoke/kill | real HTTP with injected DID in 2; every crash seam on child devices in 6 |
| integration, 2 memory / 3 providers | spent epochs across branches/deletion, r10 | real MLS/openWelcome/registry: A3 → A4 → confirmed B2; exact and alternate A3 share authenticator and both refuse after reconstruction; spent epochs reached by own/received commit or recovery also refuse as Welcome/candidate/seed; delete/reopen retains guard; ordinary and last-resort, including replay before consume |

## Umbrella amendments

Applied in this revision, not deferred to another reconciliation step:

- Package layout: phase 2 codec/retention/rotation/registry and rpc metadata/outcome ports; P2a
  `ControlStore`/`AdoptionWrite`; landed Welcome open/consume. Hozon adapters stay phase 3.
- Flows: durable operations/outcomes/rejoins and Welcome obligations; state save precedes consume;
  explicit atomic readmission reset, inventory and deletion drain.
- Semantics: app-only unproven restart resealing, memory-only exact-byte retry, client `{sequenceID}` result,
  proof-time status/removal outcome and minimal durable settlement obligation (r12 decision). No persisted app ciphertext/ack.
- Scenario 8: split acknowledgement and proof; lease/Welcome/readmission/deletion seams; P2a control seams.
- Phases: scope above. Opened-epoch exposure belongs to phase 2; messaging consumes it in phase 5.
- Lift table: copy the audit's 5 MOVE, 6 EXTRACT, 8 REIMPLEMENT, 1 BLOCKED verdicts. G1 is specified
  here but remains an implementation prerequisite; automatic `/info` integration stays BLOCKED.
- r8: P2a recovery-codec adaptation, asynchronous access, committed membership/numeric receive runtime,
  explicit shared factories, all-writer lifecycle barriers, terminal proof settlement and outcome-aware Hozon hooks.
- r10: lifetime spent epoch authenticators replace r9 Welcome digests; every epoch installation appends atomically, with tombstone retention and explicit P2a D4 amendment.
  Complete Welcome union/options and structural mirrors; durable handshake reservations protect rotation/control rebuilds across restart.
  Host at-rest codec includes anchor factories/namespaces/secrets. Doubles and real stores reject unauthorised lineage changes.
- r11: per-epoch unpublished handshake budget 64, below the configured receiver window 1000; terminal typed exhaustion requires device readmission, without automatic rebuild.
  Shared conformance binds physical mutation/swaps and a transactional side-row writer on memory and provider fixtures.
- r12: durable local anchor ordinals order messages/read watermarks across lower recovery. Peer receipts compare anchor/position only within one anchor.
  Certified outbox-meta obligations survive terminal restart. Registry builds read accepted handshake baselines under the shared gate.
  Ordinary same-number different-authenticator state/open writes conflict, with every coupled row unchanged (r12 decision).

## Review log

Entries r1–r3 are historical review findings, not current API instructions. Their intent/journal,
`onJoined` before release, operation-envelope IDs and lost-work reconciliation solutions were
superseded by P2a. Read current Decisions and binding P2a instead.
The r9 digest rulings are historical too, superseded by r10's spent epoch identities.
The r8 memory-only certified-proof claim is superseded by r12's minimal settlement obligation.

- **Codex r1 (historical).** Adoptable journal blob; proof distinct from acknowledgement; app restart
  resealing; lease burn budget; coordinated remove/clear, message identity and ambiguity ownership.
- **Codex r2 (historical).** Current-record CAS; rotation builder and retention 1000/1000 with limit
  500; occurrence-aware control intent; publication position; outbox mutation marker; tombstone floor.
- **Codex r3 (historical).** Save-before-consume; same-number recovery identity; lineage-aware control
  recovery; recovery journal and separate Welcome obligations; retention propagation; outbox
  serialisation; deletion hook; anchor segment distinct from MLS epoch.
- **Amended by Spec P2a (r5).** D5 control moved to P2a. AdoptionWrite co-commit, source-scoped joinRef,
  unsettled-delete refusal and ControlStore cursor replace the earlier contracts.
- **Premise refresh (r6), 2026-10-09.** Read the premise report, lift audit, binding P2a and sender-zero
  backlog fully. Rechecked current source citations. Required edits 1–11 and every section-5 gap
  are resolved above. New choices, each marked `(r6 decision)`:
  - version 2 with ref-keyed zero sidecar; refuse version 1. Alternative: accept ambiguous version-1 sender loss.
  - explicit `kind: 'welcome'` state/control/anchor reset. Alternative: overload landed-mark adoption or save anchor later.
  - identity-gated merge/HWM and same-number recovery reset. Alternative: compare epoch numbers alone.
  - registry factory plus separate seal/receive access. Alternative: identify sends heuristically inside mutate or persist every registry seal.
  - dynamic owning-access lineage and recovery mode. Alternative: hard-coded zero or pin crypto at creation across recovery.
  - defer burn while encryption is inadmissible. Alternative: unconditional restore-time encrypt, blocking control/recovery restore.
  - rotation rejects new acceptance, holds accepted entries and schedules outside the gate. Alternative: silently accept new sends or rotate inside the registry mutex.
  - non-admin lifecycle-gated proposal-free rotation builder. Alternative: reuse admin-only empty ledger commits or commit pending proposals implicitly.
  - all inbound application contexts, including broadcast/direct requests; optional broadcast transit metadata. Alternative: log-event-only epoch or current-epoch substitution.
  - reuse `{sequenceID}` client result, memory prepared-byte retry slot and identity/topic sealVersion. Alternative: store `PublishResult`/deduped, reseal every failed handoff or invalidate by epoch number alone.
  - strict event decoder with prc mapping and named error. Alternative: parse opaque data without validating framing/procedure.
  - shared serial memory transaction with snapshot/rollback/commit hooks. Alternative: unrelated per-store maps or a premature MessageStore package.
  - stop/drain lifecycle before deletion. Alternative: check control settled while acceptance/delivery remain writers.
  - explicit root/transaction provider scope and named constructor error in phase 3. Alternative: accept caller transactions or guess root ownership.
  - provider ambiguity is a supported phase-3 model. Alternative: assert untested exclusivity of postgres ambiguous outcomes.
  Existing P2a tests are reuse/extensions. Real-store, MessageStore and child-process gaps remain
  explicitly assigned to phases 3, 5 and 6. No code implementation or test pass is claimed by r6.
- **Blind review r6**, 2026-10-09. Verified all four findings against today's source. Resolved in draft r7:
  - Completion barrier on a retained per-group owner row, including absent-row insert conflicts (r7 decision).
    Alternative: negative SELECT proves rollback, or postgres-only `pg_xact_status` without a portable barrier.
  - SQLite/Expo require completed COMMIT/ROLLBACK or a clean writer-lock barrier (r7 decision).
    Alternative: assume every in-process rejection is known rollback despite failed transaction cleanup.
  - Memory faults retain an unfinished backend transaction across rejection and negative read (r7 decision).
    Alternative: only inject commit-then-reject after publishing rows, hiding late commits.
  - Publications, acknowledgement and both proof paths bind authenticator/lineage and sealVersion (r7 decision).
    Alternative: invalidate prepared frames only and certify acknowledged publications by epoch number.
    Already-proven removal outcomes remain frozen.
  - Confirmed, source-checked recovery may lower current epoch; admissionFloor remains monotonic for tombstones (r7 decision).
    Alternative: unconditional epoch monotonicity, an unchecked recovery flag, or weakening Welcome tombstone admission.
    P2a recovery confirmation remains binding. The r10 spent-epoch amendment supersedes the live Welcome admission statement.
  - Owner-mediated clearJoinRef and registry-owned saveOpened/pending wiring resolve their own CAS/cache ambiguity (r7 decision).
    Alternative: host metadata saves behind the registry or an external pending writer without ownership/version context.
  - State/outbox adapters share the canonical root gate; deletion drains then acquires it once (r7 decision).
    Alternative: per-adapter mutexes or disposal alone authorises deletion with unresolved writers.
  - Explicit memory factories, generic hook/fault/reopen harnesses, retention options and buffered `epochs` constructor (r7 decision).
    Alternative: infer signatures from prose, pass bare retention, or retain the buffer's concrete registry dependency.
  Phase 2 models each contract/fault on doubles. Provider verification remains phase 3; no implementation/test pass is claimed.
- **Blind review r7**, 2026-10-09. Verified all seven findings against source. Resolved in draft r8:

  1. Full version-2 sourceState in the encrypted recovery candidate; candidate version/AAD 2; source-tree/rejoin regression (r8 decision).
     Evidence: `mls-rpc/src/recovery-codec.ts:36`, `mls-rpc/src/recovery-codec.ts:87`.
     Rejected alternative: envelope-length subtraction/private-state splice, or exposing new codec internals just for that splice.
     Phase 2, with G1. P2a candidate/requestKey, confirmation and source checks stay binding.
  2. Independent anchor/cursor saves share the gate/owner row and resolve internally before promise settlement (r8 decision).
     Evidence: `rpc/src/peer.ts:376`, `rpc/src/host-boundary.ts:149`, `../kubun/packages/plugin-p2p/src/groups/anchor-store.ts:35`.
     Rejected alternative: peer retry/drain alone, or rejection releasing a writer while its backend transaction remains pending.
     Phase 2 doubles and late-commit deletion/readmission cases; phase 3 provider implementation.
  3. Frozen proven removals settle before terminal clear; disposal retains a counted storage-only finaliser and drain waits it (r8 decision).
     Evidence: `rpc/src/log-delivery.ts:102`, `rpc/src/log-delivery.ts:280`, `rpc/src/peer.ts:3341`.
     Rejected alternative: clear/delete fails a proven row after cancelling retries, or adding a durable publication-proof journal.
     Phase 2 rpc/status doubles; phase 5 MessageStore hooks. P2a removal/control lifecycle stays binding.
  4. Outcome-aware hook queues survive uncertain rejection; a resolver-held token selects exactly one queue after the barrier (r8 decision).
     Evidence: `../hozon/packages/db/src/db.ts:275`, `../hozon/packages/db/src/db.ts:286`.
     Rejected alternative: treat every rejection as rollback, or report row-only success after losing the event hook.
     Phase 3 Hozon prerequisite/provider tests; phase 2 hook model and commit/rollback-count conformance.
  5. Registry access awaits load/restore/validation; no pre-load epoch/lineage/admission getters exist (r8 decision).
     Evidence: synchronous simple access starts with an available handle (`mls-rpc/src/access.ts:40`).
     Rejected alternative: mandatory preload, fabricated cold snapshots, or delayed validation at first seal.
     Phase 2 registry/callers; simple access stays synchronous.
  6. Explicit group-bound MLSEncryptor constructor, committed membership snapshots and numeric receive counts (r8 decision).
     Evidence: `../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:149`, `../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:243`.
     Rejected alternative: groupID-only watcher events or boolean batch counts. Ordinary rotation keeps a surviving peer tunnel open.
     Phase 2 extraction/runtime/tests; phase 4 client binds the same ports.
  7. Explicit shared control/anchor/cursor factories bind `{db, groupID}`; legacy no-argument control factory stays isolated (r8 decision).
     Evidence: `rpc-conformance/src/memory-control-store.ts:68`.
     Rejected alternative: reuse private legacy maps in shared fixtures, or infer Hozon constructor signatures from prose.
     Phase 2 shared doubles/harness; phase 3 Hozon factories. P2a ports stay unchanged.

  No unresolved findings. No implementation or test pass is claimed by this documentation revision.

- **Blind review r8**, 2026-10-09. Verified both findings against today's source. Resolved in draft r9:
  1. **Blocker:** every installed ordinary/last-resort Welcome co-writes a per-group spent digest with joined state (r9 decision).
     Admission refuses spent digests regardless of current epoch; recovery and D3 deletion retain them, including tombstones. This amends P2a D4.
     Evidence: `mls-hub/src/admission.ts:8`, `mls-hub/src/provisioner.ts:253`, `mls-hub/test/join.test.ts:320`, `node_modules/ts-mls/dist/src/clientState.js:603`.
     Rejected alternative: highest-epoch-ever live admission floor, which rejects legitimate Welcomes on the lower branch.
     Conformance/integration cover A3 → A4 → confirmed B2 → refused A3 replay and deleted-group replay, with ordinary and last-resort sources.
     Recovery candidate replay remains source/lineage-checked and atomically marked adopted (`rpc/src/control/rejoin.ts:39`, `rpc/src/control/rejoin.ts:168`).
     Specified replay/progress regression; no recovery confirmation exception is introduced.
  2. **Medium:** required host `AtRestCodec` in state/coordinated-outbox/control factories; host owns all at-rest key lifecycle (r9 decision).
     Kumiai never generates or stores at-rest keys. AAD binds group, namespace and record identity; memory doubles inject a deterministic test codec.
     Evidence: `../hozon/packages/db/src/db.ts:72`, `../hozon/packages/node-sqlite/src/index.ts:36`, `../hozon/packages/expo/src/index.ts:23`, `../hozon/packages/postgres/src/index.ts:73`.
     Rejected alternative: SQLCipher/provider encryption as the only mechanism; Expo and postgres differ.
     Raw-storage conformance excludes plaintext state, pending frames, outbox payloads and control secrets; wrong-AAD opening and ciphertext swaps reject.
     Phase 2 models encrypted rows on doubles; phase 3 implements/verifies every provider.

  No unresolved findings. No implementation or test pass is claimed by this documentation revision.

- **Blind review r9**, 2026-10-09. Source-checked findings and decided rulings applied in draft r10:
  1. **Blocker:** Welcome digests identify artifacts, not spent secrets. Retain every held epoch authenticator per group (r10 decision).
     Genesis, Welcome, own/received commit and recovery append atomically with installed state; recovery and lifetime tombstones retain the set.
     Welcome/candidate/seed admission refuses spent authenticators before epoch comparison, never merges; exact and alternate A3 representations both refuse.
     Growth is one authenticator per held epoch, accepted in the same growth class as receipts. Version-2 record metadata and mirrors carry the set.
     Evidence: `node_modules/ts-mls/dist/src/createCommit.js:143`, `node_modules/ts-mls/dist/src/groupInfo.js:12`, `node_modules/ts-mls/dist/src/clientState.js:603`.
     Rejected alternative: artifact digest; repackaging escapes it. Remove welcomeDigest derivation/plumbing and amend P2a D4.
  2. **High:** speculative private commits reuse source handshake generations on rebuild (r10 decision).
     Builders expose the consumed generation; access durably reserves its exclusive handshake HWM before returning ciphertext/HostBuilt.
     Every rebuild merges the reserved source HWM, including after restart. Poison-head mismatch conformance requires strictly increasing generations.
     Evidence: `mls/src/group-commit.ts:333`, `node_modules/ts-mls/dist/src/createCommit.js:77`, `node_modules/ts-mls/dist/src/secretTree.js:237`, `rpc/src/control/operations.ts:194`.
     Rejected alternative: public framing for member commits, which exposes commit contents to the relay.
  3. **Medium:** anchor secrets join the host at-rest codec contract (r10 decision).
     Both anchor factories require atRest; encrypted anchor namespace/AAD covers the full slot and adoption co-writes.
     Raw-byte, wrong-AAD and ciphertext-swap cases cover AnchorSlot.anchor.secret on doubles and real stores.
     Evidence: `rpc/src/anchor.ts:6`, `rpc/src/peer-epoch.ts:262`, `../kubun/packages/plugin-p2p/src/groups/anchor-store.ts:35`.
  4. **Medium:** negative conformance rejects ordinary kind 'state' lineage increases despite matching CAS and unchanged identity (r10 decision).
     All lineage decreases conflict too. Only authorised recovery/Welcome replacement increments; progress and coupled rows remain unchanged on refusal.
     Run on doubles and real stores. Evidence: same-epoch progress merging covers both chains (`mls/src/secret-tree.ts:17`, `mls/src/secret-tree.ts:35`).
  5. **Low:** publish complete openWelcome nested result and single-options judgeWelcomeAdmission signatures, with structural mirrors (r10 decision).
     The authenticator rides joined.group.state.keySchedule; seed derives it from that authenticated handle. No digest field remains.
     Evidence: `mls-hub/src/join.ts:26`, `mls/src/group-welcome.ts:45`, `mls-hub/src/admission.ts:2`.

  No unresolved findings. Implementation and executable conformance remain phase 2/3 work; this revision claims no implementation or test pass.

- **Blind review r10**, 2026-10-09. Read the findings first and verified cited code against source. Decided rulings applied in draft r11:
  1. **High:** unbounded unpublished handshake reservations exceed the real receiver's forward window (r11 decision).
     Require `reservedHandshakeGeneration - publishedHandshakeGeneration <= HANDSHAKE_BURN_BUDGET`, with budget 64 and epoch-start baseline 0.
     Only hub-confirmed own commits advance that baseline; new epochs reset it. The required receiver configuration is 1000 steps.
     Evidence: `rpc/src/control/operations.ts:194`, `node_modules/ts-mls/dist/src/secretTree.js:104`, `node_modules/ts-mls/dist/src/clientConfig.d.ts:7`.
     D3 requires that configuration; today's context still omits the override (`mls/src/group-context.ts:59`), using the default 200.
     Check before building/reserving. Exhaustion becomes terminal `HandshakeBudgetExhaustedError`, with durable identifiable rejected outcome and typed host failure.
     Existing P2a device readmission supplies a fresh leaf/handshake chain. No automatic rebuild; outcome acknowledgement/restart never resets the budget.
     Conformance burns 0–63 then decrypts commit 64, rejects build 65 without reserving, tests readmission/reset and enforces real/double forward-window parity.
     Rejected alternative: unbounded reservation; peers cannot follow.
  2. **Medium:** inspectors and hook-only transactions cannot express ciphertext corruption or atomic side-row visibility (r11 decision).
     Add exact `mutateStoredRecord`/`swapStoredRecords` signatures, physical keys, transaction-bound `writeSideRow` and committed `inspectSideRow`.
     Evidence: `../hozon/packages/db/src/db.ts:31`, `../hozon/packages/db/src/db.ts:208`, `rpc-conformance/src/control-store.ts:168`.
     Bind phase-2 memory records and phase-3 provider raw tables. State/pending/control/outbox/anchor suites test adapter rejection after corruption/swaps.
     Coordinated-outbox cases read both durable rows after commit, rollback and unfinished late-commit/rollback faults, retaining hook-count assertions.
     Rejected alternative: codec-only corruption checks or hook counts without a second transactional write.

  No unresolved findings. Implementation and executable conformance remain phase 2/3 work; this revision claims no implementation or test pass.

- **Blind review r11**, 2026-10-09. Read the findings first and verified cited code against source. Decided rulings applied in draft r12:
  1. **High:** lower recovery regresses epoch-based segments and read watermarks. Durable local anchor ordinals increase at every capture, including recovery (r12 decision).
     Tombstones retain the counter/map. Late frames retain their captured anchor ordinal. Peers exchange anchor/position and compare only within that anchor.
     Superseded-anchor receipts cover no replacement-anchor message. Frame formats stay unchanged; ordinals are local.
     Evidence: `rpc/src/peer.ts:440`, `rpc/src/app-lane.ts:731`, `rpc/src/crypto.ts:228`.
     Conformance accepts A4 `(3,10)`, recovers to B2, then orders B2 `(4,20)` later without marking it read.
  2. **High:** kill after terminal adoption loses a frozen publication result. Certification persists the minimal outbox-meta settlement obligation before terminal adoption (r12 decision).
     The shared gate orders terminal state/control adoption behind that write. Restart clearing reports published and co-deletes obligation/entry.
     Evidence: `rpc/src/log-delivery.ts:45`, `rpc/src/peer.ts:3111`. P2a's terminal restart text carries an amendment note.
     Conformance: certify, remove rolls back, terminal adoption commits, kill before retry, restart reports published rather than failed.
  3. **Medium:** buildControl lacked its durable handshake-baseline reader. The registry receives `loadControl(groupID): Promise<ControlSnapshot>` (r12 decision).
     It loads identity-matched accepted builds inside the read/check/build/reservation gate section. No matching accepted build gives baseline 0.
     Evidence: `rpc/src/control/types.ts:45`, `rpc/src/control/types.ts:63`. HWM 65 with accepted generation 64 permits direct build 65.
  4. **Medium:** conformance missed ordinary same-number identity replacement. State and open paths reject matching-CAS E4/authA → unspent E4/authB (r12 decision).
     Every coupled logical row remains unchanged. Only confirmed, source-checked recovery permits this transition.
     Evidence: `mls-rpc/src/mls.ts:218`, `mls-rpc/src/access.ts:87`.

  No unresolved or impossible rulings. Implementation and executable conformance remain phase 2/3 work; this revision claims no implementation or test pass.
