# Probe brief — Question 2.1: a generic `GroupAnchor` with an opaque `app` slot

First source change of the implementation. Everything before this was a read-only probe.

Create `packages/mls/src/anchor.ts` and `packages/mls/test/anchor.test.ts`. Export the new symbols
from `packages/mls/src/index.ts`. Touch nothing else in `src/` unless the brief says so.

Read `AGENTS.md` and the `kigu:conventions` skill before writing code. `type` not `interface`;
`Array<T>` not `T[]`; never `any`; capital `ID`/`DID`; ES `#fields`, never `private`/`readonly`;
never edit generated `lib/`. **Code, comments, and test names must never reference plan questions,
decision numbers, or phase labels.** No `// Q2.1:`. State the constraint or invariant directly.

**Write the test first.** Before implementing, write `anchor.test.ts` showing how a caller uses
this API. If it reads awkwardly, fix the API before implementing it. This is a hard requirement,
not a preference.

## Where this comes from

`kubun/packages/plugin-p2p/src/groups/group-anchor.ts` (read it — it is the thing being made
generic). Kubun's anchor is `{creatorDID, version, recoverySecret}`. The `recoverySecret` is a
kubun concern: an epoch-independent seed for its non-rotating recovery topic. kumiai must not know
about it.

## What to build

```ts
/** MLS GroupContext extension carrying the genesis anchor. */
export const GROUP_ANCHOR_EXTENSION_TYPE = 0xf100
/** MLS GroupContext extension carrying the control-ledger head. */
export const LEDGER_HEAD_EXTENSION_TYPE = 0xf101

export type GroupAnchor = {
  creatorDID: string
  version: number
  /** Opaque consumer payload, written once at group creation. `@kumiai/mls` never
   *  reads it. Kubun stores its recovery seed here. */
  app?: Uint8Array
}
```

Plus: `encodeGroupAnchor` / `decodeGroupAnchor`, `buildGroupAnchorExtension(anchor)`,
`controlCapabilities()`, `readGroupAnchor(handle)`.

Both extension type constants live here even though the head's *logic* arrives in a later step —
`controlCapabilities()` must advertise both from the outset, or an anchored group cannot later
carry a head without every member's leaf being rejected.

Note kubun's `groupAnchorCapabilities()` is what `controlCapabilities()` replaces. RFC 9420
requires each member leaf to advertise every custom GroupContext extension type, at both
`createGroup` and `createKeyPackageBundle`, or `commitInvite` refuses the added leaf.

### `app` is bytes, and the anchor is JSON today

Kubun's encode is `TextEncoder().encode(JSON.stringify(anchor))`. `app` is a `Uint8Array`, which
does not survive `JSON.stringify` — this is the one real design decision in this step. Pick an
encoding that round-trips arbitrary bytes exactly, decide it deliberately, and say in the report
what you chose and why. Whatever you pick, a byte-for-byte round trip of a non-UTF-8 `app` payload
(include `0x00` and `0xff` bytes in the test) must pass.

### Decode is tolerant; a corrupt anchor is not absence

`decodeGroupAnchor` returns `null` on malformed bytes or wrong shape — never throws.

`readGroupAnchor(handle)` returns `null` **only** when the extension is genuinely absent. An
extension that is present but undecodable is corruption, not absence, and **throws**. Kubun's
comment explains why: a control gate that treats corruption as absence fails open. Preserve that
distinction and its reasoning, in your own words.

Unlike kubun's, `app` is optional: an anchor without it is valid, not malformed. Kubun required
`recoverySecret`; that requirement moves to kubun's own decode of its `app` bytes.

## Done when

`anchor.test.ts` covers, at minimum:

1. An anchor with a non-empty `app` containing `0x00` and `0xff` bytes survives a real
   `createGroup` → `readGroupAnchor` round trip, byte-for-byte.
2. An anchor with no `app` round-trips and reads back with `app` undefined.
3. `readGroupAnchor` on a group with no anchor extension returns `null`.
4. `readGroupAnchor` on a group whose anchor extension holds undecodable bytes **throws**.
5. `decodeGroupAnchor` returns `null` — never throws — on: not-JSON, JSON that is not an object,
   a missing `creatorDID`, a non-number `version`.
6. `controlCapabilities()` advertises both `0xf100` and `0xf101`, and is idempotent if the
   defaults already contain them.
7. A group created with `controlCapabilities()` can invite and admit a member whose key package
   also advertises them, and the joined member reads the same anchor. (Lift the fixture from
   `packages/mls/test/groupcontext-extension.test.ts:46` — it already proves this shape for one
   extension type.)

Do **not** write `createGroup`'s "always write an anchor" behaviour in this step. `createGroup`
takes `extensions` today and the test can pass one. Anchor-is-mandatory arrives with the roster.

## Rules

- **Stop at the first failure of the approved approach.** Report `BLOCKED` with what you tried and
  what happened. Do not try alternatives without asking. Difficulty is information.
- If the API reads badly when you write the test, say so and stop. That is the finding.
- Paste **actual command output**, not a summary.

## Verify

From the repo root (`/Users/paul/dev/yulsi/kumiai`). An `rtk` shim intercepts `pnpm run <script>`;
use `pnpm exec` forms:

```
pnpm --filter @kumiai/mls exec vitest run test/anchor.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
pnpm exec biome check ./packages ./tests
```

All three must pass. Also run the existing suite once to prove nothing regressed:

```
pnpm --filter @kumiai/mls exec vitest run
```

## Report contract

Write the full report to `docs/superpowers/probes/question-2.1-report.md`: what you built, the
`app` encoding decision and its reasoning, anything the test-first pass made you change about the
API, pasted output of all four commands, and any surprise.

Return to the caller **only**: status (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED`), a one-line
summary, the encoding you chose, and concerns. Not the report body.
