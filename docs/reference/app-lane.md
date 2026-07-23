# The app lane: anchor, segments, drain, cursor

The app lane is the one lane whose topic rotates. Everything here follows from that.

## The anchor

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

## The returning-member drain

A retained app frame is readable at exactly one moment: **the epoch it was sealed at**, before the
commit that leaves it. After that apply the handle holds different key material and those bytes are
ciphertext forever.

So the drain is **interleaved with the commit walk, ahead of each apply** — never after it. It pulls
the segment's topic on **every drain**, not once per segment: the log is not the same log at every
epoch inside the segment — it grows, and a frame published while this peer walks is one a single
pull could never see. Frames already seen are deduped by their `logPosition`, the place in the
topic's log that the hub reports on a log-class push. The pull buffers the frames sealed and
dispenses each epoch's as the walk passes through. The binding is per **frame-epoch**, not per
rotation: a segment spanning five epochs is dispensed five times off the one pull. Delivered frames
reach the host through the existing `handlers` map; there is no separate delivery API. Its own
frames are not echoed back to it, as the live fan-out would not.

> **The past-epoch window IS reachable here, and rpc still must not use it.** ts-mls holds key
> material for 4 past epochs (`retainKeysForEpochs`, default 4; eviction *zeroes* it), and it does
> reach this port: a frame sealed at epoch 3 opens against a handle that `processMessage` carried
> to epoch 4, while the same read six transitions on is refused with ts-mls's own "Cannot process
> message, epoch too old" — measured, and the correction of an earlier claim here that the window
> was unreachable. (That claim held only for a handle **replaced wholesale**, as when a member
> adopts the derived handle of a commit it authored: that handle starts with no history, which is
> the case it was measured on.) Leaning on the window is wrong anyway, because it is spent by
> **epoch transitions, not time**: a catch-up walk destroys the very keys it would need, and a
> member away four commits could read where a member away a week could not. rpc reads at the
> sealing epoch, full stop.
>
> Three further structural bounds on that window, measured against `ts-mls@2.0.0-rc.13` and worth
> having written down before anyone reaches for it again:
>
> - **Past-epoch reads are application-messages-only, by explicit design.** A commit or proposal
>   from a former epoch throws rather than being processed, so a retained frame can never re-drive
>   group state — the window lets a peer read payloads it missed, never catch up through them.
> - **A freshly joined handle's window is empty**, not partially filled. The join path, the create
>   path, and the **external-commit** path all initialize the history map from scratch, so a member
>   that resyncs by external commit — which is how a stranded peer rejoins — can read nothing
>   sealed before that rejoin, in principle and not merely in practice.
> - **Within a single epoch the ordering slack is also bounded**: ts-mls keeps only the 10 most
>   recent skipped generations and caps forward jumps at 200. A drain reading one sender's frames
>   in generation order is unaffected; one reading them out of order can lose keys more than 10
>   generations behind the highest it has already consumed.
>
> None of this is tunable from `@kumiai/mls` today: `resolveMlsContext` never sets `clientConfig`,
> and `GroupOptions` exposes no knob, so the defaults always apply. Widening the window would be a
> code change here, not a caller option — and would trade a hard bound for a tunable one while
> keeping stale key material alive longer, which is the wrong direction.

**`unwrap` throwing is ordinary control flow** on every read path — it is how a frame says "not my
epoch". An implementation that opens strictly at the current epoch is a correct implementation of
the port.

## The cursor, and why the port has `frameEpoch`

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
