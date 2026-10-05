# Lanes and retention

How frames are held, which lanes carry what, and how long a member can be away.

## Retention classes

The hub holds two kinds of frame, and the difference decides what a member who was away can ever
read. It is set per publish (`retain`), and the hub is the only thing that knows about it — it is
blind to groups, epochs, and members.

**`mailbox`** (the default) is per-recipient pending delivery: push-only, ack-refcounted, and
**dropped at publish if nobody is subscribed**. It cannot be pulled. A subscription back-fills
nothing.

**`log`** is retained unconditionally, has a compare-and-set head, and is readable with
`fetchTopic` to a cursor. Unsubscribing frees nothing. A log-class publish with no subscriber is
still retained.

A topic may carry **both**. `fetchTopic` returns only the `log` frames — which is what lets one app
topic serve live ephemeral traffic and a drainable history at once.

## Lanes

Four, over the same hub, distinguished by what derives their topic and what they retain.

| Lane | Topic derived from | Class | Read by |
| --- | --- | --- | --- |
| **Commit** | the group's lifelong recovery secret | `log` | pull, from a cursor |
| **Rendezvous** | the recovery secret | `mailbox` | push |
| **App** | the **anchor** (a per-epoch secret) | both | push (live) + pull (drain) |
| **Inbox** | the anchor + the member's own DID | `mailbox` | push |

The inbox lane carries directed 1:1 RPC. One topic per member, and it has more consumers than any
other lane: the acceptor for each protocol, plus one directed client per member being spoken to. All
of them read it through **one open-once path** (`rpc/src/open-once.ts`), because opening consumes the
frame's per-message ratchet key — two consumers each calling `unwrap` race for one key and the loser
silently drops the frame. That was a real defect: directed RPC answered nothing over real MLS while
the fake, whose `unwrap` was pure, kept every test green.

The commit lane's secret is epoch-independent and lives as long as the group, which is what lets a
member absent for weeks find its way back. The app lane's cannot be — see
[the app lane](./app-lane.md).

## Retention window

Members request **28 days** on subscribe, for both the commit log and the app log. They are
**aligned by choice**, so the membership-rebuild bound and the app-drain bound coincide: there is no
span in which a member can rebuild its membership but not its messages.

> They are independent dials (`commitLogRetentionSeconds`, `appLogRetentionSeconds`). Moving one
> alone silently reopens that gap. If you change one, change both.

The hub **operator** governs real storage via its own `maxRetention` cap; this is a default members
carry, not a mechanism. A per-member override is possible up to that cap.

**Four weeks, not thirty days, and the two days are the margin.** `createMemoryStore`'s reference
ceiling is thirty days, and a hub **refuses** a retention above its ceiling rather than clamping it.
A default sitting exactly *on* the ceiling leaves the documented per-member override nowhere to go:
every upward move is refused outright. The relationship is asserted, not merely written down —
`packages/rpc/test/hub-mux-subscribe-failure.test.ts` fails if the defaults drift up to the ceiling
or apart from each other.

### A subscribe the hub refuses

An operator may still set a tighter cap than the reference one, so the refusal has to be survivable.
A peer that is not a subscriber of a topic is pushed nothing on it and cannot pull it — no commit
applies, no app frame arrives — so `hub-mux` treats a refusal as follows:

| | |
| --- | --- |
| Transient (a dropped socket) | Retried on a bounded backoff. Not reported if it heals. |
| Permanent (`RetentionExceededError`) | **Not** retried — the hub has answered, and asking again is a busy loop against a settled result. |
| Either, once given up on | **Latched**, and reported via `onSubscribeFailed`. |

A latched topic is not a topic this peer holds, so it is not recorded as one: a later `retainTopic`
asking for a *different* window tries again. A later retain carrying **no** window does not — a
caller with no opinion about retention must not overrule the one that had an opinion and was
refused, since subscribing anyway would land the peer on the hub's default and deliver exactly the
silent downgrade the `RetentionExceededError` exists to refuse.

The latch, not the callback, is the guarantee: every `publish` and `fetchTopic` on a refused topic
throws the hub's own error. A host that wires no callback therefore still cannot mistake such a peer
for a healthy one — a peer that cannot receive on a topic does not go on transmitting there. The
callback exists because a peer that only *reads* a topic calls nothing that could throw.

## Fetch coverage and pruning

Every fetch result requires a boolean `gap`, sharing one snapshot with `messages` and stored `head`.
It reports a removed log frame after the exclusive `after` cursor and before the first returned message.
For an empty page, it covers removals at or before `head`. With no cursor, it covers any removed log frame.
Removal of the cursor frame alone is no gap. Mailbox removal never counts.
Missing or non-boolean `gap` fails the fetch and retries the pull.
`oldest` names the earliest retained log frame or is null. Positions are sparse per topic, so `oldest` cannot detect gaps.

Log head and the `removedThrough` watermark are monotonic stored state, surviving trim, purge and empty pages.
Log removal is prefix-only per topic, ordered by position rather than timestamp.
Age purge stops at the first log frame it must retain, even under a backward clock.
Mailbox expiry remains independent. Depth eviction retains the head frame, so it cannot produce an empty-page gap below head.
A fetch after head is empty with `gap: false` when nothing after it was removed.

The app lane checks every page of every pull with an `after` cursor.
On `gap: true`, `onAppWindowPruned` reports that fetch's own cursor and `oldest: string | null`.
Null means the retained window is empty. Surviving frames still deliver.
Notices deduplicate per topic and cursor in memory. A restart may repeat a notice, and no cursor produces no notice.
The notice contains no wall-clock time. Hosts derive any date description from their own state.
Persisted notices can be lost on crash or disposal, so hosts recover required state from stores.

A commit-topic gap strands the peer as `retention-gap` and starts confirmed recovery after the lane releases.
Removing only its cursor frame leaves coverage intact. A fresh joiner rejoins only when an uncovered floor leaves a publication at risk.

## Ephemeral delivery

An ephemeral frame reaches a receiver when the hub accepted it after that receiver's topic subscription was acknowledged.
Its listeners must register within the acknowledgement TTL, while the receiver still holds the frame's epoch.
Early subscription on anchor capture and pending-frame handover cover the single-epoch walk window.
Before subscription acknowledgement, beyond the TTL, or across further epoch advances, ephemeral delivery remains best-effort.
