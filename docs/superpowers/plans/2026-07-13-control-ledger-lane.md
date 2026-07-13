# Control-ledger lane — implementation plan

**Stage:** planning
**Mode:** learning-loop
**Spec:** `docs/superpowers/specs/2026-07-13-control-ledger-lane-design.md` (revision 21)
**Review record:** `docs/superpowers/specs/2026-07-13-control-ledger-lane-review.md` (G1–G27)
**Found while implementing:** G28 (the lane outruns the mailbox), G29 (`head` advances on a
mailbox publish), G30 ("one transaction" is not a CAS), G31 (the dedup record must not cascade
from `messages`, while the delivery rows must), G32 (an Add-only commit carries no UpdatePath and
rotates nothing) — see the decision log.

## How this plan is adversarial

Fourteen review passes found twenty-seven defects. Nearly every *blocking* one shared a
signature:

> **a design claim that the obvious implementation satisfies while being wrong.**

The store passes its whole test suite while its "log" is a mailbox (G7). The recovery reply
seals correctly for the one peer that didn't need it (G14). The crash victim reports itself
healthy (G18). The journal survives the crash but not the calendar (G24). None of these are
caught by testing the happy path — **they are caught by testing the wrong implementation and
watching it pass.**

So every question below carries a **⚠️ Wrong-but-passing** note: the plausible implementation
that satisfies a naive test. A question is not done until a test *distinguishes* the right
implementation from that one. Where the spec names a G-numbered regression test, it is quoted
in "Done when" — those are exit criteria, not suggestions.

**Scope:** kumiai only (`hub-protocol`, `hub-server`, `mls`, `rpc`). Kubun's `HubStore`
migration is its own plan in its own repo; the conformance suite exported from `hub-protocol`
is the contract between us.

---

## Phase 1: The store contract

The suite is written **before** the store it judges, and its first run is **against today's
`memoryStore`, expecting failures**. A suite that passes on the unmodified store is a broken
suite — that is the phase's central check, and it is the one thing that would have caught G7
on day one.

**Exit criteria:** `hub-protocol` exports a conformance suite; `memoryStore` passes all of it;
and the suite **demonstrably fails** a store that hangs retention off delivery, or dedup off the
message row — both verified by building the wrong store and watching it fail, not by assertion.

An in-process sequence counter was originally listed here too. **It is not testable and the
criterion is withdrawn** (question 1.3): the suite drives one store object in one process, where a
lazily-seeded counter is monotonic and unique, so it passes every clause and breaks only across two
hub processes on one database. It is a review item against the host's DDL, recorded in the spec's
host-side impact. Restating it honestly is worth more than a clause that would have passed
vacuously.

### Question 1.1: Does a conformance suite written from the spec actually fail today's store?

- **Assumption:** the suite's two load-bearing tests (zero-subscriber publish, dedup-outlives-trim)
  fail against the current `memoryStore`, and fail *for the reasons the spec predicts*.
- **Done when:** the suite exists in `hub-protocol` (exported for hosts), and running it against
  the **unmodified** `memoryStore` fails on exactly: zero-subscriber publish then pull;
  ack-does-not-delete; dedup-outlives-trim; `fetchTopic` missing. Paste the failure output. No
  store code changed in this question.
- **⚠️ Wrong-but-passing:** a suite that only exercises publish→deliver→ack. Today's store passes
  that completely, which is why the log's absence went unnoticed until G7.
- **Spec excerpt:** "**The log is real: publish to a topic with zero subscribers, then subscribe
  and pull the frame.** The single test that proves retention is not a function of delivery.
  Every store passes today's tests and fails this one." … "a store that hangs the key off the
  message row passes every other test here and fails this one, exactly as a delivery-derived
  store passes everything and fails the zero-subscriber test. These two are the suite's
  load-bearing tests."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 1.2: Can `memoryStore` retain a per-topic log independently of delivery?

- **Assumption:** retention can be moved off delivery without breaking the mailbox behaviour the
  rest of the system still depends on (rendezvous and app lanes keep mailbox semantics — G9).
- **Done when:** a `log`-class publish stores an entry with zero subscribers; `ack` deletes a
  *delivery* and never a `log` entry; `trim({ topicID, before })` is the only deleter of one, and
  moves `oldest` without touching `head`; a trimmed entry leaves no pending delivery behind; a
  `mailbox`-class publish keeps **today's** semantics exactly, ack GC included. Suite's log and
  class tests pass. The existing `hub.test.ts` still passes — the mailbox is not regressed.
- **The two classes are the point (spec revision 17).** Ack GC asks "has everyone read this?" and
  on the commit topic the reader **may not exist yet** — an invitee is not a subscriber at publish
  time, so no refcount over current subscribers can account for it. That is why the log's retention
  cannot be delivery-derived *even with a correct refcount*, and it is also why the mailbox may
  keep its refcount: there, the reader set really is known.
- **Three existing tests encode the old contract and must be rewritten, not preserved** (found
  in question 1.1): `memoryStore.test.ts:11` (zero-subscriber publish drops), `:83` (refcount GC
  on last ack), `:62` (last unsubscribe drops the whole topic log). Each *asserts* a behaviour
  the spec now forbids. Rewriting a passing test is the correct move here and it will feel wrong;
  do it deliberately, and say in the commit which contract each one used to encode.
- **⚠️ Wrong-but-passing:** keeping `deleteMessage`'s refcount GC *for the log class* "as an
  optimization for messages nobody wants". That is precisely today's bug: the last ack destroys
  the log entry, and every online-peer test still passes. Same shape for `unsubscribe`: dropping
  the topic index when the last subscriber leaves is a deletion `trim` never authorized, and no
  online-peer test notices. And the newest shape: **treating `retain` as a no-op** — a store that
  ignores the class passes every clause except the one pair that publishes identically to the same
  topic with the same acks and expects one frame gone and one still there.
- **Spec excerpt:** "Messages are retained per topic, independently of delivery… Delivery rows
  govern push only… Trim governs the log, by depth and age, and is the only thing that removes a
  log entry."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 1.3: Is the CAS atomic, and is `sequenceID` ordered?

- **Assumption:** `expectedHead` + a DB-minted, lexicographically-ordered sequenceID can be
  specified such that a non-transactional store fails the suite.
- **Done when:** `PublishParams.expectedHead` and `HeadMismatchError` land; the contract states
  that the head comparison, **the sequence mint**, the append and the head advance are one
  transaction; sequenceIDs are contractually lexicographic + strictly increasing per topic. Suite
  asserts: 9→10 boundary ordering; empty-topic `null` sentinel; loser stores nothing; **N racing
  publishes at one head yield exactly one append**, and the suite's docs say this must be run by
  hosts over *separate DB connections*, not N `await`s on one.
- **⚠️ Wrong-but-passing:** `String(counter)` unpadded, or a UUID — satisfies `sequenceID: string`
  and silently breaks every comparison (`"10" < "9"`). And an in-process counter (kubun's today)
  passes every single-process test while colliding across two hub processes on one database.
- **Spec excerpt:** "sequenceIDs are **lexicographically ordered, strictly increasing within a
  topic**… the sequenceID is **minted by the store inside the CAS transaction**, not by the
  process… Survivable for a mailbox; fatal for a head, because the head *is* a sequenceID."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 1.4: Does the dedup record outlive the log?

- **Assumption:** `publishID` can be stored with retention independent of trim, and the suite can
  prove it.
- **Done when:** republishing an accepted `publishID` returns the original sequenceID and appends
  nothing — **including after the log has been trimmed**. Retention is indefinite in `memoryStore`.
- **⚠️ Wrong-but-passing:** `publishID` as a column on the message row. It passes the plain
  idempotency test and fails only after a trim — and in a multi-member group even *that* failure
  is masked, because the peer falls through to `recover()` and finds a responder. It only bites
  the sole-member group, which is the one case the journal exists for (G24).
- **Spec excerpt:** "The `publishID` → `sequenceID` dedup record is not a log entry, and trim must
  not remove it… Hanging the key off the message row is the natural implementation and it is
  **wrong**."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 1.5: Does `fetchTopic` read the log, gated on subscription?

- **Assumption:** a subscriber-gated topic read composes with the existing `hub/receive` mailbox
  channel without disturbing it.
- **Done when:** `fetchTopic({subscriberDID, topicID, after, limit}) → {messages, head, oldest}`
  works in `memoryStore`, refuses a non-subscriber, and is reachable end-to-end through
  `hub-protocol`'s procedure definition, `hub-server`'s handlers, `hub-tunnel`'s `HubLike`, and
  `hub-client`. `expectedHead`/`publishID` thread through `HubPublishParams` likewise.
- **⚠️ Wrong-but-passing:** implementing `fetchTopic` over the *delivery* rows (they're right
  there, and they're keyed by topic). It returns plausible results for an online peer and returns
  nothing for exactly the peers the pull lane exists to serve.
- **Spec excerpt:** "`fetchTopic` is gated on subscription, so it exposes a topic's log only to
  members who already derive that topic from the group secret."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

---

## Phase 2: The mls primitives

**Exit criteria:** sealing works for a peer whose leaf key rotated; bootstrap rejects a doctored
ledger; the completeness invariant is computable locally.

### Question 2.1: Does a commit really rotate the committer's leaf HPKE key?

- **Assumption:** G14's premise. Every commit carries an UpdatePath that installs a fresh leaf key
  for its author, so a peer that committed cannot open a reply sealed to the leaf the group can see.
- **Done when:** a test demonstrates it directly — commit, then compare the committer's leaf
  `encryption_key` in the pre- and post-commit trees, and show the pre-commit private key does not
  open a seal to the post-commit public key. This is a **read-only probe**: it validates the reason
  D2 abandoned leaf-sealing, and if it comes back false, **stop and update the spec** — the
  ephemeral-key machinery would be unnecessary.
- **⚠️ Wrong-but-passing:** testing this with a *non-committing* member (the trim-strand peer).
  Leaf-sealing works perfectly for that one, which is exactly how the flaw survived three revisions.
- **Spec excerpt:** "the committer's path is whose path a commit rotates — every Commit carries an
  UpdatePath installing a fresh leaf HPKE key for its author… Only the trim-strand peer — the one
  that was merely behind — could open its own rescue."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 2.2: Can GroupInfo be sealed to a requester-supplied ephemeral key, authorized by the roster?

- **Assumption:** `sealGroupInfo` / `openSealedGroupInfo` over the existing X25519 HPKE, with a
  signed request carrying the ephemeral public key.
- **Done when:** the reply opens for the requester and **fails to open for every other member and
  for the hub**; AAD binds `groupID` + `requesterDID` + `requestID`, so a reply replayed at another
  member or another request is rejected; a request whose DID has **no leaf in the current tree** is
  refused (a removed member gets nothing); a request with a bad signature is refused. **The G14
  test: a peer whose own commit was accepted and then lost recovers** — the case leaf-sealing fails.
- **⚠️ Wrong-but-passing:** sealing to the leaf. It passes a three-member happy-path recovery test
  and fails only for the two peers that actually need heal.
- **Two traps found while verifying the premise (question 2.1), both landing here:**
  - **The first rejection you hit is the wrong one.** Feeding a commit back to a handle that has no
    `resolveLedgerEntries` resolver fails at the **ledger policy** ("ledger entries could not be
    resolved") long before MLS is reached. A recovery test written against a resolver-less handle
    passes for a shallow reason and proves nothing about sealing. Provision the resolver so the
    throw you assert is the genuine MLS one.
  - **A stale committer cannot even apply its own commit** — ts-mls *throws* (`No overlap between
    provided private keys and update path`), because the author's own subtree is excluded from every
    path secret's recipient set. So the recovery path must not fall back to "re-feed it the commit
    it sent". Its only route back into the group is a fresh leaf.
- **Spec excerpt:** "The requester generates an HPKE keypair per `recover()` call and puts the
  public half in the rendezvous request, signed by its DID identity key. The responder: verifies
  the request signature… checks that DID has a leaf in the **current ratchet tree**… seals to the
  **ephemeral** public key."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 2.3: Does head-verified ledger bootstrap reject a doctored ledger?

- **Assumption:** `computeHead` + `assertHeadMatches` (today wired only into `processWelcome`) can
  be wired onto the rejoin path, and `isLedgerComplete()` is a purely local check.
- **Done when:** `getLedger()`, `bootstrapLedger(tokens)` and `isLedgerComplete()` land.
  `bootstrapLedger` **verifies the recomputed head before folding a single entry** and throws
  `LedgerIncompleteError` on mismatch. The G15 security test: a responder returns a
  genuinely-signed, correctly-scoped ledger **with one demotion omitted** — it is rejected, the
  responder is skipped, and the demoted admin does **not** reappear in the roster. The G15 liveness
  test: a bootstrapped peer accepts the next commit from an admin promoted after genesis (a peer
  with an empty ledger rejects it — an empty ledger is a *roster reset*, not a neutral state).
- **⚠️ Wrong-but-passing:** verifying each token's signature and calling it done. Every token in a
  doctored ledger is genuinely signed and correctly scoped — **omission and reordering are exactly
  what signatures do not protect and what `ledger_head` does.** Also wrong: folding then checking.
- **Spec excerpt:** "Verify it against the authenticated head **before applying a single entry**…
  This bound — a lying responder can withhold, never rewrite."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

---

## Phase 3: The peer lane

**Exit criteria:** one serialized lane; the cursor table's rows fire in the order written; no lane
result is delivered under the lock; the lane never advances the group past an epoch whose app
frames are still undecrypted.

### Question 3.1: Does the pull-driven commit lane seed and catch up correctly?

- **Assumption:** a cursor seeded by *reading the log* serves the fresh joiner, the re-seeded peer,
  and the rejoiner — the three peers that have applied nothing from the topic.
- **Done when:** `commitTopic` / `rendezvousTopic` split; the peer subscribes, then pulls from its
  cursor; push is a wakeup only. **The late-joiner test:** a member is invited, two further commits
  land before it subscribes, and it converges **by pulling** — with no `recover()`, and **no fork
  diagnosis** while walking frames from epochs it never held.
- **⚠️ Wrong-but-passing:** seeding the cursor from the topic's `head` at subscribe time. Every
  online-peer test passes; the joiner then CASes against a head whose commits it never applied.
- **Two traps found while wiring the transport (question 1.5), both landing here:**
  - **A log publish is pushed *and* retained.** An accepted `retain: 'log'` frame goes down
    `hub/receive` *and* into the log, so an online peer sees every commit twice. The lane drives by
    **pull**; push is a wakeup and nothing more. A lane that also processes the pushed copy works
    perfectly in every single-peer test and breaks the moment two peers are online.
  - **`hub/receive`'s `after` and `hub/topic/fetch`'s `after` are both `string` and mean different
    things** — a delivery-queue position versus a log position. A peer holding one "cursor" and
    feeding it to both silently mis-pages. Name them apart in the peer's state
    (`deliveryCursor` / `reconciledHead`); do not let them share a type alias either.
- **Spec excerpt:** "seeds its cursor by *reading the log*, not by guessing… A frame framed at an
  epoch it has already passed is dropped and still advances the cursor."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 3.2: Do bodies ride the commit frame, and is classification before unwrap?

- **Assumption:** `[commit][wrap(bodies)]` under the pre-commit epoch secret makes first-delivery
  resolution automatic, and history stays readable without being unwrappable.
- **Done when:** the three-member test — an admin enacts an entry, the third member has never seen
  the body, and it **applies the commit on first delivery with no gather**. The G11 test: a late
  joiner walks frames whose blob it cannot unwrap (**including its own add-commit**) and classifies
  **none of them as malformed**.
- **⚠️ Wrong-but-passing:** unwrapping the blob as part of parsing the frame. The cursor still
  advances (both rows say advance), so every test passes — and ordinary history is logged as
  poison, which costs someone a day the first time they debug a real log.
- **Spec excerpt:** "Unwrapping is a *consequence* of 'I can apply this frame', never a
  precondition of reading it."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 3.3: Does the commit CAS loop converge, serialize, and journal?

- **Assumption:** build-without-adopting + CAS + discard-on-loss, under one per-group mutex, with
  the journal written before publish.
- **Done when:** two admins at epoch N → one wins, the loser rebases and its entries land in a
  later commit (no fork, no lost entries). Two **concurrent same-device** `commit()` calls
  serialize; both land; neither builds against a superseded handle. The journal is written
  **before** the publish and cleared on both terminal outcomes. Retry is a **deadline**, not an
  attempt count.
- **⚠️ Wrong-but-passing:** adopting `newGroup` when the hub accepts but before `onAccepted` — or
  reusing the source handle across a retry. Both pass a single-committer test; the second is the
  hazard `commitLedgerEntries` documents ("two commits issued from the same source handle both
  frame at that handle's epoch and diverge").
- **Spec excerpt:** "`commit` holds a per-group mutex for its whole run… Journal the pending commit
  before publishing… It is what makes the acceptance window survivable *without a peer*."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 3.4: Does the cursor table classify in the order written — and can a member weaponise it?

- **Assumption:** the G18 trigger keyed on **authorship** (not applicability) detects the crash
  victim without handing any member a DoS.
- **Done when:** every row of the cursor table has a test, and they fire **in the order written**.
  Specifically — **the G18 test:** a peer crashes after acceptance, restarts, meets its own commit,
  and **heals** (assert its epoch *advanced*; an implementation without this row walks to
  `reconciledHead == head` and reports itself healthy). **The G19 security test:** a removed member
  publishes a well-formed, **policy-rejected** commit at the current head, and **nobody heals** —
  every honest peer drops it as poison. And a `MissingLedgerEntriesError` frame **gathers**, it does
  not heal.
- **⚠️ Wrong-but-passing:** the trigger as "a valid frame at my current epoch I cannot apply". It
  passes the G18 test perfectly. It also routes policy-rejected commits and missing-bodies frames to
  `recover()` — so any member, including a removed one, forces the **entire group** into a recovery
  storm with one publish, repeatable at will.
- **Spec excerpt:** "**The discriminator is authorship, not applicability.**… the committer is
  MLS-authenticated, so authorship cannot be forged."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 3.5: Does `recover()` heal without nesting, and re-enact by membership?

- **Assumption:** `recover()` is its own lane operation with its own CAS loop; re-enactment is a
  *subsequent* `commit()` filtered by ledger membership.
- **Done when:** `recover()` CASes its external commit at `reconciledHead` and, on
  `HeadMismatchError`, **discards the GroupInfo too** (it describes a tree the winner already
  changed) and re-requests. Two peers healing concurrently both converge. **The G13 test:** a heal
  triggered while `commit()` is pulling does not deadlock — the trigger records, `commit()` unwinds
  and releases, `recover()` runs as its own operation. **The G17 test:** admin A's commit is
  accepted, A crashes, admin B overwrites the same subject, A heals — **A's entry is not re-enacted
  and B's value stands.** **The G23 test:** a crash inside `recover()`'s own acceptance window
  converges by re-recovery, with exactly one leaf (`resync: true` collects the orphan).
- **⚠️ Wrong-but-passing:** re-enacting whatever was in flight. It passes the byzantine-fork test
  (where the entries genuinely never landed) and **silently reverts another admin's change** on the
  crash path, where the hub *accepted* the commit and the entries are already in everyone's ledger.
  `mls` does not dedup — a re-appended entry wins the fold. No error, no conflict, no signal.
- **Spec excerpt:** "**The rule is membership, not provenance:** an entry is re-enacted if and only
  if the group's authenticated ledger does not already contain it — never because of which failure
  brought the peer here."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 3.6: Does replay return its outcome without deadlocking the host?

- **Assumption:** replay at lane step 0, with `lost` delivered as a **return value**, lets the host
  respond by calling `commit()` — the one thing it will certainly do.
- **Done when:** `replay()` exists as a lane operation and every lane result carries
  `{ lost?: LostCommit }`. **The G27 test:** a host that responds to *any* lane result (`lost`,
  `reenact`) by immediately calling `commit()` **completes and does not deadlock.** **The G22 test:**
  replay runs `onAccepted` twice (crash between `onAccepted()` and `clear()`) and the invitee
  **no-ops the duplicate Welcome** rather than erroring or building a duplicate group. **The G25/G26
  test:** replay loses the CAS — a `ledger` commit's tokens are handed back and the *host* re-issues
  them (assert **the peer did not commit them itself**), and a journalled `remove` is surfaced with
  the member **still in the roster** (an admin must never believe an eviction happened when it did
  not).
- **⚠️ Wrong-but-passing:** delivering `lost` via a callback fired at step 0. Every unit test that
  inspects the event passes. The first *real* host handler — `onCommitLost: (e) => peer.commit(...)`
  — deadlocks on the mutex replay is still holding.
- **Spec excerpt:** "Delivered as a RETURN VALUE, never a callback (G27)… A callback fired under the
  lock whose documented purpose is to make the host re-enter the lock is precisely the nesting G13
  forbids."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 3.7: Does the lane outrun the mailbox and destroy downloaded messages? (G28)

- **Assumption:** an app frame is decryptable only from its own epoch's secret tree, `ts-mls` keeps
  **4 epochs by default** (`defaultKeyRetentionConfig.retainKeysForEpochs`), and a pull-driven
  commit lane that replays to head at step 0 therefore blows past the keys for every app frame
  already sitting in the mailbox.
- **Write the failing test first, against the lane as Q3.1–3.6 leave it.** A peer goes offline; the
  group makes ten commits *and* sends an app message at an early epoch; the peer reconnects. Assert
  it **reads the plaintext**. This is expected to fail before the fix — capture that, the way
  question 1.1 captured the store's failure. If it *passes* without the interleave, the premise is
  wrong and the spec needs revisiting, not the test.
- **Done when:** replay drains the mailbox up to epoch E before applying the commit that leaves E,
  and the test above passes. `retainKeysForEpochs` is raised above 4 as a safety net for live
  out-of-order delivery — **not** as the fix; assert the interleave holds with the default still in
  place, or the config is doing the work and the bug is merely postponed.
- **⚠️ Wrong-but-passing:** everything. This is the design's purest silent failure — the peer
  converges, the epoch is right, the roster matches, `head` matches, no error is raised anywhere,
  and a week of messages is simply gone. **Every single existing test still passes.** The only
  assertion that catches it is the plaintext of a message sent at an old epoch. Do not assert "no
  error"; assert the bytes.
- **Also worth knowing:** at D1's target commit volume (100/day, the whole control plane on the
  ledger), four epochs is **under an hour**. This is not a long-absence bug. A member offline over
  lunch loses its messages.
- **Spec excerpt:** "Never apply the commit that leaves epoch E while app frames at epoch E are
  still undecrypted… The lane advances the group only as fast as the consumer drains it."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

---

## Phase 4: The scenarios that only fail at the seams

Every question here is an integration test whose failure mode is **silence**. They go last because
each needs several phases working, and they are the ones that would have caught the structural
findings.

**Exit criteria:** the spec's acceptance list passes, including the two that no unit test reaches.

### Question 4.1: Does a sole-member group survive a crash on its first commit — and the calendar?

- **Assumption:** the journal, not heal, is what saves the group of size one — and it only works if
  the dedup record outlives the trim window.
- **Done when:** **G21:** the creator's `commitInvite` is accepted, the process dies before
  `onAccepted`, and there is **no other member in existence** to answer a rendezvous. It recovers
  **from the journal alone**, the invitee gets the Welcome, the group is alive. **G24:** the same
  scenario, but **the log is trimmed before the restart** — replay still returns the original
  sequenceID and the peer still adopts.
- **⚠️ Wrong-but-passing:** any heal-based recovery. There is nobody to recover *from* — the only
  prospective member is the invitee whose Welcome was never sent. A design that leans on `recover()`
  here bricks the group at creation, permanently, and every multi-member test still passes.
- **Spec excerpt:** "Detection is not recovery… the group is **bricked at creation**."
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

### Question 4.2: Do the acceptance criteria hold end to end?

- **Assumption:** the spec's acceptance list is satisfied by what Phases 1–3 built.
- **Done when:** each acceptance bullet has a passing test — concurrent admins converge with no fork
  and no lost entries; two same-device commits both land; a member invited mid-flight converges by
  pulling; a third member applies an enacting commit on first delivery with no gather; a member
  offline across several commits catches up **with no host-side backfill code**; a
  permanently-failing commit is dropped **once**; a host writes no ordering, authority, integrity or
  body-distribution code, and **no body store**.
- **⚠️ Wrong-but-passing:** asserting "no error was raised". Most of this design's failures are
  *silent* — the stranded peer reports itself healthy, the reverted entry raises nothing, the
  bricked group looks idle. **Assert state moved:** epochs advanced, entries present, rosters
  matching, members converged.
- **Verify:** `rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test`

---

## Decision Log

### 2026-07-13 — Question 1.1: Does a conformance suite written from the spec actually fail today's store?

**Findings:** Confirmed, and by a wider margin than the plan predicted — **9 of 10 clauses fail**
against the unmodified `memoryStore`, not 4. The plan's done-when list undercounted: today's store
also ignores `expectedHead` entirely, so both CAS clauses and the concurrent-CAS clause fail on
top of the four named. The one pass is legitimate: `formatSequenceID` already zero-pads to 12, so
the lexicographic-ordering clause holds. The load-bearing dedup-outlives-trim clause fails on its
own assertion (`expected '000000000002' to be '000000000001'` — there is no dedup record at all).
Every other test in the repo stays green; the type additions cascade nowhere (27/27 `test:types`).

Three of the four originally-named clauses fail on `Error: fetchTopic is not implemented` rather
than on their own assertion — **masked, not absent.** This is structural: every clause about the
log must *read* the log, and the only contract read path is `fetchTopic`, which today's store does
not have. Independent evidence over the store's existing API confirms each fails for the reason
the spec predicts: a zero-subscriber publish mints sequenceID `000000000001` for a frame that is
then unrecoverable by any read path (exactly the incoherent head the spec describes), the last ack
destroys the frame, and `expectedHead`/`publishID` are silently ignored.

**Spec impact: revision 16.** Three changes, all from things the probe found that the design had
not settled:

1. **`NotSubscribedError` is named.** The spec named only `HeadMismatchError`, so the
   non-subscriber clause could only be written as `rejects.toThrow()` — which any throw satisfies,
   *including a host's not-implemented stub*. A store with no read path at all would have passed
   that clause. Rule now in the spec: every error the contract requires a store to raise is a named
   type.
2. **`trim({ topicID, before })` replaces "trim by depth and age".** There was no trim surface on
   `HubStore` at all — only `purge({ olderThan })` — so "trim moves `oldest` and never touches
   `head`" was unassertable by any host. One primitive; depth-versus-age becomes host policy on
   top of it; the invariant is what the contract fixes.
3. **The default window drops from 90 days to 30, and becomes a first-class config knob.** The
   spec now separates *head* from *history* explicitly: the head and the dedup record are permanent
   and tiny, and they are the entire anti-fork mechanism — a hub whose log is trimmed to nothing
   still cannot fork a group. Only catch-up degrades. Frames have exactly one reader (the peer that
   fell behind), and MLS gives it two ways forward and no third: pull the log (needs only the hub)
   or heal (needs another member *awake*). So the window buys one thing — how long a member may be
   offline and still converge against the hub alone — and that, not disk, is the dial.

**Learned (1.1):** The masking is a property of the suite worth keeping in mind for the rest of Phase 1 —
against a *partially migrated* host store the suite fails loudly and precisely, but against a store
with no read path the first missing method swallows the assertion behind it. A host cannot conclude
"only `fetchTopic` is missing" from a run like today's.

Also: `unsubscribe` is a third illegal deleter nobody had noticed. `memoryStore` drops a topic's
whole message index when its last subscriber leaves (`memoryStore.ts:242-250`) — a deletion `trim`
never authorized, and no online-peer test notices. Folded into question 1.2, along with the three
existing tests that assert the old contract and must be rewritten rather than preserved.

The suite ships as a `@kumiai/hub-protocol/conformance` subpath so `vitest` stays out of the main
entry (optional peer dep). It is therefore vitest-shaped: a host on another runner cannot use it.
Accepted — no host in the stack uses anything else.

---

### 2026-07-13 — Question 1.2: Can `memoryStore` retain a per-topic log independently of delivery?

**Findings:** Yes, and the split is clean — no cascade beyond `memoryStore.ts` and its tests. The
first pass hit its prediction exactly (5 passed / 5 failed of 10); the retention model that came out
of it took the suite to 9 passed / 5 failed of 14, with the five CAS/dedup clauses still failing by
design. `hub.test.ts` passed **untouched, on the first run** — the sharpest signal available that
the mailbox is not regressed.

The trick that makes the invariant structural rather than disciplinary: **`heads` is a separate map
from the log.** Nothing that removes entries can reach it, so `head` survives trimming a topic to
empty — which the restart-replay path depends on. One removal path (`removeLogEntry`) touches the
log; `dropDelivery` cannot reach it by construction.

**Spec impact: revisions 17 and 18.** Three changes, and the first came from a question the user
asked rather than from a test:

1. **Two retention classes, not one.** The design had every topic taking the log's retention, which
   would have left app ciphertext on the hub for 30 days after every recipient acked it, and thrown
   away the mailbox's refcount GC — which is *correct* for a mailbox. `PublishParams.retain: 'log' |
   'mailbox'` (default `mailbox` = exactly today's behaviour). The reason the commit log cannot use
   ack GC is sharper than "some peers are offline": **ack GC asks "has everyone read this?" and on
   the commit topic the reader may not exist yet.** An invitee is not a subscriber at publish time,
   so no refcount over current subscribers can ever account for it — the last member acks, the frame
   dies, and the member that needed it had not been born. G7 one layer up. Equally, this is *why*
   the mailbox may keep its refcount: there, the reader set really is known.
2. **Retention duration is requested at subscribe and bounded by the hub** — `{ default, max }`, with
   `RetentionExceededError` rather than a silent clamp (a clamp strands a peer that believed it had
   asked for more). A topic's frames live for the longest retention any current subscriber asked for.
3. **G29 — `head` advances only on a log publish.** The probe found this and declined to fix it,
   correctly. `publish` was advancing `head` for every accepted publish, including a mailbox frame
   that its own last ack then frees. Every member is a subscriber of `commitTopic`, so **any member
   could move the head to a frame that then vanishes** — peers pull, never see that sequenceID, their
   cursor can never reach the head, and the next CAS anchors on something unfetchable. The lane
   wedges for the entire group, permanently, and nothing raises. G19's shape reached through the
   store instead of the heal trigger, and it would have been load-bearing under question 1.3.

**Learned:** the wrong-but-passing frame keeps paying out, but the *finder* is shifting. G7 was
caught by writing a suite the store had to fail; G29 was caught by an implementer noticing that a
field meant two things. Both are invisible to any test written from the happy path.

The most quotable line in the report is §6.3: **every pre-existing test that could have caught the
old retention bug asserts through `store.fetch` — the mailbox.** The entire suite was blind to
whether the log survives. Only the three tests we had to rewrite reached past `fetch`, and they
reached past it to assert *the bug*.

Two open items, accepted rather than solved: the suite asks a host to **declare** its `maxRetention`,
so a host declaring `Infinity` passes the refusal clause vacuously (the suite can check the boundary
a host declares, not that it declared a sane one); and retention follows *current* subscribers rather
than a high-water mark, which is safe only because the commit lane never unsubscribes — now stated in
the spec, because it is a load-bearing assumption that reads like an implementation detail.

---

### 2026-07-13 — Question 1.3: Is the CAS atomic, and is `sequenceID` ordered?

**Findings:** Confirmed. 13 passed / 2 failed of 15 — the three CAS clauses flip green, the two
`publishID` dedup clauses stay red for question 1.4. The CAS is the **first** thing `publish` does,
above `counter++`, so a loser is not a rollback: there is nothing to roll back. No entry, no
delivery row, no sequenceID burned. "Stores nothing" ends up structural rather than a cleanup path
that could be forgotten.

**The suite caught itself.** G29 (from question 1.2) had silently broken three CAS clauses: they
published *mailbox*-class frames, which no longer move the head — so the `null`-sentinel clause
**would have passed for the wrong reason**. Head stays `null` forever, so a second
`expectedHead: null` publish is legitimately accepted, and the clause proves nothing. It only became
a real test once told to publish `retain: 'log'`. A clause passing for the wrong reason is precisely
what this suite exists to prevent, and it happened *inside the suite*.

**Spec impact: revision 19.** Two additions, both about defects the suite **structurally cannot
catch**:

1. **G30 — "one transaction" is necessary and not sufficient.** On `READ COMMITTED` — the default in
   both Postgres and MySQL — a `SELECT head …` inside `BEGIN` takes **no lock**. Two transactions
   read the same head, both pass the comparison, both commit, and both frames land. The host obeyed
   the contract to the letter and forked the group anyway. The contract now requires a **conditional
   write** (`UPDATE … WHERE head = :expected` plus an affected-row-count check) or a locking read, and
   says plainly that **a read followed by a write is not a compare-and-set, however many `BEGIN`s wrap
   it.**
2. **An in-process sequence counter passes all 15 clauses — and it is what kubun mints today.** The
   suite drives one store object in one process, where a lazily-seeded counter is monotonic and
   unique. Two hub processes on one database mint the *same* sequenceID for different frames, both
   CAS successfully against the same head, and the lane forks.

Both are now in "Host-side impact" as a **DDL review item, not a test**, under a sentence that says
what the whole phase has been circling: *a host that reads a fully green conformance run as proof its
store is sound is wrong.*

**Learned:** the conformance suite has a hard ceiling, and naming it is worth more than extending it.
Everything that needs **two processes against one database** — the counter collision, the
read-then-write CAS — is invisible to an in-process suite and will pass every clause forever. The
concurrent-CAS clause now opens its doc comment with "READ THIS BEFORE TRUSTING A GREEN RUN OF THIS
CASE" and states that a non-transactional three-statement store passes it every time. A vacuous
clause that announces its vacuity is useful; one that stays quiet is worse than no clause at all,
because a host reads green as proof.

---

### 2026-07-13 — Question 1.4: Does the dedup record outlive the log?

**Findings:** Confirmed — **15/15**, and the claim was *verified rather than asserted*. The probe
built the wrong store (dedup key hung off the message row) and watched it score **14/15**, failing
exactly and only the load-bearing clause, with:

```
HeadMismatchError: expected head null, but the head is 000000000002
```

That is the bricked-group walkthrough reproduced mechanically. The clause does not merely detect a
missing row — it prints the fatal path. Full repo green for the first time since question 1.1.

Structural again, and by the same trick that made `heads` right in 1.2: the dedup record is keyed by
`publishID`, and **every deleter in the store is keyed by sequenceID, with no index running back the
other way.** `removeEntry`, `trim` and `purge` *cannot* reach it. The dedup check is the first thing
`publish` does — above the CAS and above the mint — because a replay carries both a known
`publishID` and a now-stale `expectedHead`, and in the other order the store raises
`HeadMismatchError` and **the caller concludes its commit was lost when it actually landed.**

**Spec impact: revision 20.**

1. **G31 — two tables reference `messages`, and exactly one of them may cascade.** Delivery rows
   **must** `ON DELETE CASCADE` (question 1.2's finding). The dedup record **must not** — that
   cascade *is* the row-hung store, and a host that writes the symmetric, tidy-looking schema has
   rebuilt it **while believing it had separated them**, passing fourteen of fifteen clauses on the
   way. The natural thing is the fatal one, so the spec names it rather than leaving it to review.
2. **The dedup record and the log entry are written in one transaction.** A crash between them
   either bricks the group (frame committed, record lost) or — worse and silently — leaves a record
   for a frame that never existed, so a replay returns a sequenceID for a publish that never landed
   and the caller **marks a lost commit as accepted.**

**Phase 1 exit: 2 of 3, and the third criterion is withdrawn rather than passed.** The suite
demonstrably fails a delivery-derived store and a row-hung dedup record — both watched failing, not
assumed. It **cannot** catch an in-process sequence counter, because it drives one store object in
one process where a lazily-seeded counter is monotonic and unique; kubun's current shape passes all
fifteen clauses and breaks only across two hub processes on one database. The plan's exit criterion
has been restated to say so.

**Learned:** the highest-value output of this phase was not the store — it was **three defects the
suite structurally cannot catch** (in-process counter, read-then-write CAS on `READ COMMITTED`, and
the cascading dedup FK), each of which passes a fully green run. Every one of them is silent, every
one forks or bricks a group, and every one is a schema review rather than a test. A conformance suite
that knows and states its own ceiling is worth considerably more than one that implies it has none.

---

### 2026-07-13 — Question 1.5: Does `fetchTopic` read the log, gated on subscription?

**Findings:** Confirmed, end to end. `hub/topic/fetch` is the new procedure; `retain`,
`expectedHead` and `publishID` thread through publish, `retention` through subscribe; the three
errors cross the wire as `HUB_HEAD_MISMATCH` / `HUB_NOT_SUBSCRIBED` / `HUB_RETENTION_EXCEEDED`, and
`hubErrorFromCode` rebuilds the named class client-side — returning `null` for anything without a
hub code, which is exactly what a transport failure is. So the peer lane can distinguish "I lost the
CAS, rebase and retry" from "the hub is down", which its whole retry loop turns on. Integration
23/23, full repo green.

**The five wire fields are proven, not assumed.** Each was deleted and the resulting failure
recorded. Dropping `retain` fails 3 of 6 integration tests and the zero-subscriber pull returns `[]`
— the entire phase silently reverting to a mailbox, exactly as predicted. Dropping `publishID`
reproduces the restart-replay brick end to end: `expected head null, but the head is 000000000001`.

`subscriberDID` was a non-finding, and the good kind: every existing handler already derives the
caller from the verified `iss` of the signed message, so the new one does too. The protocol test now
asserts `subscriberDID`'s **absence** from the wire schema — it cannot be named by a caller.

**Spec impact:** none. Two notes folded into question 3.1 instead, both found by wiring rather than
by testing:

1. **A log publish is pushed *and* retained** — an online peer sees each commit twice, once down
   `hub/receive` and once by pulling. Consistent with the design (the lane drives by pull; push is a
   wakeup), but a lane that also processes the pushed copy passes every single-peer test and breaks
   the moment two peers are online.
2. **`hub/receive`'s `after` and `hub/topic/fetch`'s `after` are both `string` and mean different
   things** — a delivery-queue position versus a log position. A peer holding one "cursor" and
   feeding it to both silently mis-pages.

**Learned:** `expectedHead: null` and *absent* are different requests — conditional-at-empty versus
unconditional — and spreading `params.expectedHead` straight through would have made **every mailbox
publish a conditional publish against `undefined`**. The optional-field-that-means-something-when-
null is a shape worth watching for wherever this design uses one.

`fetchTopic` was deliberately **not** added to `hub-tunnel`'s `HubLike`: that is the tunnel's mailbox
abstraction, with four implementations and no consumer for a log — the peer lane pulls through
`hub-client`. A two-line addition if Phase 3 turns out to want it.

---

## Phase 1 exit

**Met, with one criterion withdrawn rather than passed.**

- `hub-protocol` exports a conformance suite (`@kumiai/hub-protocol/conformance`), 15 clauses.
- `memoryStore` passes all 15, and the whole surface is reachable over the wire.
- The suite **demonstrably fails** the two wrong stores — both were built and watched failing, not
  argued about: a delivery-derived store (9 of 10 red at the time) and a row-hung dedup record (14
  of 15, failing exactly the load-bearing clause with the bricked-group error printed).
- **Withdrawn:** "the suite fails a store that mints sequenceIDs in-process." It cannot, and no
  in-process suite can. Now a DDL review item in the spec's host-side impact.

**What the phase actually produced.** The store was the smaller half. The larger half is four
defects that a fully green conformance run does not catch, every one of them silent, and every one
of them forking or bricking a group:

- **G29** — `head` advancing on a mailbox publish lets *any member* wedge the lane for the whole
  group, permanently. Found by an implementer noticing a field meant two things.
- **G30** — "one transaction" is necessary and not sufficient: on `READ COMMITTED`, a host that
  obeys the contract to the letter still forks. Needs a conditional write, not a read-then-write.
- **G31** — two tables reference `messages`; the delivery rows **must** cascade and the dedup record
  **must not**. The symmetric, tidy-looking schema is the fatal one.
- **The in-process counter** — passes all 15 clauses; breaks across two hub processes on one
  database. Kubun mints this today.

A conformance suite that states its own ceiling is worth more than one that implies it has none.
Three of those four are now written into the spec as host review items, because a host reads a green
suite as proof.

---

### 2026-07-13 — Question 2.1: Does a commit really rotate the committer's leaf HPKE key?

**Findings: yes — confirmed, and the strandedness is total.** `packages/mls/test/leaf-key-rotation.test.ts`
(new; **zero `src/` changes** — a read-only verification probe, as intended). Two tests, both green;
full verify green (27/27 tasks, `mls` 267/267).

The committer's post-commit leaf key differs from its pre-commit one, and the pre-commit private key
**fails to open** a seal made to the key the responder can see. Soundness of the seal was checked
too: the *dropped* post-commit private key **does** open that same ciphertext, so the failure is the
stale key and not a malformed seal. The negative control fires as predicted — a non-committing
member's leaf is **byte-identical** after someone else's commit, and its held private key opens its
seal fine. That asymmetry is exactly what let the flaw survive three spec revisions, and it is now
pinned by a test rather than by an argument.

In ts-mls: the new leaf key is drawn from **fresh randomness** (`updatePath.js:26`), not from the
group key schedule — so nothing the committer still holds predicts it. Its private half is
transmitted to **no one, ever** (`updatePath.js:60`: *"we have to remove the leaf secret since we
don't send it to anyone"*). And it lands **only** in the returned `newState` (`createCommit.js:85-90`)
— `createCommit` never mutates the state it was given, so a committer that dies before adopting the
handle has destroyed the key while the group has already moved to the matching public one. Three
doors, all closed.

**Spec impact: revision 21 — G32.**

> **"Every commit carries an UpdatePath" is false about MLS, and true about kumiai only through a
> coupling nobody had written down.**

RFC 9420 §12.4 lets an **Add/PSK/ReInit-only** commit omit the path entirely, and ts-mls implements
exactly that (`needsUpdatePath`, `clientState.js:443-447`). Such a commit rotates **nothing** — not
even its author's leaf. Every commit this codebase can currently build *does* carry a path, but only
because each routes through `commitWithEntries`, which appends a `group_context_extensions` proposal
advancing the ledger head: `commitLedgerEntries` refuses an empty token list, `createInvite` always
appends a role token, `removeMember` carries a remove. So `commitInvite`'s "always appends a role
token" is a **precondition of the recovery design**, not an implementation convenience. A future
caller who hand-builds an `Invite` with empty ledger entries gets an Add-only, path-less commit whose
author's leaf does not rotate — silently reversing D2's table for that commit, with nothing in the
old phrasing to warn them. Folded into D2; the assertion belongs on `commitInvite` when D2 lands.

**Learned:** the premise was true, but *the sentence stating it was not* — the design was right for a
reason narrower than the one it gave, and the narrower reason is a property of **our** call graph
rather than of MLS. That is the same shape as every other defect this plan has found: a claim the
obvious implementation satisfies while being wrong. Had we built D2 on the stated reason and someone
later added a path-less commit, the recovery design would have broken with every test still green.

Two traps carried into Q2.2, both written into the question: (1) **the first rejection you hit is the
wrong one** — a commit fed back to a handle with no `resolveLedgerEntries` resolver fails at the
*ledger policy*, long before MLS is reached, and a recovery test written that way passes for a
shallow reason (the probe's own first draft did exactly this and caught itself); (2) **a stale
committer cannot even apply its own commit** — ts-mls *throws* `No overlap between provided private
keys and update path`, because the author's subtree is excluded from every path secret's recipient
set. There is no "just re-feed it the commit it sent" fallback. A fresh leaf is the only way back.

---

### 2026-07-13 — Question 2.2: Can GroupInfo be sealed to a requester-supplied ephemeral key, authorized by the roster?

**Findings: yes — all six clauses hold.** `packages/mls/src/recovery.ts` (three primitives) and
`packages/mls/test/recovery.test.ts` (nine tests, green). Full verify green; `mls` 276/276, 27/27
tasks. The stranded committer — the peer leaf-sealing cannot serve, per question 2.1 — **recovers,
rejoins via `joinGroupExternal`, and resumes two-way traffic.** Over the X25519 HPKE already in
`crypto.ts` and the `@kokuin/token` scheme the ledger already uses: no second HPKE, no second
signature scheme, no `GroupMLS` port built.

**The primitives came out tighter than the spec wrote them, in the direction that matters.** Three
deviations, each one deleting a way a caller could hold it wrong rather than adding a check:

- **The recipient key is not a parameter.** It lives inside the signed request, so `sealGroupInfo`
  takes `{ group, request }` and nothing else. "Seal to the key passed alongside the request" is
  **unrepresentable**, not merely avoided.
- **There is no `requesterDID` field** — it is the verified `iss`. The DID a request names and the
  DID whose key signed it cannot come apart, so no code has to remember to compare them.
- **`openSealedGroupInfo` rebuilds the AAD from the caller's own handle.** There is no DID to pass,
  hence no wrong DID to pass. The binding is an **AEAD failure**, not a comparison after decryption:
  in the replay test Carol is handed *the ephemeral private key itself* and still gets nothing. Had
  it been compare-after-decrypt she would have **decrypted the ratchet tree** and then been told not
  to look.

A fourth refusal was added that the spec did not list: **a request naming another group**. Without
it, a responder in two groups seals *this* group's state in answer to a request authorized against
*another* — signature and ephemeral key both checking out.

**The probe mutation-checked the two clauses that could pass shallowly.** Deleting the roster check
makes the non-member test fail; stripping DID + requestID from the AAD makes both replay tests fail
(the replayed reply *opens*). Both reverted. The refusals bite — which is the standard this plan
holds a test to, and the reason it is worth stating rather than assuming.

**Spec impact: revision 22.** D2's primitive block replaced with what shipped, plus the two
properties building it made visible:

1. **The roster check goes stale, by design.** A responder's tree is as fresh as its last applied
   commit, so **a responder lagging a removal still answers the removed member**. Bounded by one
   commit's propagation; the reply is sealed to *her* ephemeral key so no eavesdropper benefits; and
   `joinGroupExternal`'s resync needs a prior leaf the removing commit took away, so she gets a
   GroupInfo she cannot rejoin with, describing an epoch she was entitled to as a member anyway.
   **Liveness/PCS, not confidentiality** — but undocumented it reads as a hole, so it is now written
   down and asserted as a test.
2. **The ephemeral private key's lifetime is an unenforced host obligation.** The host retains a raw
   `Uint8Array` keyed by `requestID` **across the crash it exists to recover from** — so in the
   general case it must be *persisted*, which is a new secret at rest. Nothing zeroes it, expires
   it, or stops `requestID` reuse, which would give two replies the same AAD and collapse the
   per-request binding. Three rules now on the spec: persist it as a secret, drop it on consume or
   abandon, mint `requestID` randomly.

Also noted for the roster: authorization is `findMemberLeafIndex` over the **MLS ratchet tree**, not
`roster.ts` — which folds the *ledger* into role permissions and can hold a role for a DID with no
MLS membership at all. The naming invites the wrong one.

**Learned:** the strongest refusals in this design are the ones with no parameter to get wrong. Every
deviation the probe made was of that shape — not "add a check" but "remove the input that made the
check necessary." The AEAD-vs-compare-after-decrypt choice is the sharpest instance: both forms pass
the same test, and only one of them declines to decrypt the ratchet tree first.

**Unrelated defect fixed in passing (a real bug, not the flake we assumed).** `ledger.test.ts:169`
flipped the **last** base64url character of an Ed25519 signature. A signature is 64 bytes = 512 bits,
which base64url encodes in 86 characters = 516 bits — so the final character carries **4 padding
bits**. A flip landing only in the padding decodes to the identical signature bytes and verification
legitimately succeeds. The test's premise was false for roughly one token in four. It reproduces on a
clean tree, in isolation, at about 1 run in 5 — it was never load-related, and two earlier probes had
recorded it as a parallel-load flake on my say-so. Now flips the *first* signature character, which
carries six significant bits; ten consecutive runs green.

---

### 2026-07-13 — Question 2.3: Does head-verified ledger bootstrap reject a doctored ledger?

**Findings: yes — rejected, and nothing folded.** `packages/mls/src/group.ts` (`isLedgerComplete`,
`getLedger`, `bootstrapLedger`), `packages/mls/src/head.ts` (`headsMatch`, the predicate form of the
comparison `assertHeadMatches` already made), `packages/mls/test/ledger-bootstrap.test.ts` (seven
tests, green). Full verify green: `mls` 283/283, 27/27 tasks, `test:types` included. No second head
computation was written — `computeHead` / `assertHeadMatches` wired onto the rejoin path unchanged,
and `processWelcome`'s existing call is byte-identical.

**The attack was demonstrated before it was defended against**, which is the only way to know the
test means anything. The doctored ledger is built *honestly*: a real group, real invites, Bob
genuinely promoted to admin and genuinely demoted back — then the lying responder returns that real
ledger with the demotion **dropped**. No token is forged; the test asserts every token verifies, is
scoped to the group, and is signed by the real admin. It then folds that ledger the way a
signature-verifying implementation would, and shows the result:

```ts
expect(folded.roster.roles.get(normalizeDID(bob.id))).toBe('admin')   // the demoted admin, back
```

Against `bootstrapLedger` it throws `LedgerIncompleteError`, and the roster is asserted
**exhaustively** — `toEqual` over the whole entry list, not "Bob is not admin" — because a
fold-then-check implementation throws in exactly the same place and differs only in what it left
behind. Reorder variant: same four tokens, two transposed, every signature still valid, rejected.

**The mutation check is the finding, not a formality.** Replacing the head check with signature-only
verification — which is *literally deleting the assertion*, since the per-token verify loop below it
already is the wrong implementation:

```
 × rejects a genuinely-signed ledger with one demotion omitted, and folds nothing
   → promise resolved "undefined" instead of rejecting
 × rejects a reordered ledger — every entry present, every signature valid
   → promise resolved "undefined" instead of rejecting
 ✓ accepts the honest ledger and rebuilds the roster the group actually has
 ✓ an empty-ledger peer rejects the promoted admin's commit; a bootstrapped one applies it
```

**Read which tests still pass under the mutation.** The honest path and the liveness test cannot
distinguish the two implementations. Only the head check does — which is exactly why neither could
stand alone, and why the plan demanded both. Under the mutation the bootstrap does not merely fail to
throw: a throwaway probe confirmed it **installs the doctored roster**, demoted admin back as
`admin`.

**Check-before-fold is structural, by data dependency rather than statement order.** The fold builds
locals only; the handle is mutated in one block of three assignments at the tail, every one consuming
a local built *after* the gate. They cannot be hoisted above the check without failing to compile.

**`isLedgerComplete()` is local and not vacuous.** The genesis-only group reads `true` against a real
32-byte digest bound to the group id (`SHA-256(DOMAIN ‖ groupID)`) — asserted unequal to another
group's genesis head and to the zero buffer, so "complete" is never "both sides are empty in
different ways". A suppressed head extension reads `false` (fail-safe, into bootstrap, which throws
loudly). The test wires a call-counting resolver and asserts the count does not move: no peer, no
network.

**Spec impact: revision 23.** Two host obligations the types do not carry, both folded into D2's
bootstrap block:

1. **The handle mutex is not reentrant, and all three methods take it.** `resolveLedgerEntries` and
   `onLedgerEntries` fire *inside* `processMessage`'s critical section, so a host calling
   `getLedger()` or `isLedgerComplete()` from one of those callbacks **deadlocks**. They take the
   mutex deliberately: `applyLedgerEntries` awaits per-token verification inside its own critical
   section, so a lock-free read can observe a **half-applied ledger** — a torn `getLedger()` would be
   served to another peer and fail *its* head check.
2. **A responder must gate its gather reply on `isLedgerComplete()`**, or a rejoined peer that has
   not yet bootstrapped answers with its **empty** ledger. The requester's head check rejects it, so
   it is a wasted responder rather than a soundness hole — but a wasted responder precisely when
   responders are scarce.

Also recorded: `bootstrapLedger` **replaces** the ledger rather than appending, and so cannot reuse
`applyLedgerEntries` — which appends, and which *silently drops* an unverifiable token. Permissive is
right for the low-level primitive and wrong for a gate. Bootstrap fails closed.

**Learned:** the liveness test earns its place by *failing to distinguish* — it passes under the
wrong implementation, and that is the point. Its job is to stop the opposite mistake: a
`bootstrapLedger` that throws on everything passes the security test perfectly. The two tests are a
pair, and either one alone is a design that looks defended and is not.

---

## Phase 2 exit

**Met.** The exit criteria were: sealing works for a peer whose leaf key rotated; bootstrap rejects a
doctored ledger; the completeness invariant is computable locally. All three, and each proven against
the implementation that would have passed a naive test:

- **Sealing.** The stranded committer — the peer whose commit the hub accepted and who then died
  before adopting it — recovers, rejoins, and resumes two-way traffic. Leaf-sealing cannot serve that
  peer, and question 2.1 proved *why* before question 2.2 built the alternative: the leaf key is
  fresh randomness, sent to nobody, living only in a returned handle the crash destroyed.
- **Bootstrap.** A genuinely-signed, correctly-scoped ledger with one demotion omitted is rejected
  with nothing folded, and the same test **fails** against signature-only verification.
- **The invariant.** Local, non-vacuous, consults no peer.

**What the phase produced beyond the code.** Phase 1's lesson was that a green conformance run hides
defects; Phase 2's is narrower and sharper: **the design was right for reasons narrower than the ones
it gave.**

- **G32** — "every commit carries an UpdatePath" is *false about MLS*. An Add-only commit rotates
  nothing. D2's premise holds in kumiai only because every commit routes through `commitWithEntries`
  and appends a ledger-head proposal — a coupling nobody had written down, and one a future
  hand-built `Invite` with no entries would break silently, reversing D2's whole table for that
  commit.
- **The refusals with no parameter to get wrong.** Every deviation question 2.2 made from the spec's
  pseudo-signatures was of one shape: not "add a check" but **"remove the input that made the check
  necessary."** The recipient key lives inside the signed request, so sealing to an unsigned key is
  unrepresentable. There is no `requesterDID` field, so the named DID cannot disagree with the
  signing key. `openSealedGroupInfo` rebuilds the AAD from the caller's own handle, so there is no
  DID to pass and no wrong DID to pass — and the replay refusal becomes an **AEAD failure** rather
  than a comparison after decryption. Both forms pass the same test; only one declines to decrypt the
  ratchet tree first.
- **Two properties that read as holes until written down**: the roster check goes stale (a responder
  lagging a removal still answers the removed member — bounded, liveness not confidentiality), and
  the ephemeral private key's lifetime is an unenforced host obligation *across the very crash it
  exists to survive*, which likely means persisting a new secret at rest.
- **A real test bug, mistaken twice for a flake.** `ledger.test.ts` flipped the last base64url
  character of an Ed25519 signature — 4 of whose 6 bits are padding — so one token in four decoded
  unchanged and verification correctly succeeded. It failed about one run in five, on a clean tree,
  in isolation. Two probe briefs had told the next probe to ignore it as parallel-load noise. The
  third one looked.

**Mutation-checking became the phase's standing practice**, and it paid twice: deleting the roster
check, stripping the AAD binding, and replacing the head check with signature verification each made
the corresponding test go red — and in two of the three, the wrong implementation did not merely fail
to refuse, it **installed the attacker's state**.
