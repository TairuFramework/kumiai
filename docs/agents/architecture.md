# Architecture

kumiai (組合, "union / cooperative") is the MLS group-messaging layer -- the top of the stack.

## Packages

mls (E2EE identity + membership via MLS -- the crypto core), broadcast (generic fan-out),
the hub subsystem (hub-protocol, hub-client, hub-server, hub-tunnel), and rpc. Locked group
while pre-1.0 (young, tightly coupled).

## Position in the stack

Depends downward on sozai, kokuin, and enkaku; nothing depends on kumiai. See the stack
overview: https://github.com/TairuFramework/kigu/blob/main/docs/stack.md

---

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

Three, over the same hub, distinguished by what derives their topic and what they retain.

| Lane | Topic derived from | Class | Read by |
| --- | --- | --- | --- |
| **Commit** | the group's lifelong recovery secret | `log` | pull, from a cursor |
| **Rendezvous** | the recovery secret | `mailbox` | push |
| **App** | the **anchor** (a per-epoch secret) | both | push (live) + pull (drain) |

The commit lane's secret is epoch-independent and lives as long as the group, which is what lets a
member absent for weeks find its way back. The app lane's cannot be, for the reason below.

## The app-lane anchor

The app topic is derived from an **anchor**: a `{secret, epoch}` pair, where `secret` is
`exportSecret()` at `epoch` — the **per-epoch** secret, never the recovery secret.

**Load-bearing:** a removed member keeps the recovery secret for life, and every topic ID it ever
derived. Epoch numbers are counters it can enumerate. So a topic derived from anything it keeps
cuts nobody off; only the per-epoch secret does. This is the whole of the removal boundary.

**The anchor sits at the last roster change** — an Add *or* a Remove — and nowhere else. Two
constraints meet only there:

- A **Remove** must move it: the evicted member holds every topic ID it ever derived, so the group
  must leave them.
- An **Add** must move it too: MLS ratchets forward, so a member added at epoch E can never export
  an earlier epoch's secret. An anchor left behind is one the newest member cannot derive.

`max(last add, last remove)` is the only epoch that is both after every removal and held by every
current member. Members **agree natively**: each reaches it by applying the same commit, the joiner
seeding at its own add epoch included. Nothing is exchanged.

A **rejoin** (external commit) moves it for the Add reason, from a member the roster diff cannot
see: the rejoiner keeps its DID *and* its leaf index (ts-mls's resync blanks the leaf and the new
one takes the leftmost blank — the one it just blanked). No diff over any state reads true, so the
commit says so itself: the header carries `external`, and the lane rotates on
`rosterChanged || external`.

**The anchor is persisted, not derived.** A rebooted handle has ratcheted past the anchor epoch and
can never re-export its secret. A peer that re-seeded from its live handle would be right at genesis
and wrong ever after — deriving its own topics, invisible to everyone who stayed up, silently.

A **segment** is the run of epochs between two roster changes: one stable topic.

## Procedure kind × retention

Retention is declared **per procedure, in the protocol definition** — not chosen per call. The send
API stays one `dispatch(prc, data)`, routing by the declaration.

```ts
const room = defineGroupProtocol({
  'room/posted': { type: 'event', retain: 'log', data: { type: 'object' } }, // drainable history
  'room/typing': { type: 'event', data: { type: 'object' } },               // ephemeral (default)
  'room/roster': { type: 'request', params: {}, result: {} },               // always ephemeral
})
```

**Only events may be `log`.** `request` / `gather` / `reply` are always ephemeral, and
`defineGroupProtocol` rejects `retain: 'log'` on them at definition time. Retaining a correlated
procedure would re-fire responders on drain, against an `rid` whose requester and timeout died long
ago.

## The returning-member drain

A retained app frame is readable at exactly one moment: **the epoch it was sealed at**, before the
commit that leaves it. After that apply the handle holds different key material and those bytes are
ciphertext forever.

So the drain is **interleaved with the commit walk, ahead of each apply** — never after it. It pulls
a segment's topic once, buffers the frames sealed, and dispenses each epoch's as the walk passes
through. The binding is per **frame-epoch**, not per rotation: a segment spanning five epochs is
dispensed five times off the one pull. Delivered frames reach the host through the existing
`handlers` map; there is no separate delivery API. Its own frames are not echoed back to it, as the
live fan-out would not.

> **ts-mls retains 4 past epochs — do not lean on it.** A state at epoch N can decrypt application
> messages sealed at N-1…N-4 (`retainKeysForEpochs`, default 4; eviction *zeroes* the key material).
> But the window is spent by **epoch transitions, not time**, so a catch-up walk destroys the very
> keys it would need: a member away four commits could read, a member away a week could not. That is
> a correctness cliff disguised as a working design. rpc reads at the sealing epoch, full stop.

**`unwrap` throwing is ordinary control flow** on every read path — it is how a frame says "not my
epoch". An implementation that opens strictly at the current epoch is a correct implementation of
the port.

### The cursor, and why the port has `frameEpoch`

The drain holds a **durable read position per topic** (`AppCursorStore`). Without one it re-reads a
topic from the hub's oldest retained frame on every restart — for a roster-stable group, that is its
entire history, every time — and it has no place to notice the retention floor passing it.

**The advance rule is the safety property: a cursor may only pass a frame that is DELIVERED or
DEAD.** It advances over the contiguous run of finished frames and stops dead at the first that is
not, because a position is a place in the *log*, and passing it passes everything before it. A frame
sealed *ahead* of the walk is neither — it opens once the walk gets there — so the cursor waits
behind it. Passing it would drop it on the next restart, which is the loss the whole lane exists to
stop.

That rule needs a distinction `unwrap` cannot make. It throws "not my epoch" and cannot say *which*:
sealed-ahead (opens later) and sealed-below (never opens again) are the same exception. So
`GroupCrypto.frameEpoch(bytes)` reads the epoch from the frame's own **cleartext**, pre-open — as
`readCommitHeader` is pre-apply. One line for a host, over `@kumiai/mls`'s `readMessageEpoch`.

**Trust boundary:** `frameEpoch` is the *publisher's* word, carried in the clear and relayed by an
untrusted hub. It decides only what to try and what to pass — **never** what is authentic. `unwrap`
is the only authority on opening, and a frame claiming this epoch that will not open is treated as
any other frame that will not open.

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

When the drain finds the hub's oldest retained frame is newer than its cursor, the peer fires
`onAppWindowPruned` — a **notice**, not an error (surviving frames are delivered anyway), naming the
group and the gap's edges. It carries **no wall-clock**: "messages since \<date\>" is the host's own
sentence, from the host's own HLC. It over-reports, because a peer whose cursor frame has aged out
cannot prove nothing followed it — that is the side to be wrong on.

## What a host wires

`createGroupPeer` takes two ports and three durable stores. **The stores are required alongside the
`mls` port and the type enforces it**, because every one of them fails *silently* when absent:

| | |
| --- | --- |
| `GroupCrypto` | `epoch`, `exportSecret`, `wrap`, `unwrap`, `frameEpoch` |
| `GroupMLS` | commit lifecycle, `rosterDIDs`, `readCommitHeader` (incl. `external`) |
| `CommitJournal` | single slot; loses a commit whose process died in the acceptance window |
| `AnchorStore` | the anchor; without it a restart partitions the peer from its own group |
| `AppCursorStore` | the read position; without it the drain re-reads history forever |

`onAppWindowPruned` is **optional** — the line is whether omitting it loses messages. A host with no
cursor store partitions or re-reads; a host ignoring the pruned signal loses nothing it would not
have lost anyway. It is merely not told.

## Stated residuals

Bounds this design has, on purpose, rather than hides:

- **A member away beyond the retention window** loses those messages — surfaced as a pruned-window
  event, never silent.
- **The `processCommit` → anchor-save window.** `processCommit` is durable; a crash before the anchor
  is persisted restores a stale anchor and misses the new segment until the next roster change.
  Closing it needs the anchor inside the same durable write as the handle, which rpc cannot reach.
- **A laggard publisher** — a member still at epoch E writing to segment E's topic after the group
  has rotated past it seals bytes nobody can open again. Inherent.
- **A fresh joiner cannot drain pre-join frames** (its ts-mls history window is empty). Correct by
  design: forward secrecy.
- **The drain is at-least-once against the live path.** The cursor tracks the drain, so a restart can
  re-deliver frames that arrived live and sit after it.
