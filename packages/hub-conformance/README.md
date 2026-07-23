# @kumiai/hub-conformance

The contract suites for the hub: one for the `HubStore` storage contract of `@kumiai/hub-protocol`,
and one for the `LogHub` / `MailboxHub` seam the peer and tunnel layers actually hold. Both are
vitest suites the caller runs inside its own test run.

## The rule

**Every hub implementation passes these, and so does every double that stands in for one.** A double
that answers where its real hub refuses hides a production defect behind a green suite: the code
under test never meets the refusal it will meet in production, so the bug it has cannot fail. That
is what the `LogHub` suite was written for — three separate in-repo doubles had an infallible
`subscribe` while the real hub refuses a retention above its ceiling, and that hid a swallowed
subscribe failure that stalls a peer permanently.

Each clause here exists because a plausible implementation gets it wrong. Three on the store suite
are load-bearing: a store treating `retain` as a no-op passes all but "the retention class governs
deletion"; one deriving all retention from delivery passes all but "publish with no subscribers is
retained"; one hanging the idempotency key off the message row passes all but "the dedup record
outlives the log".

## Exports

- `testHubStoreConformance({ createStore, maxRetention, maxDepth? })` — the `HubStore` contract.
- `testLogHubConformance({ createHub, maxRetention, maxDepth, label })` — the log seam.
- `testMailboxHubConformance({ createHub, maxRetention, maxDepth, label })` — the mailbox subset,
  which every `LogHub` run includes.
- `testAckConformance({ createHub, maxRetention, maxDepth, label, redeliver })` — the clauses a hub
  that declares an `ack` must answer for. Opt-in and separate from the two suites above: `ack?` is
  optional on the contract, so folding these clauses into the main suite would make them pass
  vacuously on a hub with no ack at all. `redeliver` is **required**, not optional — it must trigger
  the hub's reconnect-backlog replay for a subscriber, not merely whatever a still-open `receive`
  would push on its own. Opting into this suite is a claim that the hub's ack suppresses a
  redelivery; a hub that cannot demonstrate the redelivery its ack is meant to suppress cannot
  substantiate that claim, and every "not redelivered" clause would otherwise pass against a hub
  that never redelivers anything, acked or not.

```ts
import { testHubStoreConformance } from '@kumiai/hub-conformance'

testHubStoreConformance({ createStore: () => new SQLHubStore(freshDatabase()), maxRetention: 3600 })
```

`createStore` must return a fresh empty store per case, configured with **default retention zero**,
so `purge({ olderThan: 0 })` can empty a topic whose only subscriber holds the default. A non-zero
default floors the age bound and the purge-empties clauses never fire. `maxDepth` is optional and
counts log frames only: omit it and the depth clause is skipped.

## Two suites, and the store suite is not bridged to the seam

`testHubStoreConformance` checks a `HubStore`, and exactly one implementation runs it. What the rpc
and tunnel suites execute against are `LogHub`s — a different, narrower shape — and until the second
suite existed those were checked by nothing.

The log suite is deliberately **not** the store suite behind an adapter. A `HubStore` adapter over a
`LogHub` would have to implement the storage semantics the store suite checks (delivery-derived
mailbox GC, the age bound, ack accounting), at which point the suite is testing the adapter. Only
the clauses a `LogHub` can answer for on its own live there; the rest stay on the store suite.

The hub shapes in the log suite are re-declared structurally rather than imported from
`@kumiai/hub-tunnel`, because `hub-tunnel` runs the suite over its own double and the import would
put a cycle in the package graph. Structural typing means a real `LogHub` satisfies them without a
cast.

## Atomicity cannot be proven in-process

The racing-publish clause runs N publishes concurrently against one instance, which a
non-transactional read-then-write compare-and-set store still passes, because nothing interleaves.
Hosts **must** also run it against their real database over **separate connections** — that is the
only version that proves the head comparison, sequence mint, append and head advance happen in one
transaction.
