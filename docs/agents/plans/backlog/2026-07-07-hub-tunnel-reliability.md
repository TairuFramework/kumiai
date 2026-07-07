# hub-tunnel reliability

**Priority:** backlog — but contains one **high**-severity correctness item (the dead
durable-ack contract); pull forward at next triage.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### High (correctness)

- **`packages/hub-tunnel/src/transport.ts:22,119` — durable-ack contract dead.**
  `HubReceiveSubscription` documents an `ack` contract, but the transport never calls
  `subscription.ack`, so over a durable hub every tunnel frame is redelivered on every
  reconnect until purge. The encrypted wrapper (`encrypted-transport.ts:105-112`) also
  structurally drops the `ack` member. Fix: ack processed frames in the read pump
  (forwarding through the wrapper), or delete the contract and document that durability
  belongs to the rpc mux.

### Medium (correctness)

- `packages/hub-tunnel/src/transport.ts:117` — construction-time `hub.subscribe` rejection
  swallowed entirely; a transport whose subscribe fails looks healthy but never receives.
  Fix: surface via `teardown(error)` or an observability event.
- `packages/hub-tunnel/src/transport.ts:276-288` — `frame.seq < expectedSeq` drops any
  *reordered* frame as `'dedup'` while forward gaps are accepted — neither ordering nor
  completeness. Fix: track a seen-seq window or buffer out-of-order frames up to a bound.

### Low

- `packages/hub-tunnel/src/transport.ts:255-256` — auto-session mode locks
  `lockedSessionID` to whichever sessionID arrives first, so any principal authorized to
  publish on the topic can fixate the session. Fix: document the single-writer requirement
  or bind session establishment to an authenticated sender DID. (security)
- `packages/hub-tunnel/src/encrypted-transport.ts:131-138` — the `'abort'` listener on
  `externalSignal` is never removed on dispose, leaking listener + internal controller for
  long-lived signals. Fix: remove on teardown. (correctness)

## Test hooks

No test asserts the teardown contract (`session-end` frame published, `hub.unsubscribe`
called, `onSessionEnd` firing on a peer's frame) — see `next/2026-07-07-test-gaps.md`.
