# Probe report — anchor-derived app topic: stable across non-removal, rotates on Remove

**Status: DONE as specified, with one blocking finding the lane must resolve before it can ship.**

The approved approach did not fight the code. The topic-derivation swap is four lines, `topic.ts` is
untouched, and rotation fell out of the existing `rebuildEpoch` path with no new plumbing. Both
required tests pass, and the whole suite is green.

The finding is not about the swap. It is that binding the topic to the anchor makes a latent defect
in the anchor's **seeding** (committed under Q2.1, outside this question's scope) load-bearing and
fatal: two members whose peer objects bootstrap at different epochs derive **different app topics
and cannot hear each other at all**, with no Remove anywhere in sight. Measured below.

## The exact question, answered

Yes, on both halves, for members that share an anchor:

- **Stable across non-removal:** epochs advance (update / no-op / add-only commits), the anchor does
  not, and `buildEpoch` re-derives the identical topic. Delivery continues; all frames land on the
  one topic ID.
- **Rotates on Remove:** the applied Remove moves the anchor (`peer.ts:846`), `rebuildEpoch` re-runs
  `buildEpoch`, and it derives a new topic ID. Delivery continues across the rotation, both
  directions.

## Changes

All in `packages/rpc/src/peer.ts`. `topic.ts` unchanged — the functions receive anchor values
instead of live per-epoch ones, exactly as the spec said they would.

| Line | Change |
| --- | --- |
| `289` | `protocolTopic(anchor.secret, anchor.epoch, name)` — was `(secret, epoch, name)` |
| `296` | `selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)` |
| `326` | acceptor `resolveSendTopic: (senderDID) => inboxTopic(anchor.secret, anchor.epoch, senderDID)` |
| `385-386` | `createDirectedClient({ secret: anchor.secret, epoch: anchor.epoch })` |
| `230-233` | `ProtocolRuntime.topicID` doc: records the anchor-bound invariant |
| `256-263` | `epoch` doc: rewritten — it is no longer "the epoch the app lane is built at" |

`wrap: crypto.wrap` / `unwrap: crypto.unwrap` are **unchanged**: content stays sealed under the live
epoch, only the topic ID is anchor-bound.

### The `secret` / `epoch` module vars

Checked every reader, as instructed.

- **`secret` (was `peer.ts:255`, written `:279`) — REMOVED.** After the swap its only four readers
  were the derivations above, leaving it write-only. Both the declaration and the
  `secret = await crypto.exportSecret()` line in `buildEpoch` are gone.
- **`epoch` (`:266`) — KEPT.** Not app-lane-only: `frameCommit` (`:956`) reads it for the commit-lane
  guard `if (crypto.epoch() !== epoch)`, which refuses to seal bodies once the host has advanced past
  the framed epoch. It is still written in `buildEpoch` (`:280`) and genuinely read, so it is not
  write-only. Its doc comment claimed it was "the epoch the app lane is built at", which the swap
  made false; rewritten to describe what it actually is now (the live epoch the commit lane frames
  at), keeping the load-bearing "zero is not neutral" rationale.

### Rotation: the existing rebuild path was enough

No new plumbing, per the brief. `pullCommits` sets the anchor on an applied Remove (`:846`) and
returns `advanced: true`; every caller already rebuilds on an advance — `reconcileCommits` (`:867`),
`onCommitDelivery` (`:885`), `commit` (`:1262`), `recover` (`:1442`). `buildEpoch` re-reads `anchor`
each run, so a moved anchor produces the new topic and an unmoved one reproduces the same string.
The ordering is already correct: the anchor is written during the pull, strictly before the rebuild
that reads it.

I did **not** take the optional "skip the rebuild when the anchor is unchanged" optimisation.
Correctness was the bar and the rebuild is harmless: `hub-mux` refcounts local listeners and never
unsubscribes, and `FakeHub.subscribe` only adds a DID to a set, so re-subscribing to the same topic
redelivers nothing and costs nothing observable.

## The test

New: `packages/rpc/test/peer-app-topic.test.ts`, two tests, both passing.

`makeMLSPeer` hardcodes the `chat` protocol, which has no `retain:'log'` procedure, so the file has a
local `makeRoomPeer` wiring the same MLS port (`createMemoryGroupMLS` + `onAdvance` → crypto) to a
`room` protocol with `'room/posted': { type: 'event', retain: 'log' }`.

1. **Stable across non-removal** — alice and bob exchange logged events across an update/no-op commit
   and an add-only commit (epochs 1→2→3). Every event reaches the other's handler; both anchors stay
   at 1; the topic ID is unchanged throughout. Tied to the wire, not just the derivation:
   `hub.fetchTopic(genesisTopic)` returns **all three** frames, and the per-epoch topics the group
   would otherwise have moved onto have **zero subscribers**.
2. **Rotates on Remove** — carol is evicted; both members independently rotate to anchor epoch 2 and
   agree; the new topic ID differs from the pre-removal one; delivery continues both ways;
   `fetchTopic` shows 2 frames on the new topic and the original 1 still on the old.

**The tests are not vacuous.** Reverting `:289` to the per-epoch derivation fails test 1 with
`expected [ Array(1) ] to have a length of 3` — the frames scatter across three topics. Test 2 still
passes under the *old* derivation (per-epoch rotates on every commit, including Removes), which is
precisely why test 1 is the discriminating one; the file's header comment says so, so nobody later
mistakes test 2 for sufficient.

### Existing tests: 5 failed, all encoding the old per-epoch premise

The brief expected `peer-control-lanes.test.ts` to stay green. It did not, and neither did four
others. None was a regression in the swap — each asserted, as its premise, that an epoch advance
rotates the app topic. That is the behaviour this change deliberately removes. Updated to the new
invariant rather than weakened:

- `peer-commit-lane.test.ts:45-51` — "his app lane was rebuilt at the epoch he reached, not the one
  he joined at" is now exactly backwards. **Inverted**: dave sits on his anchor's topic (epoch 1),
  not the live epoch 3 he pulled up to. This test is the clearest statement of the finding below.
- `peer-control-lanes.test.ts:20` — its real subject is "a rotation never unsubscribes", which a
  stable topic would leave untested. **Rewritten to keep it**: it now drives a genuine Remove
  (`publishCommit({ removes: ['carol'] })`) so the topic really rotates, and still asserts the
  rotated-off subscription survives. The old test faked rotation with `crypto.setEpoch(2)` +
  `resync()`, which left the MLS port at epoch 0 while the crypto sat at 1 — the two were decoupled
  and no commit was ever applied. Driving a real commit required `epoch: 1` and `onAdvance` on the
  port to make them agree.
- `peer-control-lanes.test.ts:116,164` — non-removal commits. **Inverted**: the topic holds, and the
  per-epoch topic has zero subscribers.
- `peer-recovery.test.ts:46` — an external-commit rejoin only adds a leaf. **Inverted**: eve's anchor
  is untouched by her rejoin and nobody moves onto an epoch-4 topic.

## Finding: the anchor is seeded per-peer, not per-group — this breaks delivery on restart

**This is the one thing that must not be lost from this report.**

`peer.ts:1499` seeds the anchor at construction:

```ts
anchor = { secret: await crypto.exportSecret(), epoch: crypto.epoch() }
```

That is a **local, construction-time** value. The spec defines the anchor as captured "at the last
commit containing a Remove" — a fact about **group history** that every member must agree on. The
implementation approximates it with "the epoch this peer object happened to boot at". Those coincide
only for members that boot together at genesis — which is exactly the shape of every test in the
suite, and why this was invisible until now.

Two members that bootstrap at different epochs derive different anchors, hence different app topics,
hence **hear nothing from each other** — silently, with no Remove involved, forever (until a Remove
happens to resynchronise them). Measured with a throwaway probe (not committed): alice boots at
epoch 1, the group advances twice with non-removal commits, dave's peer then boots over a handle
already at epoch 3 (a restart, or a late join), alice dispatches one event:

| | messages dave received |
| --- | --- |
| Per-epoch derivation (before this change) | **1** |
| Anchor derivation (after this change) | **0** |

alice anchors at 1, dave at 3. Before the change both converged to epoch 3 and agreed on the topic,
so it worked; after, they diverge permanently. This is a **regression introduced by making the topic
anchor-bound**, and it fires on the most ordinary event in the system: a phone restarting.

`peer-commit-lane.test.ts` and `peer-recovery.test.ts` now document this in passing — dave anchors at
1 while the group is at 3; eve anchors at 1 while carol and dave anchor at 3, on a different app
topic. Those tests pass only because they never exchange app messages.

I did **not** fix it. It is outside this question's stated scope ("topic-ID source only"; the anchor
state and its seeding are Q2.1's committed work), and the fix is a design decision, not plumbing —
the anchor must become group-derived and durable. Roughly, the options:

1. **Derive it from the commit log.** The log is the group's agreed history and every member already
   walks it; the last Remove in it is a value they would all compute alike. Costs: a member whose
   backlog was trimmed past the last Remove cannot compute it, and the secret at that epoch is not
   recoverable by replay (MLS ratchets forward), so this needs the secret carried, not recomputed.
2. **Carry it in the Welcome / GroupInfo**, so a joiner adopts the group's anchor instead of minting
   its own. Does not by itself fix restart — see 3.
3. **Persist the anchor** alongside the handle, so a restart restores rather than re-seeds it. Needed
   under any of the above; the anchor is currently in-memory only, so today a restart re-seeds it
   from the live epoch even for a founding member.

(1)+(3) or (2)+(3) both look viable; (3) alone is not sufficient for a genuine late joiner.

## Surprises

- **`epoch` survived; `secret` did not.** The brief anticipated both might go. `frameCommit`'s guard
  is a non-app-lane reader of `epoch`, so removing it would have broken the commit lane.
- **The old control-lanes rotation test never applied a commit.** It hand-set the crypto epoch while
  the MLS port sat at epoch 0. It asserted rotation without ever exercising the path that rotates.
- **`fetchTopic` throws rather than returning empty** for a non-subscriber, so "the group never used
  the per-epoch topic" is asserted with `subscriberCount(...) === 0` — a stronger claim than an empty
  fetch anyway: the topic was never even subscribed to.

## Concerns

1. **Blocking — the anchor is not group-agreed or durable** (above). This change is correct in
   isolation and unshippable until that is resolved; it trades "rotates too often" for "silently
   partitions the group on restart". The required tests cannot catch it, because both their peers
   boot at the same epoch.
2. Directed-lane topics are now anchor-bound too, per the approved approach. Same divergence applies,
   and the scope boundary (a directed message sent during a segment the member never subscribed
   remains out of scope) is respected.
3. `peer-app-drain.test.ts`'s skipped test is unaffected and still correctly skipped; the app lane
   still has no pull-readable back-fill, so the log-class frames on a rotated-off topic are retained
   but nothing reads them back. That is Phase 3 (the returning-member drain), not built here.

## Verify — real output

`pnpm run build && rtk proxy pnpm run lint && pnpm test --force` (repo root, uncached, `EXIT=0`):

```
 Tasks:    8 successful, 8 total
Cached:    8 cached, 8 total
  Time:    22ms >>> FULL TURBO

$ biome check --write ./packages ./tests
Checked 214 files in 169ms. No fixes applied.

@kumiai/rpc:test:unit:  Test Files  32 passed (32)
@kumiai/rpc:test:unit:       Tests  190 passed | 1 skipped (191)

 Tasks:    30 successful, 30 total
Cached:    0 cached, 30 total
  Time:    15.308s
```

The 1 skipped test is the pre-existing, deliberate skip in `peer-app-drain.test.ts` (documented there
as failing for the right reason), untouched by this work.
