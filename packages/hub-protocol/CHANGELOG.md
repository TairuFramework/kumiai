# @kumiai/hub-protocol

## 0.4.0

### Minor Changes

- All seven procedures move to `hub/v1/*`: `hub/publish` -> `hub/v1/publish`, and the same for
  `subscribe`, `unsubscribe`, `topic/fetch`, `receive`, `keypackage/upload` and
  `keypackage/fetch`. The first real revision of any of them is then `hub/v1/publish` rather than
  an irregular `hub/publish/v2` with an unmarked predecessor.

  Wire-breaking both ways: deploy the hub and every `@kumiai/hub-client` consumer together.
  `@kumiai/hub-tunnel` names no procedure directly and is unaffected.

- `StoredMessage.logPosition` — the place a log-class frame occupies in its topic's log, carried
  on the push as well as the pull. A delivery position and a log position are different sequences:
  a delivery position runs across all of a recipient's subscribed topics and skips its own frames.
  Without this field a live push could not advance a durable read position at all. Absent on
  mailbox frames, which have no place in any log — read the absence, not a falsy value.

## 0.3.0

### Minor Changes

- BREAKING: the `HubStore` contract gains retention classes and a stored head.

  - `PublishParams` gains `retain: 'log' | 'mailbox'` (default `mailbox`), `expectedHead` and
    `publishID`; `publish` returns `{ sequenceID, deduped }` and MUST NOT re-deliver a deduped
    publish.
  - `subscribe` takes a `SubscribeParams` object; stores must implement `fetchTopic` (serving a
    topic's log-class frames, in order, to a cursor) and `trim`.
  - `head` is stored state supporting compare-and-set, not a projection of the log; `trim` and
    depth bounds are log-class-only. The conformance suite — the contract a host implements — is
    the deliverable, now 24 clauses.
  - The `./conformance` subpath export is **removed** and the `vitest` peer dependency dropped;
    the suite now ships as the standalone `@kumiai/hub-conformance` package.
