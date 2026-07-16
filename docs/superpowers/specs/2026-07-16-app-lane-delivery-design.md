# App-lane delivery: reach a member who was away — design

**Date:** 2026-07-16
**Status:** design approved, ready to plan.
**Scope:** `@kumiai/rpc` (+ possibly an additive `@kumiai/mls` accessor, avoided by the chosen
Remove-detection approach). Non-breaking, additive MINOR. Does **not** gate any release.
**Origin:** `docs/agents/plans/next/2026-07-15-app-lane-delivery.md` (design approved 2026-07-15),
refined against the current code and against the real host (Kubun) on 2026-07-16.

## The problem

A member is **structurally unable to receive app traffic from any epoch it was not subscribed
through** — not merely past a retention window, *any* epoch it slept through. At the design's
commit volume the epoch turns over constantly, so an ordinary user closing their laptop over lunch
loses every message sent while away. Three composed properties cause it: app topics are
epoch-derived; app frames are **mailbox-class** (push-only, dropped if no subscriber at publish);
and `subscribe` back-fills nothing.

The control-ledger work closed every path that *deleted* app mail (unsubscribe-as-destructor on
rotation and on dispose — see `hub-mux.ts:74-91`, subscriptions now outlive listeners). This design
closes the paths that merely *fail to deliver*.

**Evidence in tree:** the skipped test `packages/rpc/test/peer-app-drain.test.ts:72` fails for
exactly this reason and must not be deleted, inverted, or weakened. The peer comes back at epoch 1
holding epoch 1's secret, is handed the epoch-1 frame by the hub, and drops it — it holds the key
but never installs the listener, because there is no pull-readable app lane.

## Architecture context (retention classes and lanes)

The hub is a blind pub/sub store over opaque topic IDs. Every frame is one of two classes
(`hub-protocol/src/types.ts:52-57`):

- **`log`** — retained unconditionally, trimmed only by age/depth; live-pushed to current
  subscribers **and** pullable via `fetchTopic` to a cursor; has a stored `head` supporting
  compare-and-set. Unsubscribing a log-class topic frees nothing (frames and head survive).
- **`mailbox`** (default) — per-recipient pending delivery, ack-refcount GC, push-only, dropped if
  no subscriber at publish.

Lanes map onto these. The **commit lane** (`commitTopic`, log-class, lifelong recovery secret) is
the CAS'd membership log; the **rendezvous topic** (mailbox, lifelong recovery secret) carries
sealed recovery + ledger gathers; the **app lane** (`protocolTopic` broadcast, `inboxTopic` per-DID)
is derived from the **per-epoch** secret (`GroupCrypto.exportSecret()`, `crypto.ts:14`). The app lane
is currently mailbox-class — that is the bug.

## Key discovery that shaped this design

The item framed the fix as "publish `retain: 'log'`" — a one-line flag in `peer.ts`. It is not. App
frames **do not go through `mux.publish`**. They flow through `BroadcastClient` over
`createBroadcastTransport({ ..., bus: mux.bus })` (`peer.ts:265-289`), and `bus.publish`
(`hub-mux.ts:170-172`) hardcodes `hub.publish` with **no `retain`** — mailbox by default. The
`BroadcastBus` interface has no retention and no pull. The commit lane deliberately bypasses the bus
and uses `mux.publish`/`mux.fetchTopic` directly (`peer.ts:1163`). So making app frames log-class +
pullable is an integration change, not a flag.

We further validated against the real host, **Kubun** (feature branch mid-migration to `@kumiai/rpc`
0.3.1):

- **No `peer.ready()` exists in 0.3.1**; the peer is *eager* — the receive drain opens in the
  constructor (`group-peer-manager.ts:266`). App messages arrive only via registered `handlers`
  (`group-handlers.ts:35`), fire-and-forget. Construction return value is never read.
- **Kubun drives no app catch-up.** Zero call sites for `peer.resync/recover/replay/commit` in
  source; reconnect is transparent inside `HubLike`. The only host-driven catch-up is
  control-ledger (`gather('control/ledgerCatchup')`), not app messages.
- Therefore the returning-member app-drain **must be peer-internal** (run automatically when the
  peer comes up / reconnects). There is no host call to hang it on. This is also the best UX: the
  user reopens the app and messages appear.
- Kubun has **no epoch→timestamp table** (`tables.ts:100` stores only the current epoch) but does
  hold a per-message HLC wall-clock (`group-protocols.ts:118`, `tables.ts:150`). So an epoch number
  from rpc is not renderable by the host; the pruned-window signal need only report *that a gap
  exists*, and the host renders "since <date of last message held>" from its own HLC.
- The natural landing surface for the pruned signal already exists and is **inert**:
  `GroupHealthMonitor.signal(groupID, condition)` → `groupHealthChanged` → GraphQL subscription
  (`group-health-monitor.ts:68,163`; `schema.ts:1146`), explicitly reserved for this class of event.

## The design

### 1. Retention is a per-procedure property; only events may be logged (Fork 1)

App traffic has two **orthogonal** dimensions, chosen independently:

- **Kind** — `event` (fire-and-forget, 1→N) | `request` / `gather` / `reply` (RPC correlation). All
  four primitives stay.
- **Retention** — `log` (retained by the hub, pullable to a cursor, drained on return) | `ephemeral`
  (live push, mailbox-class, dropped if no subscriber at publish).

**Guardrail: only events may be `log`. `request` / `gather` / `reply` are always ephemeral.** Retaining
correlation traffic is unsafe on two counts: a `request` re-pulled during a drain re-fires its
responder, so a returning member would re-run RPCs that already ran; and the `rid` / timeout / quorum
a reply correlates against is long dead by the time a member returns. Durability is expressed as a
**logged event applied idempotently**, never as a retained request.

**Retention is declared per procedure in the group protocol definition — not chosen per call.** An
event procedure marks `retain: 'log'`; the default is ephemeral. Every `dispatch` of that procedure is
retained regardless of the call site, so retention is an intrinsic property of the *message type* and
cannot be fumbled per-call (silent loss from a wrong per-call choice is the exact failure this feature
exists to prevent). The protocol definition is also where the guardrail is **enforced**: declaring
`retain: 'log'` on a `request` / `gather` procedure is rejected at definition time.

- **Logged events** (e.g. `chat/message`, mutations) publish via the hub's log class
  (`mux.publish({ retain: 'log' })` — the machinery the commit lane already uses and tests), retained
  and pullable; a returning member drains them.
- **Ephemeral events** (e.g. `chat/typing`, presence, cursors) publish live (mailbox), never retained,
  never drained. Presence itself is **out of scope**; the point is only that the knob exists so a
  signal stream is never *forced* onto the log — a retained "online" outlives the device, and flap
  would pollute every returning member's drain.

The send API stays a single `dispatch(prc, data)` that routes by the procedure's declared retention;
the receive side is unchanged (handlers keyed by procedure name). A topic may carry both classes —
`fetchTopic` returns only `retain:'log'` frames, so the drain pulls every app topic and receives
exactly the logged events; mixing on one topic is safe. A log-class frame also pushes live to online
subscribers, so "drain epoch E fully" becomes a `fetchTopic` the peer can complete and *know* it
completed; accumulation is a non-issue because unsubscribing a log-class topic frees nothing (subscribe
only the current topic for live push, reach old ones by pull).

Rejected API shapes: a per-call `retain` flag on `dispatch` (a load-bearing choice buried in an options
bag, one typo from silent loss); two send methods `dispatch` / `post` (explicit at the call site, but
the method name is the only guard — same fumble risk). Rejected transport shapes: widening
`BroadcastBus.publish` with `retain` + a pull method, or retiring `BroadcastClient` for the app lane —
both touch the generic fan-out lib's public surface for no gain.

**Implementation seam (resolved in Q1.1):** where the per-procedure `retain` marker lives — an
additive optional field on the group protocol definition (`defineGroupProtocol`) vs. an rpc-side
sidecar map — and how a logged event's publish reaches `mux.publish({ retain: 'log' })` while ephemeral
events and all RPC stay on the existing live path. Both directions are additive / non-breaking.

### 2. Topic model — derived anchor at the last ROSTER CHANGE, durably held

`appTopic = protocolTopic(anchorSecret, anchorEpoch, name)` and `inboxTopic(anchorSecret,
anchorEpoch, did)`, where `anchorSecret`/`anchorEpoch` are captured from `exportSecret()` at the
**last commit that changed the roster — an Add or a Remove**. A commit that leaves the roster
untouched (update, no-op, ledger-only) leaves the topic stable; any roster change rotates it. New peer
state `anchorSecret`/`anchorEpoch`, updated whenever a roster-changing commit is applied, and
**durably persisted** (see below). `topic.ts` needs no signature change — the existing functions
receive anchor values instead of the current per-epoch values.

**Why the last roster change and not the last Remove** (corrected 2026-07-16 — the original
"last Remove" is not implementable, and binding the topic to it silently partitions the group):

The anchor *secret* is `exportSecret(anchorEpoch)`, and MLS ratchets forward — a member cannot export
the exporter secret of an epoch it did not hold. Two constraints follow, and they intersect at exactly
one epoch:

- The anchor epoch must be one **every current member holds the secret for**, so it must be ≥ the
  newest member's join epoch. Otherwise a member added after the anchor can never derive the topic —
  no seeding trick fixes this; the secret is simply gone forward.
- The anchor epoch must be **after every removal**, so a removed member cannot derive it (§4).

`max(last add, last remove)` = **the last roster change**. That is not a preference; it is what the two
constraints leave.

It also makes the hard cases self-synchronize with **no announced value**: a member added at epoch E
seeds its anchor at E, and every existing member rotates to E on applying that same add — they agree
natively, each holding E's secret. An external-commit rejoin adds a leaf, so recovery re-synchronizes
the anchor for free.

**The anchor must be durable.** A restart is the one case derivation cannot cover: a member rebooting
at epoch 12 whose last roster change was epoch 5 cannot re-export `secret@5`, and re-seeding from the
live epoch would put it on a topic no one else uses — a silent, permanent partition triggered by a
phone restarting (measured: a peer booting at epoch 3 against a group anchored at 1 received **0** of
the messages it should have). So `{anchorSecret, anchorEpoch}` is persisted alongside the handle and
restored on construction, rather than re-seeded. This is consistent with the existing at-rest posture —
the MLS handle already persists epoch secrets in order to decrypt at all.

**Rejected — carry the anchor in Welcome/GroupInfo** (keeping "last Remove", announcing the value to
joiners): it does not avoid persistence (a restart still cannot re-export an old secret, so persistence
is needed anyway — announcing is *additional*, not alternative); the secret cannot ride a GroupContext
extension, because extensions are public to all members and a later-removed member would have seen it,
defeating §4; and handing a joiner `secret@anchorEpoch` lets it derive the topic for the segment
*before* it joined, so with log-class retention it can `fetchTopic` that pre-join history — ciphertext
it cannot open, but message count, timing and sender DIDs it can. Under the chosen model a joiner's
anchor is its own add epoch, so it can derive nothing prior.

**Cost, stated:** rotating on adds means more segments than rotating on removes alone — segments are
bounded by roster changes in the retention window rather than removals. The drain does one `fetchTopic`
per segment (§5), so this is a handful of extra fetches, traded against transporting a secret.

### 3. Detecting a roster change (Fork 2 — roster-set diff, no mls change)

No accessor exposes a commit's proposals today (`readCommitHeader` returns only `{ epoch,
committerDID }`, `crypto.ts:96`). Rather than add one, detect a roster change by diffing the roster
around application: capture the member DIDs before `processCommit` (via the additive `rosterDIDs()`
port accessor, surfacing `GroupHandle.listMembers()`), compare to after; **any difference between the
two sets — a leaf gained or lost — rotates the anchor**.

Set **inequality**, not set difference: per §2 the anchor sits at the last roster change, so an Add
rotates it just as a Remove does. A commit carrying both an Add and a Remove leaves the leaf count
unchanged and still rotates (a count check would miss it). A self-removal or leave rotates — the leaf
disappears for every member. An external-commit rejoin adds a leaf, so it rotates too, which is what
re-synchronizes a recovering member's anchor with the group (§2). An update, no-op, or ledger-only
commit touches no leaf and does not rotate. No `@kumiai/mls` change.

### 4. Why a removed member is blind

A member removed at the rotation commit never receives that commit's new epoch secret (MLS forward
secrecy), so cannot derive the anchor epoch's `exportSecret()`, so cannot compute the new topic.
Content was always MLS-locked; this closes the metadata channel too. No new leak versus today —
removed members already follow `commitTopic` for life, so they already observe that removals occur.

**Load-bearing:** the anchor must feed the **per-epoch** `exportSecret()`, never the lifelong
recovery secret (which removed members keep for life). A topic derived from the recovery secret plus
a guessable epoch number would cut nobody off. This is also why the anchor cannot be announced in
public group state (§2): a value every member can see is a value a later-removed member has kept.

Adds rotate the anchor too (§2), which costs nothing here — an Add does not need to cut anyone off,
and rotating on it is what keeps the anchor derivable by the member being added.

### 5. Delivery and drain (peer-internal)

- **Online:** subscribe the current app topic, live push. On applying a roster-changing commit, update
  the anchor, drop the old subscription (safe — log-class), subscribe the new topic.
- **Returning (peer-internal, automatic on construct/reconnect):** walk the commit log epoch by
  epoch (deriving each `exportSecret()`), pulling **once per segment** — the run of epochs between
  two roster changes is one stable topic — to head, decrypting each frame under the epoch its MLS
  ciphertext names; at each roster-change boundary update the anchor and move to the next segment's
  topic.
  All members (publishers included) derive from the anchor, so a live publisher mid-segment writes
  the same topic a returning peer pulls. Delivered frames reach the host through the **existing
  `handlers` map** — no new host delivery API. The drain pulls only **logged-event** frames
  (`fetchTopic` returns only `retain:'log'`); ephemeral events and all RPC never enter the drain.

### 6. Pruned-window signal (Fork 3 — event, not return value)

Because there is no `ready()`, the peer is eager, and the host drives no catch-up, the signal is an
**event the peer emits**, not a return value. When the internal drain finds the hub's oldest retained
frame is newer than the cursor it needs (a gap below the retention floor), the peer emits a
**pruned-window event** naming the group. The payload carries what rpc knows (the group, and the
gap boundary as a cursor/sequence — an epoch number is acceptable but not required, since the host
cannot render it). It deliberately does **not** carry a wall-clock: the host renders "messages since
<date of last message held>" from its own HLC.

The event is shaped to feed Kubun's inert `GroupHealthMonitor` as a new health condition (e.g.
`'app-window-pruned'`) → `groupHealthChanged`. Wiring it into Kubun is a **Kubun-side follow-up** on
the migration branch; this spec's obligation is only to expose an rpc event whose shape drops
straight in. rpc emits the discovery; the host decides stickiness/dismissal.

### 7. Retention

Members request **30 days** by default via `SubscribeParams.retention`
(`hub-protocol/src/types.ts:84`) — aligned to the commit window so the membership-rebuild bound and
the app-drain bound coincide (no partial-recovery gap). The hub **operator** governs real storage via
the existing `maxRetention` cap; the hub is blind to groups and cannot enforce a per-group figure, so
this is a default members carry, not a new mechanism. Per-member override up to the operator cap
remains possible.

## Blast radius

**rpc-only, no `@kumiai/hub-protocol`/`hub-server`/`mls` public-contract change.** It reuses the
log-class / `fetchTopic` / retention surface the control-ledger release already ships.

Touched:
- `peer.ts` — route a **logged** event's publish to `mux.publish({ retain: 'log' })` while ephemeral
  events and all RPC (`request`/`gather`/`reply`) stay on the existing live path; add `anchorSecret`/
  `anchorEpoch` state; roster-set-diff **roster-change** detection around `processCommit`;
  anchor-based topic derivation in `buildEpoch`; the returning-member per-segment internal drain that
  pulls only logged events; subscribe-current + pull-old; emit the pruned-window event.
- **Durable anchor** (§2) — `{anchorSecret, anchorEpoch}` must survive a restart, so it is persisted
  alongside the handle and restored at construction instead of re-seeded from the live epoch. Whether
  that rides the existing commit journal, a new additive port method, or host-persisted state is an
  implementation seam decided in the plan; either way it is additive, and the handle already persists
  epoch secrets so it is no new class of at-rest exposure.
- The per-procedure `retain` marker on the group protocol definition — an additive optional field on
  `defineGroupProtocol` **or** an rpc-side sidecar map (Q1.1 decides). If it lands on the protocol
  definition it is an **additive** field, not a break. Definition-time enforcement rejects
  `retain:'log'` on a `request`/`gather` procedure.
- `topic.ts` — no signature change (fed anchor values).

Not touched: `@kumiai/mls` (roster-set diff avoids the accessor); hub contracts. `@kumiai/broadcast`
public surface is untouched **unless** Q1.1 puts the `retain` marker on `defineGroupProtocol`, in which
case it gains one additive optional field.

## Deliverables

1. The rpc changes above.
2. **Expand `docs/agents/architecture.md`** (currently a 14-line stub) with the retention-class / lane
   concept map and usage examples — the durable home for the architecture overview.
3. Un-skip and complete `packages/rpc/test/peer-app-drain.test.ts:72`; give the peer test fixture an
   app-handler registration (the fixture currently cannot register one, which is why no test caught
   the loss).

## Testing

Assert the **plaintext the handler received**, not the absence of an error (the original loss passed
a convergence assertion on the line above the failure). Cover:

- The three loss scenarios (epoch never held; own-epoch published after the leaving commit; own-epoch
  after restart), each now delivered by pull.
- A removal rotates the topic and the **removed member cannot derive or read** the post-removal topic.
- A returning member **drains across a rotation boundary** in order under the correct per-epoch keys.
- **Anchor agreement** (the case the original design got wrong, and which same-epoch-boot tests
  structurally cannot catch): a member whose peer boots at a **later epoch than the group's anchor** —
  a late joiner and an external-commit rejoin — still derives the same topic as everyone else and
  exchanges messages with them. An add rotates the anchor for existing members and the joiner alike.
- **Restart agreement:** a member restarting over a handle already past the anchor epoch restores the
  persisted anchor rather than re-seeding from the live epoch, and does not partition. Assert it
  receives messages from a member that never restarted.
- A member away beyond the window gets a **surfaced pruned-window event**, not a silent gap; assert
  the event fires and names the group.
- Roster-set-diff correctness: a commit carrying **both an Add and a Remove** still rotates.
- **Retention split:** an `ephemeral` event (e.g. a typing/presence-shaped procedure) is **not**
  drained — a returning member receives logged events but no ephemeral history.
- **Guardrail:** declaring `retain:'log'` on a `request`/`gather` procedure is rejected at protocol
  definition time.

**Mutation-check** the decisive tests: revert the log-class publish; revert the anchor update; revert
the pruned-window emit — each must turn a green test red.

## Residuals (stated, not hidden)

- A member away longer than 30 days loses those messages — a stated bound, surfaced as a
  pruned-window event, never silent.
- A returning member re-derives per-epoch keys across the drained span (bounded by retention; it
  walks the commit log to rebuild anyway).
- High app volume × 30-day retention is real hub storage; the operator's `maxRetention` is the cap.
- Rotating on adds (§2) means more segments than rotating on removals alone, so a returning member
  does one `fetchTopic` per roster change in its window rather than per removal. Bounded and small
  (roster changes are rare next to commits), and it is the price of an anchor every member can derive
  without transporting a secret.

## Resolved open calls

- **Retention model** — two orthogonal dimensions (kind × retention); only events may be `log`,
  correlation is always ephemeral (§1). Retention is declared **per procedure** in the group protocol
  definition (not per call), enforced at definition time. Send API stays a single `dispatch`.
- **Anchor definition** (corrected 2026-07-16, mid-implementation) — the anchor sits at the last
  **roster change**, not the last Remove, and is **durably persisted** (§2). Forced by two constraints:
  the anchor epoch must be one every current member holds the secret for (≥ the newest join, since MLS
  ratchets forward and the secret cannot be reached back for), and after every removal (§4). Their
  intersection is `max(last add, last remove)`. Rejected the alternative of announcing the anchor in
  Welcome/GroupInfo — it still needs persistence, cannot use a public GroupContext extension without
  defeating §4, and leaks pre-join metadata to joiners.
- **Roster-change detection** — roster-set diff (§3), set **inequality**, no additive mls accessor
  needed beyond `rosterDIDs()` on the rpc port.
- **Pruned-window signal shape** — an rpc **event** shaped to feed a host health condition (§6),
  not a return value; forced by Kubun's eager-peer / no-`ready()` / no-host-catch-up model.

## Deferred to the plan

- Where the per-procedure `retain` marker lives (additive `defineGroupProtocol` field vs. rpc sidecar)
  and how a logged event's publish reaches `mux.publish({ retain: 'log' })` — the Q1.1 seam; both
  additive/non-breaking.
- Exact event name/payload type for the pruned-window signal (rpc side) and the matching
  `GroupHealthCondition` (Kubun side, follow-up).
- Plan mode: this design carries validated-but-unexercised integration assumptions (the 0.3 recovery
  lane is undriven by any host today), which leans `learning-loop`; confirm at planning.
