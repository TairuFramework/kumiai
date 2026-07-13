# Probe brief — Question 2.3

## The question

**Does head-verified ledger bootstrap reject a doctored ledger?**

- **Assumption:** `computeHead` + `assertHeadMatches` — today wired **only** into `processWelcome`
  (`packages/mls/src/head.ts`, called from `group.ts:1272`) — can be wired onto the rejoin path, and
  `isLedgerComplete()` is a **purely local** check needing no peer and no network.
- **⚠️ Wrong-but-passing:** **verifying each token's signature and calling it done.** Every token in
  a doctored ledger is *genuinely signed* and *correctly scoped to the group* — **omission and
  reordering are exactly what signatures do not protect, and exactly what `ledger_head` does.** A
  bootstrap that verifies signatures passes every honest-responder test and folds a lying one's
  ledger without a murmur. Also wrong: **folding, then checking** — by then the roster has already
  moved, and there is no rollback.

The bound this buys, and the sentence to hold the implementation against:

> **a lying responder can withhold, never rewrite.**

## Why this is the second security question

Question 2.2 protected the *reply*. This protects **the ledger inside it**. A peer that rejoins by
external commit gets a GroupInfo carrying an MLS state and an **empty ledger** — and an empty ledger
is not a neutral starting point, it is a **roster reset**: the roster folds from the genesis anchor
plus applied entries, so with none, the creator is admin and nobody else is. Every admin promoted
since is invisible, and `foldEnvelope` **rejects the next commit any of them authors**. The rejoined
peer does not merely lack history — it actively rejects the live group's commits and re-strands
itself, with the host's projections folding empty alongside.

So it must take the ledger from a responder **that may be lying**, and the only thing standing
between it and a rewritten roster is the head check.

## Spec excerpt (verbatim — this is the contract)

> So bootstrap is its own primitive, not a clause inside `recover()`:
>
> 1. **Gather the whole ordered ledger** — not "the missing ids". `GroupMLS` gains a full-log
>    accessor beside the id-keyed one; the responder serves it from `handle.ledgerTokens`, "the
>    canonical persistent and wire form, the only thing that can be handed to another party".
> 2. **Verify it against the authenticated head before applying a single entry.** Recompute
>    with `computeHead(groupID, entryIDs)` over the gathered ids *in the order given* and
>    compare against the `ledger_head` the peer's own GroupContext already carries
>    (`readLedgerHead`). The head arrived inside the GroupInfo and is MLS-authenticated, so it
>    is a trustworthy check against an untrusted responder.
> 3. **A responder that fails the head check is not asked again** — fall through to the next
>    gather reply.
>
> Signature verification alone does **not** cover this. A lying member can hand back a list of
> genuinely-signed, correctly-scoped tokens with one demotion **omitted**: every token
> verifies, every groupID matches, the fold runs, and the rejoiner's roster now contains an
> admin the group demoted. Order and completeness are exactly what signatures do not protect
> and what `ledger_head` does. This bound — **a lying responder can withhold, never rewrite** —
> is the one D3 already claims for the id-keyed gather; bootstrap earns it the same way.

And the completeness invariant:

> A handle's ledger is complete **exactly when** `computeHead(groupID, ids(handle.ledger))`
> equals the `ledger_head` in its own GroupContext (`readLedgerHead`). That comparison needs no
> peer, no network, and no memory of how the peer got into its current state.

And the three methods:

```ts
/** True when computeHead(groupID, ids(handle.ledger)) matches the handle's own
 *  ledger_head. False means the ledger is incomplete and bootstrap must run. */
isLedgerComplete(): Promise<boolean>
/** The whole ordered ledger, as signed tokens — the bootstrap gather's reply. */
getLedger(): Promise<Array<string>>
/** Fold a gathered ledger after verifying its recomputed head against the authenticated
 *  one. Throws LedgerIncompleteError on mismatch; the peer then tries the next responder. */
bootstrapLedger(tokens: Array<string>): Promise<void>
```

## Scope

**In scope:** the three methods on `GroupHandle` (`packages/mls/src/group.ts`), reusing `head.ts`'s
`computeHead` / `assertHeadMatches` / `LedgerIncompleteError`. Tests in `packages/mls/test/`.

**Out of scope:** the `GroupMLS` port in `@kumiai/rpc`, the gather transport, responder selection
("not asked again" is the *caller's* loop — the primitive's job is to **throw**). Do not build them.

## Done when — two tests, and they pull in opposite directions

**1. The security test.** A responder returns a ledger that is **genuinely signed, correctly scoped,
and complete except for one omitted demotion**. Build it honestly: take a real group's real
`ledgerTokens` and *drop one entry* — do not hand-forge tokens, because the whole point is that
forgery is not required. Assert:

- `bootstrapLedger` throws `LedgerIncompleteError`;
- **the handle's ledger and roster are unchanged** — not "the throw happened", but *nothing was
  folded*. Check the roster explicitly. **The demoted admin must not appear in it.** A fold-then-check
  implementation throws in exactly the same place and fails this half.

Do the same for a **reordered** ledger (same entries, permuted) — signatures all still verify.

**2. The liveness test.** This is the half that catches a bootstrap which "safely" does nothing, and
it must be written even though it looks like a happy path:

- an admin is **promoted after genesis**, and then authors a commit;
- a peer with an **empty ledger rejects that commit** — assert this first, because it is what makes
  the empty ledger a *roster reset* rather than a blank slate;
- a peer that **bootstrapped from an honest responder accepts it**.

Without the second test, a `bootstrapLedger` that throws on everything passes the security test
perfectly.

**3. The invariant is local.** `isLedgerComplete()` is true for a healthy handle, false for a
rejoined one with an empty ledger against a non-genesis `ledger_head`, and consults **no peer**.
Make sure a genesis-only group reads `true` and not "vacuously true because both sides are empty in
different ways" — say in the report which it is.

## The approved approach

1. **Read `head.ts` first**, then `processWelcome`'s existing call (`group.ts:1272`) — it is the
   working example of this exact check, and `LedgerIncompleteError`'s doc comment already names this
   attack verbatim ("an inviter omitted, reordered, or truncated a ledger entry"). **Reuse it. Do not
   write a second head computation.** If the rejoin path needs something `processWelcome`'s call does
   not have, say what and why in the report.

2. **Verify before folding — structurally, not by ordering statements.** The strongest form: compute
   and compare the head over the *incoming tokens* while the handle's own ledger is still untouched,
   and only then commit the fold. If the natural code shape makes it possible for a future edit to
   slide a fold above the check, say so — this is the invariant the whole question is about.

3. **`getLedger()` serves `handle.ledgerTokens` in order.** Order is load-bearing: `computeHead` is a
   chain digest, so a permuted-but-complete ledger must fail.

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- Do not build the `GroupMLS` port or touch `@kumiai/rpc`.
- Everything currently green stays green. `processWelcome`'s existing behaviour is unchanged.

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("the recomputed head is verified before
a single entry is folded").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required). Include the output. (The `ledger.test.ts`
intermittent failure was a real test bug and is fixed — if you see a *new* flake, report it rather
than assuming it is that one.)

## Report contract

Write to `docs/superpowers/probes/question-2.3-report.md`:

- The three methods, `file:line`, and how `bootstrapLedger` guarantees **check-before-fold**
  structurally rather than by statement order.
- **The security test and its pasted output** — including the assertion that the roster was *not*
  mutated, and that the demoted admin is absent. Say how you built the doctored ledger, and confirm
  every token in it genuinely verifies (if they don't, the test proves nothing).
- **The liveness test and its pasted output**, including the empty-ledger peer *rejecting* the
  promoted admin's commit.
- **Mutation-check the security test**, as question 2.2 did: replace the head check with signature
  verification only, and confirm the security test **fails** (the doctored ledger folds). Paste that
  failure, then revert. A test that would pass against the wrong implementation is not a test.
- Whether `isLedgerComplete()` can be fooled — in particular by a genesis-only group, or by any
  state where both sides of the comparison are trivially equal.
- Anything a caller can hold wrong that the types do not prevent.
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
