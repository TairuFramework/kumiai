# @kumiai/mls-rpc

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
