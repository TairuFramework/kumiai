# @kumiai/hub-server

The hub server: `@kumiai/hub-protocol`'s procedure handlers wired to an `@enkaku` server, a live
client registry for push fan-out, and an in-memory `HubStore` for development and tests.

## Exports

- `createHub({ transport, store, identity, ... })` — the whole server: handlers, registry, access
  rules, rate limits, and an optional scheduled purge. Returns `{ registry, server }`.
- `createHandlers({ registry, store, ... })` — the handlers alone, for a host assembling its own
  server.
- `createMemoryStore({ maxDepth?, retention? })` — an in-memory `HubStore`. For testing and
  development; it is also what runs the `@kumiai/hub-conformance` suites in this repo.
- `HubClientRegistry` — the live-connection table.
- `createRateLimiter`, `DEFAULT_RATE_LIMITS`, `DEFAULT_KEYPACKAGE_FETCH_LIMITS`,
  `DEFAULT_HUB_ACCESS_RULES`.

```ts
import { createHub, createMemoryStore } from '@kumiai/hub-server'

const { server } = createHub({ transport, identity, store: createMemoryStore() })
```

## The hub is blind, and identity comes only from the signature

Topic IDs are opaque and payloads are ciphertext the hub never opens. Every handler takes the caller
DID from the **verified issuer** of the signed message, never from a wire field — so `hub/topic/fetch`
cannot be pointed at someone else's subscription, and a publish cannot claim another sender. The
`identity` param is required for that reason.

Authorization is two layers, and only the second one knows about topics: `accessRules` gate the
procedures (the default lets any authenticated DID call them), and the optional `authorize(did,
action, topicID)` hook decides publish and subscribe per topic. The default allows any authenticated
DID.

## Durable subscription, ephemeral connection

Subscription state lives in the store. `HubClientRegistry` holds only currently-connected clients and
their live `hub/receive` writers, so it routes push fan-out and nothing else — a restart loses no
subscription.

Binding a receive channel **evicts** whatever held the lane for that DID. A reconnect happens because
the old connection broke and the server learns that last, so the stale writer must give way to the
live one, not the other way round. The evicted channel is resolved rather than thrown: being replaced
is not its error, and the client that replaced it is the same client.

`hub/receive` is always added to the server's `longLivedProcedures`, so open mailbox channels are
exempt from `controllerTimeoutMs` and from the `maxConcurrentHandlers` cap. A host passing its own
`limits` does not need to remember this.

## What live fan-out does and does not push

A **deduped** publish fans out to nobody. It appended nothing — the frame was already accepted and
already delivered to whoever was subscribed then, and its sequenceID may since have been acked and
its delivery row removed — so re-running the loop would push a frame every current subscriber has
already applied, named by a dead sequenceID. Fan-out is for a genuine append only.

The sender is excluded from its own fan-out. `hub/topic/fetch` makes no such exclusion — a topic's
log holds every log-class frame including the caller's own — so a reader that must not see its own
messages twice filters them itself, as `@kumiai/rpc`'s drain does.

A pushed frame carries `logPosition` **only** when it is log-class, and the key is spread in rather
than assigned, because `logPosition: undefined` becomes a present key with a falsy value once it is
off the wire — and the entire point of the field is that a reader can tell "no place in any log" from
a place.

## Retention: the store refuses, the hub schedules

Two different knobs, easily confused. `createHub`'s `purge.olderThan` (default 7 days) is the **age
bound** the scheduled sweep applies to a topic no subscriber asked to keep longer; the sweep runs on
`purge.interval` (default 1 hour) and stops with the server. The **ceiling** on what a subscriber may
request belongs to the store, because the store is what refuses the subscribe —
`createMemoryStore`'s is 30 days, finite by design, since an unbounded ceiling lets any subscriber
pin a topic's frames forever with `subscribe({ retention: 2 ** 31 })`. A subscribe above the ceiling
is refused with `RetentionExceededError`, never clamped.

`createMemoryStore`'s `maxDepth` (default 1000) evicts the oldest **log** frames beyond that count.
Mailbox frames on the same topic are not counted, so a member cannot evict the log with a mailbox
flood.

Publish rate limits are per DID (20/s, burst 50) and per topic (100/s, burst 200), merged over
`DEFAULT_RATE_LIMITS`; `hub/keypackage/fetch` has its own request quota per requester DID.
