---
'@kumiai/broadcast': minor
'@kumiai/rpc': minor
---

Make suppressible anycast sound, and collapse the duplicated bus responder into one.

Suppression now fires only on a **successful** reply. Previously any observed reply — errors
included — marked a request replied, so a single fast *failing* responder suppressed every healthy
one and the client timed out. Both mark-replied sites (the responder's own reply and an observed
peer reply) are now gated on `err == null`.

`@kumiai/rpc`'s hand-copied `createGroupBusServer` is deleted; `@kumiai/broadcast`'s
`createBroadcastResponder` is the single implementation. To absorb the bus server it gains an
optional `@sozai/event` `EventEmitter` for fire-and-forget event fan-out and a dispose-aborted
`AbortSignal` in the handler context, and renames `handlers` → `requestHandlers`. A malformed
control frame (a `req`/`res` shape with an invalid `rid`) is dropped rather than forwarded to event
listeners, and a handler that resolves on abort after dispose no longer registers a stray suppress
timer or writes on a tearing-down transport.

`adaptBusHandlers` now validates bus-lane input against the protocol's declared JSON schemas: an
invalid request rejects (surfacing as an error reply, which — per the suppression fix — does not
suppress healthy responders), and an invalid event is dropped and logged under `['kumiai', 'rpc']`.
The dead `ctx.signal` is now the responder's real dispose signal. Validation and adaptation are
shared by the live push and the app-lane drain (the "same door"), and the drain drops
control-shaped payloads exactly as the live path does so a frame is delivered identically on replay.
