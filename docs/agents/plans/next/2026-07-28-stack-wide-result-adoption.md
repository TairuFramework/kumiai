# Should the rest of kumiai return Results too

**Priority:** low — a design question, not a defect. Needs brainstorming, not a patch.
**Origin:** scoped out of `feat/provisioning-retryable-result` (2026-07-28); see
`docs/agents/plans/completed/2026-07-28-provisioning-retryable-result.complete.md`.

`@kumiai/mls-hub` now returns `AsyncResult` from its two provisioning entry points, splitting a
retryable hub failure from a settled refusal. It is the only package in kumiai that does. The
question is whether that pattern earns its keep anywhere else.

## Why it was not swept across

A blanket conversion would move 156 `throw new` sites, both conformance suites, and every double
behind them. Most of those throws are broken invariants rather than outcomes a caller chooses
between — constructor validation, a store record that fails its own round-trip contract, an
unauthenticated message. `Result` is for expected failure paths; converting by grep would drown the
signal.

The rule `mls-hub` adopted is also domain-specific. Retryable-versus-refused came from the hub's
error taxonomy and from the fact that an unreachable hub costs a user nothing while it lasts.
`@kumiai/mls`'s crypto failures do not split that way and would need their own classification.

## What to decide

- Which failures elsewhere in the stack are genuinely *expected* — a caller picks between outcomes —
  rather than invariant violations.
- Whether `@kumiai/rpc`'s existing `isPermanentSubscribeFailure` (`packages/rpc/src/hub-mux.ts:255`)
  should be expressed the same way, given it already encodes the identical rule internally.
- How the conformance suites express a `Result`-returning port, since every double must match.
- Note that `@sozai/result` is used by exactly one package in sozai itself, so kumiai would be
  setting the stack's precedent rather than following it.

Read what `mls-hub` actually cost before deciding: that is the point of having done it first.
