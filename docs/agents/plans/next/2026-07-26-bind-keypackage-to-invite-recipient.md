# Bind a key package's credential DID to the invite recipient

**Priority:** medium-high — defence in depth against a store bug whose blast radius is a
cross-DID membership substitution.
**Origin:** surfaced by the whole-branch review of the last-resort key-package work landed
2026-07-26 (branch `feat/last-resort-keypackage`). Not a defect introduced by that work — the gap
predates it — but that work made the consequence sharper and is what brought it to light.

## The gap

`commitInvite` (`packages/mls/src/group-commit.ts`) hands whatever `KeyPackage` it is given
straight into the Add proposal:

```ts
const addProposal: DefaultProposal = {
  proposalType: defaultProposalTypes.add,
  add: { keyPackage },
}
```

It validates that `invite.groupID` matches the group. It does **not** check that the key package's
credential DID equals `invite`'s recipient. So the identity that actually joins the group is
decided entirely by whoever supplied the bytes — today, the hub's key-package store.

## Why it matters

The failure is not "the wrong person is refused". It is that the wrong person **succeeds**:

- A fetch for BOB that returns ALICE's key package Welcomes **ALICE** into the group, where she
  derives the epoch secrets and can decrypt everything.
- The ledger entry the same commit enacts grants the role to **BOB**. So the roster and the MLS
  membership disagree, silently, with no party in a position to notice from its own state.

The reachable trigger is a `HubStore` implementation whose last-resort read drops its owner
predicate — `SELECT blob FROM key_packages WHERE is_last_resort LIMIT 1`. `@kumiai/hub-conformance`
now carries a clause that catches exactly this (added 2026-07-26, same branch), so a store that
runs the suite is covered. But that makes the store layer the *only* check, and it is the layer
furthest from the group's own security decision.

## What to do

Add the binding check in `commitInvite`, before building the Add proposal: parse the key package's
credential with `parseMLSCredentialIdentity` and reject when its `id` is not `invite`'s recipient
DID. The inviter already knows both values — no new input, no new dependency, no wire change.

Open questions to settle first:

- **Where the recipient DID lives.** `Invite` carries `groupID`, `inviterID`, and `ledgerEntries`
  — the recipient is currently implicit in the last ledger entry's subject. Either read it from
  there or add an explicit field; the latter is clearer but is a type change with consumers.
- **Error type.** A dedicated error (rather than a bare `Error`) lets `mls-rpc` and hosts
  distinguish "the hub served the wrong package" from an ordinary rejection — which is exactly the
  operational signal a store bug should produce.
- **Whether `joinGroupExternal` needs the analogous check.** Its external-commit policy already
  resolves the committing DID from the commit's own UpdatePath leaf credential and requires roster
  membership, so it may already be covered. Verify rather than assume.

## Testing

The claim to prove is the one the current code cannot make: build an invite for BOB, hand
`commitInvite` a key package generated for ALICE, and assert it is refused. Mutation-check it — the
test must fail if the new check is removed. Then assert the honest path still commits, so the check
cannot have been implemented as a blanket refusal.
