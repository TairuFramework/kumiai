# rpc: re-enact entries are memory-only after an automatic heal

**Priority:** backlog. Found by a blind review of the strand-observability branch (PR #47). The other gap
that review found (anchor capture and epoch rebuild after a durable advance) was closed by the bound-leaf
lifecycle and log delivery work (`../completed/2026-10-05-bound-leaf-and-log-delivery.complete.md`).

A successful automatic recovery puts the entries this device still owes the log into the in-memory
`pendingReenact` stash. `recover()`, `commit()` and `replay()` drain it. If the host disposes the peer
first, the stash is dropped. After a restart the bootstrapped ledger is complete, so the snapshot those
entries were computed from is gone and they cannot be rebuilt.

Options: hand owed entries to the host at heal time (a callback or an `onRecovery` field), or persist
the stash through a host port. Either needs a decision on who owns re-enactment across restarts.

Test hook: heal, dispose before draining, restart: the owed entries are still re-enacted (or reach the
host).
