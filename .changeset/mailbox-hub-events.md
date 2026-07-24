---
'@kumiai/hub-tunnel': minor
---

Expose `MailboxHub` connection events through a `@sozai/event` `EventEmitter`.

`MailboxHubEvents` is now `EventEmitter<{ status: MailboxHubEvent }>` rather than a hand-rolled
`{ subscribe(listener) }` registry, exposed on a hub through a read-only `get events()` accessor over
a private field. Subscribe with `hub.events.on('status', (event) => …)` in place of
`hub.events.subscribe(…)`; the returned unsubscribe function is unchanged. `HubBase.events` is now
`readonly`, and the removed `MailboxHubEventListener` type no longer needs importing. The encrypting
wrapper forwards the emitter unchanged.
