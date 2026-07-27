# Nothing tops up the ordinary key-package pool

**Priority:** medium — a host that never re-uploads still works, but forfeits forward secrecy for
every new member.
**Origin:** scoped out of the last-resort provisioning work landed 2026-07-26; see
`docs/agents/plans/completed/2026-07-27-last-resort-provisioning.complete.md`.

## The gap

`@kumiai/mls-hub` keeps the last-resort slot filled. Nothing keeps the ordinary pool filled. A host
that uploads once at enrolment and never again eventually serves every join from the reusable
last-resort package — correct, and the availability floor works exactly as designed, but a reused
init key means new members do not get the forward secrecy a fresh package would give them.

## The blocker, and why this is not a small change

**A client cannot learn its own pool depth.** `hub/v1/keypackage/upload` returns
`{ stored: number }`, meaning stored-by-this-call; consumption happens on someone else's fetch and is
never reported. So there are only two shapes available:

- **Blind top-up.** Re-upload N packages on a schedule and treat `KeyPackageQuotaExceededError` as
  normal operation. No protocol change; wasteful and noisy, and it cannot tell a drained pool from a
  full one — which is exactly the distinction that matters.
- **Add a depth query.** `hub/v1/keypackage/status` returning the caller's own count, then top up on
  demand. Correct, and it needs `hub-protocol`, `hub-server`, and `hub-conformance` clauses, plus a
  minor release across them. Note the authorization shape: a DID may read only its OWN depth, or the
  query becomes a reconnaissance channel telling an attacker exactly when a drain has succeeded.

The second is the real answer. It was kept out of the last-resort work because the item's premise
there was "no hub-side change expected", and mixing a protocol addition into a policy layer would
have obscured both.

**The same gap has a sibling: a DID cannot read back its own LAST-RESORT slot either.** `HubClient`
exposes only `uploadLastResortKeyPackage`, so `@kumiai/mls-hub` has to treat its own record of a
successful upload as proof the hub still holds the package. A hub that lost the slot is reported as
provisioned until the next rotation falls due. Whatever shape a self-read status query takes, it
should cover both the ordinary pool's depth and the last-resort slot's presence, under the same
read-only-your-own-DID authorization.

## Scope

`@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-conformance`, `@kumiai/hub-client`,
`@kumiai/mls-hub`. Retention is simpler than the last-resort case — an ordinary bundle's private half
may be dropped once its Welcome is processed — but the same store-before-upload ordering applies, and
the same accumulate-then-prune shape, so `LastResortStore` is the template rather than a thing to
reuse verbatim.
