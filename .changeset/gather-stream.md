---
"@kumiai/broadcast": minor
"@kumiai/rpc": minor
---

`gather` gains `onReply` (called once per accepted, attributed reply as it arrives) and `signal`
(per-call `AbortSignal`; abort resolves with the replies collected so far, a pre-aborted signal
resolves `[]` without sending). The rpc protocol surface forwards both and aborts its wait on the
peer's initial readiness. Additive; existing callers are unaffected.
