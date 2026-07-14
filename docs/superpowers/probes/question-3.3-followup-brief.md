# Question 3.3 — follow-up: the cursor-wedge and the journal epoch guard

**Read `docs/superpowers/probes/question-3.3-brief.md` first.** This is a continuation of that
probe, not a new one. The main body of question 3.3 is **done and was green at 110/110**; its
report is at `docs/superpowers/probes/question-3.3-report.md`. Your job is the follow-up that was
started and left half-applied.

**The working tree is RED right now. Do not commit anything until the full verify is green.**

---

## Where the tree is

Uncommitted, on branch `feat/control-ledger-lane`, on top of `7c8617d`:

- **The main body of 3.3 is present and was green.** New: `packages/rpc/src/commit.ts`,
  `packages/rpc/test/fixtures/journal.ts`, `packages/rpc/test/fixtures/peer.ts`,
  `packages/rpc/test/peer-commit-cas.test.ts`, `packages/rpc/test/peer-commit-replay.test.ts`.
  Modified: `packages/rpc/src/peer.ts` (the commit loop), `hub-mux.ts`,
  `packages/hub-tunnel/src/transport.ts`, `memory-group-mls.ts`, both fake hubs, and five rpc
  suites.
- **The follow-up is half-applied.** Specifically:
  - The **store-side filter is written**: `memoryStore.fetchTopic` filters the log to log-class
    frames before applying `after`/`limit`; `FetchTopicParams` carries the contract in its doc;
    a new conformance clause (`a mailbox publish to a log topic is delivered, and does not appear
    in the log`) asserts it. **These look right — read them, keep them.**
  - **One conformance test fails.** See below.
  - The **peer-side head CAS is NOT written**. `packages/rpc/src/peer.ts:312` declares
    `commitLogHead` with a full doc comment and **never reads or writes it**. That is the whole of
    the work that was done on the peer side.
  - The **journal epoch guard is not started.**

Current failure, from `packages/hub-server`:

```
1. HubStore conformance fetchTopic refuses a non-subscriber
   AssertionError: expected [] to have a length of 1 but got +0
```

That test (`packages/hub-protocol/src/conformance.ts:533`) publishes with **no `retain`** — so a
mailbox frame — and then expects `fetchTopic` to hand it back. Under the new contract the log does
not serve it. The test's subject is **authorization**, not retention: it wants a frame in the log
so that the allowed-vs-refused distinction has something to bite on. Fix it by publishing
`retain: 'log'`. Check the rest of the conformance suite for the same assumption; fix any others
the same way. **Do not weaken the new clause to accommodate an old test.**

---

## The defect being fixed: the cursor-wedge

G29 made the store's `head` advance **only on a log publish**. But `fetchTopic` still returned
every retained frame, mailbox ones included. So a peer pulls a mailbox-class frame, steps over it
(question 3.1's rule: the cursor advances over every frame the peer *processed*, including ones it
dropped), and sets `reconciledHead` to a sequenceID **that is not, and can never be, the head**.
Every subsequent `commit()` compare-and-sets against a value that will never match, takes
`HeadMismatchError` until its deadline, and dies. **Permanently** — the frame need not even
persist, because the cursor keeps its value after the frame is acked away.

The retention class is the **publisher's** to choose, and per the spec's own *"a removed member
keeps `commitTopic`"*, **a removed member can publish one.** One frame, and every writer on the
topic is wedged for good.

It is G29's mirror image: we fixed the head-wedge and left the cursor free to name a frame that is
not in the log.

---

## Fix 1 (store) — mostly written; finish it

`fetchTopic` serves **log-class frames only**. A topic's log is its log-class frames; a mailbox
publish to a log topic is still **delivered** — push is untouched — and **never enters the log**.

Two details already in the code, both load-bearing; keep them and keep their comments:

- **Filter before `limit`, not after.** A page of mailbox frames that ate the caller's limit would
  hand a draining reader an empty page while log frames were still waiting, and the reader would
  stop.
- The new conformance clause asserts the mailbox frame is absent from the log **before** the ack as
  well as after. Asserting only after the ack would pass against a store that puts mailbox frames in
  the log, because the ack is what removes them.

This is a **contract change on `HubStore`**, which hosts (kubun, backed by SQL) implement. The
conformance suite is how they are told. That is why the clause matters more than the memory-store
change.

## Fix 2 (peer) — not written; write it

Compare-and-set against **the head the drained pull reported**, not against the cursor.

`reconciledHead` is what this peer has **processed**. The log's `head` is what the log's **tip is**.
Two things, two names — the same discipline that branded `LogPosition` apart from `DeliveryPosition`
in `cursor.ts`. `commitLogHead` at `peer.ts:312` is already declared and documented for exactly
this; wire it up.

- `pullCommits` (`peer.ts:413`) records the head **from `fetchTopic`'s own reply**. Record it on a
  **complete drain** — at the points where `pullCommits` returns, not before processing a page.
  A `commitLogHead` set ahead of the frames it covers would claim a tip the peer has not reconciled
  to, and the next `commit()` would win a compare-and-set at an epoch it had not caught up to. Think
  about the empty-log case and the paging case; say in the report what you concluded.
- `commit()` (`peer.ts:629`) uses `commitLogHead` for `expectedHead` at step 3/4, in place of
  `reconciledHead`.
- On acceptance — **both** the `commit()` step 5 path (`peer.ts:689`) and the `replayJournal`
  accepted path (`peer.ts:611`) — this peer's own frame is now both the cursor **and** the tip.
  Set both.

Note `null` still means "the topic has never had an accepted log publish", which is exactly what the
first commit of a group's life compare-and-sets against. Do not change that.

**Belt and braces, on purpose.** The store change makes the log honest; the peer change makes the
anchor correct *by name* rather than by an invariant it does not state. Keep both even if you find
that either alone closes the wedge — but you must **say** which, see "What the report must answer".

## Fix 3 — the journal epoch guard

Replay **re-seals** the bodies: `replayJournal` (`peer.ts:578`) calls `frameCommit`, which calls
`crypto.wrap`. The journal holds plaintext tokens, and that is forced — `LostCommit.tokens` must
hand back re-issuable tokens regardless.

Re-sealing is safe **only because `onAccepted` is the sole adopt point** — an argument, not a
construction. A host that adopts elsewhere and then crashes before acceptance re-seals under the
**post**-commit epoch and publishes a blob **no member can open**: the commit applies, every
receiver fails to resolve its bodies, `processCommit` throws, the cursor never advances, and **the
lane wedges for the whole group** on a frame nobody can ever get past.

So:

- `JournalEntry` (`commit.ts:49`) gains an **`epoch`** field.
- **Read it from `crypto.epoch()`** — `GroupCrypto` (`crypto.ts:14`) already exposes
  `epoch(): number`, and `crypto` is the thing that *seals*, so it is the honest thing to compare.
  **No change to `GroupMLS` is needed.** (`GroupMLS` has no epoch accessor and the real handle's is
  a `bigint`; do not go there.)
- `commit()` records it at journal-put time. `replayJournal` compares, and **refuses** to re-seal at
  a different epoch — a **named error** (in `commit.ts`, exported, with a doc comment saying what it
  means and what the host did wrong).

One field, turning a silent group-wide wedge into a loud local error at the peer that caused it.

This **deviates from the spec's verbatim `JournalEntry`**. That is intended and approved; the spec
is being corrected after you land.

---

## What the report must answer

Append a section titled **"The cursor-wedge and the epoch guard (follow-up)"** to
`docs/superpowers/probes/question-3.3-report.md`. It must contain:

1. **A test that reproduces the wedge**, against the peer, through the fake hub: a member publishes
   one `retain: 'mailbox'` frame to the commit topic, and a subsequent `commit()` must still land.
   Assert the commit lands — not that no error was thrown. This test is the deliverable; the fixes
   are how it passes.

   The fake hubs (`packages/rpc/test/fixtures/fake-hub.ts`, `durable-fake-hub.ts`) must model the
   store contract faithfully — they already dedup-before-CAS for the same reason. If they serve
   mailbox frames from `fetchTopic`, **they must be fixed to match**, and the wedge test must then
   still fail for the *peer* reason before fix 2. Be careful here: a fixture that silently matches
   the new contract makes fix 2 untestable and you will report that it carries nothing, which would
   be a lie about where the safety lives. **Say explicitly how you kept the fixture honest.**

2. **How much each half of the wedge fix is carrying.** Revert **one at a time** — store filter
   alone, peer head CAS alone — run the suite, and **name which tests go red for each**. If one of
   them turns out to carry nothing on its own, say so plainly; do not pad the finding.

3. **A mutation check on the epoch guard**: build the host that adopts early and crashes before
   acceptance, show the guard fires, and show what happens **without** it (the unopenable blob). If
   the without-it case cannot be made to reach the group-wide wedge in the test doubles, say so and
   say how far it does get.

4. The full verify output.

---

## Conventions

- `kigu:conventions` and the repo's `CLAUDE.md`/`AGENTS.md` are binding. `type` not `interface`;
  `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES `#fields`, never
  `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**
- **Code, comments, and test names never reference plan questions, decision numbers, or phase
  labels** — no `// Q3.3:`, no `// G29`. Capture the constraint or the invariant directly. The
  comments already in the tree are the model: they say *why the code must be this way*, in terms a
  reader with no plan in hand can act on.
- Verify command, from the repo root — **the `rtk` shim intercepts `pnpm run`, so use `rtk proxy`**:

  ```
  rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
  ```

## Stop conditions

- If the approved approach **does not work**, stop and report `BLOCKED` with what you found. Do not
  try an alternative design without asking. The blocker is the finding.
- **Do not commit.** Leave the work in the tree; the main thread commits after review.

## Report contract

Write the full report by **appending** to `docs/superpowers/probes/question-3.3-report.md` (do not
overwrite the existing report — the main body's findings must survive). Return only: status, a
one-line test summary, and concerns.
