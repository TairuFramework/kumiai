# Host handle access for `@kumiai/mls-rpc`

**Status:** design approved 2026-09-25 (decisions below). This spec does not implement production changes.
**Release:** the coordinated 0.10 minor band. Durable app delivery (#49) and input typing (#50) are on main.

## Verified starting point

Paths in this table are relative to kumiai unless prefixed `kubun/` (the sibling checkout at `/Users/paul/dev/yulsi/kubun`). Each line cites current source, not the older plan's assertion.

| Premise from the item | Verdict | Evidence and correction |
| --- | --- | --- |
| Both factories require a synchronous mutable handle. | True | `packages/mls-rpc/src/mls.ts:72-90,132-134` and `packages/mls-rpc/src/crypto.ts:51-69,99-103`. The crypto factory requires only `handle`; `adopt` and `persist` are MLS-factory inputs. |
| Received commits mutate the current handle in place; authored and recovery commits install a new handle. | True | `packages/mls-rpc/src/mls.ts:112-117,172-199,252-268`; `packages/mls/src/group-handle.ts:1322-1332`. |
| Kubun only exposes locked, async handle access. | True | `kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:174-206,347-373`. `readHandle` and `withHandle` are async. The registry deliberately exposes only a scalar epoch synchronously (`:534-550`). |
| Kubun restores a working handle inside the commit transaction and swaps only on commit. | True, with nuance | `kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:320-339,347-373`. The cache is invalidated on commit, then restored on the next access; it is not directly swapped to the working handle. |
| The lock holder never waits on the database. | Changed | Ordinary registry operations release their mutex before ordered persistence (`kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:389-474`). Commit apply explicitly holds the lock across its transaction (`:320-373`), an acknowledged exception. The durable-open callback still waits on storage under the MLS mutex (`packages/mls/src/group-handle.ts:892-932`; `packages/mls-rpc/src/crypto.ts:155-169`). |
| Host writes must share the commit transaction. | True | Kubun writes member and role rows, status, and ledger fold inside `withHandleReplacingInTransaction` (`kubun/packages/plugin-p2p/src/groups/group-mls.ts:249-253,290-297,339-475`), then emits after commit (`:506-545`). Current `mls-rpc.processCommit` returns only `advanced` (`packages/mls-rpc/src/mls.ts:168-200`). |
| The host needs roster before/after, old ledger length, and surfaced entries. | True | Kubun captures these around apply and from its handle callback (`kubun/packages/plugin-p2p/src/groups/group-mls.ts:229-233,290-297,325-334,464-489`). `GroupHandle.ledger` preserves ordered repeats (`packages/mls/src/group-handle.ts:397-409`). |
| Kubun duplicates frame epoch and entry sealing. | True | `kubun/packages/plugin-p2p/src/groups/group-crypto.ts:173-214` duplicates `packages/mls-rpc/src/crypto.ts:118-153,179-183`. Its exporter reads `state.keySchedule.exporterSecret` directly (`kubun/packages/plugin-p2p/src/groups/group-crypto.ts:76-103`), while `GroupHandle.exportSecret` already exposes the needed call (`packages/mls/src/group-handle.ts:785-801`). |
| Kubun duplicates recovery pending, read helpers, and error-to-null ledger opening. | True | `kubun/packages/plugin-p2p/src/groups/group-mls.ts:112-133,559-714` and `packages/mls-rpc/src/mls.ts:133-145,202-299` have the same duties. Kubun also does a projection rebuild after bootstrap (`kubun/packages/plugin-p2p/src/groups/group-mls.ts:716-753`). |
| Kubun has no durable-open counterpart. | Changed | Kubun's present `unwrap` uses `readHandle` and ordinary decrypt (`kubun/packages/plugin-p2p/src/groups/group-crypto.ts:131-163`). Durable delivery introduced `pending.persistOpened` only in kumiai (`packages/mls-rpc/src/crypto.ts:64-69,155-169`), so adopting it is additional Kubun work, not merely deleting a copy. |
| `processCommit` accepts any MLS message and answers false for a Proposal. | True for an accepted Proposal | `packages/mls-rpc/src/mls.ts:172-199` passes bytes unfiltered. `GroupHandle.processMessage` accepts proposals and persists their pending state (`packages/mls/src/group-handle.ts:1297-1305,1322-1369`). Kubun rejects non-Commit bytes using `readCommitHeader` (`kubun/packages/plugin-p2p/src/groups/group-mls.ts:269-285`). |
| A Proposal on the commit topic can alter the next commit. | True: correctness bug | `packages/mls-rpc/test/commit-topic-proposal.test.ts` uses real MLS. An Update Proposal enters `unappliedProposals` while the port reports no advance. `commitWithEntries` includes pending proposals (`packages/mls/src/group-commit.ts:236-273`). A peer missing the Proposal cannot apply the next Commit; giving it the Proposal first succeeds. File a separate 0.10 fix: reject non-Commit bytes before `processMessage`. The policy already rejects a non-admin control-extension Proposal (`packages/mls/src/policy.ts:251-256`). |
| Recovery secrets from the two implementations agree. | False | `mls-rpc` runs a KDF over encoded genesis anchor (`packages/mls-rpc/src/mls.ts:307-317`). Kubun returns the random 32-byte seed in the anchor app slot (`kubun/packages/plugin-p2p/src/groups/group-mls.ts:757-767`; `kubun/packages/plugin-p2p/src/groups/manager.ts:429-440`). They name different rendezvous topics. |
| The proposed three access methods suffice. | False | `GroupCrypto.epoch()` is synchronous (`packages/rpc/src/crypto.ts:34-35`); Kubun uses `groupEpoch() ?? initialEpoch` (`kubun/packages/plugin-p2p/src/groups/group-crypto.ts:106-110`). Also, a resolver that calls `access.read` from inside `access.mutate` can self-deadlock: `GroupHandle.exportSecret` is intentionally lock-free for in-apply reads (`packages/mls/src/group-handle.ts:785-792`), while Kubun `readHandle` locks (`kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:200-206`). |
| `processMessage` and `processWelcome` have effectively unknown inputs. | True | `packages/mls/src/group-handle.ts:1297-1313` and `packages/mls/src/group-welcome.ts:30-36` both use `Uint8Array | unknown`. Fixed on main by #50. |
| The release is already in the 0.10 minor band. | True | `packages/mls-rpc/package.json:3` is `0.9.0`; `.changeset/durable-app-delivery.md:1-15` schedules all twelve packages as minor. `docs/agents/plans/milestones/v0.10-release.md` includes this item after durable delivery. |

## Public API

The basic port must cover the synchronous epoch query and distinguish read, mutation, replacement, and durable open. The following is the proposed exact TypeScript surface. Generic method names and array spellings follow repository conventions.

```ts
import type { GroupHandle } from '@kumiai/mls'
import type { PendingAppFrame } from '@kumiai/rpc'

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
```

`read` gives a handle only for the callback's lifetime. `mutate` serialises with every other operation and resolves after persistence. Its `persist` argument is passed to `GroupHandle.processMessage` and `bootstrapLedger`, retaining their rollback-on-save-failure semantics. For ordinary `encrypt` and `decrypt`, the adapter saves the post-operation state. `replace` persists before publishing the new handle. A transactional adapter works on a fresh restored handle; it discards that handle on rollback and publishes only on commit. It may use a no-op `persist` callback within the transaction, then write the final handle and host rows before commit. A simple adapter uses the supplied `persist` hook at the library boundary and must avoid writing the same state twice.

`epoch` is a host-published scalar **hint**, never an unlocked handle and never a basis for a decision (see "Epoch reads"). The adapter publishes it only after the outermost successful commit, and may take an initial value before first restore. `simpleHandleAccess` seeds the scalar from `handle().epoch` and updates it after successful mutation or replacement, so `epoch()` cannot see a tentative in-place advance. The port requires a single access instance shared by `createGroupMLS({ access, identity, entrySlot })` and `createGroupCrypto({ access, entryLabel?, runtime?, pending? })`.

`open` is a distinct operation because the pending record and consumed MLS state form one transaction. `fn` calls `handle.decryptStaged` and forwards its staged callback to `persistOpened`. The simple adapter passes the provided store callback through. A transactional adapter gives `fn` an isolated working handle and captures the staged state and record without database I/O in that callback. It then writes both atomically, with a state revision guard, before publishing the working handle. It retries from a fresh handle on a revision conflict. The adapter may implement this with a short host lock to capture a revision and a conditional database write outside that lock. It must not expose the working handle while the write is pending. A duplicate frame ID must reuse its pending record or return a retryable storage fault without consuming the key twice. This operation needs implementation proof against the real registry before declaring Kubun adoption complete.

`pending` becomes `{ persistOpened, list, complete }` as today, but `createGroupCrypto` invokes the callback through `access.open`. The `open` callback receives the encoded post-open `ClientState`; it does not need a live `GroupHandle`. `list` and `complete` remain store operations outside handle access. `AppFrameStorageError` wraps only the atomic save fault. An MLS open or AAD failure retains its original error. Both pending and non-pending `unwrap` use `access.open` or `access.mutate` respectively; `wrap` uses `mutate`. `frameEpoch` and `frameAAD` remain total byte readers outside the port. `exportSecret`, entry-key derivation, and all other handle reads use `read`.

### Durable save ordering

**Recommendation: stage, then conditionally commit.** Merely routing the current `persistOpened` callback through `access.mutate` still awaits database I/O inside `decryptStaged`'s handle mutex. It also risks a registry mutex to database lock-order cycle. The transaction adapter must persist `(stagedState, record)` in one write, ordered after earlier handle saves. The state row needs a monotonically increasing revision within an epoch, not only an epoch guard: later app opens at the same epoch consume additional ratchet generations. Reject an older revision even when its epoch matches. Do not use an ordinary stale `GroupHandle` swap after the write. The host's ordered save queue and conditional row update are part of this port's contract, not a `pending` implementation detail. This preserves the durable-delivery contract in `packages/mls-rpc/README.md:37-66` and the staged-state guarantee in `packages/mls/src/group-handle.ts:892-932`.

### Epoch reads

A probe against Kubun (real KubunDB and SQLite) showed the scalar cannot be exact. The received-commit transaction publishes in its commit hook, so rollback leaves the scalar unchanged. `withHandle`, `withHandleReplacing` and `replaceHandle` publish after an ordered persist outside the mutex: the scalar lags the handle, and inside an outer transaction it runs ahead of the committed row and stays ahead after rollback. The commit hook runs after the database commit, and a second connection or process never updates the map. Making `epoch()` asynchronous does not help: every read changes, four synchronous sites need redesign (the two constructor seeds, the pushed-frame `note` callback, `retainOnFailure`), and a read is still not atomic with the next handle operation.

The deeper cause is in `@kumiai/rpc`: the commit mutex and the app-lane mutex are not the host's handle lock, so even an exact read can go stale before the awaited handle operation. The rule for this release:

- `epoch()` stays synchronous. Only fast paths and diagnostics read it: the constructor seeds, the unknown-version classifier inputs (`peer.ts:1448,1487`), and error messages.
- Every decision takes its epoch from a port result computed under the handle lock (`access.read` or `access.mutate`). The port result carries the epoch it acted at, and `@kumiai/rpc` decides from that value:
  - commit classification and the cursor advance (`peer.ts:1532,1604`): `applyCommit` compares the frame epoch under the lock and returns `epochBefore` and `epochAfter`; a mismatch returns a disposition, not an advance, so the peer reclassifies instead of moving its cursor past an applicable commit;
  - advance baselines and repair (`peer.ts:1348,1363,1376,1681,1689,2382,2395`): use `epochBefore` / `epochAfter` from the port result, not two scalar reads;
  - app-frame drain and staging (`app-lane.ts:589,617,620`, `peer.ts:648`): `unwrap` checks the frame epoch against the locked handle and reports past or future distinctly; the lane marks a frame `done` only on a locked "past" answer and retains on "future";
  - anchor capture (`peer.ts:618`): the secret export returns the epoch it was exported at;
  - sealing, replay and journal (`peer.ts:1809,1858,2118`): the seal returns the epoch it sealed at, and the journal records that value;
  - runtime rebuild (`peer.ts:777`): seed from the hint, then correct from the first locked result.
- The constructor seeds (`peer.ts:544,572`) may start from the hint because the first locked result corrects them.

A host adapter must publish the scalar only from the outermost successful commit, restore it on rollback, and publish only after the store confirms it adopted the offered state. The contract suites test that a decision never follows a stale or ahead scalar: a double whose `epoch()` lies in either direction must not change any disposition.

## Commit core and shell

```ts
import type { GroupHandle, VerifiedLedgerEntry } from '@kumiai/mls'
import type { CommitContext, RosterEntry } from '@kumiai/rpc'

export type ApplyCommitContext = CommitContext & { entrySlot: LedgerEntrySlot; ownDID: string }
export type ApplyCommitResult = {
  advanced: boolean
  rosterBefore: Array<RosterEntry>
  rosterAfter: Array<RosterEntry>
  surfacedEntries: Array<VerifiedLedgerEntry>
  ledgerLengthBefore: number
  committerDID?: string
}
export function applyCommit(
  handle: GroupHandle,
  commit: Uint8Array,
  context: ApplyCommitContext,
  persist?: (handle: GroupHandle) => Promise<void>,
): Promise<ApplyCommitResult>
```

`applyCommit` first compares `readMessageEpoch(commit)` with `handle.epoch` and asks `handle.readCommitHeader(commit)`. A non-Commit returns `advanced: false` without passing bytes to `processMessage`. A mismatched epoch or own authenticated commit also returns false. No resolver or state mutation runs on those paths. The result's rosters map `listMembers()` to `{ did, leafIndex, longForm }`; the old ledger length is captured before process. The `entrySlot` installs this frame's resolver in `try/finally`. It derives `surfacedEntries` from the new ledger suffix, excluding `kumiai.*` control entries, exactly as `foldEnvelope` does (`packages/mls/src/envelope-fold.ts:79-119`). This preserves repeated entries. The post-commit roster and `advanced` reflect the actual handle epoch. For a refused or ignored frame, the before and after snapshots are equal and `surfacedEntries` is empty.

Error mapping is centralised here: `MissingLedgerEntriesError` propagates unchanged so the lane classifies poison; a persist or transaction failure propagates unchanged for retry; `CommitRejectedError` and malformed/unauthentic MLS commit errors return `advanced: false` if no durable advance occurred. A host callback that throws *after* durable acceptance reports the observed advance, as current `processCommit` does (`packages/mls-rpc/src/mls.ts:189-199`); it must not cause replay of an accepted commit. `processCommit` returns only `{ advanced }` to `@kumiai/rpc` and delegates its mutation to `access.mutate((handle, persist) => applyCommit(..., persist))`. The host may instead call `applyCommit` inside its own handle, MLS-state, roster, member-row, role, and ledger transaction, then emit after commit. The host owns rollback of both state and projection writes.

A frame resolver that opens entries by calling `GroupCrypto.openEntries` may re-enter the same access lock during `applyCommit`. The shell must prepare the frame's sealed entries outside `mutate` and pass a non-locking, in-memory resolver inside it, after checking the frame epoch and Commit type. The current `CommitContext.resolveLedgerEntries(ids)` contract does not promise an all-entries response for `ids=[]`; the implementation must extract requested IDs from the commit envelope, or add an explicit pre-resolution hook. The transaction then re-verifies every token by digest and signature. Do not solve this by making `GroupHandle.exportSecret` acquire its own mutex: it is deliberately lock-free for the pre-commit exporter read.

`applyCommit` accepts `Uint8Array`, matching the RPC port. `GroupHandle.processMessage` accepted `Uint8Array | unknown`; #50 narrowed it to `Uint8Array | MlsFramedMessage`.

## Other routing

- `rosterEntries`, `readCommitHeader`, `createRecoveryRequest`, `sealGroupInfo`, `applyRecovery`'s open and rejoin preparation, `isLedgerComplete`, `getLedger`, `sealLedger`, `openSealedLedger`, and `exportRecoverySecret` use `access.read`.
- `applyRecovery.onAccepted` uses `access.replace(rejoined.group)` once hub acceptance is durable; it clears the pending private key only after replacement succeeds. A repeated acceptance must be safe.
- `bootstrapLedger` uses `access.mutate` and forwards its persist hook to `handle.bootstrapLedger`. A Kubun projection rebuild remains a host operation after the install and may need its own transaction; it is not a generic MLS port side effect.
- `GroupCrypto.wrap` and non-durable `unwrap` use `access.mutate`, since both advance message ratchets. Durable `unwrap` uses `access.open`. `exportSecret`, `sealEntries`, and `openEntries` derive a key through `access.read` and do the byte operation after releasing the handle.
- `frameEpoch` and `frameAAD` use the total `@kumiai/mls` byte readers. `epoch` uses `access.epoch`.

## Standalone exports and recovery choice

Export these from `@kumiai/mls-rpc` and use them in its factories; none should read or retain a global handle:

```ts
export function deriveEntryKey(handle: GroupHandle, label?: string): Promise<Uint8Array>
export function sealEntries(key: Uint8Array, entries: Uint8Array, runtime?: Runtime): Uint8Array
export function openEntries(key: Uint8Array, sealed: Uint8Array): Uint8Array
export type RecoveryPending = {
  get(requestID: string): Uint8Array | null
  put(requestID: string, ephemeralPrivateKey: Uint8Array): void
  delete(requestID: string): void
}
export function createRecoveryPending(options?: { ttlMS?: number }): RecoveryPending
export function deriveRecoverySecret(handle: GroupHandle): Promise<Uint8Array>
```

`deriveEntryKey` calls `handle.exportSecret(label ?? ENTRY_SEAL_LABEL, new Uint8Array(), 32)`. `sealEntries` and `openEntries` retain version 1, 24-byte nonce, XChaCha20-Poly1305, and the existing errors. The factory wipes derived keys in `finally`; a standalone caller owns wiping its key. `createRecoveryPending` is stateful, despite being a standalone export: it sweeps expired requests, zeroes replaced/deleted private keys, arms an unref timer, and defaults to 120,000 ms. `createGroupMLS` uses it. These exports remove Kubun's byte copies and pending map, while Kubun keeps its transaction and event work.

**Recommendation: keep the anchor KDF as the default for groups already using `mls-rpc`, with an explicit `recoverySecret?: (handle: GroupHandle) => Promise<Uint8Array>` host override for Kubun.** A random seed in the anchor app slot is not derivable from the generic anchor alone. Silently changing the default strands existing `mls-rpc` groups on a different rendezvous topic. Kubun must pass an override that reads and validates its seed. A newly created group with the seed and a generic peer can interoperate only when both configure the same choice; the choice is per group and must survive restore. Do not try both topics silently: that changes rendezvous visibility and makes failures hard to diagnose. A later explicit migration needs a coordinated group-wide switch and cursor treatment; this release should preserve each group's existing derivation.

## Conformance, migration, and release note

Run both `rpc-conformance` suites against `mls-rpc` using `simpleHandleAccess`. Add a transactional test adapter that restores a fresh handle for every mutation, writes a staged state and pending record atomically, discards the working handle on failure, and swaps or invalidates cache only on commit. Run the same suites against that adapter, including the optional durable-pending clauses. Also run the suites against doubles, because a port change can hide a false answer there. Add focused tests for non-Commit refusal, resolver non-reentrancy, persisted same-epoch open ordering, transaction rollback, and post-persist callback error mapping. Run `hub-conformance` after any shared-port change, per the repository gate.

Single-handle migration:

```ts
const access = simpleHandleAccess({ handle: () => handle, adopt: (next) => { handle = next }, persist })
```

Pass this **same** `access` to both factories in place of their old handle/adopt/persist properties. This is one adapter-construction line, plus the parameter substitutions at the two call sites. Keep the existing ledger-entry slot on each handle's construction path.

Add one changeset for `@kumiai/mls-rpc` and `@kumiai/rpc-conformance` as `minor` within the pending 0.10 band. The migration section must show the adapter line, note the synchronous `epoch` and durable `open` obligations for custom hosts, and distinguish the recovery override. Do not add a second minor for packages already listed in the pending 0.10 changesets; coordinate the release notes across all twelve packages. The Proposal rejection is a separate correctness fix and test for this same release.

## Decisions (approved 2026-09-25)

1. **How should the access port expose the synchronous epoch?** Options: `epoch()` scalar snapshot; make the RPC port asynchronous. Decided: a synchronous scalar **hint**, with every decision re-checked from a locked port result (see "Epoch reads"). A Kubun probe showed the scalar can lag and run ahead; an async port changes every read and is still not atomic.
2. **How should durable opens cross the host/store boundary?** Options: route the existing callback through `mutate`; stage on an isolated handle, conditionally persist state plus record, then publish. Decided: stage then commit. The former keeps database I/O under the MLS mutex and cannot meet Kubun's normal lock order.
3. **What revision guards same-epoch state?** Options: compare only epoch; use a per-group monotonically increasing state revision and conditional update. Decided: revision. App opens change the secret tree without changing the epoch.
4. **How should commit-frame entry resolution avoid re-entering access?** Options: extract envelope IDs and resolve before mutation; require a re-entrant adapter; change `CommitContext` to carry pre-opened entries. Decided: pre-resolve the requested IDs outside the lock and re-verify inside. Preserve the port's no-blob-open rule for a wrong-epoch or non-Commit frame.
5. **Which recovery secret names a group's rendezvous topic?** Options: replace the default with the random anchor seed; retain the anchor KDF and allow a host override. Decided: the latter. Existing groups remain reachable, and Kubun keeps its current seed without a hidden migration.
6. **How should a host obtain surfaced entries for its transaction?** Options: use the newly appended ledger suffix; add a per-operation `onLedgerEntries` callback. Decided: the suffix for 0.10. `foldEnvelope` surfaces exactly its non-`kumiai.*` entries, while the suffix preserves repeats and requires no new handle wiring.
7. **Should input typing be included here?** Options: merge the separate `feat/mls-input-typing` branch first and use its type; implement it in this branch. Done: merged first as #50 (`MlsFramedMessage`); `applyCommit` takes `Uint8Array`.
