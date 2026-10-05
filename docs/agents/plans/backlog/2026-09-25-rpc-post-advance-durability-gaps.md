# rpc: durability gaps after a commit or recovery advance

**Priority:** backlog. Found by a blind review of the strand-observability branch (PR #47), which kept
them unchanged. The bound-leaf lifecycle and log delivery work
(`../completed/2026-10-05-bound-leaf-and-log-delivery.complete.md`) closed the anchor-capture half of the
second gap; what remains is below.

## Re-enact entries are memory-only after an automatic heal

A successful automatic recovery puts the entries this device still owes the log into the in-memory
`pendingReenact` stash. `recover()`, `commit()` and `replay()` drain it. If the host disposes the peer
first, the stash is dropped. After a restart the bootstrapped ledger is complete, so the snapshot those
entries were computed from is gone and they cannot be rebuilt.

Options: hand owed entries to the host at heal time (a callback or an `onRecovery` field), or persist
the stash through a host port. Either needs a decision on who owns re-enactment across restarts.

## Epoch runtime rebuild is not retried after a received commit

Anchor capture is now durable: every advance persists a one-advance rotation record in the
`AnchorStore` slot before ratcheting, and the next advance or startup resolves it (capturing the landed
anchor, or forcing confirmed recovery when the target secret is gone).

The in-memory epoch runtime has no equivalent outside the rejoin path. After a pull that applied
commits, `reconcileCommits` calls `rebuildEpoch()`. If `teardownEpoch()` throws, `buildEpoch()` never
runs, and the next walk sees the commits as history, so nothing rebuilds the protocol runtimes at the
new anchor. The walk-failure path in `pullCommits` rebuilds only within the same call. The rejoin path
already has the repair (`rejoinRuntimeNeedsBuild`): mark "runtime owed" before the rebuild, clear it on
success, check it at the start of each walk. Extend it to received commits.

## Test hooks

- Heal, dispose before draining, restart: the owed entries are still re-enacted (or reach the host).
- Make `teardownEpoch` fail once after a pull applies a commit: the next walk rebuilds the runtimes at
  the new anchor.
