# DID registry entries on the control ledger

Design owner: kokuin, `docs/agents/plans/milestones/2026-08-07-profile-did-key-events.md`. That
document is the source of truth; this item covers only what kumiai would build.

## Context

The stack wants one stable DID per user profile whose key set rotates, verifiable across groups and
outside every group. The registry needs ordering, inclusion proofs, and recovery for late joiners.
The control ledger already provides all three:

- Entries are signed kokuin tokens with content-addressed digests (`packages/mls/src/ledger.ts`).
- The running head is authenticated in GroupContext extension `0xf101`, and a welcome recomputes it
  over the inviter's entries, throwing `LedgerIncompleteError` on omission, reorder, or truncation
  (`packages/mls/src/head.ts`).
- Reducers plug into `foldLedger` with no edits to it, and authority is evaluated against
  state-so-far rather than final state (`packages/mls/src/fold.ts`) — which is exactly what makes
  rotation sound.
- A late joiner receives the full entry set at welcome, so recovery does not depend on hub retention.

The app lane is not an option: a fresh joiner cannot drain pre-join frames, by design.

## Work

**A nested entry shape.** The outer ledger entry is group-scoped and notarises ordering and
inclusion only; its `value` carries a group-independent, self-authorising key event signed by the
subject's own pre-committed key. Nesting dissolves the group-scoping blocker — entries are
group-scoped and a cross-group entry is rejected as a replay (`envelope-fold.ts:56`), but the same
inner bytes replay into every group unchanged, and the admin cannot forge the inner event (wrong
key) and cannot remove it *after inclusion* (the head would diverge).

**Member-publishable rotation entries** (decided in the kokuin design). Admin authorship does not
survive the censorship analysis: `foldEnvelope` requires every entry to be admin-authored in
state-so-far (`packages/mls/src/envelope-fold.ts:61`), and an admin can simply never include a
member's rotation — no head diverges over an entry that never existed, and a group where a thief
holds admin would never learn the revocation. So the invariant is relaxed for exactly one case: a
non-admin-authored entry is admitted iff its type is the rotation application namespace *and* the
inner event's subject DID matches the authoring member. Costs, borne knowingly:

- **This is a policy change with a flag day** — every peer must ship the relaxed fold before the
  first member-authored entry appears, or the commit fails closed. It needs a version gate: peers
  advertise support, and the entry type is only used once the group's policy floor includes it.
- **Member writes need bounding**: per-member rate and size limits on the rotation type, so the
  relaxed rule is not a spam channel into the replayed-at-welcome ledger.

**A `didRegistryReducer`.** Folds inner chains per subject: rejects `seq` gaps, verifies each event
against the previous event's pre-rotation digests, and flags same-`seq` forks as duplicity rather
than resolving them. Rotation is sequential per controller — a fork is something to surface, not a
conflict to merge. One exception to plain sequential folding: the kokuin design adopts KERI-style
*superseding recovery* — a `rotate` signed by the pre-committed next keys outranks operations
signed by current keys, so the fold must support rewinding current-key operations past the
divergence point rather than treating the recovery as a fork.

**An application-namespace entry type.** Not `kumiai.*`: an unknown reserved type fails the whole
commit closed, so adding one is a flag day. Do not plan on GroupContext extension `0xf102` either —
populating it is a policy change every peer must ship first (`packages/mls/src/policy.ts:99-118`
admits only zero-length data). The relaxed authorship rule above is the one policy flag day the
design accepts; keep it the only one.

## Constraints to weigh before starting

- **Entry size.** Every entry is a signed token. ML-DSA-65 signatures are ~3.3 KB, taking tokens
  from ~200 bytes to ~7 KB, and every entry is replayed at every welcome and covered by the head.
  The kokuin design keeps device onboarding on the capability path precisely so it produces no
  ledger entry; only authority rotation, post-quantum migration, and recovery do.
- **No compaction path** exists for the ledger today. A per-profile rotation history needs either a
  checkpoint story or a hard rotation-rate budget.
- **Cross-group duplicity remains unsolved.** Kumiai orders per group only. Nesting makes divergent
  chains detectable across groups (inner event ids are comparable) but does not prevent them.
  Verifiers should treat the highest inner `seq` seen for a DID anywhere — any group, any direct
  presentation — as a monotonic floor; that is both the staleness guard and the comparison that
  makes duplicity detectable.
- **Confidentiality.** Entries are sealed under `kumiai/ledger-entries/v1`, so the registry is not
  readable outside the group. External verification stays proof-carrying.

## Blocked on

The kokuin key-event module and the `iss`-resolution change in `@kokuin/token`. Nothing here can
start before the inner event format is fixed.
