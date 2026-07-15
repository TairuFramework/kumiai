# Host requirement: a committer reader for `readCommitHeader`

**Priority:** 1 — blocks kubun's adoption of the 0.3.0 control-ledger lane at the first method it must implement. Nothing in `plugin-p2p` compiles past it.
**Origin:** kubun's control-plane-on-commits work (kubun `feat/peer-connect-abstraction`, 2026-07-15), adopting `@kumiai/*` 0.3.0. kubun is the first host to drive the pull-commit lane against real MLS, and it hits this at `GroupMLS.readCommitHeader`.

## Context

`@kumiai/rpc` 0.3.0 makes every host implement `GroupMLS`, and the pull lane calls `readCommitHeader` on every frame it reads from the commit log *before* deciding what to do with it (`peer.ts` → `classifyCommit`):

```ts
readCommitHeader(commit: Uint8Array): CommitHeader | null   // { epoch, committerDID }
```

The lane's `classify` turns on the header. Epoch decides applicability; **`committerDID` decides authorship** — an `own-unmerged` frame (this peer's own commit, which MLS merges and never processes) is `{ advanced: false }`, and the heal-on-losing-branch rule fires only for a peer's *own* authored commit, which is what stops one well-formed commit from a member (or a removed member) sending every honest peer into a recovery storm at once. The committer must be the one MLS authenticated, not the frame's transport sender (the hub's word).

That contract is not implementable for a real MLS host as written.

- Host handshake commits are **PrivateMessages** (kubun builds them with `commitInvite` / `removeMember` / `commitLedgerEntries`, none passing `publicMessage`). The committer's sender-leaf is encrypted under the epoch's `senderDataSecret`; it is **not in the commit bytes**. `readMessageEpoch` works because the epoch rides the cleartext wire header — the committer does not.
- The signature is **synchronous and handle-less**, and its doc says "WITHOUT applying or opening anything." But recovering the committer needs the epoch secret to decrypt sender-data, and then the ratchet tree to map the sender leaf index to a DID. Both live on the `GroupHandle`, which a host reaches only asynchronously (behind its per-group mutex). Even a PublicMessage commit, whose sender leaf *is* in the clear, still needs the tree for leaf→DID — so no host can answer `committerDID` from bytes alone.
- The in-memory reference (`packages/rpc/test/fixtures/memory-group-mls.ts`) satisfies the contract only because its "commit" is cleartext JSON carrying `committerDID` in the open. The double is faithful about epoch and authorship *as data*; it does not model that a real committer is ciphertext until the epoch secret opens it.

This is not a kubun preference. Every real host implementing `GroupMLS` fails at the same method, and the only "workarounds" are unsound: trusting `context.senderDID` feeds the hub's word into the storm-prevention `classify`; making commits PublicMessage leaks the committer to the relay and still needs the handle for leaf→DID.

## The machinery already exists — internally

This is an **exposure and signature** task, not new cryptography.

- External commits already resolve their committer: `packages/mls/src/group-handle.ts` has `readExternalCommit` (line ~141) reading the committer DID off the commit's own UpdatePath leaf (an external committer holds no pre-commit leaf, so its DID rides the commit).
- Member commits already have their sender-leaf decrypted and mapped during `processMessage` — the commit policy receives `senderLeafIndex` and `didOfLeaf(leafIndex)` (`policy.ts`), which is exactly leaf→DID against the current tree.

Both paths run today; neither is reachable as a standalone read.

## R1 — Export a handle-bound committer reader in `@kumiai/mls`

**Required.** A function that reads a Commit's MLS-authenticated committer against a handle, without advancing state:

- For a **member commit** (PrivateMessage): decrypt sender-data with the handle's current epoch secret, take the sender leaf index, resolve it to a DID against the handle's ratchet tree. This reuses the `didOfLeaf` mapping the policy path already builds.
- For an **external commit**: read the committer DID off the UpdatePath leaf, as `readExternalCommit` already does.
- Returns `{ epoch, committerDID }`, or null for bytes that are not a Commit.
- **Non-mutating.** It reads the handle; it does not process, merge, or persist. It may be async — decryption is.

The epoch is already available cheaply (`readMessageEpoch`); the new surface is the committer half.

## R2 — Make `@kumiai/rpc`'s `GroupMLS.readCommitHeader` handle-bound and async

**Required, and coupled to R1.** The port method cannot stay `(commit) => CommitHeader | null`. It must be able to reach the handle and to await:

```ts
readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
```

with the port free to reach its own handle internally (the host already holds it), **or** an explicit handle-passing shape if the lane would rather supply it. Either resolves the two problems: async admits the decrypt, and handle-access admits the tree lookup. `classifyCommit` and the two `readCommitHeader` call sites in `peer.ts` await accordingly. The in-memory fixture stays trivially satisfiable (it ignores the handle and returns its cleartext field).

The doc comment's "WITHOUT applying or opening anything" should be relaxed to "without *advancing* state" — reading sender-data with the epoch secret is an open, and it is unavoidable and safe (read-only).

## Non-goals

- No change to how commits are framed. PrivateMessage handshake commits stay private; the committer is not leaked to the hub. R1 reads it locally, member-side, with the epoch secret the member already holds.
- No change to `classify`'s rows or the storm-prevention rule. This makes the input it already depends on actually obtainable.
- No change to the recovery, ledger, or head surfaces. They are sound and shipped in 0.3.0.

## Acceptance

- A real MLS host implements `GroupMLS.readCommitHeader` and, for a member PrivateMessage commit at the handle's epoch, returns the committer DID the commit authenticates — the same DID the commit policy would see as `didOfLeaf(senderLeafIndex)`.
- The same reader returns the external committer for an external commit, and null for non-commit bytes.
- `classifyCommit` distinguishes a peer's own authored commit from another member's using an authenticated committer, not the transport sender.
- kubun's `plugin-p2p` compiles and its `processCommit` poison test passes (a wrong-epoch commit is `{ advanced: false }`, an unresolvable-entries commit throws) — the port method that today cannot be written at all.
