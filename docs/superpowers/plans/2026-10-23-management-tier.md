# kumiai band 0.12: kokuin management tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** `@kumiai/mls` accepts MLS leaves, holder grants, registry entries and revoke proofs authorised by `did:kokuin:` management members (`mbr`), so a controller's devices run groups with the root seed cold.

**Architecture:** Bound leaves carry the controller log as `{ chain, events }`. Verification resolves members through an embedded `@kokuin/controller` resolver (`resolveMember` on one `frozen()` view). A managing device binds its own leaf by membership (`controller.member`, no capability); other leaves keep capabilities whose root may be `mbr`. The device registry records `ControllerLog`s, and every acceptance judges a leaf's **member root** (member DID, add digest, generation) against the registry's current authenticated head, never against delivered bytes.

**Tech Stack:** TypeScript, ts-mls, `@kokuin/controller` ^0.2.3, `@kokuin/capability` ^0.5.1, `@kokuin/token` ^0.6.1, vitest, pnpm/turbo.

**Spec:** `docs/superpowers/specs/2026-10-23-stack-management-tier-design.md`, the kumiai section and "Decided round 2". It is a snapshot of kubun `feat/stack-adoption` at `caa5c266`. Persisted decisions: `docs/agents/plans/backlog/2026-10-23-kokuin-management-tier.md`.

## Global Constraints

- Band raise: every `@kumiai/*` package moves 0.11 to 0.12 together (repo `AGENTS.md`); `pnpm change` intents per `kumiai-release-mechanics` memory.
- Catalog: `@kokuin/controller` `^0.2.3` (needs `deviceRevokeIndices`). Cross-repo deps stay published `^` ranges, never `workspace:`.
- No legacy data compat: the persisted registry format (`recordedLog`, `Revocation.logPosition`) may break with no migration or shim.
- Deny and member state come from a fold's `head`, never `states.at(-1)` (spec N1). `.gen` reads from `states.at(-1)` stay valid.
- Member DIDs are compared canonically (`normalizeDID`); member pins are long-form `did:peer:4`.
- `EPOCH_SATURATED` and any resolver refusal read as "unavailable": refuse, never "nothing denied".
- Member grant bounds: `exp ≤ lease` always. The MLS holder-grant lifetime ceiling is `MAX_TRUSTED_GRANT_LIFETIME` (31 536 000 s), passed as `maxMemberGrantLifetime`, and also bounded by the lease. The leaf capability stays ≤ `MAX_LEAF_LIFETIME` (604 800 s) and the group's `leafLifetime` (default 86 400 s).
- A changed port runs both contract suites against the real implementation and the doubles. A double may be stricter than its port, never more permissive.
- Verify with `turbo run test:types` repo-wide (breaking types). Tests: `pnpm --filter @kumiai/mls test:unit`, forced, `Cached: 0`. Lint: `rtk proxy pnpm run lint`.
- Heavy runs (repo-wide types, full suites) follow the machine-wide heavy-run protocol.

## Review Focus

1. **Concurrent removal.** A member removed in the ledger whose earlier-signed leaf, grant or registry entry arrives later must be refused at acceptance, even though kokuin's causal fold keeps its events. Test owner: Task 6.
2. **Renewed member, old snapshot.** A member renewed in epoch events after the last root settle must mint grants up to the renewed lease. A chain-only prefix would wrongly refuse them. Test owner: Task 2.
3. **Re-revoke after reset.** A device revoked at gen 1, re-admitted after a reset and revoked at gen 2 must be accepted at gen 2. Test owner: Task 5.
4. **Member-attested time.** A member-minted leaf with `iat` far ahead (≤ its lease) must not lapse other leaves of the controller. Test owner: Task 8.
5. **Saturated log.** A leaf or registry entry whose embedded or recorded log is saturated is refused. Existing leaves stay. Test owner: Tasks 2 and 6.

---

## Phase 0: Probes

Each probe is a read-and-measure task. The output is a short findings note appended to this plan under "Probe findings" and a decision logged per `autonomous-milestone-decisions-log`. Later tasks marked **(revise after Pn)** are updated from the findings before they start. BLOCKED is a valid outcome. Verify each premise in source; do not take this plan's word for it.

### Probe P1: Welcome registry ordering

**Question:** When `validateWelcomeTree` (`lifecycle.ts:328`) runs `checkSurvivors(..., { kind: 'welcome' })`, does `group.registry` already include every ledger removal and revoke the Welcome's ledger carries? Or is the tree judged before the ledger is folded?

- [ ] Trace `group-welcome.ts` from Welcome receipt to `validateWelcomeTree`, and record where `registry` is computed.
- [ ] Write a throwaway test: root revokes device X in the ledger, then a Welcome that still holds X's leaf. Record whether the joiner refuses X.
- [ ] Findings: "ordered" or "gap". On a gap, Task 6 gains a step that folds the ledger before the tree is judged.

### Probe P2: leaf events or a registry-held epoch, and size

**Question:** Does carrying the causal closure in every bound leaf stay within `HISTORY_HORIZON` (393 216) for a realistic epoch, and is the registry-held alternative worth its Welcome coupling?

- [ ] Extend `test/fixtures/history-probe.ts` with an epoch builder: 3 members (`createAdd`), renewals (`createRenew`) every 21 days over 180 days, and 4 edge revokes (`createRevoke`). Measure the closure bytes per leaf and `historySize` for groups of 2, 10 and 50 bound leaves.
- [ ] Measure the registry-held alternative: one copy of the epoch in `recordedLog`, leaves carrying only `member`/`mbr` references.
- [ ] Findings: recommend one form. Propose `MAX_EMBEDDED_EPOCH_EVENTS` (the hard cap, from the user's OQ-settle decision) and `SETTLE_PROMPT_EPOCH_EVENTS` (the prompt threshold). Escalate to the user only if the cap would force a root settle more often than every 3 months.

### Probe P3: tree-time guard

**Question:** Which guard stops member-attested `iat` inflating tree time (`lifecycle.ts:73-96`), and stops `clock` entries ratcheting `timeFloor` from member-attested time (`lifecycle-proof.ts` `op === 'clock'` branch)?

- [ ] List the consumers of `treeTime` and `timeFloor` (`isLapsed`, `checkAdmissionExpiry`, `assertSenderNotLapsed`, `removeLapsedLeaves`, `clockEntries`).
- [ ] Evaluate three options against those consumers and against an honest offline phone (30 d, OQ-offline):
  - (a) count only root-attested `iat` in `timeOf`;
  - (b) cap a member-attested `iat` at `timeFloor + MAX_ATTESTATION_SKEW`;
  - (c) let only `clock` entries advance time.
- [ ] Findings: the chosen option and its constant, if any. Task 8 implements it.

### Probe P4: kokuin integration surface

**Question:** Does `createControllerResolver({ loadLog })` over an embedded `{ chain, events }` give `resolveMember` and `frozen()` with zero external I/O? Does kokuin offer a causal-closure builder (spec N5), and does `deviceRevokeIndices` replace `revokesSubject` exactly?

- [ ] Read `@kokuin/controller` `resolver.ts`, `log.ts` (`pruneLog`, `epochHeads`) and `device-revoke.ts` at 0.2.3, and `@kokuin/capability` `member.ts` (`assertMemberRoot`).
- [ ] Findings: either a kumiai-local `closureOf(log, digests)` or a request to kokuin. Kumiai-local is the default; ask the kubun stack-adoption session first, since kokuin may add it. Also record the exact `checkCapability` options needed (`methods: [frozen]`, `maxMemberGrantLifetime`).

---

## Phase 1: Implementation

### Task 1: Catalog, log shape and the controller-log helpers

**Files:**
- Modify: `pnpm-workspace.yaml:27` (`@kokuin/controller: ^0.2.3`)
- Modify: `packages/mls/src/controller-log.ts`
- Test: `packages/mls/test/controller-log.test.ts`

**Interfaces:**
- Produces:
  - `foldControllerLog(did: string, log: ControllerLog): FoldResult`, which keeps the chain-`rev` refusal of `foldChain`.
  - `revokeIndices(did: string, chain: ReadonlyArray<SignedEvent>, subject: string): Array<number>`, which wraps `deviceRevokeIndices`.
  - `asControllerLog` stays as the chain-only lift.
  - `revokesSubject` is deleted once callers move (Task 5).

- [ ] **Step 1: Write failing tests**
  - `foldControllerLog applies member add and renew from events`: after `createAdd` and `createRenew`, `head.members` holds the member with the renewed lease.
  - `foldControllerLog refuses a chain rev`: reason `CHAIN_REVOKE_REFUSED`.
  - `revokeIndices returns both generations of a re-revoked device`: two indices.
- [ ] **Step 2:** Run `pnpm --filter @kumiai/mls exec vitest run test/controller-log.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3:** Implement both in `controller-log.ts`, bump the catalog, then run `pnpm install`.
- [ ] **Step 4:** Rerun the tests. Expected: PASS. Then run `pnpm --filter @kumiai/mls test:types`.
- [ ] **Step 5:** Commit `feat(mls): fold full controller logs and index device revokes`.

### Task 2: Embedded resolver with members **(revise after P2, P4)**

**Files:**
- Modify: `packages/mls/src/embedded-resolver.ts`
- Modify: `packages/mls/src/credential.ts` (`ControllerBinding.events?: Array<SignedEvent>`, parser)
- Test: `packages/mls/test/embedded-resolver.test.ts`, `packages/mls/test/credential-controller.test.ts`

**Interfaces:**
- Consumes: `foldControllerLog` (Task 1).
- Produces:
  - `createEmbeddedControllerResolver({ controllerID, log: ControllerLog, denySet? }): ControllerResolver`, which forwards `resolveMember` and `frozen` in addition to today's methods. `resolveDenySet` stays the injected registry set.
  - `ControllerBinding.events` is optional. The parser checks only that it is an array.

- [ ] **Step 1: Write failing tests**
  - `resolveMember answers an effective member from embedded events`: returns the pinned key and the renewed lease. This is Review Focus 2.
  - `resolveMember refuses a removed incarnation`: rejects with `MEMBER_NOT_EFFECTIVE`.
  - `resolveMember refuses on a saturated embedded log`: rejects. This is Review Focus 5.
  - `resolver loads no DID but the controller`: `loadLog` for another DID gives `undefined`.
  - `parser accepts controller.events and rejects a non-array`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. `loadLog` returns the embedded `{ chain: prefix, events }`. Keep the chain-`rev` refusal.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mls): resolve controller members from embedded epoch events`.

### Task 3: Member-rooted capabilities in leaf authentication

**Files:**
- Modify: `packages/mls/src/capability.ts` (`assertControllerGrant`; minting)
- Modify: `packages/mls/src/authentication.ts` (`verifyPinnedCapability`, `checkHolderEvidence`, `verifyManagementCapability`)
- Test: `packages/mls/test/authentication-bound.test.ts`, `packages/mls/test/holder-evidence.test.ts`, `packages/mls/test/management-capability.test.ts`, `packages/mls/test/capability.test.ts`

**Interfaces:**
- Consumes: the Task 2 resolver.
- Produces:
  - `assertControllerGrant(payload, controllerID)` accepts `iss === sub`, or `iss !== sub` with a well-formed `mbr`. The membership check itself is in `verifyPinnedCapability`.
  - `MemberRoot = { did: string; add: string; gen: number } | { root: string }`.
  - `memberRootOf(binding: ControllerBinding): MemberRoot`, exported from `capability.ts`. It reads the direct `mbr`, else the parent's `mbr`, else the holder grant's `mbr`, else root.
  - `mintLeafCapability`/`mintTrustedGrant` take an optional `member: { add: string; g: number }` and write `mbr`.

- [ ] **Step 1: Write failing tests**
  - `direct mbr leaf capability authenticates`.
  - `direct mbr leaf refused when the issuer is not an effective member`.
  - `mbr grant past the lease is refused`: kokuin `MEMBER_GRANT_PAST_LEASE` arrives wrapped as a `LeafBindingError`.
  - `holder grant minted by a member authenticates a chained leaf`.
  - `holder grant lifetime above min(lease, MAX_TRUSTED_GRANT_LIFETIME) refused`.
  - `longer holder grant does not lengthen the leaf`: a leaf capability over `leafLifetime` is refused with `lifetime-cap`.
  - `memberRootOf reads direct, parent, holder and root roots`: four cases.
  - `mbr manage capability verifies`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. On both the direct and chained arms, call `checkCapability(permission, payload, { atTime: payload.iat, methods: [resolver.frozen()], maxDepth: 1, maxMemberGrantLifetime })`. That runs `assertMemberRoot` for every `mbr` root. The direct arm still runs `verifyToken` first (signature before membership).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mls): authenticate member-issued leaf, holder and manage grants`.

### Task 4: Membership binding for a managing device's own leaf

**Files:**
- Modify: `packages/mls/src/credential.ts` (`ControllerBinding.member?: { add: string; g: number }`; `capability` optional only when `member` is present)
- Modify: `packages/mls/src/authentication.ts` (`verifyLeafCredential`: a third arm)
- Modify: `packages/mls/src/lifecycle.ts` (`attestedTime`, `isLapsed`, `checkAdmissionExpiry`, `assertSenderNotLapsed`); `packages/mls/src/lifecycle-proof.ts` (the leaves map); `packages/mls-rpc/src/recovery.ts:78-79` (`bindingID` includes `member`)
- Test: `packages/mls/test/authentication-bound.test.ts`, `packages/mls/test/credential-controller.test.ts`, `packages/mls/test/leaf-key-rotation.test.ts`

**Interfaces:**
- Consumes: `memberRootOf` (Task 3), the Task 2 resolver.
- Produces:
  - `leafExpiry(binding: ControllerBinding, lease?: number): number`, exported from `lifecycle.ts`: the capability's `exp`, or the member's lease end from the embedded log.
  - `memberRootOf` returns `{ did: leafDID, add, gen: g }` for a membership binding.
  - `attestedTime` returns 0 for a membership leaf.

- [ ] **Step 1: Write failing tests**
  - `membership leaf authenticates when the signature key equals the pin`.
  - `membership leaf refused when the signature key differs from the pin`: `confirmation-invalid`.
  - `membership leaf refused for a removed incarnation`.
  - `membership leaf lapses at the lease end by tree time`.
  - `renewal reaches a membership leaf on Update`: after `createRenew` and a leaf Update carrying the new events, the leaf is not lapsed past the old lease.
  - `membership leaf attests no tree time`.
  - `parser refuses a binding with neither capability nor member`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Compare the pin with `normalizeDID(leaf DID) === normalizeDID(member.did)` and the exact key bytes, after `matchesLeafKey`. Every `readCapability(binding.capability)` caller branches on `member`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `pnpm --filter @kumiai/mls-rpc test:unit`.
- [ ] **Step 5:** Commit `feat(mls): bind a managing device's leaf by controller membership`.

### Task 5: Registry on `ControllerLog`; epoch proof form **(revise after P4)**

**Files:**
- Modify: `packages/mls/src/registry.ts` (`ControllerProjection.recordedLog: ControllerLog`; `Revocation`/`DeviceRecord`: `logPosition` replaced by `proofRef: { chainIndex: number } | { event: string }`; `DeviceValue.proof: ControllerLog`)
- Modify: `packages/mls/src/lifecycle-proof.ts` (`authenticateLifecycleProof`)
- Modify: `packages/mls/src/group-lifecycle.ts` (`proofFor`, `revokeWithProof`, `isFullyRevoked`)
- Modify: `packages/mls/src/controller-log.ts` (delete `revokesSubject`; add `closureOf` if P4 says kumiai-local)
- Modify: `packages/rpc-conformance/src/persistence-fixture.ts` (new persisted shape)
- Test: `packages/mls/test/lifecycle-proof.test.ts`, `packages/mls/test/device-proof.test.ts`, `packages/mls/test/group-lifecycle.test.ts`, `packages/mls/test/device-attacks.test.ts`

**Interfaces:**
- Consumes: `foldControllerLog`, `revokeIndices` (Task 1).
- Produces:
  - `AuthenticatedProof = { recordedLog: ControllerLog; genFloor: number; proofRef: ProofRef }`.
  - The effect is read from `head` for epoch events (`head.deny` for `rev`, `head.members.get(add).removed` for `rmv`) and from `revokeIndices` for root rotates, taking the first index whose generation is ≥ `genFloor`.
  - `DeviceOp` gains `'remove'` (member removal, subject = member DID).
  - `proofFor` emits the chain plus `closureOf(events, [target])`.

- [ ] **Step 1: Write failing tests**
  - `member rev of an edge DID is a valid revoke proof`.
  - `member rmv is a valid remove proof`.
  - `epoch proof keyed by event digest; replay of the same digest is effects-mismatch`.
  - `re-revoke after reset accepted at gen 2`: Review Focus 3.
  - `partial closure refused`: a `rev` whose parent is missing is refused with `not-authority-signed`.
  - `saturated proof refused`.
  - `stored epoch proof upgrades to chain form after settle`: after root `rot` with `snapshotOf(head)`, the record's `proofRef` is `chainIndex` and denial persists.
  - `deny read from head, not states.at(-1)`: N1 mutation-check. Make the fixer swap to `states.at(-1)` and see the test fail.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Producer and verifier share one function for "which effect does this proof prove".
- [ ] **Step 4:** Run the tests. Expected: PASS. Run the `@kumiai/rpc-conformance` and `@kumiai/mls-rpc` suites.
- [ ] **Step 5:** Commit `feat(mls)!: device registry records full controller logs and epoch proofs`.

### Task 6: Member-root cascade and current-state acceptance **(revise after P1)**

**Files:**
- Modify: `packages/mls/src/lifecycle-proof.ts` (leaves map: `memberRoot` replaces `issuer`; cascade; `isEvidencedChild`; `effectsMatch`)
- Modify: `packages/mls/src/registry.ts` (`effectiveMemberRoot(registry, controller, root: MemberRoot): boolean`, read from the head of the recorded log)
- Modify: `packages/mls/src/lifecycle.ts` (`validateBoundLeaf`, `checkSurvivors`, and Welcome ordering if P1 found a gap)
- Modify: `packages/mls/src/authentication.ts` (`DIDAuthenticationDependencies.effectiveMemberRoot?`)
- Test: `packages/mls/test/cascade-exemption.test.ts`, `packages/mls/test/lifecycle-pipeline.test.ts`, `packages/mls/test/external-rejoin.test.ts`

**Interfaces:**
- Consumes: `memberRootOf` (Task 3), the registry from Task 5.
- Produces: `effectiveMemberRoot`. Every member-authored registry entry, leaf and `manage` grant is accepted only when it returns true at acceptance.

- [ ] **Step 1: Write failing tests**
  - `rmv cascades a direct mbr leaf`.
  - `rmv cascades a leaf whose holder grant came from the removed member`.
  - `rmv keeps a leaf whose holder grant came from another effective member`.
  - `edge rev cascades its chained leaves only`.
  - `removed member's earlier-signed leaf arriving after the removal is refused`: Review Focus 1.
  - `removed member's concurrent registry entry is refused`: Review Focus 1.
  - `survivor grant from the surviving member keeps the leaf; from the removed member it does not`.
  - `Welcome joiner refuses a leaf the ledger removed`: from P1.
  - `saturated recorded log refuses new member-authored entries, keeps existing leaves`: Review Focus 5.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. `proofFor`/`effectsMatch` and `checkSurvivors` call one shared `cascadeOf(leaves, effect, registry)`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Mutation-check the current-state rule: make the fixer skip `effectiveMemberRoot` and confirm Review Focus 1 fails.
- [ ] **Step 5:** Commit `feat(mls): cascade and accept by member root against current registry state`.

### Task 7: Embedded-event cap and settle prompt **(revise after P2)**

**Files:**
- Modify: `packages/mls/src/history.ts` (constants), `packages/mls/src/authentication.ts` or the `lifecycle.ts` entry gate (cap)
- Modify: `packages/mls/src/index.ts` (export `settleAdvisory`)
- Test: `packages/mls/test/history-size.test.ts`

**Interfaces:**
- Produces:
  - `MAX_EMBEDDED_EPOCH_EVENTS` and `SETTLE_PROMPT_EPOCH_EVENTS`, with values from P2.
  - `settleAdvisory(log: ControllerLog): 'ok' | 'prompt' | 'blocked'` for hosts (kubun, Sakui) to show the settle prompt.
  - A new member-issued leaf with more embedded epoch events than the cap is refused with `LeafBindingError('epoch-cap')`.

- [ ] **Step 1: Write failing tests**
  - `leaf with events over the cap refused with epoch-cap`.
  - `settleAdvisory thresholds`: three cases.
  - `realistic epoch fits HISTORY_HORIZON`: the P2 fixture, asserting `historySize < HISTORY_HORIZON` at 50 leaves.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `'epoch-cap'` to the `LeafBindingError` reasons in `errors.ts`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mls): cap embedded epoch events and advise settling`.

### Task 8: Tree-time guard **(revise after P3)**

**Files:**
- Modify: `packages/mls/src/lifecycle.ts` (`attestedTime`/`timeOf`), `packages/mls/src/lifecycle-proof.ts` (`clock` branch)
- Test: `packages/mls/test/lifecycle-pipeline.test.ts`, `packages/mls/test/group-lifecycle.test.ts`

**Interfaces:**
- Consumes: `memberRootOf` (Task 3).
- Produces: the P3 option. If (b), add `MAX_ATTESTATION_SKEW` with the value P3 chose, in `lifecycle.ts`.

- [ ] **Step 1: Write failing tests**
  - `member leaf with iat at its lease end does not lapse other leaves`: Review Focus 4.
  - `clock entry cannot raise timeFloor past root-bounded time`.
  - `honest offline phone member keeps its leaves for 30 days`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the P3 option.
- [ ] **Step 4:** Run the tests. Expected: PASS. Mutation-check it: remove the guard and confirm Review Focus 4 fails.
- [ ] **Step 5:** Commit `fix(mls): bound member-attested tree time`.

### Task 9: Contracts, doubles, band and docs

**Files:**
- Modify: `packages/rpc-conformance/src/**` and `packages/hub-conformance/src/**`, wherever a controller binding, registry shape or revoke proof appears. Locate them with `grep -rn "holderGrant\|recordedLog\|logPosition\|ControllerBinding"`.
- Modify: `packages/mls/README.md` and `docs/agents/architecture.md` (binding forms, member root, proof form)
- Create: `pnpm change` intents for all fourteen packages at 0.12 (see the `kumiai-release-mechanics` memory)
- Test: both conformance suites, real implementation and doubles

- [ ] **Step 1:** Add conformance cases: an `mbr` leaf, a membership leaf, an epoch revoke proof, a removed member root refused, and a saturated log refused. Each runs against the real implementation and every double. The doubles must refuse at least as much as the real code does.
- [ ] **Step 2:** Run both suites (a heavy run: request first). Expected: PASS on the real implementation and the doubles.
- [ ] **Step 3:** Update the docs to describe the surface only (`terse-code-comments` memory).
- [ ] **Step 4:** Run `turbo run test:types` repo-wide (heavy run), then the forced full test (`Cached: 0`), then `rtk proxy pnpm run lint`. Expected: all green.
- [ ] **Step 5:** Commit `chore!: band 0.12, management tier contracts and docs`.

## Probe findings

(Appended during Phase 0.)
