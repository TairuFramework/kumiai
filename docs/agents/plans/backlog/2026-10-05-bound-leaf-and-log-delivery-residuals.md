# Bound-leaf lifecycle and log delivery: deferred residuals

**Priority:** backlog. None is a correctness gap in the shipped contracts; each is a known bound that
the design accepted. Context: `../completed/2026-10-05-bound-leaf-and-log-delivery.complete.md`.

## Ledger compaction or re-anchoring

A lifecycle group's ledger proofs never shrink, even after a key reset, and the controller-log horizon is
a fixed 393,216 bytes. A group whose ledger alone nears the horizon records no further proof; the only
path today is a new group. Needed only for long-lived groups with many revocations. Direction: a
re-anchoring commit that folds the ledger into a compact, authenticated summary. Needs its own design.

## A bound on consumer ledger entries

Consumer entries are limited only by the final-frame check. A group whose entries grow large enough makes
every frame that carries the whole ledger fail with `FrameTooLargeError`: invites, Welcomes and sealed
GroupInfo replies. New members cannot join and recovery ends `no-responder`. Direction: a per-group or
per-entry cap enforced at the commit gate, or paged ledger transfer.

## Stale-confirmation residual in controller-less groups

A member removed after the source epoch can feed stale GroupInfo and confirm a recovery from retained
state. Lifecycle groups bound this by leaf expiry; groups without a controller have nothing to check
against and keep the unbounded form (same as before this work, not a regression). Direction: a
recovery-workstream design for an independent freshness signal.

## Removed-receiver path validation (upstream)

ts-mls returns before validating or applying the path for a removed receiver, so it can treat itself as
removed by a commit survivors reject (an early leave). Closing it needs an upstream ts-mls change; track
alongside `ts-mls-upstream.md`.

## One commit-head probe per outbox entry

The worker probes the commit head after each publication, so a burst of entries costs one probe each.
Performance only. Direction: batch one probe over entries published at the same epoch.

## Durable unusable-binding set

`markBindingUnusable()` state is an in-memory, identity-keyed, 16-entry set. A restart permits one
extra refused attempt. Persist it only if restart-after-refusal proves common in practice.

## Notice dedupe across restart

`AppWindowPruned` and similar notices deduplicate per topic and cursor in memory and can repeat after a
restart. Harmless for idempotent hosts; persist the dedupe key only if a host cannot tolerate repeats.

## Delivery latency under sustained commit pressure

Certification needs a seal-to-probe interval with no intervening commit, so a group committing
continuously can delay log delivery. Direction: certify through a covered complete walk even when
commits keep arriving, if such a group exists.
