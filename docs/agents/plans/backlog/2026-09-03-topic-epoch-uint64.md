# Topic derivation epoch is capped at 2^53, not the full MLS uint64

**Priority:** backlog — a long-horizon completeness limitation, not a reachable defect.
**Filed:** 2026-09-03, surfaced by an adversarial review of the `deriveTopicID` injectivity work.

## What

`deriveTopicID` (`packages/broadcast/src/topic.ts`) now rejects any epoch that is not a non-negative
JavaScript safe integer (`Number.isSafeInteger(epoch) && epoch >= 0`). MLS epochs are unsigned
64-bit: `GroupHandle.epoch` is a `bigint`, and the real crypto adapter narrows it with
`Number(handle().epoch)` (`packages/mls-rpc/src/crypto.ts`) before it reaches the topic helpers,
whose `epoch` parameter is a `number`. So an epoch at or above `2^53` is rejected at derivation.

## Why it is not urgent

- **It fails closed, and it fixed a worse bug.** Before this guard, an epoch at or above `2^53`
  would round to a colliding float inside `Number(...)`/`encodeEpoch` and two distinct uint64 epochs
  could derive the *same* topic silently. The guard converts that silent collision into a loud
  throw. Rejecting the unrepresentable range is the correct behaviour for the current `number` API.
- **The range is astronomically unreachable.** The epoch advances once per commit; `2^53` is ~9
  quadrillion commits on one group.

## The real fix, when it is ever wanted

Carry `bigint` through the topic API end to end — `GroupCrypto.epoch()` (`packages/rpc/src/crypto.ts`),
the `deriveTopicID`/`protocolTopic`/`inboxTopic` signatures, and `encodeEpoch` — so the full uint64
domain is representable and the safe-integer cap can be lifted. That is a breaking signature change
across `@kumiai/broadcast` and `@kumiai/rpc`; take it only alongside other breaking work on those
ports, never on its own. Until then the safe-integer guard is the correct, injective behaviour.
