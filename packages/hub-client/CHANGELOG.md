# @kumiai/hub-client

## 0.4.0

### Minor Changes

- Every hub procedure moved to `hub/v1/*` in lockstep with `@kumiai/hub-protocol`. A client on a
  pre-release build cannot talk to a hub on this one, and the reverse — deploy them together.

### Patch Changes

- Export `SubscribeOptions`, `FetchTopicParams`, `FetchTopicResult` and `ReceiveOptions`. All four
  appear in `HubClient`'s public method signatures, so a consumer could not name the argument or
  result type of `subscribe`, `fetchTopic` or `receive` without reaching into `lib/`.
- Updated dependencies:
  - @kumiai/hub-protocol@0.4.0

## 0.3.0

### Minor Changes

- Add the log-class publish and fetch surface (additive): optional `retain`, `expectedHead` and
  `publishID` publish fields, a `SubscribeOptions` retention field, and the
  `FetchTopicParams`/`FetchTopicResult` types.

### Patch Changes

- Updated dependencies:
  - @kumiai/hub-protocol@0.3.0
