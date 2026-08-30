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
   per `(did, topicID)` with a short TTL to bound hook calls under load; the TTL bounds
   how long an already-resolved allow is reused (see §4 for exact semantics).

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

The check goes **inside** the existing `try { ... } finally { pending-- }` body,
before `writer.ready`/`writer.write`, so the early `return` still releases the
`pending` slot via `finally` (placing it before the `try` would leak a slot per
denied frame and eventually trip the buffer cap). Concretely:

```ts
writeChain = writeChain.then(async () => {
  if (tornDown) return
  pending++ // (already present, shown for context)
  try {
    if (!(await gate(clientDID, frame.topicID))) return // denied: skip write
    await writer.ready
    await writer.write(frame)
    if (frame.sequenceID > lastServed) lastServed = frame.sequenceID
  } catch {
    finish()
  } finally {
    pending--
  }
})
```

`lastServed` is only advanced on a successful write, so a denied frame does not raise
it and the `> lastServed` dedup stays correct.

Because the `gate` call sits inside the same `try`, a hook that **rejects** (throws or
rejects its promise) follows the existing write-error path: `finish()` tears the
channel down. This is intentional — a hook that cannot render a decision must fail
closed, not deliver. Allow/deny are the only outcomes that continue the stream.

`gate(did, topicID)` wraps `authorize({ action: 'receive/deliver', did, topicID })`
behind a decision cache:

- Cache keyed by `(did, topicID)`, value `{ allow: boolean; expiresAt: number }`.
- On hit within TTL, return the cached `allow` without calling the hook.
- On miss or expiry, call the hook, normalize, store, return.
- The cache lives for the channel handler's lifetime (a local `Map`), so it is torn
  down with the channel — no cross-connection state.

### 4. Configurable TTL

Add `receiveAuthCacheTTL?: number` to **both** `CreateHandlersParams` (sibling to
`receiveBufferLimit`) **and** the public `CreateHubParams` (`hub.ts`), with `createHub`
forwarding it into `createHandlers` — the existing handler-option pass-through. Without
the `CreateHubParams` addition only direct `createHandlers` callers could tune it;
production callers configure `createHub`.

Default `5000` (milliseconds). Input semantics, enforced where the option is read:

- A finite value `> 0` is the cache TTL.
- `0` disables reuse — every frame calls the hook (exact revocation, no window).
- A non-finite or negative value falls back to the `5000` default.

TTL means the maximum **reuse period for an already-resolved cached decision**:
expiry is measured from when a decision is stored, and excludes hook execution time
and any latency in the external policy the hook consults. Within that period a removed
DID can keep draining a topic; that is the deliberate throughput/revocation trade-off.
The coarse connect gate is uncached and always immediate.

### 5. Deny semantics (per-frame)

A denied frame is **skipped and not written**; the server never auto-acks it, so it
stays pending in the store, redelivers on the recipient's next connect, and is
re-gated. While the DID is denied it stays pending (idempotent store-and-forward, the
same fallback the buffer cap uses); once re-authorized it delivers. Denial does not
tear the channel down — other topics on the same channel keep flowing.

The security guarantee is **no payload reaches a denied recipient**. It is *not* that
a denied frame can never leave the store: the ack loop forwards client-supplied
sequence IDs to `store.ack` unrestricted (`handlers.ts:685`), so a client may still
ack an ID it learned from an earlier delivery. That is harmless — acking only discards
the client's own undelivered mail; no denied payload is served by it. Ack-eligibility
tracking (rejecting acks for IDs never written on this channel) is deliberately **not**
added: it would break legitimate re-acks and guards nothing the payload gate does not
already cover.

## Testing (hub-server)

New tests in `packages/hub-server/test/`:

- **Connect gate deny** — `authorize` returning deny for `action: 'receive'` rejects
  the channel with `authorizationDenied` and registers no state.
- **Deny on each of the three delivery paths** (they are distinct states in the
  machine, so each is tested):
  - *backlog drain* — a `receive/deliver` deny for topic X drops X's backlog frames.
  - *buffered-live flush* — a frame that arrived via `onLive` while `phase ===
    'draining'` and is denied during the post-drain flush.
  - *direct live* — a frame denied after the flip to `phase === 'live'` on an
    already-open stream (defect scenario 6, no reconnect).
- **Topic isolation** — on one channel, a DID denied for topic X still receives
  topic Y's frames.
- **Denied frame stays pending** — a denied frame is redelivered (and re-gated) on the
  next connect; delivers once the decision flips to allow.
- **Hook rejection tears down** — a `gate` hook that throws/rejects mid-stream calls
  `finish()` and closes the channel (fail-closed).
- **Cache TTL** — repeated same-topic frames within the TTL call the hook once; after
  the TTL a flipped decision revokes. `TTL = 0` calls the hook every frame; a
  non-finite/negative TTL falls back to `5000`.
- **Public API pass-through** — `receiveAuthCacheTTL` set on `createHub` reaches the
  handler (not only direct `createHandlers` callers).
- **No-hook deployment** — a hub created without `authorize` delivers all frames, drain
  and live, unchanged.

Test doubles/conformance: `authorize` is a `createHub` option, not part of the
hub-conformance contract (the suite has no `authorize` coverage — verified: no
`authorize`/`AuthorizeHook`/`AuthorizeRequest` refs in `packages/hub-conformance`), so
no conformance suite or double changes.

## Consumer note (Kubun)

`joinLaneAuthorize` and any other `AuthorizeHook` implementation must handle the two
new actions. Adding union variants surfaces at compile time in an exhaustive `switch`;
an implementation with a permissive default must be checked so it does not
accidentally allow `receive`/`receive/deliver` it means to deny. Track on the Kubun
side (`kubun/docs/agents/plans/backlog/2026-08-30-service-tunnel-review-followups.md`).

## Docs to update

- `CreateHubParams.authorize` doc comment (`hub.ts`) currently says "publish/subscribe
  authorization" — extend it to name the `receive`/`receive/deliver` actions.
- Any README action list enumerating the authorized actions.

## Out of scope

- **Recipient wake authorization.** The publish path notifies stored subscribers that
  lack a live channel (`handlers.ts:440`/`451`), passing `{ did, topicID, sequenceID }`
  to the dispatcher — metadata only, never a payload. This change gates *delivery*, so
  the payload guarantee holds, but a removed member's device can still be woken for a
  topic it can no longer read (learning that a sequenceID advanced). Gating that would
  mean running the same cached recipient/topic decision in the publish handler before
  `notify`. Deferred; the leak is metadata, not content. Follow-up candidate — noted so
  "the hook decides who may receive" is understood as *payload* receipt, not wake
  metadata.
- Per-frame gating for a *remote* authorize hook's throughput beyond the TTL cache
  (e.g. batching, or the invalidation-signal design). The 5s cache is the first cut;
  revisit if a remote hook lands.
- Ack-eligibility tracking (see §5) — client acks stay unrestricted.
- Imperative subscription/live-channel revocation API (defect option 2). Gating
  delivery via the hook was the preferred option.
