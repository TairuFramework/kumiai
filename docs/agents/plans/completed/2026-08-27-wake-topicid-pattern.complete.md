# Constrain `topicID` so every legal value can be sealed — complete

**Status:** complete. Branch `feat/topicid-pattern`. Bounded change, no ephemeral spec/plan.
**Origin:** opened by the final review of `feat/hub-wake-notifications`
(`docs/agents/plans/completed/2026-08-10-hub-wake-notifications.complete.md`), left off that branch
deliberately because the fix reaches every topic-taking procedure.

## Goal

`sealWakeHint` seals `{ v, topicID, sequenceID, count }` into a fixed-size RFC 8291 record — fixed
because a constant ciphertext size is what stops the push provider inferring anything from the
bytes. The `topicID` schema capped only length (256 code points on the params, nothing on the
result echoes), so a JSON-escape-heavy value was schema-legal yet overflowed the record and threw
at seal time. Close the gap at the schema, not by inflating the record.

## What was built

A shared `topicIDSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }` in
`packages/hub-protocol/src/protocol.ts`, applied at all six topicID sites: the publish, subscribe,
unsubscribe and topic/fetch params, plus the topic/fetch result frame and the receive channel
frame. The now-redundant `minLength`/`maxLength` were dropped.

Tests (`packages/hub-protocol/test/protocol.test.ts`): six presence checks (one per site) plus a
behavioral check that drives the regex from the shipped schema — a real 43-char topicID passes;
human-readable and escape-heavy values, and lengths 42/44, reject. The `wake-envelope.test.ts`
ceiling assertions were kept intact; only their comments were re-framed, since they now pin the
seal record's raw byte headroom rather than a live hazard.

## Key design decisions

- **What a topicID actually is.** Every topicID is `toB64U(32 bytes)`: `@kumiai/broadcast`'s
  `deriveTopicID` (HKDF/SHA-256, `TOPIC_ID_BYTES = 32`), called by `@kumiai/rpc`'s topic helpers
  (`protocolTopic`/`inboxTopic`/`commitTopic`/`rendezvousTopic`), and `@kumiai/rpc`'s
  `discoveryTopic` via `toB64U(sha256(...))`. 32 bytes render to exactly 43 unpadded base64url
  characters, deterministically (never 44). So `^[A-Za-z0-9_-]{43}$` rejects no legitimately-minted
  topicID from any producer in the tree.
- **Exact `{43}`, not a lenient alphabet-or-length pattern.** The seal record is a fixed size, and
  this protocol seals its schemas — a future topic shape ships as a new versioned procedure, never
  a widened field. Exact length also makes min/max redundant.
- **The pattern is a contract/type-level narrowing today, not a runtime guard.** `serve()` in
  `hub-server/src/hub.ts` is called with no `validator` (enkaku's `serve` takes `validator?`
  optionally), and there is no client-side validation; the hub-conformance suites drive the store
  directly, below the RPC boundary. So nothing runs the schema against a value at runtime, and the
  seal-time throw remains the runtime backstop. This is why existing readable test/conformance
  fixtures (`'topic:conformance'`, `'topic-a'`) did not break. Notes were left at the conformance
  `TOPIC` constants: if a `validator` is ever wired into `serve()`, those fixtures must move to real
  base64url values first.

## Verification

- TDD red→green on the protocol tests. 50 hub-protocol tests + 703 hub/rpc runtime tests pass.
- Lint clean (biome). Typecheck clean across hub-protocol and all dependents; full-band
  `build:types` passed in the pre-commit hook.
- Doubles: the only topicID *schema* in the repo is this one; `HubStore` types topicID as bare
  `string` (a shape-agnostic key-value boundary, not the RPC port), so no double is more permissive
  than its port.

## Follow-up at release (finishing / releasing)

A `@kumiai/hub-protocol` minor change intent was recorded (`.changeset/topicid-pattern.md`). Per
AGENTS.md the twelve packages share one version band and a minor is a group act, so the
band-alignment step must raise all twelve together (as the `align-band-0-7` intent did for the
0.7.0 line) rather than shipping hub-protocol alone. Narrowing an existing schema is breaking for
any caller sending a value outside the new pattern, which is why this was done while the band is
still low-cost to move.
