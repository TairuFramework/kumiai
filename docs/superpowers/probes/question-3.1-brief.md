# Probe brief — Question 3.1

## The question

**Does the pull-driven commit lane seed and catch up correctly?**

- **Assumption:** a cursor seeded by **reading the log** serves the three peers that have applied
  nothing from the topic — the fresh joiner (from a Welcome), the re-seeded peer (whose backlog was
  trimmed), and the rejoiner (external commit).
- **⚠️ Wrong-but-passing:** **seeding the cursor from the topic's `head` at subscribe time.** It is
  the obvious move — the head is right there in `fetchTopic`'s reply — and **every online-peer test
  passes**. The joiner then CASes against a head whose commits it never applied, and it is wrong in
  exactly the case the pull lane exists for.

## Scope

**In scope:** the topic split, the peer's `reconciledHead` cursor, subscribe-then-pull seeding,
catch-up, and push-as-wakeup. `packages/rpc/src/` (`topic.ts`, `peer.ts`, `hub-mux.ts` as needed).

**Out of scope, and do not build:** the bodies-in-the-frame blob (question 3.2 — for now the frame
payload is whatever it is today), the commit CAS/journal loop (3.3), the cursor-advance
classification table (3.4), recovery wiring (3.5+), and the epoch/mailbox interlock (3.7). If the
lane's shape forces a decision that belongs to one of those, **note it in the report** rather than
reaching for it.

This is the **first `rpc` change in the whole plan.** Read before you write: `peer.ts`, `topic.ts`,
`hub-mux.ts`, and the existing tests are the ground truth for how a peer currently drives the hub.

## Spec excerpt (verbatim — this is the contract)

> #### Topic split
>
> Today's single handshake topic carries commits *and* recovery frames, and any publish would
> move the head. It splits:
>
> - `commitTopic(recoverySecret)` — commits only, CAS'd, read as a log.
> - `rendezvousTopic(recoverySecret)` — recovery request/reply, unconditional, push-delivered.
>
> Both remain non-rotating and derived from `exportRecoverySecret()`, so a peer stranded on
> any epoch still shares both rendezvous with the live group. Both are subscribed for the
> peer's whole life, never rebuilt on resync.
>
> #### The commit lane is pull-driven
>
> The peer drives `commitTopic` by **pull**, not by delivery. It keeps one cursor,
> `reconciledHead` — the sequenceID of the last commit frame it has *processed*, whether it
> applied that frame or dropped it as stale or malformed.
>
> - **Seeding (G1).** A peer that has applied nothing from the topic — a fresh member from a
>   Welcome, a peer whose backlog was trimmed, a peer that just rejoined by external commit —
>   seeds its cursor by *reading the log*, not by guessing. It subscribes first, then calls
>   `fetchTopic` from its last known cursor (or from the oldest retained frame), processes
>   every frame it can, and sets `reconciledHead` to what it reached. A frame framed at an
>   epoch it has already passed is dropped and still advances the cursor. This is also what
>   closes problem 4: the late-subscribing joiner *pulls* the commits it missed instead of
>   being stranded, and needs no recovery at all.
> - **Push is only a wakeup.** The subscription still delivers commit frames; the peer treats
>   a delivery as a hint to pull, and takes the frames from the pull. Delivery order,
>   redelivery, and the store's exclusion of the sender from its own recipients all stop
>   mattering for commits.
> - **Ack becomes cursor-advance.** "Do not ack, so the hub redelivers" is no longer how the
>   commit lane retries; the cursor simply does not advance.
>
> **Only the commit lane becomes a log (G9).** … The rendezvous lane and the app lane keep the
> mailbox semantics, deliberately: a recovery requester subscribes before it asks, so it cannot
> miss its own reply, and app data has the host's own sync behind it.

## The two traps found while wiring the transport (question 1.5), both landing here

Read these before writing the lane. Each produces a lane that passes its tests and is wrong.

1. **A log publish is pushed *and* retained.** An accepted `retain: 'log'` frame goes down
   `hub/receive` **and** into the log. So an online peer **sees every commit twice** — once as a
   push, once in the pull. The lane drives by **pull**; a push is a wakeup and **nothing more** —
   the payload of the pushed copy must never be processed. A lane that also processes the pushed
   copy works perfectly in every single-peer test (the store excludes the sender from its own
   recipients, so the committer never sees its own push) and **breaks the moment two peers are
   online**. Write a test with two online peers.

2. **`hub/receive`'s `after` and `hub/topic/fetch`'s `after` are both `string` and mean different
   things** — a **delivery-queue** position versus a **log** position. A peer that holds one
   "cursor" and feeds it to both silently mis-pages: it will skip frames or re-read them, and no
   type error stops it. Name them apart in the peer's state — `deliveryCursor` and `reconciledHead`
   — and **do not let them share a type alias either**. If a single `Cursor` type would cover both,
   that is the bug.

## Done when

1. **The topic split lands.** `commitTopic(recoverySecret)` and `rendezvousTopic(recoverySecret)`,
   both derived from `exportRecoverySecret()`, both non-rotating, both subscribed for the peer's
   whole life. The commit lane subscribes with the **log** retention class; rendezvous stays a
   mailbox.

2. **The peer pulls.** It subscribes, then `fetchTopic`s from its cursor (or from the oldest
   retained frame when it has none), processes what it can, and sets `reconciledHead` to what it
   reached. Push is a wakeup: on delivery it pulls, and takes the frames from the pull.

3. **The late-joiner test — the deliverable.** A member is invited; **two further commits land
   before it subscribes**; it converges **by pulling**. Assert: it reaches the group's epoch, it
   calls **no** `recover()`, and it raises **no fork diagnosis** while walking frames from epochs it
   never held. (Fork *classification* is 3.4's; here, just assert nothing spuriously reports a fork
   or a heal — whatever the current code's diagnosis surface is.)

4. **The wrong seeding is proven wrong.** Seed the cursor from `head` at subscribe time instead, and
   show the late-joiner test **fails**. Paste it. Then revert. Same standard as phase 2's
   mutation checks: *a test that would pass against the wrong implementation is not a test.*

5. **Two peers online, one commit, one apply each.** The double-delivery trap, asserted.

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- Do not build 3.2–3.7. Note what they force; do not reach for it.
- Everything currently green stays green — `rpc` has 68 tests and they are the definition of the
  peer's current contract. If one of them **encodes the behaviour this question replaces**, say so
  explicitly and rewrite it deliberately (phase 1 hit exactly this: three tests *asserted* the bug).

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers** — state the invariant directly ("push is a wakeup; the frames come from
the pull").

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root (`rtk proxy` prefix required), plus the integration tests. Include the output.

## Report contract

Write to `docs/superpowers/probes/question-3.1-report.md`:

- The lane's shape, `file:line`: where the cursor lives, where it advances, where the pull happens,
  and **how a pushed frame is prevented from being processed as a frame**.
- **The two cursors, and how they are kept apart** — types, names, and whether anything in the type
  system stops them being crossed.
- **The late-joiner test and its pasted output.**
- **The mutation check**: head-seeded cursor → late-joiner test fails. Pasted.
- **The two-peers-online test and its pasted output.**
- Which existing `rpc` tests encoded the old push-driven contract, and what you did with them.
- What 3.2–3.7 will need that this lane does not yet have — especially anything you had to stub.
- The full verify output.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
