# MLS Capability-Layer Member Revocation

> **Relocated from enkaku** (0.18 stack split, 2026-06-30). The packages this targets now live in kumiai: `@enkaku/hub-*` → `@kumiai/hub-*`, `@enkaku/group` → `@kumiai/mls` (`packages/group/` → `packages/mls/`). `@enkaku/token` → `@kokuin/token`. Origin/`completed/` links point at the **enkaku** repo.


**Priority:** backlog (blocks fresh external join with new DID; needed to close stale-rejoin security gap)
**Origin:** Follow-up to `2026-04-20-mls-external-rejoin.complete.md`

## Problem

MLS (RFC 9420) has no cryptographic member revocation. `joinGroupExternal({ resync: true })` lets any device that retains its `MemberCredential` rejoin the group after removal, provided it can still obtain a fresh `GroupInfo`. Today's mitigations are external-to-MLS (group rotation, transport-layer deny-serve). A capability-layer revocation mechanism is needed for production use cases that require guaranteed eviction.

## Sketch

Candidate designs (to be brainstormed):

1. **Capability revocation tokens** — Admin signs `RevokeMember{ groupID, revokedDID, epoch }` cap token. Members persist a revocation set per group. On `processMessage` for commits with add/external-init proposals, reject if the added leaf DID has a valid revocation token. Distribution mechanism needs deciding (piggyback on commits, separate channel, hub broadcast).

2. **GroupContext extension banlist** — Admin puts `bannedDIDs: Array<DID>` in a custom GroupContext extension. Syncs natively via MLS state. Member-side hook in `processMessage` rejects commits adding revoked DIDs. Simpler distribution, unbounded extension growth.

3. **Hybrid** — Signed revocation token stored in GroupContext extension. Best of both: cryptographic verification + MLS-native convergence.

## Dependencies

- Unblocks `proposeAddExternal` and fresh external join (non-resync) once the revocation story is in place.

## Notes

- Member-side enforcement hook lives in `GroupHandle.processMessage` — likely a small validator that runs before `mlsProcessMessage` and rejects adds of revoked DIDs.
- Need to decide: is revocation permanent or per-epoch? Can a revoked DID be re-admitted (fresh delegation resets the ban)?
- Late-joining members need to fetch the revocation set on join — design that into the Welcome or its distribution envelope.

## Status update — 2026-07-11: the stated hole is closed; the premise above is stale

The permission-enforcement work (`../completed/2026-07-11-mls-permission-enforcement.complete.md`)
changes the picture. The problem statement above — "any device that retains its `MemberCredential`
can rejoin after removal, provided it can still obtain a fresh `GroupInfo`" — **is no longer true
for this implementation**, and the capability layer it proposes to revoke no longer exists (the
capability chain was deleted; authority is the roster folded from the signed ledger).

Why a removed device cannot walk back in today:

- `joinGroupExternal` exposes only `resync: true` (the parameter's type is the literal `true`), and
  a resync replaces the caller's *prior leaf*. A removed member has no leaf in the tree, so ts-mls
  refuses the external commit outright ("no prior leaf matching the new KeyPackage"). This is now
  pinned by a test: a member an admin actually removed cannot resync back in.
- A stranger — never in the group — is refused on the same path *and* by the external-commit policy,
  which requires the joining DID to appear in the roster.

So eviction is complete **via the ratchet tree**, not via the roster.

What genuinely remains, and it is narrower than this doc assumes:

- **Removal is not revocation of the roster grant.** `removeMember` evicts the leaf but leaves the
  removed DID's `group.role` entry standing. That grant confers nothing without a leaf, so it is not
  currently exploitable — but it means the roster and the tree disagree about who is a member. An
  admin who wants the grant gone must sign a demotion entry as well.
- **The exposure would return if a non-resync external join were ever exposed.** Such a join adds a
  *new* leaf rather than replacing a prior one, so the "no prior leaf" refusal would not apply, and
  the external-commit policy's roster check would happily admit a removed-but-still-granted DID.
  Anything that unblocks `proposeAddExternal` or a fresh (non-resync) external join must therefore
  either revoke the roster grant on removal, or gate on tree membership rather than the roster.

Revisit this item only when a non-resync external join is actually wanted. The three sketches above
should be re-derived against the ledger/roster model rather than the deleted capability layer — a
revocation is most naturally just another admin-signed ledger entry the fold interprets.
