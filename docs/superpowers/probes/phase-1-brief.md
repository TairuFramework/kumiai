# Probe brief — Phase 1: ts-mls capability probes

You are answering four factual questions about `ts-mls@2.0.0-rc.13`'s real runtime behaviour.
Everything below was read out of `.d.ts` files and never executed. Your job is to execute it.

**No `packages/mls/src/` changes.** The only file you create is
`packages/mls/test/ts-mls-probe.test.ts`. It is a throwaway — its findings go into a report,
not into the permanent suite. Do not modify any other test.

Read `AGENTS.md` and the `kigu:conventions` skill before writing code. In particular:
`type` not `interface`; `Array<T>` not `T[]`; never `any`; capital `ID`/`DID`; ES `#fields`.
**Code, comments, and test names must never reference plan questions, decision numbers, or
phase labels.** No `// Q1.1:`. Name each test after the behaviour it establishes and state the
invariant directly.

Existing tests to read first, as idiom and as fixtures you can lift from:

- `packages/mls/test/groupcontext-extension.test.ts` — builds a group with a custom
  GroupContext extension, seeds a `commitPolicy`, drives a `group_context_extensions` commit
  through `createCommit` + `encode(mlsMessageEncoder, …)`, asserts the receiver rejects and
  keeps its epoch.
- `packages/mls/test/external-rejoin.test.ts` — `joinGroupExternal` end to end, including a
  third online member converging.
- `packages/mls/test/group.test.ts` — `createGroup` / `createInvite` / `commitInvite` /
  `processWelcome` fixtures.
- `packages/mls/src/group.ts` — `authenticatedData` appears only at lines ~810, ~829, ~881,
  inside `joinGroupExternal`. Nothing else in the package touches it.

---

## Question 1: does `authenticatedData` survive a commit round trip, and is it readable before decryption?

**Assumption under test.** `createCommit({ authenticatedData })` produces a `PrivateMessage`
whose `authenticatedData` is byte-identical on the receiving side, readable off the decoded
frame *without* holding the epoch secrets; and mutating those bytes in flight makes
`processMessage` fail, because the AEAD AAD covers them.

**Spec section this rests on** (verbatim):

> **`authenticatedData` is cleartext but authenticated.** `PrivateMessage.authenticatedData`
> is a plaintext field of the framed message (`privateMessage.d.ts:10-17`), readable before
> decryption, yet covered both by `PrivateContentAAD` (so tampering breaks the AEAD) and by
> the signed `FramedContentTBS`. `createCommit` and `joinGroupExternal` already accept it.

**Approach.** Two-member group. Commit carrying a non-empty `authenticatedData`. Encode it,
decode it on the receiving side, read `authenticatedData` off the decoded `PrivateMessage`
before calling `processMessage`, assert byte equality. Then a second test that flips one byte
of the ciphertext-adjacent authenticated data in the encoded message and asserts
`processMessage` throws.

**Important.** The spec's claim "`createCommit` … already accept[s] it" is *unverified* — the
only call site in this repo passing `authenticatedData` is `joinGroupExternal`. Establish
whether `createCommit` (the kumiai wrapper in `src/group.ts`) accepts it, and separately
whether ts-mls's underlying `createCommit` accepts it. If the kumiai wrapper does not but
ts-mls does, that is a finding, not a blocker — call ts-mls directly in the probe and report
that the wrapper needs a passthrough.

**If ts-mls itself cannot carry `authenticatedData` on a commit, or the receiver cannot read
it before decryption: report `BLOCKED` immediately.** That kills the spec's carrier for the
control envelope. Do not invent an alternative. Report and stop.

---

## Question 2: is an external commit a `PublicMessage` with a reachable UpdatePath leaf credential?

**Assumption under test.** `joinGroupExternal` emits a `PublicMessage` (cleartext); the
joiner's credential is reachable at the commit's UpdatePath leaf node without processing the
message; and the receiving `commitPolicy` sees `senderLeafIndex === undefined`.

**Spec section this rests on** (verbatim):

> For an external-init commit `senderLeafIndex` is `undefined`, and the joiner's credential
> lives in the commit's UpdatePath leaf rather than in `proposals` — the synchronous callback
> cannot see who is committing. But `joinGroupExternal` emits a `PublicMessage`, which is
> cleartext, so `processMessage` decodes it in the async pre-pass, resolves the path leaf's
> DID, and hands the callback a precomputed verdict.

**Approach.** Establish a group, have a third identity join by external commit (lift the
fixture from `external-rejoin.test.ts`). On the receiving side: decode the message, assert its
wire format is `PublicMessage`, walk to the commit's UpdatePath leaf node, extract the
credential, decode the DID out of it, assert it equals the joiner's DID. Separately, install a
`commitPolicy` on the receiver that captures the `incoming` value it is handed; assert
`senderLeafIndex` is `undefined` and **record exactly what `proposals` contained** — the spec
claims the credential is not in there, and we want that on the record either way.

**If the credential is not reachable from the undecrypted message: report `DONE_WITH_CONCERNS`,
not `BLOCKED`.** The consequence is bounded (external commits get rejected by default), so the
finding is useful and Phase 2 can still start.

---

## Question 3: is the handle still usable after a rejected commit?

**Already established** by `test/groupcontext-extension.test.ts:126`: a
`group_context_extensions` proposal reaches the callback with
`proposalType === defaultProposalTypes.group_context_extensions`, returning `'reject'` leaves
the receiver at its pre-commit epoch, and `processMessage` throws `CommitRejectedError`. Do
not re-test that.

**Assumption under test — the untested remainder.** After a rejected commit, the receiver's
handle is not merely at the right epoch but still *functional*: it can decrypt a subsequent
application message from a peer that also rejected the same commit.

Also establish, while you are there: are the proposed extensions *inspectable* from the
`incoming` value — i.e. can the callback read the proposed extension **types** in order to
detect the anchor type specifically, rather than blanket-rejecting every
`group_context_extensions` proposal as kubun's `anchorImmutabilityPolicy` does?

**Spec sections this rests on** (verbatim):

> | `group_context_extensions` | `admin`, and rejected outright if it touches the anchor extension type |

> On reject, or on any thrown verification, none of the three fields are assigned. Rollback is
> simply not assigning — no state is mutated in place, so there is nothing to undo. This is
> how the existing reject path already behaves (`group.ts:350-357`).

**Approach.** Three members. Two of them (Bob, Carol) reject the same commit from Alice. Then
Bob encrypts an application message and Carol decrypts it. Assert it round-trips and that both
are still at the pre-commit epoch.

---

## Question 4: does a by-reference proposal carry a `senderLeafIndex` distinct from the committer's?

**Assumption under test.** `ProposalWithSender.senderLeafIndex` is per-proposal. When admin
Alice commits a Remove that member Bob proposed *by reference*, the receiving callback sees
that proposal's `senderLeafIndex` as Bob's leaf, not Alice's.

**Spec section this rests on** (verbatim):

> `ProposalWithSender.senderLeafIndex` is per-proposal, because a commit may include
> by-reference proposals authored by other members. Checking only the committer would let an
> admin launder a non-admin's Remove by committing it. Each proposal is checked against
> `p.senderLeafIndex ?? commit.senderLeafIndex`.

**Approach.** Three members (Alice, Bob, Carol) plus a fourth (Dave) to remove. Bob issues a
Remove proposal by reference; Alice commits it; Carol's `commitPolicy` captures `incoming` and
asserts `proposals[0].senderLeafIndex` equals Bob's leaf index and differs from the commit's
own `senderLeafIndex`.

If ts-mls has no ergonomic path to issuing a standalone by-reference proposal through the
kumiai wrapper, call ts-mls directly. If it cannot be done at all, report
`DONE_WITH_CONCERNS` with what you found — the policy then has to fall back to the committer's
permission alone, which is a real weakening worth recording.

---

## Rules

- **Stop at the first failure of the approved approach.** Report `BLOCKED` with what you tried
  and what happened. Do not try alternatives without asking. Difficulty is information.
- Each of the four questions is independent. A `BLOCKED` on Question 1 still means you report
  whatever you established on 2–4.
- Paste **actual command output**, not a summary.

## Verify

Run from the repo root (`/Users/paul/dev/yulsi/kumiai`). Note: an `rtk` shim on this machine
intercepts `pnpm run <script>` and may redirect it to the wrong tool. Use `pnpm exec` forms:

```
pnpm --filter @kumiai/mls exec vitest run test/ts-mls-probe.test.ts
pnpm --filter @kumiai/mls exec tsc --noEmit --skipLibCheck -p tsconfig.test.json
pnpm exec biome check ./packages ./tests
```

## Report contract

Write your **full report** to `docs/superpowers/probes/phase-1-report.md`, structured as one
section per question, each with: the assumption, `CONFIRMED` / `CONTRADICTED` / `BLOCKED`, the
pasted test output, the exact ts-mls API path you had to use, and any surprise.

For each question also record the **decision-log line** the plan will absorb:
findings / spec impact / what we now know.

Return to the caller **only**: overall status (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED`), a
one-line summary per question, and concerns. Not the report body.
