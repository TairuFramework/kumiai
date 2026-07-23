# hub-tunnel reliability

**Priority:** backlog — ordering, error-path, and teardown hardening in `@kumiai/hub-tunnel`.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

> **The high-severity item moved out (2026-07-23).** The dead durable-ack contract was promoted to
> `../next/2026-07-23-high-severity-correctness.md`, re-verified against `5eb220a` — and the stakes
> rose: `HubPublishParams.retain`'s `'mailbox'` class (`transport.ts:52`) now defines reclamation in
> terms of acks that never happen. Everything below stays here. Line numbers below are still
> `bb343d9` and have drifted.

> **The locally-declared hub port types are not a finding (verified 2026-07-23).**
> `HubBase`/`MailboxHub`/`LogHub`/`HubReceiveSubscription`/`HubPublishParams` belong here: nothing
> in `@kumiai/hub-protocol` declares them, and `@kumiai/rpc` already imports them from this package.
> Reasoning in `2026-07-07-hub-protocol-server-cleanup.md`. One real defect came out of that check —
> `LogHub.publish` (`transport.ts:139`) is typed narrower than `HubStore.publish`, dropping
> `deduped` — and is tracked there with the wire-response gap it belongs to.

> The `urn:enkaku:` schema `$id`s (`envelope.ts:14`, `frame.ts:56`) are tracked in
> `2026-07-07-hub-protocol-server-cleanup.md`, whose scope was widened to cover them.

## Findings

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
