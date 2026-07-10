# Probe brief — Question 2.7: the ledger head hash chain

Create `packages/mls/src/head.ts` and `packages/mls/test/head.test.ts`. Export the new symbols from
`packages/mls/src/index.ts`. Touch nothing else in `src/`.

Read `AGENTS.md` and `kigu:conventions` first. `type` not `interface`; `Array<T>` not `T[]`; never
`any`; capital `ID`/`DID`; ES `#fields`. **No plan/question/phase labels in code, comments, or test
names.** State constraints directly.

**Write the test first.** Show a caller computing a genesis head, extending it by a batch of entry
ids, and reading a head back off a group — before implementing. If it reads awkwardly, fix the API.

## What this is

A running hash over the control ledger's ordered entry ids, stored in a GroupContext extension
(`0xf101`, `LEDGER_HEAD_EXTENSION_TYPE`, already defined in `anchor.ts`). Its purpose: a joiner
recomputes the chain across `Invite.ledgerEntries` and compares it to the head authenticated in the
group's GroupContext, so an inviter that omits an entry is caught. Existing members verify a head
update by extending their own chain by the arriving ids — O(k), no refold.

Spec, verbatim:

> ```
> head₀ = SHA256(domainSeparator ‖ groupID)                 // written by createGroup
> headₙ = SHA256(headₙ₋₁ ‖ id₁ ‖ … ‖ idₖ)                    // ids in envelope order
> ```
> A hash **chain** over ordered ids, not a digest over a set. An existing member verifies a head
> update by extending its own chain by the arriving ids — `O(k)`, no refold. A joiner recomputes
> from the genesis constant across `Invite.ledgerEntries` in order and compares against the head it
> reads from the GroupContext after `mlsJoinGroup`. Omission, reordering, and truncation all break
> the recomputation.

## What to build

```ts
export const LEDGER_HEAD_VERSION = 1

/** The parsed ledger-head extension: a version and the running chain digest. */
export type LedgerHead = { v: number; head: Uint8Array }

/** Thrown when a joiner's recomputed head does not match the authenticated one. */
export class LedgerIncompleteError extends Error { /* carries expected/actual, see below */ }

/** Genesis head for a group: SHA256(domainSeparator ‖ groupID). Pure. */
export function genesisHead(groupID: string): Uint8Array

/** Extend a head by a batch of entry ids, in order: SHA256(head ‖ id₁ ‖ … ‖ idₖ). Pure. */
export function extendHead(head: Uint8Array, entryIDs: Array<string>): Uint8Array

/** Recompute a head from genesis across an ordered id list. Pure. */
export function computeHead(groupID: string, entryIDs: Array<string>): Uint8Array

/** Encode / decode the LedgerHead GroupContext extension. */
export function encodeLedgerHead(head: Uint8Array): Uint8Array   // → extension bytes
export function decodeLedgerHead(bytes: Uint8Array): LedgerHead | null  // tolerant, null on malformed
export function buildLedgerHeadExtension(head: Uint8Array): GroupContextExtension

/** Read the ledger head from a handle's GroupContext. null when absent; throws on corruption. */
export function readLedgerHead(handle: GroupHandle): LedgerHead | null
export function readLedgerHeadExtension(handle: GroupHandle): GroupContextExtension | null
```

### Hashing

`sha256` from `@noble/hashes/sha2.js` and `concatBytes` from `@noble/hashes/utils.js` — kumiai
already uses the former in `crypto.ts`. Entry ids are strings (multibase digests from
`ledgerEntryDigest`); hash their UTF-8 bytes. `genesisHead(groupID) = sha256(concat(DOMAIN, utf8(groupID)))`
where `DOMAIN` is a fixed, non-empty domain-separator byte string — pick one, define it as a module
constant, and say in the report what it is. It exists so a head can never collide with a raw
SHA-256 of unrelated data.

`extendHead(head, ids) = sha256(concat(head, utf8(id₁), …, utf8(idₖ)))`. **Order-sensitive and
length-sensitive**: swapping two ids, or dropping one, must change the result. To be unambiguous
about boundaries, length-prefix each id (e.g. a 4-byte big-endian length before each id's bytes),
so that `["ab","c"]` and `["a","bc"]` cannot collide. Decide and document the framing; a naive
concat without length framing is a bug, and a test must prove `["ab","c"] ≠ ["a","bc"]`.

`extendHead(head, [])` returns `head` unchanged — an empty batch is a no-op, so a commit that
carries no entries does not move the head.

### Encoding — binary, not JSON

Unlike the anchor, the head is a fixed-size digest that gets **byte-compared** in the commit
policy. Do not JSON-encode it — JSON's non-canonical round-trip is exactly the hazard the anchor
section warns about. Use a compact binary form: one version byte (`LEDGER_HEAD_VERSION`) followed by
the 32 digest bytes. `decodeLedgerHead` returns `null` on any wrong length or unknown version byte.
This gives a single canonical byte form, so re-encoding a decoded head is safe — but still prefer
`readLedgerHeadExtension` (verbatim bytes) for anything that will be byte-compared, mirroring the
anchor discipline.

### `readLedgerHead` mirrors `readGroupAnchor`

`null` only when the extension is genuinely absent; a present-but-undecodable extension **throws**
(corruption is not absence, and a control gate must fail closed). `readLedgerHeadExtension` returns
the raw extension for verbatim copying, `null` when absent, never throws.

### `LedgerIncompleteError`

Carries the expected (authenticated) and actual (recomputed) heads so a caller can log the
mismatch. It is *thrown by the joiner's verification path* — but that path lives in `processWelcome`
(Phase 4), not here. In this step, only define and export the error and a pure helper that a caller
uses:

```ts
/** Assert a recomputed head matches the authenticated one, or throw LedgerIncompleteError. */
export function assertHeadMatches(expected: Uint8Array, actual: Uint8Array): void
```

## Done when

`head.test.ts` covers, at minimum:

1. **Genesis is pure and group-scoped.** `genesisHead('g')` is deterministic across calls, and
   `genesisHead('g') ≠ genesisHead('h')`.
2. **Extend is order-sensitive.** `extendHead(h, ['a','b']) ≠ extendHead(h, ['b','a'])`.
3. **Extend is length-framed.** `computeHead('g', ['ab','c']) ≠ computeHead('g', ['a','bc'])`.
4. **A joiner reproduces the chain.** `computeHead('g', ids)` equals the head reached by folding the
   same ids batch-by-batch through `extendHead` starting from `genesisHead('g')` — including a
   multi-batch case (extend by `[a,b]` then `[c]` equals compute over `[a,b,c]`).
5. **Omission breaks it.** Dropping any single id — first, middle, last — from the recomputation
   yields a head unequal to the full one.
6. **Empty batch is a no-op.** `extendHead(h, [])` deep-equals `h`.
7. **Encode/decode round trip**, binary form; `decodeLedgerHead` returns `null` on a wrong-length
   buffer and on an unknown version byte, never throws.
8. **`readLedgerHead` on a real group.** Build a group whose GroupContext carries a head extension
   (via `createGroup`'s `extensions` option + `buildLedgerHeadExtension`), read it back, assert
   equality; a group without the extension returns `null`; a corrupt head extension throws.
9. **`assertHeadMatches`** returns for equal heads and throws `LedgerIncompleteError` (with both
   heads on it) for unequal.

## Rules

- **Stop at the first failure of the approved approach.** Report `BLOCKED`. No alternatives without
  asking.
- Do not wire anything into `group.ts` / `processWelcome` — that is Phase 4. This step is pure
  functions plus the two `read*` handle helpers.
- Paste **actual command output**.

## Verify

From repo root (`/Users/paul/dev/yulsi/kumiai`); `rtk` intercepts `pnpm run`, use `pnpm exec`:

```
pnpm --filter @kumiai/mls exec vitest run test/head.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
pnpm exec biome check ./packages ./tests
pnpm --filter @kumiai/mls exec vitest run
```

All four pass; the last proves no regression.

## Report contract

Full report to `docs/superpowers/probes/question-2.7-report.md`: what you built, the domain
separator and id-framing you chose, the binary encoding layout, anything test-first changed, pasted
output of all four commands, any surprise.

Return to the caller **only**: status, one-line summary, the domain separator + framing decision,
and concerns.
