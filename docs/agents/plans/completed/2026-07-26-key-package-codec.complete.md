# Key-package codec — complete

**Landed:** 2026-07-26, on the same branch as the last-resort key-package work
(`docs/agents/plans/completed/2026-07-26-last-resort-keypackage.complete.md`).
**Scope:** `@kumiai/mls` only. No hub-side change.

## The gap it closed

Nothing in the stack converted an MLS `KeyPackage` to the `string` the hub stores, or back.

The hub's `hub/v1/keypackage/upload` and `hub/v1/keypackage/fetch` both carry key packages as
opaque strings; `@kumiai/mls` produces `KeyPackageBundle.publicPackage` as a `ts-mls` `KeyPackage`
object. There was no `encodeKeyPackage`, no `decodeKeyPackage`, and no use of `ts-mls`'s
`keyPackageEncoder` / `keyPackageDecoder` anywhere in `packages/*/src` — nor in any test or
integration code. So a host had to reach past `@kumiai/mls` into `ts-mls` directly, hand-roll TLS
encoding plus a binary-to-string step, and independently reinvent the exact inverse on the fetching
side before it could pass anything to `commitInvite`. Both `uploadKeyPackages` and
`uploadLastResortKeyPackage` were unusable from inside this stack without that.

The gap predated the last-resort work — ordinary key packages had it too — but it blocked automatic
provisioning specifically, because producing that string is a provisioning helper's entire job.

## Decisions and why

**The encoding is a wire-compatibility decision, not a local one.** The uploading peer and the
fetching peer must agree, and once packages are sitting in a hub, changing it breaks them. That
framing drove every choice below.

| Question | Decision | Why |
|---|---|---|
| Return type | `string` (base64) | Deviates from every other encoder in the package (`encodeGroupAnchor`, `encodeClientState`, `encodeLedgerHead` all return `Uint8Array`) — deliberately. `@sozai/codec` exports both `toB64` and `toB64U` and they are not interchangeable; returning bytes and leaving the string step to each host is precisely how an uploader and a fetcher end up disagreeing about data already stored. The hub is the only consumer and its wire type is `string`, so the codec makes one form canonical and removes the choice. |
| Decode failure | `null` | Matches `decodeGroupAnchor` / `decodeLedgerHead`. |
| Validation | None beyond well-formedness | `ts-mls` performs signature, lifetime, and capability checks at Add time in `validateKeyPackage`, on the inviter, with the group context in hand — which a decoder does not have. Repeating them would be redundant where it duplicated that gate and *misleading* where it did not: a caller could reasonably read "it decoded" as "it is safe to add". It is not. |
| File | New `key-package-codec.ts`, not `codec.ts` | `codec.ts` documents itself as "one process serializing its own state to itself … never a wire format another peer or another build reads". This is the exact opposite, and colocating them would undercut a comment doing real work. |
| `PrivateKeyPackage` encoding | Out of scope | Host-side persistence of private key material carries retention and rotation obligations that belong with the provisioning work. |

## Decode is strict in three independent ways

Each closes a path by which one logical key package gains a second string form. One canonical
representation per package is what any later attempt to dedup or identify a package by its stored
form depends on.

1. **`fromB64` throws** `Error('Invalid base64 encoding')` on a bad alphabet rather than returning
   a sentinel. Caught, returns `null`.
2. **Canonical-form check** — `toB64(bytes) !== encoded` rejects any string that is not the
   canonical base64 of its own bytes. This is the guard that is easiest to mistake for ceremony and
   is not: `fromB64` *trims surrounding whitespace* and decodes with `lastChunkHandling: 'loose'`,
   so without it `encoded + '\n'` decodes happily to the same package. The hub stores and compares
   **strings**, so a byte-level canonicality guarantee never reaches the layer that needs it.
3. **Whole-input check** — `keyPackageDecoder` is called directly rather than through `ts-mls`'s
   `decode()`, which is `dec(t, 0)?.[0]` and discards the consumed length, silently accepting
   trailing garbage. The returned length is compared against the input length instead.

**The `Decoder<T>` contract is wrong, and the implementation depends on knowing that.** Its type
says `(b, offset) => [T, number] | undefined`, implying failure is always `undefined`. In fact
`varLenDataDecoder` **throws** `CodecError` when a variable-length field's declared length overruns
the buffer — so truncated input throws where malformed-but-complete input returns `undefined`. The
decoder call therefore has its own `try/catch`, kept separate from `fromB64`'s so the two failure
paths stay independently testable. The full decoder call graph was traced: every throw reachable on
this path is a `CodecError` from a malformed length prefix, and no signature-verification path is
reachable during decode, so the bare `catch {}` cannot mask a verification error. **Do not collapse
the two `try` blocks.**

## What proves it

Seven unit guards plus one integration test, all mutation-checked (implementation deliberately
broken, matching test confirmed failing, restored):

- Round trip reproduces the package structurally; encoding is deterministic.
- Trailing bytes, whitespace padding, non-base64, empty string, and truncated TLS each return
  `null`.
- **The claim the unit tests cannot make:** a *decoded* package — never the original — is added to
  a real group via `commitInvite` and the join is carried through `processWelcome`, asserting the
  invitee actually landed in the group. Structural equality alone would pass for an encoding MLS
  cannot consume.

## Follow-ons this leaves open

- Automatic provisioning and rotation —
  `docs/agents/plans/next/2026-07-26-last-resort-keypackage-provisioning.md`, which this unblocks.
- `PrivateKeyPackage` encoding, if a host needs to persist the private half across a rotation.
