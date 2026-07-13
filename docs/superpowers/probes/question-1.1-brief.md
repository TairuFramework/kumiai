# Probe brief — Question 1.1

## The question

**Does a conformance suite written from the spec actually fail today's store?**

- **Assumption:** the suite's two load-bearing tests (zero-subscriber publish,
  dedup-outlives-trim) fail against the current `memoryStore`, and fail *for the reasons the
  spec predicts*.
- **Done when:** the suite exists in `hub-protocol` (exported for hosts), and running it
  against the **unmodified** `memoryStore` fails on exactly: zero-subscriber publish then
  pull; ack-does-not-delete; dedup-outlives-trim; `fetchTopic` missing. **Paste the failure
  output.** No store behaviour changed in this question.
- **⚠️ Wrong-but-passing:** a suite that only exercises publish → deliver → ack. Today's store
  passes that completely, which is why the log's absence went unnoticed.

**The failure output is the deliverable.** A suite that passes against the unmodified
`memoryStore` is a broken suite, not a working store. If everything passes, that is a finding
— report it, do not "fix" it by changing the store.

## Scope — read this twice

- **You MUST NOT change the behaviour of `packages/hub-server/src/memoryStore.ts`.** Making
  the suite pass is the *next* question's work, not yours.
- The one exception: `memoryStore` must still **typecheck and build**. The new `HubStore`
  members you add to the type surface will break its structural conformance. Where that
  happens, add the *minimal* stub that keeps the build green and fails the test loudly — e.g.
  a `fetchTopic` that throws `new Error('not implemented')`. Do not implement a log. Do not
  implement CAS. Do not touch retention, `ack`, or `deleteMessage`.
- Existing tests (`hub.test.ts`, `memoryStore.test.ts`, and everything else in the repo) must
  still pass. If the type additions break them, that is a signal — report it.

## Spec excerpts (verbatim — this is the contract, do not paraphrase from memory)

From `docs/superpowers/specs/2026-07-13-control-ledger-lane-design.md`, "The `HubStore`
contract change: a log alongside the mailbox":

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
> - **Trim governs the log**, by depth and age, and is the only thing that removes a log entry.
>   Trim moves `oldest` and never touches `head`.
> - **The `publishID` → `sequenceID` dedup record is not a log entry, and trim must not remove
>   it (G24).** It has its own retention, strictly longer than the commit-log trim window;
>   **retaining it indefinitely is the recommended implementation** — it is a hash and a
>   sequenceID, one per commit rather than one per delivery, a few dozen bytes. Hanging the key
>   off the message row is the natural implementation and it is **wrong**: trim would delete the
>   idempotency record along with the frame, and a replay of that `publishID` would silently
>   become an ordinary new publish.

The type surface (verbatim from the spec):

```ts
export type PublishParams = {
  senderDID: string
  topicID: string
  payload: Uint8Array
  /**
   * Compare-and-set on the topic's head. Absent: append unconditionally. Present: append
   * only if the topic's current head is exactly this value, where `null` means "the topic
   * has never had an accepted publish". On mismatch, throw HeadMismatchError and store
   * nothing.
   */
  expectedHead?: string | null
  /**
   * Idempotency key. Republishing an already-accepted publishID returns its original
   * sequenceID instead of appending again. This is what makes the commit journal's restart
   * replay work (see "Restart replay"), so its record has its OWN retention — it is not a
   * log entry and MUST NOT be trimmed with one (G24).
   */
  publishID?: string
}

export type FetchTopicParams = {
  /** Authorization: the caller must be a current subscriber of topicID. */
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

export type HubStore = {
  // ...existing members unchanged
  publish(params: PublishParams): Promise<string>
  fetchTopic(params: FetchTopicParams): Promise<FetchTopicResult>
}
```

Ordering and atomicity contract (verbatim):

> - sequenceIDs are **lexicographically ordered, strictly increasing within a topic** —
>   byte-comparable, so a fixed-width zero-padded encoding, not a bare decimal and not a UUID;
> - the sequenceID is **minted by the store inside the CAS transaction**, not by the process.
>
> **Atomicity is a contract requirement, not an implementation detail.** The head comparison,
> **the sequence mint**, the append, and the head advance MUST happen in **one transaction**.
> A read-then-write CAS is a race — precisely the race D1 exists to eliminate. A host reading
> "the head is a scalar" could reasonably implement it as three statements; the contract
> forbids that in words, and the conformance suite must catch it.
>
> `fetchTopic` is gated on subscription, so it exposes a topic's log only to members who
> already derive that topic from the group secret.

The suite's required clauses, from the spec's Testing section (verbatim):

> - **`HubStore` conformance suite**, run against the memory store and **exported from
>   `hub-protocol` for hosts to run against their own store** — it is the contract, and every
>   clause below exists because a plausible implementation gets it wrong:
>   - **The log is real: publish to a topic with zero subscribers, then subscribe and pull
>     the frame.** The single test that proves retention is not a function of delivery. Every
>     store passes today's tests and fails this one.
>   - **Ack does not delete:** subscriber acks a frame, then pulls it again via `fetchTopic`.
>   - **Trim is the only deleter:** `head` survives a trim while `oldest` moves.
>   - **Ordering:** sequenceIDs sort lexicographically across a 9→10 boundary. A store minting
>     unpadded decimals passes the type and fails here.
>   - **CAS:** two publishes at the same head — one accepted, one `HeadMismatchError`, nothing
>     stored for the loser; the empty-topic sentinel (`null`); a replayed `publishID` returns
>     the original sequenceID and appends nothing.
>   - **The dedup record outlives the log (G24): publish with a `publishID`, trim the log, then
>     republish the same `publishID` — the original sequenceID comes back and nothing is
>     appended.** A store that hangs the key off the message row passes every other test here
>     and fails this one, exactly as a delivery-derived store passes everything and fails the
>     zero-subscriber test. These two are the suite's load-bearing tests.
>   - **Concurrent CAS under real parallelism:** N racing publishes at the same head yield
>     exactly one accepted append. This must run against a real database over **separate
>     connections** — not N `await`s on one connection, which the obvious in-memory version
>     does and which a non-transactional, process-counter store passes while being broken.
>   - `fetchTopic` refuses a non-subscriber.

## The approved approach

1. **Read first.** `packages/hub-protocol/src/types.ts`, `packages/hub-protocol/src/index.ts`,
   `packages/hub-server/src/memoryStore.ts` and its existing tests. Understand today's
   retention model (publish with zero recipients stores nothing; `removeDelivery` /
   `deleteMessage` GCs the message once the last delivery is acked) before writing a line.

2. **Land the type surface** in `hub-protocol`: `PublishParams.expectedHead`,
   `PublishParams.publishID`, `FetchTopicParams`, `FetchTopicResult`, `HubStore.fetchTopic`,
   and a `HeadMismatchError`. Both new `PublishParams` fields are optional, so existing
   callers keep compiling. Follow the existing error-class pattern in the package if there is
   one.

3. **Write the conformance suite** as a new module in `hub-protocol` — a function that takes a
   store factory and registers the test cases, so a host (kubun) imports it and runs it
   against its own SQL store. It is production code in `src/`, exported from the package, not
   a test file. Decide the export shape from what the repo's test runner supports (check how
   other packages structure tests); the requirement is that a host can call one exported
   function with `() => new TheirStore()` and get the whole contract asserted.

   Cover every clause quoted above. The two load-bearing ones — zero-subscriber publish, and
   dedup-outlives-trim — are the point of the exercise; write them so they cannot pass by
   accident.

   The concurrent-CAS case: the spec says it must run over separate connections against a real
   database, which an in-memory store cannot express. Include the test, and **document in the
   suite's own doc comment** that an in-process store cannot prove atomicity — hosts must run
   this one against their real database over separate connections. Do not silently omit it.

4. **Run it against the unmodified `memoryStore`** from `hub-server`, and capture the output.
   Expect failures. That output is the deliverable.

5. **Keep the build green.** `fetchTopic` on `memoryStore` may be a throwing stub. Nothing
   else in `memoryStore` changes.

## Rules

- If the approach does not work — the suite cannot be expressed as an exported function, the
  type additions cascade into unrelated packages, anything — **stop and report `BLOCKED` with
  what you hit.** Do not try an alternative approach without asking.
- If the suite *passes* against the unmodified store, **stop and report that.** Do not adjust
  the store to create a failure, and do not adjust the suite to manufacture one. A pass means
  either the suite is wrong or the spec's reading of the store is wrong, and either is a
  finding the human needs.

## Conventions

- Follow the `kigu:conventions` skill and the repo's `AGENTS.md` / `CLAUDE.md`.
- `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID` / `HTTP` / `JWT`;
  ES `#fields`, never `private` / `readonly`. pnpm only. Do not edit generated `lib/`.
- **Code, comments, and test names never reference plan questions, decision numbers, phase
  labels, or G-numbers.** No `// Q1.1:`, no `// G24`. State the constraint or invariant
  directly: "the dedup record has its own retention and is never removed by trim" — not "G24".

## Verify

Run from the repo root, and include the output in the report:

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

(An `rtk` shim intercepts `pnpm run <script>`; `rtk proxy` is required to reach the real
scripts. See the machine notes in the user's global `CLAUDE.md`.)

Note that `pnpm test` is expected to *fail* on the new conformance tests, by design. Every
*other* test must still pass. Make that distinction explicit in the report.

## Report contract

Write the full report to `docs/superpowers/probes/question-1.1-report.md`, containing:

- What you found in today's `memoryStore` — the actual retention mechanism, cited as
  `file:line`.
- The suite's export shape and how a host runs it.
- **The pasted failure output** from running the suite against the unmodified store, and for
  each failing case, whether it failed *for the reason the spec predicts* or for some other
  reason (a mismatched assertion, a missing method, a type error). This distinction is the
  whole finding.
- The full verify output.
- Anything that surprised you.

**Return to the caller only:** status (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` /
`NEEDS_CONTEXT`), the commits made, a one-line test summary, and your concerns. Not the report
body — it is on disk.

Do not commit. Leave the working tree dirty; the caller commits after review.
