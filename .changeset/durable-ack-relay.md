---
'@kumiai/rpc': minor
'@kumiai/hub-tunnel': minor
'@kumiai/broadcast': minor
'@kumiai/hub-conformance': minor
---

Reconnects the durable-acknowledgement relay, which had been severed at six separate points
between a peer's ack and the hub: the encrypting hub-tunnel wrapper dropped `ack` when it rebuilt
the receive subscription; the mux's mailbox facade, its open-once path, and its bus view each held
or forwarded an ack incorrectly; the broadcast subscribe callback had no ack parameter to forward
at all; and the hub-tunnel transport's own read pump never acked a handled frame.

`@kumiai/hub-tunnel` gains `HubReceiveOptions` and an optional `receive` scope parameter (additive:
a double declaring fewer parameters stays assignable) plus ack forwarding through the encrypting
wrapper. `@kumiai/broadcast`'s `subscribe` callback gains an optional second argument carrying the
ack. `@kumiai/hub-conformance` gains `testAckConformance`, an opt-in suite a double calls only when
it declares an `ack`, asserting the ack's presence and behaviour rather than guarding on it — the
main `testLogHubConformance` suite deliberately does not include these clauses, since folding them
in would make them pass without asserting anything on a hub with no redelivery to gate.

`@kumiai/rpc` also gates `ProtocolSurface.to` on peer readiness, alongside `protocol()`'s other
three methods. BREAKING: `ProtocolSurface.to` now returns `Promise<Client<Protocol>>`.

`@kumiai/hub-server` is unaffected — nothing under its `src/` changed.

A frame matching no listener and no sink is also no longer acked: the hub holds it to its age
bound and redelivers it on reconnect, which a host may observe as a previously-silent frame now
reappearing after restart.

`@kumiai/hub-tunnel`'s transport now acks every frame its read pump actually handles (enqueued,
filtered, deduped, undecodable, or session-end alike), withholding the ack only on the two paths
that tear the transport down before the frame is resolved. The most visible change for a
`@kumiai/hub-tunnel` consumer: mailbox entries that previously aged out unread on a durable hub are
now reclaimed as soon as this transport handles them.
