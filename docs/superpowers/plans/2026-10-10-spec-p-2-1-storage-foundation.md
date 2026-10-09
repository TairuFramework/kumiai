# Spec P Phase 2.1 Storage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build lossless MLS v2 codecs and a sealed, transactional memory storage foundation with reusable storage conformance.

**Architecture:** `mls` owns client-state encoding, and `mls-rpc` owns recovery encoding and persistence contracts above MLS and RPC. Memory providers share group/device ownership, transaction completion and sealed records. Structural conformance lives in `rpc-conformance`; registry and peer integration follow in subsequent plans.

**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, existing XChaCha20-Poly1305, Web Crypto, Biome.

**Spec:** [docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md](../specs/2026-10-08-spec-p-transactional-persistence.md), r16. Approved and binding despite its historical `draft r16` status text.

- **2.1** -- Storage foundation: v2 codecs, sealed group/device memory providers, fixtures and storage conformance.
- **2.2** -- Control: P2a amendments, incarnation lifecycle, durable fork halt, manual recovery, commit-once, first-valid adoption and captureHead resync.
- **2.3** -- Runtime: registry adapters, fair batching, handler policies, atomic Welcome burn, restore processing, leases/rotation and settlements/events.
- **2.4** -- Edge: hub-client lifts, MLSEncryptor, complete real/double contract gates and real-HTTP two-device smoke with injected server DID.

## Global Constraints

- “pnpm only.” Run scripts as `rtk proxy pnpm run <script>` and package scripts as `rtk proxy pnpm --filter <package> run <script>`.
- Vitest strips types. Pair every Vitest run, including red and mutation runs, with the package's `test:types`.
- Before tests import changed sibling exports, run `rtk proxy pnpm turbo run build:js build:types`; imports resolve through generated package barrels.
- Any breaking type change requires `rtk proxy pnpm turbo run test:types`, without `--filter`.
- A test double may be stricter than its port, never more permissive.
- “Changing a port means running **both** contract suites against the real implementation and the doubles”. See `docs/agents/architecture.md:21-24`.
- “Do not edit generated files (`lib/`).” Build scripts may regenerate them; never hand-edit or stage generated output.
- “Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as published `^` ranges, never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.”
- “All dev tooling and shared configs come from `@kigu/dev`.” Preserve package scripts and tooling configuration.
- Record release intents through `rtk proxy pnpm change`, using `.changeset/` files. Releases use pnpm's versioning, not `@changesets/cli`.
- “twelve packages share one version band (same minor pre-1.0, same major from 1.0); raising it is a group act, but a patch release within the band is not.” The current tree contains fourteen published manifests; Task 9 names all fourteen.
- For test-quality-critical guards, break the guard, confirm its test fails, restore it, then rerun the paired checks.
- Lint before every staging step: `rtk proxy pnpm run lint`.
- “Every factory requires host `AtRestCodec.seal/open(bytes, aad)`.” Host owns at-rest keys; kumiai stores none.
- “Memory persists sealed bytes without a plaintext shadow map.” Clear keys, revisions, locks and mutation markers carry no payload.
- “AAD is UTF-8 JSON of `['kumiai/at-rest/v1', groupID, incarnationOrNull, namespace, recordID]`”.
- “Device-scoped records use ownerDID, null incarnation, distinct namespaces and sourceID/ref or work ID”.
- “Expected null means absent lifetime, never a tombstone.” Lifetime revisions advance per transition; state versions advance per state/metadata change.
- “Stores are group-bound and expire with the callback.” Transaction-bound methods never acquire another gate or start another transaction.
- “Receipt-bearing refs can never regain private records.” Ordinary and retained last-resort private keys share the group provider and loss boundary.
- “signerTree contains public nodes only, never retained private ratchets.” Retained trust and spent authenticators survive tombstones and deletion.
- “Refuse every v1 blob: absence and lost zero are indistinguishable.” Recovery candidates also refuse v1.
- “Retry barrier/read failures from 100 ms doubling to 15 s, outside transactions; other groups continue.”
- “Phase 2 creates no client/messaging/MessageStore/Hozon provider/child driver; use opaque side rows for handler/status conformance.”

## Review Focus

- A non-zero-offset byte view and malformed UTF-8 sidecar must neither alias secrets nor repair the wrong proposal. Pin in Task 1.
- Callback failure, reentrancy and throwing hooks must settle ownership without rolling back another group's committed rows. Pin in Task 4.
- Null/corrupt state with readable trust must preserve recovery metadata; absent/corrupt trust must never become an empty spent set. Pin in Tasks 5 and 8.
- Delimiter collisions and numeric positions `2`/`10` must preserve record identity, topic isolation and storage ordering. Pin in Task 6.
- Throwing mutation callbacks, missing ciphertext keys and physical duplicates must expose no partial corruption or cached plaintext. Pin in Task 8.

## Phase-2 ownership

Each item in Spec P's “Phase split” phase-2 row (`:993`) has one delivery owner below. Storage prerequisites do not claim runtime delivery.

| Phase-2 item | Sole plan | Delivery boundary |
| --- | --- | --- |
| MLS client-state v2 codec | 2.1 | Task 1, including sender-zero backlog |
| Recovery candidate v2 codec | 2.1 | Task 2; recovery reply v2 belongs to captureHead below |
| Memory group coordinator | 2.1 | Tasks 3-6; all group namespaces and completion barriers |
| Registry | 2.3 | Cold access, restored handles, snapshots and concrete adapters |
| Incarnations and spent admission | 2.2 | Lifecycle switch/readmission and admission decisions; records and storage guards supplied by 2.1 |
| Durable fork halt | 2.2 | Durable evidence, hold and replayable safety event |
| Manual recovery | 2.2 | Durable authorisation and selected target/successor |
| Automatic stranded resync with authenticated captureHead | 2.2 | Reply v2, trust-based request/authentication, head reconciliation and confirmed switch |
| Commit-once runner and first-valid adoption | 2.2 | Exact saved build and full-prefix acceptance proof |
| Fair adaptive batching | 2.3 | 64 frames, 2 ms, 8 ms, independent groups and three-batch fairness |
| Handler metadata and policies | 2.3 | Registration, completion, replay, authenticated metadata and terminal opened drain |
| DevicePersistence | 2.1 | Task 7; shared provider, ordinary/last-resort stores and cleanup/restore record CRUD |
| Package adapters | 2.3 | Registered participants, provisioning/rotation and external cleanup adapters; 2.1 supplies storage facades |
| Atomic Welcome burn | 2.3 | Prepared Welcome installation consumes package/receipt in the group/device transaction |
| Retained recovery trust | 2.1 | Task 5; public tree, immutable anchor and retained spent set |
| Durable restore-work | 2.3 | Declaration/startup processing and durable stage transitions; Task 7 supplies record storage |
| Application leases and rotation | 2.3 | 16-generation lease, renewal below 4, ceiling 500, retention at least 1000 |
| Encrypted namespaces | 2.1 | Tasks 3, 5-8; every stored value and every physical copy |
| Durable settlements and events | 2.3 | Certification, effects, publication/failure finalisers and replay; 2.1 supplies sealed meta rows |
| Mutation, side-row and fault fixtures | 2.1 | Tasks 4 and 8; extension to runtime fixtures belongs to 2.3 |
| Hub-client lifts | 2.4 | HTTP/scoped/buffered views, backoff and retention-preserving reconnect |
| mls-rpc encryptor | 2.4 | Registry-backed MLSEncryptor and tunnel lifecycle |
| Both contract suites on real MLS and doubles | 2.4 | Final complete phase-2 gate; every earlier plan also runs its affected contracts |
| Real HTTP smoke with injected DID | 2.4 | Two devices, real registry/MLS and HTTP; no automatic `/info` integration |

## Placement and contract decisions

The umbrella's package layout (`:142-166`) puts registry/state work in `mls-rpc` and introduces `rpc-store` only for phase 3. `mls-rpc/src/index.ts:6-17` explains the dependency boundary: neither `mls` nor `rpc` imports the other. Persistence types and providers therefore live in `mls-rpc`, with one added `@kumiai/mls-hub: workspace:^` dependency for existing package-store ports.

Memory factories use a new `@kumiai/mls-rpc/testing` export. Its Node-only async ownership context enforces reentrancy without introducing Node imports into the production barrel. The root barrel exports persistence types and errors only. Task 8 adds structural mirrors and storage conformance to `rpc-conformance`, following its existing `control-store.ts:1-60` pattern.

Copy normative types from Spec P “Group persistence and transactions” (`:413-475`), “Device persistence and retained trust” (`:484-509`), and “Factories” (`:791-858`). Task 3 also defines the storage value types listed below. Existing P2a `ControlSnapshot`, `ControlChanges`, `ControlStore`, `AnchorSlot`, `AnchorStore` and `AppCursorStore` remain imported from `@kumiai/rpc`. Plans 2.2/2.3 own their amendments; this plan preserves their existing fields.

Storage outbox/frame/meta types use Spec P's exact signatures in `mls-rpc/persistence-types.ts`, including the complete `AppOutbox` surface. They do not substitute the narrower current RPC types. Plan 2.3 promotes those signatures into RPC and wires the peer. This plan tests storage CAS and record operations, without publication proof production or runtime scheduling.

The phase-2.1 suite is named `testGroupStorageConformance`, with `PersistenceFixture<StorageTestPorts<TTx>>`. The full normative `testGroupPersistenceConformance` and `PersistenceTestPorts<TTx>` require registry/safety/crypto adapters and belong to 2.3. No synthetic registry or fabricated lost-state handle satisfies those ports in 2.1.

Unspecified storage choices are pinned here: initial state version/revision is `1`; supplied state versions are proposed next versions. Explicit saves require `previous.version + 1`; namespace-only mutations increment the affected existing state's version once. Each group transition advances lifetime revision once, stamps its mutationID and validates any supplied lifetime revision against that result. Malformed v2 input returns `undefined`; unsupported versions throw. These choices preserve the published signatures and D5/D7 invariants.

Physical group keys are `JSON.stringify([groupID, incarnationOrNull, recordID])` within a namespace map. Device keys substitute ownerDID and null incarnation. Fixed slots use recordID `'current'`. Cursor IDs are lowercase SHA-256 hex of UTF-8 topicID, while sealed cursor values include `{topicID, position}`. Settlement/event IDs are JSON tagged tuples `['settlement', seq]` / `['event', id]`. Package/receipt IDs are JSON `[sourceID, ref]`; cleanup/restore IDs are their stable row/work IDs. Logical namespace names are `lifetime`, `trust`, `state`, `control`, `anchor`, `pending`, `poison`, `cursor`, `outbox`, `meta`, `device-package`, `device-last-resort`, `device-receipt`, `device-cleanup`, `device-restore`.

Modification ranges below refer to the branch before execution. Locate the named declaration after earlier tasks shift lines.

Test-record vocabulary: groupID `'group-A'`, incarnation `1`, epoch `3`, senderHWM `16`, outbox seq `7`, frame IDs `'frame-1'`/`'frame-2'`, and topicID `'topic-secret'`. Use actual fixture credentials/authenticators. `pending` has protocol `'chat'`, procedure `'posted'`, segment `3`, position `'2'` and JSON frame idempotency key from D3. `entry` has protocol `'chat'`, prc `'posted'`, data UTF-8 `'plaintext-sentinel'`, status `'accepted'`, lastAttempt null. `anchor` has epoch `3` and a 32-byte secret filled with `97`. `obligation` is `{sequenceID: '10', attemptID: 'publish-1', topicID, outcome: 'published'}`. `event` is the Spec P accepted event with ID `'event-1'` and this entry. `outcome` is `{id: 'operation-1', opID: 'operation-1', at: 1000, kind: 'unknown'}`. Local setups supply these typed records explicitly; store assertions execute within their callback lifetime.

---

### Task 1: Lossless version-2 MLS client-state codec

**Files:** Modify `packages/mls/src/codec.ts:12-54`; Modify/Test `packages/mls/test/codec.test.ts:1-91`.

**Interfaces:**
- Consumes: ts-mls `clientStateEncoder`, `clientStateDecoder`, `encode`, and `ClientState['unappliedProposals']`.
- Produces: unchanged `encodeClientState(state: ClientState): Uint8Array` and `decodeClientState(encoded: Uint8Array): ClientState | undefined`.
- Test-local helper: `frameV2(body: Uint8Array, refs: Array<Uint8Array>, trailing?: Uint8Array): Uint8Array` writes D5's framing literally.

- [ ] Write `preserves zero one and absent senders through v2 and a sliced byte view` using a real genesis state.

```ts
const proposal: ClientState['unappliedProposals'][string]['proposal'] = { proposalType: defaultProposalTypes.remove, remove: { removed: 0 } }
state.unappliedProposals = {
  'AA==': { proposal, senderLeafIndex: 0 },
  'AQ==': { proposal, senderLeafIndex: 1 },
  'Ag==': { proposal, senderLeafIndex: undefined },
}
const bytes = encodeClientState(state)
const decoded = decodeClientState(bytes)
expect(decoded!.unappliedProposals['AA==']!.senderLeafIndex).toBe(0)
expect(Object.values(decoded!.unappliedProposals).map((p) => p.senderLeafIndex)).toEqual([0, 1, undefined])
expect(bytes[0]).toBe(2)
expect(decodeClientState(new Uint8Array([99, ...bytes, 99]).subarray(1, bytes.length + 1))).toEqual(decoded)
decoded!.keySchedule.exporterSecret.fill(0)
expect(decodeClientState(bytes)!.keySchedule.exporterSecret).toEqual(state.keySchedule.exporterSecret)
```

- [ ] Write `refuses malformed zero sidecars and every v1 blob`. Build the body using ts-mls, not the new encoder.

```ts
const body = encode(clientStateEncoder, state)
for (const refs of [[utf8('AA=='), utf8('AA==')], [utf8('Aw==')], [utf8('AQ==')], [new Uint8Array([0xc3, 0x28])]]) {
  expect(decodeClientState(frameV2(body, refs))).toBeUndefined()
}
expect(decodeClientState(frameV2(body, [], new Uint8Array([0])))).toBeUndefined()
expect(decodeClientState(new Uint8Array())).toBeUndefined()
expect(decodeClientState(new Uint8Array([2]))).toBeUndefined()
expect(() => decodeClientState(new Uint8Array([1, ...body]))).toThrow('unsupported client-state version 1')
expect(() => decodeClientState(new Uint8Array([3, ...body]))).toThrow('unsupported client-state version 3')
```

Define `utf8(value: string): Uint8Array` locally with TextEncoder. Add truncated u32/body/ref and oversized length cases to this table.

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls run test:unit test/codec.test.ts` and `rtk proxy pnpm --filter @kumiai/mls run test:types`. Expect FAIL: `expected undefined to be 0`, or `expected 1 to be 2`; types compile.
- [ ] Implement the two existing signatures in `codec.ts`, setting `CLIENT_STATE_VERSION = 2`.

Use big-endian `u8(2) || u32(bodyLength) || body || u32(refCount) || refs`. Sort exact zero-sender references lexicographically. Check decoder consumption, complete framing, fatal UTF-8, unique known refs and absent decoded sender before restoration. Decode a copied body. Reject unsorted references as noncanonical encoding. Do not mutate the input state. Invoke `clientStateDecoder(bodyCopy, 0)` to verify consumed length explicitly.

- [ ] Audit transitive `optionalEncoder` uses reachable from `clientStateEncoder` in installed rc.13. Pin epoch `0n`, private-path leaf `0`, generation `0`, and empty tree-hash bytes round-trips in the existing test file.

The reachable optional values are proposal sender numbers, tree-node objects and tree-hash byte arrays. Objects and empty Uint8Arrays are truthy; numeric epoch/path/generation encoders are unconditional. Add no additional sidecar.

- [ ] Run the paired MLS checks above. Expect PASS, including updated existing version assertions and the non-alias test.
- [ ] Remove zero restoration temporarily, run the same paired checks, expect the zero-sender assertion to fail, then restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/mls/src/codec.ts packages/mls/test/codec.test.ts
git commit -m "fix(mls): preserve zero proposal senders in state codec v2"
```

### Task 2: Version-2 recovery candidate codec

**Files:** Modify `packages/mls-rpc/src/recovery-codec.ts:1-105`; Modify/Test `packages/mls-rpc/test/recovery-codec.test.ts:1-260`; Create/Test `packages/mls-rpc/test/recovery-codec-format.test.ts`.

**Interfaces:**
- Consumes: Task 1 codec signatures; existing `RecoverySnapshot` (`recovery-codec.ts:14-25`) and `BoundRecoveryCommit` from `recovery.ts`.
- Produces: unchanged `encodeRecoveryCandidate(snapshot: RecoverySnapshot, requestKey: Uint8Array): Uint8Array` and `decodeRecoveryCandidate(bytes: Uint8Array, requestKey: Uint8Array): RecoverySnapshot`.

- [ ] Write `round trips a complete sourceState with a different tree and zero one absent senders`.

```ts
const bytes = encodeRecoveryCandidate(snapshot, requestKey)
const after = decodeRecoveryCandidate(bytes, requestKey)
expect(bytes[0]).toBe(2)
expect(encodeClientState(after.state)).toEqual(encodeClientState(snapshot.state))
expect(after.sourceTree).toEqual(snapshot.sourceTree)
expect(after.sourceTree).not.toEqual(snapshot.state.ratchetTree)
expect(after.boundCommit).toEqual(snapshot.boundCommit)
expect(after.knownRegistry).toEqual(snapshot.knownRegistry)
expect(after.replyLedger).toEqual(snapshot.replyLedger)
expect(Object.values(after.state.unappliedProposals).map((p) => p.senderLeafIndex)).toEqual([0, 1, undefined])
expect(() => decodeRecoveryCandidate(new Uint8Array([1, ...bytes.subarray(1)]), requestKey)).toThrow('Unsupported recovery candidate version 1')
expect(() => decodeRecoveryCandidate(bytes, new Uint8Array(32))).toThrow()
```

Use `createRealGroup` and existing `setup()` recovery construction. Build `snapshot` from the real RecoveryCandidate's state/sourceTree/registry/commit and exact bound tuple. Parameterise empty and mixed proposal sets.

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/recovery-codec-format.test.ts test/recovery-codec.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expect FAIL: v1 output, or invalid reconstructed source tree.
- [ ] Implement the existing signatures in `recovery-codec.ts`, setting version `2` and AAD `kumiai/recovery-candidate/v2`.

Store base64 `sourceState = encodeClientState({...snapshot.state, ratchetTree: snapshot.sourceTree})`. Decode state and sourceState independently. Preserve nonce length `24`, requestKey use, canonical base64 validation, registry, holder/binding evidence and bound verdict tuple. Remove groupStateEncoder and all private-state slicing/splicing. Use fatal UTF-8 for the encrypted JSON envelope.

- [ ] Add a format assertion by decrypting the test envelope with its requestKey and v2 AAD: `sourceState` exists, `sourceTree` does not, and both state envelopes start with `2`.
- [ ] Run the paired checks above. Expect PASS, including authoritative/advisory verdict tests, wrong key and replayed acceptance tests.
- [ ] Temporarily encode sourceState without substituting snapshot.sourceTree, run the paired checks and expect the differing-tree test to fail; restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/mls-rpc/src/recovery-codec.ts packages/mls-rpc/test/recovery-codec.test.ts packages/mls-rpc/test/recovery-codec-format.test.ts
git commit -m "fix(mls-rpc): encode complete recovery source state in v2"
```

### Task 3: Persistence contracts and authenticated row encoding

**Files:** Create `packages/mls-rpc/src/persistence-types.ts`, `packages/mls-rpc/src/persistence-errors.ts`, `packages/mls-rpc/src/persistence-codec.ts`; Modify `packages/mls-rpc/src/index.ts:22-46`; Modify `packages/mls-rpc/package.json:37-44`; Create/Test `packages/mls-rpc/test/persistence-codec.test.ts`; Create `packages/mls-rpc/test/fixtures/at-rest.ts`.

**Interfaces:**
- Consumes: MLS `ClientState`, `DeviceRegistry`, `MemberCredential`, `ControllerBinding`; RPC P2a store types; mls-hub `KeyPackagePoolStore`, `LastResortStore`, `BundleSource`.
- Produces in `persistence-types.ts`: exact Spec P `GroupKey`, `EpochIdentity`, `PackageUse`, `GroupLifetime`, `GroupStateRecord`, `GroupRecoveryTrust`, `GroupTransaction`, `IncarnationStores`, `GroupStores<TTx>`, `GroupTransition`, `GroupPersistence<TTx>`, `GroupPersistencePorts`, `AtRestCodec`, `TransactionHookSettlement`, `OutcomeAwareTransactionOptions`, `GroupMutationGate`, `MemoryStoreRows`, `MemoryTransaction`, `MemoryDatabase`, `DeviceRecord`, `HubCleanupRow`, `RestoreWork`, `DeviceStores<TTx>`, `DevicePersistence<TTx>`, `TransactionalGroupEffects<TTx>`, `RawStoredRecord`, `PendingCommitFault`, and generic `PersistenceFixture<TPorts>`.
- Also produces exact Spec P storage `PreOpenAppFrameRef`, `AppFrameRef`, `PendingAppFrame`, `AppPoisonRecord`, `AppAttempt`, `AppOutboxEntry`, `AppOutbox`, `AppPublicationOutcome`, `AppSettlementObligation`, `AppSettlementExpected`, `AppSettlementResult`, `AppStatusEvent`, `GroupForkEvidence`, `ForkHalt`, `GroupSafetyEvent`, `RecoveryUnavailableEvent`, `PersistenceEvent`. Preserve every discriminant and field from `:553-578`, `:667-677`, `:721-755`.

The signatures used by subsequent tasks are:

```ts
type AtRestCodec = { seal(plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>; open(ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> }
type GroupTransaction = { providerID: string; groupID: string | null; onCommit(fn: () => void): void; onRollback(fn: () => void): void }
type GroupTransition = { groupID: string; mutationID: string; expected: { revision: number; activeIncarnation: number | null } | null }
type GroupPersistence<TTx extends GroupTransaction> = {
  load(groupID: string): Promise<GroupLifetime | null>
  loadState(key: GroupKey): Promise<GroupStateRecord | null>
  loadTrust(groupID: string): Promise<GroupRecoveryTrust | null>
  list(): Promise<Array<GroupLifetime>>
  ports(key: GroupKey): GroupPersistencePorts
  transition<TValue>(change: GroupTransition, work: (stores: GroupStores<TTx>) => Promise<TValue>): Promise<TValue>
  resolve(groupID: string, mutationID: string): Promise<'committed' | 'rolled-back'>
}
type DevicePersistence<TTx extends GroupTransaction> = {
  providerID: string; ownerDID: string; groups: GroupPersistence<TTx>
  load(): Promise<DeviceRecord>
  transition<TValue>(change: { mutationID: string; expectedRevision: number; group: GroupTransition | null }, work: (stores: DeviceStores<TTx>) => Promise<TValue>): Promise<TValue>
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
}
type StoredAddress = { groupID: string; incarnation: number | null; namespace: string; recordID: string }
function recordAAD(address: StoredAddress): Uint8Array
function physicalRecordKey(address: StoredAddress): string
function topicLocator(topicID: string): Promise<string>
function encodeStoredValue(value: unknown): Uint8Array
function decodeStoredValue(bytes: Uint8Array): unknown
function sealRecord(codec: AtRestCodec, address: StoredAddress, value: unknown): Promise<Uint8Array>
function openRecord(codec: AtRestCodec, address: StoredAddress, bytes: Uint8Array): Promise<unknown>
function createDeterministicAtRestCodec(params: { key: Uint8Array }): AtRestCodec // test fixture only
```

- [ ] Write `binds sealed records to all address components and round trips nested MLS values`.

```ts
expect(new TextDecoder().decode(recordAAD(address))).toBe('["kumiai/at-rest/v1","group-A",1,"pending","frame-1"]')
const bytes = await sealRecord(codec, address, { data: new Uint8Array([0, 1]), n: 0n, map: new Map([['leaf', 0]]) })
expect(await openRecord(codec, address, bytes)).toEqual({ data: new Uint8Array([0, 1]), n: 0n, map: new Map([['leaf', 0]]) })
for (const wrong of [{ ...address, groupID: 'group-B' }, { ...address, incarnation: 2 }, { ...address, namespace: 'outbox' }, { ...address, recordID: 'frame-2' }]) {
  await expect(openRecord(codec, wrong, bytes)).rejects.toThrow()
}
expect(await sealRecord(codec, address, { n: 0 })).toEqual(await sealRecord(codec, address, { n: 0 }))
expect(await topicLocator('topic-secret')).toMatch(/^[0-9a-f]{64}$/)
```

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/persistence-codec.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expect FAIL: missing persistence-codec export; types report missing declarations.
- [ ] Implement the listed declarations in their named files and add the mls-hub dependency through `rtk proxy pnpm --filter @kumiai/mls-rpc add '@kumiai/mls-hub@workspace:^'`.

Encode unknown values as recursively tagged JSON nodes, distinguishing object/array/bytes/bigint/Map/scalar/undefined. Encode objects as entry arrays, so a user key named `$type` cannot collide with tags. Decode fatal UTF-8 and reject malformed tags. Store only sealed output; copy input/output bytes. Use `encodeDeviceRegistry`/`decodeDeviceRegistry` at trust serialization boundaries rather than dropping registry Maps.

Test codec: AES-GCM with injected 32-byte key, 12-byte nonce from SHA-256 of length-prefixed AAD/plaintext, and AAD authentication. Prefix the nonce to ciphertext. It is test-only and never exported from the production barrel.

Produce spec error classes `GroupStateConflictError`, `GroupStateUncertainError`, `DisplacedGroupHandleError`, `OutboxReplacementError`, `InvalidAppEntryError`, `NonRootProviderError`, with matching `name` and `(message?: string, options?: ErrorOptions)`. Re-export canonical RPC `StorageOutcomeUnknownError` and `GroupControlUnsettledError`.

- [ ] Run the paired checks above and `rtk proxy pnpm turbo run test:types`. Expect PASS and structural type declarations without dependency cycles.
- [ ] Temporarily omit incarnation from AAD, run the paired checks and expect wrong-incarnation rejection to fail; restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/mls-rpc/src/persistence-types.ts packages/mls-rpc/src/persistence-errors.ts packages/mls-rpc/src/persistence-codec.ts packages/mls-rpc/src/index.ts packages/mls-rpc/package.json packages/mls-rpc/test/persistence-codec.test.ts packages/mls-rpc/test/fixtures/at-rest.ts pnpm-lock.yaml
git commit -m "feat(mls-rpc): define sealed group and device persistence contracts"
```

### Task 4: Scoped memory transactions and completion barriers

**Files:** Create `packages/mls-rpc/src/memory-transaction.ts`, `packages/mls-rpc/src/memory-faults.ts`, `packages/mls-rpc/src/testing.ts`; Modify `packages/mls-rpc/package.json:19-21`; Create/Test `packages/mls-rpc/test/memory-transaction.test.ts`.

**Interfaces:**
- Consumes: Task 3 `MemoryDatabase`, `MemoryTransaction`, `GroupMutationGate`, `OutcomeAwareTransactionOptions`, `TransactionHookSettlement`, `PendingCommitFault`.
- Produces:

```ts
function createMemoryTransaction(params: { rows: MemoryStoreRows }): MemoryDatabase
type MemoryFaultController = {
  failNext(point: 'after-first-write' | 'before-commit' | 'status-read'): void
  commitThenReject(): void
  rejectCommitPending(): PendingCommitFault
}
function memoryFaults(db: MemoryDatabase): MemoryFaultController
// MemoryDatabase methods retain the exact Spec P signatures:
// transact<TValue>(scope: {groupID: string | null; devicePackages: boolean}, fn: (tx: MemoryTransaction) => Promise<TValue>, options?: OutcomeAwareTransactionOptions): Promise<TValue>
// completionBarrier(scope: {groupID: string | null; devicePackages: boolean}): Promise<void>
// snapshot(): MemoryStoreRows
```

- [ ] Write `isolates groups and rejects nested root work without losing a concurrent commit`.

```ts
const db = createMemoryTransaction({ rows: {} })
const first = db.transact({ groupID: 'A', devicePackages: false }, async (tx) => {
  await expect(db.transact({ groupID: 'A', devicePackages: false }, async () => 1)).rejects.toThrow('reentrant')
  await pause.promise
  tx.rows.state!.set(JSON.stringify(['A', 1, 'current']), sealedA)
})
await db.transact({ groupID: 'B', devicePackages: false }, async (tx) => {
  tx.rows.state!.set(JSON.stringify(['B', 1, 'current']), sealedB)
})
pause.resolve()
await first
expect(db.snapshot().state!.size).toBe(2)
```

Define a local `deferred(): {promise: Promise<void>; resolve(): void}`. Initialise declared namespace maps on the transaction view. Parameterise same-group queued calls, synchronous/asynchronous nested calls and rejected out-of-scope keys.

- [ ] Write `retains private writes and hooks until late completion proof`, parameterised over `'commit'` / `'rollback'`.

```ts
const fault = memoryFaults(db).rejectCommitPending()
const hooks: Array<string> = []
let settlement: TransactionHookSettlement | undefined
const result = db.transact(scope, async (tx) => {
  tx.onCommit(() => { hooks.push('commit') })
  tx.onRollback(() => { hooks.push('rollback') })
  tx.rows.state!.set(key, sealedA)
}, { onUnknown: (value) => { settlement = value } })
await fault.rejected
await expect(result).rejects.toMatchObject({name: 'StorageOutcomeUnknownError'})
expect(db.snapshot().state?.get(key)).toBeUndefined()
expect(hooks).toEqual([])
const barrier = db.completionBarrier(scope)
await fault.barrierWaiting
await fault.finish(outcome)
await barrier
settlement!.settle(outcome === 'commit' ? 'committed' : 'rolled-back')
settlement!.settle(outcome === 'commit' ? 'committed' : 'rolled-back')
expect(hooks).toEqual([outcome])
expect(db.snapshot().state?.get(key)).toEqual(outcome === 'commit' ? sealedA : undefined)
```

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/memory-transaction.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expect FAIL: missing memory factory.
- [ ] Implement the listed memory functions in their named files; export them only from `testing.ts` and package subpath `./testing`.

Use two barrel lines: one for `createMemoryTransaction`, one for `memoryFaults`/`MemoryFaultController`. This pins subsequent modification ranges.

Use per-group FIFO queues and a separate device-package queue, acquired device-first then group. Node AsyncLocalStorage detects nested root work and callback-bound stores after expiry. Clone only declared scope and supplied side rows. Merge only touched scope at commit, preserving other groups. Reject writes to unrelated rows. No global transaction queue.

Unknown faults retain private rows and backend owner locks after rejection. `finish` selects backend commit/rollback and releases backend locks, not coordinator gates or hook queues. The barrier takes those backend locks in fresh root work; marker proof then settles exactly one hook queue. Repeated same outcome is harmless and contradiction throws ownership conflict. Contain each hook exception and finish remaining hooks. Known outcomes finish their hook queue before return/rejection. Snapshots always copy committed rows. Coordinator gates remain held until proof and settlement.

`after-first-write` means the first transaction row mutation, including owner markers. Test provider-level namespace atomicity additionally with a thrown error after the first domain write. Barrier/status-read faults retain ownership and retry outside transactions at `100, 200, 400, ... 15000` ms.

- [ ] Write `contains throwing hooks and releases only the completed owner` with these assertions.

```ts
await expect(db.transact(scope, async (tx) => {
  tx.onRollback(() => { throw new Error('hook failed') })
  tx.onRollback(() => { hooks.push('rollback-after-throw') })
  throw new Error('callback failed')
})).rejects.toThrow('callback failed')
expect(hooks).toEqual(['rollback-after-throw'])
expect(db.snapshot()).toEqual(before)
```

Parameterise expired tx writes, pending rollback, device-first lock order and group B progress during A ambiguity in this test file.
- [ ] Run the paired checks above and repo-wide type checks. Expect PASS; no test requires a global mutex or plaintext snapshot.
- [ ] Release A's owner lock on unknown temporarily, run the paired checks and expect the queued-A barrier test to fail; restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/mls-rpc/src/memory-transaction.ts packages/mls-rpc/src/memory-faults.ts packages/mls-rpc/src/testing.ts packages/mls-rpc/package.json packages/mls-rpc/test/memory-transaction.test.ts
git commit -m "feat(mls-rpc): add scoped outcome-aware memory transactions"
```

### Task 5: Group state guards and retained recovery-trust stores

**Files:** Create `packages/mls-rpc/src/memory-group-state.ts`, `packages/mls-rpc/src/persistence-guards.ts`; Create/Test `packages/mls-rpc/test/group-state-persistence.test.ts`; Create `packages/mls-rpc/test/fixtures/storage-seed.ts`.

**Interfaces:**
- Consumes: Tasks 1/3/4; exact lifetime/trust/state member signatures from `GroupStores<MemoryTransaction>` and `IncarnationStores`.
- Produces `GroupStateStores = Pick<GroupStores<MemoryTransaction>, 'tx' | 'lifetime' | 'trust'> & {state(incarnation: number): IncarnationStores['state']}` and `createGroupStateStores(params: {tx: MemoryTransaction; groupID: string; atRest: AtRestCodec}): GroupStateStores`.
- Produces `assertStateTransition(previous: GroupStateRecord | null, next: GroupStateRecord, trust: GroupRecoveryTrust | null): void` and `assertTrustTransition(previous: GroupRecoveryTrust | null, next: GroupRecoveryTrust): void`.
- Test helpers: `StorageSeed = {key: GroupKey; lifetime: GroupLifetime; state: GroupStateRecord & {deleted: false}; trust: GroupRecoveryTrust}`; `makeStorageSeed(params: {id: string; incarnation: number; epoch: number; mode: 'real-mls' | 'double'}): Promise<StorageSeed>`; `installSeed(groups: GroupPersistence<MemoryTransaction>, seed: StorageSeed, mutationID: string): Promise<void>`; `nextChange(groups: GroupPersistence<MemoryTransaction>, groupID: string, mutationID: string): Promise<GroupTransition>`.

- [ ] Write `rejects version and identity regression without spending an authenticator` against guards and transaction-bound row stores.

```ts
for (const candidate of [{...seed.state, version: 1}, {...seed.state, version: 2, epoch: 2}, {...seed.state, version: 2, epochAuthenticator: otherAuthenticator}, {...seed.state, version: 2, senderHWM: seed.state.senderHWM - 1}]) {
  expect(() => assertStateTransition(seed.state, candidate, seed.trust)).toThrow(GroupStateConflictError)
}
expect(seed.trust.spentEpochAuthenticators).toEqual([seed.state.epochAuthenticator])
await db.transact(scope, async (tx) => {
  const stores = createGroupStateStores({tx, groupID, atRest: codec})
  await stores.state(1).save(seed.state)
  await stores.trust.save(seed.trust)
  expect(await stores.state(1).load()).toEqual(seed.state)
})
```

Generate `seed` at epoch `3` and HWM `16`. The real mode advances actual MLS state to the requested epoch. The double builds serialized storage values, never a GroupHandle.

- [ ] Write `retains trust above tombstones and refuses absent or unreadable trust` (Review Focus).

```ts
await db.transact(scope, async (tx) => {
  const stores = createGroupStateStores({tx, groupID, atRest: codec})
  await stores.state(1).save({...seed.key, version: 2, deleted: true})
  expect((await stores.trust.load())!.genesisAnchor).toEqual(seed.trust.genesisAnchor)
})
expect(() => assertStateTransition(seed.state, {...seed.state, version: 2, epoch: 4}, null)).toThrow(GroupStateConflictError)
expect(() => assertTrustTransition(seed.trust, {...seed.trust, spentEpochAuthenticators: []})).toThrow(GroupStateConflictError)
```

Add a separate null-state save and assert trust still loads. Task 8 owns ciphertext-corruption integration assertions using these exact row stores.

```ts
await stores.state(1).save({...seed.state, version: 2, state: null})
expect(await stores.trust.load()).toEqual(seed.trust)
expect(() => assertStateTransition(null, {...seed.state, incarnation: 2, version: 1}, seed.trust)).toThrow(GroupStateConflictError)
const copy = (await stores.trust.load())!
copy.spentEpochAuthenticators[0]!.fill(0)
expect((await stores.trust.load())!.spentEpochAuthenticators).toEqual(seed.trust.spentEpochAuthenticators)
```

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/group-state-persistence.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expect FAIL: missing guards/state-store factory.
- [ ] Implement the listed signatures in their named files with callback-bound sealed stores. Task 6 owns the complete group coordinator.

State guards require initial version `1` or the previous version plus `1`. Within one incarnation refuse lower epochs, changed same-epoch authenticator, senderHWM regression and consumed ratchet resurrection. Progress saves do not append/reinstall the current authenticator. Trust guards reject spent-set shrinkage and immutable-anchor replacement.

For non-null state bytes, decode v2 and require UTF-8 groupContext.groupId, numeric epoch and keySchedule.epochAuthenticator to match the record. Refuse wrong-group bytes with unchanged metadata in the guard table. Null state remains recovery metadata and exposes no handle.

For identity change, guards require readable trust and a previously unspent authenticator. Initial absent-lifetime creation may supply its first matching trust. Compare bytes, retain sorted unique defensive spent copies, forbid private signer nodes, and preserve ledger repeats and registry denial/floor Maps. Task 6 validates the final co-written installation and appends its authenticator once. Row reads never initialise missing trust.

For progress checks, compare current and matching historical secret-tree generations. Below the previous generation, next unused-key IDs must be a subset of previous unused-key IDs. Newly retained skipped keys at or above the previous generation remain valid. Refuse reintroduced consumed keys, backward generations and resurrected evicted epochs. A newly advanced epoch has fresh chains; retained matching epochs cannot regress.

- [ ] Add pinning assertions: seal-failure rollback preserves state/trust; spent A3 refuses a different incarnation; immutable anchor and defensive spent copies survive reopen.
- [ ] Run the paired checks above and repo-wide type checks. Expect PASS for real-MLS and double seeds.
- [ ] Temporarily disable spent-byte comparison, run the paired checks and expect spent A3 refusal to fail; restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/mls-rpc/src/memory-group-state.ts packages/mls-rpc/src/persistence-guards.ts packages/mls-rpc/test/group-state-persistence.test.ts packages/mls-rpc/test/fixtures/storage-seed.ts
git commit -m "feat(mls-rpc): persist incarnation state and retained recovery trust"
```

### Task 6: All group namespaces in one transition

**Files:** Create `packages/mls-rpc/src/memory-group-persistence.ts`, `packages/mls-rpc/src/memory-incarnation-stores.ts`, `packages/mls-rpc/src/memory-group-ports.ts`; Modify `packages/mls-rpc/src/testing.ts:1-2` (Task 4 factory exports); Create/Test `packages/mls-rpc/test/group-namespaces.test.ts`.

**Interfaces:**
- Consumes: Task 5 state stores/guards and Task 4 coordinator; RPC `applyChanges(snapshot: ControlSnapshot, changes: ControlChanges): ControlSnapshot` from `control/store.ts:27-67`.
- Produces `createMemoryGroupPersistence(params: {db: MemoryDatabase; atRest: AtRestCodec; providerID: string; effects?: TransactionalGroupEffects<MemoryTransaction>}): GroupPersistence<MemoryTransaction>`; Task 7 exposes it as `device.groups`.
- Produces `createIncarnationStores(params: {tx: MemoryTransaction; key: GroupKey; atRest: AtRestCodec}): IncarnationStores` and `createMemoryGroupPorts(params: {groups: GroupPersistence<MemoryTransaction>; key: GroupKey}): GroupPersistencePorts`.
- `IncarnationStores` uses the exact state/control/anchor/pending/poison/cursor/outbox/meta/clearTransport signatures in Spec P `:432-455`. Meta stores `AppSettlementObligation` and `PersistenceEvent`, without runtime certification or effects scheduling.
- Consumes Task 5 `installSeed` and `nextChange` helper signatures. Each seed save supplies the transition's actual mutationID/revision.

- [ ] Write `commits or rolls back every namespace and side effect together`.

```ts
const before = db.snapshot()
await expect(groups.transition(await nextChange(groups, groupID, 'multi-write'), async (stores) => {
  const rows = stores.incarnation(1)
  await rows.anchor.save(anchor)
  await rows.control.apply({putOutcomes: [outcome]}, 'multi-write')
  await rows.pending.put([pending])
  await rows.cursor.save(topicID, '10')
  await rows.outbox.put([entry])
  await rows.meta.putSettlement(7, obligation)
  await rows.meta.putEvents([event])
  throw new Error('after first domain write')
})).rejects.toThrow('after first domain write')
expect(db.snapshot()).toEqual(before)
```

Repeat the callback without the throw and assert every supplied row survives reconstruction. The callback's state version advances exactly once.

- [ ] Write `isolates incarnations and sorts numeric lane positions without locator collisions` (Review Focus).

```ts
expect(physicalRecordKey({...address, groupID: 'a|b', recordID: 'c'})).not.toBe(physicalRecordKey({...address, groupID: 'a', recordID: 'b|c'}))
expect((await rows.pending.list()).map((r) => r.frame.position)).toEqual(['2', '10'])
expect(await rows.cursor.load('topic-other')).toBeNull()
expect(await nextRows.anchor.load()).toBeNull()
expect((await oldRows.control.load()).applied).toHaveLength(1)
expect((await nextRows.control.load()).applied).toEqual([])
await expect(groups.ports(oldKey).outbox.put(entry)).rejects.toMatchObject({name: 'DisplacedGroupHandleError'})
```

Read `rows`, `oldRows` and `nextRows` inside one `groups.transition` callback. Test the stale facade separately after a committed incarnation switch. Create two epochs within one topic and two topics with equal positions. Sort by incarnation, frame segment (anchor epoch), then topicID, then numeric position within that topic. Topic ordering is deterministic enumeration, not receipt coverage. These variables are typed Task 3 records.

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/group-namespaces.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expect FAIL: missing incarnation stores or missing committed rows.
- [ ] Implement the listed signatures. Root facades call the group coordinator; transaction stores never nest it.

Retain a groupOwner marker, validate expected revision/active incarnation inside ownership and advance lifetime revision once. Initial incarnation is `1`; a switch installs `latestIncarnation + 1` and tombstones the active source atomically. A new incarnation may have a lower epoch and inherits no progress. Require co-written matching trust on installation and append its authenticator once. Existing lifetime with missing trust refuses installation. Namespace-only mutations bump an existing state version once. Safety-only control/event writes can proceed without opening corrupt state/trust. Matching resolve proof bypasses candidate admission, never reinstalls a candidate.

Bind providerID at the first persistence factory and reject later mismatches. Keep the application mutation gate separate from backend owner locks. Ambiguous transitions retain their callback result privately, resolve matching mutation or exact previous revision after the barrier, settle hooks, then return the result only for commit. Proven rollback throws the original write error. Unexpected markers throw ownership conflict. Barrier/read failure retries outside storage using D7's pinned backoff. `resolve` itself never runs candidate admission.

Keep control FIFO/outcomes/Welcomes and applied/response retention semantics from P2a. Control apply's mutationID must match the group transition. `lastMutation()` crosses the barrier before reading the last control-apply marker, not an unrelated group's latest write. Control-only unknown writes may throw canonical `StorageOutcomeUnknownError`; other facades await resolved commit/rollback before releasing callers.

Make byte/nested values defensive. Refuse immutable outbox protocol/procedure/data replacement. Persist raw settlement/event rows idempotently; reject conflicting settlement values. `AppOutbox.recordSettlement(seq, obligation, expected)` validates stored identity/version/attempt/topic under the acquired gate and returns the exact Spec P reason on mismatch, with no hooks or marker change. Unknown/double pending completion and event acknowledgement are no-ops. Completion removes only specified records; cursor advancement remains explicitly co-written by its runtime caller in 2.3.

Storage outbox remove co-deletes its settlement and persists the supplied original occurrence/status event and opted-in effect together. Without a matching occurrence, certified entries refuse erasure. Generate event IDs from the transition mutationID and sequence, so retries retain IDs. Runtime proof collection, automatic finalisers and event delivery remain 2.3. Check inactive writes before allocating a mutation or sequence.

`clearTransport()` retains owed outcomes/Welcomes, fork evidence and unacked events. It refuses unresolved settlement obligations until 2.3's certified finaliser consumes them. It preserves lifetime/trust/spent rows. Retired facades may read/ack/delete owed records, but cannot write new app entries, anchors, cursors or ordinary control operations. No facade follows the current incarnation implicitly.

- [ ] Add a seal-failure test after each namespace write: every failure leaves lifetime/state versions, markers and all namespace rows unchanged.
- [ ] Pin stale revision, tombstone-as-absent refusal, atomic incarnation install, one spent append and unspent lower-epoch admission as storage operations.

```ts
await expect(groups.transition({groupID, mutationID: 'stale', expected: {revision: 0, activeIncarnation: 1}}, async () => undefined)).rejects.toMatchObject({name: 'GroupStateConflictError'})
await expect(groups.transition({groupID, mutationID: 'tombstone-is-not-absent', expected: null}, async () => undefined)).rejects.toMatchObject({name: 'GroupStateConflictError'})
expect((await groups.loadTrust(groupID))!.spentEpochAuthenticators).toEqual(expectedSpent)
expect((await groups.loadState({groupID, incarnation: 1}))!.deleted).toBe(true)
expect((await groups.loadState({groupID, incarnation: 2}))!.version).toBe(1)
```
- [ ] Run the paired checks above and repo-wide type checks. Expect PASS; existing P2a control contracts remain compatible.
- [ ] Temporarily omit control from scoped rollback, run the paired checks and expect the snapshot equality assertion to fail; restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/mls-rpc/src/memory-incarnation-stores.ts packages/mls-rpc/src/memory-group-ports.ts packages/mls-rpc/src/memory-group-persistence.ts packages/mls-rpc/src/testing.ts packages/mls-rpc/test/group-namespaces.test.ts
git commit -m "feat(mls-rpc): transact all incarnation namespaces together"
```

### Task 7: DevicePersistence and co-stored package/cleanup/restore records

**Files:** Create `packages/mls-rpc/src/memory-device-persistence.ts`, `packages/mls-rpc/src/memory-package-stores.ts`; Modify `packages/mls-rpc/src/testing.ts:1-4` (prior factory exports); Create/Test `packages/mls-rpc/test/device-persistence.test.ts`.

**Interfaces:**
- Consumes: Task 3 `DevicePersistence`, `DeviceStores`, `DeviceRecord`, `HubCleanupRow`, `RestoreWork`; Tasks 4-6 coordinator and group stores; existing mls-hub store signatures (`pool-store.ts:60-68`, `store.ts:56-64`).
- Produces exact `createMemoryDevicePersistence(params: {db: MemoryDatabase; atRest: AtRestCodec; providerID: string; ownerDID: string; effects?: TransactionalGroupEffects<MemoryTransaction>}): DevicePersistence<MemoryTransaction>`.
- Produces storage-only provisioning facades `createMemoryPackageStores(params: {device: DevicePersistence<MemoryTransaction>; sourceID: string}): {ordinary: KeyPackagePoolStore; lastResort: LastResortStore}`.
- Device transaction signatures: `ordinary(sourceID: string): KeyPackagePoolStore`, `lastResort(sourceID: string): LastResortStore`, cleanup `list/put/remove`, restore `load/save`, exactly Spec P `:488-493`.

- [ ] Write `co-stores ordinary burn receipt group install cleanup and restore-work`.

```ts
await packageStores.ordinary.put(ownerDID, ordinary)
const before = await device.load()
await device.transition({mutationID: 'join', expectedRevision: before.revision, group: {groupID, mutationID: 'join', expected: null}}, async (stores) => {
  await stores.ordinary(sourceID).consume(ordinary.ref, groupID)
  await stores.cleanup.put(cleanup)
  await stores.restore.save({id: 'restore-1', stage: 'invalidate', remainingGroups: [groupID]})
  await stores.group!.lifetime.save(seed.lifetime)
  await stores.group!.incarnation(1).state.save(seed.state)
  await stores.group!.trust.save(seed.trust)
})
expect(await packageStores.ordinary.list(ownerDID)).toEqual([])
expect(await packageStores.ordinary.receipt(ordinary.ref)).toEqual({groupID})
expect((await device.load()).restoreWork).toEqual({id: 'restore-1', stage: 'invalidate', remainingGroups: [groupID]})
await expect(packageStores.ordinary.put(ownerDID, ordinary)).rejects.toThrow('consumed')
await packageStores.lastResort.consume(lastResort.ref, groupID)
expect(await packageStores.lastResort.receipt(lastResort.ref)).toBeNull()
```

This exercises transaction plumbing directly. It does not claim validated Welcome admission or restore processing.

- [ ] Write `preserves device cleanup and package exclusion across group retirement and late commit`.

```ts
const fault = memoryFaults(db).rejectCommitPending()
// Start the combined install above and a second group's consume of the same source/ref.
await fault.rejected
expect(db.snapshot()['device-receipt']?.has(receiptKey) ?? false).toBe(false)
await fault.finish('commit')
expect(await device.resolve('join')).toBe('committed')
await expect(secondInstall).rejects.toThrow('consumed')
expect(await device.groups.load(secondGroupID)).toBeNull()
// Tombstone the winner and reconstruct the device facade from the same database.
const cleanupRows = await reopenedDevice.transition({mutationID: 'read-cleanup', expectedRevision: (await reopenedDevice.load()).revision, group: null}, async (stores) => stores.cleanup.list())
expect(cleanupRows).toEqual([cleanup])
```

During ambiguity, use raw snapshot inspection for the receipt assertion; a root receipt read must wait on the device barrier. The final suite covers both late outcomes.

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/device-persistence.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expect FAIL: missing device factory.
- [ ] Implement the listed functions in their named files and export from `testing.ts`.

Bind db/providerID/ownerDID once and reject foreign reuse. Start device revision at `0`, advance once per committed device transition, and validate both group/device expected revisions for combined transitions. Use one mutationID for both retained owners. Consume under device-first ownership; recheck ref/private presence, retain irreversible receipt, reject re-put after receipt. In combined installation, a deleted private ref refuses. Device-only legacy consume may use P2a deleted-ref metadata, but never proves group admission. Last-resort consume remains no-op/reusable.

Reject missing/non-callable seal/open at group/device factory creation with TypeError. Test malformed arguments through Reflect.apply, without weakening AtRestCodec's required type.

Seal ordinary/last-resort/private/deletion metadata/receipts/cleanup/restore records with Task 3 addresses. Source and owner predicates isolate every read/write. Root facades use device transitions; transaction-bound package stores share the existing transaction. Concurrent distinct-ref puts preserve both. Cleanup outlives group deletion. Store restore-work stages literally; no invalidation, upload, retry worker or network call runs here.

Device fault proof fences both owners and holds both hook queues. A mismatched marker throws ownership conflict; raw absence proves nothing. Provider loss removes packages, receipts, trust/spent and group rows together. Reject participant identity mismatches at the storage boundary; 2.3 validates the complete registered adapter set.

- [ ] Add rollback assertions for combined group/burn/cleanup writes, stale device revision, wrong owner/source and full-provider loss with retained signing identity only.
- [ ] Run the paired checks above and repo-wide type checks. Expect PASS; group-only B remains independent when A does not hold device ownership.
- [ ] Temporarily retain ordinary privatePackage on consume, run the paired checks and expect empty ordinary list/raw-private-key checks to fail; restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/mls-rpc/src/memory-device-persistence.ts packages/mls-rpc/src/memory-package-stores.ts packages/mls-rpc/src/testing.ts packages/mls-rpc/test/device-persistence.test.ts
git commit -m "feat(mls-rpc): co-store device packages cleanup and restore work"
```

### Task 8: Mutation/raw-byte/side-row fixtures and storage conformance

**Files:** Create `packages/rpc-conformance/src/group-storage.ts`, `packages/rpc-conformance/src/device-storage.ts`, `packages/rpc-conformance/src/persistence-fixture.ts`; Modify `packages/rpc-conformance/src/index.ts:21-80`; Create `packages/mls-rpc/test/fixtures/storage-persistence.ts`; Create/Test `packages/mls-rpc/test/storage-conformance.test.ts`, `packages/mls-rpc/test/storage-fixture.test.ts`.

**Interfaces:**
- Consumes: Tasks 3-7, existing P2a structural mirrors in `rpc-conformance`; actual providers through testing export.
- Produces implementation-independent structural `Conformance*` mirrors of every consumed persistence/store/value signature, without imports from mls/mls-rpc/rpc/mls-hub.
- Produces `StorageTestPorts<TTx extends ConformanceGroupTransaction> = {device: ConformanceDevicePersistence<TTx>; packageStores(sourceID: string): {ordinary: ConformanceKeyPackagePoolStore; lastResort: ConformanceLastResortStore}}`.
- Produces `StorageConformanceParams<TTx extends ConformanceGroupTransaction> = {label: string; writeSideRow(tx: TTx, key: string, bytes: Uint8Array): Promise<void>; createFixture(id: string, effects?: ConformanceTransactionalGroupEffects<TTx>): Promise<ConformancePersistenceFixture<StorageTestPorts<TTx>>>}`.
- Produces `testGroupStorageConformance<TTx extends ConformanceGroupTransaction>(params: StorageConformanceParams<TTx>): void` and `testDeviceStorageConformance<TTx extends ConformanceGroupTransaction>(params: StorageConformanceParams<TTx>): void`.
- Implementation test fixture: `createStorageFixture(params: {id: string; mode: 'real-mls' | 'double'; effects?: TransactionalGroupEffects<MemoryTransaction>}): Promise<PersistenceFixture<StorageTestPorts<MemoryTransaction>>>`; `writeSideRow(tx: MemoryTransaction, key: string, bytes: Uint8Array): Promise<void>`.

Fixture methods retain Spec P's exact signatures: `reopen`, `failNext`, `commitThenReject`, `rejectCommitPending`, `inspectRows`, `inspectRawBytes`, `inspectSideRow`, `mutateStoredRecord`, `swapStoredRecords`, `setTime`, `advanceTime`, `close`. Mirrors use structural public tree/registry types, not unknown/any placeholders. Compile assignments in both directions against actual types, including all discriminants.

- [ ] Write `mutates only addressed ciphertext and preserves markers on missing keys or callback throws` (Review Focus).

```ts
const before = await fixture.inspectRawBytes()
await expect(fixture.mutateStoredRecord('pending', existing.key, () => { throw new Error('mutation failed') })).rejects.toThrow('mutation failed')
await expect(fixture.mutateStoredRecord('pending', 'missing', (bytes) => bytes)).rejects.toThrow('missing')
expect(await fixture.inspectRawBytes()).toEqual(before)
await fixture.swapStoredRecords('pending', first.key, second.key)
const reopened = await fixture.reopen()
await expect(reopened.device.groups.transition(change, async (stores) => stores.incarnation(1).pending.list())).rejects.toThrow()
expect((await reopened.device.groups.load(groupID))!.mutationID).toBe(previousMutationID)
```

- [ ] Write `authenticates every physical byte copy and atomically commits side rows` in the reusable suite.

```ts
for (const row of await fixture.inspectRawBytes()) {
  expect(containsBytes(row.bytes, plaintext)).toBe(false)
  expect(containsBytes(row.bytes, anchorSecret)).toBe(false)
  expect(containsBytes(row.bytes, utf8(topicID))).toBe(false)
}
expect(await fixture.inspectSideRow('effect-1')).toBeNull()
await fixture.ports.device.groups.transition(change, async (stores) => {
  await writeSideRow(stores.tx, 'effect-1', effectBytes)
  await stores.incarnation(1).pending.complete(['frame-1'])
  await stores.incarnation(1).cursor.save(topicID, '10')
})
expect(await fixture.inspectSideRow('effect-1')).toEqual(effectBytes)
```

Define `containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean` and `utf8` locally. Side rows are host-owned opaque bytes, deliberately excluded from kumiai ciphertext scans; inspection includes every physical kumiai payload copy.

- [ ] Write `corrupt state retains trust but corrupt trust refuses installation` with independent fixtures per corruption.

```ts
const lifetimeBefore = await fixture.ports.device.groups.load(groupID)
await fixture.mutateStoredRecord('state', stateRow.key, (bytes) => new Uint8Array(bytes.length))
const reopened = await fixture.reopen()
await expect(reopened.device.groups.loadState(key)).rejects.toThrow()
expect(await reopened.device.groups.loadTrust(groupID)).toEqual(seed.trust)
expect(await reopened.device.groups.load(groupID)).toEqual(lifetimeBefore)
// A separate fixture corrupts only trust and retains readable state/lifetime.
await trustFixture.mutateStoredRecord('trust', trustRow.key, (bytes) => new Uint8Array(bytes.length))
await expect((await trustFixture.reopen()).device.groups.loadTrust(groupID)).rejects.toThrow()
```

Seed every namespace before raw inspection. Assert each kumiai payload row is sealed bytes and enumerate its logical RawStoredRecord address. Faulted, retired and retained rows receive the same scan. Installation after missing/corrupt trust must reject unchanged; a safety-only event write must still commit.

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/storage-fixture.test.ts test/storage-conformance.test.ts`, `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`, and `rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types`. Expect FAIL: missing suite/fixture exports.
- [ ] Implement the named fixtures and exported suites in their named files. Reopen reconstructs facades from sealed rows and discards caches.

Physical mutation/swap preserve keys/revisions/owner markers. Validate both keys and copy bytes before mutation; a throwing callback changes nothing. Inspect raw bytes before adapter opens. Include all physical duplicates if introduced later, retaining their logical AAD. Write side rows through tx.rows under the declared owner, with no independent root store.

Transfer Tasks 4-7's storage assertions into the reusable suites: CAS/version, state/trust corruption, spent refusal, incarnation isolation, all-namespace rollback, device co-storage, receipt exclusion, restore CRUD, hook counts, completion barriers and independent groups. Preserve the local focused regression tests. Add wrong group/incarnation/namespace/record-address reopen tests for every namespace. Inject `status-read`, before-commit, commit-then-reject and pending late commit/rollback faults for initially absent owners, progress, tombstones and combined package transitions.

- [ ] Register both suites twice in `storage-conformance.test.ts`: real-MLS serialized state/registry/trust seeds and strict structural double seeds, over the shared memory providers.
- [ ] Run the paired checks above and repo-wide type checks. Expect PASS; conformance packages still have no test:unit script and require no new script.
- [ ] Temporarily skip the completion barrier and run paired checks: the raw-negative/late-commit case must fail. Restore and rerun to PASS.
- [ ] Run lint, then commit the task.

```sh
git add packages/rpc-conformance/src/group-storage.ts packages/rpc-conformance/src/device-storage.ts packages/rpc-conformance/src/persistence-fixture.ts packages/rpc-conformance/src/index.ts packages/mls-rpc/test/fixtures/storage-persistence.ts packages/mls-rpc/test/storage-conformance.test.ts packages/mls-rpc/test/storage-fixture.test.ts
git commit -m "test(rpc-conformance): pin sealed group and device storage contracts"
```

### Task 9: Real codec/provider reconstruction gate and backlog consumption

**Files:** Create `packages/mls-rpc/test/fixtures/codec-reopen.ts`; Create/Test `packages/mls-rpc/test/storage-codec-reopen.test.ts`; Delete `docs/agents/plans/backlog/2026-10-09-client-state-sender-zero.md`; Create `.changeset/spec-p-storage-foundation.md` through pnpm change.

**Interfaces:**
- Consumes: Tasks 1-8 public codecs, memory factories, real seed construction and raw/fault fixtures.
- Consumes RPC `GroupMLS` and `OpenedRecoveryVerdict` for real candidate restoration.
- Produces test-only `createCodecReopenFixture(id: string): Promise<{fixture: PersistenceFixture<StorageTestPorts<MemoryTransaction>>; key: GroupKey; zeroRef: string; boundVerdict: OpenedRecoveryVerdict; realPort: GroupMLS; mutationID: string}>`.

- [ ] Write `reopens sealed real MLS pending zero sender and recovery candidate without plaintext state caches`.

```ts
const reopened = await fixture.reopen()
const stored = await reopened.device.groups.loadState(key)
expect(stored!.deleted).toBe(false)
if (stored == null || stored.deleted || stored.state == null) throw new Error('missing state')
expect(stored.state[0]).toBe(2)
expect(decodeClientState(stored.state)!.unappliedProposals[zeroRef]!.senderLeafIndex).toBe(0)
const rejoin = (await reopened.device.groups.ports(key).control.load()).rejoin!
expect(rejoin.candidate[0]).toBe(2)
const restored = await realPort.restoreRecovery(rejoin.candidate, rejoin.requestKey)
expect(restored.judgeVerdict(boundVerdict)).toBe('authoritative')
expect(await reopened.device.groups.resolve(groupID, mutationID)).toBe('committed')
```

Use the real recovery fixture from Task 2 to construct the existing P2a RejoinRecord, with its unchanged fields. The record is storage data, not a running recovery worker. Save the zero proposal state and rejoin candidate/requestKey in one transition, then reconstruct solely from snapshot bytes. Also assert clone/save/reopen for sender `1` and absent sender.

- [ ] Run `rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit test/storage-codec-reopen.test.ts` and `rtk proxy pnpm --filter @kumiai/mls-rpc run test:types`. Expect FAIL: missing `createCodecReopenFixture`; types report its missing export.
- [ ] Implement `createCodecReopenFixture(id: string)` in the named fixture file using the existing signatures.

Reconstruct `realPort` through `restoreGroup` from copied stored state, credential and ordered ledger, retaining only host signing identity externally. Preserve repeated ledger tokens and actual source/candidate tree differences. Do not return the original source handle as the reconstructed port.
- [ ] Run the paired focused checks. Expect PASS with zero restoration, authoritative verdict and co-committed mutation proof.
- [ ] Run the final regression gate below. Each Vitest command has its explicit type companion.

```sh
rtk proxy pnpm --filter @kumiai/mls run test:types
rtk proxy pnpm --filter @kumiai/mls run test:unit
rtk proxy pnpm --filter @kumiai/mls-rpc run test:types
rtk proxy pnpm --filter @kumiai/mls-rpc run test:unit
rtk proxy pnpm --filter @kumiai/rpc run test:types
rtk proxy pnpm --filter @kumiai/rpc run test:unit test/ports-conformance.test.ts test/control-store-conformance.test.ts test/hub-conformance.test.ts
rtk proxy pnpm --filter @kumiai/mls-hub run test:types
rtk proxy pnpm --filter @kumiai/mls-hub run test:unit test/store-ports.test.ts test/pool-store.test.ts test/store.test.ts test/consume.test.ts
rtk proxy pnpm --filter @kumiai/hub-server run test:types
rtk proxy pnpm --filter @kumiai/hub-server run test:unit test/conformance.test.ts test/log-hub-conformance.test.ts
rtk proxy pnpm --filter @kumiai/integration-tests run test:types
rtk proxy pnpm --filter @kumiai/integration-tests run test:unit test/hub-log-conformance.test.ts
rtk proxy pnpm --filter @kumiai/rpc-conformance run test:types
rtk proxy pnpm --filter @kumiai/hub-conformance run test:types
rtk proxy pnpm turbo run test:types
rtk proxy pnpm run check:versions
```

Expect PASS: RPC crypto/MLS contracts on real implementations and doubles, existing hub contracts on memory/doubles/SQL, and new storage suites on real-MLS/double records. Do not claim registry-based full persistence conformance yet.

- [ ] Delete the consumed sender-zero backlog after its round-trip, v1 refusal and optional-encoder audit checks pass.
- [ ] Record a minor release intent through `rtk proxy pnpm change`, naming all fourteen published packages because v1 refusal breaks stored-format compatibility.

Use the generated intent as `.changeset/spec-p-storage-foundation.md`. Entries at `minor`: `@kumiai/mls`, `@kumiai/broadcast`, `@kumiai/hub-protocol`, `@kumiai/hub-client`, `@kumiai/hub-server`, `@kumiai/hub-store`, `@kumiai/hub-http`, `@kumiai/hub-tunnel`, `@kumiai/hub-wake`, `@kumiai/rpc`, `@kumiai/mls-rpc`, `@kumiai/mls-hub`, `@kumiai/rpc-conformance`, `@kumiai/hub-conformance`. Summary: “Add transactional memory persistence and lossless MLS/recovery v2 storage codecs; refuse ambiguous v1 snapshots.” Do not apply versions or publish in this plan.

- [ ] Run `rtk proxy pnpm change status` and lint. Expect one coherent band-raising intent and clean lint.
- [ ] Commit the final task.

```sh
git add packages/mls-rpc/test/fixtures/codec-reopen.ts packages/mls-rpc/test/storage-codec-reopen.test.ts docs/agents/plans/backlog/2026-10-09-client-state-sender-zero.md .changeset/spec-p-storage-foundation.md
git commit -m "test(mls-rpc): verify sealed v2 reconstruction and retire sender backlog"
```

## Self-review and handoff

Coverage: 2.1 owns v2 codecs (Tasks 1-2), contracts/AAD (3), coordinator/completion (4), incarnation records/trust/spent guards (5), namespaces (6), DevicePersistence (7), fixtures/conformance (8), and reconstruction/regressions/backlog consumption (9). Every phase-2 row has one plan owner. Runtime admission, restore processing, settlement certification and peer wiring remain assigned explicitly.

Step scan: tasks name exact signatures, source files, test assertions, red/pass commands, mutation guards and commit paths. Type scan: storage value types are normative; unchanged P2a imports are explicit. The generic storage fixture does not counterfeit full runtime TPorts. Review Focus maps to Tasks 1, 4, 5, 6 and 8. Proportion: nine reviewable test cycles, no implementation function bodies, and fewer lines than the r16 spec.

This document is an execution plan. Writing it changes documentation only and performs none of its code edits, test mutations, release intents, backlog deletion or commits.
