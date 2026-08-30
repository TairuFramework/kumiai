# Design — Authorize `hub/v1/receive`

**Component:** `@kumiai/hub-server`.
**Addresses:** `2026-08-30-hub-receive-authorization-gap.md` (defect: receive delivery
bypasses the `authorize` hook, so a removed member keeps draining a topic's backlog
and live deliveries).
**Origin:** Kubun `feat/sakui-multi-device-sync-enablers` review (2026-08-30).

## Problem

`createHub({ authorize })` gates `publish`, `subscribe`, and `topic/fetch`, but the
`hub/v1/receive` handler drains `store.fetch({ recipientDID })` and binds the live
writer with no authorization check. A DID authorized to subscribe to a private topic
while it was a group member keeps receiving that topic's backlog and subsequent
deliveries after removal — the hook is never asked, so it can never revoke.

The receive channel is per-DID and topic-agnostic: it drains frames across *all* of
the recipient's topics. But every delivered frame carries a `topicID`. Revocation is
therefore inherently per-topic — a DID removed from topic X while still a member of
topic Y must stop receiving X and keep receiving Y — so a connect-time, DID-only gate
cannot express it. The fix gates delivery per frame, by topic, while keeping a cheap
coarse gate at connect time.

## Approach

Two gates, both driven by the existing `authorize` hook:

1. **Coarse connect gate** — one uncached check when the channel opens: may this DID
   receive at all. Rejects a fully-banned DID before any state is registered.
2. **Per-frame topic gate** — check each frame's `topicID` against current policy
   before it is written to the socket, on both the backlog drain and live delivery.
   This is the check that actually revokes a removed member. Decisions are cached
   per `(did, topicID)` with a short TTL to bound hook calls under load; the TTL is
   the maximum revocation-latency window.

When no `authorize` hook is configured the hub allows all delivery, exactly as today —
existing deployments are unaffected.

## Changes

### 1. Two new `AuthorizeRequest` variants

In `packages/hub-server/src/handlers.ts` (the `AuthorizeRequest` union, ~line 32):

```ts
| { action: 'receive'; did: string }
| { action: 'receive/deliver'; did: string; topicID: string }
```

`receive` is the coarse connect gate (no topic); `receive/deliver` is the per-frame
gate. The slash sub-action naming follows the existing `topic/fetch`,
`keypackage/upload`, and `wake/register` variants. Both additions are additive to the
union and re-exported unchanged from `src/index.ts`.

### 2. Coarse connect gate

At the top of the `hub/v1/receive` handler, before `registry.register(clientDID)`,
consult the hook:

```ts
const decision = normalizeAuthorizeDecision(
  await authorize({ action: 'receive', did: clientDID }),
)
if (!decision.allow) {
  throw new HandlerError({
    code: HUB_ERROR_CODES.authorizationDenied,
    message: decision.reason ?? 'Not authorized to receive',
  })
}
```

Uncached and immediate, mirroring the `subscribe` handler's deny path. No channel
state is registered when it denies.

### 3. Per-frame topic gate

Fold the check into `pushWrite`'s chained async step, so a single site gates both the
drain (the `pushWrite(toReceiveFrame(msg))` call in the drain loop) and live delivery
(the `pushWrite(frame)` call in `onLive`), and `onLive` stays synchronous. Inside the
`writeChain.then(async () => { ... })` body, before `writer.write(frame)`:

```ts
if (!(await gate(clientDID, frame.topicID))) return
```

Returning early skips the write and releases the `pending` slot in the existing
`finally` block. `lastServed` is only advanced on a successful write, so a denied
frame does not raise it and the `> lastServed` dedup stays correct.

`gate(did, topicID)` wraps `authorize({ action: 'receive/deliver', did, topicID })`
behind a decision cache:

- Cache keyed by `(did, topicID)`, value `{ allow: boolean; expiresAt: number }`.
- On hit within TTL, return the cached `allow` without calling the hook.
- On miss or expiry, call the hook, normalize, store, return.
- The cache lives for the channel handler's lifetime (a local `Map`), so it is torn
  down with the channel — no cross-connection state.

### 4. Configurable TTL

Add `receiveAuthCacheTTL?: number` to `CreateHandlersParams` (sibling to
`receiveBufferLimit`), default `5000` (milliseconds). This is the maximum window a
removed DID can keep draining a topic after the hook flips to deny. Deployments that
need tighter revocation lower it; the coarse connect gate is unaffected (always
immediate).

### 5. Deny semantics (per-frame)

A denied frame is **skipped and left pending** in the store — never acked. It
redelivers on the recipient's next connect and is re-gated; if the DID is still
denied it stays pending (idempotent store-and-forward, the same fallback the buffer
cap already uses), and if it is later re-authorized it delivers then. No frame is
dropped and no data is lost. Denial does not tear the channel down: other topics on
the same channel keep flowing.

## Testing (hub-server)

New tests in `packages/hub-server/test/`:

- **Connect gate deny** — `authorize` returning deny for `action: 'receive'` rejects
  the channel with `authorizationDenied` and registers no state.
- **Mid-stream revocation (drain)** — a DID whose `receive/deliver` decision flips to
  deny for topic X stops receiving X's backlog frames; frames stay pending.
- **Topic isolation** — on one channel, a DID denied for topic X still receives
  topic Y's frames.
- **Cache TTL** — repeated same-topic frames within the TTL call the hook once;
  after the TTL a flipped decision takes effect (revokes).
- **No-hook deployment** — a hub created without `authorize` delivers all frames, drain
  and live, unchanged.

Test doubles/conformance: `authorize` is a `createHub` option, not part of the
hub-conformance contract (the suite has no `authorize` coverage), so no conformance
suite or double changes. Confirm this during implementation.

## Consumer note (Kubun)

`joinLaneAuthorize` and any other `AuthorizeHook` implementation must handle the two
new actions. Adding union variants surfaces at compile time in an exhaustive `switch`;
an implementation with a permissive default must be checked so it does not
accidentally allow `receive`/`receive/deliver` it means to deny. Track on the Kubun
side (`kubun/docs/agents/plans/backlog/2026-08-30-service-tunnel-review-followups.md`).

## Out of scope

- Per-frame gating for a *remote* authorize hook's throughput beyond the TTL cache
  (e.g. batching, or the invalidation-signal design). The 5s cache is the first cut;
  revisit if a remote hook lands.
- Imperative subscription/live-channel revocation API (defect option 2). The hook
  now covers receive end to end, which was the preferred option.
