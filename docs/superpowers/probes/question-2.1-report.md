# Probe report: Question 2.1, second run

**Status: DONE**

The first run was BLOCKED because commit resolution could call `GroupCrypto.openEntries` while `processCommit` held the proposed access mutex. That call would enter `access.read` and wait behind the mutation that was waiting for the resolver. No API or caller migration survived the first run. This run used the approved pre-resolution step to remove that cycle.

## Findings

A usage test was written before the API. It passed one `simpleHandleAccess` instance to both factories and initially failed because `access.js` did not exist. The final test passes with the same call shape.

One access-level queue now serialises `read`, `mutate`, `replace`, and `open`. `epoch()` reads a published number seeded from the initial handle. A mutation saves once: the adapter forwards its save callback to library methods that need rollback on save failure, then skips its fallback save when that callback succeeds. Ordinary `wrap` and non-durable `unwrap` use the fallback save. Replacement saves before adoption. Durable open forwards the staged writer through `access.open` and publishes only after it resolves.

`processCommit` checks Commit kind and epoch under `access.read` before resolving entries. A wrong-epoch or non-Commit frame returns `{ advanced: false }` without opening a blob. A new total `readCommitEntryIDs` reader extracts cleartext control-envelope IDs from a private Commit; malformed or other frames yield `[]`. The shell resolves nonempty IDs outside mutation. Inside mutation, the slot returns only the fetched tokens requested by the handle. The handle still verifies digest and signature. An epoch change during resolution throws a retryable error before apply. Resolver faults and `MissingLedgerEntriesError` retain their propagation paths.

Both factories now require `access`. The repository callers, conformance wiring, integration fixtures, and README examples use it. The integration authored-commit fixture adopts through `access.replace`. Recovery acceptance also uses `replace`. Handle construction in the touched conformance restore path retains the ledger resolver slot.

## Final API

```ts
type PersistOpened = (stagedState: Uint8Array, record: PendingAppFrame) => Promise<void>

export type HandleAccess = {
  epoch(): number
  read<TValue>(fn: (handle: GroupHandle) => TValue | Promise<TValue>): Promise<TValue>
  mutate<TValue>(
    fn: (handle: GroupHandle, persist: (handle: GroupHandle) => Promise<void>) => Promise<TValue>,
  ): Promise<TValue>
  replace(next: GroupHandle): Promise<void>
  open<TValue>(
    fn: (handle: GroupHandle, persistOpened: PersistOpened) => Promise<TValue>,
    persistOpened: PersistOpened,
  ): Promise<TValue>
}

export type SimpleHandleAccessParams = {
  handle: () => GroupHandle
  adopt: (next: GroupHandle) => void | Promise<void>
  persist?: (handle: GroupHandle) => void | Promise<void>
}

export function simpleHandleAccess(params: SimpleHandleAccessParams): HandleAccess
export function readCommitEntryIDs(bytes: Uint8Array): Array<string>
```

`GroupMLSParams` is `{ access, identity, entrySlot }`. `GroupCryptoParams` is `{ access, entryLabel?, runtime?, pending? }`. No `@kumiai/rpc` port type changed.

## Rationale and alternatives

The standalone reader is smaller than extending `readCommitHeader`: the latter is an authenticated, handle-bound, asynchronous read and would need another public result field. The new reader only supplies an untrusted fetch hint. The existing `processMessage` pipeline remains the authority for entry verification and commit acceptance.

A re-entrant access mutex or an unlocked exporter path would weaken the exact `HandleAccess` contract. Pre-resolution uses the approved surface and allows a resolver implemented with `access.read`. A rejected Commit exits mutation by an internal marker, so the simple adapter does not save unchanged state. This also keeps the existing poison outcome if a host save hook would fail on an unrelated rejected frame.

The generic epoch-move error is retryable through the current RPC catch path. `MissingLedgerEntriesError` is reserved for bodies that are actually absent during the handle's verification; RPC currently classifies that error as poison. No new port result or `applyCommit` helper was added.

## Surprises and learning

- The package-level integration runner reads built `lib/` exports. The MLS and MLS-RPC JavaScript builds had to be refreshed locally before direct integration runs could see the new exports. Generated files were not edited or committed.
- Persisting ordinary decrypt ratchets changes crash replay in a non-durable integration fixture. That fixture now uses an in-memory pending store and saves its staged state and record together. Its restart test replays the pending record after the first process dies inside a handler.
- Conformance fixtures that advanced a handle directly left the adapter's scalar behind. They now advance through `access.mutate`.
- A valid but refused Commit must not trigger the adapter's fallback save. A focused test covers that path.

## Verification

The focused MLS-RPC suites passed, including real entry-bearing commits, empty IDs, access re-entry, concurrent epoch replacement, wrong-epoch and non-Commit no-open paths, resolver failures, save rollback, authored and recovery replacement, and durable open pass-through.

From the repository root:

```text
$ rtk proxy pnpm turbo run test:types test:unit --force --concurrency=2
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    42.765s

$ pnpm exec vitest run --root tests/integration
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Duration  6.48s

$ rtk proxy pnpm run lint
Checked 399 files in 327ms. No fixes applied.
```

The transactional access adapter, epoch-bearing RPC results, standalone byte helpers, and `applyCommit` remain scheduled for their later questions. A simple adapter cannot discard an in-place ordinary ratchet mutation after a post-operation store failure; the operation rejects and the host must restore its durable handle before continuing. The transactional adapter is the path for rollback of that case.
