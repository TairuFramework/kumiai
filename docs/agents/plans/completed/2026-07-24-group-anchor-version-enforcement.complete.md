# Enforce `GroupAnchor.version` on decode — complete

**Status:** complete
**Date:** 2026-07-24
**Branch:** `feat/group-anchor-version-enforcement`
**Package:** `@kumiai/mls` (minor → 0.5.0)

## Goal

Close the last remaining format in the repo where a version was declared and never checked.
`packages/mls/src/anchor.ts` baked a `version` into every genesis `GroupAnchor` but
`decodeGroupAnchor` never compared it against the version the running build understands. A future
build's anchor therefore parsed as though this build understood it, and its opaque `app` payload
(kubun stores its recovery seed there) reached the consumer under version expectations this build
had never seen — an undetectable misread.

## What was built

`decodeGroupAnchor` now gates the `app` copy on `record.version <= CURRENT_VERSION`
(`CURRENT_VERSION` is `1`, module-private). When `version > CURRENT_VERSION` it returns the
structural anchor (`creatorDID`, `version`) with `app` withheld; `version <= CURRENT_VERSION` is
unchanged. No signature change. `readGroupAnchor` and the `GroupHandle` constructor are untouched.

Doc comments on `decodeGroupAnchor` and `readGroupAnchor` state the rule and the forward-compat
contract it rests on.

## Key design decision — "accept and withhold" over "fail closed"

Three behaviours were on the table for `version > CURRENT_VERSION`:

1. **Return `null` (hard refuse).** Because `readGroupAnchor` turns a `null` decode into a *throw*
   and the `GroupHandle` constructor throws on that, option 1 makes a future-version group
   **unjoinable** — the handle cannot be constructed. Rejected: the anchor is met only at a join,
   and refusing to join over a payload you merely cannot *interpret* is a real liveness cost.
2. **Accept the anchor, drop `app` (chosen).** The member joins as a full participant — membership,
   messaging, commits, and the ledger/roster all seed from `creatorDID` (structural), never from
   `app`. Only the payload a v1 build provably cannot interpret is withheld. `version` is preserved
   on the returned anchor, so a consumer distinguishes "future version, `app` withheld"
   (`version = 2`, `app = undefined`) from "genuinely no `app`" (`version = 1`, `app = undefined`) —
   a signal option 1 destroys.
3. **No enforcement, document the contract.** Rejected: leaves today's silent misread in place.

Option 2 mirrors how the handshake version was made to reach the classifier rather than being
discarded (see [forward compatibility](./2026-07-21-forward-compatibility.complete.md)).

## The contract this rests on

Stated in the doc comments so the assumption cannot rot silently:

- A `GroupAnchor.version` bump means **`app` semantics changed** and nothing else.
- Any future control-relevant field goes in a **new GroupContext extension type**, never inside the
  anchor where a version-tolerant older peer would silently ignore it.

Sound because the anchor carries only `creatorDID` (authority root, structural), `version` (the
gate), and `app` (opaque). Roster/ledger authority is rooted at `creatorDID` and never consults
`app`, so withholding `app` cannot downgrade a v1 peer's control state. If a future v2 violated the
contract (hid control data in `app`), option 2 would under-enforce — which is exactly why the
contract is named at the reservation.

## Why it shipped now rather than deferred

Non-breaking today: `CURRENT_VERSION` is the only value ever written, so no anchor in the wild
carries a higher version. But *deferring* it is the "degraded" class from the forward-compatibility
work — a later fix would forever have to carry a sniffing rule for the unversioned era, and a build
that tolerates unknown versions silently cannot be taught to stop. Old peers obey the rule only if
they already shipped it, so it had to land before the next release. Deadline was "the next release
that ships", not 1.0.

## Verification

- `packages/mls/test/anchor.test.ts` — 13/13. Three unit tests pin the `<=` boundary (version above
  → `app` absent, `version` preserved; below → full; at current → full); a wrong gate (`!==`, `<`,
  or none) fails at least one. One e2e test drives a future-version anchor *carrying* an `app`
  through `createGroup → readGroupAnchor` and asserts the member joins with `app` withheld.
- Typecheck and lint clean; `turbo build:types` 10/10.
- Task review: spec ✅, quality Approved, zero findings. Final whole-branch review (opus): ready to
  merge, no Critical/Important.

## Follow-on

None. `readGroupAnchorExtension` (the raw-bytes path for GCE round-tripping) never interprets `app`
and was intentionally left untouched, so a v1 peer preserves a future `app` byte-exactly in
round-trips while refusing to interpret it.
