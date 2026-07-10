# Probe report — Question 2.7: the ledger head hash chain

Status: **DONE**

## What I built

`packages/mls/src/head.ts` — a running hash chain over the control ledger's ordered entry ids,
stored in the `0xf101` (`LEDGER_HEAD_EXTENSION_TYPE`) GroupContext extension. Pure hashing helpers
plus the two `read*` handle helpers, mirroring the anchor discipline. Nothing wired into
`group.ts` / `processWelcome` (that is a later phase). Exported the new symbols from
`packages/mls/src/index.ts`. `packages/mls/test/head.test.ts` written first, then the module.

Exports:

- `LEDGER_HEAD_VERSION = 1`
- `type LedgerHead = { v: number; head: Uint8Array }`
- `class LedgerIncompleteError extends Error` — carries `.expected` / `.actual` (both `Uint8Array`, ES `#fields` + getters)
- `genesisHead(groupID)` — `SHA256(DOMAIN ‖ groupID)`
- `extendHead(head, entryIDs)` — fold a batch of framed ids into the chain, left to right
- `computeHead(groupID, entryIDs)` — `extendHead(genesisHead(groupID), entryIDs)`
- `encodeLedgerHead(head)` / `decodeLedgerHead(bytes)` — binary extension codec
- `buildLedgerHeadExtension(head)` — `makeCustomExtension` at type `0xf101`
- `readLedgerHead(handle)` / `readLedgerHeadExtension(handle)`
- `assertHeadMatches(expected, actual)`

## Domain separator

`DOMAIN = utf8("kumiai/mls/ledger-head/v1")` — a fixed, non-empty, namespaced-and-versioned byte
string. `genesisHead(groupID) = sha256(concat(DOMAIN, utf8(groupID)))`. It exists so a group's
genesis head can never equal a raw SHA-256 of the group id (or of unrelated data) computed without
this prefix.

## Id framing

Entry ids are strings (multibase digests from `ledgerEntryDigest`); their UTF-8 bytes are hashed.
Each id is **length-framed**: a **4-byte big-endian length prefix** (`DataView.setUint32(..., false)`)
before the id's UTF-8 bytes. This makes boundaries unambiguous, so `["ab","c"]` and `["a","bc"]`
cannot fold to the same head (proven by a test). A naive concat without framing would be a bug.

## Chain shape (the one design decision worth flagging)

The spec's shorthand `headₙ = SHA256(headₙ₋₁ ‖ id₁ ‖ … ‖ idₖ)` reads like a single hash over a
whole batch. But brief requirement #4 demands that folding batch-by-batch equal a single
`computeHead` over the concatenation — `extendHead(extendHead(genesis,[a,b]),[c]) === computeHead(g,[a,b,c])`.
A single per-batch hash does **not** compose that way (an outer `SHA256(h1 ‖ c)` cannot equal a flat
`SHA256(genesis ‖ a ‖ b ‖ c)`). The only construction satisfying both "a hash **chain** over ordered
ids" and #4 is a **per-id link**: `acc ← SHA256(acc ‖ frame(id))`, folded left to right. That is what
`extendHead` implements, so `extendHead` is associative over id lists and an existing member verifies
an update in `O(k)` by extending its own chain. This is the approved chain interpretation, not an
alternative approach — I did not need to stop.

## Binary encoding layout

`encodeLedgerHead(head)` → **33 bytes**: byte `0` is `LEDGER_HEAD_VERSION` (`0x01`), bytes `1..32`
are the 32-byte SHA-256 digest. No JSON — a single canonical byte form so the head can be
byte-compared in the commit policy. `decodeLedgerHead` returns `null` (never throws) unless the
buffer is exactly `1 + 32` bytes with a known version byte; any wrong length or unknown version → `null`.

`readLedgerHead` mirrors `readGroupAnchor`: `null` only when the extension is genuinely absent; a
present-but-undecodable extension **throws** (corruption is not absence — fail closed).
`readLedgerHeadExtension` returns the raw extension for verbatim byte copying, `null` when absent,
never throws.

## What test-first changed

The API read cleanly on the first pass; TDD surfaced no signature changes. The one thing writing the
test-for-#4 first made unavoidable was proving the composition property up front, which is what
locked in the per-id-link chain shape (above) before I wrote a line of the implementation — had I
coded from the spec shorthand's batch-hash reading, #4 would have failed.

## Surprises

None. `@noble/hashes/utils.js` exports `concatBytes` and `@noble/hashes/sha2.js` exports `sha256`
(both verified before use); `sha256(...)` returns a fresh 32-byte `Uint8Array` synchronously, so all
five hashing helpers are pure and allocation-clean.

## Pasted command output

```
$ pnpm --filter @kumiai/mls exec vitest run test/head.test.ts

 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  17:50:46
   Duration  352ms (transform 58ms, setup 0ms, import 216ms, tests 51ms, environment 0ms)
```

```
$ pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
EXIT tsc: 0
```

```
$ pnpm exec biome check ./packages ./tests
Lint: No issues found
EXIT biome: 0
```

```
$ pnpm --filter @kumiai/mls exec vitest run

 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  16 passed (16)
      Tests  161 passed (161)
   Start at  17:51:26
   Duration  1.46s (transform 556ms, setup 0ms, import 3.87s, tests 3.62s, environment 1ms)
```

All four pass; the full-suite run (161 tests) proves no regression.
