# Bound-leaf lifecycle

## Genesis and membership

A lifecycle group has `GroupAnchor.controller`, naming one `did:kokuin` controller H.
The creator passes a `ControllerBinding` and authoritative `options.controllerLog` to `createGroup`.
A first-position `seed` entry installs the log, generation floor, denials and removed-member tombstones atomically.
Every leaf belongs to an agent and proves its binding to H.
Membership is a live leaf in the tree. A local controller-head check is advisory and never an MLS input.

The genesis anchor is immutable and keeps version 1.
`leafLifetime` defaults to 86,400 seconds and accepts `1..604,800`.
`trustedGrantLifetime` defaults to 2,592,000 seconds and accepts `1..31,536,000`.
Malformed lifecycle fields refuse the group, including on future-version anchors.
Every lifecycle peer must run the same release. Older peers ignore these fields and enforce incompatible credential rules.

Every member may admit agents and enact consumer ledger entries.
The roster seeds H as admin. Lifecycle groups reject `kumiai.role` entries.
Invites carry `recipientDID`, bind the key package to that recipient, and carry optional consumer `entries` without a role grant.
Consumer consent and its consumed-ID entry belong in the same Add commit.
A competing admission loses the epoch race and checks consumption again.

## Credentials and time

`ControllerBinding` carries `id`, a chain-only `prefix`, and one binding form:

- `capability`, with `holderGrant` for a chained leaf.
- `member: { add, g }` and self-attested `iat`, binding the leaf to its own pinned membership incarnation.

Capabilities may be H-signed or member-signed with `mbr: { add, g }`.
Member roots resolve through the registry-held `ControllerLog`, including the pinned signing key and lease.
Standard groups remain root-only. Member-rooted credentials require a lifecycle group.
Membership `iat` orders replacements but never attests tree time.
`memberRootStatus(...).status` is `root`, `effective`, `removed` or `unavailable`.
Admission refuses removed or unavailable authority. Retention keeps unchanged leaves when authority is unavailable.
Welcome and recovery require available authority and may use verified survivor authority.

`mintLeafCapability` issues a direct capability or a child of one trusted grant.
`mintTrustedGrant` authorises a trusted agent T to issue children, without requiring T to hold a group leaf.
Both set `iat`. Leaf capabilities cannot exceed seven days, and trusted grants cannot exceed 365 days.
Group limits can be lower. A child cannot outlive its parent or name its signer as its audience.
Chains deeper than one are refused. The parent pins T's signing key through `cnf`.
Root-issued direct capabilities pin `iss = sub = H`. Member-issued capabilities pin `iss` to the member DID and `sub` to H.
Both pin the agent audience, permission and leaf key.
Verification uses token reference times and embedded controller prefixes, without a clock or DID cache.
Authoring checks additionally require `iat <= now < exp`, including creation, key packages, external joins, invites and renewal.

Tree time is `max(timeFloor, rootTime, quorum)`.
Root-issued direct capabilities and chain parents attest their `iat` through `rootTime`.
Effective members attest through member-issued direct capabilities, chain parents and registry-held attest clocks.
The quorum uses distinct pinned keys: the second-highest attestation, or the highest when only one key is effective.
With no effective keys, the quorum contributes zero. Membership leaves attest nothing.
`attestTreeTime(group, time?)` publishes an effective member's own `clock` entry with `attest: true`.
A leaf is lapsed when its effective expiry is below tree time. Membership expiry comes from the recorded lease or survivor grant.
A leaf that enters or changes needs effective expiry strictly above `treeTime(H)` of the pre-commit epoch.
This entry check applies to an Add, an external commit's new leaf, an Update, and a committer's path leaf whose credential changed.
At expiry equal to `treeTime(H)`, an installed leaf is not lapsed, but the same leaf cannot enter or change.
Wall-clock expiry alone does not stop an installed member sending.
Root time or member attestations reaching the group advance lapse.
A preservation `clock` entry prevents time falling across changes to the proposed tree or candidate registry.

`sendAdmission()` is a synchronous epoch-paired verdict. Lapsed senders cannot encrypt or send ordinary member commits.
Receivers reject a lapsed sender before opening its application message, preserving the ratchet generation.
A renewal commit can renew the sender out of lapse and bundle `controllerLog`.
`renewLeaf` preserves the agent DID, long form, signature key and controller, and never lowers `bindingIssuedAt`.
One exception: a direct H capability may replace a leaf whose capability has a newer `iat` when the group registry records that leaf's issuer T as revoked.
T denied only in a later H log, not yet recorded by the group, does not qualify.
Every other check still applies: same agent and key, same controller, lifetime, lapse and monotonic tree time.
Capability-bound agents renew in every group at least once per `leafLifetime`. Membership-bound agents follow their recorded leases.
H renews T's trusted grant at least once per `trustedGrantLifetime`.

## Device operations and commits

Lifecycle `kumiai.device` entries allow `seed`, `log`, proven `revoke`, `reset`, `clock` and advisory `beacon`.
They reject `register`, `add`, `label` and capability-authorised revocation.
Other groups retain device management with registry/tree controller agreement and issuer/subject pins.
Terminally denied DIDs cannot enter as bound or floating leaves, or issue leaf capabilities.

The ledger is the only revocation authority.
Proof-bearing entries carry `proof: ControllerLog`, with `chain` and `events` arrays.
The registry stores only the authoritative merged log. Leaves keep chain-only prefixes.
A delta carries an empty chain, a suffix after the recorded head, or a full chain for genesis or reset.
`publishControllerLog(group, log)` publishes effect-free changes, including leases, added members and settlement.
A `log` entry cannot introduce denials, member removals or generation changes.
Newly applied events from authors already removed or ineffective in the recorded head are refused.

`revokeWithProof(group, { log, deny?, remove?, survivors?, evidence? })` publishes exact declared effects and Removes.
`remove` names `{ did, add }` incarnations. `{ reset: true, log }` raises the generation floor.
`EffectClaim` uses `kind: 'deny'` with `did`, or `kind: 'remove'` with `member: { did, add }`.
Each claim carries `ref: ProofRef`: `{ chainIndex }`, `{ event, epoch? }`, or reset-only `{ snapshot }`.
`DeviceRecord.proofRef` and `Revocation.proofRef` replace log positions.
Epoch `rev` events prove DID denial. Epoch `rmv` events prove incarnation removal.
An `rmv` cascades through that incarnation's membership leaf and rooted grants, without permanently denying their holder DIDs.
Grants other effective members issued to that DID remain valid. Root may deny the DID at its next settlement.
A removed holder can return through another effective root or a new incarnation.

`effectiveAuthorityOf` chooses the primary root, then valid holder evidence, then an accepted survivor grant.
`survivorTargets(group, add)` lists affected leaf holders and keys for substitute grants.
The `survivors` input carries those grants. Their expiry bounds surviving leaves, including membership leaves.
`memberRemoved` reports accepted incarnation removal.
`removalEvidence(controller, log, rmv)` captures an epoch closure before settlement for a never-snapshotted removal.
Hosts retain that evidence beside their controller store until every group has accepted the removal.
The ledger preserves historical evidence. The recorded log keeps only the authoritative projection.
A repeat proof for T reports `already-revoked` while only evidenced children of T remain.
An evidenced child keeps T as its issuer until it renews:

- On the commit path, including survivor checks and authentication of the committer's path leaf, it passes only with the credential and key already in the tree at that leaf.
- A Welcome or external joiner has no earlier tree, so it accepts any evidenced child in the tree it receives. A denied-issuer leaf without valid evidence is still refused.
- Entry checks keep refusing a denied T: no Add, update or external replacement may carry a new capability T issued.
  DID denials and their cascades are permanent, including for a subject without a leaf.
  An un-revoke in H's log cannot remove them. A replacement agent needs a new DID.
  Reset-only removal permits re-entry through Add and Welcome with valid binding evidence at or above the current generation floor.
  Direct H grants and chained capabilities with the holder's own H-signed grant follow the same rule.
  The live registry projects current tree bindings onto the full ordered ledger fold.
  Accepted re-entry restores an active registry binding while the leaf remains in the tree.
  If that leaf later leaves without a ledger revocation, its record returns to reset-revoked on every member and after reconstruction.
  Until accepted re-entry, the removed device confers no authority.

This projection cannot distinguish a legitimately re-admitted leaf that later lapsed from a leaf inserted after its post-reset capability expired.
A malicious member holding D's genuine post-reset key package can therefore present an expired D as active to a device that adopts that member's tree: a Welcome joiner, or an existing member that externally rejoins from the malicious member's GroupInfo.
That device is on a fork the existing members reject. Ordinary Add/commit paths still enforce admission expiry.
The ledger records no readmission operation, so a joining or rejoining device has no authenticated admission history to resolve this ambiguity.
A later subject revocation makes a reset-removed device terminally denied.

Mandatory gates run before caller policy: asynchronous entry/proof preparation, synchronous proposal checks, then survivor path checks before adoption.
Caller policy cannot override a failed lifecycle gate.
A proof commit contains one revoke or reset, its exact Removes, a head move and an optional clock entry.
It cannot add or renew a leaf. Member removals keep the committer's credential unchanged.
A lapsed target may be removed by any member. A target's self-removal proposal may be committed by another member.
Other discretionary removals, PSKs and ReInit are refused.
An external rejoin replaces exactly one existing leaf with the same agent and key, using a bound replacement.

`renewLeaf`, `removeLapsedLeaves`, `commitInvite`, `publishControllerLog`, `attestTreeTime` and `revokeWithProof` return speculative handles when they build commits.
They neither publish nor adopt, and lifecycle helpers absorb no pending proposals.
The host publishes and adopts on acceptance, or discards a losing result and rebuilds against the winner.
Adoption calls `confirmAdopted()` once. Repeated calls emit nothing further.
A speculative handle owns its authentication state and emits no early control events.
Restore and Welcome project revocations and floors silently. Hosts read `revocationOf` afterwards.

`publishRevokeProof(peer, mls, input, { serializeJournal })` publishes one ordinary lane commit with `holdLogSends: true`.
The required host `serializeJournal(derived)` blob must restore MLS state AND the derived ledger entries through `adoptJournalled`.
It rebuilds after a lost epoch race and returns `committed`, `already-revoked`, `self-affected` or `not-provable`.
Another member publishes a self-affected proof. A thrown lane failure requires a host retry on reconnect.
For `detached`, obtain a log through the recorded head. For `needs-reset`, publish the reset first.
For `too-large`, use shorter reset prefixes or create a new group when ledger proofs alone fill the horizon.
The send hold and durable handover contract are in [the app lane](./app-lane.md).

## History and frames

`HISTORY_HORIZON = 393,216` bytes is fixed, with no per-group override.
History counts signed-event JSON bytes across every leaf prefix and every ledger proof, including repeated chain and epoch-event copies.
A commit passes when `post <= horizon` or `post <= pre`, so shrinking remains possible above the horizon.
Welcome/external revalidation has no absolute horizon check. Only that comparative commit gate authorises history growth.
A reset shortens renewed prefixes to `[icp, reset, ...]`, but never compacts earlier ledger proofs.
A group whose ledger alone fills the horizon needs a new group.

Member-rooted admission permits at most 32 distinct applied current-epoch events (`MAX_EPOCH_EVENTS_FOR_LEAVES`).
`settleAdvisory(log)` and `group.settleAdvisory()` return `ok`, `prompt` from 24 events, or `blocked` above 32.
The cap excludes unchanged leaves, Welcome trees, root-issued admissions and lifecycle entries.
Settlement clears the current epoch count.

Consumer entries have only the whole-frame bound, not the history horizon.
Every RPC-owned frame passes `assertFrameFits` before journalling or publishing.
For n bytes, `4 * ceil(n / 3) <= 1,048,576` must hold.
An oversized frame throws `FrameTooLargeError` without a journal or publish.
A host publishing a Welcome through a hub checks its final framed bytes inside `build()`, before returning `PendingCommit`.
Large consumer ledgers can therefore block invites, Welcomes and GroupInfo replies, ending recovery as `no-responder`.

## Recovery and trust residuals

`prepareRecovery()` returns `ready` or `renewal-required` before requesting GroupInfo.
The cached binding must pass wall-clock expiry, known tree time, generation floor, identity and horizon checks.
`recoveryBinding({ groupID, controllerID, current })` supplies a fresh binding at most once per attempt, or returns `null`.
It must return promptly without waiting for user interaction.
`applyRecovery` returns `PendingRecovery | { renewalRequired: true } | null`.
Lifecycle GroupInfo replies include a ledger covered by the attestation digest and checked against the authenticated head.
A handle with an incomplete ledger processes no commits. It re-requests the ledger at every lane operation and on its own 1 to 60 second backoff.

Hub acceptance alone never authorises recovery adoption.
`PendingRecovery.epoch` names the target epoch, and `confirmationKey(position, commitDigest)` binds its speculative exporter key.
`onAccepted` is idempotent. Verdicts bind the group, request, publication position and commit digest.
A valid confirmation wins over superseded and refusal. Superseded wins over refusal after a bounded settle round.
Outside lifecycle groups, refusals and superseded require a source-tree signer. Confirmation uses the target-epoch tag.

A verdict signed by the rejoiner never counts.
Lifecycle attestations and verdicts count only from a bound leaf in the pending tree.
The reply's authenticated ledger supplies the candidate registry for judgement and adoption.
`assertRetainsKnownEffects(controller, known, candidate)` refuses dropped denials, removed incarnations, current-epoch events, floors or effective-key attestations.
Root settlement supersedes only its ended epoch events. A newer reset may supersede older incarnations and events.
Neither supersedes MLS time floors or effective-key attestations.
Signer and survivor authority use the candidate registry, including after adoption and restore.
The signer must remain live at `max(treeTime(pending), now - 300 seconds)` and meet the candidate generation floor.
A failed signer gate makes the verdict advisory.

Binding, lapse and floor refusals call `PendingRecovery.markBindingUnusable()` and end as `renewal-required`.
The adapter keeps an in-memory, identity-keyed 16-entry set. Ratchets do not clear it.
A restart clears the set, costing one extra refused attempt.
Policy and invalid refusals end as `refused`, including `refusal` and `responder`, until the host calls `recover()`.
Renewal-required waits for a fresh grant and host `recover()`, or a ratchet. Automatic triggers request no further GroupInfo while held.
Unconfirmed attempts retain queued entries and retry on backoff, reporting advisory verdicts.
A later rejoin removes any orphan leaf left by a lost confirmation.

Revocation is eventually consistent: the agent can read until its proof lands.
A stolen T can issue children until its grant expires or the group records its revocation.
A rejoiner with a known revocation rejects that signer.
With an older known ledger, an unknown-revoked signer can confirm until its leaf expires plus 300 seconds on the rejoiner's clock.
A revoked T can extend that residual through children until its trusted grant expires plus 300 seconds.
Groups without a controller retain an unbounded old-secret confirmation residual.
Divergent caller policies and a hub that forks readers cannot support the shared delivery guarantee.

A removed receiver cannot validate the commit path with the current MLS implementation.
It can accept an authorised removal whose path survivors reject, causing an early leave.
Closing this residual requires an upstream MLS change.

## Errors

`LeafBindingError.reason` includes issuer-mismatch, subject-mismatch, audience-mismatch, permission-denied, signature-invalid, confirmation-invalid, chain-depth, self-issued, child-outlives-parent, denied-issuer,
lifetime-cap, generation-floor, identity-change, controller-mismatch, floating-refused, history-horizon, member-removed, member-unavailable and epoch-cap.
`LeafLapsedError` refuses sending or opening a lapsed leaf's traffic.
`RevokeProofError.reason` includes no-rev, wrong-controller, not-authority-signed, generation-floor, too-large,
detached, needs-reset, effects-mismatch and removes-mismatch. Helpers return these through `not-provable`.
`no-rev` means the supplied log and retained evidence cannot prove the requested effect. Reset denials use the reset form.

`@kumiai/mls-rpc` and `@kumiai/mls-hub` inherit the `@kumiai/mls` behaviour change.

`CommitRejectedError` carries binding, lapse, floor, policy or invalid refusal reasons.
`InviteRecipientMismatchError` refuses a key package or Welcome for another recipient.
