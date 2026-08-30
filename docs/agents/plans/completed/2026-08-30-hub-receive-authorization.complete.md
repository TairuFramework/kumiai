# Hub `receive` authorization — complete

**Status:** complete
**Component:** `@kumiai/hub-server`
**Branch:** `feat/hub-receive-authorization`
**Origin:** defect surfaced by Kubun's join-lane authorizer review (2026-08-30) — `hub/v1/receive`
delivery bypassed the `authorize` hook, so a DID removed from a group kept draining that topic's
backlog and live deliveries; the hook could never revoke it because it was never consulted for
receive.

## Goal

Make the `authorize` hook's contract complete for receive: the hook decides who may receive a
*payload*, including after a membership change, without the caller tracking and revoking
subscriptions out of band.

## What was built

- **Two new `AuthorizeRequest` variants:** `{ action: 'receive'; did }` (coarse, at channel open)
  and `{ action: 'receive/deliver'; did; topicID }` (per frame, by topic).
- **Coarse connect gate:** consulted once at the top of the `hub/v1/receive` handler, before any
  channel state is registered; deny rejects with `authorizationDenied`, mirroring the subscribe
  handler. Uncached, immediate.
- **Per-frame per-topic gate:** folded into the single serialized write site (`pushWrite`), so it
  covers all three delivery paths — backlog drain, buffered-live flush, and direct live delivery —
  with no frame reaching the socket ungated. This is what revokes a removed member mid-stream,
  including on a receive stream opened *before* removal (no reconnect needed).
- **Configurable decision cache:** per-channel `Map` keyed by `(did, topicID)`, TTL via
  `receiveAuthCacheTTL` on both `CreateHandlersParams` and the public `CreateHubParams` (forwarded
  through `createHub`). Default 5000 ms; `0` disables reuse (hook per frame); non-finite or negative
  (including `Infinity`) falls back to the default — `Infinity` never becomes a permanent allow.

## Key design decisions (rationale preserved)

- **Per-frame, per-topic is the real fix, not a connect-time DID gate.** The receive channel is
  per-DID and topic-agnostic, but each frame carries a `topicID`. A removed-from-X-but-still-in-Y
  DID must lose X and keep Y, which only a per-topic check on delivery can express.
- **Gate lives inside `pushWrite`'s `try { … } finally { pending-- }`, before the write.** A denied
  frame's early `return` still releases its `pending` slot via `finally`; placing the gate before
  the `try` would leak a slot per denial and eventually trip the buffer cap, wrongly tearing down a
  healthy channel. `lastServed` advances only after a successful write, so a denied frame never
  raises it and the post-drain `> lastServed` flush dedup stays correct (a denied high-seq frame
  cannot strand a later allowed lower-seq frame).
- **Deny vs. throw are distinct.** A hook returning `false` skips only that frame and leaves the
  channel operational (other topics keep flowing). A hook that *throws* reaches the existing
  `catch → finish()` and tears the channel down — fail closed: a hook that cannot render a decision
  must not deliver.
- **Deny semantics = skip and leave pending.** A denied frame is never written and never auto-acked
  by the server, so it stays pending and redelivers on the recipient's next connect (re-gated);
  once re-authorized it delivers. The security guarantee is *no payload reaches a denied recipient* —
  not that a frame can never leave the store. Client acks remain unrestricted by design (harmless:
  acking only discards the client's own undelivered mail; no denied payload is served by it), so no
  ack-eligibility tracking was added.
- **TTL is a reuse window measured from decision-store time, excluding hook latency.** Both allow
  and deny decisions are cached, so re-grant is bounded by the TTL (not immediate) and an
  in-session-denied frame redelivers on next connect. `expiresAt` is computed from the clock read
  *after* the hook resolves, so a slow hook does not shorten the effective window.
- **No hub-conformance / test-double change.** `authorize` is a `createHub`/`createHandlers`
  option, not part of the hub-conformance contract, so the contract suites and doubles were
  untouched.

## Verification

- 223 hub-server tests pass; typecheck and lint clean. Tests cover: connect-gate deny (no state
  registered), per-frame deny on all three delivery paths, topic isolation on one channel,
  fail-closed teardown on hook throw, TTL reuse / `0`-disables / `Infinity`-defaults, public-API
  pass-through, and a regression test pinning "`lastServed` not advanced on deny" (a denied high-seq
  frame must not strand a later allowed lower-seq frame).
- Reviewed by staged task reviews, a whole-branch review, and an independent Codex source-grounded
  pass. The Codex pass confirmed all invariants and caught one spec-conformance miss (TTL was
  counting hook latency against the reuse window), which was fixed.

## Follow-on

Recipient wake authorization is deliberately out of scope — see
`docs/agents/plans/backlog/2026-08-30-hub-recipient-wake-authorization.md`.
