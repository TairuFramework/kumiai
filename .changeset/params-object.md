---
'@kumiai/broadcast': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-tunnel': minor
'@kumiai/mls': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/rpc-conformance': minor
---

Exported functions, constructors, methods and contract members with two or more parameters now take one flat params object, with options folded into it. `AppFrameStorageError` keeps the `Error` shape of `(message, options)`, and `precedesSequenceID` stays positional as a comparator.
