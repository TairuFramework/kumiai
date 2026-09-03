# Protocol isolation on the directed inbox via an authenticated in-frame discriminator — design

**Date:** 2026-09-03
**Packages (minor bump, coupled band):** `@kumiai/rpc` (directed frame tagging + routing,
`normalizeDID` at ingress) and `@kumiai/rpc-conformance` (isolation clauses). Adds `@kokuin/token` to
`@kumiai/rpc`'s catalog deps. `@kumiai/broadcast`, `@kumiai/mls-rpc`, and the hub packages do **not**
change.
**Depends on:** Spec A ([AAD binding](../../agents/plans/completed/2026-09-02-mls-encrypt-aad.complete.md)) —
the directed frame is already MLS-sealed with AAD bound to the topic, which is what makes an in-payload
tag authenticated. Spec B ([`deriveTopicID` injectivity](../../agents/plans/completed/2026-09-03-derivetopicid-injectivity.complete.md))
is unaffected — this design does not change any topic derivation.

This is Spec C of three, split out of the mls-encrypt-aad work.

## History of this design

The original framing was "give each protocol its own inbox topic." An adversarial review of that
approach against source disproved its safety premises: the directed inbox is **mailbox class**, not
transient, so per-topic rotation and any old-topic unsubscribe silently drop undelivered directed
frames; the dominant subscription leak is the pre-existing never-unsubscribed app topics (~R×P across R
rotations and P protocols), which per-protocol inboxes would multiply without being able to reclaim;
and the per-runtime anchor snapshot introduced its own directed-send rotation race. The per-topic
approach was therefore rejected as disproportionate to the actual defect. This spec takes the lighter,
correct fix. The rejected riders (per-runtime snapshot, seal-race barrier, rotation drain, subscription
budget) are recorded under "Rejected alternatives" so the reasoning is not lost.

## The defect

The peer builds **one** recipient-scoped directed-inbox topic
(`selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)`, `packages/rpc/src/peer.ts:573`) and
attaches one acceptor **per protocol** to that single inbound path (`peer.ts:612`, all sharing
`inboxLane.path`). `createInboxPath` opens each frame once and fans the plaintext to every registered
consumer (`open-once.ts`, `directed.ts:49`). The inbound frame carries only a `sessionID` and a `kind`
(`decodeFrame`, `directed.ts:301`) — **no protocol identifier**.

So every protocol's acceptor, and every directed client, receives every opened frame on the inbox. The
consequences are worse than a name-collision edge case:

- **Double execution.** Each acceptor feeds its own `Server<Protocol>`. If two protocols define a
  procedure of the same name, both handlers run.
- **Spurious error replies (already broken today).** An enkaku `Server` fed a frame for a procedure it
  does not define **sends an error response** so the client rejects rather than hangs
  (`node_modules/@enkaku/server/lib/server.js:317-327`). With P protocols on the shared inbox, one
  directed request produces one real reply and up to P−1 error replies racing back — an error reply can
  even win, so multi-protocol directed RPC is already flaky, not merely on name collision.
- **Reply cross-delivery.** A directed client filters inbound frames only by authenticated `senderDID`
  and topic (`directed.ts:120`). Two protocols talking to the **same** member both match that member's
  reply, so both clients receive it.

Spec A's AAD does not separate them, because all protocols share the identical inbox topic and epoch,
hence the identical AAD.

Scope note: the **app broadcast** topics (`protocolTopic(anchor.secret, anchor.epoch, name)`,
`peer.ts:586`) are already per-protocol and correct. This defect is confined to the **directed inbox**.

## The fix

Route each directed frame to exactly one protocol using an **authenticated in-frame protocol
discriminator**, keeping the single shared inbox topic unchanged.

**Where the tag lives.** The directed payload sent to `crypto.wrap` is the enkaku hub-tunnel frame
(`directed.ts:100`, `:210`). Prepend a protocol tag to that payload **before** the seal, so the tag is
inside the MLS-sealed ciphertext and authenticated to the sender's MLS identity. On open, the recovered
plaintext is `tag ∥ frame`; strip the tag, and each consumer processes only frames whose tag matches
its own protocol.

**Encoding.** A small fixed header, unambiguous by construction (the Spec B injectivity lesson — never
an ambiguous join):

```
directedPayload = VERSION(1 byte) ‖ varuint(len(protocolUTF8)) ‖ protocolUTF8 ‖ frameBytes
```

`VERSION` is a format marker so a peer can distinguish a tagged frame from a legacy untagged one and
reject the legacy frame cleanly, rather than misparsing its bytes as a bogus tag length. The
length-prefixed protocol name makes the `protocol ∥ frame` split injective regardless of the name's
content.

**Why inside the seal.** If the tag were outside the seal (plaintext beside the ciphertext), a lying
hub could flip it and misroute a frame onto the shared inbox key — B's acceptor would open A's frame
(same epoch key) and run it. Inside the seal, the tag is covered by the AEAD, so neither the hub nor a
non-member can alter or forge it. A group member can only tag their **own** frames, and only for a
protocol they are already entitled to call, so there is no privilege boundary to cross — the tag is an
accidental-cross-delivery and reply-routing fix, over an authenticated channel, not an authorization
mechanism.

**Receive routing.** `createInboxPath`'s projection strips the header and surfaces the decoded
`protocol` on `OpenedInbound`. Then:

- The inbox acceptor for protocol X processes a frame only when `opened.protocol === X`; otherwise it
  ignores it. So a non-owning `Server` is never fed the frame and never emits a spurious error reply.
- A directed client for `(protocol X, member M)` accepts an inbound frame only when
  `opened.protocol === X` **and** the authenticated sender is `M`. So replies route to exactly the one
  client that issued the request, even when several protocols talk to the same member.

**Send.** Both publish sites (`directed.ts:100` client, `:210` acceptor session) prepend the header for
the protocol the client or acceptor belongs to. The protocol name is known where each is created.

No topic derivation changes; AAD stays `fromUTF(topicID)`. Capacity, rotation, and the app-topic
lifecycle are untouched.

## Rider — DID normalization at ingress (kept, independent correctness fix)

Raw-DID comparison is a latent bug regardless of the isolation fix. `detectRosterChange` compares raw
DID string sets (`packages/rpc/src/roster.ts:22`), so a member whose DID appears in one form on one
epoch and an equivalent form on another would register as a false roster change (or mask a real one);
the directed sender compare (`directed.ts:120`), the directed server-session compares
(`directed.ts:307,315`), the app-lane self-echo (`app-lane.ts:445`), the directed cache key
(`peer.ts:696`), and commit classification (`classify.ts:286`) all compare raw DIDs; broadcast gather
deduplicates and counts quorum by the raw recovered DID (`@kumiai/broadcast/src/client.ts:142,154`).

Fix: use `normalizeDID` from `@kokuin/token` (the function the mls layer already uses for roster and
credential comparison, e.g. `mls/src/roster.ts:47`, `credential.ts:154`; do not invent a helper) and
apply it at **ingress**:

- Normalize every DID recovered from the crypto/MLS port as it enters rpc — the open's recovered
  `senderDID`, `committerDID`, and `rosterDIDs()` — so all downstream consumers (directed, app-lane,
  roster, classify, and the broadcast gather that opens through rpc's adapter) receive canonical
  strings. This keeps the port contract and the doubles unchanged: rpc is robust to whatever form the
  port returns.
- Normalize caller-supplied DIDs at their entry points: `localDID` at peer construction and `memberDID`
  at `.to()`.

For the real MLS implementation a valid `did:peer:4` credential already carries the short ID matching
its long form (`mls/src/authentication.ts:53`), so this mainly canonicalizes caller-supplied long forms
and hardens rpc against conforming doubles or alternate implementations that do not promise canonical
strings. Add `@kokuin/token` to `@kumiai/rpc`'s catalog dependencies (currently absent,
`rpc/package.json:39-51`).

## Mixed-version deployment

The directed payload format changes (the `VERSION` header). Group peers on independently-upgrading
devices can therefore straddle versions during a rollout: an upgraded peer receiving a legacy untagged
frame rejects it via the version marker, and a legacy peer receiving a tagged frame fails to decode it.
Either way the affected directed request is dropped, and because the inbox is mailbox class a dropped
frame is not redelivered.

Stance: **hard cutover**, consistent with Spec A's pre-1.0 deliberate invalidation of retained history
and the coupled version band. All group peers must reach this version together; a straddled window
drops cross-version directed RPC. The `VERSION` marker guarantees the failure is a clean drop with a
legible cause, never a silent misroute onto the shared key. This is documented as a pre-1.0 upgrade
requirement, not smoothed over with a dual-format transition, because a dual-format path would reopen
the very cross-delivery this change closes for the duration of the window.

## Non-goals

- **Per-protocol inbox topics** — rejected (see "Rejected alternatives"). No topic derivation changes.
- **Transport/hub-level metadata separation.** All protocols still share one inbox topic, so the hub
  sees one directed lane per member. The hub already cannot read the opaque, secret-derived topic or its
  sealed frames; distinguishing protocols at the hub was never the defect. The isolation guarantee here
  is that handler execution and reply routing are confined to the owning protocol.
- **`discoveryTopic`** (`rpc/src/topic.ts:95`) is unchanged.
- **The pre-existing app-topic subscription leak** (~R×P, never unsubscribed by design because
  unsubscribing an app/log topic drops unread messages for everyone) is out of scope. This design does
  not touch it, worsen it, or depend on it. It is noted here so a future capacity/hub-lifecycle spec can
  pick it up.

## Testing

- **Isolation (rpc-conformance), against the real implementation and the double:**
  - Two protocols defining a same-named procedure: a directed call to A runs A's handler and **not**
    B's.
  - The caller of A receives A's single reply and **no** spurious error reply from B's server.
  - Two protocols to the same member: each protocol's client receives only its own reply.
- **Tag authenticity:** a frame tagged for protocol A is never routed to protocol B; a corrupted or
  flipped header does not cause cross-routing (it fails the AEAD open or the version check).
- **Encoding:** the `VERSION ‖ len ‖ protocol ‖ frame` header round-trips; a protocol name containing
  arbitrary characters (including `/`) is recovered exactly; a legacy untagged frame is rejected by the
  version marker, not misparsed.
- **Rider 2:** a peer given a member DID in long form both addresses it and matches its replies when MLS
  returns the short credential form; `detectRosterChange` does not fire on an equivalent-form flip;
  self-echo suppression holds across DID forms.

TDD throughout; every vitest step paired with `test:types`. The rpc-conformance suite runs against the
real implementation **and** the double, since the change is on the directed-inbox port surface. Confirm
`Cached: 0` on the forced test run.

## Verification plan

- Whole-branch review on the most capable model.
- At least one blind adversarial Codex review, briefed with the isolation and authentication questions,
  never the expected answers.
- Confirm no topic ID rotated (no derivation changed) — the app broadcast, commit, and rendezvous
  topics are byte-identical.

## Rejected alternatives

- **Per-protocol inbox topics.** `inboxTopic` would fold the protocol into a reserved-namespace label.
  Rejected: the directed inbox is mailbox class (`hub-server/src/memoryStore.ts:99`), so rotating the
  inbox topic drops undelivered frames (a publish with no current subscriber is dropped outright,
  `memoryStore.ts:246`) and any old-topic unsubscribe deletes the recipient's pending deliveries
  (`memoryStore.ts:470`). The associated riders each proved to demand something unattainable:
  - *Per-runtime anchor snapshot* fixed one mutable-anchor race but created another — a frame sealed at
    the new MLS epoch published on the old-anchor inbox topic that a newly added recipient never
    subscribed to.
  - *Seal-race transitioning barrier* could not be made both race-free and deadlock-free, because
    `advanceHandle` awaits a host-supplied, reentrant `onAccepted` (`peer.ts` warns of this).
  - *Rotation drain (rider 4)* could not be lossless: there is no per-topic drain marker and handlers
    are fire-and-forget, so a bounded drain cannot prove quiescence and an unbounded one hangs rotation.
  - *Subscription budget (rider 5)* could neither reclaim safely (mailbox unsubscribe loses data) nor
    guarantee failing before the hub cap (the cap is configurable and no query exposes the live count),
    and the dominant leak is the app topics it cannot touch.
- **Procedure-name collision guard only.** Rejecting a peer whose protocols share a procedure name would
  stop double execution but not the spurious error replies or reply cross-delivery, because every
  non-owning `Server` is still fed every frame. Insufficient.
