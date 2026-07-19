# @kumiai/rpc

High-level, MLS-aware group RPC for Enkaku. Wraps the pub/sub hub and the
broadcast primitives so a group is a first-class messaging substrate: address
the whole group (events), a subgroup, anycast a request, gather replies, or run
directed 1:1 RPC (request/stream/channel) to a single member — all over
epoch-rotating opaque topics, with an authenticated sender on every surface.

## The two consumer ports

group-rpc never imports MLS. It owns transport and orchestration; the consumer supplies the crypto
half through two ports:

- **`GroupCrypto`** — the epoch number, the epoch-bound topic-derivation secret, `wrap`/`unwrap` for
  app traffic, `frameEpoch` to read a sealed frame's epoch from its cleartext, and
  `sealEntries`/`openEntries` for a commit's ledger-entry blob.
- **`GroupMLS`** — the lifecycle half: read a Commit's own claims before touching it, apply the ones
  this member is in a position to apply, report the roster the apply left behind, and drive the
  recovery/ledger rendezvous.

`@kumiai/mls-rpc` implements both over a live `@kumiai/mls` handle. `@kumiai/rpc-conformance` is the
contract every implementation and every double must pass.

Three constraints a port implementation is most likely to get wrong, all of which the suite pins:

- **`unwrap` throwing is ordinary control flow**, not an error: it is how a retained frame says "not
  my epoch". Every reader here walks logs full of frames from epochs it does not hold. An
  implementation that opens strictly at the current epoch is a correct implementation of the port —
  a real handle's few epochs of retained key material are spent by epoch *transitions* rather than by
  time, so nothing may depend on the window.
- **`readCommitHeader` returning `null` means "these bytes are not a Commit at all"** — never "a
  Commit I could not read". The lane files `null` as poison and steps over it, so a port answering
  `null` for every commit framed away from its own epoch makes a peer that fell behind read the
  group's entire future as garbage, walk to the end of the log, and report itself fully reconciled at
  a dead epoch.
- **`processCommit` returns `{ advanced: false }` for anything it cannot apply, and throws for
  exactly one outcome**: a Commit it should apply whose named ledger entries will not resolve from
  the Commit's own frame. A throw makes the lane re-read the frame, so a port that throws on a commit
  it was never in a position to apply wedges the lane there forever — a late joiner would wedge on
  its own add-commit, the first frame it reads.

`sealEntries`/`openEntries` are deliberately not `wrap`/`unwrap`. The entry blob is opened from
inside the apply of the commit that carries it, and a ratchet-backed open mutates the handle, which
is unsound there however it is scheduled. Derived-key sealing makes opening pure, so the question of
when it is safe to open stops existing rather than being managed.

## The app lane: logged events

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
