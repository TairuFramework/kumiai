# Dispose & ordering residuals — design

**Date:** 2026-08-27
**Scope:** four residuals from `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`
(items 3, 4, 6, 7), settled and pulled into a single branch.
**Packages:** `@kumiai/hub-tunnel`, `@kumiai/rpc`.

## Background

Four items were triaged out of scope for earlier dispose/test-gap branches and parked as residuals.
Each premise below was re-verified against the current source on 2026-08-27 (the residual doc's line
numbers are from July and had drifted slightly). One finding raised the stakes on two of them:

**`mls: GroupMLS` is host-passed, not peer-created** (`packages/rpc/src/peer.ts:155`, destructured
at `:343`). So a post-dispose write through that handle mutates state the *host still holds a
reference to* — it is not peer-private wasted work. The residual doc's "no host-facing entry point
exposes the MLS handle this mutates" understated it: the host owns the reference it passed in.

## Slice 1 — hub-tunnel subscribe ordering (residual #3)

**File:** `packages/hub-tunnel/src/transport.ts` (~line 214).

`createHubTunnelTransport` issues `void Promise.resolve(hub.subscribe(localDID, receiveTopicID)).catch(() => {})`
during construction and never awaits it. Against an in-memory double the subscribe was a synchronous
Set mutation; against a real wire it is an RPC round trip, so there is no contractual guarantee the
subscription lands before the first publish on the same transport. A caller that constructs a
transport and immediately publishes a request can lose the first inbound reply.

**Fix.** Capture the subscribe promise instead of discarding it:

```ts
const subscribed = Promise.resolve(hub.subscribe(localDID, receiveTopicID)).catch(() => {})
```

Gate the transport's send path on it — `await subscribed` before every publish. The promise is
cached, so after it first resolves the await is a microtask; gating every send (rather than tracking
a first-send flag) keeps the code simple, and `sendSessionEnd` on teardown awaits it harmlessly. The
`.catch(() => {})` preserves the existing contract that a *failed* subscribe simply yields no inbound
frames rather than throwing — a gated send still proceeds.

Update the contract doc block (currently "`hub.subscribe` ... called exactly once during
construction") to state that the first send is now gated on the subscribe completing.

**Test.** A real-wire double whose `subscribe` resolves on an artificially delayed tick. Construct a
transport, publish a request immediately, and assert the reply is delivered. This fails today (reply
lost) and passes after the gate.

## Slice 2 — ledger-waiter post-dispose write (residual #6)

**File:** `packages/rpc/src/peer.ts` (~lines 1610-1626).

`requestLedger`'s waiter registers a `ledgerWaiters` callback whose body is an async IIFE:
`openSealedLedger`, then `bootstrapLedger(tokens)` — a write into the host-owned MLS handle. Its only
guard is the local `if (settled) return`, which tracks the gather's own resolution and says nothing
about `disposed`. `dispose()` calls `ledgerWaiters.clear()`, but a callback already invoked before
that point is past the map, and its IIFE completes afterwards. This waiter runs *outside* the commit
mutex, so Slice 3's mutex drain does not cover it — it needs its own guard.

**Fix.** Guard `disposed` in the IIFE:
- an early-out check at the top of the IIFE, skipping a wasted `openSealedLedger` decrypt, and
- a re-check immediately before `bootstrapLedger`, after the `openSealedLedger` await — `disposed`
  can flip during that await, and `bootstrapLedger` is the host-shared write that must not run
  post-dispose. This second check is the decisive one.

**Test.** Mutation-checked. Park the callback on `openSealedLedger` / `bootstrapLedger` (the way
`peer-dispose-race.test.ts`'s rendezvous tests park `sealLedger` / `sealGroupInfo`), fire `dispose()`,
and assert no host write lands. Then break the guard and confirm the test fails before restoring it.

## Slice 3 — dispose drains the commit mutex (residual #7)

**File:** `packages/rpc/src/peer.ts` `dispose` (~lines 2056-2080).

`dispose()` awaits `settled` (`ready.catch(() => {})`) but never the commit mutex (`runSerial`,
`commitTail`). An operation that has already passed its entry guard — `onCommitDelivery`'s
`if (disposed) return`, or `commit()` / `replay()` / `recover()`'s `assertLive()` — keeps running
inside the mutex and can still reach `mux.publish` (`packages/rpc/src/hub-mux.ts:665`, which carries
no disposed check of its own) after `dispose()` has returned.

**Approach: drain the mutex** (chosen over guarding `mux.publish`, which would need a cross-cutting
drop-vs-throw decision at every publish site). `dispose` awaits `commitTail` so an op already inside
`runSerial` finishes before teardown. Precise ordering:

```
disposed = true
await settled                                  // existing
commitUnsubscribe?.(); rendezvousUnsubscribe?.()
<drain recoveryWaiters, clear timers, clear ledgerWaiters>   // existing
await commitTail                               // NEW
await teardownEpoch()
await mux.dispose()
```

- **After** the `recoveryWaiters` drain: a `recover()` op parked in `requestGroupInfo` is settled by
  that drain (resolved null), which lets its `runSerial` op run to completion — so `commitTail` can
  actually settle.
- **Before** `teardownEpoch` / `mux.dispose`: no lane op touches the mux after teardown.
- **Unbounded** (no timeout): every `runSerial` op is deadline-bounded (commit/recover deadlines,
  replay is finite), and `commitTail` swallows errors (`op.then(() => {}, () => {})`) so it always
  settles. A timeout would reintroduce the race it is meant to close.
- **No deadlock:** `runSerial` is non-reentrant, but `dispose` is a host-facing entry never called
  from inside a lane op, so awaiting `commitTail` cannot wait on itself.

**Append-race note for the plan.** An op that passed its guard *before* `disposed = true` enqueues on
`commitTail` synchronously (guard and `runSerial` call are synchronous-adjacent). `dispose` awaits
`settled` first, which yields, so such an op is in `commitTail` before `dispose` reaches the new
`await`. An op reaching its guard *after* `disposed = true` is refused. The mutation test must pin
this ordering.

**Test.** Mutation-checked. Park a `commit()` op mid-mutex (e.g. on `mux.publish` or a build step),
call `dispose()`, and assert (a) `dispose()` does not resolve until the parked op completes, and
(b) no publish reaches a torn-down mux. Break the ordering (move `await commitTail` after
`mux.dispose`, or drop it) and confirm failure before restoring.

## Slice 4 — named lifecycle error (residual #4)

**Files:** `packages/rpc/src/peer.ts`, `packages/rpc/src/index.ts` (class pattern in `commit.ts`).

`assertLive` throws a bare `Error('Peer is disposed')` (`peer.ts:735`). The package exports named
error classes for conditions callers act on (`CommitDeadlineError`, `JournalEpochError`,
`RecoveryRequiredError`), and "the peer is disposed" is one a caller plausibly branches on — retry
against a fresh peer versus surface to the user. The residual doc deferred this because changing one
throw *in isolation* would leave its bare-Error neighbours inconsistent, and pointed at
`rpc-api-surface.md`. Two things resolve that:

- `rpc-api-surface.md` is **type-safety debt** (generics on the public surface, breaking changes). It
  does not cover the error taxonomy — this is a separate, coherent decision.
- Doing it **non-breaking** sidesteps the pre-1.0 deadline: a `PeerDisposedError extends Error` that
  keeps the same `'Peer is disposed'` message satisfies every existing `/disposed/i` assertion while
  letting callers `instanceof`.

**Fix.** Add two lifecycle error classes following the `commit.ts` pattern, export both from
`index.ts`:
- `PeerDisposedError` — thrown at `assertLive` (`peer.ts:735`), message unchanged.
- `PeerNotStartedError` — thrown at `peer.ts:688` (`'Peer is not started'`), same lifecycle family; a
  caller branches on it (start-then-retry) just as it does on disposed.

**Leave bare, with a one-line policy comment** at the class definitions: `Unknown protocol`
(`peer.ts:668`) and `no MLS port` (`peer.ts:1647`) are programmer errors, not conditions a caller
branches on. **Policy:** lifecycle conditions a caller acts on get named classes; programmer errors
stay bare.

Upgrade `peer-dispose-race.test.ts`'s `/disposed/i` message assertions to `instanceof
PeerDisposedError`, so the message string stops being load-bearing (the doc's own note).

## Out of scope

Nothing deferred — all four residuals are closed by this branch. The residual file
`docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md` is removed on completion.

## Testing summary

- Slices 2, 3, 4 all touch dispose behaviour and belong in `peer-dispose-race.test.ts` alongside the
  existing parked-callback rendezvous tests.
- Slice 1 is a hub-tunnel transport test using a delayed-subscribe real-wire double.
- Slices 2 and 3 are mutation-checked: break the guard/ordering, confirm the test fails, restore.
- Changing dispose does not touch a port contract, so the conformance suites do not need re-running
  for correctness — but run the full `@kumiai/rpc` suite (forced, `Cached: 0`) before staging.
