# kumiai band 0.12: kokuin management tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** `@kumiai/mls` accepts MLS leaves, holder grants, registry entries and revoke proofs authorised by `did:kokuin:` management members (`mbr`), so a controller's devices run groups with the root seed cold.

**Architecture:** Bound leaves keep the chain-only `prefix`. The controller's current epoch lives once per group in the device registry: `recordedLog: ControllerLog`, fed by signed `kumiai.device` `log` entries carrying epoch-event deltas (P2: per-leaf closures overflow `HISTORY_HORIZON` at 50 leaves). Verification resolves members through a `@kokuin/controller` resolver over the registry's recorded log (`resolveMember` on one `frozen()` view), with zero external I/O. A managing device binds its own leaf by membership (`controller.member`, no capability); other leaves keep capabilities whose root may be `mbr`. The device registry records `ControllerLog`s, and every acceptance judges a leaf's **member root** (member DID, add digest, generation) against the registry's current authenticated head, never against delivered bytes.

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

- Phase 0 rulings are binding (see "Probe findings"): R2 tree time, R3–R7 kokuin integration, R8 registry-held epoch, R9 Welcome staging.

## Review Focus

1. **Concurrent removal.** A member removed in the ledger whose earlier-signed leaf, grant or registry entry arrives later must be refused at acceptance, even though kokuin's causal fold keeps its events. Test owner: Task 7.
2. **Renewed member, old snapshot.** A member renewed in epoch events after the last root settle must mint grants up to the renewed lease. The registry-held log must carry the renewal. Test owner: Task 2.
3. **Re-revoke after reset.** A device revoked at gen 1, re-admitted after a reset and revoked at gen 2 must be accepted at gen 2. Test owner: Tasks 1 and 6.
4. **Member-attested time.** A member-minted leaf with `iat` far ahead (≤ its lease) must not lapse other leaves of the controller. Test owner: Task 9.
5. **Saturated log.** A leaf or registry entry whose recorded log is saturated is refused. Existing leaves stay. Test owner: Tasks 3 and 7.

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
  - `revokeIndices(did: string, chain: ReadonlyArray<SignedEvent>, subject: string): Array<number>`, which wraps `deviceRevokeIndices` (R3).
  - `closureOf(did: string, log: ControllerLog, targets: ReadonlyArray<string>): ControllerLog | undefined` (R5). It returns the chain plus every target event and its epoch ancestors, keeping the authenticated copies. It returns `undefined` when any target or ancestor is missing, or when a target is not in the fold's `applied`.
  - `asControllerLog` stays. `revokesSubject` is deleted when Task 6 moves its callers.

- [ ] **Step 1: Write failing tests**
  - `foldControllerLog applies member add and renew from events`: after `createAdd` and `createRenew`, `head.members` holds the member with the renewed lease.
  - `foldControllerLog refuses a chain rev`: reason `CHAIN_REVOKE_REFUSED`.
  - `revokeIndices matches revokesSubject on every index`: a table of chains (canonical long/short `did:peer:4` aliases, a repeated denial, a denial cleared by reset, a re-revoke at gen 2). For each, `revokeIndices` equals the indices `revokesSubject` accepts. Review Focus 3.
  - `closureOf returns the renew with its add`, `closureOf refuses a missing parent`, `closureOf refuses a target not applied`.
- [ ] **Step 2:** Run `pnpm --filter @kumiai/mls exec vitest run test/controller-log.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3:** Bump the catalog and run `pnpm install`. Implement the helpers in `controller-log.ts`.
- [ ] **Step 4:** Rerun the tests. Expected: PASS. Then run `pnpm --filter @kumiai/mls test:types`.
- [ ] **Step 5:** Commit `feat(mls): fold full controller logs, index device revokes, build causal closures`.

### Task 2: Registry-held epoch (`log` entries)

**Files:**
- Modify: `packages/mls/src/registry.ts`:
  - `ControllerProjection.recordedLog: ControllerLog`;
  - `DeviceOp` gains `'log'`;
  - `DeviceValue.events?: Array<SignedEvent>` for `log`;
  - `registryApply` merges a `log` entry.
- Modify: `packages/mls/src/lifecycle-proof.ts` (`verifyLifecycleProof` accepts `log`)
- Modify: `packages/mls/src/group-lifecycle.ts`: `publishControllerEvents(group, controller, events): Promise<DeviceWriteResult>`, the producer.
- Modify: `packages/mls/src/history.ts` (count `recordedLog.events` and `log` entry events)
- Test: `packages/mls/test/device-events.test.ts`, `packages/mls/test/history-size.test.ts`

**Interfaces:**
- Consumes: `foldControllerLog`, `closureOf` (Task 1).
- Produces:
  - `recordedLogOf(registry: DeviceRegistry, controller: string): ControllerLog`, which is `{ chain: [], events: [] }` when absent.
  - A `log` entry is accepted only when `foldControllerLog(controller, merge(recorded, delta))` succeeds and every delta digest is in `applied`. The stored log is the pruned fold input, never the raw delta (the ingestion contract).
  - The author is any device bound to that controller.
  - The entry carries only events the recorded log lacks.

- [ ] **Step 1: Write failing tests**
  - `log entry adds a member to the recorded log`.
  - `log entry with a renew extends the recorded lease`: Review Focus 2.
  - `log entry whose events leave a parent pending is refused`.
  - `log entry carrying an unauthenticated event copy is refused, and the recorded log is unchanged`.
  - `log entry from a device bound to another controller is refused`.
  - `history counts each epoch event once`: the P2 workload (3 members, renewals every 21 d to day 168, 4 revokes, 50 bound leaves) gives `historySize < HISTORY_HORIZON`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Merge with kokuin `mergeLogs` and keep the result of `pruneLog`. Count events in `historySize`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Run `pnpm --filter @kumiai/rpc-conformance test:unit` (persisted shape).
- [ ] **Step 5:** Commit `feat(mls)!: device registry holds each controller's epoch via log entries`.

### Task 3: Resolver over the recorded log

**Files:**
- Modify: `packages/mls/src/embedded-resolver.ts`
- Test: `packages/mls/test/embedded-resolver.test.ts`

**Interfaces:**
- Consumes: `recordedLogOf` (Task 2).
- Produces: `createEmbeddedControllerResolver({ controllerID, prefix, recorded?: ControllerLog, denySet? }): ControllerResolver`.
  - `loadLog` returns `recorded` when it is present and its chain extends `prefix`. Otherwise it returns `asControllerLog(prefix)`, which means no members.
  - It forwards `resolveMember`.
  - `frozen()` is kumiai's own: one fold per verification, and it still answers `resolveDenySet` from the injected registry set (R4).
  - Resolver queries use `{ did, add, gen }` (R6).

- [ ] **Step 1: Write failing tests**
  - `resolveMember answers an effective member from the recorded log, with the renewed lease`.
  - `resolveMember refuses a removed incarnation`.
  - `resolveMember refuses on a saturated recorded log`: Review Focus 5.
  - `frozen view keeps the injected deny set`: a DID denied in the registry but not in the log is denied.
  - `recorded log whose chain does not extend the leaf prefix is not used`.
  - `loads no DID but the controller`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mls): resolve controller members from the registry's recorded log`.

### Task 4: Member-rooted capabilities in leaf authentication

**Files:**
- Modify: `packages/mls/src/capability.ts` (`assertControllerGrant`; minting)
- Modify: `packages/mls/src/authentication.ts` (`verifyPinnedCapability`, `checkHolderEvidence`, `verifyManagementCapability`; `DIDAuthenticationDependencies.recordedLog?: (controller: string) => ControllerLog | undefined`)
- Modify: `packages/mls/src/lifecycle.ts` and `packages/mls/src/group-context.ts` (pass the registry's recorded log)
- Test: `packages/mls/test/authentication-bound.test.ts`, `packages/mls/test/holder-evidence.test.ts`, `packages/mls/test/management-capability.test.ts`, `packages/mls/test/capability.test.ts`

**Interfaces:**
- Consumes: the Task 3 resolver.
- Produces:
  - `assertControllerGrant(payload, controllerID)` accepts `iss === sub`, or `iss !== sub` with a well-formed `mbr`.
  - `MemberRoot = { did: string; add: string; gen: number } | { root: string }`.
  - `memberRootOf(binding: ControllerBinding, leafDID: string): MemberRoot` (R1), which reads the direct `mbr`, then the parent's, then the holder grant's, else root.
  - `mintLeafCapability`/`mintTrustedGrant` take `member?: { add: string; g: number }` and write `mbr`.

- [ ] **Step 1: Write failing tests**
  - `direct mbr leaf capability authenticates`.
  - `direct mbr leaf refused when the issuer is not an effective member`.
  - `mbr grant past the lease is refused`.
  - `holder grant minted by a member authenticates a chained leaf`.
  - `member holder grant over the group trustedGrantLifetime is refused`.
  - `longer holder grant does not lengthen the leaf`: a leaf capability over `leafLifetime` is refused with `lifetime-cap`.
  - `memberRootOf reads direct, parent, holder and root roots`.
  - `mbr manage capability verifies`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement as in P4. Create `const frozen = resolver.frozen()` once per verification. Verify the signature first: `verifyToken(raw, { methods: [frozen], atTime: payload.iat, historic: true, allowUnsigned: false })`. Then call `checkCapability(permission, payload, { atTime: payload.iat, methods: [frozen], maxDepth: 1, maxMemberGrantLifetime })`, with `maxMemberGrantLifetime` set to the role's ceiling: `MAX_TRUSTED_GRANT_LIFETIME` for holder grants and `MAX_LEAF_LIFETIME` for leaf capabilities. The local lifetime checks stay.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mls): authenticate member-issued leaf, holder and manage grants`.

### Task 5: Membership binding and Welcome staging

**Files:**
- Modify: `packages/mls/src/credential.ts` (`ControllerBinding.member?: { add: string; g: number }`; `capability` optional only when `member` is present; the parser)
- Modify: `packages/mls/src/authentication.ts` (`verifyLeafCredential`: the membership arm; `DIDAuthenticationDependencies.deferMemberAuthority?: boolean`)
- Modify: `packages/mls/src/group-welcome.ts:84-90`, so that the early join check passes `deferMemberAuthority: true` (R9)
- Modify: `packages/mls/src/lifecycle.ts` (`attestedTime`, `isLapsed`, `checkAdmissionExpiry`, `assertSenderNotLapsed`), `packages/mls/src/lifecycle-proof.ts` (the leaves map), `packages/mls/src/recovery-verdict.ts`, `packages/mls-rpc/src/recovery.ts:78-79` (`bindingID` includes `member`)
- Test: `packages/mls/test/authentication-bound.test.ts`, `packages/mls/test/credential-controller.test.ts`, `packages/mls/test/lifecycle-invite.test.ts`

**Interfaces:**
- Consumes: `memberRootOf` (Task 4) and the Task 3 resolver.
- Produces:
  - `leafExpiry(binding: ControllerBinding, lease?: number): number`, in `lifecycle.ts`: the capability `exp`, or the member's lease from the recorded log.
  - `memberRootOf` returns `{ did: leafDID, add, gen: g }` for a membership binding.
  - `attestedTime` is 0 for a membership leaf.
  - When `deferMemberAuthority` is set, `verifyLeafCredential` checks only the key binding and the prefix fold for member-rooted leaves. `validateWelcomeTree` runs after the ledger fold (P1) and does the full check.

- [ ] **Step 1: Write failing tests**
  - `membership leaf authenticates when the signature key equals the pin`.
  - `membership leaf refused when the signature key differs from the pin`: `confirmation-invalid`.
  - `membership leaf refused for a removed incarnation`.
  - `membership leaf lapses at its lease end by tree time`.
  - `renewal reaches a membership leaf through a log entry`: after a `log` entry with `createRenew`, the leaf is not lapsed past the old lease.
  - `phone member keeps its leaf 30 days on a 90-day lease`: lease 7 776 000 s, tree time advanced 2 592 000 s.
  - `membership leaf attests no tree time`.
  - `parser refuses a binding with neither capability nor member`.
  - `Welcome with an mbr leaf joins once the ledger carries the member's add`.
  - `Welcome with an mbr leaf whose member the ledger lacks is refused`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The pin check is `normalizeDID(leafDID) === normalizeDID(member.did)` plus an exact key-bytes match after `matchesLeafKey`. Every `readCapability(binding.capability)` caller branches on `member`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `pnpm --filter @kumiai/mls-rpc test:unit`.
- [ ] **Step 5:** Commit `feat(mls): bind a managing device's leaf by controller membership`.

### Task 6: Epoch revoke and remove proofs

**Files:**
- Modify: `packages/mls/src/registry.ts`:
  - `Revocation`/`DeviceRecord.logPosition` becomes `proofRef: { chainIndex: number } | { event: string }`;
  - `DeviceOp` gains `'remove'`;
  - `DeviceValue.proof: ControllerLog`.
- Modify: `packages/mls/src/lifecycle-proof.ts` (`authenticateLifecycleProof`), `packages/mls/src/group-lifecycle.ts` (`proofFor`, `revokeWithProof`, `isFullyRevoked`), `packages/mls/src/controller-log.ts` (delete `revokesSubject`)
- Modify: `packages/rpc-conformance/src/persistence-fixture.ts`
- Test: `packages/mls/test/lifecycle-proof.test.ts`, `packages/mls/test/device-proof.test.ts`, `packages/mls/test/group-lifecycle.test.ts`, `packages/mls/test/device-attacks.test.ts`

**Interfaces:**
- Consumes: `foldControllerLog`, `revokeIndices`, `closureOf` (Task 1); the recorded log (Task 2).
- Produces: `AuthenticatedProof = { recordedLog: ControllerLog; genFloor: number; proofRef: ProofRef }`.
  - Epoch effects are read from `head`: `head.deny` for `rev`, and `head.members.get(add)?.removed` for `rmv`. Both sides are normalised (R7). The target digest must be in `applied` (R5).
  - Root-rotate effects use `revokeIndices`, taking the first index whose generation is ≥ `genFloor`.
  - The proof is merged into the recorded log the same way as a `log` entry.
  - `proofFor` emits `closureOf(controller, recorded, [target])`.

- [ ] **Step 1: Write failing tests**
  - `member rev of an edge DID is a valid revoke proof`.
  - `member rmv is a valid remove proof`.
  - `epoch proof keyed by event digest; replay of the same digest is effects-mismatch`.
  - `re-revoke after reset accepted at gen 2`: Review Focus 3.
  - `partial closure refused`.
  - `saturated proof refused`.
  - `revoke of a long-form did:peer:4 matches the short-form leaf`: R7.
  - `stored epoch proof upgrades to chain form after settle`.
  - `deny read from head, not states.at(-1)`: N1. Mutation-check it: make the fixer swap the read to `states.at(-1)` and confirm the test fails.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The producer and the verifier share one function that answers "which effect does this proof prove".
- [ ] **Step 4:** Run the tests. Expected: PASS. Run the `@kumiai/rpc-conformance` and `@kumiai/mls-rpc` suites.
- [ ] **Step 5:** Commit `feat(mls)!: epoch revoke and member-remove proofs`.

### Task 7: Member-root cascade and current-state acceptance

**Files:**
- Modify: `packages/mls/src/lifecycle-proof.ts` (leaves map: `memberRoot` replaces `issuer`; cascade; `isEvidencedChild`; `effectsMatch`)
- Modify: `packages/mls/src/registry.ts` (`effectiveMemberRoot(registry, controller, root: MemberRoot): boolean`, read from the recorded log's head)
- Modify: `packages/mls/src/lifecycle.ts` (`validateBoundLeaf`, `checkSurvivors`)
- Test: `packages/mls/test/cascade-exemption.test.ts`, `packages/mls/test/lifecycle-pipeline.test.ts`, `packages/mls/test/external-rejoin.test.ts`

**Interfaces:**
- Consumes: `memberRootOf` (Task 4); the registry from Tasks 2 and 6.
- Produces: `effectiveMemberRoot`, plus one shared `cascadeOf(leaves, effect, registry)` used by `proofFor`, `effectsMatch` and `checkSurvivors`.

- [ ] **Step 1: Write failing tests**
  - `rmv cascades a direct mbr leaf`.
  - `rmv cascades a leaf whose holder grant came from the removed member`.
  - `rmv keeps a leaf whose holder grant came from another effective member`.
  - `rmv cascades the removed member's own membership leaf`.
  - `edge rev cascades its chained leaves only`.
  - `removed member's earlier-signed leaf arriving after the removal is refused`: Review Focus 1.
  - `removed member's concurrent registry entry is refused`: Review Focus 1.
  - `survivor grant from the surviving member keeps the leaf; from the removed member it does not`.
  - `Welcome joiner refuses a leaf the ledger removed`: start from `packages/mls/test/probe-p1-welcome-ordering.test.ts` (untracked, P1), adapt it here, then delete the probe file.
  - `saturated recorded log refuses new member-authored entries, keeps existing leaves`: Review Focus 5.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS. Mutation-check the current-state rule: make the fixer skip `effectiveMemberRoot` and confirm Review Focus 1 fails.
- [ ] **Step 5:** Commit `feat(mls): cascade and accept by member root against current registry state`.

### Task 8: Epoch-event cap and settle advisory

**Files:**
- Modify: `packages/mls/src/history.ts` (constants), `packages/mls/src/errors.ts` (`'epoch-cap'`), `packages/mls/src/authentication.ts` (cap), `packages/mls/src/index.ts` (export)
- Test: `packages/mls/test/history-size.test.ts`

**Interfaces:**
- Produces:
  - `MAX_EPOCH_EVENTS_FOR_LEAVES = 32` and `SETTLE_PROMPT_EPOCH_EVENTS = 24` (P2).
  - `settleAdvisory(log: ControllerLog): 'ok' | 'prompt' | 'blocked'`: 0–23 gives `ok`, 24–32 gives `prompt`, more than 32 gives `blocked`. It counts the distinct applied events of the current epoch.
  - A new member-rooted leaf, while the recorded epoch holds more than 32 events, is refused with `LeafBindingError('epoch-cap')`.
  - `log`, revoke and remove entries are never capped, so security events still land.

- [ ] **Step 1: Write failing tests**
  - `member-rooted leaf refused with epoch-cap past 32 events`.
  - `log entry still accepted past the cap`.
  - `settleAdvisory thresholds`: 23, 24, 32 and 33 events.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mls): cap member-rooted leaves by epoch size and advise settling`.

### Task 9: Tree-time guard (R2)

**Files:**
- Modify: `packages/mls/src/lifecycle.ts` (`attestedTime`/`timeOf`), `packages/mls/src/lifecycle-proof.ts` (the `clock` bound, `attested`), `packages/mls/src/group-lifecycle.ts` (`clockEntries`), `packages/mls/src/recovery-verdict.ts` (`recoverySignerEligible`)
- Test: `packages/mls/test/lifecycle-pipeline.test.ts`, `packages/mls/test/group-lifecycle.test.ts`

**Interfaces:**
- Consumes: `memberRootOf` (Task 4) and `effectiveMemberRoot` (Task 7).
- Produces: `attestedTreeTime(tree, controllerID, floor, registry): number` in `lifecycle.ts`, the single rule all four scans call. It returns `max(floor, root-attested iat, quorum member time)`.
  - The quorum member time is the second-highest of the per-member-root maxima across distinct effective member roots. It is the highest when the controller has exactly one effective member.
  - The token whose `iat` counts is the one the current code selects (direct leaf, or the parent of a chained leaf). It is classified by its own `iss`.
  - The existing `<` and `<=` expiry boundaries and the historical-epoch floors stay unchanged.

- [ ] **Step 1: Write failing tests**
  - `single member of two with iat = lease - 60 does not lapse other leaves`: Review Focus 4.
  - `two members agreeing advance tree time`.
  - `sole effective member advances tree time`.
  - `clock entry cannot raise timeFloor past attestedTreeTime`.
  - `removed member's attestation stops counting`.
  - `recovery eligibility uses attestedTreeTime`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement and route all four scans through `attestedTreeTime`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Mutation-check it: count every member's attestation and confirm Review Focus 4 fails.
- [ ] **Step 5:** Commit `fix(mls): bound member-attested tree time by member quorum`.

### Task 10: Contracts, doubles, band and docs

**Files:**
- Modify: `packages/rpc-conformance/src/**` and `packages/hub-conformance/src/**`, wherever a controller binding, registry shape or revoke proof appears. Locate them with `grep -rn "holderGrant\|recordedLog\|logPosition\|ControllerBinding"`.
- Modify: `packages/mls/README.md` and `docs/agents/architecture.md` (binding forms, member root, `log` entries, proof form)
- Create: `pnpm change` intents for all fourteen packages at 0.12
- Test: both conformance suites, real implementation and doubles

- [ ] **Step 1:** Add conformance cases: an `mbr` leaf, a membership leaf, a `log` entry, an epoch revoke proof, a removed member root refused, and a saturated log refused. Run each against the real implementation and every double. The doubles must refuse at least as much as the real code does.
- [ ] **Step 2:** Run both suites (a heavy run: request first). Expected: PASS on the real implementation and the doubles.
- [ ] **Step 3:** Update the docs to describe the surface only.
- [ ] **Step 4:** Run `turbo run test:types` repo-wide (heavy run), then the forced full test (`Cached: 0`), then `rtk proxy pnpm run lint`. Expected: all green.
- [ ] **Step 5:** Commit `chore!: band 0.12, management tier contracts and docs`.

## Probe findings

Full reports live in the plan workspace (`.superpowers/sdd/2026-10-23-management-tier/task-P<n>-report.md`).

- **P1 (ordered).** `processWelcome` folds the ledger (`applyLedgerEntries`) before `validateWelcomeTree` (`group-welcome.ts:156`). No ordering repair is needed.
- **P2 (registry-held).** Per-leaf closures for a 6-month, 3-member epoch cost 755 550 history bytes at 50 leaves (horizon 393 216). Registry-held costs 34 511. The early join check verifies credentials before the ledger exists (`group-welcome.ts:84`).
  - **R8:** the epoch lives in the registry via `log` entries (Task 2). Leaves keep the chain-only prefix.
  - **R9:** the early join check defers member authority (`deferMemberAuthority`). `validateWelcomeTree` does the full check after the fold (Task 5).
  - Cap 32, prompt 24.
- **P3 (tree time).** The report recommended root-only attestation.
  - **R2** overrides it: root-only time freezes while root is cold, so leaves never lapse. The quorum rule (Task 9) is used instead, with no skew constant.
  - Four independent scans share the rule: `lifecycle.ts`, `lifecycle-proof.ts`, `group-lifecycle.ts`, `recovery-verdict.ts`.
  - MLS requires `exp > iat`, so the fixture uses `iat = lease - 60`.
- **P4 (integration).** The embedded resolver works with zero I/O.
  - **R3:** pin `deviceRevokeIndices` equivalence in Task 1's tests (0.2.3 was not installed during the probe).
  - **R4:** use kumiai's own `frozen()`, because the base one bypasses the injected deny set.
  - **R5:** `closureOf(did, log, targets)` is kumiai-local (kubun confirmed). A target must be in `applied`.
  - **R6:** the resolver query uses `gen`, while the token claim uses `mbr.g`.
  - **R7:** normalise both sides when reading kokuin `head.deny`/`members`.
