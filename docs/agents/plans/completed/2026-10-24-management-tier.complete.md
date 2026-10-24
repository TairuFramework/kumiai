# kokuin management tier (band 0.12) — complete

**Date:** 2026-10-24
**Status:** complete
**Packages:** all fourteen (band 0.12, breaking). Most of the behaviour is in `@kumiai/mls`.
`@kumiai/mls-rpc` (recovery and adoption), `@kumiai/rpc-conformance` (doubles) and the integration
tests follow it.
**Origin:** kokuin controller 0.2 added management members, and band 0.11 adopted the controller
without them. The tier was designed stack-wide (kokuin, kumiai, kubun, sakui) in one spec co-owned
with the kubun stack-adoption session.

## Goal

A `did:kokuin:` controller's devices run lifecycle groups while the root seed stays cold, on a
hardware wallet or a mnemonic. Management members (`mbr`) authorise leaves, holder grants, registry
entries and removals on the controller's behalf. They never go beyond root's authority.

## User decisions

- **Custody.** The root comes out only for setup, member adds, settling or fixing the log, and reset
  recovery. A stolen member keeps log authority until it is removed. This is accepted, because root
  can fix the log.
- **Lost managing device.** Another member `rmv`s its incarnation. Root denies the DID at the next
  settle. A member never `rev`s a member (kokuin `MEMBER_REVOKES_MEMBER`).
- **Device binding.** A device's `did:peer:4` (long form) is its member pin. A managing device binds
  its own leaf by membership (`controller.member: { add, g }` plus `iat`, with no capability).
- **Scope.** Member-rooted credentials are allowed only in lifecycle groups. Standard groups keep
  root-only `manage`.
- **Offline device.** A phone offline for about 30 days keeps participating with grants up to its
  lease.
- **Settle cadence.** A size-triggered prompt at 24 epoch events, and a hard cap at 32. Past the cap,
  new member-issued leaves fail closed (`epoch-cap`) until root settles.
- **Root still counts for time.** Root-issued tokens still attest `iat`, so groups where the seed sits
  on a desktop keep lapsing.
- **Authority is current, with no ancestor exception.** An event that a removed or non-effective
  member authored is refused, whatever its descendants are.
- **Recovery keeps known effects.** Recovery never adopts a registry that drops known removals,
  denials, epoch events or attestations, unless root supersedes them.

## Key design decisions

- **The registry holds the epoch, not the leaves.** Per-leaf epoch closures overflowed
  `HISTORY_HORIZON` at 50 leaves (probe P2). The controller's current epoch therefore lives once per
  group: `recordedLog: ControllerLog`, stored only as kokuin's `authoritativeLog(...).log`.
- **Signed `kumiai.device` entries carry it:**
  - `seed`: ledger position 0, installs everything atomically;
  - `log`: effect-free, used for leases, new members and settlements;
  - `revoke` and `reset`: carry exact `EffectClaim`s, each with a `ProofRef` of
    `{ chainIndex } | { snapshot } | { event, epoch? }`;
  - `clock`: preservation, or `attest: true` from an effective member.
- **One derivation from end to end.** `claimsFor`, `effectOf`, `cascadeOf` and
  `effectiveAuthorityOf` are shared by the producer, the receiver gate and the pure registry fold.
  Every acceptance judges a leaf's member root (DID, add digest, generation) against a named registry.
  That registry is the candidate registry of the commit being judged, or `registryAt(head)` for a
  delayed frame. It is never the delivered bytes.
- **Judging context.**
  - Shape: `{ registry, stage: structural|full, mode: admit|retain|rejudge }`.
  - The epoch cap applies only on `admit`.
  - `retain` keeps an unavailable root.
  - `rejudge` (Welcome, rejoin) needs full authority.
  - A removed primary root falls back to an effective substitute: the holder-grant root, or a survivor
    grant.
  - A leaf whose required holder grant loses member authority is cascaded with that member.
- **Removal tombstones are not denials.** `removedMembers` is keyed by add digest. A cascaded device
  may return under another member's grant, or as a new incarnation. Events newly authored by a
  tombstoned incarnation are refused on publication, on proof acceptance and on replay.
- **Tree time.** Tree time is `max(timeFloor, root iat, member quorum)`. The member quorum is the
  second-highest attestation across distinct effective member keys, or the highest when there is
  only one. A single eligibility predicate serves the producer, acceptance and `attestedTreeTime`.
  Preservation clocks are computed centrally in `commitWithEntries` over the proposed tree.
- **Removal evidence.** After a settle, neither `pruneLog` nor `authoritativeLog` keeps the `rmv`.
  The host therefore captures `removalEvidence(controller, log, rmv)` before settling, and passes it to
  `revokeWithProof`. This duty is recorded in kubun's spec.
- **Recovery.** `assertRetainsKnownEffects(controller, known, candidate)` throws
  `RecoveryKnowledgeError`. Adoption re-checks it under the replacement lock. The mls-rpc port
  `HandleAccess.replace(next, guard)` requires a guard. `guardedReplace` throws when an
  implementation never ran it. A forked candidate is refused unless its head equals the resolved
  winner.
- **Cost bounds.** Effect-claim count and targets are checked before any per-claim fold, which uses
  one shared proof context. Delta-log replay carries authenticated folds forward, and log entries that
  add nothing are refused. Lifecycle entries are verified in envelope order.

## Verification

- Repo-wide forced `turbo run test:types test:unit` passed: 57 of 57 tasks, 0 cached.
- Integration passed: 150 of 150. Biome and the version check are clean.
- Probes P1–P4 checked the plan's premises before implementation.
- Every task had its own review. A blind Codex review and an Opus final review covered the whole
  branch. Their findings were fixed in one wave, mutation-checked, and re-reviewed.

## Follow-ons

- `../next/2026-10-24-management-tier-followups.md`: the 0.12 release, kubun unblock, and adopting
  kokuin #23 (a controller 0.2.x patch if proven compatible).
- `../backlog/2026-10-24-management-tier-residuals.md`: parked minors.
