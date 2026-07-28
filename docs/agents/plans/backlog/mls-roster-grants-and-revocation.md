# Roster grants: what they confer, and how they are taken away

**Priority:** backlog — three design questions, no defect among them. Needs brainstorming, not a
patch.
**Merged 2026-07-28** from `next/2026-07-26-invite-multi-grant-policy.md`,
`next/2026-07-26-role-revocation-committer-receiver-split.md`, and
`backlog/mls-capability-revocation.md`. They are one subject: a `kumiai.role` grant is conferred by
an invite, means something on its own, and today can never be withdrawn. Each section below was a
separate doc and can still be read alone.

Read all three before designing revocation. The second and third only become live when revocation
does, and the first constrains what a grant is allowed to be in the first place.

---

## 1. What an invite is allowed to grant

**Origin:** raised as a residual by `feat/bind-keypackage-recipient` (2026-07-26), re-examined during
`fix/add-proposal-roster-binding` (2026-07-26).

### Correcting the record first

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

### What the residual actually is

An invite enacting `[grant X, grant Y]` binds to Y. A key package for Y is accepted, Y joins, and X
is left holding a roster grant it never joined against.

That is a smaller problem than it sounds. `packages/mls/src/roster.ts:20` documents the roster map as
DID-keyed precisely "so it can hold a role for a DID that has no MLS membership yet" — a grant
without membership is an intended state, not corruption. The joining identity is not wrong: Y is
bound to Y's own grant, and the receive-side rule independently confirms Y is granted.

What remains odd is only that a hand-assembled invite can grant roles to DIDs that are not its
recipient, and that the recipient is decided by entry position rather than by anything explicit.
`createInvite` always places the invitee's grant last, so nothing this library issues is affected.

### The decision

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

### Scope

`packages/mls/src/group-commit.ts` (`commitInvite`'s recipient binding and the
`InviteRecipientMismatchError` doc comment), plus `packages/mls/test/invite-recipient-binding.test.ts`
whichever way it goes. Under (a) or the explicit-recipient option, also
`docs/agents/plans/completed/2026-07-26-bind-keypackage-recipient.complete.md`, which records the
residual as known-open.

---

## 2. Revocation would split the committer's Add verdict from the receiver's

**Priority:** none today — a latent hazard, not a defect. Nothing in the codebase can trigger it.
**Origin:** final whole-branch review of `fix/add-proposal-roster-binding`, 2026-07-26.
**This is the section that makes revocation non-trivial.**

### The asymmetry

The receive-side Add rule (`packages/mls/src/policy.ts`, the `add` arm of `evaluateProposal`) asks
whether the added leaf's credential DID holds a role in `context.candidateRoster`. Two callers build
that context, and they build it at different moments:

- **The committer**, filtering its pending-proposal set before authoring
  (`packages/mls/src/group-commit.ts`, `commitWithEntries`), judges a pending Add against the
  **post-fold** roster — the roster after the commit's own entries apply.
- **A receiver**, judging a standalone proposal on receipt (`packages/mls/src/group-handle.ts`),
  judges the same proposal against its **current** roster, because a standalone proposal enacts no
  entries and its candidate roster collapses to the base one.

They can only disagree about a DID whose grant status changed between the two moments.

### Why it cannot bite today

`roleReducer.apply` (`packages/mls/src/roster.ts:50-53`) only ever `set`s. There is no revocation and
no removal — a DID that has ever been granted a role keeps it forever. So the grant status can only
move from ungranted to granted, never back:

- Ungranted at receipt: the receiver rejects the proposal and never stores it, so there is nothing
  for a later commit to reference.
- Granted at receipt: still granted at commit time, so both sides accept.

Anything a receiver actually holds passed the base-roster check and stays granted. The two verdicts
cannot diverge.

### What revocation would do to it

Add revocation and the ungranted-again direction opens. A receiver stores a pending Add for a DID
that is granted at receipt; the grant is revoked; a committer then authors a commit whose post-fold
roster no longer grants that DID, so the committer's filter **drops** the Add. But the commit still
references it by reference, and receivers that stored it expect it to be there.

The failure is a liveness one, not a security one — a commit that peers cannot resolve, which is the
same shape as the griefing bug the pending filter was introduced to fix (see
`packages/mls/test/group.test.ts`, `the committer filters the pending set before authoring a commit`).
That earlier fix made committer and receiver agree; revocation would reintroduce the disagreement
through a different door.

### What to decide, when the time comes

Whether a receiver should re-judge its stored pending proposals when the roster changes, or whether
the committer should keep a dropped-but-referenced proposal rather than filtering it. Either closes
the split; they have different costs and neither is obviously right from here.

---

## 3. Removal evicts the leaf but leaves the grant standing

> **Relocated from enkaku** (0.18 stack split, 2026-06-30): `@enkaku/group` → `@kumiai/mls`,
> `@enkaku/token` → `@kokuin/token`. Origin links point at the **enkaku** repo.

**Origin:** follow-up to `2026-04-20-mls-external-rejoin.complete.md`, superseded in large part by
`../completed/2026-07-11-mls-permission-enforcement.complete.md`.

### The original premise is stale

This began as "MLS Capability-Layer Member Revocation": RFC 9420 has no cryptographic member
revocation, so `joinGroupExternal({ resync: true })` was said to let any device retaining its
`MemberCredential` rejoin after removal. **That is no longer true for this implementation**, and the
capability layer it proposed to revoke no longer exists — the capability chain was deleted, and
authority is now the roster folded from the signed ledger.

Why a removed device cannot walk back in today:

- `joinGroupExternal` exposes only `resync: true` (the parameter's type is the literal `true`), and a
  resync replaces the caller's *prior leaf*. A removed member has no leaf in the tree, so ts-mls
  refuses the external commit outright ("no prior leaf matching the new KeyPackage"). Pinned by a
  test: a member an admin actually removed cannot resync back in.
- A stranger — never in the group — is refused on the same path *and* by the external-commit policy,
  which requires the joining DID to appear in the roster.

Eviction is therefore complete **via the ratchet tree**, not via the roster.

### What genuinely remains

- **Removal is not revocation of the roster grant.** `removeMember` evicts the leaf but leaves the
  removed DID's `kumiai.role` entry standing. That grant confers nothing without a leaf, so it is not
  currently exploitable — but it means the roster and the tree disagree about who is a member. An
  admin who wants the grant gone must sign a demotion entry as well.
- **The exposure returns if a non-resync external join is ever exposed.** Such a join adds a *new*
  leaf rather than replacing a prior one, so the "no prior leaf" refusal would not apply, and the
  external-commit policy's roster check would happily admit a removed-but-still-granted DID. Anything
  that unblocks `proposeAddExternal` or a fresh (non-resync) external join must either revoke the
  roster grant on removal, or gate on tree membership rather than the roster.

### If revocation is built

The three sketches this doc originally carried — revocation tokens, a GroupContext-extension banlist,
and a hybrid — were derived against the deleted capability layer and should be re-derived against the
ledger/roster model. Under that model a revocation is most naturally **just another admin-signed
ledger entry the fold interprets**, which makes `roleReducer.apply` gain a delete arm — and that is
precisely the change section 2 above says splits the committer's Add verdict from the receiver's.

Open questions carried forward: is revocation permanent or per-epoch, can a revoked DID be
re-admitted, and how a late-joining member learns the revocation set (it folds from the ledger it
already replays, if revocation is a ledger entry).

---

## Scope

`@kumiai/mls` throughout — `group-commit.ts`, `policy.ts`, `roster.ts`, and their tests. Section 3
additionally gates anything that would expose a non-resync external join.
