# Spec B — `deriveTopicID` injectivity (with migration)

**Filed:** 2026-09-02, split out of the mls-encrypt-aad work when four review rounds showed it was a separate project. This is the open [broadcast robustness](../backlog/2026-07-07-broadcast-robustness.md) NUL-injectivity item, plus the constraints that make it non-trivial.

## The defect

`deriveTopicID` (`broadcast/src/topic.ts`) builds `info = fromUTF(PREFIX ∥ NUL ∥ label ∥ NUL ∥ scope)` — a NUL-joined concatenation with no count or length prefix. The split back into `(label, scope)` is not unique, so a NUL-bearing `label`/`scope`/protocol/DID can reproduce another derivation's exact `info`. Concretely, an inbox scope `h ∥ NUL ∥ memberDID` collides `protocolTopic` with `label = INBOX_LABEL ∥ NUL ∥ h`. If an app topic and an inbox topic collide, both open-once paths open the same ciphertext — the double-open defect MLS single-open exists to prevent.

## Why it is not a one-liner

1. **UTF-8 is already lossy.** `fromUTF` replaces lone UTF-16 surrogates with U+FFFD (`@sozai/codec` index.ts:175), so `"\uD800"` and `"\uD801"` encode to identical bytes. Count- and length-prefixing cannot recover a distinction already gone. A truly injective derivation must reject non-well-formed UTF-16 (or encode UTF-16 code units / WTF-8) **before** hashing.
2. **The principled fix rotates every topic ID.** Re-encoding `info` (e.g. `PREFIX ∥ u32be(count) ∥ per-component u32be(len) ∥ utf8`) changes every derived ID. But commit and rendezvous topics are **stable for the group's lifetime** (`rpc/src/topic.ts:58`) and epoch-independent so a stranded peer can re-derive them. Rotating those strands offline peers (they resubscribe to a new empty commit log, get no "ahead" evidence, never recover), makes pending-journal replay republish an old `expectedHead` onto a new log (false loss), and orphans retained app history and cursors (`app-lane.ts:226`, `app-cursor.ts:17`). A rolling deploy splits the commit/recovery plane entirely. "Everyone upgrades together" does not migrate retained hub data or offline peers.
3. **Epoch/length domains.** The epoch encoder uses `setBigUint64(BigInt(epoch))` — wraps mod 2⁶⁴ (epoch 0 == 2⁶⁴), and has no contract for negative/fractional/non-finite. A `u32be(len)` needs explicit rejection above `0xffffffff`.

## What the spec must decide

- Injective encoding **and** a UTF-16 well-formedness contract.
- Migration for durable control topics: preserve the legacy encoding for commit/rendezvous (and possibly app topics), or a dual-read/migration protocol — not a naked rotation.
- Epoch and length bounds/validation.

The choice of fix decides whether this stays breaking or can preserve durable IDs. Blocks Spec C (per-protocol inbox needs an injective primitive).
