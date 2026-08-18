# did:kokuin device verification — deferred hardening

**Origin:** named limitations of the completed did:kokuin device-verification adoption (Slices 1–3),
see `docs/agents/plans/completed/2026-08-18-did-kokuin-device-verify.complete.md`. These are the
future *kumiai-side* concerns the three slices explicitly deferred — each was a conscious scope
decision, not an oversight. None blocks the shipped feature.

## 1. Profile authority-key compromise recovery

**The gap.** A stolen *device* is fully handled today — terminal revocation plus re-add as a fresh
device DID. A stolen *profile authority-key set* (the `did:kokuin:` controller's own n-of-n keys) has
**no in-group remedy**. Device compromise is not profile compromise (a device holds only a delegated
capability and its own MLS leaf key, never the profile's authority keys), so this never arose from
the device lifecycle — but a directly-compromised profile can currently mint valid device capabilities
that every group accepts.

**Why it was deferred.** The terminal-revocation model never reverses a decision, so the KERI
superseding-recovery machinery (`@kokuin/controller`'s `resolveBranches`, reset handling,
non-monotonic rewind) — which exists precisely to *reverse* a divergence — is not needed for anything
the shipped slices do. Recovering a compromised profile key set is the one case that would need it,
and it is a whole design problem of its own (how a recovered profile re-anchors across every group it
belongs to).

**What a slice here would need to establish.** How a superseding recovery event propagates into group
state deterministically; whether it folds as a new control-entry type or arrives out-of-band; how a
device onboarded under the compromised key set is re-validated or terminally denied; and the
interaction with the stable-profile-DID invariant (the DID survives recovery, the keys do not).
Until built, the named accepted risk stands.

## 2. Orphaned admin presence guard

**The gap.** `revokeDevice` can remove a device leaf whose controller profile holds an admin role.
Removing a profile's *last* device leaf leaves it admin in the roster with **no presence** in the
group — its authority survives, its ability to act (it has no leaf to commit from) does not.

**Why it was deferred.** The profile retains its authority correctly; the loss of in-group presence is
a separate governance concern. Guarding it needs per-profile device-leaf tracking in the commit-policy
context (counting a profile's remaining leaves before allowing the removal), which the current context
does not carry.

**Options to weigh.** Reject a revoke that would orphan an admin profile; or allow it but surface a
`deviceRevoked`-adjacent warning event so a consumer can re-establish presence or transfer the role;
or demote-on-orphan. Each has a different failure mode — pick against real consumer need, not in the
abstract.

## 3. Mixed-version negotiation gate

**The gap.** `MLSCredentialIdentity` and `ControlEnvelope` stay `v: 1` with no version gate and no
in-band negotiation. A peer predating the adoption misreads a bound leaf's `controller` as an unknown
field (silent downgrade to floating) and fails closed on the unknown `kumiai.device` control type.

**Why it was deferred.** All first-party consumers (kubun and this monorepo) ship the new fold
together, so the breaking change is *coordinated*, and a coordinated break needs no negotiation. This
was the same deliberate decision at all three slices.

**When to build.** Only if a genuinely mixed-version deployment becomes real (a third-party consumer,
or a staged rollout that cannot ship atomically). At that point a version gate on the credential
and/or envelope, with an explicit accept/reject-or-downgrade rule per version, is a separable change —
it does not require touching the fold or the authority model. Not worth building speculatively.
