# @kumiai/rpc-conformance

## 0.10.0

### Minor Changes

- Ship in the 0.10 release band for acknowledged durable app-frame delivery. `@kumiai/rpc`
  adds opt-in at-least-once delivery of retained events, a pending-record port, handler frame
  identity, and retry and operator-drop behavior. `@kumiai/mls` adds staged decrypt and cleartext
  AAD reading; `@kumiai/mls-rpc` implements the atomic durable-open port. The conformance suite
  covers the new contract, and the remaining packages move together in the shared version band.

  **Breaking:** all app frames now use versioned AAD carrying authenticated log intent. 0.9 and
  0.10 peers cannot exchange app frames; a frame with the older bare-topic AAD is refused. Consumers
  implementing `GroupCrypto` must provide `frameAAD` and support the new `unwrap` options. Hosts opting in to
  durable delivery must atomically persist consumed-key state with each pending record, order
  handle saves, reject stale same-epoch writes, and avoid holding a database transaction while
  awaiting a peer or handle operation.

- Host handle access, in the same 0.10 band as durable delivery.

  **`@kumiai/mls-rpc` (breaking):** both factories take one shared `access: HandleAccess` in place of `handle` / `adopt` / `persist`; `simpleHandleAccess({ handle, adopt, persist })` builds it from the old parameters. A host with its own store implements `HandleAccess` (`epoch`, `read`, `mutate`, `replace`, `open`) and owns the lock, the transaction and the persist order. New exports: `applyCommit` for applying a received Commit inside a host transaction (it returns both rosters, the surfaced ledger entries, the committer, and `applied` / `advanced`), `deriveEntryKey`, `sealEntries`, `openEntries`, `createRecoveryPending` and `deriveRecoverySecret`. `createGroupMLS` takes an optional `recoverySecret(handle)` override; the default is unchanged, so existing groups keep their topics. Without `pending`, the simple adapter now saves the ratchet state after `wrap` and `unwrap`: a crash after `unwrap` and before the handler finishes loses that frame, and `pending` is the at-least-once path. `applyCommit` propagates resolver faults instead of reporting a refusal. A durable open reports a fault from the adapter's staging callback as `AppFrameStorageError`, so the frame is retried. `processCommit` answers `advanced: false` with the handle's epoch when the handle moved while entries resolved, and `bootstrapLedger` keeps a stored bootstrap when a host callback throws after the write.

  **`@kumiai/rpc` (breaking port change):** `GroupCrypto.epoch()` is a hint, and decisions use the epoch a locked port result reports. `exportSecret` returns `{ secret, epoch }`, `sealEntries` returns `{ sealed, epoch }`, `unwrap` results carry `epoch`, `processCommit` returns `{ advanced, epochBefore, epochAfter }`, and `GroupMLS` gains `readEpoch()`. `unwrap` throws `FrameEpochError { frameEpoch, handleEpoch }` for a readable frame at another epoch, before decrypting. App-frame retention, the drain, anchor capture, the commit walk and journal replay read the epoch under the handle lock instead of the hint. `isFrameAhead` and `isAppFrameStorageError` check by error name, so errors from a second installed copy of the package classify correctly.

  **`@kumiai/rpc-conformance`:** harnesses provide `setEpochHintOffset(offset)`, and clauses run with a lying hint in both directions. The `GroupMLS` shape gains `readEpoch`.

- `GroupMLS.rosterDIDs` → `rosterEntries` with per-leaf identity (breaking). `rosterDIDs(): Promise<Array<string>>` is replaced by `rosterEntries(): Promise<Array<RosterEntry>>`, where `RosterEntry` is `{ did, leafIndex, longForm }`. Entries are returned in ascending `leafIndex` order; `leafIndex` is stable while a leaf remains present and is reassigned by a remove/rejoin of that member; `longForm` is the leaf credential's long form when it carries one, else its `id` (never absent, not a resolvability guarantee).

  **Breaking:** the port rename and shape change hit the `@kumiai/rpc` `GroupMLS` port, the `@kumiai/mls-rpc` real implementation, and the `@kumiai/rpc-conformance` contract suite every implementation and every double must pass. `detectRosterChange` is unchanged — it keeps its `Array<string>` DID-set signature.

  Known coverage gap (documented, not implemented): the in-repo test double addresses removal by DID and cannot model removing one of two leaves the same DID holds, so the duplicate-DID-leaf-removal case is not covered by conformance. No filed consumer needs it today; the real `@kumiai/mls-rpc` implementation is already faithful via ts-mls.

## 0.9.0

### Minor Changes

- Add authenticated-data (AAD) binding to the group application-message cryptographic layer. The `GroupHandle.encrypt()` and `GroupHandle.decrypt()` methods now accept an optional AAD parameter, and the `@kumiai/rpc` `GroupCrypto` port's `wrap()` and `unwrap()` operations now accept AAD and `expectedAAD` respectively. Each application message and directed frame is now cryptographically bound to the topicID on which it is published; a frame sealed for one topic cannot be opened on another. The AAD comparison is performed before the message is decrypted, preventing a wrong-topic frame from consuming a ratchet generation.

  **Breaking change:** Pre-upgrade retained application history is invalidated on upgrade. The upgrade drain now enforces the topic AAD constraint and advances the durable cursor past legacy empty-AAD frames. There is no legacy-acceptance code path for frames without AAD.

  This change does not modify topic-ID derivation logic or the durable commit and recovery-topic infrastructure.

## 0.8.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.8.0. The twelve packages move as one minor band
  (AGENTS.md); the `topicID` schema narrowing (`@kumiai/hub-protocol`) raises the band, so the
  remaining packages take a no-op minor to keep every package on the same minor. No functional change
  in these packages.

## 0.7.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.7.0. The twelve packages move as one minor band (AGENTS.md); the did:kokuin (`@kumiai/mls`) and wake (`hub-*`) features raise the band, so the remaining packages take a no-op minor to keep every package on the same minor. No functional change in these packages.

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

## 0.5.0

### Minor Changes

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

## 0.4.0

### Minor Changes

- New package: `testGroupCryptoConformance` and `testGroupMLSConformance`, the contract suites for
  `@kumiai/rpc`'s two consumer ports, run against the test doubles and against the real
  `@kumiai/mls-rpc` implementations.

  They exist because a double that answers where its real port refuses hides a production defect
  behind a green suite. Clauses worth naming, each of which found a real divergence: `unwrap`
  consumes, so a frame opens exactly once; `exportSecret` is per-epoch, and derives different
  bytes for different labels; a commit removing the local member does not advance it and yet drops
  its own leaf; a recovery or ledger responder refuses a requester it has removed; a gather key is
  not consumed, so a requester can consider more than one responder; a tampered entry blob is
  refused rather than opened; and a key package is served once.

  The suite carries a compile-time tripwire in its callers: a reverse type assignment that fails
  the moment a contract grows a member the suite has never heard of. Without it that gap is
  invisible, because a member with no clause simply is not exercised — which is how eight of
  `GroupMLS`'s twelve members came to have no contract at all.
