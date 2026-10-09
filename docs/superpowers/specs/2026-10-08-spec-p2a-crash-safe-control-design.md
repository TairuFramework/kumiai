# Spec P2a: crash-safe group control — design

Date: 2026-10-08
Status: draft r6
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
Siblings:
- [Spec P, transactional persistence](2026-10-08-spec-p-transactional-persistence.md) (control baseline amended by Spec P r14).
- [Spec P2b, epoch views and the lifecycle package](2026-10-08-spec-p2-group-lifecycle-design.md),
  which builds on this spec.

P2a makes group control crash-safe in `@kumiai/rpc` as it is structured today. "Control" means
commits, recovery, forks and Welcomes. Every operation, rejoin, outcome, owed Welcome and applied
commit is recorded in a transactional `ControlStore`, and replayed from it per stage. Every adoption
commits its control changes in the same transaction as the new group state, so no adoption is ever
recorded in one store and not the other. P2a keeps
today's structure: one commit mutex, deliver-before-ratchet and the single-slot anchor store. That
structure is what lets it skip epoch views, fences and view records. Spec P2b then removes the
coupling, with P2a's crash suite as its regression net.

Split from the combined P2 draft at r3, after three blind review rounds; that draft's review log
records the findings carried here.

Apply [Spec P r14 amendments](#spec-p-r14-amendments) before reading this historical baseline.
Its automatic fork healing and separate source-prefix admission are superseded; only non-fork stranding recovers automatically.

## Context

Checked against source on 2026-10-08 (branch `design/client-messaging-e2e`). Paths are relative to
`packages/` unless rooted elsewhere.

### Durability today

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

### D1. Placement

- **In rpc, outside the closure.** The new state machines live in their own modules,
  `rpc/src/control/{store,operations,rejoin,welcome,forks}.ts`. Each takes its dependencies
  as arguments, and `peer.ts` calls them under the commit mutex. None closes over `peer.ts` state,
  so P2b moves them into the lifecycle package without rewriting them.
- **Peer surface.**
  - `enqueue(op)`, `outcomes()` and `ack(id)` are new.
  - `commit()` stays as a convenience: `enqueue` plus a wait for that operation's outcome in this
    process. It resolves on `landed` and rejects with `OperationOutcomeError` carrying any other
    outcome, so callers that read a return as "landed" (`rpc/src/peer-types.ts:324`) stay correct.
    A restart loses the wait, never the operation.
  - **Scheduling.** `enqueue` writes the intent and returns; a queue runner executes operations,
    each in its own `runSerial` task. Waits on outcomes happen outside `runSerial`, which is not
    reentrant (`rpc/src/peer.ts:881`).
  - **Gates kept.** Before `build`, an intent passes today's gates in order: journal replay before
    pull, `ensureLedger` (today `pullCommits` returns early on an incomplete ledger,
    `rpc/src/peer.ts:1600`), the strand and anchor-recovery holds. A durable rejoin record replaces
    `activeRecovery` as the restart-visible gate on the queue and on sends.
  - `abandon()` is new: one `apply` turns open operations and a rejoin record into `unknown`
    outcomes and deletes them, and deletes Welcome obligations. It is the way out before host
    deletion (D5).
  - `takeLost` goes (D7).
- **Ports.**
  - `ControlStore` (D2) is new in rpc, and `rpc-conformance` re-declares it.
  - `GroupMLS` gains the recovery methods (D6), and `mls-rpc` implements them.
  - `mls` gains `carryReceiveProgress` (D3).
  - **The host state save carries control.** Every adoption path, the host `adopt` (D3),
    `GroupMLS.processCommit` (D5) and `restoreRecovery(...).onAccepted` (D6), takes an
    `AdoptionWrite` (D2) and passes it to the host's `persist`, which commits it with the new state.
    Today the handle assigns the new state tentatively, runs `persist`, and restores state, ledger,
    roster, registry and admission if it rejects; notification follows a successful `persist`
    (`mls-rpc/src/apply-commit.ts:55`, `mls/src/group-handle.ts:1629-1656`). The write context is
    threaded as a factory `(staged: GroupHandle) => AdoptionWrite` through `HandleAccess.mutate`,
    `replace` and `SimpleHandleAccessParams.persist` (`mls-rpc/src/access.ts:12-25, 65-70`), all of
    which lack it today; recovery adopts through `replace` (`mls-rpc/src/mls.ts:431`). The factory
    runs on the staged handle, so `epochAfter` and `removed` come from the staged epoch and roster
    before the commit, not from the result after it.
  - `mls-hub` gains `consume` and `receipt` (D4).

### D2. `ControlStore`

Replaces `CommitJournal` and the `AppOutbox` commit cursor. It lives in rpc and stores bytes and plain
values only.

```ts
export type ControlSnapshot = {
  operations: Array<Operation>          // FIFO by `seq`
  rejoin: RejoinRecord | null
  outcomes: Array<Outcome>
  welcomes: Array<WelcomeObligation>
  applied: Array<AppliedCommit>         // newest 64 epochs
  responses: Array<ExternalResponse>    // responder outcomes, newest 64 epochs
  cursor: CommitCursor | null           // {position, epoch, stranded?, fork?}
}
/**
 * Durable with the strand. A detected conflict, not a proven divergence point: the framed epoch is
 * unauthenticated below the current epoch, and divergence may lie lower (D5).
 */
export type ForkEvidence = { conflictEpoch: number; sharedPosition: LogPosition | null; frameDigest: string }
export type ControlChanges = {
  putOperations?: Array<Operation>; deleteOperations?: Array<string>
  putRejoin?: RejoinRecord; deleteRejoin?: true
  putOutcomes?: Array<Outcome>; deleteOutcomes?: Array<string>
  putWelcomes?: Array<WelcomeObligation>; deleteWelcomes?: Array<string>
  putApplied?: Array<AppliedCommit>; deleteAppliedFrom?: number   // drops rows at epoch >= n, before puts
  deleteAppliedBelow?: number   // drops rows at epoch < n, before puts
  putResponses?: Array<ExternalResponse>; deleteResponsesBelow?: number   // by `epoch`
  cursor?: CommitCursor | null
}
/** Control changes committed with an adoption's state save (D5). */
export type AdoptionWrite = {
  changes: ControlChanges
  mutationID: string
  /** The `advance` of the pending anchor rotation this adoption lands, marked in the same transaction. */
  anchorLanded?: string
}
export type ControlStore = {
  load(): Promise<ControlSnapshot>
  /** All or nothing. On an ambiguous commit, rejects with `StorageOutcomeUnknownError`. */
  apply(changes: ControlChanges, mutationID: string): Promise<void>
  /** The `mutationID` of the last committed `apply`. */
  lastMutation(): Promise<string | null>
}
```

- **One transaction with the state.** `ControlStore`, the group state and the anchor slot share one
  database, and an adoption's writes go through the host state save, as one root transaction (Spec
  P D1, D2). That transaction writes the new state, `changes`, `mutationID` as the last mutation, and
  `pending.landed` on the anchor slot when `anchorLanded` matches its `advance`. A write with no
  state change uses `apply`. A failed save leaves the state, the live handle and control untouched.
- **Writers.** The peer is the only writer and serialises every `apply` and adoption.
- **Ambiguous outcomes have one owner each.** An adoption save goes through the host state save, so
  the registry owns its ambiguity, as for every state save (Spec P D2, D3): `mutationID` is its
  `writeID`, the group is marked uncertain, opens, seals and bootstrap wait, and the registry
  reloads the handle and hands the peer a settled committed-or-not result. The peer resolves only a
  state-free `apply`: on `StorageOutcomeUnknownError` it reads `lastMutation()`, with backoff capped
  at 15 s; equal means committed, anything else means not. It stays paused until that read
  succeeds.
- **`applied` and `responses` windows.** The peer keeps the newest 64 epochs of each, by framed
  epoch, and `pruneWindow` prunes older rows (`deleteAppliedBelow` for applied rows,
  `deleteResponsesBelow` for responses) in the same `apply`.
- **Secrets.** `RejoinRecord.requestKey` and the candidate blob are secrets: the Hozon implementation
  encrypts them at rest (Spec P).
- **Isolation.** Spec P's provider and transaction rules (its D2 and D8) apply unchanged.

### D3. Operations

```ts
export type OperationRequest = {
  /** Random 128-bit; the host's handle for outcomes. */
  id: string
  kind: 'invite' | 'remove' | 'ledger' | 'rotation'
  /** Holds app sends (the revoke hold, below) from enqueue until the operation settles. */
  revokes: boolean
  /** Host-opaque; everything `build` needs, such as targets, role and signed tokens. */
  body: Uint8Array
}
/** The operation deadline is `enqueuedAt + operationTimeoutMs`, so a restart keeps it. */
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
  /** The complete host-encoded invitation artifact (D4), or null. */
  welcome: { bytes: Uint8Array; recipients: Array<string> } | null
}
```

The host supplies `build(op)` and `adopt(journal, expected, write)`.

- **`build(op)`** returns `{commit, bodies, journal, welcome}` and must not mutate. It builds
  against the current handle, under the peer's commit mutex as today.
- **`adopt(journal, expected, write)`** runs under the commit mutex and must be idempotent:
  - **no-op** when the current state's epoch and `epochAuthenticator` already equal the
    candidate's;
  - **installs** only when the current state matches `expected = {epoch, authenticatorBefore,
    lineage}`, with a compare-and-set on the stored state version, committing `write` (D2) in the
    same transaction;
  - otherwise reports **`moved`** and writes nothing.

  Installing **preserves ratchet progress**. Opens and seals at `E` happen between build and adopt
  even inside one task: `advanceHandle` drains app frames after build and before ratcheting
  (`rpc/src/peer.ts:1161`), and live inbound opens and seals bypass `runSerial`
  (`rpc/src/peer-epoch.ts:158, 216, 365`). A durable operation also outlives its task: a publish
  error keeps it `built`, and replay after a restart adopts what an earlier process built. Opens
  advance the secret tree, and so do seals (`ts-mls/dist/src/createMessage.js:100-101`). The candidate holds the trees
  snapshotted at build (`ts-mls/dist/src/createCommit.js:84`). After the identity check and before
  saving, and under the handle's own write gate (`mls/src/group-handle.ts:85`) so no open or seal
  interleaves, `adopt` copies the current state's whole `secretTree`, sender and receive progress alike,
  into the candidate's history at `E`, and the current historical tree of every earlier epoch the
  candidate also retains. It keeps the candidate's `E + 1` state, and resurrects no epoch the
  current state has evicted. Every change in between goes through the same handle, so the current
  trees are strictly newer and a copy is enough. Skipping it would reuse sender generations. Today
  `mls-rpc` refuses opens at earlier epochs (`mls-rpc/src/crypto.ts:188`), so the earlier-epoch
  copy is a no-op until P2b; it is specified now so P2b need not revisit `adopt`. `mls` provides this as
  `current.carryReceiveProgress(candidate)`. Its carry identity check compares the candidate's
  retained `resumptionPsk` at `E` with the current state's `resumptionPsk`, in constant time.
  ts-mls history retains no `epochAuthenticator`; both values derive from `epoch_secret`, so the
  resumption PSK witnesses the same epoch identity. Rebuilding the commit at adoption is not an option:
  update paths use fresh randomness (`ts-mls/dist/src/updatePath.js:26`), so the bytes would differ
  from the accepted ones.

Each operation moves through its stages as follows. Every arrow is one `apply` unless noted.

1. **`enqueue`.** `putOperations([intent])`. The call resolves after the commit. An operation with
   `revokes: true` sets the send hold.
2. **Head of the queue.** The peer pulls the commit log to its head (D5), calls `build`, frames the
   payload, and writes `built`. A refused `build` writes a `rejected` outcome and deletes the
   operation in one `apply`.
3. **Publish** `payload` under `publishID` and `expectedHead`:
   - accepted, deduplicated or not: write `accepted` and `putWelcomes` in the same `apply`;
   - head mismatch: the honest store claims the ID before its head check
     (`hub-store/src/store.ts:186-215`), but a hub may have lost its dedup record, so the peer
     always searches the commit log from `expectedHead` for a frame whose payload hashes to
     `payloadDigest` (below). Found: `accepted` at that position. Absent from a complete range:
     return to `intent`, then pull, rebuild and retry until the operation deadline; past it, write
     `lost` and delete the operation. A retention gap over the range: write `unknown` and delete
     the operation. Live and replayed mismatches follow this one rule;
   - any other error: keep `built` and retry with backoff.
4. **`accepted`.** Call `adopt`.
   - **Installed:** `write` deletes the operation, puts the `landed` outcome, puts the `applied`
     row `{epoch, digest, payloadDigest, sequenceID, opID, removed: false}` and sets the cursor to
     `acceptedAs`, all in the adoption's transaction. The peer rebuilds the epoch, as today.
   - **No-op:** the state already holds the commit. Either this adoption committed before a crash,
     and its changes with it, or the commit arrived from the log first and the incoming adoption
     settled the operation (D5). The peer `apply`s the same changes for any part still missing.
   - **`moved`:** acceptance is evidence that the hub served the commit, not that this device's
     branch contains it. The `applied` rows and the cursor are left alone. The peer pulls the log
     and compares the `applied` row at `built.epoch` (rows are keyed by the commit's framed epoch,
     as the classifier keys them today, `rpc/src/peer.ts:1560`):
     - same `digest` AND `payloadDigest`: the commit was already adopted from the log. Write
       `landed` and delete the operation;
     - a different digest, a matching digest with a different payload digest, or a log that does
       not show the commit on this device's branch: fork
       evidence. The operation stays `accepted`, the device strands (D5), and the rejoin's final
       `apply` (D6) settles it as `unknown` (D5).

**Revoke hold.** While any stored operation with `revokes: true` is unsettled, the peer hands no
retained log submission to the hub (`rpc/src/peer.ts:635`). This is today's `holdLogSends`
behaviour, scoped as today: ephemeral publishes and directed replies seal and send on their own
paths (`rpc/src/peer-epoch.ts:216, 365`) and are not held. Before publishing a held commit, the
peer still runs `settleLogSubmissions` (`rpc/src/peer.ts:2167-2169`), so submissions already handed
off are drained first. Held entries are re-sealed at the successor epoch; after a restart they are
always re-sealed, since publication evidence is memory-only today.
- At `start` the hold is recomputed from the stored operations, before delivery starts. It replaces
  the journal's restart hold (`rpc/src/peer.ts:238`).
- It combines with the strand, rejoin, anchor-recovery and removal holds in `held()`
  (`rpc/src/peer.ts:586-594`).
- Settling one revoke never lifts another's.
- `publishRevokeProof` moves to `enqueue` with `revokes: true`.
- A publish already in flight when the hold is set may still land, as today.

**Replay at `start`** works per stage, at the D5 startup steps 7 and 10:

- `intent`: as step 2.
- `built`: republish the stored `payload` under the same ID, whatever the current epoch. This
  removes `JournalEpochError`.
  - Accepted or deduplicated: as step 3.
  - Head mismatch: as step 3. The search matches the whole payload, not the commit digest, which
    stops a hub from re-wrapping our genuine commit with corrupted bodies (the commit digest
    excludes bodies and "is not a security boundary", `rpc/src/classify.ts:173`).
- `accepted`: as step 4.

**Outcomes:**

```ts
export type Outcome = { id: string; opID: string | null; at: number } & (
  | { kind: 'landed'; position: LogPosition }
  | { kind: 'lost' }                       // absent from the branch this device follows
  | { kind: 'unknown' }                    // absence not provable, or touched by a fork (D5)
  | { kind: 'reenact'; tokens: Array<string> }    // ledger tokens missing after a rejoin
  | { kind: 'rejected'; reason: string }          // build refused, e.g. not authorised
  | { kind: 'refused'; reason: RecoveryRefusal }  // a rejoin refused by policy (D6)
)
```

- They persist until `ack`. The peer never re-enacts anything; the host enqueues a new operation.
  The peer emits `outcome` when it writes one.
- **`lost` is relative to the branch this device follows.** Against an honest hub it means the
  commit is absent. A hostile hub can accept a commit, serve another branch and forget its dedup
  record, so `lost` does not prove global absence. If another member applied the commit, that shows
  up later as fork evidence on this device. So a host may re-enact a `lost` operation, and its
  `build` must refuse a target that is already in the wanted state (already a member, already
  removed) as `rejected`.
- **`landed` and "lands once" are branch-relative too.** Against an honest hub, rebuild-and-retry
  (step 3) never lands one intent twice. Against a hostile hub, a hidden first acceptance on another
  branch and the rebuilt commit here can both land. The target guard covers invites and removals; a
  ledger operation, where enacting twice is meaningful (`mls/src/group-commit.ts:178-181`), has no
  such guard. The crash rows assert "lands once" against an honest hub only.

### D4. Welcome obligations

**Inviter side:**

- A `WelcomeObligation` is `{opID, welcome, recipients}`. It is written with `accepted` (D3 step 3).
- `welcome` is the **complete host-encoded invitation artifact**: the MLS Welcome plus the invite and,
  when needed, the ratchet tree (`mls/src/group-welcome.ts:50-58`). Raw Welcome bytes are not
  enough: once the operation and its journal are deleted, nothing else can rebuild the artifact.
  Kubun already persists the encoded invitation for this reason
  (`kubun/packages/plugin-p2p/src/groups/manager.ts:894-899`).
- After each such `apply`, and at every `start`, the peer calls the host's
  `deliverWelcome(obligation)`. It resolves once the delivery transport has durably accepted the
  artifact; the peer then deletes the obligation. Delivery is at least once.
- Delivery does not depend on adoption, and survives a rejoin (D6).
- The host checks frame size inside `build`, as today (`rpc/src/commit.ts:23-29`).

**Invitee side (`mls-hub`):**

- `processWelcomeFromSources` splits into `openWelcome(sources, welcome)`, which decrypts without
  releasing and returns the verified `groupID`, and `consume(ref, groupID)`. The host calls
  `consume` only after it has saved the joined group, with `joinRef` set (Spec P).
- **Ordinary `consume` is one source transaction:** it deletes the private package and writes the receipt
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
- **Admission against held state, after the spent check.** An unspent Welcome for a group the host already holds, or has
  tombstoned, is judged by its authenticated epoch, not by group ID:
  - none held: join;
  - live, at or above the Welcome's epoch: `alreadyJoined`;
  - live, below: a genuine re-admission (the device was removed and re-invited while asleep).
    Replaced through `seed({replace: true})`, compare-and-set on the stored version. This is a
    remove-then-join, not an adoption, so D5's adoption rule does not apply. With the peer stopped,
    one root transaction installs the joined state and resets control: open operations and a
    rejoin record become `unknown` outcomes and are deleted; `applied`, `responses` and the cursor
    are cleared; the anchor slot is cleared. Outcomes and Welcome obligations are kept. The peer
    then starts as for a fresh join, capturing the anchor at the joined epoch. P2a startup also
    clears only the cursor when its epoch differs from `GroupMLS.readEpoch()`, then walks from the
    oldest retained frame. A position paired with a different MLS epoch cannot seed a covered
    range for the current handle. Ordinary co-committed adoptions prevent this epoch mismatch;
    the fallback is defensive for state replaced outside that contract. This fallback does not
    reset operations, rejoin or the anchor, nor settle old-branch work: re-admission still requires
    the explicit atomic reset above;
  - tombstone: accepted only above the tombstone's epoch floor (Spec P).

  This moves from Spec P's deleted D5.
- **Last-resort packages** are never consumed (`mls-hub/src/provisioner.ts:65`): `consume` is a
  no-op that writes no receipt, and `receipt(ref)` returns `null`. Their repeats go
  through the same admission rules. `processWelcomeOnce` dedups by group ID alone
  (`mls/src/group-welcome.ts:184-194`) and would discard a genuine re-admission, so it is not used,
  as Kubun already avoids it (`kubun/packages/plugin-p2p/src/groups/manager.ts:690-704`).

### D5. Commit log, forks and strands

- **`applied` rows.** An `AppliedCommit` is `{epoch, digest, payloadDigest, sequenceID, opID: string
  | null, removed: boolean}`, keyed by the commit's framed epoch. One is written for each adoption, own or incoming, so
  fork classification survives a restart.
- **Responder outcomes** are separate: an `ExternalResponse` is `{position, digest, kind: 'applied'
  | 'refused' | 'superseded', epoch: number, reason?: RecoveryRefusal, epochAfter?: number}`, `epoch`
  being the frame's framed epoch, keyed by log position as today
  (`rpc/src/peer.ts:935-940, 1563-1564`). Several refused external commits can share one epoch
  without adopting anything, and the reason separates renewal from policy refusals
  (`mls/src/recovery-verdict.ts:24, 32`). It is written in the same `apply` as the cursor skip, or in the adoption's transaction when the external commit is adopted.
- **Adoption writes.** Every adoption, own, incoming or recovery, commits an `AdoptionWrite` (D2)
  with its new state. Its `changes` always hold the `applied` row and the cursor, plus:
  - an incoming commit whose `payloadDigest` matches an `accepted` operation: that operation's
    deletion and `landed`;
  - an adopted external commit: the `ExternalResponse` `applied` with `epochAfter`, which
    confirmation requests need and which a later pull cannot rebuild once the cursor has passed the
    frame (`rpc/src/peer.ts:968, 1511`);
  - a rejoin: its record's move to `adopted` (D6);
  - a pending anchor rotation: `anchorLanded`, except for a `removed: true` adoption. A
    self-removal keeps epoch `E` while the identity predicts `E + 1` (`rpc/src/peer.ts:1520`,
    `mls-rpc/src/apply-commit.ts:133-143`), and its live resolution stays `keepAnchor`
    (`rpc/src/peer.ts:427-437`);
  - a rejoin that heals a fork: fork settlement (below).

  So no adoption is ever unrecorded, and nothing needs reconciling.
  `GroupMLS.processCommit(frame, write)` reports `applied` separately from epoch advancement. Today
  `mls-rpc` discards `ApplyCommitResult.applied` (`mls-rpc/src/mls.ts:333`), and a self-removal
  applies without advancing the epoch (`mls-rpc/src/apply-commit.ts:133-143`); it still saves, with
  `removed: true` on its row.
- **Effects after the transaction** come from durable state, never memory, so a crash before them
  repeats them on restart:
  - **removal:** the newest `applied` row has `removed: true`. Live detection uses a roster
    transition (`rpc/src/peer.ts:1186-1191`), which a restart no longer sees. If operations or a
    rejoin record remain, one `apply` turns them into `unknown` outcomes and deletes them. Then
    today's removal path runs: `locallyRemoved` and outbox clearing (`rpc/src/log-delivery.ts:272-278`);
    it does not delete the group. The group stays **terminal**: startup on it runs only Welcome
    delivery and outcome serving;

  - **host deletion** (Spec P `delete`) is refused while the control store holds an operation, a
    rejoin record, an unacked outcome or an undelivered Welcome obligation. So a tombstone never
    carries control records, and no worker has to serve one. A host that must delete anyway calls
    `abandon()` (D1) first and acks the outcomes;
  - **anchor:** a pending rotation with `landed` resolves as landed. One without it provably did not
    land, so the anchor is kept. Today a same-number record found at startup cannot be told apart
    and forces `requireAnchorRecovery` (`rpc/src/peer.ts:425-432`); with the mark that case is gone.
  - **anchor resolution saves first.** Today `captureAnchor` and `keepAnchor` replace the anchor,
    clear `anchorPending` and release the seal barrier before `anchorStore.save`
    (`rpc/src/peer.ts:393-408`). A failed save then leaves nothing to retry: the catch's
    `resolveAnchorRotation` finds no record (`:419, 1205-1209`) and the caller's `rebuildEpoch` is
    skipped (`:1641`). This is a defect today, and P2a makes it worse, since the co-committed
    operation is already gone. Both functions save first, then publish memory (anchor, pending,
    barrier, `appLane.reset()`). A failed save keeps `anchorPending`, so the retry resolves it, and
    the epoch is rebuilt after it.
- **Startup order:**
  1. load the anchor slot and `ControlStore`;
  2. run the removal effect. A removed group stops here, then runs only Welcome delivery and
     outcome serving;

  3. resolve the anchor (`rpc/src/peer.ts:2783`), using the landed mark;
  4. restore pending app records (`restorePending`), so replay drains them;
  5. subscribe the control topics, and nothing else. Today `initControlLanes` also restores the
     cursor, replays the journal, runs `ensureLedger` and pulls (`rpc/src/peer.ts:1733-1756`); those
     move to the steps below;
  6. restore the holds, including the rejoin barrier (D6);
  7. **settle before the walk**, as today's "replay ahead of the pull" (`rpc/src/peer.ts:1594-1599,
     1788-1794`): republish or search each `built` operation and adopt each `accepted` one (D3); move
     a `built` rejoin whose publish is found to `published` with its position, so its barrier is up.
     Otherwise the walker meets our own accepted commit unadopted, strands on it
     (`rpc/src/peer.ts:1419-1433`) and asks for a recovery nobody may answer;
  8. the seed pull and `ensureLedger`;
  9. build the epoch (`buildEpoch`, `rpc/src/peer.ts:2798`), which an idle restart needs since no
     adoption triggers it;
  10. replay the rest: `intent` operations and the rejoin's later stages. Rejoin replay is exempt
      from the anchor-recovery gate that `initControlLanes` and `walkCommits` apply today
      (`rpc/src/peer.ts:1239, 1729`). Confirmation waits stay outside `runSerial`, as today
      (`rpc/src/peer.ts:2515`);
  11. start background delivery. The synchronous drain inside `advanceHandle`
      (`rpc/src/peer.ts:1161`) is unchanged.
- **Fork window.**
  - The window covers 64 epochs.
  - A forked frame older than the window classifies as `history`. That is an accepted blind spot: the
    device stays on its branch until other evidence (`ahead`, a gap) strands it.
- **Stranding** writes `cursor.stranded = true`, and for a lost fork `cursor.fork` (the
  `ForkEvidence`: the conflicting frame's epoch, the last shared position and the competing frame's
  digest), in one `apply` with the durable position unchanged, as `persistStrand` does today
  (`rpc/src/peer.ts:704-715`). It holds sends, as today's strand hold in `held()`
  (`rpc/src/peer.ts:586-594`), and requests a heal.
- **Fork evidence triggers a heal; it proves nothing.** Below the current epoch the classifier rests
  on a cleartext framed epoch, a digest of hub-supplied bytes and sequence order, with no
  authenticated committer (`rpc/src/classify.ts:259-283`, `mls/src/group-handle.ts:1404-1422`). A
  hostile hub can forge it. The conflict epoch `E` is where a competitor was seen, not where the
  branches diverged: the classifier flags whichever epoch has a row, and divergence may lie lower.
  At the divergence epoch both commits share a parent, so a commit this device built there may be
  the winner. Neither MLS parent binding nor a log scan settles which commits won.
- **Fork settlement** runs in the rejoin's adoption transaction (D6), before the rejoin's own row can
  overwrite a row at the same framed epoch, and asserts nothing it cannot prove:
  - every operation still `accepted`, and every `applied` row at or above `E` that carries an
    `opID`: `unknown`. For a row, this follows the `landed` written at adoption, which was relative
    to the branch then followed (D3);
  - `deleteAppliedFrom: E`, then the rejoin's own row is put. Deletes run before puts in one
    transaction (D2), so the rejoin row survives even when its framed epoch is at or above `E`,
    and an older row it would overwrite has been read first.
    Rows below `E` are kept and not re-reported. Divergence below the detected epoch is the same
    accepted blind spot as the 64-epoch window;
  - the authoritative answer is the rejoined state itself: its authenticated roster for invites and
    removals, and `reenact` (D6) for ledger tokens. A host re-enacts an `unknown` operation, and the
    `build` target guard (D3) refuses one that already holds.
- **Cursor.** The commit cursor moves into `ControlStore` and advances in the same transaction as
  the `applied` row or skip it records. Only a recorded adoption or skip moves it, so it never regresses.

### D6. Rejoin

```ts
export type RejoinRecord = {
  /** Random per rejoin. */
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
   * source tree, the known registry and the confirmation tuple (`mls-rpc/src/recovery.ts:206-207`),
   * and the binding's `holderGrant`, which is part of the binding identity
   * (`mls-rpc/src/recovery.ts:99-108`). Secret.
   */
  candidate: Uint8Array
  /** Identity of the state the rejoin replaces; re-checked before adoption. */
  source: { epoch: number; authenticator: Uint8Array; lineage: number; head: LogPosition | null }
  digest: string; epochAfter: number
  /** Ledger tokens held before the rejoin, for `reenact`. */
  ledgerBefore: Array<string>
  /** `ForkEvidence.conflictEpoch`, when the rejoin heals a detected fork (D5). */
  conflictEpoch: number | null
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
| `built` | before publishing the external commit | republish the stored `payload` under the same ID. Accepted or deduplicated: `published`. Head mismatch: search the log for `payloadDigest`; found means `published` at that position; absent from the branch served means delete the record and start afresh (relative to that branch, as `lost` in D3) |
| `published` | publish accepted | re-send the confirmation request with the stored `request`, and open verdicts with `requestKey`. Authoritative confirm: `confirmed`. Authoritative refusal requiring renewal: delete the record and start a fresh rejoin with renewal. Refusal by policy or as invalid: write stage `refused` with its reason and a `refused` outcome in one `apply`. Authoritative `superseded`: discard the candidate, delete the record and start a fresh rejoin from fresh GroupInfo, as today (`rpc/src/peer.ts:2550-2551`, `tests/integration/test/recovery-confirmation.test.ts:438`). `unconfirmed` or deadline: delete the record and start a fresh rejoin; the orphan leaf is replaced, as today (`tests/integration/test/recovery-confirmation.test.ts:306`) |
| `confirmed` | verdict verified | The adoption moves the record to `adopted` in its own transaction, so a record still `confirmed` was not adopted. **Re-check**, read-only and exempt from the anchor-recovery gate: the current state must still equal `source` (epoch, authenticator, lineage). `source.head` is the in-memory reconciled head at rejoin build (`rpc/src/peer.ts:2460`), persisted because a strand keeps the durable cursor behind it (`rpc/src/peer.ts:716`). The peer then scans the log over `[source.head, record.position)` without adopting; the barrier guarantees nothing after the rejoin's position touched the source state, and the check **fails iff** it finds a retention gap, or a commit frame framed at `source.epoch` that is neither this rejoin's own external commit, nor unparseable, nor covered by a recorded `ExternalResponse`. Frames framed above `source.epoch` cannot move the source and pass. This is conservative: a parseable frame that MLS would later refuse still fails the check, which costs one fresh rejoin, never an unsafe install, as today's equality check (`rpc/src/peer.ts:2563-2571`). On failure, the candidate is **invalidated**: delete the record and start a fresh rejoin only if evidence still calls for one. Otherwise `restoreRecovery(candidate, requestKey).onAccepted(write)`, idempotent by `epochAuthenticator`. Adoption uses the recovery identity (`epochAfter`, `forced: true`, `recovery: true`, `rpc/src/peer.ts:2607`), and `write` (D5) moves the record to `adopted` |
| `adopted` | in the rejoin's adoption transaction, with fork settlement from `conflictEpoch` (D5) | bootstrap the ledger, then one `apply`: `reenact` outcomes for `ledgerBefore` tokens missing from the group ledger; clear `stranded`; delete the record |
| `refused` | policy or invalid refusal | terminal and durable: sends stay held and no automatic rejoin starts, across restarts and after the outcome is acked. Cleared only by the host calling `recover()`, which deletes the record and starts a fresh rejoin. Today's latch is memory-only (`rpc/src/peer.ts:758, 2356`) |

**Rules:**

- **Settle operations first.** Before writing a rejoin `built`, the peer settles the queue head:
  - a `built` operation is republished or searched (D3);
  - an `accepted` one is adopted, or kept `accepted` on `moved` for the rejoin to resolve.

  The queue then pauses until the rejoin record is deleted.
- **Rejoin barrier.** While a record is `published` or `confirmed`, the commit walker and the
  responder stop at `record.position` before classifying it, as today's in-memory
  `pendingRecovery` does (`rpc/src/peer.ts:966, 1394-1395`). At startup the barrier is rebuilt from
  the durable record. Frames before it are still adopted; the `confirmed` re-check catches any that
  moved the state. Without it, a same-number rejoin breaks: a successor framed at `source.epoch` is
  refused under the source but applies under the candidate, and a recorded refusal passes the
  re-check, so installing the candidate would regress the cursor or miss that successor.
- **New `GroupMLS` methods:**
  - `createRecoveryRequest` returns `{request, requestKey}`;
  - `restoreRecovery(candidate, requestKey)`;
  - `PendingRecovery.serialize()`.

  The 120 s map goes. Every reader takes the key as an argument: `applyRecovery`,
  `openRecoveryVerdict` and `openSealedLedger`. The key belongs to the attempt that created it.
  `applyRecovery` runs before any record exists (`mls-rpc/src/mls.ts:375-376`,
  `rpc/src/peer.ts:2432`), so the rejoin holds its key in memory until it writes `built`, which
  persists it; a crash before `built` loses nothing durable. A ledger gather makes its own request
  and can run with no rejoin (`rpc/src/peer.ts:1752, 2009-2013, 2043`): its key stays in memory,
  and a restart starts a new gather.
- **Responders confirm at their current epoch only.** A responder re-derives `confirmationKey` from
  `exportSecret`, which reads the current key schedule only (`mls/src/group-handle.ts:895-896`); ts-mls
  retains no exporter secret for past epochs (`ts-mls/dist/src/epochReceiverData.d.ts:11-17`). So a
  responder confirms only while its current epoch equals the candidate's, and stores no secret. Once
  every responder has moved past it, the requester times out and rejoins again. Persisting the
  requester's key makes a restart resume confirmation inside that window; it does not widen it.
- **Responders** record each external commit's outcome, with its refusal reason, as an
  `ExternalResponse` (D5).
- **Anchor.** `AnchorSlot.pending` gains `landed?: true`, written by the adoption transaction (D2).
  A same-number rejoin no longer needs `requireAnchorRecovery` at startup; the live paths that call
  it for an unexpected epoch are unchanged (`rpc/src/peer.ts:410-414`).

**Known limitation:** an unresolved anchor gate can leave a source-epoch commit unwalked, invalidating every confirmed rejoin at the same position.
`onRecovery` exposes repeated `invalidated` failures with `anchorRecovery: true` and the same non-null `blockingPosition`.
Stop and drain the peer. An authorised administrator removes its leaf and re-invites it with a fresh key package.
Install the newer authenticated Welcome through D4 re-admission, resetting control and anchor with open work settled as `unknown`, then restart.
Automatic reconciliation requires a durable anchor-recovery hold across intermediate authenticated adoptions. Advancing `source.head` without processing the prefix is unsafe.

### D7. Errors

- `OperationRejectedError`: `build` refused. It becomes a `rejected` outcome.
- `StorageOutcomeUnknownError`: from `ControlStore` or an adoption save, resolved per D2.
- `RecoveryRequiredError`: kept.
- `JournalEpochError` and `LostCommit` / `takeLost`: removed (D3).

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
| adoption save, mid-transaction | host state save with an `AdoptionWrite` | failure injected | neither state, control nor anchor mark changed; the live handle unchanged; adoption retried |
| own adoption committed | host `adopt` | after | `landed`, one `applied` row, operation gone; the no-op path writes nothing |
| incoming adoption committed | MLS state save | after | row and cursor on disk; a competing frame at that epoch classifies as a fork |
| ambiguous adoption save | host state save | commit then reject | `lastMutation()` resolves it; committed: handle reloaded, one row |
| ambiguous `apply` at acceptance | `apply` | commit then reject | `lastMutation()` resolves it; one `accepted` |
| external commit adopted | MLS state save (external) | after | `ExternalResponse` on disk; a confirmation request is answered |
| same-number rejoin committed, before anchor resolution | host replace | after | the landed mark resolves the rotation; no `requireAnchorRecovery`, sends resume |
| same-number rejoin save fails | host replace | failure injected | no mark: anchor kept, record still `confirmed`, re-check then adoption retried |
| self-removal committed, before host deletion | MLS state save (`removed: true` row) | after | open operations `unknown`; removal path runs; group terminal |
| host deletes a group with unsettled control | host `delete` | — | refused; after `abandon()` and acks, deletion succeeds and the tombstone carries no control records |
| hub accepted, before `accepted`, restart | hub `publish` on the commit topic | after | step 7 adopts it before the seed walk; never stranded on our own commit |
| rejoin published, before `published` write, restart | hub `publish` (external) | after | step 7 finds it and moves the record to `published` before the seed walk; its barrier holds |
| rejoin row at the framed epoch of an own `landed` row | rejoin adoption | after | settlement reads the old row first: its `opID` gets `unknown` |
| ambiguous anchor save | `AnchorStore` save | commit then reject | `anchorPending` kept until the save is known; resolution repeats idempotently |
| live self-removal with a pending rotation | MLS state save (`removed: true`) | after | no landed mark; `keepAnchor`; group terminal |
| Welcome re-admission committed | host `seed({replace: true})` | after | operations and rejoin `unknown`; rows, cursor and anchor reset; anchor captured at the joined epoch |
| anchor capture save fails live | `AnchorStore` save at capture | failure injected | `anchorPending` kept; retry resolves it; the epoch is rebuilt |
| anchor keep save fails live | `AnchorStore` save at keep | failure injected | as above, anchor unchanged |
| anchor resolved, before `rebuildEpoch` | `AnchorStore` save | after | startup builds the epoch |
| same-number rejoin, external successor | `apply` with `published`, then an external commit at `source.epoch` | after | the barrier holds the walker at the rejoin position; the re-check scans only below it and passes; the successor is judged under the candidate after adoption, never skipped |
| restart with an operation past its deadline | `apply` with `built` | after, clock moved | the deadline from `enqueuedAt` applies: `landed` if dedup or the search finds it, else `lost` or `unknown` per D3 |
| rejoin state committed | host replace | after | record is `adopted`; bootstrap, `reenact` and fork settlement run; never invalidated |
| responder refusal, before cursor skip | MLS verdict sent | after | the refusal is judged again and recorded once with its reason |
| strand and fork evidence written, before rejoin `built` | `apply` with `stranded` and `fork` | after | rejoin starts from the stored evidence; settlement uses `conflictEpoch` even if the competing frame is never served again |
| ledger bootstrapped, before final rejoin `apply` | `bootstrapLedger` | after | bootstrap is idempotent; `reenact` and settlement written once |
| Welcome accepted by transport, before obligation deletion | `deliverWelcome` | after | delivered again (at least once); the invitee answers `alreadyJoined` |
| Welcome obligation, before delivery | `apply` with `putWelcomes` | after | delivered |
| invitee joined, before consume | host save of the joined group | after | consumed on start; repeat Welcome is `alreadyJoined` |
| invitee consume, mid-transaction | source `consume` | failure injected | package kept, no receipt; consumed on start |
| invitee consumed, before ack | source `consume` | after | repeat Welcome is `alreadyJoined` without decrypt |
| rejoin built, before publish | `apply` with rejoin `built` | after | one external commit, same payload |
| rejoin published, before confirm | hub `publish` (external) | after | confirmation resumes with the stored key while a responder is at the candidate epoch; otherwise a fresh rejoin |
| rejoin confirmed, state moved, before adopt | `apply` with `confirmed`, then an incoming commit | after | candidate invalidated; never installed over the newer state |
| rejoin confirmed, before adopt | `apply` with `confirmed` | after | adopted once with recovery identity |
| rejoin refused by policy, restart, outcome acked | `apply` with `refused` | after | sends stay held and no rejoin starts until `recover()` |
| rejoin adopted, before bootstrap | host replace | after | bootstrap, `reenact` computed from `ledgerBefore` |
| fork loser, restart, winner shown | `applied` rows on disk | — | fork detected; `unknown` and `reenact` outcomes |
| rejoin final `apply`, rejoin row at or above `E` | final rejoin `apply` | after | losing rows deleted, the rejoin's own row kept |

## Conformance and tests

| Suite | Case | Assertion |
|---|---|---|
| `testControlStoreConformance` (new, in `rpc-conformance`, replacing the `CommitJournal` suite) | all or nothing | failure injected mid-`apply`: no change visible after reopen |
| | durable | every record kind round-trips across reopen |
| | ambiguous commit | commit-then-reject: `lastMutation()` equals the attempt |
| | co-commit with the state save | an adoption save with an `AdoptionWrite`: failure injected mid-transaction leaves state, control and anchor slot unchanged; after commit, all three changed and `lastMutation()` equals its `mutationID`. Run against the host store and every double |
| | outcomes persist until deleted | |
| | secrets | `requestKey` and `candidate` round-trip byte-exact |
| | per provider | memory, node-sqlite, postgres, expo (phase 3 of the parent) |
| `mls` | `carryReceiveProgress` | an open at `E` after build, then adopt: the spent generation does not open again; a seal at `E` after build, then adopt: no sender generation repeats; an evicted epoch is not resurrected |
| `mls-hub` | `consume` atomic (pool store and bundle source) | failure mid-`consume`: the package survives and no receipt exists |
| | re-admission | a held group at `E`, a last-resort Welcome at `E + 3`: replaced; a Welcome at `E`: `alreadyJoined` |
| peer crash tests | every row of the crash-seam table | as stated |
| | Codex r4 blockers | a hub that re-wraps our commit with corrupted bodies never clears an operation; a hub fork accepting our invite on the losing branch gives `unknown`, and the rejoined roster decides; a crash after rejoin publish never adopts without confirmation; a `built` operation at a moved epoch resolves instead of throwing |
| | `moved` | an operation accepted on a losing branch while the state follows the winner: no `applied` row, no cursor move, outcome `unknown` after the rejoin |
| | rejected revoke | a revoke whose `build` is refused lifts the hold; queued entries publish |
| | revoke hold | no retained log submission is handed to the hub between a revoke's enqueue and its outcome, across restart, except those already handed off before the hold, which `settleLogSubmissions` drains first |
| | two revokes | settling the first keeps the hold while the second is unsettled |
| | fork settlement | every `accepted` operation and every row at or above `conflictEpoch` with an `opID` gives `unknown`; no `reverted` exists |
| | winner at divergence | our commit wins at `E` while a competitor is adopted: never reported as reverted |
| | late-revealed divergence | divergence at `E`, competitor first seen at `E + 3`: rows below `E + 3` are not re-reported (documented blind spot) |
| | forged conflict | a hub serves a parseable fake commit at a lower position: the device heals, and no outcome is asserted from the evidence |
| | removal effect | a self-removal committed, crash before deletion: removal runs at start from the row |
| | source re-check | a winner's successor framed above `source.epoch` passes; a parseable unrecorded frame at `source.epoch` fails |
| | refused rejoin | a policy refusal writes `refused` and keeps sends held; a renewal refusal starts a fresh rejoin |
| | holder evidence | a chained leaf without holder evidence: `build` gives `rejected`; a rejoin binding refreshed with evidence round-trips its `holderGrant` and is usable; a Welcome to such a leaf leaves its obligation delivered and the invitee unjoined |
| integration | `recovery-confirmation` suite unchanged and green | |
| | requester restart | restart between external publish and confirmation: one leaf, adoption after confirmation |
| | Welcome after crash | inviter crashes after `accepted`: the invitee joins after restart |

## Phasing

Each phase is its own PR, with `rpc`, `mls`, `mls-hub`, `mls-rpc`, `rpc-conformance` and the
integration suites green, and repo-wide `turbo run test:types`.

1. **Probe.** Confirm, with path:line evidence:
   - every place `peer.ts` writes the commit journal, the commit cursor or `appliedByEpoch`;
   - `PendingRecovery` serialisability, including the source tree and known registry;
   - every open and seal path that can run between build and adopt, so the D3 carry and its write
     gate cover them;
   - every reader of the 120 s request-key map;
   - the Kubun call sites for `commit()`, `takeLost` and the journal;
   - that every host keeps the group state, the anchor slot and `ControlStore` in one database
     (Kubun `store-p2p`, the test fixtures), and every `persist` call site that must carry an
     `AdoptionWrite`;
   - that `resolveAnchorRotation`'s durable effect is the anchor slot save alone.
2. **Crash safety.** In this order, one task each:
   1. `mls`: `carryReceiveProgress`; `persist` carries an `AdoptionWrite`;
   2. `mls-hub`: `consume` and `receipt`;
   3. `ControlStore`, the co-commit contract and its conformance suite;
   4. operations and outcomes;
   5. the revoke hold;
   6. Welcome obligations;
   7. `applied` and `responses` rows, effects from durable state and the anchor landed mark;
   8. rejoin records.

   Each module lands with its crash rows green.
3. **Band move.** The band moves from 0.10 to 0.11. Kubun adoption is out of scope here, as in the
   parent: when it happens, `store-p2p` implements `ControlStore` and `deliverWelcome`, commits an
   `AdoptionWrite` in its state-save transaction and drops the commit cursor from `AppOutbox`;
   `plugin-p2p` moves to `enqueue` and `outcomes`, and its registry merge extends to every retained
   epoch (`kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:570`).

## Spec P r16 amendments

These changes supersede this historical baseline, including its trust assumption, interfaces, crash/tests and risks.
[Spec P r16](2026-10-08-spec-p-transactional-persistence.md) is normative for signatures and conformance, including the r16 decisions below.
Baseline source citations refer to the pre-landing snapshot; new citations below were verified on feat/spec-p-phase-2.

- **Trust/fork halt (r14 decision).** Trust the strongly consistent hub for ordering/CAS and availability, never confidentiality/authenticity.
  Either fork branch durably halts sends (including ephemeral) and control, keeps history and co-writes a machine-readable `group:fork` event.
  Restart and event ack cannot lift the halt. Remove losing-fork automatic recovery (`packages/rpc/src/peer.ts:1512`) and exclude forks
  from the automatic trigger (`packages/rpc/src/peer.ts:3053`); no winner-continuation, automatic fork settlement or reenactment.
  Expose epoch authenticators for host out-of-band comparison; consistently isolated split views cannot be detected locally.
- **Stranded/manual recovery (r14 decision).** Non-fork retention/unprocessable gaps and lost MLS state automatically external-resync:
  authenticated sealed GroupInfo, Remove own old leaf + ExternalInit, fresh leaf/tree/generation-zero chains, normal policy and exact-commit confirmation.
  Unknown versions hold, never trigger a bypass. Fork recovery requires persisted host authorisation for a chosen target or already admitted successor;
  application owns hub/topic coordination, which ReInit does not carry. Retain exact external attempts; same-epoch head moves retry bytes,
  changed epoch requires fresh GroupInfo. Drop lower-epoch candidate approval/source-prefix scans. R16 supplies retained recovery trust and handle-independent request/authentication/candidate-restoration signatures.
- **Capture-head binding (r15 decision).** The sealed, signed reply attests required `captureHead` alongside the exact GroupInfo digest.
  Spec P D1 defines its encoding and v1/missing-field refusal. Initial external CAS uses `expectedHead = captureHead`.
  After exact-acceptance search, complete mismatch reconciliation either retries identical bytes/ID or discards unadopted after a valid epoch move.
  Stale GroupInfo never installs. GroupInfo has no capture-epoch receiver secrets, so unavailable validation state holds the attempt unadopted.
  General encrypted poison-only retry after secret loss is impossible with this field alone. Spec P adds conformance for both branches.
- **Database loss (r15 decision).** Total loss needs no spent set only when every ordinary/last-resort Welcome private key is also lost.
  KeyPackage sources MUST share group state's provider/transaction/loss boundary. Current host-injected stores require that contract change.
  Before startup after rollback, `declareRestoredFromBackup()` writes device restore-work in one transaction (r16 decision).
  Every restored group needs fresh-leaf external resync into a new incarnation before sends. Fork/admission policy still applies.
  Discard restored unused/last-resort packages, rotate and revoke hub copies where supported. Current hubs leave undecryptable stale invitation copies.
  Every restored outbox entry fails with a durable `database-restored` event, including settlement obligations, overriding normal published settlement.
  Undeclared backup restore is outside the model. Spec P defines total-loss/restore/crash conformance.
- **Incarnations/admission (r14 decision).** Successful same-group recovery/readmission atomically tombstones n and installs n+1.
  Every epoch-keyed namespace/order/watermark binds incarnation. No lineage/floor, in-place replacement exception, recovery HWM/progress merge,
  displaced-row retirement or local ordinal machinery. Old outcomes/Welcomes remain under n; new control/anchor/cursors start fresh.
  Spent authenticators survive at group level; installation appends atomically, Welcome/seed/resync refuses exact/alternate spent identities.
  Tombstones admit unspent Welcomes without an epoch floor; fork halts require manual recovery. Ordinary consumption co-commits installation (r16 decision).
- **Commit-once (r14 decision).** D3/operations.ts no longer returns absent mismatch to intent at unchanged epoch
  (`packages/rpc/src/control/operations.ts:194`). Save exact payload/ID/candidate/journal before handoff. Search/reconcile first;
  unchanged incarnation/epoch/authenticator republishes identical bytes/ID at refreshed head. Build again only after epoch change.
  Keep candidate/keys/referenced proposals; preserve ordinary ratchet progress; omitted proposals need reproposal; control builders use empty proposals.
  Delete handshake reservations/budget/error/baseline/staging-clone rules. Lost/unknown/deadline/ack retain the source-epoch slot.
  Deadline stops handoffs: proven first-valid acceptance lands, superseded/complete absence loses, incomplete coverage/fork-touched work yields unknown (r16 decision).
- **Transactions/fairness (r14 decision).** Every durable transition writes all affected namespaces/opted-in effects in one group transaction.
  Build/publish/fetch/confirm stay outside short transactions; remove internal cross-store commit-order seams.
  Defaults: 64 streaming frames, 2 ms coalescing bound, 8 ms work budget; idle lone frames start immediately.
  Release scope between batches and interleave control, other lanes and enqueue. A/B/control fixture completes low-rate B/control
  within three total batches including active A. No cross-group scheduler lock. Completion barriers retain one coordinator and both hook queues.
- **Handlers/terminal (r14 decision).** Default at-least-once handlers run outside transactions with stable idempotency keys.
  Opt-in handlers co-write effect/completion/cursor through the group transaction, without network I/O, for exactly-once effects in a shared DB.
  MessageStore is one such handler. Live/restarted self-removal drains every opened handler/completion before terminal clearing, without new opens.
  Ephemeral requests/responses/signals create no outbox/pending persistence or transactions; they use pre-reserved application leases.
- **Outbox/retained gates (r14 decision).** Switch fails unpublished entries with durable status/events and original retry data; no automatic reseal.
  Certified entries settle published, preserving sealed topicID and inside-gate identity/version/attempt revalidation. Host history survives.
  Keep v2 sender-zero/sourceState codecs refusing v1, all-namespace host at-rest seal/open(aad), raw-byte/wrong-AAD/mutation/swap/side-row tests.
  Phase 2 supplies memory contracts, both suites, mls-rpc/hub-client and real HTTP smoke with injected DID;
  phase 3 supplies sqlite/postgres providers with explicit group transaction scope. Old fork-healing crash rows become halt/manual-recovery rows.

- **First-valid occurrence (r16 decision).** `packages/rpc/src/peer.ts:2128` must not return a match before prefix coverage/validation.
  `packages/rpc/src/control/operations.ts:192`, `:235` require persisted first-valid proof before acceptance/adoption or Welcome release.
  Earlier valid competitor at the framed epoch means lost/superseded; cursor/state follows it. Incomplete coverage holds/unknown.
  Any commit-topic publisher can replay bytes under another publishID. Later proven losers are superseded, not fork evidence.
  Conformance: competitor wins CAS, own exact payload replayed later; never adopt/release Welcome.
- **Welcome package transaction (r16 decision).** Installation spans group + device package/receipt namespaces, burning ordinary private material atomically.
  Only package-pool rows require device serialisation. Concurrent cross-group Welcomes admit exactly one, including ambiguous COMMIT.
  Last-resort packages remain reusable; spent authenticators protect replay. Remove incarnation joinRef obligations/clear API.
  Hub-copy cleanup uses device retry rows surviving retirement/tombstones. Restart completes supported cleanup without making a key reusable.
  Current hub cannot eagerly revoke ordinary copies; unsupported removal retains the fetch/expiry residual.
- **Recovery/restore boundary (r16 decision).** Every epoch installation co-writes retained group trust: genesis anchor, signer tree/membership and spent set.
  State unreadable/trust intact permits automatic resync without a source handle. Trust unreadable too halts/events; manual re-invite required.
  DevicePersistence owns groups/packages/last-resort/trust/cleanup/restore-work; registry receives provider identity and package adapters explicitly.
  Startup idempotently invalidates/rotates packages, queues revocation retries, holds each group for resync and fails restored outbox before deleting work.
  Hozon root/scope/barrier and deferred rollback-hook settlement remain phase-3 prerequisites (`../hozon/packages/db/src/db.ts:275`).
- **Consumer adapters (r16 decision).** Spec P defines registry HandleAccess mutate/replace/open, crypto/MLS adapters and incarnation/version expectations.
  Pre-open references lack procedure; staging derives authenticated procedure/idempotency keys and commits malformed plaintext as consumed-key poison.
  Handler registration uses the public policy union/completion runner; conformance uses concrete TPorts, mixed-result crypto and metadata/retention propagation.

## Out of scope (P2b)

- Epoch views, past-epoch opens, fences, view records and lineage invalidation.
- Removing deliver-before-ratchet, the shared lock, `rebuildEpoch` and `runExclusive`.
- The `@kumiai/group-lifecycle` package and the `host-boundary` split.
- Configurable key retention.
- Voluntary departure through `proposeSelfRemoval` / `commitSelfRemovals` (mls 0.10.2,
  `mls/src/group-lifecycle.ts:42-54`). The proposal mutates the live handle without `persist` and
  blocks application encryption until committed; neither rpc nor mls-rpc calls these today. Adopting
  them needs a durable operation kind of its own. Being removed by another member's commit, which
  this spec covers, is unchanged.

## Risks

- **Work inside `peer.ts`.** It is about 2,900 lines with crossing concerns. D1's module rule keeps
  the new code out of the closure. The phase 1 probe maps every touched site first.
- **Kubun breakage.** The band move breaks Kubun's `CommitJournal`, `takeLost` and cursor use; its
  adoption is a separate change.
- **Hosts must share one database** for state, anchor and control. A host that cannot loses the
  crash guarantees; the conformance suite's co-commit case is the gate.
- **Responder confirmation window.** Resumed confirmation works only while some member is still at
  the candidate's epoch. Past that it degrades to today's orphan-and-rejoin.
- **64-epoch fork window.** An older fork goes undetected until other evidence strands the device.
- **`lost`, `landed` and "lands once" against a hostile hub** are relative to the branch served.
  Global absence or uniqueness is not provable; a ledger operation can land on two branches.
- **Fork outcomes are `unknown`.** Hosts read the rejoined roster and `reenact` for the truth. A
  forged conflict costs a heal, never a false outcome.
- **Revoke publish window.** A publish already in flight when the hold is set can still reach the
  member being removed, as today.
- **Holder evidence (mls 0.10.2).** A chained leaf without valid controller-signed holder evidence
  refuses `build`, incoming commits and Welcome joins (`mls/src/authentication.ts:233`,
  `mls/src/group-welcome.ts:84`). These surface as `rejected` outcomes, rejoin refusal or a failed
  Welcome admission; no new outcome kind is needed, the `holder evidence` test row covers each. A
  delivered Welcome obligation still does not prove admission.

## Review log

- **Carried from the combined P2 draft (r1 to r3).** Its review log lists the Codex findings behind
  D2 to D6. Findings about epoch views stay with P2b.
- **r1, Codex (blind), 2026-10-08.** Six blockers plus implementation notes; a Claude agent confirmed
  all six (two with overstated consequence) and the notes, refuting none.
  - Blockers:
    - fork evidence was lost on a crash before rejoin. Now `ForkEvidence` is written with the
      strand, and `deleteAppliedFrom` drops losing rows;
    - reconciliation dropped the `ExternalResponse`. The receipt now carries `external` and
      `epochAfter`, and reconciliation writes the response;
    - a same-number rejoin saved before anchor resolution forced a second rejoin. Reconciliation
      now runs before anchor resolution and completes the rotation;
    - the source-head check relied on memory. `source.head` is persisted, with an explicit re-check
      rule after restart;
    - winner rows could not be built from log presence. Settlement now rests on MLS parent binding
      (verified in ts-mls): `reverted` at or above `forkEpoch`, else `landed` or `unknown`;
    - the hold promised more than today. It is now scoped to retained log submissions, as today.
  - Notes:
    - scheduling outside `runSerial`, gates before `build`, and the `commit()` contract;
    - carry runs within one task too, under the handle's write gate;
    - `processCommit` reports `applied`, and self-removal writes a receipt;
    - `superseded` keeps today's fresh retry;
    - every request-key reader moves to the record;
    - one head-mismatch rule;
    - eight crash seams added.
- **r2, Codex (blind), 2026-10-08.** Five blockers and one high finding. A Claude agent confirmed
  the five and found the sixth partial, refuting none.
  - Blockers:
    - fork settlement could mark the winner `reverted`. At the divergence epoch both commits share a
      parent, and the conflict epoch is not the divergence point. `reverted` is gone; fork-touched
      operations settle as `unknown`, and the rejoined state is the authority;
    - a hostile hub could forge fork evidence below the current epoch. Evidence now triggers a heal
      only, never an outcome;
    - an acked receipt skipped unfinished removal or anchor repair. Effects now key on the receipt
      and their own state, not on `receiptAck`;
    - the recovery branch skipped the row, cursor and ack, and `deleteAppliedFrom` would delete the
      rejoin's row. Both branches share one bookkeeping `apply`; deletes run before puts;
    - live reconciliation ran too late. It now runs at the start of every lane task.
  - The source re-check now has an exact, read-only predicate; conservative invalidation is an
    accepted cost.
  - Notes: explicit startup order (anchor load, `restorePending`, subscribe, gate exemption);
    "lands once" is honest-hub only; six crash and test rows added.
- **r3 step back, 2026-10-08.** Sorting the twelve r1 and r2 blockers by cause showed five came from
  one choice: control in its own atomic store, apart from the group state, rejoined by a hand-built
  receipt and reconciliation. Spec P already commits several stores in one root transaction. r4
  commits each adoption's control changes and anchor mark with its state, which removes the receipt,
  `receiptAck`, reconciliation, the live bookkeeping failure, and their crash rows. Effects
  (removal, anchor resolution) now run from durable state. Spec P's same-number anchor ambiguity
  goes with the landed mark.
- **r4, Codex (blind), 2026-10-08.** No finding came from the old receipt design; fork settlement and
  `carryReceiveProgress` held. Two blockers, three high and three medium; a Claude agent confirmed
  seven and found one partial, refuting none.
  - Blockers:
    - Welcome re-admission bypassed the adoption rule. It is now a remove-then-join with an explicit
      control and anchor reset;
    - removal cleanup deleted unacked outcomes and Welcome obligations, and today's removal path
      does not delete the group. Deletion now keeps both; a removed group is terminal.
  - High:
    - anchor resolution published memory before saving, a defect today. It now saves first;
    - two key readers had no record. Keys now belong to their attempt and are passed explicitly;
    - the pending-recovery log barrier was memory-only. It is rebuilt from the durable record.
  - Medium: the write factory runs on the staged handle; startup separates subscription, holds,
    the seed pull and `buildEpoch`; `ExternalResponse.epoch`, response pruning, and a deadline that
    survives restart.
- **r5, Codex (blind), 2026-10-08.** One blocker, three high and three medium. A Claude agent
  confirmed six and found one partial, refuting none. Three came from text added in r5.
  - Blocker: r5's startup pulled before replay, so the device stranded on its own accepted commit.
    Settling `built` and `accepted` work, and the rejoin's barrier, now come before the seed walk.
  - High:
    - the rejoin's row could overwrite an own row before settlement read it. Settlement now runs in
      the rejoin's adoption transaction;
    - host deletion dropped unsettled work, and nothing served a tombstone's records. Deletion is now
      refused while control is unsettled, with `abandon()` as the way out.
  - Medium: the source re-check is bounded by the rejoin's position; the registry owns adoption
    ambiguity; self-removal writes no landed mark; crash rows narrowed and six added.
