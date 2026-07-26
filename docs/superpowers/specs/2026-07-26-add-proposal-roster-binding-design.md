# Bind an Add proposal's leaf to the candidate roster on the receive path

**Origin:** `docs/agents/plans/next/2026-07-26-add-proposal-roster-binding.md`, raised by the final
whole-branch review of `feat/bind-keypackage-recipient` (landed as #14, commit `d66f6e1`).

## The gap

`commitInvite` now refuses to author a commit whose key package disagrees with the roster the same
commit grants (`packages/mls/src/group-commit.ts:349-391`). That invariant is enforced only where
the commit is authored. `defaultCommitPolicy`'s add rule accepts any Add from an admin sender
without looking at the added leaf at all (`packages/mls/src/policy.ts:153-156`):

```ts
case defaultProposalTypes.add:
case defaultProposalTypes.psk:
case defaultProposalTypes.reinit:
  return isAdmin(context, effectiveSender) ? 'accept' : 'reject'
```

So a receiver cannot notice a divergence between the leaf being added and the roster the same
commit produces. A modified or buggy `commitInvite`, or any future write path that builds an Add
proposal directly, would still Welcome the wrong identity into the group — from the receive side,
exactly as before #14.

The inputs are already in hand where `evaluateProposal` judges an add:
`proposal.add.keyPackage.leafNode.credential` names the DID the leaf presents, and
`context.candidateRoster` is the roster the commit's own enacted entries produce.

## What this closes, precisely

It rejects an Add whose DID holds **no** grant in the candidate roster.

It does **not** close `commitInvite`'s documented ordering residual, contrary to what the originating
`next/` item claimed. Walk that case: a hand-built invite enacting `[grant X, grant Y]` binds the key
package to Y, because `commitInvite` reads the *last* `kumiai.role` entry. The candidate roster folds
both entries, so Y is granted in it and the receive check passes. X keeps a grant it never joined
against, exactly as before. Closing that needs a separate send-side change — binding to whichever
enacted entry grants the key package's DID rather than to the last one — and it is out of scope
here. The `InviteRecipientMismatchError` doc comment currently points at the receive path as the
eventual fix for this; that claim is corrected as part of this work.

## Design

### The rule

Split `add` out of the shared `add | psk | reinit` arm in `evaluateProposal`:

```ts
case defaultProposalTypes.add: {
  if (!isAdmin(context, effectiveSender)) return 'reject'
  const addedDID = didFromCredential(proposal.add.keyPackage.leafNode.credential)
  if (addedDID === undefined) return 'reject'
  return context.candidateRoster.roles.has(addedDID) ? 'accept' : 'reject'
}
case defaultProposalTypes.psk:
case defaultProposalTypes.reinit:
  return isAdmin(context, effectiveSender) ? 'accept' : 'reject'
```

`didFromCredential` returns a normalized DID and `candidateRoster.roles` is normalized-keyed, so the
compare is direct. The admin check stays first: an ungranted Add from a non-admin rejects for the
older, simpler reason, and the rule adds no new way for a non-admin to learn anything.

`psk` and `reinit` carry no leaf and are unaffected. The split exists only so they stop sharing an
arm that now reads `proposal.add`.

**`candidateRoster`, not `baseRoster`.** An honest invite's grant for the invitee rides the same
commit as the Add, so it exists only in the candidate roster. Checking the base roster would reject
every legitimate invite.

**Membership in the roster, not "granted by this commit".** The rule asks whether the added DID holds
any role in the candidate roster, not whether this commit enacted its grant. A re-add of a DID that
already holds a grant — a second device, a rejoin after removal — must keep working, and the policy
has no view of which entries this commit enacted beyond the roster they fold into.

### The helper

`didFromCredential(credential): string | undefined` in `packages/mls/src/credential.ts`, **not**
re-exported from the package index — `policy.ts` is the only consumer, and it is cheap to export
later if a host asks for it.

It guards with ts-mls's `isDefaultCredential` plus `credentialType === defaultCredentialTypes.basic`
(the same two-step `commitInvite` uses, because `CredentialCustom.credentialType` is a bare `number`
and does not narrow on its own), then catches everything `parseMLSCredentialIdentity` throws — bad
JSON, unsupported `v`, non-string `id`, non-string `longForm` — and returns `undefined`.

The function is total and never throws. That is the point: a receiver judging an untrusted commit
cannot let a malformed credential throw past the policy boundary, and `defaultCommitPolicy` is
documented as pure and total.

`commitInvite` keeps its own inline parse rather than routing through the helper. It deliberately
reports "non-basic credential" and a malformed-JSON failure as different errors, and collapsing both
to `undefined` would make it report the wrong cause.

### Data flow

Nothing new. `candidateRoster` is already a field on `CommitPolicyContext`
(`packages/mls/src/policy.ts:24`) and is already populated by `buildCommitPolicyContext` for both
callers: the receive gate (`packages/mls/src/group-handle.ts:790`) and the send-side pending-proposal
filter (`packages/mls/src/group-commit.ts:207`). No new context field, no caller wiring.

Three consequences follow:

- **Receive.** An ungranted Add rejects the whole commit — a proposal-level reject already propagates
  to the commit verdict (`packages/mls/src/policy.ts:262-266`).
- **Send.** `commitWithEntries`'s pending filter drops such an Add before authoring, so the committer
  and its receivers reach the same verdict. That symmetry is what the filter exists for; without it
  the committer would author a commit every peer rejects.
- **`commitInvite` is unaffected.** Its Add rides `extraProposals`, which the pending filter does not
  touch, and it satisfies the rule by construction: the binding pins the key package to a subject
  this commit's entries grant, so the fold puts that DID in `candidateRoster`.

### Error handling

Plain `'reject'`. No new error type and no reason channel.

`defaultCommitPolicy` returns ts-mls's `IncomingMessageAction`, which has no room for a reason, and
threading one out would require side-channel state that breaks the function's purity. Every other
rule in the file — non-admin sender, unauthorized Remove, tampered extension list — already rejects
opaquely, and `CommitRejectedError` (`packages/mls/src/group-handle.ts:73`) carries no reason either.
A host that wants to alert on this specific case can read the Add off `error.proposals` and run the
same compare.

The asymmetry with `commitInvite`'s typed `InviteRecipientMismatchError` is deliberate: the send side
is a local programming or key-package-store fault worth alerting on, while the receive side is an
untrusted peer sending something inadmissible, which is routine.

## Behaviour change

The rule makes MLS membership imply a roster grant. Every honest path already satisfies this — the
creator is seeded as epoch-0 admin (`packages/mls/src/roster.ts:47`) and `createInvite` always issues
a `kumiai.role` entry for the invitee — with one exception in the test suite.

`packages/mls/test/group.test.ts:3184`, *"retains an admin's pending proposal and carries it into the
commit"*, seeds an admin's standalone Add of Dave and lets a `removeMember` commit absorb it. That
commit enacts no grant for Dave, so under the new rule the send-side filter drops the Add and Dave
never joins. The capability is not lost, only ordered: an admin commits Dave's grant first, and a
later commit absorbs the pending Add. The test is rewritten grant-first.

This ordering constraint is accepted deliberately. The alternative — checking only when
`context.commitEnactsEntries` is true — lets an attacker skip the check by omitting the envelope,
which closes almost nothing.

## Scope

Changed:

- `packages/mls/src/credential.ts` — add `didFromCredential`.
- `packages/mls/src/policy.ts` — split the add arm, apply the check, document the rule.
- `packages/mls/src/group-commit.ts` — correct the `InviteRecipientMismatchError` doc comment's claim
  about what the receive path would close.
- `packages/mls/test/policy.test.ts` — new `addProposal(did)` helper and new cases (below).
- `packages/mls/test/group.test.ts` — rewrite the absorbed-Add test grant-first.

Not changed, verified rather than assumed:

- `packages/rpc-conformance` — no scenario builds an Add against a candidate roster.
- `packages/hub-conformance` — its only touchpoint is a doc comment on the key-package store
  (`packages/hub-conformance/src/index.ts:930`), which describes `commitInvite`'s send-side binding
  and stays accurate.
- The `memory-group-mls` double (`packages/rpc/test/fixtures/memory-group-mls.ts`) represents an add
  as a bare DID string, so a key-package/roster disagreement is structurally unrepresentable in it.
  It is already stricter than the port here, which the test-doubles rule permits.

Both contract suites are still run against the real implementation and the doubles, per `AGENTS.md`.

## Testing

`policy.test.ts`'s `taggedProposal` fabricates no payload, so all six add-bearing call sites would
read `proposal.add.keyPackage` off `undefined` once the rule lands. They need an `addProposal(did)`
helper that builds a real `basic` credential whose `identity` is the JSON bytes
`parseMLSCredentialIdentity` expects.

New cases:

- An Add whose DID holds a role in `candidateRoster` is accepted.
- An Add whose DID holds no role in `candidateRoster` is rejected.
- An Add whose DID is granted only in `candidateRoster`, absent from `baseRoster`, is accepted — the
  honest-invite shape.
- An Add carrying a non-`basic` credential is rejected.
- An Add whose credential identity bytes are malformed is rejected, and the call does not throw.
- A non-admin sender's Add is still rejected, granted DID or not.
- `psk` and `reinit` remain admin-gated and are not affected by the split.

Existing coverage that must stay green: the standalone-proposal receipt tests and the pending-filter
tests in `group.test.ts:3099-3211`, the latter with the grant-first rewrite.
