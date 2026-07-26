---
'@kumiai/mls': minor
---

Add `encodeKeyPackage` and `decodeKeyPackage`, so a host can move key packages to and from the
hub without a direct `ts-mls` dependency.

Nothing in the stack converted an MLS `KeyPackage` to the `string` the hub's
`hub/v1/keypackage/upload` and `hub/v1/keypackage/fetch` carry, or back — so `uploadKeyPackages`
and `uploadLastResortKeyPackage` were unusable from inside this stack without each host
hand-rolling TLS encoding plus a binary-to-string step, then independently reinventing the exact
inverse on the fetching side. The encoding is a wire-compatibility decision rather than a local
one: the uploading peer and the fetching peer must agree, and once packages are sitting in a hub,
changing it breaks them. `@sozai/codec` exports both `toB64` and `toB64U` and they are not
interchangeable, so this returns a `string` — deviating from every other encoder in the package,
which returns `Uint8Array` — and makes one form canonical.

`decodeKeyPackage` returns `null` rather than throwing, matching `decodeGroupAnchor` and
`decodeLedgerHead`, and is strict about canonical form: it rejects a string that is not the
canonical base64 of its own bytes (`fromB64` trims whitespace and tolerates padding variation,
and the hub compares strings), and it calls `keyPackageDecoder` directly rather than through
ts-mls's `decode()` — which discards the consumed length and so silently accepts trailing
garbage — to require that the whole input was consumed. One canonical string per package is what
any later attempt to dedup or identify a package by its stored form depends on.

A successful decode proves well-formedness and nothing more. No signature is verified, no
lifetime is checked, no capability is inspected: ts-mls performs all of those at Add time on the
inviter, with the group context in hand, and repeating them here would be redundant where it
duplicated that gate and misleading where it did not.
