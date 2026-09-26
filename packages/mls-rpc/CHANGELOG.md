# @kumiai/mls-rpc

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

### Patch Changes

- Reject non-Commit bytes on the commit topic before they reach the MLS handle. This prevents stray Proposals from entering the next authored Commit and keeps peers that missed them able to apply it.

- Expose commit strand observations and recovery lifecycle callbacks. `started` is dispatched asynchronously when the attempt begins, before its terminal event and while a port call may still be pending. Recovery attempts are single-flight, and `recover()` may drain re-enact entries left by an earlier automatic heal. Future-version handshake frames with unknown kinds now trigger healing, failed request publishes throw instead of timing out, and a ledger bootstrap completed later returns the owed re-enact entries. Disposal waits for ledger bootstraps already in progress.

  `@kumiai/mls` persists accepted received commits and proposals, plus ledger bootstrap, before notifications; this option does not persist application-message receive ratchets. Persist must write atomically and must not call back into the same handle while its mutex is held. A rejection restores prior in-memory state and must leave storage unchanged. Host callback errors do not undo a durable advance.

  `@kumiai/mls-rpc` persists recovery handles before adoption; if adoption throws, a restart loads the new stored handle. It uses the MLS handle persistence boundary for commits and ledger bootstrap, reports durable advances even if a host callback throws, and expires and zeroes recovery request keys on timers without requiring another request.

- Updated dependencies:
  - @kumiai/mls@0.10.0
  - @kumiai/rpc@0.10.0

## 0.9.0

### Minor Changes

- Add authenticated-data (AAD) binding to the group application-message cryptographic layer. The `GroupHandle.encrypt()` and `GroupHandle.decrypt()` methods now accept an optional AAD parameter, and the `@kumiai/rpc` `GroupCrypto` port's `wrap()` and `unwrap()` operations now accept AAD and `expectedAAD` respectively. Each application message and directed frame is now cryptographically bound to the topicID on which it is published; a frame sealed for one topic cannot be opened on another. The AAD comparison is performed before the message is decrypted, preventing a wrong-topic frame from consuming a ratchet generation.

  **Breaking change:** Pre-upgrade retained application history is invalidated on upgrade. The upgrade drain now enforces the topic AAD constraint and advances the durable cursor past legacy empty-AAD frames. There is no legacy-acceptance code path for frames without AAD.

  This change does not modify topic-ID derivation logic or the durable commit and recovery-topic infrastructure.

### Patch Changes

- Updated dependencies:
  - @kumiai/mls@0.9.0
  - @kumiai/rpc@0.9.0

## 0.8.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.8.0. The twelve packages move as one minor band
  (AGENTS.md); the `topicID` schema narrowing (`@kumiai/hub-protocol`) raises the band, so the
  remaining packages take a no-op minor to keep every package on the same minor. No functional change
  in these packages.

### Patch Changes

- Updated dependencies:
  - @kumiai/mls@0.8.0
  - @kumiai/rpc@0.8.0

## 0.7.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.7.0. The twelve packages move as one minor band (AGENTS.md); the did:kokuin (`@kumiai/mls`) and wake (`hub-*`) features raise the band, so the remaining packages take a no-op minor to keep every package on the same minor. No functional change in these packages.

### Patch Changes

- Updated dependencies:
  - @kumiai/mls@0.7.0
  - @kumiai/rpc@0.7.0

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

- Updated dependencies:
  - @kumiai/mls@0.6.0
  - @kumiai/rpc@0.6.0

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

### Patch Changes

- Updated dependencies:
  - @kumiai/mls@0.5.0
  - @kumiai/rpc@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - @kumiai/rpc@0.5.0

## 0.4.0

### Minor Changes

- New package: `createGroupCrypto` and `createGroupMLS`, the first real implementations of
  `@kumiai/rpc`'s `GroupCrypto` and `GroupMLS` ports over `@kumiai/mls`. It sits above both
  packages because `@kumiai/rpc` must not depend on MLS and `@kumiai/mls` must not depend on RPC.

- The sealed ledger-entry blob carries a format version: `[ VERSION(1) | NONCE(24) | CIPHERTEXT ]`.
  The byte buys diagnosis, not compatibility — a format change is a flag day whatever it says, but
  the failure now reads as "this blob is v2 and I speak v1" instead of an AEAD refusal
  indistinguishable from a wrong epoch or a tampered frame. It lives inside the blob and never in
  the frame header, so an unknown version costs an old peer one poisoned commit rather than a
  stall on every frame.

- `ENTRY_SEAL_LABEL` is exported — the label the entry seal derives its key under, so a caller
  overriding it via `GroupCryptoParams.entryLabel` can name what it is replacing.

- `GroupCryptoParams.label` is **deleted**; the per-purpose label now comes from the
  `exportSecret(label, …)` call itself, and `entryLabel` is the only override left. Passing
  `label` in an object literal is an excess-property error, but passing a loosely-typed variable
  compiles, is silently ignored, and **changes every derived topic ID**. Audit `createGroupCrypto`
  call sites by hand rather than trusting the compiler.

- `APP_TOPIC_LABEL` is no longer exported here; import it from `@kumiai/rpc`.

- `RECOVERY_LABEL` moves from `kumiai/rendezvous/v1` to `kumiai/recovery/v1` — it was colliding
  with `@kumiai/rpc`'s `RENDEZVOUS_LABEL`. The recovery secret is exported under this label and
  both the commit and rendezvous topics derive from that secret, so all three move together.

### Patch Changes

- Updated dependencies:
  - @kumiai/rpc@0.4.0
  - @kumiai/mls@0.4.0
