# @kumiai/broadcast

Generic fan-out broadcast primitives for Enkaku RPC: a topic-addressed
broadcast transport, an anycast/gather client, a responder with storm-collapse,
and opaque topic-ID derivation. No MLS, hub, or DID coupling — the consumer
supplies a `BroadcastBus`, a `wrap`/`unwrap` byte transform, and the keying
material fed to `deriveTopicID`.

## Installation

```sh
npm install @kumiai/broadcast
```

## Exports

- `deriveTopicID(secret, epoch, label, scope?)` — opaque HKDF-SHA256 topic ID.
- `createBroadcastTransport({ topicID, bus, wrap?, unwrap? })` — `TransportType` over one topic.
- `BroadcastClient` — `dispatch` (event), `request` (anycast first-wins), `gather` (collect).
- `createBroadcastResponder` + `suppressible` — the responding side with jitter/suppression.
- `defineGroupProtocol` / `GroupProtocolDefinition` — protocol scaffold types.
- `BroadcastBus` / `createMemoryBus` — the bus interface and an in-process fake.

## Gather replies

`BroadcastClient.gather(prc, param, options?)` resolves with replies collected before its quorum or
timeout. `onReply` runs once per accepted reply as it arrives, with the authenticated `senderDID`.
It receives the same object stored in the result array. Treat that object as read-only. A throwing
callback is ignored.

Pass `signal` to cancel one gather. Aborting resolves with replies collected so far. A signal that
was already aborted resolves `[]` without sending.
