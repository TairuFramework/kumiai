# Bound-leaf lifecycle and durable epoch-change log delivery — complete

**Date:** 2026-10-05
**Status:** complete
**Packages:** `@kumiai/mls`, `@kumiai/mls-rpc`, `@kumiai/rpc`, `@kumiai/rpc-conformance`,
`@kumiai/hub-protocol`, `@kumiai/hub-server`, `@kumiai/hub-client`, `@kumiai/hub-tunnel`,
`@kumiai/hub-conformance` (all patch bumps). The contracts are breaking for the single consumer, Kubun,
which adopts them in one coordinated bump. The anchor version and `HANDSHAKE_VERSION` both stay 1.
**Origin:** Two linked needs. (1) A user's agents join groups under a controller identity and must be
revocable and expirable without every member agreeing on a wall clock. (2) An epoch change must not lose
log-class app events: before this work a send racing a commit could be sealed at an epoch the group had
left, a restart lost the in-memory send, and a hub that trimmed commit bodies let a peer certify a walk it
had not actually covered. The two ship together because lifecycle recovery needs the confirm-before-adopt
rule and the outbox that carries entries across it.

## Goal

A group can carry a controller whose agents hold short-lived bound leaves, with revocation that is
permanent in the group and verifiable by every member from the group ledger alone. Log sends are accepted
durably and delivered at least once, in per-sender order, across epoch changes, restarts, strands and
recovery. Behaviour for standard (controller-less) groups is unchanged except where noted.

Reference docs (persistent contracts): `docs/reference/mls-lifecycle.md`, `docs/reference/app-lane.md`,
`docs/reference/lanes-and-retention.md`, `docs/reference/group-protocols.md`, `docs/reference/sealing.md`,
`docs/reference/reserved-namespaces.md`.

## Key design decisions

**Bound-leaf lifecycle**

- **Clock-free verification.** A leaf credential pins issuer and subject and is judged against tree time,
  a monotonic value only the controller can advance, never against a member's wall clock. Every honest
  member applying the same hub-ordered log therefore reaches the same verdict, which is what lets one
  member's acceptance stand for the group. A stolen trusted agent can mint children with far-future times
  but cannot move tree time, so it cannot get an honest leaf lapse-removed. Wall-clock expiry is used only
  at the edges (a rejoiner judging a confirmer, with a 300 second allowance).
- **The group ledger is the only revocation authority.** The controller's key log is read only to verify a
  proof. A revocation the ledger records is permanent in that group, even if the controller later
  un-revokes; a replacement agent needs a new identity. A key reset acts through a generation floor that
  invalidates earlier grants. Rationale: a revocation that a later key-log event could undo would make
  membership depend on external state members cannot all see.
- **Short leaf lifetime is the revocation bound for rejoin.** A rejoiner only knows its own ledger, so a
  member revoked after that ledger can still confirm a stale rejoin until its leaf expires (plus allowance).
  Defaults 24 h leaf, 30 days trusted grant; ceilings 7 and 365 days; fixed at genesis in the anchor and
  immutable. The cost of the bound is a renewal commit per agent per group per lifetime.
- **One delegation link.** A trusted grant may delegate once; children cannot outlive parents (enforced in
  kokuin, hence the release-order requirement).
- **Fixed, comparative history horizon.** The controller's log carried by a group is bounded at 393,216
  bytes. A commit passes only when its post-size is within the horizon or no larger than its pre-size, so a
  shrinking commit (a reset, a removal) always passes. Welcome and external-join revalidation applies no
  absolute check, because a joiner cannot know the pre-size and members already accepted the commit.
  Ledger proofs never shrink; a group that fills its ledger needs a new group. The horizon is a constant,
  not per-group, after a probe showed no empirical need for a tunable ceiling.
- **Frame bound instead of entry bound.** Consumer ledger entries are limited only by what fits a final
  frame (`assertFrameFits`, checked before journalling or publishing). Hosts publishing a Welcome through a
  hub preflight its bytes inside `build()`; kumiai adds no port for this because the host owns the Welcome
  transport and a port would be bypassable.
- **Proven revocation.** `revokeWithProof` derives a suffix proof against the recorded log; the committed
  proof is verified identically by live members, the author's derived handle, restored handles and Welcome
  joiners. `publishRevokeProof` runs a rebuilding lane commit under a log-send hold so no log frame is
  sealed across the removal; the host supplies `serializeJournal(derived)` because only it owns the
  journal blob that must hold MLS state and derived ledger entries together.
- **Removed receivers.** ts-mls returns before validating the path for a removed receiver, so a receiver
  can treat itself as removed by a commit survivors reject. Removal verdicts are computed before the path
  so it agrees on whether the removal was authorised; the only effect is an early leave.

**Recovery**

- **Confirm before adopt.** Hub acceptance of a rejoin never authorises adoption. A rejoiner adopts only on
  a counted confirmation from a signer that passes the gate (a bound leaf in the pending tree, neither it
  nor its issuer revoked, generation at the floor, leaf live at the later of tree time and now minus 300 s).
  Confirmation carries the target epoch and an HMAC tag from the speculative exporter key. Honest members
  apply the same deterministic rules, so one member having applied the commit shows all honest members do.
- **Typed refusals.** Binding, lapse and floor refusals mark the binding unusable and end as
  renewal-required (a new binding or a ratchet can fix it); policy and invalid refusals wait for host
  `recover()`. No timer retries a held binding. Unconfirmed attempts keep their entries and retry on backoff.
- **Whole ledger in lifecycle GroupInfo replies,** covered by the attestation digest, so a rejoiner can
  judge signers against revocations and floors it did not previously know. A handle with an incomplete
  ledger processes no commits and re-requests the ledger on a 1 to 60 second backoff.

**Durable log delivery**

- **Durable `AppOutbox`, resolve at durable acceptance.** A log dispatch resolves once the host has
  durably accepted the entry, not when a hub frame lands. The worker seals at the current epoch, persists a
  prepared state, publishes, then probes the commit head. A safe probe or a covered complete walk after
  acknowledgement certifies the publication at that epoch; a commit beyond it re-seals. A later entry never
  gets a publication at an epoch before every earlier unresolved entry has one there, which keeps
  per-sender order. Restart republishes everything left, costing at most one duplicate, which at-least-once
  already allows. `lastAttempt` is prepared state, never evidence of publication.
- **Commit cursor `{ position, epoch, stranded? }`** persisted by the host beside the outbox. Without it a
  restart forced a heal. The cursor seeds only on an epoch match, is written only after durable MLS state,
  and carries the strand, so a restart at the same epoch heals instead of continuing on a losing fork; a
  rejoin that lands on the stranded epoch number clears it.
- **One-advance anchor rotation record.** `AnchorStore` holds one `{ anchor, pending }` slot; each record
  spans exactly one epoch advance (before, target, roster before, forced, advance digest) and resolves
  before another begins. A crash between advance and anchor capture is repaired at startup. When the
  target epoch's secret is gone the right topic cannot be derived, so the peer forces confirmed recovery
  rather than inventing a topic from the current epoch.
- **Lock-free admission snapshot.** `HandleAccess.admission()` publishes the epoch-paired send snapshot
  without taking the handle lock, so a dispatch awaited inside an adoption callback cannot deadlock.
- **Hub fetch `gap` and prefix-only purge.** Every fetch reports `gap: true` when log frames after the
  cursor were removed, computed from a per-topic monotonic removal watermark read in the same snapshot as
  head and page. Without it a trimmed commit body is indistinguishable from an empty walk and a peer could
  certify delivery it never verified. For the watermark to mean anything, log removal must be prefix-only
  per topic by log position, never by timestamp, so a backward clock cannot punch a hole. A missing gap
  field fails the fetch; it never certifies. A gap strands with a `retention-gap` kind, and the app lane
  reports `AppWindowPruned` (with `oldest` nullable) for every cursor-bearing fetch.
- **One live designated-hub peer per group** owns the outbox, journal and anchor store. A second live peer
  would interleave sends and rotation records. Handover is `dispose()`, then await `drained()`, then start
  the replacement; draining accounts for abandoned host promises and returned callbacks.
- **Ephemeral delivery** requires an acknowledged receiver subscription, a registered listener within the
  acknowledgement TTL and the receiver still holding the frame epoch; other ephemeral traffic stays best
  effort.

## What was built

- Lifecycle genesis fields, bound credentials, controller-bound creation, key packages, external joins and
  recipient-bound invites; `kumiai.device` proven revoke suffixes; `renewLeaf`, `removeLapsedLeaves`,
  `revokeWithProof`, `revocationOf`, speculative helper handles with `confirmAdopted()`.
- History horizon, `assertFrameFits`, `FrameTooLargeError`, new typed errors and reason unions.
- Recovery orchestration: `recoveryBinding`, `prepareRecovery`, widened `applyRecovery`, `PendingRecovery`
  additions, recovery confirm and verdict rendezvous kinds, signer gate, `markBindingUnusable()`.
- `AppOutbox`, commit-cursor ports, outbox worker, `AppOutboxFullError`, `AppEntryTooLargeError`,
  `PeerRemovedError`, `SendNotAdmissibleError`, `onAppOutboxCleared`, `holdLogSends` and persisted
  `holdsLogSends`, `publishRevokeProof`.
- Anchor rotation slot and startup repair, ledger-retry timer, host-callback accounting and `drained()`.
- Hub store, server, client, tunnel and wire `gap`; per-topic removal watermark; prefix-only purge; new
  conformance clauses (including backward clock and snapshot) run against real implementations and doubles.
- A kokuin patch (capability child-expiry attenuation) released first and adopted through the catalog.
- Review: independent whole-branch reviews found a recovery adopting an empty ledger, restart-forced heals
  and several strand and anchor-capture races; all fixed test-first and re-reviewed to approval.

## Accepted residuals

- A member revoked after the rejoiner's known ledger can confirm a stale rejoin until its leaf expires plus
  300 s; for a revoked trusted agent, until its grant expires plus 300 s. Groups without a controller keep
  the unbounded old-secret version, as on main.
- Divergent caller policies and a hub that forks its readers defeat the shared delivery guarantee.
- A removed receiver can accept a removal whose path survivors reject (early leave); closing it needs ts-mls.
- Full proof ledger or oversized consumer entries stop new joins and recovery for that group.
- The unusable-binding set is in memory, so a restart permits one extra refused attempt.
- Notices deduplicate in memory and can repeat after restart; persisted notices can be lost on crash, so
  hosts read their stores at startup.
- Each outbox entry costs one commit-head probe (performance only); sustained commit pressure can delay
  delivery until a seal-to-probe interval has no intervening commit.

## Release order

1. Release the kokuin capability child-expiry attenuation patch (done, `@kokuin/capability` 0.3.1) and
   adopt it in the catalog.
2. Release kumiai. Hubs deploy before or alongside peers: peers require `gap` in every fetch result.
3. Ship rejoiners and responders together; older responders ignore the new rendezvous kinds and cannot
   confirm new rejoiners. Every lifecycle peer must run the same release.
4. Kubun adopts everything in one coordinated bump (hub store migration, outbox and cursor persistence,
   `recoveryBinding`, designated-hub peer ownership, `serializeJournal`); tracked in Kubun's handoff.

## Follow-on

Low-priority residuals: `../backlog/2026-10-05-bound-leaf-and-log-delivery-residuals.md`.
