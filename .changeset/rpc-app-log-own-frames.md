---
'@kumiai/rpc': patch
---

The app-log drain no longer opens frames the hub attributes to this member. A member reads its own retained frames back on a history pull, and MLS cannot open a message its own sender ratchet sealed, so each one was reported to the host as an open failure. They are now marked done at fetch, and the cursor passes them.
