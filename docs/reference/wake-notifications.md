# Wake notifications

A push doorbell for a device whose app is suspended, so it opens a hub connection and drains what
is already waiting for it.

## What a wake is, and is not

`hub/v1/receive` is a live bidirectional channel. A member only learns of a frame while that
channel is bound; a phone with the app suspended has no channel, so it learns nothing until the
user opens the app. Fan-out is not the gap — waking the device is.

A wake is a doorbell, not a delivery path. The frame it announces is already durably queued at the
hub before the ping is sent: `publish` commits the append and its delivery rows in one transaction,
and the wake fires only for a recipient with no live channel to push to. The ping carries nothing
the device could not learn by connecting; it only says come and get it.

## Trust boundary

The hub already sees `topicID`, `senderDID`, and delivery timing for every publish. Wake adds
exactly one thing it did not have: a durable `DID → endpoint` map — a stable per-device identifier
that outlives every group the device belongs to.

The push provider (a Web Push service, Expo, and APNs/FCM behind them) learns device identity,
timing, and a fixed ciphertext size. It never learns a topic, a group, a sender, or content.
Sealing `topicID` into the hint costs nothing against the hub, which already routes on it — it only
hides the topic from everything downstream of the hub.

## The sealed hint

The hint body is sealed with **RFC 8291 `aes128gcm`**: ECDH P-256, HKDF-SHA256, AES-128-GCM. This
is not a free choice — a browser refuses a Web Push body that does not decrypt this way — so one
implementation serves web, Expo, and any later direct-APNs path, the latter two carrying the same
ciphertext base64url-encoded in a JSON field rather than as a raw Web Push body.

Once opened, the hint is:

```
{ v: 1, topicID, sequenceID, count }
```

`topicID` and `sequenceID` name the frame that triggered the ping. The device maps `topicID` to a
group alias from its own local state; that mapping never leaves the device, so the hub and the
provider never learn it.

`count` is the number of frames the dispatcher observed for this device **since its last wake
ping** — not the device's total backlog. `HubStore` exposes no pending count, and widening that
contract (and its conformance suite, and every host store) for a cosmetic number is the wrong
trade. The dispatcher owns the only counter it can honestly produce.

Plaintext is padded to a fixed record length before sealing, so ciphertext size is constant
regardless of topic length or count — a 4-character and a 256-character `topicID` seal to the same
number of bytes. Every body is 597 bytes: an 86-byte RFC 8188 header, a 495-byte padded record, and
the 16-byte GCM tag. The declared record size (`rs`) is 512, strictly greater than the 511-byte
ciphertext, as RFC 8291 §4 requires — equality is what a strict user agent refuses.

`v` is a **field inside the sealed JSON**, not a byte on the wire. That is the stronger placement:
the provider can neither read it nor tamper with it, because it only exists after the body is
decrypted. It follows the precedent of `TUNNEL_ENVELOPE_VERSION` in what it does with an unknown
value — rejected outright, never best-effort parsed — not in where it sits.

## Leading-edge debouncing

A burst of frames for the same offline device does not mean a burst of pings. The dispatcher
coalesces per DID on a **leading edge**:

1. The first frame for an offline DID pings immediately, sealed with that frame's `topicID` and
   `count: 1`.
2. Further pings are suppressed for `debounceMs` (default 10 000).
3. If more frames land inside the window, one trailing ping fires at its end, carrying the
   **latest** `topicID` and however many frames landed during the window.
4. If the DID binds a receive channel during the window, the trailing ping is cancelled — the
   device is draining already, and a ping at that point would be noise.

Leading edge rather than trailing because the timer map is in-process: a hub restart drops every
pending window. On a leading edge that loses at most a trailing summary; a trailing-only scheme
would lose the notification itself whenever a restart landed inside a window — the one outcome a
doorbell cannot afford.

Dispatch off this trigger is fire-and-forget: a slow or hanging provider must never delay fan-out
to members who are online and waiting on their live channel.

## The three verdicts

`WakeSender.send` never throws at its caller — it resolves to a verdict, and the verdict is what
decides what happens to the registration:

| Verdict | Hub action |
| --- | --- |
| `delivered` | Nothing. |
| `gone` | The registration is **deleted**. Web Push answers 404/410, Expo answers `DeviceNotRegistered` — either way the endpoint is permanently dead, and a dead endpoint retained forever is a stale identifier the hub keeps volunteering to a provider. |
| `retry` | The ping is dropped and reported through the same hook shape as `onStoreError`. There is no retry queue: the next frame re-triggers a ping on its own, and a queue would be a second delivery system with its own durability story to get right. |

## The iOS section

The Notification Service Extension that turns a sealed hint into visible text is Swift, reached
through an Expo config plugin and an EAS development build — it lives outside this repo and never
runs in Expo Go.

**The NSE must never unwrap an MLS frame.** Opening a frame consumes its per-message ratchet key —
the exact race `rpc/src/open-once.ts` exists to prevent. Two openers racing for one key is a defect
this repo has already shipped once, in the inbox lane. The NSE's job stops at the hint: it decrypts
the RFC 8291 body and maps `topicID` to a locally stored alias — "New message in Foo" — never the
message itself.

Silent push (`content-available: 1`) is throttled by Apple, and background execution is capped near
30 seconds, so "wake, connect, drain, then notify" cannot be the primary path. The visible
notification the user sees must render from the hint alone; the drain happens later, on tap or
foreground.

## Wiring

`createHub({ wake })` takes a `registry` (a `WakeRegistry`) and a `sender` (a `WakeSender`), plus
an optional `debounceMs`. Both are host choices:

- **`registry`** — durable storage for one registration per DID. `@kumiai/hub-wake` ships an
  in-memory reference implementation; a production host wants a durable one, checked against
  `testWakeRegistryConformance` from `@kumiai/hub-conformance`. Nothing unusable reaches it:
  `hub/v1/wake/register` refuses a `publicKey` that is not a 65-byte uncompressed P-256 point, or
  an `authSecret` that is not 16 bytes, with `HUB_INVALID_PAYLOAD`. Key material the hub cannot
  seal to would otherwise register happily and fail inside every send, forever, with the device
  believing it was reachable.
- **`sender`** — where the sealed body actually goes. `@kumiai/hub-wake` ships a generic
  HTTP/VAPID sender for anything speaking RFC 8030 Web Push, and an Expo sender for the Expo Push
  API. Both are plain `fetch` calls behind the `WakeSender` port; a host wanting APNs or FCM
  directly writes its own. The Web Push sender takes an optional `allowEndpoint(url)` predicate,
  **defaulting to `https:` only**. That check belongs in the sender, not at registration: the hub
  never parses an endpoint, and the sender is where provider knowledge already lives. Without it an
  authenticated DID can register any string and have the hub issue requests to it — an internal
  host, a loopback admin port — then read the outcome back through `unregisterWake()`, since only a
  `gone` verdict deletes. A rejected endpoint resolves to **`retry`**, never `gone`: a policy
  refusal is a fact about the hub's configuration, which a redeploy can reverse, whereas `gone`
  would delete the registration unrecoverably. A host running a self-hosted push service over plain
  HTTP widens the predicate; one that knows its push origins narrows it to an allowlist.

Two costs worth knowing before you wire a durable registry. Neither leaks anything; both are
operator-relevant:

- The dispatcher does a `registry.get(did)` on the **leading edge for every offline subscriber**,
  registered or not. On a busy topic that is one durable-store read per offline DID per debounce
  window, including for the DIDs that will never have a registration.
- A DID whose registration a `gone` verdict already deleted keeps **chaining windows** for as long
  as traffic flows for it: each window closes, finds a summary to send, opens a fresh one, and the
  send finds no registration and returns. The timers are cheap and `unref`'d, but they do not stop
  until the traffic does.

Both procedures also pass through `createHub`'s `authorize` hook, as
`{ action: 'wake/register', did, kind }` and `{ action: 'wake/unregister', did }`. The hook sees the
caller and the opaque sender tag and nothing else — no endpoint, no key material, since the hub does
not interpret an endpoint and a hook that saw one would be a second place it gets read. A wake
registration is the one durable cross-group per-device identifier the hub stores, so it is the
procedure a host is most likely to want a say over.

With `wake` **absent**, both `hub/v1/wake/register` and `hub/v1/wake/unregister` refuse with
`WakeNotSupportedError`. The enkaku protocol is static, so the handlers always exist on the wire —
refusing is the only honest answer, since accepting a registration the hub will never act on would
leave the device believing it is reachable when nothing will ever wake it.
