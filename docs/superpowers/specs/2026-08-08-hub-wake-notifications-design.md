# Hub wake notifications

Waking a device whose app is dead or OS-throttled, so it opens a hub connection — without telling
the push provider anything about the group.

## Problem

`hub/v1/receive` is a live bidirectional channel. A member only learns of a frame while that channel
is bound. A phone with the app suspended has no channel, so it learns nothing until the user opens
the app. Fan-out is not the gap; waking the device is.

This is a last-hop doorbell, not a second delivery system. The hub's mailbox already queues the
frame durably for an offline subscriber; the wake only tells the device to come and get it.

## Non-goals

- Replacing any part of hub delivery. Nothing about `publish`, `receive`, the mailbox/log split, or
  retention changes.
- Carrying message content. The wake never contains anything the device could not learn by
  connecting.
- Native iOS/Android code. The Notification Service Extension and the RN push glue live outside this
  repo (see [iOS constraints](#ios-constraints)).

## Trust boundary

The hub already sees `topicID`, `senderDID`, and delivery timing. Wake adds exactly one thing it did
not have: a durable `DID → endpoint` map — a stable device identifier that outlives any group the
device belongs to.

The push provider (a Web Push service, Expo, and APNs/FCM behind them) learns device identity,
timing, and a fixed ciphertext size. It never learns a topic, a group, a sender, or content.

Sealing `topicID` to the device costs nothing against the hub, which routes on it already. It only
hides the topic from the provider.

## Platform shape

Targets are React Native / Expo, plus a web target. One endpoint **per device**, not per group —
the platforms force it:

| Platform | Why per-device |
| --- | --- |
| iOS | One APNs device token per app installation. Per-group tokens do not exist. |
| Web Push | One subscription per service-worker registration, i.e. per origin per browser profile. |
| Android | Per-registration endpoints are possible via UnifiedPush, but then the distributor counts the user's groups and watches each one's rhythm — the exact linkage this design denies it. |

Per-device DIDs make registration 1:1. A future user-DID-plus-device-DIDs mapping is the host's
concern; the hub stays blind to it and this design does not anticipate it.

## Components

| Where | What |
| --- | --- |
| `hub-protocol` | `hub/v1/wake/register` and `hub/v1/wake/unregister`; the `WakeRegistry` and `WakeSender` types; `wake-envelope.ts` (seal/unseal, version field). No vendor dependencies. |
| `hub-server` | Optional `wake: { registry, sender, debounceMs }` on `createHub`; the two handlers; the debounce dispatcher. |
| `hub-client` | `registerWake()`, `unregisterWake()`, `unsealWakeHint()`. |
| `hub-wake` (new) | In-memory `WakeRegistry`; the generic HTTP/VAPID sender; the Expo sender. Server-side, optional. |
| `hub-conformance` | `WakeRegistry` contract cases. |

`hub-wake` is the twelfth package in the shared version band.

**Expo isolation.** The Expo Push API is a plain `POST https://exp.host/--/api/v2/push/send` with a
JSON body. The sender is a `fetch` call behind the `WakeSender` port, in its own subpath export. No
`expo-server-sdk`, no vendor dependency in any package.

## Seal

**RFC 8291 `aes128gcm`** — ECDH P-256, HKDF, AES-128-GCM. Not a free choice: a browser refuses a Web
Push body that does not decrypt this way. One implementation therefore serves web, Expo, and any
later direct-APNs path, the latter two carrying the same ciphertext base64-encoded in a data field.

Plaintext is padded to a fixed record length, so ciphertext size is constant regardless of topic
length or pending count.

```
hint = { v: 1, topicID, sequenceID, count }
```

`count` is the number of frames the dispatcher has observed for this device **since its last wake
ping** — not the device's total backlog. `HubStore` exposes no pending count, and widening that
contract (and its conformance suite, and every host store) for a cosmetic number is the wrong
trade. The dispatcher owns the counter it can honestly produce.

The device maps `topicID → group alias` from its own local state. That mapping never leaves the
device.

The version field follows the precedent of `TUNNEL_ENVELOPE_VERSION`: an unknown version is rejected,
never best-effort parsed.

## Wire surface

```
hub/v1/wake/register   { kind, endpoint, publicKey, authSecret, expiresAt? } -> { registered: true }
hub/v1/wake/unregister { }                                                   -> { unregistered: boolean }
```

- `kind` is an opaque tag (`"webpush"`, `"expo"`, …) that the **sender** switches on. The hub never
  interprets it.
- `endpoint` is an opaque string. The hub never parses it, and must not: a hub that understood
  endpoint URLs would grow provider-specific behaviour it has no business having.
- `publicKey` and `authSecret` are the device's RFC 8291 keys. The private half never leaves the
  device.
- `expiresAt` is optional, in seconds, mirroring Web Push `expirationTime`.

New procedures rather than widened ones, per the rule stated at the top of `protocol.ts`.

With `wake` absent from `createHub`, both handlers throw `WakeNotSupportedError`. The enkaku
protocol is static so the handlers always exist; refusing is the only honest answer, since accepting
a registration the hub will never act on leaves the device believing it is reachable.

## Trigger

The hook point is the existing fan-out loop in `packages/hub-server/src/handlers.ts`, which already
walks `getSubscribers` and tests `client?.sendMessage != null`. The `else` of that test is the wake.

**Both retention classes trigger**, not only `mailbox`. A commit-lane frame is `log`, and a
membership change is precisely what a sleeping device must learn.

**Leading-edge debounce:**

1. First frame for an offline DID: ping immediately, sealed with that frame's `topicID` and
   `count: 1`.
2. Suppress further pings for `debounceMs` (default 10 000).
3. At the end of the window, if more frames landed, send one trailing ping carrying the **latest**
   `topicID` and how many landed during the window.
4. If the DID binds a receive writer during the window, cancel the trailing ping — the device is
   draining, and a ping would be noise.

Leading edge rather than trailing because the timer map is in-process. A hub restart drops pending
windows; with leading edge that loses at most a trailing summary, whereas trailing-only would lose
the notification itself whenever a restart landed inside a window.

Dispatch is fire-and-forget off the publish path. A slow or hanging provider must never delay
fan-out to online members.

## Failure handling

`WakeSender` returns a verdict and does not throw at the caller:

| Verdict | Hub action |
| --- | --- |
| `delivered` | Nothing. |
| `gone` | **Delete the registration.** Web Push 404/410, Expo `DeviceNotRegistered`. A dead endpoint retained forever is a stale identifier the hub keeps volunteering to a provider. |
| `retry` | Report through the `onStoreError`-shaped hook and drop the ping. No retry queue: the next frame re-triggers, and a queue would be a second delivery system with its own durability story. |

## Registration lifecycle

One registration per DID. Re-register replaces; unregister and `gone` delete. A registry MUST NOT
serve an entry past its `expiresAt` — the same rule key packages already follow, for the same
reason: expired entries that still answer are entries that fail silently.

Rotation is a re-register with a fresh keypair.

## iOS constraints

None of these block the design; they constrain what the hint may contain and push work outside this
repo.

- Decrypting the hint before display needs a Notification Service Extension in Swift, reached by an
  Expo config plugin and an EAS development build. It never works in Expo Go. The decryption key
  lives in the Keychain behind a shared App Group so app and extension both reach it.
- **The NSE must never unwrap an MLS frame.** Opening a frame consumes its per-message ratchet key —
  the race `rpc/src/open-once.ts` exists to prevent. Notification text comes from the hint's
  `topicID` mapped to a locally stored alias: "New message in Foo", never the message.
- Silent push (`content-available: 1`) is throttled by Apple and background execution is capped near
  30 seconds, so "wake, connect, drain, then notify" cannot be the primary path. The visible
  notification must render from the hint alone.
- iOS suspends the app, so the `hub/v1/receive` channel reopens only on tap or foreground.
- ntfy and UnifiedPush are unreachable from the Expo managed workflow, which needs a native
  distributor module. On Expo, Android goes through FCM. ntfy remains usable as a self-hosted Web
  Push or generic relay for the web target, or if a UnifiedPush Android variant ships later.
- Web Push on iOS requires the user to Add to Home Screen (Safari 16.4+) before a subscription
  exists.

## Testing

- **`hub-conformance`** — the `WakeRegistry` contract: replace on re-register, delete, expired
  entries not served, one registration per DID. Runs against the memory backend **and** every
  double, per the repo rule that a double must be stricter than its port, never more permissive.
- **`hub-protocol`** — the RFC 8291 §5 published test vector reproduced byte for byte; seal
  round-trip; ciphertext length identical for a 4-character and a 256-character `topicID`, and for
  `count` 1 versus 9 999; wrong key fails; unknown version rejected.
- **`hub-server`** — no ping while online; ping when offline; leading edge is immediate; a burst
  coalesces to one trailing ping; a reconnect cancels the trailing ping; `gone` deletes the
  registration; `wake` absent yields `WakeNotSupportedError`; a hanging sender does not delay
  fan-out to online members.
- **`hub-wake`** — VAPID header shape; status-to-verdict mapping for both senders.
- **`tests/e2e-expo`** — the existing Expo + Maestro harness is where a device-level check belongs:
  register from the app, publish from a second peer, assert the notification appears. Bounded by
  what simulators do — `xcrun simctl push` injects a payload but does not exercise APNs delivery,
  and the Android emulator needs Play Services for FCM. Real end-to-end delivery stays a manual
  check on hardware.

## Stated residuals

- The provider learns device identity, timing, and a constant ciphertext size. Self-hosting the push
  service collapses that to the hub operator, who already saw the timing. Expo and Apple cannot be
  collapsed away.
- The `DID → endpoint` map is new linkability at the hub, outliving every group the device belongs
  to.
- A hub restart drops pending debounce windows, losing a trailing summary.
- On iOS the notification renders from the hint alone; the drain happens on tap or foreground.
- The Notification Service Extension is Swift and lives outside this repo, reached through an Expo
  config plugin. `tests/e2e-expo` can drive the app around it, but the extension's own decrypt path
  is only exercised on hardware.
