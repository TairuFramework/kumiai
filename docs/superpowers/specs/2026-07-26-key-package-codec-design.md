# Key-package codec

**Date:** 2026-07-26
**Scope:** `@kumiai/mls`
**Prerequisite for:** automatic last-resort key-package provisioning
(`docs/agents/plans/next/2026-07-26-last-resort-keypackage-provisioning.md`)

## Problem

Nothing in the stack converts an MLS `KeyPackage` to the `string` the hub stores, or back.

The hub's `hub/v1/keypackage/upload` and `hub/v1/keypackage/fetch` both carry key packages as
opaque strings, and `@kumiai/mls` produces `KeyPackageBundle.publicPackage` as a ts-mls `KeyPackage`
object. No `encodeKeyPackage`, no `decodeKeyPackage`, and no use of ts-mls's `keyPackageEncoder` /
`keyPackageDecoder` exists anywhere in `packages/*/src` — nor in any test or integration code.

So today a host must reach past `@kumiai/mls` into ts-mls directly, hand-roll TLS encoding plus a
binary-to-string step, and independently reinvent the exact inverse on the fetching side before it
can pass anything to `commitInvite`. Both `uploadKeyPackages` and `uploadLastResortKeyPackage` are
unusable from inside this stack without that.

This predates the last-resort work — ordinary key packages have the same gap — but it blocks
provisioning specifically, because producing that string is a provisioning helper's entire job.

The encoding is a **wire-compatibility decision, not a local one**: the uploading peer and the
fetching peer must agree, and once packages are sitting in a hub, changing it breaks them.

## Decisions

| Question | Decision |
|---|---|
| Return type | `string` (base64), not the `Uint8Array` other `@kumiai/mls` encoders return |
| Decode failure | `null`, matching `decodeGroupAnchor` / `decodeLedgerHead` |
| Trailing bytes | Rejected — decode is strict about consuming its whole input |
| Validation | None beyond well-formedness; Add-time validation remains the gate |
| File | New `key-package-codec.ts`, not `codec.ts` |

### Why `string` rather than `Uint8Array`

Every existing encoder in the package (`encodeGroupAnchor`, `encodeClientState`, `encodeLedgerHead`)
returns `Uint8Array`, so this deviates deliberately.

`@sozai/codec` exports both `toB64` and `toB64U`, and they are not interchangeable. Returning bytes
and leaving the string step to each host is precisely how an uploader and a fetcher end up
disagreeing about data already stored in a hub. Since the hub is the only consumer and its wire type
is `string`, the codec makes one form canonical and removes the choice.

## Design

### Surface

New file `packages/mls/src/key-package-codec.ts`, re-exported from `@kumiai/mls`:

```ts
export function encodeKeyPackage(keyPackage: KeyPackage): string
export function decodeKeyPackage(encoded: string): KeyPackage | null
```

`encodeKeyPackage` serializes with ts-mls's `keyPackageEncoder` and base64-encodes the result with
`toB64`, matching the encoding the hub already uses for message payloads.

It lives in its own file rather than in `codec.ts` because that file documents itself as "one
process serializing its own state to itself … never a wire format another peer or another build
reads". This codec is the exact opposite — a format two peers must agree on — and colocating them
would undercut a comment that is doing real work.

### Strict decode

`decodeKeyPackage` returns `null` for input that is not valid base64, and otherwise calls
`keyPackageDecoder(bytes, 0)` **directly** rather than going through ts-mls's `decode()` helper.

`decode()` is `dec(t, 0)?.[0]` — it discards the consumed length, so trailing garbage is silently
accepted and the same logical key package has unlimited byte representations. Calling the decoder
directly exposes the consumed length; the codec returns `null` unless it equals the input length.

One comparison buys a single canonical representation per package, which any later attempt to dedup
or identify a package by its bytes depends on.

### What decode deliberately does not do

No signature verification, no lifetime check, no capability check.

ts-mls already performs all of these at Add time, in `validateKeyPackage` inside
`applyTreeMutations`, and that is the gate that matters — it runs on the inviter with the group
context in hand, which a decoder does not have.

Verifying here would be redundant where it duplicates the Add-time checks and misleading where it
does not: a caller could reasonably read "it decoded" as "it is safe to add", which is false. The
doc comment states plainly that a successful decode proves only well-formedness.

### Testing

- **Round trip against real MLS**: encode a generated bundle's `publicPackage`, decode it, and use
  the *decoded* package in a real `commitInvite` that succeeds. This proves the codec against MLS
  rather than against itself — a structural-equality assertion alone would pass for an encoding MLS
  cannot consume.
- Structural equality of the decoded package with the original.
- Trailing bytes appended to a valid encoding are rejected.
- Non-base64 input is rejected.
- Empty string is rejected.
- Truncated TLS bytes are rejected.

Each guard is mutation-checked: the implementation is deliberately broken, the matching test
confirmed failing, then restored.

## Out of scope

- Provisioning, rotation, and upload scheduling — the separate follow-on this unblocks.
- Any change to the hub protocol, `HubStore`, or `hub-client`. Their wire types already accept the
  string this produces.
- Encoding for `PrivateKeyPackage`. Host-side persistence of private key material is its own
  decision and belongs with the provisioning work, which is where the retention and rotation
  obligations live.

## Success criteria

- A key package encoded by `encodeKeyPackage` can be uploaded through `hub-client` unmodified.
- A string fetched from the hub decodes to a `KeyPackage` that `commitInvite` accepts.
- A malformed, truncated, or trailing-byte-padded blob returns `null` rather than throwing or
  producing a partially-populated package.
- No `@kumiai/mls` consumer needs a direct `ts-mls` dependency to upload or consume key packages.
