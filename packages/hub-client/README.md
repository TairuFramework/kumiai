# @kumiai/hub-client

A typed client for `@kumiai/hub-protocol`. Wraps an `@enkaku` `Client<HubProtocol>` so each hub
procedure is a method with named parameters instead of a `request` call and a param object.

## Exports

- `HubClient` — the wrapper. `publish`, `subscribe`, `unsubscribe`, `fetchTopic`, `receive`,
  `uploadKeyPackages`, `fetchKeyPackages`, plus `rawClient` for anything not wrapped.
- `HubClientParams`, `PublishParams`.

```ts
import { HubClient } from '@kumiai/hub-client'

const hub = new HubClient({ client })
await hub.subscribe('topic:abc', { retention: 86400 })
await hub.publish({ topicID: 'topic:abc', payload: toB64(bytes), retain: 'log' })
```

It is a wrapper and nothing more: it holds no state, opens no connection, and retries nothing. The
caller supplies a connected enkaku client, and every method returns that client's own call object —
a `RequestCall`, or a `ChannelCall` for `receive`.

## Payloads are base64 strings, and the caller encodes them

`payload` is `string` at this layer, not `Uint8Array`. The wire schema declares it
`contentEncoding: 'base64'`, and `HubClient` passes it through untouched — encoding and decoding are
the caller's (`toB64` / `fromB64` from `@sozai/codec`). Handing it raw bytes or unencoded text is a
schema failure at the server, not a conversion.

## Absent and `null` are different requests

`expectedHead` is the topic's compare-and-set. Absent means "append unconditionally"; `null` means
"only if this topic has never had an accepted log publish". Because those are genuinely different
requests, `publish` only sends the key when the caller actually set it — `'expectedHead' in params`,
not a truthiness check. A caller that spreads an options object with an undefined `expectedHead` gets
an unconditional publish, which is the intent; a caller that means the empty-topic case must pass
`null` explicitly.

A lost compare-and-set rejects with the `HeadMismatchError` wire code, which is how a caller tells it
from an unreachable hub — see `hubErrorFromCode` in `@kumiai/hub-protocol`.

## Reading a topic's log

`fetchTopic` pulls log-class frames only, and the hub gates it on the caller's **own** subscription:
the subscriber DID is the authenticated identity, never a wire field, so naming someone else does not
read their topics. Draining terminates on the `head` / `oldest` pair the result already carries —
there is no `hasMore`. A frame pushed on `receive` carries `logPosition` for the topic's log
alongside the delivery-queue `sequenceID`; advance a log cursor with the former and never the latter.
