# Probe report — Phase 1: ts-mls capability probes

`ts-mls@2.0.0-rc.13`. Probe test: `packages/mls/test/ts-mls-probe.test.ts` (throwaway).

## Verify output

All three brief-specified commands pass (run from repo root):

```
$ pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts --reporter=verbose

 ✓ test/ts-mls-probe.test.ts > framed authenticatedData on a commit > a cleartext authenticatedData field survives the commit round trip and is readable before decryption 82ms
 ✓ test/ts-mls-probe.test.ts > framed authenticatedData on a commit > tampering with the authenticatedData bytes breaks AEAD verification 30ms
 ✓ test/ts-mls-probe.test.ts > external commit framing and reachability > an external join is a cleartext PublicMessage whose UpdatePath leaf carries the joiner credential 63ms
 ✓ test/ts-mls-probe.test.ts > handle usability after a rejected commit > two members that reject the same commit keep a working shared epoch 63ms
 ✓ test/ts-mls-probe.test.ts > per-proposal sender of a by-reference proposal > a committed by-reference Remove reports the proposer leaf, not the committer 83ms

 Test Files  1 passed (1)
      Tests  5 passed (5)

$ pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
tsc exit: 0

$ pnpm exec biome check ./packages ./tests
Checked ... No issues found        (exit 0)
```

Note on biome: the authoritative repo config is biome 2.5.2 via `@kigu/dev` (100-col). An early
apparent "exit 0" from `biome check` was a misread `tail` exit code; the file was then run through
`biome check --write` and now passes clean. (An IDE PostToolUse hook runs a *different*, narrower
biome and will still flag two lines — that formatter is not the repo's.)

---

## Question 1 — does `authenticatedData` survive a commit round trip, and is it readable before decryption?

**Assumption.** `createCommit({ authenticatedData })` produces a `PrivateMessage` whose
`authenticatedData` is byte-identical on the receiving side, readable off the decoded frame without
epoch secrets, and mutating it makes `processMessage` fail (AEAD AAD covers it).

**Verdict: CONFIRMED.**

- The decoded `PrivateMessage.authenticatedData` is byte-equal to the input label
  (`expect(...).toEqual(label)`), read directly off the framed message *before* `processMessage`.
- The frame still decrypts and applies (`bobGroup.epoch` 1 → 2).
- Flipping one byte of the plaintext `authenticatedData` and re-framing makes `processMessage`
  reject, and the receiver stays at its pre-commit epoch (1) — the AEAD AAD (`PrivateContentAAD`)
  genuinely covers the field.

**ts-mls API path.** `createCommit` from `ts-mls` **directly**, not the kumiai wrapper.
`CreateCommitOptions.authenticatedData?: Uint8Array` exists (`createCommit.d.ts`) and works. Test
used an empty (path-only) commit: `createCommit({ context, state, extraProposals: [], authenticatedData })`.

**Surprise / finding.** The spec's claim that "`createCommit` … already accept[s] it" is true of
**ts-mls's** `createCommit`, but the **kumiai wrappers do not pass it through**: `commitInvite`
and `removeMember` (`src/group.ts`) call `createCommit` with no `authenticatedData`, and there is no
generic commit wrapper. Only `joinGroupExternal` forwards `authenticatedData` today. **Phase 2 needs
a passthrough** on the kumiai commit wrappers (or a new wrapper) to carry the control envelope on
Add/Remove/GCE commits.

**Decision-log line.** `authenticatedData` is a confirmed cleartext-but-AEAD-authenticated carrier on
commits at the ts-mls layer; kumiai's `commitInvite`/`removeMember` must be extended to forward it
(currently only `joinGroupExternal` does).

---

## Question 2 — is an external commit a `PublicMessage` with a reachable UpdatePath leaf credential?

**Assumption.** `joinGroupExternal` emits a cleartext `PublicMessage`; the joiner's credential is
reachable at the commit's UpdatePath leaf without processing; and the receiving `commitPolicy` sees
`senderLeafIndex === undefined`.

**Verdict: CONFIRMED.**

- Decoded wire format is `wireformats.mls_public_message`, decodable with no epoch secrets.
- `publicMessage.content.contentType === contentTypes.commit`; `content.commit.path` is present; the
  DID parsed out of `path.leafNode.credential` equals the joiner's DID (`bob.id`).
- The receiver's `commitPolicy` was invoked with `incoming.kind === 'commit'` and
  `senderLeafIndex === undefined`.

**Recorded: what `proposals` contained.** The external-init/resync commit surfaced inline proposal
types **`[3, 6]` = `remove` (3) + `external_init` (6)`** — NO `add` (1). The joiner's credential is
**not** delivered as an Add proposal; it lives only at the UpdatePath leaf, exactly as the spec
claims. So a synchronous callback that inspects `proposals` alone cannot see who is committing; it
must read the path leaf (the async pre-pass the spec describes).

**ts-mls API path.** kumiai `joinGroupExternal` (which frames the `PublicMessage`); receiver via
kumiai `GroupHandle.processMessage(bytes, { commitPolicy })`. Walk:
`decode(mlsMessageDecoder,…).publicMessage.content.commit.path.leafNode.credential`.

**Decision-log line.** External commits are cleartext `PublicMessage`s with `senderLeafIndex ===
undefined` and no Add proposal; the joiner DID is only at `commit.path.leafNode.credential`, so
permission enforcement for external joins must resolve the path-leaf DID out of band, not from
`proposals`.

---

## Question 3 — is the handle still usable after a rejected commit?

**Assumption (untested remainder).** After a rejected commit, the receiver's handle is not merely at
the right epoch but still functional — it can decrypt a subsequent application message from a peer
that also rejected the same commit. Plus: are the proposed extension **types** inspectable from
`incoming`?

**Verdict: CONFIRMED.**

- Bob and Carol (both at epoch 2, both under the reject policy) reject the same anchor-touching
  `group_context_extensions` commit from Alice → both throw `CommitRejectedError`, both stay at
  epoch 2.
- Bob then encrypts an application message and Carol decrypts it: `'still here'` round-trips. The
  rejected handles remain fully functional at the shared pre-commit epoch.
- Extension types **are** inspectable: the callback read
  `proposal.groupContextExtensions.extensions[].extensionType` and observed `ANCHOR_TYPE`
  (`seenExtensionTypes` contained `0xff00`). A policy can therefore reject only commits touching the
  anchor type specifically, rather than blanket-rejecting every `group_context_extensions` proposal.

**ts-mls API path.** kumiai `GroupHandle.processMessage` with an `IncomingMessageCallback` commit
policy; anchor-mutating commit built with `createCommit` from `ts-mls` directly (GCE proposal).

**Surprise.** None. Rollback-by-non-assignment holds, and the two-reject convergence works.

**Decision-log line.** A rejected commit leaves the handle at its pre-commit epoch AND fully usable
(peers that both rejected still exchange application messages); the callback can read proposed
extension types, so `anchorImmutabilityPolicy` can narrow to the anchor type instead of blanket-
rejecting all GCE proposals.

---

## Question 4 — does a by-reference proposal carry a `senderLeafIndex` distinct from the committer's?

**Assumption.** `ProposalWithSender.senderLeafIndex` is per-proposal. When admin Alice commits a
Remove that member Bob proposed by reference, the receiving callback sees that proposal's
`senderLeafIndex` as Bob's leaf, not Alice's.

**Verdict: CONFIRMED.**

- Bob (leaf 1) proposes Dave's removal by reference; Alice (leaf 0) commits it (empty
  `extraProposals`, absorbing the pending proposal by reference); Carol's `commitPolicy` captures
  `incoming`.
- The captured Remove proposal reports `senderLeafIndex === 1` (Bob), while the commit's own
  `senderLeafIndex === 0` (Alice). Per-proposal sender is distinct from the committer.

**ts-mls API path.** No kumiai wrapper exists for a standalone by-reference proposal, so:
`createProposal` from `ts-mls` **directly** (Bob) → framed `PrivateMessage` bytes → both Alice and
Carol `processMessage` it (stored in each receiver's `unappliedProposals` with Bob's sender) → Alice
`createCommit({ …, extraProposals: [] })` from `ts-mls` directly (auto-includes the pending
proposal as a reference — `createCommit.js:111`) → Carol `processMessage(commit, { commitPolicy })`.
The receiver resolves each reference's sender from its own `unappliedProposals`
(`clientState.js:399-404`), which is why every receiver must have seen the proposal first.

**Surprise / finding.** The mechanism works but requires calling ts-mls `createProposal` /
`createCommit` directly — the kumiai wrapper has no ergonomic path for a standalone by-reference
proposal, and receivers must independently process the proposal before the referencing commit.
Phase 2's policy can safely check `p.senderLeafIndex ?? commit.senderLeafIndex` per proposal; the
per-proposal value is real and correct.

**Decision-log line.** `ProposalWithSender.senderLeafIndex` is genuinely per-proposal (by-reference
Remove reports the proposer's leaf, not the committer's), so the permission policy must check each
proposal's own sender to stop an admin laundering a non-admin's Remove; issuing/relaying standalone
by-reference proposals needs ts-mls `createProposal`/`createCommit` directly (no kumiai wrapper yet).
