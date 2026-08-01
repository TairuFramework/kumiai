# Bind a key package's credential DID to the invite recipient

**Status:** complete
**Landed:** 2026-07-26, branch `feat/bind-keypackage-recipient`
**Package:** `@kumiai/mls` (minor)

## The gap this closed

`commitInvite` handed whatever `KeyPackage` it was given straight into the MLS Add proposal. It
checked that `invite.groupID` matched the group; it did not check that the key package's credential
DID was the identity the invite grants a role to. The identity that actually joined was therefore
decided by whoever supplied the bytes — in practice the hub's key-package store.

The failure was a silent success, not a refusal. A fetch for BOB that returned ALICE's key package
Welcomed **ALICE** into the group, where she derives the epoch secrets and reads all traffic, while
the ledger entry the same commit enacted granted the role to **BOB**. Roster and MLS membership
disagreed, and no party could notice from its own state. The reachable trigger was a `HubStore`
whose last-resort read dropped its owner predicate — which `@kumiai/hub-conformance` catches, but
that made the store the only check, and the layer furthest from the group's own security decision.

## What was built

A guard inside `commitInvite`, after `entriesAddedByInvite` and before the Add proposal is built,
so a wrong package costs no commit. It verifies the invite's newly-enacted ledger tokens, takes the
`subject` of the **last** `kumiai.role` entry for this group, and compares it against the DID
parsed from the key package's basic credential — both sides folded through `normalizeDID`.

- A mismatch throws the new exported `InviteRecipientMismatchError`, carrying `groupID`,
  `expectedDID`, and `actualDID`.
- An invite enacting no role entry for the group, and a key package carrying a non-`basic`
  credential, each throw a bare `Error`.

Eleven tests in `packages/mls/test/invite-recipient-binding.test.ts`; every guard branch is
mutation-checked.

## Design decisions worth keeping

**The recipient comes from the enacted role entry, not a new `Invite` field.** That entry is the
grant this same commit applies to the roster, so binding the MLS leaf to it *is* the invariant —
roster and membership cannot disagree — with no type change and no new input. An explicit
`Invite.recipientDID` would be self-declared data that can drift from the ledger it travels with,
so it would have needed its own consistency check against the same entry to be worth anything.

**The last role entry, not the only one.** An earlier draft required exactly one, on the premise
that `createInvite` produces exactly one. That premise was false: `packages/mls/test/group.test.ts`
carries two tests ("the control: an admin committing the same Add and promotion is accepted", and
"a member-signed entry smuggled into an invite is refused before it is committed") that commit an
invite carrying a promotion for an existing member *plus* the invitee's grant in one commit. Both
keep the invitee's grant last, which is what `createInvite` itself does and documents ("The whole
log, new role entry last"). Reading the last entry gets the same answer wherever exactly-one was
right, and keeps working where it was not.

**The ordering is load-bearing, not stylistic.** A hand-assembled invite whose invitee grant is not
last binds to whichever role entry *is* last, and a key package for that subject is accepted — the
leaf that joins is not the one the inviter meant to add, and the intended invitee gets a roster
grant without ever joining. The admitted party always holds a grant enacted by the same commit, so
this is not the original hole (an identity with no grant at all deriving the epoch secrets), but it
is still a divergence. `createInvite` satisfies the precondition by construction; anything
assembling an invite by hand must too. A test pins this as known behaviour rather than leaving it
undiscovered.

**A dedicated error class, so the store bug is machine-distinguishable.** `InviteRecipientMismatchError`
lets a host tell "the hub served the wrong package" from an ordinary rejection and alert on it.
The shape failures stay bare `Error`s: a malformed invite and a non-kumiai credential are not
identity substitutions, and hosts have no distinct action for them. Reporting the non-`basic` case
through the typed error would have meant inventing a stand-in string for `actualDID` — the
placeholder-value anti-pattern.

**Narrowed with ts-mls's `isDefaultCredential`, not a cast.** `credentialType !== basic` does not
narrow the `Credential` union on its own, because `CredentialCustom.credentialType` is a bare
`number`. `packages/mls/src/authentication.ts` solves the same problem with a cast, but that
function returns `false` on every failure path, where a wrong cast degrades to a rejection. This
one admits a member to a group, and the compiler can prove the narrow here.

**The guard is only sound in combination with credential authentication.** On its own it checks a
*claimed* DID — anyone can mint a key package carrying another DID's credential bytes with their
own signing key. What makes the pair sound is `createDIDAuthenticationService`
(`packages/mls/src/authentication.ts`), which ts-mls invokes on the Add's leaf during
`createCommit`: it binds the credential DID to control of the leaf's signature key. Together they
mean the leaf that joins is the DID this commit grants a role to.

**`joinGroupExternal` needed nothing**, verified rather than assumed: it builds its own key package
from `identity`, so nothing external picks the joining identity. No rpc port or test double was
affected either — `commitInvite` is not a port member, and neither contract suite changed.

## Known follow-up

The invariant is still local to the inviter. `defaultCommitPolicy`'s add rule accepts any admin's
Add without checking the added leaf's credential DID against `candidateRoster`, so a *receiver*
still cannot notice the divergence from its own state — only an honest inviter now refuses to
produce one. Tracked in `archive/2026-07-archive-summary.md` (add-proposal-roster-binding, shipped 2026-07-26), which
would also close the ordering residual described above, from the other side.

## Verification at merge

`pnpm exec turbo run test:types test:unit --force` — 40/40, `Cached: 0 cached`. Integration suite
35 pass. Lint clean. Four task reviews plus an adversarial whole-branch review; the whole-branch
review found no Critical issues and confirmed no input under the store-controls-the-bytes attacker
model still lands an ungranted leaf.
