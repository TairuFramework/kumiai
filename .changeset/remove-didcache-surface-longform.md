---
'@kumiai/broadcast': minor
'@kumiai/hub-client': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-tunnel': minor
'@kumiai/mls': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/rpc-conformance': minor
---

**Breaking (`@kumiai/mls`):** `GroupOptions.cache`, `GroupOptions.resolver`, the matching
`GroupHandle` params and getters, and the exported `populateCacheFromCredential` are gone. Nothing
in the package ever read or wrote either one, so a consumer passing a cache was getting a
passthrough that would report a miss for a document it had been told would be there.

`GroupMember` now carries `longForm`, the resolvable form of `id` — the leaf's long form for
did:peer:4, `id` itself for did:key — and `GroupHandle.findMemberLongForm(id)` looks it up by
either form. That is what a consumer needing a member's DID document should use: it reads the
signed leaf rather than an unsigned copy beside it.

The rest of the band takes the minor because all eleven packages share one pre-1.0 version band.
