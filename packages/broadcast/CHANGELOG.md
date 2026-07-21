# @kumiai/broadcast

## 0.4.0

### Minor Changes

- Replies are attributed to the AUTHENTICATED sender, not to a name the reply asserted about
  itself. `ReplyData` loses `from`, and `GatheredReply.from` becomes `GatheredReply.senderDID`.

  The rename is the break, deliberately: keeping the name would have let every consumer compile
  while none was told the meaning moved from asserted to authenticated. `gather` keys its dedup on
  the reply identity, so a member could suppress another member's real reply by racing a forgery
  under that DID, or reach a quorum of N alone by replying N times under N names.

  `BroadcastClient` now keys `seen` on the transport-level `senderDID` and drops any reply it
  cannot attribute. `BroadcastResponderParams.from` and `GroupBusServerParams.from` survive for
  buses with no authenticated sender to offer (the memory bus), but they now feed the
  transport-level `senderDID` rather than the reply body — and on an authenticating transport what
  `unwrap` recovered REPLACES whatever the bytes claimed, including when it recovered nothing.

- Frames carry a wire version, `v: 1`, refused distinguishably when unrecognised
  (`BROADCAST_VERSION`, `encodeFrame` and `decodeFrame` are exported). Loose JSON already made
  ADDING a field safe; the discriminant buys removing and reinterpreting one, which is what taking
  `from` off the wire did.

  Wire-breaking: a peer on a pre-release build cannot read this format.

- Reserved topic labels move from `enkaku/*` to `kumiai/*`. The exported constant names are
  unchanged, so code importing them keeps compiling while the values underneath move — labels are
  hashed into topic IDs, so members that upgrade out of lockstep partition silently.

### Patch Changes

- `Unwrap` may return an `UnwrapResult` carrying the sender the open authenticated, rather than
  payload bytes alone. Group lanes bind a session to that value and never to the hub-asserted
  sender, which is what stops a lying hub forging or splicing one.
