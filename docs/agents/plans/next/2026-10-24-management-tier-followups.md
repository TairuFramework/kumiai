# Management tier follow-ups

**Priority:** next.
**Context:** `../completed/2026-10-24-management-tier.complete.md`.

## 1. Release band 0.12

- The intent `.changeset/management-tier-0-12.md` raises all fourteen packages one minor. The user runs
  the release.
- After publishing, tell the kubun stack-adoption session. 0.12 unblocks its controller-owned
  credential-record carriage, where a co-member resolves a delegate's authority from the owner's log
  through `resolveMember`.
- Kubun host duties to restate at integration:
  - Capture `removalEvidence(controller, log, rmv)` before a settle, and keep it beside the kokuin
    store until the removal has landed in every group.
  - A custom `HandleAccess` must run `replace`'s guard under the replacement lock, before persisting.
  - Adopt authored commits through `guardedReplace`.

## 2. Adopt `@kokuin/controller` 0.3

- kokuin #23 is a wire break. It folds in the #22 canonical-deny fix. Do it after 0.12 ships; 0.12 does
  not wait on it.
- Kubun's adoption notes (kokuin worktree `vault-records`, stack-adoption-2 upstream) cover:
  - `resolveMemberHistoric` with `removed: true`;
  - the removed-member tombstone in the snapshot field `u`, shaped `{ did, key, add, lease }`, with
    `gen` taken from its chain state;
  - `resolveDenySet`, which now returns raw and canonical entries;
  - `deviceRevokeIndices`, which is unchanged.
- kumiai's `removedMembers` judges by incarnation (`add`), not by removal time. A settled tombstone
  maps to its first carrying chain state with
  `foldLog(did, log).states.findIndex((s) => s.members.get(add)?.removed === true)`. Snapshot
  granularity is enough, because after a settle kumiai already downgrades `{ event }` refs to
  `{ chainIndex }`.
- Re-check canonical DID handling on both sides wherever kumiai reads kokuin's deny or member state.
- In 0.3, chain states may hold removed incarnations: either as tombstones in `members`, or in a
  separate `removed` map, which kumiai asked kokuin for. If they land in `members`, rewrite two
  snapshot-drop predicates to `!has(add) || get(add).removed`:
  - `proofsFor` drops in `packages/mls/src/member-root.ts`;
  - `memberDropIndices` in `packages/mls/src/controller-log.ts`.
  Then re-audit the code that iterates chain-state members (`member-root.ts` claim and cascade
  checks, `controller-ingest.ts` effect delta).
- Tighten attest-clock attribution in `registryApply` (`packages/mls/src/registry.ts`) to effective
  members of the previous projection. Today it matches any incarnation by DID. The admission gate
  already refuses removed attestors.

## 3. Catch up the Spec P phase 2 worktree

The milestone worktree (`kumiai.worktrees/spec-p-phase-2`) must rebase or merge over 0.12 before it
continues.
