---
'@kumiai/mls-hub': minor
'@kumiai/mls': minor
---

Automatic last-resort key-package provisioning: the defence is now armed, not merely present.

`@kumiai/mls` could already generate a last-resort key package and the hub could already serve one
without consuming it, but nothing decided *when* — so until a host wired it by hand, no DID had one
and the key-package drain residual stayed open in practice.

New package `@kumiai/mls-hub` owns that policy. `createLastResortProvisioner({ identity, client,
store }).ensureProvisioned()` is idempotent: it mints, uploads, and retains a package, replaces it
once fewer than 30 days of its 90-day lifetime remain, and prunes a retired record only after its
lifetime plus a 7-day grace. `bundles()` returns every retained bundle newest-first for
`processWelcome`. It lives above both `@kumiai/mls` and `@kumiai/hub-client` for the same reason
`@kumiai/mls-rpc` exists — neither may depend on the other — and it does not depend on `ts-mls`.

The record is persisted **before** the upload. The reverse order has a crash window in which the hub
serves a package whose private half was never written down, which is the silent "unaddable forever"
outage the slot exists to prevent; a crash in the chosen order instead leaves an un-uploaded record,
which the next call resumes and finishes — unless that record is by then already inside the rotation
window, in which case the next call abandons it for a fresh mint rather than finishing an upload no
inviter would accept anyway.

Two host obligations that were previously doc comments are now discharged by code: retaining a
reusable package's private half across a Welcome, and rotating before the MLS lifetime the *inviter*
enforces runs out. The `LastResortStore` port is host-implemented and holds secret key material; a
store MUST scope every method by owner DID.

`@kumiai/mls` gains `encodePrivateKeyPackage` / `decodePrivateKeyPackage` — the canonical string form
of a key package's private half, strict in the same three ways the public codec is — and
`keyPackageRef`, the base64 KeyPackageRef a Welcome names.

Also recorded, having been read and verified rather than assumed: nothing requires a publisher to
advertise extension type `0x000A` in its capabilities. draft-ietf-mls-extensions-05 has no such
clause, RFC 9420's capabilities rule binds leaf-node extensions and `last_resort` is
KeyPackage-only, and draft -08 has moved the feature to MLS Component Type `0x00000004` inside
`app_data_dictionary`. `0x000A` remains what deployed implementations use, so it stays;
`controlCapabilities()` is unchanged.
