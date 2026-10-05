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
stop. A future claim stays retained even when the hub temporarily omits the commit that would
produce its epoch. A forged claim can hold the cursor until an operator calls `dropAppFrame`;
durable peers report that wait once through `onAppDeliveryStalled`.

That rule needs a distinction `unwrap` cannot make. It throws "not my epoch" and cannot say *which*:
sealed-ahead (opens later) and sealed-below (never opens again) are the same exception. So
`GroupCrypto.frameEpoch(bytes)` reads the epoch from the frame's own **cleartext**, pre-open — as
`readCommitHeader` is pre-apply. One line for a host, over `@kumiai/mls`'s `readMessageEpoch`.

**Trust boundary:** `frameEpoch` is the *publisher's* word, carried in the clear and relayed by an
untrusted hub. It decides only what to try and what to pass — **never** what is authentic. `unwrap`
is the only authority on opening, and a frame claiming this epoch that will not open is treated as
any other frame that will not open.

## Durable log dispatch

A resolved log `dispatch` means durable acceptance into the required `AppOutbox`, not publication.
A rejected dispatch accepts nothing and publishes nothing.
`retentionOf` follows the procedure declaration. Only log events enter this queue.
The host supplies `appOutboxLimit`. Admission rejects lapsed senders with `SendNotAdmissibleError`.
Encoded plaintext above `MAX_APP_ENTRY_BYTES = 524,288` throws `AppEntryTooLargeError`.
Outstanding entries and unresolved reservations count towards the cap, which throws `AppOutboxFullError` rather than blocking.
Reservations preserve call order even when puts settle out of order.
The worker cannot pass an unresolved reservation or an earlier unresolved entry.

Log delivery is at least once across epoch changes and sender restarts, with per-sender order.
The peer retains each accepted event until it proves a publication readable by every member at that publication's epoch.
Removal, host outbox clearing or permanent disposal ends this promise without delivery, with host-visible outcomes.
Handlers must be completion-safe on retry: after partial failure, a duplicate must finish all remaining effects.
An upsert alone does not guarantee completion. No new envelope message ID suppresses duplicates.
The host's atomic `put` resolves only after durability and leaves no row on rejection.
`list` returns ascending sequence order. `remove` and `clear` are durable, and removing an unknown sequence is harmless.
Sequences identify outstanding entries and may recur after a drained queue restarts.
`lastAttempt` records preparation only, never acknowledged publication.

The outbox contains arbitrary event plaintext, potentially indefinitely during strand or lapse.
The host encrypts it at rest and clears it on group deletion or leave.
Row deletion does not establish physical erasure. The host chooses an erasure policy.

`HandleAccess.admission()` and `GroupMLS.sendAdmission()` publish one lock-free snapshot alongside `epoch()`.
They never acquire the handle lock or wait on read, mutate, replace or open.
The snapshot updates after mutate/open and after replace's adoption callback resolves.
Dispatch inside adoption reads the epoch being left and can await durable insertion without taking the lane.
The host's outbox put must not wait on that same adoption transaction.
Dispatch inside one's own renewal can still be refused by the old lapsed snapshot. The host dispatches after adoption.

The worker catches up, checks admission, seals, persists preparation, publishes, then probes the commit head.
Ciphertext epoch, admission epoch and the captured floor epoch must agree.
Only an acknowledged publication is eligible for certification.
A safe probe proves no commit head beyond its floor. A covered, complete walk begun after acknowledgement also certifies at that epoch.
A gap, strand or uncovered walk cannot certify. The worker holds and re-seals after a ratchet.
A fresh joiner with an uncovered floor rejoins only when an acknowledged entry remains at risk after a non-ratcheting walk.
Failures retain entries and retry with exponential backoff from one to sixty seconds.
A failed remove retries removal alone. Sustained commit pressure can delay delivery until a seal-to-probe interval has no intervening commit.

A commit removing the local member clears queued entries and reports `onAppOutboxCleared({ reason: 'removed', seqs })`.
A sender removed behind a retention gap cannot learn its removal or obtain GroupInfo from current members.
Its entries remain durable and unpublished, with strand and recovery-failure reports, until the host clears them or disposes the peer.
Lapse after enqueue holds entries until renewal or removal.
Every final frame passes the whole-frame guard. `FrameTooLargeError` keeps an outbox entry for host inspection, without publishing it.

## The rotation slot and recovery

`AnchorStore` holds `{ anchor, pending?: { epochBefore, epochAfter, rosterBefore, forced, advance } }` atomically.
One rotation record spans exactly one handle advance and is saved before that advance starts.
`advance` identifies its digest. A recovery records `PendingRecovery.epoch`, never its header epoch or the old handle's epoch plus one.
The next advance resolves the previous record while the target epoch's exporter secret remains available.
A landed record rotates on roster change or forced external rejoin and saves `{ anchor }`.
A known-unlanded refusal clears the record.
`MissingLedgerEntriesError` with port epoch equal to `epochBefore` also clears it, while the walk retains poison classification.
An ambiguous throw at `epochBefore` keeps the record. Only the same advance may retry it.
A throw after landing still resolves and repairs the anchor before another advance.

At startup, repair runs before replay, seed advances and delivery.
At `epochBefore`, no durable replacement landed, so startup drops the record.
At another epoch beyond the target, the secret is gone. The peer requires a confirmed forced rejoin instead of inventing a topic.
Minimal readiness installs control lanes and holds sealing, commits and walk advances until that recovery lands.
Ordinary peer-owned advances close the anchor crash gap. Hosts that advance outside the peer can still require coordinated recovery.

Recovery adopts only after a member confirms the published external commit.
A retention gap strands immediately as `retention-gap`, leaving the cursor and queued entries unchanged.
`renewal-required` and `refused` hold recovery until the host changes inputs and calls `recover()`.
A ratchet also clears renewal-required. `unconfirmed`, no-responder and deadline retry on backoff.
The [lifecycle contract](./mls-lifecycle.md#recovery-and-trust-residuals) defines bound signer gates and refused-binding handling.

## Revoke hold and peer ownership

`commit(build, { holdLogSends: true })` takes a synchronous hold until landing or known-unlanded resolution.
No queued log frame is submitted during the hold, even if sealed or durably prepared earlier.
The held commit waits for already submitted log publications to settle before journalling or publishing.
`JournalEntry.holdsLogSends` preserves this ordering across restart. Hosts must store and return the flag unchanged.
Ephemeral and directed sends remain outside this hold.

One live `GroupPeer` owns the group's outbox, commit journal and anchor slot on one designated commit hub.
Other hubs are failover candidates. Shared stores across simultaneous peers can overwrite sequences and rotation records.
All log sends, commits, recovery and revoke runs use the owning peer.
A host switches ownership by calling `dispose()`, awaiting `drained()`, then constructing the replacement.
Calling `drained()` before disposal rejects. Disposal remains non-blocking with respect to host callbacks.

`drained()` waits for disposal teardown and every already invoked host effect to settle, including abandoned promises and returned callbacks.
New host calls after disposal reject synchronously. Parked hub receive/close work and runtime work do not hold the drain.
WARNING: never await `drained()` inside that peer's counted callback or port invocation, because it would wait on itself.

Acceptance effects must be recoverable from the current durable handle, including effects missed after a crash or rejected callback.
Journal replay alone cannot restore them once adoption cleared the journal.
The host can persist a dirty mark with handle advances and reconcile effects from current state.
Persisted notices can be lost on crash or dispose. Notices are not replayed, so hosts recover required state from stores at startup.


## Durable commit cursor

`AppOutbox.getCommitCursor()` and `putCommitCursor()` store `{ position, epoch }` separately from queued entries.
Each write must be durable before resolution. Clearing entries preserves the cursor. Group deletion clears both.
The peer writes a cursor only after MLS state for its paired epoch is durable.
Hosts must finish MLS persistence before successful commit processing or adoption returns.
Startup seeds the commit walk only when the stored epoch equals `GroupMLS.readEpoch()`.
An epoch mismatch discards the cursor and starts from the oldest retained frame.
A matching cursor lets undelivered entries resume without a recovery rejoin, costing at most one duplicate per entry.
Recovery request keys remain available for at least the configured recovery or ledger deadline, with a 120-second minimum.
