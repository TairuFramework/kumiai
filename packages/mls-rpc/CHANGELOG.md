# @kumiai/mls-rpc

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
