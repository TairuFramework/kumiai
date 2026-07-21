# @kumiai/hub-server

## 0.4.0

### Minor Changes

- Every hub procedure moved to `hub/v1/*` in lockstep with `@kumiai/hub-protocol`. A hub on a
  pre-release build cannot talk to a client on this one, and the reverse — deploy them together.

- `AuthorizeHook` takes one discriminated `AuthorizeRequest` instead of positional arguments, and
  returns `AuthorizeDecision` (`boolean | { allow, reason?, code?, retryAfterMs? }`) instead of a
  bare `boolean`. Surface only, no new enforcement: of the six actions (`publish`, `subscribe`,
  `unsubscribe`, `topic/fetch`, `keypackage/upload`, `keypackage/fetch`) only `publish` and
  `subscribe` are dispatched to the hook today, and `code`/`retryAfterMs` are accepted but not yet
  wired to a caller.

  The `AuthorizeAction` type is no longer exported — narrow on `AuthorizeRequest`, or use
  `AuthorizeRequest['action']`.

- `hub/receive` now evicts an older channel for the same DID instead of refusing the newer one. A
  client reconnects because its connection broke, and the server learns that last: refusing on a
  stale receive writer turned away precisely the reconnect that had to happen, and the refusal
  arrived on a channel promise nothing awaited. Both channels belong to one authenticated DID, so
  a client can replace its own stale lane and nothing else. The evicted channel ends rather than
  errors.

- Dropped the unused `@kumiai/mls` and `@sozai/stream` dependencies. The MLS core in a blind hub's
  dependency closure was the wrong architectural signal as well as dead weight.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.4.0

## 0.3.0

### Minor Changes

- BREAKING (lockstep with `@kumiai/hub-protocol`): the store implements the new `HubStore`
  contract — log/mailbox retention classes, stored `head`, `fetchTopic`, `trim`, and class-scoped
  trim and depth eviction (a mailbox flood can no longer evict a group's commit log). A deduped
  publish is no longer re-fanned to subscribers.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.3.0
  - @kumiai/mls@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies:
  - @kumiai/mls@0.2.0
