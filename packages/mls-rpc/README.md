# @kumiai/mls-rpc

The two consumer ports of `@kumiai/rpc` — `GroupCrypto` and `GroupMLS` — implemented over a live
`@kumiai/mls` `GroupHandle`. This is what a host wires when it wants group RPC over real MLS.

## Why it is its own package

`@kumiai/rpc` does not depend on `@kumiai/mls` and must not: it owns transport and orchestration,
and the two ports exist precisely so the consumer supplies the crypto half. `@kumiai/mls` does not
depend on `@kumiai/rpc` either — a crypto core that imported an RPC package's types would invert
the stack. So the implementation of one package's ports over the other's handle belongs above both.

It is a real implementation, not a fixture. Until it existed, both ports had exactly one
implementation apiece — a test double — and nothing had ever run them against MLS. This is also the
only place a compiler checks the two contracts against each other, and the only package that may
depend on both.

## Exports

- `simpleHandleAccess({ handle, adopt, persist? })` — serialised access to a live handle; the
  `HandleAccess` type for a host that brings its own.
- `createGroupCrypto({ access, entryLabel?, runtime?, pending? })` — `GroupCrypto` over that access.
- `createGroupMLS({ access, identity, entrySlot, recoverySecret? })` — `GroupMLS` over the same
  access.
- `applyCommit(handle, commit, context, persist?)` — apply a received Commit inside the host's own
  transaction (see below).
- `createLedgerEntrySlot()` — the per-commit ledger-entry resolver seam (see below).
- `deriveEntryKey`, `sealEntries`, `openEntries`, `ENTRY_SEAL_LABEL` — the ledger-entry seal.
- `createRecoveryPending`, `deriveRecoverySecret`, `RECOVERY_LABEL` — recovery request keys and the
  default recovery secret.

## Share one access instance

Both factories take the same `access` instance. The adapter reads the current handle through
`handle: () => GroupHandle`, because authored commits and recovery replace it wholesale. A host
adopts an authored commit through `access.replace(next)` after acceptance. The adapter saves before
publishing the replacement and publishes its synchronous epoch hint after a successful save.

For a *received* commit there is nothing to adopt: ts-mls's `processMessage` advances the handle in
place. A host that treated every commit as adopt-later would double-apply received ones.

Migrating from 0.9: build one adapter from the old `handle` / `adopt` / `persist` parameters and pass
it to both factories in their place.

```ts
const access = simpleHandleAccess({ handle: () => handle, adopt, persist })
const crypto = createGroupCrypto({ access, pending })
const mls = createGroupMLS({ access, identity, entrySlot })
```

### A host's own `HandleAccess`

A host with its own handle store implements the port instead:

- `read(fn)` lends the handle for the callback only. `mutate(fn)` serialises with every other
  operation and resolves after the state is stored; `fn`'s `persist` argument goes to
  `processMessage` and `bootstrapLedger`. `replace(next)` stores before publishing. A transactional
  host may restore a fresh handle per mutation, discard it on rollback, and publish on commit.
- `epoch()` is a synchronous hint. Publish it only after the outermost successful commit, and restore
  it on rollback. No port decision reads it: every one uses an epoch read under the lock.
- `open(fn, persistOpened)` is the durable open. `fn` stages the open and hands its state and record
  to the callback it is given. A host may capture them, release its lock, and then call
  `persistOpened` to write both in one transaction guarded by the state row's revision, publishing
  the working handle only after that commits, and only if no newer write was published meanwhile.
  On a revision conflict it retries from a fresh handle. Faults from `persistOpened`, and faults the
  adapter raises around `fn`, come back as `AppFrameStorageError`, which the lane retries.

## Durable logged app delivery

Pass a `pending` adapter to `createGroupCrypto` to opt in. Its `persistOpened(stagedState, record)`
must write the encoded post-open `ClientState` as the group's handle state **and** insert the
`PendingAppFrame` in one atomic transaction. `list()` returns all uncompleted records after a
restart, ordered by `(frame.segment, frame.position)` by this port. `complete(id)` clears one
record and resolves for an unknown id. Deduplicate inserts by `record.frame.id`.

```ts
const access = simpleHandleAccess({
  handle: () => handle,
  adopt: (next) => { handle = next },
  persist: (current) => store.save(current),
})
const crypto = createGroupCrypto({
  access,
  pending: {
    persistOpened: async (stagedState, record) => {
      await store.transaction(async (tx) => {
        await tx.saveHandleState(groupID, stagedState)
        await tx.insertPendingIfAbsent(record.frame.id, record)
      })
    },
    list: () => store.listPending(groupID),
    complete: (id) => store.completePending(id),
  },
})
```

The example's `saveHandleState` must also enforce the host's save ordering and same-epoch
monotonic version rule. Saves issued before `persistOpened` must finish before it; a delayed
older state at the same epoch must be rejected. `persistOpened` runs under the handle mutex and
the peer's commit mutex: it must not call either object. Never hold a transaction or the sole
database connection while awaiting a peer or handle call; a handler should commit its own
transaction before awaiting `commit()` or `dispatch()`. A single-connection host that reverses
this order can deadlock. Hosts adopting this in Kubun must first remove transaction-then-registry
waits on paths overlapping app opens and prove the lock order against SQLite.

With `pending`, `unwrap(bytes, { expectedAAD, frame })` calls `GroupHandle.decryptStaged` and
resolves only after the atomic write. A persistence failure becomes `AppFrameStorageError` for
the RPC lane to retry; an unopenable frame is classified dead. Without `pending`, the adapter saves
the post-open ratchet state without a pending record, so a crash after `unwrap` and before the
handler finishes loses that frame: `pending` is the at-least-once path. `frameAAD(bytes)` exposes
the cleartext AAD as a routing hint. The full `expectedAAD` on open authenticates it.
The 0.10 app AAD carries version and log intent. Older bare-topic app frames cannot interoperate
with 0.10 peers. See the `@kumiai/rpc` README for the delivery and retention boundary.

## `createLedgerEntrySlot` is mandatory, and must be installed where the handle is built

`GroupMLS.processCommit` is handed a `resolveLedgerEntries` scoped to **one** commit's frame — the
signed ledger-entry bodies ride that frame and nowhere else. But `GroupHandle` takes its resolver
once, in `GroupOptions`, and offers no way to change it afterwards. So the indirection has to be
installed when the group is *built*:

```ts
import { createGroupCrypto, createGroupMLS, createLedgerEntrySlot, simpleHandleAccess } from '@kumiai/mls-rpc'

const entrySlot = createLedgerEntrySlot()
// Every construction site: createGroup / processWelcome / restoreGroup.
const { group } = await createGroup(identity, groupID, {
  resolveLedgerEntries: entrySlot.resolve,
})

let handle = group
const access = simpleHandleAccess({
  handle: () => handle,
  adopt: (next) => { handle = next },
  persist: (current) => store.save(current),
})
const crypto = createGroupCrypto({ access })
const mls = createGroupMLS({
  access,
  identity,
  entrySlot,
})
```

Passing anything else means a commit resolves its entries against whatever resolver the handle
happened to be born with.

The optional adapter `persist` callback receives the tentative state after an accepted commit,
the bootstrapped handle, or an ordinary ratchet operation. Writes must
be atomic: rejection must leave storage unchanged, since the in-memory handle rolls back and no
control notifications fire. Received-message and bootstrap persist runs under the handle mutex;
it must not call back into that handle. Recovery persists the rejoined handle before adoption. If
adoption throws, storage already holds the new handle and a restart loads it.

## Applying a commit inside a host transaction

`processCommit` is `applyCommit` inside `access.mutate`, plus entry resolution before the lock. A host
that projects commits into its own tables calls `applyCommit` inside its own transaction instead, from
its own `GroupMLS.processCommit`, so the peer still sees each result and rotates its anchor:

```ts
const result = await applyCommit(handle, commit, {
  senderDID,
  resolveLedgerEntries: (ids) => resolved(ids), // must not take the handle lock
  entrySlot,
  ownDID: identity.id,
}, persist)
if (result.applied) {
  // write result.rosterAfter, result.surfacedEntries, ... and commit
}
```

It refuses non-Commit bytes, a frame at another epoch, and this member's own authenticated commit
before any resolver or mutation runs. `applied` means the handle took the commit's state; `advanced`
means the epoch moved. A commit removing this member is applied without advancing. The result
carries both rosters, the ledger length before, the committer, and the verified non-`kumiai.*`
entries the commit appended, repeats kept. `MissingLedgerEntriesError` and store faults propagate.

## Recovery secret

`exportRecoverySecret` defaults to `deriveRecoverySecret`, the anchor KDF. A host whose groups
already rendezvous on another secret passes `recoverySecret: (handle) => ...` for every restore of
those groups: both the commit and the rendezvous topic follow it. A result under 16 bytes or a throw
is refused; the default is never tried as a fallback.

## Two seals, one exporter

`wrap`/`unwrap` carry app traffic and are ratchet-backed: each open consumes a message key and
mutates the handle. `sealEntries`/`openEntries` carry a commit's ledger-entry blob under a key
exported from the epoch, so opening is **pure** and may run from inside the apply of the commit that
carries it — which is the only place it does run, and which the ratchet-backed pair cannot serve.
The two use different exporter labels deliberately: the topic secret names a topic and is handed to
anything that derives one, while the entry key opens the group's control-ledger bodies.

The sealed blob is `[ VERSION(1) | NONCE(24) | CIPHERTEXT ]`, XChaCha20-Poly1305. The version byte
sits inside the blob rather than in the frame header so that an unknown version fails the *open* —
survivable, the commit is filed as poison and stepped over — rather than the *decode*, which would
leave a peer stepping over frames without ever classifying one and never learning the group moved on.

## Where this diverges from the doubles

Documented on the factories themselves; the conformance suite in `@kumiai/rpc-conformance` pins each
one. The ones a host is most likely to trip on:

- **`unwrap` opens only at the current epoch.** A readable frame at any other epoch throws
  `FrameEpochError` before decryption, under the handle lock. ts-mls could open a few past epochs,
  but `GroupHandle.decrypt` resolves senders at the current epoch, so such a frame never had a
  sender.
- **`exportSecret` derives from MLS exporter state.** The fake uses HMAC to model epoch separation,
  while the real port derives from the handle's exporter secret.
- **`wrap` mutates.** It consumes a per-message ratchet key, so sealing the same plaintext twice
  gives different bytes.
- **`exportRecoverySecret` is derived from the group's genesis anchor, which is public.** MLS has no
  lifelong group secret, so there is nothing confidential and epoch-independent to derive it from.
  Anyone who has seen a `GroupInfo` for the group can compute the rendezvous topic. That is tolerable
  for what the topic is for — a stranded peer, and a removed one, must both be able to name it — but
  a host must put nothing on it that confidentiality depends on.
