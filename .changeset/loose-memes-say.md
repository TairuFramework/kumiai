---
"@kumiai/broadcast": minor
"@kumiai/rpc": minor
---

Broadcast control frames now ride a dedicated `typ:'ctrl'` wire discriminator (`BROADCAST_VERSION` 2), freeing `data.kind` for application use. Previously, control replies/requests shared `typ:'event'` with app data and were distinguished only by an app-controlled `data.kind` field, so an application event whose own data happened to carry a colliding `kind` (e.g. `kind:'req'`) could be misclassified as protocol control traffic. Responder and client classifiers now key on `payload.typ`; `data.kind` is read only under `typ==='ctrl'` and is never inspected for app events.

**Breaking:** frames encoded under `BROADCAST_VERSION` 1 are no longer decodable — `decodeFrame` refuses a stale wire version. The RPC app-lane drain's interim control-shape fallback (dropping replayed frames that merely looked like a control reply/request) is removed; drained frames are classified the same way live frames are, by `typ`, not by shape-sniffing `data`.
