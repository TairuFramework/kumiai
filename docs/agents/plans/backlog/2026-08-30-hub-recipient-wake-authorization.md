# Hub recipient wake authorization (metadata leak)

**Type:** hardening follow-on.
**Component:** `@kumiai/hub-server`.
**Priority:** low — metadata-only, no payload exposure.

## Context

Receive *payload* delivery is now gated per topic by the `authorize` hook (see
`docs/agents/plans/completed/2026-08-30-hub-receive-authorization.complete.md`). That change closes
the payload leak: a group member removed from a topic no longer receives that topic's frames.

It does **not** gate wake notifications. On the publish path, every stored subscriber without a live
channel is notified via the wake dispatcher with `{ did, topicID, sequenceID }` — metadata only,
never a payload. So a removed member's device can still be woken for a topic it can no longer read,
learning that a `sequenceID` advanced on that topic. The wake authorization is decided only by the
*publisher's* action, not the *recipient's* current topic access.

## Requested change

Gate recipient wakes with the same per-recipient/topic decision the delivery gate uses: before the
publish handler calls the wake dispatcher's `notify` for a given recipient, consult the `authorize`
hook (action `receive/deliver`, or a dedicated `wake/deliver` variant) for that `(did, topicID)`. A
deny suppresses the wake for that recipient without affecting delivery to authorized recipients.

## Notes

- The leak is metadata (topic identity + that a sequence advanced), not message content. Weigh the
  cost of an extra hook call on the publish fan-out hot path against the value of closing a
  metadata side channel.
- A short-TTL decision cache like the delivery gate's would bound the added hook calls.
- Kubun cross-ref: `kubun/docs/agents/plans/backlog/2026-08-30-service-tunnel-review-followups.md`.
- Kubun consumers implementing `AuthorizeHook` must handle the `receive` and `receive/deliver`
  actions already added; a new `wake/deliver` variant would extend that surface again.
