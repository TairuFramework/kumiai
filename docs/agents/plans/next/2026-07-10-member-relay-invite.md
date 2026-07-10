# Member-served invites: `createInvite` drops the inviter's own delegation link

**Priority:** 2 — a plain member cannot serve an invite at all, so no relay/hub topology can onboard a joiner.
**Origin:** kubun open-circles design (2026-07-09), Q3.2 bidirectional proof. First code path to drive a non-creator invite end to end; the defect was invisible because every invite test in kubun and kumiai has the group CREATOR do the inviting.

## Problem

Group membership is an Enkaku capability delegation chain rooted at the creator. `createInvite` builds the invitee's chain from the inviter's `rootCapability` rather than from the inviter's own chain, so the inviter's own membership link is dropped. Only the creator — for whom "root capability" and "own chain" coincide — can produce a chain that validates.

The `GroupPermission` level is irrelevant here: a member promoted to `admin` still fails, because `rootCapability` is the creator's root regardless of permission. This is orthogonal to `mls-permission-enforcement.md` (which asks whether the inviter is ALLOWED to invite); this item is that a permitted inviter's invite is structurally unverifiable.

## Root cause

`packages/mls/src/group.ts` (`lib/group.js:350-366` in the built 0.1.0):

```js
const memberCap = await delegateGroupMembership({
  identity, groupID: group.groupID, recipientDID, permission,
  parentCapability: group.rootCapability,           // <- creator's root, not the inviter's link
})
const invite = {
  capabilityChain: [ group.rootCapability, memberCapStr ],   // <- inviter's own link missing
  ...
}
```

A joined member's handle is constructed with `rootCapability: invite.capabilityChain[0]` (`lib/group.js:459`) — the creator's root token, not the `creator→member` delegation it received. So when member R (invited by creator A) invites B:

- R signs `R→B` with `parentCapability = A-root`.
- The chain ships as `[A-root, R→B]`; the `A→R` link is absent.
- B's `processWelcome` → `validateGroupCapability` → `checkDelegationChain(R→B, [A-root])` calls `assertValidDelegation(A-root, R→B)`, which requires `to.iss === from.aud`, i.e. `R === A`.
- Fails with `Invalid capability: audience mismatch` (`@kokuin/capability/lib/index.js:209`).

## Reproduction

Three engines, kubun `packages/plugin-p2p`: A (creator, HTTP + autoAccept[R]), R (HTTP + autoAccept[B]), B (outbound-only).

1. A creates a group. R runs `joinPeerGroup(peerDID: A, groupID)` — **succeeds**, R is a plain member.
2. B runs `joinPeerGroup(peerDID: R, groupID)` — **fails**: `Invalid capability: audience mismatch`, thrown from B's `processWelcome`.

R serving the invite is the only difference from the passing two-engine case. R's own membership is valid; the invite it produces is not.

## Requirements

1. **`createInvite` must chain from the inviter's own capability, not from the group's root.** The invitee's chain must be the inviter's full validated chain plus the new delegation — `[...inviterChain, inviterCap, newDelegation]` in whatever shape keeps `assertValidDelegation` true for every adjacent pair, terminating at the creator's self-issued root.
2. **`GroupHandle` must retain the full capability chain, not just element zero.** A joined member currently stores `rootCapability = chain[0]` and loses the links that prove its own membership. It needs both: the root (for `res`/`groupID` checks) and its own chain (to extend when inviting). `commitInvite`/`processWelcome` construct handles in at least two places (`lib/group.js:396,459,491`) — all must agree.
3. **Chain depth must be bounded and validated.** A relay chain grows by one link per hop (`A→R→B→C…`). Verification cost is linear in depth; a malicious inviter can inflate it. Decide a maximum depth, enforce it in `checkDelegationChain`, and state it in the docs.
4. **Revocation semantics must be stated.** With multi-hop chains, revoking `A→R` must invalidate `R→B` transitively. `backlog/mls-capability-revocation.md` currently assumes a single delegation level; that assumption breaks here. Design the two together.
5. **Test the non-creator invite path directly.** The defect survived because no test has a member invite anyone. Add: creator invites member; member invites a third party; third party's `processWelcome` validates; a fourth hop still validates; a member whose own link was revoked cannot serve a valid invite.

## Interaction with permission enforcement

`mls-permission-enforcement.md` (same file, `createInvite`/`processWelcome`) wants `createInvite` to check `group.credential.permission` before issuing, and `processWelcome` to derive `permission` via `extractPermission` rather than trusting `invite.permission`. Both touch the code this item rewrites. Land them together or sequence this one first — the chain shape it establishes is what `extractPermission` will read from.

## Consumer status

kubun's open-circles design assumed a member could relay an invite (a hub or CLI peer that is not the group admin onboarding a joiner). That claim has been narrowed to creator-only invite-serving in `kubun/docs/superpowers/specs/2026-07-09-open-circles-self-join-design.md` pending this fix. The circle self-join half of the design does not depend on it: a joiner self-joins open circles with no admin authorship, proven by documents crossing both ways in `kubun/packages/plugin-p2p/test/open-circle-doc-flow.test.ts`. Only the MLS invite-serving hop is creator-bound.
