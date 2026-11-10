# @kumiai/hub-server

The hub server: `@kumiai/hub-protocol`'s procedure handlers wired to an `@enkaku` server, a live
client registry for push fan-out, and an in-memory `HubStore` for development and tests.

## Exports

- `createHub({ transport, store, identity, ... })` — the whole server: handlers, registry, access
  rules, rate limits, and an optional scheduled purge. Returns `{ registry, server, dispose }`.
- `createHandlers({ registry, store, ... })` — the handlers alone, for a host assembling its own
  server.
- `createMemoryStore({ maxDepth?, retention? })` — an in-memory `HubStore`. For testing and
  development; it is also what runs the `@kumiai/hub-conformance` suites in this repo.
- `HubClientRegistry` — the live-connection table.
- `createRateLimiter`, `DEFAULT_RATE_LIMITS`, `DEFAULT_KEYPACKAGE_FETCH_LIMITS`,
  `DEFAULT_RECEIVE_WINDOW`, `DEFAULT_RECEIVE_WINDOW_BYTES`, `DEFAULT_RECEIVE_ACK_TIMEOUT`,
  `DEFAULT_HUB_ACCESS_RULES`.
- `HubStoreErrorEvent`, `HubStoreErrorHook` — the `onStoreError` event and hook types.

`createHub` accepts `replay` with a cache and tuning (`maxAge`, `leeway`, `maxEntries`).
The hub always enables replay checks and rejects stale tokens. Supply a persistent `replay.cache`
to keep replay protection across restarts; omitted, it uses a per-process memory cache.

```ts
import { createHub, createMemoryStore } from '@kumiai/hub-server'

const { server } = createHub({ transport, identity, store: createMemoryStore() })
```

## The hub is blind, and identity comes only from the signature

Topic IDs are opaque and payloads are ciphertext the hub never opens. Every handler takes the caller
DID from the **verified issuer** of the signed message, never from a wire field — so
`hub/v1/topic/fetch` cannot be pointed at someone else's subscription, and a publish cannot claim
another sender. The `identity` param is required for that reason.

Authorization is two layers, and only the second one knows about topics: `accessRules` gate the
procedures (the default lets any authenticated DID call them), and the optional
`authorize(request)` hook decides the rest. It takes one discriminated `AuthorizeRequest` — narrow
on `request.action` — and returns `AuthorizeDecision`, either a boolean or
`{ allow, reason?, code?, retryAfterMs? }`. `AuthorizeRequest` names nine actions, of which only
`unsubscribe` is not dispatched today; the two `wake/*` actions gate push registration, which is the
one durable per-device identifier the hub stores. The default allows any authenticated DID, and a
hook should allow any action it does not recognise, so that a hook written before a variant shipped
does not start refusing a procedure that used to be ungated.

## Durable subscription, ephemeral connection

Subscription state lives in the store. `HubClientRegistry` holds only currently-connected clients and
their live `hub/v1/receive` writers, so it routes push fan-out and nothing else — a restart loses no
subscription.

Binding a receive channel **evicts** whatever held the lane for that DID. A reconnect happens because
the old connection broke and the server learns that last, so the stale writer must give way to the
live one, not the other way round. The evicted channel is resolved rather than thrown: being replaced
is not its error, and the client that replaced it is the same client.

`hub/v1/receive` is always added to the server's `longLivedProcedures`, so open mailbox channels are
exempt from `controllerTimeoutMs` and from the `maxConcurrentHandlers` cap. A host passing its own
`limits` does not need to remember this.

## What live fan-out does and does not push

A **deduped** publish fans out to nobody. It appended nothing — the frame was already accepted and
already delivered to whoever was subscribed then, and its sequenceID may since have been acked and
its delivery row removed — so re-running the loop would push a frame every current subscriber has
already applied, named by a dead sequenceID. Fan-out is for a genuine append only.

The sender is excluded from its own fan-out. `hub/v1/topic/fetch` makes no such exclusion — a topic's
log holds every log-class frame including the caller's own — so a reader that must not see its own
messages twice filters them itself, as `@kumiai/rpc`'s drain does.

A pushed frame carries `logPosition` **only** when it is log-class, and the key is spread in rather
than assigned, because `logPosition: undefined` becomes a present key with a falsy value once it is
off the wire — and the entire point of the field is that a reader can tell "no place in any log" from
a place.

## The receive channel is paced by acks

`hub/v1/receive` writes a frame only while the frames in flight on that channel stay under a window:
`receiveWindow` frames (`DEFAULT_RECEIVE_WINDOW`, 256) and `receiveWindowBytes` bytes
(`DEFAULT_RECEIVE_WINDOW_BYTES`, 512 KiB, counting the base64 payload plus an envelope estimate; one
frame always goes through when nothing else is in flight). The backlog drain and live pushes share
the window, and acks are read from the moment the channel opens, so the drain advances as the client
acks it.

The transport cannot do this pacing: `writer.ready` on a channel says nothing about the HTTP
bridge's per-session buffer, which `@enkaku/http-serve` drops whole once it passes
`maxSessionBufferBytes`. Unpaced, a backlog larger than that buffer, read by a slow client, ended
the session on every connect before any ack reached the hub, and the next connect redelivered the
same backlog. Keep the byte window well below the transport's session buffer.

The channel is ordered, so an ack for a frame proves the client has read every frame written before
it: for the window, an ack releases that frame and all earlier ones. The store still frees only the
deliveries actually acked. A client can leave frames unacked for good — a topic it subscribed to but
reads with `hub/v1/topic/fetch`, or one no consumer on the device claims — and those frames must not
hold the window, or they would come back first on every connect and stall it.

A full window that sees no ack at all for `receiveAckTimeout` ms (`DEFAULT_RECEIVE_ACK_TIMEOUT`,
15 s; each ack restarts it) is released whole and the drain goes on; the channel is not ended,
because a window made only of never-acked frames would come back first on the next connect too. A
client that has stopped reading cannot grow a buffer without bound: the HTTP bridge drops its
session, and a transport with real backpressure stalls the write until `receiveBufferLimit` tears
the channel down.

## Retention: the store refuses, the hub schedules

Two different knobs, easily confused. `createHub`'s `purge.olderThan` (default 7 days) is the **age
bound** the scheduled sweep applies to a topic no subscriber asked to keep longer; the sweep runs on
`purge.interval` (default 1 hour) and stops with the server. The **ceiling** on what a subscriber may
request belongs to the store, because the store is what refuses the subscribe —
`createMemoryStore`'s is 30 days, finite by design, since an unbounded ceiling lets any subscriber
pin a topic's frames forever with `subscribe({ retention: 2 ** 31 })`. A subscribe above the ceiling
is refused with `RetentionExceededError`, never clamped.

When the store supports subscription reaping, each tick also removes inactive subscriptions after message purge settles.
`purge.subscriptionOlderThan` sets the inactivity window in seconds, defaulting to `7776000` (90 days).
The effective window is `Math.max(subscriptionOlderThan, olderThan)`, so subscriptions outlive the message retention window.
Both operations report failures through `onStoreError` independently. Disposal waits for both operations.

`createMemoryStore`'s `maxDepth` (default 1000) evicts the oldest **log** frames beyond that count.
Mailbox frames on the same topic are not counted, so a member cannot evict the log with a mailbox
flood.

Publish rate limits are per DID (20/s, burst 50) and per topic (100/s, burst 200), merged over
`DEFAULT_RATE_LIMITS`; `hub/v1/keypackage/fetch` has its own request quota per requester DID.
A request over a limit is refused with `HUB_RATE_LIMITED` (`RateLimitedError`) before it takes effect, so the caller waits and retries it.

## A store failure that is not a request failure

Four store operations are deliberately not allowed to fail the request they happen in:
- the **last-resort key-package top-up**, read after `fetchKeyPackages` has already consumed
  destructively — surfacing it would destroy packages nobody received, and the client's retry
  would burn the next batch
- an **ack**, where the frame simply stays pending and the client re-acks next round
- a scheduled **purge**, retried on the next interval
- the **subscriber read for live fan-out**, which runs after the publish committed its append and
  delivery rows — every subscriber still receives the frame by pulling, and failing the request
  would instead lose the live push for good, since the caller's `publishID` retry dedups and skips
  fan-out

All four are correct, and all four were silent. `createHandlers` and `createHub` take
`onStoreError`, called with an event discriminated on `method` — the `HubStore` method that threw —
carrying the subject that method has: `did` for `ack` and `fetchLastResortKeyPackage`, `topicID` for
`getSubscribers`, neither for `purge`. Wire it to whatever an operator watches:

```ts
const { server } = createHub({
  transport,
  store,
  identity,
  onStoreError: (event) => metrics.storeFailure(event),
})
```

Fire-and-forget — a throw from the hook is swallowed rather than allowed to fail the request.
Unwired, the failure is reported through `@sozai/log` under `['kumiai', 'hub-server']` at `error`
rather than passing silently. Pass an empty handler to silence it deliberately.

There is no throttling: a permanently broken store reports per request. logtape ships
`getThrottlingFilter`, so rate control belongs in the app's sink configuration where an operator
can tune it.

## Invocation hooks and attribution

`createHub` accepts optional `onInvocation`, forwarded to the Enkaku server for authenticated invocation context and delegation verification.
`createHub` and `createHandlers` accept optional `resolveAttribution({ message, senderDID })`.
The resolver can return `HubAttribution`, `undefined`, or a promise of either.

Without a resolver result, publishes use `{ account: senderDID, actor: senderDID, via: 'direct' }`.
The sender DID still comes from the verified signature.
A resolver supplies host accounting metadata rather than changing the authenticated sender or authorisation rules.
Only a verified delegation yields `via: 'delegated'`. A claimed subject alone does not prove delegation.
Hosts can use `onInvocation` to verify delegation before resolving attribution.

The store receives the resolved attribution with the publish.
The SQL stores persist it. The development memory store reports publish outcomes but does not implement occupancy sampling.
Unconfigured hooks preserve existing routing, retention and delivery behaviour.
