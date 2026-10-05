---
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
"@kumiai/rpc": patch
"@kumiai/rpc-conformance": patch
"@kumiai/hub-protocol": patch
"@kumiai/hub-server": patch
"@kumiai/hub-client": patch
"@kumiai/hub-tunnel": patch
"@kumiai/hub-conformance": patch
---

Bound-leaf lifecycle and durable epoch-change log delivery.

These patches break API and wire contracts. Kubun is the only consumer. The anchor version and `HANDSHAKE_VERSION` both stay at 1.

Release order:
- Release the kokuin capability child-expiry patch first.
- Deploy hubs before or with peers.
- Every lifecycle peer must run this release.

**Lifecycle (`@kumiai/mls`)**

- Groups can carry a controller. Its agents hold bound leaves that are verified against tree time, not a wall clock.
  - Genesis adds `controller`, `leafLifetime` and `trustedGrantLifetime`.
  - Creation, key packages and external joins accept a `ControllerBinding`.
  - `Invite.recipientDID` binds an invite to its recipient.
- New lifecycle operations: `renewLeaf`, `removeLapsedLeaves`, `revokeWithProof` and `revocationOf`.
  - Helpers return speculative handles.
  - `confirmAdopted()` emits their control events once.
  - Ledger revocations are permanent.
- `HISTORY_HORIZON` is 393,216 bytes. A commit passes only when its size after the commit is within the horizon or no larger than before it.
- `assertFrameFits` and `FrameTooLargeError` bound every final frame.
- New typed errors: `LeafBindingError`, `LeafLapsedError`, `RevokeProofError` and `InviteRecipientMismatchError`.
- `foldEnvelope` takes a single `FoldEnvelopeParams` object.

**Recovery (`@kumiai/mls-rpc`, `@kumiai/rpc`)**

- A recovery is adopted only after counted confirmation through signed verdicts. This adds new rendezvous kinds.
- Binding renewal uses `recoveryBinding` and `prepareRecovery`.
- `applyRecovery` can return `{ renewalRequired: true }`.
- `PendingRecovery` adds `epoch`, `confirmationKey`, `judgeVerdict` and `markBindingUnusable()`.

**Durable log delivery (`@kumiai/rpc`)**

- `GroupPeerMLSParams` requires an `AppOutbox` and `appOutboxLimit`.
- Log dispatch resolves at durable acceptance. Delivery is at least once and in per-sender order, across epoch changes and restarts.
- Hosts persist a commit cursor `{ position, epoch, stranded? }` through `getCommitCursor()` and `putCommitCursor()`.
- `AnchorStore` holds `{ anchor, pending }`, a one-advance rotation record that is repaired at startup.
- `HandleAccess.admission()` publishes a lock-free send snapshot.
- `GroupPeer.commit` adds `holdLogSends`.
- `publishRevokeProof` takes one `{ peer, mls, input, options }` object, with a host `serializeJournal` in `options`.
- One live peer per group owns the outbox, the journal and the anchor store. To hand over, call `dispose()`, await `drained()`, then start the replacement.

**Hub**

- Every fetch result requires `gap: boolean`.
- Log purge removes only a prefix of each topic, by position.
- `AppWindowPruned.oldest` may be `null`.
- New `retention-gap` strand kind.

Full contracts: `docs/reference/` (mls-lifecycle, app-lane, lanes-and-retention, group-protocols).
