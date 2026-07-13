# Design: the control-ledger lane

**Status:** design, revision 18 (2026-07-13). Reviewed fourteen times by kubun in
`2026-07-13-control-ledger-lane-review.md`; G1–G27 are folded in below. Revisions 16–18 fold in
the first two implementation probes: `NotSubscribedError`, a `trim` primitive, a 30-day default
window, two retention classes with subscriber-requested durations, **G28 — the commit lane must
not outrun the mailbox**, which silently destroys downloaded messages, and **G29 — `head`
advances only on a log publish**, without which any member can wedge the lane for the group.
**Supersedes:** the requirements in `../../agents/plans/next/2026-07-13-host-ledger-lane.md`
(R1/R2/R3), which stays as the origin record.
**Scope:** `@kumiai/mls`, `@kumiai/rpc`, `@kumiai/hub-protocol`, `@kumiai/hub-server`,
`@kumiai/hub-tunnel`. Hosts implementing `HubStore` pay a migration.

## Problem

`@kumiai/mls` 0.2 made the control ledger authoritative — a commit's envelope names the
entries it enacts, `foldEnvelope` refuses entries not admin-authored at their own
position, and `ledger_head` chains the enacted ids into the GroupContext. That core is
sound. Three things around it are not:

1. **Bodies never travel.** The envelope is ids-only, so a receiver that has never seen
   an entry body throws `MissingLedgerEntriesError` and cannot apply the commit. The
   library leaves the id→body half to the host. Every host needs it, and a host that gets
   the ordering backwards strands its peers permanently.
2. **Recovery is dead.** `GroupMLS.exportGroupInfo` is contracted to return group state
   *sealed to the requesting member's leaf*. `mls` has no sealing primitive, so no host
   can satisfy it. Every host either leaks the ratchet tree to the relay or stubs the
   method out.
3. **Concurrent commits fork the group.** kumiai is apply-then-announce. Two admins at
   epoch N both commit, both apply locally, both fan out — neither can apply the other's
   commit, and the group is split with no exit. Rare today only because commits are rare;
   kubun's move of its whole control plane onto `commitLedgerEntries` raises commit
   frequency by an order of magnitude.

A fourth, surfaced while reviewing D1 and fixed here as a consequence of it:

4. **`HubStore` is a mailbox, not a log.** `fetch` is a per-recipient delivery queue, and
   `publish` snapshots its recipients from the topic's subscribers *at publish time*. A
   member invited at epoch N who subscribes after two further commits have landed is never
   sent those commits — there is no backlog to ask for. It is stranded on arrival, today,
   independent of everything above. Two further consequences, both load-bearing for D1:
   **a publish with no recipients stores nothing at all** (`memoryStore.publish`:
   `if (recipients.size === 0) return sequenceID` — the sequence is burned and no row is
   written), and **`ack` deletes** — `removeDelivery` refcounts a message down and GCs it
   out of `topicMessages` when its last recipient acks. What looks like a topic log is
   derivative of delivery. Retention is a function of who has read a message, not of the
   topic.

## Design decisions

Taken in dependency order: ordering first, because it changes the peer's commit API that
the body lane rides on; sealing second, because the heal path depends on it.

### D1 — Ordering: the commit topic becomes a CAS'd log

**A byzantine hub can fork the group under any design.** CAS acceptance is an
unauthenticated claim: a lying hub can tell two admins they both won and partition
delivery. Fork *handling* is therefore a floor we cannot remove. CAS is not a soundness
guarantee — it is what removes forks from the honest-hub common case, which is the case
kubun's 10× commit rate actually creates. We build both.

**Threat delta of CAS against a compromised hub.** No confidentiality or authenticity
loss: accept/reject is a routing decision, MLS keeps both branches sealed and
authenticated, and the hub gains no read or forge power. Three deltas, all
availability/consistency class:

- *Censorship becomes deniable.* A hub can reject one admin's CAS forever while accepting
  another's. She believes she lost an honest race and retries, cooperating with her own
  censorship. The ceiling is unchanged — the hub could always drop her commit — but the
  failure goes from loud (she has already applied locally and diverges visibly) to silent.
- *Forks remain possible.* See above. The heal path is retained for exactly this.
- *The hub becomes stateful.* A lost or rolled-back head stalls the commit lane. Safety is
  unaffected (peers reject stale-epoch commits by MLS epoch); it is another way to stall,
  i.e. DoS.

Accepted. The hub can already drop, delay, reorder and partition; none of this raises its
ceiling.

#### The `HubStore` contract change: a log alongside the mailbox

`HubStore` is a **`hub-protocol` contract that hosts implement** — kubun backs it with SQL
over SQLite and Postgres. So the head lives in the host's database, and this is a contract
change every host with a hub must migrate for. `hub-protocol` *defines* the semantics; the
`HubStore` implementation *provides* them.

**This is not a field addition. `HubStore` gains a log.** Today, as problem 4 sets out,
messages are retained as a function of delivery: a publish with no subscribers is not
stored, and the last ack deletes the row. A CAS head over that is incoherent — the head
would advance past frames that were never stored, or that a reader's own ack destroyed, and
no peer could ever pull them. So:

- **Messages are retained per topic, independently of delivery.** A publish is appended to
  the topic's log whether or not anyone is subscribed. This is the system of record.
- **Delivery rows govern push only.** They remain an optimization — a wakeup signal — and
  `ack` deletes a *delivery*, never a log entry.
- **Trim governs the log** and is the only thing that removes a log entry. Trim moves `oldest`
  and never touches `head`. Nothing else deletes: not `ack`, not `unsubscribe`.
- **The `publishID` → `sequenceID` dedup record is not a log entry, and trim must not remove
  it (G24).** It has its own retention, strictly longer than the commit-log trim window;
  **retaining it indefinitely is the recommended implementation** — it is a hash and a
  sequenceID, one per commit rather than one per delivery, a few dozen bytes. Hanging the key
  off the message row is the natural implementation and it is **wrong**: trim would delete the
  idempotency record along with the frame, and a replay of that `publishID` would silently
  become an ordinary new publish. See "Restart replay" for why that is fatal rather than
  merely untidy.

#### The head is not history; the log is (G12)

The two things the store now retains have completely different lifetimes, and conflating them
is what makes "the hub keeps a log" sound more expensive than it is.

- **The head and the dedup record are permanent, and tiny.** One sequenceID per topic; one
  `publishID → sequenceID` pair per commit, a few dozen bytes. Together they are the *entire*
  anti-fork mechanism, and they do not depend on the frames still being there. **A hub whose
  commit log has been trimmed to nothing still cannot fork a group.** Ordering survives an
  empty log; only catch-up degrades.
- **Frames are history**, and exactly one reader wants them: the peer that fell behind and
  comes back at epoch N while the group is at epoch M.

That peer has two ways forward, and MLS offers no third:

- **Pull** frames N..M from the log and apply them in order. Needs only the hub.
- **Heal** — rendezvous with a live member, obtain a sealed GroupInfo, external-commit in
  (D2, G10). Needs **another member awake at that moment**.

There is no cheaper catch-up. MLS epochs cannot be skipped: a peer either replays every
commit or rejoins the group. And the hub cannot hold a snapshot to shortcut the replay — a
GroupInfo carries the ratchet tree and `external_pub`, so parking one at the hub is precisely
the leak D2 exists to close.

So the trim window buys exactly one thing: **how long a member may be offline and still
converge against the hub alone, without needing another member online.** That is the clause to
weigh, not disk. A group of phones where everyone is asleep and one wakes up converges from
the log; with no log it cannot converge at all until someone else opens the app.

- **Default the `commitTopic` window to 30 days, and make it a first-class configuration
  knob** — per host, and settable per topic class. It is a liveness/storage dial, and the
  design's job is to say what each end costs, not to pick for the host: a shorter window is
  cheaper and makes heal the ordinary reconnect path (so reconnects start depending on another
  member being awake); a longer window lets a long-absent peer converge against the hub alone.
- **Retention is unconditional** (that is the point of G7), so the log grows with commit
  volume — and D1 raises commit volume by an order of magnitude by design. A commit frame is a
  few KB, so a group committing 100 times a day for 30 days retains on the order of 10 MB.
  That is the high-water group; most commit orders of magnitude less. It is a tail cost, not a
  mean one.
- **Only `commitTopic` is a log.** `rendezvousTopic` and every app/broadcast topic keep
  mailbox semantics — deliver, ack, delete (G9). The hub stays a relay for the bulk of its
  traffic; the log is one topic per group.

#### Two retention classes, because the commit log's reader may not exist yet

A first cut of this design gave *every* topic the log's retention, and that is wrong in both
directions: app ciphertext would sit on the hub for 30 days after every recipient had acked
it, and the mailbox's ack-driven GC — which is *correct* for a mailbox — would have been
thrown away for no gain. The two lifetimes answer different questions:

| | `commitTopic` (log) | app / `rendezvousTopic` (mailbox) |
|---|---|---|
| Is the reader set known at publish time? | **No** — a member invited tomorrow must read frames published today | Yes — the current subscribers |
| Ack-driven GC | **Unsound** | Correct |
| Removed by | `trim` only | last ack, or age |
| Read with | `fetchTopic` | `fetch` (push/mailbox) |

The middle row is the whole point, and it is G7 one layer up. **Ack GC asks "has everyone
read this?" — and on the commit topic, the reader may not exist yet.** An invitee is not a
subscriber, not a member, not anything at publish time, so no refcount over current
subscribers can account for it. The last existing member acks, the frame dies, and the member
that needed it had not been born. That is why the commit log's retention cannot be delivery-
derived *even with* a complete and correct refcount.

(The invitee does not need the log for its *ledger* — `commitInvite` puts the whole ordered
ledger in the invite and `processWelcome` head-verifies it, so ledger history never comes
from the hub. What it needs from the log is the MLS commits that landed between its Welcome
and its first subscribe. It cannot skip them: MLS epochs do not skip.)

So the class is declared at publish:

```ts
export type PublishParams = {
  // ...
  /**
   * Retention class. 'mailbox' (default): today's semantics — the frame is removed once
   * every delivery is acked, or when it ages out. 'log': the frame is retained
   * unconditionally and removed only by trim, because a future subscriber may need it.
   */
  retain?: 'log' | 'mailbox'
}
```

**`rpc`'s commit lane sets this, not the host** — the host never gets the chance to pick
wrong. And it leaks nothing to the hub that the hub does not already have: the commit topic
is already the *only* topic that uses `expectedHead`, so a hub that wants to identify it
merely watches for conditional publishes.

**`head` advances only for `retain: 'log'` (G29).** A head that names a mailbox frame is a
head that can be deleted, and the CAS is then anchored to a frame no reader can pull. This is
not theoretical: every member is a subscriber of `commitTopic`, so **a member that publishes a
mailbox-class frame there moves the head to a frame that its own last ack then frees.** Peers
pull the log, never see that sequenceID, and their cursor can never reach the head; the next
conditional publish compares against something unfetchable. The lane wedges for the whole
group, permanently, and nothing raises. It is G19's shape — a member-triggerable, group-wide
denial of service — reached through the store instead of through the heal trigger.

So `head` means **the last accepted *log* publish**, which is exactly what CAS needs. A stray
mailbox frame on `commitTopic` becomes a frame the peer reads, fails to parse as a commit, and
steps over as poison. Mailbox topics never read `head` at all — they use `fetch`, not
`fetchTopic` — so nothing is lost by narrowing it.

#### Retention duration: the hub sets the bounds, the subscriber asks within them

Duration is orthogonal to class, and it is a subscription-time request:

```ts
export type SubscribeParams = {
  subscriberDID: string
  topicID: string
  /**
   * Requested retention in seconds for this subscriber's view of the topic. Absent: the
   * hub's default. Above the hub's maximum: RetentionExceededError, at subscribe time —
   * never a silent downgrade to the max, which would strand a peer that believed it had
   * asked for more.
   */
  retention?: number
}
```

- **A topic's frames live for the longest retention any of its *current* subscribers asked
  for**, floored at the hub's default. For a mailbox topic that bound sits *alongside* ack GC —
  whichever frees the frame first wins, and for a mailbox the ack usually does. For a log topic
  it is the only bound, since ack GC is off.
- Retention therefore follows the subscriber list rather than being a high-water mark only trim
  can lower. That is deliberate: a high-water mark can be pinned by a member who has since left.
  It is safe here because **the commit lane subscribes to `commitTopic` for the peer's whole life
  and never unsubscribes** — both group topics are non-rotating and survive resync — so the
  group's log window is stable for as long as the group has members.
- **The hub configures `{ default, max }`** and enforces the max. `hub-server`'s existing
  scheduled purge becomes the age enforcement for both classes.
- **`rpc`'s commit lane subscribes to `commitTopic` with the group's log retention** — 30 days
  by default, configurable. Everything else subscribes with the hub default, which is today's
  7 days, unchanged.

This is what makes both windows configurable by the hub while letting a consumer that knows
it needs more — a group of phones, a long-absent member — ask for it and be told no rather
than discover the shortfall as a stranded peer.

**A member offline longer than the mailbox window keeps its membership and loses its chat.**
That asymmetry is deliberate: the commit log is correctness, the mailbox is content. What the
design does *not* permit is a member losing content it successfully downloaded — see "The
commit lane must not outrun the mailbox" (G28).

**Trim is one primitive, and policy sits on top.** Depth-versus-age is a host decision, and
putting both in the contract makes neither testable. The contract exposes a single bound:

```ts
export type TrimParams = {
  topicID: string
  /** Remove log entries with sequenceID strictly below this bound. */
  before: string
}
```

A host implements a 30-day window, a depth cap, or both, by choosing `before`. What the
contract fixes is the invariant, and the conformance suite asserts it for every host: **trim
moves `oldest`, never touches `head`, and never removes a dedup record.**

**Removing a log entry removes the deliveries that pointed at it.** A delivery whose referent
is gone can never be pushed, so leaving it is a silent leak. A SQL host gets this free with
`ON DELETE CASCADE`; one without a foreign key leaks rows and nothing notices — so the suite
asserts it: *a trimmed entry leaves no pending delivery behind.*

```ts
export type PublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append
   * only if the topic's current head is exactly this value, where `null` means "the topic
   * has never had an accepted publish". On mismatch, throw HeadMismatchError and store
   * nothing.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original
   * sequenceID instead of appending again. This is what makes the commit journal's restart
   * replay work (see "Restart replay"), so its record has its OWN retention — it is not a
   * log entry and MUST NOT be trimmed with one (G24).
   */
  publishID?: string
}

export type FetchTopicParams = {
  /** Authorization: the caller must be a current subscriber of topicID, or NotSubscribedError. */
  subscriberDID: string
  topicID: string
  /** Exclusive cursor: messages after this sequenceID. Absent: from the oldest retained. */
  after?: string
  limit?: number
}

export type FetchTopicResult = {
  messages: Array<StoredMessage>
  /** The topic's current head: the sequenceID of the last accepted publish, or null. */
  head: string | null
  /** The oldest sequenceID still retained for this topic, or null if the log is empty. */
  oldest: string | null
}

export type HubStore = {
  // ...existing members unchanged
  publish(params: PublishParams): Promise<string>
  fetchTopic(params: FetchTopicParams): Promise<FetchTopicResult>
  trim(params: TrimParams): Promise<void>
}
```

**Named errors, because an unnamed one is a false pass.** `HeadMismatchError` for a lost CAS,
`NotSubscribedError` for a `fetchTopic` from a non-subscriber, `RetentionExceededError` for a
subscribe above the hub's maximum. All live in `hub-protocol` and all are part of the contract:
a conformance clause of the form `rejects.toThrow()` is satisfied by *any* throw — including a
host's not-yet-implemented stub — so the suite must be able to name what it expects. Every error
the contract requires a store to raise is a named type.

**`sequenceID` gains an ordering contract.** The design compares sequenceIDs in five places
— `expectedHead` equality, `head` against the cursor, `oldest` against the cursor, `after`
as an exclusive cursor, and the byzantine tiebreak. The type is `string` and its order has
never been specified; `memoryStore` works only because `formatSequenceID` happens to
`padStart(12, '0')`. A host that mints `String(counter)` unpadded, or a UUID, satisfies the
type and silently breaks every one of those comparisons (`"10" < "9"`). The contract now
requires:

- sequenceIDs are **lexicographically ordered, strictly increasing within a topic** —
  byte-comparable, so a fixed-width zero-padded encoding, not a bare decimal and not a UUID;
- the sequenceID is **minted by the store inside the CAS transaction**, not by the process.
  kubun mints from an in-process counter lazily seeded from `max(sequence_id)`, so two hub
  processes on one database already collide. Survivable for a mailbox; fatal for a head,
  because the head *is* a sequenceID.

**Atomicity is a contract requirement, not an implementation detail.** The head comparison,
**the sequence mint**, the append, and the head advance MUST happen in **one transaction**.
A read-then-write CAS is a race — precisely the race D1 exists to eliminate. A host reading
"the head is a scalar" could reasonably implement it as three statements; the contract
forbids that in words, and the conformance suite must catch it.

The head is **hub-assigned** — a `sequenceID`, which only the store mints. A member cannot
choose it, so a malicious member cannot wedge the lane by publishing a bogus head token.
This is why the CAS condition is not a member-supplied value. The payload stays opaque: the
hub sequences bytes it cannot read.

`fetchTopic` is gated on subscription, so it exposes a topic's log only to members who
already derive that topic from the group secret.

#### Topic split

Today's single handshake topic carries commits *and* recovery frames, and any publish would
move the head. It splits:

- `commitTopic(recoverySecret)` — commits only, CAS'd, read as a log.
- `rendezvousTopic(recoverySecret)` — recovery request/reply, unconditional, push-delivered.

Both remain non-rotating and derived from `exportRecoverySecret()`, so a peer stranded on
any epoch still shares both rendezvous with the live group. Both are subscribed for the
peer's whole life, never rebuilt on resync.

#### The commit lane is pull-driven

The peer drives `commitTopic` by **pull**, not by delivery. It keeps one cursor,
`reconciledHead` — the sequenceID of the last commit frame it has *processed*, whether it
applied that frame or dropped it as stale or malformed.

- **Seeding (G1).** A peer that has applied nothing from the topic — a fresh member from a
  Welcome, a peer whose backlog was trimmed, a peer that just rejoined by external commit —
  seeds its cursor by *reading the log*, not by guessing. It subscribes first, then calls
  `fetchTopic` from its last known cursor (or from the oldest retained frame), processes
  every frame it can, and sets `reconciledHead` to what it reached. A frame framed at an
  epoch it has already passed is dropped and still advances the cursor. This is also what
  closes problem 4: the late-subscribing joiner *pulls* the commits it missed instead of
  being stranded, and needs no recovery at all.
- **Push is only a wakeup.** The subscription still delivers commit frames; the peer treats
  a delivery as a hint to pull, and takes the frames from the pull. Delivery order,
  redelivery, and the store's exclusion of the sender from its own recipients all stop
  mattering for commits.
- **Ack becomes cursor-advance.** "Do not ack, so the hub redelivers" is no longer how the
  commit lane retries; the cursor simply does not advance. See D3.

**Only the commit lane becomes a log (G9).** Publish-time recipient snapshotting strands
late subscribers on *every* lane, not just this one. The rendezvous lane and the app lane
keep the mailbox semantics, deliberately: a recovery requester subscribes before it asks, so
it cannot miss its own reply, and app data has the host's own sync behind it. This is a
decision, not an omission — a new lane that needs history must opt into `fetchTopic`, and a
new lane that assumes a late subscriber sees anything published before it subscribed is
wrong.

#### The peer's commit state machine

`GroupPeer.localCommitted(commit)` — apply-then-announce — is **removed**. It is replaced by
`GroupPeer.commit(build)`:

```ts
type PendingCommit = {
  /** Framed MLSMessage(Commit) bytes. */
  commit: Uint8Array
  /** Signed ledger-entry tokens this commit enacts. Empty for a commit that enacts none. */
  bodies: Array<string>
  /**
   * What this commit was. Replay routes on it, so it never has to parse the framed commit
   * (G25). 'ledger' is fully rebuildable from `bodies` after a restart; the proposal-carrying
   * kinds are not, and must be surfaced to the host instead of silently dropped.
   */
  kind: 'ledger' | 'invite' | 'remove'
  /**
   * Opaque host blob holding everything needed to adopt this commit after a restart:
   * the serialized post-commit handle (`newGroup`) and any Welcome to deliver. Written to
   * the journal BEFORE the peer publishes. The peer never inspects it (G21).
   */
  journal: Uint8Array
  /** Runs only if the hub accepts. The host adopts newGroup here and sends any Welcome. */
  onAccepted: () => Promise<void>
}

/** Durable single-slot journal, host-provided. The host already persists handle state and
 *  has a database; the peer has neither. */
type CommitJournal = {
  put(entry: {
    publishID: string
    expectedHead: string | null
    commit: Uint8Array
    bodies: Array<string>
    kind: 'ledger' | 'invite' | 'remove'
    journal: Uint8Array
  }): Promise<void>
  get(): Promise<JournalEntry | null>
  clear(publishID: string): Promise<void>
}

/**
 * What replay found (G26). Delivered as a RETURN VALUE, never a callback (G27): replay runs
 * at lane step 0, inside the mutex, and the host's response to it is to call `commit()` —
 * which takes that same mutex. A callback fired under the lock whose documented purpose is to
 * make the host re-enter the lock is precisely the nesting G13 forbids, and the obvious host
 * handler deadlocks. Returning it means the host acts after the lane has released, so its
 * follow-up `commit()` is naturally a separate lane operation.
 *
 * `kind: 'ledger'` carries the surviving signed tokens: the host re-issues them with an
 * ordinary `commit()`. `kind: 'invite' | 'remove'` carries none: that commit did not happen
 * and cannot be reconstructed, so the host must re-issue the operation or tell the user.
 */
type LostCommit =
  | { kind: 'ledger'; tokens: Array<string> }
  | { kind: 'invite' | 'remove' }

/** Every lane operation replays first (step 0), so every one of them can surface a loss. */
type LaneResult = { lost?: LostCommit }

commit: (build: () => Promise<PendingCommit>) => Promise<LaneResult>
recover: () => Promise<LaneResult & { advanced: boolean; reenact: Array<string> }>
/** Replay on its own, for startup: run the lane's step 0 and hand back what it found. */
replay: () => Promise<LaneResult>
```

This keeps the symmetry the design has been arguing for: **`recover()` returns `reenact` and
replay returns `lost`** — two paths where the work survived and the closure did not, now
structurally identical rather than merely conceptually so. Neither calls back into the peer.

**`commit` holds a per-group mutex for its whole run (G3).** CAS resolves races between
devices; it says nothing about two callers on the same device. Two concurrent `build()`
calls would both frame at the same handle's epoch and diverge — exactly the hazard
`commitLedgerEntries` documents. The peer owns the commit loop, so the peer owns the
serialization.

Inside the mutex:

0. **Replay the journal (G22).** This is step **zero** of every lane operation, strictly ahead
   of the completeness check and the pull — the ordering is load-bearing, not stylistic. A
   peer that pulls first meets its own un-merged commit, fires the G18 trigger, and takes the
   expensive rendezvous path the journal exists to avoid. See "Restart replay".
1. Pull `commitTopic` to the end and process everything. `reconciledHead` is now current.
2. Call `build()`. The host has produced `newGroup` via `commitLedgerEntries` /
   `commitInvite` / `removeMember` but has **not** adopted it — mls commits are
   non-mutating, returning a derived handle and never advancing the source, so the host's
   live handle is still the pre-commit one.
3. **Journal the pending commit before publishing (G21):** `journal.put({ publishID,
   expectedHead: reconciledHead, commit, bodies, journal })` with a fresh `publishID`. This
   write must be durable before step 4 begins. It is what makes the acceptance window
   survivable *without a peer* — see "Restart replay".
4. Frame `[commit][wrap(bodies)]` (see D3) and publish to `commitTopic` with
   `expectedHead: reconciledHead` and that `publishID`.
5. **Accepted** → set `reconciledHead` to the returned sequenceID, run `onAccepted()`, clear
   the journal slot, rebuild the epoch.
6. **`HeadMismatchError`** → clear the journal slot and drop the `PendingCommit` untouched.
   Discarding costs nothing, and the pre-commit leaf key material is retained, which the heal
   path needs. Go back to step 1: pull the winning commit, let the host's handle rebase as it
   applies, and call `build()` again against the now-current handle.

#### Restart replay: the crash window is closed, not merely detected (G21)

**Before any lane operation, the peer replays its journal.** If the slot holds an entry, the
peer republishes it with the **same `publishID` and the same `expectedHead`**. The store's
idempotency contract decides the outcome, with no responder and no network peer involved:

- **The original publish was accepted** → the store returns its original sequenceID and
  appends nothing. The peer adopts the journalled `newGroup`, delivers the journalled Welcome,
  sets `reconciledHead`, and clears the slot. It is whole.
- **It was never accepted** → the republish is an ordinary CAS at `expectedHead`. It wins (the
  commit lands, adopt as above), or it takes `HeadMismatchError` — someone else committed
  meanwhile — and **what happens to the work depends on what the commit was (G25)**.

**Replay's `HeadMismatchError` cannot "rebuild like any other loser".** Inside `commit()` that
phrase is fine: losing means going back to step 1 and calling `build()` again, and `build()` is
a live closure over the host's current handle. **After a restart there is no closure** — the
process that held it is gone. So the branch routes on `kind`:

**Replay never re-enacts anything. It surfaces what survived and what did not (G26)**, and the
host commits again — for every `kind`. It surfaces it **as the lane operation's return value,
after the mutex is released (G27)**, never as a callback fired under the lock:

| `kind` | What replay hands back |
|---|---|
| `ledger` | **The journalled tokens, re-issuable.** Entry tokens are signed and epoch-independent — the property heal already leans on — so the work survives the restart intact. The host issues an ordinary `commit()` over them, membership-filtered exactly as G17 defines (they are *not* in the group's ledger, since this commit never landed, so the filter keeps them). Nothing is lost. After kubun's control-plane move this is *most* commits. |
| `invite` / `remove` | **A failure notice: this did not happen, and it cannot be given back.** The intent lives in the MLS Add/Remove proposal and the KeyPackage, not in `bodies`, and neither survives without `build()`. The host must re-issue it or tell the user. |

**The invariant, now load-bearing in two places: the peer never constructs a commit — only the
host does, via `build()`.** Every mechanism that "re-enacts" (heal, replay) is really the host
committing again over tokens the peer preserved. This is already `recover()`'s contract — it
returns `{ advanced, reenact }` and the caller commits those as a separate lane operation — and
replay has the identical shape, because it is the identical situation: the work survived, the
closure did not. A peer that could rebuild a `ledger` commit itself would need commit
*construction* behind `GroupMLS` (whose job is MLS state) and would gain a second, private way
to commit that never passes through the host.

**Silently clearing the slot is the one thing that must not happen.** For an invite it loses an
invitation; for a **remove** it is worse than data loss — the admin clicked evict, the process
crashed, and from their side the member is gone while in fact they are still in the group, with
no signal to anyone. An admin who believes a member was evicted when they were not is a
security-relevant no-op, not a UX wrinkle. The `kind` tag exists so replay can route without
parsing the framed commit, and so the host is told *which* of the two situations it is in.

**`onAccepted` MUST be idempotent — replay can and will run it more than once (G22).** The
sequence *publish → accepted → `onAccepted()` → `clear(publishID)`* is three steps and a crash
can land between any two of them, so an entry whose `onAccepted` already ran (wholly or
partly) is still in the slot on restart and gets replayed. Re-adopting the journalled
`newGroup` is harmless — it is a fixed serialized value, so adopting it twice is idempotent by
construction. **Re-delivering the Welcome is not:** the invitee has already joined, and a
second `processWelcome` over the same bytes is not a no-op — it errors or builds a duplicate
group state, and either way the invitee's host handles an event its author believed happened
once. The host must therefore write both halves of `onAccepted` to tolerate a repeat
(deliver-by-`publishID`, or simply no-op a Welcome for a member already at that leaf). The
journal's whole purpose is to make a commit *look* atomic, and that framing is exactly what
hides the at-least-once semantics underneath — so the design states them rather than letting a
host infer exactly-once.

This is why **the journal is not an optimization** (revision 8 said it was; it was wrong).
Every heal path terminates in `recover()`, and `recover()` is a rendezvous — it needs *another
member, online, able to seal a GroupInfo*. Consider the first commit of a group's life: the
creator is the sole member, it `commitInvite`s, the hub accepts (the frame is retained even
with zero other subscribers — G7 working as intended), and the process dies before
`onAccepted`. On restart the G18 trigger fires exactly as designed and `recover()` publishes a
rendezvous request — and **nobody answers, and nobody ever will**, because the only prospective
member is the invitee, whose Welcome `onAccepted` never sent. Without the journal that group is
**bricked at creation**: it can never merge its own commit, never advance past epoch 0, never
commit again (its `expectedHead` is behind the head its own orphan frame installed), and never
heal. Detection is not recovery.

The narrow alternative — "notice I am alone and just re-commit" — does not work: the orphan
frame is already in the log at epoch 0, so any later reader sees two frames at that epoch and
trips the fork trigger on them. The journal is the clean answer, and `publishID` has been in
`PublishParams` since revision 2 precisely so this costs no second host migration.

**Replay rests entirely on the `publishID` record outliving the log (G24).** If a store hangs
that key off the message row — the natural reading of "the log is the system of record, and
trim is the only deleter" — then trim destroys the idempotency record along with the frame,
and the replay of a trimmed `publishID` is no longer idempotent: it is an ordinary new publish.
In a multi-member group that degradation is *invisible*, because the republish CASes at a now
stale `expectedHead`, takes `HeadMismatchError`, and the peer falls through to `recover()`,
where responders exist. Something else catches it.

Run it through the sole-member group the journal exists for, and nothing does:

> The creator `commitInvite`s. It journals, publishes, the hub **accepts**, and the process
> dies before `onAccepted` — so the invitee never got a Welcome and never became a member.
> There is exactly one member in the world. The user does not reopen the app for longer than
> the trim window — 30 days by default. Trim removes the
> frame and, with it, the `publishID` record. The peer restarts and replays: the key is
> unknown, so the republish is treated as new — an ordinary CAS at the journalled
> `expectedHead` (`null`, the empty-topic sentinel, since it was the group's first commit).
> But `head` is still the sequenceID of its own trimmed frame, because **trim never touches
> `head`**. So `null ≠ head` → `HeadMismatchError` → discard. The peer pulls: no messages, a
> head it cannot reach, nothing retained → trim strand → `recover()` → **no responder, and
> there never will be one.**

The group is bricked at creation — G21's exact outcome, reached through the mechanism
introduced to prevent it. The journal survives the crash; it must also survive the calendar.

The G18 trigger stays, and the two mechanisms cover different failures: the journal recovers a
peer whose *own* pending state was lost; `recover()` recovers a peer whose *group* state is
unusable (trimmed out, or on a discarded branch). The journal makes the common crash need no
responder at all; heal remains the exit when the peer genuinely needs the group's help.

**The retry bound is a deadline, not an attempt count.** At the commit rate D1 is designed
for, with several active admins, five consecutive CAS losses on a busy group is not rare —
an attempt count turns ordinary contention into a thrown error. `commit` retries until a
configurable deadline (default 30s), with a large attempt ceiling retained only as a
runaway guard. Losing a CAS is the expected path, not an error path.

`build()` must read the host's *current* handle on every call — it is a closure, so this is
natural — and must have no side effects until `onAccepted` runs.

**A throw from `onAccepted` is the crash window, reached by a likelier route (G8).** The hub
has accepted; the group has advanced; the host failed to adopt — a DB write failed, a
Welcome send failed. `commit()` is therefore **not atomic**, and a host must not assume it
is. The peer treats a throw exactly as it treats the crash: it does not retry the commit
(the commit is already in the log and other members are applying it), it surfaces the
failure, and the peer heals by external-commit rejoin and re-enacts its entries. See
"Host-side impact".

Because a loser's commit is never published, the commit topic under an honest hub contains
only accepted commits.

#### The commit lane must not outrun the mailbox (G28)

Pulling the commit lane out of the mailbox breaks an interleaving that was previously free,
and the cost is silent message loss.

An MLS application message is decrypted from **its own epoch's** secret tree. `ts-mls` keeps
those for `retainKeysForEpochs` epochs — **4 by default** — and drops the rest
(`clientState.ts`, `removeOldHistoricalReceiverData`). The frame's epoch is in its cleartext
header, so the peer can always *see* which epoch a pending app frame belongs to; it just
cannot open it once the keys are gone.

Today commits and app messages share one mailbox and drain in sequenceID order, so a commit
is applied only after the app messages that preceded it. The interleave costs nothing and
nobody had to think about it. **D1 makes the commit lane a separate, pull-driven lane that
runs at lane step 0** — so replay races to the head while the mailbox is still full. Five
commits later, every app frame the peer had already downloaded is undecryptable. The peer is
perfectly in sync, the roster matches, no error is raised, and a week of messages is gone.

D1 makes this worse *by design*: moving a host's control plane onto `commitLedgerEntries`
raises commit volume by an order of magnitude. At 100 commits a day, four epochs is under an
hour — so this is not a 30-day-absence problem. **A member offline over lunch loses its
messages.**

The rule, which is local — the peer has every frame in hand and every epoch is readable
without a key:

> **Never apply the commit that leaves epoch E while app frames at epoch E are still
> undecrypted.** Replay drains the mailbox up to E, applies the commit, drains E+1, applies,
> and so on. The lane advances the group only as fast as the consumer drains it.

Raise `retainKeysForEpochs` above 4 as well, but as a safety net for ordinary out-of-order
delivery — *not* as the fix. The fix is the ordering rule; a bigger retention window only
widens the race it loses.

This is why the retention asymmetry in D1 is acceptable: a member offline past the mailbox
window loses chat it never received, which is a product decision. Losing chat it *did*
receive, because its own commit lane sprinted past the keys, is a bug.

#### One serialized lane; heal never runs nested (G13)

`commit()` holds the per-group mutex for its whole run, and its first step *pulls and
processes* frames — which is what fires the heal triggers. So heal is reachable from inside
the mutex, and `recover()` both mutates the handle and ends by re-enacting entries through
`commit()`. Nesting it either way is broken: take the mutex and a heal triggered inside
`commit()`'s pull deadlocks (twice over, on the tail call); skip the mutex and a concurrent
`commit()` builds against the pre-rejoin handle while `recover()` swaps it out — the exact
hazard the mutex exists for, on the path where the handle is least stable.

**All three operations — pull, `commit()`, `recover()` — are top-level operations on one
serialized per-group lane. None of them ever calls another. The mutex is never re-entered.**

**Every lane operation first checks the ledger-completeness invariant (G16)** — cheap, local,
no network — and bootstraps before proceeding if it fails. That is what makes a peer stranded
by a crash mid-bootstrap self-healing at its next lane operation or at startup, rather than
depending on `recover()` having remembered to finish.

- A heal trigger fired while processing a frame **records the condition and returns**. It
  does not heal in place. The pull finishes, the enclosing `commit()` unwinds and releases
  the lane, and its caller sees a retryable outcome.
- `recover()` then runs as its **own** lane operation, taking the mutex itself.
- Re-enactment after a successful heal is a **subsequent** `commit()`, queued on the lane
  after `recover()` releases it — which is just "heal is two commits, not one" (G10) falling
  out of the concurrency rule rather than being bolted onto it.
- A `commit()` that was in flight when heal was triggered re-enters the lane behind
  `recover()` and rebuilds, if it is still within its deadline.

#### Heal: `recover()` is a CAS loop of its own (G10)

Three paths reach heal — the trim strand, the losing branch of a byzantine double-accept,
and a crash or an `onAccepted` throw after acceptance. All three end in an **external
commit**, which changes the ratchet tree and must therefore land on `commitTopic` like any
other commit. That means every question D1 answers for `commit()` must also be answered
here, on the path where the group is *already* fragile.

- **The external commit is CAS'd**, at `reconciledHead`, seeded from `fetchTopic` exactly as
  a fresh member seeds it (G1's mechanism). Publishing it unconditionally would re-open the
  fork D1 exists to close, on the worst possible path.
- **Losing the CAS is the likely case, not the edge case** — heal runs precisely when the
  group is under commit pressure, and two peers healing concurrently (routine, given G12)
  race each other. But a heal retry is **not** shaped like `commit()`'s: the peer cannot
  simply rebuild, because its GroupInfo is now **stale** — it describes a ratchet tree the
  winning commit has already changed. It must discard the GroupInfo, re-request it, and
  rebuild the external commit from the fresh one.
- **Heal is two commits, not one.** `joinGroupExternal` returns `{ commitMessage, group }`
  and carries no entry envelope, so it cannot re-enact anything. The entries ride a
  *subsequent* ordinary `commit()`, which contends on the CAS like any other. "Rejoin and
  re-enact" is two acts, and the second one can lose.

```
recover(deadline):                          # a top-level lane operation; holds the mutex
  loop until deadline:
    pull commitTopic to the end             # may resolve the strand outright: nothing to heal
    requestID = fresh
    request = mls.createRecoveryRequest(requestID)   # ephemeral HPKE key, signed (D2)
    publish request on rendezvousTopic, await a sealed reply
    pending = mls.applyRecovery(sealed, requestID)   # opens with the ephemeral key,
                                                     # builds the external commit; null if unopenable
    publish pending.commit to commitTopic with expectedHead = reconciledHead
      accepted     -> pending.onAccepted()            # adopt the rejoined handle
                      reconciledHead = returned sequenceID
                      bootstrap()                     # REQUIRED: the rejoined handle's ledger
                                                      # is empty, which is a roster reset until
                                                      # this runs. Gathers the WHOLE ordered
                                                      # ledger, head-verified (D3). Failure is a
                                                      # persistent degraded state, NOT a heal:
                                                      # keep retrying; never return advanced:true
                                                      # with an incomplete ledger.
                      # Re-enact by MEMBERSHIP, not by failure mode (G17): keep only the
                      # in-flight entries whose ids the bootstrapped ledger does not contain.
                      # On the crash path this empties the list — those entries are already
                      # enacted, and re-appending them would revert a later admin's change.
                      return { advanced: true, reenact: inFlight.filter(id not in ledger) }
      HeadMismatch -> discard the GroupInfo AND the external commit built from it
                      (the GroupInfo describes a tree the winner already changed)
                      continue the loop
  deadline exceeded -> return { advanced: false }

# The caller re-enacts `reenact` via an ordinary commit() — a SEPARATE lane operation,
# queued after recover() releases the mutex. recover() never calls commit().
```

The peer's own entry tokens survive all of this untouched: they are epoch-independent, so a
discarded external commit costs nothing but the round trip.

**`recover()`'s own acceptance window is deliberately unjournalled: it is self-healing by
re-recovery (G23).** `recover()` has `commit()`'s shape — publish, accept, *then* adopt — so a
crash in that window leaves an orphaned external commit in the log. It converges anyway, and
the reason is worth stating so nobody journals it unnecessarily or assumes it is broken:

- On restart the peer holds its old, broken handle. It pulls, and its orphaned external commit
  is in the log framed at the **group's** epoch E — not at the peer's own stale epoch N. The
  G18 trigger tests authorship **and** current epoch: authorship matches, the epoch does not,
  so it stays quiet and the frame classifies as *history → advance*. (This is the G19
  narrowing paying for itself: an applicability-based trigger would have fired here.)
- The peer's original condition — trimmed out, or on a discarded branch — still holds, so it
  trips again, re-enters `recover()`, and builds a **fresh** external commit against a fresh
  GroupInfo. That one lands.
- `joinGroupExternal({ resync: true })` "atomically removes prior leaf for same identity", so
  the second rejoin collects the leaf the orphaned first one added. Leaves do not accumulate.

Re-recovering is cheaper than journalling a second path, and unlike the `commit()` window it
needs no responder that a size-one group cannot supply — a group with no other member has no
`recover()` to crash inside.

#### Heal triggers

Three of them, for the cases CAS cannot cover. All three are single-observation; the timing
heuristic in revision 1 is gone (G4).

**`recover()` has a precondition, and it must be stated (G21): heal requires at least one
other member that is online, holds the group, and can seal a GroupInfo.** It is a rendezvous;
without a responder it cannot work. When none answers, `recover()` burns its deadline and
returns `{ advanced: false }`, and the peer stays degraded and retries — which reads as "try
later" and *is* "try later", but only for a group that has other members. This is precisely
why the crash window is closed by the journal (above) rather than by heal: at group size one
there is no later.

- **Trim strand.** After a pull, `head > reconciledHead` but the intervening frames are no
  longer retained (`oldest` is past the cursor). The peer knows in one observation that they
  were trimmed, with no waiting. Action: `recover()`.
- **Byzantine double-accept.** The peer records, per epoch it has applied, the sequenceID of
  the commit it applied there. A fork is: **a valid commit at an epoch for which this peer
  holds a recorded applied-commit sequenceID, whose sequenceID differs from the recorded
  one.** "A valid commit at an epoch the peer has already passed" — revision 2's trigger —
  is *not* the test, and using it would be a bug: a late joiner pulling from `oldest` walks
  frames from before it was invited, a rejoined peer walks a log that predates its new leaf,
  and a re-seeded peer walks frames it never held. None of them ever "passed" those epochs.
  Every one of them would diagnose a fork on its first pull and escalate to `recover()`,
  turning the late-joiner fix into a recovery storm. **No record for that epoch → not a
  fork, just history.** Tiebreak, when it really is a fork: the branch whose conflicting
  commit carries the **lower** hub sequenceID wins — both peers can evaluate this once they
  see both frames. The loser rejoins by external commit onto the winner's branch and
  re-enacts its entries; entry tokens are epoch-independent, so re-enactment needs no
  re-signing.
- **Un-merged own commit (G18, narrowed by G19).** A valid frame framed at the peer's
  **current** epoch **whose committer is this peer**, which it cannot merge. This is the
  crash-window victim: the hub accepted its commit, the group advanced, and the pending state
  died with the process — MLS *merges* a pending commit, it does not *process* one, so the
  peer can never apply the frame that is its own commit. Action: `recover()`.

  **The discriminator is authorship, not applicability.** "A valid frame at my current epoch
  that I cannot apply" — revision 8's wording — is not a description of this condition, it is
  a description of *every* frame a peer fails to apply, since the frame you are about to
  apply is always at your current epoch. It swallows the two rows beneath it: a
  policy-rejected commit (well-formed, deliberately refused) and a `MissingLedgerEntriesError`
  frame (well-formed, and *by definition* at the current epoch, since that is the only epoch
  whose frames a peer resolves). Left that way it is a **member-triggerable group-wide DoS**:
  the hub is blind and cannot judge a commit, so any member — including a removed one, who
  keeps `commitTopic` and its subscription forever — publishes one well-formed,
  policy-rejected commit at the current head, and *every* honest peer heals at once. A
  rendezvous, a sealed GroupInfo from every responder, an external commit, and CAS contention,
  from the whole group, repeatable at will.

  Both `readMessageEpoch` (the frame's epoch) and the committer's DID (`policy.ts`'s
  `didOfLeaf` over the commit's `senderLeafIndex`) are readable **without applying the
  frame**, and the committer is MLS-authenticated, so authorship cannot be forged. With
  authorship in the predicate the row stops overlapping its neighbours: someone else's
  policy-rejected commit is poison, a missing-bodies frame is a gather, and only the peer's
  own orphaned commit heals.

  This is the third heal path, and until now it was the one with no trigger. It trips
  *nothing* else: the completeness invariant passes (the peer never rejoined, so its ledger
  still matches its own `ledger_head` at epoch N), trim does not fire (the frames are all
  retained), and the fork trigger does not fire (it never applied a commit at epoch N, so it
  holds no conflicting per-epoch record). Without this row the frame falls through to
  *poison → advance*, every later frame classifies as *history → advance*, and the peer ends
  at `reconciledHead == head` believing it is fully reconciled — **stuck at epoch N forever,
  with a complete ledger and a clean bill of health.** A throw from `onAccepted` is the same
  failure with the peer alive to notice; a process death is the same failure with nobody left
  to remember.

- **Unrecoverable partition.** A hub that never shows a peer the other branch prevents
  convergence entirely. That is DoS, and out of scope.

### D2 — Recovery: seal GroupInfo to a requester-supplied ephemeral key, authorized by the roster

**Sealing to the requester's MLS leaf does not work, and the reason is instructive (G14).**
Revision 3 argued: "commits rotate only the committer's path, and a peer that lost a CAS
race never rotated at all", so the requester still holds the leaf private key the responder
can see. The first clause is true. The conclusion inverts for exactly the peers heal exists
to serve, because **the committer's path is whose path a commit rotates** — every Commit
carries an UpdatePath installing a fresh leaf HPKE key for its author (kumiai depends on
this: `envelope-fold` resolves the committer from "the commit's own UpdatePath leaf
credential"), and the new private key lives only in the derived post-commit state:

| Heal path | Committed? | Leaf key in the responder's tree | Can open a leaf-sealed reply |
|---|---|---|---|
| Trim strand (offline too long) | No | its old key, still held | **Yes** |
| Crash / `onAccepted` threw | Yes — the hub accepted it | its **new** key, installed by the commit every other member applied | **No** — that private key died with the unpersisted `newGroup` |
| Byzantine double-accept, losing branch | Yes — it merged its own | on the winner's branch, its **old** key, which its own merge rotated away | **No** — it holds only the new key, from a branch nobody else has |

Only the trim-strand peer — the one that was merely behind — could open its own rescue. The
two peers whose state is genuinely broken, and for whom `recover()` is the sole exit, could
not. D1 step 5 already half-knew this ("the pre-commit leaf key material is retained, which
the heal path needs"), but that reasoning covers the *discarded* commit; on the
*accepted-then-crashed* commit the tree moved and the key moved with it.

**So the reply is sealed to an ephemeral key the requester mints, and authorization stays on
the roster.** The requester generates an HPKE keypair per `recover()` call and puts the
public half in the rendezvous request, signed by its DID identity key. The responder:

1. verifies the request signature against the DID it names;
2. checks that DID has a leaf in the **current ratchet tree** — authorization remains
   intrinsic and roster-based, the property D2 refuses to give up: a removed member gets
   nothing, with no policy check a host could forget;
3. seals the framed `MLSMessage(GroupInfo)` to the **ephemeral** public key, AAD binding
   `groupID`, `requesterDID`, and `requestID` exactly as before.

This keeps every property the leaf-sealing argument was defending, and drops the one
assumption that fails. It also still answers the objection that killed DID-key sealing — a
stolen DID key would let an attacker *ask*, but the reply is sealed to an ephemeral public
key the attacker does not hold, so a stolen identity key alone buys nothing readable.

The request is now **signed**, which changes the replay analysis: a replayed request re-seals
GroupInfo to the same ephemeral key only its original minter can open, so replay buys
amplification and nothing else — bounded, as before, by responder jitter, storm-collapse
suppression, and the roster filter. A *forged* request now fails signature verification
outright, where previously it was merely useless.

**mls grows two primitives**, over the X25519 HPKE already in `mls/crypto.ts`:

```ts
sealGroupInfo({ group, requesterDID, requestID, recipientKey }): Promise<Uint8Array>
openSealedGroupInfo({ sealed, requesterDID, requestID, privateKey }): Promise<Uint8Array>
```

`sealGroupInfo` throws if `requesterDID` has no leaf in the current tree. `openSealedGroupInfo`
returns the framed `MLSMessage(GroupInfo)`, which feeds the existing `joinGroupExternal`
unchanged, and rejects anything whose AAD does not bind the caller's own DID and request.

**The `GroupMLS` port follows the ephemeral key**, and — because the heal path's external
commit is CAS'd (G10) — `applyRecovery` returns a `PendingCommit` rather than applying:

```ts
type GroupMLS = {
  // ...processCommit, exportRecoverySecret, getLedgerEntries unchanged
  /** Mint the ephemeral keypair + sign the rendezvous request. The private half is retained
   *  by the host, keyed by requestID, until applyRecovery consumes it. */
  createRecoveryRequest(requestID: string): Promise<Uint8Array>
  /** Verify signature, check the roster, seal to the request's ephemeral key. Returns null
   *  for a request whose DID has no leaf — the responder simply stays silent. */
  exportGroupInfo(request: Uint8Array): Promise<Uint8Array | null>
  /** Open with the retained ephemeral private key and build the external commit. Returns
   *  null for bytes it cannot open (hub-injected, or sealed to another request). The peer
   *  CASes the returned commit; the handle is adopted only in onAccepted. */
  applyRecovery(sealed: Uint8Array, requestID: string): Promise<PendingCommit | null>
}
```

`requestID` is still minted by the requester, per `recover()` call, and is still a
correlation id rather than an authorization token — the signature and the roster check carry
authorization now.

### D3 — Bodies: bundled with the commit, no host store

**No `GroupLedger` host port.** `GroupHandle` already exposes `ledgerTokens` — the signed
tokens, "the canonical persistent and wire form, the only thing that can be handed to
another party" — and the host already persists handle state. A body store would duplicate
what the handle holds. The host implements nothing.

**The commit frame carries the bodies.** The frame becomes `[commit bytes][wrapped body
blob]`, where the blob is the signed tokens the commit enacts, encrypted with
`GroupCrypto.wrap` under the **pre-commit** epoch secret. Every peer that can apply the
commit is at that epoch and holds that secret; the hub never sees a body.

This deletes the publish-bodies-before-the-commit ordering rule entirely. Body delivery is
atomic with the commit, so first-delivery stranding is impossible by construction rather
than merely retryable. A peer further behind cannot unwrap the blob — but it cannot apply
the commit either. It processes the log in sequence order, and each commit's blob is
unwrappable by the time that commit is the next one it can apply.

The MLS control envelope stays ids-only. This is the transport frame, not the AAD.

**Resolution and catch-up.** The peer supplies the resolver the host wires into
`GroupHandleParams.resolveLedgerEntries`. It serves from the bodies unwrapped from the
in-flight frame; on a miss — an external-commit rejoin, whose GroupInfo carries no ledger —
it gathers the missing ids from current members over the encrypted app lane. Serving a
gather needs one new `GroupMLS` method:

```ts
getLedgerEntries(ids: Array<string>): Promise<Array<string>>  // signed tokens, from handle.ledger
```

The requester re-verifies every returned token and checks each digest against the id it
asked for, so a lying responder can only fail to answer, never inject.

#### Ledger completeness is an invariant the peer can check alone (G16)

A handle's ledger is complete **exactly when** `computeHead(groupID, ids(handle.ledger))`
equals the `ledger_head` in its own GroupContext (`readLedgerHead`). That comparison needs no
peer, no network, and no memory of how the peer got into its current state. It is the
trigger for bootstrap — *not* `recover()`'s control flow:

- **Check it on restore, and before every lane operation.** Mismatch → the ledger is
  incomplete → bootstrap before doing anything else.
- **An incomplete ledger is a persistent, retryable, degraded state**, not a return value
  that can be dropped. A peer that cannot bootstrap must keep trying and must **not** report
  `advanced: true` and carry on as though healed.

This matters because bootstrap has an unavoidable window and no rollback. `recover()` adopts
the rejoined handle and only then can bootstrap: the gather rides the app lane, which
requires group membership, so a peer **cannot** bootstrap before rejoining. Between adoption
and a successful bootstrap it holds an internally inconsistent handle — an empty
`handle.ledger` against a real, non-genesis `ledger_head` — which is the roster reset G15
describes. The external commit is already in the log, so there is nothing to roll back, and
having rejoined, the peer no longer trips the trim-strand trigger that would have sent it
back. A crash in that window is the same state reached faster, and it **survives restart**:
the host persists the handle with an empty ledger, `restoreGroup` replays it, and the roster
resets again with nothing anywhere noticing.

The invariant makes that state self-detecting and self-healing, at startup or at any lane
operation, with no extra machinery.

#### Ledger bootstrap: a rejoined peer refolds its ledger, head-verified (G15)

A peer that rejoined by external commit has a GroupInfo, an MLS state — and an **empty
ledger**. That is not a neutral starting point, it is a **roster reset**: the roster folds
from the genesis anchor plus the applied entries, so with no entries the creator is admin
and nobody else is. Every admin promoted since is invisible to it, and `foldEnvelope` will
reject the next commit any of them authors — the rejoined peer does not merely lack history,
it **actively rejects the live group's commits and re-strands itself**. The host's
projections fold from the same ledger, so they come back empty too.

It also cannot use D3's gather to fix this, because **it does not know the ids to ask for**.
`resolveLedgerEntries(ids)` is the commit pre-pass's hook, called with ids read from an
incoming commit's envelope — it resolves entries some *new* commit enacts. Nothing
enumerates the group's *existing* ledger, and `ledger_head` is a chain digest, not a list.

So bootstrap is its own primitive, not a clause inside `recover()`:

1. **Gather the whole ordered ledger** — not "the missing ids". `GroupMLS` gains a full-log
   accessor beside the id-keyed one; the responder serves it from `handle.ledgerTokens`, "the
   canonical persistent and wire form, the only thing that can be handed to another party".
2. **Verify it against the authenticated head before applying a single entry.** Recompute
   with `computeHead(groupID, entryIDs)` over the gathered ids *in the order given* and
   compare against the `ledger_head` the peer's own GroupContext already carries
   (`readLedgerHead`). The head arrived inside the GroupInfo and is MLS-authenticated, so it
   is a trustworthy check against an untrusted responder.
3. **A responder that fails the head check is not asked again** — fall through to the next
   gather reply.

Signature verification alone does **not** cover this. A lying member can hand back a list of
genuinely-signed, correctly-scoped tokens with one demotion **omitted**: every token
verifies, every groupID matches, the fold runs, and the rejoiner's roster now contains an
admin the group demoted. Order and completeness are exactly what signatures do not protect
and what `ledger_head` does. This bound — **a lying responder can withhold, never rewrite** —
is the one D3 already claims for the id-keyed gather; bootstrap earns it the same way.

The primitives for this are already in `mls` and, today, wired only for the invite path:
`computeHead` and `assertHeadMatches` (whose `LedgerIncompleteError` doc comment names this
attack verbatim — "an inviter omitted, reordered, or truncated a ledger entry") are called
from `processWelcome` and nowhere else. Rejoin needs the same check.

```ts
type GroupMLS = {
  // ...
  /** True when computeHead(groupID, ids(handle.ledger)) matches the handle's own
   *  ledger_head. False means the ledger is incomplete and bootstrap must run. */
  isLedgerComplete(): Promise<boolean>
  /** The whole ordered ledger, as signed tokens — the bootstrap gather's reply. */
  getLedger(): Promise<Array<string>>
  /** Fold a gathered ledger after verifying its recomputed head against the authenticated
   *  one. Throws LedgerIncompleteError on mismatch; the peer then tries the next responder. */
  bootstrapLedger(tokens: Array<string>): Promise<void>
}
```

#### Re-enact by ledger membership, never by failure mode (G17)

After a heal, the peer re-enacts the entries it had in flight. Doing that unconditionally is
**silent data loss on the crash path**, because the three heal paths differ in whether the
peer's entries already reached the group's ledger:

| Heal path | Hub accepted its commit? | Entries in the group's ledger? | Re-enact? |
|---|---|---|---|
| Trim strand | never committed | nothing in flight | no-op |
| **Crash / `onAccepted` threw** | **yes — acceptance is what defines this path** | **yes — every other member pulled and applied it** | **must NOT** |
| Byzantine losing branch | only on a branch the group discarded | no | **must** |

The crash path is *defined* by the hub having accepted the commit — that is why the group
advanced without the committer — so its entries are already enacted everywhere. Re-enacting
appends them **again, at the end of the log**, and `mls` does not dedup: `applyLedgerEntries`
pushes every token, and `commitLedgerEntries` documents enacting "one whose content the log
already carries" as intentional, because re-appending is how a demotion back to a
previously-held role is expressed. So a re-enacted entry **wins the fold**:

> Admin A commits `circle.def X → name "Foo"`. The hub accepts; A crashes before adopting.
> Admin B commits `circle.def X → name "Bar"`. Everyone applies it. The circle is "Bar".
> A heals, rejoins, bootstraps, re-enacts "Foo". The ledger is `[Foo, Bar, Foo]`, the fold is
> last-write-wins by position, and **the circle is "Foo" again** — B's change reverted by a
> peer that crashed, with no error, no conflict, and no signal anywhere.

That generalizes to every last-write-wins reducer, which is all of kubun's.

**The rule is membership, not provenance:** *an entry is re-enacted if and only if the
group's authenticated ledger does not already contain it* — never because of which failure
brought the peer here. Bootstrap has already fetched the whole ordered, head-verified ledger
with its content ids, so this is one set-difference over ids, and the three heal paths stop
needing to be told apart at all.

**Cursor-advance rule.** Replaces revision 1's ack table, now that the commit lane is pulled
rather than delivered. For each frame processed from `commitTopic`:

**Classify by epoch first; unwrap only what you can apply (G11).** The blob is sealed under
the *pre-commit* epoch secret, so a peer walking history — the late joiner, the rejoiner,
the re-seeded peer, all of which the design now expects to do exactly this — reaches frames
whose blob it can never open, including the commit that added it. Unwrapping is therefore a
*consequence* of "I can apply this frame", never a precondition of reading it. A naive
implementation that unwraps before classifying sees ordinary history as a decryption
failure: the cursor still advances (both rows say advance), but the frame is logged as
poison, and that lie costs someone a day the first time they debug a real log.

| Frame | Cursor |
|---|---|
| Applied | advance; record this epoch → sequenceID for the D1 fork check |
| At an epoch this peer has no recorded applied-commit for (pre-join, pre-rejoin, re-seeded history) | advance, **no fork check, no unwrap attempt** — history, not a fork and not poison |
| At an epoch this peer *has* a record for, with a different sequenceID | advance; the fork trigger (D1) |
| **At the peer's current epoch, committed by *this peer*, unmergeable (pending state lost)** | **do not advance; heal trigger → `recover()`** (G18, narrowed by G19 — the predicate is authorship, *not* "cannot apply") |
| Malformed, or policy-rejected (`CommitRejectedError`) | advance (poison — never retry) |
| `MissingLedgerEntriesError` | **do not advance**; gather the missing ids, retry the frame (bounded); on exhaustion, advance and escalate to `recover()` |

**The rows are evaluated in the order written.** Epoch classification comes first (G11: no
unwrap before it), the un-merged own-commit row comes before the poison row (G18: otherwise a
crash victim's own commit is filed as malformed and the peer walks cheerfully to
`reconciledHead == head`), and poison is the last resort, never the fallback for "I could not
apply this".

**After a real crash, `inFlight` is empty** — the `PendingCommit` lived in memory. That is
correct and needs no machinery, because G17's membership filter would empty the re-enact list
anyway: on the crash path the entries are already in the group's authenticated ledger. The
restarted peer heals, bootstraps, re-enacts nothing, and is whole. The two fixes compose, and
a reader wondering how a restarted peer re-enacts entries it can no longer name has the
answer: it must not, and it does not need to.

`MissingLedgerEntriesError` remains the one retryable outcome, and D3 makes it the rare one.
This also repairs today's bug in `peer.ts`, whose bare `catch` never acks, so *any*
permanently-failing commit is redelivered forever.

## Component boundaries

| Component | Owns | Does not |
|---|---|---|
| `hub-protocol` | *Defines* conditional publish, `fetchTopic`, `HeadMismatchError`, the atomicity requirement, the conformance suite | Implement storage |
| `HubStore` implementations (`hub-server` memory store; each host's DB store) | *Provide* the per-topic head, the atomic CAS, the readable log | Read payloads; know what a commit is |
| `mls` | Group state, authority, `ledger_head`, ledger tokens, GroupInfo sealing/opening, the recovery request's ephemeral key and signature | Transport; ordering across peers |
| `rpc` (`GroupPeer`) | The serialized per-group lane (replay, pull, `commit`, `recover` — never nested), the CAS loops, retry/rebase, the pull cursor, body framing, the resolver, gather, fork detection, heal triggers | MLS state; entry semantics; **constructing commits — only the host does that, via `build()`. Heal and replay hand recoverable work back; they never commit on the host's behalf (G26)** |
| Host | Persist handle state; author entries; app reducers; migrate its `HubStore` | Ordering, authority, integrity, body distribution, body storage |

## Host-side impact

Named so the work is sized honestly. These are the host's to absorb.

- **Every host with a hub rebuilds the storage model of its `HubStore`.** This is the
  largest item in the design, and it is not a column or two. Today retention is a function
  of delivery: a publish with no subscribers stores nothing, and the last ack deletes the
  row. The store must instead **retain messages per topic independently of delivery**, with
  `trim` as the only thing that removes an entry; delivery rows become a push-wakeup
  optimization, and `ack` stops deleting messages — as does `unsubscribe`. On top of that: a
  per-topic head, a unique `publishID`, a topic-log read path, sequenceIDs that are lexicographically
  ordered and **minted by the database inside the CAS transaction** rather than by an
  in-process counter (kubun's current counter collides across two hub processes on one
  database — survivable for a mailbox, fatal for a head). A host that reads this as "add a
  head column" will under-scope it by a wide margin.
- **Removing `localCommitted` inverts the host's commit path.** A host that applies the
  commit and adopts `newGroup` up front (kubun's `withHandleReplacing`) must instead build
  without adopting and adopt only inside `onAccepted`. Because `build()` re-runs on every
  retry, an invite re-mints both the Commit *and* the Welcome each time. This is a rewrite
  of the host's commit paths, not a call-site swap.
- **A commit lost to a restart is handed back, not swallowed — and the host re-commits it.**
  When replay's republish loses the CAS, the lane operation **returns** `lost`: for a `ledger`
  commit it carries the surviving signed tokens, which the host re-issues via an ordinary
  `commit()`; for an `invite` or `remove` it carries a failure notice, because `build()` was a
  closure and the process that held it is gone. It is a return value and not a callback for a
  concrete reason (G27): the host's response is to call `commit()`, and a callback fired at
  step 0 runs **inside the lane mutex**, so the obvious handler would deadlock. **The peer
  never commits on the host's behalf** — the same rule that governs heal's `reenact`. A dropped
  removal is the case to design for: the admin believes the member is evicted and they are not.
- **`onAccepted` must be idempotent.** Replay is at-least-once: a crash between `onAccepted()`
  and `clear()`, or partway through `onAccepted()` itself, re-runs it. Adopting the journalled
  handle twice is harmless; **delivering the Welcome twice is not**, so the host must make
  Welcome delivery a no-op on repeat. The journal makes a commit *look* atomic, which is
  exactly why this has to be said out loud.
- **The host provides a durable single-slot commit journal (`CommitJournal`) and serializes
  its pending handle into it.** Written before every publish, replayed before every lane
  operation, cleared on acceptance or rejection. The blob is host-opaque — the serialized
  post-commit handle plus any Welcome — and the host already has both a database and handle
  serialization, which the peer does not. This is required, not optional (G21): without it a
  crash in the acceptance window bricks a single-member group permanently, because heal needs
  a responder and there is none. It also makes Welcome delivery durable across acceptance, so
  the orphan-leaf outcome (a member added to the tree who never received keys, repaired by an
  admin remove + re-invite) is no longer the expected result of a crash — it is what happens
  only if the journal itself is lost.

## Accepted exposure: a removed member keeps `commitTopic`

`commitTopic` is non-rotating and derived from `exportRecoverySecret()`, which a removed
member knows permanently, and `fetchTopic` authorizes on subscription. Under mailbox
semantics such a member could only ever receive what was published while it was subscribed;
under a retained log it can re-pull the topic's whole retained history at any time.

**No confidentiality delta.** Post-removal frames carry bodies wrapped under epoch secrets
it cannot derive, and the commits themselves are MLS-authenticated; pre-removal frames it
already had. What it gains is **durable metadata** — commit cadence, frame sizes, group
liveness — and a free hub-resource drain.

Revoking the subscription on removal is the obvious mitigation and is *not* available
cheaply: the hub is blind to the roster by design, so it cannot know a removal happened, and
rotating `commitTopic` on removal would break the one property the topic exists for — that a
peer stranded on any epoch can still find the rendezvous. Accepted and named; revisit only
if metadata exposure to ex-members becomes a stated requirement.

**The write side, which matters more (G20).** The analysis above is about what an ex-member
can *read*. D1 makes `commitTopic` the group's **serialization point**, and the hub authorizes
publishes without knowing the roster — so what a member can *write* to it is a new capability,
handed to members rather than to the hub. Under the old mailbox semantics a garbage commit was
a message honest peers ignored. Now an ex-member's publish:

- **advances the head**, which every honest committer must then CAS against;
- forces every peer to fetch, parse, classify and drop the frame.

So an ex-member can inject noise into the serialization lane indefinitely, costing every
honest commit an extra CAS round and every peer a wasted pull. DoS-class, consistent with the
posture the design already takes ("the hub can already drop, delay, reorder and partition"),
and **accepted** — recorded here so the write side is not rediscovered later as a surprise.

This is also what made G19 dangerous rather than merely wrong: a predicate that heals on any
unapplicable frame turns this write capability into a group-wide recovery storm. The general
lesson holds for anything added to this lane — **a frame from an untrusted member must never
be able to make an honest peer do expensive work**, and the only lever that would bound the
write side is the same one rejected for the read side (rotating the topic on removal).

## Deferred

*(The pending-commit journal was deferred in revisions 2–8 and is now **required** — see
"Restart replay". G21 showed it is the only exit for a crash in a single-member group, which
heal cannot reach for want of a responder.)*
- **Full-device-loss recovery** (no MLS state at all). Such a member is re-invited.
- **Hub-partition DoS.** Out of scope.

## Non-goals

- No change to the authority model, the roster, `ledger_head`, or the commit policy.
- Host reducers (`circle.def`, `circle.member`, `group.settings`) stay in the host. kumiai
  orders and authorizes entries; it never interprets them.
- Nothing here needs the `app` slot of `ControlEnvelope`.

## Testing

- **`HubStore` conformance suite**, run against the memory store and **exported from
  `hub-protocol` for hosts to run against their own store** — it is the contract, and every
  clause below exists because a plausible implementation gets it wrong:
  - **The log is real: publish to a topic with zero subscribers, then subscribe and pull
    the frame.** The single test that proves retention is not a function of delivery. Every
    store passes today's tests and fails this one.
  - **Ack does not delete:** subscriber acks a frame, then pulls it again via `fetchTopic`.
  - **Trim is the only deleter:** `head` survives a `trim` while `oldest` moves. Asserted
    through the `trim` primitive, so it holds for every host whatever depth-or-age policy
    it layers on top. Nothing else deletes a log entry — not `ack`, and not `unsubscribe`
    (today's memory store drops a topic's whole index when its last subscriber leaves; under
    this contract that is a deletion trim did not authorize).
  - **Ordering:** sequenceIDs sort lexicographically across a 9→10 boundary. A store minting
    unpadded decimals passes the type and fails here.
  - **CAS:** two publishes at the same head — one accepted, one `HeadMismatchError`, nothing
    stored for the loser; the empty-topic sentinel (`null`); a replayed `publishID` returns
    the original sequenceID and appends nothing.
  - **The dedup record outlives the log (G24): publish with a `publishID`, trim the log, then
    republish the same `publishID` — the original sequenceID comes back and nothing is
    appended.** A store that hangs the key off the message row passes every other test here
    and fails this one, exactly as a delivery-derived store passes everything and fails the
    zero-subscriber test. These two are the suite's load-bearing tests.
  - **Concurrent CAS under real parallelism:** N racing publishes at the same head yield
    exactly one accepted append. This must run against a real database over **separate
    connections** — not N `await`s on one connection, which the obvious in-memory version
    does and which a non-transactional, process-counter store passes while being broken.
  - **`fetchTopic` refuses a non-subscriber with `NotSubscribedError`** — the named type, not
    merely "it throws". A clause that accepts any throw is satisfied by a host's
    not-implemented stub, which is how a store passes the contract while having no read path
    at all. The clause also asserts the positive case in the same test: a subscriber *can*
    read, so a store that throws for everyone still fails.
  - **A trimmed entry leaves no pending delivery behind.** A host without a foreign key leaks
    delivery rows pointing at frames that no longer exist, and nothing else in the system
    notices.
  - **The two retention classes:** a `mailbox` frame is gone once every delivery is acked; a
    `log` frame published in the same way, to the same topic, with the same acks, **is still
    there**. This is the pair that proves the class is honoured rather than ignored — a store
    that treats `retain` as a no-op passes every other clause.
  - **Retention duration:** a subscribe above the hub's maximum raises `RetentionExceededError`
    rather than silently clamping; a topic's frames survive as long as the *longest* retention
    any of its subscribers asked for.
  - **`head` ignores a mailbox publish (G29):** publish a log frame, then a mailbox frame to the
    same topic, and `head` still names the log frame. A store that advances the head on every
    publish passes every other clause and hands the commit lane a head that its own ack can
    delete.
- **Concurrent commits.** Two admins commit at epoch N against one hub: one wins, the loser
  rebases and its entries land in a later commit. No fork, no lost entries.
- **Same-device concurrency.** Two concurrent `peer.commit` calls serialize; both commits
  land; neither builds against a superseded handle.
- **Late joiner.** A member is invited, two further commits land before it subscribes, and it
  converges by pulling the log — with no `recover()` and **no fork diagnosis**, walking
  frames from epochs it never held (the G5 regression test).
- **The lane does not outrun the mailbox (G28).** A peer is offline while the group makes ten
  commits *and* sends an app message at an early epoch. On reconnect it reads the message.
  With `retainKeysForEpochs` at its default of 4 this fails unless replay interleaves, and it
  fails **silently** — the peer converges, the roster matches, nothing throws, and the message
  is simply undecryptable. Assert the plaintext, never the absence of an error.
- **`onAccepted` throws.** The commit is in the log, the host failed to adopt: `commit()`
  surfaces the failure, does not retry the commit, and the peer heals by rejoin.
- **First-delivery resolution.** Three-member group, an admin enacts an entry, the third
  member has never seen the body: it applies the commit on first delivery, no gather.
- **Offline catch-up.** A member offline across several enacting commits reconnects and
  converges, with no host-side backfill code.
- **Trim strand.** The intervening commits are trimmed; the peer detects it in one
  observation (`head > reconciledHead`, `oldest` past the cursor) and heals.
- **Heal loses the CAS.** A commit lands between the rejoining peer's GroupInfo request and
  its external-commit publish: the peer takes `HeadMismatchError`, **discards the GroupInfo**
  (not just the commit), re-requests, rebuilds, and converges. The regression test for G10 —
  a peer that merely retried the same external commit against a changed tree would wedge.
- **Two peers heal concurrently.** Both hold GroupInfo at the same epoch; one wins, the other
  re-requests and converges. Both end up in the roster, and neither loses its entries.
- **Heal re-enacts.** After a rejoin, the peer's discarded entries land via an ordinary
  `commit()` — a second commit, which itself contends normally.
- **History is not poison.** A late joiner pulling from `oldest` walks frames whose body blob
  it cannot unwrap (including its own add-commit) and classifies none of them as malformed
  (the G11 regression test).
- **Sealing.** A reply opens for the requester and fails to open for every other member and
  for the hub. A reply replayed at another member or another request is rejected by the AAD
  check. A removed member's request is refused (no leaf in the current tree). A request with
  a bad signature is refused. **A peer whose own commit was accepted and then lost (the crash
  path) recovers** — the G14 regression test, which a leaf-sealed design fails: it holds no
  private key matching the leaf the responder can see.
- **Heal never nests.** A heal triggered while `commit()` is pulling does not deadlock: the
  trigger records, `commit()` unwinds and releases the lane, `recover()` runs as its own
  operation, and the re-enactment is a later `commit()` (the G13 regression test).
- **Nothing the peer hands back is delivered under the lock (G27).** A host that responds to
  *any* lane result — `lost`, `reenact` — by immediately calling `commit()` completes, and does
  not deadlock. Written as a test the obvious host handler would fail if the peer ever moved
  either one back into a callback.
- **Ledger bootstrap.** A rejoined peer refolds the full ledger and its roster matches the
  live group's — in particular it **accepts the next commit from an admin promoted after
  genesis**, which a peer with an empty ledger would reject (the G15 liveness regression
  test).
- **Bootstrap rejects a doctored ledger.** A responder returns a genuinely-signed,
  correctly-scoped ledger with one demotion omitted: the recomputed head does not match the
  GroupInfo's authenticated `ledger_head`, `LedgerIncompleteError` is thrown, that responder
  is skipped, and the peer folds an honest reply instead. The demoted admin does **not**
  reappear in the rejoiner's roster (the G15 security regression test).
- **A hostile commit does not trigger heal (G19).** A removed member publishes a well-formed,
  policy-rejected commit at the current head. Every honest peer drops it as poison and
  **nobody heals** — the security regression test for the narrowed predicate, which an
  applicability-based trigger fails by sending the entire group into recovery at once.
  Likewise: a frame that throws `MissingLedgerEntriesError` gathers, and does not heal.
- **A crash in the acceptance window is repaired from the journal, with no peer.** The
  committer is killed after the hub accepts and before it adopts, then restarted. Replay
  republishes by `publishID`, the store returns the original sequenceID without appending,
  and the peer adopts the journalled handle and sends the journalled Welcome. Assert the
  peer's epoch **advanced** — an implementation that merely raises no error leaves it stuck.
- **A single-member group survives a crash on its first commit (G21).** The creator's
  `commitInvite` is accepted, the process dies before `onAccepted`, and there is no other
  member in existence to answer a rendezvous. It recovers from the journal alone, the invitee
  receives the Welcome, and the group is alive. Without the journal this group is bricked
  forever — the test that no amount of heal machinery can pass.
- **…and survives it across the trim window (G24).** Same scenario, but the log is trimmed
  before the peer restarts. Replay still returns the original sequenceID, the peer still
  adopts and still sends the Welcome. A store that trims its dedup records with its log bricks
  this group, and does so silently — in a multi-member group the same bug is masked by
  `recover()` finding a responder.
- **Replay loses the CAS: entries survive, proposals are reported (G25, G26).** The peer
  journals a commit, dies before publishing succeeds, and another admin commits meanwhile. On
  restart the republish takes `HeadMismatchError` and the peer fires `onCommitLost`: for a
  `ledger` commit the host receives the tokens and re-issues them (assert they are in the
  group's ledger after the host's `commit()` — **and that the peer did not commit them by
  itself**), and for a journalled `remove` the host receives a failure notice (assert the host
  is told, and assert the member is still in the roster, because the silent-success version of
  this bug leaves an admin believing an eviction happened).
- **Replay runs `onAccepted` twice.** The peer is killed between `onAccepted()` and
  `clear(publishID)`. On restart the entry replays: the handle is adopted again (harmless) and
  the Welcome is delivered again — and the invitee, already joined, no-ops it rather than
  erroring or building a duplicate group (the G22 regression test).
- **A crash inside `recover()`'s acceptance window converges.** The peer is killed after its
  external commit is accepted and before it adopts. On restart its orphan commit classifies as
  history (authorship matches, epoch does not — the G18 trigger stays quiet), the original heal
  condition re-fires, a fresh rejoin lands, and `resync: true` collects the orphaned leaf. The
  peer ends whole with exactly one leaf (the G23 regression test).
- **The journal is lost or absent → the G18 trigger still fires.** The peer detects its own
  un-merged commit and heals via a responder (the multi-member fallback), rather than walking
  to `reconciledHead == head` with a clean bill of health.
- **A crash mid-bootstrap self-heals.** The peer is killed between adopting the rejoined
  handle and completing bootstrap, and restarted: the completeness invariant fails on
  restore, bootstrap runs, and the roster is whole — with no memory of how it got there (the
  G16 regression test). A peer that cannot bootstrap stays degraded and retrying, and never
  reports itself healed.
- **Heal does not revert a later admin's change.** Admin A's commit is accepted, A crashes
  before adopting; admin B overwrites the same subject; A heals. A's entry is **not**
  re-enacted (bootstrap's ledger already contains its id), and B's value stands. The G17
  regression test — an unfiltered re-enactment silently reverts B with no error anywhere.
- **Cursor-advance.** A commit with unresolvable bodies is retried without advancing; a
  malformed commit advances the cursor once and is never retried.
- **Fork heal.** A simulated lying hub double-accepts; the lower-sequenceID branch wins, the
  loser rejoins by external commit, and its entries are re-enacted.

## Acceptance

- A host writes no ordering, no authority, no integrity, and no body-distribution code — and
  no body store. Its only new obligation is the `HubStore` migration.
- Two admins enacting entries concurrently converge against an honest hub, with no permanent
  fork and no lost entries.
- Two concurrent commits on the same device both land.
- A member invited while commits are in flight converges by pulling the log, without
  recovery.
- A third member who has never seen an entry body applies the enacting commit on first
  delivery.
- `GroupMLS.exportGroupInfo` is implementable by a host without leaking group state to the
  relay.
- A permanently-failing commit is dropped once and never retried forever.
- A peer that must heal converges even under commit pressure: its external commit is CAS'd,
  and losing the race costs it a re-request, not a wedge.
- A member offline for the trim window's duration resumes by pulling, not by healing.
