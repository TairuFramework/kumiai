# Probe report — Question 2.6: can one commit carry a GCE proposal and an Add?

`ts-mls@2.0.0-rc.13`. Probe test: `packages/mls/test/ts-mls-probe.test.ts` (throwaway, recreated
for this phase). Anchor extension type `0xf100`, `ledger_head` extension type `0xf101`.

**Overall: DONE — no stop condition tripped.** The `ledger_head` design's load-bearing assumption
(a GCE head-rewrite rides the Add commit, and the receiving policy can byte-compare the anchor)
holds on all counts.

## Verify output

All three brief-specified commands pass (run from repo root `/Users/paul/dev/yulsi/kumiai`):

```
$ pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts --reporter=verbose

 RUN  v4.1.10 /Users/paul/dev/yulsi/kumiai/packages/mls

 ✓ test/ts-mls-probe.test.ts > a group_context_extensions proposal riding an Add commit > a single commit carries both an Add and a group_context_extensions proposal, both visible to the receiver 104ms
 ✓ test/ts-mls-probe.test.ts > reading the proposed anchor extensionData from the commit policy > the receiver reads the proposed anchor extensionData byte-for-byte and compares it to its own 56ms
 ✓ test/ts-mls-probe.test.ts > reading the proposed anchor extensionData from the commit policy > the receiver rejects a commit whose anchor extensionData has a byte flipped and keeps its epoch 37ms
 ✓ test/ts-mls-probe.test.ts > a standalone group_context_extensions proposal absorbed by reference > the receiver reports the proposer leaf, not the committer leaf 68ms

 Test Files  1 passed (1)
      Tests  4 passed (4)

$ pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
tsc exit: 0

$ pnpm exec biome check ./packages ./tests
Checked 148 files in 34ms. No fixes applied.
biome exit: 0
```

---

## Question 1 — does a single commit carry a GCE proposal alongside an Add, with both visible?

**Assumption.** A commit may carry `[Add(bob), GroupContextExtensions([anchor, ledgerHead'])]`
together, and the receiving `IncomingMessageCallback` sees **both** proposals in
`incoming.proposals`.

**Verdict: CONFIRMED.**

- Alice (creator) and Carol (member) share an anchored group at epoch 1, both leaves advertising
  `[ANCHOR_TYPE, LEDGER_HEAD_TYPE]`, both carrying `anchor` + `ledger_head` in the GroupContext.
- `createCommit` accepted `extraProposals: [Add(bob), GroupContextExtensions([anchor, ledgerHead'])]`
  in one commit and produced a single framed message (plus a Welcome for Bob). No error about
  proposal mixing.
- Carol's `commitPolicy` was invoked with `incoming.kind === 'commit'` and
  `incoming.proposals.length === 2`; the proposal types contained **both**
  `defaultProposalTypes.add` and `defaultProposalTypes.group_context_extensions`.
- Carol accepted; her epoch advanced 1 → 2, and she then decrypted an application message
  (`'after the head moved'`) that Alice encrypted from the post-commit state. The added-leaf refusal
  the brief warned about did **not** occur — advertising both custom extension types on every leaf
  (`defaultCapabilities()` + `extensions: [ANCHOR_TYPE, LEDGER_HEAD_TYPE]`, at `createGroup` and at
  `createKeyPackageBundle`) was sufficient.

**ts-mls API path.** `createCommit` from `ts-mls` **directly** (not the kumiai wrapper), with the
Add and GCE proposals both in `extraProposals` and `ratchetTreeExtension: true`. Wire via
`encode(mlsMessageEncoder, result.commit)`. Receiver via kumiai
`GroupHandle.processMessage(bytes, { commitPolicy })`. The callback reads
`incoming.proposals[i].proposal.proposalType`.

**Surprise.** None. The one operational note: kumiai has no wrapper that builds a mixed Add+GCE
commit — `commitInvite` frames Add-only. Phase 2 needs a commit path that takes extra proposals
(the head rewrite) alongside the Add, calling ts-mls `createCommit` directly.

**Decision-log line.** A single commit can carry `[Add, group_context_extensions]` together and the
receiver's policy sees both proposals (`proposals.length === 2`, one `add` + one
`group_context_extensions`); the `ledger_head` "rewrite on the Add commit" model is viable, but
kumiai needs a new commit wrapper that forwards extra proposals (today only `commitInvite`'s
Add-only path exists).

---

## Question 2 — is `extensionData` reachable from the callback, byte-for-byte?

**Assumption.** From `incoming.proposals[i].proposal.groupContextExtensions.extensions[j]` the
callback can read `extensionData` as a `Uint8Array` and compare it byte-for-byte against the anchor
in its own `GroupContext`.

**Verdict: CONFIRMED.**

- Positive path: Carol's policy located the proposed extension with `extensionType === ANCHOR_TYPE`,
  read its `extensionData`, confirmed it `instanceof Uint8Array` (`proposedAnchorIsBytes === true`),
  and byte-compared it against her own current anchor from
  `carolGroup.state.groupContext.extensions` — **equal** (`anchorEqual === true`). It also read the
  proposed `ledger_head` `extensionData` and confirmed it **differs** from her current head
  (`headDiffers === true`). So the policy can affirm "anchor unchanged, only the head moved" from
  inside the callback, byte-for-byte.
- The handle state read inside the callback is the **pre-commit** state (ts-mls invokes the callback
  before assigning `newState`), so `carolGroup.state.groupContext.extensions` is exactly the current
  anchor to compare against — no extra bookkeeping needed.
- Negative path: Alice committed a GCE proposal whose anchor `extensionData` had its first byte
  XOR-flipped (head still advancing). Carol's policy detected `!bytesEqual(proposedAnchor,
  currentAnchor)` and returned `'reject'`; `processMessage` threw `CommitRejectedError` and Carol's
  epoch was unchanged.

**ts-mls API path.** Read walk inside the `IncomingMessageCallback`:
`incoming.proposals.find(p => p.proposal.proposalType === defaultProposalTypes.group_context_extensions)`
→ `p.proposal.groupContextExtensions.extensions` (guarded by `'groupContextExtensions' in proposal`)
→ `.find(e => e.extensionType === ANCHOR_TYPE).extensionData` (a `Uint8Array`). Own side:
`handle.state.groupContext.extensions`, same shape. Extensions built with
`makeCustomExtension({ extensionType, extensionData })` from `ts-mls`.

**Surprise.** None — this closes the exact gap Phase 1 left open (Phase 1 established
`extensionType` was readable but did not test `extensionData`). `extensionData` is a plain
`Uint8Array` on both the proposed and the local side.

**Decision-log line.** The commit policy can read each proposed extension's `extensionData` as a
`Uint8Array` and byte-compare it against the handle's own pre-commit
`groupContext.extensions`, so the new anchor guard ("anchor present and byte-identical, only
`ledger_head` differs") is enforceable purely inside the synchronous callback — no post-apply
integrity re-check and no spec rewrite needed.

---

## Question 3 — what does the receiver see when the GCE proposal is by-reference?

**Assumption, weakly held.** If a GCE proposal arrives by reference, the policy must handle a
proposal whose `senderLeafIndex` differs from the committer's.

**Verdict: CONFIRMED** (the cheap check succeeded rather than staying UNRESOLVED).

- ts-mls **does** permit a standalone `group_context_extensions` proposal via `createProposal`,
  absorbed by a later `createCommit({ extraProposals: [] })`. A non-admin member (Carol, leaf 1)
  framed it; Alice (leaf 0) and Dave both stored it via `processMessage`; Alice committed with empty
  `extraProposals`, absorbing it by reference.
- On the receiving side, Dave's `commitPolicy` reported the commit's own
  `senderLeafIndex === 0` (Alice, the committer) while the **GCE proposal's** own
  `senderLeafIndex === 1` (Carol, the proposer). Per-proposal sender is distinct from the committer,
  exactly as Phase 1 (Q1.4) proved for Remove — it holds for `group_context_extensions` too.

**ts-mls API path.** `createProposal` from `ts-mls` directly (proposer) → framed `PrivateMessage`
bytes → every other member `processMessage`s it into their `unappliedProposals` → committer
`createCommit({ extraProposals: [] })` from `ts-mls` directly (auto-references the pending proposal)
→ receiver `processMessage(commit, { commitPolicy })`. In the callback, the committer is
`incoming.senderLeafIndex`; the proposer is the per-proposal
`incoming.proposals[i].senderLeafIndex`.

**Surprise.** None, but the operational note matters: a by-reference GCE head update means the
anchor guard cannot assume the head-rewriting proposal was authored by the committer. The policy
must key its anchor/head checks on **each proposal's own `senderLeafIndex`**, not the commit sender
— and every receiver must have independently processed the standalone proposal first (there is no
kumiai wrapper for issuing/relaying a standalone GCE proposal; it needs ts-mls `createProposal`
directly).

**Decision-log line.** A standalone `group_context_extensions` head update can be proposed by
reference (even by a non-admin) and absorbed by a later commit; the receiver's policy sees the
proposal's own `senderLeafIndex` (proposer) distinct from the commit's `senderLeafIndex`
(committer), so the permission/anchor policy must attribute a by-reference head rewrite to its
proposer, and Phase 2 must relay the standalone proposal to all members (no kumiai wrapper exists
yet — use ts-mls `createProposal`).
