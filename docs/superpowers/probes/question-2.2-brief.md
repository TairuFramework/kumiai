# Probe brief — Question 2.2: `LedgerEntry` with `groupID`, and the cross-group replay drop

Create `packages/mls/src/ledger.ts` and `packages/mls/test/ledger.test.ts`. Export the new symbols
from `packages/mls/src/index.ts`. Touch nothing else in `src/`.

Read `AGENTS.md` and the `kigu:conventions` skill first. `type` not `interface`; `Array<T>` not
`T[]`; never `any`; capital `ID`/`DID`; ES `#fields`, never `private`/`readonly`. **Code, comments,
and test names must never reference plan questions, decision numbers, or phase labels.** State the
constraint directly.

**Write the test first.** Show how a caller signs an entry, verifies it, and computes its id,
before implementing. If it reads awkwardly, fix the API and say so.

## Where this comes from

`kubun/packages/plugin-p2p/src/groups/ledger-entry.ts` — read it. This is a faithful port with
**one addition**: `groupID` on the entry, signed with the rest of the claim, checked on verify.
Everything else — the signing, the `alg: 'none'` rejection, the `null`-never-throw contract, the
multibase-SHA256 digest — moves across unchanged.

## What to build

```ts
export type LedgerEntry<TValue = unknown> = {
  type: string
  groupID: string
  subject: string
  value: TValue
  /** Consumer-supplied total-order key, signed with the rest of the claim.
   *  `@kumiai/mls` never reads it — kumiai orders by the epoch chain. Kubun
   *  sets it to its HLC. Optional. */
  ord?: string
}

export type VerifiedLedgerEntry<TValue = unknown> = {
  /** Authenticated author DID (the verified token issuer), normalized. */
  issuer: string
  entry: LedgerEntry<TValue>
}

export function signLedgerEntry(identity: OwnIdentity, entry: LedgerEntry): Promise<string>
export function verifyLedgerEntry<TValue = unknown>(token: string): Promise<VerifiedLedgerEntry<TValue> | null>
export function ledgerEntryDigest(signedToken: string): string
```

The `@kokuin/token` API you need (verified against its `.d.ts`):

- `identity.signToken(payload, { embedLongForm: true })` → a `SignedToken`. `OwnIdentity` /
  `SigningIdentity` carry the method. `embedLongForm: true` makes each entry self-verifying offline
  — the ledger is folded long after first contact, when the author's DID document may not be
  cached. Keep kubun's reasoning.
- `stringifyToken(signed)` → string (from `@kokuin/token`).
- `verifyToken<Payload>(token, options?)` → `Token<Payload>`; wrap in `try/catch` and return `null`
  on throw. `isVerifiedToken<SignedPayload & LedgerEntry<TValue>>(verified)` narrows it.
- `normalizeDID(iss)` for the issuer.
- `multihashSHA256` + `encodeMultibase` for the digest, over the token's UTF-8 bytes.

### `signLedgerEntry` signs the whole claim including `groupID` and `ord`

The signed payload carries `type`, `groupID`, `subject`, `value`, and — only when present — `ord`.
Do not sign an `ord: undefined` key. The signer's DID fills `iss`; the issuer is never a payload
field, it comes from the verified token.

### `verifyLedgerEntry` returns `null`, never throws

Return `null` on: unparseable token; a token that `isVerifiedToken` rejects (this is what rejects
`alg: 'none'` — an attacker could otherwise forge an arbitrary `iss`); or a structurally malformed
claim. Structurally malformed now includes **a missing or non-string `groupID`**, alongside kubun's
existing `type` / `subject` string checks. `ord`, when present, must be a string; when absent, fine.

On success return `{ issuer: normalizeDID(iss), entry: { type, groupID, subject, value, ...(ord) } }`.

### `ledgerEntryDigest` is unchanged

Multibase-encoded SHA-256 multihash over the stringified token's bytes. Same bytes in, same id out
— content-addressed.

## Done when

`ledger.test.ts` covers, at minimum:

1. **Round trip.** Sign an entry with a real identity, verify it, and get back `issuer` equal to
   the normalized signer DID and an `entry` deep-equal to what was signed (including `groupID` and,
   in a second case, `ord`).
2. **The replay drop — the reason this field exists.** Sign one entry in group A
   (`{type:'group.role', groupID:'A', subject:'did:mallory', value:'admin'}`). Verify it — it
   parses fine, that is not the defence. Then a **fold-level** assertion: a helper that keeps only
   entries whose `groupID` matches the group being folded drops this entry when folding group `B`
   and keeps it when folding group `A`. (You are not building `foldLedger` here — a three-line
   local filter in the test is enough to demonstrate the property the field enables.) Assert the
   **same `ledgerEntryDigest`** for the entry in both folds, proving content-addressing was no
   defence: identical bytes, identical id.
3. **`null`, never throws**, on each of: a non-token string; a token with `alg: 'none'` (forge one
   however `@kokuin/token` lets you construct an unsigned token — `createUnsignedToken` +
   `stringifyToken`); a signed token whose payload omits `groupID`; one whose `groupID` is not a
   string; one whose `type` is missing. Each returns `null` and does not throw.
4. **Tamper.** Verify that a signed entry whose stringified token has one byte flipped returns
   `null` (signature check fails inside `verifyToken`).
5. **Digest determinism.** `ledgerEntryDigest` of the same token string twice is equal; of two
   different tokens, different.

## Rules

- **Stop at the first failure of the approved approach.** Report `BLOCKED`. Do not try alternatives
  without asking.
- If constructing an `alg: 'none'` forgery is not possible through the `@kokuin/token` public API,
  say so — that is itself a finding about the attack surface, and `DONE_WITH_CONCERNS` is the right
  status, not a silent skip.
- Paste **actual command output**.

## Verify

From the repo root (`/Users/paul/dev/yulsi/kumiai`). The `rtk` shim intercepts `pnpm run`; use
`pnpm exec`:

```
pnpm --filter @kumiai/mls exec vitest run test/ledger.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
pnpm exec biome check ./packages ./tests
pnpm --filter @kumiai/mls exec vitest run
```

All four must pass; the last proves no regression.

## Report contract

Full report to `docs/superpowers/probes/question-2.2-report.md`: what you built, whether an
`alg: 'none'` forgery was constructible and how, anything the test-first pass changed, pasted output
of all four commands, any surprise.

Return to the caller **only**: status, one-line summary, whether the forgery was constructible, and
concerns.
