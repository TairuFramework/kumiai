# Question 3.3 — follow-up 2: journal the acceptance

**Read first, in order:**

1. `docs/superpowers/probes/question-3.3-brief.md` — the original brief.
2. `docs/superpowers/probes/question-3.3-report.md` — **especially §C of the follow-up section**, which
   is the finding this brief acts on. Everything below assumes you have read it.
3. The repo's `CLAUDE.md` / `AGENTS.md`.

**The tree is currently GREEN** (rpc 112, hub-server 57, mls 283, integration 23) with uncommitted work
on `feat/control-ledger-lane`. Keep it that way. **Do not commit.**

---

## What §C found, in one paragraph

Replay **re-seals** the bodies (`replayJournal` → `frameCommit` → `crypto.wrap`). Re-sealing at the
wrong epoch publishes a blob no member can open, which wedges the whole group. The obvious guard —
journal the epoch, refuse to re-seal at a different one — **was built, and it has zero discriminating
power**: a legal crash between `onAccepted` and `clear` leaves the handle at epoch N+1 with a journal
entry framed at N, which is byte-for-byte the same state as a misbehaving host that adopted early and
never landed its publish. The probe printed both. They are identical.

The information that separates them is **"was the publish accepted?"** — and the journal does not
record it.

## The approved fix: record it. Locally, and at the right moment.

`JournalEntry` gains **two** fields, and `CommitJournal` gains **one method**:

```
JournalEntry:  + epoch: number          // crypto.epoch() at put time
               + acceptedAs?: string    // the sequenceID the hub returned. Absent: unknown.

CommitJournal: + markAccepted(publishID: string, sequenceID: string): Promise<void>
```

`markAccepted` takes the `publishID` for the same reason `clear` does: it can only ever mark the entry
it was given, never somebody else's.

### The ordering is the whole trick

`markAccepted` fires **between the hub's answer and `onAccepted`** — *before* it, while the handle is
still at the pre-commit epoch. That is what makes the later epoch check discriminating:

```
crash after onAccepted, before clear   → acceptedAs SET,     epoch N+1  → adopt, clear. LEGAL   ✓
host adopts early, publish never lands → acceptedAs ABSENT,  epoch N+1  → REFUSE.       ILLEGAL ✗
```

Record the acceptance *after* `onAccepted` instead and the legal crash looks exactly like the attack
again — you are back to §C. **This ordering is load-bearing and you must pin it with a test** (see the
mutation check below).

### `commit()` — the new step ordering

```
put({ publishID, expectedHead, epoch: crypto.epoch(), commit, bodies, kind, journal })
publish → sequenceID
markAccepted(publishID, sequenceID)     ← NEW. Before onAccepted, while the handle is still at N.
onAccepted()
reconciledHead = commitLogHead = asLogPosition(sequenceID)
clear(publishID)
rebuildEpoch()
```

### `replayJournal` — now routes on acceptance

```
entry = get(); if null → return false

if (entry.acceptedAs != null):
    It LANDED, and we know it locally. No publish, no re-seal, NO NETWORK.
    reconciledHead = commitLogHead = asLogPosition(entry.acceptedAs)
    adoptJournalled(entry.journal)      // idempotent, as it already must be
    clear(entry.publishID)
    return true

We are about to RE-SEAL, which is only safe at the epoch the commit was framed at:
if (crypto.epoch() !== entry.epoch):
    throw <named error>

...the existing publish path, unchanged (dedup, HeadMismatchError → lostCommit, etc)...
```

On the accepted-known path, set `commitLogHead` as well as the cursor — this peer's own frame was the
tip when it landed. If others have committed since, the next compare-and-set simply loses and rebases;
a stale head is safe in that direction, a wrong one is not.

### The window this leaves open, and why it is already correct

A crash **between the hub's answer and the `markAccepted` write**: `acceptedAs` is absent, but the
frame is in the log. The host has **not** adopted (`onAccepted` has not run), so the handle is still at
epoch N, so the epoch check **passes**, so replay republishes — and **the store's dedup returns the
original sequenceID and appends nothing.** That is the mechanism already built and tested in the main
body of this question. It needs no new code. **Write a test for it anyway** — it is the seam between
the new local record and the old idempotency, and nobody has crossed it yet.

### The error

Named, exported from `commit.ts`, with a doc comment. The message must tell the host **what it did
wrong**, not merely what was observed. The shape the earlier attempt used was right:

> `commit replay: the journalled commit was framed at epoch 1, and this group is now at 2. A commit is
> adopted in onAccepted, and nowhere else.`

---

## Tests

1. **`replay is idempotent` (existing) must stay green — and must now take the no-publish path.**
   Strengthen it: assert the replay of an accepted commit **publishes nothing**. A frame count on the
   fake hub, or a publish counter. Today it passes by re-sealing and republishing into the store's
   dedup; it must now pass by never touching the network. If it still passes when the network is
   unreachable, that is the assertion.

2. **The misbehaving host is REFUSED.** It adopts out of band while the publish is in flight, dies
   without learning the outcome, restarts. Replay throws the named error. **Assert the poison frame
   never lands** — a group-wide wedge is what this is for, so check the group, not just the throw.

3. **The crash between the hub's answer and `markAccepted`.** Replay republishes, dedup answers with
   the original sequenceID, the commit is adopted once, the log has one frame. See above.

4. **MUTATION CHECK — the one that matters.** Move `markAccepted` to *after* `onAccepted`, run the
   suite, and **`replay is idempotent` must go red.** Report the exact failure. Then revert. If it
   stays green, the ordering is not pinned by anything and you must say so plainly — that is a finding,
   not a formality.

Also mutate: **drop the epoch check entirely** (keep `acceptedAs`) and confirm test 2 goes red. The two
fields do different jobs and each must be shown to carry its own.

The journal fixture (`packages/rpc/test/fixtures/journal.ts`) needs `markAccepted`. Its
`putWhileOccupied()` counter — the one that proves the single slot **is** the commit mutex — must not
count a `markAccepted` as a `put`. Check that it still reads 0.

## Docs to update

- `CommitJournal`'s doc comment in `commit.ts` says the slot is written once, before the publish. It is
  not any more. Say what it now is, and say **why the second write lands where it does** — a host
  implementing this must not "optimise" it to after `onAccepted`.
- `PendingCommit.onAccepted`'s comment carries the "sole adopt point" argument. It is now **enforced**,
  not merely asserted. Update it to say so, and to say what the peer does when a host breaks it.

---

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q3.3:`, no `// §C`. State the invariant directly, for a reader with no plan in hand.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- If the approach does not work, **STOP and report `BLOCKED`** with what you found. Do not invent an
  alternative design. The blocker is the finding — that is exactly how §C happened, and it was the most
  valuable result of the last probe.
- **Do not commit.**

## Report contract

**Append** a section titled **"Journalling the acceptance (follow-up 2)"** to
`docs/superpowers/probes/question-3.3-report.md`. Do not overwrite: the main body and follow-up 1 must
survive. Include both mutation checks with their exact failure output, and the full verify output.

Return only: status, a one-line test summary, and concerns.
