# Per-protocol directed-inbox topics + protocol isolation — design

**Date:** 2026-09-03
**Packages (minor bump, coupled band):** `@kumiai/rpc` (inbox derivation in `topic.ts`, peer wiring,
the mux for rider 5) and `@kumiai/rpc-conformance` (isolation clauses). `@kumiai/broadcast` does **not**
change — `deriveTopicID` is already the injective primitive and the protocol-fold lives in rpc's
`inboxTopic` wrapper. Rider 5's real unsubscribe touches `@kumiai/hub-tunnel`/`@kumiai/hub-protocol`
only if the hub port lacks an unsubscribe operation today (to be checked in planning); the reference
`@kumiai/hub-server` cap is referenced, not changed.
**Depends on:** Spec B ([`deriveTopicID` injectivity](../../agents/plans/completed/2026-09-03-derivetopicid-injectivity.complete.md)) —
this design needs the injective primitive. Spec A ([AAD binding](../../agents/plans/completed/2026-09-02-mls-encrypt-aad.complete.md))
composes with it: once the inbox topicID carries protocol identity, Spec A's per-frame AAD separates
protocols for free.

This is Spec C of three, split out of the mls-encrypt-aad work.

## The defect

The peer builds **one** recipient-scoped directed-inbox topic —
`selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)` (`packages/rpc/src/peer.ts:573`) —
and attaches one acceptor **per protocol** to that single inbound path (`peer.ts:612`, all sharing
`inboxLane.path` at `:616`). `createOpenOncePath` opens each frame exactly once and fans the plaintext
to every registered listener (`packages/rpc/src/open-once.ts:60,66`). The single-inbox shape is
deliberate: it guarantees a frame is opened exactly once, which matters because an MLS `unwrap`
consumes a ratchet generation, so a second open would burn a generation or fail.

But the inbox topic names no protocol. A directed request for protocol A is therefore delivered to
protocol B's acceptor as well; if both define a compatible procedure name, both handlers run. There
is no authenticated protocol discriminator. Spec A's topic-context AAD does not fix this, because all
protocols on the shared inbox share the identical topic and epoch, so they share the identical AAD.

Scope note: the **app broadcast** topics (`protocolTopic(anchor.secret, anchor.epoch, name)`,
`peer.ts:586`) are already per-protocol and correct. This design changes only the **directed inbox**.

## The fix

Give each protocol its own directed-inbox topic. `inboxTopic` folds the protocol into the derivation,
called as a params object over Spec B's now-injective primitive:

```
inboxTopic({ secret, epoch, memberDID, protocol }) =
  deriveTopicID(secret, epoch, `${INBOX_LABEL}/${protocol}`, normalizeDID(memberDID))
```

where `INBOX_LABEL = 'kumiai/inbox/v1'`.

Injectivity, given Spec B: the protocol lives in the **label** as a fixed-prefix suffix
(`kumiai/inbox/v1/<protocol>`), which is injective in the protocol because the prefix is fixed; the
member DID lives in the **scope**. Two free components carry the two identities, so no two fields are
packed into one component — the exact non-injectivity Spec B closed is not reintroduced. The label
stays under the reserved `kumiai/` namespace, so it can never collide a host `protocolTopic`, whose
label is the bare host protocol name and which Spec B already rejects from the `kumiai/` namespace.

Consequences:

- Each protocol gets its **own** inbox path, hence its **own** open-once path — no double-open, because
  each protocol opens only its own frames.
- Cross-protocol delivery is structurally impossible: a frame for protocol A lands only on A's topic.
- With Spec A, the inbox topicID now carries protocol identity, so the per-frame AAD binding separates
  protocols with no extra work.

The **send** side changes symmetrically: a sender addressing a recipient computes the recipient's
**per-protocol** inbox topic. `resolveSendTopic` (`peer.ts:617`) and the directed-client send topic
(`peer.ts:705`) fold in the protocol the runtime belongs to.

**The inbox topic rotates — intended.** Changing the label from `kumiai/inbox/v1` to
`kumiai/inbox/v1/<protocol>` changes every inbox topic ID. This is the point of the change, and it is
safe where the app/commit rotation of Spec A/B would not have been: directed inbox traffic is transient
request/reply, not a retained log, so an in-flight directed frame stranded across the upgrade is retried
by its caller, with no durable history lost. App broadcast topics, the commit log, and the rendezvous
mailbox are all untouched, so nothing durable rotates.

## Riders

Each rider is a real failure the fix must handle, not optional polish.

### Rider 1 — anchor snapshot per runtime

The self topic is computed in `buildEpoch` from `anchor` (`peer.ts:573`), but `resolveSendTopic`
(`:617`) and the client send topic (`:705`) read the **mutable** shared `anchor` lazily, on every
call. `captureAnchor` mutates that shared variable by reassignment (`peer.ts:466`) and is called after
a roster-changing commit inside `advanceHandle` (`:1110`). So a send computed after a rotation can
derive a topic under the new anchor while the subscription was established under the old one.

Fix: each `ProtocolRuntime` captures **one** anchor snapshot at build time and derives its self-topic,
its `to()` send topic, and its `resolveSendTopic` from that snapshot, storing `{ topicID, path }` per
runtime. No runtime ever reads the mutable `anchor` after build.

### Rider 2 — DID normalization beyond topics

Use `normalizeDID` from `@kokuin/token` (defined at `node_modules/@kokuin/token/lib/did.js:323`;
already used across the mls layer for roster and credential comparison, e.g. `mls/src/roster.ts:47`,
`mls/src/credential.ts:154`). Do not invent a helper. Add `@kokuin/token` to `@kumiai/rpc`'s catalog
dependencies — it is currently absent (`rpc/package.json:39-51`).

Normalizing only the topic is insufficient. The directed client compares the MLS-recovered sender
against the **raw** `memberDID` (`directed.ts:120`); the directed server-session path compares raw too
(`directed.ts:307,315`); the app-lane self-echo keys on the **raw** `localDID` (`app-lane.ts:445`).
A client created with a long-form DID would reach the normalized topic but drop the reply when MLS
returns the short credential ID. Normalize at ingress and use the normalized form for the topic, every
DID equality check, and every DID-keyed cache — one canonical form throughout the peer.

### Rider 3 — `sealForSegment` seal race (transitioning barrier)

A roster-changing commit advances the handle before `captureAnchor` runs (`peer.ts:1110`).
`sealForSegment` can read the old anchor, seal under the new MLS epoch, and pass its post-seal identity
check before the anchor changes — producing a new-epoch frame published on the old segment topic, which
loses retained traffic for a newly added member. The post-seal check only catches an anchor that
changes **during** the seal, not a handle that moved just before it.

Fix (transitioning barrier, not a held mutex): mark the app segment "transitioning" **before**
`advanceHandle` moves the handle. A `sealForSegment` that observes the transition awaits the capture,
then seals against the new anchor/segment. A held mutex is avoided deliberately — draining a mutex in
teardown deadlocks when host callbacks run inside it.

### Rider 4 — rotation pairing scope

A per-runtime snapshot (rider 1) only covers the window after `captureAnchor` and before rebuild.
`teardownEpoch` (`peer.ts:627`) then disposes the old clients, acceptors, and directed sessions, so a
reply that arrives after rotation completes still misses.

Fix: scope the delivery guarantee to "capture occurred, old runtime not yet torn down," and add a
bounded drain of the old runtime before `teardownEpoch` disposes it, so an in-flight reply crossing a
rotation still lands. The drain is bounded so a stuck peer cannot hold rotation open.

### Rider 5 — subscription budget (safe drain-then-unsubscribe **and** a bounded guard)

Per-protocol inboxes multiply the durable topics per anchor segment from roughly `P + 1` to roughly
`2P`. The mux never unsubscribes (`hub-mux.ts:275`, no-op release at `:632`); the reference in-memory
hub caps subscriptions per DID at 1000 (`hub-server/src/memoryStore.ts:116`) and **rejects** — does not
evict — past the cap (`:436-438`).

The constraint that shapes this rider: the mux must **not** unsubscribe **app** topics.
`peer.ts:587-593` documents that unsubscribing tells the hub to drop the member's pending deliveries and
free any frame it was the last reader of — deleting unread messages for everyone. App/retention topics
therefore keep the never-unsubscribe contract untouched.

Fix (both parts):

1. **Safe drain-then-unsubscribe, inbox topics only.** Add a real unsubscribe to the mux, gated on the
   topic being fully drained and its local refcount reaching zero, and apply it **only** to per-protocol
   inbox topics on the epoch left behind — never to app/retention topics. This reclaims capacity on
   rotation. The unsubscribe is driven by the rider-4 teardown seam, after the bounded drain, so no
   in-flight inbox frame is dropped.
2. **Bounded budget guard.** Independently, track the peer's live subscription count per DID and fail
   loud — a clear, catchable error at the peer boundary — before the hub's own rejection would fire.
   This is the boundary safety net that holds even if reclamation lags or a host runs an unusually large
   protocol set.

The two parts are complementary: part 1 keeps steady-state topic count near `2P` by reclaiming stale
inbox topics; part 2 guarantees a legible failure rather than an opaque hub rejection if the bound is
ever approached.

## Non-goal

`discoveryTopic` (`rpc/src/topic.ts:95`) is a public raw SHA-256 construction, not a `deriveTopicID`
caller. It does not change here; Spec B only added its well-formedness check. Do not move it to a
secret-bearing HKDF derivation.

## Testing

- **Isolation (rpc-conformance):** a directed request for protocol A is delivered to A's handler and
  **not** to B's, even when both define a same-named procedure. Runs against the real implementation and
  the double.
- **Derivation (broadcast + rpc):** `inboxTopic` for distinct `(protocol, memberDID)` pairs yields
  distinct topics; a per-protocol inbox topic never equals a host `protocolTopic`; golden pins on the
  new derivation.
- **Rider 1:** a send issued after a simulated rotation uses the runtime's snapshot topic, not the
  mutated anchor.
- **Rider 2:** a client created with a long-form DID both reaches the normalized topic and receives the
  reply when MLS returns the short credential form; self-echo suppression holds across DID forms.
- **Rider 3:** a commit that adds a member during an in-flight seal never publishes a new-epoch frame on
  the old segment topic (the added member sees the retained traffic).
- **Rider 4:** a reply in flight across a rotation still lands; the drain is bounded (a stuck peer does
  not hang rotation).
- **Rider 5:** a drained old-epoch inbox topic is unsubscribed while app/retention topics are not; the
  budget guard raises a clear error before the hub cap would reject.

TDD throughout; every vitest step paired with `test:types`. Both conformance suites re-run against the
real implementation **and** the doubles, since the change touches the directed-inbox port surface and
the mux. Confirm `Cached: 0` on the forced test run.

## Verification plan

- Whole-branch review on the most capable model.
- At least one blind adversarial Codex review, briefed with the isolation and injectivity questions,
  never the expected answers.
- Golden pins recomputed independently to confirm the app broadcast topics did not rotate.

## Follow-ups anticipated

- If the bounded drain (rider 4) or safe unsubscribe (rider 5) proves too coupled to land cleanly, the
  fallback is the hybrid: enforce the budget guard in this branch and file safe drain+unsubscribe as a
  follow-up. This is a fallback, not the plan — the plan is both parts.
