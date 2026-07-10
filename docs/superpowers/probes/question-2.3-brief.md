# Probe brief — Question 2.3: `foldLedger`, full-replay, caller-ordered

Create `packages/mls/src/fold.ts` and `packages/mls/test/fold.test.ts`. Export the new symbols from
`packages/mls/src/index.ts`. Touch nothing else in `src/`.

Read `AGENTS.md` and `kigu:conventions` first. `type` not `interface`; `Array<T>` not `T[]`; never
`any`; capital `ID`/`DID`; ES `#fields`. **No plan/question/phase labels in code, comments, or test
names.** State constraints directly.

**Write the test first.** Show a caller defining a tiny reducer, folding a shuffled entry list, and
reading the projection — before implementing. If it reads awkwardly, fix the API and say so.

## Where this comes from

`kubun/packages/plugin-p2p/src/groups/ledger-fold.ts` — read it. This is a port with **two
deliberate departures from kubun**, both already decided; do not re-litigate them, implement them:

1. **`foldLedger` does not sort.** Kubun sorts a copy by `(hlc, entryID)` internally. kumiai folds
   the entries in the exact order the caller supplies. The two consumers derive order from
   different places — kumiai from the authenticated epoch chain, kubun from its HLC — so the sort
   moves out of the fold and into the caller. Delete `compareFoldInputs` and the internal sort
   entirely.
2. **Full replay only.** No incremental apply, no per-type watermark, no `dependsOn`. `foldLedger`
   takes the whole entry set and replays it. There is no partial-input entry point, by design —
   a reducer whose authority reads another entry type cannot be driven safely by a per-type
   incremental applier (kubun shipped that bug). This is a refusal to export a footgun, not an
   oversight. A test asserts the module surface is replay-only (see below).

Everything else is kubun's, unchanged in meaning: seed from the anchor, evaluate authority against
**state accumulated from strictly-earlier entries** (never final state — that is what makes
rotation sound), drop (never throw) on an unrelated type or a failed authority check, and never
mutate the input array. Purity: no clock, no randomness, no I/O.

## What to build

```ts
import type { GroupAnchor } from './anchor.js'
import type { VerifiedLedgerEntry } from './ledger.js'

export type LedgerReducer<TValue, TState> = {
  /** Ledger entry `type` this reducer projects; entries of any other type are dropped. */
  type: string
  /** Initial fold state, derived from the genesis anchor. */
  seed(anchor: GroupAnchor): TState
  /** Is the verified issuer allowed to make this claim, given the state so far? */
  verifyAuthority(verified: VerifiedLedgerEntry<TValue>, stateSoFar: TState): boolean
  /** Fold step: the next state after applying an authorized claim. */
  apply(verified: VerifiedLedgerEntry<TValue>, stateSoFar: TState): TState
}

export type FoldInput<TValue = unknown> = {
  verified: VerifiedLedgerEntry<TValue>
  entryID: string
}

export type FoldDrop = { entryID: string; type: string; reason: string }

export function foldLedger<TValue, TState>(
  entries: Array<FoldInput<TValue>>,
  anchor: GroupAnchor,
  reducer: LedgerReducer<TValue, TState>,
  onDrop?: (drop: FoldDrop) => void,
): TState
```

`foldLedger` seeds from the anchor, then folds `entries` **in the given order**: for each, drop if
`entry.type !== reducer.type` (reason: unrelated type), drop if `!verifyAuthority(verified, state)`
(reason: issuer not authorized), else `state = apply(verified, state)`. Drops call `onDrop` when
supplied and are otherwise silent — the fold runs on every authority check where authority-failed
drops are expected, so the caller decides whether to surface them. `[...entries]` is never sorted;
do not even copy-to-sort. (You may still avoid mutating the input, but there is nothing to sort.)

State the group-scoping expectation in the docs: `foldLedger` itself does not filter by `groupID`
— the caller passes only entries for the group being folded, and a `groupID` mismatch is dropped by
the caller before the fold, or by a reducer's `verifyAuthority`/`type` check. (The roster reducer in
the next step will enforce `groupID`; do not add group logic here.)

## Done when

`fold.test.ts` covers, at minimum, using a small self-contained reducer defined in the test (do
NOT depend on `roster.ts`, which does not exist yet — define e.g. a trivial admin-set reducer
inline):

1. **Determinism under shuffled *input array*, given a fixed caller order.** The caller's order is
   the array order now, so this means: two `FoldInput` arrays that are the same entries in the same
   caller-intended order but built by different code paths fold to equal state. More usefully:
   fold `[a, b, c]` and assert the result; the point of "no internal sort" is that
   `[c, b, a]` folds to a **different** state if order matters to the reducer — assert that too, to
   prove the fold honours caller order rather than imposing its own.
2. **Authority against state-so-far (rotation).** Anchor seeds `{admins: {creator}}`. Alice
   (creator) grants Bob admin; Bob then revokes Alice; assert Bob's earlier-position grant of, say,
   Carol still applied — evaluating against final state would have dropped it. This is the property
   that makes rotation sound; it must be a test, not a comment.
3. **Unrelated type dropped**, with an `onDrop` notice naming the reason, and the state unchanged.
4. **Unauthorized issuer dropped**, with an `onDrop` notice, state unchanged; a later entry from a
   now-authorized issuer still applies (one bad entry never aborts the fold).
5. **Input array not mutated** — fold a frozen array (`Object.freeze`) and assert no throw, and
   that the original array is unchanged afterward.
6. **Replay-only surface.** Assert the module exports no incremental-apply / watermark function —
   concretely, that `foldLedger` is the only fold entry point. Write this as a test that imports the
   module namespace and asserts the shape of what is exported (no `applyEntry`, `foldIncremental`,
   `watermark`, etc.). If you think a runtime assertion of "no such export" is awkward, a
   type-level test plus a comment is acceptable — say which you chose and why.

## Rules

- **Stop at the first failure of the approved approach.** Report `BLOCKED`. No alternatives without
  asking.
- Paste **actual command output**.

## Verify

From repo root (`/Users/paul/dev/yulsi/kumiai`); `rtk` intercepts `pnpm run`, use `pnpm exec`:

```
pnpm --filter @kumiai/mls exec vitest run test/fold.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
pnpm exec biome check ./packages ./tests
pnpm --filter @kumiai/mls exec vitest run
```

All four pass; the last proves no regression.

## Report contract

Full report to `docs/superpowers/probes/question-2.3-report.md`: what you built, how you tested the
replay-only surface (runtime vs type-level) and why, anything test-first changed, pasted output of
all four commands, any surprise.

Return to the caller **only**: status, one-line summary, and concerns.
