# Probe brief — Question 3.3

## The question

**Does the commit CAS loop converge, serialize, and journal?**

This is the question the whole plan exists for. It is where **concurrent commits stop forking the
group** — the original requirement (R3) that started this design.

- **Assumption:** build-without-adopting + CAS + discard-on-loss, under one per-group mutex, with the
  journal written **before** the publish.
- **⚠️ Wrong-but-passing, two of them:**
  - **Adopting `newGroup` when the hub accepts but before `onAccepted`.** Passes a single-committer
    test.
  - **Reusing the source handle across a retry.** Also passes a single-committer test, and it is the
    hazard `commitLedgerEntries` documents *in its own doc comment*: "two commits issued from the
    same source handle both frame at that handle's epoch and diverge."

## Scope

**In scope:** `GroupPeer.commit(build)`, the `CommitJournal` port, restart replay (step 0), the
per-group mutex, the CAS retry loop and its deadline, and `LostCommit` / `LaneResult`.

**Out of scope, and do not build:** the cursor-advance classification table (3.4 — no fork trigger, no
heal trigger, no stale-epoch drop), `recover()` (3.5), the epoch/mailbox interlock (3.7). Where this
question's code will *later* need one of those, note it; do not reach for it.

## What you already have

Read `docs/superpowers/probes/question-3.1-report.md` and `question-3.2-report.md` first.

- **The lane is pull-driven** (3.1). `pullCommits` (`peer.ts`) is the only place a commit frame is
  read; the cursor advances on four paths and on none when `processCommit` throws.
- **Most of the inversion is already built** (3.2). `localCommitted(commit, { ledgerEntries, adopt })`
  seals → publishes → `adopt()`s → rebuilds, and **errors if the host adopted first**. That is
  `commit(build)` seen from the other end: **`adopt` *is* `onAccepted`; `ledgerEntries` *is*
  `PendingCommit.bodies`.** Absorb it. Do not re-derive it, and do not leave both.
- **The frame is `[commitLength][commit][wrap(bodies)]`**, the blob sealed under the **pre-commit**
  epoch secret (3.2).

## Spec excerpt (verbatim — this is the contract)

```ts
type PendingCommit = {
  commit: Uint8Array            // framed MLSMessage(Commit)
  bodies: Array<string>         // signed ledger-entry tokens this commit enacts
  kind: 'ledger' | 'invite' | 'remove'   // replay routes on it, never parses the commit (G25)
  journal: Uint8Array           // opaque host blob: serialized newGroup + any Welcome. The peer NEVER inspects it (G21).
  onAccepted: () => Promise<void>        // runs only if the hub accepts
}

type CommitJournal = {          // durable single-slot, host-provided
  put(entry: { publishID; expectedHead: string | null; commit; bodies; kind; journal }): Promise<void>
  get(): Promise<JournalEntry | null>
  clear(publishID: string): Promise<void>
}

type LostCommit =
  | { kind: 'ledger'; tokens: Array<string> }
  | { kind: 'invite' | 'remove' }

type LaneResult = { lost?: LostCommit }

commit: (build: () => Promise<PendingCommit>) => Promise<LaneResult>
replay: () => Promise<LaneResult>       // run the lane's step 0 and hand back what it found
```

> **`commit` holds a per-group mutex for its whole run (G3).** CAS resolves races between
> devices; it says nothing about two callers on the same device. Two concurrent `build()`
> calls would both frame at the same handle's epoch and diverge — exactly the hazard
> `commitLedgerEntries` documents. The peer owns the commit loop, so the peer owns the
> serialization.
>
> Inside the mutex:
>
> 0. **Replay the journal (G22).** This is step **zero** of every lane operation, strictly ahead
>    of the completeness check and the pull — the ordering is load-bearing, not stylistic. A
>    peer that pulls first meets its own un-merged commit, fires the G18 trigger, and takes the
>    expensive rendezvous path the journal exists to avoid.
> 1. Pull `commitTopic` to the end and process everything. `reconciledHead` is now current.
> 2. Call `build()`. The host has produced `newGroup` but has **not** adopted it — mls commits are
>    non-mutating, returning a derived handle and never advancing the source.
> 3. **Journal the pending commit before publishing (G21)** with a fresh `publishID`. This write
>    must be durable before step 4 begins.
> 4. Frame `[commit][wrap(bodies)]` and publish with `expectedHead: reconciledHead` and that
>    `publishID`.
> 5. **Accepted** → set `reconciledHead` to the returned sequenceID, run `onAccepted()`, clear
>    the journal slot, rebuild the epoch.
> 6. **`HeadMismatchError`** → clear the journal slot and drop the `PendingCommit` untouched.
>    Discarding costs nothing, and the pre-commit leaf key material is retained, which the heal
>    path needs. Go back to step 1: pull the winning commit, let the host's handle rebase as it
>    applies, and call `build()` again against the now-current handle.
>
> **The retry bound is a deadline, not an attempt count.** At the commit rate D1 is designed
> for, with several active admins, five consecutive CAS losses on a busy group is not rare —
> an attempt count turns ordinary contention into a thrown error. `commit` retries until a
> configurable deadline (default 30s), with a large attempt ceiling retained only as a
> runaway guard. **Losing a CAS is the expected path, not an error path.**
>
> `build()` must read the host's *current* handle on every call — it is a closure, so this is
> natural — and must have no side effects until `onAccepted` runs.

### Restart replay (G21, G25, G26, G27)

> **Before any lane operation, the peer replays its journal.** If the slot holds an entry, the
> peer republishes it with the **same `publishID` and the same `expectedHead`**. The store's
> idempotency contract decides the outcome, with no responder and no network peer involved:
>
> - **The original publish was accepted** → the store returns its original sequenceID and
>   appends nothing. The peer adopts the journalled `newGroup`, delivers the journalled Welcome,
>   sets `reconciledHead`, and clears the slot. It is whole.
> - **It was never accepted** → the republish is an ordinary CAS at `expectedHead`. It wins, or it
>   takes `HeadMismatchError` — and what happens to the work depends on what the commit was.
>
> **Replay's `HeadMismatchError` cannot "rebuild like any other loser".** Inside `commit()` that
> phrase is fine: losing means going back to step 1 and calling `build()` again, and `build()` is
> a live closure over the host's current handle. **After a restart there is no closure** — the
> process that held it is gone. So the branch routes on `kind`:
>
> | `kind` | What replay hands back |
> |---|---|
> | `ledger` | **The journalled tokens, re-issuable.** Entry tokens are signed and epoch-independent, so the work survives the restart intact. The host issues an ordinary `commit()` over them. Nothing is lost. |
> | `invite` / `remove` | **A failure notice: this did not happen, and it cannot be given back.** The intent lives in the MLS Add/Remove proposal and the KeyPackage, not in `bodies`, and neither survives without `build()`. The host must re-issue it or tell the user. |
>
> **Replay never re-enacts anything. It surfaces what survived and what did not (G26)** — **as the
> lane operation's return value, after the mutex is released (G27)**, never as a callback fired
> under the lock. Replay runs at lane step 0, *inside* the mutex, and the host's response to it is
> to call `commit()`, which takes that same mutex. **A callback fired under the lock whose
> documented purpose is to make the host re-enter the lock is precisely the nesting G13 forbids,
> and the obvious host handler deadlocks.**
>
> **Silently clearing the slot is the one thing that must not happen.** For an invite it loses an
> invitation; for a **remove** it is worse than data loss — the admin clicked evict, the process
> crashed, and from their side the member is gone while in fact they are still in the group, with
> no signal to anyone. **An admin who believes a member was evicted when they were not is a
> security-relevant no-op, not a UX wrinkle.**
>
> **`onAccepted` MUST be idempotent — replay can and will run it more than once (G22).** The
> sequence *publish → accepted → `onAccepted()` → `clear(publishID)`* is three steps and a crash
> can land between any two of them. Re-adopting the journalled `newGroup` is harmless — it is a
> fixed serialized value. **Re-delivering the Welcome is not:** a second `processWelcome` over the
> same bytes errors or builds a duplicate group state. The host must write both halves to tolerate
> a repeat. The journal's whole purpose is to make a commit *look* atomic, and that framing is
> exactly what hides the at-least-once semantics underneath — so state them.

## Done when

1. **Two admins at epoch N → one wins.** The loser rebases and **its entries land in a later
   commit**. No fork; no lost entries. Assert the loser's entries are in the group's ledger at the
   end — "it didn't throw" is not the test.

2. **Two concurrent same-device `commit()` calls serialize. Both land.** Neither builds against a
   superseded handle. This is the mutex, and it is the one CAS cannot help with.

3. **The journal is written before the publish, and cleared on both terminal outcomes** — accepted,
   and `HeadMismatchError`. Prove the *ordering*, not just that both happen.

4. **Retry is a deadline, not an attempt count.** Configurable, default 30s. A large attempt ceiling
   may remain as a runaway guard. **Losing a CAS is not an error path** — a test where a peer loses
   several CASes in a row and still lands must pass without a thrown error.

5. **Restart replay.** Publish, kill the peer *before* it records the outcome, restart, replay:
   - accepted-then-crashed → the store returns the original sequenceID, nothing is appended, the peer
     adopts and is whole;
   - never-accepted, and someone else won → routes on `kind`: `ledger` hands back its **tokens**;
     `invite`/`remove` hands back a **failure notice**. The slot is **never** silently cleared.
   - `lost` is a **return value**, delivered after the mutex is released. **Write the obvious host
     handler — one that calls `commit()` on the loss — and show it does not deadlock.** If it is
     delivered as a callback, it will.

6. **`selfCommitted` dies.** 3.1's in-memory set is replaced by the journal. The test: publish, kill
   the peer before it records, restart, pull — **the commit is applied exactly once**. Today that set
   is memory-only, so this is a real restart bug closed.

7. **The two mutation checks.**
   - Adopt on hub-accept, before `onAccepted` → show which test fails.
   - **Reuse the source handle across a retry** → show the fork. This is the one the mls doc comment
     warns about; if no test catches it, the test suite is not done.

## A decision to make deliberately, not by accident

**Does the journal hold the bodies, or the sealed frame?** Replay republishes; the frame must be
sealed under the **pre-commit epoch secret**. The peer is still at that epoch on replay — adoption
happens in `onAccepted`, and a crash before acceptance means no adoption — so **re-sealing works**.
But that holds **by an argument, not by construction**. Journalling the already-sealed frame makes it
hold by construction, at the cost of a journal holding ciphertext it cannot re-key (and the spec's
`CommitJournal` type says `bodies`). **Pick one, say why, and say what breaks if the argument you
relied on ever stops being true.**

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- **The peer never constructs a commit — only the host does, via `build()`.** Every "re-enactment"
  (replay, and later heal) is the host committing again over tokens the peer preserved. A peer that
  could rebuild a `ledger` commit itself would gain a second, private way to commit.
- The peer **never inspects** `PendingCommit.journal`. It is an opaque host blob.
- Do not build 3.4–3.7.
- Everything currently green stays green (rpc 93, mls 283, integration 23).

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("the journal is written before the
publish", "losing a CAS is the expected path").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required), plus the integration tests. Include the output.

## Report contract

Write to `docs/superpowers/probes/question-3.3-report.md`:

- The loop, step by step, `file:line`. Where the mutex is taken and released; where the journal is
  written relative to the publish; where `onAccepted` runs.
- **The two-admin convergence test and its pasted output** — including the assertion that the
  loser's entries landed.
- **The same-device serialization test and its pasted output.**
- **Restart replay**: all three outcomes, pasted. And the host handler that calls `commit()` on a
  loss, **not deadlocking** — that is G27 earning its place.
- **The two mutation checks**, pasted, then reverted.
- **The journal-holds-what decision**, argued.
- Whether `onAccepted`'s at-least-once semantics are *documented on the type* where a host will read
  them, and what a host that ignores them breaks.
- What 3.4–3.7 will need that this does not have.
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
