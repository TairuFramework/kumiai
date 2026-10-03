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
- **Over-approximation.** The at-risk check counts any commit-topic movement after the floor, including history, poison and non-advancing frames. The cost is one extra duplicate.
- **Backpressure, not loss.** When the outbox is at the host's cap, `dispatch` rejects. Nothing is silently dropped.
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

The peer tracks `floor = { epoch: number, position: LogPosition | null }`: the commit-topic position at which its handle entered `epoch`. `null` is genesis or a fresh join with nothing applied yet.

- It is set inside `advanceHandle`, after a successful ratchet and before the seal barrier is released, from the position the caller applied: the walk position, or the accepted `sequenceID` for own commit, replay and rejoin.
- At the end of a complete walk that did not ratchet, it rises to `reconciledHead`, **unless the walk stranded**. `reconciledHead` steps over `ahead` and `fork-losing` frames (`peer.ts:1604-1644`) that other members did apply, so raising the floor there would prove an at-risk frame safe. `own-unmerged` stops the walk early, so that walk is not complete.
- It is never taken from `reconciledHead` before a ratchet. `commit()` and `replayJournal` move `reconciledHead` before the handle ratchets (`peer.ts:2294` vs `2308`, `1940` vs `1948`), and using it in that window would prove an at-risk frame safe.

### 2. Sealing a log entry

A log seal returns `{ topicID, payload, epoch, floor }`, where `epoch` is read from the ciphertext (`GroupCrypto.frameEpoch`), not from the hint.

- The seal reuses `sealForSegment`'s `anchor === at && sealBarrier == null` check (`peer.ts:917-921`), and in the same synchronous step snapshots `floor`.
- It is accepted only if `floor.epoch` equals the ciphertext epoch. Otherwise it seals again. The anchor-identity check alone does not catch a non-rotating advance that started and finished during `wrap`, and that case pairs E's ciphertext with E+1's floor.
- **Sender admission.** Before sealing, the worker asks the MLS port whether the local leaf may send an application message at the current epoch (new `GroupMLS.sendAdmission(): Promise<{ epoch: number; admissible: true } | { epoch: number; admissible: false; reason: 'lapsed' }>`). It seals only when `admissible` is true and `epoch` matches the ciphertext epoch. Under the companion bound-leaf spec, lapse is a pure function of the epoch's tree (`L.exp < treeTime(H)`), so the sender's verdict at E is every receiver's verdict at E. A floating leaf is always admissible.

### 3. Dispatch

`dispatch` for a log event:

1. Checks admission at the current epoch. A sender the port reports inadmissible is refused with `SendNotAdmissibleError` (an `@kumiai/rpc` class carrying the port's `reason`; `@kumiai/rpc` does not depend on `@kumiai/mls`, so it cannot throw `LeafLapsedError`). No durable promise is made for an event the group would drop.
2. Checks the outbox cap. At the cap it rejects with `AppOutboxFullError`.
3. Assigns the next `seq` synchronously, at call time, and `put`s the entry.
4. Resolves when `put` resolves, and kicks the worker.

It never waits on a lane operation, the commit mutex or the worker, so a host may await it from inside an epoch or adoption callback. The host's `put` must not wait on the host's own in-flight adoption transaction either.

**What the promise means.** Resolved: the event is durable and the promise in the Goal applies. Rejected: the event was not accepted, and nothing will be published.

Admission is checked again at every seal (§2), because a commit after enqueue can lapse the sender.

Rejecting at the cap rather than blocking keeps `dispatch` callback-safe: a blocked `dispatch` inside a lane callback would wait on a worker that waits on that lane. Refusing a lapsed sender at enqueue is simpler than accepting and holding: the caller learns at once, and only the rare lapse after enqueue needs the hold path.

Ephemeral and directed frames are unchanged. They never enter the outbox.

### 4. The send queue and its worker

One durable, ordered log send queue per group, worked by a single worker.

**Per entry, in `seq` order:**

1. **Catch up.** If the last commit-head observation (from a probe or a pull) is beyond `floor.position`, run a pull as a lane operation and await it. The worker is never itself inside a lane operation.
2. **Hold or seal.** If the peer is stranded, or not admissible at the current epoch, stop the pass here. Otherwise, if the entry has no publication at the current epoch, seal it (§2).
3. **Durable update.** Write the publication's `{ epoch, floor }` and attempt count to the entry.
4. **Publish.**

The pass stops at the first entry it cannot publish (held, failed or barrier). A later entry never gets a publication at an epoch before every earlier unresolved entry has one there. This keeps per-sender order for first publications and for every re-seal. An entry already published at the current epoch is not republished.

**Probe.** After the pass's last publish is acknowledged, one probe reads `fetchTopic(commitTopic, { after: floor.position, limit: 1 })`.

- **Safe** when `head` is at or below `floor.position` (both `null` counts as safe). Every publication of the pass at that floor is proven, and those entries are removed.
- **At risk** otherwise, whatever `messages` holds. The head is stored state and survives trim and purge (`hub-protocol/src/types.ts:118-128`), so an empty page with a later head is not clean. A gap below `oldest` changes nothing, because the decision reads only `head`. The worker then calls `requestAppPull()`.

**Reconciliation certificate.** A complete walk that started after a publication was acknowledged also proves it, if the walk ended at that publication's epoch and did not strand. Every commit ordered before the publication was then ordered before the walk, and the walk applied or rejected all of them at that epoch. The worker re-evaluates after every reconciliation, ratcheting or not. That clears false positives from history, poison and non-advancing frames, which a probe alone would keep flagging under traffic.

**Triggers.** The worker runs on enqueue, on probe result, at init after the anchor repair and seed pull (§5), on every lane operation's completion, and on its backoff timer.

**Failures.** A failed seal, publish, probe, durable update or remove keeps the entry and retries with exponential backoff (1 s doubling to 60 s, like the app pull). A failed remove retries the remove alone. A pass handles at most a bounded number of entries and then yields. The bound under sustained commit pressure is conditional: an entry is delivered at the first epoch where no commit lands between its seal and its probe.

**Removed sender.** A commit that removes the local member does not ratchet its handle (`peer.ts:1395-1404`). When an applied commit leaves `localDID` out of the roster, the peer clears the queue and calls a new `onAppOutboxCleared({ reason: 'removed', seqs })`. Those events stay lost, which is correct: the group removed S, and they landed after it did.

**Lapse after enqueue.** The entry is held (step 2) until a ratchet makes the sender admissible again (renewal) or removes it (cleared, as above). The worker does not publish a frame receivers would drop.

**Recovery.** A restart runs the same sequence: catch up, seal at the current epoch, durable update, publish, probe. A preliminary probe never certifies a later publication, so every entry left in the outbox is published again at least once. That costs at most one duplicate per entry, which at-least-once already allows.

### 5. Ports

**`AppOutbox`** is a new required member of `GroupPeerMLSParams`, together with a host-configured `appOutboxLimit`:

```ts
export type AppOutboxEntry = {
  seq: number                     // assigned at dispatch; queue order; never reused in a group
  protocol: string
  prc: string
  data: Uint8Array                // encoded event plaintext
  published: { epoch: number; floor: string | null; attempts: number } | null
}

export type AppOutbox = {
  put(entry: AppOutboxEntry): Promise<void>       // insert or replace by seq; durable before it resolves
  list(): Promise<Array<AppOutboxEntry>>          // ascending seq
  remove(seq: number): Promise<void>              // durable before it resolves; unknown seq is a no-op
  clear(): Promise<void>                          // durable before it resolves
}
```

- `epoch` is a `number`, as everywhere in RPC (`crypto.ts:33`, `crypto.ts:369`).
- `floor` is `null` at genesis, as the commit head is (`commit.ts:63`).
- At init the next `seq` is one above the highest listed.
- `published` is a record of the latest attempt, for backoff and host inspection. Recovery never uses it to skip a publication.

**Plaintext at rest.** The outbox holds **arbitrary app event plaintext**. This is a new category: the commit journal holds signed ledger bodies and the host's adoption blob (`commit.ts:76-79`), not app payloads. Retention is normally one walk, but has no bound for a stranded or lapsed sender until it recovers, renews or is removed. The host must encrypt it at rest and clear it when it deletes or leaves the group. Removing a row is not physical erasure, so the host decides how to erase.

**`AnchorStore`** gains a rotation record in its single slot, to close the anchor crash gap:

- Before every handle advance, `advanceHandle` saves `{ anchor, pending: { epochBefore, rosterBefore, forced } }`. `forced` is `header.external` for an applied commit and `true` for a rejoin.
- After the advance it saves `{ anchor }`, with the new anchor if the advance rotated. Each write carries the in-memory anchor, so a failed post-advance save is repaired by the next write.
- **Init repair.** The repair runs before the worker. If the stored slot has `pending` and the handle's epoch is not `epochBefore`, the advance landed and nothing after it did. The peer re-decides the rotation from `forced` or the diff of `rosterBefore` against the current roster. If it rotated, the peer captures the anchor from the current epoch, the one epoch whose secret the handle still holds.
- If the epoch is `epochBefore`, the advance never landed, and the record is dropped.
- The anchor is still never recomputed for an epoch the handle has left.
- The cost is one extra slot write per advance.

A pure recompute from the handle alone is impossible: the rotation decision needs the pre-advance roster, which the advance destroys.

**`GroupMLS.sendAdmission`** is new (§2). It is implemented in `@kumiai/mls-rpc` from the companion spec's tree time.

All three are breaking for `GroupPeerMLSParams`. They ship as a patch version, because kubun is the single consumer.

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

Covering a multi-epoch walk would need mailbox frames opened inside `advanceHandle` while their epoch is live, staged in plaintext, and handed to listeners after the walk. Ephemeral traffic is best-effort by ruling, so this design does not do that.

### 7. Hub conformance

New clause in `@kumiai/hub-conformance`, run with separate publisher and reader clients:

1. Publishes and fetches across all topics of one hub are **linearizable**. A fetch on any topic reflects every publish that took effect before the fetch was issued, and a publish takes effect before its acknowledgement.
2. A fetch reflects a log publish through `head` even after that publish's body is trimmed or purged. `head` never decreases.

The probe (§4) depends on clause 1 from commit topic to app topic. The receiver's pre-apply drain depends on it the other way round. The memory store and `DurableFakeHub` already satisfy both clauses.

### 8. Contract docs

- `dispatch` / `retentionOf`: what the resolved promise means (§3), at-least-once delivery, and handlers that are completion-safe on retry.
- Per-sender log order is kept.
- Ephemeral delivery has the narrowed promise of §6.
- `AppOutbox`: plaintext category, retention, host encryption and erasure (§5).

## Testing (in `@kumiai/rpc`, fixtures `makeMLSPeer`, `DurableFakeHub`, `publishCommit`, `buildLedgerCommit`, `buildRemoveCommit`)

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
8. **Trimmed commit body, advanced head (I7).** C lands after the floor and is trimmed before the probe. The probe sees an empty page and a later head, and F is kept and re-sealed.
9. **Two commits in one walk.** Bob is two commits behind when he dispatches. F′ is sealed at E+2, never at E+1, and alice receives it.
10. **False positive cleared (I6).** A poison frame follows the floor. After a non-ratcheting walk, the entry is retired with no re-seal.
11. **Stranded walk does not raise the floor.** An `ahead` frame is stepped over. The entry stays held until `recover()` lands, then is re-sealed.

**Ordering (I3):**

12. F1 is at risk, then F2 is dispatched after catch-up. Alice receives F1′ before F2.
13. **Same-epoch at-risk replacement.** F1′ at E+1 is at risk because C2 is already on the hub. F2 dispatched now is published after F1′ and re-sealed after F1″, and a receiver at E+2 sees F1″ before F2′.
14. **Concurrent dispatch.** Two dispatches are issued without awaiting, and the first `put` is delayed. Publications follow call order.
15. **Epoch callback awaiting dispatch.** A host epoch callback inside `onAccepted` awaits `dispatch`. It resolves, and the commit completes.

**Wakeups and failures (I2):**

16. **Delayed put.** A `put` resolves after the sender has ratcheted and finished its lane operation. The entry is still published at the current epoch and delivered.
17. **Failed probe, failed write and failed remove**, each with no further commit. The entry is retried on backoff and delivered, or removed, without another lane trigger.
18. **Backpressure.** At `appOutboxLimit`, `dispatch` rejects with `AppOutboxFullError`, and nothing already queued is dropped.

**Crash (I1, I8):**

19. **Crash after an at-risk publish.** Bob is killed before his walk. On restart with the same outbox, alice receives F.
20. **Crash before publish.** The entry is written but not published. On restart, alice receives F.
21. **Crash between probe and publish.** C lands after recovery's catch-up and before its publish. The post-publish probe flags the entry, and it is re-sealed and delivered.
22. **Crash before anchor save.** Bob applies a roster commit, and the handle is durable but the anchor save is lost. On restart the anchor is repaired before the worker runs, and alice receives the recovered entry on the new segment. Without the repair, the test fails.
23. **Rotation record, advance not landed.** A crash before `processCommit` persists leaves `pending` at the current epoch. The anchor is unchanged and the record is dropped.

**Membership and lapse (I10):**

24. **Removed sender.** Bob is removed while detached and dispatches at E, then pulls. He publishes nothing after the pull, his outbox is empty, and `onAppOutboxCleared` fires.
25. **Removed member.** Carol is removed and bob re-seals. Carol cannot open F′, and F′ is on the new segment topic.
26. **Lapsed sender.** `dispatch` from a lapsed leaf rejects with `SendNotAdmissibleError` whose `reason` is `'lapsed'`.
27. **Lapse after enqueue.** A commit lapses bob after enqueue. The entry is held, and nothing is published. After renewal it is published and delivered. If bob's leaf is instead removed as lapsed, the queue is cleared with a notice.

**Subscribe and mux (I4, I5):**

28. **Mux hand-off.** A frame pushed on a retained topic before any listener exists reaches the first listener registered within TTL, and is acked once, after that listener acks.
29. **Delayed hub subscription.** A frame published before the new subscription is acknowledged is not delivered live, and a frame published after it is.
30. **Bounds pinned.** Two commits in one walk, and a walk past the TTL. The intermediate-epoch frame is not delivered. These tests document the narrowed promise.

**Hub:**

31. **Conformance clauses** run against the memory store and `DurableFakeHub`, with separate publisher and reader clients, and with a trim and a purge between publish and fetch.

Existing init-race tests (`peer-delivery-before-ready.test.ts`, `hub-mux-ack-refcount.test.ts`) may need updating for §6.

## Release

- Patch versions for `@kumiai/rpc`, `@kumiai/mls-rpc` (`sendAdmission`) and `@kumiai/hub-conformance`.
- Breaking for `GroupPeerMLSParams` (`AppOutbox`, `appOutboxLimit`, the anchor-slot rotation record) and `GroupMLS` (`sendAdmission`). kubun is the single consumer.
- Released together with `feat/bound-leaf-lifecycle`, which defines lapse.
- kubun then:
  - bumps;
  - adds the outbox store and its migration;
  - extends its anchor store for the rotation record;
  - encrypts the outbox at rest and clears it on group deletion;
  - makes its log handlers completion-safe on retry, starting with the share handler;
  - turns its reproducing test (`i6-epoch-change-broadcast.test.ts`) green.
