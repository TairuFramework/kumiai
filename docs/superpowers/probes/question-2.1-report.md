# Probe report — Question 2.1: a generic `GroupAnchor` with an opaque `app` slot

**Status:** DONE

## What I built

New module `packages/mls/src/anchor.ts`, its test `packages/mls/test/anchor.test.ts`, and the
matching re-exports from `packages/mls/src/index.ts`. Nothing else in `src/` was touched.

Exported symbols:

- `GROUP_ANCHOR_EXTENSION_TYPE = 0xf100`, `LEDGER_HEAD_EXTENSION_TYPE = 0xf101` — both live here from
  the outset. `controlCapabilities()` advertises both even though the head's logic arrives later, so
  an anchored group can grow a head without re-admitting every member.
- `type GroupAnchor = { creatorDID: string; version: number; app?: unknown }`
- `encodeGroupAnchor` / `decodeGroupAnchor`
- `buildGroupAnchorExtension(anchor)` and `buildCurrentGroupAnchorExtension(creatorDID, app?)`
- `controlCapabilities()` — replaces kubun's `groupAnchorCapabilities()`, advertising both control
  extension types, idempotently.
- `readGroupAnchor(handle)` — tolerant-absence / intolerant-corruption read.
- `readGroupAnchorExtension(handle)` — the verbatim-bytes helper (see below).

`recoverySecret` did not cross over: it is a kubun concern. `app` is the opaque slot kubun stores its
recovery seed in, and `@kumiai/mls` never reads it.

## The `app` encoding decision — JSON value, no encoding chosen

The brief framed `app` as `Uint8Array` and called its encoding "the one real design decision." The
caller's mid-flight correction changed `app` to an opaque **JSON value** (`app?: unknown`), which
deletes that decision entirely — there is no encoding to choose.

Reasoning (now carried in the type's doc comment): the anchor's container is already JSON
(`TextEncoder().encode(JSON.stringify(anchor))`, unchanged from kubun). A `Uint8Array` field would
have to be base64'd to survive `JSON.stringify` — a ~33% size tax plus a decode step on every
consumer, bought for nothing. Kubun's real payload (`recoverySecret`, "base64 of 32 random bytes")
is already a string; a bytes-typed `app` would have meant base64-ing a base64 string. A consumer
that genuinely holds raw bytes encodes them to a JSON-safe form itself, at its own layer.

So `encodeGroupAnchor` stays `TextEncoder().encode(JSON.stringify(anchor))` and `app` rides through
JSON untouched. The byte-round-trip test the original brief asked for (`0x00`/`0xff`) was dropped and
replaced with a structured-value round trip — a nested object, an array, and a string with non-ASCII
characters (`café ☕ — naïve`) — asserted with deep equality after a real `createGroup` →
`readGroupAnchor`.

`app` is optional: `JSON.stringify` omits an `undefined` `app`, and `decodeGroupAnchor` treats an
absent `app` as `undefined`, present. An anchor without `app` is valid, not malformed — the
`recoverySecret`-required check moves to kubun's own decode of its `app`.

## The verbatim-bytes helper — `readGroupAnchorExtension`

New requirement from the caller, now implemented and documented in the function's doc comment.

Every `ledger_head` update is a `group_context_extensions` (GCE) proposal, and a GCE proposal
replaces the **entire** GroupContext extension list — so each one must re-include the anchor
unchanged, and the receiving commit policy byte-compares the proposed anchor's `extensionData`
against its own. If either side re-encodes a decoded `GroupAnchor` instead of copying the bytes, that
compare can fail on identical content (JSON key order, number formatting, dropped `undefined` keys) —
an intermittent failure that looks exactly like an anchor-tampering attack.

`readGroupAnchorExtension(handle): GroupContextExtension | null` returns the anchor extension exactly
as it sits in the GroupContext, without decoding, so a future GCE builder copies rather than rebuilds.
The decoded `GroupAnchor` from `readGroupAnchor` is for **reading**; these bytes are for
round-tripping. The naming read fine when I wrote its usage as a test (a GCE builder takes the
extension and copies `extensionData`), so I did not stop on it.

The two reads share one private `findAnchorExtension` locator, so "present" means the same thing to
both: `readGroupAnchorExtension` returns the raw extension even when it is corrupt (corruption is not
absence), while `readGroupAnchor` throws on that same corrupt extension.

## Decode tolerance / corruption-is-not-absence (preserved from kubun)

- `decodeGroupAnchor` returns `null` — never throws — on non-JSON, non-UTF-8 bytes, JSON that is not
  an object, a missing/non-string `creatorDID`, or a non-number `version`.
- `readGroupAnchor` returns `null` **only** when the extension is genuinely absent. A present-but-
  undecodable extension **throws**: a control gate that treated corruption as absence would fail
  open. The anchor is written once at creation and authenticated by the GroupInfo signature, so this
  is a corruption guard, not a forgery path.

## Test-first pass — what it changed, and the one surprise

Writing the test before the implementation did not force an API change; the shape read cleanly. The
correction (JSON `app` + the verbatim helper) arrived while the test was open, and I folded both in
before implementing.

**Surprise (a flake I caught, in my own test — not the implementation).** My `controlCapabilities`
test initially asserted that every entry of a *fresh* `defaultCapabilities().extensions` was present
in the result. That passed in isolation but failed once in the full suite:

```
AssertionError: expected [ 61696, 61697 ] to include 60138
```

`ts-mls`'s `defaultCapabilities()` seeds **random GREASE values** into `.extensions`, so it returns a
different, non-deterministic set on every call:

```
extensions: [ 6682, 51914 ]
extensions: [ 2570, 19018, 43690, 47802 ]
extensions: [ 14906 ]
extensions: [ 23130 ]
```

Comparing the result against a second `defaultCapabilities()` call is therefore invalid. The
implementation is sound — `controlCapabilities()` dedups via a `Set` and adds both control types — so
I removed the over-assertion and kept the testable invariants: both control types present, each
exactly once. Worth flagging for downstream: `controlCapabilities()` output is non-deterministic
beyond `0xf100`/`0xf101`, so no test may assert its exact `extensions` contents. (The two control
types cannot collide with GREASE, whose values follow the `0xNANA` pattern.)

## Pasted command output

### 1. `pnpm --filter @kumiai/mls exec vitest run test/anchor.test.ts`

```
 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  16:37:30
   Duration  375ms (transform 57ms, setup 0ms, import 202ms, tests 87ms, environment 0ms)
```

### 2. `pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`

```
tsc exit=0
```

(No diagnostics.)

### 3. `pnpm exec biome check ./packages ./tests`

```
Checked 149 files in 34ms. No fixes applied.
biome exit=0
```

### 4. `pnpm --filter @kumiai/mls exec vitest run` (full suite, nothing regressed)

```
 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 Test Files  12 passed (12)
      Tests  120 passed (120)
   Start at  16:37:39
   Duration  1.10s (transform 581ms, setup 0ms, import 2.43s, tests 2.18s, environment 1ms)
```

The anchor file was also run three further times to confirm the GREASE flake is gone: `8 passed`
each time.

## Notes

- `buildLeafCapabilities` in `group.ts` already auto-derives the creator leaf's advertised extension
  types from the group's `extensions`, so passing `capabilities: controlCapabilities()` at
  `createGroup` is belt-and-suspenders for the anchor type but load-bearing for `0xf101` (the head),
  which no extension declares yet.
- `createGroup`'s "always write an anchor" behaviour was **not** added — that arrives with the
  roster. The tests pass the anchor extension explicitly via `options.extensions`.
