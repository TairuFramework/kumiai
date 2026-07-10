# Non-creator invites: `createInvite` drops the inviter's own delegation link

**Priority:** 2 — only the group's CREATOR can serve an invite. A promoted admin cannot, so admin rotation and any non-creator onboarding path are broken.
**Origin:** kubun open-circles design (2026-07-09), Q3.2 bidirectional proof. First code path to drive a non-creator invite end to end; the defect was invisible because every invite test in kubun and kumiai has the group CREATOR do the inviting.

**Revised 2026-07-10** after `docs/superpowers/notes/kubun-impact.md`. The original headline read "a plain member cannot serve an invite, so no relay/hub topology can onboard a joiner." That does not survive the permission-enforcement design: once the default commit policy lands, a plain member's Add is refused by every peer regardless of how well-formed its capability chain is, because `add` requires `admin` in the roster. Fixing the chain does not enable a plain-member relay — **a relay must be an admin.** The real defect is narrower and still real: a non-creator ADMIN cannot invite, which is exactly the flow that design creates (promote a member, have them invite). Whether `add` should require full `admin` rather than a narrower `invite` permission is raised in `notes/kubun-response.md` §4.

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

**Resolved 2026-07-10 by Question 2.5.** The capability chain is removed from the invite entirely.
Nothing it proves is lost — a signed, anchor-rooted `group.role` entry carries signature, group
scoping, permission level, and root-from-creator at equal or greater strength, with a total order
and a revocation primitive the chain never had. Its `aud`-to-joiner binding was never enforced
(`validateGroupCapability` does not read `aud`). Kubun references the chain in zero places.

So requirements 1, 3, and 4 do not get fixed — they cease to exist. There is no chain to build
from the inviter's own link, no depth to bound, no transitive revocation to design.

1. ~~**`createInvite` must chain from the inviter's own capability.**~~ **DISSOLVED.** `Invite`
   becomes `{groupID, recipientDID, inviterID, ledgerEntries}`.
2. ~~**`GroupHandle` must retain the full capability chain.**~~ **WITHDRAWN — already satisfied**
   (and now removed along with the chain).
3. ~~**Chain depth must be bounded.**~~ **DISSOLVED.** (For the record: a cap already existed —
   `DEFAULT_MAX_DELEGATION_DEPTH = 20`, configurable through `validateGroupCapability`'s existing
   `options`, no dependency change needed.)
4. ~~**Revocation semantics must be stated.**~~ **DISSOLVED.** Roster demotion, ordered by the
   epoch chain, is the revocation primitive.
5. **Test the non-creator invite path directly.** **STANDS**, and is the reason the defect went
   unseen. Add: creator promotes a member to admin; that admin invites a third party who joins; a
   plain member's invite is refused by the commit policy; a demoted admin cannot serve a valid
   invite.

## Interaction with permission enforcement

`mls-permission-enforcement.md` (same file, `createInvite`/`processWelcome`) wants `createInvite` to check `group.credential.permission` before issuing, and `processWelcome` to derive `permission` via `extractPermission` rather than trusting `invite.permission`. Both touch the code this item rewrites. Land them together or sequence this one first — the chain shape it establishes is what `extractPermission` will read from.

## Consumer status

kubun's open-circles design assumed a member could relay an invite (a hub or CLI peer that is not the group admin onboarding a joiner). Two separate limits kill that assumption, and only the first is a defect:

1. **Today:** only the creator can serve an invite — this item's bug.
2. **After the permission work:** `add` requires `admin`, so a plain member's invite is refused on the receiving side no matter how well-formed. This is by design, not a bug.

kubun's spec (`docs/superpowers/specs/2026-07-09-open-circles-self-join-design.md`) records the constraint as invite-serving requiring admin authority, creator-only until this item lands. Kubun reaches the same precondition independently — `sharePeerGroup` now rejects a non-admin caller before any ledger write.

The circle self-join half of the design does not depend on either limit: a joiner self-joins open circles with no admin authorship anywhere, proven by documents crossing both ways in `kubun/packages/plugin-p2p/test/open-circle-doc-flow.test.ts`. Circle membership is an application-ledger fact, not MLS group entry.
