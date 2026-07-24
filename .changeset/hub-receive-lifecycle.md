---
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
---

Fix the hub `receive`/`publish` lifecycle so the push lane delivers each frame exactly once, in
order, with bounded memory and typed errors.

`hub/v1/receive` now runs a two-phase delivery state machine: live pushes are buffered during the
backlog drain, then flushed deduped by `sequenceID > lastServed` before the channel goes live — so a
frame published mid-drain is no longer delivered twice or out of order. The phase flip to live is
synchronous with the empty-buffer check, closing a window where a frame published during the flush
write would be stranded. All writes serialize through a bounded queue: over `receiveBufferLimit`
(new `CreateHandlersParams` field, default `DEFAULT_RECEIVE_BUFFER_LIMIT = 256`, enforced in both the
live and draining phases) or on a write rejection, the channel tears down and frames stay pending in
the store for redelivery on reconnect. The ack loop no longer treats a `store.ack` failure as a
channel close, and an already-aborted receive signal now runs cleanup instead of leaking.

`@kumiai/hub-protocol` gains `HUB_INVALID_PAYLOAD` / `InvalidPayloadError` (with round-trip): a
publish carrying a malformed base64 payload is now refused with that typed code instead of a raw
decode error.

Soundness note for implementers: the `> lastServed` flush dedup relies on live pushes reaching the
receive callback in sequence order, which holds because the store mints sequenceIDs monotonically and
the publish fan-out keeps a fixed await-depth between minting and delivery. A future change that
inserts a conditional `await` there could make concurrent publishes arrive out of order, and the
dedup would then silently drop a lower-sequence frame.
