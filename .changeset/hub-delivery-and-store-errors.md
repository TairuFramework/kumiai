---
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/rpc': minor
---

Exactly-once ordered push delivery, and every store failure either coded on the wire or reported.

**Breaking.** `HubStoreErrorEvent` is a discriminated union on `method` rather than a flat
`{ method; did?; error }`. Each variant carries the subject its site has — `did` for `ack` and
`fetchLastResortKeyPackage`, `topicID` for the new `getSubscribers`, neither for `purge`. A hook
reading `event.did` unconditionally must narrow on `event.method` first.

`hub/v1/receive` now runs a two-phase delivery state machine: live pushes are buffered during the
backlog drain, then flushed deduped by `sequenceID > lastServed` before the channel goes live, so a
frame published mid-drain is neither delivered twice nor out of order. The phase flip is synchronous
with the empty-buffer check. All writes serialize through a bounded queue — over `receiveBufferLimit`
(new `CreateHandlersParams` field, `DEFAULT_RECEIVE_BUFFER_LIMIT` 256) or on a write rejection the
channel tears down and frames stay pending for redelivery. A `store.ack` failure no longer closes the
channel, and an already-aborted receive signal runs cleanup instead of leaking.

The flush dedup relies on live pushes reaching the receive callback in sequence order, which holds
because the store mints sequenceIDs monotonically and the publish fan-out keeps a fixed await-depth
between minting and delivery. A future conditional `await` there would let concurrent publishes
arrive out of order, and the dedup would silently drop the lower-sequence frame.

`createHandlers` and `createHub` take `onStoreError`, called where the hub deliberately does not fail
the request: the last-resort top-up read, an ack, the scheduled purge, and a failed subscriber read
during publish fan-out. Those swallows are correct and unchanged — failing the publish would lose the
live push permanently, since the caller's `publishID` retry dedups and skips fan-out — but they are no
longer silent. Unwired, they report through `@sozai/log` under `['kumiai', 'hub-server']`.

Store failures on `hub/v1/unsubscribe` and the key-package fetch path now cross the wire with their
hub code instead of arriving indistinguishable from a transport failure. On the spent-budget fallback
the store error deliberately does not replace the client's retryable `HUB_KEYPACKAGE_FETCH_LIMIT`; it
is attached as `cause`. `@kumiai/hub-protocol` gains `HUB_INVALID_PAYLOAD` / `InvalidPayloadError`
for a malformed base64 publish payload.
