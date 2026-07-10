# Report — `foldLedger`, full-replay, caller-ordered

Status: **DONE**. All four verify commands pass.

## What I built

- `packages/mls/src/fold.ts` — `foldLedger` plus `LedgerReducer`, `FoldInput`, `FoldDrop`.
  A port of kubun's `groups/ledger-fold.ts` with the two decided departures baked in:
  - **No internal sort.** Deleted `compareFoldInputs` and the `[...entries].sort(...)` copy
    entirely. The fold iterates `entries` in the exact order the caller supplies. Order lives with
    the caller (kumiai derives it from the authenticated epoch chain; kubun from its HLC).
  - **Full replay only.** The module exports a single fold entry point that takes the whole entry
    set. No incremental apply, no per-type watermark, no `dependsOn`. The doc comment states why
    (a reducer whose authority reads another entry type cannot be driven safely by a per-type
    incremental applier), so the missing surface reads as a refusal, not an omission.
  - Everything else is kubun's, unchanged in meaning: seed from the anchor, evaluate authority
    against state accumulated from strictly-earlier entries, drop (never throw) on an unrelated type
    or a failed authority check, `onDrop` optional and otherwise silent, input array never mutated,
    pure (no clock/randomness/I/O). `FoldInput`'s doc no longer calls `entryID` a tie-breaker
    (there is no sort to break ties), only an identifier for drop notices.
  - The group-scoping expectation is stated in the `foldLedger` doc: the fold does not filter by
    `groupID`; the caller passes only the group's entries, and a mismatch is dropped by the caller
    or by a reducer's own `type` / `verifyAuthority`. No group logic here.
- `packages/mls/test/fold.test.ts` — 8 tests over a small inline admin-set reducer (no dependency
  on the not-yet-existent `roster.ts`).
- `packages/mls/src/index.ts` — exports `foldLedger`, `LedgerReducer`, `FoldInput`, `FoldDrop`.

Nothing else in `src/` was touched.

## How I tested the replay-only surface, and why

**Runtime**, not type-level. The test imports the module namespace and asserts
`Object.keys(foldModule).sort()` equals `['foldLedger']`, plus explicit `not.toHaveProperty` for
`applyEntry`, `foldIncremental`, `watermark`. This is precise rather than awkward here: the type
exports (`LedgerReducer`/`FoldInput`/`FoldDrop`) erase at runtime, so the runtime value surface of
the module *is* exactly the set of exported functions. Asserting that set equals `{foldLedger}` is a
direct, non-brittle statement of "one fold entry point, no incremental applier" — a type-level test
could only assert individual names are absent, never that the surface is closed. So I chose the
runtime assertion.

## What test-first changed

Writing the test first surfaced a genuine inconsistency in the brief's rotation example (step 2 of
"Done when"). The brief says: "Alice grants Bob; Bob then revokes Alice; assert Bob's earlier-position
grant of Carol still applied — evaluating against final state would have dropped it."

That exact sequence does **not** exercise the property. Final admins there are `{Bob, Carol}`; Bob is
still an admin, so Bob's grant of Carol would pass under *either* state-so-far or final-state
evaluation — nothing distinguishes the two, so the test would prove nothing. For the property to be
observable, the **issuer of the surviving grant must be the party who is later revoked**.

I kept the brief's named actors and the "Bob's grant of Carol survives" framing, and adjusted only
the direction of the final revoke so the property is real:

1. Alice (creator) grants Bob → `{Alice, Bob}`
2. Bob grants Carol → `{Alice, Bob, Carol}`  (Bob's earlier-position grant)
3. Alice revokes Bob → `{Alice, Carol}`

Now Bob's grant of Carol was authorized when made but Bob is *not* in the final admin set, so
final-state evaluation would retroactively drop Carol. The test asserts `admins.has(Carol) === true`
and `admins.has(Bob) === false`, which fails under final-state semantics and passes under
state-so-far. This is the faithful realization of the property the brief asked to be a test rather
than a comment; only the revoke's direction moved (Alice-revokes-Bob instead of Bob-revokes-Alice),
because the revoked party has to be the granting issuer for the assertion to bite.

The API itself read cleanly test-first (define reducer, fold a list, read projection), so no
signature changes were needed.

## Tests

1. Caller defines a reducer, folds a list, reads the projection (the required test-first shape).
2. Folds in caller order: `[grant Bob, revoke Bob]` → `{Alice}` vs the reversed array →
   `{Alice, Bob}`; asserts the two differ, proving no internal sort collapses them.
3. Same entries, same order, built two ways (spread vs push loop) → equal state.
4. Authority against state-so-far (rotation), as above.
5. Unrelated `type` dropped, `onDrop` names the reason, state unchanged.
6. Unauthorized issuer dropped with an `onDrop` notice; the fold runs on and a now-authorized issuer
   (Bob, after Alice grants him) still applies — one bad entry never aborts.
7. Frozen input array (`Object.freeze`): no throw, array unchanged afterward.
8. Replay-only surface (runtime namespace assertion, above).

## Pasted command output

```
$ pnpm --filter @kumiai/mls exec vitest run test/fold.test.ts

 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  17:25:51
   Duration  131ms (transform 18ms, setup 0ms, import 24ms, tests 4ms, environment 0ms)
```

```
$ pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
EXIT:0   (no output)
```

```
$ pnpm exec biome check ./packages ./tests
Lint: No issues found
EXIT:0
```

```
$ pnpm --filter @kumiai/mls exec vitest run

 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  14 passed (14)
      Tests  140 passed (140)
   Start at  17:26:01
   Duration  1.16s (transform 642ms, setup 0ms, import 2.87s, tests 2.48s, environment 1ms)
```

The final full-suite run (140 tests, 14 files) proves no regression from the new module and export.

## Surprises

- The brief's rotation example is internally inconsistent (documented above). This is the one place I
  deviated from the literal text to honour the stated intent ("this must be a test, not a comment").
  Flagging it because the same wording likely recurs in the roster step, where the roster reducer
  will need the revoked issuer to be the granter for the rotation test to be meaningful.
- Biome's formatter and lint run on Write/Edit via a hook; the initial file tripped
  `noUnusedImports`/`noUnusedVariables` (a leftover `VerifiedLedgerEntry` import and `MALLORY`
  constant) and one line-wrap. Resolved with `biome check --write`. No behavioural impact.
