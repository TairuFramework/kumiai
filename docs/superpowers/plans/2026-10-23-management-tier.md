# kumiai band 0.12: kokuin management tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** `@kumiai/mls` accepts MLS leaves, holder grants, registry entries and revoke proofs authorised by `did:kokuin:` management members (`mbr`), so a controller's devices run groups with the root seed cold.

**Architecture:** Bound leaves keep the chain-only `prefix`. The controller's current epoch lives once per group in the device registry: `recordedLog: ControllerLog`, fed by signed `kumiai.device` entries (`log`, `revoke`, `reset`) that each carry a `ControllerLog` delta and are stored only as kokuin's `authoritativeLog(...).log` (P2: per-leaf closures overflow `HISTORY_HORIZON` at 50 leaves). Verification resolves members through a resolver over the registry's recorded log (`resolveMember` on one `frozen()` view), with zero external I/O. A managing device binds its own leaf by membership (`controller.member`, no capability); other leaves keep capabilities whose root may be `mbr`. Every acceptance judges a leaf's **member root** (member DID, add digest, generation) against an explicitly named registry (the candidate registry of the commit being judged, or the historical one of a delayed frame), never against delivered bytes. Revision after the plan review: see "Design decisions (plan revision)" and "Plan review dispositions".

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

- Phase 0 rulings are binding (see "Probe findings"): R2 tree time, R3–R7 kokuin integration, R8 registry-held epoch, R9 Welcome staging. R2 is superseded by the user's clock-authority decision (D12); R9 is generalised by D9.
- Every task pairs its vitest run with `pnpm --filter <package> test:types` (vitest strips types).

## Review Focus

1. **Concurrent removal.** A member removed in the ledger whose earlier-signed leaf, grant or registry entry arrives later must be refused at acceptance, even though kokuin's causal fold keeps its events. Test owner: Tasks 3, 6 and 12.
2. **Renewed member, old snapshot.** A member renewed in epoch events after the last root settle must mint grants up to the renewed lease. The registry-held log must carry the renewal. Test owner: Tasks 3 and 8.
3. **Re-revoke after reset.** A device revoked at gen 1, re-admitted after a reset and revoked at gen 2 must be accepted at gen 2. Test owner: Tasks 1, 4 and 11.
4. **Member-attested time.** A member-minted leaf with `iat` far ahead (≤ its lease) must not lapse other leaves of the controller. Test owner: Task 13.
5. **Saturated log.** A leaf or registry entry whose recorded log is saturated is refused. Existing leaves stay. Test owner: Tasks 5, 6 and 10.

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

## Design decisions (plan revision)

These answer the plan review (`.superpowers/sdd/2026-10-23-management-tier/plan-review-codex.md`) and bind Tasks 2–15. Each was checked against `packages/mls/src`, `packages/mls-rpc/src` and `node_modules/@kokuin/*` at 0.2.3 / 0.5.1 / 0.6.1.

- **D1 Delta carriage and ingestion.** Every proof-bearing device entry (`log`, `revoke`, `reset`) carries `proof: ControllerLog`, a delta over the registry's recorded log:
  - `proof.chain` is empty (no chain change), a suffix whose first event's `p` is the recorded chain head, or a full chain from `icp` (no recorded log yet, or a reset);
  - `proof.events` are epoch events the recorded log lacks.
  The registry stores only `authoritativeLog({ did, loaded: join(recorded, proof), seen: recorded, context }).log` (spec ingestion contract; kokuin `history.d.ts`). A throw (`LOG_FORKED`, `LOG_NOT_AUTHORITATIVE`, `LOG_UNFOLDABLE`, the signature limit) refuses the entry, and the prior log is kept. `seen` is always a value this same function produced, because the registry is a pure fold of the ledger (`foldControl`), so kokuin's "trusted stored copies" rule holds.
- **D2 Genesis.** `createGroup` takes `options.controllerLog` (the author's own authoritative copy). For a lifecycle group it signs a genesis `log` entry (issuer: the creator, subject: the controller) carrying `pruneLog(controller, controllerLog)`, and starts the ledger with it: the head extension is `extendHead(genesisHead(groupID), [entryID])` and the handle's ledger holds the entry. Joiners recompute that head from `invite.ledgerEntries` as today (`group-welcome.ts:134`). A member-rooted creator leaf without `controllerLog` is refused (`member-unavailable`). A root-rooted creator may omit it; the first later `log` entry then carries a full chain.
- **D3 Settlement and reset transport.** A settlement without a revoke is a `log` entry whose chain suffix is a same-generation `rot`. A reset stays `op: 'reset'` (full chain from `icp`).
- **D4 `log` entries are effect-free.** `effectDelta(before, after)` must be empty: no new DID denial, no member that was effective becoming non-effective, no generation change. Lease changes and new members are allowed. A delta with effects must travel as a `revoke` (D6) or `reset` entry.
- **D5 Current-authority rule (endorsement).** Kokuin authorises causally, so a removed member's concurrent event stays applied (`epoch.js` `ren`/`rmv` branch: "removal dominates renewal at the join"). Kumiai accepts a delta only when every event it newly applies is endorsed. An event is endorsed when its author is root (no `by`) or an incarnation that is effective in the post-merge head, or when it is an ancestor of an endorsed newly applied event. Events already in the recorded log are not re-judged: applied state wins.
- **D6 Effect descriptor.** A `revoke` entry's subject is the controller. It declares `effects: Array<EffectClaim>`, which must equal `effectDelta(before, after)` exactly, in canonical order. Each claim names the event or chain index that proves it (`ref: ProofRef`), and `effectOf` checks that the ref proves that claim and nothing weaker. One proof entry per commit stays (`lifecycle.ts:396`); a removal plus a device revoke of the same device may share one entry.
- **D7 Removed member roots are not denied DIDs.** A `remove` claim tombstones the incarnation in `ControllerProjection.removedMembers` (keyed by add digest). Its cascade removes leaves from the tree but writes no device record, so a cascaded device may return under another effective member's grant or a new incarnation. A `deny` claim writes revoked device records as today (`registry.ts:187-200`).
- **D8 Member-root status.** `memberRootStatus` answers `'root' | 'effective' | 'removed' | 'unavailable'`.
  - `removed`: the incarnation is tombstoned, kokuin reports it removed or denied, or `mbr.g` names another generation.
  - `unavailable`: no recorded log, a saturated head, an unknown add digest, or a leaf prefix the recorded chain does not contain.
  Every consumer treats the two outcomes differently.
- **D9 Judging context.** Authentication takes `{ registry?, stage: 'structural' | 'full', mode: 'admit' | 'retain' | 'rejudge' }`.
  - `structural` checks everything except member authority: key binding, prefix fold, token structure, every signature including `mbr` tokens against their `iss` DID, and lifetimes.
  - `admit` judges a new credential: full authority, cap (D11), no substitute authority.
  - `retain` judges a credential byte-identical to one already in the pre-commit tree. `removed` falls back to substitutes (D10), and `unavailable` keeps the leaf.
  - `rejudge` judges a Welcome or rejoin tree. It requires full authority (`unavailable` refuses) and allows substitutes, with no cap.
  The "Staged verification" table in Task 9 names the registry each phase reads.
- **D10 Survivor authority.** `effectiveAuthorityOf(leaf)` takes the primary root (the capability chain's root, or the membership incarnation). When that root is removed, it uses a substitute in order: the holder grant's root (evidenced child), then a survivor grant registered by the accepted `revoke` entry (Task 12). Authentication (`retain`/`rejudge`), cascade, `checkSurvivors`, Welcome and recovery all call this one function. A later cascade keys on the substitute's root.
- **D11 Cap only on admission.** `epoch-cap` refuses only `admit` of a member-rooted credential. Unchanged leaves, Welcome trees, root-issued admissions and lifecycle entries are never capped. The count is the distinct applied events of the recorded current epoch; cap 32, prompt 24 (P2).
- **D12 Clock authority (user decision, 2026-10-23).** Tree time is `max(timeFloor, quorum)`.
  - The quorum ranges over the distinct pinned keys of effective members: the second-highest per-key attestation, or the highest when exactly one key is effective, or 0 with none.
  - A key's attestation is the max of the `iat` of member-issued tokens in the tree (the token the current scans select: direct capability, or the parent of a chained leaf) and the member's registry-held attest clocks.
  - Root-issued tokens and membership leaves attest nothing.
  - Membership-only groups advance through `clock` entries with `attest: true`, authored by an effective member's own device.
- **D13 Historical registry.** A delayed application frame is judged against `registryAt(head)`, the fold of the ledger prefix its epoch's head authenticates, for time, leases and effectiveness alike.
- **D14 Recovery arbitration.** `knownRecoveryRegistry` arbitrates each controller projection: `authoritativeLog(loaded: offered, seen: known)`.
  - A stale reply keeps the known log. A fork refuses the reply.
  - Removed members and survivor grants are unioned; attestations and floors take the max.
- **D15 Scope (pending user decision, see "Needs user decision").** Member-rooted credentials are supported in lifecycle groups (anchor names a controller). Standard groups refuse them and keep root-only `manage` capabilities.
- **D16 Membership binding ordering.** A membership binding carries its own `iat` (self-attested by the pinned key, used only for ordering). Stale-leaf replacement and `renewal-order` compare `bindingIssuedAt` (the capability `iat`, or the membership `iat`). It never counts as tree time.

## Interface table

| Symbol | File | Produced in | Consumed in |
|---|---|---|---|
| `ControllerBinding` (membership form, `iat`), `LeafBinding.member` | `credential.ts`, `device-proof.ts` | 2 | 6, 7, 9, 12, 13, 14 |
| `MemberRoot`, `EvidenceSlot`, `memberRootsOf`, `bindingIssuedAt` | `member-root.ts`, `stale-leaf.ts` | 2 | 4, 6, 7, 12, 13 |
| `ControllerProjection` (new shape), `recordedLogOf`, `registryForLog` | `registry.ts` | 3 | 4–14 |
| `ingestControllerLog`, `effectDelta` | `controller-ingest.ts` | 3 | 4, 8, 11, 12, 14 |
| `ProofRef`, `EffectClaim`, `effectOf`, `claimsFor`, `memberDropIndices` | `controller-log.ts`, `member-root.ts` | 4 | 11, 12 |
| `memberRootStatus`, `effectiveAuthorityOf`, `cascadeOf` | `member-root.ts` | 4 | 6, 7, 10, 11, 12, 13, 14 |
| `createRegistryControllerResolver`, `prefixRelation` | `embedded-resolver.ts` | 5 | 6, 7 |
| `JudgingContext`, `DIDAuthenticationDependencies.judging` | `authentication.ts` | 6 | 7, 8, 9, 12 |
| `leafExpiry` | `lifecycle.ts` | 7 | 9, 13 |
| `publishControllerLog`, `controllerLogDelta`, `GroupOptions.controllerLog`, `CreateInviteParams.controllerLog`, `renewLeaf(..., { controllerLog })` | `group-lifecycle.ts`, `types.ts`, `group-commit.ts` | 8 | 9, 10, 15 |
| `epochEventCount`, `settleAdvisory`, `GroupHandle.settleAdvisory()` | `history.ts`, `group-handle.ts` | 10 | 15 |
| `RevokeWithProofParams` (ControllerLog form), `Revocation.proofRef` | `group-lifecycle.ts`, `registry.ts` | 11 (deny), 12 (remove, survivors) | `mls-rpc/src/revoke.ts`, 15 |
| `survivorTargets`, `memberRemoved` event | `group-lifecycle.ts`, `group-handle.ts` | 12 | 15 |
| `attestedTreeTime`, `attestTreeTime`, `registryAt` | `lifecycle.ts`, `group-lifecycle.ts`, `group-handle.ts` | 13 | 14 |
| `arbitrateProjection` | `registry.ts` | 14 | `mls-rpc/src/recovery.ts` |

Every new public symbol is exported from `packages/mls/src/index.ts` in the task that produces it.

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

### Task 2: Binding forms and member roots

**Files:**
- Modify: `packages/mls/src/credential.ts` (`ControllerBinding`, parser)
- Modify: `packages/mls/src/device-proof.ts` (`LeafBinding.member`, `iat`; `capability` stays optional)
- Modify: `packages/mls/src/group-handle.ts` (`bindingOfDID` copies `member` and `iat`)
- Create: `packages/mls/src/member-root.ts` (types and `memberRootsOf`, decode-only)
- Modify: `packages/mls/src/capability.ts` (minting writes `mbr`)
- Modify: `packages/mls/src/stale-leaf.ts` (`bindingTime` becomes `bindingIssuedAt`), `packages/mls/src/group-credential.ts` (`assertBindingAuthorTime` branches)
- Test: `packages/mls/test/credential-controller.test.ts`, `packages/mls/test/member-root.test.ts` (new), `packages/mls/test/capability.test.ts`, `packages/mls/test/stale-leaf-replacement.test.ts`

**Interfaces:**
- Produces:
  - `ControllerBinding = { id: string; prefix: Array<SignedEvent>; capability?: string; holderGrant?: string; member?: { add: string; g: number }; iat?: number }`. The parser enforces exactly one of `capability` and `member`. `iat` must be present with `member`, and `holderGrant` only with `capability`. `member` must have the shape kokuin's `isMemberClaim` accepts: exactly `add` (non-empty) and `g` (a non-negative safe integer). Kokuin does not export it, so kumiai checks the shape locally.
  - `MemberRoot = { kind: 'root'; controller: string } | { kind: 'member'; did: string; add: string; gen: number }`.
  - `EvidenceSlot = 'capability' | 'parent' | 'holder' | 'membership' | 'survivor'`.
  - `memberRootsOf(binding: ControllerBinding, leafDID: string): Array<{ slot: EvidenceSlot; root: MemberRoot }>`. It lists the primary slot first: `capability` for a direct capability, `parent` for a chained one, `membership` for a membership binding (`{ did: leafDID, add, gen: g }`). A `holder` slot follows when a holder grant rides. A token with `mbr` yields a member root with `did: iss`; any other yields `{ kind: 'root' }`. Decode-only: callers authenticate.
  - `bindingIssuedAt(binding: ControllerBinding): number`.
  - `mintLeafCapability` / `mintTrustedGrant` take `member?: { add: string; g: number }`. With it they write `mbr` and skip `assertControllerGrant`'s `iss === sub` check, and `self-issued` stays refused.

- [ ] **Step 1: Write failing tests**
  - `parser accepts a membership binding`: `{ id, prefix, member: { add, g: 0 }, iat }` round-trips; `capability` is absent.
  - `parser refuses a binding with neither capability nor member`, `parser refuses a binding with both`, and `parser refuses a membership binding without iat`, each with an `Invalid MLS credential` message.
  - `bindingOfDID returns the membership form`: `member` and `iat` set, `capability` undefined.
  - `memberRootsOf reads direct, parent, holder, membership and root roots`: a table of five bindings with the expected slot order and roots.
  - `mintLeafCapability with member writes mbr and refuses self-issue`.
  - `assertNewerBinding orders a membership binding against a capability binding by bindingIssuedAt`.
- [ ] **Step 2:** Run `pnpm --filter @kumiai/mls exec vitest run test/credential-controller.test.ts test/member-root.test.ts test/capability.test.ts test/stale-leaf-replacement.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Every `readCapability(binding.capability)` caller compiles against the optional field. Callers that cannot yet handle the membership form throw `LeafBindingError('controller-mismatch')`; Task 7 replaces those throws.
- [ ] **Step 4:** Rerun. Expected: PASS. Then run `pnpm --filter @kumiai/mls test:types`.
- [ ] **Step 5:** Commit `feat(mls)!: membership binding form and member-root reading`.

### Task 3: Registry projection and controller-log ingestion

**Files:**
- Modify: `packages/mls/src/registry.ts` (projection shape, `DeviceOp 'log'`, `isDeviceValue`, `registryApply`, `recordedLogOf`, `registryForLog`)
- Create: `packages/mls/src/controller-ingest.ts`
- Modify: `packages/mls/src/lifecycle-proof.ts` (`authenticateLifecycleProof` gains the `log` arm; the array-form proof branches are removed)
- Modify: `packages/mls/src/history.ts` (`proofSize`; count every ControllerLog proof copy)
- Modify: `packages/mls/src/errors.ts` (`RevokeProofReason` gains `'not-endorsed'`)
- Test: `packages/mls/test/registry-log.test.ts` (new), `packages/mls/test/history-size.test.ts`, `packages/mls/test/fixtures/controller-epoch.ts` (new: `buildEpoch({ members, renewEvery, until, revokes })`, `saturatedLog()`)

**Interfaces:**
- Consumes: `foldControllerLog`, `closureOf` (Task 1).
- Produces:
  - `ControllerProjection = { recordedLog?: ControllerLog; genFloor: number; timeFloor: number; attestations: ReadonlyMap<string, number>; removedMembers: ReadonlyMap<string, RemovedMember>; survivorGrants: ReadonlyMap<string, string>; beacon?: ControllerBeacon }`, with `RemovedMember = { did: string; gen: number; proofRef: ProofRef }`. Tasks 12 and 13 fill the three maps; the persisted shape lands once, here.
  - `DeviceValue.proof?: ControllerLog`. `op: 'log'` has subject = controller and carries no `revoked`, `effects` or `capability`.
  - `ingestControllerLog(controller: string, recorded: ControllerLog | undefined, proof: ControllerLog): { log: ControllerLog; before?: KeyState; after: KeyState; introduced: Array<string> }`. It implements D1 and D5, and throws `RevokeProofError` (`'detached'`, `'not-authority-signed'`, `'needs-reset'`, `'not-endorsed'`).
  - `effectDelta(before: KeyState | undefined, after: KeyState): { denied: Array<string>; removed: Array<{ did: string; add: string }>; generation: boolean }`. It reads DID-spelled denials and member effectiveness from `head` (N1), normalised on both sides (R7).
  - `recordedLogOf(registry: DeviceRegistry, controller: string): ControllerLog | undefined`.
  - `registryForLog(controller: string, log: ControllerLog): DeviceRegistry`, an author-side registry over the author's own log (D2, Task 9 key packages).
  - `historySize` counts `proof.chain` and `proof.events` of every device entry, once per entry, with no deduplication; the derived `recordedLog` projection is not counted again. `proofSize(value: unknown): number`.
  - The `log` arm of `authenticateLifecycleProof`: subject is the controller, `ingestControllerLog`, then `effectDelta` must be empty (D4) or `'effects-mismatch'`.

- [ ] **Step 1: Write failing tests**
  - `genesis log entry with a full chain seeds the recorded log`: `recordedLogOf` holds the `add`; the folded head has the member effective.
  - `log entry with events only, on an empty registry, is refused`: dropped by `foldControl` with `invalid lifecycle proof`.
  - `log entry with a chain suffix settles without a revoke`: the recorded chain grows by one same-generation `rot`, and the prior epoch's events are gone from the stored log.
  - `log entry renewing a member extends the recorded lease` (Review Focus 2).
  - `removed member's concurrent renewal is refused`: kokuin's fold applies it, but kumiai throws `not-endorsed` and the recorded log is unchanged (Review Focus 1). Mutation-check it: make the fixer drop the endorsement filter and confirm the test fails.
  - `removed member's event endorsed by an effective member's later event is accepted`.
  - `log entry carrying a new denial is refused`, `log entry whose settlement snapshot drops an effective member is refused` and `log entry raising the generation is refused`, with reasons `effects-mismatch`, `effects-mismatch` and `needs-reset`.
  - `forged copy beside the genuine one stores the genuine copy`: the stored signatures equal the genuine event's.
  - `chain fork is refused and the prior log is kept`.
  - `pending event is not stored`.
  - `history counts every proof copy`: two entries carrying the same event count it twice, and the total equals the sum of `controllerLogSize` over each entry's chain and events.
  - `history does not shrink after a settlement`.
  - `P2 workload fits the horizon held once`: 3 members, renewals every 21 days to day 168 and 4 revokes, delivered as one genesis entry plus `log` entries, with 50 bound leaves. `historySize < HISTORY_HORIZON`.
- [ ] **Step 2:** Run `pnpm --filter @kumiai/mls exec vitest run test/registry-log.test.ts test/history-size.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Join the chain as D1 states, merge the events with `mergeLogs`, then call `authoritativeLog`. `introduced` is `after.applied` minus `before.applied`. Endorsement walks `p` within the applied set.
- [ ] **Step 4:** Rerun. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls)!: device registry ingests controller logs through authoritativeLog`.

### Task 4: Lifecycle effects and the member-root model

**Files:**
- Modify: `packages/mls/src/controller-log.ts` (`memberDropIndices`)
- Modify: `packages/mls/src/member-root.ts` (status, authority, cascade, effects)
- Test: `packages/mls/test/member-root.test.ts`, `packages/mls/test/effect-descriptor.test.ts` (new)

**Interfaces:**
- Consumes: `memberRootsOf` (Task 2); `recordedLogOf`, `effectDelta` (Task 3); `revokeIndices` (Task 1).
- Produces:
  - `ProofRef = { chainIndex: number } | { event: string }`.
  - `EffectClaim = { kind: 'deny'; did: string; ref: ProofRef } | { kind: 'remove'; member: { did: string; add: string }; ref: ProofRef }`.
  - `memberDropIndices(did: string, chain: ReadonlyArray<SignedEvent>, add: string): Array<number>`. It returns every same-generation `rot` whose snapshot `m` lacks incarnation `add` while the prior state held it, not removed.
  - `effectOf(controller: string, log: ControllerLog, claim: EffectClaim, genFloor: number): void`. It throws `RevokeProofError` (`'effects-mismatch'`, `'generation-floor'`, `'no-rev'`).
    - An `event` ref must be in the fold's `applied`, of type `rev` with `normalizeDID(x) === did`, or of type `rmv` with `add === member.add`, where `member.did` matches that incarnation canonically.
    - A `chainIndex` ref must be in `revokeIndices` (deny) or `memberDropIndices` (remove), at generation ≥ `genFloor`.
  - `claimsFor(controller: string, recorded: ControllerLog | undefined, merged: ControllerLog, genFloor: number): Array<EffectClaim>`. It is the producer's derivation and canonical order: denies by DID, then removals by add digest. It prefers event refs and falls back to the first chain index ≥ `genFloor`.
  - `MemberRootStatus = { status: 'root' } | { status: 'effective'; key: Uint8Array; lease: number } | { status: 'removed' } | { status: 'unavailable'; why: 'no-log' | 'saturated' | 'unknown-incarnation' | 'prefix' }`, and `memberRootStatus(registry: DeviceRegistry, controller: string, root: MemberRoot): MemberRootStatus` (D8).
  - `LeafRef = { did: string; binding: ControllerBinding; leafKey: Uint8Array }`, and `effectiveAuthorityOf(leaf: LeafRef, registry: DeviceRegistry, controller: string): { root: MemberRoot; slot: EvidenceSlot } | { status: 'removed' } | { status: 'unavailable' }` (D10). A substitute counts only when its `aud` is the leaf DID and its `cnf` the leaf key.
  - `RemovedEffect = { did: string; cascadedFrom: string }`, where `cascadedFrom` is an add digest.
  - `cascadeOf(leaves: ReadonlyArray<LeafRef & { leafIndex: number }>, claims: ReadonlyArray<EffectClaim>, before: DeviceRegistry, after: DeviceRegistry, controller: string): { revoked: Array<RevokedEffect>; removed: Array<RemovedEffect>; removeLeafIndices: Array<number> }`.
    - `deny` keeps 0.11's shape: the denied DID, plus chained leaves whose immediate issuer is denied, minus evidenced children judged in `after`.
    - `remove` cascades every leaf whose `effectiveAuthorityOf(after)` is `removed`.
    - The producer (`revokeWithProof`), the verifier (`verifyLifecycleProof`) and `checkSurvivors` all call this function.

- [ ] **Step 1: Write failing tests**
  - `effectOf accepts a member rev by event digest`.
  - `effectOf refuses an applied but unrelated event digest`: `effects-mismatch` (review finding 9).
  - `effectOf refuses an rmv ref under a deny claim`.
  - `settled rmv is proved by chain index`: after a settlement snapshot drops the member, `memberDropIndices` finds it and `effectOf` accepts `{ chainIndex }`.
  - `re-revoke after reset is proved at gen 2` (Review Focus 3).
  - `claimsFor output passes effectOf for every claim`: the producer and the verifier agree.
  - `memberRootStatus table`, with one row per outcome:
    - root;
    - effective, with the renewed lease;
    - removed by `rmv`;
    - removed by a reset's generation;
    - removed by a tombstone after a settlement dropped the member;
    - unknown add, unavailable;
    - no log, unavailable;
    - `saturatedLog()`, unavailable.
  - `member introduced through a settlement snapshot is effective with no epoch events` (review finding 15).
  - `effectiveAuthorityOf uses the holder substitute when the parent's member is removed`.
  - `effectiveAuthorityOf uses a registered survivor grant`.
  - `effectiveAuthorityOf refuses a substitute whose aud or cnf is another leaf's`.
  - `cascadeOf: rmv cascades a direct mbr leaf, a leaf whose parent came from the removed member, and the member's own membership leaf`.
  - `cascadeOf: rmv keeps a leaf whose holder grant came from another effective member`.
  - `cascadeOf: edge deny cascades its chained leaves only`.
  - `cascadeOf: rmv writes no revoked device records` (D7).
- [ ] **Step 2:** Run `pnpm --filter @kumiai/mls exec vitest run test/member-root.test.ts test/effect-descriptor.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. These are pure functions: no tree, no handle, no I/O. `memberRootStatus` folds the recorded log at most once per registry value (memoised in a `WeakMap` keyed by the projection).
- [ ] **Step 4:** Rerun. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls): lifecycle effect descriptor, member-root status and shared cascade`.

### Task 5: Resolver over the registry

**Files:**
- Modify: `packages/mls/src/embedded-resolver.ts`
- Test: `packages/mls/test/embedded-resolver.test.ts`

**Interfaces:**
- Consumes: `recordedLogOf` (Task 3), `denySetOf`.
- Produces:
  - `prefixRelation(recorded: ControllerLog | undefined, prefix: ReadonlyArray<SignedEvent>): 'contained' | 'ahead' | 'forked' | 'none'`. `contained` means the prefix's head digest is one of the recorded chain's states.
  - `createRegistryControllerResolver({ controllerID, prefix, registry? }): ControllerResolver`.
    - `resolve`, `resolveHistoric` and `resolveAgreementKey` come from the prefix alone. A chain is never saturated, so root-issued tokens keep verifying while the epoch is unavailable.
    - `resolveMember` answers from the registry's recorded log only when `prefixRelation` is `contained`; otherwise it refuses.
    - `resolveDenySet` answers `denySetOf(registry)`.
    - `frozen()` returns one view that folds the recorded log once and keeps the registry deny set (R4).
    - With no registry, it has no `resolveMember`, so every member-rooted check refuses (the structural stage skips that check instead; Task 6).
  - `createEmbeddedControllerResolver` is removed; its callers move to the new factory.

- [ ] **Step 1: Write failing tests**
  - `resolveMember answers an effective member with the renewed lease`.
  - `resolveMember refuses a removed incarnation`.
  - `resolveMember refuses on a saturated recorded log, while root-token historic resolution still answers from the prefix` (Review Focus 5).
  - `resolveMember refuses when the leaf prefix is ahead of or forked from the recorded chain`.
  - `frozen view keeps the registry deny set`: a DID denied in the registry but not in the log is denied.
  - `one frozen view loads the recorded log once`: a counting `loadLog` sees 1 call across five queries (as P4 measured).
  - `loads no DID but the controller`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement on `createControllerResolver({ loadLog })`. Keep `history` unset.
- [ ] **Step 4:** Rerun. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls): resolve controller members from the registry's recorded log`.

### Task 6: Judging context and member-rooted capabilities

**Files:**
- Modify: `packages/mls/src/authentication.ts` (`verifyLeafCredential`, `verifyPinnedCapability`, `checkHolderEvidence`, `hasHolderEvidence`; `DIDAuthenticationDependencies.judging`)
- Modify: `packages/mls/src/capability.ts` (`assertControllerGrant` accepts a well-formed `mbr`)
- Modify: `packages/mls/src/lifecycle.ts` (`checkBinding`, `validateBoundLeaf`, `validateEntry` and `checkEntry` take a `JudgingContext`; the default is `{ registry: group.registry, stage: 'full', mode: 'admit' }`)
- Modify: `packages/mls/src/group-context.ts` (the deny holder carries `judging`)
- Modify: `packages/mls/src/errors.ts` (`LeafBindingReason` gains `'member-removed'`, `'member-unavailable'`, `'epoch-cap'`). `rejectionReason` maps all three to `'binding'`.
- Test: `packages/mls/test/authentication-bound.test.ts`, `packages/mls/test/holder-evidence.test.ts`, `packages/mls/test/management-capability.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4 and 5.
- Produces: `JudgingContext = { registry?: DeviceRegistry; stage: 'structural' | 'full'; mode: 'admit' | 'retain' | 'rejudge' }` (D9), and `DIDAuthenticationDependencies.judging?: () => JudgingContext`. `deviceRegistry` is removed and the registry comes from `judging`.
  - Member-rooted tokens use one `frozen` view per verification.
    - The signature first: `verifyToken(raw, { methods: [frozen], atTime: payload.iat, historic: true, allowUnsigned: false })`.
    - Then `checkCapability(permission, payload, { atTime: payload.iat, methods: [frozen], maxDepth: 1, maxMemberGrantLifetime: MAX_TRUSTED_GRANT_LIFETIME })`, for every walk. Kokuin forwards the option recursively (`delegation.js:148,233`), so a leaf-sized value would refuse a long parent (review finding 5).
    - The local bounds stay: leaf ≤ `leafLifetime` and parent or holder ≤ `trustedGrantLifetime`.
  - `full` stage, by mode:
    - `admit`: requires `memberRootStatus` of the primary root to be `root` or `effective` (`member-removed` / `member-unavailable` otherwise).
    - `retain`: `removed` falls to `effectiveAuthorityOf` substitutes, verified in full against the same frozen view; `unavailable` keeps the leaf on structural checks.
    - `rejudge`: like `retain`, but `unavailable` refuses.
  - The `structural` stage skips `resolveMember`, deny and status, and still verifies every signature.
  - D15: in a group whose anchor names no controller, a member-rooted credential is refused with `controller-mismatch`. `verifyManagementCapability` stays root-only.

- [ ] **Step 1: Write failing tests**
  - `direct mbr leaf capability authenticates`.
  - `direct mbr leaf refused when the issuer is not an effective member`: `member-removed`.
  - `mbr grant past the lease is refused`.
  - `holder grant minted by a member authenticates a chained leaf`.
  - `30-day member parent with a one-hour leaf authenticates`: the same fixture fails when `maxMemberGrantLifetime` is 604 800 (review finding 5).
  - `member holder grant over the group trustedGrantLifetime is refused`: `lifetime-cap`.
  - `longer holder grant does not lengthen the leaf`: a leaf capability over `leafLifetime` is refused with `lifetime-cap`.
  - `admission refuses a removed member root whose own evidence still verifies`: the registry holds the `rmv` (Review Focus 1). Mutation-check it: make the fixer skip `memberRootStatus` in `admit` and confirm the test fails.
  - `admit refuses on an unavailable registry`: `member-unavailable`.
  - `retain keeps an unchanged leaf on an unavailable registry`, and `rejudge refuses it` (Review Focus 5).
  - `structural stage accepts an mbr leaf without a registry and refuses a tampered mbr signature`.
  - `standard group refuses a member-rooted leaf and an mbr manage capability` (D15).
- [ ] **Step 2:** Run `pnpm --filter @kumiai/mls exec vitest run test/authentication-bound.test.ts test/holder-evidence.test.ts test/management-capability.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Existing callers keep 0.11 behaviour through the default context, until Tasks 8 and 9 pass explicit ones.
- [ ] **Step 4:** Rerun, plus the whole `@kumiai/mls` unit suite (structural change). Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls): authenticate member-issued leaf and holder grants under an explicit judging context`.

### Task 7: Membership binding arm

**Files:**
- Modify: `packages/mls/src/authentication.ts` (the membership arm)
- Modify: `packages/mls/src/lifecycle.ts` (`leafExpiry`; `isLapsed`, `checkAdmissionExpiry` and `attestedTime` branch on the membership form; `renewal-order` and `replacesRevokedIssuer` use `bindingIssuedAt`)
- Modify: `packages/mls/src/lifecycle-proof.ts` (leaves map), `packages/mls/src/group-lifecycle.ts` (`isFullyRevoked`, `clockEntries`), `packages/mls/src/recovery-verdict.ts` (`recoverySignerEligible`)
- Modify: `packages/mls-rpc/src/recovery.ts` (`current()` accepts the membership form; `bindingID` includes `member` and `iat`)
- Test: `packages/mls/test/authentication-bound.test.ts`, `packages/mls/test/lifecycle-invite.test.ts`, `packages/mls/test/stale-leaf-replacement.test.ts`, `packages/mls/test/recovery-verdict.test.ts`, `packages/mls-rpc/test/recovery-holder-evidence.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4–6.
- Produces:
  - Membership authentication:
    - `matchesLeafKey`, then `resolveMember(controller, { did: leafDID, add, gen: g })` on the frozen view (R6);
    - then `constantTimeEqual(member.key.publicKey, signaturePublicKey)` (`resolveMember` returns `{ key, lease }`, not a DID; `@kokuin/token` `method.d.ts:15`).
    - Status follows D9.
  - `leafExpiry(binding: ControllerBinding, registry: DeviceRegistry, controller: string): number | undefined`. It is the capability `exp`, or the member's lease when the incarnation is `effective`, and `undefined` when unavailable.
    - `isLapsed` treats `undefined` as not lapsed: existing leaves are untouched.
    - `checkAdmissionExpiry` treats it as `member-unavailable`.
  - Membership leaves contribute 0 to every time scan.

- [ ] **Step 1: Write failing tests**
  - `membership leaf authenticates when the signature key equals the pin`.
  - `membership leaf naming another member's incarnation is refused`: kokuin's "incarnation is another DID" refusal surfaces as `member-removed`.
  - `membership leaf refused for a removed incarnation`.
  - `membership leaf lapses at its lease end by tree time`, using a registry whose `timeFloor` passes the lease.
  - `renewal reaches a membership leaf through a log entry`: after a `log` entry with `createRenew`, the leaf is not lapsed past the old lease (Review Focus 2).
  - `phone member keeps its leaf 30 days on a 90-day lease`: lease 7 776 000 s, tree time advanced 2 592 000 s.
  - `membership leaf attests no tree time`.
  - `membership key package replaces a stale leaf only when newer`, and `membership renewal with an older iat is refused` (`renewal-order`).
  - `recovery binding state carries a membership binding`: `current()` returns it, and `bindingID` differs when `iat` differs.
  - `recovery signer with an effective membership leaf is eligible`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Every `readCapability(binding.capability)` caller branches on `member`, and Task 2's interim `controller-mismatch` throws are gone. Check with `grep -rn "binding.capability\|\.capability)" packages/mls/src packages/mls-rpc/src`.
- [ ] **Step 4:** Rerun, then run `pnpm --filter @kumiai/mls test:unit` and `pnpm --filter @kumiai/mls-rpc test:unit`. Expected: PASS. Then run `test:types` for both.
- [ ] **Step 5:** Commit `feat(mls): bind a managing device's leaf by controller membership`.

### Task 8: `log` entries in the lifecycle gate, producers and genesis

**Files:**
- Modify: `packages/mls/src/registry.ts` (`isLifecycleDeviceValue` accepts `log`), `packages/mls/src/envelope-fold.ts` (lifecycle groups accept `log`)
- Modify: `packages/mls/src/lifecycle.ts` (`prepareLifecycleGate`)
  - `log` entries are verified; at most one per commit, and never beside a proof.
  - Every leaf judgement passes `{ registry: candidateRegistry, stage: 'full', mode }`, where `mode` is `retain` for an unchanged leaf at its index and `admit` otherwise.
  - `checkSurvivors` reads `candidateRegistry`.
- Modify: `packages/mls/src/lifecycle-proof.ts` (`verifyLifecycleProof`, `log` arm)
  - The issuer is a bound device of the controller in the pre-commit tree, not denied and not lapsed.
  - The registry check runs through `authenticateLifecycleProof`, and the size accounting through `proofSize`.
- Modify: `packages/mls/src/group-handle.ts`. `#prepareCommitPipeline` exposes `candidateRegistry`, and the ts-mls `validateCredential` callback (`group-handle.ts:1912-1940`) judges with it instead of the pre-commit `this.registry`.
- Modify: `packages/mls/src/group-commit.ts`.
  - `commitWithEntries` scopes the authoring authService to `fold.registry` while ts-mls builds the commit.
  - `CreateInviteParams.controllerLog?` appends a signed `log` entry carrying the delta, which `commitInvite` enacts before the Add.
- Modify: `packages/mls/src/group-context.ts` (`withJudging(context, judging, fn)`, the scoped holder override)
- Modify: `packages/mls/src/group-lifecycle.ts` (`publishControllerLog`, `controllerLogDelta`; `renewLeaf(group, binding, options?: { controllerLog?: ControllerLog })`)
- Modify: `packages/mls/src/group-create.ts`, `packages/mls/src/types.ts` (`GroupOptions.controllerLog?: ControllerLog`; the D2 genesis entry)
- Modify: `packages/mls/src/index.ts`
- Test: `packages/mls/test/controller-log-entries.test.ts` (new), `packages/mls/test/lifecycle-invite.test.ts`, `packages/mls/test/envelope-fold.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 6.
- Produces:
  - `controllerLogDelta(group: GroupHandle, log: ControllerLog): ControllerLog | null`. It returns the chain suffix over the recorded chain plus the pruned events the recorded log lacks, and `null` when there is nothing new. It throws `RevokeProofError('detached')` on a fork.
  - `publishControllerLog(group: GroupHandle, log: ControllerLog): Promise<DeviceWriteResult | null>`. It is one commit carrying the `log` entry and at most one preservation clock. A delta with effects throws `RevokeProofError('effects-mismatch')`; the caller uses `revokeWithProof`.
  - `renewLeaf(group, binding, { controllerLog })` bundles the delta the new binding needs.
  - `createGroup` (D2). The creator leaf is judged against `registryForLog(controller, controllerLog)`.

- [ ] **Step 1: Write failing tests**
  - `createGroup with a membership creator seeds the registry from controllerLog`: the ledger has 1 entry, the head equals `extendHead(genesisHead(id), [entryID])`, and `recordedLogOf` holds the creator's add.
  - `createGroup with a membership creator and no controllerLog is refused`: `member-unavailable`.
  - `member processes an invite commit whose log entry carries the issuing member's renewal`: the candidate registry, not the pre-commit one, judges the Add (review finding 4, live commits).
  - `commit adding an mbr leaf without the needed log entry is refused`: `CommitRejectedError` with reason `binding`.
  - `author refuses to build a commit its receivers would reject`: `commitInvite` without `controllerLog` throws before emitting.
  - `publishControllerLog settles without a revoke`: receivers' recorded chain gains the `rot`, and a second call returns `null` (review finding 1).
  - `log entry from a device bound to another controller is refused`, `two log entries in one commit are refused`, `log entry beside a proof is refused` and `lapsed sender cannot publish a log entry`.
  - `foldControl keeps a log entry in a lifecycle group`.
  - `renewLeaf with controllerLog carries the renewal the new grant needs` (Review Focus 2, end to end).
- [ ] **Step 2:** Run `pnpm --filter @kumiai/mls exec vitest run test/controller-log-entries.test.ts test/lifecycle-invite.test.ts test/envelope-fold.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, plus the `@kumiai/mls` unit suite. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls)!: carry controller logs through log entries, genesis and invites`.

### Task 9: Staged verification for Welcome, external recovery, key packages and restore

**Files:**
- Modify: `packages/mls/src/group-welcome.ts` (`processWelcome`, `joinGroupExternal`)
- Modify: `packages/mls/src/lifecycle.ts` (`validateWelcomeTree` takes `judging`, defaulting to `{ registry: group.registry, stage: 'full', mode: 'rejudge' }`; its `checkSurvivors` refuses `effectiveAuthorityOf` = `removed`)
- Modify: `packages/mls/src/group-credential.ts` (`buildBundle`: a member-rooted binding needs `options.controllerLog`)
- Modify: `packages/mls/src/group-handle.ts` (`#computeAdmission` reads `leafExpiry`; recomputed after every fold, as today)
- Test: `packages/mls/test/lifecycle-invite.test.ts`, `packages/mls/test/external-rejoin.test.ts`, `packages/mls/test/welcome-redelivery.test.ts`, `packages/mls/test/persist-boundary.test.ts`

**Staged verification** (which registry each phase reads):

| Path | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| Welcome (`processWelcome`) | ts-mls join callback: `structural`, no registry (`group-welcome.ts:84-92`) | construction: admission with an empty registry, so expiry is unknown and not lapsed | head check, `applyLedgerEntries`, then `validateWelcomeTree`: `full`/`rejudge` on the folded registry, plus the joiner's admission expiry |
| External recovery (`joinGroupExternal`) | ts-mls source-tree callback: `structural` (`group-welcome.ts:291-314`) | `bootstrapLedger` on both handles, then `beforeBinding` (signer eligibility against the Task 14 arbitrated registry) | gate with `externalLeaf` in `admit` against `before.registry`; then `validateWelcomeTree(group)` in `rejudge` |
| Creation (`createGroup`) | creator leaf: `full`/`admit` against `registryForLog(controllerLog)` | genesis `log` entry (D2) | — |
| Key package (`buildBundle`) | `full`/`admit` against `registryForLog(controllerLog)` for member-rooted bindings; root-rooted as today | — | — |
| Restore (`restoreGroup`) | construction: unknown expiry, not lapsed | `applyLedgerEntries`, then admission recomputed | no tree re-judgement (local trusted state, as in 0.11) |
| Live commit | pipeline fold yields `candidateRegistry` | gate: proofs, `log` and leaves against `candidateRegistry` (Task 8) | ts-mls callback and `postApply` against `candidateRegistry` (Task 8) |

- [ ] **Step 1: Write failing tests**
  - `Welcome with an mbr leaf joins once the ledger carries the member's add`.
  - `Welcome with an mbr leaf whose member the ledger lacks is refused`: `member-unavailable`.
  - `Welcome joiner with a membership leaf takes admission from the folded registry`: admissible after join, and lapsed once the registry `timeFloor` passes the lease.
  - `external rejoin judges an mbr source tree after the ledger bootstrap`.
  - `external rejoin whose membership binding the reply ledger cannot support is refused`: `LeafBindingError('member-unavailable')`, `rejectionReason` = `binding`.
  - `membership key package needs controllerLog` and `mbr key package verifies against controllerLog`.
  - `restored handle takes its own admission from the replayed ledger`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the table. The P1 ordering (head check, then fold, then tree) stays (`group-welcome.ts:130-157`).
- [ ] **Step 4:** Rerun, plus the `@kumiai/mls` unit suite. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls): stage member authority after the ledger on every early-authentication path`.

### Task 10: Epoch-event cap and settle advisory

**Files:**
- Modify: `packages/mls/src/history.ts` (constants, `epochEventCount`, `settleAdvisory`), `packages/mls/src/authentication.ts` (cap in `admit`), `packages/mls/src/group-handle.ts` (`settleAdvisory()`), `packages/mls/src/index.ts`
- Test: `packages/mls/test/epoch-cap.test.ts` (new)

**Interfaces:**
- Produces:
  - `MAX_EPOCH_EVENTS_FOR_LEAVES = 32` and `SETTLE_PROMPT_EPOCH_EVENTS = 24` (P2).
  - `epochEventCount(log: ControllerLog): number`, the length of `applied` of the current epoch.
  - `settleAdvisory(log: ControllerLog): 'ok' | 'prompt' | 'blocked'`: 0–23 gives `ok`, 24–32 gives `prompt`, more than 32 gives `blocked`.
  - `GroupHandle.settleAdvisory()` reads the registry's recorded log.
  - D11: only `admit` of a member-rooted credential is capped, with `LeafBindingError('epoch-cap')`.

- [ ] **Step 1: Write failing tests**
  - `settleAdvisory thresholds`: 23, 24, 32 and 33 events.
  - `member-rooted Add refused with epoch-cap at 33 events`.
  - `root-issued Add accepted at 33 events`.
  - `unchanged member-rooted committer still commits at 33 events` (`retain`).
  - `Welcome with member-rooted tree leaves joins at 33 events` (`rejudge`).
  - `log and revoke entries still land at 33 events`.
  - `after a root settlement the refused Add is accepted`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls): cap new member-rooted admissions by epoch size and advise settling`.

### Task 11: Deny proofs and reset on the ControllerLog form

**Files:**
- Modify: `packages/mls/src/registry.ts`
  - `revoke` value: `{ op: 'revoke', proof: ControllerLog, effects: Array<EffectClaim>, revoked: Array<RevokedEffect>, removed: Array<RemovedEffect>, survivors?: Array<string> }`, subject = controller.
  - `DeviceRecord.proofRef?: ProofRef` replaces `logPosition`, and `Revocation = { controller; proofRef; reason?; cascadedFrom? }`.
  - `registryApply` upgrades an `{ event }` ref to `{ chainIndex }` when an ingested chain carries the same denial (`revokeIndices`).
- Modify: `packages/mls/src/lifecycle-proof.ts`. `authenticateLifecycleProof` handles `revoke`/`reset` through `ingestControllerLog`, `effectDelta` equal to the declared `effects`, and `effectOf` for each claim. `verifyLifecycleProof` derives through `cascadeOf`.
- Modify: `packages/mls/src/group-lifecycle.ts`
  - `proofFor` becomes `controllerLogDelta` plus `claimsFor`.
  - `revokeWithProof(group, params: { log: ControllerLog; deny: Array<string> } | { reset: true; log: ControllerLog })`. `claimsFor` may add authentic extra effects the delta carries, and the result reports them.
  - `isFullyRevoked` becomes `alreadyApplied(group, claims)`.
- Modify: `packages/mls/src/controller-log.ts` (delete `revokesSubject`), `packages/mls/src/group-handle.ts` (`emitControlEvents` reads `effects`), `packages/mls-rpc/src/revoke.ts` (types)
- Test: `packages/mls/test/lifecycle-proof.test.ts`, `packages/mls/test/device-proof.test.ts`, `packages/mls/test/group-lifecycle.test.ts`, `packages/mls/test/device-attacks.test.ts`, `packages/mls/test/reset-readmission.test.ts`

- [ ] **Step 1: Write failing tests**
  - `member rev of an edge DID is a valid deny proof`: `ref` is `{ event }`.
  - `root-rotate deny is proved by chain index`.
  - `deny claim whose ref names an unrelated applied event is refused` (review finding 9).
  - `undeclared effect in the delta is refused`: a closure carrying a second `rev` declared as one claim gives `effects-mismatch`, and `revokeWithProof` declares both.
  - `revoke from a removed member's concurrent rev is refused`: `not-endorsed`.
  - `replayed deny is already-revoked`, `partial closure refused` and `saturated proof refused`.
  - `re-revoke after reset accepted at gen 2` (Review Focus 3).
  - `deny of a long-form did:peer:4 matches the short-form leaf` (R7).
  - `stored epoch deny upgrades to chain form after settle`: `revocationOf` returns `{ chainIndex }`.
  - `deny read from head, not states.at(-1)` (N1). Mutation-check it: make the fixer swap the read and confirm the test fails.
  - `deny cascade keeps evidenced children`, and `reset keeps reset-only readmission`: the 0.11 semantics on the new form.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The producer and the verifier share `claimsFor`, `effectOf` and `cascadeOf`.
- [ ] **Step 4:** Rerun, then run `pnpm --filter @kumiai/mls test:unit`, `pnpm --filter @kumiai/mls-rpc test:unit` and `pnpm --filter @kumiai/rpc-conformance test:unit`. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls)!: deny and reset proofs on the controller-log form`.

### Task 12: Member removal, cascade and survivors

**Files:**
- Modify: `packages/mls/src/registry.ts`. `remove` claims fill `removedMembers` and `survivors` fill `survivorGrants`; no device record is written for a removal (D7).
- Modify: `packages/mls/src/lifecycle-proof.ts`. Removal claims cascade through `cascadeOf`. Each survivor grant is verified as a direct `mbr` leaf grant:
  - `aud` is the surviving leaf's DID and `cnf` its key;
  - it grants `authenticate` on `kumiai/mls-leaf`;
  - its lifetime is ≤ `trustedGrantLifetime`;
  - its root is effective in the post-entry head and is not the removed incarnation.
- Modify: `packages/mls/src/lifecycle.ts` (`checkSurvivors` refuses `effectiveAuthorityOf` = `removed`)
- Modify: `packages/mls/src/group-lifecycle.ts`
  - `RevokeWithProofParams` gains `remove?: Array<{ did: string; add: string }>` and `survivors?: Array<string>`.
  - `survivorTargets(group: GroupHandle, add: string): Array<{ did: string; leafKey: Uint8Array }>`.
- Modify: `packages/mls/src/group-handle.ts`: `GroupHandleEvents.memberRemoved: Array<{ controller: string; member: { did: string; add: string }; removedLeaves: Array<string> }>`.
- Test: `packages/mls/test/cascade-exemption.test.ts`, `packages/mls/test/member-removal.test.ts` (new), `packages/mls/test/lifecycle-invite.test.ts`

- [ ] **Step 1: Write failing tests**
  - `rmv cascades a direct mbr leaf`, `rmv cascades a leaf whose parent came from the removed member` and `rmv cascades the member's own membership leaf`.
  - `rmv keeps a leaf whose holder grant came from another effective member`.
  - `settled rmv proved by chain index removes the same leaves`.
  - `removed member's earlier-signed leaf arriving after the removal is refused` (Review Focus 1).
  - `removed member's concurrent log entry is refused` (Review Focus 1, `not-endorsed`).
  - `cascaded device returns under another member's grant` and `removed device returns under a new incarnation` (review finding 8).
  - `survivor grant keeps a direct mbr leaf; one from the removed member is refused`.
  - `survivor grant minted by a member removed in the same window is refused`.
  - `survivor authors its next commit` (`retain` with the substitute) and `survivor appears in a later Welcome` (`rejudge` with the substitute) (review finding 10).
  - `Welcome joiner refuses a leaf the ledger removed`: adapt `.superpowers/sdd/2026-10-23-management-tier/probe-p1-welcome-ordering.test.ts` (P1, moved there in Task 1) into this file, then delete the probe.
  - `concurrent mutual rmv: the first to land wins and the second is not-endorsed`.
  - Mutation-check it: make the fixer drop the tombstone read in `effectiveAuthorityOf` and confirm Review Focus 1 fails.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then run the `@kumiai/mls` and `@kumiai/mls-rpc` unit suites. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls): member removal by incarnation, shared cascade and survivor grants`.

### Task 13: Clock authority (D12)

**Files:**
- Modify: `packages/mls/src/lifecycle.ts`
  - `attestedTreeTime` replaces `timeOf` and `attestedTime`. `treeTime`, `isLapsed`, `checkAdmissionExpiry` and `checkTime` call it.
  - `assertRecoveryBinding` and `assertSenderNotLapsed` call it, the latter with `registryAt`.
- Modify: `packages/mls/src/lifecycle-proof.ts` (`clock` arm, both kinds; the leaves map drops `attested`)
- Modify: `packages/mls/src/registry.ts` (`clock` with `attest: true` folds `attestations[key] = max`; the key is the issuer's member pin from the recorded head)
- Modify: `packages/mls/src/group-lifecycle.ts` (`clockEntries` through `attestedTreeTime`; `attestTreeTime`), `packages/mls/src/recovery-verdict.ts` (`recoverySignerEligible`), `packages/mls/src/group-handle.ts` (`registryAt`, memoised per head, at most 8 entries)
- Test: `packages/mls/test/tree-time.test.ts` (new), `packages/mls/test/lifecycle-pipeline.test.ts`, `packages/mls/test/group-lifecycle.test.ts`, `packages/mls/test/recovery-verdict.test.ts`

**Interfaces:**
- Produces:
  - `attestedTreeTime(tree: ClientState['ratchetTree'], registry: DeviceRegistry, controllerID: string): number` (D12).
  - Clock entries: `{ op: 'clock', time: number, attest?: true }`.
    - Preservation (no `attest`): `timeFloor < time ≤ attestedTreeTime(pre-commit tree, pre-commit registry)`, from any bound device. It sets `timeFloor`.
    - Attestation: the issuer DID canonically equals an effective member's DID, `time > attestations[key] ?? 0` and `time ≤` that member's lease. It sets `attestations[key]` only.
  - `attestTreeTime(group: GroupHandle, time?: number): Promise<DeviceWriteResult | null>`. It returns `null` when this device is not an effective member or has nothing newer to attest.
  - `registryAt(group: GroupHandle, head: Uint8Array): DeviceRegistry` (D13).

- [ ] **Step 1: Write failing tests**
  - `single member of two with iat = lease - 60 does not lapse other leaves` (Review Focus 4). Mutation-check it: make the fixer take the max over all keys and confirm the test fails.
  - `two members agreeing advance tree time to the lower of their attestations`.
  - `sole effective member advances tree time`.
  - `two incarnations of one pinned key count once`: concurrent adds (`epoch.js` add branch).
  - `membership-only group advances through attest clocks from two members`.
  - `root-issued leaves do not advance tree time`.
  - `removed member's attestation stops counting; the preserved floor stays`.
  - `preservation clock cannot exceed attestedTreeTime`.
  - `attest clock from a non-member device is refused` and `attest clock past the member's lease is refused`.
  - `delayed application frame gets the same verdict before and after a later renewal, removal and settlement` (review finding 12).
  - `recovery eligibility uses attestedTreeTime over the known registry`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement, and route the four scans (P3) through `attestedTreeTime`. Migrate the 0.11 fixtures that advance time with root-issued leaves to member-issued grants or attest clocks. Locate them with `grep -rln "treeTime\|lapsed\|removeLapsedLeaves" packages/mls/test packages/mls-rpc/test`. The `<` and `<=` boundaries stay as they are.
- [ ] **Step 4:** Rerun, then run the `@kumiai/mls` and `@kumiai/mls-rpc` unit suites. Expected: PASS. Then run `test:types`.
- [ ] **Step 5:** Commit `feat(mls)!: tree time by effective-member quorum`.

### Task 14: Recovery arbitration of controller logs

**Files:**
- Modify: `packages/mls/src/registry.ts` (`arbitrateProjection`)
- Modify: `packages/mls-rpc/src/recovery.ts` (`knownRecoveryRegistry` arbitrates each controller with it)
- Modify: `packages/mls/src/recovery-verdict.ts` (a member-rooted signer is judged through `effectiveAuthorityOf` on the arbitrated registry; `unavailable` makes it ineligible)
- Test: `packages/mls-rpc/test/recovery-holder-evidence.test.ts`, `packages/mls/test/recovery-verdict.test.ts`

**Interfaces:**
- Produces: `arbitrateProjection(controller: string, known: ControllerProjection, offered: ControllerProjection): ControllerProjection` (D14). It throws on `LOG_FORKED`; the reply is then ineligible.

- [ ] **Step 1: Write failing tests**
  - `reply omitting a known removal keeps it`: the signer rooted in the removed member is ineligible (review finding 7).
  - `reply omitting a known renewal keeps the known lease`.
  - `stale reply keeps the known recorded log`.
  - `forked reply is refused`.
  - `saturated known log makes a member-rooted signer ineligible; a root-issued signer is judged as before`.
  - `verdict judging reads the arbitrated registry`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS. Then run `test:types` for `@kumiai/mls` and `@kumiai/mls-rpc`.
- [ ] **Step 5:** Commit `fix(mls-rpc): arbitrate known and offered controller logs in recovery`.

### Task 15: Contracts, doubles, band and docs

**Files:**
- Modify: `packages/rpc-conformance/src/group-mls.ts`: the `createBoundRecovery` clauses gain membership-bound and `mbr`-bound variants. `packages/rpc-conformance` has no persistence fixture, so the old plan's `persistence-fixture.ts` reference is dropped.
- Modify: every double the suites run against that builds bindings, registries or revoke proofs. Locate them with `grep -rln "holderGrant\|recordedLog\|logPosition\|revokeWithProof\|ControllerBinding" packages`.
- Modify: `packages/mls/README.md`, `docs/agents/architecture.md` and `docs/reference/mls-lifecycle.md`: binding forms, member roots, `log` entries, the proof form, tree time and the cap. Describe the surface only.
- Create: `pnpm change` intents for all fourteen packages at 0.12.
- Test: both conformance suites, against the real implementation and the doubles.

- [ ] **Step 1:** Add conformance cases:
  - an `mbr` leaf;
  - a membership leaf;
  - a `log` entry;
  - an epoch deny proof;
  - a removed member root refused;
  - an unavailable registry refused on admission;
  - recovery with a membership binding.
  Run each against the real implementation and every double. The doubles must refuse at least as much as the real code does.
- [ ] **Step 2:** Run both suites (a heavy run: request first). Expected: PASS on the real implementation and the doubles.
- [ ] **Step 3:** Update the docs.
- [ ] **Step 4:** Run `turbo run test:types` repo-wide (heavy run), then the forced full test (`Cached: 0`), then `rtk proxy pnpm run lint`. Expected: all green.
- [ ] **Step 5:** Commit `chore!: band 0.12, management tier contracts and docs`.

## Plan review dispositions

Review: `.superpowers/sdd/2026-10-23-management-tier/plan-review-codex.md` (3 Critical, 10 Important, 2 Minor). All 15 are resolved. Two sub-points of Critical 3 are ruled out.

| # | Finding | Disposition |
|---|---|---|
| C1 | No bootstrap or settlement transport; creation and key packages authenticate before a registry exists | Resolved. D1 delta carriage (a full chain when none is recorded); D2 genesis entry; D3 settlement as a `log` chain suffix. Tasks 3, 8 and 9. Tests: `createGroup with a membership creator seeds the registry…`, `publishControllerLog settles without a revoke`, `membership key package needs controllerLog`. |
| C2 | Ingestion lacks current-authority checks and gate wiring; `rev`/`rmv` effects unenforced | Resolved. D5 endorsement in `ingestControllerLog` (Task 3). D4 effect-free `log` entries. D6 declared effects on `revoke` (Tasks 11 and 12). Gate wiring: `isLifecycleDeviceValue`, `envelope-fold` and `prepareLifecycleGate` (Task 8). D1 persists `authoritativeLog(...).log`, never the fold input. |
| C3 | Tree time fails for one member, after a removal, and for membership-only groups | Resolved by D12 (user decision): distinct pinned keys, the quorum, attest clocks for membership-only groups, and a persisted floor preserved by quorum-backed clocks. Task 13. Ruled out: (a) "removing the second member activates the survivor's earlier future timestamp". A sole effective member may set time anyway under the user's rule, so re-activation adds no power (accepted, N3). (b) "an independently bounded time source". The user's decision rules it out. Stated consequences: a group with only root-issued leaves, or with a member offline, advances only as fast as its quorum attests. |
| I4 | R9 covers only one early path | Resolved. D9 and the staged verification table in Task 9 (Welcome, external recovery, creation, key packages, restore); live commits and authoring in Task 8. |
| I5 | `MAX_LEAF_LIFETIME` as `maxMemberGrantLifetime` rejects long parents | Resolved. `MAX_TRUSTED_GRANT_LIFETIME` for every walk, with the local bounds kept. Task 6, test `30-day member parent with a one-hour leaf authenticates`. |
| I6 | Membership interfaces incomplete; `member.did` nonexistent; no `iat` | Resolved. `LeafBinding`/`bindingOfDID` gain `member` (Task 2). The pin is compared through `resolveMember`'s returned key bytes (Task 7). D16 `iat`, with `bindingIssuedAt` for stale-leaf ordering. RPC `current()`/`bindingID` updated (Task 7). |
| I7 | Recovery discards known member removals | Resolved. D14 `arbitrateProjection`. Task 14. |
| I8 | Removal must not become a permanent audience denial | Resolved. D7 `removedMembers` by incarnation, with no device record for cascades. Task 12 regrant and re-add tests. |
| I9 | Proof identity and settled removal undefined | Resolved. D6 `EffectClaim` with `ref`; `effectOf` checks the ref proves that claim; `memberDropIndices` covers a settled `rmv`. Task 4. |
| I10 | Survivor exemption does not survive full authentication | Resolved. D10 `effectiveAuthorityOf`, used by authentication (`retain`/`rejudge`), cascade, Welcome and recovery; the survivor grant producer is in Task 12. Tests: survivor's next commit and later Welcome. |
| I11 | Caps and saturation disable existing credentials; Boolean effectiveness | Resolved. D8 four-state status; D9 modes; D11 cap only on admission. Tasks 4, 6 and 10 test subsequent commits, Welcome survivors, root-issued admissions and root repair. Note: recorded-log saturation (4 096 events, kokuin `MAX_EPOCH_EVENTS`) is unreachable in practice, because `HISTORY_HORIZON` (393 216 B; P2 measured 437–741 B per event) refuses the growth well before it. The paths still fail closed, and the tests use `saturatedLog()`. |
| I12 | Historical admission needs a historical registry | Resolved. D13 `registryAt`. Task 13. |
| I13 | ControllerLog proofs escape history accounting | Resolved. `proofSize` counts every retained copy, and derived projections are not counted again (Task 3). |
| M14 | Producers and intermediate contracts underspecified | Resolved. Interface table; producers are typed in Tasks 8, 11 and 12; `memberRemoved` event; the shared model (Task 4) precedes producers and verifiers. |
| M15 | "Chain-only means no members" is wrong | Resolved. A settled snapshot's members are members (Task 4 and 5 tests); an incompatible prefix is a separate `prefixRelation` refusal (Task 5). |

Also corrected while revising:
- The P1 probe now lives in the plan workspace, not `packages/mls/test`.
- `packages/rpc-conformance/src/persistence-fixture.ts` does not exist.
- A lifecycle group has exactly one controller (`registry.ts:170-174` keys lifecycle effects on the anchor's), so per-group registry state is per that controller.

Consequences of fixed decisions, stated so review can check them:
- With the root cold for MLS time, groups whose leaves are all root-issued never advance tree time, so their leaves never lapse by time. Revocation still works.
- Removal of a member, in kumiai, refuses that member's later-arriving concurrent actions, including a concurrent counter-removal. Kokuin's union semantics then differ from the group until root settles.
- An external rejoin cannot carry ledger entries, so a rejoiner whose new binding needs events the group lacks ends `renewal-required` until a member publishes them.

## Needs user decision

**Standard groups and member-rooted credentials (D15).** The spec widens `verifyManagementCapability` to `mbr` (kumiai section, "Leaf binding"). That function serves only standard groups: lifecycle groups refuse non-lifecycle device ops (`registry.ts:351`, `envelope-fold.ts:104`). After R8, member authority needs a registry-held log. Standard groups would therefore need `log` entries keyed by each controller (subject = controller) and a second ingestion surface. They have no tree time or cascade.
- Option A (recommended): lifecycle groups only in 0.12. Standard groups refuse member-rooted bindings and keep root-only `manage`. Kubun's controller-bound groups are lifecycle groups (own-agents: kubun `docs/agents/plans/milestones/catalog-sync-own-agents.md`). A search of kubun source found no use of standard-group device management (`registerDevice`, `addDevice`, `kumiai/devices`). Cost if wrong: one task adding standard-group `log` ingestion, with no change to the shared model.
- Option B: support both in 0.12. Add a task after Task 8: `log` entries in standard groups, issuer bound to the subject controller, and member authority for `manage` and leaves.
Plan as written follows A.

## Probe findings

Full reports live in the plan workspace (`.superpowers/sdd/2026-10-23-management-tier/task-P<n>-report.md`). Task numbers in this section are the pre-revision plan's. R2 is superseded by D12 (user decision); R9 is generalised by D9.

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
