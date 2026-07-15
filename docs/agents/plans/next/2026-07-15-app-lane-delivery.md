# App-lane delivery: reach a member who was away

**Status:** design approved (2026-07-15), ready to plan and implement.
**Priority:** real bug (silent app-message loss), but **additive to rpc** — a non-breaking follow-on MINOR.
It does **not** gate the control-ledger-lane release; see
[../completed/2026-07-15-control-ledger-lane.complete.md](../completed/2026-07-15-control-ledger-lane.complete.md).
**Evidence in tree:** the skipped test `packages/rpc/test/peer-app-drain.test.ts` fails for exactly this
reason; the peer test fixture cannot register an app handler, which is why no test ever caught the loss.

## The problem

A member is **structurally unable to receive app traffic from any epoch it was not subscribed through** —
not merely past a retention window, *any* epoch it slept through. At the design's commit volume the epoch
turns over constantly, so an ordinary user closing their laptop over lunch loses every message sent while
away. Three composed properties cause it: app topics are epoch-derived; app frames are **mailbox-class**
(push-only, a per-recipient delivery created at publish time for the then-current subscribers, dropped if
none); and `subscribe` back-fills nothing. The control-ledger work closed every path that *deleted* mail
(unsubscribe-as-destructor on rotation and on `dispose`); this closes the paths that merely *fail to
deliver*.

## Architecture context (the two retention classes and the lanes)

The hub is a blind pub/sub store over opaque topic IDs. Every frame is one of two classes:

- **`log`** — retained unconditionally, trimmed only by age/depth; live-pushed to current subscribers **and**
  pullable via `fetchTopic` to a cursor; has a stored `head` supporting compare-and-set. For convergence.
  Unsubscribing a log-class topic frees nothing (its frames and head survive).
- **`mailbox`** (default) — per-recipient pending delivery, ack-refcount GC, push-only, dropped if no
  subscriber at publish. For directed ephemeral delivery.

Lanes map onto these: the **commit lane** (`commitTopic`, log-class, lifelong recovery secret) is the CAS'd
membership log; the **rendezvous topic** (`rendezvousTopic`, mailbox-class, lifelong recovery secret)
carries the sealed recovery + ledger gathers; the **app lane** (`protocolTopic` broadcast, `inboxTopic`
per-DID mail) is derived from the **per-epoch** secret (`exportSecret()`), so a removed member is cut off by
forward secrecy. The app lane is currently mailbox-class — that is the bug.

## The design

**1. App frames become log-class and pullable** — symmetric with the commit lane. A log-class frame pushes
live to online subscribers *and* is retained for pull, so "drain epoch E fully" becomes a `fetchTopic` the
peer can complete and *know* it completed. Accumulation is a non-issue: since unsubscribing a log-class
topic frees nothing, a peer subscribes only the *current* app topic for live push and reaches old ones by
pull.

**2. Topic model — derived anchor, rotate on removal.** `appTopic = protocolTopic(anchorSecret, anchorEpoch,
name)` (and `inboxTopic(anchorSecret, anchorEpoch, did)`), where `anchorSecret`/`anchorEpoch` are captured
from `exportSecret()` at the **last commit containing a Remove**. Non-removal commits leave the topic stable;
a Remove rotates it. New peer state `anchorSecret`/`anchorEpoch`, updated whenever a Remove-bearing commit
is applied. Detecting a Remove is inspectable from the applied proposals — no announced value, no new control
message, pure derivation.

**3. Why a removed member is blind.** A member removed at the rotation commit never receives that commit's
new epoch secret (MLS forward secrecy), so cannot derive the anchor epoch's `exportSecret()`, so cannot
compute the new topic. Content was always MLS-locked regardless; this closes the metadata channel too. No
new leak versus today — removed members already follow `commitTopic` for life, so they already observe that
removals occur. **Load-bearing:** the anchor must feed the *per-epoch* secret, never the lifelong recovery
secret (which removed members keep for life) — else a topic derived from it plus a guessable epoch number
cuts nobody off.

**4. Delivery and drain.** Online: subscribe the current app topic, live push; on applying a Remove, update
the anchor, drop the old subscription (safe — log-class), subscribe the new topic. Returning: walk the
commit log epoch by epoch (deriving each `exportSecret()`), pulling **once per segment** (the run of epochs
between two removals — one stable topic) to head, decrypting each frame under the epoch its MLS ciphertext
names; at each Remove boundary update the anchor and move to the next segment's topic. All members —
publishers included — derive from the anchor, so a live publisher mid-segment writes the same topic a
returning peer pulls.

**5. Retention.** Members request **30 days** by default — aligned to the commit window, so the
membership-rebuild bound and the app-drain bound coincide (no partial-recovery gap). The hub **operator**
governs real storage via the existing `maxRetention` cap; the hub is blind to groups and cannot enforce a
per-group figure, so this is a default members carry into `SubscribeParams.retention`, not a new mechanism.
Per-member override up to the operator cap remains possible.

## Blast radius

**rpc/mls only — no hub-protocol/hub-server public-contract change.** It reuses the log-class / `fetchTopic`
/ retention surface the control-ledger release already ships. The change is `peer.ts` (publish `retain:
'log'`; anchor state; the returning-member per-segment drain; subscribe-current + pull-old); `topic.ts` needs
no signature change (feed anchor values to the existing functions). An mls touch is needed only if capturing
the anchor secret or detecting a Remove in a commit needs a new `GroupMLS` accessor — and that would be
**additive** (a new optional method), not a break.

## Deliverables

1. The rpc changes above.
2. **Expand `docs/agents/architecture.md`** with the retention-class / lane concept map and usage examples
   (currently a 15-line stub). This is the durable home for the architecture overview.
3. Un-skip and complete `packages/rpc/test/peer-app-drain.test.ts`; give the peer test fixture an app-handler
   registration.

## Testing

Assert the **plaintext the handler received**, not the absence of an error (the original loss passed a
convergence assertion on the line above the failure). Cover: the three loss scenarios (epoch never held;
own-epoch published after the leaving commit; own-epoch after restart), each now delivered by pull; a
removal rotates the topic and the **removed member cannot derive or read** the post-removal topic; a
returning member **drains across a rotation boundary** in order under the correct per-epoch keys; and a
member away beyond the window gets a surfaced "pruned beyond your window" signal, not a silent gap.
Mutation-check the decisive tests (revert the log-class publish; revert the anchor update).

## Residuals (state, do not hide)

A member away longer than 30 days loses those messages — a stated bound, surfaced as a pruned-window signal,
never silent. A returning member re-derives per-epoch keys across the drained span (bounded by retention,
and it walks the commit log to rebuild anyway). High app volume × 30-day retention is real hub storage; the
operator's `maxRetention` is the cap.

## Open implementation calls (for the plan)

Whether "a commit contains a Remove" needs a new additive `GroupMLS` accessor or can reuse existing commit
inspection; and the exact shape of the pruned-window signal surfaced to the host.
