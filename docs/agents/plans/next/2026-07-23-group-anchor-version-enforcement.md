# Enforce `GroupAnchor.version` on decode

**Priority:** 3 — ahead of the stalled Phase 1 items, below the promoted high-severity correctness
work. Small, self-contained, and *ship-before-needed*: the cost of deferring it grows with every
release that goes out without it.
**Origin:** final whole-change review of `feat/app-lane-delivery` (2026-07-21). Split out from
`next/2026-07-20-deferred-api-findings.md` at the 2026-07-23 triage — it was filed among fifteen
other deferrable API-shape items, but it does not belong with them.

## Why this is not deferrable debt

`../completed/2026-07-21-forward-compatibility.complete.md` graded forward-compatibility gaps three
ways: **unreachable** (no later version works), **degraded** (fixable later, but the fix must
forever carry a sniffing rule for the unversioned era), and **silent** (fixable later, type-checks,
and is therefore dangerous). Version bytes landed on the client-state and credential-identity
formats precisely because they are *degraded*-class.

`GroupAnchor` carries a version and never enforces it — the same class, in the one format the plan
missed. After that branch it is the only remaining format in the repo where a version is declared
and not checked.

## The gap

`packages/mls/src/anchor.ts:68` requires `record.version` to be a `number` and `:71` copies it onto
the returned anchor. Nothing ever compares it against `CURRENT_VERSION` (`:28`, currently `1`,
written only by `buildCurrentGroupAnchorExtension` at `:90`).

So an anchor written by a future build parses as though this build understood it, and its `app`
payload is handed to the consumer — through `readGroupAnchor` (`:137`) and thence
`group-handle.ts:292` and `group-create.ts:42` — under a version this build has never seen. A
consumer that stores something meaningful there (kubun keeps its recovery seed in `app`) reads a
v2 payload with v1 expectations and cannot tell.

## Why the stakes are lower than the frame formats — and why it still ships now

The anchor is written once at group creation and is immutable, so there is no live lane on which an
old peer meets a new anchor except a join. And a `null` at a join is not self-evidently better than
a tolerated anchor: refusing to join a group whose anchor you cannot fully interpret is a real
liveness cost.

That trade-off is exactly why this must be decided *now* rather than later. Whatever the rule is —
reject, or accept-and-flag — old peers only obey it if they already shipped it. A build that
tolerates unknown versions silently cannot be taught to stop.

## What to decide

The implementation is small; the design question is which of these `decodeGroupAnchor` should do
when `record.version > CURRENT_VERSION`:

1. **Return `null`.** Fail closed, consistent with every other malformed case in the tolerant
   decode. Costs joinability against future groups.
2. **Return the anchor with the unknown version, and drop `app`.** The structural fields a v1 peer
   does understand (`creatorDID`) stay usable; the payload it provably cannot interpret does not
   reach the consumer. Preserves joinability.
3. **Return the anchor and let the consumer branch on `version`.** No enforcement, only a documented
   contract that consumers must check — which is what happens today, minus the documentation.

Option 2 is the likely answer (it matches how the handshake version was made to reach the
classifier rather than being discarded), but confirm before implementing.

## Scope

- `packages/mls/src/anchor.ts` — the version comparison in `decodeGroupAnchor`, and doc comments on
  `decodeGroupAnchor`/`readGroupAnchor` stating the rule.
- Whatever the chosen option implies for `readGroupAnchor`'s `GroupAnchor | null` signature. Options
  1 and 2 need no signature change; option 3 needs none either but wants a prominent doc warning.

## Test hooks

`packages/mls/test/anchor.test.ts:110` already covers "returns null on malformed bytes or wrong
shape". Add cases for `version` above `CURRENT_VERSION` (asserting the chosen behaviour), `version`
below it, and — regardless of option — that a `version: 1` anchor is unaffected.
