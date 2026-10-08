# Spec P2: group lifecycle — epoch views and crash-safe control — design

Date: 2026-10-08
Status: draft r1
Parent: [client host, messaging protocol and multi-device e2e](2026-10-08-client-messaging-e2e-design.md)
Sibling: [Spec P, transactional persistence](2026-10-08-spec-p-transactional-persistence.md) (its D5
moves here)

P2 separates group lifecycle from the app lane, and makes the lifecycle crash-safe. "Lifecycle" here
means commits, recovery, forks and Welcomes. Today both concerns share one closure in
`packages/rpc/src/peer.ts`, so they also share one lock and one set of mutable state. P2 has two parts:

- **Root-cause fix.** Lifecycle publishes one immutable **epoch view** per adopted epoch. The app lane
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
- **`HubMux`, `host-boundary`, `cursor`** and the shared errors move to lifecycle, or to `hub-client`
  where they are hub-generic. Phase 1 decides each file.
- **`createGroupPeer`** stays in rpc as a thin assembler. It returns today's `GroupPeer` surface where
  the meaning is unchanged, so Kubun migrates once.
- **`mls-rpc`** implements lifecycle's `GroupControlMLS` port and rpc's narrower `EpochCrypto`.

### D2. Epoch views

```ts
export type CloseReason = 'superseded' | 'stranded' | 'revoking' | 'removed' | 'recovering' | 'disposed'

export type EpochView = {
  epoch: number
  anchor: Anchor
  topics: AppTopics
  floor: EpochFloor
  /** Admission snapshot; `admissible: false` carries the reason. */
  admission: SendAdmission
  /** Rejects with `EpochClosedError` once `sendsClosed` has resolved. */
  seal(entry: AppEntry): Promise<SealedAppFrame>
  /** Valid until `release()`; `ref` requests a durable open (Spec P D3, `saveOpened`). */
  open(frame: AppFrame, ref?: AppFrameRef): Promise<OpenedAppFrame>
  sendsClosed: Promise<CloseReason>
  /** The app lane will open nothing more at this epoch. Idempotent. */
  release(): void
}

export type GroupLifecycle = {
  start(): Promise<void>
  /** One view per adopted epoch, in order, starting with the current one. */
  views(): AsyncIterable<EpochView>
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

Rules:

- **Opening.** The app lane routes each frame by the epoch in its cleartext header:
  - a frame for a leased view opens through that view;
  - a frame for a newer epoch is buffered until that view arrives;
  - a frame for a released epoch is dead.

  Opening never consults the live handle. Opens at past epochs serialise on the `mls` handle's own
  mutex (`mls/src/group-handle.ts:960`), not on a peer lock.
- **Retention lease.**
  - `client` and the lifecycle set `retainKeysForEpochs: 8` on the `MlsContext`. Spec P D3 makes key
    retention configurable and carries it through every constructor.
  - Lifecycle does not adopt epoch `E + 8` while the view for `E` is unreleased. Adoption awaits the
    release: backpressure by promise, with no shared lock.
  - The app lane releases a view once it has drained every frame it fetched at that epoch and the view
    is not the newest.
- **Sending.**
  - The outbox seals against the newest view only.
  - When `sendsClosed` resolves, unproven entries wait for the next view and are re-sealed. That is
    rpc's existing re-seal-until-proof path (`rpc/src/log-delivery.ts:145-207`).
  - Nothing orders app publishes against commits: a frame sealed at `E` and published after the
    commit to `E + 1` still opens at receivers, who retain `E`.
- **Closing sends.**
  - `superseded`: the next epoch was adopted.
  - `stranded`: the commit log shows this device is off the line.
  - `revoking`: a remove or revoke operation was enqueued. Sends close at enqueue, before the commit.
    This replaces `holdLogSends` and `settleLogSubmissions`.
  - `removed`: this device is no longer a member.
  - `recovering`: a rejoin record exists.
  - `disposed`.
- **Topics.** A view whose anchor differs from the previous view's carries new `topics`. The app lane
  re-subscribes on receipt. This replaces `captureAnchor`'s direct `appLane.reset()`.
- **No shared lock.**
  - Lifecycle serialises its own work.
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
  cursor: CommitCursor | null           // {position, epoch, stranded?}
}
export type ControlChanges = {
  putOperations?: Array<Operation>; deleteOperations?: Array<string>
  putRejoin?: RejoinRecord; deleteRejoin?: true
  putOutcomes?: Array<Outcome>; deleteOutcomes?: Array<string>
  putWelcomes?: Array<WelcomeObligation>; deleteWelcomes?: Array<string>
  putApplied?: Array<AppliedCommit>
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
- **`applied` window.** Lifecycle keeps the newest 64 epochs and prunes older rows in the same
  `apply`.
- **Secrets.** `RejoinRecord.requestKey` and the candidate blob are secrets: the Hozon implementation
  encrypts them at rest (Spec P).
- **Isolation.** Spec P's provider and transaction rules (its D2 and D8) apply unchanged.

### D4. Operations

```ts
export type OperationRequest = {
  /** Random 128-bit; the host's handle for outcomes. */
  id: string
  kind: 'invite' | 'remove' | 'ledger' | 'rotation'
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
  /** Epoch and `epochAuthenticator` of the state the commit was built from. */
  epoch: number
  authenticatorBefore: Uint8Array
  /** The exact framed hub payload, with bodies sealed once. Replay publishes these bytes. */
  payload: Uint8Array
  /** Digest of the MLS commit (`digestAppliedCommit`), used to find it in the log. */
  digest: string
  bodies: Array<string>
  /** Host blob: the post-commit state and anything needed to adopt it. */
  journal: Uint8Array
  welcome: { bytes: Uint8Array; recipients: Array<string> } | null
}
```

The host supplies `build(op, view)` and `adopt(journal, expected)`.

- **`build(op, view)`** returns `{commit, bodies, journal, welcome}` and must not mutate. Its view
  argument is the newest one; the host builds against that epoch.
- **`adopt(journal, expected)`** must be idempotent. It is a no-op when the current state's epoch and
  `epochAuthenticator` already equal the post-commit state's. It installs only when the current state
  matches `expected = {epoch, authenticatorBefore}`. Otherwise it reports `moved` and writes nothing.

Each operation moves through its stages as follows. Every arrow is one `apply` unless noted.

1. **`enqueue`.** `putOperations([intent])`. The call resolves after the commit. A `remove` or revoke
   operation closes sends on the newest view (`revoking`).
2. **Head of the queue.** Lifecycle pulls the commit log to its head (D6), calls `build` against the
   newest view, frames the payload, and writes `built`.
3. **Publish** `payload` under `publishID` and `expectedHead`:
   - accepted, deduplicated or not: write `accepted` and `putWelcomes` in the same `apply`;
   - head mismatch: the hub claims the ID before its head check, so the commit did not land. Return
     to `intent`, then pull, rebuild and retry until the operation deadline. Past the deadline, write
     a `lost` outcome and delete the operation;
   - any other error: keep `built` and retry with backoff.
4. **`accepted`.** Call `adopt`, then in one `apply`:
   - delete the operation;
   - `putOutcomes([landed])`;
   - `putApplied({epoch, digest, sequenceID, opID})`;
   - set the cursor to `acceptedAs`.

   A view for the new epoch follows. If `adopt` reports `moved`, the outcome is still `landed`: the
   commit is in the log. No state is written, and the group's newer state stands.

**Replay at `start`** works per stage:

- `intent`: as step 2.
- `built`: republish the stored `payload` under the same ID, whatever the current epoch. This
  removes `JournalEpochError`.
  - Accepted or deduplicated: as step 3.
  - Head mismatch: the hub may have forgotten the ID, so lifecycle searches the commit log from
    `expectedHead` for a frame whose commit digest equals `digest`:
    - found: treated as accepted at that position;
    - absent, with the log complete from `expectedHead`: `lost`;
    - absent, with a retention gap: `unknown`.
- `accepted`: as step 4.

**Outcomes:**

```ts
export type Outcome = { id: string; opID: string | null; at: number } & (
  | { kind: 'landed'; position: LogPosition }
  | { kind: 'lost' }                       // proven absent
  | { kind: 'unknown' }                    // absence not provable
  | { kind: 'reverted'; position: LogPosition }   // accepted on a losing fork branch
  | { kind: 'reenact'; tokens: Array<string> }    // ledger tokens missing after a rejoin
  | { kind: 'rejected'; reason: string }          // build refused, e.g. not authorised
)
```

They persist until `ack`. Lifecycle never re-enacts anything; the host enqueues a new operation.
Lifecycle emits `outcome` when it writes one.

### D5. Welcome obligations

**Inviter side:**

- A `WelcomeObligation` is `{opID, welcome, recipients}`. It is written with `accepted` (D4 step 3).
- After each such `apply`, and at every `start`, lifecycle calls the host's
  `deliverWelcome(obligation)`. Once that resolves, lifecycle deletes the obligation. Delivery is at
  least once.
- Delivery does not depend on adoption, and survives a rejoin (D7).
- The host checks frame size inside `build`, as today (`rpc/src/commit.ts:23-29`).

**Invitee side (`mls-hub`):**

- `processWelcomeFromSources` splits into `openWelcome(sources, welcome)`, which decrypts without
  releasing, and `release(ref)`. The host calls `release(ref)` only after it has saved the joined group.
- A released ordinary package leaves a receipt `{ref, groupID}` in its source.
- `openWelcome` reads the Welcome's refs without decrypting (`mls/src/welcome-refs.ts:13-27`). A
  receipted ref returns `{alreadyJoined: groupID}`.
- At startup, the host releases the ref of every group it holds whose package is still unreleased.
  The ref is recorded with the group state; Spec P's `joinRef`.
- Last-resort packages are never released (`mls-hub/src/provisioner.ts:65`). Their repeats are caught
  by `processWelcomeOnce` (`mls/src/group-welcome.ts:179-189`).

### D6. Commit log, forks and strands

- **`applied` rows.** An `AppliedCommit` is `{epoch, digest, sequenceID, opID: string | null, external?:
  'applied' | 'refused' | 'superseded'}`. One is written in the same `apply` as each adoption, own or
  applied, so fork classification survives a restart.
- **Fork window.**
  - The window covers 64 epochs.
  - A forked frame older than the window classifies as `history`. That is an accepted blind spot: the
    device stays on its branch until other evidence (`ahead`, a gap) strands it.
- **Stranding** writes `cursor.stranded = true` with the durable position unchanged, as
  `persistStrand` does today (`rpc/src/peer.ts:704-715`). It closes sends (`stranded`) and requests a
  heal.
- **Losing a fork at epoch `E`** is resolved by a rejoin (D7). Its final `apply` turns every `applied`
  row at or above `E` that carries an `opID` into a `reverted` outcome, and replaces those rows with
  the winner's.
- **Cursor.** The commit cursor moves into `ControlStore` and advances in the same `apply` as the
  adoption or skip it records.

### D7. Rejoin

```ts
export type RejoinRecord = {
  stage: 'built' | 'published' | 'confirmed' | 'adopted'
  publishID: string; expectedHead: LogPosition | null
  requestID: string; request: Uint8Array
  /** Secret. Today it lives in a 120 s memory map (`mls-rpc/src/mls.ts:135-173`). */
  requestKey: Uint8Array
  /** `PendingRecovery.serialize()`: the candidate state and its confirmation binding. Secret. */
  candidate: Uint8Array
  digest: string; epochAfter: number
  /** Ledger tokens held before the rejoin, for `reenact`. */
  ledgerBefore: Array<string>
  /** The lowest losing-branch epoch, when the rejoin heals a fork. */
  forkEpoch: number | null
  position?: LogPosition
  verdict?: Uint8Array
}
```

**Stages:**

| Stage | Written | Replay at `start` |
|---|---|---|
| (none) | — | start a rejoin only when evidence calls for one |
| `built` | before publishing the external commit | republish the same payload and ID. Accepted or deduplicated: `published`. Head mismatch: search the log for `digest`; found means `published` at that position, absent means delete the record and start afresh |
| `published` | publish accepted | re-send the confirmation request with the stored `request`, and open verdicts with `requestKey`. `confirmed` on an authoritative confirm. On `unconfirmed` or deadline, delete the record and start a fresh rejoin; the orphan leaf is replaced, as today (`tests/integration/test/recovery-confirmation.test.ts:306`) |
| `confirmed` | verdict verified | `restoreRecovery(candidate, requestKey).onAccepted()`, idempotent by `epochAuthenticator`. Adoption uses the recovery identity (`epochAfter`, `forced: true`, `recovery: true`, `rpc/src/peer.ts:2607`), never the ordinary-commit replay identity. Then `adopted` |
| `adopted` | host replace done | bootstrap the ledger, then one `apply`: `reenact` outcomes for `ledgerBefore` tokens missing from the group ledger; `reverted` outcomes from `forkEpoch`; clear `stranded`; delete the record |

**Rules:**

- **Settle operations first.** Before writing a rejoin `built`, lifecycle settles the queue head:
  - a `built` operation is republished or searched (D4);
  - an `accepted` one is adopted, or reported `landed` with `moved`.

  The queue then pauses until the rejoin record is deleted.
- **New `GroupControlMLS` methods:**
  - `createRecoveryRequest` returns `{request, requestKey}`;
  - `restoreRecovery(candidate, requestKey)`;
  - `PendingRecovery.serialize()`.

  The 120 s map goes.
- **Responders.**
  - A responder records each external commit's outcome kind in its `applied` row.
  - It confirms only while its current or retained epoch equals the candidate's, by re-deriving
    `confirmationKey` from `exportSecret`. It stores no secret.
  - A responder that has moved past the epoch cannot confirm. The requester then times out and
    rejoins again.
- **Anchor.** The anchor store is unchanged. A same-number rejoin still goes through
  `requireAnchorRecovery` (`rpc/src/peer.ts:410-414`), and its view carries the captured anchor.

### D8. Errors

- `EpochClosedError`: a seal on a closed view.
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
| hub accepted, before `accepted` | hub `publish` on the commit topic | after | dedup or digest search: `accepted`, one Welcome obligation |
| hub forgot the ID | as above, plus hub dedup purge | after | digest search finds it: `landed`, never `lost` |
| `accepted`, before adopt | `apply` with `accepted` | after | adopt once, Welcome delivered |
| adopted, before `landed` apply | host `adopt` | after | `adopt` no-op, `landed` written |
| Welcome obligation, before delivery | `apply` with `putWelcomes` | after | delivered |
| invitee joined, before release | host save of the joined group | after | release on start; repeat Welcome is `alreadyJoined` |
| invitee released, before ack | `release` | after | repeat Welcome is `alreadyJoined` without decrypt |
| rejoin built, before publish | `apply` with rejoin `built` | after | one external commit |
| rejoin published, before confirm | hub `publish` (external) | after | confirmation resumes with the stored key; no second rejoin while a responder holds the epoch |
| rejoin confirmed, before adopt | `apply` with `confirmed` | after | adopted once with recovery identity |
| rejoin adopted, before bootstrap | host replace | after | bootstrap, `reenact` computed from `ledgerBefore` |
| fork loser, restart, winner shown | `applied` rows on disk | — | fork detected; `reverted` and `reenact` outcomes |
| view leased at `E`, 8 commits arrive | app lane holds the lease | — | adoption of `E + 8` waits; frames at `E` still open |

## Conformance and tests

| Suite | Case | Assertion |
|---|---|---|
| `testControlStoreConformance` (new, in `rpc-conformance`, replacing the `CommitJournal` suite) | all or nothing | failure injected mid-`apply`: no change visible after reopen |
| | durable | every record kind round-trips across reopen |
| | ambiguous commit | commit-then-reject: `lastMutation()` equals the attempt |
| | outcomes persist until deleted | |
| | secrets | `requestKey` and `candidate` round-trip byte-exact |
| | per provider | memory, node-sqlite, postgres, expo (phase 3 of the parent) |
| lifecycle crash tests | every row of the crash-seam table | as stated |
| | Codex r4 blockers | a forged frame carrying our digest never clears an operation, because the digest is of bytes only we built; a hub fork accepting our invite on the losing branch gives `reverted`; a crash after rejoin publish never adopts without confirmation; a `built` operation at a moved epoch resolves instead of throwing |
| view tests | past-epoch open | a frame at `E` opens after `E + 1` is adopted |
| | lease backpressure | adoption of `E + 8` waits for the release of `E` |
| | re-seal on close | an unproven entry sealed at `E` is re-sealed at `E + 1` and published once proven |
| | topics switch | a roster change gives a view with new topics; the app lane re-subscribes |
| | revoke closes sends at enqueue | no app frame is sealed between a revoke's enqueue and its view |
| | no deadlock | a handler that sends from inside delivery completes |
| integration | `recovery-confirmation` suite unchanged and green | |
| | requester restart | restart between external publish and confirmation: one leaf, adoption after confirmation |
| | Welcome after crash | inviter crashes after `accepted`: the invitee joins after restart |

## Phasing

Each phase is its own PR, with `rpc`, `mls-rpc`, `rpc-conformance` and integration suites green, and
repo-wide `turbo run test:types`.

1. **Probe.** Confirm, with path:line evidence:
   - `decryptStaged` opens at historical epochs;
   - the lease covers a fetched backlog;
   - every `held()` condition maps to a `CloseReason`;
   - the effect of the unlocked `commitLogHead` write today;
   - which shared modules go to `hub-client` versus lifecycle;
   - `PendingRecovery` serialisability.
2. **Epoch views inside rpc.** The app lane consumes views, and the shared lock, hooks,
   `rebuildEpoch`, `holdLogSends` and `settleLogSubmissions` are removed. Ordering tests that encoded
   deliver-before-ratchet are rewritten to the view rules, each with a ledgered reason.
3. **Package split.** `@kumiai/group-lifecycle` is created, lifecycle and `HubMux` move, and
   `createGroupPeer` becomes the assembler. Tests move with their concern; the 62 full-peer tests stay
   in rpc.
4. **Crash safety.** D3 through D7: `ControlStore`, operations, outcomes, Welcome obligations,
   `applied`, rejoin records, and the mls-hub join split.
5. **Band move and Kubun.** The band moves from 0.10 to 0.11. Kubun's `store-p2p` implements
   `ControlStore`, the split `AppOutbox` and `deliverWelcome`; `plugin-p2p` moves from `commit()` to
   `enqueue` and `outcomes`.

## Spec P amendments

- D5 (commits, intents, adoption, Welcome) is removed. P2's D4, D5 and D7 replace it.
- `GroupStateStore` keeps `epochAuthenticator`, `lineage` and `joinRef`, which P2's `adopt` and the
  invitee rules consume. Intents and `WelcomeObligation` leave it.
- D6 and D7 (outbox) build on views: an outbox entry's `segment` is the view's anchor epoch.
- Deletion closes sends through lifecycle (`removed`) before the tombstone.
- The crash seams and conformance rows for D5 move here.

## Risks

- **Ordering drift in phase 2.** Tests catch dropped calls, not changed await order
  (`docs/agents/plans/backlog/2026-10-05-rpc-peer-module-split.md`). Mitigation: the view rules replace
  the ordering rather than preserve it, and each changed test is ledgered.
- **Lease starvation.** An app handler that never completes holds a view and stalls adoption. The app
  lane's handler retry and backoff (`rpc/src/app-lane.ts:576-589`) must time out into a dead frame
  rather than hold the lease forever. Phase 2 defines the bound.
- **Kubun breakage.** Phase 5 is one coordinated change.
- **Responder confirmation window.** Resumed confirmation works only while some member retains the
  candidate's epoch. Past that it degrades to today's orphan-and-rejoin.
- **64-epoch fork window.** An older fork goes undetected until other evidence strands the device.

## Review log

(none yet)
