# Deferred API findings from the forward-compatibility audits

Four parallel API-surface audits ran over all ten packages on 2026-07-20, ahead of the
forward-compatibility work that drew from them (see
`docs/agents/plans/completed/2026-07-21-forward-compatibility.complete.md`). The audits found
roughly thirty things that cannot change after 1.0 without breaking a consumer; that work took only
the handful where deferring makes the later fix *impossible* rather than merely expensive — a
mechanism that must exist in the code shipping before the code that needs it — and explicitly left
the rest for whenever something actually needs them. The governing ruling: *do not pile up breaking
changes with every follow-up doc; address necessary changes as they are discovered.*

**Every item below will cost a breaking change when it is finally taken — every package here is
0.x, so that cost is a `minor` bump, never `major`. This was accepted deliberately, per that
ruling, and not overlooked.** None is a correctness bug; each is a shape that a filed consumer
would force a break to fix, and no consumer has filed one yet.

## From the audits

- **A third `GroupPermission`.** `packages/mls/src/roster.ts` — the role model is exactly
  `'admin' | 'member'`. Widening a value that consumers exhaustively `switch` over is the same
  break class `AuthorizeRequest` was built to avoid taking twice; no filed use needs a third role.
- **Leaf identity on `rosterDIDs`.** `GroupMLS.rosterDIDs(): Promise<Array<string>>` — bare DIDs,
  no leaf index or credential metadata. Fine while nothing needs to disambiguate two leaves for
  the same DID (a rejoin mid-fold, say); adding that later means widening the return shape.
- **A typed `ProtocolSurface`.** `packages/rpc/src/peer.ts:279` — `dispatch`/`request`/`gather`
  take `prc: string` and untyped `prm?: unknown` rather than being keyed off the protocol's own
  procedure map. A fully-typed surface is possible but a materially larger change than any single
  signature this plan touched.
- **`HubStore` headroom and its positional methods.** `packages/hub-protocol/src/types.ts:244` —
  every `HubStore` method but two takes one params object; `unsubscribe(subscriberDID, topicID)`
  and `fetchKeyPackages(ownerDID, count?)` stayed positional. Left inconsistent rather than
  reshaped now, since a store-port change here has no filed need behind it either.
- **`deduped`/`head` on the publish result.** `HubStore.publish` already returns `deduped`
  (`packages/hub-protocol/src/types.ts:88`), but `hub/v1/publish`'s wire response carries only
  `sequenceID` (`packages/hub-protocol/src/protocol.ts:30-37`). A caller cannot tell a
  deduplicated publish from a fresh one, or learn the topic's new head, without a separate
  `fetchTopic` round trip. No filed caller needs either field over the wire yet.
- **`KeyPackageLimits` renaming.** `packages/hub-server/src/handlers.ts:72` names its config
  `KeyPackageFetchLimits`, naming only the fetch side. A parallel upload-side config would want a
  sibling name; renaming now would be premature since nothing constrains uploads today.
- **Nested `HubRateLimits`.** `packages/hub-server/src/handlers.ts:62` — flat `{ perDID,
  perTopic }`. A future per-action or per-procedure limit (matching `AuthorizeRequest`'s six
  actions) has no home in the current shape. No filed need for finer-grained limits yet.
- **Hub port types moving out of `hub-tunnel`.** `packages/hub-tunnel/src/transport.ts` declares
  `HubBase`/`MailboxHub`/`LogHub`/`HubPublishParams` and friends locally rather than importing
  them from `@kumiai/hub-protocol`, so the two packages can drift independently of each other.
  Moving them is a package-boundary change, not a signature change, and out of this plan's scope.
- **The `urn:enkaku:` schema `$id`s.** `packages/hub-tunnel/src/envelope.ts:14` and
  `frame.ts:56` carry `$id: 'urn:enkaku:hub-tunnel:envelope'` / `'...:frame'`. Whether that is the
  right identifier scheme — versioned, collision-safe against other enkaku-based protocols outside
  this repo — was not settled by this plan.
- **`deriveTopicID` NUL-injectivity.** `packages/broadcast/src/topic.ts:22-30` joins `label` and
  `scope` with a NUL byte (`SEP = '\0'`) before hashing. A `label` or `scope` containing a literal
  NUL could collide with a different `(label, scope)` pair. Every caller in this repo passes a
  fixed, code-controlled label and scope, so this is unreachable today; it stays unreachable only
  as long as no caller ever derives a topic from untrusted input.
- **The dead `GroupSyncScope` export.** `packages/mls/src/types.ts:62`, re-exported from
  `packages/mls/src/index.ts:151`, referenced nowhere else in the repo. Removing an exported type
  is the same breaking-change class as everything else on this list, and costs nothing to leave in
  place until something needs the removal — so it stayed.
- **`hub-client`'s `rawClient` leak and pre-base64 `payload`.** `packages/hub-client/src/client.ts:73`
  exposes the underlying `Client<HubProtocol>` via a `rawClient` getter, letting a caller bypass
  `HubClient`'s typed surface (and any authorization or retry logic layered onto it later).
  `PublishParams.payload` is a pre-base64-encoded `string`, pushing the encoding step onto every
  caller rather than accepting raw bytes. Both are usability/encapsulation gaps, not correctness
  bugs, and neither has a filed caller pushing on it.

## Found during this plan's execution, not by the audits

These two surfaced while implementing Task 5 and Task 6 of the forward-compatibility plan itself,
after the audits ran. They belong here for the same reason: closing them later is a breaking
change, and closing them now was out of scope for the task that found them.

- **The AAD/context half of `wrap`/`unwrap`.** The plan's B2 item (`packages/rpc/src/crypto.ts`)
  called for binding rpc's sealed bytes to a topic/segment context, alongside making `senderDID`
  required — the same silent-failure shape as `exportSecret`'s label. Only the required-`senderDID`
  half shipped. Investigated and dropped: `@kumiai/mls`'s `GroupHandle.encrypt`/`decrypt`
  (`packages/mls/src/group-handle.ts:617`, `:654`) take no AAD parameter at all, so real binding
  needs a change in that package first. `packages/rpc/src/directed.ts` and `open-once.ts` also
  declare `unwrap: Unwrap` against `@kumiai/broadcast`'s crypto-agnostic type — a 2-argument
  `unwrap` is not assignable to that 1-argument type today, a structural arity mismatch that would
  need its own reshape independent of the AAD question. (An earlier version of this finding also
  argued the app lane's resync/replay drain could not determine its own context; that argument did
  not survive a second reading of `loadAppSegment`/`drainAppFrames`, which bind every frame to one
  topic before `unwrap` is ever called — the conclusion to drop the AAD half stands, that specific
  reason does not.)
- **`open-once.ts` and `directed.ts`'s residual `UnwrapResult` typing.** Task 6 closed the runtime
  hole in `packages/rpc/src/peer.ts` (`openedFrames` is typed `GroupUnwrapResult`, and a frame
  missing `senderDID` is refused before anything downstream sees it). It did not re-type
  `open-once.ts:15`'s `project: (message, opened: UnwrapResult) => ...` callback parameter or
  `directed.ts`'s matching transport glue, both still declared against `@kumiai/broadcast`'s
  optional-sender `UnwrapResult` and shared by other consumers beyond Task 6's scope. Type-safety
  debt with a runtime guard already under it, not a live gap.

## Found during the final whole-change review

- **The `0xf102` hatch opens narrower than it reads.** `@kumiai/mls` reserves and advertises the
  third control extension type, so a future control extension can be INSTALLED into a live group
  without re-admitting every member — but only empty. `packages/mls/src/policy.ts:119-125` permits
  the added entry solely when its data is a zero-length `Uint8Array`, and every later change to the
  GroupContext extension list goes through the same positional compare
  (`evaluateGroupContextExtensions`), which requires byte-identical data at every position bar the
  ledger head. So POPULATING `0xf102` — the step that actually makes it useful — is still a policy
  change every peer must ship before any peer can commit it. What the reservation buys is the
  extension TYPE surviving into existing groups' extension lists and every member's capabilities;
  it does not buy a data channel that can be opened later without a flag day. Worth stating plainly
  because the changeset's "escape hatches with a closing window" framing invites the stronger read.
- **`GroupAnchor.version` is carried but never enforced.** `packages/mls/src/anchor.ts:79` checks
  that `version` is a `number` and `:82` copies it onto the returned anchor, but nothing ever
  compares it against `CURRENT_VERSION` (`:102`, the only writer) — so an anchor written by a
  future build parses as if this build understood it, and its `app` payload is handed to the
  consumer under a version this build has never seen. Pre-existing, not touched by this branch, and
  genuinely lower-stakes than the frame formats: the anchor is written once at group creation and
  is immutable, so there is no live lane on which an old peer meets a new anchor except a join, and
  a `null` there is not obviously better than a tolerated one. Recorded because after this branch
  it is the one remaining format in the repo where a version is declared and not enforced — the
  exact shape of the commit-frame defect this review caught, in the one place still holding it.
