# The conformance suite checks the one hub nothing runs against

> **CLOSED 2026-07-19 on `feat/app-lane-delivery`.** `hub-conformance` now runs against
> `createMemoryStore`, the hub-tunnel doubles and the rpc fakes (`log-hub-conformance.test.ts`,
> `hub-tunnel/test/hub-conformance.test.ts`, `rpc/test/hub-conformance.test.ts`), and
> `rpc-conformance` runs the port contracts against both the fakes and the real `mls-rpc` ports.
> The text below is the gap as it stood, kept for the reasoning.

## The gap

`@kumiai/hub-conformance` is the contract for a hub, and it runs against exactly one
implementation: `createMemoryStore` (`packages/hub-server/test/memoryStore.test.ts`). Meanwhile
every peer-level and tunnel-level test in the repo runs against a *double* —
`packages/rpc/test/fixtures/fake-hub.ts`, `packages/rpc/test/fixtures/durable-fake-hub.ts`,
`packages/hub-tunnel/test/fixtures/fake-hub.ts` — and those three are checked by nothing.

So the hub the suites actually execute against may diverge from the hub the contract describes, and
the divergence is invisible until production. It has already happened once: all three doubles had an
**infallible** `subscribe`, so `hub-mux`'s swallowed subscribe failure was unreachable from every
test in the repo.

Two of the three now enforce a retention ceiling the way the store does (the rpc pair, fixed with
that defect). `packages/hub-tunnel/test/fixtures/fake-hub.ts` still does not — it was out of that
probe's scope. That is the first, cheap piece of this.

## Why it was not just done

The suite takes a **`HubStore`**; the doubles are **`LogHub`s**. They are not variants of one shape:

- `HubStore.subscribe({ subscriberDID, topicID, retention })` vs
  `LogHub.subscribe(subscriberDID, topicID, options?)` — params object vs positional, and the
  LogHub one may return `void`.
- `HubStore` has `fetch({ recipientDID })`, `ack({ recipientDID, sequenceIDs })`,
  `purge({ olderThan })` and `trim({ topicID, before })`. A `LogHub` has none of them: it has
  `receive()` returning a push subscription, and `ack` lives on that subscription.
- The suite's load-bearing clauses are about *storage* semantics the doubles do not model at all —
  the age bound, delivery-derived mailbox GC, the publishID record outliving the log.

Bridging that needs a `HubStore`-shaped adapter over each double, and the adapter would have to
*implement* the very semantics the suite is checking — at which point the suite is testing the
adapter, not the double. That is a design task, not a wiring task.

## Options to weigh

1. **Split the suite.** Factor out the clauses that are expressible over a `LogHub` — the
   subscription gate on `fetchTopic`, the retention ceiling refusal, the compare-and-set, the
   publishID dedup, log-class filtering, `head` surviving a `trim` — into a
   `testLogHubConformance({ createHub, maxRetention })` that every double runs. Leave the
   storage-semantics clauses on the `HubStore` suite. Most valuable; the shared clauses are exactly
   the ones a double gets subtly wrong.
2. **Adapter per double.** Cheaper to start, and worth less for the reason above.
3. **Do nothing structural; keep fixing doubles reactively.** What we do today, and what let this
   one through.

Lean 1.

## Cheap first step, independent of the choice

Give `packages/hub-tunnel/test/fixtures/fake-hub.ts` the retention ceiling its rpc siblings now
have, so all three doubles refuse what a real hub refuses. Small and self-contained.
