# Enforce `GroupAnchor.version` on decode — design

**Source:** [`next/2026-07-23-group-anchor-version-enforcement.md`](../../agents/plans/next/2026-07-23-group-anchor-version-enforcement.md)
**Milestone:** [non-breaking API work](../../agents/plans/milestones/non-breaking-api.md) — ship-before-needed.
**Branch:** `feat/group-anchor-version-enforcement`

## Problem

`packages/mls/src/anchor.ts` declares `CURRENT_VERSION = 1` and writes it onto every anchor via
`buildCurrentGroupAnchorExtension`, but `decodeGroupAnchor` never compares `record.version` against
it. An anchor written by a future build parses as though this build understood it, and its opaque
`app` payload reaches the consumer under a version this build has never seen. Kubun stores its
recovery seed in `app`; a v2 payload read with v1 expectations is undetectable.

This is the last remaining format in the repo where a version is declared and not checked. It is
*degraded*-class (per `completed/2026-07-21-forward-compatibility.complete.md`): fixable later, but
only if the fix forever carries a sniffing rule for the unversioned era. A build that tolerates
unknown versions silently cannot be taught to stop, so the rule must ship before any release goes
out without it.

## Decision

**Option 2 — accept the anchor, withhold `app`.** When `decodeGroupAnchor` sees
`record.version > CURRENT_VERSION`, it returns the structural anchor (`creatorDID`, `version`) with
the `app` payload dropped. Rejected alternatives:

- **Option 1 (return `null`):** because `readGroupAnchor` throws on a `null` decode and the
  `GroupHandle` constructor throws on that, option 1 makes a future-version group *unjoinable* — the
  handle cannot be constructed at all. Too strong: the anchor is met only at a join, and refusing to
  join a group you cannot *fully* interpret is a real liveness cost when the part you can't interpret
  is an opaque consumer payload.
- **Option 3 (doc-only):** no enforcement; a v2 `app` still reaches a v1 consumer. This is today's
  behavior plus a warning — it does not close the gap.

### Why option 2 preserves full participation

Group membership, messaging, commits, and the ledger/roster all run off `creatorDID` (structural)
and MLS state — never `app`. `app` is the *only* version-bearing consumer data on the anchor. So a
v1 peer joins a v2-anchored group as a full member; it only loses the payload it provably cannot
interpret.

`version` is preserved on the returned anchor, so a consumer distinguishes "future version, `app`
withheld" (`version = 2`, `app = undefined`) from "genuinely no `app`" (`version = 1`,
`app = undefined`). Option 1 destroys that signal.

### The contract this rests on

Option 2 is sound **only while the anchor's structural control stays `creatorDID`**. The forward-
compat contract, stated in the doc comments:

- A `version` bump means **`app` semantics changed** — nothing else.
- Any future control-relevant field goes in a **new extension type**, never smuggled into the anchor
  where a `version`-tolerant older peer would ignore it.

If a future v2 violated that (hid security-relevant data a v1 peer skips), option 2 would silently
under-enforce. Naming the contract at the reservation keeps the assumption from rotting unnoticed.

## Scope of change

`packages/mls/src/anchor.ts` only.

- **`decodeGroupAnchor`** — after the existing type guards, gate the `app` copy on
  `record.version <= CURRENT_VERSION`. A `version` above `CURRENT_VERSION` returns
  `{ creatorDID, version }` with no `app`. `version <= CURRENT_VERSION` is unchanged (full anchor
  incl. `app`).
  - The guard is `> CURRENT_VERSION`, matching the plan. A `version < CURRENT_VERSION` (no such
    anchor exists today — `CURRENT_VERSION` is the only value ever written) is accepted in full: by
    the backward-compat contract a lower, already-known version stays interpretable.
- **Doc comments** on `decodeGroupAnchor` and `readGroupAnchor` stating the rule and the v2 contract
  above.

No signature change. `readGroupAnchor` and the `GroupHandle` constructor are untouched: a future
anchor now *decodes* (returns non-null) instead of throwing, so the member joins and only `app` is
withheld.

## Behavior table

| `record.version` | `decodeGroupAnchor` returns | `readGroupAnchor` | Join |
|---|---|---|---|
| `1` (== CURRENT) | `{ creatorDID, version, app? }` — full | anchor | full member, `app` readable |
| `2` (> CURRENT)  | `{ creatorDID, version }` — **no `app`** | anchor | full member, `app` withheld |
| `0` (< CURRENT)  | `{ creatorDID, version, app? }` — full | anchor | full member (unreachable today) |
| not a number / wrong shape | `null` | **throws** (corruption) | fails closed |

## Tests

`packages/mls/test/anchor.test.ts` (existing "returns null on malformed bytes or wrong shape" block
at :110):

- `version` above `CURRENT_VERSION`: `decodeGroupAnchor` returns a non-null anchor; `creatorDID`
  and `version` intact; `app` **absent** even when the encoded bytes carried one.
- `version` below `CURRENT_VERSION`: full anchor returned, `app` retained.
- `version === CURRENT_VERSION` (== 1) with an `app`: unchanged — `app` present.

No round-trip / re-encode concerns: `decodeGroupAnchor` is read-only, and `readGroupAnchorExtension`
(the byte-copy path used by GCE proposals) is not touched.

## Out of scope

- `readGroupAnchor`'s throw-on-corruption behavior — unchanged.
- Any `GroupHandle` / roster / ledger logic — unchanged.
- Bumping `CURRENT_VERSION` or defining a v2 `app` shape — this ships the *guard*, not a v2.
