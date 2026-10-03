# Log delivery across an epoch change

## Goal

A log-class app event that a member dispatches must reach every member that is in the group when the event lands, even when a commit lands around the same time. Today two cases lose frames for good. An ephemeral event sent right after an anchor move should reach receivers that already applied the move.

Consumer impact: kubun's `delegation:revoke` is a log event. Losing it fails open.

## Accepted tradeoffs

- Log events become at-least-once across an epoch change. A member still at the old epoch can read the original frame and the re-sealed copy. Consumers must apply log events idempotently. No message id is added to the envelope now.
- A sender's log events stay in dispatch order, at the cost of queueing new log dispatches behind pending re-seals.
- An ephemeral event can still miss a receiver that has not applied the commit when the event is published. Pull stays the fallback. Only making the event log class removes this.
- The at-risk check sometimes flags a frame that was safe (a history, poison or non-advancing frame on the commit topic). The cost is one extra duplicate.

## Background (reproduced on main `0d0ee9f`)

**Loss 1: a log frame sealed behind a commit.**

1. Member S is at epoch E and has not yet applied commit C, which leaves E.
2. S seals log frame F at E. The hub accepts F after it accepted C.
3. A receiver that applied C before F arrived refuses F as past (`crypto.ts:19-20`, `app-lane.ts:767-773`) and acks it dead.
4. Nothing re-sends F. `dispatch` keeps no plaintext after the publish (`peer.ts:959-966`).

Any commit causes this, not only roster changes: `unwrap` refuses every epoch other than the current one.

**Loss 2: an ephemeral frame published before receivers subscribe.**

- `captureAnchor` moves the anchor during the walk (`peer.ts:631-643`), and `sealForSegment` seals to the new topic from then on (`peer.ts:906`).
- Receivers subscribe to the new topic only in `buildEpoch`, after the walk (`peer.ts:844`).
- The hub drops a mailbox frame that has no recipients (`hub-server/src/memoryStore.ts:252`).
- If the subscribe is moved earlier on its own, a frame that arrives before the listener registers stays unacked until a reconnect (`hub-mux.ts:651-662`).

**Safety condition.** A receiver reads E's frames in `advanceHandle` (`appLane.deliver()`, `peer.ts:1379`) before it applies C, and it fetched C before that. So if the hub accepted F before C, every receiver sees F at E. F is at risk only if a commit was accepted after the point where S entered E.

## Design

### 1. Epoch floor

The peer tracks `epochFloor`: the commit-topic position at which its handle entered the current epoch.

- It is set only after a successful ratchet in `advanceHandle`, from the position the caller applied. That is the walk position, or the accepted `sequenceID` for own commit, replay and rejoin.
- At the end of a full walk that did not ratchet, it rises to `reconciledHead`.
- It is never taken from `reconciledHead` before a ratchet. `commit()` and `replayJournal` move `reconciledHead` before the handle ratchets (`peer.ts:2294` vs `2308`), and using it in that window would prove an at-risk frame safe.

### 2. Log dispatch

1. Under the existing `anchor === at && sealBarrier == null` check, seal F and capture `{sealEpoch, floor}` atomically.
2. Write the outbox entry before the publish (write-ahead; see §4).
3. Publish F.
4. Probe: `fetchTopic(commitTopic, { after: floor, limit: 1 })`.
   - Empty page: no commit was accepted after the floor before F, so F is safe. Remove the outbox entry.
   - Non-empty page: F is at risk. Keep the entry and call `requestAppPull()` so the sender walks promptly.

Ephemeral and directed frames are unchanged: they never enter the outbox.

### 3. Re-seal flush

The flush runs after every lane operation that ratcheted (pull, commit, replay, recover, rejoin). It runs outside the commit mutex, the same way `healIfRequested` does (`peer.ts:1816`, `2322`), and never inside `advanceHandle`.

For each outbox entry with `sealEpoch` below the current epoch, in original order:

1. Re-seal it through `sealForSegment`.
2. Publish.
3. Probe again from the new floor.
4. Update the entry's `sealEpoch` and keep it only while still at risk.

The loop ends when a probe finds no new commit.

While the outbox holds an entry below the current epoch, new log dispatches queue behind the flush. This does not take the commit mutex.

**Removed sender.** A commit that removes the local member does not ratchet its handle (`peer.ts:1395-1404`), so the flush never fires for that sender. The peer clears its outbox when an applied commit leaves `localDID` out of the roster. That frame stays lost, which is correct: the group removed S at C, and F landed after C.

### 4. Durable outbox port

New required port on `GroupPeerMLSParams`, modelled on `CommitJournal`:

```ts
export type AppOutboxEntry = {
  id: string            // stable across re-seals, assigned at first dispatch
  protocol: string
  prc: string
  data: Uint8Array      // encoded event plaintext
  sealEpoch: bigint
  floor: string         // commit-topic position the last probe starts from
}

export type AppOutbox = {
  put(entry: AppOutboxEntry): Promise<void>      // insert or replace by id; durable before it resolves
  list(): Promise<Array<AppOutboxEntry>>          // in insertion order of first put
  remove(id: string): Promise<void>
  clear(): Promise<void>
}
```

- **Write-ahead.** The entry is put before the first publish, so a crash at any point leaves it in the outbox.
- **Init.** After the seed pull, the peer re-runs the flush for every entry. An entry already at the current epoch is probed from its floor:
  - If at risk, it is re-sealed at the next ratchet as usual.
  - If clean, it is published again once, because the process may have crashed before the publish. That costs at most one duplicate, which at-least-once already allows.
- **Bound.** There is no silent drop. The outbox normally holds only frames dispatched behind a commit and waits at most one walk. A stranded peer keeps its entries until `recover()` rejoins: a rejoin ratchets, so the entries re-seal as a member again.
- **Plaintext at rest.** The outbox holds plaintext, as the commit journal already does. Encrypting it at rest is the host's job.
- **Release impact.** This is breaking for `GroupPeerMLSParams` (patch version, single consumer). kubun adds a store and migration.

### 5. Subscribe when the anchor moves

- At `captureAnchor`, the peer retains the new protocol topics and the self-inbox topic, with `appLogRetentionSeconds`. Retains are idempotent and lifelong, so rebuild and teardown are unaffected. An aborted walk keeps the anchor it already persisted (`peer.ts:1756-1765`), so the early retain matches it.
- The mux hands a pending frame that matched no listener to the first listener registered on its topic within the ack TTL, then acks it once. This also closes the init-race window documented at `hub-mux.ts:302-307`.

This covers receivers that applied the commit but have not finished their walk. It cannot cover receivers that have not applied the commit, because they cannot derive the new topic yet.

### 6. Hub conformance

New clause in `@kumiai/hub-conformance`: a publish acknowledged before a fetch starts, on another topic of the same hub, is visible to that fetch. §2's probe depends on this. The memory store and `DurableFakeHub` already satisfy it.

### 7. Contract docs

- `dispatch` / `retentionOf`: log events are at-least-once across an epoch change, so handlers must be idempotent.
- They keep per-sender dispatch order.
- Ephemeral events are best-effort for receivers behind a commit.

## Testing (in `@kumiai/rpc`, fixtures `makeMLSPeer`, `DurableFakeHub`, `publishCommit`, `buildLedgerCommit`, `buildRemoveCommit`)

These fail on main today:

1. A roster commit lands while bob is detached. Bob dispatches `chat/posted` at E, then reattaches and pulls. Alice at E+1 receives it.
2. The same scenario with a non-roster ledger commit.
3. Bob's anchor has moved and his runtime is not rebuilt yet. Alice dispatches `chat/changed`, and bob receives it.

Added with the fix:

4. **Safe frame.** Bob is current when he publishes, and alice commits after. Exactly one publish of the frame, received once.
5. **Bounded duplicate.** A member still at E receives F and F′: two deliveries, same plaintext and sender, at most one re-seal per ratchet.
6. **Own-commit window.** Bob dispatches between `markAccepted` and the ratchet of his own commit. F′ is sealed at E+1 and alice receives it. This guards the floor placement.
7. **Removed sender.** Bob is removed while detached and dispatches at E, then pulls. He publishes nothing after the pull, and his outbox is empty.
8. **Removed member.** Carol is removed and bob re-seals. Carol cannot open F′, and F′ is on the new segment topic.
9. **Stranded sender.** The re-seal happens only after `recover()` lands.
10. **Ordering.** F1 is at risk, then F2 is dispatched after catch-up. Alice receives F1′ before F2.
11. **Crash.** Bob is killed after an at-risk publish, before his walk. On restart with the same outbox, alice receives F.
12. **Crash before publish.** The outbox entry is written but not published. On restart, alice receives F.
13. **Mux hand-off.** A frame pushed on a retained topic before any listener exists reaches the first listener registered within TTL and is acked once.
14. **Conformance clause** runs against the memory store and `DurableFakeHub`.

Existing init-race tests (`peer-delivery-before-ready.test.ts`, `hub-mux-ack-refcount.test.ts`) may need updating for §5.

## Release

- Patch versions for `@kumiai/rpc` and `@kumiai/hub-conformance`.
- Released together with `feat/bound-leaf-lifecycle`.
- kubun then bumps, adds the outbox store, and turns its reproducing test (`i6-epoch-change-broadcast.test.ts`) green.
