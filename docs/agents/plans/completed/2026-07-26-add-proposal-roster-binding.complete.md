# Bind an Add proposal's leaf to the candidate roster on the receive path

**Status:** complete — landed 2026-07-26 on `fix/add-proposal-roster-binding`.
**Origin:** the final whole-branch review of `feat/bind-keypackage-recipient`, which shipped the
send-side half of this binding.

## Goal

`commitInvite` refused to author a commit whose key package disagreed with the roster the same
commit grants, but that invariant held only where the commit was authored. A receiver could not see
the divergence: `defaultCommitPolicy` accepted any Add from an admin sender without looking at the
added leaf at all. A modified or buggy `commitInvite`, or any future write path building an Add
directly, would still Welcome an identity the roster never granted a role to.

This adds the mirror rule on the receive side.

## What was built

`defaultCommitPolicy`'s `add` case now requires the added leaf's credential DID to hold a role in the
commit's candidate roster. `add` split out of the arm it shared with `psk` and `reinit`, which carry
no leaf and are otherwise unchanged. Supporting it, `didFromCredential` in
`packages/mls/src/credential.ts` extracts a normalized DID from an MLS leaf credential and returns
`undefined` — never throws — for a non-`basic` credential or any malformed identity.

Ships as a `minor` on `@kumiai/mls`.

## Key design decisions

**`candidateRoster`, not `baseRoster`.** An honest invite's grant for the invitee rides the same
commit as the Add, so it exists only after the fold. Checking the base roster would reject every
legitimate invite.

**Membership, not provenance.** The rule asks whether the added DID holds any role, never whether
this commit granted it. A re-add — a second device, a rejoin after removal — enacts no entry and must
keep working. Note that roles are append-only (`roleReducer.apply` only ever `set`s), so "holds a
role" means *was ever granted one*; an evicted member keeps their grant.

**Unconditional, not gated on `commitEnactsEntries`.** The cheaper alternative — check only when the
commit enacts entries — is defeated by an attacker simply omitting the envelope, so it closes almost
nothing. The cost of going unconditional is an ordering constraint, below.

**Plain `'reject'`, no new error type and no reason channel.** `defaultCommitPolicy` returns ts-mls's
`IncomingMessageAction`, which carries no reason, and threading one out would need side-channel state
that breaks the function's documented purity. Every other rule in the file already rejects opaquely.
A host that wants to distinguish this case reads the Add off `CommitRejectedError.proposals`. The
asymmetry with `commitInvite`'s typed `InviteRecipientMismatchError` is deliberate: the send side is a
local programming or key-package-store fault worth alerting on; the receive side is an untrusted peer
sending something inadmissible, which is routine.

**`didFromCredential` is total, and off the public API surface.** Totality is the point — a receiver
judging an untrusted commit cannot let a malformed credential throw past the policy boundary. It is
not re-exported from the package index because `policy.ts` is its only consumer; widening later is
cheap and impossible to undo. `commitInvite` deliberately keeps its own inline parse rather than
calling it, because it distinguishes "non-basic credential" from a malformed-JSON failure in its
error messages and collapsing both to `undefined` would report the wrong cause. A cross-reference
comment records that the two bindings must stay in agreement or a divergence surfaces as a liveness
failure — the committer authoring a commit every receiver rejects.

## Behaviour change

The rule makes MLS membership imply a roster grant. Every honest path already satisfied it: the
creator is seeded as epoch-0 admin, and `createInvite` always issues a `kumiai.role` entry for the
invitee.

The one thing that changes is ordering. An Add absorbed by a commit that enacts no grant for the
added DID — an admin's standalone Add riding an unrelated eviction commit, say — is now dropped by
the committer's own pending filter and rejected by receivers. The capability is not lost, only
ordered: commit the grant, then let a later commit absorb the Add.

## What this closes, precisely

It rejects an Add whose DID holds **no** grant in the candidate roster.

It does **not** close `commitInvite`'s last-entry ordering residual, despite an earlier claim that it
would. An invite enacting `[grant X, grant Y]` binds the key package to Y; the candidate roster folds
both entries, so Y is granted in it and the Add passes. X keeps a grant it never joined against. See
`2026-07-26-invite-multi-grant-policy.md` in `next/`, which also corrects a second wrong claim about
how to fix it.

## Verification

A whole-branch review found no path by which an Add reaches `'accept'` with the added DID absent from
the candidate roster: external commits reject an Add outright (`evaluateExternalCommit` permits only
`external_init` plus the self-`remove`), the empty-proposal early accept carries no Add, unknown tags
fail closed, and DID normalization agrees on both sides. Impersonation is closed upstream — the DID
authentication service binds a leaf's signature key to its credential DID, so "the DID has a grant"
does imply "the grant holder's key".

Both contract suites ran against the real implementation and the doubles. The `memory-group-mls`
double needed no change: it represents an add as a bare DID string, so a key-package/roster
disagreement is structurally unrepresentable in it — already stricter than the port, which the
test-doubles rule permits.

Coverage sits at both levels: the policy function directly, and end to end through a real receiver
applying an admin-authored commit that adds an ungranted DID.

## Follow-on work

- `../backlog/mls-roster-grants-and-revocation.md` — the ordering residual as a design question about
  what an invite may grant, with two earlier wrong claims corrected.
- `../backlog/mls-roster-grants-and-revocation.md` — a latent hazard that only becomes
  live if role revocation is ever added. Inert today because roles are append-only.
- `next/2026-07-07-test-gaps.md` gained one item: no `did:peer:4` identity flows through this rule
  end to end, since every group test uses `did:key`.
