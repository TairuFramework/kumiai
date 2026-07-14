# Question 3.5 — does `recover()` heal without nesting, and re-enact by membership?

Repo `/Users/paul/dev/yulsi/kumiai`, branch `feat/control-ledger-lane`. **Tree is green and committed
at `d930956`** (rpc 137, 27/27). Questions 3.1–3.4 built the pull-driven lane, the commit frame, the
CAS loop with its durable journal, and the cursor classification table. **This question builds
`recover()` on top of them.**

Read first: `packages/rpc/src/peer.ts` (`recover`, `runSerial`, `pullCommits`),
`packages/rpc/src/classify.ts`, `packages/rpc/src/commit.ts`, `packages/mls/src/recovery.ts`.

---

## The question

> **Assumption:** `recover()` is its own lane operation with its own CAS loop; re-enactment is a
> *subsequent* `commit()` filtered by ledger membership.

## ⚠️ Wrong-but-passing — the reason this question exists

> Re-enacting whatever was in flight. It passes the byzantine-fork test (where the entries genuinely
> never landed) and **silently reverts another admin's change** on the crash path, where the hub
> *accepted* the commit and the entries are already in everyone's ledger. `mls` does not dedup — a
> re-appended entry wins the fold. **No error, no conflict, no signal.**

The spec's own worked example, verbatim — **this is the test you must write**:

> Admin A commits `circle.def X → name "Foo"`. The hub accepts; A crashes before adopting.
> Admin B commits `circle.def X → name "Bar"`. Everyone applies it. The circle is "Bar".
> A heals, rejoins, bootstraps, re-enacts "Foo". The ledger is `[Foo, Bar, Foo]`, the fold is
> last-write-wins by position, and **the circle is "Foo" again** — B's change reverted by a peer that
> crashed, with no error, no conflict, and no signal anywhere.

**The rule is membership, not provenance:** *an entry is re-enacted if and only if the group's
authenticated ledger does not already contain it* — **never** because of which failure brought the peer
here. Bootstrap has already fetched the whole ordered, head-verified ledger, so the filter is local and
free.

| Heal path | Hub accepted its commit? | Entries in the group's ledger? | Re-enact? |
|---|---|---|---|
| Trim strand | never committed | nothing in flight | no-op |
| **Crash / `onAccepted` threw** | **yes — acceptance is what defines this path** | **yes** | **must NOT** |
| Byzantine losing branch | only on a branch the group discarded | no | **must** |

**Assert the value, not the absence of an error.** The failing implementation throws nothing.

---

## The spec, verbatim

### One serialized lane; heal never runs nested (G13)

> `commit()` holds the per-group mutex for its whole run, and its first step *pulls and processes*
> frames — which is what fires the heal triggers. So heal is reachable from inside the mutex, and
> `recover()` both mutates the handle and ends by re-enacting entries through `commit()`. Nesting it
> either way is broken: take the mutex and a heal triggered inside `commit()`'s pull deadlocks (twice
> over, on the tail call); skip the mutex and a concurrent `commit()` builds against the pre-rejoin
> handle while `recover()` swaps it out — the exact hazard the mutex exists for, on the path where the
> handle is least stable.
>
> **All three operations — pull, `commit()`, `recover()` — are top-level operations on one serialized
> per-group lane. None of them ever calls another. The mutex is never re-entered.**
>
> - A heal trigger fired while processing a frame **records the condition and returns**. It does not
>   heal in place. The pull finishes, the enclosing `commit()` unwinds and releases the lane, and its
>   caller sees a retryable outcome.
> - `recover()` then runs as its **own** lane operation, taking the mutex itself.
> - Re-enactment after a successful heal is a **subsequent** `commit()`, queued on the lane after
>   `recover()` releases it — which is just "heal is two commits, not one" (G10) falling out of the
>   concurrency rule rather than being bolted onto it.
> - A `commit()` that was in flight when heal was triggered re-enters the lane behind `recover()` and
>   rebuilds, if it is still within its deadline.

### `recover()` is a CAS loop of its own (G10)

> - **The external commit is CAS'd**, at the head, seeded from `fetchTopic` exactly as a fresh member
>   seeds it. Publishing it unconditionally would re-open the fork D1 exists to close, on the worst
>   possible path.
> - **Losing the CAS is the likely case, not the edge case** — heal runs precisely when the group is
>   under commit pressure, and two peers healing concurrently race each other. But a heal retry is
>   **not** shaped like `commit()`'s: the peer cannot simply rebuild, because its GroupInfo is now
>   **stale** — it describes a ratchet tree the winning commit has already changed. It must **discard
>   the GroupInfo**, re-request it, and rebuild the external commit from the fresh one.
> - **Heal is two commits, not one.** `joinGroupExternal` returns `{ commitMessage, group }` and
>   carries no entry envelope, so it cannot re-enact anything. The entries ride a *subsequent* ordinary
>   `commit()`, which contends on the CAS like any other. "Rejoin and re-enact" is two acts, and the
>   second one can lose.

```
recover(deadline):                          # a top-level lane operation; holds the mutex
  loop until deadline:
    pull commitTopic to the end             # may resolve the strand outright: nothing to heal
    requestID = fresh
    request = mls.createRecoveryRequest(requestID)   # ephemeral HPKE key, signed
    publish request on rendezvousTopic, await a sealed reply
    pending = mls.applyRecovery(sealed, requestID)   # opens with the ephemeral key,
                                                     # builds the external commit
    publish pending.commit to commitTopic with expectedHead = <the head>
      accepted     -> pending.onAccepted()            # adopt the rejoined handle
                      <cursor and head> = returned sequenceID
                      bootstrap()                     # REQUIRED: the rejoined handle's ledger
                                                      # is empty, which is a roster reset until
                                                      # this runs. Gathers the WHOLE ordered
                                                      # ledger, head-verified. Failure is a
                                                      # persistent degraded state, NOT a heal:
                                                      # keep retrying; never return advanced:true
                                                      # with an incomplete ledger.
                      # Re-enact by MEMBERSHIP, not by failure mode: keep only the
                      # in-flight entries whose ids the bootstrapped ledger does not contain.
                      return { advanced: true, reenact: inFlight.filter(id not in ledger) }
      HeadMismatch -> discard the GroupInfo AND the external commit built from it
                      continue the loop
  deadline exceeded -> return { advanced: false }

# The caller re-enacts `reenact` via an ordinary commit() — a SEPARATE lane operation,
# queued after recover() releases the mutex. recover() never calls commit().
```

### `recover()`'s acceptance window is deliberately unjournalled (G23)

> `recover()` has `commit()`'s shape — publish, accept, *then* adopt — so a crash in that window
> leaves an orphaned external commit in the log. It converges anyway:
>
> - On restart the peer holds its old, broken handle. It pulls, and its orphaned external commit is in
>   the log framed at the **group's** epoch E — not at the peer's own stale epoch N. The heal trigger
>   tests authorship **and** current epoch: authorship matches, the epoch does not, so it stays quiet
>   and the frame classifies as *history → advance*.
> - The peer's original condition still holds, so it trips again, re-enters `recover()`, and builds a
>   **fresh** external commit against a fresh GroupInfo. That one lands.
> - `joinGroupExternal({ resync: true })` "atomically removes prior leaf for same identity", so the
>   second rejoin collects the leaf the orphaned first one added. **Leaves do not accumulate.**

### The precondition, which must be stated (G21)

> **heal requires at least one other member that is online, holds the group, and can seal a
> GroupInfo.** It is a rendezvous; without a responder it cannot work. When none answers, `recover()`
> burns its deadline and returns `{ advanced: false }`, and the peer stays degraded and retries.

---

## Definition of done

- **The G17 test — the spec's worked example, exactly.** A's commit accepted, A crashes, B overwrites
  the same subject, A heals. **A's entry is not re-enacted and B's value stands.** Assert the folded
  value is `"Bar"`. The wrong implementation produces `"Foo"` and throws nothing.
- **The byzantine-losing-branch test** — entries that genuinely never landed **are** re-enacted. This
  is the other half of the membership rule, and an implementation that re-enacts *nothing* passes G17
  and fails here.
- **`recover()` CASes**, and on `HeadMismatchError` **discards the GroupInfo** — not just the commit —
  re-requests, and rebuilds. **Mutation-check this**: retry the same external commit against the
  changed tree and show what breaks. A peer that merely retried the commit would wedge.
- **Two peers healing concurrently** both converge. One wins; the other re-requests. Both end in the
  roster; neither loses its entries.
- **The G13 test — no deadlock.** A heal triggered while `commit()` is pulling: the trigger records,
  `commit()` unwinds and releases, `recover()` runs as its own operation. **Mutation-check the nesting:
  call `recover()` from inside the pull and show it deadlocks.** Question 3.3 proved the callback
  version of `lost` deadlocks by building it; do the same here.
- **The G23 test** — a crash inside `recover()`'s own acceptance window converges by re-recovery, with
  **exactly one leaf** (`resync: true` collects the orphan). Assert the leaf count.
- **Bootstrap failure is a degraded state, not a heal.** `recover()` must **never** return
  `advanced: true` with an incomplete ledger. A rejoined handle's ledger is **empty**, which is a
  **roster reset** until bootstrap runs — so an implementation that returns early here silently drops
  every member's role. Assert the roster.
- **No responder → `{ advanced: false }`**, deadline burned, peer degraded and retrying. Not a throw.

## Notes from the questions already answered

- `recover()` **already pulls inside its serialized body** (question 3.4 added this, so a recovered
  peer's stale cursor walks the skipped commits as history rather than re-applying them). Do not
  duplicate it.
- The heal trigger already exists and already unwinds `commit()` with a typed `RecoveryRequiredError`.
  Question 3.4 built the classification; this question builds what happens *next*.
- `packages/mls/src/recovery.ts` (question 2.2) has `createRecoveryRequest` / `sealGroupInfo` /
  `openSealedGroupInfo`, and question 2.3 built `bootstrapLedger` + `isLedgerComplete`, head-verified.
  **Use them. Do not rebuild them.**
- The **responder** side must gate its reply on `isLedgerComplete()` (question 2.3's finding) or it
  answers with an empty ledger.

## Conventions

`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`HTTP`/`JWT`/`DID`; ES
`#fields`, never `private`/`readonly`. pnpm only. **Never edit generated `lib/`.**

**Code, comments, and test names never reference plan questions, decision numbers, or phase labels** —
no `// Q3.5:`, no `// G17`. State the invariant directly. `classify.ts` and `commit.ts` are the model.

Verify from the repo root — **an `rtk` shim intercepts bare `pnpm run`**:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

## Stop conditions

- If the approach does not work, **STOP and report `BLOCKED`** with what you found. Do not invent an
  alternative design. Three probes in this plan have reported `BLOCKED` or surfaced a defect that
  killed an already-approved fix, and every one of them was right to.
- **Do not commit.** Leave the work in the tree.

## Report contract

Write the full report to `docs/superpowers/probes/question-3.5-report.md`. Include every mutation check
with its exact red output, and the full verify output. Return only: status, a one-line test summary,
and concerns.
