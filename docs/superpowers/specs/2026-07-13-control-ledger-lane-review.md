# Review: the control-ledger lane design

**Reviewer:** kubun (the host driving the requirements in `2026-07-13-host-ledger-lane.md`).
**Subject:** `2026-07-13-control-ledger-lane-design.md`.

Twelve review passes. **The newest pass is at the top; earlier passes are kept below as the record.**

---

# Revision 12 review

**Verdict:** G24 is folded in — the dedup record has its own retention, the contract says it is not a log entry, and the conformance test (publish, trim, republish the same `publishID`, get the original `sequenceID` back) pins it.

One finding, and it is the last one I have. It is a sentence the journal quietly made untrue.

## G25 — Replay's `HeadMismatchError` branch promises a rebuild that cannot happen after a restart

**Blocking, but small — it is a semantics gap, not a mechanism gap.** The replay path says:

> **It was never accepted** → the republish is an ordinary CAS at `expectedHead`. It wins… or it takes `HeadMismatchError` (someone else committed meanwhile: clear the slot, discard, **and rebuild later like any other loser**).

"Like any other loser" is right inside `commit()`, where losing means going back to step 1 and calling `build()` again — `build()` is a live closure over the host's current handle, and that is what makes a rebuild possible.

**After a restart there is no closure.** The process that held `build()` is gone. So "rebuild later" describes something the peer cannot do, and the design does not say what actually happens to the work. Three cases, and they are not alike:

- **A ledger-only commit** (`commitLedgerEntries` — which, after kubun's move, is *most* commits). The journal holds `bodies`: the **signed entry tokens**, which are epoch-independent — the design leans on this repeatedly ("entry tokens are epoch-independent, so re-enactment needs no re-signing"). These are fully recoverable. The peer can re-enact them through a fresh `commit()`, subject to G17's membership filter (they are not in the ledger, since the commit never landed, so the filter keeps them). Nothing is lost, but only if the design says to do it — otherwise a host clears the slot and the entries silently evaporate.
- **An invite.** The intent lives in the MLS Add proposal and the KeyPackage, not in `bodies`. Neither survives in a form the peer can rebuild without the original `build()`. The invite simply did not happen.
- **A remove.** Same: the intent is the Remove proposal. The journal's `bodies` hold only the demotion entry that was riding along. **The removal silently did not happen** — and the admin who issued it has no signal, because from their side the app crashed *after* they clicked it. An admin believing a member was evicted when they were not is a security-relevant no-op, not a UX wrinkle.

So the branch needs to say what it does, per case:

- **Re-enact what is recoverable.** On replay-`HeadMismatchError`, the journalled `bodies` are re-enacted through an ordinary `commit()` — the same membership-filtered path G17 already defines for heal. This is the common case and it costs nothing new.
- **Surface what is not.** A journalled entry whose commit carried MLS proposals (invite, remove) cannot be rebuilt from the journal. The peer must report it — the host has to know that the invite or the removal did not take effect, so it can re-issue or tell the user. Silently clearing the slot is the one thing that must not happen.

The cheap way to make this expressible: have the journal carry a small tag of what the commit *was* (ledger-only / invite / remove), so replay can route it without the peer having to parse the framed commit. That also gives the host a meaningful event to surface rather than a generic failure.

## What matches, revision 12

The G24 fix is complete and correctly placed: the retention rule sits in `PublishParams` next to the field, is restated in the store-contract section, and has a conformance test whose shape mirrors the zero-subscriber test — both are "every plausible store passes today's suite and fails this one", which is the right instinct for a contract test. The sole-member walkthrough now appears in the design itself rather than only in this review, which is where it belongs.

Absent G25 I have no further findings. Across twelve passes the design's *shape* has not moved since revision 4 — CAS'd log, pull-driven lane, bodies in the frame, seal to an ephemeral key, journal plus heal — and everything since has been closing interactions at its edges, each narrower than the last. That is convergence, and the next risk is implementation fidelity, not design.

---

# Revision 11 review (folded in — kept as the record)

**Verdict:** G22 and G23 are folded in. Replay as an explicit *step zero* ahead of the completeness check and the pull is the right structural fix, and stating the at-least-once semantics out loud — rather than letting a host infer exactly-once from a journal whose whole purpose is to make a commit look atomic — is exactly the note to leave.

One finding. It is narrow, but it lands on the single guarantee the journal was introduced to provide, so it is blocking.

## G24 — The journal's idempotency dies with the trim, in exactly the case the journal exists for

**Blocking.** Replay rests entirely on one contract clause:

> *"Republishing an already-accepted `publishID` returns its original `sequenceID` instead of appending again."*

The design never says **where the `publishID` record lives, or how long it survives.** Everything else in the store is governed by one rule it states emphatically: *"Trim governs the log… and is the only thing that removes an entry."* If the `publishID` uniqueness record is a column on the message row — which is what "hosts persist it and enforce uniqueness" most naturally means, and what any implementer will build — then **trim deletes the idempotency record along with the frame.**

After that, a replay of that `publishID` is no longer idempotent. It is an ordinary new publish.

For a multi-member group this is harmless: the republish CASes at a stale `expectedHead`, takes `HeadMismatchError`, clears the slot, and the peer falls through to `recover()` — where responders exist, so it heals. The degradation is invisible because something else catches it.

**But run it through the one scenario the journal was added for (G21) — the sole-member group with no possible responder:**

1. The creator makes a group and `commitInvite`s. It journals, publishes, the hub **accepts**, and the process dies before `onAccepted`. The invitee never got a Welcome, so it never became a member. There is exactly one member in the world.
2. The user does not reopen the app for longer than the trim window. This is ordinary human behaviour, and the design just set that window to **90 days** on the argument that it must be generous.
3. Trim removes the frame — and with it the `publishID` record.
4. The peer restarts and replays. The `publishID` is unknown to the store now, so the republish is treated as *new*: an ordinary CAS at the journalled `expectedHead` (`null`, the empty-topic sentinel, since it was the group's first commit). The topic's `head` is still the sequenceID of its own now-trimmed frame — trim moves `oldest` and, by the design's own rule, **never touches `head`**. So `null ≠ head` → `HeadMismatchError` → clear the slot, discard.
5. The peer pulls: `messages: []`, `head` set, `oldest` null. `head > reconciledHead` with nothing retrievable → **trim strand → `recover()` → no responder, and there never will be one.**

The group is bricked at creation — the identical outcome G21 diagnosed, reached by a different road, and reached *through* the mechanism introduced to prevent it. The journal survives the crash but not the calendar.

**Fix: `publishID` records are not log entries and must not be trimmed with them.** They are a hash and a sequenceID — tiny, and there is one per commit, not one per delivery. The contract should say:

- The `publishID` → `sequenceID` mapping is a **dedup record with its own retention**, independent of the message log. Retain it strictly longer than the commit-log trim window; retaining it indefinitely costs a few dozen bytes per commit and is the simplest thing that is correct.
- Add the conformance test that pins it: **publish with a `publishID`, trim the log, republish the same `publishID` — the original `sequenceID` comes back and nothing is appended.** Every store that hangs the key off the message row passes today's tests and fails this one, which is the same shape as the zero-subscriber test that proved the log was real.

If, instead, bounded retention is preferred, then replay needs a defined answer for "my journalled entry is older than the dedup window" — and in the sole-member case that answer would have to be something other than `recover()`, because there is nobody to recover from. Retaining the record is much cheaper than inventing that path.

## What matches, revision 11

Step zero is right, and calling the ordering "load-bearing, not stylistic" earns its place — it is the kind of line that survives a refactor. The `onAccepted` idempotency paragraph correctly separates the harmless half (re-adopting a fixed serialized `newGroup`) from the dangerous half (re-delivering a Welcome), and names two concrete ways for a host to satisfy it. G23's resolution — stating that `recover()`'s acceptance window is self-healing by re-recovery, and *why* the three facts hold together — is the right call over journalling a second path.

Absent G24 I see no remaining structural defect. The design has been stable in shape for three revisions now; what keeps surfacing are narrower and narrower interactions at its edges, which is what convergence looks like.

---

# Revision 10 review (folded in — kept as the record)

**Verdict:** G21 is folded in, and the journal is the right mechanism — replay by `publishID` lets the store's idempotency contract decide the outcome with no responder and no network peer, which is exactly what the size-one group needs. The split between the two mechanisms is stated crisply and correctly: *"the journal recovers a peer whose own pending state was lost; `recover()` recovers a peer whose group state is unusable."*

This pass is materially smaller than the last nine. One finding, and one gap the journal itself opens.

## G22 — `onAccepted` must be idempotent, and the design does not say so

**Blocking, but small.** The commit sequence is: publish → **accepted** → `onAccepted()` → `clear(publishID)`. Those are three separate durable-ish steps, and a crash can land between any two of them. Replay then re-runs `onAccepted` on an entry that already ran it:

- Crash **between `onAccepted()` and `clear()`** — the slot still holds the entry. On restart, replay republishes, the store returns the original sequenceID, and the peer *"adopts the journalled `newGroup`, delivers the journalled Welcome"* — **a second time.**
- Crash **partway through `onAccepted()`** — say the handle was persisted but the Welcome had not been sent, or vice versa. Same replay, same double-execution of whichever half already ran.

Re-adopting the same `newGroup` is harmless (it is a fixed serialized value; adopting it twice is idempotent by construction). **Re-delivering the Welcome is not.** The invitee has already joined; a second `processWelcome` over the same bytes is not a no-op — it either errors or builds a duplicate group state, and either way the invitee's host is now handling an event its author believed happened once.

So the contract needs a line the design is currently missing: **`onAccepted` MUST be idempotent — replay can and will run it more than once.** In practice that means the host writes its handle adoption and its Welcome delivery so that a repeat is a no-op (deliver-by-`publishID`, or simply tolerate a duplicate Welcome for a member already at that leaf). This is a host obligation and belongs in "Host-side impact" beside the others, because a host will otherwise reasonably assume `onAccepted` runs exactly once — the whole point of the journal is to make the commit look atomic, and that framing is precisely what hides the at-least-once semantics underneath.

While there: the numbered `commit()` steps still begin at *"1. Pull `commitTopic` to the end"*, and replay is described separately as happening "before any lane operation". The ordering is load-bearing and worth making structural rather than prose — **replay must strictly precede the pull**, because a peer that pulls first meets its own un-merged commit, fires the G18 trigger, and takes the expensive rendezvous path the journal exists to avoid. Making replay step 0 of the lane, ahead of both the completeness check and the pull, removes the ambiguity.

## G23 — `recover()`'s own acceptance window is unjournalled, and the design does not say what happens

Not blocking — I believe it is already safe — but it is an unexamined window in the path that everything else falls back to, and it should be reasoned about rather than left to the reader.

`recover()` has the same shape as `commit()`: it publishes an external commit, the hub accepts, and only then does `pending.onAccepted()` adopt. A crash in *that* window is not journalled. Tracing it:

- On restart the peer's handle is the old, broken one. It pulls. Its orphaned external commit is in the log, framed at the group's epoch E — **not** at the peer's own (stale) epoch N. So the G18 trigger does not fire (authorship matches, epoch does not), and the frame classifies as *history → advance*.
- The peer's original condition — trim strand, or fork — still holds, so it trips again and re-enters `recover()`, builds a *fresh* external commit, and this one lands.
- `joinGroupExternal({ resync: true })` is documented to atomically remove the prior leaf for the same identity, so the leaf the orphaned first rejoin added is cleaned up by the second.

So it converges, by re-recovering rather than by replaying — which is fine, and cheaper than journalling a second path. But it depends on three separate facts holding together (the epoch mismatch keeping G18 quiet, the original trigger re-firing, and `resync: true` collecting the orphan leaf), and none of them is stated. One paragraph saying "recover()'s acceptance window is self-healing by re-recovery, and here is why" would close it — otherwise the first person to implement this will either journal it unnecessarily or assume it is broken.

## What matches, revision 10

The journal is correctly scoped: single-slot, host-provided (the host has a database, the peer does not), written *before* the publish, cleared on both terminal outcomes. Making the peer never inspect the blob — it is opaque host state — keeps the layering clean. Replay-by-`publishID` covering both "accepted" and "never accepted" with the same call, and letting the CAS resolve the second case, is elegant. And the design now says plainly that revision 8 was wrong to demote the journal, with the reason (detection is not recovery), which is the sort of thing worth leaving in the document.

---

# Revision 9 review (folded in — kept as the record)

**Verdict:** G19 and G20 are folded in correctly. Authorship-not-applicability is the right predicate, the note that both `readMessageEpoch` and the committer DID are readable *without applying the frame* (and that the committer is MLS-authenticated, so authorship cannot be forged) is the part that makes it implementable, and the write-side exposure is now recorded rather than omitted.

One new finding. **G21 is blocking, it is permanent, and it is reachable on the first commit of every group.** It also invalidates revision 8's demotion of the Deferred pending-commit journal.

## G21 — Heal needs a responder. The crash-window victim can be the only member there is.

**Blocking.** Every heal path terminates in `recover()`, and `recover()` is a rendezvous: *"publish request on rendezvousTopic, await a sealed reply."* It needs **another member, online, willing and able to seal a GroupInfo.** The design never states that precondition, and there is a case where it cannot be met — permanently.

Walk the very first commit of a group's life:

1. The creator makes a group. It is the sole member, and the sole admin.
2. It invites someone: `commitInvite` → `commit(build)` → the frame is CAS'd onto `commitTopic` (retained even with zero other subscribers — that is G7's fix working as intended).
3. **The hub accepts. The process dies before `onAccepted`.**

On restart: the creator is at epoch 0 with a persisted pre-commit handle. It pulls, finds its own commit at its current epoch, cannot merge it (the pending state died) — and the G19-narrowed trigger fires exactly as designed. `recover()` runs. It publishes a rendezvous request.

**Nobody answers.** The only other person who could have become a member is the invitee, and the invitee never received the Welcome — `onAccepted` is what sends it. So there is no responder, there never will be, and `recover()` burns its deadline and returns `{ advanced: false }`.

The creator is now permanently wedged: it can never merge its own commit, never advance past epoch 0, never commit again (its `expectedHead` is behind the head its own orphaned frame installed), and never heal. **The group is bricked at creation, by a crash in a window that exists on every single commit.** The same argument covers any group whose other members are all offline — there it is a stall rather than a brick, which is survivable, but the single-member case has no exit at all.

**This makes the Deferred journal load-bearing, not an optimization.** Revision 8 demoted it:

> "This is an **optimization, not a correctness dependency**: with the un-merged own-commit trigger (G18) the crash victim detects itself and heals."

Detection is not the same as recovery. The trigger tells the peer it is broken; the *rendezvous* is what fixes it, and the rendezvous requires a peer. With a durable pending-commit journal the crash victim does not need a responder at all — it reloads its own `newGroup`, merges, and is whole. That is the **only** exit that works at group size one, so the journal is the sole mechanism covering a case that is otherwise unrecoverable.

Two ways to close it, and they compose:

- **Promote the journal out of Deferred** for at least the commit path: persist the pending commit (bytes, `newGroup` state, any Welcome) *before* publishing, and on restart, republish by `publishID` to learn the outcome — accepted means adopt the journalled `newGroup` and send the journalled Welcome; rejected means discard. The `publishID` idempotency key is already in the `PublishParams` contract *precisely so this costs no second migration*, which the design says out loud. It should just be built now.
- **State the precondition** on `recover()` regardless: heal requires at least one other member that is online, holds the group, and can seal. Say what happens when none answers — today the pseudocode returns `{ advanced: false }` and the caller is given no guidance, which reads as "try later" but is "never" in the single-member case.

The narrower alternative — have the peer detect "I am the only member and my own commit is orphaned" and simply re-CAS a fresh commit — does not work: the orphan frame is already in the log at epoch 0, so any later reader sees two frames at that epoch and the fork trigger fires on them. The journal is the clean answer.

## What matches, revision 9

The G19 narrowing is exactly right, and the design now explains *why* the broad predicate was dangerous rather than just replacing it — which is the difference between a fix and a patch. The G20 write-side section correctly identifies that D1 turns the commit topic into the group's serialization point and that this hands members (not just the hub) a new capability, and it records the mitigation lever as considered-and-rejected rather than unexamined.

Still stale, editorially: the heal-triggers section opens "Retained for the **two** cases CAS cannot cover" and then lists three.

---

# Revision 8 review (folded in — kept as the record)

**Verdict:** G18 is folded in, with the trigger, the cursor row, the ordering note, the `inFlight`-is-empty consequence, and the Deferred-journal demotion all correct.

But the new row introduced a defect of its own. **G19 is blocking, and it is member-triggerable**: as worded, the un-merged own-commit trigger is *strictly dominant* over the two rows beneath it, so any member — including a removed one — can force every peer in the group into a recovery storm with a single publish.

## G19 — The un-merged own-commit trigger swallows every unapplicable frame at the current epoch

**Blocking.** The trigger reads:

> **Un-merged own commit.** A valid frame framed at the peer's **current** epoch that it cannot apply.

and the cursor table puts that row **above** the poison row, deliberately (G18's own note: "otherwise a healthy own-commit is filed as poison").

Now read the predicate literally. "A valid frame at my current epoch that I cannot apply" describes the un-merged own commit — and it *also* describes:

- a **policy-rejected** commit (`CommitRejectedError`) at the current epoch — a well-formed frame the peer deliberately refuses;
- a frame that throws **`MissingLedgerEntriesError`** at the current epoch — well-formed, and *by definition* at the current epoch, since that is the only epoch whose frames a peer tries to resolve.

Both already have rows, and both are below the G18 row, so the G18 row wins. The frame a peer is *about to apply* is always at its current epoch — that is what "next frame" means — so the new row captures essentially every non-applied frame in the normal path. `MissingLedgerEntriesError`, which D3 is at pains to keep as "the one retryable outcome", now routes to `recover()` instead of a gather. And a poison commit routes to `recover()` instead of being dropped.

**That last one is a group-wide DoS, and any member can pull it.** The hub is blind: it does not know the roster and cannot judge a commit. So a member — or a **removed** member, who keeps `commitTopic` and its subscription forever, as the design's own "Accepted exposure" section establishes — publishes one well-formed, policy-rejected commit, CAS'd at the current head. The hub accepts it (it accepts bytes). Every honest peer pulls it, finds a valid frame at its current epoch that it cannot apply, and heals: a rendezvous request, a sealed GroupInfo from every responder, an external commit, and CAS contention — from every member of the group, at once. Repeat at will.

**Fix: the discriminator is authorship, not applicability.** The condition the design actually means is *"my own commit, which I never merged"*. So test that:

> A valid frame framed at the peer's current epoch **whose committer is this peer** and which it cannot merge.

The committer is readable without applying the frame — `defaultCommitPolicy` already resolves a proposal's sender leaf to a DID via `didOfLeaf`, and `envelope-fold` resolves an external commit's author from its UpdatePath leaf credential. So the row becomes:

| Frame | Cursor |
|---|---|
| At the peer's current epoch, **committed by this peer**, unmergeable (pending state lost) | do not advance; heal trigger → `recover()` |

With authorship in the predicate the row stops overlapping the others: a policy-rejected commit from someone else is poison (advance, drop), a `MissingLedgerEntriesError` is a gather (do not advance, retry), and only the peer's own orphaned commit heals. The ordering note in G18 stays correct and becomes narrow enough to be safe.

## G20 — The "accepted exposure" analysis covers reads, not writes

**Not blocking on its own; it is what makes G19 dangerous, and it should be reasoned about explicitly.**

The design carefully analyses what a removed member can *read* from `commitTopic` (retained history; no confidentiality delta; a metadata delta, accepted). It never analyses what a removed member — or any member — can *write* to it.

Under the old mailbox semantics, a garbage commit from an ex-member was a message honest peers ignored. Under D1 the commit topic is **the group's serialization point**, and the hub authorizes publishes without knowing the roster. So an ex-member's publish:

- **advances the head**, which every honest committer must now CAS against;
- forces every peer to fetch, parse, classify, and drop the frame;
- and, with G19 unfixed, triggers a full group-wide recovery.

Even with G19 fixed, this is worth a line in the exposure section rather than an omission: an ex-member can inject noise into the group's serialization lane indefinitely, costing every honest commit an extra CAS round and every peer a wasted pull. That is DoS-class and consistent with the design's stated posture ("the hub can already drop, delay, reorder and partition"), but it is a *new* capability handed to *members*, not to the hub — and the exposure section is the place to say so. If it ever needs bounding, the lever is the same one the design already rejected for reads (rotating the topic on removal), which suggests recording now that the write side was considered and accepted, so it is not rediscovered as a surprise.

## What matches, revision 8

The G18 trigger is right in substance — `readMessageEpoch` as the discriminator between "history" and "the frame I should be able to apply" is exactly the observation, and the reasoning for why nothing else fires (invariant passes, trim doesn't, fork doesn't) is correct and worth having written down. The `inFlight`-is-empty-after-crash note composing with G17's membership filter is a genuinely nice piece of consistency. Demoting the durable-commit journal from silently-load-bearing to a stated optimization is right.

Minor editorial: the heal-triggers section still opens "Retained for the **two** cases CAS cannot cover" and then lists three.

---

# Revision 7 review (folded in — kept as the record)

**Verdict:** G16 and G17 are folded in, and both correctly. The completeness invariant (`computeHead(ids(handle.ledger))` vs the handle's own `ledger_head`) as a *self-describing* bootstrap trigger is the right shape — it needs no memory of how the peer got broken. And "re-enact by ledger membership, never by failure mode" collapses the three heal paths into a single set-difference, which is strictly better than telling them apart.

One new finding. It is the **last instance of the pattern this review has been chasing since G5**: the design enumerates three heal *paths* but only ever specifies two heal *triggers*.

## G18 — The crash-window peer has no trigger. Nothing detects it, including the new invariant.

**Blocking.** Heal has three named paths. It has exactly two triggers — trim strand, and byzantine double-accept. The third path, crash-in-the-acceptance-window, is never given one.

The design conflates two different failures under one heading: *"A throw from `onAccepted` is the crash window, reached by a likelier route."* For the **throw**, that's fine — the peer is alive, it is inside `commit()`, it knows. For an actual **process death** between the hub's acceptance and the host's adoption, the knowledge dies with the process. On restart the peer is left in a state that trips nothing:

- **The completeness invariant passes.** It never rejoined, so its ledger still matches its own `ledger_head` at epoch N. G16's check says it is healthy.
- **Trim strand does not fire.** The frames are all still retained; it can pull the log to the end.
- **The fork trigger does not fire.** It never applied a commit at epoch N, so it holds no conflicting per-epoch sequenceID record.

So it pulls, reaches the frame that is **its own accepted commit at epoch N**, and cannot apply it — MLS *merges* a pending commit, it does not *process* one, and the pending state died with the process. The design already knows this ("Host-side impact" says exactly that sentence), but the cursor table has no row for it. The frame falls through to *malformed / policy-rejected → poison → advance*. The cursor then walks every later frame, all at epochs the peer cannot reach, each classified as *no record for that epoch → history → advance*.

The peer ends at `reconciledHead == head`, believing it is fully reconciled, **stuck at epoch N forever, with a complete ledger and a clean bill of health.** It silently stops applying group changes and silently stops being able to commit. There is no error, and — this is what makes it blocking — the invariant introduced in G16 to make strandedness self-detecting *reports this peer as fine*.

**The detector already exists in `mls`: `readMessageEpoch`.** It reads a frame's epoch without applying it, so the peer can distinguish "a frame from before my time" (history — skip) from "a frame at my *current* epoch that I cannot apply" (I am stranded — heal). That second condition is precisely the un-merged own-commit, and it cannot arise for any healthy peer: a frame framed at your current epoch is, by definition, the next commit you should be able to apply.

Recommend a third heal trigger, stated beside the other two:

> **Un-merged own commit.** A valid frame framed at the peer's *current* epoch that it cannot apply. The peer is the crash-window victim: the hub accepted its commit, the group advanced, and the pending state did not survive. Action: `recover()`.

and a matching row in the cursor table, above the poison row, so an un-mergeable own-commit is never miscategorized as malformed:

| Frame | Cursor |
|---|---|
| At the peer's current epoch, valid, but unapplicable (own un-merged commit) | do not advance; **heal trigger** — `recover()` |

Two smaller consequences fall out for free once this is stated:

- **`inFlight` is empty after a real crash** — the `PendingCommit` was in memory. That is *correct* and needs no extra machinery, precisely because of G17: on the crash path the membership filter empties the re-enact list anyway, since the entries are already in the group's ledger. The two fixes compose. Worth one sentence saying so, because a reader will otherwise wonder how a restarted peer re-enacts entries it can no longer name.
- The Deferred "durable pending-commit journal" is now clearly an *optimization* (it would let the peer merge instead of rejoin), not a correctness dependency — which is worth saying, since without a trigger it was silently load-bearing.

## What matches, revision 7

The completeness invariant is the right abstraction and is correctly scoped ("check it on restore, and before every lane operation"), and making an incomplete ledger a *persistent degraded state* rather than a droppable return value is the part that actually closes G16. G17's table and the `[Foo, Bar, Foo]` walkthrough state the bug precisely, and "membership, not provenance" is a better rule than the path-by-path fix I proposed — it means a future fourth heal path inherits the correct behaviour for free.

With G18 closed I have no further structural objections. Every remaining risk I can see is implementation fidelity: the `HubStore` conformance suite run against a real database over separate connections, and the cursor table's rows being implemented in the order written.

---

# Revision 6 review (folded in — kept as the record)

**Verdict:** G15 is folded in, and correctly — bootstrap as a named primitive with its own head-verification step, rather than a clause inside `recover()`, is the right call, and wiring `computeHead`/`assertHeadMatches` on the rejoin path (where today they run only from `processWelcome`) closes the omission attack.

Two new findings, both in the heal path the last two revisions drew. **G17 is a silent data-loss bug** — it reverts another admin's change with no error anywhere.

## G17 — Re-enacting after heal is correct on one path and corrupting on another

**Blocking.** `recover()` returns `reenact: <entries discarded on the way in>`, and the caller re-enacts them through an ordinary `commit()`. That is right for one heal path and wrong for another, because the three paths differ in *whether the peer's entries already reached the group's ledger*:

| Heal path | Was its commit accepted by the hub? | Are its entries in the group's ledger? | Re-enact? |
|---|---|---|---|
| Trim strand | never committed | n/a — nothing to re-enact | no-op |
| **Crash / `onAccepted` threw** | **yes — acceptance is what defines this path** | **yes — every other member pulled and applied it** | **must NOT** |
| Byzantine losing branch | accepted only on a branch the group discarded | no | **must** |

The crash path is defined by the hub having *accepted* the commit — that is precisely why the group advanced without the committer. So its entries are already enacted, already folded, already in everyone's ledger. Re-enacting them appends them a second time, at the end of the log.

And in `mls` that is not a harmless duplicate. `applyLedgerEntries` documents it: *"A token the log already holds is appended again rather than skipped. The log is an ordered record of what each commit enacted, not a set of claims"* — deliberate, because re-appending is how a demotion back to a previously-held role is expressed. Which means a re-enacted entry **wins the fold**:

> Admin A commits `circle.def X → name "Foo"`. The hub accepts; A crashes before adopting.
> Admin B commits `circle.def X → name "Bar"`. Everyone applies it. The circle is "Bar".
> A heals, rejoins, bootstraps, and re-enacts its "Foo" entry.
> The ledger is now `[Foo, Bar, Foo]`. The fold is last-write-wins by position. **The circle is "Foo" again.**

B's change is silently reverted by a peer that crashed. No error, no conflict, no signal — a stale write resurrected by the recovery mechanism itself. This generalizes to every last-write-wins host reducer, which is all three of kubun's.

**Fix, and it is cheap because bootstrap already fetched what it needs.** Bootstrap hands the peer the **whole ordered ledger, with content ids, head-verified**. So after bootstrap, re-enact only the entries whose ids are **absent** from it. On the crash path that filter empties the list; on the byzantine path it keeps it whole; on the trim path there was nothing anyway. One set-difference, and the three paths stop needing to be told apart.

Worth stating the invariant the filter enforces, because it is the real rule: **an entry is re-enacted if and only if the group's authenticated ledger does not already contain it** — never because of which failure brought us here.

## G16 — Bootstrap has no failure path, and a crash before it leaves a silently reset peer

`recover()`'s accepted branch adopts the rejoined handle, then calls `bootstrapLedger()`. Between those two, and until bootstrap succeeds, the peer holds an **internally inconsistent handle**: `handle.ledger` is empty while its GroupContext's `ledger_head` is the group's real, non-genesis digest. As G15 established, that is a roster reset — the peer will reject the next commit any non-creator admin authors.

The design never says what happens when bootstrap **fails**: every responder lies, or nobody answers, or the peer goes offline mid-gather. And it cannot be undone — the external commit is already accepted and in the log, so there is no rollback. The peer is rejoined, broken, and (having rejoined) no longer trips the trim-strand trigger that would have sent it back to `recover()`. Worse, the ordering is forced: the gather rides the app lane, which needs group membership, so the peer *cannot* bootstrap before rejoining. The window is unavoidable and must therefore be survivable.

A crash in that window is the same state, reached faster, and it **persists across restart**: the host persists the handle with `ledgerEntries: []`, `restoreGroup` replays an empty list, the roster resets again, and nothing anywhere notices.

**The detector is a self-describing invariant, and it is free.** A handle's ledger is complete exactly when `computeHead(groupID, ids(handle.ledger))` equals the `ledger_head` in its own GroupContext. That comparison needs no peer, no network, and no memory of how the peer got here — it is evaluable at startup, after restore, and before any commit. Make *that* the bootstrap trigger, rather than `recover()`'s control flow:

- **On restore and before each lane operation**, check the invariant. Mismatch → the ledger is incomplete → bootstrap before doing anything else.
- **Bootstrap failure is a retryable, persistent state**, not a return value that gets dropped. A peer that cannot bootstrap is degraded and must keep trying; it must not report `advanced: true` and proceed as though healed.
- This also subsumes the crash case with no extra machinery, and gives the peer a real answer to "am I whole?" that does not depend on remembering what went wrong.

## What matches, revision 6

Bootstrap as its own primitive with `getLedger()` + `bootstrapLedger()` is right, and putting the head check *before* the fold ("verify it against the authenticated head before applying a single entry") is the correct ordering — a fold-then-check would already have moved the roster. The observation that `computeHead`/`assertHeadMatches` exist and are wired only into `processWelcome` is exactly the gap. The "withhold, never rewrite" bound now holds on both gather paths.

---

# Revision 5 review (folded in — kept as the record)

**Verdict:** G13 and G14 are folded in, and both correctly. "All three operations are top-level operations on one serialized lane; none of them ever calls another; the mutex is never re-entered" is the right rule, and it makes "heal is two commits" *fall out of* the concurrency invariant instead of being bolted on. The ephemeral-key seal keeps every property leaf-sealing was defending — intrinsic roster authorization, a removed member gets nothing, replay-bound AAD — and drops the assumption that inverted.

One new finding. **G15 is the last structural hole I can find**, and it is both a liveness bug and a security hole on the same path.

## G15 — A rejoined peer cannot bootstrap its ledger, and nothing authenticates one if it could

**Blocking.** `recover()`'s accepted branch says:

> `gather the ledger bodies the GroupInfo did not carry (D3)`

and D3's gather is `getLedgerEntries(ids: Array<string>)`, served from the responder's `handle.ledger`.

**The rejoined peer does not know the ids.** It joined by external commit from a GroupInfo. Its GroupContext carries `ledger_head` — a *chain digest*, not a list — and its handle's ledger is empty. `resolveLedgerEntries(ids)` is the commit pre-pass's hook: it is called with ids read from an incoming commit's *envelope*, i.e. only for entries some **new** commit enacts. Nothing enumerates the group's *existing* ledger. So the peer has nothing to ask for, and the gather cannot start.

That is the liveness half. The security half is worse, and it is what makes this blocking rather than merely a missing method:

**An empty ledger is not a neutral state — it is a roster reset.** The roster folds from the anchor plus the applied entries. With no entries, the rejoined peer's roster is *the genesis anchor alone*: the creator is admin, and nobody else is. Every admin promoted since is invisible to it. It will refuse the next commit any of them authors — `foldEnvelope` rejects an entry whose issuer is not an admin in state-so-far — so a rejoined peer doesn't just lack history, it **actively rejects the live group's commits** and re-strands itself. And the host's projections (kubun's circles, members, settings) fold from the same ledger, so they come back empty too.

Now suppose the gather is added naively — "ask a member for the whole ledger". A lying member hands back a list with one demotion entry **omitted**. Every token still verifies (they are all genuinely signed), the groupID still matches, and the fold still runs. The rejoiner's roster now contains an admin the group demoted. Signature verification does not catch an omission, and neither does authority folding — **only the order and the completeness of the list are unprotected, and those are exactly what `ledger_head` protects.**

**The fix is already in `mls`, unused.** `computeHead(groupID, entryIDs)` recomputes the chain from genesis across an ordered id list, and `assertHeadMatches` throws `LedgerIncompleteError` — whose doc comment says, verbatim, *"an inviter omitted, reordered, or truncated a ledger entry"*. That is precisely this attack, anticipated for the invite path and never wired for the rejoin path. So:

- **Gather the whole ordered ledger, not "the missing ids".** `GroupMLS` needs a full-log accessor alongside the id-keyed one — the responder already has it (`handle.ledgerTokens` is documented as "the canonical persistent and wire form, the only thing that can be handed to another party").
- **Verify it against the authenticated head before applying a single entry.** Recompute with `computeHead` over the gathered ids in the order given, compare against the `ledger_head` extension the peer's own GroupContext already carries (`readLedgerHead`), and reject on mismatch. The head came in with the GroupInfo and is MLS-authenticated, so it is a trustworthy check against an untrusted responder.
- **A responder that fails the head check is not asked again** — fall through to the next gather reply. This makes a lying member able to withhold, never to rewrite, which is the same bound D3 already claims for the id-keyed gather ("a lying responder can only fail to answer, never inject").

Worth stating in the design as a named step — "ledger bootstrap" — rather than a clause inside `recover()`, because it is a distinct primitive with its own integrity check, and the host's projections depend on it having run before they refold.

## What matches, revision 5

The single serialized lane is the right resolution of G13, and deriving "heal is two commits" from it is cleaner than the revision-4 text that asserted both separately. The G14 table is exactly the analysis, and the replay note (a signed request means a forged one now fails verification outright, where before it was merely useless) is a genuine improvement over what I proposed. `applyRecovery` returning a `PendingCommit` rather than applying — so the heal path's external commit goes through the same CAS discipline as any other — closes the loop between D1 and D2 properly.

I have no further structural objections beyond G15. The remaining risk in this design is implementation fidelity, not shape — chiefly the `HubStore` conformance suite actually being run against a real database over separate connections.

---

# Revision 4 review (folded in — kept as the record)

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
