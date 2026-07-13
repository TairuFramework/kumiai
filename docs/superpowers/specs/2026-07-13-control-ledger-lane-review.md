# Review: the control-ledger lane design

**Reviewer:** kubun (the host driving the requirements in `2026-07-13-host-ledger-lane.md`).
**Subject:** `2026-07-13-control-ledger-lane-design.md`.

Four review passes. **The newest pass is at the top; earlier passes are kept below as the record.**

---

# Revision 4 review

**Verdict:** G10–G12 are folded in, and the `recover()` CAS loop is the right shape — "heal is two commits, not one" (the external commit carries no envelope, so the entries ride a *subsequent* `commit()` that contends normally) is a distinction I had not drawn, and it is correct.

Two findings. **G14 is the most serious defect found in any pass**: D2's sealing target is unavailable to two of the three peers the heal path exists to serve. It is not a gap in the writing — the design is internally consistent and still wrong, because it rests on an MLS property that does not hold for a peer that has committed.

## G14 — The heal path's victims cannot open the recovery reply sealed to them

**Blocking.** D2 justifies sealing GroupInfo to the requester's MLS leaf with:

> "That population is precisely the one that still holds its **leaf HPKE private key** — commits rotate only the committer's path, and a peer that lost a CAS race never rotated at all."

The first clause is right; the conclusion does not follow, because **the committer's path is exactly whose path a commit rotates — and two of the three heal paths are walked by peers that committed.**

An MLS Commit carrying an UpdatePath installs a *fresh leaf HPKE key* for the committer. The new private key lives in the derived post-commit state — kumiai's `newGroup` — and the old one is gone from the merged state. Now walk the design's own three heal paths:

| Heal path | Did this peer commit? | Whose leaf key is in the responder's tree? | Can it open the seal? |
|---|---|---|---|
| **Trim strand** (offline too long) | No | its old leaf key, which it still holds | **Yes** |
| **Crash / `onAccepted` throws** | Yes — the hub *accepted* it | its **new** leaf key, installed by the commit every other member applied | **No** — the new private key was in the `newGroup` it failed to persist |
| **Byzantine double-accept, losing branch** | Yes — it applied its own commit | on the winner's branch, its **old** leaf key — which its own merge rotated away | **No** — it holds only the new key, from a branch nobody else has |

So the trim-strand peer — the one case that could arguably have limped along without recovery, since it merely fell behind — is the *only* one that can open a sealed GroupInfo. The two peers whose state is genuinely broken, and for whom `recover()` is the sole exit, are precisely the two that cannot decrypt the reply. Heal is unreachable for the peers that need it.

Note this is not hypothetical for the crash path: D1 step 5 is careful that on `HeadMismatchError` "the pre-commit leaf key material is retained, which the heal path needs" — the design already knows leaf key material is at stake. But that reasoning covers only the *rejected* commit. On the *accepted-then-crashed* commit, the tree moved and the key that moved with it was never persisted. The property the design relies on holds for the discard case and inverts for the crash case.

**Recommended fix: seal to a requester-supplied ephemeral key, authorized by roster membership.** The requester mints an ephemeral HPKE keypair per `recover()` call and sends the public half in the rendezvous request, signed by its DID identity key. The responder:

1. verifies the request signature against the named DID;
2. checks that DID has a leaf in the current ratchet tree — **authorization is still intrinsic and still roster-based**, which is the property D2 correctly refuses to give up;
3. seals the GroupInfo to the *ephemeral* public key, with the AAD binding `groupID`, `requesterDID`, and `requestID` exactly as now.

This keeps every property D2 argues for — a removed member gets nothing, no policy check a host can forget, replay-bound AAD — while removing the one assumption that fails: that the requester still holds the private key matching the leaf the responder can see. It also sidesteps D2's stated objection to DID-key sealing (that a stolen DID key alone would suffice to pull group state): the DID key here *authenticates* the request, and confidentiality rests on the ephemeral key the requester just generated, so a stolen DID key buys an attacker a seal to a public key it does not hold.

If sealing to the leaf is kept for the trim-strand case, the design must say explicitly that the other two paths are unrecoverable — which would mean a crash in `commit()`'s acceptance window permanently strands a member, and the "Deferred: closing the crash window" item becomes load-bearing rather than an optimization.

## G13 — `recover()` and `commit()` contend for the same per-group mutex, and `recover()` calls `commit()`

`commit()` holds the per-group mutex for its whole run (G3), and inside it, step 1 pulls the log and *processes* frames. Processing a frame is what fires the heal triggers: a trim strand, or a byzantine fork. So `recover()` is reachable from inside the mutex.

`recover()` in turn mutates the handle (it adopts the rejoined state) and, on success, "re-enacts any discarded entries via the ordinary `commit()` loop" — which takes the mutex again.

Both ways round are broken:

- If `recover()` **takes** the mutex, a heal triggered from inside `commit()`'s pull deadlocks on a non-reentrant mutex, and its own tail call into `commit()` deadlocks a second time.
- If `recover()` **does not** take the mutex, a concurrent `commit()` on another caller can build against the pre-rejoin handle while `recover()` is swapping it out — the exact hazard the mutex exists to prevent, on the path where the handle is least stable.

The design needs an explicit concurrency story here. The shape that likely works: the heal *trigger* fired during a pull records the condition and returns, letting the pull and the enclosing `commit()` unwind and release the mutex; `recover()` then runs as a separate mutex-holding operation, and its re-enactment is a *subsequent* `commit()` after it releases — consistent with "heal is two commits, not one", which the design already establishes. Whatever the choice, say which lock `recover()` holds and where it releases it, because the current text has it running both inside and around `commit()`.

## What matches, revision 4

`recover()` as its own CAS loop, with the discard-the-GroupInfo-too rule and its regression test, is exactly what G10 asked for. "Heal is two commits, not one" is a better decomposition than the one I suggested. The trim window as a group-liveness parameter with a 90-day default, and the explicit note that shortening it silently converts the late-joiner fix back into a recovery path, closes G12. G11's "classify by epoch first; unwrap only what you can apply" is right, including the observation that the lie costs a debugging day rather than correctness. The removed-member exposure section correctly reasons that no confidentiality delta exists and names the metadata delta anyway.

---

# Revision 3 review (folded in — kept as the record)

**Verdict:** G1–G9 are all folded in, and folded in *correctly* — the G5 fix is the one I'd have written (the per-epoch sequenceID record was already in the design; the trigger just had to use it), and the G7 rewrite of the host-impact section now states the storage-model change at its real size. The conformance suite's "publish to a topic with zero subscribers, then subscribe and pull the frame" is the right single test.

Three findings. **G10 is structural**: it is the one path in the design that has no publish story, and three separate failure paths all terminate in it.

## G10 — The heal path's external commit has no defined publish path

**Blocking.** Every recovery route in the design ends in the same sentence: *"the loser rejoins by external commit onto the winner's branch and re-enacts its entries."* Three distinct paths reach it —

- trim strand (`oldest` past the cursor),
- byzantine double-accept (the losing branch),
- `onAccepted` throwing, or the crash window (the committer cannot apply even its own commit),

— and **none of them says how that external commit reaches the hub.** `joinGroupExternal` produces a Commit that changes the ratchet tree; every other member must apply it, so it must land on `commitTopic`. That leaves the questions D1 was built to answer, unanswered for the one lane that most needs them:

1. **Is the external commit CAS'd?** It must be. Publishing it unconditionally re-opens exactly the fork D1 closes — and does so on the path where the group is *already* fragile.
2. **What is its `expectedHead`?** The rejoining peer seeds `reconciledHead` from `fetchTopic` (G1's mechanism), so it has one. Say so explicitly.
3. **What happens when the external commit loses the CAS?** This is not an edge case — it is the *likely* case, because heal runs precisely when the group is under commit pressure. And unlike a normal `HeadMismatchError`, the peer cannot just call `build()` again: its GroupInfo is now **stale**, describing a ratchet tree the winning commit has already changed. It must re-request recovery, get a fresh GroupInfo, and rebuild the external commit. The retry loop is a different shape from `commit()`'s, and the design never draws it.
4. **What if two peers heal concurrently?** Both hold GroupInfo at the same epoch, both build an external commit, one wins. The loser needs the same re-request loop. With a trim window shorter than a mobile peer's offline period (see G12) this is routine, not exotic.

Recommend `recover()` own an explicit loop of the same shape as `commit()`: pull to the end, request GroupInfo, build the external commit, CAS it at `reconciledHead`, and on `HeadMismatchError` discard the GroupInfo and start over from the pull — with the same deadline discipline `commit()` now has.

## G12 — Trim policy silently decides how often heal runs

The design says trim exists ("by depth and age"), that it is the only deleter, and that it moves `oldest`. It never says what the window is, and it never connects the window to the trim-strand heal path — but that connection is the whole operational story:

> **A peer offline longer than the trim window comes back trimmed-out, and every such peer runs the heal path.**

Kubun's peers are phones. Offline for a week is ordinary, not exceptional. If the trim window is tuned like a message-queue backlog (hours, or a few thousand messages), then a returning phone does not resume by pulling the log — it triggers `recover()`, which triggers a rendezvous, which triggers an external commit, which (G10) contends on the CAS. The mechanism designed as the rare fallback becomes the common path for the most common client.

Two things to state:

- **The trim window is a group-liveness parameter, not a storage parameter.** It should be set from "how long may a member be offline and still resume by pull", and the default should be generous (weeks, not hours). Storage is cheap; recovery storms are not.
- **Retention is now unconditional** — a frame is kept whether or not anyone has read it (that is the point of G7). So the log grows with commit volume, and D1 *raises* commit volume by an order of magnitude. The design should say what bounds it, because "trim by depth" with a small depth silently converts the late-joiner fix back into a recovery path.

## G11 — The cursor table has no row for "cannot unwrap the body blob"

D3 wraps the body blob under the **pre-commit** epoch secret. A peer walking the log through history — the late joiner, the rejoiner, the re-seeded peer, all now explicitly expected to do this — reaches frames whose blob it cannot unwrap, because it never held that epoch's secret. Its own add-commit is one of them.

The cursor table classifies frames by *epoch record*, which correctly routes those frames to "advance, no fork check". But a naive implementation unwraps the blob *before* classifying, and a failed unwrap looks like a malformed frame. Both rows say "advance", so the cursor still moves — but a frame that is ordinary history gets logged as poison, and the distinction matters the moment anyone debugs a real log.

Make it explicit: **the body blob is unwrapped only for a frame the peer can actually apply.** Classification by epoch comes first; unwrap is a consequence of "I can apply this", never a precondition of reading the frame.

## Noted, not blocking

- **A removed member keeps `commitTopic` forever.** The topic is non-rotating and derived from `exportRecoverySecret()`, which a removed member knows permanently, and `fetchTopic` authorizes on subscription. Under mailbox semantics it could only receive what was published while it was subscribed; under a retained log it can re-pull the topic's whole retained history at any time. No confidentiality delta — post-removal frames are wrapped under epoch secrets it cannot derive, and pre-removal frames it already had — but it does gain durable metadata (commit cadence, frame sizes) and a free hub-resource drain. Worth one line acknowledging it, and worth asking whether removal should revoke the subscription.

## What matches, revision 3

The G5 fix is exactly right, including the explicit "no record for that epoch → not a fork, just history" and the late-joiner regression test. The deadline-not-attempt-count retry bound is the right call. The G7 host-impact rewrite now says the true size of the storage change, and the conformance suite's zero-subscriber test is the one that proves it. `requestID`'s threat analysis (a replayed request only causes another seal to a leaf nobody else can open) is sound. `onAccepted`-throws is now specified — and G10 is, in a sense, the missing second half of that specification.

---

# Revision 2 review (folded in — kept as the record)

**Verdict:** G1–G4 are correctly folded in, and the design found something the revision-1 review missed — problem 4, the commit lane being a mailbox rather than a log. That find is right. But it is *bigger than the design accounts for*: closing it is not a `HubStore` field addition, it is a change to what a `HubStore` fundamentally is. G7 blocks; G6 is a correctness bug in the CAS itself.

## G7 — The topic log does not exist, and `HubStore` cannot currently hold one

**Blocking.** D1 rests on `fetchTopic` reading a retained, per-topic, ordered log with an `oldest` watermark and a trim policy. No `HubStore` has one. `HubStore` is a per-*recipient* mailbox that happens to be keyed by topic:

- **Publish fans out to delivery rows at publish time**, snapshotting the topic's subscribers. This is problem 4's root cause, correctly identified.
- **A publish with no recipients stores nothing at all.** From kubun's store: `if (recipients.length === 0) { return sequenceID }` — the sequence is consumed, no message row is written. So the first commit into a group whose only other member has not yet subscribed *does not exist* afterwards. Under D1 the head would advance past a frame no peer can ever pull. The lane is silently, permanently broken, and no test that keeps two peers online will catch it.
- **`ack` deletes.** Retention today is a function of delivery, not of the topic. `oldest` and trim-by-depth/age have nothing to attach to.

So the host migration is not "add a head column and a `publishID`". It is: **retain messages per topic independently of delivery**, decouple retention from ack, and add trim. Deliveries become an optimization for push-wakeup, not the system of record. That is the real shape of the work, and it should be stated in the design — a host reading the current "Host-side impact" bullet will under-scope it by a wide margin.

Recommend the design say plainly: `HubStore` gains a *log* alongside its mailbox. `fetchTopic` reads the log. Trim governs the log. Delivery rows govern push only. And the conformance suite must include **"publish to a topic with zero subscribers, then subscribe and pull the frame"** — the single test that proves the log is real.

## G6 — `sequenceID` has no defined total order, and cannot be minted where it is

**Blocking-adjacent — it is a correctness bug in the CAS, not a documentation gap.** The design compares sequenceIDs in four places: `expectedHead` equality, `head > reconciledHead`, `oldest` past the cursor, `after` as an exclusive cursor, and the byzantine tiebreak's "lower sequenceID wins". `sequenceID` is typed `string`, and its ordering is never specified.

Kubun's store makes it work only by accident: `String(counter).padStart(12, '0')`, so lexicographic order coincides with numeric order. A host that mints `String(counter)` unpadded, or a UUID, satisfies the type and silently breaks every comparison above — `"10" < "9"` lexicographically. The contract must require sequenceIDs to be **lexicographically ordered, per topic, strictly increasing**, and the conformance suite must assert it across a 9→10 boundary.

Worse, kubun mints the sequence from an **in-process counter** (`sequenceCounter++`, lazily seeded from `max(sequence_id)`), not from the database. Two hub processes against one database mint colliding sequenceIDs today. That is survivable for a mailbox; it is fatal for a CAS head, because the head *is* a sequenceID. D1 therefore requires that the sequenceID be minted **inside the same transaction as the CAS**, by the database, not by the process. This belongs in the contract's atomicity clause: "the head comparison, the sequence mint, the append, and the head advance are one transaction."

The "N racing publishes yield exactly one accepted append" test only catches this if it runs against a real database with real parallelism — two connections, not two `await`s on one connection. Worth saying so in the test description, because the obvious in-memory version of that test passes on a broken store.

## G5 — The byzantine fork trigger misfires on any peer that pulls history

The trigger is "a *valid* commit framed at an epoch the peer has already passed". Three peers legitimately encounter exactly that with no byzantine hub in sight:

- the late joiner from problem 4's fix, pulling the log from `oldest` and walking frames from **before it was invited**;
- a peer that rejoined by external commit, whose log predates its new leaf;
- a peer that was trimmed and re-seeded.

None of them has "passed" those epochs — they never held them. But the frames are valid, and they are framed at epochs below the peer's current one, which is what the trigger tests. A late joiner would diagnose a fork on its very first pull and escalate to `recover()` — turning problem 4's fix into a recovery storm.

The design already carries the discriminator, one paragraph later: the peer "retains, per applied epoch, the sequenceID of the commit it applied there." Tighten the trigger to use it: **a fork is a valid commit at an epoch for which this peer holds a recorded applied-commit sequenceID, whose sequenceID differs from the recorded one.** No record for that epoch → not a fork, just history. Skip and advance the cursor.

That also gives the cursor table its missing row: *frame at an epoch the peer has no state for (pre-join, pre-rejoin) → advance, no fork check.*

## G8 — `onAccepted` throwing is the crash window, and is unspecified

The design handles a *crash* between CAS acceptance and `onAccepted`. It does not say what happens when `onAccepted` simply **throws** — a host DB write fails, a Welcome send fails. The group has advanced; the host has not adopted. This is the same state as the crash, reached by a much more likely route, and it should be named as such: treat a throw from `onAccepted` identically — the peer heals by external-commit rejoin and re-enacts its entries. Otherwise a host will reasonably assume `commit()` is atomic and let the exception propagate to the app with the group already advanced underneath it.

## G9 — Problem 4 is a class, and only the commit lane is fixed

Publish snapshotting recipients at publish time strands late subscribers on **every** lane, not just commits. The commit lane is fixed by making it pull-driven; the rendezvous lane and the app lane keep the old semantics. That is defensible — a recovery *requester* subscribes before it asks, and hosts generally have their own sync for app data (kubun does) — but it should be an explicit statement, not an omission, so the next lane added does not rediscover this as a mystery bug.

## Minor

- **Retry bound of 5.** With the 10× commit rate D1 is designed for and several active admins, five consecutive CAS losses on a busy group is not obviously rare. Consider making it time-bounded rather than attempt-bounded, or at least host-configurable.
- **`requestID` provenance** in D2 is unspecified — who mints it, and what stops a replayed *request* (as opposed to a replayed reply, which the AAD covers).

## What matches, revision 2

The pull-driven commit lane is the right answer to G1 and G4 at once, and it subsumes problem 4 for free. The `HubStore` boundary is now stated correctly (`hub-protocol` defines, implementations provide). The atomicity requirement is in the contract in words. The per-group commit mutex is in. `publishID` reserved now to avoid a second host migration later is good foresight. The host-impact section says the things a host needs to hear — it just under-scopes the store change (G7).

---

# Revision 1 review (folded in — kept as the record)

**Verdict:** the design answers R1/R2/R3. D3 is a better answer than the requirement asked for — bundling bodies in the commit frame under the pre-commit epoch secret makes first-delivery stranding impossible by construction and removes the host body store entirely. D1's honesty about CAS (not a soundness guarantee; heal is the floor a byzantine hub forces) is the right framing.

Four gaps. G1 blocks implementation.

## G1 — A fresh member cannot form its first CAS

D1 defines `expectedHead` as "the `sequenceID` of the last commit **this peer applied**".

A member that joined by Welcome has applied *no* commit from `commitTopic`. The commits that built the group predate its membership and sit at epochs it cannot process. Its `appliedHead` is therefore undefined, and its first commit has no legal `expectedHead`:

- the empty-topic sentinel is wrong — the topic is not empty;
- omitting `expectedHead` publishes unconditionally, opting out of the very mechanism CAS exists to provide.

The same hole appears in two more places: a peer whose backlog was trimmed, and a peer that rejoined by external commit during heal. All three are peers that legitimately hold current MLS state but have applied nothing from the topic.

**Fix.** Decouple "the head I must CAS against" from "the commit I last applied". The hub should expose the topic's current head — returned from `fetch`, or carried on the subscription — and a peer seeds `appliedHead` from it at join, at resync, and after an external-commit rejoin. The scalar then means "the head I have reconciled to", which is what the CAS actually needs.

Without this, D1 has no entry point for anyone but the group's creator.

## G2 — `HubStore` is host-implemented; the CAS is a store obligation

The component table assigns the per-topic head and conditional publish to `hub-server` / `hub-protocol` / `hub-tunnel`. But `HubStore` is a *contract* in `hub-protocol` that the host implements. Kubun implements it in `packages/hub/src/hub-store.ts` — SQL-backed, with its own migrations, over both SQLite and Postgres.

So D1 is a `HubStore` contract change, and the head lives in the host's database, not in `hub-server`. Two consequences the design should state:

- **Atomicity is a requirement, not an implementation detail.** A read-then-write CAS is a race, and this particular race is the one D1 exists to eliminate. The contract must require that the head comparison, the append, and the head advance happen in a single transaction. Say so, because a host reading the design's `head`-as-a-scalar description could reasonably implement it as three statements.
- **Every host with a hub pays a migration.** Worth naming in the design so the work is sized honestly.

The boundary table should read: hub-protocol *defines* conditional publish and `HeadMismatch`; the `HubStore` implementation *provides* it atomically.

## G3 — No local serialization on `peer.commit`

CAS resolves races between devices. It says nothing about two concurrent callers on the *same* device.

Both call `build()` against the same handle, both publish, one takes a `HeadMismatch` and retries for nothing. Worse, `build()` runs concurrently against a handle the other caller is about to supersede — exactly the hazard `commitLedgerEntries` warns about ("two commits issued from the same source handle both frame at that handle's epoch and diverge").

`peer.commit` needs a per-group mutex. Kubun serializes this today in its handle registry; if the peer owns the commit loop, the peer owns the serialization.

## G4 — The trim-strand trigger is a timing heuristic

D1 claims both heal triggers are deterministic. The byzantine one is: a *valid* commit framed at an epoch the peer has already passed is observable in one step.

The trim-strand trigger is not. "`HeadMismatch` with no inbound commit able to advance it" can only be evaluated by waiting for an inbound commit that never comes.

**Fix falls out of G1.** If the hub returns its current head, a peer that sees `head > appliedHead` and cannot fetch the intervening commits knows immediately that they were trimmed. One observation, no wait.

## Host-side impacts — not gaps, but size the plan

These are kubun's to absorb. Listed because the design reads as a smaller host change than it is.

- **Removing `localCommitted` inverts the host's commit path.** Kubun applies the commit and adopts `newGroup` up front (`withHandleReplacing`). Under D1 it must build without adopting and adopt only inside `onAccepted` — and because `build()` re-runs on every retry, an invite re-mints both the Commit *and* the Welcome each time. This is a rewrite of the host's commit paths, not a call-site swap. Fine, but say it.
- **Welcome delivery is not durable across CAS acceptance.** Once the hub accepts, the group has advanced whether or not the Welcome reaches the invitee. A crash between acceptance and `onAccepted`'s send leaves the invitee added to a group they never received keys for. The answer may simply be "an admin re-invites", but the design should say which.

## What matches

Recorded so it does not get relitigated: the envelope stays ids-only; host reducers stay in the host; `handle.ledger` and `onLedgerEntries` are consumed rather than rebuilt; sealing to the leaf (not the DID key) is the right call and the reachability argument for it is sound; the acceptance criteria are the ones the host would have written.
