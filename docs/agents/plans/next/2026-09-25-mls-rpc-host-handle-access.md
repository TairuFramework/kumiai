# Let hosts with their own handle store reuse `@kumiai/mls-rpc`

**Priority:** next. **Waits on:** durable app-frame delivery (`feat/rpc-durable-app-delivery`) being
done; this reshapes the ports that work adds, so it lands after it and in the same 0.10 release. See
`../milestones/v0.10-release.md`.
**Origin:** Kubun adoption review, 2026-09-25. Kubun implements `GroupMLS` and `GroupCrypto` itself
instead of using `@kumiai/mls-rpc`, and duplicates much of it.

## Why a host cannot use `mls-rpc` today

`createGroupMLS` / `createGroupCrypto` assume the host keeps one long-lived, mutable `GroupHandle`
reachable synchronously (`handle: () => GroupHandle`) and persists it inline (`persist(handle)`, then
`adopt(handle)`). A host that stores handles in a database with transactions cannot fit that shape:

- **Handle access is async and locked.** Kubun reaches a handle only through a mutex-guarded registry
  (`readHandle` / `withHandle`). A synchronous accessor would bypass the lock that makes "advance the
  ratchet and write the row" atomic.
- **Handle identity is unstable on purpose.** Kubun applies a commit to a handle restored inside a DB
  transaction and swaps its cache only when the transaction commits; a rollback just drops the
  handle. A synchronous `handle()` reads the old epoch on both sides of the advance.
- **The lock holder never waits on the DB.** `persist` runs inside the handle call, so a host that
  wraps the call in its own lock waits on storage while holding it. The durable-delivery port
  `pending.persistOpened` has the same property.
- **A commit must share one transaction with host writes.** Kubun writes roster changes, member rows,
  role mirroring and a ledger fold in the transaction that applies the commit, and emits its events
  after it commits. `processCommit` offers no hook between apply and persist, and does not return the
  roster before and after, the ledger length before, or the surfaced ledger entries.

## What Kubun duplicates

- **Byte-for-byte copies:** `frameEpoch`, `sealEntries`, `openEntries` (kept equal by a cross-check
  test in Kubun), the recovery pending map with its sweep and 120 s TTL, and `openSealedLedger`'s
  error-to-null mapping.
- **Same call, different handle access:** `readCommitHeader`, `sealGroupInfo`,
  `createRecoveryRequest`, `applyRecovery`, `isLedgerComplete`, `getLedger`, `sealLedger`,
  `exportSecret`, `wrap`, `unwrap`.
- **Kubun-specific, stays in Kubun:** the table writes and events around `processCommit`, the
  projection rebuild after `bootstrapLedger`, and `unwrap` dedup across two transports.

## Proposal

Keep kumiai generic: nothing below names Kubun's registry or tables.

1. **Export the pure primitives** from `@kumiai/mls-rpc`: entry sealing (`deriveEntryKey(handle,
   label)`, `sealEntries(key, entries)`, `openEntries(key, bytes)`), `createRecoveryPending({ ttlMS })`,
   and `deriveRecoverySecret(handle)`. `mls-rpc` itself uses them. (Kubun also reads
   `handle.state.keySchedule.exporterSecret` directly instead of `handle.exportSecret`; the export fixes
   that.)
2. **Replace `handle` / `adopt` / `persist` with a handle-access port:**

   ```ts
   type HandleAccess = {
     read<T>(fn: (handle: GroupHandle) => T | Promise<T>): Promise<T>
     mutate<T>(fn: (handle: GroupHandle) => Promise<T>): Promise<T> // host owns lock, tx, persist order
     replace(next: GroupHandle): Promise<void> // adopt and persist as one host step
   }
   ```

   Ship `simpleHandleAccess({ handle, adopt, persist })` as the default adapter with today's
   semantics, so single-handle hosts change one line.
3. **Split `processCommit` into a core and a shell.** Export `applyCommit(handle, commit, ctx)`
   returning `{ advanced, rosterBefore, rosterAfter, surfacedEntries, ledgerLengthBefore,
   committerDID }`, with the error mapping in one place (a rejected commit is not advanced; missing
   ledger entries and persist failures propagate). `processCommit` becomes
   `access.mutate((h) => applyCommit(h, ...))`. A host with its own transaction calls `applyCommit`
   inside it and does its writes from the result.
4. **Reshape durable delivery's `pending.persistOpened` the same way.** It currently runs under the
   handle lock and must write the DB there. Route it through `access.mutate`, or make it
   stage-then-commit, so the host owns the lock and write order.
5. **Pick one recovery secret.** `mls-rpc` derives it with a KDF over the encoded group anchor; Kubun
   uses a random seed minted into the anchor's app slot. Peers using the two never meet on the
   recovery rendezvous topic. Decide which is the kumiai default (the random seed is not derivable
   from the anchor alone) and make the other a host option or drop it.

## Probe first (can run now, independent of the release)

Kubun rejects non-Commit bytes in `processCommit` (pinned by its
`commit-ingest-rejects-proposals.test.ts`). `mls-rpc` passes any message to
`GroupHandle.processMessage`, which also accepts Proposals, then answers `{ advanced: false }`. Check
whether a Proposal the hub places on the commit topic is kept as pending state and changes what the
next commit enacts. If it is, that is a correctness fix for the current band, not part of this item.

## Also in the same packages (bundle candidates)

- `processMessage` / `processWelcome` take `Uint8Array | unknown`, which collapses to `unknown`
  (`2026-07-07-mls-api-hardening.md`). `applyCommit` is a natural moment to type the input.

## Done when

- Kubun's adapters shrink to handle access, its own writes and events; the byte-copies are gone.
- `rpc-conformance` passes against `mls-rpc` with `simpleHandleAccess` and with a transactional
  test adapter that restores a fresh handle per mutation and swaps on commit.
- The migration for single-handle hosts is one line, stated in the changeset.
