# `deriveTopicID` injectivity — design

**Date:** 2026-09-03
**Packages:** `@kumiai/broadcast`, `@kumiai/rpc`
**Status:** approved for planning
**Input:** `docs/agents/plans/next/2026-09-02-derivetopicid-injectivity.md` (Spec B of three; Spec A —
AAD on group app-message crypto — shipped 2026-09-03 as `#38`).

## Goal

Make topic derivation injective without rotating any existing topic ID, on two levels: `deriveTopicID`
is structurally injective over distinct validated input tuples, and the `@kumiai/rpc` topic helpers
(`protocolTopic`, `inboxTopic`, `commitTopic`, `rendezvousTopic`, `discoveryTopic`) are
domain-separated from one another so no two *kinds* collide. Achieved by validating inputs and
enforcing label domain-separation (rejection), not by re-encoding.

The guarantee is scoped to the helpers, not to the low-level primitive: `deriveTopicID` is exported by
`@kumiai/broadcast` and is deliberately label-agnostic, so a caller bypassing the rpc helpers can
supply a reserved tuple and reproduce a helper's topic on purpose. That is the layering boundary
(generic broadcast must not know rpc's namespace), not a defect — the helpers, which every real
consumer uses, are what carry domain separation.

## The defect

Topic IDs come from `deriveTopicID` (`broadcast/src/topic.ts:28`), which builds the HKDF `info` as a
NUL-joined string:

```
info = fromUTF(`${PREFIX}${SEP}${label}${SEP}${scope}`)   // SEP = '\0'
```

Injectivity fails on three independent axes:

1. **A component bearing a literal `\0`** breaks the unambiguous split. `inboxTopic` passes
   `scope = memberDID` and `protocolTopic` passes a host-supplied `label`; a NUL in either lets one
   `(label, scope)` pair reproduce another's exact `info`.
2. **Lossy UTF-8 encoding.** `fromUTF` is a WHATWG `TextEncoder` (`@sozai/codec` lib/index.js:151,
   which notes `TextEncoder` has no `fatal` option), so a lone UTF-16 surrogate is replaced with
   U+FFFD: `"\uD800"` and `"\uD801"` encode to identical bytes. Two distinct strings collapse to one
   `info` — a collision no NUL check catches.
3. **Unenforced label reservation (cross-kind collision).** `protocolTopic` passes the host-supplied
   protocol name *directly* as the `deriveTopicID` label (`rpc/src/topic.ts:46`), with no check that
   it avoids the reserved labels `INBOX_LABEL`, `COMMIT_LABEL`, `RENDEZVOUS_LABEL`. The inbox comment
   (`rpc/src/topic.ts:51`) *claims* the reserved label "never collides with an application protocol
   of the same name", but nothing enforces it. Because `inboxTopic` and `protocolTopic` derive from
   the **same** `anchor.secret` at the **same** `anchor.epoch` (`peer.ts:573`, `peer.ts:586`), a host
   that names a protocol `kumiai/inbox/v1` and publishes it with `scope = memberDID` produces exactly
   `inboxTopic(anchor.secret, anchor.epoch, memberDID)` — a collision needing no NUL and no
   surrogate, entirely inside the validated string domain. Axes 1 and 2 alone do not close this.

Any of these makes two open-once paths open the same ciphertext, defeating the MLS single-open
guarantee.

**Reachability.** Malformed DIDs are accepted today: `localDID` is a bare parameter passed to
`inboxTopic` at init unvalidated (`peer.ts:573`), `.to(memberDID)` accepts an arbitrary string on the
public surface (`peer.ts:2051` → `inboxTopic`), and the MLS credential parser only checks that `id`
is a string — its syntax is explicitly not validated (`mls/src/credential.ts:140`). So a NUL- or
surrogate-bearing DID can reach `inboxTopic` through an unvalidated credential today; this is not a
Spec-C-only concern. Host protocol names (axis 3) come straight from `Object.entries(protocols)`
(`peer.ts:586`).

## Decision: rejection, not re-encoding

A NUL-joined concatenation is injective **iff** every component is NUL-free **and** well-formed
UTF-16, and topic *kinds* are separated **iff** host labels cannot occupy the reserved-label
namespace. Enforce all three as contracts and throw on violation. Because no existing valid caller
violates them, every already-derived topic ID is byte-for-byte unchanged: the fix rotates nothing,
needs no migration, and preserves the durable control plane (commit/rendezvous) and retained app
history.

The alternative — re-encoding `info` with a length-prefixed structure — is structurally injective for
arbitrary byte input but rotates *every* topic ID: a data break stranding offline peers on the
commit/rendezvous plane, orphaning retained app logs and cursors, splitting the commit plane under a
rolling deploy, all requiring a dual-read migration protocol. It buys nothing here — topic components
are always text (reserved labels, host protocol names, DIDs), never arbitrary bytes — and it would
still not fix axis 3 on its own. Rejected.

## Contract

### `deriveTopicID(secret, epoch, label, scope)` — `@kumiai/broadcast`

Validate before deriving; throw a plain `Error` naming the offending component and reason. Valid
inputs produce the identical output they produce today (same NUL-join, same bytes).

- **`label`, `scope`** — reject if the string contains `\0`; reject if `!str.isWellFormed()`
  (ES2025, lib `es2025` is enabled). Applied to each independently.
- **`epoch`** — reject if `!Number.isSafeInteger(epoch)` or `epoch < 0`.

  The safe-integer bound is the real injectivity limit, not `2**64`. `encodeEpoch` does
  `setBigUint64(BigInt(epoch))` (`broadcast/src/topic.ts:11`); two distinct intended epochs at or
  above `2**53` round to the same float *before* `BigInt` sees them, and non-integer / negative /
  non-finite epochs have no defined encoding. No epoch reaching `2**64` is safely representable as a
  `number`, so the safe-integer floor subsumes the mod-`2**64` wrap concern. Injectivity is over
  integer epoch *values*: `+0` and `-0` denote the same epoch and derive the same topic by design
  (both encode to salt `0n`), which is correct, not a collision.

`deriveTopicID` stays label-agnostic — it enforces structural injectivity of the join only. The
reserved-label policy belongs one layer up, in `@kumiai/rpc`, which owns the reserved labels.

### `protocolTopic(secret, epoch, protocol, scope)` — `@kumiai/rpc`

Reject a `protocol` label that falls in the framework's reserved namespace, i.e. any label beginning
with the reserved prefix `kumiai/`. All reserved labels (`INBOX_LABEL`, `COMMIT_LABEL`,
`RENDEZVOUS_LABEL`) start with that prefix, so the prefix rule separates host protocol topics from
every reserved-label topic kind — present and future — structurally, rather than by an unenforced
comment. Throw a plain `Error` naming the reserved prefix on violation. No checked-in protocol name is
under `kumiai/`, so this rejects no current caller; it does reject a host that names a protocol under
the framework prefix (see Compatibility) — the point being that such a name is exactly what would
collide a reserved kind.

### `discoveryTopic(memberDID)` — `@kumiai/rpc`

`discoveryTopic` does not call `deriveTopicID`; it is `toB64U(sha256(PREFIX ∥ SEP ∥ memberDID))`. With
a fixed prefix and a **single** variable component, the prefixed string is injective in `memberDID`
even when the DID contains a NUL — there is no component boundary to confuse — so a NUL rejection here
would be a gratuitous public-API break that closes no collision. Validate **well-formedness only**
(reject `!memberDID.isWellFormed()`), which is the one axis that can collapse two distinct DIDs onto
one public discovery topic. Do not reject NUL in `discoveryTopic`.

## Injectivity argument (preserved rationale)

Take a fixed `secret` and `epoch`. Under the contract, each string component is NUL-free, so joining
them on the NUL delimiter is uniquely decodable — the map `(label, scope) → info string` is injective.
UTF-8 encoding is a bijection on well-formed Unicode, so `info string → info bytes` is injective once
lone surrogates are rejected (confirmed: `TextEncoder` applies no normalization, emits no overlong
forms, and preserves a BOM as ordinary content). The reserved-namespace rule makes host protocol
labels disjoint from reserved labels, so different topic *kinds* never share a `(label, …)` prefix.
Therefore distinct validated derivations yield distinct HKDF `info`, hence distinct topics **modulo
HKDF/SHA-256 collision resistance** — the assumption the whole scheme already rests on. The guarantee
is at the `info` (pre-HKDF) layer; it is not a claim that the 32-byte HKDF output is mathematically
injective over unbounded input.

## Relationship to Spec C

Spec C (per-protocol inbox) derives from `(protocol, memberDID)`. Validating each component NUL-free
and well-formed is necessary but **not** sufficient on its own: an undelimited concatenation still
collides (`protocol="ab", did="c"` and `protocol="a", did="bc"` both give `"abc"`), and NUL-joining
them into the single `scope` slot would itself violate `deriveTopicID`'s NUL prohibition. So Spec C
must define a concrete injective composition — a delimiter the components are validated free of, or a
higher-arity primitive — not merely reuse the two-slot `scope`. Given that, and with host protocols
confined out of the reserved namespace, a per-protocol inbox stays injective and separated from the
plain inbox and control topics. Spec C builds on this validated primitive; it needs no re-encoding of
existing topics.

## Non-goals

- No topic-ID rotation, no migration protocol, no dual-read path.
- No change to HKDF parameters, secret derivation, epoch encoding, or the b64url output shape.
- No roster/DID *syntax* validation at the identity layer — this spec rejects the two byte-level
  hazards (NUL, lone surrogate) at the derivation boundary, not general DID well-formedness.
- The unrelated `@kumiai/broadcast` robustness items (unwrap ordering, backpressure, loopback
  semantics) stay in their backlog doc — out of scope.

## Compatibility

Non-breaking for every well-formed, non-reserved input: outputs are byte-identical, nothing rotates.
The change *does* newly reject inputs the public API accepts today — a NUL- or surrogate-bearing
`localDID`/`memberDID`, and a host protocol named under `kumiai/` — which today derive unsafe,
degenerate, or colliding topics. Turning those into a thrown `Error` is the intended correction, and
it is reachable now (unvalidated credential `id`, public `.to()`), so the change is worth making
independently of Spec C.

## Testing

- **`broadcast/test/topic.test.ts`** — reject: `\0` in `label`; `\0` in `scope`; lone surrogate in
  `label`; lone surrogate in `scope`; negative `epoch`; non-integer `epoch`; unsafe-integer `epoch`.
  Accept: representative valid inputs, and `+0`/`-0` deriving the same topic. **Regression pin:** a
  golden b64url for a fixed `(secret, epoch, label, scope)` stays unchanged — the direct proof that
  nothing rotates.
- **`rpc/test/topic.test.ts`** — `protocolTopic` rejects a `kumiai/`-prefixed protocol (covering the
  exact `INBOX_LABEL`/`COMMIT_LABEL`/`RENDEZVOUS_LABEL` cross-kind collisions); `inboxTopic` rejects a
  NUL-bearing and a lone-surrogate `memberDID`; `discoveryTopic` rejects a lone-surrogate DID but
  **accepts** a NUL-bearing DID (documenting the single-component rationale); `commitTopic`,
  `rendezvousTopic`, and a plain `protocolTopic` still derive their existing values (golden pins).
- **Reachability paths** — `createGroupPeer` with a NUL/surrogate `localDID` throws at init; a
  `.to(memberDID)` call with a NUL/surrogate DID throws.
- **Injectivity:** the reserved-label protocol collision and the NUL/surrogate collisions each now
  throw rather than producing a shared topic.
- **Layering boundary (documenting, not a guard):** a test asserting that a direct
  `deriveTopicID(secret, epoch, INBOX_LABEL, memberDID)` equals `inboxTopic(secret, epoch, memberDID)`
  — the bypass is intentional and lives below the rpc reservation; the helpers, not the primitive,
  carry domain separation.

## Milestone

The `deriveTopicID` NUL-injectivity item is already filed on
`docs/agents/plans/milestones/non-breaking-api.md`, conditioned "non-breaking *if fixed by
rejection*" — meaning no topic-ID rotation and no data migration, which this choice honours (see
Compatibility for the narrow class of newly-rejected inputs, which rotate nothing). On completion,
discharge it there. No milestone move is needed.
