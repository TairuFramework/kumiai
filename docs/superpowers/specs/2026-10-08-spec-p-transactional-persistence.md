# Spec P: transactional persistence — design

Date: 2026-10-08
Status: draft r6
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
(phase 0)

Spec P fixes the contracts phase 2 implements on memory doubles. P2a crash-safe control has
landed on `feat/spec-p-phase-2` and is binding. This spec adds no second control journal.

## Scope and handoff

| Phase | Work |
|---|---|
| 2 | `rpc`, `mls`, `mls-rpc`, `rpc-conformance` and `hub-client` contracts and runtime additions. Version-2 state codec first. Registry over `GroupStateStore`, memory stores, D4 metadata, D6 attempts/outcomes, D7 decoding and shared transaction fixtures. Both contract suites against real crypto/MLS/HTTP and doubles. Real HTTP hub plus in-process two-device group-peer smoke. |
| 3 | `rpc-store`: Hozon stores, coordinated outbox, state/control/anchor co-commit, tombstones and hooks. Provider discriminator prerequisite in Hozon. sqlite/postgres/expo conformance, persistence and provider failure tests. |
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

### D2. Transactions and ambiguous outcomes

- Every multi-store write is one `db.withTransaction` on the **root** provider, and every store it
  writes is taken from that callback's `tx`. Each callback awaits every write it starts.
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
  SQLite/Expo are treated as in-process known outcomes, pending phase 3 provider verification.
  This is a required model, not an already-tested cross-provider guarantee (r6 decision).
  Each port names its owner:
  - `GroupStateStore` rejects with `StorageOutcomeUnknownError`; the registry resolves it (D3). This
    includes adoption saves carrying P2a's `AdoptionWrite`, whose `mutationID` is the `writeID`.
  - P2a's `ControlStore.apply` (no state change) is resolved by the peer through `lastMutation()`.
  - The coordinated outbox resolves it internally (D7), so `AppOutbox`'s "a rejection leaves storage
    unchanged" contract (`rpc/src/app-outbox.ts:26`) still holds.

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
  epoch: number                   // tombstone keeps the last live admission floor
  state: Uint8Array               // version-2 encodeClientState output; empty when deleted
  credential: { id: string; groupID: string } | null
  ledger: Array<string>           // signed tokens in enactment order, repeats kept
  senderHWM: number               // exclusive reservation ceiling for this epoch identity
  epochAuthenticator: Uint8Array  // empty when deleted
  lineage: number                 // starts at 0; never decreases, tombstones included
  joinRef: { sourceID: string; ref: string } | null
}
export type GroupStateCAS = { expected: { version: number } | null }
export type GroupStateWrite = GroupStateCAS & (
  | { kind: 'state'; adoption?: AdoptionWrite }
  | { kind: 'welcome' }
)
export type GroupStateStore = {
  load(groupID: string): Promise<GroupStateRecord | null> // includes tombstones
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

Phase 3 encrypts state bytes, P2a rejoin secrets and app plaintext at rest.
New errors use `(message?: string, options?: ErrorOptions)` inherited from `Error`.
Canonical errors already have explicit names (`rpc/src/errors.ts:16`, `rpc/src/errors.ts:24`).
Redeclaration breaks ambiguity recognition (`rpc/src/control/store.ts:105`).

**Store rules:**

- **CAS.** `expected: null` means absent, never tombstoned. Otherwise the stored version must match.
  `record.version` must exceed the prior version; lower epoch or lineage conflicts. A miss writes
  nothing and throws `GroupStateConflictError`. Map postgres serialization failures to that conflict.
- **Identity (r6 decision).** Epoch identity is `(groupID, epoch, epochAuthenticator)`; lineage identifies
  ownership, not the epoch secret. Same identity/same lineage retains max HWM and merged sender/receive
  progress. Only after both checks may `mergeReceiveSecretTree` run (`mls/src/secret-tree.ts:17`).
  Never merge by epoch number alone.
- A newer epoch resets HWM to the candidate's own sender generation. Recovery may keep the number
  while changing authenticator: reset HWM, bump lineage, discard old current-tree progress.
  Welcome replacement requires a strictly higher authenticated epoch. A replacement proposing the
  same identity is an idempotent no-op, not a new lineage with reusable keys. Recovery/Welcome bumps
  lineage by one; ordinary commits keep it. Tombstones retain epoch/lineage, with HWM zero, empty
  state/authenticator/ledger and null credential/joinRef.
- `save(kind: 'state')` co-commits any `AdoptionWrite`, its mutation marker and matching anchor landed
  mark. `record.writeID === adoption.mutationID`. Keep P2a's carry into retained historical epochs.
  Current-state same-identity merging supplements that carry; it does not replace it.
- **Welcome save (r6 decision).** `save(record, {expected, kind: 'welcome'})` is the atomic
  seed/readmission operation. With the old peer stopped/drained, apply
  `readmissionChanges(txControlSnapshot)` (`rpc/src/control/store.ts:67`) and clear the anchor slot
  in the state-save transaction. Set control's mutation marker to `record.writeID`.
  Operations/rejoin become `unknown`; applied/responses/cursor clear; outcomes/Welcomes survive.
  Initial join uses the same method with absent control. Tombstone admission keeps its epoch floor.
  This is not `AdoptionWrite.anchorLanded`, which only marks an advance (`rpc/src/control/types.ts:43`).
- `saveOpened` co-writes the CAS state and pending record. Duplicate `(groupID, pending.frame.id)`
  insertion is a no-op. List in `(segment, position)` order, using rpc's numeric-position comparison
  (`rpc/src/crypto.ts:226`). Every read/write owns defensive copies of bytes and nested values.
- **Ambiguity.** The resolving writer stays paused; other access throws `GroupStateUncertainError`.
  Block subsequent writes until `load` succeeds.
  Matching `writeID`: install the committed record and resolve. Expected version/absence: reject
  with the original error, known uncommitted. Anything else: conflict, invalidate and reload.
  Failed reads retry at 100 ms, doubling to a 15 s cap. Do not expose uncertain state.
- `delete` stores a tombstone, removes pending, applied/responses/cursor, anchor, app cursor/outbox
  and outbox meta rows, and awaits `onDelete` in one transaction. Retain the tombstone's write marker.
  Refuse operations, rejoin, unacked outcomes or Welcomes with canonical `GroupControlUnsettledError`
  (`rpc/src/control/store.ts:57`). Deletion does not abandon control work automatically.

**Construction and runtime surface (r6 decision):**

```ts
// Phase 3, rpc-store. Uses stores obtained from the root callback's tx.
export function createGroupStateStore(params: {
  db: HozonDB
  onDelete?: (tx: StoreProvider, groupID: string) => Promise<void>
}): GroupStateStore

// Phase 2, mls-rpc. The host supplies context/policy/resolvers through restore.
export function createGroupHandleRegistry(params: {
  store: GroupStateStore
  restore: (record: GroupStateRecord) => Promise<GroupHandle>
}): GroupHandleRegistry
export type GroupHandleRegistry = {
  access(groupID: string): HandleAccess
  seed(group: GroupHandle, params: {
    replace?: boolean
    joinRef: GroupStateRecord['joinRef']
  }): Promise<void>
  delete(groupID: string): Promise<void> // host must stop/drain its peer first
  onAdmissionChanged(listener: (groupID: string, value: SendAdmission) => void): () => void
  onEpochChanged(listener: (groupID: string) => void): () => void
  dispose(): Promise<void> // cancels timers, awaits writes and flushes dirty receives
}
// Add to HandleAccess; retain read/mutate/replace/open and AdoptionWriteFactory.
lineage(): number
seal<TValue>(fn: (handle: GroupHandle) => Promise<TValue>): Promise<TValue>
receive<TValue>(fn: (handle: GroupHandle) => Promise<{
  result: TValue; accepted: boolean
}>): Promise<TValue>
// Fourth replace argument defaults to 'adoption'. Recovery explicitly passes 'recovery'.
replace(next: GroupHandle, adoption?: AdoptionWriteFactory,
  prepare?: (current: GroupHandle) => Promise<boolean>, kind?: 'adoption' | 'recovery'): Promise<void>
```

- `restore` rejects mismatched groupID, epoch, credential or authenticator. The registry derives
  saved bytes/credential/ledger from the handle. Clones use the version-2 codec and retained options.
  Seed returns without writing for a held live epoch at/above the candidate. Live newer Welcome
  requires `replace: true`; absent/tombstoned joins use the welcome save. At/below a tombstone floor
  or unauthorised replacement throws `GroupStateConflictError`. Existing version/lineage are loaded
  under the gate, never supplied as guessed insert defaults.
- One per-group gate spans preparation, save and ambiguity resolution. Durable mutation/open,
  commit replacement, Welcome seed and deletion stage from the current cache; install after commit.
  Retry durable-open CAS at most eight times on fresh clones. Merge only matching identities/lineages.
- `wrap` moves from `access.mutate` to `access.seal`; each callback seals at most one application
  frame. Non-durable unwrap uses `receive`, counting only accepted opens. Receives install immediately
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
  immediately supplies loaded groups; epoch subscription fires on later epoch/availability changes.
  Contain listener errors. Host schedules work outside the registry gate.
- `list()` drives host restore. Tombstones never start peers. After live restore, the host consumes
  each source-scoped `joinRef`, then clears it through a CAS state save. Never clear before consume.
  Restore pending into the peer before P2a replay. Keep P2a's startup order and terminal-removal rule.

**Retention, lease and rotation:**

```ts
// Add to mls GroupOptions and createMlsContext's optional third parameter.
keyRetention?: Partial<KeyRetentionConfig>
// rpc SendAdmission; mls's leaf admission remains its existing lapsed check.
export type SendAdmission =
  | { epoch: number; admissible: true }
  | { epoch: number; admissible: false; reason: 'lapsed' | 'rotation-required' }
// rpc SendNotAdmissibleError constructor and reason getter use the same reason union.
const RESERVE = 16
const RENEW_BELOW = 4
const ROTATE_AT = 500
```

- Context overlays supplied retention on ts-mls defaults through `clientConfig.keyRetentionConfig`
  (`node_modules/ts-mls/dist/src/mlsContext.d.ts:9`, `node_modules/ts-mls/dist/src/clientConfig.d.ts:7`).
  Preserve other client defaults. Registry sealing requires generation retention and forward steps
  both at least 1000; reject weaker host configuration at access creation. Client/smoke fixtures set
  both to 1000. Ordinary mls callers keep defaults; historical epoch retention remains unchanged.
- Carry configuration through create, restore, Welcome, external join, clone and `deriveGroup`, and
  both fresh and deserialised recovery (`mls-rpc/src/recovery.ts:166`, `mls-rpc/src/mls.ts:471`).
- **Lease.** Read the own application chain's next generation `g` (unexpanded means 0).
  Burn to persisted HWM before any real seal. With fewer than four left, CAS reserve
  `min(500, max(g, senderHWM) + 16)` with state unchanged. At the capped final lease, one to three
  remaining generations may be used without another reservation. Seal only below 500.
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
  P2a's revoke hold remains independent and retains its existing retained-log scope.
- The bound is per epoch identity/lineage, not epoch number. No seal reaches generation 500; lease
  burns and failed/unpublished seals count. Different-authenticator same-number recovery starts fresh.
  Old-lineage app entries reseal (D6); this does not promise old ciphertext remains decryptable.

**Deletion lifecycle (r6 decision).** Later client, and phase 2 fixtures, block peer creation/seed
under the group's lifecycle gate. Call `peer.dispose()`, then `peer.drained()` before registry deletion.
Drain is already the owner-replacement contract (`rpc/src/peer-types.ts:364`). Wait for acceptance,
delivery, invoked handlers, network submissions and ambiguous outbox mutations to settle. Then take
registry/outbox mutation gates and perform the delete transaction. Never await drain inside a peer
callback. Unsettled control still refuses deletion; resume a peer to settle or explicitly abandon/ack
before retrying. On failure, keep the group stopped until restored. This prevents a late put from
recreating rows. No timeout authorises deletion with outstanding work.

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

### D5. Commits (landed P2a prerequisite; rotation addition)

P2a D2–D6 owns operations, exact control replay, adoption, Welcome obligations/admission, removal
and rejoin. Its `ControlStore`, `AdoptionWrite`, consume/receipt and revoke hold are prerequisites.
Do not reimplement journal replay, add operation IDs to envelopes, or revive lost-work reconciliation.

```ts
// New mls export. No mutation of group; no Welcome or ledger bodies.
export type CommitKeyRotationResult = {
  commitMessage: Uint8Array
  newGroup: GroupHandle
  epoch: bigint
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

The host converts this result to P2a `HostBuilt`: `commit = commitMessage`, `bodies = []`,
`welcome = null`, journal is the serialised candidate, and source identity uses D3 lineage.
Use operation `{id, kind: 'rotation', revokes: false, body: new Uint8Array()}`.
A now-unneeded rotation is `OperationRejectedError`, settled by P2a. Rotation leaves the app anchor
unchanged unless another roster/forced-recovery change occurs (`rpc/src/peer.ts:440`).

Incoming commits skip state persistence only for **`applied: false`**, never merely
`advanced: false`. Self-removal is applied and saved without epoch advancement
(`rpc/src/crypto.ts:160`, `mls-rpc/test/adoption-write.test.ts:75`).

### D6. Outgoing attempts and publication status

**App outboxes only:** restart reseals every unproven plaintext entry. Store no app ciphertext or
acknowledgement proof. P2a commit/rejoin records deliberately store and replay exact ciphertext
(`rpc/src/control/types.ts:75`, `rpc/src/control/types.ts:103`). Message identity absorbs an earlier
app attempt that also landed; the umbrella's first-durable-occurrence ordering stays unchanged.

```ts
// Reuse rpc's landed client result, not hub-protocol's store PublishResult (G2).
export type PublishOutcome = { sequenceID: string } // rpc/src/control/operations.ts:36
export type AppPublicationOutcome = { segment: number; position: string }
export type AppAttempt = {
  epoch: number                    // MLS seal/proof epoch
  floor: string | null
  attempts: number
  publishID: string
  segment: number                  // app anchor epoch/topic segment at seal
}
// AppOutboxEntry.lastAttempt: AppAttempt | null; other fields unchanged.
// AppOutbox.remove(seq: number, outcome?: AppPublicationOutcome): Promise<void>
export type LogFrame = { topicID: string; payload: Uint8Array; publishID: string }
export type SealedLogFrame = LogFrame & {
  floor: EpochFloor
  segment: number
  sealVersion: number              // local invalidation generation; never persisted
}
// LogDeliveryParams:
sealVersion: () => number
publish: (frame: LogFrame) => Promise<PublishOutcome> | null
remove: (seq: number, outcome?: AppPublicationOutcome) => Promise<void>
// Keep proof fields and add the accepted app occurrence:
type Publication = {
  epoch: number; floor: LogPosition | null; acknowledged: number
  publishID: string; segment: number; sequenceID: string
}
```

- Each successful seal gets a fresh random `publishID`; persist attempt metadata before transport
  handoff. Publish that ID to the frame's sealed topic. `segment` never substitutes for MLS epoch.
  Mux already returns sequenceID (`rpc/src/hub-mux.ts:777`). HTTP remains `{sequenceID}`; no fabricated
  `deduped` field (`hub-protocol/src/protocol.ts:49`, `hub-protocol/src/types.ts:77`).
- **Retry bytes (r6 decision).** Keep one prepared `{frame, updatedEntry}` in a memory map by seq
  until acknowledgement or invalidation. Failed put/publish or a null handoff retries those exact
  bytes/ID, not another seal/counter increment. The map never survives restart.
  After acknowledgement, store `Publication` and discard prepared bytes. Delivery keeps proof logic.
- **Invalidation (r6 decision).** Increment peer `sealVersion` on every installed MLS epoch
  identity/lineage change and anchor-topic change, including same-number recovery. Capture it with
  each seal; re-check before handoff.
  Invalidate stale prepared frames on a mismatch and reseal. An ordinary floor-position change
  alone does not invalidate identical bytes. Delivered-entry resends use the same rule with a
  worker-local retry slot, since their `seq: -1` cannot share the outbox map.
- Old-epoch acknowledged but unproven publications reseal. Restart discards all publication evidence
  and reseals with new IDs. No 365-day ambiguity horizon is needed for app attempt recovery.
- **Status.** `pending` until first atomic put; `accepted` when it commits; `published` only at proof.
  `remove(seq, {segment, position: sequenceID})` names the publication proof certified. Freeze that
  outcome when proven and retry the identical removal after failures, even if the epoch changes.
- D7 writes published status/position with removal. The sender records the proven occurrence;
  receivers keep their first durable occurrence. `clear` and deletion fail unpublished messages.
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

- `put/remove/clear` run one root transaction each. Read affected entries from tx, mutate outbox,
  await hook, then write fresh `mutationID` to group outbox meta. Resolve after commit/hooks.
  Cursor stays in `ControlStore`; adoption writes remain co-committed with state.
- Serialise each outbox from transaction entry through ambiguous read-back. Unknown remove skips
  its hook and succeeds; retry after reopen cannot write status twice. Replacement may change only
  `lastAttempt`; different protocol, prc or data throws `OutboxReplacementError`, changing nothing.
- On ambiguous COMMIT, read meta from a fresh root transaction. Equal mutationID resolves;
  otherwise reject as known uncommitted. Failed reads retry 100 ms, doubling to 15 s; keep the
  caller pending and later mutations paused. Acceptance retains its sequence reservation meanwhile.
- Messaging correlates by `(groupID, ownAuthor, payload.id)`, never seq. Sequences can restart after
  reopening an empty inventory (`rpc/src/app-outbox.ts:73`). `onPut` inserts accepted once;
  outcome-bearing `onRemove` writes published/position once; `onClear/onDelete` fail unpublished rows.
  Generic removal without an outcome removes the row without claiming publication.
- D3 deletion must share this adapter's mutation gate and drain before deleting its rows/meta.
  Peer disposal alone does not justify bypassing unresolved transactions.

**Shared memory transaction (r6 decision), test support in `rpc-conformance`:**

```ts
export type MemoryStoreRows = Record<string, Map<string, unknown>>
export type MemoryTransaction = {
  rows: MemoryStoreRows
  onCommit(fn: () => void): void
}
export type MemoryDatabase = {
  transact<TValue>(fn: (tx: MemoryTransaction) => Promise<TValue>): Promise<TValue>
  snapshot(): MemoryStoreRows
}
export function createMemoryTransaction(params: { rows: MemoryStoreRows }): MemoryDatabase
```

Clone all maps/values at transaction entry; expose only the clone during the callback. Atomically
publish it on success, then run commit hooks before resolving. Callback rejection discards the
clone/hooks; commit-hook exceptions are contained after publication.
Serialise root transactions; disallow reentrant transactions. `snapshot` returns a defensive copy
of committed rows, including while a callback is held. Test adapters share one `MemoryDatabase`
for state/control/anchor/pending/outbox/meta and opaque host side rows; do not construct separate
memory databases per adapter. Factories take `{db: MemoryDatabase, ...}` with the same group/hook
parameters as their Hozon counterparts, substituting `MemoryTransaction` for `StoreProvider`.
Use row namespaces `state`, `control`, `anchor`, `pending`, `appCursor`, `outbox` and `outboxMeta`.
State/control/anchor/meta keys are groupID; compound keys use JSON arrays `[groupID, id/topicID/seq]`.
Host side rows use a separate namespace. Future memory MessageStore uses that same database.
Commit-then-reject injection happens after publication; reopen wraps the same committed rows,
with every runtime cache discarded.

### D8. Provider guarantees (phase 3 gate)

These are required supported guarantees, not provider test results. D2's COMMIT ambiguity model
applies. Hozon does not configure transaction isolation (`../hozon/packages/db/src/db.ts:194`).

| Claim | node-sqlite | postgres | expo |
|---|---|---|---|
| Root transaction commits all stores or none; promise resolves after commit/hooks | required | required | required |
| CAS conditional plain UPDATE affected count | required | READ COMMITTED; stricter serialization failure maps to conflict | required; no RETURNING (`../hozon/packages/expo/src/driver.ts:104`) |
| Transaction execution | one-connection serialisation | concurrent when pool capacity permits (`../hozon/packages/postgres/src/index.ts:73`) | connection mutex (`../hozon/packages/expo/src/driver.ts:53`) |
| Root call inside transaction | must not await; connection is held | independent transaction when pool capacity permits; must not await either | must not await; connection is held |
| Supported ambiguous COMMIT model | known in-process outcome | transport loss can be ambiguous | known in-process outcome |

## Phase 2 implementation order and exit criteria

1. MLS version-2 codec and regression. Retention propagation and rotation builder.
2. D3 port, shared memory transaction/store, registry/access and lineage plumbing. Reuse P2a co-commit.
3. D4 pending/handler migration, including optional broadcast metadata and directed stamped headers.
4. D6 entry/publication/removal shapes, prepared-byte retries, proof outcome and memory-hub dedup parity.
5. D7 rpc decoder/error exports and coordinated memory contract fixtures; no production rpc-store adapter.
6. Hub-client lifts per the audit, keeping epoch inspection injected. Preserve subscription retention
   on first subscribe, reconnect and same-connection retry. The source drops options on replay
   (`../kubun/packages/plugin-p2p/src/hub/hub-like.ts:529`, `../kubun/packages/plugin-p2p/src/hub/hub-like.ts:608`).
7. In-process e2e smoke: standalone devices, real MLS ports/registry on shared memory host stores,
   real HTTP hub, explicit server DID, invite/join, retained send, opened epoch and proof outcome.
   Include non-admin rotation/resume and state/pending replay by rebuilding runtime over stored rows.
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
```

Keep malformed/unknown-epoch passthrough, notification wake/revisit and disposal unsubscribe.
Inspection is an unauthenticated prefilter (`mls/src/group-info.ts:17`). Bind registry notifications
in the host fixture in phase 2, later in client. Automatic `/info` integration remains BLOCKED in the
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
| Joined state saved, before key consume | `save(kind: 'welcome')` | after | P2a prerequisite; extend through new store 2/3/6 |
| Welcome readmission, between state/control/anchor writes | `save(kind: 'welcome')` | injected failure | neither state/reset/anchor changes; old runtime not installed; 2/3 |
| Welcome readmission committed, before peer restart | `save(kind: 'welcome')` | after | unknown outcomes preserved; reset anchor recaptured at join; 2/3/6 |
| Deletion committed, before restart | `delete` | after | tombstone/rows 2/3; failed messages 5; SIGKILL 6 |

Control/rejoin/Welcome-delivery seams remain owned by P2a. Its in-process Welcome crash reconstruction
is existing coverage (`tests/integration/test/welcome-after-crash.test.ts:179`), not child-process coverage.

## Conformance additions

Phase 2 fixtures provide reopen (same committed rows, new runtime), second-write failure,
commit-then-reject, clock control and opaque side-row inspection. Generation tests use real MLS.
Phase 3 supplies those fixtures on every provider, plus a separate-connection postgres visibility
barrier. Expo uses a node shim or records BLOCKED with its reason. Phase 6 supplies the kill harness.

| Suite / phase | Case | Assertion / existing coverage |
|---|---|---|
| codec/registry, 2 | lossless sender | zero, one, absent survive clone/save/reopen; malformed sidecar refused; version 1 throws; regression fails on current codec |
| `testGroupStateStoreConformance`, 2 memory / 3 providers | CAS/version | wrong expected, lower/equal version, lower epoch/lineage and tombstone-as-absent all conflict without changes |
| | ambiguous saves | commit-then-reject for insert/state/Welcome/delete exposes exact writeID; registry resolves committed/uncommitted before another writer |
| | adoption co-commit | reuse P2a case (`rpc-conformance/src/control-store.ts:321`), now against D3 stores/providers; state/control/anchor/marker all commit or roll back |
| | Welcome reset atomic/reopen | failure in reset or anchor clear rolls back state; success preserves outcomes/Welcomes, settles open work unknown, clears applied/responses/cursor/anchor; restart joins once |
| | identity/HWM | same identity/lineage preserves max HWM; different-authenticator same-number recovery resets and bumps lineage; no cross-identity tree merge |
| | atomic open and duplicate | second-write failure changes neither state nor pending; same-frame CAS retry leaves one row; extend existing key-unspent case (`rpc-conformance/src/pending-group-crypto.ts:137`) |
| | pending reopen | numeric `(segment, position)` order, epoch retained, unknown/double completion succeeds; extend existing case (`rpc-conformance/src/pending-group-crypto.ts:177`) |
| | delete | stopped/drained owner; atomic tombstone/row cleanup/hook; epoch/lineage floor survives; stale write fails; no late put recreates rows |
| | unsettled delete | operations, rejoin, outcomes and Welcomes each refuse; reuse predicate/host tests (`rpc/test/control-store.test.ts:253`) |
| `testAppOutboxConformance`, 2 / 3 | attempt/outcome | all attempt fields round-trip; outcome reaches remove; unknown removal remains harmless |
| `testCoordinatedOutboxConformance`, 2 memory / 3 Hozon | rollback/visibility | hook failure rolls back both rows; onCommit fires before resolution; postgres independent reader sees neither row before commit |
| | ambiguous mutations | put, same-data replacement, remove, clear commit-then-reject resolve iff committed; failed status read keeps caller/later writer paused |
| | overlap/removal/replacement | B waits through A's readback; repeated remove skips hook; changed protocol/prc/data rejects unchanged |
| | root-only constructor, 3 | transaction-scoped provider refused |
| `testAppCursorStoreConformance`, 2 / 3 | durable per topic | reopen saved position; other topics remain null |
| pending/group crypto, 2 | opened epoch | extend record and narrowed unwrap types together; stored epoch equals authenticated unwrap epoch |
| rpc handler tests, 2 | every D4 path | durable replay, retained drain, live log/ephemeral, anycast request and directed kinds expose original epoch; spoofed wire/header epoch cannot win |
| registry real-MLS tests, 2 | lease/restart | reserve, reconstruct, seal at or above HWM; no generation repeats; failed reservations prevent sealing |
| | blocked restore | lapsed, removed, suspended and pending-proposal restores keep control/receive usable; deferred burn completes before an eligible same-identity seal |
| | rotation | 500 admission trigger, rejected new acceptance, held accepted queue; non-admin rotation resumes; restarts/unpublished seals obey the bound |
| | overtaking/derivation | raw MLS context tests (outside the registry 500 guard) retain an earlier key after generation 600; derive invite/remove/rotation and fresh/restored recovery retain 1000/1000 |
| | same-identity adoption | intervening seal/open remains spent after replacement; extend P2a historical carry test (`mls/test/carry-receive-progress.test.ts:80`) |
| | tombstone Welcome floor | reuse comparison (`mls-hub/test/admission.test.ts:10`); add delete/save/rejoin integration |
| rpc delivery tests, 2 | retry bytes/restart | failed or null handoff retries byte-exact with same ID; reconstruction reseals/new ID; extend restart test (`rpc/test/peer-log-delivery.test.ts:554`) |
| | acknowledgement/proof | extend overtaken-epoch restart (`rpc/test/peer-log-delivery.test.ts:1093`); acknowledgement never removes; proof freezes correct segment/sequenceID through failed removal |
| `hub-conformance`, 2 | dedup scope/expiry | same ID on two topics appends on both; purge just before cutoff dedups, at cutoff appends; retry does not refresh timestamp; real hub-store and memory |
| hub-client, 2 | retention/buffer | reconnect and retry preserve retention; injected epoch notifications wake held frames; disposal unsubscribes |
| client/messaging, 4/5 | lifecycle/status | rotation scheduling, Welcome consume sweep, deletion fails accepted messages; published status/position co-commit with removal |
| e2e, 2 then 6 | smoke/kill | real HTTP with injected DID in 2; every crash seam on child devices in 6 |

## Umbrella amendments

Applied in this revision, not deferred to another reconciliation step:

- Package layout: phase 2 codec/retention/rotation/registry and rpc metadata/outcome ports; P2a
  `ControlStore`/`AdoptionWrite`; landed Welcome open/consume. Hozon adapters stay phase 3.
- Flows: durable operations/outcomes/rejoins and Welcome obligations; state save precedes consume;
  explicit atomic readmission reset, inventory and deletion drain.
- Semantics: app-only restart resealing, memory-only exact-byte retry, client `{sequenceID}` result,
  proof-time status/removal outcome, optional `remove` parameter. No persisted app ciphertext/ack.
- Scenario 8: split acknowledgement and proof; lease/Welcome/readmission/deletion seams; P2a control seams.
- Phases: scope above. Opened-epoch exposure belongs to phase 2; messaging consumes it in phase 5.
- Lift table: copy the audit's 5 MOVE, 6 EXTRACT, 8 REIMPLEMENT, 1 BLOCKED verdicts. G1 is specified
  here but remains an implementation prerequisite; automatic `/info` integration stays BLOCKED.

## Review log

Entries r1–r3 are historical review findings, not current API instructions. Their intent/journal,
`onJoined` before release, operation-envelope IDs and lost-work reconciliation solutions were
superseded by P2a. Read current Decisions and binding P2a instead.

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
