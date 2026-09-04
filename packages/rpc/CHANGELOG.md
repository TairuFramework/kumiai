# @kumiai/rpc

## 0.9.0

### Minor Changes

- Add authenticated-data (AAD) binding to the group application-message cryptographic layer. The `GroupHandle.encrypt()` and `GroupHandle.decrypt()` methods now accept an optional AAD parameter, and the `@kumiai/rpc` `GroupCrypto` port's `wrap()` and `unwrap()` operations now accept AAD and `expectedAAD` respectively. Each application message and directed frame is now cryptographically bound to the topicID on which it is published; a frame sealed for one topic cannot be opened on another. The AAD comparison is performed before the message is decrypted, preventing a wrong-topic frame from consuming a ratchet generation.

  **Breaking change:** Pre-upgrade retained application history is invalidated on upgrade. The upgrade drain now enforces the topic AAD constraint and advances the durable cursor past legacy empty-AAD frames. There is no legacy-acceptance code path for frames without AAD.

  This change does not modify topic-ID derivation logic or the durable commit and recovery-topic infrastructure.

- Broadcast control frames now ride a dedicated `typ:'ctrl'` wire discriminator (`BROADCAST_VERSION` 2), freeing `data.kind` for application use. Previously, control replies/requests shared `typ:'event'` with app data and were distinguished only by an app-controlled `data.kind` field, so an application event whose own data happened to carry a colliding `kind` (e.g. `kind:'req'`) could be misclassified as protocol control traffic. Responder and client classifiers now key on `payload.typ`; `data.kind` is read only under `typ==='ctrl'` and is never inspected for app events.

  **Breaking:** frames encoded under `BROADCAST_VERSION` 1 are no longer decodable — `decodeFrame` refuses a stale wire version. The RPC app-lane drain's interim control-shape fallback (dropping replayed frames that merely looked like a control reply/request) is removed; drained frames are classified the same way live frames are, by `typ`, not by shape-sniffing `data`.

- Type `@kumiai/rpc`'s `ProtocolSurface` against the protocol's procedure map, closing its phantom type parameter. `dispatch`/`request`/`gather` are now keyed off the concrete protocol — `dispatch` accepts event procedure names with typed `data`, `request`/`gather` accept request procedure names with typed `param` and typed `result`, and `gather` returns `Array<GatheredReply<Result>>`.

  **Breaking:** the three methods now take a single enkaku-style config object instead of positional arguments — `dispatch(prc, { data })`, `request(prc, { param, ...options })`, `gather(prc, { param, ...options })`. Every call site must migrate. The `GroupPeer` and `GroupPeerParams` `Protocols` bound also tightens from `Record<string, ProtocolDefinition>` to `Record<string, GroupProtocolDefinition>`.

  `@kumiai/broadcast`'s `GatheredReply` is now generic over its value type (`GatheredReply<T = unknown>`); the default keeps every existing use valid (additive, non-breaking).

### Patch Changes

- Updated dependencies:
  - @kumiai/broadcast@0.9.0
  - @kumiai/hub-protocol@0.9.0
  - @kumiai/hub-tunnel@0.9.0

## 0.8.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.8.0. The twelve packages move as one minor band
  (AGENTS.md); the `topicID` schema narrowing (`@kumiai/hub-protocol`) raises the band, so the
  remaining packages take a no-op minor to keep every package on the same minor. No functional change
  in these packages.

### Patch Changes

- Updated dependencies:
  - @kumiai/broadcast@0.8.0
  - @kumiai/hub-protocol@0.8.0
  - @kumiai/hub-tunnel@0.8.0

## 0.7.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.7.0. The twelve packages move as one minor band (AGENTS.md); the did:kokuin (`@kumiai/mls`) and wake (`hub-*`) features raise the band, so the remaining packages take a no-op minor to keep every package on the same minor. No functional change in these packages.

### Patch Changes

- Updated dependencies:
  - @kumiai/broadcast@0.7.0
  - @kumiai/hub-protocol@0.7.0
  - @kumiai/hub-tunnel@0.7.0

## 0.6.0

### Minor Changes

- **Breaking (`@kumiai/mls`):** `GroupOptions.cache`, `GroupOptions.resolver`, the matching
  `GroupHandle` params and getters, and the exported `populateCacheFromCredential` are gone. Nothing
  in the package ever read or wrote either one, so a consumer passing a cache was getting a
  passthrough that would report a miss for a document it had been told would be there.

  `GroupMember` now carries `longForm`, the resolvable form of `id` — the leaf's long form for
  did:peer:4, `id` itself for did:key — and `GroupHandle.findMemberLongForm(id)` looks it up by
  either form. That is what a consumer needing a member's DID document should use: it reads the
  signed leaf rather than an unsigned copy beside it.

  The rest of the band takes the minor because all eleven packages share one pre-1.0 version band.

### Patch Changes

- A commit delivery queued behind the commit mutex when `dispose()` ran is now refused. `dispose()`
  awaits `settled`, never the mutex, so such a delivery used to resume against a torn-down peer and
  rebuild its epoch — fetching the commit topic from a peer its host had already disposed. Refused
  silently, unlike every host-facing entry point: an inbound delivery has no caller to tell.

- A rendezvous reply whose timer fired before `dispose()` no longer publishes after it. Both
  responders — `handleRecoveryRequest` and `handleLedgerRequest` — schedule a `setTimeout` whose
  callback removes itself from its pending set before awaiting the MLS seal, so `dispose()`'s
  `clearTimeout` sweep could not reach one already in flight, and a sealed GroupInfo or the group's
  whole sealed ledger could go out from a torn-down peer.

- Updated dependencies:
  - @kumiai/broadcast@0.6.0
  - @kumiai/hub-protocol@0.6.0
  - @kumiai/hub-tunnel@0.6.0

## 0.5.0

### Minor Changes

- Exactly-once ordered push delivery, and every store failure either coded on the wire or reported.

  **Breaking.** `HubStoreErrorEvent` is a discriminated union on `method` rather than a flat
  `{ method; did?; error }`. Each variant carries the subject its site has — `did` for `ack` and
  `fetchLastResortKeyPackage`, `topicID` for the new `getSubscribers`, neither for `purge`. A hook
  reading `event.did` unconditionally must narrow on `event.method` first.

  `hub/v1/receive` now buffers live pushes during the backlog drain and flushes them deduped before the
  channel goes live, so a frame published mid-drain is neither delivered twice nor out of order. All
  writes serialize through a bounded queue — over `receiveBufferLimit` (new `CreateHandlersParams`
  field, `DEFAULT_RECEIVE_BUFFER_LIMIT` 256) or on a write rejection the channel tears down and frames
  stay pending for redelivery. A `store.ack` failure no longer closes the channel, and an
  already-aborted receive signal runs cleanup instead of leaking.

  `createHandlers` and `createHub` take `onStoreError`, called at the four sites where the hub
  deliberately does not fail the request: the last-resort top-up read, an ack, the scheduled purge, and
  a failed subscriber read during publish fan-out. Those swallows are correct and unchanged — failing
  the publish would lose the live push permanently — but they are no longer silent. Unwired, they
  report through `@sozai/log` under `['kumiai', 'hub-server']`.

  Store failures on `hub/v1/unsubscribe` and the key-package fetch path now cross the wire with their
  hub code instead of arriving indistinguishable from a transport failure. On the spent-budget fallback
  the store error deliberately does not replace the client's retryable `HUB_KEYPACKAGE_FETCH_LIMIT`; it
  is attached as `cause`. `@kumiai/hub-protocol` gains `HUB_INVALID_PAYLOAD` / `InvalidPayloadError`
  for a malformed base64 publish payload.

- Key-package provisioning: last-resort slot, pool replenishment, and drain defence.

  **Security.** An authorized attacker within quota could drain a victim's key-package pool, after
  which the victim could not be added to any group until they re-uploaded. Closed on four fronts: a
  per-DID last-resort slot that is never consumed and sits outside the storage cap; per-DID caps
  (`maxKeyPackagesPerDID` 100, `maxSubscriptionsPerDID` 1000) that reject rather than evict; a
  per-target consumption quota (`maxPerTargetConsumed`, 60/window) so minting throwaway requester DIDs
  no longer amplifies a drain; and automatic provisioning in the new `@kumiai/mls-hub`, without which
  no DID had a slot at all.

  `@kumiai/hub-conformance` gains a clause that one owner's last-resort package is never served for
  another. **An existing store may now fail it**: every other clause exercises a single DID, so a read
  missing `AND owner = ?` passed them all. A fetch for BOB returning ALICE's package Welcomes ALICE,
  who derives the epoch secrets, while the ledger grants the role to BOB.

  **Breaking.**

  - `HubStore.countKeyPackages(ownerDID)` is a **new required method**. `storeKeyPackage` takes an
    optional `notAfter`; an expired entry must be neither served, counted, nor charged against the cap.
  - `KeyPackagePool.ensureStocked()` and `LastResortProvisioner.ensureProvisioned()` return an
    `AsyncResult` from `@sozai/result`. Read `.value`, or branch on `result.isError()` to carry on
    through an outage. A transient condition returns `HubRetryableError`; a settled refusal throws
    `HubRefusedError` with its wire code.
  - `@kumiai/mls-hub`'s pool and last-resort records carry `kind: 'ordinary'` or `kind: 'last-resort'`.
    `KeyPackagePoolStore` and `LastResortStore` were structurally assignable, so a host wiring one
    store to both got no diagnostic on the wrong half — under which a single-use ordinary package
    could be installed in the hub's reusable last-resort slot. The discriminant makes them mutually
    unassignable, and both callers re-check `kind` on every read since a store adapter rebuilding
    records from its own columns can drop the field where no compiler sees it. **A store MUST persist
    `kind` and return it unchanged.**

  **Added.** `@kumiai/mls`: `createLastResortKeyPackageBundle` (extension `0x000A`, explicit 90-day
  lifetime — ts-mls's ~15-day default made the slot read healthy while every join through it failed),
  `LAST_RESORT_LIFETIME_DAYS`, `encodeKeyPackage`/`decodeKeyPackage` and the private-half equivalents,
  `keyPackageRef`. `@kumiai/mls-hub`: `createLastResortProvisioner`, `createKeyPackagePool`,
  `processWelcomeFromSources`. `@kumiai/hub-protocol`: `hub/v1/keypackage/status` (caller's own depth
  only, takes no `did`), a `lastResort` upload flag, and four coded errors —
  `HUB_AUTHORIZATION_DENIED`, `HUB_KEYPACKAGE_QUOTA`, `HUB_SUBSCRIPTION_QUOTA`,
  `HUB_KEYPACKAGE_FETCH_LIMIT`. `@kumiai/hub-client`: `uploadLastResortKeyPackage`.

  **Host obligations**, silent if missed: retain a last-resort bundle's `privatePackage` across a
  Welcome, and re-upload before its lifetime elapses. The `LastResortStore` port holds secret key
  material and MUST scope every method by owner DID.

- Commit-lane replay handling, anycast suppression, the durable-ack relay, and peer disposal.

  **Breaking.**

  - `classifyCommit` takes a single `ClassifyCommitParams` object —
    `{ header, sequenceID, commitDigest, state }`. `CommitClassifierState.appliedByEpoch` is
    `ReadonlyMap<number, AppliedCommit>`. `AppliedCommit`, `ClassifyCommitParams` and
    `digestAppliedCommit` are exported.
  - `ProtocolSurface.to` returns `Promise<Client<Protocol>>`; it is now gated on peer readiness like
    `protocol()`'s other three methods.
  - `@kumiai/rpc`'s hand-copied `createGroupBusServer` is deleted. `@kumiai/broadcast`'s
    `createBroadcastResponder` is the single implementation; it renames `handlers` →
    `requestHandlers` and gains an optional `@sozai/event` `EventEmitter` and a dispose-aborted
    `AbortSignal` in the handler context.
  - `MailboxHubEvents` is `EventEmitter<{ status: MailboxHubEvent }>`. Use
    `hub.events.on('status', …)` in place of `hub.events.subscribe(…)`; the returned unsubscribe is
    unchanged. `HubBase.events` is `readonly`, and `MailboxHubEventListener` is removed.
  - `@kumiai/broadcast`'s `subscribe` callback gains an optional second argument carrying the ack.
    `@kumiai/hub-tunnel` gains `HubReceiveOptions` and an optional `receive` scope parameter
    (additive — a double declaring fewer parameters stays assignable).

  **Security — a replayed commit is no longer a fork.** The commit lane proxied "a different commit"
  with "a different sequenceID". A hub re-publishing a genuine commit frame verbatim and serving the
  copy first made every peer read the original as the losing side of a fork: a heal, a rejoin, an
  external commit, and an app-lane anchor rotation for every member, once per replay, for bytes
  already delivered. `appliedByEpoch` now records a digest of the applied commit's bytes and
  `classifyCommit` answers `history` on a match. Genuinely different commits at one epoch still fork
  and still heal, lower sequenceID winning; the change only ever produces fewer heals than before. Not
  a general defence against a hub that reorders or withholds — it removes the replay route. Both
  conformance suites gain the complementary floor, `a re-published payload under a fresh publishID
  never lands below the original`; a store failing it is not conformant.

  **Anycast suppression fires only on a successful reply.** Any observed reply, errors included,
  previously marked a request replied, so one fast *failing* responder suppressed every healthy one
  and the client timed out. `adaptBusHandlers` now validates bus-lane input against the protocol's
  declared JSON schemas — an invalid request rejects (which, per the fix, suppresses nobody) and an
  invalid event is dropped and logged. Live push and app-lane drain share the same validation.

  **The durable-acknowledgement relay is reconnected** between a peer's ack and the hub, and
  `@kumiai/hub-tunnel`'s transport now acks every frame its read pump handles, withholding only where
  the transport tears down first. Two visible consequences: mailbox entries that previously aged out
  unread are reclaimed, and a frame matching no listener and no sink is no longer acked, so it is
  redelivered after restart rather than silently dropped. `@kumiai/hub-conformance` gains opt-in
  `testAckConformance`, split into `testMailboxAckConformance` and `testLogAckConformance` so a
  subject with no readable log can take the redelivery clause alone.

  **A disposed `GroupPeer` refuses everything** — `dispatch`, `request`, `gather`, `to`, `commit`,
  `replay`, `recover`, `resync` — with `Peer is disposed`. Each previously failed its own way, `to()`
  handing back a live-looking `Client` over an aborted transport among them. `resync()` also now runs
  under the commit mutex, so a host calling it mid-commit waits rather than running two teardown/build
  cycles over one set of runtimes.

- The group moves to the 0.5 band. Every publishable package shares one meaningful version — the minor
  while pre-1.0, the major after. Trailing segments still diverge freely: a package taking a patch
  release on its own does not move anyone else.

  `@kumiai/mls-hub` publishes for the first time in this release, at the band version.

  **Breaking.** Two dead exports removed while the band break makes it cheap, both unreachable in
  practice:

  - `@kumiai/mls` no longer exports the `GroupSyncScope` type — referenced by nothing, here or in any
    consumer.
  - `HubClient` no longer exposes the `rawClient` getter. `HubClient` now has one method per
    `HubProtocol` procedure, and a caller needing the underlying `Client<HubProtocol>` already holds
    it — `HubClientParams` takes it in.

### Patch Changes

- Updated dependencies:
  - @kumiai/broadcast@0.5.0
  - @kumiai/hub-protocol@0.5.0
  - @kumiai/hub-tunnel@0.5.0

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
