# AAD on the group application-message crypto, bound to topic context — complete

**Status:** complete
**Completed:** 2026-09-03
**Packages (minor bump):** `@kumiai/mls`, `@kumiai/rpc`, `@kumiai/mls-rpc`, `@kumiai/rpc-conformance`
**Milestone discharged:** the `@kumiai/mls` "AAD on `GroupHandle.encrypt`/`decrypt`" item of
[pre-1.0 breaking API surface](../milestones/pre-1.0-breaking-api.md) — the change that had to come
first before any rpc-side AAD binding.

This was Spec A of three. Spec B ([`deriveTopicID` injectivity](../next/2026-09-02-derivetopicid-injectivity.md))
and Spec C ([per-protocol inbox](../next/2026-09-02-per-protocol-inbox.md)) remain filed in `next/`.

## Goal

Thread MLS `authenticated_data` (AAD) through `GroupHandle.encrypt`/`decrypt` and the `@kumiai/rpc`
`GroupCrypto` `wrap`/`unwrap` port, and bind every application frame to the topicID it is published
on, so a frame sealed for one topic cannot be opened on another. This closes cross-topic replay: a
frame captured on topic A and replayed onto topic B previously opened cleanly, because a sealed
frame carried no cryptographic binding to where it belonged.

## Key design decisions (preserved from the spec)

- **Topic binding is receiver-enforced.** ts-mls reconstructs the AEAD's AAD from the frame's own
  carried `authenticatedData`, so a byte-for-byte replay still opens cryptographically. The topic
  binding is enforced by the *receiver* comparing the frame's carried AAD against the topic it
  expects. The sender binds `AAD = fromUTF(topicID)` at every wrap site; the receiver passes
  `expectedAAD = fromUTF(<same topicID>)` at every unwrap site. No topic derivation changed — the
  bound value is the topicID as derived today, encoded to bytes.

- **Pre-open comparison, to avoid a ratchet-burn DoS.** `decrypt` reads the frame's cleartext
  `authenticatedData` from the decoded `PrivateMessage` and compares it to `expectedAAD` **before**
  `mlsProcessMessage` runs. `processMessage` accepts no externally-expected AAD, so a comparison
  done *after* the open would have consumed a ratchet generation and mutated handle state — a
  wrong-topic frame would be a ratchet-burning denial of service rather than a cheap reject. The
  compare joins the existing pattern that reads the sender leaf index before opening so a frame that
  then fails to open has cost nothing. `readPrivateFrame` was widened to surface
  `authenticatedData` (confirmed safe: `readSenderLeafIndex` ignores extra fields and commit
  processing uses a separate path).

- **The rpc port is verify-only.** `GroupUnwrapResult` stays `{ payload, senderDID }` and never
  echoes AAD. rpc enforces the binding by passing `expectedAAD` at every unwrap site; no caller
  needs the AAD back, and widening the result would break every double and contradict its
  never-widen doctrine. The mls layer still always returns the frame's `AAD` on a successful open;
  the rpc port drops it.

- **Two wiring patterns.** Fixed-topic lanes (app live/retained, inbox receive) know their topic
  when the lane is built, so rpc hands broadcast a topic-bound unwrap adapter and broadcast stays
  generic. Directed lanes choose a destination per call, so they call the two-argument
  `crypto.wrap`/`unwrap` directly, binding `publishParams.topicID`. The app seal side
  (`sealForSegment`) computes the segment/anchor topic first and binds those exact bytes; the
  drain's `expectedAAD` is the cursor's authoritative topicID, not the current MLS epoch.

- **Unconditional-enforcement rollout; retained history deliberately invalidated.** AAD lives in the
  frame, not the topic, so no topic rotation. But the app *retained* log is durable and a
  pre-upgrade retained frame has empty AAD. An upgraded drain enforcing `expectedAAD` rejects such a
  frame, marks it dead, and permanently advances the durable cursor past it — so pre-upgrade
  retained app history is dropped when a reader upgrades. Accepted at pre-1.0 over a compatibility
  window: enforcement is unconditional and the code carries no legacy empty-AAD acceptance path. The
  commit/recovery plane is untouched (that is Spec B).

## What was built

- `@kumiai/mls` — `GroupHandle.encrypt(plaintext, { AAD? })` and
  `decrypt(message, { expectedAAD? })` returning `{ payload, senderDID?, AAD }`, with the pre-open
  compare; `PrivateCommitFrame` and `readPrivateFrame` surface `authenticatedData`.
- `@kumiai/rpc` — `GroupCrypto` `wrap`/`unwrap` gain AAD; directed lanes, the app live lane, inbox
  receive, and the app retained drain each bind their topicID.
- `@kumiai/mls-rpc` — the real port implementation delegates AAD to the handle (drops the returned
  AAD, per verify-only).
- `@kumiai/rpc-conformance` — AAD round-trip, mismatch-throws, pre-open ratchet-preservation, and
  empty-default clauses, run against the real implementation **and** the double, plus an
  impl-agnostic tamper clause.
- The double (`fake-crypto`) carries the AAD in its frame and authenticates it with a keyed,
  non-linear tag over the whole body **including the epoch**, verified before the `expectedAAD`
  compare and before the spent-set insertion.

## Verification

TDD throughout; every vitest step paired with `test:types`. Both conformance suites green against
the real implementation and the double. Final fresh runs: `@kumiai/rpc` 417, `@kumiai/mls` 516,
`@kumiai/mls-rpc` 54.

Three blind Codex adversarial rounds followed the task reviews. The first two each found a real
test-doubles strictness violation in the double — its original XOR "tag" was malleable, then a
residual left a keyless cross-epoch translation forgery — both fixed (keyed tag, epoch folded into
the tag input) with regression tests; the third confirmed closure. Production AAD paths were
reconfirmed correct and pre-open-safe in every round; the defects were confined to the double
under-modelling AEAD non-malleability, which would have hollowed out the conformance guarantee.
