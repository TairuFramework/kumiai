# Log delivery across an epoch change

## Goal

A log-class app event that a member dispatches must reach every member that is in the group when the event lands, even when a commit lands around the same time, and even when the sender crashes. Today two cases lose frames for good.

The promise, exactly: once `dispatch` of a log event resolves, the peer keeps the event durably and publishes it, in per-sender order, until it can prove that some publication of it was readable by every member at that publication's epoch. Three things end the promise without delivery, and each is reported: the sender is removed from the group, the host clears the outbox (group deletion), or the host disposes the peer for good. Past-epoch frames are never accepted.

An ephemeral event sent right after an anchor move should also reach receivers whose subscription to the new topic the hub has acknowledged. That promise is narrower (§6).

Consumer impact: kubun's `delegation:revoke` is a log event. Losing it fails open.

## Accepted tradeoffs

- **At-least-once.** Log events become at-least-once across an epoch change and across a sender restart. A member still at the old epoch can read the original frame and the re-sealed copy. No message id is added to the envelope. Consumer handlers must be **completion-safe on retry**, not merely upserts: a handler that failed half-way must finish its remaining effects when the duplicate arrives. kubun is fixing its share handler separately.
- **Per-sender order costs latency.** A log event waits behind every earlier unresolved log event from the same peer.
- **Ephemeral delivery stays best-effort** for a receiver that has not applied the commit, whose new subscription is not yet acknowledged, or whose walk passes more than one epoch before its listeners register. Pull is the fallback.
- **Over-approximation.** The at-risk check counts any commit-topic movement after the floor, including history, poison and non-advancing frames. The cost is a hold until a covered walk certifies the entry, or at most one extra duplicate if a ratchet comes first.
- **Backpressure, not loss.** When the outbox is at the host's cap, or an event's plaintext is over the entry bound (§3), `dispatch` rejects. Nothing is silently dropped.
- **A retention gap costs a rejoin.** If the hub removed a commit-topic frame after the peer's cursor that the peer never read, the peer strands and rejoins at once (§1), even when the removed frames were not commits. A rejoin is an external commit, so it changes the tree for the whole group. The peer takes the hub's `gap` on trust; a hub can already withhold frames, so a false `gap` adds a forced rejoin and nothing else. Removal of the cursor's own frame is not a gap and costs nothing. A fresh joiner whose first walk is uncovered rejoins only if it has an entry at risk (§4).
- **A rejoin waits for a member's word.** A rejoiner adopts nothing until a member that applied its external commit confirms it (§1). A rejoin with no member online to confirm does not land, even when the hub accepted it, and a confirmation lost past the deadline costs one more rejoin and one orphan leaf, which the next rejoin collects.
- **A member removed with old secrets can confirm a stale rejoin.** In a group without a controller, as on main, without bound. In a lifecycle group only while the rejoiner has not seen its revocation, and only until its leaf capability expires plus 300 s, or, under a revoked trusted agent, that agent's grant expires plus 300 s (bound-leaf spec, tradeoff 5).
- **A revoke holds its author's log sends.** While a revoke or reset commit this member authored is pending, its queued log events wait, and the revoke commit itself waits for the member's log publishes already in flight to settle (§4).
- **Stale admission at enqueue.** The enqueue gate reads a published snapshot that can lag an adoption in progress (§3). A sender renewed by that adoption can be refused once, and a sender lapsed by it is held after enqueue.
- **Plaintext at rest.** The outbox holds app event plaintext until delivery is proven (§5).

## Background (reproduced on main `0d0ee9f`)

**Loss 1: a log frame sealed behind a commit.**

1. Member S is at epoch E and has not yet applied commit C, which leaves E.
2. S seals log frame F at E. The hub accepts F after it accepted C.
3. A receiver that applied C before F arrived refuses F as past (`crypto.ts:19-20`, `app-lane.ts:767-773`) and acks it dead.
4. Nothing re-sends F. `dispatch` keeps no plaintext after the publish (`peer.ts:959-966`).

Any commit causes this, not only roster changes: `unwrap` refuses every epoch other than the current one.

**Loss 2: an ephemeral frame published before receivers subscribe.**

- `captureAnchor` moves the anchor during the walk (`peer.ts:631-643`), and `sealForSegment` seals to the new topic from then on (`peer.ts:906-924`).
- Receivers subscribe to the new topic only in `buildEpoch`, after the walk (`peer.ts:844`).
- The hub drops a mailbox frame that has no recipients (`hub-server/src/memoryStore.ts:251-254`).
- If the subscribe is moved earlier on its own, a frame that arrives before the listener registers stays unacked until a reconnect (`hub-mux.ts:653-662`).

**Anchor crash gap.** `processCommit` is durable before `captureAnchor` saves the anchor. A crash between them leaves a stale persisted anchor (`peer.ts:626-629`), and init restores it rather than recomputing it (`peer.ts:2695-2701`). A recovered outbox entry sealed onto that stale topic is invisible to the group.

**Safety condition.** A receiver reads E's frames in `advanceHandle` (`appLane.deliver()`, `peer.ts:1379`) before it applies C, and it fetched C before that. So if the hub ordered F before C, every receiver sees F at E. F is at risk only if a commit was ordered after the point where S entered E and before F.

## Design

### 1. Epoch floor

The peer tracks `floor = { epoch: number, position: LogPosition | null, covered: boolean }`: the commit-topic position at which its handle entered `epoch`, and whether the peer has read every commit-topic frame since. `null` is genesis or a fresh join with nothing applied yet. The floor is in memory only.

- It is set inside `advanceHandle`, after a successful ratchet and before the seal barrier is released, from the position the caller applied: the walk position, the accepted `sequenceID` for own commit and replay, or the **confirmed** position for a rejoin (below). A hub acknowledgement of the rejoiner's own external commit is never enough: the hub orders frames, it does not apply them.
- At the end of a complete, covered walk that did not ratchet, it rises to `reconciledHead`, **unless the walk stranded** or `floor.covered` is false. `reconciledHead` steps over `ahead` and `fork-losing` frames (`peer.ts:1604-1644`) that other members did apply, so raising the floor there would prove an at-risk frame safe. `own-unmerged` stops the walk early, so that walk is not complete.
- It is never taken from `reconciledHead` before a ratchet. `commit()` and `replayJournal` move `reconciledHead` before the handle ratchets (`peer.ts:2294` vs `2308`, `1940` vs `1948`), and using it in that window would prove an at-risk frame safe.

**Covered walk.** A walk drains with no error even when commit bodies after its cursor were removed: an empty page records the head and returns (`peer.ts:1466-1471`). `oldest` cannot tell whether that happened. Positions come from one hub-wide counter shared by every topic and by mailbox frames (`memoryStore.ts:124`, `:230-231`; `durable-fake-hub.ts:99`), so they are not dense per topic. `oldest` above the cursor looks the same when only the cursor's own frame aged out as when a later frame did. Only the hub knows what it removed, so a fetch reports it as `gap` (§7).

A page is **covered** when it had an `after` cursor and reported `gap: false`. A walk is covered when every page it fetched was covered. An empty page whose `head` is beyond its cursor and which reports no gap breaks the hub contract, and the walk treats it as a gap. The cursor is exclusive, so a page whose cursor is the floor's own frame stays covered when that frame aged out. A covered walk read every commit-topic frame after its starting cursor.

The peer keeps `floor.covered`. A ratchet sets it to true, since the floor is then a frame the peer applied. Any uncovered walk sets it to false until the next ratchet. While it is false, no walk raises the floor or certifies a publication (§4). With a cursor, an uncovered page strands the peer (below) and recovery ratchets it. The one uncovered walk that does not strand is a fetch with no cursor. That is a fresh joiner's first walk, which cannot tell frames removed before its join from frames removed after it. Stranding there would make every member that joins a trimmed group rejoin. The worker rejoins instead, and only when an entry needs it (§4).

**A gap strands the peer.** A page with a cursor that reports `gap: true` means a commit-topic frame this peer never read is gone, so the peer cannot prove it reaches the head. The walk then:

- stops before processing that page. It leaves `reconciledHead` in place and takes no tip, as `own-unmerged` does (`peer.ts:1588-1603`). The next walk from the same cursor sees the same gap;
- sets `stranded` and `healRequested` (`peer.ts:1084`, `:1107`);
- reports `observeStrand` with a new `StrandKind` `'retention-gap'`, `confidence: 'claimed'` (the hub's word), `position` the cursor, and `commitDigest` and `claimedEpoch` null.

The heal runs as soon as the lane operation releases the commit mutex, through `healIfRequested` (`peer.ts:2642-2652`), with no timer. Commit delivery, `commit()` and init already call it after their pull (`peer.ts:1816`, `:2322`, `:2734`). The app pull (`peer.ts:685-689`) and `dropAppFrame` (`peer.ts:2788-2795`) gain the same call. The worker's catch-up is the app pull (`requestAppPull`, `peer.ts:705-708`).

Recovery (`attemptBody`, `peer.ts:2402-2593`) re-walks, sees the gap again (harmless), and rejoins by external commit at the store's head. The rejoin lands only once a member confirms it (below). Adoption then clears `stranded` (`peer.ts:2534`) and moves `reconciledHead` to the rejoin, past the gap (`:2545`). The rejoin ratchets through `advanceHandle`, which sets the floor to the confirmed position with `covered: true`. The lane operation's completion triggers the worker, which re-seals every held entry at the rejoined epoch through the ordinary path (§4).

**Recovery in a lifecycle group.** Both rejoins this spec relies on, the retention-gap rejoin here and the fresh-joiner rejoin (§4), are external commits, and in a lifecycle group an external commit must replace the agent's leaf with a bound one. The bound-leaf spec defines how recovery gets that binding: kumiai reuses the leaf's current binding while it is valid by wall clock, and otherwise asks the host through the new port `recoveryBinding()`. When the host has none, recovery requests no GroupInfo and reports the distinct outcome `'renewal-required'` through `onRecovery`. It reports the same outcome, and publishes no commit, when the GroupInfo and the ledger carried with it show that survivors would refuse the binding. This spec only consumes that rule. The preflight saves a publication that would be refused; it is not what makes adoption safe. Confirmation (below) is, and in a lifecycle group only from a signer that passes the bound-leaf spec's verdict gate (bound-leaf §5, *Verdict gate*). The entries stay held, as for any recovery that does not land.

**Confirm before adopting.** This applies to every external rejoin: retention gap, fresh joiner (§4), secret gone (§5) and the host's `recover()`, in lifecycle and other groups alike. Today a rejoiner adopts as soon as the hub accepts its commit (`peer.ts:2510-2545`). The compare-and-set proves only that no commit landed between `readCommitHead` (`:2439`) and the publish (`:2487-2493`). It does not prove the GroupInfo was current. A responder answers from its own handle with no catch-up (`:1237-1249`, `mls/src/recovery.ts:530-554`), and the requester accepts any responder in its own last-known tree (`recovery.ts:615-620`). A stale or policy-refused rejoin is then adopted, its floor equals the hub head, and the probe retires a publication no survivor can read.

- **Pending.** After the hub accepts the external commit at position P, the rejoiner keeps `PendingRecovery` unadopted. It writes no rotation record, seals nothing with it, raises no floor, moves no `reconciledHead`, and certifies no entry. The attempt holds the commit mutex across the GroupInfo wait and the publish, as today, and **releases it while it waits for verdicts**: `runRecovery` splits its `runSerial` around `attemptBody` (`peer.ts:2607-2609`) into a publish operation and an adoption operation, and the wait between them holds no lane. `activeRecovery` spans both, so triggers still coalesce. While the attempt is pending:
  - nothing seals at, adopts or raises a floor from the pending handle;
  - `commit()` is **queued**: it awaits the in-flight attempt before taking the lane, then runs against whatever the attempt left (a stranded peer then refuses as today, `peer.ts:2218-2222`);
  - walks run on the old handle. A walk that reaches the frame at P whose digest is the pending `commitDigest` classifies it as **own pending**: it stops before it, leaves its cursor, records no outcome, and treats it as neither poison, fork nor `ahead`, so it neither strands nor raises a heal. Frames before P are walked as usual;
  - the peer seals no GroupInfo and answers no verdict request for a position at or after its own P: its old handle cannot judge them.
  On a confirmation the adoption operation takes the lane and **revalidates** first: the old handle's epoch and `reconciledHead` are still those recorded at publish, and the rotation slot holds no record. If a walk meanwhile ratcheted the old handle, the pending handle no longer extends the state it was built on: it is discarded, as for `'unconfirmed'`, and the backoff decides whether another attempt is needed.
- **Ask.** The rejoiner publishes `recoveryConfirmRequest { requestID, request, position: P, commitDigest }` on the recovery rendezvous (mailbox class, like `recoveryRequest`, `peer.ts:2362-2368`). `request` is the signed recovery request token of this attempt, so a responder can seal to its ephemeral key, and `commitDigest` is `digestAppliedCommit` (`classify.ts:181`) of the external commit. It asks again every `recoveryTimeoutMs`, with the same `requestID` and `request`, until it adopts or the attempt's deadline.
- **What a member records.** When a member's walk reaches an external commit (`header.external`), it records the outcome by position, in memory, bounded by count and by the recovery deadline:
  - **applied**: inside the same lane operation, right after the ratchet, it derives the confirmation key `K = MLS-Exporter("kumiai.rejoin-confirm", frame(groupID, P, commitDigest), 32)` at the commit's target epoch, and keeps `{ epoch, K }`. Only a member that applied P at that epoch can derive `K`; the hub cannot, and neither can a member that rejected or stepped over P. `K` serves only this check, and is dropped with the record;
  - **superseded**: the walk stepped over it as history or a losing fork, because it was framed at an epoch the group had left. This is the stale-responder case;
  - **refused**, with the port's reason: `processCommit` returned `advanced: false` for it at the member's own epoch. `ProcessCommitResult` gains `refusal?: RecoveryRefusalReason`, defined here once (the bound-leaf spec maps its gates onto it):
    ```ts
    type RecoveryRefusalReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'
    ```
    `binding`, `lapse` and `floor` are the lifecycle entry checks that a new binding can satisfy (bound-leaf §5, *Responder refusal reasons*). `policy` is the default roster policy or a caller policy (`policy.ts:272-296`, `group-handle.ts:1078-1083`). `invalid` is everything else: a commit of the wrong shape, an identity it may not replace, or one malformed or cryptographically invalid. A correctly built commit is never refused for shape, so retrying cannot help.
  A walk that strands or meets P as `ahead` records nothing: that member cannot judge it.
- **Reply.** The request handler runs outside the lane and never calls `runSerial` from inside a lane operation (the mutex is not reentrant, `peer.ts:1173-1193`). A member that has no record for P triggers its ordinary commit pull, a lane operation of its own that runs once the lane is free, and looks again when the pull settles. A rejoiner's lane is free while it waits for verdicts, so two members recovering at once each pull, and each judges the other's publication. With a record, it replies after a bounded jitter. There is **no storm suppression**: the GroupInfo reply's collapse (`peer.ts:1273-1286`) acts on the outer `requestID` before any verification, and other responders cannot open a verdict sealed to the requester, so they cannot know it arrived. A responder answers only when the request token verifies and `commitDigest` equals the digest of the external commit its record holds at `position`; otherwise it sends no verdict. It then caches, keyed by the full verified tuple (the request's identity, `requestID` with its signed request, plus `position` and `commitDigest`) and bounded by count and by the deadline, the verdict's outcome (`confirmed` with its `epoch` and `tag`, `superseded`, or `refused` with its reason) and its sealed token. It replies once per repeat of the same tuple, after a fresh bounded jitter, with the cached sealed token: the outcome and tag are fixed once recorded. A different tuple never answers from, replaces or suppresses another tuple's entry, so a copied request token naming another position cannot poison the genuine request's verdict. A lost verdict therefore costs one request interval, and an injected envelope suppresses nothing. It never answers its own request. The reply is `recoveryVerdict { requestID, sealed }`, sealed to the request's ephemeral key under its own AAD domain, exactly as the GroupInfo reply is (`recovery.ts:530-554`). The sealed plaintext is a token signed by the responder's DID key, binding `groupID`, `requestID`, `position` and `commitDigest`, and one of `{ verdict: 'confirmed', epoch, tag }` with `tag = HMAC(K, requestID)`, `{ verdict: 'superseded' }`, or `{ verdict: 'refused', reason: RecoveryRefusalReason }`. `superseded` is not a refusal: it says the GroupInfo was stale, not that the rejoin was wrong. The request is the ask, so no other message is added.
- **Verify.** `PendingRecovery` gains `epoch`, the derived handle's target epoch, and `confirmationKey(position, commitDigest)`, which derives `K` from the derived handle without adopting it. A confirmation is accepted when the HPKE open succeeds, the token binds this group, request, P and digest, its `epoch` equals `PendingRecovery.epoch`, and its `tag` matches. Outside lifecycle groups the tag is the authenticator, so the responder need not be in any tree the rejoiner knows. In a lifecycle group that is not enough: a removed member that kept the source epoch's secrets can apply a stale rejoin and derive the same tag. There, every verdict signer, confirmation included, must pass the bound-leaf spec's verdict gate (§5, *Verdict gate*), which is normative and judged only against the rejoiner's own state; this spec does not restate its predicates. A signer that fails it is advisory. Outside lifecycle groups, a `superseded` or `refused` verdict is accepted when the open succeeds and the token binds the same four values. It is **authoritative** only when its signer holds a leaf in the **source tree**: the tree of the GroupInfo the rejoin was built from, which is the pending handle's tree without the rejoiner's new leaf. A leaf only in the rejoiner's last-known tree (`recovery.ts:615-620`) is not enough: a member removed since then needs no current secret to seal to the request's public key, and HPKE base mode does not authenticate the sealer (`recovery.ts:568-572`). A verdict whose signer is not in the source tree is **advisory**: recorded, reported with the outcome, and never acted on.
- **Contradictory verdicts.** A valid confirmation wins over any refusal or `superseded`, and an authoritative `superseded` wins over a refusal: a stale GroupInfo makes the refusal moot. A confirmation adopts at once. An authoritative `superseded` or refusal opens a **settle round** of one `recoveryTimeoutMs`, in which the rejoiner asks once more and keeps waiting; it is acted on only if no higher verdict arrives in that round, and never past the attempt's deadline. Lifecycle groups follow the same precedence; only which signers count differs (*Verify*).
- **Confirmed.** The rejoiner adopts through `advanceHandle` as today (`peer.ts:2517-2541`): rotation record first (§5), then `onAccepted`, floor `{ epoch: PendingRecovery.epoch, position: P, covered: true }`, `reconciledHead = P`, rebuild, bootstrap. The worker then re-seals every held entry. Commits that landed after P while it waited are applied by its next walk from P, at the confirmed epoch.
- **Refused or unconfirmed.** Only an authoritative verdict leads to the first three cases below. The pending handle and its key are discarded and the old handle stays. Entries stay queued and unpublished, and `stranded` and the episode stand as before the attempt.
  - `superseded`: the GroupInfo was stale. The attempt asks for a fresh one, as on a lost compare-and-set (`peer.ts:2495-2501`), until its deadline.
  - `binding`, `lapse`, `floor`: a new binding can fix it. The rejoiner marks the refused binding unusable, so no later attempt reuses it, and the attempt ends as `'renewal-required'` (bound-leaf §5): the next attempt calls `recoveryBinding()`, and no automatic trigger starts one while the binding is unchanged.
  - `policy`, `invalid`: `onRecovery` reports `phase: 'failed'`, `reason: 'refused'`, with `refusal` set to the reason and `responder` to the signer. A retry cannot change the answer, so no automatic trigger starts another attempt until the host calls `recover()`.
  - No confirmation and no authoritative verdict by the deadline, including when only advisory verdicts arrived: `onRecovery` reports `phase: 'failed'`, `reason: 'unconfirmed'`, carrying the advisory verdicts as `advisory` (each reason and signer), so a host sees them without being held by them. This is retried on backoff, like `no-responder` and `deadline`. If survivors did apply P, the group holds a leaf whose key the rejoiner discarded. The next rejoin removes the rejoiner's existing leaf (`resync: true`, `mls-rpc/src/mls.ts:316-321`), so it collects that orphan.
  A crash while pending is the unconfirmed case: nothing was adopted or recorded.
- **GroupInfo responders.** No catch-up requirement is added for sealing a GroupInfo. A stale responder now costs one `superseded` round, not a split. A responder may run its ordinary pull before sealing to make that rarer; that is an optimisation, not a safety condition. The verdict responder, by contrast, answers only from what its own walk did at P.
- **Why a confirmation is enough, and the residual.** Honest members apply the same hub-ordered log with the same deterministic rules: lifecycle checks read tree time, never the wall clock. One member that applied P therefore shows that every honest member applies P, and that P's target epoch is on the group's line. That member's later fate does not undo this. If it is rejoined, forked or removed afterwards, P is still on the log, and everyone else still applies it. The residual is the inputs this rests on:
  - **Divergent caller policies.** Members whose caller policies disagree on P can confirm and refuse the same commit. Deliberately incompatible caller policies cannot support the shared delivery guarantee, and the confirmation wins (above).
  - **A hub that forks its readers.** A hub that withheld an earlier commit from the confirming member could have it apply P on a forked view. That hub can already withhold frames, and the delivery promise rests on clause 1 of §7. The next honest commit then reaches the rejoiner from an epoch it does not hold, and it strands and rejoins again.
  - **A removed member that kept old secrets.** Honest hub, honest-looking confirmation: "one member applied P" assumes an honest member. A member removed after the source epoch can feed stale GroupInfo, apply P on its retained state and confirm it.
    - In lifecycle groups the verdict gate refuses such a signer whenever the rejoiner's own ledger, or the reply's, records its revocation, and otherwise from the moment its leaf capability expires plus 300 s on the rejoiner's clock (bound-leaf §5, *Residual*).
    - Groups without a controller have nothing to check against. The residual stays open there, as on main, so this is not a regression. It is filed as a follow-up for the kumiai recovery workstream.

**If recovery does not land.** `onRecovery` reports `failed` with `no-responder`, `deadline` (`peer.ts:2453`, `:2584`) or `unconfirmed`. `stranded` stays set, and the entries stay in the outbox unpublished. The cursor did not move, so the worker's next catch-up pull on its backoff re-observes the gap and asks again. For `bootstrap-failed` (`peer.ts:2563`) the rejoin was confirmed and adopted, so the entries are re-sealed as above. After `'renewal-required'` or `'refused'` the backoff does **not** re-raise the heal: retrying with unchanged inputs would only fail again, so no GroupInfo is requested while the outcome stands. After `'renewal-required'` the next attempt comes when the inputs change, as the bound-leaf spec defines (the host's `recover()` once `recoveryBinding()` can answer, or a ratchet). After `'refused'` it comes only from the host's `recover()`.

**Removed while behind a gap.** A responder seals a GroupInfo only for a requester whose leaf is in its current tree (`peer.ts:1247-1249`). In lifecycle groups, the companion spec also requires an external commit to replace an existing leaf of the same agent. A peer removed by a commit that has since aged out therefore cannot rejoin: every attempt fails, and the peer never applies its removal, so `onAppOutboxCleared({ reason: 'removed' })` never fires. Its entries are still not dropped: they stay durable and unpublished, and the host has the `retention-gap` strand notice and every recovery failure. The promise then ends only as the Goal says: the host clears the outbox or disposes the peer. Nothing is published to a group that removed the sender, and nothing is lost without a report.

### 2. Sealing a log entry

A log seal returns `{ topicID, payload, epoch, floor }`, where `epoch` is read from the ciphertext (`GroupCrypto.frameEpoch`), not from the hint.

- The seal reuses `sealForSegment`'s `anchor === at && sealBarrier == null` check (`peer.ts:917-921`), and in the same synchronous step snapshots `floor`.
- It is accepted only if `floor.epoch` equals the ciphertext epoch. Otherwise it seals again. The anchor-identity check alone does not catch a non-rotating advance that started and finished during `wrap`, and that case pairs E's ciphertext with E+1's floor.
- **Sender admission.** The MLS port publishes whether the local leaf may send an application message (new `GroupMLS.sendAdmission(): SendAdmission`, with `SendAdmission = { epoch: number; admissible: true } | { epoch: number; admissible: false; reason: 'lapsed' }`). It is a synchronous published snapshot, like `GroupCrypto.epoch()` (`crypto.ts:33`): it takes no lock and pairs the verdict with the epoch of the one handle state it was read from. The worker revalidates in the same synchronous step as the floor snapshot, and accepts a seal only when the snapshot's `epoch` equals the ciphertext epoch and `admissible` is true. A snapshot that lags the ciphertext epoch is retried on the next trigger. Under the companion bound-leaf spec, lapse is a pure function of the epoch's tree (`L.exp < treeTime(H)`), so any snapshot at E gives the sender's verdict at E, and that is every receiver's verdict at E. A floating leaf is always admissible.

### 3. Dispatch

`dispatch` for a log event:

1. **Synchronously, on entry**, in one step:
   - reads `sendAdmission()`, and refuses an inadmissible sender with `SendNotAdmissibleError` (an `@kumiai/rpc` class carrying the port's `reason`; `@kumiai/rpc` does not depend on `@kumiai/mls`, so it cannot throw `LeafLapsedError`). No durable promise is made for an event the group would drop;
   - refuses an event whose encoded plaintext exceeds `MAX_APP_ENTRY_BYTES = 524,288` (512 KiB) with `AppEntryTooLargeError` (`@kumiai/rpc`). A sealed frame must fit the hub's cap of 1,048,576 base64 characters (`hub-protocol/src/protocol.ts:35`, 786,432 raw bytes), and an entry that could never fit would block every later entry of the sender, since the queue is ordered. The bound leaves 262,144 bytes for the MLS message, padding and framing; the worker's whole-frame check (§4) stays the backstop;
   - counts outstanding entries plus unresolved reservations, and at `appOutboxLimit` rejects with `AppOutboxFullError`;
   - reserves the next `seq`.
2. `put`s the entry. If `put` rejects, the reservation is released and `dispatch` rejects. `put` is atomic, so a rejected insert leaves no row.
3. Resolves when `put` resolves, and kicks the worker.

A `dispatch` issued before init has listed the outbox waits for that listing, which is not a lane operation, and then reserves in call order. Reservation order is call order, so the queue order cannot depend on admission or storage latency.

The worker never passes an unresolved reservation: it works only entries whose `seq` is below the lowest reservation still awaiting its `put`.

`dispatch` never waits on a lane operation, the commit mutex, the worker or the MLS port's handle lock, so a host may await it from inside an epoch or adoption callback. The host's `put` must not wait on the host's own in-flight adoption transaction either.

**Snapshot timing.** `HandleAccess.admission()`, which backs `sendAdmission()`, is published together with `epoch()`, from the same handle state and at the same points. In `simpleHandleAccess` those are the end of `mutate` and `open`, and the return of `replace`'s adoption callback (`access.ts:58`, `:65`, `:71`). A `dispatch` inside an adoption callback therefore sees the pre-adoption state. If that state is admissible and the adopted one is not, the entry is held (§4). If it is lapsed and the adopted one is renewed (a `dispatch` from inside the adoption of the sender's own renewal), the caller is refused; the host dispatches after adoption.

**What the promise means.** Resolved: the event is durable and the promise in the Goal applies. Rejected: the event was not accepted, and nothing will be published.

Admission is checked again at every seal (§2), because a commit after enqueue can lapse the sender.

Rejecting at the cap rather than blocking keeps `dispatch` callback-safe: a blocked `dispatch` inside a lane callback would wait on a worker that waits on that lane. Refusing a lapsed sender at enqueue is simpler than accepting and holding: the caller learns at once, and only the rare lapse after enqueue needs the hold path.

Ephemeral and directed frames are unchanged. They never enter the outbox.

### 4. The send queue and its worker

One durable, ordered log send queue per group, worked by a single worker.

**Per entry, in `seq` order:**

1. **Catch up.** If the last commit-head observation (from a probe or a pull) is beyond `floor.position`, run a pull as a lane operation and await it. The worker is never itself inside a lane operation.
2. **Hold or seal.** If the peer is stranded, not admissible at the current epoch, or the revoke hold (below) is taken, stop the pass here. Otherwise, if the entry has no acknowledged publication at the current epoch, seal it (§2). A frame that fails the whole-frame check (bound-leaf §3) throws `FrameTooLargeError`, is not published, and keeps the entry for host inspection; `dispatch`'s entry bound makes this unreachable for an honest MLS port.
3. **Durable update.** Write the prepared attempt `{ epoch, floor, attempts }` to the entry's `lastAttempt`.
4. **Submit and publish.** In one synchronous step, check the revoke hold again and, if it is not taken, register the submission as **in flight** and hand the frame to the hub. If the hold was taken meanwhile (during the seal or the durable update), the prepared attempt is not submitted and the pass stops; the entry is re-sealed after the hold ends. The submission leaves in-flight when the hub acknowledges or fails it. On acknowledgement, record the publication `{ epoch, floor }` in memory as **acknowledged**.

Only an acknowledged publication counts as published: it alone is skipped at its epoch, probed or certified. A prepared attempt whose publish failed or has an unknown outcome is published again, since duplicates are allowed. `lastAttempt` is for backoff and host inspection, never evidence.

**Revoke hold.** This is what the bound-leaf spec's "removal before the next broadcast" means. `GroupPeer.commit(build, options?)` (`peer.ts:2174`) gains `options.holdLogSends?: true`, which `publishRevokeProof` sets. The hold is taken synchronously when that `commit()` starts and released when the commit lands or is known unlanded. While it is taken the worker submits no log frame: not a new seal, and not an attempt sealed or durably written before the hold but not yet submitted (step 4 re-checks it in the same step that submits). Before the held commit is journalled or published, `commit()` waits for every log submission already in flight to settle (acknowledged or failed). So no log frame is submitted after the hold is taken, and a frame already submitted went to a member still legitimate when it was submitted.
- **In memory** the hold spans the `commit()` call, queued time, the wait for in-flight submissions and rebuilds after a lost race included.
- **Across a restart** it is the commit journal's: `JournalEntry` (`commit.ts:59-80`) gains `holdsLogSends?: true`, written with the entry before the publish. The journal slot is cleared when the commit lands and is adopted, or when it is known unlanded (reported as lost or re-enacted), so the hold ends exactly then. The worker holds while the slot holds a flagged entry, so a revoke a crash left unpublished still goes first: the journal replay that every lane operation runs first (`replayJournal`, `peer.ts:2185`, `:2330`, `:2423`) lands it or reports it lost. No outbox-store field is added: the journal is already written before the publish and cleared at landing, and a second record could disagree with it.
- A `commit()` that throws before the journal write leaves no hold; the consumer reruns the revoke (bound-leaf Consumer contract, item 4).

The pass stops at the first entry it cannot publish (held, failed or barrier). A later entry never gets a publication at an epoch before every earlier unresolved entry has an acknowledged one there. This keeps per-sender order for first publications and for every re-seal. An entry with an acknowledged publication at the current epoch is not republished.

**Probe.** After the pass's last publish is acknowledged, one probe reads `fetchTopic(commitTopic, { after: floor.position, limit: 1 })`.

- **Safe** when `head` is at or below `floor.position` (both `null` counts as safe). Every acknowledged publication of the pass at that floor is proven, and those entries are removed.
- **At risk** otherwise, whatever `messages` holds. The head is stored state and survives trim and purge (`hub-protocol/src/types.ts:118-128`), so an empty page with a later head is not clean. The worker then calls `requestAppPull()`.

**Reconciliation certificate.** A walk also proves an acknowledged publication at `{ epoch: E, floor: f }` when all of these hold:
- the walk started after the publication was acknowledged;
- it was complete and covered, and did not strand (§1);
- it ended at epoch E;
- `floor.covered` is still true, so the peer has read every commit-topic frame after `f`.

Every commit ordered before the publication was then read by the walk and applied or rejected at E. The worker re-evaluates after every reconciliation, ratcheting or not. That clears false positives from history, poison and non-advancing frames, which a probe alone would keep flagging under traffic.

**Retention gap.** A page that reports a gap certifies nothing. It strands the peer, and the rejoin runs at once (§1). While the peer is stranded the pass holds at step 2. The worker keeps its backoff timer armed, so its catch-up pull re-raises the heal if an attempt failed, unless it failed as `'renewal-required'` or `'refused'` (§1). The confirmed rejoin's ratchet re-seals every held entry at the rejoined epoch, and the entries are then delivered like any other.

**Uncovered floor, no cursor.** An entry can also go uncertified without a strand: a fresh joiner's first walk had no cursor and reported a gap, so `floor.covered` is false. The worker rejoins when all of these hold after a catch-up pull:

- an entry has an acknowledged publication at the current epoch;
- the probe flagged it at risk;
- the walk that followed was complete, did not strand and did not ratchet;
- `floor.covered` is false.

The worker sets `healRequested` and calls `healIfRequested` once its pull has released the lane, with trigger `'automatic'`. It does not set `stranded`, because the peer has seen no evidence that it is off the group's line, so `commit()` stays open. Once a member confirms the rejoin (§1), it ratchets, the floor becomes the confirmed position with `covered: true`, and the entry is re-sealed and delivered. Until then the old handle is the peer's handle and nothing is certified on the rejoin's account. A failed attempt is retried on the worker's backoff while the same conditions hold, except after `'renewal-required'` or `'refused'`, which wait for new inputs as in §1. A ratchet from an ordinary commit ends the need first, since it also sets `floor.covered`. A joiner with nothing at risk never rejoins.

**Triggers.** The worker runs on enqueue, on probe result, at init after the anchor repair and seed pull (§5), on every lane operation's completion, and on its backoff timer.

**Failures.** A failed seal, publish, probe, durable update or remove keeps the entry and retries with exponential backoff (1 s doubling to 60 s, like the app pull). A failed remove retries the remove alone. A pass handles at most a bounded number of entries and then yields. The bound under sustained commit pressure is conditional: an entry is delivered at the first epoch where no commit lands between its seal and its probe.

**Removed sender.** A commit that removes the local member does not ratchet its handle (`peer.ts:1395-1404`). When an applied commit leaves `localDID` out of the roster, the peer clears the queue and calls a new `onAppOutboxCleared({ reason: 'removed', seqs })`. Those events stay lost, which is correct: the group removed S, and they landed after it did.

**Lapse after enqueue.** The entry is held (step 2) until a ratchet makes the sender admissible again (renewal) or removes it (cleared, as above). The worker does not publish a frame receivers would drop.

**Recovery.** A restart runs the same sequence: catch up, seal at the current epoch, durable update, publish, probe. Acknowledged publications are in memory only, and a preliminary probe never certifies a later publication, so every entry left in the outbox is published again at least once. That costs at most one duplicate per entry, which at-least-once already allows.

### 5. Ports

**`AppOutbox`** is a new required member of `GroupPeerMLSParams`, together with a host-configured `appOutboxLimit`:

```ts
export type AppOutboxEntry = {
  seq: number                     // reserved at dispatch; queue order; unique among outstanding entries
  protocol: string
  prc: string
  data: Uint8Array                // encoded event plaintext
  lastAttempt: { epoch: number; floor: string | null; attempts: number } | null
}

export type AppOutbox = {
  put(entry: AppOutboxEntry): Promise<void>       // insert or replace by seq; atomic; durable before it resolves
  list(): Promise<Array<AppOutboxEntry>>          // ascending seq
  remove(seq: number): Promise<void>              // durable before it resolves; unknown seq is a no-op
  clear(): Promise<void>                          // durable before it resolves
}
```

- `epoch` is a `number`, as everywhere in RPC (`crypto.ts:33`, `crypto.ts:369`).
- `floor` is `null` at genesis, as the commit head is (`commit.ts:63`).
- At init the next `seq` is one above the highest listed. A `seq` names an entry only while it is outstanding, and can recur after the queue drains and the peer restarts.
- `lastAttempt` is the latest prepared attempt, for backoff and host inspection. It never proves a publication.

**Plaintext at rest.** The outbox holds **arbitrary app event plaintext**. This is a new category: the commit journal holds signed ledger bodies and the host's adoption blob (`commit.ts:76-79`), not app payloads. Retention is normally one walk, but has no bound for a stranded or lapsed sender until it recovers, renews or is removed. The host must encrypt it at rest and clear it when it deletes or leaves the group. Removing a row is not physical erasure, so the host decides how to erase.

**`AnchorStore`** gains a rotation record in its single slot, to close the anchor crash gap:

- Before every handle advance, `advanceHandle` saves `{ anchor, pending: { epochBefore, epochAfter, rosterBefore, forced, advance } }`. `epochAfter` is the epoch the advance lands at, known before it runs: the commit's epoch plus one for an applied, own or replayed commit, and `PendingRecovery.epoch` for a rejoin. A rejoin's external commit header carries the GroupInfo's pre-commit epoch (`mls/test/commit-header.test.ts:208-209`), and the rejoined handle is one past it (`external-rejoin.test.ts:388`), so the header epoch would send every rejoin into the any-other-epoch branch below and another rejoin. The rejoiner's own epoch plus one is wrong too, since a rejoin can skip several epochs. `forced` is `header.external` for an applied commit and `true` for a rejoin. `advance` names the advance: the commit's `digestAppliedCommit`, the external commit's for a rejoin. A rejoin writes its record only once it is confirmed and adoption begins (§1). A failed pre-advance write fails the advance, which does not start.
- **A record spans one advance.** A landed rotation is resolved before any further handle advance, while `epochAfter`'s secret is still in the handle. The rotation decision therefore always compares the roster across exactly one advance, so a sequence of membership changes that returns to the original roster (add carol, remove carol) still rotates at each step, as survivors do.
- **Resolution** reads the handle's epoch through the port and decides against the record, not the caller's pre-state:
  - **`epochBefore`, known unlanded**: the advance returned without ratcheting and without throwing. Only such a result counts. That is a refused commit, including a rejected external commit, which leaves the handle unchanged while the walk steps over it (`peer.ts:1713-1716`): the adapter returns a refusal when processing failed with nothing persisted and no roster change (`mls-rpc/src/apply-commit.ts:132`). A persistence, resolver or missing-ledger failure is rethrown (`apply-commit.ts:120`), so it is ambiguous (next case), never known unlanded. The record is cleared from memory and slot at once. An advance that never started, and a rejoin discarded before confirmation, wrote none.
  - **`epochBefore`, ambiguous**: the advance threw and the port still reads `epochBefore`. A replacement can be durable without having been adopted (`simpleHandleAccess` persists before awaiting the host's adoption callback, `access.ts:61-65`), and a restart would find it, so the record stays. Only the same advance (same `advance`) may replace it: its retry, whose `rosterBefore` and `forced` are the same, so nothing is merged. Another attempt's `forced` is never ORed in. A different advance fails at the gate until the record resolves, and the ambiguous advance is retried on its own path: the walk re-reads the same frame (its cursor did not move), the journal replays the same own commit, and a confirmed rejoin whose `onAccepted` threw keeps its `PendingRecovery`, and the next lane operation retries its `onAccepted` first. `PendingRecovery.onAccepted` (`crypto.ts:343-353`) therefore becomes idempotent by contract, as `PendingCommit.onAccepted` already is (`commit.ts:40`).
  - **`epochAfter`**: landed. It rotates when `forced` is set or the roster differs from `rosterBefore`, capturing the anchor from the current epoch, which is `epochAfter`. It then saves `{ anchor }`. Each write carries the in-memory anchor, so a failed post-resolution save is repaired by the next write.
  - **Any other epoch**: `epochAfter`'s secret is gone, so the right topic cannot be derived. The peer does not derive a replacement topic from the current epoch, since survivors kept `epochAfter`'s. It forces a coordinated recovery: it sets `healRequested` (not `stranded`) and `anchorRecoveryPending`, and calls `healIfRequested` with trigger `'automatic'`; at init it does so through the startup recovery phase (below). The rejoin is a forced rotation for every member (`forced` is set for an external commit), so all of them capture the rejoin epoch's anchor. That rejoin is the one advance the gate (below) lets through over the unresolved record, and its own forced record replaces it. Lifecycle recovery needs a bound leaf (§1). This case is reachable only when the handle moved past `epochAfter` outside this rule, for example a restart over a handle that a later advance persisted without resolving the record (a host advancing the handle itself, or a slot written before this change).
- **After a throwing advance.** `advanceHandle` today observes a moved epoch after `advance()` throws but does not capture the anchor (`peer.ts:1416-1419`). It now runs the resolution in its catch path: if the advance landed, it repairs the anchor at once. The seal barrier stays held (`sealError`, `peer.ts:1418`) until a resolution captures the anchor, whether in that catch path, at the next advance's gate or at init.
- **The gate.** Each `advanceHandle` first resolves any record still in memory or in the slot, and starts its own advance only once that record is resolved, is an ambiguous record this advance retries (same `advance`), or when it is the forced recovery rejoin above. A known unlanded record was already cleared. A resolution that cannot capture (export or recovery not yet landed) fails the new advance, which its caller retries on its existing path, so no second advance ever lands on top of an unresolved one.
- **Init repair** is the same resolution, against the durable handle, before any advance at init (journal replay, pending-commit restore) and before the worker. At `epochBefore` the record is dropped, since no replacement was persisted either.
- **Startup recovery phase.** Init repair can land in the any-other-epoch branch. It must not await recovery there: `runRecovery` awaits `ready` (`peer.ts:2599`), `ready` is init (`:2684-2727`), and init-triggered healing is deliberately scheduled after `ready` settles (`:2731-2734`). Awaiting deadlocks, and throwing rejects `ready` and every later recovery with it. So init completes a **minimal readiness** instead:
  - it loads the stored anchor, restores pending frames, and sets up the control lanes, which subscribes the commit and rendezvous topics (`initControlLanes`, `peer.ts:1849-1862`), and builds the epoch;
  - it starts no advance. Journal replay, pending-commit restore and the seed pull's ratchets would each meet the gate; they are skipped, not failed. A journalled commit is neither adopted nor republished in this state; the rejoin supersedes it, and its bodies join the re-enactment set (`peer.ts:2466-2475`), as for any commit lost to a rejoin;
  - it sets `healRequested` and `anchorRecoveryPending`, and `ready` resolves. The existing post-ready trigger (`:2734`) then runs the rejoin as an ordinary lane operation.
  While `anchorRecoveryPending` is set, in-process or after a restart: the seal barrier holds, so the worker publishes nothing; `commit()` refuses before it builds, as for a stranded peer (`peer.ts:2218-2222`); and a walk stops before the first frame it would apply, leaving its cursor. `attemptBody` skips its journal replay and pre-request pull (steps 0 and 1) and races at the store's head, since the GroupInfo describes the head anyway. Only the confirmed rejoin, the forced advance the gate lets through, clears the flag, and the deferred journal and seed work run after it. A failed attempt leaves the flag and retries on the usual backoff, or holds after `'renewal-required'` or `'refused'`.
- The anchor is still never recomputed for an epoch the handle has left.
- The cost is one extra slot write per advance.

A pure recompute from the handle alone is impossible: the rotation decision needs the pre-advance roster, which the advance destroys.

**`HandleAccess.admission()` and `GroupMLS.sendAdmission()`** are the bound-leaf spec's (§2, *The port's snapshot*): synchronous, published with `epoch()` at the same points, never read through `read`, `mutate`, `replace` or `open`, so a `dispatch` awaited inside an adoption callback cannot deadlock. Inside that callback they report the epoch being left; the seal-time check (§2) makes that safe.

**Recovery confirmation** (§1) changes three ports. `PendingRecovery` gains `epoch: number`, the derived handle's target epoch, `confirmationKey(position, commitDigest): Promise<Uint8Array>`, derived from the derived handle without adopting it, and `judgeVerdict(opened): 'authoritative' | 'advisory'`, which applies §1's tag and source-tree rules outside lifecycle groups and the bound-leaf spec's verdict gate in a lifecycle group; the MLS port owns the judgement, since only it knows whether a group is a lifecycle group. Its `onAccepted` becomes idempotent. `GroupMLS` gains `confirmationKey(position, commitDigest): Promise<{ epoch: number; key: Uint8Array }>`, read from the current handle inside the lane operation that applied the external commit, and `sealRecoveryVerdict` / `openRecoveryVerdict`, which seal and open a verdict to a recovery request's ephemeral key as `sealGroupInfo` and `applyRecovery` do. Every frame these ports produce, like every commit frame, passes the whole-frame check before it is published, or `FrameTooLargeError` is thrown and nothing is published (bound-leaf §3). `ProcessCommitResult` (`crypto.ts:146`) gains `refusal?: RecoveryRefusalReason` (§1). Today `processCommit` reports no reason: the policy rejection is swallowed into `refused()` (`apply-commit.ts:63`, `:119-132`), and `CommitRejectedError` (`group-handle.ts:116`) carries none, so the adapter and `CommitRejectedError` gain one.

**`CommitJournal`.** `JournalEntry` gains `holdsLogSends?: true`, which the host's journal stores and returns as given (§4, *Revoke hold*).

**One owner per group.** A group's `AppOutbox`, `CommitJournal` and `AnchorStore` belong to one `GroupPeer`. A host gives them to at most one live peer for the group, and constructs another peer over them only after disposing the first. kumiai does not detect sharing: two peers over one outbox each allocate `seq` from their own listing, replace and remove each other's entries, and race the single rotation slot; journal replay on a second peer republishes the first one's commit on its own hub; and a revoke hold covers only the peer that took it. A host that reaches a group through several hubs therefore runs the group's log dispatch, commits, recovery and revoke run through that one peer.

Disposal does not end the old peer's port calls. `dispose()` deliberately does not wait for the commit mutex or a host callback (`rpc/src/peer.ts:2832`), and a lane operation already past its `assertLive` can still be awaiting `slot.put` (`:2242`), so a late write from the disposed peer can land after its replacement's and overwrite it. A host replacing a group's peer therefore fences the old peer's ports, not only disposes it: each peer gets its own `AppOutbox`, `CommitJournal`, `AnchorStore` and `HandleAccess` (mutation and adoption) instances, bound to an ownership token; the host revokes the token before constructing the replacement; a port call under a revoked token throws; and the token check is atomic with the write, so a call either completes before the revoke or throws. kumiai needs no change: a thrown port call on a disposed peer is already a lane failure the old lane surfaces and dies with.

These changes are breaking for `GroupPeerMLSParams`, `GroupMLS`, `PendingRecovery`, `ProcessCommitResult`, `JournalEntry` and `HandleAccess`. They ship as a patch version, because kubun is the single consumer.

### 6. Subscribe when the anchor moves

**Order inside `captureAnchor`:**

1. Export the secret.
2. Issue the subscribe requests for the new protocol topics and the self-inbox topic, with `appLogRetentionSeconds`.
3. Assign the anchor and release the seal barrier.
4. Save the anchor.
5. Reset the lane.

The subscribe acknowledgement is not awaited. Awaiting it would hold the walk and this peer's own sends on hub latency, and it would not help: no member can order another member's publish after this peer's acknowledgement. The host's epoch notice fires inside the advance, before all of this, because it comes from the MLS port's adoption. Retains are idempotent and lifelong, so rebuild and teardown are unaffected. An aborted walk keeps the anchor it already persisted (`peer.ts:1755-1765`), so the early retain matches it.

**Mux hand-off.** A pending frame that matched no listener is handed to the first listener registered on its topic within the ack TTL (`hub-mux.ts:42`), and acked only when that listener acks it. This also closes the init-race window (`hub-mux.ts:301-307`).

**The promise, narrowed.** An ephemeral frame reaches receiver R when all of these hold:

- the hub accepted the frame after R's subscription to its topic was acknowledged;
- R's listeners register within the TTL;
- R still holds the frame's epoch when they do.

That covers the reproduced case: R applied one commit and had not finished its walk. Everything else is best-effort, with pull as the fallback:

- R has not applied the commit, so it cannot derive the topic.
- The publish was ordered before R's subscription.
- R's walk passed a second epoch before its listeners registered, so the handed-off frame is past and acked dead.
- The walk took longer than the TTL, so the frame returns on redelivery.

Ephemeral traffic is best-effort by ruling, so multi-epoch walks are not covered.

### 7. Hub conformance

New clauses in `@kumiai/hub-conformance`, run with separate publisher and reader clients:

1. Publishes and fetches across all topics of one hub are **linearizable**. A fetch on any topic reflects every publish that took effect before the fetch was issued, and a publish takes effect before its acknowledgement.
2. A fetch reflects a log publish through `head` even after that publish's body is trimmed or purged. `head` never decreases.
3. Log-class removal on a topic is **prefix-only**: while a log frame is retained, every later log frame on that topic is retained, and `oldest` is the earliest retained one. A store enforces this by position, never by timestamp: any age-based removal selects, per topic, the removable prefix of log frames in log-position order and stops at the first log frame it must retain. Mailbox removal (ack, age) stays independent of it, since a mailbox frame is not in the log.
4. A fetch reports **`gap`**. It is true exactly when the hub removed a log-class frame of the topic positioned after `after` (anywhere, with no `after`) and before the first returned message, or, on an empty page, at or before `head`. `after` is exclusive, so the cursor frame's own removal is no gap. A removed mailbox frame never counts. `gap`, `messages` and `head` come from one snapshot.

**The protocol change.** `FetchTopicResult` gains a required `gap: boolean` (`hub-protocol/src/types.ts:115-134`), and so does the `hub/v1/topic/fetch` result schema (`protocol.ts:118-142`). `oldest` stays, for the app lane's below-retention notice. With clause 3, a store needs one value per topic: `removedThrough`, the highest log position it ever removed. Like `head`, it is stored state that never decreases. Then `gap = removedThrough != null && (after == null || removedThrough > after)`. Each implementation in the repo:

- **Memory store** (`hub-server/src/memoryStore.ts`): `removeEntry` raises the topic's `removedThrough` when it removes a log-class entry (`:163-180`). That covers trim (`:394-405`), purge (`:413-431`) and depth eviction (`:288-299`). Purge itself must change: it stamps each entry with `Date.now()` (`:262`) and removes every entry whose age passes the bound (`:418-425`), so a clock that steps back between two publishes lets it remove a later frame and keep an earlier one. It now walks each topic's log frames in position order and stops at the first one younger than the bound; mailbox frames keep their own age check. `fetchTopic` (`:357-392`) computes `gap` in the same synchronous step as `head`.
- **Hub handler** (`hub-server/src/handlers.ts:534-543`) forwards `gap`. `@kumiai/hub-client`'s `FetchTopicResult` (`client.ts:40-49`) and `@kumiai/hub-tunnel`'s `HubFetchTopicResult` (`transport.ts:98-104`) gain it. `hub-mux` returns the hub's result unchanged (`hub-mux.ts:786-793`). The integration wire adapter forwards it (`tests/integration/test/log-hub-over-wire.ts:153-172`).
- **`DurableFakeHub`**: depth eviction (`durable-fake-hub.ts:113-127`) and `trim` (`:202-204`) raise `removedThrough` for removed log-class frames, and `fetchTopic` (`:135-155`) reports `gap`.
- **`FakeHub`**: likewise for depth eviction (`fake-hub.ts:288-305`), `trim` (`:422-429`) and `fetchTopic` (`:319-356`). A frame its fork controls withhold from one reader (`:335-350`) is not removed and sets no `gap`, because those controls model a hub that lies.

The probe (§4) depends on clause 1 from commit topic to app topic. The receiver's pre-apply drain depends on it the other way round. The covered walk and the gap strand (§1) depend on clause 4, and the one-value implementation of clause 4 depends on clause 3. Clause 3 is not yet met everywhere. Trim (a `before` bound) and depth eviction (oldest log frame first) are prefix removals in the memory store and both doubles, and the doubles have no purge. Age purge is not, in the memory store or in kubun's SQL store (Release), until it selects by position as above.

**App lane pruned-window notice.** `reportPrunedWindow` (`app-lane.ts:332-346`) decides with `oldest > cursor`, from the first page of a segment's first pull (`app-lane.ts:418-429`). It has the same flaw as the old covered walk. A cursor frame that aged out with nothing behind it fires a notice, and its doc admits the over-report (`app-lane.ts:327-331`, `app-cursor.ts:36-49`). A window pruned down to an empty log is never reported, because a null `oldest` returns early (`app-lane.ts:339`). And it asks only once per segment: `reported` starts true as soon as `cursor.fetched` is set (`app-lane.ts:415`), and each page sets it (`:451`), so a gap that opens between two pages or between two pulls of a long-lived segment is silent.

The notice now checks `gap` on **every fetch that has an `after` cursor**: every page of every pull. When a fetch reports `gap: true`, the notice carries that fetch's own `after` as `cursor` (the stored cursor on a segment's first page, `cursor.fetched` after it) and that fetch's `oldest`. `AppWindowPruned.oldest` (`app-cursor.ts:62-63`) becomes `string | null`, null when the whole window after the cursor aged out. Repeats are deduplicated per topic and cursor, in memory: an empty window keeps reporting `gap` from the same cursor on every pull (the watermark is stored state), and the host is told once. A wider removal from the same cursor adds nothing the host can act on. A restart can repeat one notice. With no cursor, still no notice.

Clause 4 goes into both suites. `testHubStoreConformance` (`hub-conformance/src/index.ts:87`) drives it with trim, purge and depth. `testLogHubConformance` (`log-hub.ts:224`), whose hub exposes no trim, drives it with depth eviction (`log-hub.ts:409-436`). `ConformanceLogHub.fetchTopic` (`log-hub.ts:48-53`) gains `gap`.

### 8. Contract docs

- `dispatch` / `retentionOf`: what the resolved promise means (§3), the entry bound and `AppEntryTooLargeError`, at-least-once delivery, and handlers that are completion-safe on retry.
- Per-sender log order is kept.
- Ephemeral delivery has the narrowed promise of §6.
- `AppOutbox`: plaintext category, retention, host encryption and erasure (§5).
- `HandleAccess.admission` / `GroupMLS.sendAdmission`: a lock-free snapshot published with `epoch()`, and a `HandleAccess` implementation must never read it under the handle lock (§3, §5).
- `FetchTopicResult.gap` and `HubStore`: what `gap` covers, that it shares a snapshot with `head`, that a store keeps its removal watermark as stored state, and that log-class removal is prefix-only by position, never by timestamp (§7). The `oldest` doc says it cannot detect a gap, because positions are not dense per topic.
- `AnchorStore`: the rotation record spans one advance and is resolved before the next; a known unlanded advance clears it, an ambiguous one is replaced only by its own retry (§5).
- `recover()` / `onRecovery`: a rejoin is adopted only on a member's confirmation; a `binding`, `lapse` or `floor` refusal ends as `'renewal-required'`; `'refused'` (`policy` or `invalid`, with `refusal` and `responder`) holds until the host's `recover()`; and `'unconfirmed'` retries on backoff (§1). In a lifecycle group a verdict counts only from a signer that passes the verdict gate, judged against the rejoiner's own state (bound-leaf §5). `PendingRecovery.epoch` is the target epoch, and `onAccepted` is idempotent (§5).
- `AppWindowPruned`: checked on every fetch with a cursor, deduplicated per cursor, `oldest` nullable (§7).
- `StrandKind` `'retention-gap'`: the hub removed a commit-topic frame the peer never read, and the peer rejoins (§1).
- `GroupPeer.commit`'s `holdLogSends` and `JournalEntry.holdsLogSends`: from the moment such a commit starts until it lands or is known unlanded, the peer submits no log frame for the group, sealed earlier or not, and the commit is published only after in-flight log submissions settle, in memory or through the journal (§4).
- `AppOutbox`, `CommitJournal`, `AnchorStore`: owned by one live peer per group, never shared (§5, *One owner per group*). `FrameTooLargeError`: every frame is checked against the hub's payload cap before it is journalled or published (bound-leaf §3).

## Testing (in `@kumiai/rpc` unless noted, fixtures `makeMLSPeer`, `DurableFakeHub`, `publishCommit`, `buildLedgerCommit`, `buildRemoveCommit`)

Each test must fail with its fix removed.

**These fail on main today:**

1. A roster commit lands while bob is detached. Bob dispatches `chat/posted` at E, then reattaches and pulls. Alice at E+1 receives it.
2. The same scenario with a non-roster ledger commit.
3. Bob's anchor has moved and his runtime is not rebuilt yet. Alice dispatches `chat/changed`, and bob receives it.

**Delivery:**

4. **Safe frame.** Bob is current when he publishes, and alice commits after. Exactly one publish of the frame, received once.
5. **Bounded duplicate.** A member still at E receives F and F′: two deliveries, same plaintext and sender, at most one re-seal per ratchet.
6. **Own-commit window.** Bob dispatches between `markAccepted` and the ratchet of his own commit. F′ is sealed at E+1 and alice receives it. This guards the floor placement.
7. **Seal/floor pairing.** A non-rotating advance starts and ends during `wrap`. The seal is retried, and the entry records the ciphertext epoch's floor.
8. **Trimmed commit body, advanced head.** C leaves E and a receiver applies it. F is then published at E, and C is trimmed before the sender's probe and walk. The probe sees an empty page and a later head. The walk's page reports `gap: true`, so F is not certified and bob strands with a `retention-gap` notice. `recover()` runs as soon as that pull releases the lane, with no further commit, delivery or timer; alice confirms the rejoin and it lands. F′ is sealed at the rejoined epoch, and alice receives it.
9. **Two commits in one walk.** Bob is two commits behind when he dispatches. F′ is sealed at E+2, never at E+1, and alice receives it.
10. **False positive cleared.** A poison frame follows the floor. After a covered non-ratcheting walk, the entry is retired with no re-seal.
11. **Gap behind a retained frame.** A commit after the floor is trimmed while a later poison frame stays retained. The first page reports `gap: true`, so the walk stops before the poison frame and leaves its cursor. The floor does not rise, F is not certified, and bob strands and rejoins as in 8.
12. **Stranded walk does not raise the floor.** An `ahead` frame is stepped over. The entry stays held until `recover()` lands, then is re-sealed.
13. **Only the floor's own commit aged out.** Bob's floor commit is trimmed, and nothing after it is. A poison frame from another member follows, and frames on other topics sit between the two positions, so `oldest` is beyond the cursor. The page reports `gap: false`, the walk is covered, and the entry is retired with no re-seal and no rejoin. Under the old `oldest` rule this test holds F.
14. **Recovery fails, then lands.** As in 8, with no responder online. `onRecovery` reports `failed`, nothing is published, and the entry stays in the outbox. The worker's backoff catch-up re-raises the heal. Once alice is back online the rejoin lands and alice receives F′.
15. **Removed behind a gap.** Bob is removed while detached, and the remove commit is trimmed before he pulls. Bob strands, and every rejoin fails because no responder seals a GroupInfo for a leaf outside its tree. Bob publishes nothing, his outbox keeps the entry, and `onStrand` and each recovery failure reach the host. When the host clears the outbox the promise ends with the host's own clear, and nothing is published.
16. **Fresh joiner with an entry at risk.** Dave joins by Welcome after early commits were trimmed, and his first walk has no cursor and reports a gap. He dispatches F, and a poison frame lands on the commit topic after F's publish. The probe flags F, the walk does not ratchet, and the uncovered floor triggers a rejoin with no timer. F′ is sealed at the rejoined epoch, and alice receives it. Dave never strands, and `commit()` stays open throughout.
    - **16a. Lifecycle recovery.** 8 and 16 in a lifecycle group, through the real `@kumiai/mls-rpc` adapter. With the leaf's binding still valid by wall clock, the rejoin replaces the leaf with a bound one, survivors accept and confirm it, and alice receives F′. With it expired and `recoveryBinding()` returning nothing, recovery reports `'renewal-required'`, requests no GroupInfo, and the worker's backoff raises no further heal while the credential is unchanged. Once `recoveryBinding()` returns a fresh binding and the host calls `recover()`, the rejoin lands and alice receives F′.
17. **Fresh joiner with nothing at risk.** The same join, and Dave's dispatched F probes safe, or he dispatches nothing. He does not rejoin.

**Recovery confirmation, through the real `@kumiai/mls-rpc` adapter in `@kumiai/integration-tests`:**

17a. **Happy path, one rejoin.** As in 8. The hub accepts bob's external commit, alice applies it and confirms, and bob adopts. His rotation record's `epochAfter` is `PendingRecovery.epoch` (one past the commit header's epoch), the record resolves as landed, the seal barrier is released, and alice receives F′. Exactly one `recoveryRequest` and one external commit appear on the hub: no second rejoin. With the header epoch as `epochAfter`, the record resolves as any-other-epoch and a second rejoin starts.
17b. **Stale responder.** Alice and the hub are at E+1; carol has not applied that commit and is the only GroupInfo responder online. Bob's external commit, built from carol's E state, wins the compare-and-set. Alice steps over it and answers `superseded`; carol does the same once her walk reaches it. Bob does not adopt: his handle, floor and `reconciledHead` are unchanged, nothing is sealed at the pending epoch, and his outbox keeps F. He requests a fresh GroupInfo within the attempt, alice answers, the next rejoin is confirmed, and alice receives F′. Without the fix, bob adopts on the hub's acceptance, the probe reads the head as his floor, and F′ is removed unread.
17c. **Policy refusal.** A caller policy on alice and carol rejects bob's external commit. They reply `'refused'` with reason `'policy'`; both are in the source tree, so the refusal is authoritative. After one settle round with no confirmation, bob discards the pending handle, keeps F, and reports `phase: 'failed'`, `reason: 'refused'`, `refusal: 'policy'`. Neither the worker's backoff nor further pulls start another attempt or publish another `recoveryRequest`. A host `recover()` runs exactly one. Repeated with an external commit of the wrong shape (no Remove of bob's leaf, authored through the low-level API): the reason is `'invalid'`, with the same report and the same hold. A lifecycle refusal (`binding`, `lapse`, `floor`) ends as `'renewal-required'` instead; the bound-leaf spec tests it.
17d. **Confirmation lost.** Alice applies bob's external commit, and her verdict is dropped before it reaches bob, through the deadline. Bob discards the pending handle and reports `'unconfirmed'`. His backoff retries; the second rejoin removes the orphan leaf the first one left, alice confirms it, and alice receives F′ once. The roster ends with one leaf for bob.
17e. **Forged verdicts.** A verdict whose `tag` was made with a key not derived at the target epoch, a confirmation for another position or digest, and a refusal signed by a DID in neither tree are each ignored, and bob neither adopts nor reports a refusal on their account. **Removed signer:** mallory is in bob's last-known tree but was removed before the GroupInfo alice sealed. Mallory's correctly bound `refused: 'policy'` arrives before alice's confirmation; bob records it as advisory, keeps waiting, and adopts on alice's confirmation. With alice silent, bob reports `'unconfirmed'` carrying mallory's verdict in `advisory`, and his backoff retries; no hold. The lifecycle variants live in the bound-leaf spec's *Verdict gate* tests:
    - a confirmer whose revocation the rejoiner's ledger or the reply's records;
    - a confirmer under a revoked trusted agent;
    - a pre-reset, a lapsed and a leafless confirmer;
    - only an unknown-revoked member answering, at and just past its `exp` plus 300 s;
    - a revoked member's stale refusal.
17f. **Simultaneous recovery.** Alice and bob both strand behind a gap and rejoin at once; carol is current. Both external commits land, in either order, and each is confirmed (or, for the one built from stale GroupInfo, superseded and redone) before either attempt's deadline: carol's pulls run while both rejoiners wait, and each rejoiner's own walk stops at its own pending frame without stranding. Both adopt, the roster has one leaf each, and alice and bob each receive the other's re-sealed entry. With the commit mutex held across the verdict wait, both attempts end `'unconfirmed'`.
17g. **Confirmation request before the losing attempt's catch-up.** Alice's `recoveryConfirmRequest` reaches bob while bob's own attempt holds the lane before its pre-request pull. Bob's handler triggers a pull rather than nesting `runSerial`; carol confirms alice before her deadline, and bob's attempt proceeds and lands. A ratchet of bob's old handle while his rejoin is pending discards the pending handle at revalidation, and bob adopts nothing.
17h. **Lost verdict, retransmitted.** Alice's and carol's verdicts reach every member but bob. Bob's repeated request elicits their cached verdicts, and bob adopts within one more request interval, not at the deadline.
17i. **Invalid verdict first.** An envelope carrying bob's `requestID` and an unopenable payload arrives before any honest reply. Carol and alice still reply, and bob adopts on the first round.
17j. **Copied request, other position.** An observer copies bob's signed request token into a `recoveryConfirmRequest` naming another recorded external commit Q with Q's correct digest, and it reaches alice and carol before bob's genuine request for P. Bob still receives P's verdict from each and adopts on the first round. A request naming P with a digest other than the commit recorded at P gets no verdict. With a cache keyed by `requestID` alone, bob receives Q's cached verdict, rejects it, and ends `'unconfirmed'`.

**Ordering:**

18. F1 is at risk, then F2 is dispatched after catch-up. Alice receives F1′ before F2.
19. **Same-epoch at-risk replacement.** F1′ at E+1 is at risk because C2 is already on the hub. F2 dispatched now is published after F1′ and re-sealed after F1″, and a receiver at E+2 sees F1″ before F2′.
20. **Concurrent dispatch, delayed first insert.** Two dispatches are issued without awaiting, and the first `put` is delayed. The second `put` resolves and kicks the worker, which publishes nothing until the first resolves. Publications follow call order.
21. **Rejected insert.** The first `put` rejects. Its `dispatch` rejects, its reservation is released, and the second entry is published.
22. **Simultaneous calls at the cap.** With one slot free, two dispatches are issued without awaiting. Exactly one resolves, and the other rejects with `AppOutboxFullError`.
23. **Adoption callback awaiting dispatch.** Run in `@kumiai/integration-tests` against the real `createGroupMLS` with `simpleHandleAccess` (as `tests/integration/test/app-lane-e2e.ts:189-209` wires them), not the RPC double. A host adoption callback inside `replace` awaits `GroupMLS.sendAdmission()` and then `dispatch`. Both resolve, the adoption completes, and the admission reports the pre-adoption epoch with its own verdict. After `replace` resolves, it reports the new epoch. The queued entry is sealed only at an epoch whose admission matches the ciphertext epoch.

**Wakeups and failures:**

24. **Delayed put.** A `put` resolves after the sender has ratcheted and finished its lane operation. The entry is still published at the current epoch and delivered.
25. **Failed probe, failed write and failed remove**, each with no further commit. The entry is retried on backoff and delivered, or removed, without another lane trigger.
26. **Publish fails after the prepared write.** `lastAttempt` is written and the hub publish then fails, with no later commit. The entry is published again at the same epoch on backoff and delivered.
27. **Backpressure.** At `appOutboxLimit`, `dispatch` rejects with `AppOutboxFullError`, and nothing already queued is dropped.

**Crash:**

28. **Crash after an at-risk publish.** Bob is killed before his walk. On restart with the same outbox, alice receives F.
29. **Crash before publish.** The entry is written but not published. On restart, alice receives F.
30. **Crash between probe and publish.** C lands after recovery's catch-up and before its publish. The post-publish probe flags the entry, and it is re-sealed and delivered.
31. **Crash before anchor save.** Bob applies a roster commit, and the handle is durable but the anchor save is lost. On restart the anchor is repaired before the worker and before any advance runs. Bob's and alice's anchors have the same epoch, and the topic each derives for the protocol is identical. Alice actually receives the recovered entry on that topic. Without the repair, the test fails.
32. **Rotation record, advance not landed.** A crash before `processCommit` persists leaves `pending` at the current epoch. The anchor is unchanged and the record is dropped.
33. **Throwing adoption, then another advance.** A roster change moves E to E+1. Bob's replacement is persisted and adopted, then his adoption callback throws. A non-rotating commit to E+2 follows. Bob's anchor is captured at E+1 in the throwing advance's catch path, before the E+2 advance starts, and the seal barrier holds until it is. After E+2, bob and alice have the same anchor epoch (E+1) and derive the same topic, and alice receives an entry bob dispatches. Run twice: in-process, and with a restart between the throw and the E+2 commit, where init repair captures E+1. Without the fix, bob captures at E+2 and alice never receives the entry.
    - **33a. Persisted, not adopted, then restart.** The replacement is persisted, the callback throws before the host swaps its handle, and the port still reads E. The record stays. After a restart the durable handle is at E+1, init repair captures E+1, and the same three assertions hold.
    - **33b. Secret gone.** The slot holds a record for E to E+1, and the handle is at E+2 when it is resolved (a handle advanced outside `advanceHandle`). Bob derives no topic from E+2, keeps the seal barrier and rejoins with trigger `'automatic'`. After the rejoin is confirmed and lands, bob and alice share the rejoin epoch's anchor and topic, and alice receives the entry. Run twice: in-process, and as a **fresh process start** over that slot and handle, with an entry already in the outbox. In the fresh start, `ready` resolves without awaiting recovery; `onRecovery` reports `started` then `succeeded`; until then `commit()` is refused, no app frame is published and no other advance lands; after it, alice receives the entry. Without the startup phase, `ready` never resolves or rejects, and nothing is delivered.
    - **33d. Rejected external commit, then an ordinary commit.** Carol publishes an external commit that a caller policy shared by bob and alice rejects; bob's and alice's handles stay at E. Alice then commits a non-roster ledger commit to E+1. Bob processes both in one process; dave, a third receiver, restarts between them. Bob, alice and dave end with the same anchor epoch and the same app topic, and an entry dave dispatches reaches bob and alice. Without the fix, bob's carried `forced` rotates his anchor at E+1 while dave, whose restart dropped the record, keeps the old one.
    - **33c. Membership returns to the original roster.** Carol is added (E to E+1) with bob's adoption throwing, then removed (E+1 to E+2). Bob's anchor matches alice's after each step, at E+1 and then E+2, and alice receives an entry dispatched after each.

**Membership and lapse:**

34. **Removed sender.** Bob is removed while detached and dispatches at E, then pulls. He publishes nothing after the pull, his outbox is empty, and `onAppOutboxCleared` fires.
35. **Removed member.** Carol is removed and bob re-seals. Carol cannot open F′, and F′ is on the new segment topic.
36. **Lapsed sender.** `dispatch` from a lapsed leaf rejects with `SendNotAdmissibleError` whose `reason` is `'lapsed'`.
36a. **Revoke hold.** While a `commit()` with `holdLogSends` is queued, rebuilding or publishing, a dispatched entry resolves and is sealed by no pass, probe or backoff; after the commit lands, the pass publishes it at the new epoch. Killed after the journal write and before the publish: after restart the journal's flagged entry holds the worker until the replay lands it, then the entry is delivered. A flagged commit known unlanded releases the hold. Without the journal flag, the entry is published before the revoke after restart. **Sealed before the hold:** the worker seals F and its `lastAttempt` write is paused; the revoke starts; the write then resolves. F is not submitted, the revoke lands, and F is re-sealed at the new epoch and delivered. With the hold checked only at seal, F reaches the hub before the revoke. **In flight at the hold:** F's publish is submitted and paused at the hub; the revoke starts. The revoke commit is not journalled or published until F's publish settles, and no other log frame is submitted meanwhile.
36b. **Entry bound.** A `dispatch` of 524,289 plaintext bytes rejects with `AppEntryTooLargeError` and reserves nothing; one of 524,288 bytes is published and delivered through the hub.
37. **Lapse after enqueue.** A commit lapses bob after enqueue. The entry is held, and nothing is published. After renewal it is published and delivered. If bob's leaf is instead removed as lapsed, the queue is cleared with a notice.

**Subscribe and mux:**

38. **Mux hand-off.** A frame pushed on a retained topic before any listener exists reaches the first listener registered within TTL, and is acked once, after that listener acks.
39. **Delayed hub subscription.** A frame published before the new subscription is acknowledged is not delivered live, and a frame published after it is.
40. **Bounds pinned.** Two commits in one walk, and a walk past the TTL. The intermediate-epoch frame is not delivered. These tests document the narrowed promise.

**Hub:**

41. **Conformance clauses** run against the memory store and `DurableFakeHub`, with separate publisher and reader clients, and with a trim and a purge between publish and fetch. Clause 3 checks `oldest` and every later log frame after each removal. **Backward clock** (`testHubStoreConformance`, so the memory store and kubun's SQL store on SQLite and PostgreSQL; the suite drives the store's clock): publish A, step the clock back, publish B on the same topic, then purge with a bound that B's timestamp passes and A's does not. Purge never removes B while keeping A, and a fetch with no cursor returns A then B with `gap: false`. Mailbox frames on the topic still age out by their own timestamps.
42. **Gap clause (clause 4), `testHubStoreConformance`** (`@kumiai/hub-conformance`, run by `hub-server/test/conformance.test.ts` and by kubun's store). Each case uses trim, then purge, then depth eviction as the deleter:
    - **Trimmed behind the cursor.** Publish a, b, c. Remove a and b (a prefix, as clause 3 requires). A fetch after a returns `[c]` with `gap: true`.
    - **Only the cursor's frame removed.** Publish a, a frame on another topic, a mailbox frame on this topic, then b. Remove a. A fetch after a returns `[b]` with `oldest` beyond `a` and `gap: false`.
    - **Empty page.** Publish a, b. Remove both. A fetch after a is empty with `head` b and `gap: true`. A fetch after b reports `gap: false`.
    - **No cursor.** `gap` is true once any log frame of the topic was removed, and false before.
    - **Mailbox removal.** An acked or aged-out mailbox frame never sets `gap`.
    - **Stored state.** After later publishes, a fetch from the old cursor still reports `gap: true`.
43. **Gap clause, `testLogHubConformance`**, by depth eviction, against `FakeHub` and `DurableFakeHub` (`rpc/test/hub-conformance.test.ts`) and over the wire (`hub-server/test/log-hub-conformance.test.ts`): the trimmed-behind-cursor, cursor-only and empty-page cases above.
44. **App lane notice.** On an app topic, the cursor's own frame aged out with nothing behind it: no `onAppWindowPruned`, which fires today. Frames after the cursor aged out while later ones remain: one notice with `oldest` set. Every frame after the cursor aged out: one notice with `oldest` null, which today is silent, and further pulls from that cursor add no second notice. **Between pages:** the first page is covered, and a prefix reaching past its last frame is removed before the second fetch while later frames remain: one notice whose `cursor` is the second fetch's `after`. **Between pulls:** with no anchor change, a pull reads through A; B is published and removed, C stays; the next pull reports one notice with cursor A and `oldest` C, which today is silent. No cursor: no notice. In `@kumiai/rpc` (`peer-app-cursor.test.ts`).
45. **Gap crosses the wire** (`@kumiai/integration-tests`, `hub-log-lane.test.ts`): `gap` from the memory store reaches a `HubClient` reader through the handler.

Existing init-race tests (`peer-delivery-before-ready.test.ts`, `hub-mux-ack-refcount.test.ts`) may need updating for §6.

## Release

- Patch versions for `@kumiai/rpc` (and the confirmation messages), `@kumiai/mls` (verdict seal, rejection reason), `@kumiai/mls-rpc` (`sendAdmission`, `confirmationKey`, verdicts), `@kumiai/hub-protocol` and `@kumiai/hub-server` (`gap`, prefix-only purge), `@kumiai/hub-client` and `@kumiai/hub-tunnel` (the `gap` result field) and `@kumiai/hub-conformance` (clause 4, and clause 3's backward-clock case).
- Breaking, kubun being the single consumer:
  - `GroupPeerMLSParams` (`AppOutbox`, `appOutboxLimit`, the anchor-slot rotation record with `epochAfter` and `advance`), `GroupMLS` (`sendAdmission`), `HandleAccess` (`admission`), `StrandKind` (`'retention-gap'`), `AppWindowPruned` (`oldest` nullable), and every `HubStore` and `LogHub` (`gap` is required);
  - `dispatch`'s entry bound (`AppEntryTooLargeError`), `GroupPeer.commit`'s `holdLogSends` option and `JournalEntry.holdsLogSends`, and `FrameTooLargeError` from the whole-frame check;
  - as the bound-leaf spec defines them: `GroupMLSParams.recoveryBinding`, `GroupMLS.prepareRecovery`, and `RecoveryFailureReason` `'renewal-required'`;
  - recovery confirmation (§1, §5): `PendingRecovery` (`epoch`, `confirmationKey`, `judgeVerdict`, idempotent `onAccepted`), `GroupMLS` (`confirmationKey`, `sealRecoveryVerdict`, `openRecoveryVerdict`), `ProcessCommitResult` (`refusal`), the exported `RecoveryRefusalReason`, `CommitRejectedError` (a reason), and `RecoveryFailureReason` (`'refused'`, carrying `refusal` and `responder`, and `'unconfirmed'`, carrying `advisory`), all reported as `phase: 'failed'`.
- `gap` is required in the wire result schema. A missing `gap` is unsafe either way: read as true, every walk rejoins; read as false, a real gap certifies. The walk therefore fails a fetch whose reply has no boolean `gap`, as it fails any fetch, and the pull retries. The hub is deployed before or with its peers.
- Two new rendezvous messages, `HANDSHAKE_KIND.recoveryConfirmRequest` `{ requestID, request, position, commitDigest }` and `HANDSHAKE_KIND.recoveryVerdict` `{ requestID, sealed }` (§1), in `@kumiai/rpc`, with the verdict seal in `@kumiai/mls` and `@kumiai/mls-rpc`. A peer drops a kind it does not know (`peer.ts:1836-1846`), so an old responder never answers, and a new rejoiner then never adopts: every rejoin ends `'unconfirmed'`. Rejoiners and responders must therefore ship in the same release. `HANDSHAKE_VERSION` does not change, since an old peer ignoring the new kinds is the safe direction.
- Released together with `feat/bound-leaf-lifecycle`, which defines lapse.
- kubun then:
  - bumps;
  - implements `gap` in its own hub store. kubun's relay takes its handlers, and with them the wire field, from `@kumiai/hub-server` (`create-relay.ts:9`). Its `HubStore`, however, is kubun's SQL store (`packages/hub/src/hub-store.ts:148`), not the memory store, so the bump alone does not provide `gap`. The store keeps a per-topic `removed_through` on `kubun_hub_topics`, raised atomically with each log-class delete in `deleteFrames` (`hub-store.ts:175`), which trim, purge and depth eviction all use. `fetchTopic` reads it with `head` and the page in one snapshot; today those are separate statements outside a transaction (`hub-store.ts:428-490`). The store then passes clause 4 in `packages/hub/test/conformance.test.ts`;
  - makes its purge prefix-only (clause 3). It stamps `stored_at` with `Date.now()` (`hub-store.ts:288`) and selects every frame of a topic past the age bound (`:586-591`) before deleting them (`:599`). It now selects, per topic, the log frames in `sequence_id` order up to the first one it must retain, ages mailbox frames out separately, and deletes the prefix and raises `removed_through` in one transaction. The backward-clock case (test 41) runs on SQLite and PostgreSQL;
  - forwards `gap` in its client `LogHub` adapter (`plugin-p2p/src/hub/hub-like.ts:931`, next to `oldest`), handles the `'retention-gap'` strand kind, supplies `recoveryBinding()` and handles the `'renewal-required'` recovery outcome, and reruns a revoke whose `commit()` threw (bound-leaf Consumer contract, items 4 and 10), never treats `FrameTooLargeError` as a strand or a lost commit, reports the `'refused'` outcome (with the refusal's reason) and treats `'unconfirmed'` as retrying, and accepts a null `AppWindowPruned.oldest` (its handler at `plugin-p2p/src/groups/group-peer-manager.ts:1111` only logs it);
  - adds the outbox store and its migration, and stores `JournalEntry.holdsLogSends` in its commit journal;
  - runs one peer per group, on the group's designated commit hub, which holds the group's outbox, journal and anchor store and carries all its traffic; other bound hubs are failover candidates, and a designation change disposes the old peer before the new one starts (§5, *One owner per group*). Today it creates a peer per bound hub (`plugin-p2p/src/groups/group-peer-manager.ts:1125`, `:1476`), hands each the same group journal and anchor store (`:1061-1062`) and fans broadcasts out over all of them (`:1286`, `:1317`);
  - extends its anchor store for the rotation record;
  - publishes `admission()` from its registry `HandleAccess` alongside `epoch()`, without taking the handle lock;
  - treats a resolved `dispatch` as durable acceptance, not publication, and handles `SendNotAdmissibleError`, `AppOutboxFullError`, `AppEntryTooLargeError` and `onAppOutboxCleared`;
  - encrypts the outbox at rest and clears it on group deletion;
  - makes its log handlers completion-safe on retry, starting with the share handler;
  - turns its reproducing test (`i6-epoch-change-broadcast.test.ts`) green.
