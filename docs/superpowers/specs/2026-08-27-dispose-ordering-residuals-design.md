# Dispose & ordering residuals — design

**Date:** 2026-08-27
**Scope:** four residuals from `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`
(items 3, 4, 6, 7), settled and pulled into a single branch.
**Packages:** `@kumiai/hub-tunnel`, `@kumiai/rpc`.
**Review:** premises and the four fixes were checked against source by a Codex pass on 2026-08-27;
its corrections are folded in (Slice 1 sync-throw + teardown leak, Slice 3 approach changed from
mutex-drain to publish-guard, Slice 4 narrowed to disposed-only).

## Background

Four items were triaged out of scope for earlier dispose/test-gap branches and parked as residuals.
Each premise below was re-verified against the current source on 2026-08-27 (the residual doc's line
numbers are from July and had drifted slightly). One finding raised the stakes on two of them:

**`mls: GroupMLS` is host-passed, not peer-created** (`packages/rpc/src/peer.ts:153`, destructured
at `:337`). So a post-dispose write through that handle mutates state the *host still holds a
reference to* — it is not peer-private wasted work. The residual doc's "no host-facing entry point
exposes the MLS handle this mutates" understated it: the host owns the reference it passed in.

## Dependency between slices

Slice 4 defines `PeerDisposedError`. Slice 3 (approach A) throws it from `mux.publish`. So **Slice 4
lands first** — it is a prerequisite for Slice 3. Slices 1 and 2 are independent of both.

## Slice 4 — named lifecycle error (residual #4)

**Files:** create `packages/rpc/src/errors.ts`; modify `packages/rpc/src/peer.ts`,
`packages/rpc/src/index.ts`.

`assertLive` throws a bare `Error('Peer is disposed')` (`peer.ts:733`). The package exports named
error classes for conditions callers act on (`CommitDeadlineError`, `JournalEpochError`,
`RecoveryRequiredError` — pattern in `commit.ts:153`), and "the peer is disposed" is one a caller
plausibly branches on: retry against a fresh peer versus surface to the user.

**Scope: `PeerDisposedError` only.** The residual doc floated also naming `'Peer is not started'`
(`peer.ts:684`) as a lifecycle sibling. Rejected on review: there is no public `start()` method, and
`.to()` is already `withReady`-wrapped (`peer.ts:2035`), so `inboxLane == null` after `ready` is a
*permanent* "this peer has no directed lane" condition, not a start-then-retry state. Naming it
`PeerNotStartedError` would codify a misleading name. Left bare, out of scope.

**Placement.** `PeerDisposedError` lives in a new `errors.ts`, not `commit.ts`, because
`hub-mux.ts` throws it too (Slice 3) and must import it without taking a dependency on `commit.ts`.

**Fix.**
- `errors.ts`: `export class PeerDisposedError extends Error { override name = 'PeerDisposedError' }`,
  following the `commit.ts` pattern.
- `index.ts`: export `PeerDisposedError` beside `CommitDeadlineError` et al.
- `assertLive` (`peer.ts:735`): `throw new PeerDisposedError('Peer is disposed')` — **message
  unchanged**, so every existing `/disposed/i` assertion keeps passing (non-breaking).
- Upgrade `peer-dispose-race.test.ts`'s `/disposed/i` assertions to `instanceof PeerDisposedError`,
  so the message string stops being load-bearing (the doc's own note).

**Policy comment** (at the class definition): lifecycle conditions a caller acts on get named
classes; programmer errors (`Unknown protocol` at `peer.ts:666`, no-MLS-port at `peer.ts:1643`) stay
bare.

## Slice 1 — hub-tunnel subscribe ordering (residual #3)

**File:** `packages/hub-tunnel/src/transport.ts` (~line 214).

`createHubTunnelTransport` issues `void Promise.resolve(hub.subscribe(localDID, receiveTopicID)).catch(() => {})`
during construction and never awaits it. Against an in-memory double the subscribe was a synchronous
Set mutation; against a real wire it is an RPC round trip, so there is no contractual guarantee the
subscription lands before the first publish on the same transport. A caller that constructs a
transport and immediately publishes a request can lose the first inbound reply.

**Fix — capture and defer.** Two corrections over the naive version:

```ts
// Deferred call: `hub.subscribe` runs inside the .then, so a SYNCHRONOUS throw becomes a
// rejection the .catch absorbs — `Promise.resolve(hub.subscribe(...))` would let a sync throw
// escape construction, because the call is evaluated before Promise.resolve wraps it.
const subscribed = Promise.resolve()
  .then(() => hub.subscribe(localDID, receiveTopicID))
  .catch(() => {})
```

- **Gate the send path.** In the writable's `write` (`transport.ts:428`), `await subscribed` before
  `hub.publish` (`:444`). The promise is cached, so after it first resolves the await is a microtask.
  A failed subscribe still resolves (`.catch`), preserving the contract that a missing subscription
  simply yields no inbound frames rather than throwing.
- **Coordinate teardown (missed hazard, same code).** `teardown` sends `session-end` and calls
  `hub.unsubscribe?.(...)` immediately (`transport.ts:272-274`). If the construction `subscribe` is
  still in flight, `unsubscribe` can run first and the later-landing `subscribe` resurrects
  membership after teardown. Fix: in `teardown`, `await subscribed` before issuing `unsubscribe`
  (wrap the unsubscribe in `void subscribed.then(() => hub.unsubscribe?.(...)).catch(() => {})` so
  teardown stays synchronous but the unsubscribe is ordered after the subscribe settles).

Update the contract doc block: the first send is now gated on the subscribe completing, and
unsubscribe is ordered after it.

**Test.** A real-wire double whose `subscribe` resolves on an artificially delayed tick (the existing
`transport-ordering.test.ts` uses the synchronous `FakeHub` and has no such case). Two cases:
1. Construct a transport, publish a request immediately, assert the reply is delivered (fails today —
   reply lost; passes after the send gate).
2. A double whose `subscribe` resolves *after* `unsubscribe` would otherwise run; tear down before
   the subscribe settles; assert no live subscription remains (guards the teardown coordination).

## Slice 2 — ledger-waiter post-dispose write (residual #6)

**File:** `packages/rpc/src/peer.ts` (~lines 1600-1626).

`requestLedger`'s waiter registers a `ledgerWaiters` callback whose body is an async IIFE:
`openSealedLedger`, then `bootstrapLedger(tokens)` — a write into the host-owned MLS handle
(`crypto.ts:397`: "REPLACES the ledger this handle holds"). Its only guard is the local
`if (settled) return`, which tracks the gather's own resolution and says nothing about `disposed`.
`dispose()` calls `ledgerWaiters.clear()` (`peer.ts:2076`), but a callback already invoked before
that point is past the map, and its IIFE completes afterwards. This waiter runs *outside* the commit
mutex, so it is not covered by Slice 3 — it needs its own guard.

**Distinct from existing coverage.** `peer-dispose-race.test.ts:373-529` parks the *responder's*
`sealLedger`/`sealGroupInfo` and asserts nothing is *published*. Slice 2 is the *requester's*
`openSealedLedger`→`bootstrapLedger` — a host *write*, no publish — so a recording-hub cannot see it;
the test must spy on the requester's port.

**Fix.** Guard `disposed` in the IIFE:
- an early-out check at the top of the IIFE, skipping a wasted `openSealedLedger` decrypt, and
- a re-check immediately before `bootstrapLedger`, after the `openSealedLedger` await — `disposed`
  can flip during that await, and `bootstrapLedger` is the host-shared write that must not run
  post-dispose. This second check is the decisive one.

**Test.** Mutation-checked. Model on `peer-dispose-race.test.ts:373-455`, but instead of gating the
responder's seal, wrap the *requester's* (alice's) `mls` port so `openSealedLedger` parks on a gate;
fire `dispose()`; open the gate; assert `bootstrapLedger` was never called (spy on alice's
`bootstrapLedger`). Then break each guard and confirm the test fails before restoring.

## Slice 3 — guard `mux.publish` against post-dispose lanes (residual #7)

**Files:** `packages/rpc/src/hub-mux.ts` (publish ~665, interface, dispose ~708),
`packages/rpc/src/peer.ts` (dispose ~2056).

`dispose()` awaits `settled` but never the commit mutex. An operation that has already passed its
entry guard — `onCommitDelivery`'s `if (disposed) return` (`peer.ts:1360`), or `commit()` /
`replay()` / `recover()`'s `assertLive()` (`peer.ts:1643/1776/1841`) — keeps running inside
`runSerial` and can still reach `mux.publish` (`hub-mux.ts:665`, no disposed check) after `dispose()`
has returned. Existing tests (`peer-dispose-race.test.ts:195-308`) call these entry points *after*
dispose and hit the guard; none covers an op already *inside* the mutex when dispose runs.

**Approach A — guard the single funnel** (chosen over draining the mutex). The rejected drain
approach (`await commitTail` in dispose) is **unsafe**: `const pending = await build()` runs inside
`runSerial` (`peer.ts:1689`) and `commitDeadlineMs` bounds only the rebase loop, not the
caller-supplied `build()`, so the drain can hang `dispose()` indefinitely; and because `build()` /
`PendingCommit.onAccepted()` run inside the mutex, a host that calls `dispose()` from within one
self-deadlocks. Guarding `mux.publish` awaits nothing, so it cannot hang or deadlock, and an
in-flight op then rejects — matching the established "disposed op rejects `/disposed/i`" idiom.

`mux.publish` must reject from the moment `peer.dispose()` begins, but the mux's full `dispose()`
(which sets its own `disposed` and tears everything down) runs *last* in `peer.dispose()` — too late.
So separate the "reject new publishes" signal from the "cleanup done" guard:

- **`hub-mux.ts`:** add `let publishSuspended = false`. In `publish` (`:665`), before
  `assertSubscribable`: `if (publishSuspended) throw new PeerDisposedError('mux: publish after dispose')`.
  Expose `suspendPublishing: () => { publishSuspended = true }` on the mux interface. `dispose()`
  also sets `publishSuspended = true` (belt-and-suspenders); its idempotency guard stays on its own
  `disposed` flag, unchanged.
- **`peer.ts` `dispose`:** call `mux.suspendPublishing()` immediately after `disposed = true`
  (`:2057`), before `await settled`. Full `mux.dispose()` stays where it is (last).

Only `publish` is guarded, not `fetchTopic`: a post-dispose fetch is a read that moves no group
state, and the residual is specifically about publishing.

**Test.** Mutation-checked, new coverage. Park a `commit()` op mid-mutex — gate the host's `build()`
callback on a Promise so the op sits between its passed `assertLive` and `mux.publish`. Fire
`dispose()`, then open the gate. Assert (a) the op rejects with `PeerDisposedError`, and (b) no
publish reached the hub (recording-hub `calls()` empty). Then remove the `mux.publish` guard and
confirm the publish leaks before restoring.

## Out of scope

**Residual #4's `'Peer is not started'`** stays bare (see Slice 4).

**Three dispose-teardown hazards surfaced by the review, unrelated to these four** — file as new
residuals in `docs/agents/plans/next/`, do not expand this branch:
- `teardownEpoch()` throwing an `AggregateError` on a child disposal failure (`peer.ts:620`) skips
  the later `mux.dispose()` (`peer.ts:2078`), leaking the hub drain, listeners, sinks and sleepers.
- `mux.dispose()` and the hub-tunnel transport call `iterator.return?.()` without awaiting it
  (`hub-mux.ts:726`, `transport.ts:285`), so dispose can resolve before the receive resource closes.
- `inboxLane` closes over the mux (`peer.ts:380,572`) and `teardownEpoch()` never clears it, so a
  disposed peer retains an obsolete path (blocked by the post-dispose guards, but still held).

## Testing summary

- Slice 4, 2, 3 all touch dispose behaviour and belong in `peer-dispose-race.test.ts` alongside the
  existing parked-callback tests.
- Slice 1 is a hub-tunnel transport test using a delayed-subscribe double (new — the existing
  `transport-ordering.test.ts` only exercises the synchronous `FakeHub`).
- Slices 2 and 3 are mutation-checked: break the guard, confirm the test fails, restore.
- Changing dispose does not touch a port contract, so the conformance suites do not need re-running
  for correctness — but run the full `@kumiai/rpc` suite (forced, `Cached: 0`) before staging.
