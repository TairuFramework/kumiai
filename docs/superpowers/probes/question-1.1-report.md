# Probe report: Question 1.1

**Status: BLOCKED**

## Findings

The result shapes are comfortable at the caller. A usage test destructured `secret`, `sealed`, and `epoch` from crypto results. It also read `advanced`, `epochBefore`, and `epochAfter` from commit apply. The test failed against the current API as expected. Both commit cases returned only `{ advanced: true }`. Both crypto cases returned bare bytes, so `secret` was `undefined`.

The real port cannot supply the required epoch from the same critical section with its current factory inputs. `createGroupCrypto` and `createGroupMLS` receive `handle: () => GroupHandle`; neither receives `HandleAccess`. `GroupHandle.decrypt`, `decryptStaged`, and `processMessage` acquire the handle mutex internally and return without the epoch they used. Wrapping those calls in `mutexFor(handle).run` would acquire that same non-reentrant mutex twice. Reading `handle().epoch` before or after those calls leaves a race with another operation or handle replacement. The `decryptStaged` persistence callback runs under the lock, but ordinary `decrypt` and refused `processMessage` have no equivalent callback. The exporter is intentionally lock-free so the commit resolver can call it from inside `processMessage`.

Thus step 3 of the approved approach cannot be met without first changing the handle access boundary or the underlying MLS operation API. The brief says to stop if the approach does not work and to ask before trying alternatives. No production API or port caller was changed. The exploratory failing usage test was removed after recording its result so the worktree keeps a passing baseline.

## Final type shapes sought

These are the approved target shapes, **not implemented**:

```ts
type ProcessCommitResult = { advanced: boolean; epochBefore: number; epochAfter: number }
type ExportSecretResult = { secret: Uint8Array; epoch: number }
type SealEntriesResult = { sealed: Uint8Array; epoch: number }
type GroupUnwrapResult = { payload: Uint8Array; senderDID: string; epoch: number }
class FrameEpochError extends Error {
  frameEpoch: number
  handleEpoch: number
}
```

`FrameEpochError` would distinguish past from future by comparing its two epochs. Other open errors would retain their current classes and messages. The synchronous `epoch()` hint would stay in place.

## Rationale and alternatives

The port result must describe the operation's actual handle state. An epoch read outside `decrypt` or `processMessage` can describe a different operation. In particular, a refused commit needs its locked before and after epochs even though it never reaches a persistence callback. A frame refusal needs the locked handle epoch before the app lane classifies it as past or future.

The cleanest prerequisite appears to be the shared `HandleAccess` boundary planned for Question 2.1, followed by these result changes. Another possibility is to add epoch-bearing operation results inside `@kumiai/mls` while its mutex is held. Neither alternative was attempted because the brief prohibits switching approaches without approval.

## Surprises and learning

- `mutexFor` is exported, but its existence does not let a caller wrap methods that already take the same mutex.
- `GroupHandle.exportSecret` is intentionally unlocked for in-commit entry resolution. Locking it directly would deadlock that path.
- The current double already refuses a different frame epoch. The real `GroupHandle.decrypt` can open a bounded past window, so the requested strict mismatch refusal needs an explicit real-port gate under the same operation lock.
- The usage shape itself did not create the blocker. The lock boundary did.

## Verification

The exploratory usage test ran first and failed as expected: `4 tests | 4 failed`. The two commit cases received `{ advanced: true }` without epochs. The two crypto cases received bare bytes, so destructured `secret` was `undefined`. The test was removed before baseline verification.

From the repo root, after removing the exploratory test:

```text
$ rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    35.09s

$ pnpm exec vitest run --root tests/integration
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Duration  6.18s

$ rtk proxy pnpm run lint
Checked 396 files in 248ms. No fixes applied.
```

The forced unit run included both `rpc-conformance` suites against the real `mls-rpc` ports and RPC doubles, plus hub contract tests. All results are baseline results. No epoch-bearing contract clauses were added.
