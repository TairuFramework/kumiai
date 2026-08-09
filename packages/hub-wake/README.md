# @kumiai/hub-wake

Wake-notification storage and delivery for a kumiai hub: a push doorbell that tells a suspended device to reconnect.

Server-side, optional. See [wake notifications](../../docs/reference/wake-notifications.md) for why the package exists and what it deliberately does not do.

## Surface

- `createMemoryWakeRegistry()` — an in-memory `WakeRegistry`. Reference implementation and test double; a production host wants a durable one, checked against `testWakeRegistryConformance` from `@kumiai/hub-conformance`.
- `createWebPushSender({ vapid, ttl?, jwtLifetime?, fetch? })` — a `WakeSender` for any endpoint speaking RFC 8030 Web Push: browser push services, UnifiedPush distributors, ntfy, or a self-hosted relay. POSTs the sealed body untouched, with a VAPID (RFC 8292) `Authorization` header it signs itself.
- `createExpoSender({ accessToken?, placeholderTitle?, fetch? })` — a `WakeSender` for the Expo Push API. A plain `fetch` call against `https://exp.host/--/api/v2/push/send`; no `expo-server-sdk` dependency.

Both senders return a `WakeVerdict` (`'delivered' | 'gone' | 'retry'`) and never throw.

## Wiring

```ts
import { createMemoryWakeRegistry, createWebPushSender } from '@kumiai/hub-wake'
import { createHub } from '@kumiai/hub-server'

const wake = {
  registry: createMemoryWakeRegistry(),
  sender: createWebPushSender({
    vapid: { subject: 'mailto:ops@example.com', privateKey, publicKey },
  }),
  // debounceMs: 10_000, // default
}

const hub = createHub({ transport, store, identity, wake })
```

With `wake` omitted, `hub/v1/wake/register` and `hub/v1/wake/unregister` refuse with `WakeNotSupportedError`.

## Not in this package

- A durable `WakeRegistry` — only the in-memory one ships here.
- APNs and FCM senders — both sit behind `WakeSender` for a host that wants them without Expo in the path.
- The iOS Notification Service Extension — Swift, reached through an Expo config plugin, outside this repo.
