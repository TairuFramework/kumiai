# The app lane cannot deliver to a member who was away

**Status:** problem statement, awaiting design. Not a plan — the shape of the fix is a real design
question and deserves a brainstorm, not a probe.
**Found by:** question 3.7 of `docs/superpowers/plans/2026-07-13-control-ledger-lane.md`, which went
looking for a different bug and found this one underneath it.
**Evidence:** `docs/superpowers/probes/question-3.7-report.md` — six experiments, and a test in the
tree (`packages/rpc/test/peer-app-drain.test.ts`, skipped) that fails for exactly this reason.

## The claim

**A member is structurally incapable of receiving app traffic from any epoch it was not subscribed
through.** Not "past a retention window" — *any* epoch it slept through. At the design's target commit
volume the epoch turns over constantly, so this is an ordinary user closing their laptop over lunch and
losing every message sent while it was shut.

This is **not** caused by the control-ledger lane. It is true today, before any of it, and no key
retention window touches it.

## Why

Three properties compose into it, and each is individually defensible:

1. **App topics are epoch-derived.** `protocolTopic(secret, epoch, name)` and
   `inboxTopic(secret, epoch, did)` (`packages/rpc/src/peer.ts`, `buildEpoch`). This buys unlinkability
   across epochs: a removed member cannot follow the group's traffic, the way it can still follow
   `commitTopic`.
2. **App frames are mailbox-class, and therefore push-only.** `fetchTopic` serves **log-class frames
   only** — an app frame **can never be pulled**. A frame exists solely as a per-recipient pending
   delivery, *created at publish time for the then-current subscribers*, and a mailbox publish with **no**
   subscribers is dropped outright.
3. **`subscribe` back-fills nothing.** Subscribing to a topic late gets you an empty topic.

So a peer that was at epoch 1 when it went away was never a subscriber of the epoch-3 topic. When the
group published there, the hub created **no delivery for it**, and — if nobody else was pending — did
not retain the frame at all. It cannot pull it. It cannot back-fill it. **The message was never
addressed to it and no longer exists.**

## The three losses, all confirmed

From the probe's experiment table (`seen` is the plaintext the peer's handler actually received):

| scenario | result |
|---|---|
| frame at an epoch the peer **never held** | **lost** — never a subscriber, no delivery ever created |
| frame at the peer's own epoch, published **after** the commit that leaves it (a sender that had not yet pulled) | **lost** — it is *behind* the commit in delivery order; the peer cannot drain what it has not got |
| frame at the peer's own epoch, peer **restarted** | **lost** — see below |

The restart case has its own mechanism, and it is the one that is cheap to fix: at startup the seed pull
runs **to head before `buildEpoch()`**, so a peer that comes up at epoch 1 holding epoch-1 frames builds
its app lane at epoch 11 and **never installs a listener on the epoch-1 topic at all**. The hub pushes
the frame straight at it; it lands in the mux drain, finds no listener, and is dropped on the floor.
**The hub delivered it. The peer held the key. It threw it away.**

A control proves the key is not the issue: the identical restart with **zero commits** reads the
message, at epoch 1, through a test double that opens *only* the current epoch.

## What has already been fixed, and what has not

**Fixed in the control-ledger-lane plan — every path that DELETED mail.** On the real store,
`unsubscribe → dropDelivery → removeEntry` is a **destructor**: it frees the subscriber's pending
deliveries, and frees the frame outright for everyone if that was the last pending reader. Three paths
reached it, and all three are closed:

1. **`rebuildEpoch()`** unsubscribed the old epoch's protocol topic — so *advancing the epoch deleted the
   peer's own unread mail out of the hub.*
2. **The self-inbox topic** went through the same release path, so **directed mail was deleted on every
   rotation too.** Nobody had named this one; it fell out of fixing the first.
3. **`peer.dispose()`** unsubscribed everything — and **on a mobile client, `dispose` is what
   backgrounding calls.** The same destructor under another name, firing in the most common way a peer
   goes away.

The rule now matches what the control topics always did: **a subscription is a durable relationship, not
a session.** The peer releases *listeners*; it does not ask the hub to forget it. Unsubscribing is
something only an explicit leave-the-group action would ever do, and nothing does it.

Non-delivery is recoverable by a future design. Deletion is not. **That is the whole reason these were
fixed here and the rest was not.**

**Accepted cost.** Subscriptions are no longer torn down on rotation, so they accumulate — at the design's
target commit volume, roughly 1,400 hub subscriptions per member per week of process uptime. This is
**stated, not hidden**, and it **dissolves entirely if the redesign drops epoch-derived topics** (one app
topic per group, subscribed for life, exactly as `commitTopic` and `rendezvousTopic` already are). An
unpin-and-unsubscribe sweep once frames age out is the alternative, and it needs a retention figure **the
app lane does not currently declare** — the commit topic declares 30 days; the app topics take the hub
default and say nothing. Naming one is app-lane policy, which is this document's job, not the control
lane's.

**Not fixed:** every path that merely FAILS TO DELIVER. The frames are now *retained*, and still not
*reachable*.

## The design question

**Should app frames be log-class and pullable, as the commit lane already is?**

That would fix every loss at once. A returning peer already walks the commit log epoch by epoch,
deriving each epoch's secret as it applies each commit — so it could derive `T(E)` and **pull** that
epoch's app topic before stepping past it. It also makes the ordering rule *expressible* for the first
time: "drain epoch E" becomes a `fetchTopic` the peer can complete **and know it has completed**, rather
than a race against a push loop with no empty-signal.

The costs are real and are what the brainstorm is for:

- **Retention and GC change.** Log-class means trim-only, no ack-refcount GC. App messages would be
  retained for the topic's window regardless of who has read them.
- **Unlinkability.** Epoch-derived topics are why a removed member cannot follow the group's app traffic.
  Any scheme that lets a *returning* member reach an old epoch's topic must not also let a *removed* one.
  This is the crux, and it is not obviously easy: the returning member's evidence that it is entitled to
  epoch E is that it can derive epoch E's secret — which a removed member, by construction, cannot. That
  may be enough. It needs to be argued properly rather than assumed.
- **Volume.** The app lane carries far more traffic than the control lane, and a log the whole group
  pulls has a different cost profile from per-recipient mailboxes.

The alternative — keep push-only and hold each epoch's listener open for N epochs — was considered and
rejected: it fixes only the restart case, a peer that slept through an epoch was **never subscribed** and
still receives nothing, and the deferral **is** a retention window, which is exactly what the
control-ledger spec says must never be mistaken for a fix.

## Do not start here

The next step is `superpowers:brainstorming`, not a probe. The question "should the app lane be
log-class" reaches retention, GC, unlinkability, and the hub's storage profile, and the wrong answer is
expensive to undo.

## One number worth carrying into that conversation

When the failing test was written, **148 rpc tests and 287 mls tests passed while the peer silently lost
every message in its inbox.** The convergence assertion on the line directly above the failure passed
too. And no test in the suite *could* have caught it: the peer fixture had no way to register an app
handler, so nothing in the repo had ever asserted a plaintext across a commit.
