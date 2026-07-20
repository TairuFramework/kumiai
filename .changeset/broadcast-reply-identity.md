---
'@kumiai/broadcast': minor
'@kumiai/rpc': minor
---

Broadcast replies are attributed to the AUTHENTICATED sender, not to a name the reply asserted
about itself. `ReplyData` loses `from`, and `GatheredReply.from` becomes `GatheredReply.senderDID`.

The rename is the break, deliberately. Keeping the name would have let every consumer compile
while none was told the meaning moved from asserted to authenticated, and the old meaning was
worth more than a mis-attribution: `gather` keys its dedup on the reply identity, so a member
could suppress another member's real reply by racing a forgery under that DID, or reach a quorum
of N alone by replying N times under N names. A quorum that counts forgeries is not a quorum.

`BroadcastClient` now keys `seen` on the transport-level `senderDID` and drops any reply it
cannot attribute. `BroadcastResponderParams.from` and `GroupBusServerParams.from` survive for
buses that have no authenticated sender to offer (the memory bus), but they now feed the
transport-level `senderDID` rather than the reply body — one field on both paths, and on an
authenticating transport what `unwrap` recovered REPLACES whatever the bytes claimed, including
when it recovered nothing.

Broadcast frames carry a wire version, `v: 1`, refused distinguishably when unrecognised
(`BROADCAST_VERSION`, `encodeFrame` and `decodeFrame` are exported). Loose JSON already made
ADDING a field safe; what the discriminant buys is removing and reinterpreting one, which is
exactly what taking `from` off the wire did.
