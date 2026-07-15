# A committer reader for `readCommitHeader`

**Status:** design approved 2026-07-15. Branch `feat/committer-reader`.
**Priority:** 1 — blocks kubun's adoption of the 0.3.0 control-ledger lane. `plugin-p2p`
does not compile past `GroupMLS.readCommitHeader`.
**Requirement doc:** `docs/agents/plans/next/2026-07-15-commit-committer-reader.md`.

## Problem

`@kumiai/rpc` 0.3.0 makes every host implement `GroupMLS`. The pull lane calls
`readCommitHeader` on every commit frame it reads (`peer.ts` → `classifyCommit`)
*before* deciding what to do with it. `committerDID` decides authorship: it is what
distinguishes a peer's own commit (`own-unmerged`, which MLS merges and never
processes) from another member's, and it is what stops one well-formed policy-refused
commit — from a member, or a removed member who keeps the commit topic forever — from
sending every honest peer into a recovery storm at once. The committer must be the one
MLS authenticated, never the frame's transport sender (the hub's word).

The port contract as shipped cannot be implemented for a real MLS host:

```ts
readCommitHeader(commit: Uint8Array): CommitHeader | null   // { epoch, committerDID }
```

- Host handshake commits are **PrivateMessages**. The committer's sender-leaf is
  encrypted under the epoch's `senderDataSecret` — it is not in the commit bytes.
  `readMessageEpoch` works only because the epoch rides the cleartext wire header; the
  committer does not.
- Recovering the committer needs the epoch secret to decrypt sender-data, then the
  ratchet tree to map the sender leaf index to a DID. Both live on the `GroupHandle`, a
  host reaches asynchronously behind its per-group mutex. Even a PublicMessage commit,
  whose sender leaf is in the clear, still needs the tree for leaf→DID — so no host can
  answer `committerDID` from bytes alone, sync.
- The in-memory reference satisfies the contract only because its "commit" is cleartext
  JSON carrying `committerDID` in the open.

The only "workarounds" are unsound: trusting `context.senderDID` feeds the hub's word
into the storm-prevention `classify`; making commits PublicMessage leaks the committer
to the relay and still needs the handle for leaf→DID.

## What the investigation added

The requirement doc framed this as "expose the machinery that already exists
internally." Investigation refined that: the machinery exists, but it is **ts-mls's**,
not kumiai's, and it is walled off.

- ts-mls (`2.0.0-rc.13`) ships `decryptSenderData(msg, senderDataSecret, cs)`
  returning `SenderData{ leafIndex, generation, reuseGuard }`, plus `expandWithLabel`
  and the sender-data TLS codecs. **None are re-exported from the package index** —
  ts-mls's `exports` map exposes only `.`, so Node blocks every deep import.
- `@kumiai/mls` is the only ts-mls consumer in the repo. There are no existing dep
  patches.
- Everything else R1 needs is already reachable through the index / the handle:
  `state.keySchedule.senderDataSecret`, `context.cipherSuite` (a live `CiphersuiteImpl`
  whose `kdf.expand` and `hpke.decryptAead` are callable), the leaf→DID mapping the
  handle already folds (`#iterateMembers` / `listMembers`), and the external-commit
  committer read (`readExternalCommit`, off the UpdatePath leaf).

**Decision:** reimplement the sender-data decrypt inside `@kumiai/mls` from
index-exported primitives, rather than patch or fork ts-mls. It is ~40 lines of frozen
RFC 9420 §6.3.2 key schedule, self-contained and immune to ts-mls RC churn (the
ciphersuite parameters are read from the live `CiphersuiteImpl`, not hardcoded). The
tradeoff — a small amount of duplicated crypto — is accepted because it unblocks kubun
now without a third-party release or a patch file to carry across a moving RC target.
Tracked for removal once ts-mls stable re-exports `decryptSenderData` (see Bookkeeping).

## R1 — `GroupHandle.readCommitHeader` in `@kumiai/mls`

A new public method on `GroupHandle` reading a Commit's MLS-authenticated committer
against the handle, without advancing state:

```ts
async readCommitHeader(commit: Uint8Array):
  Promise<{ epoch: bigint; committerDID: string } | null>
```

- Decode the frame with `mlsMessageDecoder`. Anything that is not a Commit → `null`.
- **Member commit** (PrivateMessage, `contentType === commit`): decrypt sender-data with
  `#state.keySchedule.senderDataSecret` and `#context.cipherSuite`, take
  `SenderData.leafIndex`, resolve it to a DID against `#state.ratchetTree`. This is the
  same leaf→DID mapping `#iterateMembers` folds and the commit policy sees as
  `didOfLeaf(senderLeafIndex)`. Epoch from the decoded frame.
- **External commit** (PublicMessage, `senderType === new_member_commit`): committer DID
  off the UpdatePath leaf credential — promote the existing `readExternalCommit` helper.
  Epoch from the decoded frame. A leaf that does not resolve to a basic-credential DID
  → `null`.
- Returns the mls-native `bigint` epoch; the host adapter narrows to rpc's `number`.
- Runs **on the handle mutex** (`mutexFor(this).run`, as `getLedger` and
  `isLedgerComplete` do), so the `senderDataSecret`, ratchet tree, and epoch it reads are
  one consistent snapshot against a concurrent `processMessage` that swaps `#state`.
- **Non-mutating.** Sender-data decrypt uses the epoch-level `senderDataSecret` and
  consumes no per-message ratchet key. Nothing is processed, merged, or persisted. It is
  async only because the KDF and AEAD are.

Exported from `packages/mls/src/index.ts` as part of the `GroupHandle` surface (the
method needs no separate export; the type of its return value is inlined or a small
named `CommitHeader`-like type local to mls).

### The sender-data module

Isolated in one small file (e.g. `packages/mls/src/sender-data.ts`) so the reimpl
surface is contained and trivially deletable once ts-mls re-exports its own. Reproduces
RFC 9420 §6.3.2 from index-exported primitives only:

- `ciphertext_sample = ciphertext[0 .. Nh]` (KDF output length).
- `sender_data_key   = ExpandWithLabel(senderDataSecret, "key",   ciphertext_sample, Nk)`
- `sender_data_nonce = ExpandWithLabel(senderDataSecret, "nonce", ciphertext_sample, Nn)`
  where `ExpandWithLabel` is the MLS `KDFLabel` framing over `cipherSuite.kdf.expand`.
- AEAD open: `cipherSuite.hpke.decryptAead(key, nonce, aad, encryptedSenderData)`, with
  `aad = SenderDataAAD{ group_id, epoch, content_type }` TLS-encoded.
- Decode `SenderData{ leaf_index: u32, generation: u32, reuse_guard: [4]byte }`; take
  `leaf_index`.

Every step carries an RFC section reference in a comment. The module exposes one
function returning the sender leaf index (or the whole `SenderData`); `readCommitHeader`
maps that index to a DID.

## R2 — `GroupMLS.readCommitHeader` handle-bound and async in `@kumiai/rpc`

The port method becomes:

```ts
readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
```

- The port reaches its own handle internally — **no handle parameter**. The host already
  holds the handle; async admits the decrypt and handle-access admits the tree lookup.
  Explicit handle-passing is rejected: rpc holds no handle and must never import MLS
  (`group-rpc never imports MLS`), so it cannot construct or thread one.
- `CommitHeader.epoch` stays `number`; the host narrows the mls `bigint`.
- `peer.ts` — both call sites `await`:
  - `classifyCommit(await port.readCommitHeader(commitFrame.commit), position, { … })`
  - `(await port.readCommitHeader(pending.commit))?.epoch` in the recover path.
- `classifyCommit` (`classify.ts`) is **unchanged** — still a pure synchronous function
  over an already-resolved `CommitHeader | null`. Only the callers await.
- The port doc comment relaxes "WITHOUT applying or opening anything" → "without
  *advancing* state": reading sender-data with the epoch secret is an open, and it is
  unavoidable and safe (read-only).
- The in-memory fixture (`packages/rpc/test/fixtures/memory-group-mls.ts`)
  `readCommitHeader` becomes `async` and keeps returning its cleartext field — it ignores
  the handle it does not have. Trivially satisfiable, as before.

## Non-goals

- No change to how commits are framed. PrivateMessage handshake commits stay private; the
  committer is not leaked to the hub. R1 reads it locally, member-side, with the epoch
  secret the member already holds.
- No change to `classify`'s rows or the storm-prevention rule. This makes the input it
  already depends on actually obtainable.
- No change to recovery, ledger, or head surfaces. Sound and shipped in 0.3.0.

## Testing

- `@kumiai/mls`:
  - A member PrivateMessage commit: the reader returns the same DID the commit policy
    sees as `didOfLeaf(senderLeafIndex)` — cross-checked against a real `processMessage`
    sender-leaf on the same commit.
  - An external commit: the reader returns its UpdatePath committer.
  - Non-commit bytes (Proposal, application message, garbage): `null`.
  - Non-mutating: the handle's epoch and state are unchanged after a read.
- `@kumiai/rpc`:
  - Existing lane / classify tests updated for the now-async port (`await` the fixture
    method); the fixture stays green.

## Acceptance

- A real MLS host implements `GroupMLS.readCommitHeader` and, for a member PrivateMessage
  commit at the handle's epoch, returns the committer DID the commit authenticates — the
  same DID the commit policy would see as `didOfLeaf(senderLeafIndex)`.
- The same reader returns the external committer for an external commit, and `null` for
  non-commit bytes.
- `classifyCommit` distinguishes a peer's own authored commit from another member's using
  an authenticated committer, not the transport sender.
- kubun's `plugin-p2p` compiles and its `processCommit` poison test passes: a wrong-epoch
  commit is `{ advanced: false }`, an unresolvable-entries commit throws.

## Bookkeeping

- `docs/agents/plans/backlog/ts-mls-v2-stable-upgrade.md`: add a line — when ts-mls
  stable is adopted, check whether it re-exports `decryptSenderData` (and the sender-data
  codecs); if so, drop `packages/mls/src/sender-data.ts` and delegate to ts-mls's own.

## Affected files

- `packages/mls/src/sender-data.ts` — new. The RFC 9420 §6.3.2 sender-data decrypt.
- `packages/mls/src/group-handle.ts` — new `readCommitHeader` method; promote/reuse
  `readExternalCommit`.
- `packages/mls/src/index.ts` — export any new type as needed.
- `packages/rpc/src/crypto.ts` — port signature → `Promise<CommitHeader | null>`; relax
  the doc comment.
- `packages/rpc/src/peer.ts` — `await` at the two call sites.
- `packages/rpc/test/fixtures/memory-group-mls.ts` — `readCommitHeader` async.
- Tests in `packages/mls` and `packages/rpc`.
- `docs/agents/plans/backlog/ts-mls-v2-stable-upgrade.md` — reimpl-removal note.
