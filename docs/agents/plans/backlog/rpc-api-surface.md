# rpc API surface — typing debt on the public surface

**Priority:** backlog — type-safety debt on `@kumiai/rpc`'s public surface. No correctness bug;
each item is a shape a filed consumer would force a break to fix, and none has one yet.
**Origin:** the four API-surface audits of 2026-07-20, deferred by
`../completed/2026-07-21-forward-compatibility.complete.md` and folded here at the 2026-07-23
triage from `next/2026-07-20-deferred-api-findings.md`.

Split out from `2026-07-07-rpc-peer-lifecycle-hardening.md` rather than appended to it: that doc is
about lifecycle and concurrency correctness, these are static-typing gaps on the exported surface.
Different work, different reviewers, different PR.

Both items are **breaking** — see `../milestones/pre-1.0-breaking-api.md` for why the 0.x window is
the deadline. Line numbers are as of `5eb220a`.

## Findings

- **`ProtocolSurface` ignores its own type parameter.** `packages/rpc/src/peer.ts:254-258` declares
  `ProtocolSurface<Protocol extends ProtocolDefinition>`, but every member is untyped against it:
  `dispatch(prc: string, data?: Record<string, unknown>)`, `request(prc: string, prm?: unknown)`,
  `gather(prc: string, prm?: unknown)` — returning `Promise<unknown>` and
  `Promise<Array<GatheredReply>>`. `Protocol` is phantom. A caller gets no completion on procedure
  names, no parameter checking, and no result type, even though `peer.protocol(name)` (`:262`) has
  the protocol definition in hand at the call site.

  Keying the surface off the protocol's own procedure map is possible — enkaku's client does it —
  but it is a materially larger change than any single signature the forward-compatibility plan
  took, and it breaks every existing call site's inferred types at once. Worth doing before 1.0
  precisely because it cannot be done cheaply after.

- **`open-once` and `directed` still type against the optional-sender `UnwrapResult`.** Task 6 of
  the forward-compatibility plan closed the *runtime* hole in `packages/rpc/src/peer.ts` —
  `openedFrames` is typed `GroupUnwrapResult`, and a frame missing `senderDID` is refused before
  anything downstream sees it. It did not re-type `packages/rpc/src/open-once.ts:15`'s
  `project: (message: StoredMessage, opened: UnwrapResult) => Opened | undefined` callback
  parameter, nor `packages/rpc/src/directed.ts:35`'s matching `unwrap: Unwrap` transport glue. Both
  still declare against `@kumiai/broadcast`'s `UnwrapResult`, whose `senderDID` is optional, and
  both are shared by consumers beyond Task 6's scope.

  Type-safety debt with a runtime guard already under it, not a live gap — which is exactly why it
  was left. The fix is to narrow these to the group-authenticated result type, which breaks any
  consumer supplying a crypto-agnostic `unwrap`.

- **`GroupMLS.rosterDIDs` carries no leaf identity.** `packages/rpc/src/crypto.ts:240` —
  `rosterDIDs(): Promise<Array<string>>`, documented at `:228` as "one entry per leaf". So a DID
  holding two leaves appears twice, but nothing says *which* leaf each entry is: no leaf index, no
  credential metadata. Fine while nothing needs to disambiguate two leaves for the same DID (a
  rejoin mid-fold, say); adding that later widens the return shape.

  **Refiled here 2026-07-23.** The original finding placed this on `@kumiai/mls` as
  "`GroupMLS.rosterDIDs`", but `@kumiai/mls` has no such method — `GroupMLS` is `@kumiai/rpc`'s
  consumer port. That makes the blast radius wider than the original wording implies: changing it
  breaks the port (`rpc/src/crypto.ts:226`, exported at `rpc/src/index.ts:40`), its real
  implementation (`packages/mls-rpc/src/mls.ts:130`), and the contract suite every implementation
  *and* every double must pass (`packages/rpc-conformance/src/group-mls.ts:47`, exercised at
  `:313`). Three packages, not one.

## Related, blocked elsewhere

- **The AAD/context half of `wrap`/`unwrap`** (`packages/rpc/src/crypto.ts`) — binding rpc's sealed
  bytes to a topic/segment context, the same silent-failure shape as `exportSecret`'s label. Only
  the required-`senderDID` half shipped. Investigated and dropped for two independent reasons:
  `@kumiai/mls`'s `GroupHandle.encrypt`/`decrypt` (`packages/mls/src/group-handle.ts:617,654`) take
  no AAD parameter at all, so real binding needs a change *in that package first* (tracked in
  `2026-07-07-mls-api-hardening.md`); and a 2-argument `unwrap` is not assignable to
  `@kumiai/broadcast`'s 1-argument `Unwrap` type, a structural arity mismatch needing its own
  reshape independent of the AAD question.

  An earlier version of this finding also argued the app lane's resync/replay drain could not
  determine its own context. That argument did not survive a second reading of `app-lane.ts`'s
  `loadSegment`/`drain`, which bind every frame to one topic before `unwrap` is ever called. The
  conclusion to drop the AAD half stands; that specific reason does not.

## Test hooks

None — both findings are compile-time only. A type-level test (`expectTypeOf` or equivalent)
asserting that an unknown procedure name fails to compile would be the regression guard for the
first item.
