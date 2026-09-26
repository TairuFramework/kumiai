# @kumiai/rpc

High-level, MLS-aware group RPC for Enkaku. Wraps the pub/sub hub and the
broadcast primitives so a group is a first-class messaging substrate: address
the whole group (events), a subgroup, anycast a request, gather replies, or run
directed 1:1 RPC (request/stream/channel) to a single member — all over
epoch-rotating opaque topics, with an authenticated sender on every surface.

`peer.protocol(name).gather(prc, { param, quorum?, timeoutMs?, onReply?, signal? })` resolves with
the collected replies. `onReply` runs once per accepted reply as it arrives, with its authenticated
`senderDID` and the same object stored in the result array. Treat that object as read-only. A
throwing callback is ignored. Aborting `signal` resolves with replies collected so far. A signal
already aborted resolves `[]` without sending, including while the peer waits for initial readiness.

## The two consumer ports

group-rpc never imports MLS. It owns transport and orchestration; the consumer supplies the crypto
half through two ports:

- **`GroupCrypto`** — a synchronous epoch hint, `exportSecret(label, length?)` for as many epoch-bound,
  domain-separated exported secrets as there are labels, `wrap`/`unwrap` for app traffic,
  `frameEpoch` and `frameAAD` to read a sealed frame's cleartext metadata, optional `pending`
  storage for durable app delivery, and `sealEntries`/`openEntries` for a commit's ledger-entry blob.
- **`GroupMLS`** — the lifecycle half: read a Commit's own claims before touching it, apply the ones
  this member is in a position to apply, report the roster the apply left behind, and drive the
  recovery/ledger rendezvous.

`@kumiai/mls-rpc` implements both over a live `@kumiai/mls` handle. `@kumiai/rpc-conformance` is the
contract every implementation and every double must pass.

**Taking these ports means running that suite against your implementation.** A host that uses
`@kumiai/mls-rpc` gets both ports right by construction and inherits its conformance run. A host
that writes its own does not, and one method makes that most expensive: `exportSecret` is the member
of either port whose MOST CONSEQUENTIAL failure mode is silent. Derive its bytes from anything a
removed member keeps and nothing breaks — the group works, removals remove, the health monitor is
quiet — while an evicted member can still name and read the app topic, which derives from it.
`sealEntries`/`openEntries` rest on the same per-epoch removal boundary and fail the same way: a
hand-rolled seal keyed off anything but the epoch secret round-trips, throws nothing, and lets a
removed member open the ledger-entry blobs of commits enacted after its removal.

Four constraints a port implementation is most likely to get wrong, all of which the suite pins:

- **`epoch()` is a hint; decisions use the epoch a result reports.** A host's published epoch can
  lag its handle or, after a rolled-back transaction, run ahead of it. So every port result that
  acted on the handle carries the epoch it acted at, read under the host's handle lock:
  `exportSecret` returns `{ secret, epoch }`, `sealEntries` returns `{ sealed, epoch }`, `unwrap`
  returns `epoch`, `processCommit` returns `{ advanced, epochBefore, epochAfter }`, and
  `GroupMLS.readEpoch()` answers when no operation runs. The suite's epoch clauses set the hint one
  behind and one ahead and expect the same answers.
- **`unwrap` throwing is ordinary control flow**, not an error: it is how a retained frame says "not
  my epoch". A readable frame at another epoch must throw `FrameEpochError { frameEpoch,
  handleEpoch }` before anything is decrypted. The lane retains a frame only on that error's
  "ahead" answer; any other refusal marks it dead.
- **`readCommitHeader` returning `null` means "these bytes are not a Commit at all"** — never "a
  Commit I could not read". The lane files `null` as poison and steps over it, so a port answering
  `null` for every commit framed away from its own epoch makes a peer that fell behind read the
  group's entire future as garbage, walk to the end of the log, and report itself fully reconciled at
  a dead epoch.
- **`processCommit` returns `advanced: false` for anything it cannot apply, and throws only for a
  Commit it may yet apply**: one whose named ledger entries will not resolve from the Commit's own
  frame (a `MissingLedgerEntriesError`), or a fault that says nothing about the Commit, such as a
  resolver or store failure. A commit at another epoch, including one the handle moved past while
  entries resolved, is `advanced: false` with the handle's epoch. A fault makes the lane re-read
  the frame, so a port that throws on a commit it was never in a position to apply wedges the lane
  there forever — a late joiner would wedge on its own add-commit, the first frame it reads.

`sealEntries`/`openEntries` are deliberately not `wrap`/`unwrap`. The entry blob is opened from
inside the apply of the commit that carries it, and a ratchet-backed open mutates the handle, which
is unsound there however it is scheduled. Derived-key sealing makes opening pure, so the question of
when it is safe to open stops existing rather than being managed.

## The app lane: logged events

### Durable delivery (opt-in)

Supplying `GroupCrypto.pending` enables acknowledged delivery for events declared `retain: 'log'`.
For a conforming hub that appends and retains the frame until it is durably opened, the peer
delivers these events **at least once**, in log order per protocol, across process restarts and
handler failures. A successful handler return acknowledges the event; a thrown handler or failed
`pending.complete` retries the same record with backoff, holding later events in that protocol.
An event handler that never settles holds its protocol indefinitely. Disposing the peer does not
cancel an active handler; the host must settle its work or restart the peer to retry the record.
The handler context's `frame: AppFrameRef` identifies a logged delivery. Store a deduplication
entry keyed by `frame.id` in the same transaction as the handler's effect before returning.
External effects must be idempotent or reconciled by that id. A record may be delivered again if
the process crashes after the effect but before completion.

`AppFrameRef` includes `id`, `topicID`, `protocol`, anchor `segment`, and log `position`. The id
is derived from the topic and ciphertext, so it stays stable across replay. `pending.list()`
restores records at startup in `(segment, position)` order; `pending.complete(id)` is idempotent.
The port's `unwrap(bytes, { expectedAAD, frame })` must atomically save the consumed-key handle
state and the pending record before resolving. A failed save must leave the handle openable and
throw an error recognized by `isAppFrameStorageError`; the app lane retries without advancing
past that frame. `onAppDeliveryStalled` reports a persistent storage block, a missing protocol on
restore, or a future-epoch frame once per blocking frame. A missing-protocol record stays
pending and can be delivered after that protocol is registered on a later start. An operator can
accept a frame's loss with `dropAppFrame(topicID, position)`; it can explicitly discard a
missing-protocol record, but refuses a pending frame under a registered protocol. It also refuses
to drop a sealed frame behind an earlier pending or sealed frame, because the durable cursor cannot
record that drop until the earlier frame is settled.

Durable delivery is off when `GroupCrypto.pending` is absent. Ephemeral events remain best effort;
directed traffic and anycast requests and replies keep their existing live completion or expiry
semantics. Log-intent pushes only wake a retained fetch: pushed bytes and positions never become
pending records. The hub must have appended the frame to the topic log before pushing it.
Frames pruned before a read, or lost after a failed durable open followed by retention expiry,
cannot be recovered; `onAppWindowPruned` reports a visible gap. A hub that only sends a log frame
by mailbox also gives no durable guarantee. A frame published at epoch E and first fetched after
this peer has moved past E is refused: the peer cannot authenticate its sender after that move.
A hub can withhold or omit frames. A frame claiming an epoch above this peer's current epoch remains
retained with the cursor behind it even if a commit fetch omits the matching commit. It opens when the
peer reaches that epoch, or an operator can explicitly discard it with `dropAppFrame`. A forged
far-future claim can hold delivery until that drop; `onAppDeliveryStalled` reports the wait once with
`reason: 'future-epoch'`. A frame below the current epoch remains refused.
The existing commit-applied-before-anchor-saved crash window can still leave a restarted peer on
a stale app topic.

App-frame AAD is `[0x01, intent, ...UTF8(topicID)]`, where intent is `0x01` for log and `0x00`
for ephemeral. `frameAAD` reads this cleartext routing hint; only `unwrap` with the full expected
AAD authenticates it. Old bare-topic AAD fails to open, so mixed 0.9/0.10 app peers are
incompatible. Use `encodeAppAAD` and `decodeAppAAD` for the shared format.

An `event` procedure in a group protocol may declare `retain: 'log'`, which makes every dispatch of
it retained by the hub and pullable later, whatever the call site:

```ts
const chat = defineGroupProtocol({
  message: { type: 'event', data: { type: 'object' }, retain: 'log' },
})
```

Only `event` procedures may. `defineGroupProtocol` throws for a `retain` on anything else, and the
type rejects it too, so an erased type cannot slip one past. Correlation traffic
(`request`/`stream`/`channel`) is always ephemeral, and retaining it would be unsafe: a re-pulled
request re-fires its responder, and the rid/timeout/quorum machinery has no meaning outside its
original round.

Retention is the *protocol's* word, never the frame's. A retained frame naming an ephemeral
procedure was published `retain: 'log'` by a member whose dispatch would not do that, and the drain
drops it.

### The anchor

App-lane topics are derived from an **anchor** — a secret and the epoch it was exported at — that
sits at the last commit which changed the roster, not at the live epoch. Both constraints meet only
there: a Remove must move it, because an evicted member keeps every topic ID it derived; an Add must
move it too, because MLS ratchets forward and a member added at epoch E cannot export any earlier
epoch's secret. `max(last add, last remove)` is the only epoch that is both after every removal and
holdable by every current member, and every member reaches it by applying the same commit, so they
agree natively. A rejoin rotates it as well, on the applied commit's own external flag — a rejoining
member's effective join is its rejoin epoch, and nothing a roster diff can see moves.

`GroupPeer.anchorEpoch()` exposes where it sits.

### The returning-member drain

A peer that was away pulls each app topic's retained segment and delivers it through the *same*
handlers the live bus server is built from, so a drained frame and a pushed one reach the host by the
same door. Its own frames are not delivered — the live fan-out never echoes a publisher its own
broadcast, and a drain that did would make a returning member the only one to see its own messages
arrive.

The rule that makes the durable cursor safe: **a cursor may only pass a frame that is DELIVERED or
DEAD.** A frame sealed below the handle's epoch is dead (MLS ratchets forward — those bytes are
ciphertext forever), as is one that claims this epoch and will not open, as are bytes that are not a
sealed frame at all. A frame sealed *ahead* of the walk is neither: it opens once the walk gets
there, so the cursor stops behind it and the frame stays buffered. That distinction is what
`GroupCrypto.frameEpoch` exists for — `unwrap` throwing says "not my epoch" and cannot say which.

When the hub's retention floor has passed the position a peer had read to, the frames between them
aged out unread and the optional `onAppWindowPruned` callback says so. It is a notice, not an error:
the frames that survived are delivered either way. It over-reports (a peer whose own cursor frame has
aged out cannot prove nothing was published between it and the floor) and never stays quiet about a
real gap.

## What a host must supply for the commit lane

`mls`, `journal`, `anchorStore`, `appCursorStore` and `adoptJournalled` arrive **together or not at
all** — the params type is a union, so a host cannot wire a subset. Each missing piece is a silent
failure:

| | Without it |
| --- | --- |
| `journal` — durable single slot, written before every publish, cleared on both outcomes | every commit whose process died in the acceptance window is silently lost |
| `anchorStore` — one slot, overwritten on every rotation, read once at construction | the peer re-seeds the anchor at its live epoch on the next restart and silently partitions from its own group, deriving topics no member that stayed up is on |
| `appCursorStore` — a read position per topic, written as each drain finishes | the peer re-reads its app history from the hub's oldest retained frame every restart, re-delivers what it already delivered, and has nowhere to notice the retention floor passing it |

Neither the anchor nor the cursor can be re-derived. The anchor sits at an epoch the live handle then
runs past, and MLS ratchets forward, so a rebooted handle can never re-export it.

`adoptJournalled` is the restart half of a pending commit's `onAccepted`, and must be idempotent: the
peer cannot tell an entry whose `onAccepted` already ran from one whose process died before it, so a
Welcome goes out again — at-least-once, by design.

The hub is asked to retain both the commit log and the app log for **28 days** by default. Two days
below the reference hub ceiling, deliberately, so an upward override has somewhere to go: a hub
refuses a retention above its ceiling rather than clamping it, and a default sitting exactly on the
ceiling would make every upward override an outright refusal — leaving the peer not a subscriber of
its own commit topic. The two windows are aligned so there is no span in which a returning member can
rebuild its membership but not its messages.

## Host notices for commit strands and recovery

`GroupPeerParams.onStrand` reports when the commit walk finds evidence that this peer is stranded.
One observation marks one stranded episode; further frames stay silent unless they provide strictly
stronger evidence. A successful recovery, including a bootstrap completed later, ends the episode.
The next strand starts a new one. A failed attempt leaves the episode open. The state is in memory,
so restarting a peer can produce a new observation for the same strand.

Each `StrandObservation` names the stable commit-topic `groupID`, the frame's log `position`, the
peer's `localEpoch`, a `kind`, and a `confidence`. `claimedEpoch` comes from the cleartext header;
`commitDigest` identifies the commit bytes. Both are `null` for an unreadable future version.

| Kind | Confidence | What the evidence establishes |
| --- | --- | --- |
| `own-unmerged` | `authenticated` | Sender data proves this device sealed a commit at this epoch that the hub now places in the log. Commit content is unverified; a hub can tamper beyond the ciphertext sample or fake acceptance. Heal. |
| `fork-losing` | `observed` | This peer enacted different commit bytes at that epoch and is on the branch that loses the log-position tiebreak. The other commit is not authenticated. |
| `ahead` | `claimed` | A frame's cleartext epoch is ahead of this peer. A commit-topic publisher can forge that claim. |
| `unknown-version` | `claimed` | A frame's handshake or commit-frame version cannot be read by this build. Its epoch and commit bytes are unavailable. |

`GroupPeerParams.onRecovery` reports `started` and exactly one terminal event (`succeeded` or
`failed`) for each attempt. The event's `attemptID`, `groupID` and `trigger` (`automatic` or
`consumer`) stay the same. A failure has reason `no-responder`, `deadline`, `bootstrap-failed`,
`disposed` or `error`; `error` includes the thrown value. Success means both the rejoin and ledger
bootstrap completed. If a rejoin landed but bootstrap failed, a later lane operation can finish it
and emit `bootstrapped` with that failed attempt's ID. This closes the stranded episode.

`started` is dispatched asynchronously as the attempt begins, before any rendezvous reply or
terminal event is required. It can arrive while the attempt is waiting on a port call; an observer
that disposes the peer then ends the attempt with `failed` (`disposed`).

Automatic healing and calls to `recover()` share one in-flight attempt. Joiners get its result or
error; they do not start another attempt. Owed `reenact` entries are kept until the first
`recover()`, `commit()` or `replay()` that drains them. A direct `recover()` can therefore return
entries stashed by an earlier automatic heal. Each entry is handed out once.

`onStrand` and terminal `onRecovery` notices run after the producing commit-lane operation settles.
`started` is dispatched earlier. None is awaited; throws and rejections are swallowed. `onAppWindowPruned`
retains its existing behavior.
