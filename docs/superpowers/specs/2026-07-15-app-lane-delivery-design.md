# App-lane delivery — design

**Status:** design, approved in brainstorm 2026-07-15. Supersedes the problem statement
`docs/agents/plans/next/2026-07-14-app-lane-delivery.md` (which should move to `completed/` once this
ships).
**Origin:** question 3.7 of the control-ledger-lane work found the loss; evidence in
`docs/superpowers/probes/question-3.7-report.md` and the skipped `packages/rpc/test/peer-app-drain.test.ts`.

---

## 1. Problem

A member is **structurally unable to receive app traffic from any epoch it was not subscribed through** —
not merely past a retention window, but *any* epoch it slept through. At the design's commit volume the
epoch turns over constantly, so an ordinary user closing their laptop over lunch loses every message sent
while it was shut.

Three composed properties cause it, each individually defensible:

1. App topics are epoch-derived (`protocolTopic(secret, epoch, name)`, `buildEpoch` at `peer.ts:277-289`).
2. App frames are **mailbox-class** — push-only, a per-recipient delivery created *at publish time for the
   then-current subscribers*, and a mailbox publish with no subscribers is dropped outright.
3. `subscribe` back-fills nothing.

So a peer at epoch 1 when it went away was never a subscriber of the epoch-3 topic; the hub created no
delivery for it and — if nobody else was pending — retained no frame. It cannot pull, back-fill, or
recover it. The control-ledger-lane work already closed every path that *deleted* mail (unsubscribe as a
destructor, on rotation and on `dispose`); this design closes the paths that merely *fail to deliver*.

---

## 2. Architecture overview (the concept map)

> This section is durable reference, not app-lane-specific. **It must be promoted into
> `docs/agents/architecture.md`** (see Deliverables) — specs under `docs/superpowers/` are ephemeral.

The hub is a **blind pub/sub store over opaque topic IDs.** It knows nothing of groups, membership, or
MLS; it stores and serves frames keyed by a topic id that only the entitled can derive. Everything below is
built on two storage primitives and a set of lanes that map onto them.

### 2a. The two retention classes (hub-protocol storage primitives)

Every published frame is one of two classes, chosen per publish by `PublishParams.retain`:

| Class | Lifetime / GC | Delivery | Pullable? | `head` / CAS | For |
|---|---|---|---|---|---|
| **`log`** | retained unconditionally; trimmed only by age/depth (`trim`, `maxRetention`) | pushed live to current subscribers **and** kept | **yes** — `fetchTopic` serves a topic's log-class frames, in order, to a cursor | yes — `head` is durable stored state; supports compare-and-set (`expectedHead`) | convergence: any peer can reconstruct the whole sequence, whenever it asks |
| **`mailbox`** (default) | per-recipient pending delivery; ack-refcount GC; **dropped if no subscriber** at publish | push-only | no | no | directed, ephemeral delivery to peers online *now* |

Key consequences the app-lane design leans on:
- Unsubscribing a **log-class** topic frees *nothing* (its frames and `head` survive — a conformance
  guarantee, `hub-protocol` suite). Unsubscribing a **mailbox** topic is a destructor.
- A log-class frame is both **live-pushed** to current subscribers and **retained for pull** — one publish
  serves online and returning peers alike. This is exactly how the commit lane already works.

### 2b. The lanes (rpc semantic layer)

Each lane is a topic id + a retention class + a secret it derives from. Two planes:

**Control plane** (membership and healing):

- **Commit lane** — `commitTopic(recoverySecret)` (`peer.ts:940`), **log-class**, one lifelong topic per
  group. The compare-and-set serialized log of membership/authority changes (commits carrying the ledger
  bodies). Convergent: peers pull it to head and are woken by a live push. Derived from the **lifelong
  recovery secret**, so a *removed* member can still follow it — accepted, because commits are
  authenticated and the ledger is not secret. Retention: 30 days (`commitLogRetentionSeconds`).
- **Rendezvous topic** — `rendezvousTopic(recoverySecret)` (`peer.ts:941`), **mailbox-class**, one lifelong
  topic per group. The handshake channel for two gathers, both request/reply and both sealed to a
  per-request ephemeral HPKE key:
  - **Recovery** (rejoin): a stranded peer publishes a signed request; a member seals `GroupInfo` (plus a
    membership attestation) to the requester's ephemeral key; the peer rejoins by external commit.
  - **Ledger bootstrap**: the same rendezvous in the other direction — a rejoined peer whose ledger is
    empty gathers the whole ordered ledger, head-verified, sealed to its ephemeral key.
  Also derived from the lifelong recovery secret (a returning peer must reach it while off the group's
  line); confidentiality is the seal, not the topic.

**Data plane** (user traffic):

- **App lane** — `protocolTopic(secret, epoch, name)` (group broadcast) and `inboxTopic(secret, epoch, did)`
  (directed per-DID mail). Derived from the **per-epoch** secret (`crypto.exportSecret()`), so a *removed*
  member is cut off by MLS forward secrecy — the data plane's privacy that the control plane deliberately
  forgoes. **Currently mailbox-class** (the bug). **This design makes it log-class and rotates the topic on
  removal** (§3).

### 2c. Basic usage

```ts
// Publish a commit (log-class, CAS'd against the log head):
await mux.publish({ topicID: commitTopic(recoverySecret), payload, retain: 'log',
                    expectedHead, publishID })

// A returning peer converges the commit lane by pulling to head:
const { messages, head } = await hub.fetchTopic({ topicID: commitTopic(rs), after: cursor })

// Send directed app mail today (mailbox — push-only, lost if recipient is away):
await mux.publish({ topicID: inboxTopic(secret, epoch, recipientDID), payload })   // retain defaults to mailbox

// After this design (log-class, reachable on return):
await mux.publish({ topicID: appTopic, payload, retain: 'log' })
```

### 2d. How the pieces relate

```
                         hub (blind pub/sub over opaque topic IDs)
                 ┌───────────────────────┴───────────────────────┐
          retain: 'log'                                    retain: 'mailbox'
    (retained, pullable, CAS)                       (per-recipient, push-only)
          │                                                       │
   ┌──────┴───────┐                                    ┌──────────┴──────────┐
   │ COMMIT LANE  │                                    │  RENDEZVOUS TOPIC   │
   │ membership/  │  ← control plane (lifelong secret) │  recovery + ledger  │
   │ authority log│                                    │  gathers (sealed)   │
   └──────────────┘                                    └─────────────────────┘
   ┌──────────────┐
   │  APP LANE    │  ← data plane (per-epoch secret)
   │ protocol +   │     TODAY: mailbox (lossy).  THIS DESIGN: log-class,
   │ inbox topics │     topic rotates on removal (§3).
   └──────────────┘
```

---

## 3. The design

### 3.1 App frames become log-class and pullable

Publish app frames with `retain: 'log'`. A log-class frame is live-pushed to current subscribers **and**
retained for pull — symmetric with the commit lane. This alone fixes all three losses, and makes "drain
epoch E fully" *expressible*: a `fetchTopic` to head the peer can complete and **know** it completed,
rather than racing a push loop with no empty-signal. It also dissolves the subscription-accumulation cost
the interim fix incurred: because unsubscribing a log-class topic frees nothing, a peer subscribes only the
*current* app topic for live push and reaches older ones purely by pull.

### 3.2 Topic model — derived anchor, rotate on removal

The app topic is derived from an **anchor**, not the current epoch:

```
appTopic  = protocolTopic(anchorSecret, anchorEpoch, name)
inboxTopic = inboxTopic(anchorSecret, anchorEpoch, did)
```

`anchorSecret` / `anchorEpoch` are captured from `crypto.exportSecret()` **at the last commit that
contained a Remove proposal**. Non-removal commits (adds, updates, plain authority changes) leave the
anchor — and therefore the topic — unchanged; a Remove rotates it.

New peer state: `anchorSecret: Uint8Array`, `anchorEpoch: number`. Updated whenever a Remove-bearing commit
is applied — by live members as they apply it, and by a returning member as it walks the commit log. At
genesis the anchor is the genesis epoch's exported secret.

Detecting a Remove is inspectable from the commit MLS already exposes (the applied proposals); no announced
value and no new control message — the mechanism is pure derivation.

### 3.3 Why a removed member is blind (unlinkability proof)

A member removed at the rotation commit does **not** receive that commit's new epoch secret (MLS forward
secrecy). It therefore cannot compute `exportSecret()` for the anchor epoch, cannot derive the new app
topic, and is blind to all subsequent app traffic — automatically, with nothing announced to leak. Frame
**content** was always MLS-locked to the epoch regardless; this closes the **metadata** channel (that
traffic flows, its volume and timing) as well.

No new leak versus today: removed members already follow `commitTopic` for life, so they already observe
that removals occur and at what cadence. The app-topic-per-segment scheme reveals nothing beyond that — a
removed member sees its last-known app topic go silent, which the commit lane already tells them.

Note the anchor must feed the **per-epoch** secret, never the lifelong recovery secret: the recovery secret
is known to removed members for life (it is what lets them follow `commitTopic`), so a topic derived from
it plus a guessable epoch *number* would not cut anyone off. The per-epoch `exportSecret()` is the load
-bearing input.

### 3.4 Delivery and drain

- **Online member:** subscribes the current app topic; receives live pushes. On applying a Remove commit it
  updates the anchor, drops the old subscription (safe — log-class), and subscribes the new topic.
- **Returning member:** walks the commit log epoch by epoch (as it already does to rebuild), deriving each
  epoch's `exportSecret()` as it goes. The **topic** changes only at Remove boundaries, so it pulls **once
  per segment** — one `fetchTopic` to head on that segment's app topic — not once per epoch. Each pulled
  frame is decrypted under the epoch its MLS ciphertext names (a key the walk has derived). At each Remove
  boundary it updates `anchorSecret`/`anchorEpoch` and moves to the next segment's topic. Delivery order
  within a segment is the hub's log sequence. All members — publishers included — derive app topics from the
  anchor, so a live publisher mid-segment publishes to the same segment topic a returning peer will pull.

A "segment" is the run of epochs between two removals — one stable app topic across it, frames from several
epochs interleaved on one log, each decryptable under the per-epoch key the walk derives.

### 3.5 Retention

Members request **30 days** by default — aligned to the commit window, so the membership-rebuild bound and
the app-drain bound coincide and there is no partial-recovery gap (a member who can rebuild at all can drain
every message it missed). The hub **operator** governs real storage via the existing `maxRetention` cap
(the operator's single lever; the hub is blind to groups and cannot enforce per-group figures). Per-member
override up to that cap remains possible. No per-group enforcement, and no new mechanism — the default is a
figure members carry into `SubscribeParams.retention`, exactly as `commitLogRetentionSeconds` already does.

---

## 4. Blast radius and release position

**rpc / mls only — no hub-protocol / hub-server public-contract change.** The design reuses the log-class /
`fetchTopic` / retention surface the control-ledger-lane release already ships. Concretely:

- `packages/rpc/src/peer.ts` — publish app frames `retain: 'log'`; add `anchorSecret`/`anchorEpoch` state
  and update it on applying a Remove; derive app topics from the anchor; implement the returning-member
  per-segment drain; subscribe-only-current + pull-old.
- `packages/rpc/src/topic.ts` — no signature change (`protocolTopic`/`inboxTopic` already take
  `(secret, epoch, name)`); the caller feeds anchor values.
- `packages/mls` — a touch only if capturing the anchor secret or detecting a Remove in a commit needs a
  new `GroupMLS`-port accessor. Prefer reusing `exportSecret()` and the commit inspection the lane already
  has; if a port method is unavoidable it is **additive** (a new optional method), not a break.

Therefore the app-lane fix is **additive to rpc** — a later non-breaking (pre-1.0 MINOR) release — and does
**not** gate or bundle into the current control-ledger-lane breaking release. Kubun absorbs one break now
and picks this up later with no port.

---

## 5. Deliverables

1. The rpc changes in §4.
2. **Expand `docs/agents/architecture.md`** with §2 (the concept map, usage examples, and the lane/class
   diagram), updated to describe the app lane as log-class post-implementation. This is the durable home;
   the spec is ephemeral. Non-optional — it is the "docs describing the full architecture" this work owes.
3. Un-skip and complete `packages/rpc/test/peer-app-drain.test.ts`; give the peer test fixture an
   app-handler registration (its absence is why 148 rpc + 287 mls green tests never caught the loss).
4. Move `docs/agents/plans/next/2026-07-14-app-lane-delivery.md` to `completed/`.

---

## 6. Testing

Assert **plaintext received by the handler**, not the absence of an error (the original loss passed a
convergence assertion on the line above the failure). Cover:

- The three loss scenarios from the problem doc (frame at an epoch never held; frame at own epoch published
  after the leaving commit; frame at own epoch after restart) — each now **delivered** via pull.
- A removal rotates the app topic, and the **removed member cannot derive or read** the post-removal topic
  (a test double that can attempt derivation with the stale secret and fail).
- A returning member **drains across a rotation boundary** — messages from before and after a removal it
  slept through, both delivered, in order, under the correct per-epoch keys.
- Retention bound: a member away beyond the window gets a surfaced "pruned beyond your window" signal, not
  a silent gap.

Mutation-check the decisive tests (revert the log-class publish; revert the anchor update on removal) and
confirm red.

---

## 7. Residuals (stated, not hidden)

- A member away longer than the retention window (30 days) loses those app messages. This is a **stated
  bound**, surfaced to the host as a pruned-window signal — never a silent loss.
- A returning member re-derives per-epoch keys across the drained span; bounded by retention, and it is
  walking the commit log to rebuild anyway.
- High app volume × 30-day log retention is real hub storage; the operator's `maxRetention` is the cap.
- A removed member still learns *that* removals happen and their cadence — but only from `commitTopic`,
  which it can already follow for life. The app lane adds nothing to that.

---

## 8. Open questions

None blocking. Two implementation calls left to the plan: whether detecting "a commit contains a Remove"
needs a new (additive) `GroupMLS` accessor or can reuse existing commit inspection; and the exact shape of
the pruned-window signal surfaced to the host.
