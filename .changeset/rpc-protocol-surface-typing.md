---
"@kumiai/rpc": minor
"@kumiai/broadcast": minor
---

Type `@kumiai/rpc`'s `ProtocolSurface` against the protocol's procedure map, closing its phantom type parameter. `dispatch`/`request`/`gather` are now keyed off the concrete protocol — `dispatch` accepts event procedure names with typed `data`, `request`/`gather` accept request procedure names with typed `param` and typed `result`, and `gather` returns `Array<GatheredReply<Result>>`.

**Breaking:** the three methods now take a single enkaku-style config object instead of positional arguments — `dispatch(prc, { data })`, `request(prc, { param, ...options })`, `gather(prc, { param, ...options })`. Every call site must migrate. The `GroupPeer` and `GroupPeerParams` `Protocols` bound also tightens from `Record<string, ProtocolDefinition>` to `Record<string, GroupProtocolDefinition>`.

`@kumiai/broadcast`'s `GatheredReply` is now generic over its value type (`GatheredReply<T = unknown>`); the default keeps every existing use valid (additive, non-breaking).
