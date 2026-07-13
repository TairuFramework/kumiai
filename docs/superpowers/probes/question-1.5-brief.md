# Probe brief — Question 1.5

## The question

**Does `fetchTopic` read the log, gated on subscription — end to end?**

- **Assumption:** a subscriber-gated topic read composes with the existing `hub/receive` mailbox
  channel without disturbing it.
- **Done when:** `fetchTopic({ subscriberDID, topicID, after, limit }) → { messages, head, oldest }`
  is reachable **over the wire**, through `hub-protocol`'s procedure definition, `hub-server`'s
  handlers, `hub-tunnel`'s `HubLike`, and `hub-client`. `expectedHead`, `publishID` and `retain`
  thread through the publish params likewise, and `retention` through subscribe.
- **⚠️ Wrong-but-passing:** implementing `fetchTopic` over the **delivery rows** — they are right
  there, and they are keyed by topic. It returns plausible results for an online peer and returns
  **nothing** for exactly the peers the pull lane exists to serve: the late joiner and the peer back
  from a long absence. Every online-peer test passes.

## Where we are

Questions 1.1–1.4 built the whole log/CAS/dedup model **behind the `HubStore` interface**, and the
conformance suite is 15/15 against `memoryStore`. But nothing built so far is reachable by a client:
every test to date drives the store object directly.

**This question is the wire.** Phase 3's peer lane pulls the commit log over the network, not over a
store handle — so until this lands, Phase 1 is correct and unusable.

Four things must cross the wire, not one. A `retain` flag that does not reach the server means
**every commit is silently published as mailbox-class** and the whole log model reverts to a mailbox
without a single test failing:

| Crosses the wire | Consequence if it silently doesn't |
|---|---|
| `fetchTopic` | no pull lane at all |
| `PublishParams.retain` | commits published mailbox-class; ack GC eats the commit log |
| `PublishParams.expectedHead` | no CAS; concurrent commits fork |
| `PublishParams.publishID` | no idempotency; restart replay double-commits |
| `SubscribeParams.retention` | the 30-day window silently becomes the hub default |

Each of those is a **silent** downgrade to today's behaviour. Assert each one arrives, on the server
side, not merely that the call succeeds.

## Spec excerpt (verbatim)

> `fetchTopic` is gated on subscription, so it exposes a topic's log only to members who already
> derive that topic from the group secret.

And the type surface, which is already implemented in the store and now needs a wire form:

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
  /** The topic's current head: the sequenceID of the last accepted log publish, or null. */
  head: string | null
  /** The oldest sequenceID still retained for this topic, or null if the log is empty. */
  oldest: string | null
}
```

## The approved approach

1. **Read the existing protocol first.** `packages/hub-protocol/src/protocol.ts` defines the
   procedures; `packages/hub-server/src/handlers.ts` implements them; `packages/hub-tunnel/src/transport.ts`
   defines `HubLike`; `packages/hub-client` is the client. Follow whatever shape they already use —
   this is an addition, not a redesign. `hub/receive` is the existing mailbox drain and is the model
   to imitate *and to leave alone*.

2. **`subscriberDID` is not a wire field.** It is the authenticated caller. The server takes it from
   the authenticated session exactly as the existing procedures do — never from the request body, or
   any member could read any topic's log by naming someone else. Check how `hub/receive` and `ack`
   get their DID and do the same. If the existing procedures *do* take it from the body, say so in
   the report rather than following suit — that would be a finding.

3. **Thread the publish and subscribe params through.** `expectedHead`, `publishID`, `retain`,
   `retention`. `HeadMismatchError`, `NotSubscribedError` and `RetentionExceededError` must survive
   the round trip as *distinguishable* errors — a client that sees a generic RPC failure cannot tell
   "I lost the CAS, rebase and retry" from "the hub is down", and the peer lane's whole retry loop
   turns on that distinction. Check how the existing errors cross the wire and follow it.

4. **The integration test is the deliverable.** In `tests/integration`, over a real client and a
   real server: **a peer subscribes to a topic *after* frames were published to it with zero
   subscribers, and pulls them.** That is the end-to-end form of the load-bearing clause, and it is
   the one a delivery-row implementation of `fetchTopic` fails. Also assert a non-subscriber is
   refused, and that a `retain: 'log'` publish survives every subscriber acking it — over the wire,
   not against the store.

## Rules

- **BLOCKED on the first failure of the approach.** Do not try alternatives without asking.
- Do not disturb `hub/receive` or the mailbox path. `hub.test.ts` and the existing integration tests
  stay green.
- Do not implement `fetchTopic` in terms of delivery rows, however convenient. It must read the log.

## Conventions

`kigu:conventions` skill and the repo's `AGENTS.md`. `type` not `interface`; `Array<T>`; never
`any`; capital `ID`; ES `#fields`. **Code, comments and test names never reference plan questions,
phase labels, or G-numbers.**

## Verify

```
rtk proxy pnpm run build && rtk proxy pnpm run lint && rtk proxy pnpm test
```

from the repo root, plus the integration tests. Include the output.

## Report contract

Write to `docs/superpowers/probes/question-1.5-report.md`:

- The wire surface: the procedure, its params, and how `subscriberDID` is authenticated. `file:line`.
- **Whether all five things in the table above actually arrive server-side**, and how you proved it —
  not "the call succeeded", but "the server received `retain: 'log'`". A silent default here reverts
  the entire phase.
- How the three named errors cross the wire, and whether a client can distinguish them from a
  transport failure.
- The integration test, and its pasted output.
- The full verify output.
- Anything that surprised you — especially anything in the existing protocol that assumes the
  mailbox model.

**Return to the caller only:** status, a one-line test summary, concerns. Do not commit.
