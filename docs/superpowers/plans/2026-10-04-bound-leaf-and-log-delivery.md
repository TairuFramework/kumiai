# Bound Leaf Lifecycle and Epoch Change Log Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship bound agent membership, permanent proven revocation and durable epoch-aware log delivery together.

**Architecture:** Lifecycle consensus uses embedded controller proofs, authenticated ledger projections and deterministic tree time. RPC adds an ordered durable outbox, confirmed recovery and a recoverable anchor rotation slot. All kumiai changes share one branch and release, after the kokuin prerequisite patch.

**Tech Stack:** TypeScript, pnpm 12.6.0, Vitest, ts-mls 2.0.0-rc.13, kokuin capability/controller/token, existing Enkaku hub transport.

**Spec:** `docs/superpowers/specs/2026-10-03-bound-leaf-lifecycle-design.md` (L) and `docs/superpowers/specs/2026-10-03-epoch-change-log-delivery-design.md` (D). Both are binding authority.

**Stage:** planning
**Mode:** mixed -- settled tasks plus exactly two LEARNING-LOOP questions, Tasks 5 and 11.
**Execution:** Serial, one task at a time. The user chooses the execution method at plan handoff. Learning-loop Tasks 5 and 11 run their probe and discussion steps with the user, whatever the method.

## Global Constraints

- Kumiai branch: `feat/bound-leaf-lifecycle`. Worktree: `/Users/paul/dev/yulsi/kumiai.worktrees/bound-leaf-lifecycle`.
- Kokuin prerequisite: `/Users/paul/dev/yulsi/kokuin`. Its capability patch releases before kumiai depends on it.
- Release actions belong to the user. Both repository deliverables stop at **ready to release**, without publishing or version consumption.
- Kumiai ships patch versions within the current band. Breaking changes are allowed because kubun is the only consumer.
- No anchor version change. `HANDSHAKE_VERSION` stays `1`. Every lifecycle peer must run the coordinated release.
- ts-mls stays `2.0.0-rc.13`. No ts-mls edits, deeper delegation, controller-log transfer, paged ledger or staged proof protocol.
- `leafLifetime`: default `86,400`, range `1..604,800` seconds. Outside lifecycle groups, leaf ceiling `604,800` seconds.
- `trustedGrantLifetime`: default `2,592,000`, range `1..31,536,000` seconds. Outside lifecycle groups, trusted-grant ceiling `31,536,000` seconds.
- `HISTORY_HORIZON = 393,216` bytes. Post-history must be within the horizon **or no larger than pre-history**.
- Whole-frame bound: `4 * Math.ceil(n / 3) <= 1,048,576` base64 characters, equivalent to at most `786,432` raw bytes.
- `MAX_APP_ENTRY_BYTES = 524,288` plaintext bytes. At `524,289`, dispatch rejects before reserving or writing.
- Consensus reads no clock or DID cache. Authoring and recovery trust gates alone use local time. Verdict allowance is `300` seconds.
- Tree lapse is `exp < treeTime`; entry admission requires `exp > treeTime`; authoring requires `iat <= now < exp`.
- H's ledger revocations are permanent. Reset raises a generation floor. Consumer ledger entries only have the whole-frame bound.
- Helpers neither mutate the input handle, persist, publish nor retry. Derived events fire only on accepted adoption.
- Log dispatch resolves at durable acceptance. Per-sender order and at-least-once delivery survive crashes and epoch changes.
- Worker retry starts at `1 s`, doubles to `60 s`. Failed removal retries removal alone. Ephemeral and directed traffic bypass the outbox.
- One live peer owns each group's outbox, journal and anchor slot. Replacement waits for `dispose()` then `drained()`.
- pnpm only. Never edit generated `lib/`. Cross-repo dependencies use published catalog `^` ranges. Internal dependencies use `workspace:^`.
- Every task runs kumiai whole-repo `pnpm run test:types` and its relevant Vitest files. Port changes run both contract suites against real implementations and doubles.
- Commit steps are performed by the controlling session (`git commit` of the task's files only). Implementers never run git.

## Review Focus

1. Non-finite or fractional time claims and anchor lifetimes must fail closed rather than defeat comparisons. Task 2 and Task 3 pin this.
2. Non-ASCII signed-event JSON must count UTF-8 bytes, including every repeated prefix copy. Task 5 pins this.
3. A throwing host function or hostile thenable must release exactly one boundary count while preserving method receivers. Task 11 pins this.
4. A rejected initial outbox listing must preserve call order and reservations without accepting an undurable dispatch. Task 14 pins this.
5. Disposal or rejection during removal must preserve durable state and prevent duplicate clear notices in one peer lifetime. Task 15 pins this.

---

## File structure and dependency map

Existing responsibilities remain in place. Small new files isolate mechanisms that otherwise enlarge `peer.ts` or `group-handle.ts`.

| Files | Responsibility | Owner |
| --- | --- | --- |
| Kokuin `packages/capability/src/delegation.ts`, `test/atk-chain.test.ts` | Parent expiry attenuation, mint and verify | 1 |
| `packages/mls/src/authentication.ts`, new `capability.ts`, new `errors.ts` | Offline direct/delegated verification, issuing, typed lifecycle errors | 2 |
| `packages/mls/src/anchor.ts`, `types.ts`, `group-create.ts`, `group-credential.ts`, `roster.ts` | Genesis policy and bound creation | 3 |
| `packages/mls/src/registry.ts`, `device-proof.ts`, `envelope-fold.ts`, new `lifecycle-proof.ts` | Recorded log, proofs, floors, registry agreement | 4 |
| New `packages/mls/src/history.ts`, new `packages/rpc/src/frame-size.ts` | UTF-8 history accounting and final wire size | 5 |
| New `packages/mls/src/lifecycle.ts`, `group-handle.ts`, `group-commit.ts`, `policy.ts` | Entry and commit gates, post-apply adoption | 6 |
| New `packages/mls/src/group-lifecycle.ts` | Renewal, lapse removal and one proof commit | 7 |
| `packages/mls/src/group-commit.ts`, `group-welcome.ts`, `types.ts` | Recipient-bound invites, bound external join, Welcome | 8 |
| `packages/mls/src/group-context.ts`, `group-handle.ts`, `group-device.ts`; `mls-rpc/src/access.ts` | Speculative isolation, event adoption, admission snapshot | 9 |
| `packages/mls/src/recovery.ts`; new `mls-rpc/src/recovery.ts`; `mls-rpc/src/mls.ts`; `rpc/src/crypto.ts`, `peer.ts` | Lifecycle recovery binding and authenticated reply ledger | 10 |
| New `packages/rpc/src/host-boundary.ts`, `peer.ts`, `host-notice.ts` | Invocation tracking and drain | 11 |
| New `packages/mls/src/recovery-verdict.ts`; `rpc/src/crypto.ts`, `handshake.ts`, `recovery.ts`; `mls-rpc/src/recovery.ts` | Verdict cryptography and ports | 12 |
| New `packages/rpc/src/recovery-confirmation.ts`, `peer.ts` | Pending recovery, outcome cache and lane-free verdict wait | 13 |
| New `packages/rpc/src/app-outbox.ts`, `peer.ts`, `errors.ts`; fixture outbox | Durable acceptance and reservations | 14 |
| New `packages/rpc/src/log-delivery.ts`, `peer.ts`; hub fixtures | Covered floor and ordered worker over a checked gap result | 15 |
| `packages/rpc/src/anchor.ts`, `peer.ts`; anchor fixtures | One-advance rotation record and startup repair | 16 |
| `packages/rpc/src/commit.ts`, `peer.ts`; new `mls-rpc/src/revoke.ts` | Revoke hold, journal replay and publisher | 17 |
| `packages/rpc/src/hub-mux.ts`, `peer.ts` | Early retain and unclaimed-frame hand-off | 18 |
| Hub protocol/server/client/tunnel fetch producers; `hub-conformance/src/index.ts`, `log-hub.ts`; hub suites | Required wire gap, prefix purge and complete hub conformance | 19 |
| `packages/rpc/src/app-lane.ts`, `app-cursor.ts` | Accurate per-fetch pruning notice | 20 |
| `docs/agents/architecture.md`, `docs/reference/*`, patch intents | Consumer contracts, residuals and coordinated release notes | 21 |

Each task also updates the affected package's existing exports (`src/index.ts`, and MLS `src/group.ts`) and fixtures.
New file names above are implementation decisions, not claims that those files exist today.
`DeviceWriteResult.epoch` remains `bigint` in MLS (`packages/mls/src/group-device.ts:18`). RPC converts epoch values to `number` at its ports.

Verification commands below run from the kumiai root unless an absolute `pnpm -C` directory says otherwise.
Vitest file filters run through package scripts: `pnpm --filter @kumiai/<package> exec vitest run <files>`.
Whole-repo type verification uses the root script (`package.json:17`), never a package-only substitute.
Each red step expects the named missing behaviour, rather than an unrelated compilation or fixture failure.
Assertion excerpts below use local test observation variables established by that step's described scenario. They do not introduce production APIs.
Each green step requires exit code `0`, all selected tests passing and no hanging callback.

## Phase 0: Can kokuin enforce parent expiry without widening this patch?

**Exit criteria:** One capability-only behavioural patch passes mint and verifier tests and is ready for the user's release.
**Feedback protocol:** Show the patch evidence and ready-to-release state. Wait for the user to release it and identify the published patch before Phase 1.

### Task 1: Parent expiry attenuation in kokuin

**Files:** Modify `/Users/paul/dev/yulsi/kokuin/packages/capability/src/delegation.ts:43`; test `packages/capability/test/atk-chain.test.ts`, `lib.test.ts` in that repository. Add a capability patch intent using its existing versioning configuration.
**Interfaces:** Consumes existing `createCapability(signer, payload, header?, options?)` and `assertValidDelegation(from, to, atTime?)`. Produces unchanged signatures with child-expiry attenuation shared by `checkCapability` and `checkDelegationChain`.

- [ ] **Step 1: Write failing `childExpiryCannotExceedParent` tests (L42).** Assertions: `child.exp === parent.exp` passes; `child.exp === parent.exp + 1` rejects; absent child `exp` with bounded parent rejects; unbounded parent retains existing behaviour. Exercise mint, `checkCapability` and `checkDelegationChain`, including a bad intermediate link.

```ts
expect(equalExpiryAccepted).toBe(true)
expect(laterChildRejected).toBe(true)
expect(missingChildExpiryRejected).toBe(true)
```

- [ ] **Step 2: Run the red tests.** Run `pnpm -C /Users/paul/dev/yulsi/kokuin/packages/capability exec vitest run test/atk-chain.test.ts test/lib.test.ts`. Expect new attenuation assertions to fail.
- [ ] **Step 3: Implement the parent-expiry check in `delegation.ts`.** Apply it on delegated mint and `assertValidDelegation`, without changing token verification, time semantics or controller logic.
- [ ] **Step 4: Verify the ready-to-release patch.** Run the Step 2 command, `pnpm -C /Users/paul/dev/yulsi/kokuin run test:types`, `pnpm run test:types`, and `pnpm --filter @kumiai/mls exec vitest run test/authentication-bound.test.ts`. Expect all green.
- [ ] **Step 5: Prepare the patch intent and stop at ready to release.** Record the user's published version before dependency adoption. Commit only this task's reviewed files.

## Phase 1: Can every lifecycle transition be judged from authenticated group state?

**Exit criteria:** Offline credentials, lifecycle gates, helpers, speculative adoption and binding-aware recovery pass their owned tests.
**Feedback protocol:** Stop at Task 5 for raw measurements and explicit discussion. Present phase evidence and obtain feedback before Phase 2.

### Task 2: Clock-free verification and issuance

**Files:** Modify `packages/mls/src/authentication.ts:103`, `packages/mls/src/embedded-resolver.ts:15`; create `packages/mls/src/capability.ts`, `errors.ts`; test existing `authentication-bound.test.ts`, `management-capability.test.ts`, new `capability.test.ts`. Modify `pnpm-workspace.yaml` and lockfile only after the user's prerequisite release.
**Interfaces:** Consumes Task 1's published capability patch and existing `ControllerBinding` (`packages/mls/src/credential.ts:36`). Produces `mintLeafCapability({signer, controllerID, audience, leafKey, exp, parent?}): Promise<string>` and `mintTrustedGrant({signer, controllerID, audience, leafKey, exp}): Promise<string>`, with `SigningIdentity`, strings, bytes and numeric seconds as L§5 specifies. Authentication dependencies gain optional leaf/trusted lifetime providers. Exports `LeafBindingError(reason)`, `LeafLapsedError(reason)` and `RevokeProofError(reason)` with these exact reasons:
- `LeafBindingError`: `issuer-mismatch`, `subject-mismatch`, `chain-depth`, `self-issued`, `child-outlives-parent`, `denied-issuer`, `lifetime-cap`, `generation-floor`, `identity-change`, `controller-mismatch`, `floating-refused`, `history-horizon`.
- `LeafLapsedError`: `lapsed`.
- `RevokeProofReason`: `no-rev`, `wrong-controller`, `not-authority-signed`, `generation-floor`, `too-large`, `detached`, `needs-reset`, `effects-mismatch`, `removes-mismatch`.

- [ ] **Step 1: Write L1-3 verification tests and `nonFiniteClaimsFailClosed`.** Assert foreign self-issuance is `issuer-mismatch`, wrong management `sub` is refused, differing receiver clocks produce identical verdicts, valid T delegation passes, all seven L3 invalid forms fail. Assert NaN, infinity, missing required `iat`/`exp`, zero lifetime and malformed `cnf` fail. Mint checks pin `604,800`/`31,536,000`, self-audience and parent expiry.

```ts
expect(foreignIssuerError.reason).toBe('issuer-mismatch')
expect(clockAVerdict).toEqual(clockBVerdict)
expect(invalidChainAccepted).toBe(false)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/authentication-bound.test.ts test/management-capability.test.ts test/capability.test.ts`.
- [ ] **Step 3: Implement direct/delegated credential verification and issuing contracts.** Verify direct tokens historically at their `iat`. Verify the child signature using `getVerifier` and the parent `cnf`, then `checkCapability(..., {atTime: child.iat, methods: [embedded], maxDepth: 1})`. Pin issuer, subject, audience, permissions and keys. Deny both floating DIDs and trusted issuers. Keep embedded resolver denial group-derived, never controller-head-derived.
- [ ] **Step 4: Verify.** Run Step 2 and `pnpm run test:types`. Expect no external resolver calls and clock-independent verdicts.
- [ ] **Step 5: Commit this reviewed verification unit.**

### Task 3: Genesis lifecycle policy and bound construction

**Files:** Modify `packages/mls/src/anchor.ts:38`, `packages/mls/src/types.ts:13`, `packages/mls/src/group-create.ts:23`, `packages/mls/src/group-credential.ts:17`, `packages/mls/src/roster.ts:45`, `group-context.ts`; test `anchor.test.ts`, `group.test.ts`, `credential-controller.test.ts`.
**Interfaces:** Consumes Task 2's authentication providers and issuing contracts. Produces `GroupAnchor.controller?: string`, `leafLifetime?: number`, `trustedGrantLifetime?: number`; `GroupOptions` gains these creation inputs and `controller?: ControllerBinding`. `makeMLSCredential(identity: OwnIdentity, controller?: ControllerBinding): Credential`. Existing ordinary/last-resort key-package signatures consume the same binding option.

- [ ] **Step 1: Write `lifecycleGenesisPinsControllerAndCeilings` and `strictLifecycleAnchorNumbers`.** Assert defaults `86,400`/`2,592,000`, maximum `604,800`/`31,536,000`, invalid zero, over-max, non-finite and fractional values refuse. Assert `{H: admin}` seed, creator bound to H, unchanged version `1`, and standard-group seed unchanged. Pin authoring refusal at `exp <= now` or `iat > now` for group and both key-package constructors.

```ts
expect(anchor.leafLifetime).toBe(86_400)
expect(anchor.trustedGrantLifetime).toBe(2_592_000)
expect(anchor.version).toBe(1)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/anchor.test.ts test/group.test.ts test/credential-controller.test.ts`.
- [ ] **Step 3: Implement strict genesis fields and bound construction.** Configure lifecycle authentication before tree validation. Pin all GroupContext extensions except the ledger head, including caller-supplied extension bytes.
- [ ] **Step 4: Verify.** Run Step 2 and `pnpm run test:types`.
- [ ] **Step 5: Commit this reviewed genesis unit.**

### Task 4: Authenticated ledger projections and proof validation

**Files:** Modify `packages/mls/src/registry.ts:18`, `device-proof.ts`, `envelope-fold.ts`, `packages/mls/src/group-handle.ts:952`; create `lifecycle-proof.ts`; test `registry.test.ts`, `device-proof.test.ts`, `device-attacks.test.ts`, new `lifecycle-proof.test.ts`.
**Interfaces:** Consumes Tasks 2-3's verified binding and anchor. Produces registry controller projections `recordedLog: Array<SignedEvent>`, `genFloor: number`, `timeFloor: number`, with advisory beacon retained separately. Revoked records gain `logPosition`, optional `reason: 'reset'`, `cascadedFrom`. Export `revocationOf(group: GroupHandle, did: string): {controller: string; logPosition: number; reason?: 'reset'; cascadedFrom?: string} | null`. Internal `verifyLifecycleProof(group: GroupHandle, entry: VerifiedLedgerEntry<DeviceValue>): Promise<void>` validates recorded-head attachment and derived effects. Extend `foldEnvelope(baseRoster, baseRegistry, entries, groupID, context?: {controllerID: string; memberController: (did: string) => string | undefined}): EnvelopeFoldResult`. Both author and receiver pass the pre-commit membership context in lifecycle groups; standard groups omit it.

- [ ] **Step 1: Write L11, L15, L17-20 tests.** Pin banned lifecycle ops; all C3 registry/tree disagreements; authority-only proof verification, skip rejection, suffix attachment, empty suffix, `needs-reset`, exact effect/Remove sets; 50 rotations plus revoke yields a 51-event suffix. Assert permanent denial after un-revoke, ordinary rotation validity, reset floor and trusted-issuer cascade. Restore, Welcome and derived folds produce identical recorded logs, deny sets and floors.

```ts
expect(proofSuffix).toHaveLength(51)
expect(recordAfterUnrevoke.status).toBe('revoked')
expect(restoredRegistry).toEqual(liveRegistry)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/registry.test.ts test/device-proof.test.ts test/device-attacks.test.ts test/lifecycle-proof.test.ts`.
- [ ] **Step 3: Implement recorded-log and effect projection.** Replay first chain, later suffixes and replacement reset chains from authenticated ledger entries. Accept leafless revocations. Recompute live effects from the pre-commit tree, but replay recorded effects without consulting a later tree. Lifecycle consumer authority comes from a pre-commit H-bound leaf; reject `kumiai.role` and unknown reserved types. Retain standard-group management checks.
- [ ] **Step 4: Verify.** Run Step 2 and `pnpm run test:types`. Proof errors use every L reason: `no-rev`, `wrong-controller`, `not-authority-signed`, `generation-floor`, `too-large`, `detached`, `needs-reset`, `effects-mismatch`, `removes-mismatch`.
- [ ] **Step 5: Commit this reviewed ledger unit.**

### Task 5: LEARNING-LOOP -- Do real encodings support the fixed history horizon?

**Files:** Create `packages/mls/src/history.ts`, `packages/mls/test/history-size.test.ts`, `tests/integration/test/history-frame-size.test.ts`, `packages/rpc/src/frame-size.ts`, `packages/rpc/test/frame-size.test.ts`; modify RPC `packages/rpc/src/peer.ts:1892` final-frame call sites. Read kokuin builders at `/Users/paul/dev/yulsi/kokuin/packages/controller/src/events.ts:195`, `/Users/paul/dev/yulsi/kokuin/packages/controller/src/events.ts:335`, `/Users/paul/dev/yulsi/kokuin/packages/controller/src/events.ts:472`, `/Users/paul/dev/yulsi/kokuin/packages/controller/src/events.ts:622`.
**Interfaces:** Consumes Tasks 2-4's real tokens, anchor and proof shapes. Produces `HISTORY_HORIZON = 393_216`, `historySize(tree: ClientState['ratchetTree'], entries: ReadonlyArray<VerifiedLedgerEntry>): number`, and `assertFrameFits(payload: Uint8Array): void`, throwing exported RPC `FrameTooLargeError`. All later helpers and wire publishers consume these functions.
**Assumption:** JSON event byte sums, token expansion and actual MLS framing leave sufficient room at the fixed horizon.
**Done when:** Measurements cover real prefixes, repeated copies, ledger proof tokens, consumer entries and all history-bearing frames. The user records whether the prescribed envelope is supportable.
**Spec excerpt:** “The hub caps a publish at 1,048,576 base64 characters”; “HISTORY_HORIZON = 393,216”; “The horizon bounds history; the frame decides.”

The probe composes the proposed ledger-bearing GroupInfo plaintext in its test fixture using existing real codecs, signed tokens and HPKE. It does not require Task 10's production reply helper. Compare that provisional encoding with the final helper in Task 10 before release.

- [ ] **Step 1: State the question and proposed probe to the user.** Include the exact files and measurement dimensions. Wait for explicit feedback before probing.
- [ ] **Step 2: Run a bounded encoding probe.** Use real Ed25519 builders for inception, rotation, did:peer:4 revoke and reset; count UTF-8 signed-event JSON. Measure 10/50/100/256-event mixed and rotation-only logs, repeated leaf prefixes, base64url proof tokens and `[icp, reset]`. Record raw and final base64 lengths for commit, Welcome, invite, sealed GroupInfo with ledger and verdict. Include `64 * 1024` consumer bytes and non-ASCII labels. Do not replace measurements with the spec's historical estimates.
- [ ] **Step 3: Show raw results and verification output.** Run `pnpm --filter @kumiai/mls exec vitest run test/history-size.test.ts`, `pnpm --filter @kumiai/rpc exec vitest run test/frame-size.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/history-frame-size.test.ts`, and `pnpm run test:types`. Display byte tables, assertion output and any unsupported frame construction.
- [ ] **Step 4: Discuss the findings and stop.** Wait for the user's explicit decision. A contradiction requires a spec decision before further implementation. Do not autonomously alter the horizon or claim universal fit.
- [ ] **Step 5: Record the decision in the Decision log.** Include findings, spec impact and what was learned before advancing.
- [ ] **Step 6: Write failing `historyCountsUtf8AndEveryCopy` and `frameCapBeforeSideEffects` tests.** Assert repeated prefixes count repeatedly, every accepted proof remains counted after reset, consumer entries do not count towards history, and `786,432` bytes pass while `786,433` bytes fail before journal/publish.

```ts
expect(historyBytes).toBe(prefixUtf8Bytes * leafCopies + proofUtf8Bytes)
expect(rawFrameBytesAtCap).toBe(786_432)
expect(overCapJournalWrites).toBe(0)
expect(overCapHubPublishes).toBe(0)
```

- [ ] **Step 7: Run the red tests using Step 3's commands.** Expect boundary assertions to fail before implementation.
- [ ] **Step 8: Implement the approved accounting and frame-check contracts.** Apply final-byte checks after sealing and handshake framing, including commit, app, invite/Welcome paths and all control replies. Wire later verdict call sites in Task 12.
- [ ] **Step 9: Verify with Step 3's commands.** Expect all green. Task 10 owns L24's complete lifecycle frame-fit regression after authenticated reply ledgers exist.
- [ ] **Step 10: Commit the reviewed probe decision and accounting unit.**

### Task 6: Mandatory entry and commit gates

**Files:** Create `packages/mls/src/lifecycle.ts`, `packages/mls/test/lifecycle-pipeline.test.ts`; modify `packages/mls/src/group-handle.ts:952`, `packages/mls/src/group-handle.ts:1307`, `packages/mls/src/group-commit.ts:182`, `packages/mls/src/policy.ts:313`; test `authentication-bound.test.ts`, `policy.test.ts`, `persist-boundary.test.ts`.
**Interfaces:** Consumes Tasks 2-5's verified credentials, registry, immutable anchor and sizing. Produces internal `treeTime(group: GroupHandle, controllerID: string): number`, `validateEntry(group: GroupHandle, leaf: LeafNode, previous?: LeafNode): Promise<void>` and shared author/receiver gate preparation. `CommitRejectedError` gains `reason: 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'`, structurally matching the later RPC union without MLS importing RPC.

- [ ] **Step 1: Write L4-8, L14, L21, L28 tests.** Pin exact lifetime boundaries at Add/Update/external/Welcome, only H-attested time advancing, strict entry `exp > treeTime`, lapse `exp < treeTime`, clock-floor examples 100/90/95, fixed identity, composition exclusions and always-accept policy bypass attempts. Invalid survivor path keeps old state and delayed decryption; removed receiver may leave early as the accepted residual. Assert lapsed sender refusal precedes decrypt generation consumption.

```ts
expect(timeAfterFutureChild).toBe(timeBefore)
expect(floorAfterRemovingNewestLeaf).toBe(100)
expect(stateAfterRejectedPath).toBe(previousState)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/lifecycle-pipeline.test.ts test/authentication-bound.test.ts test/policy.test.ts test/persist-boundary.test.ts`.
- [ ] **Step 3: Implement the async pre-pass and synchronous proposal gate.** Compute registry/proof effects, times, lapsed targets and size before ts-mls. Enforce exact Removes, one clock, head-only extensions, no PSK/ReInit, external-init plus exactly one same-agent replacement. Mandatory gates precede caller role policy.
- [ ] **Step 4: Implement the survivor post-apply gate before adoption.** Preserve credential under member Removes, verify changed path entries and lapse renewal, maintain floor and final deny/floor invariants. Reject without assigning new state or zeroing consumed old secrets. Reuse this gate for author results.
- [ ] **Step 5: Verify.** Run Step 2 and `pnpm run test:types`. Assert lifecycle floors and horizon are excluded from standard groups; fixed identity and registry agreement still apply there.
- [ ] **Step 6: Commit this reviewed consensus gate unit.**

### Task 7: Renewal, lapse removal and proof builders

**Files:** Create `packages/mls/src/group-lifecycle.ts`, `packages/mls/test/group-lifecycle.test.ts`; modify `packages/mls/src/group-commit.ts:182`, `packages/mls/src/group-device.ts:18`; test `device-write.test.ts`, `external-rejoin.test.ts`.
**Interfaces:** Consumes Task 6's gates and Tasks 4-5's recorded proof and size contracts. Produces L§5 signatures `renewLeaf(group, binding): Promise<DeviceWriteResult>`, `removeLapsedLeaves(group): Promise<{removed: Array<string>; result?: DeviceWriteResult}>`, `revokeWithProof(group, {subject, log} | {reset: true, log}): Promise<RevokeBuildResult>`. `RevokeBuildResult` is exactly `built` with result, `already-revoked`, `self-affected` with subject, or `not-provable` with `RevokeProofReason`.

- [ ] **Step 1: Write L10, L16, L22-23 tests.** Assert late renewal, nondecreasing child `iat`, direct-to-chain renewal, original historical receiver tree and pending Add exclusion. Proof increments epoch once, evicts D, records leafless D, and duplicate winning proof returns `already-revoked`. At `393,216 - 1,024`, adding `2,048` history bytes fails for Add, renewal, external replacement and proof. Shrinking while over remains allowed; `[icp, reset]` renewals followed by reset reopen room. Test every helper outcome, including self-affected reset cascade and no-op lapse removal.

```ts
expect(renewedEpoch).toBe(previousEpoch + 1n)
expect(proofResult.status).toBe('not-provable')
expect(proofResult.reason).toBe('too-large')
expect(noLapsedLeaves).toEqual({ removed: [] })
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/group-lifecycle.test.ts test/device-write.test.ts test/external-rejoin.test.ts`.
- [ ] **Step 3: Implement the three mutex-bound builders.** Deep-copy own leaf, LeafNode and credential for renewal; restore the original tree in historical receiver data. Clear absorbed proposals for every lifecycle helper. Add a required clock automatically. Derive proofs from the recorded head and strip skipped input events before building.
- [ ] **Step 4: Verify.** Run Step 2 and `pnpm run test:types`. Each helper leaves its input untouched and returns typed failure before publication. Receiver checks include the removed-receiver horizon verdict.
- [ ] **Step 5: Commit this reviewed builder unit.**

### Task 8: Recipient-bound lifecycle invites and joins

**Files:** Modify `packages/mls/src/types.ts`, `packages/mls/src/group-commit.ts:112`, `packages/mls/src/group-commit.ts:378`, `packages/mls/src/group-welcome.ts:47`, `packages/mls/src/group-welcome.ts:186`; test `invite-recipient-binding.test.ts`, `external-rejoin.test.ts`, new `lifecycle-invite.test.ts`.
**Interfaces:** Consumes Tasks 3 and 6-7's bound constructors and author gates. Produces `Invite.recipientDID: string`; lifecycle `createInvite({group, identity, recipientDID, entries?})` has no permission or role token. Preserve the existing permission input for standard groups through a distinct typed parameter variant. External join accepts `controller?: ControllerBinding` and returns its existing result shape.

- [ ] **Step 1: Write L12-13 and L32 tests.** Assert role-free second membership and Welcome, wrong recipient refusal at invite commit and Welcome, all leaves H-bound, malformed controller refusal, floating external replacement refusal and missing binding `floating-refused`. Consumer entries ride Add atomically; two admissions for the same consent lose the epoch race once; an issuer with no pre-commit leaf fails.

```ts
expect(roleEntriesInLifecycleInvite).toHaveLength(0)
expect(invite.recipientDID).toBe(recipientDID)
expect(consentConsumptions).toBe(1)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/invite-recipient-binding.test.ts test/external-rejoin.test.ts test/lifecycle-invite.test.ts`.
- [ ] **Step 3: Implement recipient-bound lifecycle invite and join contracts.** Preserve whole-ledger authenticated-head validation. Apply key-package author-time checks in `commitInvite` and standard `addDevice`. Run lifecycle authentication for the entire Welcome tree and external GroupInfo tree before adoption.
- [ ] **Step 4: Verify.** Run Step 2 and `pnpm run test:types`. Existing standard-group invite tests remain green.
- [ ] **Step 5: Commit this reviewed admission unit.**

### Task 9: Speculative isolation and synchronous admission

**Files:** Modify `packages/mls/src/group-context.ts`, `packages/mls/src/group-handle.ts:1423`, `packages/mls/src/group-device.ts:151`; `packages/mls-rpc/src/access.ts:6`, `packages/mls-rpc/src/mls.ts:189`; `packages/rpc/src/crypto.ts`; test `device-events.test.ts`, `device-write.test.ts`, `mls-rpc/test/handle-access.test.ts`, `tests/integration/test/lifecycle-admission.test.ts` (new).
**Interfaces:** Consumes Tasks 6-8's candidate gates and lifecycle helpers. Produces `GroupHandle.sendAdmission(): SendAdmission`, `GroupHandle.confirmAdopted(): void`, `HandleAccess.admission(): SendAdmission`, `GroupMLS.sendAdmission(): SendAdmission`. `SendAdmission = {epoch: number; admissible: true} | {epoch: number; admissible: false; reason: 'lapsed'}`. Each handle owns auth service, deny provider and lifetime providers, sharing only the cipher suite.

- [ ] **Step 1: Write L9 and L27 tests.** Assert a discarded T-revoke candidate changes no live authentication and emits nothing; accepted adoption emits once despite repeated confirmation. Restore/Welcome stay silent and bootstrap emits only newly accepted records. During a replace callback, admission reads the pre-adoption epoch without the lock; afterward both published snapshots move together. The full dispatch-await assertion is owned here and activated with Task 14's dispatch implementation.

```ts
expect(eventsBeforeAdoption).toHaveLength(0)
expect(eventsAfterRepeatedConfirmation).toHaveLength(1)
expect(admissionInsideCallback.epoch).toBe(epochBefore)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/device-events.test.ts test/device-write.test.ts`, `pnpm --filter @kumiai/mls-rpc exec vitest run test/handle-access.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/lifecycle-admission.test.ts`.
- [ ] **Step 3: Implement independent derived contexts and pending events.** Recompute admission once per installed epoch. Fire received events after persistence; authored events at idempotent `confirmAdopted`. Make `HandleAccess.replace` confirm only after the host adoption callback resolves.
- [ ] **Step 4: Publish epoch/admission together at initialisation and successful mutate/open/replace completion.** Implement MLS `sendAdmission` directly from `access.admission`, without read/mutate/replace/open.
- [ ] **Step 5: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set below. Include transactional access fixtures and every GroupMLS double.
- [ ] **Step 6: Commit this reviewed adoption unit.**

### Task 10: Lifecycle recovery binding and authenticated reply ledger

**Files:** Modify `packages/mls/src/recovery.ts:530`, `packages/mls/src/group-welcome.ts:186`; create `packages/mls-rpc/src/recovery.ts`; modify `packages/mls-rpc/src/mls.ts:79`, `packages/rpc/src/crypto.ts:343`, `packages/rpc/src/peer.ts:2402`; test new `tests/integration/test/lifecycle-recovery.test.ts`, `history-frame-size.test.ts`, existing `mls/test/recovery-ledger.test.ts`.
**Interfaces:** Consumes Task 9's isolated candidates and Task 6's exact external acceptance checks. Produces `GroupMLS.prepareRecovery(): Promise<'ready' | 'renewal-required'>`; `GroupMLSParams.recoveryBinding?: (request: {groupID: string; controllerID: string; current: ControllerBinding}) => Promise<ControllerBinding | null>`; widened `applyRecovery(sealed, requestID): Promise<PendingRecovery | {renewalRequired: true} | null>`. Internal `openRecoveryGroupInfo(params: OpenSealedGroupInfoParams): Promise<{groupInfo: Uint8Array; ledger: Array<string>; signer: string}>` retains the existing public bytes-only opener for consumers. Task 12 consumes the pending tree and union of known/reply registries.

- [ ] **Step 1: Write L24 and L29-31, L33-35 tests.** Assert reuse without host calls, expired cached binding replaced once, all unusable/missing binding cases request no GroupInfo and hold automatic triggers, explicit recover reopens once, tree-lapsed present leaf can external-renew, floor/timeFloor in reply prevents publish, bad ledger head returns null. At horizon plus `64 KiB` consumer entry, commit/Welcome/sealed GroupInfo pass the real hub; one-byte-over-cap produces no journal/publish.

```ts
expect(cachedBindingHostCalls).toBe(0)
expect(freshBindingHostCalls).toBe(1)
expect(unusableBindingOutcome.reason).toBe('renewal-required')
expect(unusableBindingRecoveryRequests).toBe(0)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/integration-tests exec vitest run test/lifecycle-recovery.test.ts test/history-frame-size.test.ts`, `pnpm --filter @kumiai/mls exec vitest run test/recovery-ledger.test.ts`.
- [ ] **Step 3: Implement binding preflight and reply-ledger verification.** Check complete external predicates against own state before requesting and against responder tree/ledger afterward. Ask the host at most once per attempt, only in lifecycle groups. Digest both GroupInfo and whole ledger in the attestation and require the requester to hold a responder-tree leaf.
- [ ] **Step 4: Implement renewal-required trigger suppression in the peer.** Explicit recover or any ratchet clears renewal-required. Refused policy/invalid outcomes later hold until explicit recover. L34's responder-verdict assertions are activated in Task 13, retaining this task as their unique test owner.
- [ ] **Step 5: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set. Re-run this task after Task 13 to prove refusal mapping end-to-end.
- [ ] **Step 6: Commit this reviewed recovery-preflight unit.**

## Phase 2: Can accepted log events survive every epoch and host-boundary interruption?

**Exit criteria:** Confirmed recovery, durable ordered acceptance, safe certification, rotation repair, revoke holds and drain pass their owned tests.
**Feedback protocol:** Task 11 is a mandatory probe/discussion gate. Show phase evidence and obtain feedback before Phase 3.

### Task 11: LEARNING-LOOP -- Can one invocation wrapper enforce drained() at every host boundary?

**Files:** Create `packages/rpc/src/host-boundary.ts`, `packages/rpc/test/host-boundary.test.ts`, `peer-drained.test.ts`, `tests/integration/test/peer-drained-wire.test.ts`; modify `packages/rpc/src/peer.ts:467`, `packages/rpc/src/host-notice.ts:1`. Test existing dispose, gather and restore-race files.
**Interfaces:** Consumes construction parameters and Tasks 9-10's ports/returned recovery functions. Produces internal `createHostBoundary(): {wrap<T extends object>(value: T): T; close(): void; drained(teardown: Promise<unknown>): Promise<void>}` and `GroupPeer.drained(): Promise<void>`. `wrap` preserves receiver binding, function identity within the wrapped view and synchronous results; close forbids every subsequent invocation by synchronous `PeerDisposedError`.
**Assumption:** Invocation-scoped wrapping can capture construction methods, returned callables, later callbacks and abandoned promises without altering established API behaviour.
**Done when:** Every D§5 boundary category is demonstrated, including races and notices, existing tests stay green, and the user approves the implementation approach.
**Spec excerpt:** “Its scope is set by invocation, not by where a function came from”; “The wrapper counts each invocation from call to settlement”; “Only two parameters are excluded” (`hub` and `runtime`).

- [ ] **Step 1: State the assumption and finite probe scope to the user.** Wait for feedback before the probe.
- [ ] **Step 2: Probe one boundary around representative peer paths.** Exercise construction crypto/pending/MLS/stores/handlers/on* methods, returned PendingRecovery methods, commit build/returned acceptance, later gather onReply and notifyHost notices. Pause an abandoned list, ledger opener and unwrap separately. Check synchronous throw, rejecting/throwing thenable, method `this`, reused callable identity and no double counting. Assert byte arrays, signed-token data and protocol schemas remain ordinary data, rather than being traversed or proxied as host ports. Leave parked hub next/return and runtime excluded.
- [ ] **Step 3: Show category-by-category invocation traces and raw output.** Run `pnpm --filter @kumiai/rpc exec vitest run test/host-boundary.test.ts test/peer-drained.test.ts test/peer-dispose-race.test.ts test/peer-dispose-continuations.test.ts test/gather-stream.test.ts test/peer-delivery-before-ready.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/peer-drained-wire.test.ts`, and `pnpm run test:types`. Do not claim a category covered without a paused or late-invocation case.
- [ ] **Step 4: Discuss the result and stop.** Wait for an explicit user decision. If the wrapper cannot cover the required scope, discuss and update the design before implementing another mechanism.
- [ ] **Step 5: Record findings, spec impact and learned constraints in the Decision log.** Do not chain into the next task until recorded.
- [ ] **Step 6: Write the full failing D37a-f tests.** Keep their exact names. Assert drain waits on journal/acceptance, abandoned promises, returned recovery adoption and async onReply; late observer/timer invokes no host; next port call synchronously fails; replacement replays journal and outbox; parked transport cannot hold drain; live drain rejects without disposing.

```ts
expect(drainSettledWhileHostPaused).toBe(false)
expect(hostCallsAfterDispose).toBe(0)
expect(drainSettledWithParkedTransport).toBe(true)
```

- [ ] **Step 7: Run red tests with Step 3's commands.** Expect each named missing drain guarantee to fail.
- [ ] **Step 8: Implement the approved boundary and drain contract.** Wrap invocation results and callbacks entering later public methods, not just constructor objects. Close synchronously when dispose starts. Drain resolves after teardown settles, even if rejected, and count reaches zero. Teardown starts no wrapped host call. Notice errors remain observers' errors and do not alter lane outcomes.
- [ ] **Step 9: Verify with Step 3's commands and the port-contract command set.** Returned recovery and replacement-outbox cases reach their final assertions after Tasks 13-17 exist; keep them owned here and re-run at phase exit.
- [ ] **Step 10: Commit the approved decision and boundary unit.**

### Task 12: Recovery verdict cryptography and port contracts

**Files:** Create `packages/mls/src/recovery-verdict.ts`; modify `mls/src/recovery.ts`, `packages/rpc/src/crypto.ts:146`, `packages/rpc/src/handshake.ts:48`, `packages/rpc/src/recovery.ts:54`, `mls-rpc/src/recovery.ts`, `packages/mls-rpc/src/apply-commit.ts:58`, `mls.ts`; modify `rpc-conformance/src/group-mls.ts`; test new `mls/test/recovery-verdict.test.ts`, `tests/integration/test/lifecycle-verdict.test.ts`, existing port suites.
**Interfaces:** Consumes Task 10's pending/source trees, reply ledger and known registry. Define RPC `RecoveryRefusalReason = 'binding' | 'lapse' | 'floor' | 'policy' | 'invalid'`; `RecoveryVerdict` carries groupID/requestID/position/commitDigest and confirmed `{epoch, tag}`, superseded, or refused `{reason}`. `OpenedRecoveryVerdict = {signer: string; verdict: RecoveryVerdict}`. Produce GroupMLS `confirmationKey(position: string, commitDigest: string): Promise<{epoch: number; key: Uint8Array}>`, `sealRecoveryVerdict(request: Uint8Array, verdict: RecoveryVerdict): Promise<Uint8Array>`, `openRecoveryVerdict(sealed: Uint8Array, requestID: string): Promise<OpenedRecoveryVerdict | null>`. PendingRecovery gains `epoch: number`, `confirmationKey(position, commitDigest): Promise<Uint8Array>`, `judgeVerdict(opened: OpenedRecoveryVerdict): 'authoritative' | 'advisory'`, idempotent `onAccepted`. ProcessCommitResult gains `refusal?`.

- [ ] **Step 1: Write L36-40 and verdict cryptography tests.** Assert known/reply revocation, denied chain issuer, floor, lapse and leafless signer are advisory; unknown revocation counts exactly at `exp + 300`, not after; stale refusal cannot hold adoption. Non-lifecycle refusal requires source-tree membership, while confirmed tag needs no known-tree leaf. Pin all bindings and tag mismatch failures.

```ts
expect(verdictAtExpiryPlus300).toBe('authoritative')
expect(verdictJustPastExpiryPlus300).toBe('advisory')
expect(knownRevokedSignerVerdict).toBe('advisory')
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/mls exec vitest run test/recovery-verdict.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/lifecycle-verdict.test.ts`.
- [ ] **Step 3: Implement exporter and distinct-domain HPKE verdict seal/open.** Derive `MLS-Exporter("kumiai.rejoin-confirm", frame(groupID, position, commitDigest), 32)` and HMAC tag over requestID. Keep pending derivation unadopted. Retain the request's ephemeral private key for repeat verdict opens through its bounded lifetime, rather than consuming it on GroupInfo open.
- [ ] **Step 4: Implement verdict judgement and refusal propagation.** Join known/reply revocations and max floors. Apply L gate (a)-(d) to verdicts and GroupInfo attestations. Map entry checks 1/2/5 issuer/7/9 to binding, 3 to lapse, 4/time regression to floor, malformed/denied id to invalid, caller rejection to policy.
- [ ] **Step 5: Implement confirm-request/verdict codecs and frame guards.** Add kind values `5` and `6` for the two new messages, leaving handshake version `1`. Check final framed verdict bytes through Task 5's guard.
- [ ] **Step 6: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set. Full adoption/order assertions from L36-40 run again after Task 13's orchestrator.
- [ ] **Step 7: Commit this reviewed confirmation contract unit.**

### Task 13: Confirm-before-adopt orchestration

**Files:** Create `packages/rpc/src/recovery-confirmation.ts`, `tests/integration/test/recovery-confirmation.test.ts`; modify `packages/rpc/src/peer.ts:1237`, `packages/rpc/src/peer.ts:1445`, `packages/rpc/src/peer.ts:2402`; test `rpc/test/peer-recovery.test.ts`, `peer-recover-lane.test.ts`.
**Interfaces:** Consumes Task 12's exact verdict/PendingRecovery interfaces and Task 10's prepareRecovery. Produces confirmed position for Task 15's floor and Task 16's `epochAfter`, plus failed outcomes `refused` with refusal/responder and `unconfirmed` with advisory verdicts. Pending state retains old epoch/head, P, digest and target handle without adoption.

- [ ] **Step 1: Write D17a-j tests through the real adapter.** Pin happy one-rejoin path, stale responder superseded retry, authoritative policy/invalid hold, lost confirmation/orphan collection, forged/advisory verdicts, simultaneous recovery, pre-pull requests and revalidation, retransmission, invalid-envelope-first and copied-token/other-position cache isolation. Assertions include unchanged handle/floor/head before confirmation, one Bob leaf afterward and actual resealed delivery. Use D's exact source-tree and precedence rules.

```ts
expect(adoptionsBeforeConfirmation).toBe(0)
expect(bobLeavesAfterRetry).toHaveLength(1)
expect(policyRefusal.reason).toBe('refused')
expect(policyRefusal.refusal).toBe('policy')
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/integration-tests exec vitest run test/recovery-confirmation.test.ts test/lifecycle-verdict.test.ts test/lifecycle-recovery.test.ts`, `pnpm --filter @kumiai/rpc exec vitest run test/peer-recovery.test.ts test/peer-recover-lane.test.ts`.
- [ ] **Step 3: Implement publish/wait/adopt recovery phases.** Hold the lane through GroupInfo/publish, release it for verdict wait, reacquire for revalidation/adoption. Coalesce active recovery throughout. Queue commit behind it. Own pending P stops walks without strand, cursor advance or outcome; refuse GroupInfo/verdict service at or beyond own P.
- [ ] **Step 4: Implement bounded outcome and full-tuple verdict caches.** Record applied key immediately after ratchet, superseded for history/losing fork, refusal at own epoch, nothing for ahead/strand. Pull outside the handler lane. Repeat requests each recovery timeout, use jitter without storm suppression, and cache by verified requester/requestID/signed request/P/digest. Bound caches to 1,024 records and the attempt deadline; expiry drops K and sealed token.
- [ ] **Step 5: Implement precedence and held outcomes.** Confirmation adopts immediately; authoritative superseded outranks refusal; either opens one timeout settle round, never beyond deadline. Binding/lapse/floor block until inputs change; policy/invalid block until recover; unconfirmed retries on backoff. Retain pending onAccepted after ambiguous throws for idempotent retry.
- [ ] **Step 6: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set. Re-run delivery/rotation assertions at phase exit after Tasks 15-16.
- [ ] **Step 7: Commit this reviewed recovery orchestration unit.**

### Task 14: Durable dispatch and ordered reservations

**Files:** Create `packages/rpc/src/app-outbox.ts`, `test/fixtures/outbox.ts`, `test/peer-outbox-dispatch.test.ts`; modify `packages/rpc/src/peer.ts:172`, `packages/rpc/src/peer.ts:947`, `errors.ts`, fixture `peer.ts`; test new `tests/integration/test/outbox-adoption.test.ts`.
**Interfaces:** Consumes Task 9's synchronous admission and Task 11's wrapped host boundary. Produces required `GroupPeerMLSParams.appOutbox: AppOutbox`, `appOutboxLimit: number`, exactly D§5's `AppOutboxEntry` (`seq`, `protocol`, `prc`, `data`, nullable `lastAttempt` with number epoch/string-or-null floor/attempts). Store `put/list/remove/clear` all return `Promise<void>` except ascending `list(): Promise<Array<AppOutboxEntry>>`. Exports `AppOutboxFullError`, `AppEntryTooLargeError`, `SendNotAdmissibleError` with reason. Worker-facing reservations preserve call order and expose the lowest unresolved sequence.

- [ ] **Step 1: Write D20-23, D27, D36, D36b tests and `outboxListingFailurePreservesReservations`.** Assert delayed first insert blocks later publication, rejected put releases reservation, one free slot accepts exactly one caller, limit includes reservations, live listing failure neither accepts nor loses calls, pre-init calls resume in order. `524,288` passes and `524,289` rejects before seq allocation; lapsed rejects with reason. Real adoption callback awaits admission and dispatch without deadlock, sealing only with matching admission epoch. Activate L9's owned dispatch assertion here.

```ts
expect(plaintextBoundary).toBe(524_288)
expect(overBoundaryReservations).toBe(0)
expect(successesWithOneSlot).toBe(1)
expect(dispatchResolvedAfterPut).toBe(true)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/rpc exec vitest run test/peer-outbox-dispatch.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/outbox-adoption.test.ts test/lifecycle-admission.test.ts`.
- [ ] **Step 3: Implement durable dispatch acceptance and reservations.** Gate admission/size/cap synchronously once listing is ready; allocate in call order. Resolve only after atomic durable put. Failed put leaves no row. Expose accepted entries to Task 15's worker without awaiting any lane, handle lock or adoption transaction.
- [ ] **Step 4: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set. Update all peer construction fixtures with outbox/limit, including integration hosts.
- [ ] **Step 5: Commit this reviewed acceptance unit.**

### Task 15: Covered floors and the ordered delivery worker

**Files:** Create `packages/rpc/src/log-delivery.ts`, `test/peer-log-delivery.test.ts`; modify `packages/rpc/src/peer.ts:1369`, `packages/rpc/src/peer.ts:1445`, `packages/rpc/src/peer.ts:705`, `packages/rpc/src/peer.ts:2684`; RPC FakeHub/DurableFakeHub fixtures. Test new `tests/integration/test/epoch-log-delivery.test.ts`.
**Interfaces:** Consumes Tasks 13-14's confirmed recovery and outbox. Produces `EpochFloor = {epoch: number; position: LogPosition | null; covered: boolean}`, acknowledged-publication memory, bounded worker triggers and `onAppOutboxCleared({reason: 'removed', seqs: Array<number>})`. Internal `CoveredFetchResult = HubFetchTopicResult & {gap: boolean}` is returned only after runtime validation. Phase 2 fixtures supply gap; Phase 3 makes it required in every production/wire port and owns D§7. Real-MLS integration cases in this phase use a gap-capable FakeHub, preserving the real MLS/MLS-RPC/RPC stack. Final wire cases run after Task 19.

- [ ] **Step 1: Write D1-2, D4-16, D16a, D17-19, D24-26, D28-30, D34-35, D37 tests.** Assert actual receiver plaintext and topic, no intermediate-epoch send, safe single publish, bounded duplicate, own-markAccepted/floor window, ciphertext/floor pairing, poison certificate, trimmed/retained/empty gap variants, no-cursor risk-triggered rejoin, failed recovery retry, removed-behind-gap durable hold, ordering on reseal, every failure backoff, restart duplicate safety, removal clear and lapse hold. Add `removeFailureRetriesRemovalOnly` and `disposeDuringClearDoesNotReplayNotice` for Review Focus.

```ts
expect(intermediateEpochPublishes).toHaveLength(0)
expect(receivedPlaintext).toEqual(dispatchedPlaintext)
expect(gapNotice.kind).toBe('retention-gap')
expect(preparedButUnacknowledgedCertified).toBe(false)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/rpc exec vitest run test/peer-log-delivery.test.ts test/peer-outbox-dispatch.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/epoch-log-delivery.test.ts test/recovery-confirmation.test.ts test/outbox-adoption.test.ts`.
- [ ] **Step 3: Implement fixture gap reporting and checked fetch results.** In FakeHub/DurableFakeHub, raise a per-topic removedThrough only for physical log removal, preserving head. Use `removedThrough != null && (after == null || removedThrough > after)` in the same fixture fetch snapshot. Fork withholding sets no gap. Narrow production fetch replies through runtime boolean validation; missing/non-boolean gap fails the fetch and retries, never silently certifying it. Production protocol/store changes remain Task 19's Phase 3 work.
- [ ] **Step 4: Implement floor placement and covered walks.** Set floor only after successful applied/own/replay/confirmed ratchets, before barrier release. Cursor gap stops before the page, leaves cursor/head, emits claimed retention-gap with null digest/epoch, and heals after lane release. Empty later head/no messages/no gap is a contract breach treated as gap. Uncovered no-cursor floor remains uncovered until ratchet.
- [ ] **Step 5: Implement the ordered worker.** Process at most 64 entries per pass before yielding. Catch up outside the lane, hold on strand/lapse, seal with atomic anchor/barrier/floor/admission validation, persist attempt then publish. Only hub acknowledgement is publication evidence. Probe after the last publish with limit 1; head beyond floor requests pull. Certificate needs a walk started after acknowledgement, complete/covered/unstranded and ending at publication epoch. Back off on failures; retry proven removal alone.
- [ ] **Step 6: Implement durable membership endings and triggers.** Clear and notify on applied local removal without ratchet. Trigger on enqueue, probe, init after repair, lane completion and timer. Host clear/group deletion and permanent disposal end the documented promise; a recoverable dispose leaves entries for replacement. No automatic recovery while renewal-required/refused holds.
- [ ] **Step 7: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set. Re-run real integration recovery and lapse tests. Task 19 adds full producer conformance rather than duplicating owned D delivery tests.
- [ ] **Step 8: Commit this reviewed worker unit.**

### Task 16: Recoverable one-advance anchor rotation

**Files:** Modify `packages/rpc/src/anchor.ts:23`, `packages/rpc/src/peer.ts:1369`, `packages/rpc/src/peer.ts:2684`, `test/fixtures/anchor.ts`; create `test/peer-anchor-rotation-record.test.ts`, `tests/integration/test/anchor-rotation-recovery.test.ts`; test existing anchor restart/advance files.
**Interfaces:** Consumes Task 13's PendingRecovery target epoch/confirmed adoption and Task 15's floor/barrier. Produces `AnchorSlot = {anchor: Anchor; pending?: {epochBefore: number; epochAfter: number; rosterBefore: Array<string>; forced: boolean; advance: string}}`; `AnchorStore.load(): Promise<AnchorSlot | null>`, `save(slot: AnchorSlot): Promise<void>`. Gate every advance by digest identity, including replay and received commits.

- [ ] **Step 1: Write D31-33 and D33a-d tests.** Assert durable handle/failed save repairs before worker or next advance; unlanded record clears; throw-after-land captures E+1 before E+2; persisted/not-adopted record survives until restart; add/remove returning roster still rotates twice; refused external forced flag cannot leak into later commit; secret-gone forces confirmed rejoin, never derives E+2 topic. Fresh startup resolves ready minimally, publishes nothing, refuses commit and skips all other advances until confirmed recovery. Assert identical anchor/topic and actual receiver delivery.

```ts
expect(savedPending.epochAfter).toBe(pendingRecovery.epoch)
expect(anchorAfterThrow.epoch).toBe(epochBefore + 1)
expect(repairedTopic).toBe(aliceTopic)
expect(readyResolvedBeforeRecovery).toBe(true)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/rpc exec vitest run test/peer-anchor-rotation-record.test.ts test/peer-anchor-restart.test.ts test/peer-anchor-advance.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/anchor-rotation-recovery.test.ts test/recovery-confirmation.test.ts`.
- [ ] **Step 3: Implement pre-advance record and resolution gate.** Write before advance. Clear epochBefore only on known unlanded or init durable state. Ambiguous epochBefore permits only same-digest retry. At epochAfter capture there if forced or roster differs. Resolve each record before another advance and repair in the throwing catch path.
- [ ] **Step 4: Implement secret-gone startup recovery.** Load anchor/restore pending/setup control lanes/build epoch, resolve minimal readiness, then heal post-ready. Seal barrier holds; deferred journal bodies join re-enactment. Only confirmed forced rejoin replaces unresolved slot and clears anchorRecoveryPending. Confirmed recovery uses `PendingRecovery.epoch`, never header epoch or own epoch plus one.
- [ ] **Step 5: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set.
- [ ] **Step 6: Commit this reviewed rotation unit.**

### Task 17: Revoke hold and one-commit publisher

**Files:** Modify `packages/rpc/src/commit.ts:59`, `packages/rpc/src/peer.ts:2174`, `log-delivery.ts`; create `packages/mls-rpc/src/revoke.ts`, `rpc/test/peer-revoke-hold.test.ts`, `tests/integration/test/proven-revoke-run.test.ts`; update journal fixtures.
**Interfaces:** Consumes Task 7's `revokeWithProof` result, Task 15's submission worker and Task 16's advance gate. Produces `GroupPeer.commit(build: () => Promise<PendingCommit>, options?: {holdLogSends?: true}): Promise<LaneResult>`, `JournalEntry.holdsLogSends?: true` and L§5 `publishRevokeProof(peer, mls, {subject, log} | {reset: true, log})` with committed-number-epoch/already-revoked/self-affected/not-provable union. Adapter publisher builds against current HandleAccess, adopts through replace and journals the recoverable derived state, not an earlier cached handle. Register adapter instances in an internal `WeakMap<GroupMLS, HandleAccess>` in `mls.ts`; `revoke.ts` uses that registry. Reject an unsupported custom port explicitly. Do not add building or access methods to the public GroupMLS port.

- [ ] **Step 1: Write L25-26 and D36a tests.** Assert epoch-race rebuild against winner's recorded log and one landed proof commit; duplicate proof returns already-revoked. Hold spans queued/build/rebuild/publish and restart journal replay. Pause presealed lastAttempt write: no submission before revoke. Pause an already-submitted publish: no revoke journal or publish until settlement. Known unlanded releases hold; thrown pre-journal failure leaves no hold and caller reruns.

```ts
expect(logSubmissionsDuringHold).toBe(0)
expect(revokeJournalWritesBeforeInflightSettled).toBe(0)
expect(landedProofCommits).toBe(1)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/rpc exec vitest run test/peer-revoke-hold.test.ts test/peer-commit-replay.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/proven-revoke-run.test.ts`.
- [ ] **Step 3: Implement synchronous hold acquisition and submit registration.** Recheck hold and register in-flight submission in the same synchronous step that hands bytes to hub. Wait for all existing submissions to settle before journal/publish. Derive restart hold from the flagged journal slot; release only at adopted landing or known-unlanded result.
- [ ] **Step 4: Implement `publishRevokeProof` through one ordinary lane commit.** Rebuild helper on each race, preserve all result outcomes, convert bigint epoch at RPC boundary, and propagate lane failures without undoing accepted work. Supply adapter-internal building/journalling access without widening public GroupMLS for controller-log transfer.
- [ ] **Step 5: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set. Re-run Task 11's replacement-peer tests with flagged journal and outbox.
- [ ] **Step 6: Commit this reviewed revoke-run unit.**

### Task 18: Anchor-time subscription and mux hand-off

**Files:** Modify `packages/rpc/src/peer.ts:631`, `packages/rpc/src/hub-mux.ts:497`; test `hub-mux.test.ts`, `hub-mux-ack-refcount.test.ts`, `peer-delivery-before-ready.test.ts`, new `peer-early-subscription.test.ts`.
**Interfaces:** Consumes Task 16's resolved anchor capture. Preserves `retainTopic(topicID, options?): void` and existing inbound ack contract. Produces hand-off of previously unmatched frames to the first topic listener within existing ack TTL.

- [ ] **Step 1: Write D3, D38-40 tests.** Assert receiver between anchor move and rebuild receives acknowledged-subscription ephemeral event. Before acknowledgement no live-delivery promise. Unmatched retained frame hands off once and upstream ack follows listener ack. Two-epoch walk and past-TTL listener do not deliver the intermediate frame.

```ts
expect(deliveriesWithinTTL).toBe(1)
expect(upstreamAcksBeforeListenerAck).toBe(0)
expect(intermediateEpochDeliveries).toBe(0)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/rpc exec vitest run test/peer-early-subscription.test.ts test/hub-mux.test.ts test/hub-mux-ack-refcount.test.ts test/peer-delivery-before-ready.test.ts`.
- [ ] **Step 3: Implement capture ordering and unmatched-frame claims.** Export, issue protocol/self-inbox retains with app retention, assign/release barrier, save anchor, reset lane. Never await subscribe acknowledgement. Preserve idempotent lifelong retains and first-listener hand-off ownership.
- [ ] **Step 4: Verify.** Run Step 2 and `pnpm run test:types`. Include hub-mux dispose/receive-ended suites to ensure transport drain exclusion still holds.
- [ ] **Step 5: Commit this reviewed subscription unit.**

## Phase 3: Do real hubs, doubles and consumer contracts uphold the combined promise?

**Exit criteria:** Both contract suites pass everywhere, every spec test has one owner, reference docs and combined patch intents are ready to release.
**Feedback protocol:** Present final coverage, test output, breaking list and accepted residuals for user review. Stop at ready to release; the user owns versioning, release and downstream deployment.

### Task 19: Complete hub conformance over stores, doubles and wire

**Files:** Modify `packages/hub-protocol/src/types.ts:115`, `packages/hub-protocol/src/protocol.ts:118`, `packages/hub-server/src/memoryStore.ts:163`, `packages/hub-server/src/handlers.ts`, `packages/hub-client/src/client.ts:40`, `packages/hub-tunnel/src/transport.ts:98`, `tests/integration/test/log-hub-over-wire.ts:153`; `packages/hub-conformance/src/index.ts:87`, `packages/hub-conformance/src/log-hub.ts:224`; `hub-server/test/conformance.test.ts`, `log-hub-conformance.test.ts`, `memoryStore.test.ts`; `rpc/test/hub-conformance.test.ts`, `hub-tunnel/test/hub-conformance.test.ts`; `tests/integration/test/hub-log-lane.test.ts`.
**Interfaces:** Consumes Task 15's checked gap result and fixture watermark contract. Produces required `gap: boolean` in FetchTopicResult, HubFetchTopicResult, client and conformance results, with schema forwarding and prefix-only production purge. Produces reusable D§7 clauses 1-4 with separate publisher/reader clients and controllable store clock. Add `setTime?: (milliseconds: number) => void` to store conformance parameters; configure the memory runner with Vitest fake time and document mandatory SQL runner clock control. No kubun SQL implementation is in this branch.

- [ ] **Step 1: Write D41-43 and D45 tests.** Assert cross-topic linearizability, head surviving trim/purge, retained suffix and oldest after every removal, all six gap cases for trim/purge/depth, and wire propagation. Backward clock A then B: purge never deletes B while retaining A, fetch returns A/B with gap false; mailbox ages independently. Log-view clause tests depth eviction against both RPC doubles and real wire clients.

```ts
expect(trimmedBehindCursor.gap).toBe(true)
expect(cursorOnlyRemoved.gap).toBe(false)
expect(emptyPage.head).toBe(lastPublishedPosition)
expect(wireFetch.gap).toBe(storeFetch.gap)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/hub-server exec vitest run test/conformance.test.ts test/log-hub-conformance.test.ts test/memoryStore.test.ts`, `pnpm --filter @kumiai/rpc exec vitest run test/hub-conformance.test.ts`, `pnpm --filter @kumiai/hub-tunnel exec vitest run test/hub-conformance.test.ts`, `pnpm --filter @kumiai/integration-tests exec vitest run test/hub-log-lane.test.ts`.
- [ ] **Step 3: Implement required gap in all production fetch ports and wire schemas.** Update memory-store removeEntry, handler forwarding, client/tunnel results, mux results and wire adapter together. Compute gap with Task 15's watermark contract and the same fetch snapshot.
- [ ] **Step 4: Implement prefix-only age purge and reusable clauses 1-4.** Walk each topic's log frames in position order and stop at the first retained frame. Age mailbox frames independently. Preserve monotonic head and removedThrough, and add client/schema assertions rejecting absent gap.
- [ ] **Step 5: Verify.** Run Step 2, `pnpm run test:types`, and the port-contract command set. Re-run all Phase 2 recovery/delivery integration files against the production wire adapter, without a gap decorator. Document kubun SQLite/PostgreSQL separate-connection execution as the downstream release obligation, rather than claiming it ran here.
- [ ] **Step 6: Commit this reviewed conformance unit.**

### Task 20: Accurate app pruned-window notices

**Files:** Modify `packages/rpc/src/app-lane.ts:332`, `packages/rpc/src/app-cursor.ts:51`; test existing `peer-app-cursor.test.ts`, `peer-app-retention.test.ts`.
**Interfaces:** Consumes Task 19's conformed gap result. Produces `AppWindowPruned.oldest: string | null`, with notices deduplicated by topic and actual fetch-after cursor, independently of segment lifetime.

- [ ] **Step 1: Write D44 cases.** Cursor-only removal produces no notice. Missing later frames produce one with oldest; fully empty window produces one with null. Check gaps between pages and pulls use that fetch's after value. Repeated identical cursor reports once; no-cursor fetch reports nothing.

```ts
expect(cursorOnlyNotices).toHaveLength(0)
expect(emptyWindowNotice.oldest).toBeNull()
expect(repeatedCursorNotices).toHaveLength(1)
```

- [ ] **Step 2: Run red tests.** Run `pnpm --filter @kumiai/rpc exec vitest run test/peer-app-cursor.test.ts test/peer-app-retention.test.ts`.
- [ ] **Step 3: Implement per-fetch gap reporting and nullable oldest.** Remove oldest-based coverage inference and once-per-segment reported flag. Keep deduplication in memory, permitting one repeated notice after restart.
- [ ] **Step 4: Verify.** Run Step 2 and `pnpm run test:types`.
- [ ] **Step 5: Commit this reviewed notice unit.**

### Task 21: Contract documentation and coordinated patch readiness

**Files:** Modify `docs/agents/architecture.md`, `docs/reference/reserved-namespaces.md`, `app-lane.md`, `lanes-and-retention.md`, `group-protocols.md`, `sealing.md`; create `docs/reference/mls-lifecycle.md`; add combined kumiai patch intent under `.changeset/` using existing repository format. Update affected public API comments in MLS/RPC/MLS-RPC/hub ports.
**Interfaces:** Consumes all preceding public interfaces. Produces the D§8 consumer contract and both Release breaking lists, with no anchor/handshake version bump and no release execution.

- [ ] **Step 1: Pin L41 with both contract suites across every runner.** Add any missing recovery/admission/outbox/journal conformance assertions to the existing suites rather than treating fixture pass-through as proof. Assertions cover synchronous admission, idempotent pending adoption, refusal propagation, exporter keys and gap snapshot semantics.

```ts
expect(realAndDoubleRunnerFailures).toHaveLength(0)
expect(anchorVersion).toBe(1)
expect(handshakeVersion).toBe(1)
```

- [ ] **Step 2: Run the contract gate.** Run the port-contract command set and `pnpm run test:types`. Expect every real implementation and double runner green.
- [ ] **Step 3: Update persistent lifecycle/security and delivery contracts.** Document device ops and lifecycle restrictions, anchor fields/exact-release peers, L Accepted tradeoffs, fixed horizon/new-group path, removed-receiver residual, known-ledger verdict residual and consumer entry frame-only bound. Replace obsolete architecture claims that laggard loss and anchor crash gap are inherent.
- [ ] **Step 4: Document D§8 ownership and retry obligations.** Include resolved dispatch meaning, order, completion-safe handlers, narrowed ephemeral promise, plaintext encryption/erasure, lock-free admission, one-advance slot, gap/watermark/prefix purge, pruning notices, held recovery outcomes, revoke hold, whole-frame errors and dispose/drained handover. Forbid awaiting drained inside the peer's own counted callbacks. Note persisted notices can be lost on crash/dispose and hosts recover state from stores.
- [ ] **Step 5: Prepare combined patch release notes and the kubun handoff.** Include every L/D API and wire break, mandatory outbox/limit, journal flag, slot epochAfter/advance, nullable oldest, all errors, widened recovery results, verdict codecs, required gap and peer ownership. Name patches for MLS, MLS-RPC, RPC, hub-protocol/server/client/tunnel/conformance and contract-suite changes as needed. State hub deployment precedes or accompanies peers; rejoiners/responders ship together. Kubun supplies SQL watermark/prefix purge, migrations/encrypted outbox, recoveryBinding, lock-free access, completion-safe handlers and one designated-hub peer. Kubun runs its I6 reproduction and SQLite/PostgreSQL suites after one coordinated bump.
- [ ] **Step 6: Verify ready to release.** Run `pnpm run test:types`, `pnpm test`, `pnpm run build`, `pnpm run check:versions`, and the port-contract command set. Re-run every owned file listed above, including deferred integration assertions. Report actual output and remaining downstream obligations.
- [ ] **Step 7: Commit the reviewed docs and patch intents, then stop.** Do not consume versions, publish, deploy, bump anchor version or edit kubun here.

## Port-contract command set

Run this set whenever a task changes a port. Both suite families run against real implementations and doubles, per `docs/agents/architecture.md`.

```sh
pnpm --filter @kumiai/rpc exec vitest run test/ports-conformance.test.ts test/hub-conformance.test.ts
pnpm --filter @kumiai/mls-rpc exec vitest run test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts
pnpm --filter @kumiai/hub-server exec vitest run test/conformance.test.ts test/log-hub-conformance.test.ts
pnpm --filter @kumiai/hub-tunnel exec vitest run test/hub-conformance.test.ts
pnpm --filter @kumiai/integration-tests exec vitest run test/hub-log-lane.test.ts test/lifecycle-recovery.test.ts test/recovery-confirmation.test.ts
pnpm run test:types
```

New integration files join this set after their creating tasks. Before then, run only the existing files and current task's created tests.
Changing a port updates every producer and consumer in that task, so intermediate whole-repo type checks remain meaningful.
A spec test with later dependencies retains one owner. Re-running or activating its remaining assertions later never creates a second owner.
Record a cross-layer case as incomplete until every assertion runs green. Do not mark its owner complete using skipped tests.
A preparatory task can be reviewed and committed while those integration assertions remain outstanding in the phase ledger.
Phase exit requires its standalone assertions green. Final release readiness requires all cross-layer assertions green together.

## Requirement coverage

| Spec requirements | Tasks |
| --- | --- |
| L scope/F1/depth/issuing/clock-free credentials/errors | 2 |
| L§1 anchor, genesis, ceilings and bound creation | 3, 6, 8 |
| L§2 tree time, lapse, fixed identity, clock and author checks | 2, 3, 6, 7, 8, 9 |
| L§3 recorded log, proof/reset/cascade/permanence, C3 | 4, 6, 7 |
| L§3 horizon and whole-frame guard | 5, 6, 7, 10, 12, 15 |
| L§4 mandatory pre/callback/post gates and composition | 6 |
| L§5 issuing, setup, invites, helper results | 2, 3, 7, 8 |
| L§5 speculative adoption/read events | 9 |
| L§5 lifecycle recovery/refusal/verdict gates | 10, 12, 13 |
| L§5 one-commit revoke publishing and send hold | 17 |
| L§6 kokuin | 1 |
| D§1 covered floors/retention-gap/fresh-joiner recovery | 13, 15 |
| D§1 confirmation, outcome/verdict caches, precedence, residuals | 12, 13 |
| D§2 seal/floor/admission pairing | 9, 15 |
| D§3 durable dispatch, bounds and reservations | 14 |
| D§4 order/certification/backoff/membership/lapse/revoke hold | 15, 17 |
| D§5 outbox/snapshot/rotation/recovery/journal/drain/ownership | 9, 11-17 |
| D§6 early subscribe/mux/narrowed delivery | 18 |
| D§7 required gap/prefix purge/conformance/pruning | 15, 19, 20 |
| D§8 contracts and both Release/Consumer contract sections | 21 |

## Spec test ownership

The IDs below use the specs' Testing sections. Each numbered or lettered case has exactly one owner.
The listed task implements all assertions in that case, including its explicitly named variants.

| Spec test | Exact name or opening statement | Task |
| --- | --- | --- |
| L1 | *Issuer pin (F1).* | 2 |
| L2 | *Clock-free verdicts.* | 2 |
| L3 | *Chains.* | 2 |
| L4 | *Lifetime cap.* | 6 |
| L5 | *Only H moves tree time.* | 6 |
| L6 | *Grants advance it.* | 6 |
| L7 | *Clock entry.* | 6 |
| L8 | *Lapse and sending.* | 6 |
| L9 | *Admission without a lock.* | 9 |
| L10 | *Renewal.* | 7 |
| L11 | *Device ops.* | 4 |
| L12 | *Binding is membership.* | 8 |
| L13 | *Invite path.* | 8 |
| L14 | *Fixed identity.* | 6 |
| L15 | *Registry agreement (C3, other groups).* | 4 |
| L16 | *Proven revoke.* | 7 |
| L17 | *Rejected proofs.* | 4 |
| L18 | *Suffix against the recorded log.* | 4 |
| L19 | *Ledger is the only revocation authority.* | 4 |
| L20 | *Generation floor.* | 4 |
| L21 | *Composition.* | 6 |
| L22 | *Bound on every growth.* | 7 |
| L23 | *Reset is the path.* | 7 |
| L24 | *Frames fit.* | 10 |
| L25 | *One commit, rebuilt after a lost race.* | 17 |
| L26 | *Removal before the next broadcast.* | 17 |
| L27 | *Speculative handles.* | 9 |
| L28 | *Pipeline.* | 6 |
| L29 | *Binding reuse.* | 10 |
| L30 | *Fresh binding.* | 10 |
| L31 | *Renewal required.* | 10 |
| L32 | *Floating refused.* | 8 |
| L33 | *Tree-lapsed but present.* | 10 |
| L34 | *Refusal reasons.* | 10 |
| L35 | *Floor raised in the gap.* | 10 |
| L36 | *Known revocation.* | 12 |
| L37 | *Revoked chain issuer.* | 12 |
| L38 | *Floor, lapse, no leaf.* | 12 |
| L39 | *Residual boundary.* | 12 |
| L40 | *Stale refusal.* | 12 |
| L41 | Both conformance suites pass. | 21 |
| L42 | `createCapability` and `checkCapability` reject a child that outlives its parent. | 1 |
| D1 | A roster commit lands while bob is detached. | 15 |
| D2 | The same scenario with a non-roster ledger commit. | 15 |
| D3 | Bob's anchor has moved and his runtime is not rebuilt yet. | 18 |
| D4 | **Safe frame.** | 15 |
| D5 | **Bounded duplicate.** | 15 |
| D6 | **Own-commit window.** | 15 |
| D7 | **Seal/floor pairing.** | 15 |
| D8 | **Trimmed commit body, advanced head.** | 15 |
| D9 | **Two commits in one walk.** | 15 |
| D10 | **False positive cleared.** | 15 |
| D11 | **Gap behind a retained frame.** | 15 |
| D12 | **Stranded walk does not raise the floor.** | 15 |
| D13 | **Only the floor's own commit aged out.** | 15 |
| D14 | **Recovery fails, then lands.** | 15 |
| D15 | **Removed behind a gap.** | 15 |
| D16 | **Fresh joiner with an entry at risk.** | 15 |
| D16a | **Lifecycle recovery.** | 15 |
| D17 | **Fresh joiner with nothing at risk.** | 15 |
| D17a | **Happy path, one rejoin.** | 13 |
| D17b | **Stale responder.** | 13 |
| D17c | **Policy refusal.** | 13 |
| D17d | **Confirmation lost.** | 13 |
| D17e | **Forged verdicts.** | 13 |
| D17f | **Simultaneous recovery.** | 13 |
| D17g | **Confirmation request before the losing attempt's catch-up.** | 13 |
| D17h | **Lost verdict, retransmitted.** | 13 |
| D17i | **Invalid verdict first.** | 13 |
| D17j | **Copied request, other position.** | 13 |
| D18 | F1 is at risk, then F2 is dispatched after catch-up. | 15 |
| D19 | **Same-epoch at-risk replacement.** | 15 |
| D20 | **Concurrent dispatch, delayed first insert.** | 14 |
| D21 | **Rejected insert.** | 14 |
| D22 | **Simultaneous calls at the cap.** | 14 |
| D23 | **Adoption callback awaiting dispatch.** | 14 |
| D24 | **Delayed put.** | 15 |
| D25 | **Failed probe, failed write and failed remove** | 15 |
| D26 | **Publish fails after the prepared write.** | 15 |
| D27 | **Backpressure.** | 14 |
| D28 | **Crash after an at-risk publish.** | 15 |
| D29 | **Crash before publish.** | 15 |
| D30 | **Crash between probe and publish.** | 15 |
| D31 | **Crash before anchor save.** | 16 |
| D32 | **Rotation record, advance not landed.** | 16 |
| D33 | **Throwing adoption, then another advance.** | 16 |
| D33a | **Persisted, not adopted, then restart.** | 16 |
| D33b | **Secret gone.** | 16 |
| D33d | **Rejected external commit, then an ordinary commit.** | 16 |
| D33c | **Membership returns to the original roster.** | 16 |
| D34 | **Removed sender.** | 15 |
| D35 | **Removed member.** | 15 |
| D36 | **Lapsed sender.** | 14 |
| D36a | **Revoke hold.** | 17 |
| D36b | **Entry bound.** | 14 |
| D37 | **Lapse after enqueue.** | 15 |
| D37a | **`drainedWaitsForInFlightJournalPut`.** | 11 |
| D37b | **`drainedWaitsForAbandonedPortPromise`.** | 11 |
| D37c | **`drainedWaitsForReturnedRecoveryAdoption`.** | 11 |
| D37d | **`portCallAfterDisposeRejects`.** | 11 |
| D37e | **`drainedResolvesWithParkedWireReceive`** | 11 |
| D37f | **`drainedBeforeDisposeRejects`.** | 11 |
| D38 | **Mux hand-off.** | 18 |
| D39 | **Delayed hub subscription.** | 18 |
| D40 | **Bounds pinned.** | 18 |
| D41 | **Conformance clauses** | 19 |
| D42 | **Gap clause (clause 4), `testHubStoreConformance`** | 19 |
| D43 | **Gap clause, `testLogHubConformance`** | 19 |
| D44 | **App lane notice.** | 20 |
| D45 | **Gap crosses the wire** | 19 |


**Unplaced spec requirements:** None.
**Unplaced spec tests:** None. L has 42 numbered tests; D includes all numbered and lettered cases (including its printed 33d-before-33c ordering).

## Citation audit and self-review

All implementation file:line citations identify the current checkout, not future line positions. Newly created files deliberately have no line citation.
Kokuin `createCapability:43`, `assertValidDelegation:107`, `checkCapability:275`, `foldLog:482` and `getVerifier:27` were inspected.
ts-mls callback-before-path, removed-receiver early return, empty-commit path and historical receiver storage were inspected in installed rc.13.

**Spec citation correction found:** D§5's `handleLedgerRequest` citation `packages/rpc/src/peer.ts:1312` points to a comment terminator. The declaration is `packages/rpc/src/peer.ts:1313`; the spec now cites it.
No other wrong citation was found in the inspected material. External kubun citations were not independently verified and are not used as implementation file:line references here.

Self-review completed against both specs:

- Coverage: every design section, error/outcome, Release and consumer obligation has a task or an explicit downstream handoff.
- Steps: checkbox actions have named tests/assertions, concrete signatures, verification commands and reviewable deliverables. No implementation bodies are prescribed.
- Types: MLS epoch stays bigint; RPC snapshots/results use number. Refusal union is identical across packages without an upward MLS dependency.
- Interfaces: later peer/journal/recovery tasks consume earlier snapshots, proof results and pending contracts. No retired transfer/staging API is reintroduced.
- Review Focus: all five additional failure modes are assigned tests in their owning tasks.
- Proportion: signatures and test guarantees describe the decisions; bodies remain the implementer's work.
- Feasibility: cross-layer spec tests explicitly keep one owner and finish their dependent integration assertions at phase exit.
- Planning scope: no code, dependency or release changes were performed. Only this plan was written.

## Decision log

- **2026-10-04 -- Accepted:** One kumiai branch/release; ordered phases 0-3; native execution; patch releases and no anchor version bump.
- **2026-10-04 -- Accepted:** Mixed format. Horizon sizing (Task 5) and the host-boundary wrapper (Task 11) require probe → show → discuss → record. No autonomous chaining past either discussion.
- **2026-10-04 -- Sequencing:** Lifecycle recovery interfaces precede verdict sealing/orchestration. Gap-capable doubles precede delivery tests; Phase 3 owns the production gap protocol/store and full hub conformance. Cross-layer tests retain one owner and are rerun after dependencies exist.
- **2026-10-04 -- Task 5 decided:** `HISTORY_HORIZON = 393,216` stays a fixed constant (no per-group anchor field). Measured with real kokuin events, tokens, MLS and HPKE (two-leaf groups): at the horizon the tightest frame is the sealed GroupInfo reply with an all-proof history plus 64 KiB consumer data, 825,008 of 1,048,576 base64 chars (223,568 margin, 21%); commit and invite are within 6 KiB of it. Largest fitting history: ~518 KB (proofs + 64 KiB consumer), ~585 KB (proofs only), ~780 KB (tree prefixes only). Confirmed: `[icp, reset]` 913 B, 864 rotations / 926 mixed events fit, 10x50 mixed = 211,730 B. Contradicted: proof history expands ~1.35x inside ledger tokens, not 4/3 (headers, signatures, claims); spec text corrected, no behaviour change. Learned: consumer entries remain the only unbounded frame input (about 160 KB extra on top of a full proof history would overflow, extrapolated); Welcome+ledger and GroupInfo-reply encodings are provisional, Task 10 re-measures against the final helper; verdict size is estimated.
- **Task 11 -- Awaiting probe decision:** Record date, invocation-category traces, race/settlement evidence, user decision, spec impact and learned constraints.
