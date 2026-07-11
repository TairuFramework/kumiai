# GroupHandle state serialization + secret hygiene

**Status:** design, approved for planning.
**Origin:** 2026-07-02 repo audit (commit `bb343d9`), milestone
`docs/agents/plans/milestones/2026-07-audit-remediation.md` Phase 1 item 3
(`docs/agents/plans/next/2026-07-07-mls-state-serialization-secret-hygiene.md`). Folded into the
`feat/mls-permission-enforcement` branch so the whole `@kumiai/mls` surface settles in one release
before kubun migrates.

## Why now

The permission-enforcement work already reshapes the public `@kumiai/mls` surface kubun consumes.
This finding reshapes the *same* surface — `GroupHandle.encrypt`/`decrypt` and the mutating receive
path — and hits the same ~30-line kubun file (`plugin-p2p/src/groups/mls-codec.ts`). Shipping the two
changes in separate releases makes kubun migrate that file twice, and the second change is a
crypto-hygiene fix (a forward-secrecy hole) that should not trail behind a release it supersedes.
Bundle both, cut one breaking bump.

## Problem

Four related defects on `GroupHandle`'s state-mutating operations, all in `packages/mls/src/group.ts`.

1. **State races (High, correctness).** `encrypt`, `decrypt`, and `processMessage` each do
   `read this.#state → await ts-mls → this.#state = newState` with no serialization. Two concurrent
   `encrypt`s both read epoch N, both advance the secret-tree generation, and both write back — one
   clobbers the other, and a generation/nonce can be reused. Interleaved `processMessage`/`decrypt`
   clobber each other's key-schedule deletions. Both weaken forward secrecy. This is a concrete
   vulnerability, not a theoretical one.
2. **Consumed secrets never zeroed (Medium, security).** ts-mls returns `consumed: Array<Uint8Array>`
   on `createApplicationMessage`, `createCommit`, and `processMessage` precisely so the caller can
   wipe the retired secrets. Today only `encrypt` receives them, and it returns them to the caller
   unwiped; the commit producers (`commitInvite`, `removeMember`, `commitLedgerEntries`) and the
   receive path drop `consumed` on the floor. Retired key material lingers in the heap.
3. **`encrypt` return shape (Medium, API).** `encrypt` returns `{ message: unknown; consumed }` — a
   pre-encode ts-mls object — while every other producer (`commitInvite`, `removeMember`,
   `commitLedgerEntries`, `joinGroupExternal`) returns framed wire `Uint8Array`. Callers must know
   ts-mls encoders to put an application message on the wire.
4. **`decrypt` mutate-then-throw (Medium, correctness).** An accepted commit reaching `decrypt`
   advances the group (state mutated, epoch moved), then `decrypt` throws
   `'Expected application message but received handshake message'`. The caller sees a thrown error
   while the state changed underneath it. `decrypt` and `processMessage` are otherwise near-duplicate
   receive paths running the same commit pre-pass; this throw is `decrypt`'s only distinct behavior,
   and it is a bug.

**Blast radius.** No internal `@kumiai/mls` consumer calls `GroupHandle.encrypt`/`decrypt`
(`@kumiai/broadcast` is generic fan-out with no mls dependency; the audit's "broadcast wrap/unwrap"
note is stale). The only external consumer is kubun's `mls-codec.ts`. So the changes below break no
internal kumiai code or tests beyond the mls package's own suite.

## Design

### 1. One FIFO mutation chain per handle

Each handle gets its own serializer. It must be reachable both from `GroupHandle`'s own methods *and*
from the free producer functions in the same module — and a `#`-private method is not reachable from a
module-level function. So the serializer is a small **`Mutex`** object (a generic FIFO async queue,
shaped for later extraction to `@sozai/async` — see Follow-up), held in a **module-private `WeakMap`
keyed by handle**. Neither the `Mutex` nor the map nor the accessor is exported:

```ts
// module-private — not exported
type Mutex = { run: <T>(fn: () => Promise<T>) => Promise<T> }

function createMutex(): Mutex {
  let chain: Promise<unknown> = Promise.resolve()
  const noop = () => {}
  return {
    run(fn) {
      const result = chain.then(fn, fn)   // run regardless of the prior op's outcome
      chain = result.then(noop, noop)     // a rejection must not poison the queue
      return result
    },
  }
}

const MUTEXES = new WeakMap<GroupHandle, Mutex>()
function mutexFor(handle: GroupHandle): Mutex {
  let m = MUTEXES.get(handle)
  if (m === undefined) { m = createMutex(); MUTEXES.set(handle, m) }
  return m
}
```

(A `WeakMap` rather than a `#mutation` field keeps the mechanism internal without adding a public
`run`/`runExclusive` method to `GroupHandle`, and lets the free functions enlist. The handle holds no
reference to its `Mutex`; the entry is collected with the handle.)

Every async operation that reads or writes the handle's `#state` runs its whole
`read → await → write` body inside `mutexFor(handle).run(…)`, so operations on one handle execute one
at a time, in the order they were issued (FIFO — never reordered, because *when* a message is sent, at
which epoch, is causally load-bearing in MLS).

On the queue:

- `encrypt` and `processMessage` — the two methods that assign `this.#state`. A method enlists as
  `mutexFor(this).run(…)`.
- `commitInvite`, `removeMember`, `commitLedgerEntries` — free functions that operate on a live
  handle (they read `group.state`, `await` ts-mls, and return a derived handle). They wrap their body
  in `mutexFor(group).run(…)`. They do not write the source `#state`, but serializing them closes the
  in-process stale-read fork (a producer reading epoch N while a concurrent `encrypt` moves the handle
  to N+1).

Not on any chain — these are constructors with no prior `#state` to protect:

- `createGroup`, `processWelcome`, `restoreGroup`, `joinGroupExternal`.

**Getters stay synchronous.** `epoch`, `treeHash`, `state`, `roster`, `ledgerTokens`,
`findMemberLeafIndex`, `listMembers` read `this.#state` in one tick. JS is single-threaded, so a
getter runs atomically and always observes the last fully-assigned `#state`; it can never see a
half-applied mutation. Queueing them would force them `async` (a large breaking change) for zero
safety gain, so they are left untouched.

**Chain hygiene.** A rejected operation (e.g. a `CommitRejectedError`) must not poison the chain for
the next op. `#runExclusive` continues the chain on both fulfilment and rejection (the `NOOP, NOOP`
continuation), and surfaces the real result/rejection to the actual caller.

### 2. Zero `consumed` on every path

A single internal helper runs a ts-mls producer/receive call, commits the resulting state, then wipes
every returned `consumed` buffer before returning:

```ts
function zeroAll(buffers: Array<Uint8Array>): void {
  for (const b of buffers) b.fill(0)
}
```

Applied only on the paths that **advance the handle's own `#state`**: after `createApplicationMessage`
(in `encrypt`) and after `processMessage`'s ts-mls call (and the interim `decrypt`). On these paths
`this.#state = newState` abandons the old state first, so the retired `consumed` buffers are provably
unreferenced and safe to wipe. `consumed` never crosses the public boundary.

The **commit-producer path is deliberately excluded.** `commitInvite`/`removeMember`/
`commitLedgerEntries` route through `commitWithEntries`, which reads `group.state` but does *not*
reassign the source handle's `#state`; the caller forks a derived handle via `deriveGroup` while the
source stays live and reusable (the suite authors two alternate commits off one base handle).
ts-mls's `createCommit` `consumed` alias into the *still-live* source secret tree — zeroing them
corrupts the source and the next commit off it fails with `aes/gcm: invalid ghash tag`. Those secrets
are not retired; they belong to the live source and are collected with it by GC when the handle is
dropped. There is no safe eager-wipe point on a fork, because the library never observes when the
source handle is truly done. So the fork path keeps ts-mls's `consumed` unwiped by design.

### 3. `encrypt` returns framed `Uint8Array`

```ts
async encrypt(plaintext: Uint8Array): Promise<Uint8Array>
```

Returns wire-framed bytes via the same `mlsMessageEncoder`/`encode` path every other producer uses,
inside `mutexFor(this).run(…)` (§1), with `consumed` zeroed internally (§2). No pre-encode object, no `consumed`
in the return. A peer decrypts the bytes through `processMessage`.

### 4. Consolidate the receive path on `processMessage`; remove `decrypt`

`decrypt` is deleted. `processMessage` is the single receive path, unchanged in signature:

```ts
async processMessage(message: Uint8Array | unknown, opts?): Promise<Uint8Array | null>
//  application message  -> plaintext Uint8Array
//  accepted handshake   -> null   (state advanced, ledger entries folded)
//  rejected commit      -> throws CommitRejectedError (state unchanged)
```

This erases the mutate-then-throw bug outright — there is no
`'Expected application message…'` path left — and the receive-path duplication. `processMessage`
already applies accepted commits correctly and throws `CommitRejectedError` on reject; wrapping its
body in `mutexFor(this).run(…)` (§1) and zeroing `consumed` (§2) is the only change to it.

## Testing

- **No corruption under interleaving.** Fire N `encrypt`s and a `processMessage` concurrently on one
  handle (without awaiting between them); assert every ciphertext decrypts on a peer and the epoch
  chain is consistent — the pre-change code reuses a secret-tree generation.
- **Commit via `processMessage` returns `null`, state advances.** The old `decrypt` mutate-then-throw
  case: a received commit yields `null`, the epoch moves, the roster folds — no throw.
- **Rejected commit leaves state untouched** and throws `CommitRejectedError` (regression guard for
  the chain-hygiene continuation — the next op still runs).
- **`consumed` is zeroed.** After `encrypt` and after a commit producer, assert the retired buffers
  read as zero (spy/wrap the ts-mls call, or assert on a captured reference).
- **`encrypt` round-trips.** `encrypt` output on Alice decodes to the plaintext via `processMessage`
  on Bob.
- **FIFO order.** Two producers enqueued in order observe successive epochs, never reordered.

## Scope

- **Production:** `packages/mls/src/group.ts` only.
- **Tests:** `packages/mls/test/group.test.ts` (+ any concurrency helper).
- **No other kumiai package** changes — nothing internal depends on `encrypt`/`decrypt` shape.

## Migration impact (kubun)

Fold into the existing migration item
(`kubun/docs/agents/plans/next/2026-07-11-mls-permission-enforcement-migration.md`). `mls-codec.ts`:

- `mlsEncryptFramed`: `encrypt` now returns framed `Uint8Array` directly — drop the JSON
  `replacer`/`stringify` framing and the `consumed` field on `MLSEncryptFramedResult`. (This changes
  the bytes kubun puts on the wire from its JSON codec to the MLS wire format — kubun owns that
  transition.)
- `mlsDecryptFramed`: `handle.decrypt(...)` becomes `handle.processMessage(...)`, and
  `anchorImmutabilityPolicy` is already being removed by the permission migration — a `null` return
  now means "an accepted handshake", which the caller must handle rather than treating every return
  as plaintext.

Both edits land in the same version bump as the permission change, so `mls-codec.ts` migrates once.

## Follow-up (out of scope, stack architecture)

The FIFO serialization primitive is generic — a `Mutex`/`Serializer` with `run(fn): Promise<T>`,
FIFO, rejection-isolated — and belongs in `@sozai/async` for reuse across the stack (hub, rpc, and
anything doing read-`await`-write on shared state). It is **not** done here: extracting it upstream
means a `@sozai` change, publish, and version bump before kumiai could consume it — coordination this
crypto-hygiene fix should not wait on. To make the later swap mechanical, the inline implementation is
shaped as a small `Mutex` object exposing `run(fn)` (not a raw promise-chain inlined across the
methods), with a module-private `WeakMap<GroupHandle, Mutex>` holding one per handle. When
`@sozai/async` gains the primitive, kumiai drops the inline `Mutex` and keeps only the `WeakMap` glue.
Record the extraction as a `@sozai` backlog item.

## Non-goals

- No public getter becomes async.
- No change to the free constructors' signatures (`createGroup`/`processWelcome`/`restoreGroup`/
  `joinGroupExternal`).
- The remaining `mls-api-hardening` backlog items (persistence-hook rename, ts-mls message union,
  commit-policy `reject` ergonomics) are out of scope — separate, lower-priority, non-blocking.
