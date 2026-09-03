# Spec C — per-protocol inbox topics + protocol isolation

**Filed:** 2026-09-02, split out of the mls-encrypt-aad work. **Depends on [Spec B](./2026-09-02-derivetopicid-injectivity.md)** — it needs an injective `deriveTopicID`.

## The defect

The peer builds one recipient-scoped inbox topic (`peer.ts:572`) and attaches one acceptor **per protocol** to that single inbound path; `createOpenOncePath` opens each frame once and fans the plaintext to every listener (`open-once.ts:53,60,66`). The single-inbox shape is deliberate — it guarantees a frame is opened exactly once, which matters because an MLS `unwrap` consumes a ratchet generation. But the inbox topic names no protocol, so a directed request for protocol A is also delivered to protocol B's server; if both define a compatible procedure name, both handlers run. There is no authenticated protocol discriminator. The topic-context AAD binding (Spec A) does not fix this, because all protocols on the shared inbox share the identical topic and epoch.

## The fix and its riders

Give each protocol its **own** inbox topic (`inboxTopic` folds in the protocol, over Spec B's injective primitive, as a params-object call). Then each protocol has its own open-once path (no double-open), cross-protocol delivery is structurally impossible, and — with Spec B — the topicID carries protocol identity so Spec A's AAD separates protocols for free.

Riders a review found, each of which the spec must handle:

1. **Anchor snapshot.** The self topic is computed in `buildEpoch` from `anchor` (`peer.ts:572`), but `resolveSendTopic` and the client send-topic read the *mutable* `anchor` later (`peer.ts:611,692,698`); `captureAnchor` mutates it before rebuild (`peer.ts:464,713,1073`). Each `ProtocolRuntime` must capture one anchor snapshot and derive self-topic, `to()`, and `resolveSendTopic` from *that*, storing `{ topicID, path }` per runtime.
2. **DID normalization — beyond topics.** Use `normalizeDID` from `@kokuin/token` (`did.ts:396`; already used by mls for roster/credential comparison, `group-handle.ts:671`, `credential.ts:146`) — not an invented helper — and add the catalog dep to `@kumiai/rpc`. Normalizing only `inboxTopic` is insufficient: the directed client compares the MLS-recovered sender against the raw `memberDID` (`directed.ts:117`), and the directed cache and app-lane self-echo (`app-lane.ts:441`) key on raw form. A client created with a long-form DID reaches the normalized topic but drops the reply when MLS returns the short credential ID. Normalize equality/cache keys too.
3. **`sealForSegment` seal race.** A roster-changing commit advances the handle before `captureAnchor` (`peer.ts:1073`); `sealForSegment` (`peer.ts:660`) can read the old anchor, seal under the new MLS epoch, and pass its post-seal identity check before the anchor changes — producing a new-epoch frame published on the old segment topic, losing retained traffic for a newly added member. The post-seal check only catches an anchor changing *during* the seal, not a handle that moved just before. Serialize sealing with the advance/capture seam, or mark the segment transitioning before the handle advances.
4. **Rotation pairing scope.** A per-runtime snapshot only fixes the window after `captureAnchor` and before rebuild; teardown then disposes old clients/acceptors (`peer.ts:621`), so a reply after completed rotation still misses. Scope the guarantee to "capture occurred, old runtime not yet torn down", or add old-runtime grace/draining.
5. **Subscription budget.** The mux never unsubscribes old topics (`hub-mux.ts:275`); the reference hub caps ~1000 subscriptions/DID (`memoryStore.ts:111`). Per-protocol inboxes raise durable topics per anchor segment from ~P+1 to ~2P. Bound or define cleanup, or quota exhaustion leaves later protocol inboxes unsubscribed.

## Non-goal

`discoveryTopic` (`rpc/src/topic.ts:80`) is a public raw SHA-256 construction, not a `deriveTopicID` caller — do not mechanically move it to secret-bearing HKDF; state explicitly whether it changes.
