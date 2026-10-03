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
- **Backpressure, not loss.** When the outbox is at the host's cap, `dispatch` rejects. Nothing is silently dropped.
- **Held behind a retention gap.** If commit-topic retention removed frames the sender never read, an at-risk entry is held until the sender's next ratchet (§1, §4), even when the removed frames were not commits, or only the floor's own frame aged out.
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

- It is set inside `advanceHandle`, after a successful ratchet and before the seal barrier is released, from the position the caller applied: the walk position, or the accepted `sequenceID` for own commit, replay and rejoin.
- At the end of a complete, covered walk that did not ratchet, it rises to `reconciledHead`, **unless the walk stranded** or `floor.covered` is false. `reconciledHead` steps over `ahead` and `fork-losing` frames (`peer.ts:1604-1644`) that other members did apply, so raising the floor there would prove an at-risk frame safe. `own-unmerged` stops the walk early, so that walk is not complete.
- It is never taken from `reconciledHead` before a ratchet. `commit()` and `replayJournal` move `reconciledHead` before the handle ratchets (`peer.ts:2294` vs `2308`, `1940` vs `1948`), and using it in that window would prove an at-risk frame safe.

**Covered walk.** A walk drains with no error even when commit bodies after its cursor were removed: an empty page records the head and returns (`peer.ts:1466-1471`). A walk is **covered** when every page it fetched reported `oldest` at or before that page's `after` cursor (or `oldest` null and `after` equal to `head`), and its final page's `head` equals the cursor it ended at. A fetch with no cursor is never covered. With prefix-only removal (§7, clause 3), a covered walk read every commit-topic frame after its starting cursor.

The peer keeps `floor.covered`. A ratchet sets it to true, since the floor is then a frame the peer applied. Any uncovered walk sets it to false until the next ratchet. While it is false, no walk raises the floor or certifies a publication (§4).

### 2. Sealing a log entry

A log seal returns `{ topicID, payload, epoch, floor }`, where `epoch` is read from the ciphertext (`GroupCrypto.frameEpoch`), not from the hint.

- The seal reuses `sealForSegment`'s `anchor === at && sealBarrier == null` check (`peer.ts:917-921`), and in the same synchronous step snapshots `floor`.
- It is accepted only if `floor.epoch` equals the ciphertext epoch. Otherwise it seals again. The anchor-identity check alone does not catch a non-rotating advance that started and finished during `wrap`, and that case pairs E's ciphertext with E+1's floor.
- **Sender admission.** The MLS port publishes whether the local leaf may send an application message (new `GroupMLS.sendAdmission(): SendAdmission`, with `SendAdmission = { epoch: number; admissible: true } | { epoch: number; admissible: false; reason: 'lapsed' }`). It is a synchronous published snapshot, like `GroupCrypto.epoch()` (`crypto.ts:33`): it takes no lock and pairs the verdict with the epoch of the one handle state it was read from. The worker revalidates in the same synchronous step as the floor snapshot, and accepts a seal only when the snapshot's `epoch` equals the ciphertext epoch and `admissible` is true. A snapshot that lags the ciphertext epoch is retried on the next trigger. Under the companion bound-leaf spec, lapse is a pure function of the epoch's tree (`L.exp < treeTime(H)`), so any snapshot at E gives the sender's verdict at E, and that is every receiver's verdict at E. A floating leaf is always admissible.

### 3. Dispatch

`dispatch` for a log event:

1. **Synchronously, on entry**, in one step:
   - reads `sendAdmission()`, and refuses an inadmissible sender with `SendNotAdmissibleError` (an `@kumiai/rpc` class carrying the port's `reason`; `@kumiai/rpc` does not depend on `@kumiai/mls`, so it cannot throw `LeafLapsedError`). No durable promise is made for an event the group would drop;
   - counts outstanding entries plus unresolved reservations, and at `appOutboxLimit` rejects with `AppOutboxFullError`;
   - reserves the next `seq`.
2. `put`s the entry. If `put` rejects, the reservation is released and `dispatch` rejects. `put` is atomic, so a rejected insert leaves no row.
3. Resolves when `put` resolves, and kicks the worker.

A `dispatch` issued before init has listed the outbox waits for that listing, which is not a lane operation, and then reserves in call order. Reservation order is call order, so the queue order cannot depend on admission or storage latency.

The worker never passes an unresolved reservation: it works only entries whose `seq` is below the lowest reservation still awaiting its `put`.

`dispatch` never waits on a lane operation, the commit mutex, the worker or the MLS port's handle lock, so a host may await it from inside an epoch or adoption callback. The host's `put` must not wait on the host's own in-flight adoption transaction either.

**Snapshot timing.** `HandleAccess.admission()`, which backs `sendAdmission()`, is published together with `epoch()`, from the same handle state and at the same points. In `simpleHandleAccess` those are the end of `mutate` and `open`, and the return of `replace`'s adoption callback (`access.ts:58`, `:65`, `:71`). A `dispatch` inside an adoption callback therefore sees the pre-adoption state. If that state is admissible and the adopted one is not, the entry is held (§4). If it is lapsed and the adopted one is renewed, the caller is refused and may retry once the callback returns.

**What the promise means.** Resolved: the event is durable and the promise in the Goal applies. Rejected: the event was not accepted, and nothing will be published.

Admission is checked again at every seal (§2), because a commit after enqueue can lapse the sender.

Rejecting at the cap rather than blocking keeps `dispatch` callback-safe: a blocked `dispatch` inside a lane callback would wait on a worker that waits on that lane. Refusing a lapsed sender at enqueue is simpler than accepting and holding: the caller learns at once, and only the rare lapse after enqueue needs the hold path.

Ephemeral and directed frames are unchanged. They never enter the outbox.

### 4. The send queue and its worker

One durable, ordered log send queue per group, worked by a single worker.

**Per entry, in `seq` order:**

1. **Catch up.** If the last commit-head observation (from a probe or a pull) is beyond `floor.position`, run a pull as a lane operation and await it. The worker is never itself inside a lane operation.
2. **Hold or seal.** If the peer is stranded, or not admissible at the current epoch, stop the pass here. Otherwise, if the entry has no acknowledged publication at the current epoch, seal it (§2).
3. **Durable update.** Write the prepared attempt `{ epoch, floor, attempts }` to the entry's `lastAttempt`.
4. **Publish.** When the hub acknowledges it, record the publication `{ epoch, floor }` in memory as **acknowledged**.

Only an acknowledged publication counts as published: it alone is skipped at its epoch, probed or certified. A prepared attempt whose publish failed or has an unknown outcome is published again, since duplicates are allowed. `lastAttempt` is for backoff and host inspection, never evidence.

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

**Retention gap.** An uncovered head movement certifies nothing. A trimmed commit after the floor leaves an empty page whose head is ahead of the cursor, so the walk is uncovered and the entry stays queued. The entry is then held at its epoch with no republication, and catch-up pulls continue on backoff, until the next ratchet re-seals it. A ratchet comes from a later commit the peer can apply, or from recovery.

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

- Before every handle advance, `advanceHandle` saves `{ anchor, pending: { epochBefore, rosterBefore, forced } }`. `forced` is `header.external` for an applied commit and `true` for a rejoin.
- **An unresolved record is never replaced.** If the slot still holds `pending` from an advance that threw, the next pre-advance write keeps that record's `epochBefore` and `rosterBefore` and ORs its `forced`. An advance that throws can still have landed durably: `simpleHandleAccess` persists the replacement before awaiting the host's adoption callback (`access.ts:61-65`), and `advanceHandle` observes a moved epoch after `advance()` throws but does not capture the anchor (`peer.ts:1416-1419`).
- **Resolution.** Only an advance that returns resolves the record. It decides the rotation against the record, not its own pre-state: it rotates when the handle's epoch differs from `epochBefore` and either `forced` is set or the roster differs from `rosterBefore`. It then saves `{ anchor }`, with the new anchor if it rotated. Each write carries the in-memory anchor, so a failed post-advance save is repaired by the next write.
- **Init repair.** The repair runs before the worker, against the durable handle. If the stored slot has `pending` and the handle's epoch is not `epochBefore`, the peer applies the same decision. If it rotates, the peer captures the anchor from the current epoch, the one epoch whose secret the handle still holds. If the epoch is `epochBefore`, no advance landed, and the record is dropped.
- The anchor is still never recomputed for an epoch the handle has left.
- The cost is one extra slot write per advance.

A pure recompute from the handle alone is impossible: the rotation decision needs the pre-advance roster, which the advance destroys.

**`HandleAccess`** in `@kumiai/mls-rpc` gains a synchronous `admission(): SendAdmission`, published with `epoch()` initially and at each publication point (§3). `simpleHandleAccess` reads it from the handle there. This requires the companion spec's `GroupHandle.sendAdmission()` to be synchronous, which a pure function of the tree allows.

**`GroupMLS.sendAdmission`** is new (§2). `@kumiai/mls-rpc` implements it as `access.admission()`, never through `access.read`: `read` queues behind a `replace` that is awaiting the host's adoption callback (`access.ts:28-38`, `:47`, `:61-65`), so a `dispatch` awaited inside that callback would deadlock.

These changes are breaking for `GroupPeerMLSParams`, `GroupMLS` and `HandleAccess`. They ship as a patch version, because kubun is the single consumer.

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
3. Log-class removal on a topic is **prefix-only**: while a log frame is retained, every later log frame on that topic is retained, and `oldest` is the earliest retained one.

The probe (§4) depends on clause 1 from commit topic to app topic. The receiver's pre-apply drain depends on it the other way round. The covered-walk test (§1) depends on clause 3. The memory store and `DurableFakeHub` already satisfy all three: both trim by a `before` bound, the memory store purges at one retention per topic, and `DurableFakeHub` evicts oldest first (`memoryStore.ts:394-405`, `:413-431`, `durable-fake-hub.ts:116-125`, `:202-204`).

### 8. Contract docs

- `dispatch` / `retentionOf`: what the resolved promise means (§3), at-least-once delivery, and handlers that are completion-safe on retry.
- Per-sender log order is kept.
- Ephemeral delivery has the narrowed promise of §6.
- `AppOutbox`: plaintext category, retention, host encryption and erasure (§5).
- `HandleAccess.admission` / `GroupMLS.sendAdmission`: a lock-free snapshot published with `epoch()`, and a `HandleAccess` implementation must never read it under the handle lock (§3, §5).

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
8. **Trimmed commit body, advanced head (I7, R-I6).** C leaves E and a receiver applies it. F is then published at E, and C is trimmed before the sender's probe and walk. The probe sees an empty page and a later head. The following walk drains an empty page, ends at E without stranding, and is uncovered. F stays queued and is not certified.
9. **Two commits in one walk.** Bob is two commits behind when he dispatches. F′ is sealed at E+2, never at E+1, and alice receives it.
10. **False positive cleared (I6).** A poison frame follows the floor. After a covered non-ratcheting walk, the entry is retired with no re-seal.
11. **Gap behind a retained frame.** A commit after the floor is trimmed while a later poison frame stays retained. The walk reads the poison frame, but its first page's `oldest` is after its cursor, so it is uncovered: the floor does not rise and F is not certified.
12. **Stranded walk does not raise the floor.** An `ahead` frame is stepped over. The entry stays held until `recover()` lands, then is re-sealed.

**Ordering (I3):**

13. F1 is at risk, then F2 is dispatched after catch-up. Alice receives F1′ before F2.
14. **Same-epoch at-risk replacement.** F1′ at E+1 is at risk because C2 is already on the hub. F2 dispatched now is published after F1′ and re-sealed after F1″, and a receiver at E+2 sees F1″ before F2′.
15. **Concurrent dispatch, delayed first insert.** Two dispatches are issued without awaiting, and the first `put` is delayed. The second `put` resolves and kicks the worker, which publishes nothing until the first resolves. Publications follow call order.
16. **Rejected insert.** The first `put` rejects. Its `dispatch` rejects, its reservation is released, and the second entry is published.
17. **Simultaneous calls at the cap.** With one slot free, two dispatches are issued without awaiting. Exactly one resolves, and the other rejects with `AppOutboxFullError`.
18. **Adoption callback awaiting dispatch.** Run in `@kumiai/integration-tests` against the real `createGroupMLS` with `simpleHandleAccess` (as `tests/integration/test/app-lane-e2e.ts:189-209` wires them), not the RPC double. A host adoption callback inside `replace` awaits `dispatch`. It resolves with the pre-adoption snapshot, and the commit completes.

**Wakeups and failures (I2):**

19. **Delayed put.** A `put` resolves after the sender has ratcheted and finished its lane operation. The entry is still published at the current epoch and delivered.
20. **Failed probe, failed write and failed remove**, each with no further commit. The entry is retried on backoff and delivered, or removed, without another lane trigger.
21. **Publish fails after the prepared write (R-I5).** `lastAttempt` is written and the hub publish then fails, with no later commit. The entry is published again at the same epoch on backoff and delivered.
22. **Backpressure.** At `appOutboxLimit`, `dispatch` rejects with `AppOutboxFullError`, and nothing already queued is dropped.

**Crash (I1, I8):**

23. **Crash after an at-risk publish.** Bob is killed before his walk. On restart with the same outbox, alice receives F.
24. **Crash before publish.** The entry is written but not published. On restart, alice receives F.
25. **Crash between probe and publish.** C lands after recovery's catch-up and before its publish. The post-publish probe flags the entry, and it is re-sealed and delivered.
26. **Crash before anchor save.** Bob applies a roster commit, and the handle is durable but the anchor save is lost. On restart the anchor is repaired before the worker runs, and alice receives the recovered entry on the new segment. Without the repair, the test fails.
27. **Rotation record, advance not landed.** A crash before `processCommit` persists leaves `pending` at the current epoch. The anchor is unchanged and the record is dropped.
28. **Throwing adoption, then another advance (R-I7).** A roster-changing replacement is persisted and the host's adoption callback throws. A non-rotating advance follows, then a restart. The pending record still carries the roster from before the roster change, the anchor is captured at the current epoch, and alice receives the recovered entry. Without restart, the non-rotating advance's resolution captures it in-process.

**Membership and lapse (I10):**

29. **Removed sender.** Bob is removed while detached and dispatches at E, then pulls. He publishes nothing after the pull, his outbox is empty, and `onAppOutboxCleared` fires.
30. **Removed member.** Carol is removed and bob re-seals. Carol cannot open F′, and F′ is on the new segment topic.
31. **Lapsed sender.** `dispatch` from a lapsed leaf rejects with `SendNotAdmissibleError` whose `reason` is `'lapsed'`.
32. **Lapse after enqueue.** A commit lapses bob after enqueue. The entry is held, and nothing is published. After renewal it is published and delivered. If bob's leaf is instead removed as lapsed, the queue is cleared with a notice.

**Subscribe and mux (I4, I5):**

33. **Mux hand-off.** A frame pushed on a retained topic before any listener exists reaches the first listener registered within TTL, and is acked once, after that listener acks.
34. **Delayed hub subscription.** A frame published before the new subscription is acknowledged is not delivered live, and a frame published after it is.
35. **Bounds pinned.** Two commits in one walk, and a walk past the TTL. The intermediate-epoch frame is not delivered. These tests document the narrowed promise.

**Hub:**

36. **Conformance clauses** run against the memory store and `DurableFakeHub`, with separate publisher and reader clients, and with a trim and a purge between publish and fetch. Clause 3 checks `oldest` and every later log frame after each removal.

Existing init-race tests (`peer-delivery-before-ready.test.ts`, `hub-mux-ack-refcount.test.ts`) may need updating for §6.

## Release

- Patch versions for `@kumiai/rpc`, `@kumiai/mls-rpc` (`sendAdmission`) and `@kumiai/hub-conformance`.
- Breaking for `GroupPeerMLSParams` (`AppOutbox`, `appOutboxLimit`, the anchor-slot rotation record), `GroupMLS` (`sendAdmission`) and `HandleAccess` (`admission`). kubun is the single consumer.
- Released together with `feat/bound-leaf-lifecycle`, which defines lapse.
- kubun then:
  - bumps;
  - adds the outbox store and its migration;
  - extends its anchor store for the rotation record;
  - publishes `admission()` from its registry `HandleAccess` alongside `epoch()`, without taking the handle lock;
  - treats a resolved `dispatch` as durable acceptance, not publication, and handles `SendNotAdmissibleError`, `AppOutboxFullError` and `onAppOutboxCleared`;
  - encrypts the outbox at rest and clears it on group deletion;
  - makes its log handlers completion-safe on retry, starting with the share handler;
  - turns its reproducing test (`i6-epoch-change-broadcast.test.ts`) green.
