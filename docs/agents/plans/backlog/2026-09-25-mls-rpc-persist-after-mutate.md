# `mls-rpc` adapter mutates the handle before persisting it

**Filed:** 2026-09-25, from blind reviews of `feat/rpc-strand-observability`
(`../completed/2026-09-25-rpc-strand-observability.complete.md`). Pre-existing, not introduced there.

## Problem

The real `GroupMLS` adapter (`packages/mls-rpc/src/mls.ts`) changes the in-memory handle first and then
awaits the host's `persist`: an accepted commit adopts the new handle then persists (`mls.ts:~230`), and
`bootstrapLedger` installs the ledger on the handle then persists (`mls.ts:~267`). When `persist`
rejects, memory is ahead of storage:

- A ledger bootstrap whose persist failed leaves `isLedgerComplete()` true in memory. The peer can then
  report `bootstrapped` (and the gather can disagree with the handle), and a restart reverses it.
- An adopted commit whose persist failed runs on state the next restart does not have.

rpc now tolerates the adopted-then-persist-fails window for recovery (snapshot ownership follows the
observed epoch change), but it cannot make the host's storage match.

## Fix direction

Stage the new state, persist it, then adopt it, the way `GroupHandle.decryptStaged` does for app frames
(durable app delivery). That needs a staged variant of the handle operations the adapter drives
(commit acceptance, external rejoin, ledger bootstrap). Alternatively, on a persist failure, restore the
previous handle before rethrowing. Decide per operation; check both contract suites.

## Related, accepted for now

A host port call that never returns (for example `createRecoveryRequest` or `bootstrapLedger` stalling)
blocks `dispose()` from settling an in-progress recovery promptly. Every lane operation already awaits
host port calls without a timeout, so this is a general property of the port contract, not specific to
recovery.
