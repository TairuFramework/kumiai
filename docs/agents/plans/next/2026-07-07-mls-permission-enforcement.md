# MLS group permission enforcement + `processWelcome` token handling

**Priority:** 2 — the capability layer is currently decorative at the MLS boundary.
**Origin:** June 2026 enkaku audit (relocated backlog item, 0.18 stack split) merged with
the 2026-07-02 kumiai audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Problem

`GroupPermission` levels (`admin`/`member`/`read`) travel in group capabilities but are
never enforced on MLS operations, and `processWelcome` trusts inviter-controlled fields.

## Findings

### High

- **`packages/mls/src/group.ts:521-556,655-685` — `GroupPermission` never enforced.**
  `createInvite`, `commitInvite`, and `removeMember` never check
  `group.credential.permission`, and absent a caller-supplied `commitPolicy`,
  `processMessage` accepts add/remove commits from any leaf — a `read`-level member can
  remove members and every peer accepts it. Fix: enforce permission checks in the mutating
  operations and ship a default commit policy validating the committer's capability level.

### Medium

- **`packages/mls/src/group.ts:587-622` — `processWelcome` trusts the invite.** Never
  checks the validated capability's `aud` equals `identity.id`, and copies the
  inviter-controlled `invite.permission` verbatim into the stored `MemberCredential` (a
  token granting `read` can yield a locally trusted `admin` credential; `extractPermission`
  exists but is unused here). Fix: assert
  `normalizeDID(capToken.payload.aud) === normalizeDID(identity.id)` and derive
  `permission` via `extractPermission(capToken)`.
- **`packages/mls/src/capability.ts:106-114` — groupID path confusion.** `groupID` is
  interpolated into the resource string unvalidated, so a capability for group `a/x`
  (`res: 'group/a/x/*'`) passes the `res.startsWith('group/a/')` check for group `a`.
  Fix: reject groupIDs containing `/` and `*` in create/validate, or match on an exact
  escaped segment.

### Low

- `packages/mls/src/group.ts:521-524` — `commitInvite` never checks the key package
  credential against the invite's `recipientDID`, so a capability can be bound to one DID
  while adding a leaf for another. Fix: optionally require a match.
- `packages/mls/src/group.ts:616-618` — `processWelcome` never verifies
  `invite.capabilityToken` is the last element of `invite.capabilityChain`; stored chain
  can diverge from the validated token. Fix: assert `chain.at(-1) === token`.

## Design sketch (carried from the enkaku backlog item)

1. **Sender-side checks (easy)** — `commitInvite`/`removeMember` check
   `group.credential.permission` locally before committing. Honest-client guard only; a
   modified client skips it.
2. **Receiving-side commit authorization (the real fix)** — when `processMessage` sees a
   handshake message with Add/Remove proposals, resolve the committer's leaf → DID →
   capability and require `admin` (or `member` for self-removal). Needs: capability
   distribution to all members (piggyback on MLS extension? hub lookup?), and a policy for
   external commits/resync. The audit's "default commit policy" is this, shipped as the
   default rather than opt-in.
3. **Document advisory semantics** — if any part of enforcement belongs to the
   application/delivery-service layer, state that explicitly in `@kumiai/mls` docs.

## Dependencies

- Ties into `backlog/mls-capability-revocation.md` — both need committer-identity →
  capability resolution at `processMessage` time; design them together. The validator hook
  location is the same: a check that runs before `mlsProcessMessage` in
  `GroupHandle.processMessage`.
