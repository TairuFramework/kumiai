# did:kokuin device verification — deferred hardening

**Origin:** named limitations of the completed did:kokuin device-verification adoption (Slices 1–3),
see `docs/agents/plans/completed/2026-08-18-did-kokuin-device-verify.complete.md`. These are the
future *kumiai-side* concerns the three slices explicitly deferred — each was a conscious scope
decision, not an oversight. None blocks the shipped feature.

This item **consolidates and supersedes** the earlier `2026-08-07-did-registry-ledger-entries.md`
backlog entry: the shipped adoption resolved that entry's device-onboarding half on the capability
path (no ledger entry, exactly as its own "entry size" constraint recommended), and what remained of
it — profile authority-key rotation as folded entries, `didRegistryReducer`, superseding recovery,
the cross-group duplicity floor — is the same future work captured below. The kokuin milestone
`docs/agents/plans/milestones/2026-08-07-profile-did-key-events.md` remains the design source of
truth for the key-event format; the sections here cover only what kumiai would build.

## 1. Profile authority-key rotation + compromise recovery

**The gap.** A stolen *device* is fully handled today — terminal revocation plus re-add as a fresh
device DID. A stolen *profile authority-key set* (the `did:kokuin:` controller's own n-of-n keys) has
**no in-group remedy**, and there is no in-group representation of an ordinary authority rotation
either. Device compromise is not profile compromise (a device holds only a delegated capability and
its own MLS leaf key, never the profile's authority keys), so neither arose from the device lifecycle
— but a directly-compromised profile can currently mint valid device capabilities every group
accepts, and a rotated profile has no group-visible record of the rotation beyond the advisory
beacon.

**Why it was deferred.** Ordinary rotation is orthogonal to the deterministic fold: the profile DID
is stable across rotation, and `controllerOf`/`authority` return that stable DID, never the profile's
keys, which are pinned per-leaf by the authority-only prefix embedded at onboard time. So authority
resolution is rotation-invariant and needs no rotation entry for correctness. And the
terminal-revocation model never reverses a decision, so the KERI superseding-recovery machinery —
which exists precisely to *reverse* a divergence — is not needed for anything the shipped slices do.
Recovering a compromised profile key set is the one case that would need it.

**What a slice here would build.**

- **A nested, group-independent entry shape.** The outer ledger entry is group-scoped and notarises
  ordering and inclusion only; its `value` carries a self-authorising key event signed by the
  subject's own pre-committed key. Nesting dissolves the group-scoping blocker — the outer entry is
  rejected cross-group as a replay, but the same inner bytes replay into every group unchanged, and
  an admin can neither forge the inner event (wrong key) nor remove it after inclusion (the head
  would diverge).
- **Member-publishable rotation entries.** Admin authorship does not survive the censorship analysis
  (an admin simply never includes a member's rotation; no head diverges over an entry that never
  existed, and a thief-holds-admin group never learns the revocation). So the admin-authorship
  invariant is relaxed for exactly one case: a non-admin entry is admitted iff its type is the
  rotation-application namespace *and* the inner event's subject DID matches the author. Costs borne
  knowingly: **a policy flag day** (every peer ships the relaxed fold before the first
  member-authored entry, gated by a version floor peers advertise — see §3), and **per-member rate +
  size bounds** on the rotation type so the relaxed rule is not a spam channel into the
  replayed-at-welcome ledger. Keep this the *only* authorship flag day.
- **A `didRegistryReducer`.** Folds inner chains per subject: rejects `seq` gaps, verifies each event
  against the previous event's pre-rotation digests, and flags same-`seq` forks as duplicity rather
  than resolving them (rotation is sequential per controller — a fork is surfaced, not merged). The
  one exception is **superseding recovery**: a `rotate` signed by the pre-committed next keys outranks
  operations signed by current keys, so the fold must rewind current-key operations past the
  divergence point rather than treat the recovery as a fork. This is the machinery that gives a
  compromised profile an in-group remedy.
- **An application-namespace entry type** (not `kumiai.*`, whose unknown reserved types fail the whole
  commit closed — a flag day). Do not populate GroupContext extension `0xf102` either; that is a
  separate policy flag day (`policy.ts` admits only zero-length data there today).

**Constraints to weigh before starting.**

- **Entry size.** Every entry is a signed token; ML-DSA-65 signatures are ~3.3 KB, taking a token
  from ~200 bytes to ~7 KB, replayed at every welcome and covered by the head. Device onboarding is
  deliberately kept on the capability path (no ledger entry) for exactly this reason; only authority
  rotation, post-quantum migration, and recovery produce entries.
- **No compaction path** exists for the ledger today (a ledger-wide limitation the beacon already
  inherits). A per-profile rotation history needs either a checkpoint story or a hard rotation-rate
  budget.
- **Confidentiality.** Entries are sealed under `kumiai/ledger-entries/v1`, so the registry is not
  readable outside the group; external verification stays proof-carrying.

**Blocked on** the kokuin key-event module and the `iss`-resolution change in `@kokuin/token`. Nothing
here can start before the inner event format is fixed. Until built, the named accepted risk (no
in-group remedy for profile-key compromise) stands.

## 2. Cross-group duplicity floor

**The gap.** kumiai orders per group only. A device revoked in one group is revoked in the others only
by explicit consumer orchestration (kumiai emits the fact; the consumer calls `revokeDevice` per
group). Likewise a divergent profile key-event chain presented to two groups is not prevented.

**What a slice would add.** Once profile rotation entries exist (§1), nesting makes divergent chains
*detectable* across groups (inner event ids are comparable) though not prevented. Verifiers should
treat the highest inner `seq` seen for a DID anywhere — any group, any direct presentation — as a
monotonic floor: both the staleness guard and the comparison that makes duplicity detectable. The
Slice-3 controller-log beacon is the advisory in-group precursor of this signal; a real floor needs
the comparable inner-event ids §1 introduces. Depends on §1.

## 3. Orphaned admin presence guard

**The gap.** `revokeDevice` can remove a device leaf whose controller profile holds an admin role.
Removing a profile's *last* device leaf leaves it admin in the roster with **no presence** in the
group — its authority survives, its ability to act (no leaf to commit from) does not.

**Why it was deferred.** The profile retains its authority correctly; the loss of in-group presence is
a separate governance concern. Guarding it needs per-profile device-leaf tracking in the commit-policy
context (counting a profile's remaining leaves before allowing the removal), which the current context
does not carry.

**Options to weigh.** Reject a revoke that would orphan an admin profile; or allow it but surface a
`deviceRevoked`-adjacent warning event so a consumer can re-establish presence or transfer the role;
or demote-on-orphan. Each has a different failure mode — pick against real consumer need.

## 4. Mixed-version negotiation gate

**The gap.** `MLSCredentialIdentity` and `ControlEnvelope` stay `v: 1` with no version gate and no
in-band negotiation. A peer predating the adoption misreads a bound leaf's `controller` as an unknown
field (silent downgrade to floating) and fails closed on the unknown `kumiai.device` control type.

**Why it was deferred.** All first-party consumers (kubun and this monorepo) ship the new fold
together, so the breaking change is *coordinated*, and a coordinated break needs no negotiation. Same
deliberate decision at all three slices.

**When to build.** Only if a genuinely mixed-version deployment becomes real (a third-party consumer,
or a staged rollout that cannot ship atomically). A version gate on the credential and/or envelope,
with an explicit accept/reject-or-downgrade rule per version, is a separable change — it does not
touch the fold or the authority model, and it is the version floor §1's rotation flag day would
advertise against. Not worth building speculatively.
