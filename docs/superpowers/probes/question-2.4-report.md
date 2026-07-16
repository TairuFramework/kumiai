# Probe report — the app-lane anchor must survive a restart

**Status: ANSWERED — yes.** Persisting the anchor at every capture site and restoring it at
construction keeps a restarted peer on the group's topic. The restart test converges; dropping the
restore partitions it, on the wire, exactly as predicted.

Branch `feat/app-lane-delivery`. **Uncommitted, nothing staged, no branch switch.**

## Where `AnchorStore` went, and why

New file **`packages/rpc/src/anchor.ts`**, exported from `packages/rpc/src/index.ts:7` as
`export type { Anchor, AnchorStore }`.

Neither of the existing candidates fits.

- `roster.ts` is one pure function over two DID arrays — no state, no I/O, no types. It answers
  *"did the roster change?"*; it does not hold anything. A durable port in it would be the only
  thing in the file that touches the world.
- `commit.ts` is the commit lane: `CommitJournal`, `PendingCommit`, `JournalEntry`, the lane's
  errors. The anchor is not commit-lane state — it is app-lane state that a commit happens to
  rotate. Putting a long-lived, never-cleared slot next to a single-slot, cleared-on-outcome one
  invites exactly the overloading the brief rules out.

`anchor.ts` also gives the `Anchor` type a name. It was an inline structural type at the `let` in
`peer.ts`; the store's signature needs it, the fixture needs it, and a host implementing the port
needs it. Both halves move as a pair — a secret from one epoch under another epoch's number derives
a topic nobody is on — so the type is worth having.

## Changes

### `packages/rpc/src/anchor.ts` (new)

`Anchor = { secret, epoch }` and `AnchorStore = { load(): Promise<Anchor | null>; save(anchor):
Promise<void> }`. The doc states the invariant: the anchor is persisted state, not derived state,
because a rebooted handle can never re-export an earlier epoch's secret; `load()` returning `null`
means first boot and only first boot.

### `packages/rpc/src/peer.ts`

- **`:118` — `anchorStore: AnchorStore` added to `GroupPeerMLSParams`, required.** The type's doc
  comment now covers the third member on the same terms it already gave for the second: a peer with
  a port and no journal silently loses commits, a peer with a port and no anchor store silently
  partitions from its own group on restart. Both failures are silent, and the type is what stops a
  host wiring either.
- **`:159` — the non-MLS branch of the `GroupPeerParams` union** gains `anchorStore?: undefined`,
  so a peer without a port still cannot smuggle one in.
- **`:325` — the `anchor` declaration** is now typed `Anchor` and its doc carries the persistence
  invariant.
- **`:340` — new `captureAnchor()`**: the one place the anchor is read off the live handle and the
  one place it is saved. Both rotation sites and the first-boot seed call it.
- **`:933` — the apply site in `pullCommits`** (`detectRosterChange(...) || header?.external ===
  true`) now `await captureAnchor()`.
- **`:1527` — the rejoin adopt in `recover()`** now `await captureAnchor()`, still after
  `onAccepted`, where the post-commit epoch is what gets captured.
- **`:1610` — construction**: `await anchorStore?.load()` first. Non-null restores; null seeds via
  `captureAnchor()` (which persists it). Both branches run before `initControlLanes()`, so every
  lane is built on the settled anchor. The old comment about seeding before the seed pull is kept
  and extended — the ordering constraint it records still holds for the restore branch.

`anchorStore` is `AnchorStore | undefined` after the destructure, because the union permits a peer
with no MLS port. The two rotation sites only run inside the commit lane, which needs the port; the
seed path runs for every peer, so `?.` is load-bearing there and free elsewhere.

### The accepted residual, recorded

At `captureAnchor` (`peer.ts:329-339`), stated as a known bound and not a TODO: `processCommit` is
durable before the capture runs, so a crash between the two leaves a persisted anchor one rotation
stale and the restarted peer stays off the group's topic until the next roster change rotates it
again. Closing it needs the anchor inside the same durable write as the handle, which this layer
cannot reach — the anchor exists only once the port has committed and returned.

### Tests

- **`packages/rpc/test/fixtures/anchor.ts` (new)** — `createMemoryAnchorStore`, with `stored()` and
  `saves()` observers. It outlives a peer by construction: a "restart" is handing the same instance
  to the new peer, which is the entire subject.
- **`packages/rpc/test/fixtures/peer.ts`** — `makeMLSPeer` takes an optional `anchorStore`, defaults
  to a fresh one, wires it, and returns it on `TestPeer`.
- **`packages/rpc/test/peer-anchor-restart.test.ts` (new)** — below.
- Four direct `createGroupPeer` sites that pass a port had to be wired, which is the required type
  doing its job: `peer-app-topic.test.ts:75`, `peer-commit-reconnect.test.ts:52`,
  `peer-control-lanes.test.ts:37` and `:97`. No test's assertions changed.

## The restart test

`packages/rpc/test/peer-anchor-restart.test.ts`, three tests.

1. **`a peer restarted over a handle past the anchor restores it and stays on the group topic`** —
   alice and bob at epoch 1 (anchor 1). The group is then driven **past the anchor by two
   non-roster-changing commits** (an update/no-op, then a ledger-only enact): live epoch 3, anchor
   still 1. This is what makes the test able to fail — with anchor and live epoch equal, a peer
   that re-seeds and a peer that restores are indistinguishable. Bob is disposed and rebuilt over
   the same handle (at epoch 3) and the same store; alice never restarts. Asserts
   `restarted.mls.epoch() === 3` **and** `restarted.peer.anchorEpoch() === 1` — the persisted
   anchor, not the live epoch — then a logged (`retain: 'log'`) `room/posted` **both ways**
   (alice→bob, bob→alice), then ties it to the wire: `fetchTopic` on `protocolTopic(secret, 1,
   'room')` holds both frames, and `subscriberCount(protocolTopic(secret, 3, 'room')) === 0` — the
   live epoch's topic was never even reached for.
2. **`an empty store is first boot`** — a peer with an empty store anchors at its initial epoch and
   the store holds it: `stored().epoch === 1`, `stored().secret` equals the handle's exported
   secret, `saves() === 1`.
3. **`a roster change rotates the anchor and persists it, and a restart comes back on the new one`**
   — a Remove rotates the anchor to 2 and the store follows (`stored().epoch === 2`); the group
   then drifts to epoch 3 so the restart cannot land on the anchor by accident; the restarted peer
   comes back at `anchorEpoch() === 2`. This covers the rotation-then-restart path, which test 1
   does not: test 1 only exercises the genesis seed surviving.

## Mutation check (required)

Dropped the restore at `peer.ts:1610` — `captureAnchor()` unconditionally, always seeding from the
live handle, i.e. the pre-change behaviour:

```
 FAIL  test/peer-anchor-restart.test.ts > the app-lane anchor survives a restart > a peer restarted over a handle past the anchor restores it and stays on the group topic
AssertionError: expected 3 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 3

 ❯ test/peer-anchor-restart.test.ts:134:42
    132|     // re-seeded from its live handle and partitioned.
    133|     expect(restarted.mls.epoch()).toBe(3)
    134|     expect(restarted.peer.anchorEpoch()).toBe(1)
       |                                          ^
    135|
    136|     // Both ways, on the wire, with a member that never restarted.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/peer-anchor-restart.test.ts > the app-lane anchor survives a restart > a roster change rotates the anchor and persists it, and a restart comes back on the new one
AssertionError: expected 3 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 3

 ❯ test/peer-anchor-restart.test.ts:205:42
    203|     })
    204|     await flush()
    205|     expect(restarted.peer.anchorEpoch()).toBe(2)
       |                                          ^
    206|
    207|     await restarted.peer.dispose()

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

Red for exactly the right reason: the restarted peer anchors at its live epoch (3) instead of the
group's (1, and 2). The first-boot test stays green, as it must — first boot is the one case where
seeding and restoring agree. Reverted; green again with no residue (full verification below).

## Verify

```
$ rtk proxy pnpm run build
 Tasks:    8 successful, 8 total
Cached:    7 cached, 8 total
  Time:    480ms

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./tests
Checked 217 files in 178ms. No fixes applied.

$ rtk proxy pnpm test
@kumiai/rpc:test:unit:  Test Files  33 passed (33)
@kumiai/rpc:test:unit:       Tests  197 passed | 1 skipped (198)
 Tasks:    30 successful, 30 total
```

`pnpm test` is `turbo run test:types test:unit`, so `tsc --noEmit -p tsconfig.test.json` is inside
that pass. The one skip is the pre-existing `peer-app-drain.test.ts` `test.skip` — untouched.
`peer-app-topic`, `peer-recovery`, `peer-commit-lane`, `peer-control-lanes` and
`peer-app-retention` are all green.

## Surprises

None that changed the approach. The approved design fit the code without friction: the anchor was
already written at exactly the three sites the brief named and nowhere else, so folding the save
into a single `captureAnchor()` covered all of them by construction.

One thing worth naming, though it is a fact and not a surprise: `peer-app-retention.test.ts`
constructs peers with **no** MLS port, so it needed no store and was never touched. The required
`anchorStore` binds to the port, exactly as `journal` does — a portless peer never rotates its
anchor, so it has nothing to persist and cannot partition on restart. The union branch enforces
that.

## Concerns

1. **The existing restart tests do not carry the store, and stay green for a reason that will not
   last.** `peer-app-drain.test.ts:94`, `peer-commit-replay.test.ts` (nine sites) and
   `peer-first-commit-crash.test.ts:133`, `peer-recover-lane.test.ts:133` all restart a peer over a
   reused `mls`/`crypto`/`journal` and now get a *fresh* anchor store from `makeMLSPeer`'s default.
   They pass because in every one of them the anchor never rotated — the restarted handle is still
   at the epoch it seeded at, so re-seeding and restoring agree. That is the one case the mutation
   check showed cannot tell the two apart. They model a host that loses its anchor store on every
   restart, which is now a wiring the type forbids. Not fixed here — retrofitting eleven sites in
   four files is outside the boundary — but they are latently wrong, and the first of them that
   grows a roster change before its restart will fail for a reason that has nothing to do with what
   it is testing. Worth a follow-up that threads `anchorStore` through every restart in the suite.
2. **The residual has a real operational shape.** A crash in the `processCommit`→`save` window
   leaves a stale anchor, and the peer partitions until the *next roster change* — which in a
   settled group could be weeks. It is accepted per the brief and recorded at the save site, but
   the bound is "until the next Add or Remove", not "briefly". Whatever eventually closes it has to
   put the anchor in the same durable write as the handle, which means it is an `@kumiai/mls`-side
   change, not an rpc one.
3. **`load()` is trusted completely.** A store that returns a well-formed but wrong anchor (a
   restore from a stale backup, a store shared between two groups) puts the peer on a dead topic
   with no signal — the same silence the whole change exists to remove, one layer up. There is
   nothing rpc can check it against: the handle cannot re-derive the anchor, which is the premise.
   The port's contract carries the weight, so it is worth being explicit about that in whatever
   host implements it first.
