# What provisioning does when the hub is unreachable is undefined

**Priority:** medium — no defect today, but two entry points changed shape and nothing pins or documents
the new failure mode.
**Origin:** raised by the final whole-branch review of `feat/ordinary-keypackage-pool`, 2026-07-27; see
`docs/agents/plans/completed/2026-07-27-ordinary-keypackage-pool.complete.md`.

## The change that created this

Both of `@kumiai/mls-hub`'s entry points now begin with a network call:

- `createKeyPackagePool(...).ensureStocked()` leads with `client.keyPackageStatus()` to learn the
  deficit.
- `createLastResortProvisioner(...).ensureProvisioned()` gained a `keyPackageStatus()` readback so it
  stops trusting its own record of a successful upload and can detect a hub that lost or replaced the
  slot.

`ensureProvisioned()` previously had a genuinely local steady state: with a healthy, unexpired record it
touched only the store and returned. It no longer does. A transient hub outage now turns a call that
used to be all-local into a throw.

Neither call is guarded, and no test pins the behaviour in either direction. The two are at least
consistent with each other, which is why the review rated this Minor rather than a defect.

## Why it deserves a decision rather than a patch

The right answer is not obviously "swallow the error". A host calling `ensureProvisioned()` on a timer
and ignoring failures would be told nothing when the hub has lost its last-resort slot — which is the
exact silent-failure class the readback was added to remove. But a host calling it on every app start
now fails startup on a transient network blip, where before it would have succeeded locally.

Options worth weighing:

- **Throw, as today, and document it.** Simplest and loudest. Callers wrap it. The cost is that a
  previously-local operation now has a network dependency nobody announced.
- **Distinguish "hub unreachable" from "hub disagrees".** On a status failure, fall back to the previous
  all-local behaviour for `ensureProvisioned` (trust the local record, skip the repair) and report the
  degradation on a separate channel — the `sourceErrors`/`releaseError` shape this package already uses
  for exactly this "surface it, never swallow it" problem. `ensureStocked` has no local fallback, since
  the deficit is unknowable without the hub, so it would still fail.
- **A caller-supplied policy.** Rejected on sight unless something demands it; it pushes the decision
  onto every host and guarantees inconsistent behaviour across them.

The second option is the interesting one because this package already has a precedent for reporting a
partial failure alongside a successful result, rather than choosing between throwing and hiding.

## Scope

`@kumiai/mls-hub` only. Whatever is decided, both entry points should agree, the behaviour should be
stated in the README, and tests should pin it — the current state is undefined by omission rather than
by choice.
