# Adopt the kokuin management tier

**Priority:** backlog, open design question. Target: a band raise of its own (0.12 or later). Decided
2026-10-23 when 0.11 moved onto `@kokuin/controller` 0.2 without it.

## What kokuin offers

`@kokuin/controller` 0.2 adds management members: hot devices pinned in the profile's own log by a
root `add`, with a lease. A member can issue short-lived grants (`mbr` claim, checked by
`@kokuin/capability` through `resolveMember`) and revoke edge devices through epoch `rev` events,
without the root seed. Members, renewals, removals and member revokes live in the log's epoch
`events`; root rotates settle them into the snapshot (`m`, `d`).

## Where kumiai stands (0.11)

- Leaf prefixes, lifecycle proofs and `recordedLog` carry the root chain only; `controller-log.ts`
  folds them as `{ chain, events: [] }`.
- The embedded resolver forwards an allowlist without `resolveMember`/`frozen`, and
  `assertControllerGrant` requires `iss === sub`, so member-issued grants fail closed.
- A device revoke is a same-generation root rotate whose snapshot denies the device: every revoke
  needs the seed and adds a chain event.

## What adoption needs

- **Carrying epoch events.** A new optional `controller.events` on the leaf credential (the parser
  ignores unknown fields, so the shape is additive) and an epoch-bearing proof form for member
  revokes. A peer without the feature rejects member-granted leaves, so this needs its own band raise.
- **Resolver.** Supply `resolveMember` from the embedded log; treat `EPOCH_SATURATED` as unavailable,
  never as "nothing denied"; decide whether `frozen()` is useful per verification.
- **Registry and proofs.** Member revokes in `authenticateLifecycleProof`, `proofFor` and the
  registry fold; the producer and verifier must agree as they do for root revokes.
- **Freshness.** Embedded epoch state is a snapshot at leaf creation: member removals and revokes
  after that reach a verifier only through the ledger. Decide what an expired lease or a later member
  removal means for a leaf already in the tree.
- **Size.** Epoch events grow credentials and ledger proofs; re-run `history-size` against
  `HISTORY_HORIZON` and the deferred-hardening rotation-rate budget.
- **Contracts.** Both conformance suites against the real implementation and the doubles.

## Trigger

A kubun or sakui need for devices that grant or revoke without the root seed. Until then root-only
custody stands.
