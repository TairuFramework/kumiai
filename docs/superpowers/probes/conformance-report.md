# Probe report — a conformance suite the hub doubles actually run against

Implementation probe, branch `feat/app-lane-delivery`. Changes left **uncommitted**.

## What was built

`packages/hub-conformance/src/log-hub.ts` — `testMailboxHubConformance` and `testLogHubConformance`,
the behavioural contract expressible at the `LogHub` / `MailboxHub` seam. Exported from the package
index alongside the existing `testHubStoreConformance`.

It is deliberately **not** the `HubStore` suite bridged through an adapter. A `HubStore` adapter over
a `LogHub` would have to implement the storage semantics the suite checks (delivery-derived mailbox
GC, the age bound, ack accounting), at which point the suite tests the adapter. Only the clauses a
`LogHub` can answer for on its own are here.

The hub shapes are re-declared structurally in `log-hub.ts` rather than imported from
`@kumiai/hub-tunnel`: `hub-tunnel` now runs this suite over its own double, so a real import would
put a cycle in the package graph. Structural typing means a real `LogHub` satisfies them with no
cast — `FakeHub implements LogHub` and `DurableFakeHub implements LogHub` are passed unwrapped.

### Applied to

| Implementation | Suite | Runner |
|---|---|---|
| `createMemoryStore` (the real store) | LogHub | `packages/hub-server/test/log-hub-conformance.test.ts` |
| `packages/rpc/test/fixtures/fake-hub.ts` | LogHub | `packages/rpc/test/hub-conformance.test.ts` |
| `packages/rpc/test/fixtures/durable-fake-hub.ts` | LogHub | `packages/rpc/test/hub-conformance.test.ts` |
| `packages/hub-tunnel/test/fixtures/fake-hub.ts` | MailboxHub | `packages/hub-tunnel/test/hub-conformance.test.ts` |
| `createMemoryBus` | — | **not expressible, see below** |

The store runs through a ~20-line adapter (`pollingReceive`) because a `HubStore` has no push side.
It polls `fetch` with the store's own cursor and acks nothing. None of the properties under test live
in it: sender exclusion, sequenceID format, the retention refusal and the depth bound are all in the
store's own `publish` / `subscribe`. The adapter can only lose a message, never invent one — so it
cannot make a clause pass that the store would fail. Running the real store through the same seam is
what says the clauses describe a hub rather than describing the doubles.

## The clauses, and the property each one holds

Every clause below was **watched fail** against an implementation that violates it. Nothing is
asserted here that was not observed red first.

1. **A publish is not echoed to its sender.** Includes a control (a second subscriber does receive
   it), so the clause cannot pass by the hub delivering nothing at all.
2. **sequenceIDs order lexicographically across the 9→10 boundary.** Eleven publishes; sorting the
   minted IDs must be a no-op.
3. **A subscribe above the ceiling is refused, never clamped.** Accepts a synchronous throw or a
   rejection — `HubBase.subscribe` is `Promise<void> | void`, and a caller catching only a rejection
   is as broken as one catching nothing, so the suite must not pick a side.
4. **A subscribe exactly at the ceiling is accepted.** The boundary is inclusive and it matters: the
   app lane's default retention (30 days) sits exactly ON the store's default ceiling.
5. **`fetchTopic` refuses a non-subscriber.** (LogHub only.)
6. **A refused subscribe leaves no subscription behind.** (LogHub only.) "Refused, never clamped" is
   a claim about state, not only about the throw — a hub that threw AND subscribed at its own ceiling
   would pass clause 3 while leaving the caller believing it holds a retention it does not.
7. **A mailbox publish is delivered, stays out of the log, and does not move the head.** (LogHub.)
8. **Compare-and-set: two publishes at one head, one accepted, one `HeadMismatchError`, nothing
   stored for the loser.** (LogHub.)
9. **A replayed `publishID` returns the original sequenceID and appends nothing.** (LogHub.)
10. **A log topic trims itself once its depth bound is exceeded** — `oldest` moves, `head` does not,
    the evicted frame is gone from the log rather than hidden behind a cursor. (LogHub.)

## What reddened

**No pre-existing test in the repo reddened.** Three reds, all in the new suite, all against doubles
that were violating the contract. Each is a real finding.

### RED 1 & 2 — the rpc doubles retain unconditionally (audit MEDIUM 4)

```
PASS (18) FAIL (2)

1. FakeHub: LogHub conformance a log topic trims itself once its depth bound is exceeded
   AssertionError: expected [ { …(4) }, { …(4) }, { …(4) }, …(4) ] to have a length of 6 but got 7
2. DurableFakeHub: LogHub conformance a log topic trims itself once its depth bound is exceeded
   AssertionError: expected [ { …(4) }, { …(4) }, { …(4) }, …(4) ] to have a length of 6 but got 7
```

Both doubles exposed `trim(topicID, before)` as a manual test control only. They enforced no depth
bound and aged nothing out, so **no test could reach a cursor below `oldest` unless it remembered to
arrange one by hand**. Every path that must survive a trimmed log — the commit-lane pull, journal
replay, the app lane's below-retention notice — was reachable only by a test that thought to call
`trim()`. A peer returning after 1000 commits to find its commit cursor gone is a real production
state that these doubles could not produce by themselves.

Fixed by giving both a per-topic **log-class** depth bound in `publish`, mirroring the store's:
oldest evicted first, head untouched, mailbox frames not counted (counting them would let any member
evict the commit log with a mailbox flood). `DEFAULT_MAX_DEPTH = 1000`, the store's own default,
`maxDepth` overridable via `FakeHubOptions` — so the default fixture now behaves like a default real
hub, and no existing test changed behaviour.

### RED 3 — `hub-tunnel`'s FakeHub had an infallible subscribe (audit HIGH 2, third double)

```
PASS (3) FAIL (1)

1. hub-tunnel FakeHub: MailboxHub conformance a subscribe above the hub maximum is refused, never clamped
   Error: promise resolved "undefined" instead of rejecting
```

The last of the three doubles whose `subscribe` could not fail. Its `subscribe` took no options at
all, so the transport's own swallowed-subscribe path (`createHubTunnelTransport`, "Best-effort
subscribe; rejection is swallowed") had nothing that could exercise it. Fixed: `FakeHubOptions`,
`#maxRetention` defaulting to the store's 2_592_000, and a synchronous `RetentionExceededError` above
the ceiling. Its sender exclusion and zero-padded sequenceIDs (audit LOW 6) were already fixed in the
working tree; the suite now locks both in.

**Nothing was retuned to stay green.** No existing test was weakened, and no clause was dropped
because a double disliked it.

## What could not be expressed, and why

**`createMemoryBus` is not on this seam at all, and the no-echo property cannot be asked of it.**

`BroadcastBus` is `publish(topicID, payload)` and `subscribe(topicID, onMessage)`. There is no sender
on the publish and no subscriber identity on the subscription, so "was this echoed to its sender?" is
not a question this shape can be asked — nor are sequenceIDs, retention, or a readable log. An
adapter giving it identity would have to *implement* the sender exclusion, which is the property
under test.

The divergence is real (audit MEDIUM 5): the bus calls every subscriber including the publisher's
own, while the hub builds recipients as "current subscribers minus the sender", and the production
`BroadcastBus` (`rpc/src/hub-mux.ts:383`) is a per-peer view over exactly that fan-out. Closing it
means putting identity on `BroadcastBus` itself — which changes the production implementation in
`packages/rpc/src/hub-mux.ts`, outside this probe's scope. **Not done; reported.** The divergence is
now recorded in `createMemoryBus`'s own doc comment so the next reader meets it at the code.

Also not expressible at this seam, and left on the `HubStore` suite where they belong: the age bound
and `purge`, delivery-derived mailbox GC and ack accounting, `head` surviving a `trim` (a `LogHub`
has no `trim` on its interface — the doubles' `trim()` is a test control, not part of the port), and
the publishID record outliving a trim.

## Mutation check (required)

Sender exclusion removed from `packages/rpc/test/fixtures/fake-hub.ts`:

```diff
-      if (did === params.senderDID) continue
+      // MUTATION: sender exclusion removed.
```

```
$ pnpm exec vitest run test/hub-conformance.test.ts
PASS (19) FAIL (1)

1. FakeHub: MailboxHub conformance a publish is not echoed to its sender
   AssertionError: expected [ Array(1) ] to deeply equal []
       at /Users/paul/dev/yulsi/kumiai/packages/hub-conformance/lib/log-hub.js:88:45
```

Inverted by hand (no `git checkout` / `restore` / `stash`); the file's SHA-256 returned to
`b29637e62739443a8bb278a0b396b156a02b00a84c09727d94c8d274988d51dd`, byte-identical to before the
mutation.

### Every other clause, verified live

The remaining nine clauses were each run against a deliberately lenient wrapper over `FakeHub` in a
scratch file (since deleted), one violated property per mutant. Failures observed:

```
MUTANT-A-unpadded: sequenceIDs are lexicographically ordered across the 9 to 10 boundary
MUTANT-A-unpadded: a mailbox publish is delivered, stays out of the log, and does not move the head
MUTANT-A-unpadded: two publishes at the same head: one accepted, one refused, nothing stored for the loser
MUTANT-A-unpadded: a replayed publishID returns the original sequenceID and appends nothing
MUTANT-A-unpadded: a log topic trims itself once its depth bound is exceeded
MUTANT-B-clamps: a subscribe above the hub maximum is refused, never clamped
MUTANT-B-clamps: a refused subscribe leaves no subscription behind
MUTANT-C-exclusive-boundary: a subscribe exactly at the hub maximum is accepted
MUTANT-D-open-fetch: fetchTopic refuses a non-subscriber
MUTANT-D-open-fetch: a refused subscribe leaves no subscription behind
MUTANT-E-no-cas: two publishes at the same head: one accepted, one refused, nothing stored for the loser
MUTANT-F-no-dedup: a replayed publishID returns the original sequenceID and appends nothing
MUTANT-G-all-log: a mailbox publish is delivered, stays out of the log, and does not move the head
```

Mutants: A bare-decimal sequenceIDs; B clamps retention instead of refusing; C treats the ceiling as
exclusive; D serves `fetchTopic` to anyone; E ignores `expectedHead`; F ignores `publishID`; G makes
every publish log-class. A's blast radius is wide because a hub with unordered sequenceIDs breaks
every clause that compares one — which is the point of the clause.

## Files changed

- `packages/hub-conformance/src/log-hub.ts` (new), `src/index.ts` (re-export), `tsconfig.json`
  (`lib: ["es2025", "dom"]`, matching `hub-tunnel`'s, for `setTimeout`)
- `packages/hub-server/test/log-hub-conformance.test.ts` (new)
- `packages/hub-tunnel/test/hub-conformance.test.ts` (new), `test/fixtures/fake-hub.ts`,
  `package.json` (devDep)
- `packages/rpc/test/hub-conformance.test.ts` (new), `test/fixtures/fake-hub.ts`,
  `test/fixtures/durable-fake-hub.ts`, `package.json` (devDep)
- `packages/broadcast/src/bus.ts` (doc only — the divergence recorded, no behaviour change)
- `pnpm-lock.yaml`

`packages/rpc/src/**`, `packages/mls/**` and every rpc fixture other than the two hub doubles are
untouched. The two new runner files under `packages/rpc/test/` and `packages/hub-tunnel/test/` are
new files that collide with nothing.

## Concerns

- **The `BroadcastBus` echo is still open** and is the one audit finding this probe could not close.
  It needs identity on the `BroadcastBus` type and a matching change in `rpc/src/hub-mux.ts`.
- **The doubles' `trim()` test control is still outside the contract.** `LogHub` has no `trim`, so
  the suite reaches trimming only through the depth bound. "`head` survives a trim" is therefore
  checked on the store and not on the doubles, even though both doubles implement it correctly.
- **The depth bound now makes the rpc doubles lossy at 1000 log frames per topic.** No test in the
  repo reaches that today. A future test that publishes more will start seeing eviction — which is
  correct behaviour, but it will look like a new failure rather than a newly-modelled reality.
