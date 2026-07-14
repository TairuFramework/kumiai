# Question 3.7 — report

**Status: `BLOCKED`.** Both stop conditions fire.

1. **The spec's scenario, written verbatim, passes with no fix.** A peer whose *transport* dropped
   reads the plaintext of a message sent ten commits ago. The interleave the spec asks for already
   holds there, structurally, and is enforced by the delivery drain — not by anything in the lane.
2. **The scenario that does fail has a different mechanism than the spec's**, the spec's rule does
   not fix it, and the rule is **not implementable as written** on this hub. The keys are not gone.
   The *subscription* is.

The premise — "a week of messages is silently gone" — is **real and worse than stated**. The
*explanation* is wrong, and so is the prescription.

---

## Step 1 — the failing test, and the red

`packages/rpc/test/peer-app-drain.test.ts`. Two tests, one invariant: **a returning peer reads the
plaintext of the messages it was sent at its own epoch.** Nothing else is asserted that matters.

The instrument is `createFakeCrypto`, untouched: it opens **only the current epoch**
(`fake-crypto.ts:62`). `retainKeysForEpochs` was not raised anywhere, and no retention window,
buffer or retry is doing any work in what follows.

### The spec's scenario — PASSES with no fix

> a peer goes offline, the group makes ten commits and sends an app message at an early epoch, the
> peer reconnects

Modelled as a dropped connection (`hub.detach` / `reattach` / `redeliver`, the fixture's own idiom
for offline, and the one `peer-commit-reconnect.test.ts` uses):

```
✓ a peer whose transport dropped still reads the messages sent at its epoch
```

`seen = [{ text: 'before lunch' }]`, `epoch = 11`. The message survives ten commits **and a
one-epoch key window**. This is not a fluke of the double — it is proof: the fake opens only the
current epoch, so the frame can only have been opened *while the peer was still at epoch 1*.

### The same scenario, with "offline" meaning the process was not running — FAILS

```
 FAIL  test/peer-app-drain.test.ts > app frames outlive the commits that leave their epoch
       > a peer that was restarted still reads the messages sent at its epoch

AssertionError: expected [] to deeply equal [ { text: 'before lunch' } ]

- Expected
+ Received

- [
-   {
-     "text": "before lunch",
-   },
- ]
+ []

 ❯ test/peer-app-drain.test.ts:86:18
     84|
     85|     expect(restarted.mls.epoch()).toBe(11)
     86|     expect(seen).toEqual([{ text: 'before lunch' }])
       |                  ^
```

Note the line above the failure: **`expect(restarted.mls.epoch()).toBe(11)` passes.** The peer
converged. The roster matches. The head matches. Nothing threw. The message is gone.

---

## Step 2 — what actually broke. It is not the keys.

Six experiments, all against the lane as it stands. `seen` is the plaintext the peer's `chat/changed`
handler received.

| # | scenario | result |
|---|---|---|
| **A** | transport blip; frame at epoch 1, published **before** the ten commits (the spec's case) | `seen = [{text}]`, epoch 11 — **survives** |
| **B** | transport blip; frame at epoch 1, published **after** the commit that leaves epoch 1 (a sender that had not yet pulled) | `seen = []`, epoch 11 — **lost** |
| **C** | frame at epoch 3, an epoch the peer never held | `seen = []`, epoch 11 — **lost** |
| **D** | **restart**; frame at epoch 1 before the ten commits | `seen = []`, epoch 11 — **lost** |
| **E** | **restart**, same frame, same backlog delivery, **zero commits** (control) | `seen = [{text}]`, epoch 1 — **survives** |
| **F** | restart, ten commits, backlog pushed one tick later | `seen = []`, epoch 11 — **lost** |

**D vs. E is the causality.** Same peer, same handle, same key, same backlog, same delivery. The only
difference is the ten commits. The commits destroy the message.

**And the key was in his hand the whole time.** At restart the handle is at epoch 1 and the crypto is
at epoch 1 — E proves it, because the double opens *only* the current epoch and E's frame opened.
What D loses is not a secret.

### The real mechanism: the peer never subscribes to the topic the frame lives on

The app lane's topics are epoch-derived — `protocolTopic(secret, epoch, name)` (`peer.ts:249`). The
peer holds a listener on `T(E)` only while it is at epoch E. Two places rotate it away:

**(1) Startup — the reproducible one (D).** `peer.ts:1399-1402`:

```ts
const ready = (async () => {
  await initControlLanes()   // ... which ends in the seed pull: epoch 1 -> 11
  await buildEpoch()         // ... so the app lane is built at 11, and never at 1
})()
```

The seed pull runs **to head** before the app lane is built. A peer that comes up at epoch 1 holding
epoch-1 frames therefore **never installs a listener on `T(1)` at all** — by the time `buildEpoch()`
runs, `crypto.epoch()` is 11. The hub, meanwhile, still has him subscribed to `T(1)` server-side (a
crash does not unsubscribe; the probe confirms `subscriberCount(T(1)) === 1` after the restart) and
**pushes the frame straight at him**. It arrives in the mux drain, hits
`listeners.get(message.topicID) ?? []` (`hub-mux.ts:148`) — empty — and is **dropped on the floor**.

The hub delivered the message. The peer held the key that opens it. The peer threw it away because it
had already rotated its app lane to an epoch it reached by pulling the log *before* it ever built the
lane.

**(2) Run time (B, F).** `rebuildEpoch()` → `teardownEpoch()` → `client.dispose()` /
`busServer.dispose()` → transport cancel → `mux.release(T(E))` → **`hub.unsubscribe(localDID, T(E))`**.
On the real store that is not a passive detach — it is a **destructor**
(`hub-server/src/memoryStore.ts:379-396`):

> ```ts
> // Drops this subscriber's pending deliveries for the topic — freeing a mailbox frame whose
> // last delivery this was, and leaving a log frame standing.
> ```

`unsubscribe` → `dropDelivery` → `removeEntry`. Advancing the epoch **deletes the peer's undelivered
epoch-E app frames out of the hub**, and if the peer was the last pending reader, deletes the frame
itself for everyone.

### Why the spec's case (A) passes, and why that is not luck

The commit lane **cannot** outrun the mailbox, because they are the same queue. `createHubMux` drains
`hub.receive` in **one ordered loop** (`hub-mux.ts:129-157`) and hands each message to its topic's
listeners **synchronously**. The app lane's `unwrap` is called **synchronously** inside that listener
(`broadcast/src/transport.ts:81-83`), so a frame is decrypted at the epoch the peer is at *at the
moment it is drained*. The commit lane's listener does the opposite — `onCommitDelivery`
(`peer.ts:779`) acks and returns, deferring everything with `void runSerial(async () => { await ready
… })`. It cannot possibly advance the epoch before the drain has handed out every message queued
ahead of it.

So for any app frame that sits **before** the commit in the delivery order — the spec's case exactly —
the interleave already holds, and is guaranteed by the drain rather than by any rule. **"D1 makes the
commit lane run at lane step 0 so replay races to the head while the mailbox is still full" describes
a lane that does not exist in this tree.** The pull is only ever entered from a wakeup that is itself
an item in the same delivery queue as the app frames.

### Why the spec's rule cannot be implemented as written

> Replay drains the mailbox up to E, applies the commit, drains E+1, applies, and so on.

**There is no per-epoch mailbox to drain, and no signal that says it is empty.** From
`hub-server/src/memoryStore.ts`:

- App frames are **mailbox** class. `fetchTopic` returns **log-class frames only** (`:298-300`) — an
  app frame **can never be pulled**. The peer's only access to it is a push.
- A frame exists solely as a **per-recipient pending delivery, created at publish time for the
  then-current subscribers**. A mailbox publish with **no** subscribers is **dropped outright**.
- `subscribe` **backfills nothing** (`:364-377`). Subscribing to `T(E)` late gets you an empty topic.

So the peer has one undifferentiated push stream across every topic and no way to ask *"have I now
received everything the hub is holding for me at epoch E?"*. Any "drain before you step"
implementation is a **race against the delivery loop, not a rule** — and **F proves it**: the identical
scenario, with the backlog pushed one tick later, loses the message anyway. Reordering `ready` to
build the app lane before the seed pull makes D go green, and it is **not a fix** — it is winning that
race on a fast machine. I did not ship it.

### And the loss the spec never mentions, which is the big one (C)

**A frame sent at an epoch the peer never held is unreachable — by any ordering rule, and by a key
window of any size.** The peer was not a subscriber of `T(3)` when the frame was published, so the hub
created no delivery for it, and (if no one else was subscribed) never retained it at all. It cannot be
pulled, because `fetchTopic` serves log-class frames only. It cannot be back-filled, because
`subscribe` back-fills nothing.

**This is what "a member offline over lunch loses its messages" actually is.** It is not the four-epoch
key window. It is that the app lane's topics are epoch-derived and its delivery is push-only, so a
member is structurally incapable of receiving traffic from epochs it slept through. **It is true today,
before D1, and the commit lane has nothing to do with it.** No amount of `retainKeysForEpochs` touches
it.

---

## Step 3 — the fix, and the mutation check

**No fix was implemented, and that is the finding.** The ordering rule is a rule about a mailbox this
architecture does not have; implementing it would be implementing a race and calling it an invariant,
and it would leave B, C and F losing messages exactly as they do now. Per the brief's stop condition —
*"If the fix does not work, `BLOCKED`. Do not invent an alternative design."* — I stopped.

The mutation check is therefore inverted, and it is the most useful number in this report.

**What else in the repo catches a peer losing every message it was sent? Nothing.**

```
@kumiai/mls        287 passed (287)
@kumiai/broadcast   35 passed (35)
@kumiai/hub-tunnel  63 passed (63)
@kumiai/hub-server  57 passed (57)
@kumiai/hub-protocol 8 passed (8)
@kumiai/hub-client   5 passed (5)
@kumiai/rpc        149 passed | 1 failed (150)   <- the 1 is the assertion added here
```

The one failing assertion is `expect(seen).toEqual([{ text: 'before lunch' }])`. **The 148 rpc tests
and 287 mls tests that existed before this probe all pass while the peer silently loses every message
in its inbox.** The convergence assertion on the line directly above it passes too. That is the
measure of how silent this failure is.

---

## Verify

```
$ rtk proxy pnpm run build
Tasks:    7 successful, 7 total
Time:     466ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 189 files in 156ms. No fixes applied.

$ rtk proxy pnpm test
... 149 passed | 1 failed (150)   <- peer-app-drain.test.ts, deliberately red
ERROR  run failed: command exited (1)
```

**The tree is red at exactly one assertion, on purpose.** It is the only thing in the repo that knows
about this bug, and skipping it or inverting it would retire the only assertion that catches it. Left
uncommitted, in the tree, for the design call.

## What is in the tree

- `packages/rpc/test/peer-app-drain.test.ts` — new. Two tests, one green, one red.
- `packages/rpc/test/fixtures/peer.ts` — additive `handlers?` option on `MakeMLSPeerOptions`. Without
  it the app lane has nowhere to deliver, and no test in the suite could ever have asserted a
  plaintext across a commit. That absence is itself worth noting.

Nothing in `src/` was changed. `retainKeysForEpochs` was not touched.

## What the design has to answer before this can be fixed

1. **Should the app lane's topic be epoch-derived at all?** It is what makes an offline member's
   messages unreachable (C), and no lane ordering reaches that.
2. **Should app frames be log-class**, so a returning peer *pulls* what it missed — as the commit lane
   already does — instead of hoping the hub still holds a push for it? That fixes B, C, D and F
   together, and makes the ordering rule expressible: "drain the epoch-E topic" becomes a `fetchTopic`
   the peer can actually complete and know it has completed.
3. **If the app lane stays push-only**, then `rebuildEpoch()` unsubscribing `T(E)` is a **destructor**
   on the real store, and the peer is deleting its own unread mail. At minimum that teardown must be
   deferred, and the deferral is a retention window — which is precisely the thing the spec says must
   never be the fix.

---

# The destructor, and what was scoped out

*Appended after the coordinator accepted the `BLOCKED` finding. The app-lane architecture
("should app frames be log-class and pullable", "should app topics be epoch-derived") is
**scoped out** of this plan and will get its own spec. What follows is the one part that was
separable: the **data destruction**, which is now fixed.*

## The destructor

```
rebuildEpoch() → teardownEpoch() → client/busServer/acceptor.dispose()
              → mux.release(T(E)) → hub.unsubscribe(localDID, T(E))
              → dropDelivery()    → removeEntry()
```

**Advancing an epoch told the hub to delete the peer's own unread mail.** `memoryStore.unsubscribe`
(`hub-server/src/memoryStore.ts:379-396`) drops the subscriber's pending deliveries for the topic,
and a **mailbox frame whose last pending delivery that was is freed outright** — so the frame is
gone for everyone, not merely undelivered to one member. The store already asserts this of itself:

- `hub-server/test/memoryStore.test.ts:77` — *"unsubscribe clears the subscriber pending deliveries for that topic"*
- `hub-server/test/memoryStore.test.ts:89` — *"last unsubscribe frees a mailbox frame and leaves a log frame standing"*

The peer was calling it on every epoch rotation, on **both** its app topics: the protocol topic and
its **own directed inbox** (`createInboxAcceptor` subscribes `selfInboxTopic` through the same
`mux.onInbound` → `release` path, `directed.ts:189`). Directed mail was being deleted too.

The governing principle the coordinator set: **non-delivery is recoverable; deletion is not.** A
frame still retained in the hub can be handed to a pull-based app lane later. A frame `removeEntry`
has freed is gone forever.

## The fix — peer-side, no store change

The store's contract is untouched. **The peer simply stops asking for the deletion — anywhere.**

`packages/rpc/src/hub-mux.ts`: **nothing in the mux calls `hub.unsubscribe` any more.** `grep -c
'hub.unsubscribe' src/hub-mux.ts` → `0`. Two call sites went:

- **`release()`** — the last local listener leaving a topic used to unsubscribe it. That is what made
  `rebuildEpoch()` a destructor: rotating an epoch dropped the listeners on the epoch it left, and the
  refcount hit zero, and the hub was told to free that epoch's frames.
- **`dispose()`** — used to unsubscribe every remaining topic. **On a mobile client, `dispose` is what
  backgrounding the app calls**, so this was the same destructor firing in the single most common way
  a peer goes away: switch apps, lose your unread messages.

**The refcount is now about local listeners, and only about local listeners.** It still coalesces
overlapping registrations into one real `hub.subscribe`; it no longer has any authority to end the
subscription. That leaves unsubscribing as something **only an explicit leave-the-group would ever
do — and nothing in this package does it.** That is the right shape. A subscription is a durable
relationship between a member and a topic, not a session:

> *"Both topics are subscribed once for the peer's whole life — deliberately NOT rebuilt on resync."*
> — `initControlLanes`, on the commit and rendezvous topics.

**The app topics were the odd ones out, and they are now in line with the rest of the design.** A
member's subscription outliving its process is exactly the property that lets it come back and find
its mail. Dropping a listener, rotating an epoch, and disposing the peer all mean *"I am not
listening"*. None of them means *"I have read my mail; throw the rest away"* — and `unsubscribe` is
the store's word for the second one.

The peer keeps only a comment: `buildEpoch()` records that its protocol topic and its own inbox topic
are subscribed for the member's life on the same terms as the control topics. (An earlier draft added
a `HubMux.pin()` to hold those two subscriptions open against `release()`. Once `release()` and
`dispose()` stopped unsubscribing at all, `pin` was a no-op, and it is gone.)

## Everything that depended on the destructor was encoding it as an invariant

Four assertions had to change, and **each one was the bug, not the fix**:

- `peer-control-lanes.test.ts` ×3 — asserted `subscriberCount(T(old)) === 0` after an epoch rotation.
- `hub-mux.test.ts` — *"dispose stops the drain and unsubscribes remaining topics"*, asserting
  `subscriberCount === 0` after dispose. Exactly the shape the coordinator predicted.

They now assert the opposite, and say why. Two more mux tests that asserted the refcount unsubscribing
were rewritten to assert what the refcount is actually for: one real subscribe across overlapping
registrations, and **no unsubscribe when the last listener goes**. The dispose test now also publishes
after disposal and checks the frame is still held for the member.

## Mutation checks

Both halves of the fix are load-bearing.

**Put `dispose()`'s unsubscribe back:**

```
× dispose stops the drain and leaves the subscriptions standing
Tests  1 failed | 148 passed | 1 skipped (150)
```

**Put `release()`'s unsubscribe back** (the earlier check, against the epoch-rotation half):

```
× commit and rendezvous are subscribed once at init, survive resync, drop on dispose
× a Commit advances and resyncs every receiver
× an accepted commit appends to the log and resyncs the sender
Tests  3 failed | 147 passed | 1 skipped (151)
```

## The cost, stated and accepted

**Subscriptions accumulate, one protocol topic + one inbox topic per epoch, bounded by nothing this
package enforces.** They are never released — not on rotation, not on dispose — so the bound is the
member's whole participation in the group, not its process uptime and not the retention window.

At the design's target volume — **100 commits/day — that is ~1400 hub subscriptions per member per
week**, ~6000 a month, each a `Map` entry per topic in the store's `subscriptions`. It is not
unbounded-per-unit-work, but it is a real number and it is not small. **It is a stated, accepted
cost**, taken deliberately, because the alternative is deleting users' mail.

Two things bound it, and neither is this plan's to build:

1. **It dissolves entirely if the redesign drops epoch-derived app topics.** One stable topic per
   protocol is one subscription per protocol, forever, and the whole accumulation goes away. This is
   the likely outcome, and it is the reason not to build a sweep now.
2. **Otherwise, an unpin/unsubscribe sweep bounded by the retention window.** Once a topic's frames
   have aged out of the hub there is nothing left to destroy and unsubscribing is free, which caps the
   set at (retention × commit rate). **It needs a retention figure the app lane does not currently
   declare** — the commit topic asks for 30 days; the app topics take the hub's default and say
   nothing — and inventing one here would be inventing app-lane policy, which is what was scoped out.

## The failing test

`packages/rpc/test/peer-app-drain.test.ts` — **kept, `test.skip`, not weakened.** The comment above it
says what it proves, why it cannot pass today, and that it waits on the app-lane redesign. A reader can
unskip it and watch it fail for the right reason: the restarted peer holds epoch 1's key, is handed the
epoch-1 frame by the hub, and drops it because `ready` pulls the commit log to the head before it
builds the app lane, so it never installs the listener.

**What has changed for it is that the frame it drops is no longer deleted.** It stays in the hub — the
peer is still a subscriber of that topic, and will be for as long as it is a member. The test is now a
statement about *delivery*, which is recoverable, and no longer about *destruction*, which was not.

The green test beside it stays too, and is load-bearing evidence in its own right: **the commit lane
does NOT outrun the mailbox.** They are the same ordered drain.

## Verify

```
$ rtk proxy pnpm run build
Tasks:    7 successful, 7 total
Time:     469ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 189 files in 159ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/mls          287 passed (287)
@kumiai/hub-protocol   8 passed (8)
@kumiai/broadcast     35 passed (35)
@kumiai/hub-tunnel    63 passed (63)
@kumiai/hub-server    57 passed (57)
@kumiai/hub-client     5 passed (5)
@kumiai/rpc          149 passed | 1 skipped (150)
```

**Green.** Not committed; left in the tree.
