---
'@kumiai/broadcast': patch
---

`Unwrap` may return an `UnwrapResult` carrying the sender the open authenticated, rather than
payload bytes alone. Group lanes bind a session to that value and never to the hub-asserted
sender, which is what stops a lying hub forging or splicing one.
