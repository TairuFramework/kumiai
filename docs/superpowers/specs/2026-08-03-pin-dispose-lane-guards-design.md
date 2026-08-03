# Pin the dispose guards on the rpc lane calls

Residuals 1 and 2 from `docs/agents/plans/next/2026-07-31-close-medium-test-gaps-residuals.md`.
Residuals 3 and 4 are not in scope and stay in `next/`.

## The problem

`@kumiai/rpc`'s peer gained `assertLive()` at eight entry points on `test/close-medium-test-gaps`.
Three sit on the lane calls: `commit` (`peer.ts:1629`), `replay` (`:1762`), `recover` (`:1827`).
Deleting all three at once left the whole rpc suite green at 390/390, so the guards shipped
unverified. `commit` was pinned afterwards
(`test/peer-dispose-race.test.ts`, "dispose against a commit made afterwards"); `replay` and
`recover` were not.

A fourth path never got a guard at all. `onCommitDelivery` (`peer.ts:1348-1358`) awaits `ready` and
may then call `rebuildEpoch()`. A delivery already queued in `runSerial` when `dispose()` awaits
`settled` reaches the same post-dispose rebuild that the branch's fix refuses at every host-facing
entry. It is not host-facing, so the fix's rationale — "a disposed peer refuses everything a *host*
asks of it" — never covered it.

## What the unguarded paths actually do

The residual doc assumed `replay` and `recover` were read-and-heal paths whose post-dispose cost was
smaller than `commit`'s. Reading the source disproves that. Both publish:

- `replay` runs `replayJournal()`, which republishes a pending journalled commit through
  `mux.publish` (`:1493`), then `ensureLedger()`, which publishes a ledgerRequest to the rendezvous
  topic (`:1612`).
- `recover` is not stopped by its early return — `teardownEpoch` never nulls `commitTopicID` or
  `rendezvousTopicID` — so it pulls the commit topic through `reconcileCommits`, then publishes a
  recoveryRequest (`:1790`). On a reply it would publish an external commit that rotates the
  ratchet tree for the whole group.

What actually kept the suite green under guard deletion is simpler: no test calls `replay()` or
`recover()` after dispose at all.

`mux.publish` carries no disposed check of its own (`hub-mux.ts:665`), so nothing downstream stops
any of this.

## Source change

One guard, in `onCommitDelivery`'s `runSerial` body immediately after `await ready`:

```ts
void runSerial(async () => {
  await ready
  if (disposed) return
  ...
```

A silent `return`, not `assertLive()`: `onCommitDelivery` has no caller to reject, and the
surrounding `.catch(() => {})` would swallow a throw. The tail `.then(() => healIfRequested())`
needs no guard of its own — `healIfRequested` reaches the hub only through `recover()`, whose
`assertLive()` throws into its own `catch`.

`assertLive`'s doc block (`:713-729`) currently calls itself "the whole of the peer's post-dispose
rule". That stops being true: the rule now has a throwing form for host-facing entry points and a
silent form for inbound deliveries. The comment is rewritten to say so.

## The tests

Three, appended to `packages/rpc/test/peer-dispose-race.test.ts`. Each asserts the refusal AND that
the peer wrote nothing to the hub, using that file's existing inline recording-wrapper shape — a
`LogHub` delegating to a `FakeHub`, with `recording` flipped true only once `dispose()` has
returned.

### A. `replay()` after dispose asks the group for nothing

The journal republish is unreachable as an observable: init's seed calls `replayJournal()`
(`:1413`), so a pending entry is drained before a test can dispose.

The ledger gather is reachable, for a different reason. Init runs `ensureLedger` too (`:1417`), but
an incomplete ledger is a persistent degraded state, not something one gather repairs: against a
responder that withholds, the seed's own gather times out and `isLedgerComplete()` stays false, so
every later lane operation gathers again. `test/peer-dispose-heal.test.ts:88` asserts exactly that
standing state.

Setup is that file's lying-responder pattern (`:59-88`): a responder whose `serveLedger` withholds
the last entry, so no reply ever passes the head check and the requester never bootstraps. Dispose,
start recording, call `replay()`. Unguarded, the recording shows `publish:<rendezvous>`.

Only the disposed peer gets the recording wrapper; the responder is handed the `FakeHub` directly.
Both peers wrap one hub instance, so they still share state, but a live responder's own drain calls
`receive` continuously — through a shared wrapper it would fill the recording with another peer's
traffic and the assertion could never be empty.

### B. `recover()` after dispose asks the group for nothing

Same wrapper. Unguarded, the recording shows the commit-topic fetch and `publish:<rendezvous>`.

One ordering wrinkle, mirroring the `commit` test: unguarded `recover()` does not reject promptly.
No reply can reach a peer whose rendezvous subscription is gone, so it waits out
`requestGroupInfo`'s timeout, breaks, and *resolves*. Assert hub traffic first, own the returned
promise immediately, await the rejection last — otherwise "it published" degrades into a bare
timeout that names nothing.

### C. A commit delivery queued behind a lane operation does not pull after dispose

Queuing the delivery behind `ready` does not work, and the reason is worth recording: `retain` is
synchronous and fires `void attemptSubscribe(...)` (`hub-mux.ts:369`), so `buildEpoch` never awaits
a subscribe. Holding subscribes open leaves `ready` settling on schedule — which is also why the
in-flight-subscribe test can watch a peer carry on with subscribes still pending.

Queue it behind the commit mutex instead, which is the residual doc's own scenario — "a delivery
already queued in `runSerial` when `dispose()` awaits `settled`". `onCommitDelivery` puts its
`await ready` *inside* the `runSerial` callback (`:1350-1351`), so a held mutex stops the callback
from starting at all.

The mutex must be held by something that does no hub work after it is released, or the holder's own
traffic lands in the recording and the assertion needs filtering. `replay()` on a peer with an empty
journal and a complete ledger is exactly that: `replayJournal` returns at `entry == null`,
`ensureLedger` returns early, and nothing reaches the hub. Gate it at `journal.get()` (`:1458`) —
`makeMLSPeer` takes a `journal`, so a wrapper spread over `createMemoryCommitJournal()` with a
gated `get` holds the mutex without involving the hub at all.

So: start `replay()`, which blocks in the gated `get`; have another member commit, so the delivery
arrives and its callback queues behind the mutex; `await dispose()`, which returns without waiting
on the mutex; start recording; release the gate. `replay()` finishes hub-silently, the mutex frees,
and the queued callback runs against a peer disposed some time ago.

The observable is hub traffic alone — `onCommitDelivery` has no caller to reject. Unguarded,
`pullCommits` fetches the commit topic. Because the holder is hub-silent and the mux drain is
stopped by then, the assertion is a bare `expect(calls).toEqual([])`.

## Verification

Every guard is pinned by mutation, not by assumption. For each test: remove the guard, confirm the
new test fails naming the actual traffic, restore it, confirm green.

- A — `assertLive()` at `:1762`, expect `publish:<rendezvous>`.
- B — `assertLive()` at `:1827`, expect the commit-topic fetch and `publish:<rendezvous>`.
- C — the new `if (disposed) return`, expect `fetchTopic:<commit-topic>`.

Then the full rpc suite forced, with `Cached: 0` confirmed, and `test:types` — vitest strips types,
so a green run says nothing about what typechecks.

A guard that ships without its mutation check is unverified no matter how much green surrounds it.
That is what produced this work.

## Out of scope

**The recording wrapper is shared, by a ruling made on 2026-08-03 that reverses two earlier ones.**
The residual doc and the close-medium-test-gaps final review both said not to extract one: three
inline `FakeHub` wrappers already exist in this package, each recording different fields, and a
shared recorder gaining a parameter per caller is worse than duplication.

What changed is that all three tests here need the *same* wrapper — same five methods, same call
format, same "start after dispose returns" discipline — so the helper takes no per-caller parameter
and the failure mode those rulings guarded against does not arise. The cost accepted is a fourth
wrapper shape in a package that already has three.

Scope limit: the helper serves the three new tests only. The existing inline wrappers stay exactly
as they are — they record different fields, and rewriting them is not this branch's work.

**Residuals 3 and 4.** The `next/` file is trimmed to those two rather than deleted. `'Peer is
disposed'` stays a bare `Error`, so the new tests assert `/disposed/i` against the message prose
like their neighbours; the named-class decision belongs with `backlog/rpc-api-surface.md`.

## Risks

1. **The in-flight-subscribe test.** `peer-dispose-race.test.ts:115-122` names `onCommitDelivery`'s
   unguarded rebuild as load-bearing — the only remaining way anything downstream of a post-dispose
   rebuild can be observed, which it uses to reach `onSubscribeFailed`. But its rebuild fires at
   `:132-139`, before `bob.peer.dispose()`, so the guard should not reach it. That is a reading of
   the test, not a result. If it fails, stop and take the reshape/re-point/retire decision
   deliberately — do not patch it. If it passes, rewrite that comment: this branch falsifies its
   central claim.
2. **Test C's queue point.** ~~Gate `buildEpoch`'s subscribes to hold `ready` pending.~~ Disproved
   before implementation: `retain` never awaits a subscribe (`hub-mux.ts:369`). Test C now holds the
   commit mutex instead, per the section above. Remaining assumption: that a delivery arriving while
   the mutex is held really does queue rather than run. `runSerial` chains every task on
   `commitTail` (`:837-847`), so it should — but if the callback runs early, the test will show it
   by recording traffic before dispose rather than after.
3. **Test A's timeout.** `ensureLedger`'s gather waits out a local timer `dispose()` never clears —
   `peer-dispose-heal.test.ts:90-97` pins exactly that. The unguarded run settles slowly, so the
   recording assertions must run before the await.
