# Control-ledger lane — implementation plan

**Stage:** planning
**Mode:** learning-loop
**Spec:** `docs/superpowers/specs/2026-07-13-control-ledger-lane-design.md` (revision 15)
**Review record:** `docs/superpowers/specs/2026-07-13-control-ledger-lane-review.md` (G1–G27)

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
the suite fails against a store that hangs retention off delivery, or dedup off the message
row, or mints sequenceIDs in-process.

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
- **Done when:** publish stores a log entry with zero subscribers; `ack` deletes a *delivery* and
  never a log entry; `trim({ topicID, before })` is the only deleter and moves `oldest` without
  touching `head`. Suite's log tests pass. The existing `hub.test.ts` still passes — the mailbox
  is not regressed.
- **Three existing tests encode the old contract and must be rewritten, not preserved** (found
  in question 1.1): `memoryStore.test.ts:11` (zero-subscriber publish drops), `:83` (refcount GC
  on last ack), `:62` (last unsubscribe drops the whole topic log). Each *asserts* a behaviour
  the spec now forbids. Rewriting a passing test is the correct move here and it will feel wrong;
  do it deliberately, and say in the commit which contract each one used to encode.
- **⚠️ Wrong-but-passing:** keeping `deleteMessage`'s refcount GC "as an optimization for
  messages nobody wants". That is precisely today's bug: the last ack destroys the log entry, and
  every online-peer test still passes. Same shape for `unsubscribe`: dropping the topic index
  when the last subscriber leaves is a deletion `trim` never authorized, and no online-peer test
  notices.
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
result is delivered under the lock.

### Question 3.1: Does the pull-driven commit lane seed and catch up correctly?

- **Assumption:** a cursor seeded by *reading the log* serves the fresh joiner, the re-seeded peer,
  and the rejoiner — the three peers that have applied nothing from the topic.
- **Done when:** `commitTopic` / `rendezvousTopic` split; the peer subscribes, then pulls from its
  cursor; push is a wakeup only. **The late-joiner test:** a member is invited, two further commits
  land before it subscribes, and it converges **by pulling** — with no `recover()`, and **no fork
  diagnosis** while walking frames from epochs it never held.
- **⚠️ Wrong-but-passing:** seeding the cursor from the topic's `head` at subscribe time. Every
  online-peer test passes; the joiner then CASes against a head whose commits it never applied.
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

**Learned:** The masking is a property of the suite worth keeping in mind for the rest of Phase 1 —
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
