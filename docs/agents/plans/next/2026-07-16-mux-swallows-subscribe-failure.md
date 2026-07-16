# The mux swallows every subscribe failure

## The gap

`packages/rpc/src/hub-mux.ts:114`:

```ts
if (next === 1) void Promise.resolve(hub.subscribe(localDID, topicID, options)).catch(() => {})
```

Every error from `hub.subscribe` is discarded. The refcount is already incremented, so the mux believes
the topic is subscribed, and every later `retain` on it is a no-op. Nothing retries. Nothing reports.
The peer is simply not a subscriber of a topic it thinks it holds — and a topic it is not subscribed to
delivers nothing, and cannot even be `fetchTopic`'d (the hub gates a fetch on the caller's own
subscription).

## Why it is sharp now

`@kumiai/hub-protocol` refuses to downgrade silently, on purpose. `SubscribeParams.retention`
(`packages/hub-protocol/src/types.ts:79-84`):

> Above the hub's maximum: **RetentionExceededError at subscribe time** — never a silent downgrade to
> the maximum, which would strand a peer that believed it had asked for more.

That error is exactly what line 114 throws away. So a member asking for more retention than the
operator's cap is not downgraded — it is **unsubscribed**, silently. That is strictly worse than the
downgrade hub-protocol declined to do, and it defeats the reason the error exists.

The commit lane already passes `retention: commitLogRetentionSeconds` (`peer.ts:1353`), so this is live
today. The app-lane retention default widens it to every app topic, and makes the documented per-member
override a footgun: the one thing a host might reasonably tune is the one thing that silently strands it.

## Why it is not a one-line fix

Deciding what a peer does when a subscribe fails is a real design question, and the answers differ by
cause:

- **`RetentionExceededError`** is permanent and the host's own doing — a retry never succeeds. It wants
  to surface (throw at construction? the `onAppWindowPruned`-style callback seam?).
- **A transport failure** is transient and wants a retry with backoff, not a report.
- The refcount is incremented before the subscribe resolves, so any fix must also decide what the
  refcount means for a subscription that does not exist yet or never will.

## Options to weigh

1. **Distinguish the causes**: surface permanent failures (retention, authorization) through a host
   seam; retry transient ones. Most correct, most work.
2. **Fail loudly at construction** for the retention case only — validate the requested retention
   against the hub's cap up front, where a host can still act on it. Narrow, cheap, closes the sharp
   edge without designing a general retry policy.
3. **Report through a callback** and let the host decide. Consistent with `onAppWindowPruned`.

Lean 2 as the immediate close, with 1 as the real fix if subscribe failures turn out to matter more
broadly.

## Context

Found during the app-lane delivery work, Question 5.1 (the 30-day app retention default). Not caused by
it — the swallow predates it — but that question is what makes the override path reachable. See
`docs/superpowers/plans/2026-07-16-app-lane-delivery-plan.md`.
