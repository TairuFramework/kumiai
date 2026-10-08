# Spec P2a: crash-safe group control — design

Date: 2026-10-08
Status: draft r2
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
Siblings:
- [Spec P, transactional persistence](2026-10-08-spec-p-transactional-persistence.md) (its D5 moves
  here).
- [Spec P2b, epoch views and the lifecycle package](2026-10-08-spec-p2-group-lifecycle-design.md),
  which builds on this spec.

P2a makes group control crash-safe in `@kumiai/rpc` as it is structured today. "Control" means
commits, recovery, forks and Welcomes. Every operation, rejoin, outcome, owed Welcome and applied
commit is recorded in a transactional `ControlStore`, and replayed from it per stage. P2a keeps
today's structure: one commit mutex, deliver-before-ratchet and the single-slot anchor store. That
structure is what lets it skip epoch views, fences and view records. Spec P2b then removes the
coupling, with P2a's crash suite as its regression net.

Split from the combined P2 draft at r3, after three blind review rounds; that draft's review log
records the findings carried here.

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
  `rpc/src/control/{store,operations,rejoin,welcome,forks,receipt}.ts`. Each takes its dependencies
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
  - `takeLost` goes (D7).
- **Ports.**
  - `ControlStore` (D2) is new in rpc, and `rpc-conformance` re-declares it.
  - `GroupMLS` gains the recovery methods (D6), and `mls-rpc` implements them.
  - `mls` gains `carryReceiveProgress` (D3) and the adoption receipt in its saved state (D5).
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
  receiptAck: string | null             // `adoptionID` of the last reconciled receipt (D5)
  cursor: CommitCursor | null           // {position, epoch, stranded?, fork?}
}
/** Durable with the strand: the evidence fork settlement needs after a restart. */
export type ForkEvidence = { forkEpoch: number; sharedPosition: LogPosition | null; frameDigest: string }
export type ControlChanges = {
  putOperations?: Array<Operation>; deleteOperations?: Array<string>
  putRejoin?: RejoinRecord; deleteRejoin?: true
  putOutcomes?: Array<Outcome>; deleteOutcomes?: Array<string>
  putWelcomes?: Array<WelcomeObligation>; deleteWelcomes?: Array<string>
  putApplied?: Array<AppliedCommit>; deleteAppliedFrom?: number   // drops rows at epoch >= n
  putResponses?: Array<ExternalResponse>
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

- **Writers.** The peer is the only writer and serialises every `apply`. On
  `StorageOutcomeUnknownError` it reads `lastMutation()`, with backoff capped at 15 s: equal means
  committed, anything else means not. The peer stays paused until that read succeeds.
- **`applied` and `responses` windows.** The peer keeps the newest 64 epochs of each and prunes
  older rows in the same `apply`.
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

The host supplies `build(op)` and `adopt(journal, expected, receipt)`.

- **`build(op)`** returns `{commit, bodies, journal, welcome}` and must not mutate. It builds
  against the current handle, under the peer's commit mutex as today.
- **`adopt(journal, expected, receipt)`** runs under the commit mutex and must be idempotent:
  - **no-op** when the current state's epoch and `epochAuthenticator` already equal the
    candidate's;
  - **installs** only when the current state matches `expected = {epoch, authenticatorBefore,
    lineage}`, with a compare-and-set on the stored state version;
  - otherwise reports **`moved`** and writes nothing.

  Installing **preserves ratchet progress**. Opens and seals at `E` happen between build and adopt
  even inside one task: `advanceHandle` drains app frames after build and before ratcheting
  (`rpc/src/peer.ts:1161`), and live inbound opens and seals bypass `runSerial`
  (`rpc/src/peer-epoch.ts:158, 216, 365`). A durable operation also outlives its task: a publish
  error keeps it `built`, and replay after a restart adopts what an earlier process built. Opens
  advance the secret tree, and so do seals (`ts-mls/dist/src/createMessage.js:100-101`). The candidate holds the trees
  snapshotted at build (`ts-mls/dist/src/createCommit.js:84`). After the identity check and before
  saving, and under the handle's own write gate (`mls/src/group-handle.ts:82`) so no open or seal
  interleaves, `adopt` copies the current state's whole `secretTree`, sender and receive progress alike,
  into the candidate's history at `E`, and the current historical tree of every earlier epoch the
  candidate also retains. It keeps the candidate's `E + 1` state, and resurrects no epoch the
  current state has evicted. Every change in between goes through the same handle, so the current
  trees are strictly newer and a copy is enough. Skipping it would reuse sender generations. Today
  `mls-rpc` refuses opens at earlier epochs (`mls-rpc/src/crypto.ts:188`), so the earlier-epoch
  copy is a no-op until P2b; it is specified now so P2b need not revisit `adopt`. `mls` provides this as
  `carryReceiveProgress(candidate, current)`. Rebuilding the commit at adoption is not an option:
  update paths use fresh randomness (`ts-mls/dist/src/updatePath.js:26`), so the bytes would differ
  from the accepted ones.

  The save writes the **adoption receipt** (D5) into the group state record in the same
  transaction.

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
   - **Installed or no-op:** in one `apply`, delete the operation, `putOutcomes([landed])`,
     `putApplied({epoch, digest, payloadDigest, sequenceID, opID})`, set `receiptAck`, and set the
     cursor to `acceptedAs`. The peer
     rebuilds the epoch, as today.
   - **`moved`:** acceptance is evidence that the hub served the commit, not that this device's
     branch contains it. The `applied` rows and the cursor are left alone. The peer pulls the log
     and compares the `applied` row at `built.epoch` (rows are keyed by the commit's framed epoch,
     as the classifier keys them today, `rpc/src/peer.ts:1560`):
     - same `digest`: the commit was already adopted from the log. Write `landed` and delete the
       operation;
     - a different digest, or a log that does not show the commit on this device's branch: fork
       evidence. The operation stays `accepted`, the device strands (D5), and the rejoin's final
       `apply` (D6) resolves it against the winning branch (D5): `landed`, `reverted` or
       `unknown`.

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

**Replay at `start`** works per stage, after the D5 receipt reconciliation:

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
  | { kind: 'unknown' }                    // absence not provable
  | { kind: 'reverted'; position: LogPosition }   // accepted on a losing fork branch
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

### D4. Welcome obligations

**Inviter side:**

- A `WelcomeObligation` is `{opID, welcome, recipients}`. It is written with `accepted` (D3 step 3).
- `welcome` is the **complete host-encoded invitation artifact**: the MLS Welcome plus the invite and,
  when needed, the ratchet tree (`mls/src/group-welcome.ts:50-55`). Raw Welcome bytes are not
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

### D5. Commit log, forks and strands

- **`applied` rows.** An `AppliedCommit` is `{epoch, digest, payloadDigest, sequenceID, opID: string
  | null}`, keyed by the commit's framed epoch. One is written for each adoption, own or incoming, so
  fork classification survives a restart.
- **Responder outcomes** are separate: an `ExternalResponse` is `{position, digest, kind: 'applied'
  | 'refused' | 'superseded', reason?: RecoveryRefusal, epochAfter?: number}`, keyed by log position as today
  (`rpc/src/peer.ts:935-940, 1563-1564`). Several refused external commits can share one epoch
  without adopting anything, and the reason separates renewal from policy refusals
  (`mls/src/recovery-verdict.ts:24, 32`). It is written in the same `apply` as the cursor skip.
- **Adoption receipt.** The MLS state and the `ControlStore` are separate atomic ports (Spec P D2), so
  an adoption and its `applied` row cannot share one transaction. Instead:
  - every adoption saves the receipt `{adoptionID, kind: 'commit' | 'recovery', epoch, epochAfter,
    lineage, digest, payloadDigest, position, external: boolean, removed: boolean, rejoinID?}` in
    the group state record, in the same transaction as the new state (Spec P
    `GroupStateRecord.lastApplied`). `adoptionID` is random per adoption; `epoch` is the framed
    epoch. Every later state save, app saves included, carries `lastApplied` forward unchanged;
  - `GroupMLS.processCommit` takes the receipt metadata and reports `applied` separately from epoch
    advancement. Today `mls-rpc` discards `ApplyCommitResult.applied` (`mls-rpc/src/mls.ts:333`),
    and a self-removal applies without advancing the epoch (`mls-rpc/src/apply-commit.ts:133-143`);
    it still writes a receipt with `removed: true`;
  - the peer then writes the `applied` row, the cursor and `receiptAck = adoptionID` in one
    `apply`, and adopts nothing else until that `apply` has committed. At most one adoption is ever
    unrecorded;
  - **reconciliation** runs at `start`, before anchor resolution, classification or replay, and
    also before the next adoption whenever a live bookkeeping `apply` failed. It compares the
    receipt's `adoptionID` with `receiptAck`. Epoch numbers are not compared: a self-removal keeps its epoch,
    and a fork-healing rejoin can land on an epoch number already recorded
    (`rpc/src/peer.ts:2591-2592`). If they differ:
    - `commit`: in one `apply`, write the row, the cursor and `receiptAck`; turn an `accepted`
      operation with the same `payloadDigest` into `landed`; for `external: true`, write the
      `ExternalResponse` `applied` with `epochAfter`, which confirmation requests need and which a
      later pull cannot rebuild once the cursor has passed the frame (`rpc/src/peer.ts:968, 1511`).
      Then rebuild the runtime, and for `removed: true` run today's removal path;
    - `recovery`: the rejoin record named by `rejoinID`, still at `confirmed`, moves to `adopted` in
      the same `apply`, before D6 replay can run its source re-check. The pending anchor rotation is
      then completed as landed (`resolveAnchorRotation`, as `advanceHandle` does today,
      `rpc/src/peer.ts:1197`), clearing `anchorRecoveryPending`, and the runtime is rebuilt, all
      before bootstrap.
  - **Startup order:** load control and the receipt; reconcile; resolve the anchor
    (`rpc/src/peer.ts:2783`); restore the holds; replay operations and the rejoin; start delivery.
    Today startup resolves the anchor first, which would call `requireAnchorRecovery` for a
    same-number rejoin whose save had in fact committed (`rpc/src/peer.ts:425`).
- **Fork window.**
  - The window covers 64 epochs.
  - A forked frame older than the window classifies as `history`. That is an accepted blind spot: the
    device stays on its branch until other evidence (`ahead`, a gap) strands it.
- **Stranding** writes `cursor.stranded = true`, and for a lost fork `cursor.fork` (the
  `ForkEvidence`: the losing frame's epoch, the last shared position and the competing frame's
  digest), in one `apply` with the durable position unchanged, as `persistStrand` does today (`rpc/src/peer.ts:704-715`). It holds sends, as today's strand hold
  in `held()` (`rpc/src/peer.ts:586-594`), and requests a heal.
- **Losing a fork at epoch `E`** (`forkEpoch` from `cursor.fork`) is resolved by a rejoin (D6).
  Settlement needs no winner history, which the recovery candidate does not carry
  (`mls-rpc/src/recovery.ts:39-46`) and log presence cannot establish (refused, poison and superseded
  frames share framed epochs, `rpc/src/peer.ts:1539, 1563`). It rests on MLS binding every commit to
  its parent state: a commit built on one branch is rejected by every member on another, through the
  sender-data AEAD or membership tag, the `GroupContext`-bound signature, and the confirmation tag
  (`ts-mls/dist/src/messageProtection.js:102, 122`, `messageProtectionPublic.js:87-93`,
  `processMessages.js:192-199`). The rejoin's final `apply`:
  - every losing `applied` row (framed epoch at or above `E`) that carries an `opID`, and every
    operation still `accepted` whose `built.epoch` is at or above `E`: `reverted`. Its parent state
    is on the losing branch, so no winning member can have applied it;
  - every operation still `accepted` whose `built.epoch` is below `E`: `landed` if an `applied` row
    on the current chain carries its `digest`, otherwise `unknown`;
  - `deleteAppliedFrom: E`. No winner rows are written; rows resume with the rejoin's own adoption.
    Fork classification below the rejoin epoch is lost for that range, as for the 64-epoch window.
- **Cursor.** The commit cursor moves into `ControlStore` and advances in the same `apply` as the
  `applied` row or skip it records. Only a recorded adoption or skip moves it, so it never regresses.

### D6. Rejoin

```ts
export type RejoinRecord = {
  /** Random per rejoin; the D5 receipt's `rejoinID`. */
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
| `built` | before publishing the external commit | republish the stored `payload` under the same ID. Accepted or deduplicated: `published`. Head mismatch: search the log for `payloadDigest`; found means `published` at that position; absent from the branch served means delete the record and start afresh (relative to that branch, as `lost` in D3) |
| `published` | publish accepted | re-send the confirmation request with the stored `request`, and open verdicts with `requestKey`. Authoritative confirm: `confirmed`. Authoritative refusal requiring renewal: delete the record and start a fresh rejoin with renewal. Refusal by policy or as invalid: write stage `refused` with its reason and a `refused` outcome in one `apply`. Authoritative `superseded`: discard the candidate, delete the record and start a fresh rejoin from fresh GroupInfo, as today (`rpc/src/peer.ts:2550-2551`, `tests/integration/test/recovery-confirmation.test.ts:438`). `unconfirmed` or deadline: delete the record and start a fresh rejoin; the orphan leaf is replaced, as today (`tests/integration/test/recovery-confirmation.test.ts:306`) |
| `confirmed` | verdict verified | D5 receipt reconciliation runs first, and moves the record to `adopted` if its adoption already committed. Otherwise **re-check**: the current state must still equal `source` (epoch, authenticator, lineage), no adoption may be pending, and the log must show no adoptable commit after `source.head`. `source.head` is the in-memory reconciled head at rejoin build (`rpc/src/peer.ts:2460`), persisted because a strand keeps the durable cursor behind it (`rpc/src/peer.ts:716`). After a restart the peer pulls from `source.head`: frames this rejoin's own external commit, and frames the reader skips without adoption (malformed, refused, superseded, `rpc/src/peer.ts:1539, 1563`), do not fail the check. Any other commit frame does, as today's equality check (`rpc/src/peer.ts:2563-2571`). A retention gap after `source.head` also fails it. If not, the candidate is **invalidated**: delete the record and start a fresh rejoin only if evidence still calls for one. Otherwise `restoreRecovery(candidate, requestKey).onAccepted()`, idempotent by `epochAuthenticator`. Adoption uses the recovery identity (`epochAfter`, `forced: true`, `recovery: true`, `rpc/src/peer.ts:2607`) and writes the D5 receipt. Then `adopted` |
| `adopted` | host replace done, or receipt reconciled (D5) | bootstrap the ledger, then one `apply`: `reenact` outcomes for `ledgerBefore` tokens missing from the group ledger; fork settlement from `forkEpoch` (D5); clear `stranded`; delete the record |
| `refused` | policy or invalid refusal | terminal and durable: sends stay held and no automatic rejoin starts, across restarts and after the outcome is acked. Cleared only by the host calling `recover()`, which deletes the record and starts a fresh rejoin. Today's latch is memory-only (`rpc/src/peer.ts:758, 2356`) |

**Rules:**

- **Settle operations first.** Before writing a rejoin `built`, the peer settles the queue head:
  - a `built` operation is republished or searched (D3);
  - an `accepted` one is adopted, or kept `accepted` on `moved` for the rejoin to resolve.

  The queue then pauses until the rejoin record is deleted. Incoming commits are still adopted while
  a record is `published`; the `confirmed` re-check catches any that moved the state.
- **New `GroupMLS` methods:**
  - `createRecoveryRequest` returns `{request, requestKey}`;
  - `restoreRecovery(candidate, requestKey)`;
  - `PendingRecovery.serialize()`.

  The 120 s map goes. Every reader of it takes the key from the record instead: `applyRecovery`,
  `openRecoveryVerdict` and `openSealedLedger`.
- **Responders confirm at their current epoch only.** A responder re-derives `confirmationKey` from
  `exportSecret`, which reads the current key schedule only (`mls/src/group-handle.ts:890-891`); ts-mls
  retains no exporter secret for past epochs (`ts-mls/dist/src/epochReceiverData.d.ts:11-17`). So a
  responder confirms only while its current epoch equals the candidate's, and stores no secret. Once
  every responder has moved past it, the requester times out and rejoins again. Persisting the
  requester's key makes a restart resume confirmation inside that window; it does not widen it.
- **Responders** record each external commit's outcome, with its refusal reason, as an
  `ExternalResponse` (D5).
- **Anchor.** The anchor store is unchanged. A same-number rejoin still goes through
  `requireAnchorRecovery` (`rpc/src/peer.ts:410-414`), as today.

### D7. Errors

- `OperationRejectedError`: `build` refused. It becomes a `rejected` outcome.
- `StorageOutcomeUnknownError`: from `ControlStore`, resolved per D2.
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
| own adoption saved, before `landed` apply | host `adopt` (state and receipt) | after | receipt reconciled: `landed`, one `applied` row |
| incoming adoption saved, before `applied` apply | MLS state save (state and receipt) | after | receipt reconciled: `applied` row and cursor written before classification; a competing frame at that epoch classifies as a fork |
| same-number adoption saved, before `applied` apply | MLS state save after a self-removal, or a fork-healing rejoin to a recorded epoch number | after | `adoptionID` differs from `receiptAck`: reconciled, never skipped |
| responder refusal, before cursor skip | MLS verdict sent | after | the refusal is judged again and recorded once with its reason |
| strand and fork evidence written, before rejoin `built` | `apply` with `stranded` and `fork` | after | rejoin starts from the stored evidence; settlement uses `forkEpoch` even if the competing frame is never served again |
| external commit adopted, before responder bookkeeping | MLS state save (receipt `external: true`) | after | reconciliation writes `applied`, cursor and the `ExternalResponse` together; a confirmation request is answered |
| same-number rejoin saved, before anchor resolution | host replace (state and receipt) | after | reconciliation completes the anchor rotation; no `requireAnchorRecovery`, sends resume |
| self-removal saved, before host deletion | MLS state save (receipt `removed: true`) | after | removal path runs once |
| ledger bootstrapped, before final rejoin `apply` | `bootstrapLedger` | after | bootstrap is idempotent; `reenact` and settlement written once |
| Welcome accepted by transport, before obligation deletion | `deliverWelcome` | after | delivered again (at least once); the invitee answers `alreadyJoined` |
| bookkeeping `apply` fails live, no restart | `apply` after an adoption | failure injected | the next lane task reconciles before adopting again |
| ambiguous `apply` at acceptance and at receipt ack | `apply` | commit then reject | `lastMutation()` resolves it; one `accepted`, one row |
| Welcome obligation, before delivery | `apply` with `putWelcomes` | after | delivered |
| invitee joined, before consume | host save of the joined group | after | consumed on start; repeat Welcome is `alreadyJoined` |
| invitee consume, mid-transaction | source `consume` | failure injected | package kept, no receipt; consumed on start |
| invitee consumed, before ack | source `consume` | after | repeat Welcome is `alreadyJoined` without decrypt |
| rejoin built, before publish | `apply` with rejoin `built` | after | one external commit, same payload |
| rejoin published, before confirm | hub `publish` (external) | after | confirmation resumes with the stored key while a responder is at the candidate epoch; otherwise a fresh rejoin |
| rejoin confirmed, state moved, before adopt | `apply` with `confirmed`, then an incoming commit | after | candidate invalidated; never installed over the newer state |
| rejoin confirmed, before adopt | `apply` with `confirmed` | after | adopted once with recovery identity |
| rejoin state saved, before `adopted` | host replace (state and receipt) | after | receipt moves the record to `adopted`; bootstrap, `reenact` and fork settlement run; never invalidated |
| rejoin refused by policy, restart, outcome acked | `apply` with `refused` | after | sends stay held and no rejoin starts until `recover()` |
| rejoin adopted, before bootstrap | host replace | after | bootstrap, `reenact` computed from `ledgerBefore` |
| fork loser, restart, winner shown | `applied` rows on disk | — | fork detected; `reverted` and `reenact` outcomes |

## Conformance and tests

| Suite | Case | Assertion |
|---|---|---|
| `testControlStoreConformance` (new, in `rpc-conformance`, replacing the `CommitJournal` suite) | all or nothing | failure injected mid-`apply`: no change visible after reopen |
| | durable | every record kind round-trips across reopen |
| | ambiguous commit | commit-then-reject: `lastMutation()` equals the attempt |
| | outcomes persist until deleted | |
| | secrets | `requestKey` and `candidate` round-trip byte-exact |
| | per provider | memory, node-sqlite, postgres, expo (phase 3 of the parent) |
| `mls` | `carryReceiveProgress` | an open at `E` after build, then adopt: the spent generation does not open again; a seal at `E` after build, then adopt: no sender generation repeats; an evicted epoch is not resurrected |
| `mls-hub` | `consume` atomic (pool store and bundle source) | failure mid-`consume`: the package survives and no receipt exists |
| | re-admission | a held group at `E`, a last-resort Welcome at `E + 3`: replaced; a Welcome at `E`: `alreadyJoined` |
| peer crash tests | every row of the crash-seam table | as stated |
| | Codex r4 blockers | a hub that re-wraps our commit with corrupted bodies never clears an operation; a hub fork accepting our invite on the losing branch gives `reverted`; a crash after rejoin publish never adopts without confirmation; a `built` operation at a moved epoch resolves instead of throwing |
| | `moved` | an operation accepted on a losing branch while the state follows the winner: no `applied` row, no cursor move, outcome `reverted` after the rejoin |
| | rejected revoke | a revoke whose `build` is refused lifts the hold; queued entries publish |
| | revoke hold | no retained log submission is handed to the hub between a revoke's enqueue and its outcome, across restart, except those already handed off before the hold, which `settleLogSubmissions` drains first |
| | two revokes | settling the first keeps the hold while the second is unsettled |
| | fork settlement | an operation built at or above `forkEpoch` gives `reverted` without reading the log; one built below it and absent from the current chain gives `unknown` |
| | refused rejoin | a policy refusal writes `refused` and keeps sends held; a renewal refusal starts a fresh rejoin |
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
   - the Kubun call sites for `commit()`, `takeLost` and the journal.
2. **Crash safety.** In this order, one task each:
   1. `mls`: `carryReceiveProgress` and the receipt;
   2. `mls-hub`: `consume` and `receipt`;
   3. `ControlStore` and its conformance suite;
   4. operations and outcomes;
   5. the revoke hold;
   6. Welcome obligations;
   7. `applied` and `responses` rows and receipt reconciliation;
   8. rejoin records.

   Each module lands with its crash rows green.
3. **Band move and Kubun.** The band moves from 0.10 to 0.11. Kubun's `store-p2p` implements
   `ControlStore` and `deliverWelcome`, and drops the commit cursor from `AppOutbox`. `plugin-p2p`
   moves to `enqueue` and `outcomes`, and its registry merge extends to every retained epoch
   (`kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:570`).

## Spec P amendments

Reconciled API by API:

- D5 (commits, intents, adoption, Welcome) is removed. P2a's D3, D4 and D6 replace it. Its Welcome
  admission rules, tombstone floor included, move to P2a D4.
- `GroupStateStore` keeps `epochAuthenticator`, `lineage` and `joinRef` (now `{sourceID, ref}`),
  and gains `lastApplied` (the D5 receipt), saved in the same transaction as the state.
- Removed from `GroupStateStore`: intents, `WelcomeObligation`, `putWelcome` / `listWelcomes` /
  `clearWelcome`, and `GroupStateWrite.putWelcome`. `delete` stops clearing intents and
  obligations; the peer settles those in `ControlStore` when it observes its removal.
- The commit cursor leaves `AppOutbox` for `ControlStore`.
- The crash seams and conformance rows for D5 (intents, Welcome obligations, `onJoined`) move here.
  Spec P's tombstone-floor row stays, and P2a's `mls-hub` re-admission row covers the Welcome side.

## Out of scope (P2b)

- Epoch views, past-epoch opens, fences, view records and lineage invalidation.
- Removing deliver-before-ratchet, the shared lock, `rebuildEpoch` and `runExclusive`.
- The `@kumiai/group-lifecycle` package and the `host-boundary` split.
- Configurable key retention.

## Risks

- **Work inside `peer.ts`.** It is about 2,900 lines with crossing concerns. D1's module rule keeps
  the new code out of the closure. The phase 1 probe maps every touched site first.
- **Kubun breakage.** Phase 3 is one coordinated change.
- **Responder confirmation window.** Resumed confirmation works only while some member is still at
  the candidate's epoch. Past that it degrades to today's orphan-and-rejoin.
- **64-epoch fork window.** An older fork goes undetected until other evidence strands the device.
- **`lost` against a hostile hub** is relative to the branch served; global absence is not provable.
- **Revoke publish window.** A publish already in flight when the hold is set can still reach the
  member being removed, as today.

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
