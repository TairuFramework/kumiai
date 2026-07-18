---
'@kumiai/mls-rpc': minor
'@kumiai/mls': minor
---

Expose the MLS exporter secret and the read half of the application lane, and add
`@kumiai/mls-rpc`: the `@kumiai/rpc` consumer ports implemented over `@kumiai/mls`.

- `GroupHandle.exportSecret(label, context, length)` — the RFC 9420 §8.5 exporter over this
  epoch's exporter secret. Per-epoch by construction, which is the only thing that cuts a
  removed member off from a name derived from it.
- `GroupHandle.decrypt(bytes)` — the counterpart to `encrypt`: opens an application message
  and returns the AEAD-authenticated sender's DID, which ts-mls's own `processMessage` does
  not surface.
- `@kumiai/mls-rpc` supplies `createGroupCrypto` and `createGroupMLS`, the first real
  implementations of `GroupCrypto` and `GroupMLS`. It sits above both packages because
  `@kumiai/rpc` must not depend on MLS and `@kumiai/mls` must not depend on RPC.
