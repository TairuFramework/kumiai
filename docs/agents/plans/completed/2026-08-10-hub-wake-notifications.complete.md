# Hub wake notifications

**Status:** complete
**Date:** 2026-08-10
**Branch:** `feat/hub-wake-notifications` (PR #32)

## What this was

`hub/v1/receive` is a live bidirectional channel: a member learns of a frame only while that channel
is bound. A phone with the app suspended has no channel, so it learns nothing until the user opens
the app. Fan-out was never the gap — waking the device was.

This adds a last-hop doorbell, not a second delivery system. The mailbox already queues the frame
durably for an offline subscriber; the wake only says come and get it. Nothing about `publish`,
`receive`, the mailbox/log split, or retention changed.

`@kumiai/hub-wake` is the twelfth package in the shared version band.

## The trust boundary, which is the whole design

The hub already saw `topicID`, `senderDID`, and delivery timing. Wake adds exactly one thing it did
not have: a durable `DID → endpoint` map — a stable device identifier outliving every group the
device belongs to. That is the headline residual, and it is written into
`docs/agents/architecture.md` rather than left implicit.

The push provider learns device identity, timing, and a constant ciphertext size. It never learns a
topic, a group, a sender, or content. Sealing `topicID` to the device costs nothing against the hub,
which routes on it already — it hides the topic from the provider.

## Key design decisions

**RFC 8291 `aes128gcm` was not a free choice.** A browser refuses a Web Push body that does not
decrypt this way, so one implementation serves web, Expo, and any later direct-APNs path, the latter
two carrying the same ciphertext base64-encoded in a data field. Plaintext pads to a fixed record
length, so ciphertext size is constant regardless of topic length or pending count.

**`count` is frames since the last ping, not the device's backlog.** `HubStore` exposes no pending
count, and widening that contract — plus its conformance suite, plus every host store — for a
cosmetic number was the wrong trade. The dispatcher owns the counter it can honestly produce.

**One registration per device, not per group.** iOS has one APNs token per installation and Web Push
one subscription per service-worker registration; per-registration endpoints exist on Android via
UnifiedPush, but then the distributor counts the user's groups and watches each one's rhythm — the
exact linkage this design denies it.

**The hub never parses `endpoint`.** It is an opaque string, and `kind` is an opaque tag the *sender*
switches on. A hub that understood endpoint URLs would grow provider-specific behaviour it has no
business having. This is why the endpoint-policy check landed as an `allowEndpoint` predicate on the
Web Push sender rather than as validation at registration.

**Leading-edge debounce (default 10 000 ms), because the timer map is in-process.** A hub restart
drops pending windows; with a leading edge that loses at most a trailing summary, whereas
trailing-only would lose the notification itself whenever a restart landed inside a window. A DID
that binds a receive writer mid-window cancels the trailing ping — the device is draining and a ping
would be noise. Dispatch is fire-and-forget: a hanging provider must never delay fan-out to online
members.

**Both retention classes trigger, not only `mailbox`.** A commit-lane frame is `log`, and a
membership change is precisely what a sleeping device must learn.

**`retry` has no retry queue.** The next frame re-triggers; a queue would be a second delivery
system with its own durability story. `gone` deletes the registration outright — a dead endpoint
retained forever is a stale identifier the hub keeps volunteering to a provider.

**Refusing beats accepting.** With `wake` absent from `createHub`, both procedures throw
`WakeNotSupportedError`. The enkaku protocol is static so the handlers always exist, and accepting a
registration the hub will never act on leaves the device believing it is reachable.

**The `authorize` hook gained `wake/register` and `wake/unregister` variants** (with `expiresAt`, so
a host can cap registration lifetime). `AuthorizeRequest` is a union hosts switch on exhaustively, so
adding these after the band ships would break them — this was the last cheap moment.

## What was built

- `hub-protocol` — the `WakeRegistry` / `WakeSender` ports, `sealWakeHint` / `openWakeHint`, key
  material validation, the two procedures, and the `HUB_WAKE_NOT_SUPPORTED` refusal.
- `hub-server` — the debouncing dispatcher, both handlers gated through `authorize`, and the fan-out
  hook in the `else` of the online-client test.
- `hub-wake` (new) — in-memory registry, Web Push/VAPID sender, Expo sender. No vendor SDK
  dependency in any package; the Expo sender is a plain `fetch`.
- `hub-client` — `createWakeKeys()`, `registerWake()`, `unregisterWake()`, re-exported `openWakeHint`.
- `hub-conformance` — `testWakeRegistryConformance`, which every host registry must pass.

A hub built without a `wake` param behaves exactly as before.

## Verification

RFC 8291 §5's published vector is a test, so the derivation is pinned independently of this
implementation rather than only agreeing with itself. Full suite green uncached, 48/48 turbo tasks.

Two independent whole-branch reviews plus per-task gates, with mutation evidence required
throughout — every guard broken, shown to fail, restored. Across the branch that method caught
roughly seventeen tests that asserted nothing; the last two review passes caught 32 of 32 mutations
and the final pass returned zero findings.

## Residuals

- The provider learns device identity, timing, and a constant ciphertext size. Self-hosting the push
  service collapses that to the hub operator, who already saw the timing. Expo and Apple cannot be
  collapsed away.
- The `DID → endpoint` map is new linkability at the hub, outliving every group.
- A hub restart drops pending debounce windows, losing a trailing summary.
- `allowEndpoint`'s default is a **scheme** floor, not an origin defence: `https://10.0.0.5/` is
  still fetched, so a host on a network with internal HTTPS services must narrow it. Recorded in the
  architecture residuals and the `hub-wake` README.
- Under `retry`, a permanently-rejected endpoint is never cleaned up — its registry entry is retained
  and each debounce window emits one `onStoreError`.
- On iOS the notification renders from the hint alone; the drain happens on tap or foreground.

## Follow-on work

- `docs/agents/plans/next/2026-08-10-wake-topicid-pattern.md` — the protocol's `topicID` has no
  `pattern`, so an escape-heavy 256-character value is schema-legal and too large to seal.
- `docs/agents/plans/backlog/2026-08-10-wake-residuals.md` — the platform pieces deliberately left
  out (iOS NSE, durable registry, APNs/FCM senders, device-level e2e) and the deferred minors.

## Release note

`@kumiai/hub-wake` has never been published, so its manifest version is authoritative and the
recorded minor intent will not move it. It needs the first-publish fixup — manual manifest bump plus
a `CHANGELOG.md` header — per the `kigu:releasing` skill.
