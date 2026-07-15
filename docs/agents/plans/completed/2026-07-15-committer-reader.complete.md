# Committer reader for `readCommitHeader` — complete

**Status:** complete. **Date:** 2026-07-15. **Branch:** `feat/committer-reader`.
**Packages:** `@kumiai/mls` and `@kumiai/rpc` → `0.3.1`.

## Goal

Make `@kumiai/rpc`'s `GroupMLS.readCommitHeader` implementable by a real MLS host. The
0.3.0 control-ledger pull lane calls `readCommitHeader` on every commit frame before
classifying it, and the classification turns on the **MLS-authenticated committer** — it is
what distinguishes a peer's own commit (`own-unmerged`, which MLS merges and never
processes) from another member's, and what stops one well-formed policy-refused commit
(from a member, or a removed member who keeps the commit topic) from sending every honest
peer into a recovery storm at once. The committer must be the one MLS authenticated, never
the frame's transport sender (the hub's word).

The shipped contract `readCommitHeader(commit): CommitHeader | null` was not implementable
for a real host: a member handshake commit is a **PrivateMessage** whose committer sender-leaf
is encrypted under the epoch's `senderDataSecret` (not in the commit bytes), and resolving it
needs the epoch secret to decrypt sender-data plus the ratchet tree to map the sender leaf to
a DID — both reachable only asynchronously, on the `GroupHandle` behind the host's per-group
mutex. So the method could not stay synchronous or handle-less.

## What was built

- **R1 — `GroupHandle.readCommitHeader` in `@kumiai/mls`** (`packages/mls/src/group-handle.ts`):
  `async readCommitHeader(commit): Promise<{ epoch: bigint; committerDID: string } | null>`.
  For a member (PrivateMessage) commit it decrypts sender-data with the handle's current
  `senderDataSecret`, takes the sender leaf index, and resolves it to a DID against the ratchet
  tree — the same leaf→DID the commit policy sees as `didOfLeaf(senderLeafIndex)`. For an
  external-join commit it reads the committer off the UpdatePath leaf (reusing the existing
  `readExternalCommit` helper). Returns `null` for non-commit bytes. Runs on the handle mutex
  for a consistent secret/tree/epoch snapshot; non-mutating (sender-data decrypt uses the
  epoch-level secret and consumes no per-message ratchet key).

- **Sender-data decrypt reimplementation** (`packages/mls/src/sender-data.ts`, new): a small,
  self-contained reproduction of RFC 9420 §6.3.2 (KDFLabel expansion, ciphertext sample,
  SenderDataAAD, AEAD open, SenderData decode) built only from primitives the live
  `MlsContext.cipherSuite` exposes. **Design decision / why it exists:** ts-mls ships its own
  `decryptSenderData`, but its `exports` map exposes only the package root, so that function
  (and the codecs/`expandWithLabel` it needs) is unreachable across the package boundary — no
  deep import resolves. Rather than patch or fork ts-mls, the decrypt was reproduced locally:
  ~125 lines of frozen RFC wire format, immune to ts-mls RC churn because every ciphersuite
  parameter is read from the live `CiphersuiteImpl`. Correctness is gated by an interop test
  that decrypts a **real ts-mls-encoded** commit — a single wrong byte in the varint, KDFLabel,
  AAD, or offset fails the AEAD open. `@kumiai/mls` remains the only ts-mls consumer.

- **R2 — async, handle-bound port in `@kumiai/rpc`** (`packages/rpc/src/crypto.ts`,
  `peer.ts`): `readCommitHeader(commit): Promise<CommitHeader | null>`. The port reaches its
  own handle internally (no handle parameter — `@kumiai/rpc` never imports MLS); the lane
  awaits at both call sites. `classifyCommit` stays a pure synchronous function over an
  already-resolved header. The in-memory fixture's method became async and still returns its
  cleartext field. The port doc relaxed "WITHOUT applying or opening anything" → "WITHOUT
  advancing state" (reading sender-data with the epoch secret is a read-only open).

## Design decisions preserved

- **Committer by authorship, from the commit, not the transport sender.** The storm-prevention
  rule in `classify` fires only on a peer's *own authored* commit; feeding it the hub's
  `senderDID` would let a hub that stamps each recipient's own DID onto one poison frame heal
  the whole group at will. R1 recovers the committer MLS authenticated, member-side, with the
  epoch secret the member already holds — the committer is never leaked to the hub.
- **Handle-bound and async are both required.** Async admits the decrypt; handle-access admits
  the tree lookup. Even a PublicMessage commit (sender leaf in the clear) still needs the tree
  for leaf→DID, so no host can answer from bytes alone. Explicit handle-passing was rejected —
  it would leak the MLS type into the transport layer.
- **No change to framing, `classify` rows, or recovery/ledger/head surfaces.** PrivateMessage
  handshake commits stay private. This work made an input `classify` already depended on
  actually obtainable, nothing more.

## Verification

- `@kumiai/mls`: 306/306 unit; new `test/commit-header.test.ts` covers member-commit committer
  (interop-decrypting a genuine ts-mls commit), external-commit committer, non-commit/garbage →
  null, a truncated (decode-throwing) frame → null, and non-mutation.
- `@kumiai/rpc`: 174 passed / 1 skipped (the skip is a pre-existing, unrelated app-lane test).
- All-package `build:types` clean; biome lint clean.
- Executed subagent-driven: each of the three implementation tasks was independently
  spec+quality reviewed and came back clean. A final whole-branch review (opus) then found
  one **Critical** and it was fixed before merge (see below).

## Critical found and fixed in final review

`GroupHandle.readCommitHeader`'s top-level `decode(mlsMessageDecoder, commit)` was unwrapped.
ts-mls `decode` *throws* `CodecError` on malformed/truncated frames (not just returns null), and
the rpc lane calls the port method outside any try/catch on raw, un-decoded bytes handed over by
`decodeCommitFrame`. A hub-injected frame with a valid outer wrapper but garbage inner-commit
bytes would throw, `pullCommits` would reject, the cursor would never advance past that frame,
and every later wakeup would re-read and re-throw — a permanent, hub-triggerable commit-lane
wedge (the exact failure the design guards against for `processCommit`). Fixed (commit `1c3d0bf`)
by wrapping the decode to return `null` on any throw — mirroring `readMessageEpoch`, which guards
the same call — plus a regression test that rejected pre-fix (`CodecError: Data length exceeds
buffer`) and returns `null` post-fix.

## Follow-on

- **ts-mls stable upgrade** (`docs/agents/plans/backlog/ts-mls-v2-stable-upgrade.md`): when
  ts-mls stable is adopted, check whether it re-exports `decryptSenderData` (and the sender-data
  codecs); if so, delete `packages/mls/src/sender-data.ts` and delegate to ts-mls's own. The
  reimplementation exists only to route around the missing export.
- **Cosmetic (open, optional):** `sender-data.ts` guards the decrypted plaintext with
  `length < 4`; an authentic `SenderData` is 12 bytes. Harmless — the AEAD already authenticated
  the plaintext, so a short frame cannot occur — but tightening to `< 12` would document the full
  struct.

## Downstream

Enables kubun's `plugin-p2p` to implement `GroupMLS.readCommitHeader` by delegating to
`GroupHandle.readCommitHeader` and narrowing the `bigint` epoch to the port's `number`. That
consumer compiling (and its `processCommit` poison test passing) is the external acceptance and
is verified in the kubun repo, not here.
