# Question 3.4 — the cursor table: does it classify in the order written, and can a member weaponise it?

**The question, verbatim from the plan:**

> Does the cursor table classify in the order written — and can a member weaponise it?
>
> - **Assumption:** the G18 trigger keyed on **authorship** (not applicability) detects the crash
>   victim without handing any member a DoS.
> - **Done when:** every row of the cursor table has a test, and they fire **in the order written**.

Repo: `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. The tree is **green and
committed** at `9ab7026`. Questions 3.1–3.3 built the pull-driven commit lane, the commit frame, the
CAS loop, and the durable journal. **Read `packages/rpc/src/peer.ts` (`pullCommits`) first** — that is
the function this question rewrites.

---

## The spec, copied verbatim

### The table

| Frame | Cursor |
|---|---|
| Applied | advance; record this epoch → sequenceID for the D1 fork check |
| At an epoch this peer has no recorded applied-commit for (pre-join, pre-rejoin, re-seeded history) | advance, **no fork check, no unwrap attempt** — history, not a fork and not poison |
| At an epoch this peer *has* a record for, with a different sequenceID | advance; the fork trigger (D1) |
| **At the peer's current epoch, committed by *this peer*, unmergeable (pending state lost)** | **do not advance; heal trigger → `recover()`** (G18, narrowed by G19 — the predicate is authorship, *not* "cannot apply") |
| Malformed, or policy-rejected (`CommitRejectedError`) | advance (poison — never retry) |
| `MissingLedgerEntriesError` | **do not advance**; gather the missing ids, retry the frame (bounded); on exhaustion, advance and escalate to `recover()` |

> **The rows are evaluated in the order written.** Epoch classification comes first (G11: no
> unwrap before it), the un-merged own-commit row comes before the poison row (G18: otherwise a
> crash victim's own commit is filed as malformed and the peer walks cheerfully to
> `reconciledHead == head`), and poison is the last resort, never the fallback for "I could not
> apply this".

### The discriminator (G18/G19)

> **Un-merged own commit (G18, narrowed by G19).** A valid frame framed at the peer's **current**
> epoch **whose committer is this peer**, which it cannot merge. This is the crash-window victim:
> the hub accepted its commit, the group advanced, and the pending state died with the process —
> MLS *merges* a pending commit, it does not *process* one, so the peer can never apply the frame
> that is its own commit. Action: `recover()`.
>
> **The discriminator is authorship, not applicability.** "A valid frame at my current epoch that I
> cannot apply" — revision 8's wording — is not a description of this condition, it is a description
> of *every* frame a peer fails to apply, since the frame you are about to apply is always at your
> current epoch. It swallows the two rows beneath it: a policy-rejected commit (well-formed,
> deliberately refused) and a `MissingLedgerEntriesError` frame (well-formed, and *by definition* at
> the current epoch, since that is the only epoch whose frames a peer resolves). Left that way it is
> a **member-triggerable group-wide DoS**: the hub is blind and cannot judge a commit, so any member
> — including a removed one, who keeps `commitTopic` and its subscription forever — publishes one
> well-formed, policy-rejected commit at the current head, and *every* honest peer heals at once. A
> rendezvous, a sealed GroupInfo from every responder, an external commit, and CAS contention, from
> the whole group, repeatable at will.
>
> Both `readMessageEpoch` (the frame's epoch) and the committer's DID (`policy.ts`'s `didOfLeaf`
> over the commit's `senderLeafIndex`) are readable **without applying the frame**, and the
> committer is **MLS-authenticated, so authorship cannot be forged**. With authorship in the
> predicate the row stops overlapping its neighbours: someone else's policy-rejected commit is
> poison, a missing-bodies frame is a gather, and only the peer's own orphaned commit heals.

### And the general rule it teaches

> **a frame from an untrusted member must never be able to make an honest peer do expensive work**

---

## ⚠️ Wrong-but-passing — read this before you write a line

This question exists because the obvious implementation **passes the obvious test**.

**Trap 1 — the applicability predicate.** Define the trigger as *"a valid frame at my current epoch
that I cannot apply"* and the G18 crash-victim test passes **perfectly**. It also routes
policy-rejected commits and missing-bodies frames into `recover()`, so any member — *including a
removed one* — sends the whole group into a recovery storm with one publish. The G19 security test is
the only thing that separates the two implementations. **Build the wrong one, watch G19 go red,
revert.** Report the output.

**Trap 2 — and this one is subtler, so read it twice.** The obvious source for "who committed this?"
is **`message.senderDID`, and it is the wrong one.** `CommitContext.senderDID` says so already:

> the hub-authenticated publisher of the frame. This is the transport sender, **NOT** the
> MLS-cryptographic committer (the Commit authenticates its committer internally) — auxiliary
> information (logging, rate-limiting), not an authorization boundary.

`senderDID` **passes both G18 and G19.** The crash victim republished its own frame, so the transport
sender *is* the committer; the removed member's poison frame carries *their* DID, so nobody heals.
Both tests green, and the implementation is wrong — because **the hub is untrusted in this design**,
and `senderDID` is the hub's word. A hub that stamps each recipient's own DID onto a poison frame
makes **every peer in the group heal at once**: precisely the G19 storm, through the one party the
spec never trusted.

So the committer must be read **out of the commit itself**. In real MLS that is `senderLeafIndex` →
`didOfLeaf`, authenticated by the commit's own signature. **The memory port's commit does not carry a
committer today** (`encodeMemoryCommit(epoch, entryIDs)`) — so the double is not faithful about the
thing this question turns on, and **you must make it faithful**: the committer goes *inside* the
commit bytes, exactly as the epoch already does, for exactly the same reason.

**Then prove it.** Give the fake hub the ability to lie about `senderDID`, write the test where the
hub stamps a poison frame with the victim's own DID, and show an honest peer **does not heal**. Then
mutate the classifier to read `senderDID` and show that test goes red. If you cannot make the hub lie,
say so — but a `FakeHub` that cannot forge the one field the spec says is forgeable is not modelling
the threat.

---

## The other three things this question must settle

**1. The port must not *throw* on an inapplicable frame — it must return `{ advanced: false }`.**
Carried from 3.2. The lane's rule is *a throw leaves the cursor put and the frame is read again*. So a
`GroupMLS` adapter that lets ts-mls throw on a commit from an epoch it is not at **wedges a late
joiner on its own add-commit, forever**. Draw the line explicitly and document it on `GroupMLS`:
return `{ advanced: false }` for a frame it cannot apply; throw **only** for one it *should* have been
able to apply and could not — which is `MissingLedgerEntriesError`, the resolver miss, and the one
retryable outcome.

**2. A recovered peer must not re-apply the stale commits still in the log.** Carried from 3.1, and
**no existing test catches it — the recovery tests have no commit frames on the topic.** After
`applyRecovery` jumps the peer to epoch M, `reconciledHead` is unchanged, so the next pull walks
frames from epochs it has already passed. The table's second row is the answer (*advance, no fork
check, no unwrap attempt*), but nothing classifies a stale-epoch frame today, so it would
**double-advance**. The test: recover, then pull a log that still holds the commits you skipped, and
apply none of them.

**3. The one place tempted to grow a `console.warn` must stay silent.** A blob this peer cannot open
is **ordinary history** — a late joiner walking from `oldest` reaches the very commit that added it,
sealed under an epoch it never held. The resolver swallows that into "no entries" and there is no
channel by which it could be surfaced as corruption. **Do not log it as one.**

## The G18 test needs a note, because question 3.3 changed its shape

The journal now repairs the crash-window victim *without* a responder, so the G18 trigger is no longer
the primary path — it is the **fallback for a peer whose journal is lost or absent**. The spec says so:

> **The journal is lost or absent → the G18 trigger still fires.** The peer detects its own un-merged
> commit and heals via a responder (the multi-member fallback), rather than walking to
> `reconciledHead == head` with a clean bill of health.

Write the G18 test **with an empty journal**, and assert the peer's **epoch advanced**. An
implementation missing this row walks to `reconciledHead == head` and **reports itself healthy** —
which is why "no error was thrown" is not the assertion.

## The bounded-retry row is what makes the group survive an attack question 3.3 could not close

Question 3.3's epoch guard refuses a *misbehaving host* on its own device. It does **not** stop a
**modified peer** from publishing an unopenable frame anyway, and we reproduced what that costs today:
an honest member applies the frame, cannot open its blob, `processCommit` throws, **his cursor never
advances, and he can never commit again.** The last row of this table — *gather, retry bounded, and on
exhaustion advance and escalate* — is what turns that permanent wedge into a bounded cost. **Write that
test**: a frame whose bodies nobody can supply must not stall the lane forever. This is the row that
closes the attack, and it is the reason the row says *advance on exhaustion* rather than *retry
forever*.

---

## Approach

Classification is a decision over `(frame, this peer's state)` made **before** applying anything, so it
wants to be a pure function that a test can drive directly, row by row, without a hub. Suggested:
`packages/rpc/src/classify.ts`, consumed by `pullCommits`. Take that or better it — but if you diverge,
say why in the report. The rows must be **testable in isolation** *and* observable **in order**: a test
that only drives them end-to-end through the hub cannot show that row 4 precedes row 5, which is the
property G18 turns on.

You will need, readable without applying a frame: the frame's **epoch**, its **committer** (from the
commit, not the transport), this peer's **current epoch**, this peer's **own identity**, and the
peer's record of **epoch → sequenceID for commits it has applied** (for the fork check). Decide where
each lives and say so.

## Definition of done

- Every row of the table has a test.
- The **order** is demonstrated, not assumed.
- **The G19 security test** — a removed member publishes a well-formed, policy-rejected commit at the
  current head, and **nobody heals**.
- **The G19 hub variant** — the hub stamps the victim's own DID on it, and **still nobody heals**.
- **The G18 test** — journal absent, crash victim meets its own commit, and **its epoch advances**.
- **The stale-commit test** — recover, then pull a log holding the commits you skipped, apply none.
- **The unopenable-frame test** — a frame nobody can supply bodies for does not stall the lane forever.
- Both mutation checks (applicability predicate; `senderDID` as committer), each with its red output,
  each reverted.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q3.4:`, no `// G19`. State the invariant directly, for a reader with no plan in hand. The
comments already in `peer.ts` and `commit.ts` are the model.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- If the approach does not work, **STOP and report `BLOCKED`** with what you found. Do not invent an
  alternative design. The last two probes' `BLOCKED` results were their most valuable output — one of
  them killed a fix the user had already approved, and was right to.
- **Do not commit.** Leave the work in the tree.

## Report contract

Write the full report to `docs/superpowers/probes/question-3.4-report.md`. Include both mutation checks
with exact red output, and the full verify output. Return only: status, a one-line test summary, and
concerns.
