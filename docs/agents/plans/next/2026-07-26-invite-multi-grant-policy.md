# What an invite is allowed to grant: deciding the `commitInvite` ordering residual

**Priority:** low — a design question, not a defect. Needs brainstorming, not a patch.
**Origin:** raised as a residual by `feat/bind-keypackage-recipient` (2026-07-26), re-examined during
`fix/add-proposal-roster-binding` (2026-07-26).

## Correcting the record first

Two earlier claims about this residual are wrong. Both are corrected in the code and specs, but they
are recorded here because either one would send the next attempt in the wrong direction.

**Wrong claim 1: the receive-side Add rule closes it.** It does not. `commitInvite` binds the key
package to the subject of the *last* `kumiai.role` entry the invite enacts. The candidate roster
folds *every* entry the invite enacts, so the last entry's subject is granted in it and the Add
passes the receive check. This is now stated correctly in the `InviteRecipientMismatchError` doc
comment (`packages/mls/src/group-commit.ts`).

**Wrong claim 2: the fix is to seek the enacted entry matching the key package's DID instead of
reading the last one.** That is backwards. Today's rule accepts exactly one key package — the one
whose DID equals the last entry's subject. Seeking *any* matching entry accepts a key package for
any subject the invite grants, a strict superset. It loosens the binding rather than tightening it,
and in the `[grant X, grant Y]` case it still admits Y, which is the outcome the residual describes.

## What the residual actually is

An invite enacting `[grant X, grant Y]` binds to Y. A key package for Y is accepted, Y joins, and X
is left holding a roster grant it never joined against.

That is a smaller problem than it sounds. `packages/mls/src/roster.ts:20` documents the roster map as
DID-keyed precisely "so it can hold a role for a DID that has no MLS membership yet" — a grant
without membership is an intended state, not corruption. The joining identity is not wrong: Y is
bound to Y's own grant, and the receive-side rule independently confirms Y is granted.

What remains odd is only that a hand-assembled invite can grant roles to DIDs that are not its
recipient, and that the recipient is decided by entry position rather than by anything explicit.
`createInvite` always places the invitee's grant last, so nothing this library issues is affected.

## The decision

- **(a) Constrain what an invite may carry.** `commitInvite` rejects an invite that enacts role
  entries for more than one subject that is not already a group member. Fail-closed, small — roughly
  15 lines beside the existing binding. The cost: it forbids a shape the current code comment
  explicitly permits, "an unrelated promotion riding the same commit". Check whether anything
  depends on that before choosing this.
- **(b) Declare the dangling grant intended.** Delete the residual from the docs and from
  `InviteRecipientMismatchError`'s comment, and state that an invite may grant roles to non-joining
  subjects by design. Zero code change; the honest option if (a)'s cost is real.

A third possibility worth weighing during brainstorming: make the recipient explicit in the `Invite`
type rather than inferred from entry position, which removes the ordering question entirely instead
of legislating around it.

## Scope

`packages/mls/src/group-commit.ts` (`commitInvite`'s recipient binding and the
`InviteRecipientMismatchError` doc comment), plus `packages/mls/test/invite-recipient-binding.test.ts`
whichever way it goes. Under (a) or the explicit-recipient option, also
`docs/agents/plans/completed/2026-07-26-bind-keypackage-recipient.complete.md`, which records the
residual as known-open.

Start with brainstorming — the question is what an invite is allowed to be, and the code follows
from the answer.
