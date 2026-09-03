# Protocol isolation on the directed inbox via an authenticated in-frame discriminator — design

**Date:** 2026-09-03
**Packages (minor bump, coupled band):** `@kumiai/rpc` (directed frame tagging + routing, the
unrouted-tag NACK, the default directed timeout, `normalizeDID` at ingress) and its peer-level tests.
Adds `@kokuin/token` to `@kumiai/rpc`'s catalog deps. `@kumiai/broadcast`, `@kumiai/mls-rpc`,
`@kumiai/rpc-conformance`, and the hub packages do **not** change — this is peer/integration behavior,
not a `GroupCrypto`/`GroupMLS` port-contract change, so the port conformance suites are untouched.
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
consumer (`open-once.ts`, `directed.ts:49`). `decodeFrame` exposes the enkaku hub-tunnel envelope —
`sessionID`, `seq`, and the body including `payload.rid` (`hub-tunnel/frame.ts:60,67`) — but **no
protocol identifier**.

So every protocol's acceptor, and every directed client, receives every opened frame on the inbox. The
consequences are worse than a name-collision edge case:

- **Double execution.** Each acceptor feeds its own `Server<Protocol>`. If two protocols define a
  procedure of the same name, both handlers run.
- **Spurious error replies (already broken today).** An enkaku `Server` fed a request-like frame for a
  procedure not in its protocol fails the message validator and writes an `INVALID_MESSAGE` response
  carrying the original request ID (`node_modules/@enkaku/server/lib/server.js:227,253`). The
  originating client locates its controller by that request ID and rejects on the error response
  (`client.js:260`). With P protocols on the shared inbox, one directed request produces one real reply
  and up to P−1 error replies on the same request ID racing back — an error reply can win, so
  multi-protocol directed RPC is already flaky, not merely on name collision.
- **Wasted reply fan-out.** A directed client filters inbound frames at the outer fan-out only by
  authenticated `senderDID` and topic (`directed.ts:119`), so two protocols talking to the **same**
  member both receive that member's reply at the fan-out. This is not by itself a correctness failure —
  each client tunnel has a random session ID and drops a mismatched session before enkaku sees it
  (`hub-tunnel/transport.ts:403`), and enkaku settles a reply only against a request ID present in that
  client's controller map (`node_modules/@enkaku/client/lib/client.js:261`), so ordinary cross-settlement
  needs both a session-ID and a request-ID collision (random, effectively never). The tag removes the
  wasted delivery and adds domain separation, but the standing correctness bugs are the two above.

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
directedPayload = VERSION(1 byte) ‖ len(protocolUTF8) as fixed-width uint16 BE ‖ protocolUTF8 ‖ frameBytes
```

- **Fixed-width length, not a varuint.** `@sozai/codec` exposes only UTF-8 and base64 helpers
  (`node_modules/@sozai/codec/lib/index.d.ts`), no varuint or length-prefix primitive; the repo's own
  binary formats use fixed-width lengths (e.g. `packages/rpc/src/commit-frame.ts:38`). Follow that. A
  uint16 caps a protocol name at 65535 bytes, far above any real name; the decoder rejects a truncated
  header, a length that overruns the buffer, or a protocol name that is not well-formed UTF-8. Protocol
  registration imposes no byte-length bound today (`topic.ts:43` rejects only NUL, ill-formed UTF-16, and
  the reserved prefix), so the **encoder must reject** a name whose UTF-8 exceeds the uint16 cap rather
  than truncating modulo 65536.
- **`VERSION` is a reserved byte that is not a legal JSON leading byte.** Legacy directed frames are
  `JSON.stringify` output (`packages/hub-tunnel/src/frame.ts:90`), so they begin with `{` (or JSON
  leading whitespace). Choosing `VERSION` outside that set (a high control byte such as `0x00` is not
  valid JSON input) lets a decoder distinguish a tagged frame from a legacy one by the first byte alone,
  with no risk of misparsing legacy bytes as a bogus tag. Assign the concrete value in the plan.
- The fixed-width length makes the `protocol ∥ frame` split injective regardless of the name's content;
  the protocol name is additionally NUL-free and well-formed because it also flows through topic
  derivation, which rejects both (`packages/broadcast/src/topic.ts:15`).

**Why inside the seal.** If the tag were outside the seal (plaintext beside the ciphertext), a lying
hub could flip it and misroute a frame onto the shared inbox key — B's acceptor would open A's frame
(same epoch key) and run it. Inside the seal, the tag is covered by the AEAD, so neither the hub nor a
non-member can alter or forge it. A group member can tag only their **own** frames (the tag proves what
the authenticated sender selected, bound to that sender's MLS identity), and may select any protocol —
but since every group member may already call every protocol on the shared inbox, there is no privilege
boundary to cross. The tag is an accidental-cross-delivery and reply-routing fix over an authenticated
channel, not an authorization mechanism (`Server` is built `requireAuth: false`, `directed.ts:201`).

**Receive routing.** `createInboxPath`'s projection strips the header and surfaces the decoded
`protocol` on `OpenedInbound`. Then:

- The inbox acceptor for protocol X processes a frame only when `opened.protocol === X`; otherwise it
  ignores it. So a non-owning `Server` is never fed the frame and never emits a spurious error reply.
- A directed client for `(protocol X, member M)` accepts an inbound frame only when
  `opened.protocol === X` **and** the authenticated sender is `M`. So replies route to exactly the one
  client that issued the request, even when several protocols talk to the same member.

**Send.** The directed send paths prepend the header for the protocol the client or acceptor belongs to,
at the client publish (`directed.ts:100`) and the acceptor session publish (`directed.ts:210`). The
unrouted-tag NACK below is a **third** send path, and it echoes the caller's tag rather than owning a
protocol of its own. The protocol name is known where each is created.

The isolation fix changes no topic derivation; AAD stays `fromUTF(topicID)`; capacity, rotation, and the
app-topic lifecycle are untouched. (Rider 2's DID normalization is the one thing that can move an inbox
topic — see its own section.)

**Failure legibility.** `createOpenOncePath` swallows a projection/parse/listener exception and
acknowledges the frame in `finally` (`open-once.ts:68,76`), and the directed client creates its enkaku
`Client` with no timeout, which enkaku treats as disabled (`directed.ts:152`,
`node_modules/@enkaku/client/lib/client.js:41,499`). So any dropped inbound frame — a mixed-version
mismatch, or a frame correctly tagged for a protocol this peer has not registered — currently leaves the
caller's request pending forever, silently. Tagging would even *regress* this for the unregistered-
protocol case: today an unknown procedure draws an `INVALID_MESSAGE` reply, whereas a tag no acceptor
claims is silently dropped. This design therefore requires two mechanisms, each with a bounded reach that
must be stated honestly rather than as a blanket "calls reject":

1. **A default directed-client request timeout.** Give the directed `Client` a sensible default
   `requestTimeoutMs` (`node_modules/@enkaku/client/lib/client.d.ts:71`, applied at `client.js:499`) so a
   dropped or unrouteable **unary request** rejects rather than hanging; a caller may override it. Reach:
   enkaku applies `requestTimeoutMs` to unary requests only — stream and channel APIs do not accept a
   timeout (`client.d.ts:122`, `client.js:517`), which is correct (a long-lived call must not be aborted)
   but means a dropped stream/channel *creation* still hangs unless the caller supplies its own signal.
   And a **legacy** caller, pre-upgrade, has no such default at all, so a legacy→upgraded straddled call
   can still hang — an accepted consequence of the hard cutover, documented below, not a legibility this
   design can deliver to a peer it has not upgraded.
2. **An unrouted-tag NACK** (restores legibility for the unregistered-protocol case, and covers
   stream/channel where the timeout cannot). When an opened inbox frame's tag names a protocol not
   registered on this peer, publish an `INVALID_MESSAGE`-class error reply. It is constructible without
   running a `Server`: `decodeFrame` yields `sessionID`, `seq`, and `body.payload.rid`
   (`hub-tunnel/frame.ts:60,67`). It must obey three constraints or it is worse than nothing:
   - **Echo the caller's tag.** Tag the NACK with the *unrouted* protocol from the offending frame, not a
     protocol of ours — else the originating client's own protocol filter discards it.
   - **Only NACK request-like frames.** Restrict to `body.payload.typ ∈ {request, stream, channel, send}`,
     exactly as enkaku's own invalid-message path does (`server.js:253`). A `result`/`error`/`receive`
     reply also carries an `rid` (`@enkaku/protocol/lib/schemas/server.js`); NACKing those would let two
     peers that both lack the tag volley error frames forever.
   - **Use a fresh, non-stale session sequence,** because the tunnel drops a stale `seq`
     (`hub-tunnel/transport.ts:427`).

   The NACK does not reach a legacy caller (it is a tagged frame the legacy peer cannot decode), so legacy
   straddle hangs remain under the hard-cutover stance regardless.

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

**`normalizeDID` canonicalizes, it does not validate.** It returns a non-peer4 string unchanged and
shortens anything passing a `did:peer:4z` prefix check, truncating at the next colon
(`node_modules/@kokuin/token/lib/did.js:320`, `peer4.js:109,114`). So an empty or arbitrary non-DID
string survives, and malformed peer4-looking variants can collapse together. The claim here is only that
equivalent *valid* peer4 forms converge — not DID validation. Validation is not this rider's job.

**Topic convergence (not rotation).** Because `inboxTopic` derives from the DID as its scope
(`topic.ts:63`), normalizing the DID *before* derivation makes a long-form peer4 input derive the **same**
inbox topic as its short form. Where short-form credential IDs are already universal (the real MLS path),
this is a no-op and no live topic moves; where a caller supplied a long form, it converges that caller
onto the canonical topic — the desired identity semantics, not a rotation of existing short-form topics.
The consequence for a straddled upgrade is folded into "Mixed-version deployment" below.

**One ingress deliberately left raw.** The hub-asserted `message.senderDID` surfaced in commit context
(`peer.ts:1282`) is documented as auxiliary, never an MLS authorization input, so it is intentionally not
normalized; MLS-authenticated DIDs are the ones that must be canonical.

## Mixed-version deployment

The directed payload format changes (the `VERSION` header). Group peers on independently-upgrading
devices can therefore straddle versions during a rollout, and there are two straddle failures:

- **Wire-format mismatch.** An upgraded peer receiving a legacy `{`-leading frame detects it by the
  version byte; a legacy peer receiving a tagged frame fails its JSON decode. Either way the frame is
  dropped, and because the inbox is mailbox class it is not redelivered. The `VERSION` byte guarantees
  the tagged frame is never *misrouted* onto the shared key — the failure is always a drop, never a
  wrong-protocol execution.
- **Topic mismatch (long-form DIDs only).** If a peer's DID is used in long form on one side and Rider 2
  normalizes it on the other, the two sides derive different inbox topics and never meet on the hub at
  all. Where short-form credential IDs are universal this cannot arise.

Stance: **hard cutover**, consistent with Spec A's pre-1.0 deliberate invalidation of retained history
and the coupled version band. All group peers must reach this version together. A dropped frame is *not*
self-announcing — `createOpenOncePath` swallows and acks it (`open-once.ts:68,76`). An **upgraded**
caller's unary straddled call rejects on the default `requestTimeoutMs`; a legacy caller has no such
default and its stream/channel calls have no timeout, so those straddled calls hang until the peer
upgrades. That residual hang is the accepted cost of the hard cutover — a dual-format transition is
rejected because it would reopen the very cross-delivery this change closes for the duration of the
window.

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
- **Session-end stranding on full peer disposal.** A cleanly disposed peer suspends mux publishing before
  `teardownEpoch` (`peer.ts:2081`), so the session-end frames its directed transports try to send are
  rejected and swallowed (`hub-mux.ts:623`, `hub-tunnel/transport.ts:268`), leaving the remote acceptor's
  server sessions retained until it disposes (`directed.ts:305,323`). Pre-existing, not introduced by
  tagging, and not fixed here; noted for the future capacity work (an idle session timeout would close
  it).

## Testing

- **Isolation (peer-level integration harness, driving two protocols through `createGroupPeer`):**
  - Two protocols defining a same-named procedure: a directed call to A runs A's handler and **not**
    B's.
  - The caller of A receives A's single reply and **no** spurious error reply from B's server.
  - Two protocols to the same member: each protocol's client receives only its own reply.

  These are peer/integration behaviors, not `GroupCrypto`/`GroupMLS` port contracts, so they are new
  peer-level tests, not clauses in `rpc-conformance`. Routing is independent of the crypto
  implementation, so the fake crypto double is sufficient to drive them.
- **Tag authenticity:** a frame tagged for protocol A is never routed to protocol B; a corrupted or
  flipped header does not cause cross-routing (it fails the AEAD open or the version check).
- **Encoding:** the `VERSION ‖ len ‖ protocol ‖ frame` header round-trips; a protocol name containing
  arbitrary characters (including `/`) is recovered exactly; a legacy untagged frame is rejected by the
  version marker, not misparsed.
- **Failure legibility:** a directed unary call to a protocol not registered on the recipient rejects
  (via the unrouted-tag NACK, and via the default timeout as a backstop) rather than hanging; the NACK
  carries the caller's protocol tag so the caller's filter accepts it; the NACK fires only on request-like
  frames, never on a reply/error (no NACK ping-pong between two peers lacking the tag); the encoder
  rejects a protocol name exceeding the uint16 length; the default timeout is overridable.
- **Rider 2:** a peer given a member DID in long form both addresses it and matches its replies when MLS
  returns the short credential form; `detectRosterChange` does not fire on an equivalent-form flip;
  self-echo suppression holds across DID forms; a short-form DID's inbox topic is byte-identical to today
  (golden pin).

TDD throughout; every vitest step paired with `test:types`. The port conformance suites do not change
(no port contract changed); the new coverage is peer-level in `@kumiai/rpc`'s own tests. Confirm
`Cached: 0` on the forced test run.

## Verification plan

- Whole-branch review on the most capable model.
- At least one blind adversarial Codex review, briefed with the isolation and authentication questions,
  never the expected answers.
- Confirm the isolation fix rotates nothing: app broadcast, commit, rendezvous, and short-form inbox
  topics are byte-identical. The only permitted movement is Rider 2 converging a long-form DID's inbox
  topic onto its short form; a golden test pins that a short-form DID's inbox topic is unchanged.

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
