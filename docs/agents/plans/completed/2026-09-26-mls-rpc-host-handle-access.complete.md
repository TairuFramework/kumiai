# Host handle access for `@kumiai/mls-rpc` — complete

**Date:** 2026-09-26
**Status:** complete
**Packages:** `@kumiai/mls-rpc`, `@kumiai/rpc`, `@kumiai/rpc-conformance` (minor, 0.10 band);
`@kumiai/mls` (patch: `decodeClientState` copies its input).
**Origin:** Kubun owns its group handles behind an async, locked registry and applies commits inside
its own database transaction. `mls-rpc`'s factories required a synchronous mutable handle, so Kubun
kept duplicate copies of the crypto, commit, recovery and entry-sealing code.

## Goal

Let a host own the handle, the lock, the transaction and the persist order, while `mls-rpc` keeps the
MLS logic. The peer must stay correct when the host's cheap epoch reading is stale or ahead.

## Key decisions

- **One `HandleAccess` port** (`epoch`, `read`, `mutate`, `replace`, `open`) replaces `handle` /
  `adopt` / `persist`. `simpleHandleAccess` builds it from the old parameters for a one-line 0.9
  migration.
- **`epoch()` is a hint.** A Kubun probe showed the scalar can lag and run ahead, and an async port is
  still not atomic. Every port result carries the epoch it acted at under the lock: `exportSecret`
  `{secret, epoch}`, `sealEntries` `{sealed, epoch}`, `unwrap` `epoch`, `processCommit`
  `{advanced, epochBefore, epochAfter}`, plus `GroupMLS.readEpoch()`. `unwrap` throws
  `FrameEpochError {frameEpoch, handleEpoch}` for a readable frame at another epoch, before decrypting.
  App-frame retention, the drain, anchor capture, the commit walk and journal replay decide from those.
- **Durable opens stage, then commit.** `open` runs the decrypt on a handle whose staged state is
  handed back with the pending record; the host writes state and record in one conditional write,
  then publishes. Database I/O never runs under the MLS mutex. Same-epoch state is guarded by a
  per-group revision, because app opens change the secret tree without moving the epoch. Every
  adapter or staging fault is an `AppFrameStorageError`, so the lane retries rather than dropping a
  frame whose key was never spent.
- **`applyCommit`** applies a received Commit inside a host transaction and returns both rosters, the
  ledger length before, the committer, the surfaced non-`kumiai.*` entries (the appended ledger
  suffix, repeats kept) and `applied` / `advanced`. A commit removing this member is applied without
  advancing. Refusals (non-Commit bytes, another epoch, an own commit by normalised DID) return
  `applied: false`; missing bodies, resolver faults and store faults propagate so the peer never
  steps over a commit it may yet apply. A host callback that throws after the write reports the
  state as applied.
- **Entries resolve before the lock.** `processCommit` reads the commit's entry IDs, resolves them
  outside `access.mutate` and re-verifies inside, so a locking host resolver cannot self-deadlock.
  An epoch move during resolution answers `advanced: false` at the moved epoch.
- **Recovery secret:** the anchor KDF stays the default so existing groups keep their rendezvous
  topics; `createGroupMLS({ recoverySecret })` lets a host (Kubun's random anchor seed) override it.
  A result under 16 bytes is refused, never replaced by the default.
- **Standalone exports** for hosts building their own ports: `applyCommit`, `deriveEntryKey`,
  `sealEntries`, `openEntries`, `createRecoveryPending`, `deriveRecoverySecret`.

## What was built

- The port reshaping in `@kumiai/rpc` and the locked-epoch decisions in the peer and app lane.
- `HandleAccess`, `simpleHandleAccess`, the durable staged open, `applyCommit` and the recovery
  override in `@kumiai/mls-rpc`, with README sections on writing a custom `HandleAccess` and applying a
  commit inside a host transaction.
- A transactional test adapter (restore per mutation, revision-conditional writes, publish only on
  commit, host callbacks on restored handles). The three conformance suites run over it as well as
  over the simple adapter; it found that a self-removal commit was discarded, which led to `applied`.
- `setEpochHintOffset` in `@kumiai/rpc-conformance`: every clause runs with a lying hint in both
  directions.
- `@kumiai/mls`: `decodeClientState` copies its input, since a ratchet zeroed stored bytes it aliased.

## Review

Two blind whole-branch reviews. The first found 2 medium and 9 low; the second, 4 medium and 6 low
(resolver faults read as refusals, staging faults dropping frames, self-removal entries not surfaced,
a bootstrap stored but not published). All were fixed with mutation-checked tests except those
accepted into `../backlog/2026-09-26-rpc-locked-epoch-residuals.md`.

## Follow-on

- `../backlog/2026-09-26-rpc-locked-epoch-residuals.md`: races between two locked reads, faults read
  as missing entry bodies, the drain's per-frame cost, and two test gaps.
- Kubun adoption is tracked in Kubun's `docs/agents/plans/next/2026-09-25-kumiai-0-10-adoption.md`.
