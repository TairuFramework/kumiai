# Review: the control-ledger lane design

**Reviewer:** kubun (the host driving the requirements in `2026-07-13-host-ledger-lane.md`).
**Subject:** `2026-07-13-control-ledger-lane-design.md`.

Two review passes. **Revision 2 is reviewed at the top of this document; the revision-1 pass (G1–G4, all folded in) is kept below as the record.**

---

# Revision 2 review

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
