# Acknowledged durable app-frame delivery

**Origin:** backlog item `2026-09-25-rpc-acknowledged-durable-app-frame-delivery.md`. Consumer:
`@kubun/plugin-p2p`, which needs a transient failure between MLS open and host apply to recover
automatically.

**Revision 4** — revision 3 plus its review fixes: delivery barrier on the earliest unresolved fetched
position, host save ordering and same-epoch guard, rebuild after partial walk progress, retention until
durable open, fail-closed storage stall with an operator drop, retried startup restore, settled fetches.
**Revision 3** — revision 2 plus the fixes from its blind review (key zeroing, walk-wide storage stop,
isolated staged state, liveness retries, fetch-only positions, sender check, guarantee boundary, Kubun
lock order). **Revision 2** — after a blind review found that (1) `GroupHandle.decrypt` commits the consumed key to
in-memory state before any persist hook can run, (2) live opens outside the mutexes break log order,
and (3) `logPosition` is unauthenticated hub metadata.

## Problem

Opening an app frame consumes its message key (`crypto.ts` `unwrap`, `open-once.ts`). The retained drain
marks a frame done before emitting it, swallows a throwing listener, and advances the durable cursor over
the done run (`app-lane.ts` `drain`, `advanceCursor`). A live log push at the current epoch is staged done
in `note()` before the host outcome is known. A crash between open and host apply therefore loses the
frame: if the host saved the advanced ratchet, the frame never opens again; if it did not, the advanced
cursor skips the frame on restart.

`GroupHandle.decrypt` (`packages/mls/src/group-handle.ts:816-850`) assigns `this.#state = newState` and
zeroes the consumed key inside the handle mutex before returning. Any later handle save (commit apply,
`encrypt`) then persists the consumed key, so a persist hook called after `decrypt` returns cannot make
the open and the pending record atomic.

## Goal

Declared `retain: 'log'` app events are delivered **at least once** across crashes and handler failures,
in log order per protocol, with a stable frame identity the host deduplicates on. Everything else keeps
today's semantics.

**Guarantee boundary.** The guarantee holds for frames a **conforming hub** appended to the topic log and
still retains until this peer has **durably opened** them (a failed `persistOpened` followed by a crash
and retention expiry before the retry loses the frame). The AAD authenticates intent and topic only; a
malicious hub may still omit, reorder, or lie about fetched positions, as the repo's hub threat model
already allows. Out of scope, documented:

- A hub (or member) that delivers a log-intent frame only by mailbox, or never appends it: the hub is
  already trusted for availability and can drop any frame. Such a frame is acked, not opened, and lost.
- Log pruning or retention expiry before the peer reads the frame: reported by `onAppWindowPruned` as
  today.
- The existing commit-applied-before-anchor-saved crash window (`architecture.md`), which can leave a
  restarted peer reading a stale app topic.

## Scope

- **In:** app frames whose **authenticated log intent** (below) is `log`, when the host enables durable
  delivery.
- **Out, unchanged:** ephemeral events (at most once), anycast requests and replies (complete through
  live correlation or expiry), directed traffic, the commit lane.
- **Opt-in:** durable delivery is on iff `GroupCrypto.pending` is present. Without it, every path
  behaves exactly as today, except the AAD format change, which is unconditional.
- Kubun's adoption is a follow-up in the kubun repo.

## Authenticated log intent (wire change)

Today every app frame is sealed with `aad = fromUTF(topicID)` (`peer.ts:767`, `peer.ts:787`) and opened
with `expectedAAD = fromUTF(topicID)` (`peer.ts:585`, `peer.ts:659`, `app-lane.ts:434`).

New AAD, versioned:

```
aad = [0x01 (AAD version)] [0x00 ephemeral | 0x01 log] [topicID UTF-8]
```

- Publishers set the intent byte from the procedure's declared retention (`retentionOf`), the same
  decision that already selects `retain: 'log'` on publish. Directed and request/reply frames use
  `ephemeral`.
- Readers compare the **whole** AAD pre-open (`expectedAAD`), so a frame's intent is authenticated by
  the open: a hub that rewrites the intent byte makes the open fail (dead frame). The AAD proves the
  publisher's intent, not that the hub retained the frame (see the guarantee boundary).
- Every seal and open site changes: `peer.ts` app publish (`:767`) and directed publish (`:787`), the
  app open-once path (`:585`), the self-inbox (`:659`), the drain (`app-lane.ts:434`), and the directed
  request and reply seals (`directed.ts:151`, `directed.ts:335`) and their opens.
- Routing reads the intent from the frame's **cleartext** AAD **before** opening, via a new port method
  (below). The cleartext is only a routing hint; the open authenticates it.
- `logPosition` is no longer used to decide durability or path. It stays positional metadata.
- A frame with an old-format AAD fails the open (dead). 0.10 and 0.11 peers cannot exchange app frames;
  this ships with the 0.11 band bump.

New `GroupCrypto` member:

```ts
/**
 * The frame's CLEARTEXT authenticated data, read without opening. `null` for bytes that are not a
 * readable sealed app frame. Must not throw. Untrusted until `unwrap` succeeds with it as `expectedAAD`.
 */
frameAAD(bytes: Uint8Array): Uint8Array | null
```

`@kumiai/mls` exports `readMessageAAD(bytes)` (the cleartext `authenticatedData` of a PrivateMessage,
the same pre-open read `decrypt` already does), and `mls-rpc` wires it.

A shared codec `packages/rpc/src/app-aad.ts`: `encodeAppAAD({ topicID, intent })`,
`decodeAppAAD(bytes): { topicID, intent } | null`.

## Frame identity

```ts
export type AppFrameRef = {
  /** Stable across reconnect and replay: derived from the topic and the ciphertext. */
  id: string
  /** The app topic the frame was read from. */
  topicID: string
  /** The protocol the topic belongs to, so a record outlives its segment's topic mapping. */
  protocol: string
  /** The app-lane anchor epoch of the frame's segment; orders records across rotations. */
  segment: number
  /** The frame's log position on that topic. */
  position: string
}
```

`id = toB64U(sha256(u32be(len(topicIDBytes)) ‖ topicIDBytes ‖ ciphertext))`. Length-prefixed, so the
pre-image is injective. Records order by `(segment, position)`. The same ciphertext at a second position
gets the same `id`; only one position can open it (the key is consumed), and the other is dead.

## Staged open in `@kumiai/mls`

New `GroupHandle` method:

```ts
/**
 * Open like `decrypt`, but make the new state durable BEFORE adopting it. Runs under this handle's
 * mutex: computes the post-open state without assigning it, rejects an unnamed sender, awaits
 * `persist(stagedState, opened)`, then assigns the state and zeroes the consumed secrets. If anything
 * before adoption throws, the live state and its secrets are untouched (the frame is still openable)
 * and the error propagates.
 *
 * `stagedState` is the encoded post-open `ClientState` (the same encoding the host already stores for
 * this group), NOT a live `GroupHandle`: constructing a handle would repoint the shared group context's
 * device-deny provider (`group-handle.ts:343`, `deriveGroup` at `:1295`). `persist` must not call any
 * method of this handle or of the peer: the mutex is held.
 */
async decryptStaged(
  message: Uint8Array,
  opts: { expectedAAD?: Uint8Array },
  persist: (stagedState: Uint8Array, opened: { payload: Uint8Array; senderDID: string; aad: Uint8Array }) => Promise<void>,
): Promise<{ payload: Uint8Array; senderDID: string; aad: Uint8Array }>
```

`encrypt`, `processMessage` and every other state-mutating method take the same `mutexFor(this)`, so no
other writer can persist the handle between the open and the pending write, nor adopt a stale state
after it.

**Zeroing.** `result.consumed` from ts-mls includes the **old** ratchet secret, which still belongs to the
live state while the new state is withheld (`ts-mls secretTree.js:203-223`). It is zeroed only after
`persist` succeeds and the new state is adopted. On failure nothing in `result.consumed` is zeroed;
temporary keys that alias neither state may be cleared.

**Sender.** An open that yields no authenticated sender throws **before** `persist`, so the live state is
unchanged, matching the port's "unnamed sender is an error" rule without consuming the key.

**Encoding.** `stagedState` uses the repo's `ClientState` encoder (`packages/mls/src/codec.ts:47`), the
same form a host restores from. The `@kumiai/mls` README documents that `persist` must store it as the
group's handle state.

## Port change: `GroupCrypto`

```ts
export type PendingAppFrame = { frame: AppFrameRef; payload: Uint8Array; senderDID: string }

export type PendingAppFrames = {
  /** Every pending record, ordered by (segment, position). */
  list(): Promise<Array<PendingAppFrame>>
  /** Clear one record. Idempotent: an unknown id resolves. */
  complete(id: string): Promise<void>
}

export type GroupCrypto = {
  // ...existing members...
  unwrap(
    bytes: Uint8Array,
    opts?: { expectedAAD?: Uint8Array; frame?: AppFrameRef },
  ): GroupUnwrapResult | Promise<GroupUnwrapResult>
  frameAAD(bytes: Uint8Array): Uint8Array | null
  /** Present iff this port provides durable app delivery. */
  pending?: PendingAppFrames
}
```

**Contract when `opts.frame` is set** (set only when `pending` is present):

- Before `unwrap` resolves, the port has durably saved, in **one atomic unit**, the handle state that
  consumed this frame's key **and** the record `{ frame, payload, senderDID }`.
- If `unwrap` throws, neither was saved **and** the live handle state is unchanged. The error says which
  kind of failure it was: `isAppFrameStorageError(error)` is true for a persist failure (retryable), false
  for an unopenable frame (dead).
- A record whose `id` already exists is not duplicated.
- `list()` returns every saved, uncompleted record across process restarts.

**Real implementation (`@kumiai/mls-rpc` `createGroupCrypto`):** new optional param

```ts
pending?: {
  /** One host transaction: store `stagedState` as the group's handle state and insert `record`. */
  persistOpened(stagedState: Uint8Array, record: PendingAppFrame): Promise<void>
  list(): Promise<Array<PendingAppFrame>>
  complete(id: string): Promise<void>
}
```

`unwrap` with `frame` calls `handle().decryptStaged(bytes, opts, (stagedState, opened) =>
persistOpened(stagedState, record))`, wrapping a `persistOpened` throw in an `AppFrameStorageError`.

## Host contract (documented)

- `persistOpened` runs under the handle mutex and the commit mutex. It must not call the handle or the
  peer.
- The host must never hold a database transaction (or its single connection) while it awaits a peer or
  handle operation. A handler finishes its own transaction before awaiting `commit()`, `dispatch()`, etc.
- **Save ordering.** `persistOpened`'s write must be ordered after any handle save the host issued
  before it, and the host store must reject an older state at the same epoch (a monotonic state
  version). Otherwise a delayed earlier save overwrites the staged state while the pending record
  survives. Kubun needs both (its registry persists after releasing its mutex, and its MLS state upsert
  accepts an older same-epoch state).
- **Kubun adoption prerequisite.** Kubun's registry persists outside its per-group lock precisely because
  some transactions await `readHandle` while holding the single connection
  (`../kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:268`, regression test
  `group-mutex-db-deadlock.test.ts`). `persistOpened` inside the handle mutex is the opposite order.
  Kubun must remove every transaction-then-registry wait on paths that can overlap an app open before
  enabling durable delivery, and prove it against SQLite. Tracked as a kubun follow-up; kumiai's
  learning loop validates the lock order with a single-connection SQLite host double.

## App lane

**Live log-intent push: wakeup only.** In durable mode, the open-once path reads `crypto.frameAAD`
pre-open. For intent `log`:

- it does **not** open the frame, does **not** fan it out, and does **not** stage its bytes or position:
  pushed metadata never enters the buffer (a pushed frame could claim another entry's position);
- it acks the hub delivery (a conforming hub appends before it pushes and keeps the log entry after the
  ack);
- it schedules a drain (coalesced), as a commit-topic push does.

In durable mode, bytes and positions of log-intent frames come **only** from `fetchTopic`. Frames with
intent `ephemeral`, or an unreadable AAD, keep today's open-once path.

**Settled fetches.** `loadSegment()` uses `Promise.allSettled` over the protocol fetches and rethrows the
first failure only after all have settled, so no fetch keeps mutating buffers or `fetched` positions after
the app-lane mutex is released and a retry starts.

**Liveness.** A drain request never depends on a later push:

- A failed fetch or a storage failure reschedules the drain with the delivery-queue backoff (1 s doubling
  to 60 s), independent of pushes, until it succeeds or the peer is disposed.
- Startup: after the live app subscriptions are registered, `ready` runs one more app-lane pull, closing
  the gap between the seed pull and listener registration (`peer.ts:2155`, `hub-mux.ts:653`).

**Retained drain: the only opener of log-intent frames.** Runs under the commit mutex and the app-lane
mutex, as today, in log order. For a frame at the handle's epoch:

- decoded intent `log`: `unwrap` with `frame` → on success the frame becomes `pending(id)` and its record
  is appended to that protocol's delivery queue. The drain does not emit.
- decoded intent `ephemeral`: dead (a log-retained frame must carry log intent).
- `unwrap` throws `AppFrameStorageError`: the frame stays `sealed`, the cursor does not pass it, and
  `deliver()` **rejects** (after every protocol's fetch has settled; see "Settled fetches"). The commit walk treats that like a failed pull: it stops before applying the
  next commit, so no epoch advances past a log frame that was neither durably opened nor classified
  dead. The walk retries on the liveness schedule above. (Continuing would mark the frame dead on the
  next drain by the below-epoch rule, `app-lane.ts:420`.)

**Rebuild after partial progress.** The walk may have applied commits before the drain that rejects. If
the epoch or anchor moved during a pull that then rejects, `pullCommits` still runs `rebuildEpoch()` (and
anchor capture) before rethrowing the original error, so the runtime never sits on an old epoch or topic
while a retry finds "no new advance".

**Fail-closed storage stall.** A persistent `persistOpened` fault halts the commit walk for this group:
commits behind the frame are not classified, strand signals are delayed, and `recover()` blocks at its
first pull. This is deliberate (no epoch passes an unpersisted log frame). It is made observable and
operable:

- The walk retry resumes the full **journal-first** lane operation (replay, ledger invariant, pull), not
  just the app drain, on the liveness schedule.
- A host notice `onAppDeliveryStalled({ groupID, protocol, topicID, position, error })` fires (through
  the shared `notifyHost` outbox) when a storage failure first blocks a frame, and again only if the
  blocking frame changes.
- `GroupPeer.dropAppFrame(topicID, position)` lets an operator accept the loss: it marks that buffered
  frame dead (cursor may pass it) and resumes the walk. It never touches a frame already `pending`.
- `unwrap` throws anything else: dead, as today.

Not-this-epoch rules are unchanged.

**Frame states.** `AppFrame.sealed: Uint8Array | null` becomes
`{ state: 'sealed'; bytes } | { state: 'pending'; id } | { state: 'done' }`.

- `pending` is entered only after `unwrap` with `frame` resolved.
- Merge rule for duplicate observations of one position (all from `fetchTopic` or restored records):
  `pending` dominates `sealed` and `done` until its `complete()` succeeds; `sealed` dominates `done`. Two
  different ciphertexts at one fetched position: keep the first, drop the second.
- The cursor passes a run of `done` frames and stops at the first that is not.

## Delivery queue

One ordered queue per protocol, fed only by the drain (and by restart), running **outside** the commit
mutex and the app-lane mutex.

**Delivery barrier.** A non-rotating commit keeps the app topic, so a member already at epoch *e+1* can
append position A before a lagging member at *e* appends B. The drain keeps A sealed (ahead) and opens B.
Delivering B first would break log order. So each protocol's worker delivers a record only when no
**earlier fetched position** of the same topic is still unresolved (`sealed`); `pending` and `done`
earlier positions do not block. Records of older segments are not blocked by the current segment's
buffer. Test the epoch-inversion case.

For each record, in `(segment, position)` order:

1. Parse the payload. Self-echo (normalized `senderDID === localDID`), malformed JSON, not
   `typ: 'event'`, unknown protocol, or a procedure not declared `retain: 'log'`: `complete(id)` and
   move on.
2. Validate event data against the protocol schema; invalid: log, `complete(id)`, move on.
3. Emit to the host handler; its context gains `frame: AppFrameRef` (`handlers.ts`).
4. **Handler resolves** = acknowledgement: `await pending.complete(id)`, then under the app-lane mutex
   mark the frame `done` by `(topicID, position)` and advance that topic's cursor. A record on a topic
   that is not the current segment has no buffer entry; its completion clears the record only.
5. **Handler throws**: the record stays. Retry the same record after a backoff (1 s doubling to a 60 s
   cap). Later records in this protocol wait: head-of-line order is the contract. A host drops a
   poisoned frame by acknowledging it.
6. `complete()` throws: retry with the same backoff; the handler may run again (at least once).

**Restart.** In `ready`, after the anchor is restored and **before** `initControlLanes()` (whose seed
pull runs the first drain), `list()` all records (a rejected `list()` is retried on the liveness
backoff, and disposal aborts the wait; the seed pull never runs before restoration succeeds) and enqueue them per protocol by `frame.protocol`, in
`(segment, position)` order. A record naming a protocol this peer does not serve is completed without
delivery. `ready` does not wait for any handler: a handler awaiting `commit()` would otherwise wait on
`ready` itself. The restored records also seed the app lane: when the drain buffers a position whose
`(topicID, position)` matches a restored record, that frame enters as `pending(id)`, never `sealed`, so
it is not re-opened (its key is consumed and the open would call it dead) and the cursor stays behind it
until the record is completed.

**Rotation.** `reset()` clears segment buffers and cursors as today. Queues and pending records are not
cleared; old-segment records keep delivering.

**Dispose.** Cancels backoff timers and stops starting new handler calls. A handler already running may
finish and complete its record. Pending records stay for the next start.

## Locking summary

- Opening and persisting a log-intent frame: commit mutex → app-lane mutex → handle mutex → host
  `persistOpened`. Nothing inside calls back.
- Handlers: no kumiai lock held.
- Live ephemeral opens: unchanged (open-once chain + handle mutex).

## Guarantee (rpc README)

- Log events: at-least-once, per-protocol log order. The host records a deduplication entry keyed by
  `frame.id` in the same transaction as its effect, then resolves.
- An effect outside that transaction must be idempotent, or reconcile by `frame.id`.
- Replies complete when their live correlation accepts them or expires; ephemeral events are
  best-effort.

## Conformance

`rpc-conformance` gains a `pending` clause set, run against the real `mls-rpc` port (in-memory host
store that serializes the handle) and the fake crypto double:

- `unwrap` with `frame` saves a record `list()` returns; a second open of the same bytes throws, saves
  nothing.
- `persistOpened` throws: `unwrap` throws a storage error; `list()` empty; the **live** handle still opens
  the frame (old ratchet secret not zeroed); a handle **restored from the stored bytes** also opens it.
- An unnamed-sender frame: `unwrap` with `frame` throws before persisting; live and restored handles
  unchanged.
- A failed staged open, then a successful one: the group context's device-deny provider is the live
  handle's throughout.
- After a successful staged open, a later `wrap` and its save do not lose the record, and a restored
  handle cannot reopen the frame.
- `list()` order by `(segment, position)`; `complete()` idempotent; records survive a new port instance
  over the same store.
- `frameAAD` returns the cleartext AAD and never throws on garbage.
- A frame below the current epoch that the real port can still open: staged open behaves identically.

`GroupHandle.decryptStaged` gets unit tests in `@kumiai/mls`. Hub conformance runs as regression. The
double must be no more permissive than the real port.

## Tests (`packages/rpc/test/`)

- Live log-intent push in durable mode: not opened live, hub acked, drain opens it, one delivery with
  `frame` in context.
- Live push order: pushes B then A's retained copy arriving later still deliver A before B.
- A pushed log-intent frame claiming the position of a different fetched entry: no effect on the buffer.
- Storage failure on a frame immediately before a commit: the commit is not applied until the frame is
  durably opened; then both proceed.
- Failed fetch with no later push: the drain retries on its own and delivers.
- Publication in the gap between the seed pull and listener registration: delivered after startup.
- Directed and self-inbox AAD round trips with the new format.
- Epoch inversion: ahead frame A before at-epoch frame B on one topic: B waits, A then B delivered.
- Storage failure in the final drain after an applied roster-changing commit, then recovery with no
  further commit: the runtime is on the new epoch and topic.
- Persistent storage fault: `onAppDeliveryStalled` once; `dropAppFrame` resumes the walk.
- Transient `list()` failure at startup: retried; seed pull waits for it.
- One protocol's fetch rejecting fast while another's is delayed: no buffer mutation after the retry
  begins.
- Retention expiry after a failed durable open and a crash: frame lost, documented behaviour.
- Single-connection SQLite host double: `persistOpened` inside the handle mutex while a handler
  transaction runs does not deadlock under the host contract.
- Hub stripping `logPosition` or adding it to an ephemeral frame changes nothing (path by AAD).
- Hub rewriting the intent byte: frame dead, no delivery.
- Retained pull: cursor passes the frame only after the handler resolves.
- Handler throws: backoff retry, later frames wait, cursor stays; ack clears.
- Storage failure: drain stops at the frame, cursor stays, next drain retries and delivers.
- **Decisive restart test:** shared in-memory "database" (serialized handle + pending records + cursor)
  across two peer instances. Open a retained frame, crash before the handler runs; restart with the same
  database and hub: the frame is applied once, its record cleared, then the next frame opens and
  delivers.
- Rotation with a pending old-segment record: still delivered, completion does not touch the new cursor.
- Dispose during backoff: timers cleared, no handler call after dispose.
- Handler calling `commit()`: no deadlock.
- Without `crypto.pending`: existing behaviour (apart from the AAD format) unchanged.

## Release

Minor band bump to 0.11 for all twelve packages: AAD wire format, `GroupCrypto` port members, `GroupHandle`
method, handler retry semantics. `pnpm change` intents per package. The mixed-version incompatibility is
called out.

## Plan mode

learning-loop. Assumptions to validate first, in order:

1. `decryptStaged` can compute and withhold the post-open state with ts-mls, and a handle restored from
   the staged serialization cannot reopen the frame while one restored from the pre-open state can.
2. The drain-as-sole-opener keeps latency acceptable (one coalesced fetch per push burst).
3. Moving delivery out of the mutexes keeps drain, cursor and rotation interleavings safe.
