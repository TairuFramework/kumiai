# @kumiai/rpc-conformance

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
