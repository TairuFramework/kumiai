# Probe report — Question 2.2: `LedgerEntry` with `groupID`, and the cross-group replay drop

**Status:** DONE

**One-line:** Ported `ledger-entry.ts` into `@kumiai/mls` with a signed `groupID` field (plus a
signed-optional `ord`), test-first; all four verification commands pass, no regression.

**Forgery constructible:** Yes — an `alg: 'none'` token is constructible through the public API, and
`verifyLedgerEntry` returns `null` on it. See the finding below for the two distinct rejection paths.

## What was built

- **`packages/mls/src/ledger.ts`** — faithful port of
  `kubun/packages/plugin-p2p/src/groups/ledger-entry.ts`, with these deltas:
  - `LedgerEntry` gains `groupID: string`, signed with the rest of the claim.
  - Kubun's mandatory `hlc: string` is replaced by an **optional** `ord?: string` — the
    consumer-supplied total-order key. `@kumiai/mls` never reads it (kumiai orders by the epoch
    chain); it is signed only when present, so a claim without it never signs an `ord: undefined`
    key. Verify accepts an absent `ord` and rejects a present-but-non-string one.
  - `signLedgerEntry` signs `type`, `groupID`, `subject`, `value`, and — only when present — `ord`.
  - `verifyLedgerEntry` adds a missing/non-string `groupID` to kubun's structural checks and the
    `ord`-when-present-is-string check, alongside the existing `type`/`subject` checks.
  - Unchanged: `embedLongForm: true` (self-verifying offline), the `alg: 'none'` /
    `isVerifiedToken` rejection, the `null`-never-throw contract, and the multibase-SHA256
    `ledgerEntryDigest`.
- **`packages/mls/test/ledger.test.ts`** — written first (12 tests, see below).
- **`packages/mls/src/index.ts`** — exports `LedgerEntry`, `VerifiedLedgerEntry`,
  `signLedgerEntry`, `verifyLedgerEntry`, `ledgerEntryDigest`. Nothing else in `src/` touched.

## Test coverage (`ledger.test.ts`)

1. **Round trip** — no `ord`, and a second case with `ord`; both recover `issuer ===
   normalizeDID(signer.id)` and an `entry` deep-equal to what was signed. The no-`ord` case also
   asserts the recovered entry has no `ord` property.
2. **The replay drop** — Mallory signs `{type:'group.role', groupID:'A', subject:'did:mallory',
   value:'admin'}`. It verifies fine in both group folds (verification is not the defence). Identical
   bytes → identical `ledgerEntryDigest` (content-addressing is no defence). A three-line
   `keepForGroup` filter drops the entry when folding `B` and keeps it when folding `A` — the
   property the signed `groupID` enables.
3. **`null`, never throws** — non-token string; `alg: 'none'` forgery; signed token omitting
   `groupID`; signed token with non-string `groupID`; signed token missing `type`; signed token with
   non-string `ord`.
4. **Tamper** — one flipped byte in the token's signature segment → `null`.
5. **Digest determinism** — same token twice equal; two different tokens differ.

## `alg: 'none'` forgery — constructible, and a finding about *where* it is rejected

The forgery is constructible through the public API exactly as the brief suggested:
`stringifyToken(createUnsignedToken({ iss: 'did:example:mallory', ... }))`. `verifyLedgerEntry`
returns `null` on it. But there is a subtlety worth recording, because the brief attributes the
defence to the `isVerifiedToken` guard:

- **`createUnsignedToken` + `stringifyToken` alone yields a *two-segment* string.** `stringifyToken`
  only appends a third (signature) segment when `token.signature != null`, and an unsigned token has
  none. `verifyToken` splits on `.`, sees 2 parts, and throws `"Invalid token format: expected 3
  parts separated by dots"` — caught by the `try/catch`, returns `null`. This forgery is rejected at
  the **JWT format check, before the header's `alg` is ever read.** The `isVerifiedToken` guard is
  not what stops it.

  Probe output:
  ```
  parts: 2
  verifyToken threw: Invalid token format: expected 3 parts separated by dots
  ```

- **A well-formed *three-segment* `alg: 'none'` token does reach the header.** Appending any trailing
  signature segment (`${forged}.QQ`) gives a 3-part token; `verifyToken` reads `header.alg === 'none'`
  and returns the token *without checking a signature and without a `verifiedPublicKey`*.
  `isVerifiedToken` then returns `false` (the token was never added to the verified set), so
  `verifyLedgerEntry` returns `null` via that guard. This is the path the brief describes — the one
  that would otherwise let an attacker forge an arbitrary `iss`.

  Probe output:
  ```
  3-part: resolved; header.alg= none isVerifiedToken= false hasSig= false
  ```

Both paths return `null`, so the port is safe. The test asserts **both**: the two-segment recipe from
the brief, and the well-formed three-segment `alg: 'none'` token that genuinely exercises the
`isVerifiedToken` defence. Recording this because "the recipe returns null" and "the isVerifiedToken
guard is what stops alg:none" are both true but for *different* inputs.

## What the test-first pass changed

Nothing about the API shape — it read cleanly on first write. Two things the test surfaced and folded
back in:

- The alg:none realization above: the test initially only had the two-segment recipe (which passes
  but doesn't touch the `isVerifiedToken` guard). Verifying the recipe empirically showed it is
  rejected at format-parse, so I added the three-segment assertion to actually exercise the guard the
  field's security rests on.
- A biome import-ordering fix on the test's import block (type vs value member sort).

## Pasted command output

```
########## CMD1 — pnpm --filter @kumiai/mls exec vitest run test/ledger.test.ts ##########
 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  17:10:30
   Duration  212ms (transform 19ms, setup 0ms, import 81ms, tests 53ms, environment 0ms)

########## CMD2 — pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json ##########
tsc exit: 0

########## CMD3 — pnpm exec biome check ./packages ./tests ##########
Checked 151 files in 36ms. No fixes applied.

########## CMD4 — pnpm --filter @kumiai/mls exec vitest run ##########
 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  13 passed (13)
      Tests  132 passed (132)
   Start at  17:10:32
   Duration  1.12s (transform 544ms, setup 0ms, import 2.57s, tests 2.45s, environment 1ms)
```

All four pass; CMD4 (full `@kumiai/mls` suite, 132 tests) proves no regression.

## Surprises

- The `createUnsignedToken` + `stringifyToken` recipe is rejected one layer earlier (format) than the
  `isVerifiedToken` guard the defence is usually attributed to. Documented above; the test covers
  both layers so a future refactor of either can't silently open the alg:none hole.
