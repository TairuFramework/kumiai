# Constrain `topicID` so every legal value can be sealed

Opened by the final review of `feat/hub-wake-notifications` (see
`docs/agents/plans/completed/2026-08-10-hub-wake-notifications.complete.md`). Left off that branch
deliberately: the fix reaches every topic-taking procedure, so it wants its own change.

## The gap

`sealWakeHint` seals `{ v, topicID, sequenceID, count }` into a fixed-size RFC 8291 record — fixed
because a constant ciphertext size is what stops the push provider inferring anything from the
bytes. The protocol caps `topicID` at 256 **code points** and constrains nothing else, so a value
made of JSON-escaping characters is schema-legal and overflows the record.

Measured ceilings, all pinned as executable assertions in
`packages/hub-protocol/test/wake-envelope.test.ts` and independently re-measured twice:

| Character class | Ceiling |
| --- | --- |
| ASCII | 433 |
| `"` / `\` / newline | 216 |
| CJK | 144 |
| Non-BMP (emoji) | 108 |
| Anything needing a six-byte `\u` escape | 72 |

Unreachable today: topicIDs are MLS-derived base64url, and 433 leaves the 256 cap 177 characters of
slack. The failure would be a throw at seal time, not a silent truncation.

## Why a schema `pattern`, not a bigger record

Sizing the record for the worst case means `rs` around 1615 and a ~1700-byte body for **every** wake.
That trades away the small constant ciphertext the entire blindness design rests on — the provider
currently learns only that a constant 597 bytes arrived. Padding every ping to eleven times its
useful size to accommodate a topicID shape nothing mints is the wrong trade.

The right fix is a `pattern` on the protocol's `topicID` schema, matching what topicIDs actually are.

## Why it is `next/` rather than backlog

Narrowing an existing schema is a breaking change for any caller already sending a value outside the
new pattern. Doing it while the band is unpublished costs nothing; doing it after costs a major.

## Work

1. Establish what a topicID is allowed to be — read the MLS derivation in `@kumiai/mls-rpc` rather
   than assuming base64url from the values in tests.
2. Add the `pattern` to `topicID` in `packages/hub-protocol/src/protocol.ts` and apply it to every
   topic-taking procedure, not only the wake pair.
3. Keep the ceiling assertions. They stop pinning a live hazard and start pinning headroom, which is
   the drift they were written to catch.
4. Check the doubles: a double may be stricter than its port, never more permissive.
