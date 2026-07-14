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
- **Carried from question 3.2 — most of the inversion is already built.** D3 could not be built on
  apply-then-announce (the bodies are sealed under the epoch the commit is *framed* at, so a
  committer that already adopted can seal them for nobody), so `localCommitted` is already
  `(commit, { ledgerEntries, adopt })`: seal → publish → `adopt()` → rebuild, erroring if the host
  adopted first. **`adopt` is `onAccepted`; `ledgerEntries` is `PendingCommit.bodies`.** Absorb it
  into `commit(build)` — do not re-derive it.
- **Carried from question 3.2 — a decision to make deliberately, not by accident.** *Does the journal
  hold the bodies or the sealed frame?* Replay can only **re-seal** the bodies if the peer is still
  at the pre-commit epoch — which it is, because adoption happens in `onAccepted` and a crash before
  acceptance means no adoption. **But that holds by an argument, not by construction.** Journalling
  the **sealed frame** makes it hold by construction, at the cost of a journal holding ciphertext it
  cannot re-key. Pick one on purpose and say why.
- **Carried from question 3.1 — this question owns it.** *The pull hands a peer back its own commit
  frames; push never did.* The hub excludes a sender from its own delivery, but a **log is not
  delivery-filtered**, so the committer reads its own frame back and would apply a commit it has
  already applied. 3.1 holds it off with an in-memory `selfCommitted` set keyed on the sequenceID
  the publish returned — **which does not survive a restart.** A peer that crashes between
  publishing and recording re-applies its own commit on restart. **The journal must replace that
  set**, and the test is: publish, kill the peer before it records, restart, pull — the commit is
  applied exactly once.
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
- **Carried from question 3.2 — the failure next door, and worse.** *The port must not **throw** on
  an inapplicable frame.* The lane's rule is "a throw leaves the cursor put and the frame is read
  again". So a `GroupMLS` adapter that lets ts-mls throw on a commit from an epoch it is not at
  **wedges the late joiner on its own add-commit forever.** The adapter must return
  `{ advanced: false }` for a frame it cannot apply, and throw **only** for one it *should* have been
  able to apply and could not (the resolver miss). This table is where that line gets drawn
  explicitly.
- **Carried from question 3.2 — the one place tempted to grow a `console.warn`.** A peer never learns
  that a blob failed to open: the resolver swallows the failure into "no entries", and there is no
  channel by which it can be surfaced as corruption. When this question adds diagnostics, **that
  catch must stay silent** — a blob this peer cannot open is ordinary history.
- **Carried from question 3.1 — a real hole, currently invisible.** *A recovered peer will re-apply
  the stale commits still in the log.* After `applyRecovery` jumps it to epoch M, its
  `reconciledHead` is unchanged, so the next pull walks frames from epochs it has already passed.
  The spec's answer is the second row of this table — *dropped, and the cursor still advances* — but
  nothing classifies a stale-epoch frame yet, so today it would **double-advance**. **No existing
  test catches this, because the recovery tests have no commit frames on the topic.** That test is
  part of this question: recover, then pull a log that still holds the commits you skipped, and
  apply none of them.
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
  replay runs `onAccepted` twice (crash between `onAccepted()` and `clear()`) and the duplicate
  Welcome is **absorbed by the invitee** — `processWelcomeOnce` returns `null` for a group it already
  holds, and the member's live handle stands. Plain `processWelcome` does NOT absorb it: it silently
  builds a second group state at the joining epoch, which is the defect the safe path removes. **The G25/G26
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

---

### 2026-07-13 — Question 3.1: Does the pull-driven commit lane seed and catch up correctly?

**Findings: yes.** `rpc` 77/77 (was 68); full verify green, integration 23/23. The topic split lands
(`commitTopic` / `rendezvousTopic`, both non-rotating, both subscribed for the peer's whole life),
the peer subscribes-then-pulls, and **push is a wakeup only** — the delivered message is bound to
`_message` and never read.

**The late joiner converges by pulling.** A member joins at epoch 1, two commits land before it
subscribes, and it reaches epoch 3 having applied both — **once each** — with **zero recovery
requests** on the wire. (There is no fork/heal diagnosis surface to assert on yet; that is 3.4. So
the assertion is against the wire — no `recover()` — plus an exact commit count, which catches both a
spurious heal and a double-apply.)

**Both wrong implementations were built and watched failing.**

- *Head-seeded cursor* (the obvious one — the head is right there in `fetchTopic`'s reply):
  **75 of 77 still pass.** Every online-peer test is green; only the two late-joiner tests fall, with
  `expected 1 to be 3` — the joiner stranded at the epoch it was invited at, CAS-ready against a head
  whose commits it never applied.
- *A lane that also processes the pushed copy*: `expected 2 to be 1` — every commit applied twice, by
  every online receiver. This is the trap question 1.5 predicted: an accepted `retain: 'log'` frame is
  pushed **and** retained, and the store excludes the sender from its own delivery, so a lane that
  processes the pushed copy **works perfectly in every single-peer test**.

**The two cursors are branded apart, and the type system enforces it.** `LogPosition` and
`DeliveryPosition` are distinct branded strings. `reconciledHead = message.sequenceID` on a pushed
frame **does not compile**; minting a `LogPosition` requires `asLogPosition`, which appears in exactly
two places, both fed from a log source. The probe volunteered that it would not have got this right
without the warning — the two `after` fields are both `string` and mean different things.

**One existing test encoded the contract this question replaces.** `peer-handshake-replay.test.ts`
asserted `hub.ackedCount('bob')` **as the mechanism**: the peer got its missed commits *because the
hub redelivered unacked frames*, and avoided reprocessing *because it had acked*. That is precisely
the "do not ack, so the hub redelivers" retry the spec removes. Rewritten so the **cursor**, not the
ack, is what makes a redelivery a no-op — and the `ackedCount` assertions are gone, because asserting
on them would re-encode the old contract. Same shape as phase 1's three tests that *asserted* the
forbidden behaviour. Three more tests were retargeted at the split topics.

**A live bug in our own fixtures, exposed by the log.** Both fake hubs minted sequenceIDs as bare
decimals — `"10" < "9"`. Harmless for a mailbox; **fatal for a log**, whose `after` is an exclusive
cursor compared lexicographically, so the pull would skip or re-read frames past the tenth commit.
This is G30's sibling — the defect the store contract's ordering clause exists to prevent — sitting
in the test doubles that were supposed to be checking for it. Both now zero-pad to 12 like the real
store.

**Spec impact: revision 24 — the hub port splits.** `HubLike` was named for a resemblance and was
doing two jobs: it named *the hub a host wires into a `GroupPeer`*, which must serve a log or the
group cannot work at all, and *the mailbox-shaped adapter views built inside `rpc`* — the mux's
fan-out view, the sealed directed lane, the session tunnel, the encrypted app transport — which are
**not hubs**, never carry a commit, and have no log to serve.

The probe first made `fetchTopic` **optional**, with the peer refusing at init. That works and is
testable, but it makes the type say *a hub may or may not serve a log*, which is false of every hub a
peer is handed, and leaves a runtime check standing in for a distinction the types can draw. So:

```ts
export type MailboxHub = { publish; subscribe; unsubscribe?; receive; events? }
export type LogHub = MailboxHub & { fetchTopic(params): Promise<HubFetchTopicResult> }
```

`GroupPeer` takes a `LogHub`. Handing it a mailbox-only hub is now a **compile error at the host's
wiring** — the only place the mistake can be made. The runtime refusal is deleted, and its test
became a type-level one, mutation-checked the same way: making `MailboxHub` assignable to `LogHub`
fails the build with `TS2578: Unused '@ts-expect-error' directive`.

**And the finding that confirms the cut: none of the four adapters needed a log.** Not one gained a
method; all are unchanged in substance. The optional `fetchTopic` existed *only* because they could
not satisfy a required one, and none of them ever wanted it.

**Learned:** an optional field on a port is often a type-level distinction nobody drew. The tell here
was that the option was never a real choice — every hub a peer is handed serves a log, and everything
that doesn't is not a hub. When the "optional" case and the "required" case have no overlap in who
implements them, they are two types.

**Two gaps carried forward, both written into the questions that own them:**

1. **The pull hands a peer back its own commit frames; push never did** — a log is not
   delivery-filtered. Held off with an in-memory `selfCommitted` set that **does not survive a
   restart**. Question 3.3's journal must replace it, with the test: publish, kill the peer before it
   records, restart, pull, and apply the commit exactly once.
2. **A recovered peer will re-apply the stale commits still in the log** — after `applyRecovery`
   jumps to epoch M the cursor is unchanged, so the next pull walks frames from epochs already
   passed. Dropping them needs stale-epoch classification, which is question 3.4's table. **No test
   catches it today because the recovery tests have no commit frames on the topic** — a real hole,
   currently invisible. 3.4 now owns it, and owns writing that test.

---

### 2026-07-13 — Question 3.2: Do bodies ride the commit frame, and is classification before unwrap?

**Findings: yes, both.** `rpc` 93/93 (77 → 93: +7 codec, +5 lane, +4 port; none removed). `mls` 283,
integration 23, build and lint clean.

**The three-member test lands with no gather.** An admin enacts an entry, the third member has never
seen the body, and it applies the commit on **first delivery**. The no-gather assertion is over the
wire: `asksOnTheWire` is *every message any peer published on any topic that is not the commit
topic* — an app-lane gather, a rendezvous request, a directed ask, all of them land in it — and it
must be empty. With "the commit topic carries exactly one frame", the entire cost of enacting an
entry a member had never seen is **one commit**. A `leakedBody` scan over every published payload
confirms the hub carried the body and never saw it.

**The mutation check is the sharpest of the plan so far: 92 of 93 pass.** Unwrap-in-parse — decode
the frame, and you have a commit and some bodies — passes the three-member deliverable, every
catch-up test, every reconnect test, every lifecycle test. The cursor advances on both rows, so
nothing stalls and nothing diverges. One test fails:

```
1. a late joiner walks the commit that added it — a frame it can never open — and calls none of it malformed
   AssertionError: expected 1 to be 2
```

That is `seen()`: Dave was handed **one** commit instead of two. **The frame that created him never
reached MLS** — it was caught and logged as malformed, because its blob is sealed under the epoch
before he was a member. Every number a user or a test would look at is **identical**: his epoch, his
ledger, his commit count, the absence of a heal. The only trace of the lie is in the log — which is
exactly the day it costs someone.

`seen()` is what gives the test teeth: the double now counts *every commit the lane handed to
`processCommit`* separately from *the ones it applied*, and a frame dropped as malformed reaches
neither. Nothing else in the peer's observable state distinguishes the two implementations.

**Two test doubles were made faithful about the thing the question turns on.** `FakeCrypto` is now
epoch-keyed — `unwrap` **throws** for bytes sealed under any other epoch — and `MemoryGroupMLS`'s
commits are epoch-framed. "Cannot open" became a real property rather than a claim, and every
pre-existing commit-lane test got strictly stronger. (Nothing in `peer.ts` looks at an epoch: that is
modelling, not classification.)

**Parse and unwrap are kept apart structurally — and the probe is honest about where that stops.**
The codec module has **no crypto in scope**: `decodeCommitFrame` reads a `u32` and takes two
subarrays, and *cannot* decrypt anything. The blob leaves the lane as a **resolver, not a value**, so
it is opened only if the port asks, and the port asks only while applying a commit — at the epoch the
blob is sealed under. A blob that will not open yields **no entries, not an error**, so there is no
code path on which a failed decryption *can* be reported as corruption. What is not structural:
nothing stops a future edit from `await`ing that resolver eagerly in `pullCommits`. The test holds
that line; the type system does not.

**Spec impact: revision 25 — D3 forces D1's commit-path inversion, and it could not be deferred.**

The bodies are sealed under the epoch the commit is **framed at**, and the receiver resolves them
*before* it applies the commit (mls's pre-pass runs ahead of `mlsProcessMessage`). **A committer that
has already adopted its own commit has rotated past that secret and can seal the bodies for nobody.**
So `localCommitted(commit)` — "a Commit the consumer just produced *and already applied locally*" —
is not a contract bodies can ride on. It is now `localCommitted(commit, { ledgerEntries, adopt })`:
seal, publish, `adopt()`, rebuild — with a **hard error** if the host adopted first, rather than
silently publishing a blob nobody can open. That is D1's `commit(build)` seen from the other end:
`adopt` **is** `onAccepted`, and `ledgerEntries` **is** `PendingCommit.bodies`. Question 3.3 absorbs
it rather than re-deriving it.

**Learned:** two decisions the spec presents as separable — "bodies ride the frame" (D3) and "the
commit path inverts" (D1) — are one decision. The proof is mechanical: the seal needs the pre-commit
epoch secret, and adoption destroys it. Writing them as separate sections is what allowed
`localCommitted`'s apply-then-announce contract to survive fourteen review passes while being
incompatible with the body design two sections down.

**Three things handed forward, all written into the questions that own them:**

1. **3.4 — the port must not *throw* on an inapplicable frame.** The lane's rule is "a throw leaves
   the cursor put and the frame is read again", so an adapter that lets ts-mls throw on a commit from
   an epoch it is not at **wedges the late joiner on its own add-commit forever** — the failure next
   door to this one, and worse. Return `{ advanced: false }`; throw only for a frame it *should* have
   been able to apply (the resolver miss).
2. **3.4 — the resolver's `catch` must stay silent.** A peer never learns that a blob failed to open,
   and there is no channel by which it could be surfaced as corruption. That catch is the one place
   tempted to grow a `console.warn` when diagnostics land.
3. **3.3 — journal the bodies, or the sealed frame?** Replay can only re-seal if the peer is still at
   the pre-commit epoch, which it is (adoption is in `onAccepted`; a crash before acceptance means no
   adoption). **That holds by an argument, not by construction.** Journalling the sealed frame makes
   it hold by construction. A deliberate choice, not an accident.

**One release-time item, noted and not fixed:** `HANDSHAKE_VERSION` is still `1` while the commit
payload's shape changed under it, so a pre-3.2 frame now decodes as a **truncated commit frame**
rather than a version mismatch. It is the one remaining route by which ordinary history reads as
corruption. Moot pre-1.0 with no deployed peers; needs a bump at the first release shipping both.

---

### 2026-07-13 — Question 3.3: Does the commit CAS loop converge, serialize, and journal?

**ANSWERED. Green: rpc 114, hub-server 57, mls 283, integration 23.** Three defects found while
implementing (G33, G34, G35), all folded into the spec at revision 26.

**The main body of the question is answered, and it was green (110/110) before the follow-up began.**
Full report: `docs/superpowers/probes/question-3.3-report.md`.

**Findings.** Two admins at one epoch converge with **no fork and no lost entries** — the loser
rebases and its entries land in the *winner's* ledger. The race is constructed, not hoped for:
Alice's publish is held until Bob has demonstrably framed at epoch 1. `bobFramedAt === [1, 2]`.

Two same-device `commit()` calls serialize: `framedAt === [1, 2]`, the second `build()` seeing the
first commit **adopted**. And `putWhileOccupied() === 0` — the same fact from the other side: **the
single-slot journal *is* the commit mutex written down**, and two commits in flight at once would
have one destroying the other's only record of itself.

Five consecutive CAS losses land **without throwing**. An attempt count of 5 throws there; that is
the whole argument for a deadline, demonstrated rather than asserted.

`lost` is a return value — and **the callback version deadlocks**, which the probe proved by building
it: `DEADLOCK: commit() is waiting on a mutex replay() still holds`. G27 earned its place.

`selfCommitted` (question 3.1's in-memory set) is **dead, and nothing replaced it**: an accepted
commit sets the cursor to its own frame, and the journal carries that across a restart.

**Three mutation checks, all reverted:**

- **Reuse the source handle across a retry → the fork, reproduced.** `commitFrames(...).toHaveLength(2)`
  **still passes** — two frames are in the log. But the retry republished a commit framed at the
  **superseded epoch**, every member at the new epoch dropped it, **`commit()` resolved, and the
  committer believes it committed.** Nothing anywhere raised a word. Exactly what
  `commitLedgerEntries`' doc comment warns about. **One assertion catches it** — the one the brief
  insisted on: *the loser's entries are in the winner's ledger*.
- **Adopt on hub-accept, before `onAccepted` → 106/110 pass.** Every ledger test green. The one
  casualty: **the invitee never gets a Welcome**, which lives in `onAccepted` and nowhere else.
- **Pull before replay** (the ordering the spec calls load-bearing) **→ 109/110 pass.** The restarted
  peer meets its **own un-merged commit** and runs it through `processCommit` as if it were somebody
  else's. Against real MLS that is the heal trigger firing into the rendezvous path the journal exists
  to avoid.

**A new defect, found while implementing — the cursor-wedge. G29's mirror image.**

G29 made the store's `head` advance **only on a log publish**. But `fetchTopic` still returned **every**
retained frame, mailbox ones included. So a peer pulls a mailbox-class frame, steps over it (3.1's
rule), and sets `reconciledHead` to a sequenceID **that is not and can never be the head**. Every
subsequent `commit()` CASes against a value that will never match, takes `HeadMismatchError` until its
deadline, and dies. **Permanently.** The frame need not even persist — the cursor keeps its value after
the frame is acked away. And per the spec's own *"a removed member keeps `commitTopic`"*, **a removed
member can publish one.** We fixed the head-wedge and left the cursor-wedge.

**Two fixes, and each carries a different test — established by reverting them one at a time, not by
assertion.** The store's `fetchTopic` now serves **log-class frames only** (a mailbox publish to a log
topic is still *delivered*, and never enters the log; the class is filtered **before** `limit`, or a
page of mailbox frames hands a draining reader a short page and it stops). And the peer now CASes
against **the head the drained pull reported**, never against its cursor.

| half | what it carries alone |
|---|---|
| store log-class filter | The `HubStore` contract — 2 conformance clauses. **No rpc test.** |
| peer head CAS | **G34**, below — 1 rpc test. **No conformance clause.** |
| both | The mailbox-wedge test needs *either*. Red only when both are gone. |

The probe could have manufactured a failure for the peer half by making the fake hub serve mailbox
frames from `fetchTopic`, and refused to — that would have lied about where the safety lives. It went
looking for the case the peer half carries alone instead, and found one.

**G34 — an empty log still has a head.** Trimming removes frames and leaves the head standing (the
store already asserts this). So a swept commit log presents a reader with **no frames and a real head**,
and a peer with a null cursor — a Welcome joiner, **or any peer after a restart, since the cursor is
not persisted** — CASes `expectedHead: null`, meaning *"this topic never had a log publish"*, against
it. Loses. Forever. The log-class filter cannot reach this: the log is honest and still empty.

**G35 — the epoch guard was built, and measured to have zero discriminating power.** The approved fix
was to journal the epoch and refuse to re-seal at a different one. The probe built exactly that. It
fired — and broke a green test, `replay is idempotent`, which is the design's **own** crash window: a
crash between `onAccepted` and `clear` leaves a handle at N+1 with an entry framed at N. So it built
the misbehaving host and printed both states side by side:

```
legal   (accepted → onAccepted adopted → crash before clear):  journalled epoch 1, handle epoch 2
illegal (adopted early → publish never accepted → crash):      journalled epoch 1, handle epoch 2
```

**Identical.** Not too strict — *measuring the wrong thing*. `entry.epoch + 1 === crypto.epoch()` is
what a correctly-behaved host looks like after the commonest crash in the design. The bit that
separates them is **"was the publish accepted?"**, and the journal never recorded it: the slot was
written once, before the publish. It reverted the guard whole and reported `BLOCKED` rather than ship a
check that refuses the design's own crash window.

**The fix, approved after discussion: record the acceptance, and record it at the right moment.**
`CommitJournal` gains `markAccepted(publishID, sequenceID)`, fired **between the hub's answer and
`onAccepted`** — *before* it, while the handle is still at the pre-commit epoch. That is the whole
trick. Replay routes on `acceptedAs` first (adopt, clear, **no network at all**) and checks the epoch
only where it is about to re-seal. `JournalEntry` gains `epoch` and `acceptedAs`; `JournalEpochError`
is raised on refusal, and the slot is **kept**.

Considered and rejected: a `lookupPublish` query on `HubStore`. The store is the real authority on
acceptance, but it is a second breaking contract change on every host in one revision, and it is
avoidable — and it would make a restarted peer ask the network for something it could have written
down. The local record is strictly better on the fast path: it works with the hub down.

**Two mutation checks, both red, each on a different test:**

- **`markAccepted` moved to after `onAccepted` → `replay is idempotent` fails**, and with its first
  assertion relaxed it fails *with `JournalEpochError` itself*. **The guard fires on the legal crash
  window.** That is G35 reproduced by moving one `await` past another. The ordering is not stylistic,
  and it is now pinned by a test rather than by a comment.
- **Epoch check dropped, `acceptedAs` kept → the misbehaving-host test fails**, the poison frame lands,
  and Bob — an ordinary member at epoch 1 who did nothing wrong — applies it, cannot open its blob, and
  dies inside `pullCommits` before `build()` is ever reached. He can never commit again, nor can anyone
  else at that epoch. The group-wide wedge, end to end.

**One thing the brief missed, and the design forced:** replay's **own** accepted path must
`markAccepted` before it adopts. Replay's tail is the same four steps as `commit`'s, so a crash between
its adopt and its clear leaves exactly the state the check refuses — a peer that crashed *inside its own
replay* would come back and be accused of misbehaving.

**Learned.** The fork this question exists to prevent is *silent from the committer's side*. Its
`commit()` resolves. Its own ledger holds its entry. Only the rest of the group knows. That is why the
assertion had to be "the loser's entries are in the **winner's** ledger" — every weaker form of the test
passes against the forking implementation.

And the deeper one, from G35: **a guard can be correct in its reasoning and still be measuring the
wrong variable.** The epoch check was right about the danger, right about the mechanism, right about the
cost — and it could not tell the attack from the design's own commonest crash. Only building it and
printing both states side by side showed that. An argument cannot always be cheaply upgraded to a check;
sometimes the check needs a fact nobody was recording.

**Not closed:** the check is **local**. It refuses a misbehaving *host* on its own device; nothing stops
a modified *peer* from publishing an unopenable frame anyway. Making the group **survive** one is
question 3.4's job — the classification table must not let `processCommit` stall the lane permanently.
This closes the accident, not the attack.

**Spec impact:** revision 26. G33 (the cursor-wedge: `fetchTopic` serves log-class frames only, and the
peer CASes on the head), G34 (an empty log still has a head), G35 (the epoch cannot say whether a replay
may re-seal — journal the acceptance, before the adopt). `FetchTopicParams`/`FetchTopicResult` carry the
log-class contract; `CommitJournal` gains `markAccepted` and its two-write ordering; the commit loop's
step 5 and the restart-replay routing are rewritten; four testing clauses added; the host-side impact
bullet now says **two** durable writes, and why the second one's position is load-bearing.

---

### 2026-07-14 — Question 3.4: Does the cursor table classify in the order written — and can a member weaponise it?

**ANSWERED. Green: rpc 137 (was 114), 27/27 tasks.** Two new defects (G36, G37), both folded into the
spec at revision 27. Full report: `docs/superpowers/probes/question-3.4-report.md`.

**Findings.** The table is built as a pure function (`classify.ts`) the tests drive row by row without a
hub, plus the ordering tests that show row 4 precedes row 5 — the property G18 turns on, and one an
end-to-end test cannot demonstrate.

**G37 — the committer must be read from the commit, never from the frame's `senderDID`. This is the
sharpest wrong-but-passing of the whole plan.** `senderDID` is the obvious source, and it **passes G18,
passes the plain G19 test, and passes every classifier unit test — 131 of 132 green.** The crash victim
really did publish its own frame; the removed member's poison frame really does carry their DID. It is
wrong because `senderDID` is the **untrusted hub's word** (`CommitContext` says so already: *"not an
authorization boundary"*), and a hub that stamps each recipient's own DID onto one poison frame makes
**every peer heal at once** — the G19 storm, through the one party the design never trusted. Exactly one
test catches it. **Without `FakeHub.lieAboutSender`, that implementation ships.** The security of the
lane rests on a fixture being able to lie about the one field the spec calls forgeable.

**G36 — the escalation was the DoS, and the table was missing a row.** The probe reported the gather
"has nowhere to go" (D3 puts it on the epoch-bound app lane, and a stuck peer is behind everyone who
applied the frame). It goes further: **escalating to `recover()` on an unresolvable frame lets any
current member force the whole group into a recovery storm with one body-less commit** — G19's shape,
through the row meant to be safe. Bounded retry only delays it by N attempts.

The discriminator that resolves it: **the bodies are sealed under the epoch the commit is framed at, and
every member at that epoch holds that secret — so a frame resolves for all of them or for none.** Nobody
can resolve it ⇒ nobody applies it ⇒ the group never advances ⇒ it is a dead frame, one wasted CAS slot,
a cost this design already accepts. The group *does* advance past it ⇒ the fault is mine — and I learn
that **not from the frame, but from a later frame framed ahead of my epoch.** So: unresolvable is
**poison** (drop, advance, never heal; the retry loop is deleted), and the table gains a **first row** —
*framed ahead of me* — whose absence was a **live bug**: a peer that skipped an epoch read every later
commit as "history", reached `reconciledHead == head`, and **reported itself healthy while permanently
stuck at a dead epoch.**

**The joiner trap was not where I put it.** I briefed the probe to watch the new row's *placement*,
fearing a Welcome joiner (which sees frames both below and above its epoch) would heal on arrival. **The
placement cannot break a joiner, and the probe showed why:** the log is non-decreasing in epoch, so a
joiner applies each frame at its own epoch and **rises with it**, never meeting one ahead. What breaks it
is reading the peer's epoch **once per page** instead of once per frame — the obvious hoist-out-of-the-loop
optimisation. The epoch goes stale mid-page, the next frame classifies as *ahead*, and every new member
heals on its first pull. **The danger was in the loop, not the table.** The classifier now takes the epoch
as an argument so it cannot go stale.

**Three mutation checks, all red on exactly the predicted test, all reverted:**

- **The applicability predicate** heals the crash victim *perfectly* and turns one publish from a removed
  member into **2 heals in a 2-member honest group**.
- **`senderDID` as committer** — 131/132 green (above).
- **Restore the escalation** — the storm, measured. And a detail worth keeping: under it the
  left-behind-peer test **still passes**. It heals for the wrong reason. **Only counting heals on the
  frame nobody can resolve separates the two implementations.**

**Decisions taken.** A typed `RecoveryRequiredError` for the heal trigger unwinding `commit()` (the spec
said to unwind, never how the host is told). `appliedByEpoch` stays **in memory**: a restarted peer can
*miss* a fork and can never *invent* one — the safe direction, and D1's fork **resolution** is not built,
so the trigger has nowhere to go. No durable store for a trigger with no action.

**An accepted, bounded hazard.** A peer that dropped an unresolvable frame may still commit, landing on a
private branch if the others applied that frame. Accepted, because it is **not attacker-reachable** (a
peer that alone cannot resolve a frame already holds a different epoch secret — it was forked before the
frame arrived) and it **expires** (the group's next commit is *ahead* of it, and the new row heals it).
The obvious guard — *refuse to commit at an epoch I skipped* — is **worse than the bug**: in the case that
actually happens every honest member skipped that epoch, so every honest member refuses, while the peer
that published the frame adopted its own commit and sits an epoch ahead alone. **One unresolvable frame
would kill the group permanently.**

**Spec impact:** revision 27. The table gains the `ahead` row and loses the gather/retry/escalate row;
G36 and G37 written up; five testing clauses added.

**Learned.** Twice now the fix that suggested itself was worse than the defect — the epoch guard in 3.3
that could not tell a legal crash from an attack, and the skipped-epoch commit guard here that would trade
a bounded self-fork for a permanent group death. Both were only visible after building the thing and
asking *what does this refuse that it should not?* And G37 says something narrower and sharper: **a test
double that cannot lie is not a test.** The hub is untrusted by design, and until the fixture could forge
`senderDID`, every test in the suite agreed with an implementation that hands it the group.

**Still open, and carried:** `MissingLedgerEntriesError` no longer has a gather at all — D3's bootstrap
gather (question 2.3, head-verified) is the only one that works, and it runs after a heal. **D1's fork
resolution is not built**: the fork row escalates to `recover()` and stops. A `FakeHub` that is a single
honest log cannot produce a losing branch, so there is no end-to-end fork test. **Trim-to-empty** (head
present, no frames) leaves a peer quietly behind with nothing to trip the `ahead` row — not new, not
worsened, and easy to mistake for covered.

---

### 2026-07-14 — Question 3.5: Does `recover()` heal without nesting, and re-enact by membership?

**ANSWERED. Green: rpc 147 (was 137), 27/27 tasks.** Full report:
`docs/superpowers/probes/question-3.5-report.md`.

**Findings.** `recover()` is a top-level lane operation with a CAS loop of its own; the mutex is never
re-entered; re-enactment is a *subsequent* `commit()` filtered by ledger membership. Four mutation
checks, all red:

- **Drop the membership filter** → the spec's worked example, produced exactly: ledger `[Foo, Bar, Foo]`,
  the circle is `"Foo"` again, **and nothing is thrown anywhere.** `AssertionError: expected 'Foo' to be
  'Bar'`.
- **Retry the external commit instead of discarding the GroupInfo** → worse than a failure. The peer
  **publishes, adopts its own derived handle, and sits alone on a branch believing it rejoined**, never
  bootstrapping, because the stale head it adopted makes its empty ledger look complete. This mutation
  also exposed a weak assertion in the probe's own first draft: *"the peer is in the roster"* passes
  trivially, because a stranded member's **old leaf is still in the tree**.
- **Nest the heal inside the pull** → deadlock, 4s timeout. `commit()` holds the mutex, its pull calls
  `recover()`, `recover()` takes `runSerial`, and the tail it waits on contains the operation waiting
  for it.
- **Return `advanced: true` without completing bootstrap** → two failures, and the first is the
  instructive one: **bootstrap-before-filter is load-bearing.** With no group ledger there is nothing to
  filter against, so the peer re-enacts its whole pre-rejoin ledger and reverts the later admin — G17's
  failure reached through G15's door. The second is a **silent roster reset** reported as a heal.

**A live defect in question 3.3's journal, found by 3.5.** `peer.ts` initialised `epoch = 0` and ran
`buildEpoch()` *after* the seed lane operation, so `frameCommit`'s guard **refused every journal replay
at startup** for any peer past epoch 0 — and the throw aborted the seed pull, leaving the cursor
unseeded too. **That is the crash-restart path, which is the journal's entire reason for existing.** All
137 tests were green because every replay test calls `replay()` explicitly, after `ready`, when the
epoch is correct. Fixed by seeding from the live handle, and now pinned by a test the host drives
nothing in: the seed lane operation alone must settle it.

**And the test for that bug is itself a trap.** The probe's first draft **passed against the broken
code**: crashing inside `onAccepted` records the acceptance *first* (3.3's `markAccepted` ordering), so
replay adopts from the slot and never re-seals — never reaching the broken guard. Only a crash **before
the acceptance is recorded** exercises it. Q3.3's own fix had made its own bug untestable from the
obvious angle.

**G38 — the fork row is not dead code; the fixture could not lie.** The probe reported the losing-branch
row unreachable: the cursor is forward-only, `applied <= reconciledHead`, and the pull only serves
frames above the cursor, so an incoming fork frame is **always** `'winning'`. **That reasoning is
airtight about an honest hub, and only about an honest hub.** A fork exists *only because* the hub broke
the compare-and-set — and a hub that will do that has no reason to honour `fetchTopic`'s exclusive
cursor either. **Both are contracts binding the one party this design does not trust.** `FakeHub` gained
three opt-in byzantine controls (honest by default, and kept well away from `hub-protocol`'s conformance
suite — the store's contract is unchanged; the fixture models a **non-conforming** store, which is the
threat). Bob applies the higher-sequenceID commit, is later served the lower one **below his cursor**,
classifies `losing`, rejoins, bootstraps, and re-enacts the entry the winning branch never had.
Deleting the row's `healRequested` goes red: **zero heals, Bob on the discarded branch forever,
silently.** The winning side needed its own test and got one — the same tiebreak, on the same two
frames, must lead the two peers to **opposite** conclusions.

**Decisions taken.**

- **`inFlight` is the peer's pre-rejoin ledger, not the journal** — a **correction to the spec**. With
  the journal in place, replay settles a crashed peer's commit at step 0 *before* any heal can run, so a
  journal-sourced in-flight set can never coexist with a heal and the filter over it would be vacuous.
  The pre-rejoin ledger makes the membership rule literally what it says: a **set-difference** against
  the group's authenticated ledger.
- **The bootstrap gather rides the rendezvous lane.** The spec's "gather rides the app lane" refers to
  D3's id-keyed gather, which question 3.2 deleted. A just-rejoined peer needs a lane it certainly
  shares with a responder, and the rendezvous topic is the only non-rotating one both hold for life.
- **`LaneResult` gains `reenact?`** — a heal fired by the *pull* has no return value to put the entries
  in, so they are stashed for the next lane operation that has one, exactly as `lost` is.
- **`GroupMLS.getLedgerEntries` is removed.** Dead since 3.2 put the bodies in the commit frame; nothing
  called it. One less method every host implements.

**Learned.** *A test double that cannot lie is not a test* — and this is now the **second** question
where it was the finding, not a footnote. In 3.4 an implementation reading the committer from
`senderDID` passed 131 of 132 tests, and only a hub that could **lie** exposed it. Here an entire row of
the cursor table looked like dead code, and only a hub that could **reorder** showed it was not. Both
times the honest fixture agreed with the wrong implementation. When the threat model names an untrusted
party, the double has to be able to *be* it.

**Spec impact:** revision 28 — G38; `inFlight` corrected to the pre-rejoin ledger; the bootstrap gather
moved to the rendezvous lane; `getLedgerEntries` removed from the port.

**Still open, and carried:** the **trim-strand trigger is unbuilt** — nothing reads `oldest`. `recover()`
handles the trim strand correctly once something triggers it, and nothing does. Of the three heal paths,
only the byzantine losing branch and the un-merged own commit fire today.

---

### 2026-07-14 — Question 3.6: Does replay return its outcome without deadlocking the host?

**ANSWERED, and it did not go as planned.** Three of the four clauses were already green as side effects
of 3.3 and 3.5 — verified, not assumed. The fourth was **false**, and the probe reported `BLOCKED`
rather than route around it. Green: mls 287 (was 283), rpc 148, 27/27. Report:
`docs/superpowers/probes/question-3.6-report.md`.

**G40 — "the invitee no-ops a re-delivered Welcome" was never true, about ts-mls or anything else.** A
second `processWelcome` over the same Welcome bytes **neither errors nor no-ops: it silently builds a
second, stale group state.** The invitee ends up holding a handle at its *joining* epoch (1n, 2 members)
with the **same group id** as its live handle (2n, 3 members), and the stale one cannot decrypt the
group's current traffic.

The reason is structural, not a bug: **`processWelcome`, and ts-mls's `joinGroup` beneath it, are pure
functions** of (Welcome bytes, key package, private keys). Neither holds a registry of joined groups, so
there is no "already joined" state to consult and **nothing that could no-op**. The Welcome is not
consumed by the first join, so the second decryption succeeds identically.

**This was a live silent defect on the crash path.** Replay re-runs `onAccepted`, the Welcome is
re-delivered, and an invitee that adopts what comes back **rolls back to its joining epoch, loses every
member added since, and goes deaf to the group** — with no error anywhere. Worse, we were *telling hosts
it was handled*: `PendingCommit.onAccepted` stated "both halves must tolerate a repeat" as an obligation
**nothing in kumiai discharged**. The spec repeated the claim in two more places, and one of them
recommended a no-op that **is not available to a host at all**.

**The fix: `processWelcomeOnce` in `mls`, not a line in the host-obligation list.** It takes the group
ids the member already holds and returns `null` for a Welcome it has already joined. `processWelcome`
stays exported and stays pure underneath — it is correct as it is; the new function is the safe path
over it. The dedup **cannot** be hoisted above the join: the group id is encrypted to the joiner, so
there is nothing to compare against until the handle exists. The implementation joins, compares, and
**discards the stale handle rather than returning it**, and the doc comment says why, because that is
exactly the optimisation the next reader will reach for.

Suppressing the re-delivery on the *sender* side was considered and rejected: the send is host-side and
its outcome is unknowable, so at-most-once strands invitees — which is the failure the journalled Welcome
exists to prevent. **The Welcome is at-least-once by design, and the receiver is where idempotency has to
live.**

**The audit found the hole exactly where the brief sent it looking.** The `remove` notice was **not
pinned**: the old test asserted only that a notice came back, and said nothing about the roster. **The
precise bug the spec names — *"an admin told the removal failed while the member is quietly gone"* — would
have passed it.** Now fixed with a **positive control** (a remove that lands *does* evict, so the negative
is not vacuous) and `expect(alice.mls.leaves()).toContain('mallory')`. Mutation-checked: injecting
`adoptJournalled` on the lost-CAS branch fails on exactly that line, and **the invite test does not catch
it** — the remove test is the only thing guarding it. The other three clauses were genuinely pinned, each
by an assertion that would catch the wrong implementation.

**Accepted residual.** `processWelcomeOnce` is only as safe as the `joined` set the caller passes. The
shape is still materially better than a documented obligation, because **the signature forces the
question**: a host cannot call the safe path without supplying the set, so passing an empty one is
asserting something false about its own state — a louder error than forgetting a check exists. Making it
airtight would mean `mls` owning a group store, which cuts against the package being deliberately pure.

**Spec impact:** revision 29 — G40; the false "no-ops it" claim removed from all three places it appeared;
the testing clause now asserts **both** halves (that plain `processWelcome` silently builds a second group
state, which is *why* the safe path exists, and that `processWelcomeOnce` returns `null`).

**Learned.** Every other defect in this plan was code that failed to match the design. **This one was the
design asserting a fact about a dependency that was never true** — and then building on it: a doc comment
telling hosts to rely on it, and the journal's Welcome re-delivery resting on it. Fourteen review passes
read it as obviously true. It was reachable only by testing the **recipient** instead of the sender, and
every test we had asserted the sender delivers once — the easy half, and the wrong half. **When a design
claims a dependency behaves a certain way, that claim is a test, not a premise.**

---

### 2026-07-14 — Question 3.7: Does the lane outrun the mailbox and destroy downloaded messages? (G28)

**ANSWERED: NO — and something far worse is true.** The probe reported `BLOCKED` on the spec, not on the
code, and it was right. **G28 is wrong on the mechanism, and its rule cannot be implemented.** Green: rpc
149 + **1 deliberately skipped**, mls 287, 27/27. Report: `docs/superpowers/probes/question-3.7-report.md`.

**The spec's own scenario passes with no fix.** Written test-first, as the plan demanded: a peer goes
offline, the group makes ten commits, an app message is sent at an early epoch, the peer reconnects — and
it **reads the plaintext**. Through a double that opens *only* the current epoch, with
`retainKeysForEpochs` untouched. The message survived ten commits and a one-epoch key window.

**The commit lane cannot outrun the mailbox, because they are the same queue.** `createHubMux` drains
`hub.receive` in one ordered loop and unwraps app frames **synchronously** in the listener, while
`onCommitDelivery` defers all its work behind `void runSerial(...)`. For any frame ahead of the commit in
delivery order, the interleave **already holds structurally** — guaranteed by the drain, not by any rule.
*"D1 makes the commit lane run at step 0 so replay races to the head while the mailbox is still full"*
**describes a lane that does not exist in this tree.**

**And the rule is not implementable.** *"Drain the mailbox up to E"* needs a per-epoch mailbox that does
not exist: app frames are mailbox-class, `fetchTopic` serves **log-class only** — so an app frame **can
never be pulled** — `subscribe` back-fills nothing, and a mailbox publish with no subscribers is dropped
at publish. There is no signal that says *"I now have everything for epoch E"*. Any implementation is a
**race against the delivery loop, not an invariant**. Reordering `ready` turns the failing test green, and
the probe **refused to ship it** — the same scenario still loses the message when the backlog arrives one
tick later. That is winning a race on a fast machine, and calling it an invariant.

**G41 — what actually loses messages, and it is not the keys.** Six experiments; the causal pair is a
restart with ten commits (message lost) against the identical restart with **zero** commits (message
read, at epoch 1, through a double that opens only the current epoch). **The commits destroy the message,
and what they destroy is the *subscription*, not the secret.**

At startup the seed pull runs **to head before `buildEpoch()`**, so a peer that comes up at epoch 1
holding epoch-1 frames builds its app lane at **epoch 11** and never installs a listener on the epoch-1
topic at all. The hub — which still has it subscribed, because a crash does not unsubscribe — **pushes the
frame straight at it**, and it lands in the mux drain, finds no listener, and is dropped on the floor.
**The hub delivered it. The peer held the key. It threw it away.**

**The real defect is structural, predates D1, and the control lane has nothing to do with it.** App topics
are **epoch-derived** and app delivery is **push-only**, so a member is *structurally incapable* of
receiving traffic from any epoch it slept through: it was never a subscriber of that topic, so the hub
created no delivery for it, it cannot pull, and `subscribe` back-fills nothing. **That** is what "a member
offline over lunch loses its messages" actually is. No key window touches it. **Scoped out** to
`docs/agents/plans/next/2026-07-14-app-lane-delivery.md` — "should app frames be log-class and pullable"
reaches retention, GC and unlinkability, and deserves a brainstorm, not a probe.

**G42 — three paths were DELETING mail, and all three are now closed.** On the real store
`unsubscribe → dropDelivery → removeEntry` is a **destructor**: it frees the subscriber's pending
deliveries, and frees the frame outright for everyone if that was the last pending reader.

1. **`rebuildEpoch()`** unsubscribed the old epoch's protocol topic — **advancing the epoch deleted the
   peer's own unread mail out of the hub.**
2. **The self-inbox topic** went through the same release path, so **directed mail was deleted on every
   rotation too.** Nobody had named this one; it fell out of fixing the first.
3. **`peer.dispose()`** unsubscribed everything — and **on a mobile client, `dispose` is what backgrounding
   calls.** The same destructor under another name, firing in the most common way a peer goes away.

The governing principle, and the reason these were fixed here while the rest was scoped out:
**non-delivery is recoverable by a future design; deletion is not.** A frame still retained in the hub can
be handed to a pull-based app lane whenever we build one. A frame `removeEntry` has freed is gone forever.

The fix is peer-side, with **no `HubStore` change** — the peer simply stops *asking* for the deletion.
`release()` and `dispose()` now drop **local listeners** and leave the subscription standing. The app
topics now hold the property the control topics always had, in the spec's own words: *subscribed once for
the peer's whole life, deliberately NOT unsubscribed.* **A subscription is a durable relationship, not a
session.** Dropping a listener, rotating an epoch and disposing all mean *"I am not listening"*; none of
them means *"I have read my mail, throw the rest away"*, which is what `unsubscribe` means to the store.

**The destructor was written down as an invariant — in four tests.** Three rotation assertions
(`subscriberCount(T(old)) === 0`) and, exactly as predicted, `hub-mux.test.ts`'s *"dispose stops the drain
and unsubscribes remaining topics"*. **They were the bug, not the fix.** All four now assert the opposite
and say why. Mutation checks: restoring `dispose()`'s unsubscribe → 1 red; restoring `release()`'s → 3 red.

**Accepted cost, stated not buried.** Subscriptions are never released, so they accumulate — **~1,400 per
member per week** of process uptime at 100 commits/day. Taken deliberately, because the alternative is
deleting users' mail. It **dissolves entirely if the redesign drops epoch-derived topics** (one stable
topic per protocol, subscribed for life, exactly as `commitTopic` already is), which is why a sweep now
would likely be wasted work — and a sweep needs a retention figure **the app lane does not declare**.

**The most useful number in this plan.** When the failing test was written, **148 rpc tests and 287 mls
tests passed while the peer silently lost every message in its inbox.** The convergence assertion on the
line directly above the failure passed too. And **no test in the suite could ever have caught it**: the
peer fixture had no way to register an app handler, so nothing in the repo had *ever* asserted a plaintext
across a commit. The one new assertion is the only thing that notices. It is kept, **skipped**, unweakened
— a reader can unskip it and watch it fail for the right reason.

**Spec impact:** revision 30 — **G28 is retracted**: wrong mechanism, unimplementable rule, and it
described a race that does not exist. Replaced by G41 (the real mechanism, scoped out) and G42 (the
destructor, fixed).

**Learned.** The plan's organizing principle is *"a design claim the obvious implementation satisfies
while being wrong."* This question found its mirror: **a design claim that is wrong about the system it
describes.** G28 reasoned from an architecture — commits racing ahead of a drainable mailbox — that this
codebase does not have. Writing the test first is what caught it; had the probe started from the fix, it
would have built an interleave for a race that cannot happen, shipped it green, and left the real bug
untouched **with a test standing guard over it.**

---

### 2026-07-14 — Question 4.1: Does a sole-member group survive a crash on its first commit — and the calendar?

**Findings:** Yes, at both crash points, with the log intact and with it swept away — and **with no
`src/` change**. Four tests: {the hub accepted but the process died before `markAccepted`} × {log
intact, log trimmed}, and the same pair for a crash after the acceptance was recorded. The peer
publishes to the rendezvous topic **zero times** in all four. G21 and G24 both hold.

**But the prediction going in was wrong, and being wrong about it is the finding.** The brief expected
the seed pull to meet the peer's own un-merged commit and trip the G18 trigger in a group with nobody
to answer. It does not — because **`replayJournal` runs at step 0 of the seed**, ahead of
`ensureLedger()` and the pull, and leaves the cursor past the peer's own frame. A recording hub proved
it rather than inferring it: the pull was handed `[]` over a log the test asserts still holds exactly
one frame.

**So the group of one was saved by an ordering constraint with nothing behind it.** `replayJournal`
never clears `healRequested`, and the flag has **three** producers — `own-unmerged`, `ahead`, and
`fork`-losing. (A blanket clear on adopt is therefore a *regression*: it would swallow a genuine heal
raised for the other two, and the trim-strand peer would silently stop asking for help. The obvious fix
is worse than the defect, for the third time in this plan.) The design was safe only because replay
precedes the pull in all five lane operations — an invariant stated in prose and enforced by nothing.

**The mutation is the whole lesson.** Inverting the seed ordering — pull before replay — produces this:

```
welcomes [ 'dave' ]      ← the Welcome fired
epoch 2                  ← converged
slot cleared
rendezvous publishes 1   ← it asked the void for help
commit frames 1
```

`recover()` with no responder **resolves `{ advanced: false }`. It does not throw.** The group converges,
the Welcome fires, nothing errors, and the peer has spent a rendezvous and a 30s recovery deadline on a
group that contains only itself — on every restart, forever. **Every assertion the plan warned against
would pass.** The single observation that separates recovery from luck is `rendezvous publishes == 0`.

**And the trimmed case is the weaker test, permanently.** Under the wrong ordering the two *trimmed*
tests stayed **green** — a trimmed log returns no frames, so the own-commit row cannot fire and the
ordering cannot be observed at all. Had G24 been written over the wrong crash point, or over a fixture
that always trims, the probe would have reported success on a broken lane. **Any test of this area that
trims must be paired with one that does not.**

**Spec impact: revision 31.** The ordering is now **checked, not described**: `pullCommits` refuses to
run in a lane operation whose journal has not been replayed (`journalReplayed`, cleared by `runSerial`,
set by `replayJournal`). Before the guard the mutation went red on 6 tests — 4 of them in
`peer-commit-replay`, failing through an *unrelated* mechanism (`JournalEpochError`), **every one of
them involving a second member**. Not one existing test was a group of one. With the guard it goes red
on **16 across 6 files, including both trimmed tests** — the blind spot the trim opened is closed.

**G24 is the only test in the repo that measures the dedup record.** Mutating `FakeHub.trim` to forget
the `publishID` of whatever the log forgets leaves the suite at `PASS (152) FAIL (1)`, and that one
failure is exactly the spec's scenario: the republish CASes at `expectedHead: null` against a head that
is still its own trimmed frame, takes `HeadMismatchError`, the slot clears, and the invite surfaces as
lost. **Dave is in the ratchet tree and is never told.** Silently, with no error anywhere.

**Learned (4.1):** *An invariant that is load-bearing and silent when violated must be checked, not
written down.* The ordering was correct, uniformly applied, and documented in five places — and a
refactor touching only the seed would have passed 147 of 153 tests while every sole-member group asked
the void for help on every restart. The guard costs nine lines.

Also carried: the probe used `FakeHub` rather than `DurableFakeHub` as the brief specified, and argued
it — `DurableFakeHub`'s only distinctive feature is ack/redelivery, and a group of one receives no
pushes (the hub skips the sender), so a trim there would have been dead fixture code. **`DurableFakeHub`
still has no `trim`**; if a later question needs one under redelivery, it remains to be written.
