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
- **The pattern is runtime-enforced at the hub server boundary.** enkaku's `serve` auto-derives a
  validator from the `protocol` it is given — `createValidator(createClientMessageSchema(protocol))`
  (`@enkaku/server` `server.ts`) — and `hub-server/src/hub.ts` passes `protocol: hubProtocol`, so
  every inbound client message is validated against the schema. A topicID outside the pattern is
  rejected with enkaku error `EK08` ("Invalid protocol message") before any handler runs; the
  seal-time throw is a second, deeper backstop. (An early read of `hub.ts` alone suggested "no
  validator wired" because none is passed *explicitly*; the auto-derivation from `protocol` was
  missed, and a stale `lib/` build let a scoped test run pass before `--force` rebuilt it. The final
  full `turbo … --force` caught it.) Consequence: production callers are unaffected (they mint
  43-char base64url topics), but hub-server and hub-client test fixtures that published fake topics
  (`'topic:1'`, `'topic-a'`, `'topic:chat'`) through the client/server had to move to schema-valid
  43-char values, via a small `fixtureTopic(label)` helper. The hub-conformance suites were the
  exception and kept their readable topicIDs: they exercise the store directly, never crossing the
  enkaku client/server boundary, so the validator never sees them — a note at each `TOPIC` constant
  records that.

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
