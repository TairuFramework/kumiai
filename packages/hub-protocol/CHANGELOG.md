# @kumiai/hub-protocol

## 0.3.0

### Minor Changes

- 70634ac: BREAKING: the `HubStore` contract gains retention classes and a stored head.

  - `PublishParams` gains `retain: 'log' | 'mailbox'` (default `mailbox`), `expectedHead`, and `publishID`; `publish` returns `{ sequenceID, deduped }` and MUST NOT re-deliver a deduped publish.
  - `subscribe` takes a `SubscribeParams` object; stores must implement `fetchTopic` (serving a topic's log-class frames, in order, to a cursor) and `trim`.
  - `head` is stored state supporting compare-and-set, not a projection of the log; `trim` and depth bounds are log-class-only. The conformance suite — the contract a host implements — is the deliverable, now 24 clauses.
  - The `./conformance` subpath export is **removed** and the `vitest` peer dependency dropped; the suite now ships as the standalone `@kumiai/hub-conformance` package, so the protocol package carries no test-runner coupling.
