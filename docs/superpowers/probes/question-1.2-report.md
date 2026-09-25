# Probe report: Question 1.2

**Status: DONE**

## Findings

The commit walk now classifies from a locked `GroupMLS.readEpoch()` result. An applicable commit uses `processCommit`'s locked before and after epochs for the ratchet gate, applied record, and changed-roster anchor. When apply refuses at a different `epochBefore`, the walk reclassifies the same frame from that result before moving its cursor. It rebuilds the runtime after observing the intervening handle move. The advance seam and recovery failure paths use locked reads when their operation has no epoch result.

Tests compare honest, lagging, and leading hints for applicable, past, future, own, unknown handshake version, and unsupported commit-frame version frames. They check the cursor, strand and failed repair observations, and the rotated anchor. A separate fork test checks losing-branch evidence under all three hints. A race test moves the handle between classification and apply, checks reclassification, and proves the following applicable commit is applied.

## Moved reads

| Role | Old source | New source |
| --- | --- | --- |
| Advance baseline before an operation | `crypto.epoch()` | `port.readEpoch()` |
| Ratchet check after received apply | `crypto.epoch()` against baseline | `processCommit.epochBefore` and `.epochAfter` |
| Ratchet check after adoption without a result | `crypto.epoch()` against baseline | `port.readEpoch()` against locked baseline |
| Changed-roster anchor epoch | `crypto.epoch()` in `captureAnchor` | `processCommit.epochAfter` or locked post-adoption epoch passed by the advance seam |
| Failed advance and anchor barrier | `crypto.epoch()` against baseline | `port.readEpoch()` against locked baseline |
| Unknown handshake-version classifier and strand evidence | `crypto.epoch()` | `port.readEpoch()` |
| Unsupported commit-frame-version classifier and strand evidence | `crypto.epoch()` | `port.readEpoch()` |
| Ordinary commit classifier and fork evidence | `crypto.epoch()` | `port.readEpoch()`, then `processCommit.epochBefore` after a mismatch |
| Applied commit's epoch key | `crypto.epoch()` | Classified locked epoch, checked against `processCommit.epochBefore` |
| Pull failure baseline | `crypto.epoch()` | `mls.readEpoch()` |
| Pull failure runtime rebuild check | `crypto.epoch()` | `mls.readEpoch()` against locked baseline |
| Rejoin adoption baseline | `crypto.epoch()` | `port.readEpoch()` |
| Rejoin adoption in `finally` | `crypto.epoch()` | `port.readEpoch()` against locked baseline |

## Port change and rationale

`GroupMLS.readEpoch(): Promise<number>` is a locked read. The real adapter calls `access.read`; the memory double returns its model epoch. The `GroupMLS` conformance suite checks that the read ignores a lagging or leading hint, against both implementations. This one read covers classification without applying a commit or opening its entry blob. Using `processCommit` solely as a read was the other approved option, but unknown-version frames have no commit bytes to pass, and a probe call would change the double's process count.

The apply result takes precedence over the earlier read when the handle moves between them. A refused mismatch re-enters classification with `epochBefore`, so a frame cannot be recorded as an applied commit at the wrong epoch. The cursor moves only after the resulting disposition is known. Constructor seeds and error-message interpolation still use the hint. App-lane, sealing, replay, journal decisions, and general anchor capture on export remain assigned to Question 1.3. The advance seam passes its locked post-advance epoch to anchor capture for commit-path rotations.

## Surprises and learning

The constructor can seed an unrotated anchor from a lying hint. That behaviour belongs to Question 1.3, so the comparison tests check an anchor after a roster-changing commit. An apply refusal can follow an intervening handle move; reporting no walk advance would leave the runtime at its earlier epoch. The mismatch path therefore requests a rebuild even when this frame was refused.

## Mutation check

Temporarily changing the ordinary classifier's `let localEpoch = await port.readEpoch()` back to `let localEpoch = crypto.epoch()` failed the new test:

```text
FAIL packages/rpc/test/peer-locked-commit-epoch.test.ts > commit decisions use the handle epoch > applicable has the same result with lagging and leading hints
AssertionError: expected { epoch: 2, commits: +0, …(5) } to deeply equal { epoch: 3, commits: 1, …(5) }
```

The test also failed for own and both fork hint cases. The locked read was restored before verification.

## Verification

```text
$ rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2
@kumiai/rpc:test:unit:  Test Files  88 passed (88)
@kumiai/rpc:test:unit:       Tests  594 passed (594)
@kumiai/mls-rpc:test:unit:  Test Files  8 passed (8)
@kumiai/mls-rpc:test:unit:       Tests  94 passed (94)
@kumiai/integration-tests:test:unit:  Test Files  8 passed (8)
@kumiai/integration-tests:test:unit:       Tests  43 passed (43)
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    1m0.376s

$ pnpm exec vitest run --root tests/integration
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Duration  7.48s

$ rtk proxy pnpm run lint
$ biome check --write ./packages ./scripts ./tests
Checked 402 files in 738ms. No fixes applied.
```
