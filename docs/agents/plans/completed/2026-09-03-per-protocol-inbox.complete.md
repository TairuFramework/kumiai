# Protocol isolation on the directed inbox — complete

**Status:** complete
**Completed:** 2026-09-03
**Packages (minor bump, coupled band):** `@kumiai/rpc` only. No `GroupCrypto`/`GroupMLS` port-contract
change, so the port conformance suites (`rpc-conformance`, `hub-conformance`) were untouched — this is
peer/integration behaviour. Adds `@kokuin/token` to `@kumiai/rpc`'s catalog deps.

This was Spec C of three, split out of the mls-encrypt-aad work. It builds on Spec A
([AAD binding](./2026-09-02-mls-encrypt-aad.complete.md) — the directed frame is already MLS-sealed
with AAD bound to the topic, which is what makes an in-payload tag authenticated) and Spec B
([`deriveTopicID` injectivity](./2026-09-03-derivetopicid-injectivity.complete.md) — the
never-an-ambiguous-join lesson the tag encoding follows). Neither topic derivation changed here.

## Goal

Directed 1:1 RPC frames for every protocol shared one per-member "inbox" topic, and the frame carried
no protocol identifier, so every protocol's acceptor received every frame. Route each directed frame
to exactly one protocol, without changing any topic derivation.

## The defect (what was actually broken)

The peer built **one** recipient-scoped directed-inbox topic and attached one acceptor **per
protocol** to that single inbound path. The consequences were worse than a name-collision edge case:

- **Double execution** — two protocols defining a same-named procedure both ran their handler.
- **Spurious error replies (already broken before this change)** — an enkaku `Server` fed a
  request-like frame for a procedure not in its protocol writes an `INVALID_MESSAGE` reply carrying
  the original request ID; the originating client rejects on it. With P protocols on the shared
  inbox, one directed request produced one real reply and up to P−1 error replies racing on the same
  request ID — an error could win, so multi-protocol directed RPC was already flaky.

Spec A's AAD did not separate them, because all protocols shared the identical inbox topic and epoch,
hence the identical AAD.

## Key design decisions (preserved)

- **Authenticated in-frame protocol discriminator, not a per-protocol topic.** A protocol tag is
  prepended to the directed payload **inside** the MLS seal (before `crypto.wrap`), so it is covered
  by the AEAD and bound to the sender's MLS identity. The shared open-once path decodes the tag once
  and surfaces the protocol; each acceptor and directed client processes only frames tagged for its
  own protocol. The single shared inbox topic is unchanged.

- **Why inside the seal.** Outside the seal, a lying hub could flip the tag and misroute a frame onto
  the shared inbox key — another protocol's acceptor would open it (same epoch key) and run it.
  Inside, neither the hub nor a non-member can alter or forge it. A member can tag only their own
  frames and may select any protocol, but since every member may already call every protocol on the
  shared inbox there is no privilege boundary to cross. The tag is an accidental-cross-delivery and
  reply-routing fix over an authenticated channel, not an authorization mechanism (`Server` is
  `requireAuth: false`).

- **Per-protocol inbox topics were rejected.** The directed inbox is **mailbox class**: a publish
  with no current subscriber is dropped outright, and any old-topic unsubscribe deletes the
  recipient's pending deliveries. So rotating the inbox topic per protocol, or unsubscribing an old
  one, silently loses undelivered directed frames. Every rider that approach needed (per-runtime
  anchor snapshot, a seal-race barrier, a rotation drain, a subscription budget) proved to demand
  something unattainable. The in-frame tag is the lighter, correct fix — no topic change, no
  rotation, no capacity/mixed-version-topic fallout.

- **Encoding is unambiguous by construction** (the Spec B lesson): `VERSION(1 byte = 0x00) ‖
  len(protocolUTF8) as fixed-width uint16 BE ‖ protocolUTF8 ‖ frameBytes`. Fixed-width length (the
  repo has no varuint primitive; matches `commit-frame.ts`). `0x00` is not a legal JSON leading byte,
  so a tagged frame is distinguished from a legacy `JSON.stringify` frame (which starts `{`) by the
  first byte alone — a mixed-version legacy frame is dropped, never misrouted. The encoder rejects a
  name whose UTF-8 exceeds the uint16 cap; the decoder rejects a truncated header, an overrunning
  length, or an ill-formed-UTF-8 name.

- **Failure legibility: default timeout + unrouted-tag NACK.** With per-protocol filtering, a frame
  tagged for a protocol this peer does not serve is fed to no acceptor and would be silently dropped
  (regressing the old unknown-procedure `INVALID_MESSAGE` reply). Two mechanisms restore legibility,
  each with an honestly-bounded reach:
  - A default directed-client `requestTimeoutMs` so a dropped or unrouteable **unary** request
    rejects rather than hanging (overridable). Enkaku applies it to unary only.
  - A single peer-level **unrouted-tag NACK** responder — constructed without a `Server`, it decodes
    the inner hub-tunnel frame and publishes an `INVALID_MESSAGE`-class error reply. Three constraints
    each of which if broken makes it worse than nothing: **echo the caller's unrouted tag** (else the
    caller's own protocol filter drops it); **only NACK request-like frames** (`typ ∈ {request,
    stream, channel, send}` with a string `rid` — a reply also carries an `rid`, and NACKing one lets
    two peers that both lack the tag volley errors forever); **use a fresh, non-stale session seq on
    the offending frame's sessionID** (the caller's tunnel locks to that session and drops a stale
    seq).

- **DID normalization at ingress (independent rider).** `normalizeDID` from `@kokuin/token` (the
  function the mls layer already uses) is applied where every MLS-recovered or caller-supplied DID
  enters rpc — the open's recovered `senderDID`, `committerDID`, `rosterDIDs()`, and caller-supplied
  `localDID`/`memberDID` — so all downstream compares and cache keys see canonical strings. This
  fixes latent raw-DID comparison bugs (a false roster change on an equivalent-form flip, a directed
  reply dropped when a long-form caller's DID meets the short credential form, self-echo suppression
  across forms). `normalizeDID` **canonicalizes, it does not validate** — validation was never this
  rider's job. Because `inboxTopic` derives from the DID, normalizing before derivation **converges**
  a long-form caller onto the same short-form inbox topic; where short-form credential IDs are
  already universal this is a no-op and no live topic moves (pinned by a golden test). The one
  hub-asserted `senderDID` in commit context is left raw deliberately — it is auxiliary, never an MLS
  authorization input.

- **Mixed-version is a hard cutover**, consistent with Spec A's pre-1.0 stance and the coupled
  version band. All group peers must reach this version together. A wire-format mismatch drops (the
  version byte prevents any misroute); a long-form-DID topic mismatch means the two sides never meet.

## What was built

- `@kumiai/rpc` — a directed-payload tag codec (`directed-tag.ts`); tag decode on the shared
  open-once inbound path; per-protocol tag+filter on the directed client and inbox acceptor, with the
  protocol name threaded from the peer; the peer-level unrouted-tag NACK responder and a default
  directed request timeout; `normalizeDID` at every rpc ingress.
- Tests: peer-level integration tests driving two protocols through `createGroupPeer` (same-named
  procedure runs only the addressed protocol; caller gets one reply and no spurious error reply; two
  protocols to one member each get only their own reply); tag authenticity and encoding round-trip
  (incl. `/`-containing and multibyte names, legacy-frame rejection, over-length/truncated/non-UTF-8
  rejection); failure-legibility tests (unrouted unary rejects via NACK fast, not on the timeout; no
  NACK ping-pong; timeout backstop + override); Rider tests (long-form addressing/reply-matching,
  no false roster change on equivalent-form flip, self-echo across forms, short-form inbox-topic
  golden pin proving no rotation).

## Verification

TDD throughout, every vitest step paired with `test:types`. Final forced run: `@kumiai/rpc` 448 tests,
biome clean, build emits no test modules into `lib/`. Each task passed its own spec+quality review; a
whole-branch review on the most capable model confirmed all cross-cutting invariants (seal boundary,
single-open ratchet invariant, NACK↔isolation loop-safety, DID-compare consistency, rotation
lifecycle, legacy drop, scope). One blind adversarial Codex review of the implemented branch
independently confirmed the core sound (isolation, tag authenticity on all three seal paths, no
ping-pong, DID-normalize consistency, unchanged topics, unambiguous encoding) and surfaced two real
low-severity best-effort-path issues, both since fixed (see follow-ups).

## Follow-ups

- **NACK hardening applied in-branch (from the Codex review):** the NACK's seal+publish is now
  serialised through a tail promise so publishes happen in seq-assignment order (a concurrent-request
  reorder no longer loses a NACK to a stale-seq drop) and at most one seal runs at a time (bounding
  the per-frame work a member can induce); and the NACK is sealed under a single anchor snapshot via a
  `sealDirectedReply` helper mirroring the app lane's `sealForSegment`, so a rotation mid-seal cannot
  publish new-epoch ciphertext onto the old inbox topic. A residual head-of-line stall under
  continuous rotation is inherent to the `sealForSegment` re-read pattern and degrades to the request
  timeout, not below baseline — accepted as designed.

- **Accepted residual (hard-cutover cost, not a defect):** the default timeout is unary-only, and a
  legacy (pre-upgrade) caller has no such default, so a dropped **stream/channel creation** and any
  **legacy→upgraded straddled** call can still hang until the peer upgrades. This is the accepted cost
  of the hard cutover — a dual-format transition was rejected because it would reopen the cross-
  delivery this change closes for the window's duration. A future legibility improvement would default
  a caller-supplied abort signal for stream/channel creation.

- **Out of scope, deferred to existing tracking:** the pre-existing never-unsubscribed app-topic
  subscription leak (~R×P), and session accumulation / session-end stranding on the directed lane, are
  both untouched here and already carried by [directed lane — session accumulation and minor
  cleanups](../backlog/rpc-directed-lane.md) and a future capacity/hub-lifecycle spec.
