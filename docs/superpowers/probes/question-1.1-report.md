# Probe report: Question 1.1, second run

**Status: DONE**

The first run was BLOCKED after a usage test showed the proposed result shapes were usable but the real factories had no lock under which to read an operation's epoch. Reading around `GroupHandle` methods raced; wrapping their internal mutex was non-reentrant. Questions 2.1 and 2.2 supplied one shared `HandleAccess` queue, which made the approved result shapes implementable in this run.

## Findings

A usage test was written first. It destructured the exported secret and sealed bytes, checked the open's epoch, and read the commit's before and after epochs. Its initial run failed on the old bare-byte `exportSecret` result (`secret` was undefined). It now passes over real MLS.

The real crypto adapter reads the exporter secret and epoch in one `access.read`. It derives the entry key and captures its epoch in one `access.read`, then seals with that key and wipes it. Both ordinary and durable `unwrap` read the handle epoch and compare a readable frame epoch inside their respective `access.mutate` or `access.open` callback, before calling decrypt. A mismatch throws `FrameEpochError`; malformed frames and other open failures retain their existing errors. The successful result carries the epoch of that locked open.

`processCommit` returns the locked pre-check epoch for a frame refused before resolution. Inside `access.mutate`, it captures the before epoch and the post-apply epoch. An unchanged apply returns equal epochs without saving; a durable advance reports both values. The retryable epoch-move error during entry resolution remains unchanged.

The memory MLS and fake crypto doubles report their modelled operation epochs and refuse a mismatched frame with the same typed error. The `GroupCrypto` and `GroupMLS` contract suites now force `epoch()` one behind and one ahead. They check secret values, seal and open epochs, commit advance and refusal results, and past and future `FrameEpochError` fields. The pending crypto suite also checks that a past-frame refusal makes no durable store write. Both suites ran against the real ports and the doubles.

RPC callers were changed only to read `.secret` and `.sealed` and preserve `epoch` in the normalized open result. They still use the synchronous `crypto.epoch()` hint for existing decisions; Questions 1.2 and 1.3 own those moves. No disposition or cursor logic changed here. Tests and fixtures throughout the repository were aligned to the new shapes.

## Final types and changed public signatures

```ts
type ExportSecretResult = { secret: Uint8Array; epoch: number }
type SealEntriesResult = { sealed: Uint8Array; epoch: number }
type ProcessCommitResult = { advanced: boolean; epochBefore: number; epochAfter: number }
type GroupUnwrapResult = { payload: Uint8Array; senderDID: string; epoch: number }
class FrameEpochError extends Error {
  constructor(frameEpoch: number, handleEpoch: number)
  get frameEpoch(): number
  get handleEpoch(): number
}
```

`@kumiai/rpc` now exports the three result types and `FrameEpochError`. Its `GroupCrypto.exportSecret` returns `ExportSecretResult | Promise<ExportSecretResult>`, `sealEntries` returns `SealEntriesResult | Promise<SealEntriesResult>`, and `unwrap` returns the expanded `GroupUnwrapResult | Promise<GroupUnwrapResult>`. `GroupMLS.processCommit` returns `Promise<ProcessCommitResult>`. These are breaking changes for implementers and callers.

`@kumiai/rpc-conformance` changed its public structural `ConformanceGroupCrypto` method returns, `ConformanceUnwrapResult`, and `ConformanceGroupMLS.processCommit` return to match. `ConformanceCryptoGroup` and `ConformanceMLSGroup` now require `setEpochHintOffset(offset: number): void` from suite harnesses, changing the `createGroup` fixture contracts accepted by both exported suite functions. The `@kumiai/mls-rpc` factory signatures and `HandleAccess` signature are unchanged; their returned port methods now implement the new public RPC signatures. No changeset was added because Question 6.2 owns the release text.

## Rationale and alternatives

The operation result must name the state used by that operation. The `HandleAccess` queue keeps a handle stable for the callback, including awaits, while the published `epoch()` scalar can lag or run ahead. The strict pre-decrypt mismatch gate makes real MLS and the double agree even though ts-mls retains a bounded past key window underneath. A separate epoch read after a refusal or decrypt would reintroduce the race from the first run. Separate `...At` methods were considered in that run but were unnecessary once access supplied the lock.

## Surprises and learning

- The old conformance clause allowed a bounded past window. The new port contract requires refusal after one epoch transition, so that clause was tightened.
- Durable open needed its own epoch gate ahead of `decryptStaged`; the ordinary `mutate` gate does not cover it.
- Contract suites import built package output, so the local `@kumiai/rpc` and `@kumiai/rpc-conformance` JavaScript builds were refreshed while developing. Generated `lib/` files are untracked by this commit.
- A fake durable open must capture its epoch before awaiting persistence; otherwise a concurrent model epoch change could relabel a completed open.

## Verification

The initial usage test failed as expected: `1 test | 1 failed`, because destructured `secret` was undefined. The completed contract suites passed against real MLS and the doubles, including their lying-hint clauses and durable refusal clause: `2 files | 108 tests passed`.

From the repository root, after the final code changes:

```text
$ rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2
@kumiai/integration-tests:test:unit:  Test Files  8 passed (8)
@kumiai/integration-tests:test:unit:       Tests  43 passed (43)
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    43.801s

$ pnpm exec vitest run --root tests/integration
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Duration  6.49s

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./scripts ./tests
Checked 401 files in 320ms. No fixes applied.
```
