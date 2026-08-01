---
'@kumiai/hub-client': minor
'@kumiai/mls': minor
---

Two exports removed, both unreachable in practice, taken while the 0.5 band release makes the break
cheap.

`@kumiai/mls` no longer exports the `GroupSyncScope` type. It was declared and re-exported and
referenced by nothing, here or in any consumer.

`HubClient` no longer exposes the `rawClient` getter. It existed to reach hub procedures the wrapper
did not cover, and there are none left — `HubClient` has one method per `HubProtocol` procedure. A
caller that genuinely needs the underlying `Client<HubProtocol>` already has it: `HubClientParams`
takes it in, so the getter only handed back what the caller constructed, while offering a way around
the typed surface and anything later layered onto it.
