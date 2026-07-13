# Probe brief — Question 3.2

## The question

**Do bodies ride the commit frame, and is classification before unwrap?**

- **Assumption:** `[commit][wrap(bodies)]` under the **pre-commit** epoch secret makes first-delivery
  resolution automatic, and history stays *readable* without being *unwrappable*.
- **⚠️ Wrong-but-passing:** **unwrapping the blob as part of parsing the frame.** It is the obvious
  shape — decode the frame, you have a commit and some bodies. The cursor still advances (both rows
  of the table say advance), so **every test passes**. And ordinary history — every frame from an
  epoch the peer wasn't at — gets classified and logged as **poison**. That lie costs someone a day
  the first time they debug a real log.

The invariant, and the sentence to hold the implementation against:

> **Unwrapping is a *consequence* of "I can apply this frame", never a precondition of reading it.**

## Scope

**In scope:** the commit frame's body blob, `GroupCrypto.wrap` under the pre-commit epoch secret, the
`resolveLedgerEntries` resolver serving from the in-flight frame, and `getLedgerEntries(ids)` for
serving a gather. `packages/rpc/src/` (the frame codec and the lane's read path), plus the one
`GroupMLS` method.

**Out of scope, and do not build:** the CAS/journal loop (3.3), the cursor-advance *classification
table* (3.4 — this question must not classify anything as a fork or a heal), recovery wiring (3.5+),
the epoch/mailbox interlock (3.7). The **gather over the app lane** on a resolver miss is 3.5's
(it only happens after an external-commit rejoin) — build `getLedgerEntries` so a gather can be
served, but do not build the requester's gather loop.

## Spec excerpt (verbatim — this is the contract)

> **The commit frame carries the bodies.** The frame becomes `[commit bytes][wrapped body
> blob]`, where the blob is the signed tokens the commit enacts, encrypted with
> `GroupCrypto.wrap` under the **pre-commit** epoch secret. Every peer that can apply the
> commit is at that epoch and holds that secret; the hub never sees a body.
>
> This deletes the publish-bodies-before-the-commit ordering rule entirely. Body delivery is
> atomic with the commit, so first-delivery stranding is impossible by construction rather
> than merely retryable. A peer further behind cannot unwrap the blob — but it cannot apply
> the commit either. It processes the log in sequence order, and each commit's blob is
> unwrappable by the time that commit is the next one it can apply.
>
> The MLS control envelope stays ids-only. This is the transport frame, not the AAD.
>
> **Resolution and catch-up.** The peer supplies the resolver the host wires into
> `GroupHandleParams.resolveLedgerEntries`. It serves from the bodies unwrapped from the
> in-flight frame; on a miss — an external-commit rejoin, whose GroupInfo carries no ledger —
> it gathers the missing ids from current members over the encrypted app lane. Serving a
> gather needs one new `GroupMLS` method:
>
> ```ts
> getLedgerEntries(ids: Array<string>): Promise<Array<string>>  // signed tokens, from handle.ledger
> ```
>
> The requester re-verifies every returned token and checks each digest against the id it
> asked for, so a lying responder can only fail to answer, never inject.

And from the cursor-advance rule (the classification this question must *not* break):

> **Classify by epoch first; unwrap only what you can apply (G11).** The blob is sealed under
> the *pre-commit* epoch secret, so a peer walking history — the late joiner, the rejoiner,
> the re-seeded peer, all of which the design now expects to do exactly this — reaches frames
> whose blob it can never open, **including the commit that added it**. Unwrapping is therefore a
> *consequence* of "I can apply this frame", never a precondition of reading it. A naive
> implementation that unwraps before classifying sees ordinary history as a decryption
> failure: the cursor still advances (both rows say advance), but the frame is logged as
> poison, and that lie costs someone a day the first time they debug a real log.

## Done when

1. **The frame carries the blob.** `[commit bytes][wrapped body blob]`, blob wrapped with
   `GroupCrypto.wrap` under the **pre-commit** epoch secret. Length-framed so the two halves are
   unambiguous. The commit half is readable **without** the blob being openable — that is the whole
   design.

2. **The three-member test — the deliverable.** An admin enacts a ledger entry; a third member has
   **never seen the body**; it **applies the commit on first delivery, with no gather**. Assert there
   was no gather — over the wire, not by inspecting internals.

3. **The G11 test — the one the wrong implementation fails.** A late joiner walks frames whose blob
   it **cannot unwrap** — *including its own add-commit*, which is framed at the epoch **before** it
   was a member — and classifies **none of them as malformed or poison**. Its own add-commit is the
   sharp case: the obvious implementation reports the frame that *created* this peer as corrupt.

4. **The resolver serves from the in-flight frame.** `resolveLedgerEntries` is fed the bodies
   unwrapped from the frame being applied. On a miss it does **not** crash — it returns nothing and
   the frame raises `MissingLedgerEntriesError` (which the lane already handles by not advancing;
   the gather that answers it is 3.5's).

5. **`getLedgerEntries(ids)` lands on `GroupMLS`**, serving signed tokens from `handle.ledger`, so a
   gather *can* be served. Do not build the requester's side.

6. **The mutation check** — same standard as every phase so far. Move the unwrap into frame parsing,
   and show the G11 test fails: the late joiner's own add-commit classifies as malformed. Paste it.
   Revert. *A test that would pass against the wrong implementation is not a test.*

## What question 3.1 left you

- The lane is pull-driven; `pullCommits` (`peer.ts:313`) is **the only place a commit frame is read**.
  The cursor advances on four paths and on no path when `processCommit` throws.
- The frame payload today is a stub — this question makes it real.
- **Do not touch** the `selfCommitted` set (3.3 replaces it) or add stale-epoch classification (3.4).

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- The hub must never see a body. If any code path would publish an unwrapped token, that is a finding.
- The MLS control envelope stays **ids-only**. The blob is the transport frame, not the AAD.
- Everything currently green stays green (rpc 77, mls 283, integration 23).

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("a frame whose blob this peer cannot
open is history, not poison").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required), plus the integration tests. Include the output.

## Report contract

Write to `docs/superpowers/probes/question-3.2-report.md`:

- The frame's wire shape, `file:line`. How the two halves are delimited, and how the commit half is
  read **without** the blob being touched.
- **Where the unwrap happens, and how the code makes "parse" and "unwrap" impossible to conflate** —
  structurally if you can, and say plainly if it is only by discipline.
- **The three-member test and its pasted output**, including the assertion that no gather occurred.
- **The G11 test and its pasted output** — the late joiner walking its own add-commit.
- **The mutation check**: unwrap-in-parse → the G11 test fails. Pasted, then reverted.
- Whether a peer can be made to log ordinary history as poison by any *other* route.
- What 3.3–3.7 will need that this does not yet have.
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
