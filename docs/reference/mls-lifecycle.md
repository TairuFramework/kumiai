# Bound-leaf lifecycle

## Genesis and membership

A lifecycle group has `GroupAnchor.controller`, naming one `did:kokuin` controller H.
The creator passes a `ControllerBinding` to `createGroup`.
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

`mintLeafCapability` issues a direct H-signed capability or a child of one H-signed trusted grant.
`mintTrustedGrant` authorises a trusted agent T to issue children, without requiring T to hold a group leaf.
Both set `iat`. Leaf capabilities cannot exceed seven days, and trusted grants cannot exceed 365 days.
Group limits can be lower. A child cannot outlive its parent or name its signer as its audience.
Chains deeper than one are refused. The parent pins T's signing key through `cnf`.
Direct capabilities pin `iss = sub = H`, the agent audience, permission and leaf key.
Verification uses token reference times and embedded controller prefixes, without a clock or DID cache.
Authoring checks additionally require `iat <= now < exp`, including creation, key packages, external joins, invites and renewal.

Tree time is the maximum of the ledger time floor and H-signed times in the tree.
A direct leaf attests its capability's `iat`. A chained leaf attests its parent's `iat`, never T's child timestamp.
A leaf is lapsed when its `exp` is below tree time.
Wall-clock expiry alone does not stop an installed member sending.
H must sign something newer that reaches the group to advance lapse.
A `clock` entry preserves the pre-commit tree time whenever a removal or renewal would lower it.

`sendAdmission()` is a synchronous epoch-paired verdict. Lapsed senders cannot encrypt or send ordinary member commits.
Receivers reject a lapsed sender before opening its application message, preserving the ratchet generation.
An empty renewal commit can renew the sender out of lapse.
`renewLeaf` preserves the agent DID, long form, signature key and controller, and never lowers capability `iat`.
Every agent renews in every group at least once per `leafLifetime`.
H renews T's trusted grant at least once per `trustedGrantLifetime`.

## Device operations and commits

Lifecycle `kumiai.device` entries allow proven `revoke`, `reset`, `clock` and advisory `beacon`.
They reject `register`, `add`, `label` and capability-authorised revocation.
Other groups retain device management with registry/tree controller agreement and issuer/subject pins.
Denied DIDs cannot enter as bound or floating leaves, or issue leaf capabilities.

The ledger is the only revocation authority.
A proven revoke verifies authority-signed controller events against the group's recorded log.
The first proof carries a chain. Later proofs carry a suffix after its recorded head, possibly empty.
A reset carries a chain re-parented on inception and raises the generation floor.
Revoking T cascades to its current child leaves. Effects and exact Removes are authenticated in the entry.
A revoked record is permanent, including for a subject without a leaf.
An un-revoke in H's log cannot remove it. A replacement agent needs a new DID.

Mandatory gates run before caller policy: asynchronous entry/proof preparation, synchronous proposal checks, then survivor path checks before adoption.
Caller policy cannot override a failed lifecycle gate.
A proof commit contains one revoke or reset, its exact Removes, a head move and an optional clock entry.
It cannot add or renew a leaf. Member removals keep the committer's credential unchanged.
A lapsed target may be removed by any member. A target's self-removal proposal may be committed by another member.
Other discretionary removals, PSKs and ReInit are refused.
An external rejoin replaces exactly one existing leaf with the same agent and key, using a bound replacement.

`renewLeaf`, `removeLapsedLeaves`, `commitInvite` and `revokeWithProof` return speculative handles.
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
History counts signed-event JSON bytes across every leaf prefix and every ledger proof, including repeated copies.
A commit passes when `post <= horizon` or `post <= pre`, so shrinking remains possible above the horizon.
Welcome/external revalidation has no absolute horizon check. Only that comparative commit gate authorises history growth.
A reset shortens renewed prefixes to `[icp, reset, ...]`, but never compacts earlier ledger proofs.
A group whose ledger alone fills the horizon needs a new group.

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

Hub acceptance alone never authorises recovery adoption.
`PendingRecovery.epoch` names the target epoch, and `confirmationKey(position, commitDigest)` binds its speculative exporter key.
`onAccepted` is idempotent. Verdicts bind the group, request, publication position and commit digest.
A valid confirmation wins over superseded and refusal. Superseded wins over refusal after a bounded settle round.
Outside lifecycle groups, refusals and superseded require a source-tree signer. Confirmation uses the target-epoch tag.

Lifecycle attestations and verdicts count only from a bound leaf in the pending tree.
The known registry combines the last-known and reply ledgers, uniting revocations and taking maximum floors.
Neither the signer nor its chain issuer may be revoked, and its generation must meet the known floor.
Its leaf must remain live at `max(treeTime(pending), now - 300 seconds)`, with the known time floor.
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

`LeafBindingError.reason` includes issuer-mismatch, subject-mismatch, chain-depth, self-issued, child-outlives-parent, denied-issuer,
lifetime-cap, generation-floor, identity-change, controller-mismatch, floating-refused and history-horizon.
`LeafLapsedError` refuses sending or opening a lapsed leaf's traffic.
`RevokeProofError.reason` includes no-rev, wrong-controller, not-authority-signed, generation-floor, too-large,
detached, needs-reset, effects-mismatch and removes-mismatch. Helpers return these through `not-provable`.
`CommitRejectedError` carries binding, lapse, floor, policy or invalid refusal reasons.
`InviteRecipientMismatchError` refuses a key package or Welcome for another recipient.
