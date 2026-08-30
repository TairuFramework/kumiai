# @kumiai/broadcast

## 0.8.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.8.0. The twelve packages move as one minor band
  (AGENTS.md); the `topicID` schema narrowing (`@kumiai/hub-protocol`) raises the band, so the
  remaining packages take a no-op minor to keep every package on the same minor. No functional change
  in these packages.

## 0.7.0

### Minor Changes

- Align the shared pre-1.0 version band to 0.7.0. The twelve packages move as one minor band (AGENTS.md); the did:kokuin (`@kumiai/mls`) and wake (`hub-*`) features raise the band, so the remaining packages take a no-op minor to keep every package on the same minor. No functional change in these packages.

## 0.6.0

### Minor Changes

- **Breaking (`@kumiai/mls`):** `GroupOptions.cache`, `GroupOptions.resolver`, the matching
  `GroupHandle` params and getters, and the exported `populateCacheFromCredential` are gone. Nothing
  in the package ever read or wrote either one, so a consumer passing a cache was getting a
  passthrough that would report a miss for a document it had been told would be there.

  `GroupMember` now carries `longForm`, the resolvable form of `id` — the leaf's long form for
  did:peer:4, `id` itself for did:key — and `GroupHandle.findMemberLongForm(id)` looks it up by
  either form. That is what a consumer needing a member's DID document should use: it reads the
  signed leaf rather than an unsigned copy beside it.

  The rest of the band takes the minor because all eleven packages share one pre-1.0 version band.

## 0.5.0

### Minor Changes

- Commit-lane replay handling, anycast suppression, the durable-ack relay, and peer disposal.

  **Breaking.**

  - `classifyCommit` takes a single `ClassifyCommitParams` object —
    `{ header, sequenceID, commitDigest, state }`. `CommitClassifierState.appliedByEpoch` is
    `ReadonlyMap<number, AppliedCommit>`. `AppliedCommit`, `ClassifyCommitParams` and
    `digestAppliedCommit` are exported.
  - `ProtocolSurface.to` returns `Promise<Client<Protocol>>`; it is now gated on peer readiness like
    `protocol()`'s other three methods.
  - `@kumiai/rpc`'s hand-copied `createGroupBusServer` is deleted. `@kumiai/broadcast`'s
    `createBroadcastResponder` is the single implementation; it renames `handlers` →
    `requestHandlers` and gains an optional `@sozai/event` `EventEmitter` and a dispose-aborted
    `AbortSignal` in the handler context.
  - `MailboxHubEvents` is `EventEmitter<{ status: MailboxHubEvent }>`. Use
    `hub.events.on('status', …)` in place of `hub.events.subscribe(…)`; the returned unsubscribe is
    unchanged. `HubBase.events` is `readonly`, and `MailboxHubEventListener` is removed.
  - `@kumiai/broadcast`'s `subscribe` callback gains an optional second argument carrying the ack.
    `@kumiai/hub-tunnel` gains `HubReceiveOptions` and an optional `receive` scope parameter
    (additive — a double declaring fewer parameters stays assignable).

  **Security — a replayed commit is no longer a fork.** The commit lane proxied "a different commit"
  with "a different sequenceID". A hub re-publishing a genuine commit frame verbatim and serving the
  copy first made every peer read the original as the losing side of a fork: a heal, a rejoin, an
  external commit, and an app-lane anchor rotation for every member, once per replay, for bytes
  already delivered. `appliedByEpoch` now records a digest of the applied commit's bytes and
  `classifyCommit` answers `history` on a match. Genuinely different commits at one epoch still fork
  and still heal, lower sequenceID winning; the change only ever produces fewer heals than before. Not
  a general defence against a hub that reorders or withholds — it removes the replay route. Both
  conformance suites gain the complementary floor, `a re-published payload under a fresh publishID
  never lands below the original`; a store failing it is not conformant.

  **Anycast suppression fires only on a successful reply.** Any observed reply, errors included,
  previously marked a request replied, so one fast *failing* responder suppressed every healthy one
  and the client timed out. `adaptBusHandlers` now validates bus-lane input against the protocol's
  declared JSON schemas — an invalid request rejects (which, per the fix, suppresses nobody) and an
  invalid event is dropped and logged. Live push and app-lane drain share the same validation.

  **The durable-acknowledgement relay is reconnected** between a peer's ack and the hub, and
  `@kumiai/hub-tunnel`'s transport now acks every frame its read pump handles, withholding only where
  the transport tears down first. Two visible consequences: mailbox entries that previously aged out
  unread are reclaimed, and a frame matching no listener and no sink is no longer acked, so it is
  redelivered after restart rather than silently dropped. `@kumiai/hub-conformance` gains opt-in
  `testAckConformance`, split into `testMailboxAckConformance` and `testLogAckConformance` so a
  subject with no readable log can take the redelivery clause alone.

  **A disposed `GroupPeer` refuses everything** — `dispatch`, `request`, `gather`, `to`, `commit`,
  `replay`, `recover`, `resync` — with `Peer is disposed`. Each previously failed its own way, `to()`
  handing back a live-looking `Client` over an aborted transport among them. `resync()` also now runs
  under the commit mutex, so a host calling it mid-commit waits rather than running two teardown/build
  cycles over one set of runtimes.

- The group moves to the 0.5 band. Every publishable package shares one meaningful version — the minor
  while pre-1.0, the major after. Trailing segments still diverge freely: a package taking a patch
  release on its own does not move anyone else.

  `@kumiai/mls-hub` publishes for the first time in this release, at the band version.

  **Breaking.** Two dead exports removed while the band break makes it cheap, both unreachable in
  practice:

  - `@kumiai/mls` no longer exports the `GroupSyncScope` type — referenced by nothing, here or in any
    consumer.
  - `HubClient` no longer exposes the `rawClient` getter. `HubClient` now has one method per
    `HubProtocol` procedure, and a caller needing the underlying `Client<HubProtocol>` already holds
    it — `HubClientParams` takes it in.

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
