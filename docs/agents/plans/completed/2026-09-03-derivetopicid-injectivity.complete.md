# `deriveTopicID` injectivity via rejection — complete

**Status:** complete
**Completed:** 2026-09-03
**Packages (patch, no API-shape change):** `@kumiai/broadcast`, `@kumiai/rpc`
**Milestone discharged:** the `deriveTopicID` NUL-injectivity item on
[non-breaking API work](../milestones/non-breaking-api.md) — fixed by rejection, the branch the item
was filed against.

This was Spec B of three. Spec A ([AAD on group app-message crypto](./2026-09-02-mls-encrypt-aad.complete.md))
shipped 2026-09-03. Spec C ([per-protocol inbox](../next/2026-09-02-per-protocol-inbox.md)) remains
in `next/` and is now unblocked — it needs the injective primitive this work delivers.

## Goal

Make topic derivation injective — no two distinct derivations produce the same topic ID — without
rotating any existing topic ID. `deriveTopicID` built its HKDF `info` as `PREFIX ∥ NUL ∥ label ∥ NUL
∥ scope`, a NUL-join with no length prefix; the split back into `(label, scope)` was not unique, so a
NUL-bearing or non-well-formed component could reproduce another derivation's exact `info` and two
open-once paths would open the same ciphertext — the double-open the MLS single-open exists to
prevent.

## Key design decisions (preserved)

- **Rejection, not re-encoding.** A NUL-join is injective *iff* every component is NUL-free and
  well-formed UTF-16. Enforcing that as a contract — and throwing otherwise — closes the hole while
  leaving the derivation math untouched, so every already-derived topic ID is byte-identical: no
  rotation, no migration, the durable commit/rendezvous control plane and retained app history all
  preserved. Re-encoding the `info` (length-prefixing) is the more general fix but rotates every
  topic ID — a data break stranding offline peers and orphaning retained logs — and buys nothing,
  because topic components are always text, never arbitrary bytes.

- **Two lossy axes, both closed.** (1) A literal `\0` in a component forges the split — rejected by a
  NUL check. (2) `fromUTF` is a WHATWG `TextEncoder`, which maps a lone UTF-16 surrogate to U+FFFD, so
  two distinct strings could encode identically — rejected by `String.prototype.isWellFormed()`.
  UTF-8 is a bijection on well-formed Unicode, so once lone surrogates are rejected the
  `string → bytes` step is injective (no normalization/overlong/BOM hazard).

- **Reserved-label domain separation is enforced, not asserted.** The original code *claimed* in a
  comment that the reserved inbox label "never collides with an application protocol of the same
  name", but nothing stopped a host from naming a protocol `kumiai/inbox/v1`; since inbox and protocol
  topics derive from the same secret and epoch, that was a real cross-kind collision needing no NUL at
  all. `protocolTopic` now rejects any host protocol under the reserved `kumiai/` prefix, which covers
  every reserved label present and future. The check lives in `@kumiai/rpc` (which owns the reserved
  labels); `deriveTopicID` in `@kumiai/broadcast` stays label-agnostic, validating only structural
  injectivity of the join — the reserved-label callers (inbox/commit/rendezvous) pass through it
  unrejected.

- **Epoch bounded to a non-negative safe integer.** The real injectivity limit is `2^53`, not
  `2^64`: two intended epochs at or above `2^53` round to one float before the `BigInt` salt encoding
  and would collide. `+0` and `-0` are the same epoch by design (both salt `0n`), not a collision.
  This fails closed and, in doing so, replaced a pre-existing *silent* collision (see the follow-up
  below).

- **`discoveryTopic` validates well-formedness only.** It is a single-component sha256 after a fixed
  prefix, injective in the DID regardless of NUL, so it keeps accepting NUL DIDs; only lone surrogates
  (which would collapse two DIDs onto one public discovery topic) are rejected.

- **Guarantee scope.** The guarantee is at the pre-HKDF `info` layer, modulo HKDF/SHA-256 collision
  resistance. `deriveTopicID` is exported and label-agnostic, so a caller bypassing the rpc helpers
  can deliberately reproduce a helper's tuple — that is the layering boundary, not a defect; the
  helpers carry domain separation.

## What was built

- `@kumiai/broadcast` — `deriveTopicID` validates `label`/`scope` (NUL-free + well-formed UTF-16) and
  `epoch` (non-negative safe integer) before any derivation; cheap reject, no compute waste.
- `@kumiai/rpc` — `protocolTopic` rejects the reserved `kumiai/` namespace; `discoveryTopic` rejects
  lone surrogates; the `inboxTopic` doc-comment now points at the enforced separation instead of
  claiming it.
- Tests: rejection cases for every axis; literal golden pins (broadcast and rpc `commitTopic`)
  proving no rotation; peer-path reachability tests driving malformed DIDs through `createGroupPeer`
  init and `.to()`, asserting the rejection originates in the topic guard (`/scope/`).

## Verification

TDD throughout, every vitest step paired with `test:types`. Final forced runs: `@kumiai/broadcast`
63, `@kumiai/rpc` 427, all `Cached: 0`; biome clean. Two independent adversarial Codex reviews of the
spec (the first found the unenforced reserved-label collision, fixed with the namespace rule) plus one
blind Codex review of the implemented branch, which found no injectivity bypass and independently
recomputed both golden pins — confirming zero rotation a second time. A whole-branch review on the
most capable model reached the same verdict.

## Follow-ups

- **[Topic-epoch uint64 cap](../backlog/2026-09-03-topic-epoch-uint64.md)** — MLS epochs are uint64
  (`bigint`), narrowed to `number` before the topic API; the safe-integer guard rejects epochs at or
  above `2^53`. It fails closed and fixed a pre-existing silent collision, and `2^53` is ~9
  quadrillion commits away, so this is a long-horizon completeness limit, not a reachable defect.
  Full uint64 support needs `bigint` carried through the topic API — a breaking change to take only
  alongside other breaking work.
- **Test hygiene (minor):** the two init-reject reachability tests construct a peer whose `resync()`
  rejects and never dispose it (its control-lane subscriptions are established before the throw).
  Confirmed harmless — `FakeHub` sets no timers and holds no libuv handle, so nothing keeps the loop
  alive and it is GC-eligible — but a `try/finally { await peer.dispose() }` in the harness helper
  would close it if that helper is reused.
