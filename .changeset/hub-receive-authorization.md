---
"@kumiai/hub-server": minor
---

Authorize `hub/v1/receive` delivery through the `authorize` hook, closing a gap where a group member
removed from a topic kept draining that topic's backlog and live deliveries (the hook was never
consulted for receive). Two new `AuthorizeRequest` variants — `receive` (coarse, at channel open)
and `receive/deliver` (per frame, by topic) — are gated: the coarse check runs before any channel
state is registered, and the per-frame check runs before every socket write, covering the backlog
drain, buffered-live flush, and direct live delivery. Per-`(did, topicID)` decisions are cached for
a configurable window via the new `receiveAuthCacheTTL` option on `CreateHubParams` and
`CreateHandlersParams` (default 5000ms; `0` disables reuse; non-finite/negative falls back to the
default). A denied frame is skipped and left pending (never auto-acked), redelivering on the
recipient's next connect; a hook that throws fails closed and tears the channel down.

Additive and backward-compatible: hubs created without an `authorize` hook deliver all frames as
before. Consumers implementing `AuthorizeHook` should handle the two new actions.
