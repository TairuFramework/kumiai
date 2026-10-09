# Automatic reconciliation of an anchor-gated recovery prefix

**Priority:** backlog. Availability follow-up to crash-safe control (2026-10-08).

An unresolved landed anchor rotation can prevent walking a source prefix while every confirmed rejoin invalidates on that prefix.
The host sees repeated `invalidated` recovery failures with `anchorRecovery: true` and the same non-null `blockingPosition`.

## Evidence

The supplied `task-12-report.md`, “Livelock analysis”, establishes this sequence.
The supplied `final-fix-A-report.md`, “Livelock analysis -- smallest safe progress path”, explains the safety requirement and manual repair.
Both reports belong to the `2026-10-08-spec-p2a-crash-safe-control` implementation session.
The complete sequence is retained here because those working reports are temporary.

1. The requester holds source identity `(E, authenticator, lineage)` and reconciled head `p0`, with anchor recovery pending.
2. Source-epoch commit `C` lands at `p1 > p0`. A responder applies it, but the requester's anchor gate prevents walking it.
3. A rejoin built from newer GroupInfo publishes against `p1`, retaining durable `source.head = p0`.
4. The external commit lands at `p2`. A responder authoritatively confirms the candidate at `E + 2`.
5. The read-only source scan before `p2` finds `C`, without an own-external or recorded-response exception, and invalidates the candidate.
6. Automatic retries obtain newer GroupInfo but retain the same source identity and boundary. Every scan finds `C` again.

## Proposed work

Carry a durable anchor-recovery hold across intermediate authenticated adoptions so the device can reconcile the unwalked source prefix.
The hold must survive crashes and preserve sealing restrictions until the anchor is safely recovered.
Specify transactional hold updates and restart restoration before permitting those adoptions.
Keep source identity equality, the bounded source scan, recorded responses, and the rejoin barrier intact.

WARNING: never advance `source.head` past `C` without processing and reconciling it.
That would erase evidence of a possible source transition without establishing the prefix property required for safe adoption.
Hub acceptance, authoritative confirmation and a commit digest do not prove that property or authenticate the full ledger-body payload.
Bypassing the walker gate or overwriting its pending anchor record alone cannot preserve the hold.
Pruning `C` can create a retention gap that also invalidates the candidate.

## Interim repair and validation

The [MLS lifecycle reference](../../../reference/mls-lifecycle.md) documents authenticated Welcome re-admission as the current manual repair.
Stop and drain the peer, remove its leaf through an authorised administrator, then re-invite with a fresh key package.
Install the newer Welcome with the transactional control and anchor reset, settling open work as `unknown`, then restart.

Cover the sequence above with real MLS and doubles, including crashes at every intermediate adoption and hold update.
Verify eventual progress, held application sealing, unchanged source predicates, and successor processing beyond the rejoin barrier.
