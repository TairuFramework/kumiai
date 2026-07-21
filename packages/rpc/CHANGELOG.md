# @kumiai/rpc

## 0.4.1

### Patch Changes

- `LostCommit` now carries the lost entry's `journal` — the host's own blob, the same one
  `adoptJournalled` receives when a commit lands.

  Both obligations a lost commit creates are about a specific operation the host started: re-issue
  the right tokens, or tell the user which action did not happen. The peer held nothing that named
  it — the `build()` closure died with its process, and a `ledger` commit's tokens are the work, not
  the request — so a host could learn only that _something_ was lost. For a `remove` that is the
  security-relevant case, and it was exactly the one with no tokens to identify it by.

  Hosts consuming `lost` see one new field; nothing constructs `LostCommit` outside the peer.

## 0.4.0

### Minor Changes

- App messages now reach a member that was offline when they were sent. A procedure declaring
  `retain: 'log'` publishes to a retained, pullable log; ephemeral events and all RPC stay on the
  live lane. `defineGroupProtocol` carries the declaration.

  - App topics derive from the epoch of the last roster change rather than the live epoch, so a
    topic holds constant while the group talks and rotates only on membership change. The anchor
    is persisted through the new `AnchorStore`, never re-derived.
  - On reconnect a peer drains each segment from its durable read position (`AppCursorStore`),
    interleaved with the commit walk. `onAppWindowPruned` reports a retention floor that passed
    the read position.
  - New `onReceiveEnded` reports a push lane that ended and will not restart. Unhandled, it — and
    `onSubscribeFailed` — report through `@sozai/log` at error rather than being swallowed.
  - Directed RPC now opens each inbox frame once, through a shared per-topic open path, instead
    of racing one per-message ratchet key between the acceptor and each directed client.

  `GroupCrypto` gains `sealEntries`/`openEntries`, and `GroupMLS.readCommitHeader` also reports
  `external`. A host supplying the `mls` port must now also supply `AnchorStore`, `AppCursorStore`
  and `CommitJournal`; the type enforces it.

- `GroupCrypto.exportSecret(label, length?)` — `label` is no longer optional, and an
  implementation must derive different bytes for different labels. An optional label type-checked
  against every existing implementation while each ignored it, giving silent cross-domain key
  reuse.

- `GroupCrypto.unwrap` returns rpc's own `GroupUnwrapResult` (`{ payload, senderDID: string }`,
  exported from this package) rather than broadcast's `UnwrapResult` — `senderDID` is required,
  and an implementation with no sender to give must throw.

- Version bytes on the commit lane, and an unknown version now HEALS instead of filing as poison.

  - `decodeHandshakeFrame` returns `version` and no longer throws on an unknown one; every caller
    must compare it against `HANDSHAKE_VERSION` before trusting `payload`. It still throws on a
    short frame, a bad magic and an unknown kind.
  - `classifyCommit` accepts `UNKNOWN_FRAME_VERSION` in the header's place and files it `ahead`;
    its parameter type widened to `CommitFrameEvidence`.
  - `encodeCommitFrame` is now `[ VERSION(1) | commitLength(4, LE) | commit | sealed blob ]` and
    `encodeLedgerEntries` is `[ VERSION(1) | count(2, LE) | … ]`. `decodeCommitFrame` throws
    `UnsupportedCommitFrameVersionError`, and `isUnsupportedCommitFrameVersion` is the boundary
    predicate the lane branches on.
  - Scoped to the commit topic: an unreadable frame on the rendezvous lane is still dropped.

  Previously the version throw was caught before `classifyCommit` saw the frame, so after a bump a
  peer would step over the group's entire future and report itself reconciled at a dead epoch.

- Reserved namespaces now name kumiai: ledger entry types move from `group.*` to `kumiai.*`, and
  topic labels from `enkaku/*` to `kumiai/*`. `group.*` is freed for application entry types.

  **The type checker will not tell you.** `ROLE_ENTRY_TYPE`, `COMMIT_LABEL`, `INBOX_LABEL`,
  `RENDEZVOUS_LABEL` and `RECOVERY_REQUEST_TYPE` keep their names while their values move, so
  existing ledgers fold to a different head (recreate groups; no migration) and topics move
  (upgrade every peer together, or they partition silently). Code hardcoding `'group.role'`
  instead of importing the constant breaks with no diagnostic.

- `GatheredReply.from` is now `GatheredReply.senderDID` and carries the authenticated sender, not
  a self-asserted wire field. See `@kumiai/broadcast`.

**Deploy together, not gradually.** The commit-frame, ledger-entries and handshake-frame version
bytes, the broadcast wire version and the `hub/v1/*` rename are each wire changes: a peer, hub or
client on a pre-release build cannot talk to one on this release.

### Patch Changes

- Updated dependencies:
  - @kumiai/broadcast@0.4.0
  - @kumiai/hub-protocol@0.4.0
  - @kumiai/hub-tunnel@0.4.0

## 0.3.0

### Minor Changes

- BREAKING: the control-ledger lane. Commits publish to a compare-and-set commit log and converge
  by pull; a peer with positive evidence it is off the group's line heals by external-commit
  rejoin; entry bodies ride in the commit frame and a rejoined peer gathers the whole ordered
  ledger over a sealed rendezvous.

  - `GroupMLS` gains `readCommitHeader`, `createRecoveryRequest`, `sealGroupInfo`,
    `isLedgerComplete`, `getLedger`, `sealLedger`, `openSealedLedger` and `bootstrapLedger`;
    `applyRecovery` is retyped to `(sealed, requestID) => PendingRecovery | null`, and
    `exportGroupInfo` is removed from the port.
  - `GroupPeer` replaces `localCommitted` with `commit`/`replay`, and `recover()` returns
    `{ advanced, reenact }`. `GroupPeerParams.hub` is now a `LogHub`, and supplying `mls` also
    requires `journal` and `adoptJournalled`.
  - The handshake topic splits into `commitTopic` + `rendezvousTopic`; the recovery-request codecs
    are retyped; the in-memory `createMemoryGroupMLS` is removed (moved to test fixtures).

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.3.0
  - @kumiai/hub-tunnel@0.3.0
