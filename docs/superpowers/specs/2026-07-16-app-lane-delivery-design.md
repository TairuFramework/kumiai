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

### 1. App frames become log-class and pullable (Fork 1 — via `mux.publish`/`fetchTopic`)

App publish routes through `mux.publish({ topicID, payload, retain: 'log' })` — the exact machinery
the commit lane already uses and tests. `BroadcastClient` is kept **only** for live-push subscribe
(`bus.subscribe` → `onInbound`) and for its `wrap`/`unwrap` (encryption) responsibilities; its
publish leg is redirected to `mux.publish` with `retain: 'log'`. No `@kumiai/broadcast` public
signature changes — the transport is handed a publish function.

A log-class frame pushes live to online subscribers **and** is retained for pull, so "drain epoch E
fully" becomes a `fetchTopic` the peer can complete and *know* it completed. Accumulation is a
non-issue: unsubscribing a log-class topic frees nothing, so a peer subscribes only the *current*
app topic for live push and reaches old ones by pull.

Rejected alternatives: widening `BroadcastBus.publish` with `retain` + adding a pull method (pushes
log semantics into a generic fan-out lib and changes its public surface); fully retiring
`BroadcastClient` for the app lane (largest rewrite, no benefit over reusing `mux`).

### 2. Topic model — derived anchor, rotate on removal

`appTopic = protocolTopic(anchorSecret, anchorEpoch, name)` and `inboxTopic(anchorSecret,
anchorEpoch, did)`, where `anchorSecret`/`anchorEpoch` are captured from `exportSecret()` at the
**last commit containing a Remove**. Non-removal commits leave the topic stable; a Remove rotates
it. New peer state `anchorSecret`/`anchorEpoch`, updated whenever a Remove-bearing commit is applied.
`topic.ts` needs no signature change — the existing functions receive anchor values instead of the
current per-epoch values.

### 3. Detecting a Remove (Fork 2 — roster-set diff, no mls change)

No accessor exposes a commit's proposals today (`readCommitHeader` returns only `{ epoch,
committerDID }`, `crypto.ts:96`). Rather than add one, detect a Remove by diffing the roster around
application: capture `GroupHandle.listMembers()` DIDs before `processCommit`, compare to after; **any
leaf present-before-and-absent-after means a Remove was applied** → rotate the anchor. This is robust
to the Add+Remove-in-one-commit case (a count check is not) and to self-removal/leave (the leaf
disappears for everyone). External-commit rejoin only *adds* a leaf, so it correctly does not rotate.
No `@kumiai/mls` change.

### 4. Why a removed member is blind

A member removed at the rotation commit never receives that commit's new epoch secret (MLS forward
secrecy), so cannot derive the anchor epoch's `exportSecret()`, so cannot compute the new topic.
Content was always MLS-locked; this closes the metadata channel too. No new leak versus today —
removed members already follow `commitTopic` for life, so they already observe that removals occur.

**Load-bearing:** the anchor must feed the **per-epoch** `exportSecret()`, never the lifelong
recovery secret (which removed members keep for life). A topic derived from the recovery secret plus
a guessable epoch number would cut nobody off.

### 5. Delivery and drain (peer-internal)

- **Online:** subscribe the current app topic, live push. On applying a Remove, update the anchor,
  drop the old subscription (safe — log-class), subscribe the new topic.
- **Returning (peer-internal, automatic on construct/reconnect):** walk the commit log epoch by
  epoch (deriving each `exportSecret()`), pulling **once per segment** — the run of epochs between
  two removals is one stable topic — to head, decrypting each frame under the epoch its MLS
  ciphertext names; at each Remove boundary update the anchor and move to the next segment's topic.
  All members (publishers included) derive from the anchor, so a live publisher mid-segment writes
  the same topic a returning peer pulls. Delivered frames reach the host through the **existing
  `handlers` map** — no new host delivery API.

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
- `peer.ts` — redirect app-lane publish to `mux.publish({ retain: 'log' })`; add `anchorSecret`/
  `anchorEpoch` state; roster-set-diff Remove detection around `processCommit`; anchor-based topic
  derivation in `buildEpoch`; the returning-member per-segment internal drain; subscribe-current +
  pull-old; emit the pruned-window event.
- `topic.ts` — no signature change (fed anchor values).
- A small transport seam so `BroadcastClient`'s publish reaches `mux.publish` with `retain: 'log'`
  while its subscribe path is unchanged.

Not touched: `@kumiai/broadcast` public signatures; `@kumiai/mls` (roster-set diff avoids the
accessor); hub contracts.

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
- A member away beyond the window gets a **surfaced pruned-window event**, not a silent gap; assert
  the event fires and names the group.
- Roster-set-diff correctness: a commit carrying **both an Add and a Remove** still rotates.

**Mutation-check** the decisive tests: revert the log-class publish; revert the anchor update; revert
the pruned-window emit — each must turn a green test red.

## Residuals (stated, not hidden)

- A member away longer than 30 days loses those messages — a stated bound, surfaced as a
  pruned-window event, never silent.
- A returning member re-derives per-epoch keys across the drained span (bounded by retention; it
  walks the commit log to rebuild anyway).
- High app volume × 30-day retention is real hub storage; the operator's `maxRetention` is the cap.

## Resolved open calls

- **Remove detection** — roster-set diff (§3), no additive mls accessor needed.
- **Pruned-window signal shape** — an rpc **event** shaped to feed a host health condition (§6),
  not a return value; forced by Kubun's eager-peer / no-`ready()` / no-host-catch-up model.

## Deferred to the plan

- Exact event name/payload type for the pruned-window signal (rpc side) and the matching
  `GroupHealthCondition` (Kubun side, follow-up).
- The precise seam by which `BroadcastClient` publish reaches `mux.publish` (inject a publish fn vs.
  a thin log-transport variant) — an implementation choice, both non-breaking.
- Plan mode: this design carries validated-but-unexercised integration assumptions (the 0.3 recovery
  lane is undriven by any host today), which leans `learning-loop`; confirm at planning.
