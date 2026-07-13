# Probe brief — Question 1.4

## The question

**Does the dedup record outlive the log?**

- **Assumption:** `publishID` can be stored with retention independent of trim, and the suite can
  prove it.
- **Done when:** republishing an accepted `publishID` returns the **original** sequenceID and
  appends nothing — **including after the log has been trimmed**. Retention is indefinite in
  `memoryStore`.
- **⚠️ Wrong-but-passing:** hanging the key off the message row. It is the natural implementation,
  it passes every other clause in the suite, and it fails only this one.

The two remaining red clauses are both here. Expected outcome: **15 passed / 0 failed of 15.**

This is the second of the suite's two load-bearing tests, and it is the same failure shape as the
first, one layer along: the zero-subscriber test proved the *log* is not delivery-derived; this one
proves the *idempotency record* is not log-derived.

## Why this is fatal rather than untidy

Copy this walkthrough into your head before you write the code, because it is the reason the record
must have its own lifetime — and it is *not* about tidiness or wasted rows:

> The creator `commitInvite`s. It journals, publishes, the hub **accepts**, and the process dies
> before `onAccepted` — so the invitee never got a Welcome and never became a member. **There is
> exactly one member in the world.** The user does not reopen the app for longer than the trim
> window. Trim removes the frame and, with it, the `publishID` record. The peer restarts and
> replays: the key is unknown, so the republish is treated as new — an ordinary CAS at the
> journalled `expectedHead` (`null`, the empty-topic sentinel, since it was the group's first
> commit). But `head` is still the sequenceID of its own trimmed frame, because **trim never
> touches `head`.** The CAS fails. And there is no other member to heal against.

The group is bricked. The only exit is the journal, and the journal's only exit is this record.
That is why its retention is contractually independent, and why "retain it indefinitely" is the
*recommended* implementation rather than a lazy one.

## Spec excerpts (verbatim — this is the contract)

```ts
export type PublishParams = {
  // ...
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original
   * sequenceID instead of appending again. This is what makes the commit journal's restart
   * replay work (see "Restart replay"), so its record has its OWN retention — it is not a
   * log entry and MUST NOT be trimmed with one.
   */
  publishID?: string
}
```

> - **The `publishID` → `sequenceID` dedup record is not a log entry, and trim must not remove
>   it.** It has its own retention, strictly longer than the commit-log trim window; **retaining
>   it indefinitely is the recommended implementation** — it is a hash and a sequenceID, one per
>   commit rather than one per delivery, a few dozen bytes. Hanging the key off the message row is
>   the natural implementation and it is **wrong**: trim would delete the idempotency record along
>   with the frame, and a replay of that `publishID` would silently become an ordinary new publish.
>   See "Restart replay" for why that is fatal rather than merely untidy.

From the Testing section:

> - **The dedup record outlives the log: publish with a `publishID`, trim the log, then republish
>   the same `publishID` — the original sequenceID comes back and nothing is appended.** A store
>   that hangs the key off the message row passes every other test here and fails this one, exactly
>   as a delivery-derived store passes everything and fails the zero-subscriber test. These two are
>   the suite's load-bearing tests.

## The approved approach

1. **A dedup map keyed by `publishID`, structurally separate from the log.** Same discipline that
   made `heads` correct in question 1.2: put it where no deleter can reach it. `removeLogEntry`,
   `trim` and `purge` must be *unable* to touch it, not merely careful not to. In `memoryStore` it
   is retained indefinitely.

2. **What a replay returns.** Republishing an accepted `publishID` returns its original sequenceID
   and appends nothing: no new entry, no new delivery rows, no sequenceID consumed, no event. Think
   about what this means when the original frame has been **trimmed away** — the sequenceID it
   returns names a frame that no longer exists, and that is *correct*. The caller is asking "did my
   publish land?", not "give me my frame". The journal's replay path depends on getting `yes, as
   this sequenceID` rather than `no, here is a fresh one`.

3. **Interaction with `expectedHead`, which is the subtle part.** A replayed publish carries *both*
   a `publishID` the store has seen and an `expectedHead` that is now stale (the head moved on after
   the original was accepted). **The dedup check must come first.** If the CAS is evaluated first,
   the replay raises `HeadMismatchError` — and the caller concludes its commit was lost when in fact
   it landed, which is precisely the confusion the idempotency key exists to prevent. State this
   ordering on the contract, in words.

4. **Contract wording.** On `PublishParams` / `HubStore`: the record is not a log entry; trim and
   purge must not remove it; its retention is strictly longer than the log's, and indefinite is
   recommended; the dedup check precedes the CAS.

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- Do not weaken a clause to make it pass.
- `hub.test.ts` and the integration tests stay green. A publish with no `publishID` takes exactly
  the path it takes today.

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("the dedup record is not a log entry
and no deleter may reach it").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required). Include the output.

## Report contract

Write to `docs/superpowers/probes/question-1.4-report.md`:

- Where the dedup record lives, and **why no deleter can reach it** — structurally, not by
  discipline. `file:line`.
- The pasted conformance output. Expected 15/15.
- The dedup-before-CAS ordering: what happens to a replay whose `expectedHead` is stale, and what
  *would* have happened in the other order.
- **Phase 1 exit check.** The phase's exit criteria are: `hub-protocol` exports a conformance suite;
  `memoryStore` passes all of it; and the suite **fails** a store that (a) hangs retention off
  delivery, (b) hangs dedup off the message row, or (c) mints sequenceIDs in-process. (a) and (b)
  are demonstrable — you have watched both fail. (c) is **not**, and the spec now says so. State
  plainly which of the three the suite actually catches, and which is a documented review item
  rather than a test. Do not claim the exit criteria are met if they are not.
- Anything a real SQL host will get wrong here that the suite does not catch.
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
