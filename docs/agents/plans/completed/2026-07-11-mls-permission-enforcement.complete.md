# MLS permission enforcement — complete

**Status:** complete.
**Origin:** 2026-07-02 repo audit (commit `bb343d9`), milestone `../milestones/2026-07-audit-remediation.md`
Phase 1 item 2. Landed on `feat/mls-permission-enforcement`.

## Goal

`GroupPermission` existed as a type but nothing enforced it. A modified client could remove
anyone from any group and every peer would accept the commit — the admin check lived only at
the sender API. Make authority real, and enforce it on the *receiving* side, so a peer refuses
a commit whose author lacks the permission for it regardless of what the sender's client does.

## What was built

The library now owns a generic authority layer: a **signed, anchor-rooted control ledger**,
folded into a **roster**, enforced as a **receiving-side commit policy** on both the
PrivateMessage and the external-join (PublicMessage) paths. The capability-delegation chain
that predated it is deleted outright.

- **Anchor** — an immutable group-context extension naming the creator; seeded at construction.
  A handle without one throws (fail-closed). It carries an opaque `app` slot the library never
  reads.
- **Ledger** — an ordered log of signed entries. Each entry binds its `groupID`, so an entry
  lifted verbatim from another group is dropped by the fold (closing a cross-group replay that
  content-addressing alone could not).
- **Roster** — folded from the anchor plus the ledger. `group.role` is the library's one
  interpreted entry type; every other type is notarized, ordered, and handed back to the host
  unread.
- **Ledger head** — a group-context extension chaining `SHA256(head ‖ frame(entryID))` over the
  entries each commit enacts. An invite ships the whole ordered ledger and the joiner recomputes
  the head against the authenticated group context, so an omitted, reordered, or truncated
  ledger is rejected (`LedgerIncompleteError`).
- **Commit policy** — each peer folds a candidate roster off its own pre-commit state and checks
  every proposal against *its own sender*, not the committer, so an admin cannot launder a
  non-admin's Remove by committing it.

## Key design decisions (rationale preserved)

- **`'read'` is not a permission.** It was removed rather than implemented: a group member holds
  the epoch secrets and derives the same application keys as anyone else, so MLS cannot express
  read-only membership. Encoding it would have been a lie in the type system.
- **Authority is the roster, not a token.** The capability chain was deleted rather than fixed.
  A delegated token can only restate what the roster already decides, so it added a second
  source of truth with no additional power — and the chain made only the group creator able to
  serve an invite. Any admin can now invite; authority is decided by the live roster.
- **Authority is judged from state-so-far.** While folding an envelope's entries in order, each
  entry's issuer must be an admin in the state accumulated from *strictly earlier* entries. So
  `[promote Bob, Bob-issued-entry]` in one envelope is valid, while an entry cannot authorize
  itself.
- **Order comes from the MLS epoch chain, not a clock.** Entries are ordered by the commits that
  enacted them. A signer-asserted timestamp would let a demoted admin backdate a grant and
  retroactively promote anyone; the protocol assigns the epoch, so that class of attack does not
  exist here.
- **Removal is not revocation.** `removeMember` evicts the MLS leaf but does not erase the
  removed DID's roster grant. Eviction is nonetheless complete: rejoining requires a prior leaf
  in the tree, which a removed member no longer has (see `../backlog/mls-capability-revocation.md`).
- **A caller-supplied commit policy *replaces* the default** rather than composing with it. This
  is the documented override contract, but it means a host that sets one for any reason silently
  disables all permission enforcement — called out on the option's type.

## Hardening found in the branch's own review (also landed here)

- **Authenticated-griefing stall (the significant one).** ts-mls absorbs pending by-reference
  proposals into the next commit. A non-admin could broadcast a standalone proposal that every
  honest committer then folded in, causing every peer to reject *that committer's* commit —
  permanently stalling the group and blocking even an admin's attempt to evict the proposer. Now
  closed on both sides: a received standalone proposal is judged by the same commit policy (so it
  is rejected on receipt and never stored), and the commit producers filter the pending set
  against that policy before committing, using the same post-fold context receivers build.
- **`group_context_extensions` was under-constrained.** The policy checked only the anchor and the
  head, so an admin could inject or strip another extension (e.g. `external_senders`, which would
  grant a non-member proposal-injection rights) inside an otherwise-valid head move. A GCE commit
  must now reproduce the extension list exactly, with only `ledger_head` substituted.
- **`createGroup` now fails closed** when a caller-supplied anchor names a `creatorDID` other than
  the creating identity — which would otherwise build a group whose sole member is not its own
  admin.

## Verification

Enforcement is proven against real MLS wire bytes, not simulated policy contexts: forged commits
are hand-authored (self-promotion, a promotion laundered inside an Add, a member-signed ledger
entry, a missing or mismatched head, a replayed token from a since-demoted admin) and each is
rejected with the epoch and roster unchanged. Cross-group replay is rejected at the commit level.
A non-creator admin's invitee joins and converges end-to-end over the hub transport. Suite: 265
passing.

## Consumers

`plugin-p2p` in the kubun repo is the only external consumer; its migration is planned there
(`docs/agents/plans/next/2026-07-11-mls-permission-enforcement-migration.md` in that repo). Kubun
deletes its own anchor/ledger/fold/admin-roster modules and its `anchorImmutabilityPolicy`, which
the default policy subsumes.
