# Probe brief — Question 2.6: can one commit carry a GCE proposal and an Add?

A ts-mls capability probe, same shape as Phase 1. It has a **stop condition**: the `ledger_head`
design in the spec rests on this, and the rest of Phase 2 rests on the head.

**No `packages/mls/src/` changes.** The only file you create is
`packages/mls/test/ts-mls-probe.test.ts` (it was deleted after Phase 1; recreate it). It is a
throwaway — findings go into a report, not into the permanent suite. Do not modify any other test.

Read `AGENTS.md` and the `kigu:conventions` skill before writing code. `type` not `interface`;
`Array<T>` not `T[]`; never `any`; capital `ID`/`DID`; ES `#fields`. **Code, comments, and test
names must never reference plan questions, decision numbers, or phase labels.** No `// Q2.6:`.
Name each test after the behaviour it establishes.

Read first, as idiom and as fixtures to lift:

- `packages/mls/test/groupcontext-extension.test.ts` — builds an anchored group, seeds a
  `commitPolicy`, drives a `group_context_extensions` commit through `createCommit` +
  `encode(mlsMessageEncoder, …)`, asserts the receiver rejects and keeps its epoch. The Phase 1
  probe established, via this path, that a policy can read
  `proposal.groupContextExtensions.extensions[].extensionType`.
- `packages/mls/test/group.test.ts` — `createGroup` / `createInvite` / `commitInvite` /
  `processWelcome` fixtures.
- `docs/superpowers/probes/phase-1-report.md` — what is already known about the callback.

---

## The design this is testing

The spec adds a second GroupContext extension, `ledger_head` (`0xf101`), holding a hash chain
over the control ledger's ordered entry ids. It is rewritten by a `group_context_extensions`
proposal carried **in the same commit** that enacts the role entries — typically the very commit
that Adds the new member.

That forces the anchor guard to change shape. A GCE proposal replaces the *entire* extensions
list rather than patching one entry, so every head update necessarily re-includes the anchor
(`0xf100`). A policy that rejects "any GCE proposal touching the anchor extension type" — which
is what kubun's `anchorImmutabilityPolicy` does today — would reject every head update. The new
rule must be: the anchor extension is present and **byte-identical** to the current one, and
nothing but `ledger_head` differs.

Phase 1 established that `extensionType` is readable from the callback. It did **not** establish
that `extensionData` is.

---

## Question 1: does a single commit carry a GCE proposal alongside an Add, with both visible?

**Assumption.** A commit may carry `[Add(bob), GroupContextExtensions([anchor, ledgerHead'])]`
together (RFC 9420 permits it), and the receiving `IncomingMessageCallback` sees **both**
proposals in `incoming.proposals`.

**Approach.** Anchored group with Alice (creator) and Carol (member), both carrying the anchor
and a `ledger_head` extension in the GroupContext. Alice commits an Add of Bob's key package
together with a GCE proposal rewriting the extensions list to `[anchor (unchanged), ledgerHead']`.
Carol's `commitPolicy` captures `incoming` and asserts it sees two proposals, one `add` and one
`group_context_extensions`. Carol accepts; assert her epoch advanced and she can still decrypt an
application message from Alice.

Note that leaf capabilities must advertise **both** custom extension types or the added leaf is
refused — `defaultCapabilities()` plus `extensions: [ANCHOR_TYPE, LEDGER_HEAD_TYPE]`, at
`createGroup` and at `createKeyPackageBundle`. If that turns out to be the thing that fails,
that is itself the finding — report it and stop.

**If a GCE proposal cannot ride an Add commit: report `BLOCKED`.** Do not look for a workaround.
The head has to move somewhere else and that is a design decision, not a probe decision.

## Question 2: is `extensionData` reachable from the callback, byte-for-byte?

**Assumption.** From `incoming.proposals[i].proposal.groupContextExtensions.extensions[j]` the
callback can read `extensionData` as a `Uint8Array`, not merely `extensionType`, and can compare
it byte-for-byte against the anchor currently in its own `GroupContext`.

**Approach.** Carol's policy, on seeing the GCE proposal:

1. Reads the proposed extension list, finds the entry with `extensionType === ANCHOR_TYPE`.
2. Reads her own current anchor from `handle.state.groupContext.extensions`.
3. Compares the two `extensionData` byte arrays. Asserts equal.
4. Reads the proposed `ledger_head` `extensionData` and asserts it differs from her current one.

Then the negative: Alice commits a GCE proposal whose anchor `extensionData` has **one byte
flipped**. Carol's policy detects the difference and returns `'reject'`. Assert
`CommitRejectedError` and that Carol's epoch is unchanged.

**If `extensionData` is not reachable, or is not a comparable `Uint8Array`: report
`DONE_WITH_CONCERNS`** with exactly what *is* reachable. The consequence is bounded — the anchor
guard would have to be enforced some other way (e.g. by refusing any GCE that changes the number
or order of extensions, plus a separate anchor-integrity check after the commit applies) — but the
spec would need rewriting, so state precisely what the callback can and cannot see.

## Question 3: what does the receiver see when the GCE proposal is by-reference?

**Assumption, weakly held.** The spec assumes head updates are by-value proposals inside the
commit. If a GCE proposal can arrive by reference (proposed separately, absorbed into a later
commit), the policy must handle a proposal whose `senderLeafIndex` differs from the committer's —
Phase 1 (Q1.4) proved that happens for Remove.

**Approach.** Cheap check only: does ts-mls permit a standalone `group_context_extensions`
proposal via `createProposal`, absorbed by a later `createCommit`? If yes, does the receiving
callback report the *proposer's* leaf? Report what you find. Do not build the full fixture if it
is awkward — a one-paragraph finding is enough, and `UNRESOLVED` is an acceptable answer here.

---

## Rules

- **Stop at the first failure of the approved approach.** Report `BLOCKED` with what you tried and
  what happened. Do not try alternatives without asking. Difficulty is information.
- The three questions are independent. `BLOCKED` on 1 still means you report what you established
  on 2 and 3, if anything.
- Paste **actual command output**, not a summary.

## Verify

From the repo root (`/Users/paul/dev/yulsi/kumiai`). An `rtk` shim on this machine intercepts
`pnpm run <script>`; use `pnpm exec` forms:

```
pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
pnpm exec biome check ./packages ./tests
```

## Report contract

Write the **full report** to `docs/superpowers/probes/question-2.6-report.md`: one section per
question, each with the assumption, `CONFIRMED` / `CONTRADICTED` / `BLOCKED` / `UNRESOLVED`, the
pasted test output, the exact ts-mls API path used, and any surprise. For each, also record the
**decision-log line** the plan will absorb: findings / spec impact / what we now know.

Return to the caller **only**: overall status, a one-line summary per question, and concerns.
Not the report body.
