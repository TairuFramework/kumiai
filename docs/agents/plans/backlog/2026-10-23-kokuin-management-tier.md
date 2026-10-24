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

## Decisions (2026-10-23)

- The tier is designed stack-wide (kokuin, kumiai, kubun, sakui) in one co-owned spec hosted in
  kubun's stack-adoption milestone, starting from user flows. kubun's credential-record carriage
  defect is to be fixed by it (B resolves delegate A from O's log through `resolveMember`), so the
  records lane is a consumer next to MLS leaves.
- kokuin's tier semantics can still change; a kokuin 0.3 is acceptable.
- A stolen member device keeping log authority past its lease (removing honest members, saturating
  the epoch) is accepted by design, as long as root can fix the log by settling or resetting. No
  extra mitigation.
- The root seed is a hardware wallet or a mnemonic, mostly offline. Management members carry out
  most operations on the controller's behalf, never beyond root's authority: they cannot rotate,
  reset or revoke root keys. Root comes out for setup, member adds, fixing the log and recovery.

Round 2 (user, 2026-10-23):
- Offline device: a phone offline about 30 days keeps group participation, with leaf and holder
  grants up to its lease. Issuing grants to others may pause. Each verifier picks its own
  member-grant lifetime; kumiai may bound holder grants at the lease.
- Signed history: a record signed while its member was effective stays valid after lapse or
  removal. Only a reset or an explicit revoke of that member's grants invalidates it.
- Settle cadence: a size-triggered prompt to bring root out, plus a hard cap past which new
  member-issued MLS leaves fail closed until root settles.

- Device binding: a device's `did:peer:4` is its member pin; root may add it as a member or not.
  kumiai binds a managing device's own leaf by membership (`controller.member: { add, g }`, no
  capability, signature key equals the pin), not by a self-issued grant.

`@kokuin/controller` 0.2.2 exports `deviceRevokeIndex`/`createDeviceRevoke`. It is not a drop-in for
`revokesSubject` in `authenticateLifecycleProof`: it returns the first revoking index, while kumiai
skips revokes below `genFloor`, so a device re-revoked after a reset needs the per-index rule.
0.2.3 (kokuin PR #21) adds `deviceRevokeIndices(did, chain, subject)`: one fold, every revoking
index. Replace `revokesSubject` with it, taking the first index whose generation is at or above the
floor.

Left for the kumiai plan: settle thresholds from a `history-size` run, and a guard so member-attested
`iat` cannot inflate tree time (or ratchet `timeFloor` through `clock`).

The kumiai design (leaf events, member-root tracking, cascade, current-state acceptance,
sole-survivor, freshness, tree-time inflation guard, band 0.12) is in the shared spec: kubun
`.worktrees/stack-adoption` `docs/superpowers/specs/2026-10-23-stack-management-tier-design.md`
(ephemeral; carry it into the kumiai plan).

## Trigger

The stack design above. Until it lands, root-only custody stands.
