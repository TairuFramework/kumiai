---
'@kumiai/broadcast': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-tunnel': minor
'@kumiai/rpc': minor
---

Anycast suppression, the durable-ack relay, and peer disposal.

**Breaking.**

- `ProtocolSurface.to` returns `Promise<Client<Protocol>>`; it is now gated on peer readiness like
  `protocol()`'s other three methods.
- `@kumiai/rpc`'s hand-copied `createGroupBusServer` is deleted. `@kumiai/broadcast`'s
  `createBroadcastResponder` is the single implementation; it renames `handlers` →
  `requestHandlers` and gains an optional `@sozai/event` `EventEmitter` and a dispose-aborted
  `AbortSignal` in the handler context.
- `MailboxHubEvents` is `EventEmitter<{ status: MailboxHubEvent }>`. Use
  `hub.events.on('status', …)` in place of `hub.events.subscribe(…)`; the returned unsubscribe is
  unchanged. `HubBase.events` is `readonly`, and `MailboxHubEventListener` is removed.
- `@kumiai/broadcast`'s `subscribe` callback gains an optional second argument carrying the ack.
  `@kumiai/hub-tunnel` gains `HubReceiveOptions` and an optional `receive` scope parameter
  (additive — a double declaring fewer parameters stays assignable).

Suppression fires only on a **successful** reply. Any observed reply, errors included, previously
marked a request replied, so one fast *failing* responder suppressed every healthy one and the client
timed out. `adaptBusHandlers` now validates bus-lane input against the protocol's declared JSON
schemas — an invalid request rejects (which, per the fix, suppresses nobody) and an invalid event is
dropped and logged. Live push and app-lane drain share the same validation, and the drain drops
control-shaped payloads exactly as the live path does.

The durable-acknowledgement relay was severed at six points between a peer's ack and the hub; all
six are reconnected, and `@kumiai/hub-tunnel`'s transport now acks every frame its read pump handles,
withholding only where the transport tears down first. Two visible consequences: mailbox entries that
previously aged out unread are reclaimed, and a frame matching no listener and no sink is no longer
acked, so it is redelivered after restart rather than silently dropped.
`@kumiai/hub-conformance` gains `testAckConformance`, split into `testMailboxAckConformance` and
`testLogAckConformance` so a subject with no readable log can opt into the redelivery clause alone.
It is opt-in: the main suite deliberately excludes these clauses, since folding them in would make
them pass without asserting anything against a hub with no redelivery to gate.

A disposed `GroupPeer` now refuses everything — `dispatch`, `request`, `gather`, `to`, `commit`,
`replay`, `recover`, `resync` — with `Peer is disposed`. Each previously failed its own way: `to()`
handed back a live-looking `Client` over an aborted transport, `resync()` rebuilt an epoch onto a
disposed mux, `commit()` published to the hub from a peer that was gone, and the mirror ordering
reported `Unknown protocol` — blaming a protocol that was fine. `resync()` also now runs under the
commit mutex, so a host calling it mid-commit waits rather than running two teardown/build cycles
over one set of runtimes.
