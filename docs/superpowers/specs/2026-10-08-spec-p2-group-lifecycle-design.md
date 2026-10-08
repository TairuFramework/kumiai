# Spec P2b: epoch views and the group lifecycle package — design

Date: 2026-10-08
Status: draft r3, parked. Re-scoped after [Spec P2a](2026-10-08-spec-p2a-crash-safe-control-design.md)
lands: its D3 to D7 (control store, operations, Welcome, forks, rejoin) moved to P2a, and are kept
below only as context for how views interact with them.
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)

P2 separates group lifecycle from the app lane, and makes the lifecycle crash-safe. "Lifecycle" here
means commits, recovery, forks and Welcomes. Today both concerns share one closure in
`packages/rpc/src/peer.ts`, so they also share one lock and one set of mutable state. P2 has two parts:

- **Root-cause fix.** Lifecycle publishes one **epoch view** per adopted epoch: fixed metadata, plus
  `seal` and `open` calls that run through the single owner of the group's MLS state. The app lane
  consumes views and never touches the live handle.
- **Crash safety.** Lifecycle records every operation, every rejoin, every outcome, every Welcome owed
  and every applied commit in a transactional `ControlStore`, and replays from it per stage.

Lifecycle moves to a new package, `@kumiai/group-lifecycle`. P2 is the baseline that Spec P,
`client` and `messaging` build on.

## Context

Checked against source on 2026-10-08 (branch `design/client-messaging-e2e`, 84a8f8b). Paths are
relative to `packages/` unless rooted elsewhere.

### Why the two concerns are coupled today

`peer.ts` is about 2,900 lines: about 2,050 are lifecycle, 230 app lane, and 750 mixed or orchestration.
They cross at 25 to 29 points.

Two dependencies are inherent to MLS:

- App frames are sealed under one epoch's secrets.
- App topics derive from the anchor secret, which lifecycle rotates on roster change
  (`rpc/src/peer.ts:387-400, 442`).

Both are one-way data flows. The rest is accidental:

- **Deliver before ratchet.** `advanceHandle` drains the app lane under the commit mutex before it
  adopts (`rpc/src/peer.ts:1161, 1611`), because the app lane opens frames against the live handle.
  "A frame classified at one epoch and unwrapped at the next would be wrongly called dead"
  (`rpc/src/app-lane.ts:631-635`). Yet ts-mls keeps the full secret tree of the last
  `retainKeysForEpochs` epochs (default 4, `ts-mls/dist/src/keyRetentionConfig.js:4`;
  `clientState.js:706-724`), and `mls` already opens past-epoch frames through it
  (`mls/src/group-handle.ts:970, 1021, 1488`).
- **Send gating by lifecycle internals.**
  - `logDelivery.held()` folds 8 lifecycle conditions (`rpc/src/peer.ts:586-594`).
  - `publish` checks holds synchronously (`:636-655`).
  - `settleLogSubmissions` runs between commit framing and the journal put (`:2167-2169`).
  - `holdLogSends` is how a revoke holds sends (`mls-rpc/src/revoke.ts:36-59`).
- **One closure, one lock.**
  - `rebuildEpoch` is called from 12 lifecycle sites under the mutex (`rpc/src/peer.ts:2929-2932`).
  - `dropAppFrame` and `resync` run app work under the non-reentrant `runSerial`
    (`rpc/src/peer.ts:881-882`).
  - App notices go through the lifecycle's `hostOutbox` (`rpc/src/peer.ts:330-368`).
  - `logDelivery.probe` writes `commitLogHead` without the lock (`rpc/src/peer.ts:604`), and
    `commit` reads it as its compare-and-set anchor (`rpc/src/peer.ts:2160`).
- **Port mixing.** `AppOutbox` carries the commit cursor (`rpc/src/app-outbox.ts:33-35`).

### Lifecycle durability today

- **Commit path.** `CommitJournal` is one slot (`rpc/src/commit.ts:63-114`). `commit()` writes in this
  order:
  1. `put` (`rpc/src/peer.ts:2169`);
  2. publish under compare-and-set with a `publishID` (`:2187`);
  3. `markAccepted` (`:2216`);
  4. `advanceHandle`: anchor pending record, host `onAccepted`, commit cursor, anchor resolution
     (`:1148-1217`);
  5. `clear` (`:2247`).

  Nothing is recorded before `put`.
- **Replay** (`rpc/src/peer.ts:1806-1921`) branches as follows:
  - `acceptedAs` set: adopts through `adoptJournalled`.
  - Unset at the framed epoch: republishes under the original `publishID`. The hub claims the ID
    before its head check (`hub-store/src/store.ts:186-215`).
  - Unset at another epoch: throws `JournalEpochError` and keeps the slot (`:1851-1857`).
  - Head mismatch: clears the slot **before** recording the loss, which it keeps only in memory
    (`:1883-1889`).
- **Recovery** (`rpc/src/peer.ts:2341-2677`, `rpc/src/recovery-confirmation.ts`) publishes an external
  commit with a fresh `publishID`, then waits for one authoritative member confirmation
  (`recovery-confirmation.ts:163`), then adopts and bootstraps the ledger.
  - **Durable:** only the hub frame, the anchor record, the adopted handle, the cursor, the journal
    clear and `bootstrapLedger`.
  - **Memory only:** the request key (a 120 s map, `mls-rpc/src/mls.ts:135-173`), `pendingRecovery`,
    the adoption retry, the ledger snapshot, `pendingReenact` and responders' `commitOutcomes`.
- **Forks.** rpc assumes a hub may break compare-and-set and serve divergent logs
  (`rpc/test/peer-recover-lane.test.ts:227-234`). Fork detection uses `appliedByEpoch`, which lives in
  memory (`rpc/src/peer.ts:748`, `rpc/src/classify.ts:194-202`). A losing-branch invite or remove
  produces no notice.
- **Welcome.** The docs promise at-least-once delivery (`rpc/src/commit.ts:44-58`). Both in-repo hosts
  send it only from `onAccepted` (`tests/integration/test/app-lane-e2e.ts:366-388`,
  `rpc/test/fixtures/peer.ts:280-296`). The invitee's helper releases the key package before the host
  saves the group (`mls-hub/src/join.ts:77-80`).
- **Crash windows.** Ten cases lose, duplicate or strand an operation, or lose a Welcome, each with a
  scenario in the probe. Codex r3 and r4 on Spec P add four blockers in the same area. All are
  addressed below.

### Consumers

- **Kubun** composes one `GroupPeer`. `kubun/packages/store-p2p` implements `AppOutbox` (with the
  commit cursor) and `CommitJournal`.
- **`mls-rpc`** implements rpc's crypto and MLS ports.
- **`rpc-conformance`** re-declares the ports structurally and does not import rpc.
- **Tests.** 62 of 107 rpc test files build the full peer through `rpc/test/fixtures/peer.ts`.
- **Version band.** The packages are at 0.10 (`rpc/package.json`, `mls/package.json`).

## Decisions

### D1. Packages and dependency direction

```
@kumiai/hub-client ─┐
@kumiai/mls ────────┼─> @kumiai/group-lifecycle ──> @kumiai/rpc (app lane)
                    │            ▲                        ▲
                    └── @kumiai/mls-rpc (implements both ports)
```

- **`@kumiai/group-lifecycle`** (new) owns:
  - the commit-log reader and classifier (`classify.ts`, commit framing, handshake);
  - the operation queue;
  - recovery and confirmation;
  - the anchor store and rotation;
  - ledger bootstrap;
  - fork records;
  - Welcome obligations;
  - the `ControlStore` port.
- **`@kumiai/rpc`** keeps the app lane: procedures, handlers, `AppOutbox` (without the commit cursor),
  log delivery, app cursors and durable opens. It depends on lifecycle; lifecycle never imports rpc.
- **`HubMux`, `cursor`** and the shared errors move to lifecycle, or to `hub-client` where they are
  hub-generic. Phase 1 decides each file. **`host-boundary`** splits: it imports rpc peer types and
  classifies app handlers and stores (`rpc/src/host-boundary.ts:3-8, 92`), so only its
  lifecycle-generic part moves, and the app part stays in rpc.
- **`createGroupPeer`** stays in rpc as a thin assembler. It returns today's `GroupPeer` surface where
  the meaning is unchanged, so Kubun migrates once.
- **`mls-rpc`** implements lifecycle's `GroupControlMLS` port and rpc's narrower `EpochCrypto`.

### D2. Epoch views

```ts
export type CloseReason = 'superseded' | 'stranded' | 'removed' | 'recovering' | 'disposed'
export type HoldReason = 'revoking'

export type EpochView = {
  epoch: number
  anchor: Anchor
  topics: AppTopics
  floor: EpochFloor
  /** Admission snapshot; `admissible: false` carries the reason. */
  admission: SendAdmission
  /** Rejects with `EpochClosedError` once `sendsClosed` has resolved, `SendHeldError` while held. */
  seal(entry: AppEntry): Promise<SealedAppFrame>
  /**
   * `ref` requests a durable open (Spec P D3, `saveOpened`). Valid until the epoch's receive keys
   * are evicted, then rejects with `EpochExpiredError`.
   */
  open(frame: AppFrame, ref?: AppFrameRef): Promise<OpenedAppFrame>
  sendsClosed: Promise<CloseReason>
  /** Lifts this view's retention lease. Idempotent. */
  release(): void
}

export type GroupLifecycle = {
  start(): Promise<void>
  /**
   * One view per adopted epoch, in order. After `start` it first yields every unreleased view
   * record (D3), oldest first, with sends closed, then the current one.
   */
  views(): AsyncIterable<EpochView>
  /** Group-wide send hold, independent of any view's closure. */
  hold(): HoldReason | null
  enqueue(op: OperationRequest): Promise<void>
  outcomes(): Promise<Array<Outcome>>
  ack(outcomeID: string): Promise<void>
  recover(): Promise<void>
  /** Snapshot of the last complete commit-log head; written only by lifecycle. */
  commitHead(): LogPosition | null
  events: EventEmitter<LifecycleEvents>
  dispose(): Promise<void>
}
```

**One state owner.** A view is metadata plus calls routed to one owner of the group's MLS state,
held by lifecycle. The owner serialises every open, seal and adoption on the handle mutex
(`mls/src/group-handle.ts:82, 960`). Views never hold a handle of their own: the mutex is keyed by
handle identity, so a cloned handle would not serialise with the live one. An open at a past epoch
changes that epoch's retained secret tree inside the current state
(`ts-mls/dist/src/processMessages.js:38`), and `decryptStaged` persists the whole state
(`mls/src/group-handle.ts:1000-1046`). Every adoption therefore preserves receive progress (D4).

Rules:

- **Opening.** The app lane routes each frame by the epoch in its cleartext header:
  - a frame at a retained epoch opens through that epoch's view, leased or released;
  - a frame for a newer epoch is buffered until that view arrives;
  - a frame at an evicted epoch is reported as `expired` (an app-lane event carrying its position),
    never silently dropped.

  Opening never consults the live handle, and takes no peer lock.
- **Retention.**
  - `client` and the lifecycle set `retainKeysForEpochs: 8` on the `MlsContext`. Phase 2 makes key
    retention configurable through every constructor, `deriveGroup` included
    (`mls/src/group-handle.ts:1652-1655`).
  - ts-mls holds `E` in its historical map up to and including epoch `E + 8`, and prunes it at
    `E + 9` (`clientState.js:714-726`). Lifecycle does not adopt epoch `E + 9` while the view for `E`
    holds its lease. Adoption awaits the release: backpressure by promise, with no shared lock.
- **Fences and release.** When a view is superseded, the app lane fences each of its app topics:
  1. it fetches the topic and captures the returned head `H` as the fence (`hub-protocol`
     `fetchTopic` returns messages, head and gap from one snapshot, `hub-protocol/src/types.ts:115`);
  2. it keeps the topic reader and drains through `H`. The fence is frozen: later heads are not
     chased, so a busy topic cannot starve release;
  3. a gap below `H` (the hub trimmed it) is reported as explicit loss, not as a drained fence.
     A failed, stalled or inconsistent pull keeps the fence and the lease, and retries with backoff
     without limit. It never becomes declared loss: an outage stalls adoption at `E + 9`, where today
     it stalls at `E + 1` (`rpc/src/app-lane.ts:864-865`).

  The app lane releases the view once every fence is drained, and every frame at or below a fence is
  either durably opened (`saveOpened`) or dead. Handler completion is not required: an opened
  pending record keeps retrying its handler with backoff (`rpc/src/app-lane.ts:574-590`), with no
  timeout, after its lease is gone.
- **Delivery guarantee.** A fence proves only that the frames published before it were seen. A
  frame at `E` that a slow publisher or a hostile hub delivers after the fence still opens while `E`
  is retained, and is reported `expired` after. Retention bounds the guarantee; nothing stronger is
  claimed. Strict closure would need per-sender final-epoch watermarks, which P2 does not add.
- **Sending.**
  - The outbox seals against the newest view only.
  - When `sendsClosed` resolves, unproven entries wait for the next view and are re-sealed. That is
    rpc's existing re-seal-until-proof path (`rpc/src/log-delivery.ts:145-207`).
  - Outside a hold, nothing orders app publishes against commits: a frame sealed at `E` and
    published after the commit to `E + 1` still opens at receivers, who retain `E`.
- **Closing sends** is irrevocable for a view:
  - `superseded`: the next epoch was adopted.
  - `stranded`: the commit log shows this device is off the line.
  - `removed`: this device is no longer a member.
  - `recovering`: a rejoin record exists.
  - `disposed`.
- **Send hold (`revoking`).** A hold is group-wide and lifts. It is not a view closure.
  - It is set while **any** stored operation with `revokes: true` (D4) is unsettled, and covers
    whatever view is newest. Settling one revoke never lifts another's hold. When the last one settles: on `landed` the successor view
    arrives; on `rejected`, `lost` or `unknown` the hold lifts and sends resume on the current view.
    At `start` it is recomputed from the stored operations. In phase 3, before `ControlStore` exists,
    the shim keeps today's synchronous in-memory hold and the journal's restart hold
    (`rpc/src/peer.ts:238, 2083`).
  - **Publication policy.** While a hold is set, the outbox seals nothing, and hands no frame sealed
    at the held epoch to the hub. Such frames are re-sealed at the successor epoch, or published as
    sealed if the hold lifts without one. This keeps today's check before `publish`
    (`rpc/src/log-delivery.ts:148`). A publish already in flight when the hold is set may still
    land, readable by the member being removed: a narrow window, as today.
  - This replaces `holdLogSends` and `settleLogSubmissions` (removed in phase 5, shimmed before).
- **Lineage replacement.** A rejoin or replacement that changes `lineage` invalidates every view of
  the old lineage: their sends close (`recovering`), their leases lift, and their records are deleted
  in the rejoin's final `apply` (D7). An external commit starts with no historical receive data
  (`ts-mls/dist/src/createCommit.js:297`), and a same-number rejoin reuses an epoch number with other
  secrets, so frames still in flight on the old lineage cannot open. The app lane reports them in one
  `lineageReplaced` event, carrying the old lineage and the fenced ranges left undrained.
- **Topics.** A view whose anchor differs from the previous view's carries new `topics`. The app lane
  re-subscribes on receipt. This replaces `captureAnchor`'s direct `appLane.reset()`.
- **No shared lock.**
  - Lifecycle serialises its own work. The state owner serialises MLS access.
  - The app lane serialises its own work and never calls into lifecycle while holding its lock.
  - `rebuildEpoch`, `runExclusive`, and app notices through lifecycle all go away.
  - Log delivery reads `commitHead()` for its proof probe.

### D3. `ControlStore`

Replaces `CommitJournal` and the `AppOutbox` commit cursor. It lives in lifecycle and stores bytes and
plain values only.

```ts
export type ControlSnapshot = {
  operations: Array<Operation>          // FIFO by `seq`
  rejoin: RejoinRecord | null
  outcomes: Array<Outcome>
  welcomes: Array<WelcomeObligation>
  applied: Array<AppliedCommit>         // newest 64 epochs
  responses: Array<ExternalResponse>    // responder outcomes, newest 64 epochs
  views: Array<ViewRecord>              // unreleased views, oldest first
  receiptAck: string | null             // `adoptionID` of the last reconciled receipt (D6)
  cursor: CommitCursor | null           // {position, epoch, stranded?}
}
export type ViewRecord = { epoch: number; lineage: number; topics: AppTopics }
export type ControlChanges = {
  putOperations?: Array<Operation>; deleteOperations?: Array<string>
  putRejoin?: RejoinRecord; deleteRejoin?: true
  putOutcomes?: Array<Outcome>; deleteOutcomes?: Array<string>
  putWelcomes?: Array<WelcomeObligation>; deleteWelcomes?: Array<string>
  putApplied?: Array<AppliedCommit>
  putResponses?: Array<ExternalResponse>
  putViews?: Array<ViewRecord>; deleteViews?: Array<{ epoch: number; lineage: number }>
  receiptAck?: string
  cursor?: CommitCursor | null
}
export type ControlStore = {
  load(): Promise<ControlSnapshot>
  /** All or nothing. On an ambiguous commit, rejects with `StorageOutcomeUnknownError`. */
  apply(changes: ControlChanges, mutationID: string): Promise<void>
  /** The `mutationID` of the last committed `apply`. */
  lastMutation(): Promise<string | null>
}
```

- **Writers.** Lifecycle is the only writer and serialises every `apply`. On
  `StorageOutcomeUnknownError` it reads `lastMutation()`, with backoff capped at 15 s: equal means
  committed, anything else means not. Lifecycle stays paused until that read succeeds.
- **`applied` and `responses` windows.** Lifecycle keeps the newest 64 epochs of each and prunes
  older rows in the same `apply`.
- **View records.** The `apply` that records an adoption (D6) also writes the new epoch's
  `ViewRecord`, so a view's topics are durable before any later adoption can replace its anchor.
  `release()` deletes the record in one `apply`. At `start` lifecycle restores every record as a
  leased, sends-closed view: the app lane fences its topics again from its durable topic cursors,
  and the lease rule (D2) holds across restart. The single-slot anchor store cannot re-derive old
  topics (`rpc/src/anchor.ts:11`, `rpc/src/peer.ts:393`), so this record is the only source.
- **Secrets.** `RejoinRecord.requestKey` and the candidate blob are secrets: the Hozon implementation
  encrypts them at rest (Spec P).
- **Isolation.** Spec P's provider and transaction rules (its D2 and D8) apply unchanged.

### D4. Operations

```ts
export type OperationRequest = {
  /** Random 128-bit; the host's handle for outcomes. */
  id: string
  kind: 'invite' | 'remove' | 'ledger' | 'rotation'
  /** Sets the `revoking` send hold (D2) from enqueue until the operation settles. */
  revokes: boolean
  /** Host-opaque; everything `build` needs, such as targets, role and signed tokens. */
  body: Uint8Array
}
export type Operation = OperationRequest & { seq: number; enqueuedAt: number } & (
  | { stage: 'intent' }
  | { stage: 'built'; built: BuiltCommit }
  | { stage: 'accepted'; built: BuiltCommit; acceptedAs: LogPosition }
)
export type BuiltCommit = {
  publishID: string
  expectedHead: LogPosition | null
  /** Identity of the state the commit was built from. */
  epoch: number
  authenticatorBefore: Uint8Array
  lineage: number
  /** The exact framed hub payload, with bodies sealed once. Replay publishes these bytes. */
  payload: Uint8Array
  /** SHA-256 of `payload`: acceptance discovery matches this. */
  payloadDigest: string
  /** Digest of the MLS commit alone (`digestAppliedCommit`): fork classification only. */
  digest: string
  bodies: Array<string>
  /** Host blob: the post-commit candidate state and anything needed to adopt it. */
  journal: Uint8Array
  /** The complete host-encoded invitation artifact (D5), or null. */
  welcome: { bytes: Uint8Array; recipients: Array<string> } | null
}
```

The host supplies `build(op, view)` and `adopt(journal, expected, receipt)`.

- **`build(op, view)`** returns `{commit, bodies, journal, welcome}` and must not mutate. Its view
  argument is the newest one; the host builds against that epoch.
- **`adopt(journal, expected, receipt)`** runs through the state owner (D2) and must be idempotent:
  - **no-op** when the current state's epoch and `epochAuthenticator` already equal the
    candidate's;
  - **installs** only when the current state matches `expected = {epoch, authenticatorBefore,
    lineage}`, with a compare-and-set on the stored state version;
  - otherwise reports **`moved`** and writes nothing.

  Installing **preserves ratchet progress**. Between `build` and `adopt`, opens at `E` and at
  earlier retained epochs advance those epochs' secret trees, and seals at `E` advance the current
  tree too (`ts-mls/dist/src/createMessage.js:100-101`; only a revoke holds seals). The candidate
  holds the trees snapshotted at build (`ts-mls/dist/src/createCommit.js:84`). After the identity
  check and before saving, the owner copies the current state's whole `secretTree`, sender and
  receive progress alike, into the candidate's history at `E`, and the current historical tree of
  every earlier epoch the candidate also retains. It keeps the candidate's `E + 1` state, and
  resurrects no epoch the current state has evicted. With one owner, the current trees are strictly
  newer, so a copy is enough; skipping it would reuse sender generations. `mls` provides this as
  `carryReceiveProgress(candidate, current)`. Rebuilding the commit at adoption is not an option:
  update paths use fresh randomness (`ts-mls/dist/src/updatePath.js:26`), so the bytes would differ
  from the accepted ones.

  The save writes the **adoption receipt** (D6) into the group state record in the same
  transaction.

Each operation moves through its stages as follows. Every arrow is one `apply` unless noted.

1. **`enqueue`.** `putOperations([intent])`. The call resolves after the commit. An operation with
   `revokes: true` sets the send hold.
2. **Head of the queue.** Lifecycle pulls the commit log to its head (D6), calls `build` against the
   newest view, frames the payload, and writes `built`. A refused `build` writes a `rejected`
   outcome and deletes the operation in one `apply`.
3. **Publish** `payload` under `publishID` and `expectedHead`:
   - accepted, deduplicated or not: write `accepted` and `putWelcomes` in the same `apply`;
   - head mismatch: with the honest store the hub claims the ID before its head check
     (`hub-store/src/store.ts:186-215`), so the commit did not land on the branch served. Return to
     `intent`, then pull, rebuild and retry until the operation deadline. Past the deadline, write a
     `lost` outcome and delete the operation;
   - any other error: keep `built` and retry with backoff.
4. **`accepted`.** Call `adopt`.
   - **Installed or no-op:** in one `apply`, delete the operation, `putOutcomes([landed])`,
     `putApplied({epoch, digest, sequenceID, opID})`, and set the cursor to `acceptedAs`. A view for
     the new epoch follows.
   - **`moved`:** acceptance is evidence that the hub served the commit, not that this device's
     branch contains it. The `applied` rows and the cursor are left alone. Lifecycle pulls the log
     and compares the `applied` row at `built.epoch` (rows are keyed by the commit's framed epoch,
     as the classifier keys them today, `rpc/src/peer.ts:1560`):
     - same `digest`: the commit was already adopted from the log. Write `landed` and delete the
       operation;
     - a different digest, or a log that does not show the commit on this device's branch: fork
       evidence. The operation stays `accepted`, the device strands (D6), and the rejoin's final
       `apply` (D7) resolves it against the winning branch (D6): `landed`, `reverted` or
       `unknown`.

**Replay at `start`** works per stage, after the D6 receipt reconciliation:

- `intent`: as step 2.
- `built`: republish the stored `payload` under the same ID, whatever the current epoch. This
  removes `JournalEpochError`.
  - Accepted or deduplicated: as step 3.
  - Head mismatch: the hub may have forgotten the ID, so lifecycle searches the commit log from
    `expectedHead` for a frame whose payload hashes to `payloadDigest`. Matching the whole payload,
    not the commit digest, stops a hub from re-wrapping our genuine commit with corrupted bodies
    (the commit digest excludes bodies and "is not a security boundary", `rpc/src/classify.ts:173`):
    - found: treated as accepted at that position;
    - absent, with the log complete from `expectedHead`: `lost`;
    - absent, with a retention gap: `unknown`.
- `accepted`: as step 4.

**Outcomes:**

```ts
export type Outcome = { id: string; opID: string | null; at: number } & (
  | { kind: 'landed'; position: LogPosition }
  | { kind: 'lost' }                       // absent from the branch this device follows
  | { kind: 'unknown' }                    // absence not provable
  | { kind: 'reverted'; position: LogPosition }   // accepted on a losing fork branch
  | { kind: 'reenact'; tokens: Array<string> }    // ledger tokens missing after a rejoin
  | { kind: 'rejected'; reason: string }          // build refused, e.g. not authorised
  | { kind: 'refused'; reason: RecoveryRefusal }  // a rejoin refused by policy (D7)
)
```

- They persist until `ack`. Lifecycle never re-enacts anything; the host enqueues a new operation.
  Lifecycle emits `outcome` when it writes one.
- **`lost` is relative to the branch this device follows.** Against an honest hub it means the
  commit is absent. A hostile hub can accept a commit, serve another branch and forget its dedup
  record, so `lost` does not prove global absence. If another member applied the commit, that shows
  up later as fork evidence on this device. So a host may re-enact a `lost` operation, and its
  `build` must refuse a target that is already in the wanted state (already a member, already
  removed) as `rejected`.

### D5. Welcome obligations

**Inviter side:**

- A `WelcomeObligation` is `{opID, welcome, recipients}`. It is written with `accepted` (D4 step 3).
- `welcome` is the **complete host-encoded invitation artifact**: the MLS Welcome plus the invite and,
  when needed, the ratchet tree (`mls/src/group-welcome.ts:50-55`). Raw Welcome bytes are not
  enough: once the operation and its journal are deleted, nothing else can rebuild the artifact.
  Kubun already persists the encoded invitation for this reason
  (`kubun/packages/plugin-p2p/src/groups/manager.ts:894-899`).
- After each such `apply`, and at every `start`, lifecycle calls the host's
  `deliverWelcome(obligation)`. It resolves once the delivery transport has durably accepted the
  artifact; lifecycle then deletes the obligation. Delivery is at least once.
- Delivery does not depend on adoption, and survives a rejoin (D7).
- The host checks frame size inside `build`, as today (`rpc/src/commit.ts:23-29`).

**Invitee side (`mls-hub`):**

- `processWelcomeFromSources` splits into `openWelcome(sources, welcome)`, which decrypts without
  releasing and returns the verified `groupID`, and `consume(ref, groupID)`. The host calls
  `consume` only after it has saved the joined group, with `joinRef` set (Spec P).
- **`consume` is one source transaction:** it deletes the private package and writes the receipt
  `{ref, groupID}`, scoped to the owning source. On an ambiguous outcome it reads the receipt back.
  A crash leaves either the package or the receipt, never neither. Today's ports cannot express this
  (`KeyPackagePoolStore` has only `list`, `put` and `delete`, `mls-hub/src/pool-store.ts:53-57`;
  `BundleSource` only bundles and release, `mls-hub/src/join.ts:18-21`), so they gain:

  ```ts
  // KeyPackagePoolStore
  consume(ref: string, groupID: string): Promise<void>   // delete + receipt, one transaction
  receipt(ref: string): Promise<{ groupID: string } | null>
  // BundleSource
  readonly sourceID: string
  consume(ref: string, groupID: string): Promise<void>
  receipt(ref: string): Promise<{ groupID: string } | null>
  ```

  `joinRef` is stored as `{sourceID, ref}`, so startup finds the owning source.
- `openWelcome` reads the Welcome's refs without decrypting (`mls/src/welcome-refs.ts:13-27`). A
  receipted ref returns `{alreadyJoined: groupID}`.
- At startup, the host consumes every `joinRef` still set on a group it holds, then clears it.
- **Admission against held state.** A Welcome for a group the host already holds, or has
  tombstoned, is judged by its authenticated epoch, not by group ID:
  - none held: join;
  - live, at or above the Welcome's epoch: `alreadyJoined`;
  - live, below: a genuine re-admission (the device was removed and re-invited while asleep).
    Replaced through `seed({replace: true})`, compare-and-set on the stored version;
  - tombstone: accepted only above the tombstone's epoch floor (Spec P).

  This moves from Spec P's deleted D5.
- **Last-resort packages** are never consumed (`mls-hub/src/provisioner.ts:65`). Their repeats go
  through the same admission rules. `processWelcomeOnce` dedups by group ID alone
  (`mls/src/group-welcome.ts:176-186`) and would discard a genuine re-admission, so it is not used,
  as Kubun already avoids it (`kubun/packages/plugin-p2p/src/groups/manager.ts:690-704`).

### D6. Commit log, forks and strands

- **`applied` rows.** An `AppliedCommit` is `{epoch, digest, payloadDigest, sequenceID, opID: string
  | null}`, keyed by the commit's framed epoch. One is written for each adoption, own or incoming, so
  fork classification survives a restart.
- **Responder outcomes** are separate: an `ExternalResponse` is `{position, digest, kind: 'applied'
  | 'refused' | 'superseded', reason?: RecoveryRefusal}`, keyed by log position as today
  (`rpc/src/peer.ts:935-940, 1563-1564`). Several refused external commits can share one epoch
  without adopting anything, and the reason separates renewal from policy refusals
  (`mls/src/recovery-verdict.ts:24, 32`). It is written in the same `apply` as the cursor skip.
- **Adoption receipt.** The MLS state and the `ControlStore` are separate atomic ports (Spec P D2), so
  an adoption and its `applied` row cannot share one transaction. Instead:
  - every adoption saves the receipt `{adoptionID, kind: 'commit' | 'recovery', epoch, lineage,
    digest, payloadDigest, position, rejoinID?}` in the group state record, in the same transaction
    as the new state (Spec P `GroupStateRecord.lastApplied`). `adoptionID` is random per adoption;
    `epoch` is the framed epoch. A self-removal that applies without advancing the epoch writes one
    too (`mls-rpc/src/apply-commit.ts:133-143`);
  - lifecycle then writes the `applied` row, the cursor and `receiptAck = adoptionID` in one
    `apply`, and adopts nothing else until that `apply` has committed. At most one adoption is ever
    unrecorded;
  - **at `start`, before any classification or replay,** lifecycle compares the receipt's
    `adoptionID` with `receiptAck`. Epoch numbers are not compared: a self-removal keeps its epoch,
    and a fork-healing rejoin can land on an epoch number already recorded
    (`rpc/src/peer.ts:2591-2592`). If they differ:
    - `commit`: write the row, the cursor and `receiptAck`, and turn an `accepted` operation with
      the same `payloadDigest` into `landed`;
    - `recovery`: the rejoin record named by `rejoinID`, still at `confirmed`, moves to `adopted` in
      the same `apply`, before D7 replay can run its source re-check.
- **Fork window.**
  - The window covers 64 epochs.
  - A forked frame older than the window classifies as `history`. That is an accepted blind spot: the
    device stays on its branch until other evidence (`ahead`, a gap) strands it.
- **Stranding** writes `cursor.stranded = true` with the durable position unchanged, as
  `persistStrand` does today (`rpc/src/peer.ts:704-715`). It closes sends (`stranded`) and requests a
  heal.
- **Losing a fork at epoch `E`** is resolved by a rejoin (D7). The recovery candidate carries no
  commit history (`mls-rpc/src/recovery.ts:39-46`), so lifecycle reads the winning branch from the
  commit log, from the last position both branches share up to the rejoin's position. Its final
  `apply`:
  - for every losing `applied` row at or above `E` that carries an `opID`, and every operation still
    `accepted` (D4 step 4, `moved`): `landed` when that range contains its `payloadDigest`;
    `reverted` when the range is complete and does not; `unknown` when a retention gap covers part
    of it;
  - replaces the losing rows with the winner's rows over the range read.
- **Cursor.** The commit cursor moves into `ControlStore` and advances in the same `apply` as the
  `applied` row or skip it records. Only a recorded adoption or skip moves it, so it never regresses.

### D7. Rejoin

```ts
export type RejoinRecord = {
  /** Random per rejoin; the D6 receipt's `rejoinID`. */
  id: string
  stage: 'built' | 'published' | 'confirmed' | 'adopted' | 'refused'
  publishID: string; expectedHead: LogPosition | null
  /** The exact framed external-commit payload. Framing seals with a random nonce, so it cannot be
   *  re-derived (`rpc/src/peer.ts:1781`, `mls-rpc/src/crypto.ts:64`). */
  payload: Uint8Array
  payloadDigest: string
  requestID: string; request: Uint8Array
  /** Secret. Today it lives in a 120 s memory map (`mls-rpc/src/mls.ts:135-173`). */
  requestKey: Uint8Array
  /**
   * `PendingRecovery.serialize()`: the candidate state plus everything verdict judgment reads, the
   * source tree, the known registry and the confirmation tuple (`mls-rpc/src/recovery.ts:201-202`).
   * Secret.
   */
  candidate: Uint8Array
  /** Identity of the state the rejoin replaces; re-checked before adoption. */
  source: { epoch: number; authenticator: Uint8Array; lineage: number; head: LogPosition | null }
  digest: string; epochAfter: number
  /** Ledger tokens held before the rejoin, for `reenact`. */
  ledgerBefore: Array<string>
  /** The lowest losing-branch epoch, when the rejoin heals a fork. */
  forkEpoch: number | null
  position?: LogPosition
  verdict?: Uint8Array
  /** Set with stage `refused`. */
  refusal?: RecoveryRefusal
}
```

**Stages:**

| Stage | Written | Replay at `start` |
|---|---|---|
| (none) | — | start a rejoin only when evidence calls for one |
| `built` | before publishing the external commit | republish the stored `payload` under the same ID. Accepted or deduplicated: `published`. Head mismatch: search the log for `payloadDigest`; found means `published` at that position; absent from the branch served means delete the record and start afresh (relative to that branch, as `lost` in D4) |
| `published` | publish accepted | re-send the confirmation request with the stored `request`, and open verdicts with `requestKey`. Authoritative confirm: `confirmed`. Authoritative refusal requiring renewal: delete the record and start a fresh rejoin with renewal. Refusal by policy or as invalid: write stage `refused` with its reason and a `refused` outcome in one `apply`. Authoritative `superseded`: re-send the request and keep waiting, as today (`rpc/src/peer.ts:2551`, `rpc/src/recovery-confirmation.ts:167`). `unconfirmed` or deadline: delete the record and start a fresh rejoin; the orphan leaf is replaced, as today (`tests/integration/test/recovery-confirmation.test.ts:306`) |
| `confirmed` | verdict verified | D6 receipt reconciliation runs first, and moves the record to `adopted` if its adoption already committed. Otherwise **re-check**: the current state must still equal `source` (epoch, authenticator, lineage), the reconciled log head must equal `source.head`, and no adoption may be pending, as `rpc/src/peer.ts:2563-2571` does today. If not, the candidate is **invalidated**: delete the record and start a fresh rejoin only if evidence still calls for one. Otherwise `restoreRecovery(candidate, requestKey).onAccepted()`, idempotent by `epochAuthenticator`. Adoption uses the recovery identity (`epochAfter`, `forced: true`, `recovery: true`, `rpc/src/peer.ts:2607`) and writes the D6 receipt. Then `adopted` |
| `adopted` | host replace done, or receipt reconciled (D6) | bootstrap the ledger, then one `apply`: `reenact` outcomes for `ledgerBefore` tokens missing from the group ledger; fork settlement from `forkEpoch` (D6); delete the old lineage's view records (D2); clear `stranded`; delete the record |
| `refused` | policy or invalid refusal | terminal and durable: sends stay closed (`recovering`) and no automatic rejoin starts, across restarts and after the outcome is acked. Cleared only by the host calling `recover()`, which deletes the record and starts a fresh rejoin. Today's latch is memory-only (`rpc/src/peer.ts:758, 2356`) |

**Rules:**

- **Settle operations first.** Before writing a rejoin `built`, lifecycle settles the queue head:
  - a `built` operation is republished or searched (D4);
  - an `accepted` one is adopted, or kept `accepted` on `moved` for the rejoin to resolve.

  The queue then pauses until the rejoin record is deleted. Incoming commits are still adopted while
  a record is `published`; the `confirmed` re-check catches any that moved the state.
- **New `GroupControlMLS` methods:**
  - `createRecoveryRequest` returns `{request, requestKey}`;
  - `restoreRecovery(candidate, requestKey)`;
  - `PendingRecovery.serialize()`.

  The 120 s map goes.
- **Responders confirm at their current epoch only.** A responder re-derives `confirmationKey` from
  `exportSecret`, which reads the current key schedule only (`mls/src/group-handle.ts:890-891`); ts-mls
  retains no exporter secret for past epochs (`ts-mls/dist/src/epochReceiverData.d.ts:11-17`). So a
  responder confirms only while its current epoch equals the candidate's, and stores no secret. Once
  every responder has moved past it, the requester times out and rejoins again. Persisting the
  requester's key makes a restart resume confirmation inside that window; it does not widen it.
- **Responders** record each external commit's outcome, with its refusal reason, as an
  `ExternalResponse` (D6).
- **Anchor.** The anchor store is unchanged. A same-number rejoin still goes through
  `requireAnchorRecovery` (`rpc/src/peer.ts:410-414`), and its view carries the captured anchor.

### D8. Errors

- `EpochClosedError`: a seal on a closed view.
- `SendHeldError`: a seal during a send hold.
- `EpochExpiredError`: an open at an evicted epoch.
- `OperationRejectedError`: `build` refused. It becomes a `rejected` outcome.
- `StorageOutcomeUnknownError`: from `ControlStore`, resolved per D3.
- `RecoveryRequiredError`: kept.
- `JournalEpochError` and `LostCommit` / `takeLost`: removed (D4).

## Crash seams

Test-only wrapping stores. "After" means after the wrapped call's transaction committed. Restart
drops all memory.

| Point | Wrapped | When | Expected after restart |
|---|---|---|---|
| intent written | `ControlStore.apply` with an `intent` | after | built and published once |
| built, before publish | `apply` with `built` | after | same payload republished; lands once |
| hub accepted, before `accepted` | hub `publish` on the commit topic | after | dedup or payload search: `accepted`, one Welcome obligation |
| hub forgot the ID | as above, plus hub dedup purge | after | payload search finds it: `landed`, never `lost` |
| `accepted`, before adopt | `apply` with `accepted` | after | adopt once, Welcome delivered |
| own adoption saved, before `landed` apply | host `adopt` (state and receipt) | after | receipt reconciled: `landed`, one `applied` row |
| incoming adoption saved, before `applied` apply | MLS state save (state and receipt) | after | receipt reconciled: `applied` row and cursor written before classification; a competing frame at that epoch classifies as a fork |
| same-number adoption saved, before `applied` apply | MLS state save after a self-removal, or a fork-healing rejoin to a recorded epoch number | after | `adoptionID` differs from `receiptAck`: reconciled, never skipped |
| responder refusal, before cursor skip | MLS verdict sent | after | the refusal is judged again and recorded once with its reason |
| roster change adopted, old topics unfenced | the `apply` recording the adoption | after | the old view is restored from its record, fenced and drained; no frame lost |
| Welcome obligation, before delivery | `apply` with `putWelcomes` | after | delivered |
| invitee joined, before consume | host save of the joined group | after | consumed on start; repeat Welcome is `alreadyJoined` |
| invitee consume, mid-transaction | source `consume` | failure injected | package kept, no receipt; consumed on start |
| invitee consumed, before ack | source `consume` | after | repeat Welcome is `alreadyJoined` without decrypt |
| rejoin built, before publish | `apply` with rejoin `built` | after | one external commit, same payload |
| rejoin published, before confirm | hub `publish` (external) | after | confirmation resumes with the stored key while a responder is at the candidate epoch; otherwise a fresh rejoin |
| rejoin confirmed, state moved, before adopt | `apply` with `confirmed`, then an incoming commit | after | candidate invalidated; never installed over the newer state |
| rejoin confirmed, before adopt | `apply` with `confirmed` | after | adopted once with recovery identity |
| rejoin state saved, before `adopted` | host replace (state and receipt) | after | receipt moves the record to `adopted`; bootstrap, `reenact` and fork settlement run; never invalidated |
| rejoin refused by policy, restart, outcome acked | `apply` with `refused` | after | sends stay closed and no rejoin starts until `recover()` |
| rejoin adopted, before bootstrap | host replace | after | bootstrap, `reenact` computed from `ledgerBefore` |
| fork loser, restart, winner shown | `applied` rows on disk | — | fork detected; `reverted` and `reenact` outcomes |
| view leased at `E`, 9 commits arrive | app lane holds the lease | — | adoption of `E + 9` waits; frames at `E` still open |

## Conformance and tests

| Suite | Case | Assertion |
|---|---|---|
| `testControlStoreConformance` (new, in `rpc-conformance`, replacing the `CommitJournal` suite) | all or nothing | failure injected mid-`apply`: no change visible after reopen |
| | durable | every record kind round-trips across reopen |
| | ambiguous commit | commit-then-reject: `lastMutation()` equals the attempt |
| | outcomes persist until deleted | |
| | secrets | `requestKey` and `candidate` round-trip byte-exact |
| | per provider | memory, node-sqlite, postgres, expo (phase 3 of the parent) |
| `mls` | `carryReceiveProgress` | open at `E` after build, then adopt: the spent generation does not open again; an earlier retained epoch keeps its progress; an evicted epoch is not resurrected |
| | retention through `deriveGroup` | a derived group keeps the configured `retainKeysForEpochs` |
| `mls-hub` | `consume` atomic (pool store and bundle source) | failure mid-`consume`: the package survives and no receipt exists |
| | re-admission | a held group at `E`, a last-resort Welcome at `E + 3`: replaced; a Welcome at `E`: `alreadyJoined` |
| lifecycle crash tests | every row of the crash-seam table | as stated |
| | Codex r4 blockers | a hub that re-wraps our commit with corrupted bodies never clears an operation; a hub fork accepting our invite on the losing branch gives `reverted`; a crash after rejoin publish never adopts without confirmation; a `built` operation at a moved epoch resolves instead of throwing |
| | `moved` | an operation accepted on a losing branch while the state follows the winner: no `applied` row, no cursor move, outcome `reverted` after the rejoin |
| | rejected revoke | a revoke whose `build` is refused lifts the hold; queued entries publish |
| | two revokes | settling the first keeps the hold while the second is unsettled |
| | fork settlement gap | a retention gap over the winning range gives `unknown`, never `reverted` |
| | lineage replaced | after a rejoin, old-lineage views close and `lineageReplaced` reports undrained ranges |
| | refused rejoin | a policy refusal writes `refused` and keeps sends closed; a renewal refusal starts a fresh rejoin |
| view tests | past-epoch open | a frame at `E` opens after `E + 1` is adopted |
| | fence | a frame published at `E` before supersession but fetched after it opens; a gap below the fence is reported as loss |
| | outage at fence | a failed pull keeps the lease and retries; nothing is reported lost |
| | late frame | a frame at `E` arriving after release opens while `E` is retained, and is `expired` after |
| | lease backpressure | adoption of `E + 9` waits for the release of `E` |
| | lease vs handler | a handler at `E` that awaits a reply needing `E + 9` completes: the lease lifts after the durable open |
| | re-seal on close | an unproven entry sealed at `E` is re-sealed at `E + 1` and published once proven |
| | topics switch | a roster change gives a view with new topics; the app lane re-subscribes |
| | revoke hold | no app frame is sealed during the hold, and no frame sealed at the held epoch is handed to the hub after the hold is set |
| | carry with seals | phase 3: seal and open at `E` between build and adopt; after adopt, no sender generation repeats and spent receive generations stay spent |
| | no deadlock | a handler that sends from inside delivery completes |
| integration | `recovery-confirmation` suite unchanged and green | |
| | requester restart | restart between external publish and confirmation: one leaf, adoption after confirmation |
| | Welcome after crash | inviter crashes after `accepted`: the invitee joins after restart |

## Phasing

Each phase is its own PR, with `rpc`, `mls-rpc`, `rpc-conformance` and integration suites green, and
repo-wide `turbo run test:types`.

1. **Probe.** Confirm, with path:line evidence:
   - the lease covers a fetched backlog, and fences can be taken on every app topic;
   - every `held()` condition maps to a `CloseReason` or the `revoking` hold;
   - the effect of the unlocked `commitLogHead` write today;
   - which shared modules go to `hub-client` versus lifecycle, and the `host-boundary` split;
   - `PendingRecovery` serialisability, including the source tree and known registry.
2. **`mls` prerequisites.** Configurable key retention through every constructor, `deriveGroup`
   included; `carryReceiveProgress`; the adoption receipt in the saved state.
3. **Epoch views inside rpc.** The app lane consumes views, with fences and the single state owner.
   The shared lock, hooks and `rebuildEpoch` are removed. `holdLogSends` and `settleLogSubmissions`
   stay as a compatibility shim over the `revoking` hold until phase 5, because
   `publishRevokeProof` still uses them (`mls-rpc/src/revoke.ts:36, 60`). Every legacy replacement
   (`access.replace`, `mls-rpc/src/access.ts:65-67`, reached from `revoke.ts:53`) and every journal
   replay runs `carryReceiveProgress`, since opens and seals now proceed during a pending commit.
   View records need `ControlStore`, so until phase 5 an adoption that replaces the anchor still waits
   for the old views' release (drain before adopt, as today); other adoptions do not. Ordering tests
   that encoded deliver-before-ratchet are rewritten to the view rules, each with a ledgered reason.
4. **Package split.** `@kumiai/group-lifecycle` is created, lifecycle and `HubMux` move,
   `host-boundary` splits, and `createGroupPeer` becomes the assembler. Tests move with their concern;
   the 62 full-peer tests stay in rpc.
5. **Crash safety.** D3 through D7: `ControlStore`, operations, outcomes, Welcome obligations,
   `applied` and `responses` rows, view records, receipt reconciliation, rejoin records, and the
   mls-hub join split. The phase-3 anchor drain goes.
   `publishRevokeProof` moves to `enqueue` with `revokes: true`, and the shim goes.
6. **Band move and Kubun.** The band moves from 0.10 to 0.11. Kubun's `store-p2p` implements
   `ControlStore`, the split `AppOutbox` and `deliverWelcome`; `plugin-p2p` moves from `commit()` to
   `enqueue` and `outcomes`, and its registry merge extends to every retained epoch
   (`kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:570`).

## Spec P amendments

Reconciled API by API, not only by deleting D5's prose:

- D5 (commits, intents, adoption, Welcome) is removed. P2's D4, D5 and D7 replace it. Its Welcome
  admission rules, tombstone floor included, move to P2 D5.
- `GroupStateStore` keeps `epochAuthenticator`, `lineage` and `joinRef`, which P2's `adopt` and the
  invitee rules consume, and gains `lastApplied` (the D6 adoption receipt), saved in the same
  transaction as the state.
- Removed from `GroupStateStore`: intents, `WelcomeObligation`, `putWelcome` / `listWelcomes` /
  `clearWelcome`, and `GroupStateWrite.putWelcome`. `delete` stops clearing intents and
  obligations; P2's `removed` closure settles those in `ControlStore`.
- The commit cursor leaves `AppOutbox` for `ControlStore`.
- D6 and D7 (outbox) build on views: an outbox entry's `segment` is the view's anchor epoch.
- Deletion closes sends through lifecycle (`removed`) before the tombstone.
- The crash seams and conformance rows for D5 (intents, Welcome obligations, `onJoined`) move here.
  Spec P's tombstone-floor row stays, and P2's `mls-hub` re-admission row covers the Welcome side.

## Risks

- **Ordering drift in phase 3.** Tests catch dropped calls, not changed await order
  (`docs/agents/plans/backlog/2026-10-05-rpc-peer-module-split.md`). Mitigation: the view rules replace
  the ordering rather than preserve it, and each changed test is ledgered.
- **Lease starvation.** A fence that never drains holds a view and stalls adoption at `E + 9`.
  Leases lift after the durable open, not after the handler, so only an unreachable hub can hold
  one. That is today's stall, eight epochs later; it is never converted into declared loss.
- **Bounded delivery.** A frame at `E` delivered after `E` is evicted is reported `expired`, not
  opened. Strict delivery would need a closure protocol.
- **Revoke publish window.** A publish already in flight when the hold is set can still reach the
  member being removed, as today.
- **Kubun breakage.** Phase 6 is one coordinated change.
- **Responder confirmation window.** Resumed confirmation works only while some member is still at
  the candidate's epoch. Past that it degrades to today's orphan-and-rejoin.
- **64-epoch fork window.** An older fork goes undetected until other evidence strands the device.
- **`lost` against a hostile hub** is relative to the branch served; global absence is not provable.

## Review log

- **r1, Codex (blind), 2026-10-08.** Three blockers, seven high, five medium; a Claude agent verified
  twelve as stated and two in part, and refuted none.
  - Blockers:
    - a view could be released before its frames were fetched. Now per-topic snapshot fences, plus
      retention-bounded late opens and `expired` reporting (user: bounded guarantee);
    - adopting a build-time journal rolled back receive progress. Now one state owner and
      `carryReceiveProgress` before install;
    - the adoption and its `applied` row were not atomic. Now an adoption receipt in the state
      transaction, reconciled at `start`.
  - High:
    - `moved` recorded `landed` and could regress the cursor. Now fork evidence, resolved by the
      rejoin;
    - commit-digest search let a hub re-wrap our commit. Now acceptance matches the whole payload;
    - `lost` claimed global absence. Now relative to the branch served;
    - confirmed rejoin skipped the pre-adoption re-check. Now `source` identity and invalidation;
    - a rejected remove left sends closed forever. Now `revoking` is a lifting hold, with
      `revokes: true` as an explicit marker;
    - last-resort Welcome dedup dropped re-admissions. Now epoch-based admission;
    - release had no group binding. Now an atomic `consume(ref, groupID)`.
  - Medium:
    - responders cannot export at a past epoch. Now current-epoch confirmation only;
    - the rejoin record lacked its payload and refusal handling. Both added;
    - the Welcome obligation now holds the complete artifact;
    - the lease timeout became lease-after-durable-open;
    - phasing gained an `mls` prerequisites phase and a revoke shim.
  - Also: the lease boundary moved from `E + 8` to `E + 9`. On publication after a revoke, frames
    sealed at the held epoch are held (user choice).
- **r2, Codex (blind), 2026-10-08.** Six blockers plus six findings; a Claude agent confirmed four
  blockers, two in part, all six findings, and refuted none.
  - Blockers:
    - a restart lost the pre-fence backlog of a replaced anchor. Now durable view records, restored
      at `start`; phase 3 keeps drain-before-adopt for anchor changes until they exist;
    - reconciliation compared epochs, which misses same-number adoptions. Now `adoptionID` against
      `receiptAck`, with rows keyed by framed epoch;
    - a recovery saved before its `adopted` stage was invalidated on replay. Now the receipt moves
      it to `adopted` first;
    - a policy refusal was not durable. Now a terminal `refused` stage, cleared only by `recover()`;
    - responder outcomes did not fit `applied`. Now `ExternalResponse` keyed by position, with the
      reason;
    - fork settlement had no history source. Now it reads the winning range from the log, with
      `unknown` on a gap.
  - Findings:
    - carry copies the whole tree, since seals advance it;
    - lineage replacement invalidates old views;
    - phase 3 carries on legacy replacements;
    - the hold covers any unsettled revoke;
    - pool and source ports gain `consume` and `receipt`;
    - the head re-check and `superseded` replay are explicit.
  - Also: fence retries no longer turn an outage into declared loss.
