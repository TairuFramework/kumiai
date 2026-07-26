# Bind an Add proposal's leaf to the candidate roster on the receive path too

**Priority:** medium-high
**Origin:** the final whole-branch review of `feat/bind-keypackage-recipient`, 2026-07-26.

## The gap

`feat/bind-keypackage-recipient` makes `commitInvite` refuse to author a commit whose key package
disagrees with the roster it grants — but that invariant is enforced only where the commit is
authored. `defaultCommitPolicy`'s add rule (`packages/mls/src/policy.ts:153-156`) accepts any Add
from an admin sender without checking the added leaf's credential DID against
`context.candidateRoster`:

```ts
case defaultProposalTypes.add:
case defaultProposalTypes.psk:
case defaultProposalTypes.reinit:
  return isAdmin(context, effectiveSender) ? 'accept' : 'reject'
```

So a *receiver* still cannot notice a divergence between the leaf being added and the roster the
same commit's ledger entries grant — only an honest inviter now refuses to produce one. A receiver
running a modified or buggy `commitInvite` (or any future write path that builds an Add proposal
directly) would apply the commit and welcome the wrong identity into the group exactly as before
this branch, from the receive side.

## Why this is cheap

The inputs are already in hand at the point `evaluateProposal` judges an add:
`proposal.add.keyPackage.leafNode.credential` names the DID the leaf presents, and
`context.candidateRoster` is the roster the commit's own enacted entries produce. Every honest
invite puts the invitee's grant in that candidate roster by construction (that is what
`commitInvite`'s new guard binds to), so the check is: parse the credential's DID, normalize it,
and confirm the candidate roster grants it a role.

## What this would also close

`commitInvite`'s recipient binding has a documented residual: it reads the *last* `kumiai.role`
entry the invite enacts, so a hand-built invite whose intended invitee's grant is not last binds to
whichever entry is last instead, and a key package for that subject is accepted. The intended
invitee then holds a roster grant without ever joining. `createInvite` places the invitee's grant
last by construction, so the residual is reachable only through a hand-assembled invite — see
`docs/agents/plans/completed/2026-07-26-bind-keypackage-recipient.complete.md` and the
`InviteRecipientMismatchError` doc comment in `packages/mls/src/group-commit.ts`. A receiver-side check
against `candidateRoster` does not care about entry order — it only asks whether the added DID has
*any* grant in the roster the commit produces — so it would reject an Add for a DID the candidate
roster does not grant, whatever order the invite's entries were in. This closes the residual from
the other side rather than requiring `commitInvite` to get ordering right.

## Scope

`packages/mls/src/policy.ts` (`evaluateProposal`'s add case) and whatever in `credential.ts` is
needed to parse a leaf's DID without throwing on a non-`basic` credential — a receiver judging an
untrusted commit cannot let a malformed credential throw past the policy boundary. Likely touches
`rpc-conformance` and `hub-conformance` if either suite runs a scenario with a candidate roster and
a mismatched Add; check both suites before assuming neither is affected, per the port-change rule
in `AGENTS.md`.

## Open questions

- What a receiver does on a divergence: reject the whole commit (matching how `foldEnvelope`
  already treats any admission it cannot make sense of), or something more specific.
- Whether the psk/reinit branches sharing this case arm need a similar look, or whether they are
  unaffected because neither carries a leaf.
