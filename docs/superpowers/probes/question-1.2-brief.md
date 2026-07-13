# Probe brief — Question 1.2

## The question

**Can `memoryStore` retain a per-topic log independently of delivery?**

- **Assumption:** retention can be moved off delivery without breaking the mailbox behaviour the
  rest of the system still depends on. Rendezvous and app/broadcast topics keep mailbox
  semantics; only the log's *retention* changes, and it changes for every topic uniformly.
- **Done when:** publish stores a log entry with zero subscribers; `ack` deletes a *delivery* and
  never a log entry; `trim({ topicID, before })` is the only deleter and moves `oldest` without
  touching `head`; `fetchTopic` reads the log and refuses a non-subscriber with
  `NotSubscribedError`. The suite's log clauses pass. `hub.test.ts` still passes untouched — that
  is the mailbox regression check.
- **⚠️ Wrong-but-passing:** keeping `deleteMessage`'s refcount GC "as an optimization for messages
  nobody wants". That is precisely today's bug — the last ack destroys the log entry, and every
  online-peer test still passes. Same shape for `unsubscribe` dropping the topic index when its
  last subscriber leaves: a deletion `trim` never authorized, invisible to every online-peer test.

## Scope

**In scope:** the storage model of `packages/hub-server/src/memoryStore.ts` — the log/delivery
split, `fetchTopic`, `trim`.

**Out of scope, and you must NOT implement it:** CAS and idempotency. `PublishParams.expectedHead`
and `PublishParams.publishID` stay **ignored** by `publish`. That is the next question's work, and
implementing it here would hide whether the log alone is sound.

So the expected outcome is a *partial* pass of the conformance suite. Before this question:
9 failed / 1 passed of 10. After it, the four log-and-read clauses should pass and the CAS and
dedup clauses should still fail:

| Clause | Expected after this question |
|---|---|
| zero-subscriber publish is retained and pullable | **pass** |
| ack deletes the delivery, not the log entry | **pass** |
| trim is the only deleter: head survives, oldest moves | **pass** |
| lexicographic ordering across 9→10 | **pass** (already does) |
| `fetchTopic` refuses a non-subscriber (`NotSubscribedError`) | **pass** |
| `expectedHead: null` sentinel | fail — no CAS yet |
| CAS: loser gets `HeadMismatchError`, stores nothing | fail — no CAS yet |
| replayed `publishID` returns the original sequenceID | fail — no dedup yet |
| dedup record outlives the log | fail — no dedup yet |
| concurrent CAS: N racing publishes, one append | fail — no CAS yet |

**Predicted: 5 failed / 5 passed.** If your numbers differ, say so and explain why rather than
adjusting anything to hit the prediction. A clause passing that shouldn't is a finding.

## Spec excerpts (verbatim — this is the contract)

From `docs/superpowers/specs/2026-07-13-control-ledger-lane-design.md`:

> **This is not a field addition. `HubStore` gains a log.** Today, as problem 4 sets out,
> messages are retained as a function of delivery: a publish with no subscribers is not
> stored, and the last ack deletes the row. A CAS head over that is incoherent — the head
> would advance past frames that were never stored, or that a reader's own ack destroyed, and
> no peer could ever pull them. So:
>
> - **Messages are retained per topic, independently of delivery.** A publish is appended to
>   the topic's log whether or not anyone is subscribed. This is the system of record.
> - **Delivery rows govern push only.** They remain an optimization — a wakeup signal — and
>   `ack` deletes a *delivery*, never a log entry.
> - **Trim governs the log** and is the only thing that removes a log entry. Trim moves `oldest`
>   and never touches `head`. Nothing else deletes: not `ack`, not `unsubscribe`.

On the trim primitive:

> **Trim is one primitive, and policy sits on top.** Depth-versus-age is a host decision, and
> putting both in the contract makes neither testable. The contract exposes a single bound:
>
> ```ts
> export type TrimParams = {
>   topicID: string
>   /** Remove log entries with sequenceID strictly below this bound. */
>   before: string
> }
> ```
>
> A host implements a 30-day window, a depth cap, or both, by choosing `before`. What the
> contract fixes is the invariant, and the conformance suite asserts it for every host: **trim
> moves `oldest`, never touches `head`, and never removes a dedup record.**

On what stays a mailbox:

> **Only `commitTopic` is a log.** `rendezvousTopic` and every app/broadcast topic keep
> mailbox semantics — deliver, ack, delete. The hub stays a relay for the bulk of its
> traffic; the log is one topic per group.

Read that last one carefully, because it is easy to over-read. It describes how the *lanes* use
the store — the commit lane pulls a log, the others push-and-ack. It does **not** license the
store to retain some topics and not others: the store cannot read payloads and does not know what
a commit is, so **retention is uniform and unconditional for every topic**. What differs is that
mailbox lanes simply never call `fetchTopic`, and their logs are trimmed by ordinary retention
policy. If you find yourself adding a per-topic "is this a log topic?" flag to the store, stop —
that is the store knowing what a commit is, which the design forbids.

`fetchTopic`, from the type surface:

```ts
export type FetchTopicParams = {
  /** Authorization: the caller must be a current subscriber of topicID, or NotSubscribedError. */
  subscriberDID: string
  topicID: string
  /** Exclusive cursor: messages after this sequenceID. Absent: from the oldest retained. */
  after?: string
  limit?: number
}

export type FetchTopicResult = {
  messages: Array<StoredMessage>
  /** The topic's current head: the sequenceID of the last accepted publish, or null. */
  head: string | null
  /** The oldest sequenceID still retained for this topic, or null if the log is empty. */
  oldest: string | null
}
```

Note `head` is **the last accepted publish**, not the last *retained* one. Trimming the whole log
must not reset `head` to `null` — an empty log still has a head. This is load-bearing: the restart
replay path depends on `head` outliving the frame it names. `oldest` is `null` when nothing is
retained.

## The approved approach

Split the store's state in two, so the contract is visible in the data model rather than enforced
by discipline:

1. **The log** — per topic, append-only, written on **every** publish regardless of who is
   subscribed. This is the system of record. The only thing that removes an entry is `trim`.
   `head` (last accepted sequenceID, survives trim) and `oldest` (oldest retained, or `null`)
   derive from it.
2. **Deliveries** — the per-recipient push index. Written for current subscribers at publish time,
   removed by `ack`. A delivery row references a log entry; it does not own it.

Consequences to carry through deliberately:

- `deleteMessage` / `removeDelivery`'s refcount GC **goes away**. An ack removes a delivery row and
  nothing else. Do not keep the GC "for messages nobody wants" — that is the bug.
- `unsubscribe` **stops dropping the topic's messages**. It removes a subscription (and that
  subscriber's deliveries); the log is untouched.
- The existing `maxDepth` constructor option: keep it working if it is cheap, but it now trims the
  *log*, which means it must go through the same path as `trim` and honour the same invariant
  (never touch `head`). If it cannot be made to honour the invariant simply, say so and leave it
  out rather than half-doing it — depth policy is the host's, and the contract only fixes `trim`.
- `purge({ olderThan })` stays. It is the existing expiry surface. Where it deletes messages it is
  now a trim, and it must honour the same invariant.

Then implement `fetchTopic` (subscription-gated, `NotSubscribedError`, `after` as an *exclusive*
cursor, `limit` applied after the cursor) and `trim({ topicID, before })` (removes log entries with
sequenceID strictly below `before`; never touches `head`).

**`publish` still ignores `expectedHead` and `publishID`.** Leave them alone.

### The three existing tests that assert the old contract

These pass today and **must be rewritten, not preserved**. Each one *asserts* a behaviour the spec
now forbids. Rewriting a green test will feel wrong; do it deliberately, and in the commit message
name the contract each one used to encode.

- `packages/hub-server/test/memoryStore.test.ts:11` — "publish stores nothing when the topic has no
  subscribers (drop)". The spec's central reversal: a publish is now retained whether or not anyone
  is subscribed.
- `packages/hub-server/test/memoryStore.test.ts:83` — "refcount GC: message removed when its last
  subscriber acks". `ack` now deletes a delivery, never a log entry.
- `packages/hub-server/test/memoryStore.test.ts:62` — "last unsubscribe drops the whole topic log
  immediately". Trim is the only deleter.

Rewrite each to assert the *new* contract (the frame is still there; it is still readable via
`fetchTopic`), so the file goes on documenting the store's retention rules rather than the old
ones.

**`packages/hub-server/test/hub.test.ts` must stay untouched and green.** It is the mailbox
regression check: the push path, the rendezvous lane and the app lanes all still work exactly as
they did. If it fails, the log/delivery split broke the mailbox and that is the finding — report it,
do not fix it by weakening the test.

## Rules

- If the approach does not work — the split cascades into `hub-server`'s other modules, the
  delivery index cannot be separated cleanly, anything — **stop and report `BLOCKED` with what you
  hit.** Do not try an alternative approach without asking.
- Do not touch the conformance suite (`packages/hub-protocol/src/conformance.ts`). It is the
  contract; this question is judged *by* it. If you believe a clause is wrong, report that — do
  not edit it to pass.
- Do not implement CAS or idempotency, however tempting it is once the log exists.

## Conventions

- Follow the `kigu:conventions` skill and the repo's `AGENTS.md` / `CLAUDE.md`.
- `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID` / `HTTP` / `JWT`;
  ES `#fields`, never `private` / `readonly`. pnpm only. Do not edit generated `lib/`.
- **Code, comments, and test names never reference plan questions, decision numbers, phase labels,
  or G-numbers.** No `// Q1.2:`. State the invariant directly: "a delivery row references a log
  entry; it does not own it".

## Verify

From the repo root, and include the output in the report:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

(An `rtk` shim intercepts `pnpm run <script>`; the `rtk proxy` prefix is required.)

Expect the conformance suite to still fail on the CAS and dedup clauses — by design. Every other
test in the repo must pass, including the untouched `hub.test.ts` and the integration tests under
`tests/integration`.

## Report contract

Write the full report to `docs/superpowers/probes/question-1.2-report.md`:

- The storage model you landed — what the log is, what a delivery is, and what each operation now
  touches. Cite `file:line`.
- The conformance suite's **pasted** output, and the pass/fail count against the prediction above.
  Call out any clause that passed or failed differently than predicted, and why.
- What each of the three rewritten tests used to assert, and what it asserts now.
- Confirmation that `hub.test.ts` is untouched and green — the mailbox is not regressed.
- The full verify output.
- What surprised you. In particular: did anything *else* in `hub-server` depend on messages being
  deleted by ack or unsubscribe?

**Return to the caller only:** status (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`),
a one-line test summary, and your concerns. Not the report body — it is on disk.

Do not commit. Leave the working tree dirty; the caller commits after review.
