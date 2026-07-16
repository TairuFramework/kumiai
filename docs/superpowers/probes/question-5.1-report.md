# Probe report — question 5.1: members carry a 30-day retention request on app-topic subscribes

**Status: DONE.** Branch `feat/app-lane-delivery`, uncommitted, nothing committed or stashed.

## Answer

Yes. A member now asks the hub to hold its app log for 30 days by default, aligned to the commit
window so the membership-rebuild bound and the app-drain bound coincide. It is a default the member
carries on `SubscribeParams.retention`, overridable per host via `appLogRetentionSeconds` up to the
operator's `maxRetention` cap. No new mechanism; no hub-side change.

## Changes

- `packages/rpc/src/peer.ts:76` — `DEFAULT_APP_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60`, with the
  why: aligned to the commit window so there is no span where a member can rebuild its membership
  but not its messages. A separate dial rather than the commit one reused, because the alignment is
  a choice.
- `packages/rpc/src/peer.ts:176` — `appLogRetentionSeconds?: number` on `GroupPeerParams`, mirroring
  `commitLogRetentionSeconds` in shape, default and doc style.
- `packages/rpc/src/peer.ts:325` — resolved once against the default, beside the commit one.
- `packages/rpc/src/peer.ts:471` — `buildEpoch` retains the app topic with the window before the
  transports are built (the live lane's subscribe; see "the live listener subscribe" below).
- `packages/rpc/src/peer.ts:897` — `loadAppSegment`'s listener-less `retainTopic` carries the window.
- `packages/rpc/src/hub-mux.ts:64,278` — `retainTopic(topicID, options?: HubSubscribeOptions)`,
  a pass-through to `retain`, which already passed options to `hub.subscribe`. Doc notes the
  refcount means the FIRST retain's options are the ones the hub sees.

Tests:

- `packages/rpc/test/hub-mux.test.ts:44` — `retainTopic` passes retention through to `hub.subscribe`.
- `packages/rpc/test/peer-control-lanes.test.ts:121` — app topic carries 30 days at the hub by
  default, and so does the commit topic (the two bounds coincide).
- `packages/rpc/test/peer-control-lanes.test.ts:150` — override reaches the hub on the app topic and
  moves the commit window not at all (two dials).
- `packages/rpc/test/peer-control-lanes.test.ts:182` — the topic a rotation lands on carries the
  window on the drain's listener-less subscribe.
- `packages/rpc/test/peer-control-lanes.test.ts:243` — a peer with no commit lane (no drain) still
  carries the window on the lane-building subscribe.
- The existing commit-lane retention test (`peer-control-lanes.test.ts:92`) is untouched and green.

All assertions read `hub.requestedRetention(topic)` — the value that reached `hub.subscribe` on the
FakeHub, never the constructor param.

## Every app-topic subscribe path — found, and which ones

Three call sites reach `hub.subscribe` for an app topic, all through the mux's refcounted `retain`:

1. `peer.ts:471` `buildEpoch` → `mux.retainTopic` — the live lane. **New line.**
2. `peer.ts:897` `loadAppSegment` → `mux.retainTopic` — the drain's listener-less subscribe.
3. `peer.ts:481,495` `createBroadcastTransport({ bus: mux.bus })` → `bus.subscribe` → `onInbound`.

`inboxTopic` (directed RPC) and the rendezvous topic are mailbox lanes, not app topics, and take the
hub's default as before. Only the FIRST retain of a topic reaches `hub.subscribe` — the refcount
makes the rest local — so what matters is that whichever path gets there first carries the window.
Now all of them do, and the ordering stops being load-bearing.

**The live listener subscribe (3) carries it via (1), not via the bus.** `BroadcastBus.subscribe`
(`packages/broadcast/src/bus.ts:7`) is a generic fan-out abstraction with no notion of a hub, and
threading `HubSubscribeOptions` through it would have meant changing the `broadcast` package to know
about hub retention. Instead `buildEpoch` retains the topic explicitly, with the window, before it
builds the transports — so the hub's one subscribe for the live lane carries it and the transport's
later `bus.subscribe` is a local refcount bump. This is the one place the approved approach was met
by a different mechanism than the wording suggests; the invariant it asked for holds exactly.

## Mutation check (required)

Each app-topic subscribe site was mutated separately, and each by hand-inverting afterwards — no
`git checkout`/`restore`/`stash` was run at any point.

**Mutation A** — drop the retention from the drain's listener-less subscribe, `peer.ts:897`:

```diff
-      mux.retainTopic(topicID, { retention: appLogRetentionSeconds })
+      mux.retainTopic(topicID)
       const stored = (await appCursorStore?.load(topicID)) ?? null
```

```
PASS (7) FAIL (3)
   AssertionError: expected undefined to be 2592000 // Object.is equality
   AssertionError: expected undefined to be 4321 // Object.is equality
   AssertionError: expected undefined to be 4321 // Object.is equality
```

**Mutation B** — drop the retention from the live lane's subscribe, `peer.ts:471`:

```diff
-      mux.retainTopic(topicID, { retention: appLogRetentionSeconds })
+      mux.retainTopic(topicID)
       const selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)
```

```
PASS (10) FAIL (1)
   AssertionError: expected undefined to be 4321 // Object.is equality
```

Both inverted by hand; confirmed green, no residue:

```
 Test Files  36 passed (36)
      Tests  214 passed (214)
```

## Surprise worth recording

Mutation B initially went **green** — the first version of the test set could not see the live
lane's subscribe at all. The reason is ordering: for a peer with a commit lane, `loadAppSegment`
retains every app topic (including the live one) *before* `buildEpoch` runs, so the drain's
subscribe is the one the hub sees and `buildEpoch`'s is a refcount bump. The live lane's subscribe
is only the first one for a peer constructed **without** `mls` — no commit lane, so no drain. That
is what `peer-control-lanes.test.ts:243` covers, and it is what turned mutation B red.

Worth knowing beyond this question: **the drain, not the live lane, is what actually asks the hub to
hold an app log today.** Both sites now pass the same value, so the ordering no longer decides the
window — which is the point of carrying it on every subscribe rather than the one believed to be
first.

## Concerns

- **Not a finding, restating the filed one:** `hub-mux.ts:114` swallows subscribe errors, so a host
  that sets `appLogRetentionSeconds` above the operator's `maxRetention` is not downgraded — it is
  silently not subscribed to its own app topics. That widens the blast radius of the filed issue
  (`docs/agents/plans/next/2026-07-16-mux-swallows-subscribe-failure.md`) from the commit lane to
  the app lane: this question adds a second overridable dial pointing at the same swallow. Left
  alone per scope; no test here depends on the swallow either way.
- `buildEpoch` now retains the app topic on every rebuild, so the refcount for a long-lived topic
  climbs by one per rotation onto it. Harmless — app-topic refcounts never fall to zero anyway (the
  mux never unsubscribes, deliberately) and no hub call results — but it is a counter that only
  grows.
- The alignment of the two windows is asserted as two independent 30-day defaults, not as one
  derived from the other. That is deliberate per the approach (aligned by choice), but it does mean
  a host moving `commitLogRetentionSeconds` alone silently reopens the partial-recovery gap the
  alignment exists to close. Nothing warns. Possibly a docs matter for the architecture question.
