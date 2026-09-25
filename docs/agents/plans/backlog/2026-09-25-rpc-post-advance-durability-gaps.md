# rpc: two durability gaps after a commit or recovery advance

**Priority:** backlog. Both exist on `main`; found by a blind review of the strand-observability branch
(PR #47), which kept them unchanged.

## Re-enact entries are memory-only after an automatic heal

A successful automatic recovery puts the entries this device still owes the log into the in-memory
`pendingReenact` stash. `recover()`, `commit()` and `replay()` drain it. If the host disposes the peer
first, the stash is dropped. After a restart the bootstrapped ledger is complete, so the snapshot those
entries were computed from is gone and they cannot be rebuilt.

Options: hand owed entries to the host at heal time (a callback or an `onRecovery` field), or persist
the stash through a host port. Either needs a decision on who owns re-enactment across restarts.

## Anchor capture and epoch rebuild are not retried after a durable advance

`processCommit` persists and advances the handle; `captureAnchor()` then writes the app anchor, and a
walk that reports an advance rebuilds the epoch. If the capture or the rebuild fails, the walk leaves
its cursor behind, but the next walk sees the commit as history and skips both. The handle is durable
at the new epoch while the stored anchor (and the in-memory epoch runtime) stays at the old one.

The strand-observability branch added a repair step for the rejoin path only
(`rejoinAnchorNeedsCapture` / `rejoinRuntimeNeedsBuild`). The same repair-on-next-walk pattern would
cover received commits: mark "anchor or runtime owed" before the capture, clear it on success, and
check it at the start of each walk.

## Test hooks

- Heal, dispose before draining, restart: the owed entries are still re-enacted (or reach the host).
- Fail `captureAnchor` once after an applied commit: the next walk captures the anchor for that epoch.
