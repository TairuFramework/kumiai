# Spec P 2.3b Leases, Seal and Ephemeral Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT revision 12, 2026-10-18. It applies the five final minors ("Revision 12": Codex r11 m1-m2, Sonnet M-r11-1 to M-r11-3) as targeted edits. Revision 11 (2026-10-18) It folds `review-codex-r10.md` (0C/1I/1M) and `review-sonnet-r10.md` (0C/1I/3M) under the "Revision 11 rulings". The caller-isolation seam held; every change is local.
- Each reservation carries an immutable **envelope**: the exact advanced `ReadableGroupState` plus its saved version. The envelope survives through proof resolution and acceptance, and `pendingHandoff` carries it.
- After transfer, the registry **reads nothing but the capture**. Every derived value comes from the private restore, and the spy asserts zero reads as well as zero mutations.
- A shared optional persist-context type carries the holding token through every `mutate`/`persist` signature.
- `Relinquished` uses `MemberCredential`.
- A failed private restore refuses the install.

Revision 10 (2026-10-18) made transfer exclusive by default, added the holding token, reserved only on private restores, and checked S1 (a) at acceptance.

Revision 9 (2026-10-18) handled incoming-commit persist inside `processMessage`, shared the double serializer, added accept eligibility, and dropped the generation guard.

Revision 8 (2026-10-18) introduced `relinquishSend`, the `onAdmissionChanged` refresh, `expectedAAD` forwarding, the D5 clause rewrites, and refill stopping at 500.

Revision 7 (2026-10-18) folded `review-codex-r6.md` (1C/6I/1M) and `review-sonnet-r6.md` (0C/9I/13M) under the "Revision 7 rulings" and the "Revision 6 acceptance". The redesign is unchanged; the fixes are local:
- S1 gains an ownership-transfer companion: every input handle is denied before the `pre` snapshot, and the snapshot is taken under the handle mutex.
- The rotation trigger uses the effective next generation.
- `receive` is serialized per slot. Foreign versions are judged against accounted versions. The receive digest ignores the own send ratchet.
- A cold durable seal waits, bounded. Owner load and foreign writes warm eagerly, by scheduling.
- Seed and switch hand-offs wait on `GroupSlot` until the owner exists.
- Outcome routing moves to the emission boundary. Rejected rotations back off.
- `seal` reports the generation read inside the mutex.
- Full repo suites run from Task 2 and at the final gate. Safety-hold rows are added.
- Minors are applied.

Revision 6 (2026-10-18) was the clean-slate rewrite under the user's redesign "stored state leads" (S1-S8). Dispositions are in `.superpowers/sdd/plan-2-3b-draft/drafter-notes.md`.

**Goal:** Registry application sends use only generations the stored state has already skipped past. Ephemeral traffic seals and opens with no provider transaction. At effective next generation 500, new durable work stops and any member rotates. The kubun `MLSEncryptor` runs in `mls-rpc` over registry `seal`/`receive`/`runtime`.

**Headline invariant (S1).** For every identity (incarnation, epoch, authenticator):
- **(a)** every in-memory send copy's limit is at most the **committed** stored own application generation; and
- **(b)** no send-capable handle other than the copy holds state below the stored generation.

(b) is secured by ownership transfer through one primitive, `relinquishSend(handle, opts?)`.
- **Default.** It denies the handle irreversibly. It then **acquires** the handle mutex, waiting for any holder (an encrypt, a decrypt, a bootstrap, anything), captures the handle's bytes and send-relevant fields under that lock, and releases. It returns only the captured bytes; the caller's object is never used again for state.
- **Exception.** It skips the wait only when given a valid holding token. mls mints that token for its own persist callbacks, valid only for that handle and only while the callback runs. It captures directly, since the minting operation holds the mutex.
- Every registry acceptance calls it on the **actual caller-supplied input** before any validation, equality comparison or encoding. This covers seed, switch, `ordinary`/`replace`/`adopt` `next` (even when a journal destination is substituted), `persist` candidates, and same-identity `recordFor`.
- Validation then runs on the captured state, including the full `ordinaryCandidateMatches` comparison when a destination is substituted. Divergence is refused.
- Reservations run only on a registry-private handle restored from the captured bytes, and denied at once. The private handle's `advanced` bytes are what is persisted.
- **S1 (a) is checked at acceptance.** Accept, extend and `pendingHandoff` require `limit <= ownApplicationGeneration(decode(provenRecord.state))`, where `provenRecord` is the reservation's immutable envelope: the exact advanced record saved, plus its version, carried through proof resolution and acceptance. Otherwise the hand-off is refused and the copy dropped.

Losing memory is always safe: a restart, owner drop, failed encryption or rebuild only wastes leased generations, which spec D5 counts as used. Reviewers check two places:
- every assignment to a copy's limit follows a reservation's commit proof;
- every acceptance path calls `relinquishSend` on the caller's input before it touches that input's state, passes a token only where mls supplied one, and never calls a mutating method on the caller's object; and
- the acceptance-time S1 (a) check.

**Architecture:**
- **Reservation (S2).** One transaction:
  1. `relinquishSend` the caller's input, which captures its bytes, then revalidate. If a destination is substituted, it is relinquished too.
  2. Restore a registry-private handle from the bytes, and deny it. On it, set `start = max(own, floor)`, where `floor` is `senderHWM` for the same identity and 0 for a new one. Skip to `start`, encode `pre`, skip to `limit = min(start + 16, 500)`, and encode `advanced`.
  3. Save `advanced` with `senderHWM = limit`.
  - Only after commit proof does the registry build or extend the private copy with the range `[start, limit)`.
- **Installation pre-reserve (S4).** Every installing write reserves inside its own transaction and hands `pre` over in memory: seed (create, Welcome, external join), switch, and new-identity writes through `recordFor` (incoming commits, adoption, `replace`/`adopt`).
  - Owner writes are accepted directly.
  - Seed and switch hand-offs are held on `GroupSlot` until `load()` creates the owner for the same identity and version.
  - A lost hand-off only wastes generations.
- **Send copy.** It is private, lives on `RegistryOwner`, is send-only and bound once, through a closure over its own record.
  - An owner drop drops it (S3).
  - So do an identity change, a stored send-eligibility change (proposal set, active state, own leaf) and a foreign version above the accounted one (S5).
  - Renewal below 4 extends the copy in place only when `start === limit` and eligibility is unchanged. A reservation with `start` above the old limit replaces the copy from `pre`. A reservation with `start` below the old limit is refused (fail closed).
- **Receive (S7).**
  - A private, send-denied, decrypt-only handle caches committed bytes. It is rebuilt only when the receive projection changes, a digest that zeroes the own application ratchet.
  - Own commits install their proven record as its base. Foreign versions clear it, and the cold refresh is gated on receive lifecycle, not send admission.
  - One slot lock spans base selection, rebuild, and check-decrypt-add on a consumed set of `(epoch, leaf, generation)`. The set has a derived cap and closed markers, and never closes the current epoch.
  - Frames at generation 500 or above are refused. The AAD check runs before the sender-data peek.
- **Narrow API (R3-1).** Byte-level `seal` and `receive`. No live handle leaves `mls-rpc/src/registry/`.
- **Hygiene (S7).**
  - For registry-backed access, every handle the registry issues or accepts is denied, irreversibly. Recovery and adoption candidates are denied only when registry-backed. Control-build permit clones are denied for every host. Simple access is otherwise unchanged.
  - `bindSendCeiling` is one-shot on the copy.
  - The host `restore` adapter is the trusted raw-key exception. It now matters only for the copy.
- **Bound (S6, Revision 6 acceptance).**
  - Effective next = the copy's own generation if a copy exists, otherwise the stored generation.
  - At 500, `admission()` reports `rotation-required` and GroupMLS applies that at every cache ingress. Every effective-admission change, in either direction, also triggers a GroupMLS refresh through `onAdmissionChanged`, separately from the once-per-identity rotation notification. New durable acceptance refuses, while sealed frames still hand off.
  - Refill stops once the committed `max(own, senderHWM)` reaches 500.
  - An outside-gate scheduler enqueues one deterministic library-built rotation through a private internal enqueue, and the hub CAS decides.
- **Lanes.** Lane B lifts `MLSEncryptor`. Lane C authenticates commits in the test doubles.
- **2.3c seam (S8).** `reserveFromBytes` composes into any caller transition.

**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, transactional memory persistence, `@kumiai/hub-tunnel`.

**Spec:** [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md) r25 plus the r26 amendments in Task 0. Show the user the `seal`/`receive` shape (A3) and the D5 rewording (A2) at approval.

Baseline: `feat/spec-p-phase-2`, HEAD `5870f892`. Coordinates refer to this HEAD.

Facts this plan relies on (verified in source):
- **Stored own generation.**
  - It is `state.secretTree.leafNodes[2 * leaf].application.generation` (`registry/access.ts:209-211`).
  - The real `encrypt` advances it through `createApplicationMessage` under `mutexFor(this)` (`mls/src/group-handle.ts:981-995`).
  - The double's `encrypt` advances the same field with `stepRatchet` under `mutexFor(this)`, after the same checks (`sealed-memory-mls.ts:618-651`, `:465-471`).
  - ts-mls refuses with unapplied proposals, when suspended and when removed (`ts-mls clientState.js:131-140`).
  - Codex r6 probes: 16 skips give the same sending-chain secret as 16 encryptions, in both modes, and serialization preserves it.
- **State writers.**
  - There are four save sites: `access.ts:238` via `recordFor` (`:202-227`, used by mutate, ordinary, replace/adopt and app-open `app-open.ts:188`), `app-open.ts:215`, `seed.ts:328` and `switch.ts:400`.
  - Seed encodes the caller's handle at `seed.ts:293` and switch encodes its candidate at `switch.ts:286`, both in prepare.
  - Seed returns early for `alreadyJoined` and throws refusals before that (`seed.ts:229-245`).
- **Accepted inputs (Codex r7 C1).**
  - Adoption restores a separate destination (`access.ts:284`), compares it with `next` (`validation.ts:183`) and passes the destination to `recordFor` (`:462`). The persist path substitutes a journal destination the same way (`:566-586`).
  - `recordFor` encodes outside the handle mutex (`:218`).
  - Two mls operations call a caller's `persist` while holding the mutex:
    - `GroupHandle.bootstrapLedger` (`mls/src/group-handle.ts:716-724,785`), into which `mls.ts:984` passes mutate's `persist`;
    - `processMessage` (`:1596` mutex, `:1730-1741` `await opts.persist(this)`), into which incoming commits pass the registry `persist` (`apply-commit.ts:130-140`).
    A plain mutex wait in either would self-deadlock. So these two callbacks receive a holding token (`{ holding }` as a second argument), and `mls.ts:984` and `apply-commit.ts:132` forward it to the registry `persist`.
  - **encrypt calls no caller callback under the mutex.** Its body (`:981-995`) uses `leafAt`, `isLapsed` (pure over handle data, `lifecycle.ts:124-129`), ts-mls `createApplicationMessage` with the handle's own context, `zeroAll` and `encode`. Task 1 adds only the bound `limit()` closure: a synchronous, registry-owned closure that touches no handle.
  - The mutex is a plain FIFO chain (`mls/src/mutex.ts:15-24`), with 12 `mutexFor(this).run` sites.
  - The double imports `mutexFor` from the mls **source** module (`sealed-memory-mls.ts:141-154`), so its WeakMap differs from the built module's that mls-rpc uses. The double's `bootstrapLedger` takes no mutex (`sealed-memory-mls.ts:596-604`).
- **`GroupCrypto.unwrap`** takes `expectedAAD` (`rpc/src/crypto.ts:78`). Frame-less callers pass none (`rpc/src/open-once.ts:67`, `broadcast/src/transport.ts:146`). Conformance requires a thrown error for refusals (`rpc-conformance/src/group-crypto.ts:112,404`).
- **Same-identity writers start from current bytes.** `cold.ts:51-70,120-170`, and app-open re-checks its version (`app-open.ts:200-204`).
- **Provider guards.** Providers refuse a same-epoch regression of a ratchet generation (`persistence-guards.ts:86`) and of `senderHWM` (`:193`) on every memory save (`memory-group-persistence.ts:948`, `memory-group-state.ts:577`). The port suite pins only epoch regression (`rpc-conformance/src/group-storage.ts:207`).
- **Observations.**
  - They are delivered at commit proof, before `run`'s continuation (`memory-group-persistence.ts:542-551`).
  - Every group transition is observed, including control, cursor, outbox and pending writes. `activeVersion` is the unchanged active metadata version when state did not move (`:441,478-480,530-546`).
  - `capability.read` is a provider transaction (`:344-372`).
- **Owners.** `slot.owner` is created only by `load()` (`registry.ts:299-409`). Switch displaces the old owner (`registry.ts:290-296`).
- **Adoption.** `createControlAdoptionPort` passes its candidate to `access.replace` (`control-adoption.ts:32,49`). Simple access adopts it as its live handle (`mls-rpc/src/access.ts:157-170`).
- **Sender data.** It is epoch-level and consumes nothing (`mls/src/sender-data.ts:104-143`). It currently accepts plaintext of 4 bytes or more (`:140`).
- **Control projection.** It zeroes the own application ratchet (`control-compat.ts:10-34`).
- **Outcomes.** `emitOutcome` is shared by ordinary settlement and replay (`rpc/src/peer.ts:2690-2697`, replay at `:2712`). `OperationRequest.revokes` holds app sends until settle (`control/types.ts:114-121`). A rejected build settles via `control-build.ts:388` and `operations.ts:157`.
- **GroupMLS** caches admission at three ingresses (`registry-group-mls.ts:144,217-219`, refresh). The runtime suppresses unchanged installs (`runtime.ts:106`).
- **The memory model's authenticator** starts at `sha256(recoverySecret ‖ groupID ‖ state)` (`rpc/test/fixtures/memory-group-mls.ts:997-1007`) and advances via `:875`.

## Global Constraints

- **One principle for accepted handles.** The registry never advances, reserves on, or otherwise mutates a handle object a caller supplied.
  - Ownership transfer is: deny, then exclusive mutex acquisition (waiting for any holder), then encode the bytes under that lock, then release.
  - All reservation and advance work runs on a registry-private handle restored from those bytes. Its advanced bytes are what is persisted and checked at acceptance.
  - The only no-wait case is the explicit holding token on mls's own persist callbacks (`bootstrapLedger`, `processMessage`) when invoked through the registry's own `mutate`. There too, the registry encodes bytes and reserves on a private restore.
  - Cost: one private restore per installation and per same-identity write.

- Spec D5 (spec:619-626) as amended by A2: reserve 16, renew below 4, ceiling 500. The reservation advances committed state, so restore needs no skip. Failed or unused generations count. A reservation is refused exactly where encryption is refused; the install still commits, without a hand-off. Same-identity saves keep the maximum; a new epoch starts at 0; a new incarnation inherits neither.
- Ephemeral: "perform no persistence and initiate no provider transaction … Exhaustion rejects/holds the ephemeral call without storage work; separately scheduled maintenance refills" (spec:523-525).
- Safety holds (spec:128, :702): fork-halt, recovery-unavailable and spent-set-corrupt block ephemeral seals and new opens, live and after restart.
- Crash seam (spec:1845). **No two published messages may ever use the same own-leaf sender generation.** The raw-key restoration exception (2.3a carry-forward item 6) is the only exception.
- The hub is blind and may withhold, reorder or replay. A withheld rotation degrades to `rotation-required` non-delivery, never to a hold, halt or strand.
- Non-admin rotation "passes lifecycle checks, includes an update path, empty proposals/entries and unchanged roster/ledger; it keeps the app anchor unless membership changes" (spec:628-629).
- A double may be stricter than its port, never more permissive. A crypto double is non-malleable and epoch-bound. Every changed port runs both contract suites across `kgate`.
- `mls`, `mls-rpc`, `rpc` and `broadcast` stay runtime-neutral (`mls-rpc/test/runtime-neutral.test.ts:28-60`).
- Evidence is memory reconstruction (`reopen()`). Use pnpm via `rtk proxy` only. Do not edit `lib/`.
- New dependencies, all in Task 9: `@kumiai/hub-tunnel` (`workspace:^`), `@sozai/codec` (`catalog:`, already imported but undeclared at `mls-rpc/src/branch-history.ts:17`), and the lockfile.
- Keep comments terse. Every commit keeps its stated gate green, with no `test.fails`. Every new guard gets a mutation check: break it, see its test fail, restore it.

## Review Focus

1. **S1 (a) and (b).**
   - Every copy-limit assignment follows commit proof, with a matching identity and version, and `start` at or above the old limit.
   - Every acceptance path calls `relinquishSend` on the actual caller input before any validation, comparison or encoding, then revalidates and refuses divergence. This includes `next` when adoption substitutes a destination, persist candidates, and same-identity `recordFor`.
   - Tests: the already-admitted-encrypt tests (Tasks 1-2), with a mutation that denies without draining; the S1 property tests (Task 3).
2. **Every install reserves or wastes, never reuses** (Task 2).
3. **Copy and base invalidation fail closed, and only for foreign versions above the accounted one** (Tasks 3-4).
4. **Receive is serialized per slot. Durable state is authoritative.** Codex r2 #3, the consumed set, AAD first (Task 4).
5. **Effective-next rotation, GroupMLS overlay, outcome privacy at the emission boundary, rotation backoff** (Tasks 6-7).

## File Structure

| Boundary | Files |
| --- | --- |
| Spec | `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` (Task 0). |
| mls | New `mls/src/send-policy.ts`; `mls/src/group-handle.ts:981-995,1808-1822`, plus new `encryptApplication`, `reserveApplicationRange` and `readSenderData`; `mls/src/sender-data.ts:104-143`; `mls/src/index.ts`; double `sealed-memory-mls.ts:618-651,742` (Task 1). |
| Reservation, installs, denial | New `mls-rpc/src/registry/reserve.ts`; `registry/access.ts:202-227,284,392-470,548-611,666-683`; `registry/app-open.ts:188`; `mls-rpc/src/access.ts:38-40,144`; `registry-handle-access.ts:14`; `apply-commit.ts:17-24,132`; `mls.ts:985`; fixtures `transactional-access.ts:468`, `sealed-control-access.ts:172`; `rpc-conformance/src/{registry,safety}.ts`; `registry/seed.ts:200-245,293,338`; `registry/switch.ts:285-289`; `control-build.ts:312-319,337`; `control-validation.ts:110,198,253`; `registry-group-mls.ts:347`; `mls.ts:807,898` and `recovery.ts:290,495,604` (registry-backed only); `rpc-conformance/src/group-storage.ts`; seed/switch test migrations (Task 2 list) (Task 2). |
| Send copy, maintenance | New `registry/live-send.ts`; `registry/access.ts` (`RegistryOwner.send`/`.knownVersion`/`.expected`); `registry/registry.ts:48-50,208-267,287-298,299-409,482+`; `registry/types.ts`; `mls-rpc/src/testing.ts`; fixtures `mls-rpc/test/fixtures/registry-lease.ts`, `rpc-conformance/src/persistence-fixture.ts` (Task 3). |
| Receive | New `registry/live-receive.ts`; `mls-rpc/src/crypto.ts:332-352` (`assertOpenableEpoch`); `registry/registry.ts` (`GroupSlot.live`) (Task 4). |
| Routing | `mls-rpc/src/registry-crypto.ts:39-68`; `registry/cold.ts:56,147`; `mls-rpc/test/fixtures/registry-crypto.ts` (Task 5). |
| Admission | `registry/registry.ts:386-390`; `registry/types.ts`; `registry-group-mls.ts:122-133,144,211-220`; `registry-peer.ts:519-523`; `rpc/src/log-delivery.ts:24-33,126,157,181`; `rpc/src/peer.ts:934-944,988-992` (Task 6). |
| Auto-rotation | New `mls-rpc/src/auto-rotation.ts`; `control-build.ts:201-216,317-319,388`; `rpc/src/control/operations.ts:55-69`; `rpc/src/peer-types.ts`; `rpc/src/peer.ts:2690-2712,3796-3870`; `registry-peer.ts`; fixtures `sealed-memory-mls.ts:968-1015`, `storage-persistence.ts:1030,1145` (Task 7). |
| Contracts | New `rpc-conformance/src/registry-lease.ts`; `rpc-conformance/src/index.ts`; new `mls-rpc/test/registry-lease-conformance.test.ts` (Task 8). |
| Lift (B) | New `mls-rpc/src/mls-encryptor.ts`, its test; `mls-rpc/package.json`; `pnpm-lock.yaml` (Task 9). |
| Double commit auth (C) | `rpc/test/fixtures/{memory-group-mls,commits}.ts`, 305 sites in 60 `rpc/test` files, the 12 `mls-rpc/test` importers listed in Task 10 (Task 10); `sealed-memory-mls.ts:1017-1085`, `storage-persistence.ts` authors (Task 11). |

## Lanes

```
base:   0 ─┬──────────────────────────────────────────────┐
Lane A:    ├ 1 ─ 2 ─ 3 ─ 4 ─┬ 5 ─ 6 ─ 7 ─ 8 ─┬(merge B, C1) 11 ─ 12
Lane B:    │                └ 9 ─────────────┤
Lane C1:   └ 10 ─────────────────────────────┘
```

- **Lane A** owns `packages/mls/**`, `packages/mls-rpc/**` (except Lane B's files and the C1 call sites), `packages/rpc-conformance/**`, `rpc/src/**`, and the new tests `rpc/test/{lease-handoff,enqueue-idempotent,internal-outcomes}.test.ts`. It may make lease and denial migration edits in the 12 Task 10 files (for example `registry-double.test.ts:1487-1502`). C1 owns only the synthetic commit-authoring edits there. The overlap is resolved at the merge point (Codex r8 #3).
- **Lane B** branches after Task 4, whose fixture provides every helper Task 9 needs. It owns `mls-rpc/src/mls-encryptor.ts`, `mls-rpc/test/mls-encryptor*.test.ts`, `mls-rpc/package.json` and `pnpm-lock.yaml`.
- **Lane C1** branches from base. It owns `rpc/test/fixtures/{memory-group-mls,commits}.ts`, existing `rpc/test/**` files (including `peer-log-delivery.test.ts`; `handoffHeld` is optional, so no Lane A edit is needed there), and the synthetic authors in the 12 importers.
- **Merge point (before Task 11):** merge B and C1 into A with `git merge` (no rebase). In the 12 shared files, conflicts are resolved by keeping both: C1's authoring hunks and Lane A's lease and denial hunks. The merge commit lists each resolved file, then `kgate && kall`.

## Interfaces shared by tasks

```ts
// mls/src/send-policy.ts (Task 1), exported from the package index
export class ApplicationSendRefusedError extends Error {}
export function denyApplicationSend(handle: GroupHandle): GroupHandle   // irreversible; idempotent; inherited by deriveGroup
export function bindSendCeiling(handle: GroupHandle, limit: () => number): GroupHandle // one-shot; throws if any policy exists
export function isApplicationSendDenied(handle: GroupHandle): boolean
export function ownApplicationGeneration(state: ClientState): number
export type HoldingToken // opaque; minted by mls for its own persist callbacks
export function relinquishSend(handle: GroupHandle, opts?: { holding?: HoldingToken }): Promise<Relinquished>
//   denyApplicationSend, then acquire the handle mutex, waiting for ANY holder. Capture under the lock, then release.
//   With a holding token valid for this handle (inside the minting callback), capture directly without acquiring.
//   A token for another handle, or used after its callback returned, throws TypeError.
export type Relinquished = { state: Uint8Array; ledgerTokens: Array<string>; credential: MemberCredential }
export type PersistContext = { holding?: HoldingToken } // mls-rpc/src/access.ts; optional everywhere
export function reserveApplicationRange(handle: GroupHandle, opts: { floor: number; size: number; cap: number }):
  Promise<{ pre: Uint8Array; advanced: Uint8Array; start: number; limit: number } | null>
//   For registry-private handles only. Throws TypeError unless the handle is denied. Acquires the mutex exclusively.
//   start = max(own, floor); null if start >= cap. Skip to start, then pre = encode. Skip to
//   limit = min(start + size, cap), then advanced = encode. Encrypt-and-discard, emitting nothing.
//   Refuses where encrypt refuses minus policy (lapse, proposals, inactive), leaving the state unchanged.
// bootstrapLedger and processMessage persist callbacks gain a second argument { holding: HoldingToken }.
// @kumiai/mls/testing (new subpath, package.json exports): serializeHandle(handle, fn: (holding) => Promise<T>)
//   is the built module's serializer for doubles (Sonnet M-r9-2); not exported from ".".
// GroupHandle gains (Task 1; the double overrides encryptApplication and supplies the reserve kernel via serializeHandle):
encryptApplication(plaintext: Uint8Array, opts?: { aad?: Uint8Array }): Promise<{ ciphertext: Uint8Array; generation: number }>
//   encrypt() delegates to it. Under the mutex: lapse check, then policy (denied refuses; bound refuses unless
//   own < limit()), then read the generation and encrypt.
readSenderData(message: Uint8Array): Promise<{ epoch: number; leaf: number; generation: number } | null>
//   Pre-open, consumes nothing. Plaintext under 8 bytes gives null.

// mls-rpc/src/registry/reserve.ts (Task 2)
export const LEASE_SIZE = 16, LEASE_RENEW_BELOW = 4, LEASE_MAX_GENERATION = 500, LEASE_AWAIT_MS = 5_000
export type ReservationEnvelope = Readonly<{ saved: ReadableGroupState; version: number }> // frozen deep copy of the exact advanced record that was saved
export type Reservation = { identity: EpochIdentity; envelope: ReservationEnvelope; pre: ReadableGroupState; start: number; limit: number; eligibility: Uint8Array }
export async function reserveFromBytes(environment: ColdEnvironment, record: ReadableGroupState, floor: number):
  Promise<{ state: Uint8Array; senderHWM: number; reservation: Omit<Reservation, 'envelope'> | null }>
// The caller builds the envelope from the record it saves, with that record's version.
// A private restore failure throws GroupUnavailableError('invalid'); the install is refused and the caller's handle stays denied.
// record.state holds the relinquished bytes. It restores a private handle (environment.restore), denies it, and runs
// reserveApplicationRange({ floor, size: 16, cap: 500 }). state = advanced, or record.state when the result is null.
// floor = record.senderHWM for the same identity, 0 for a new one.
// An ineligible handle gives reservation null and an unchanged state.
export function eligibilityOf(state: ClientState): Uint8Array
// sha256(controlProjection(state) ‖ proposal keys ‖ active kind ‖ own-leaf lapse bit); controlProjection is control-compat.ts:32
export function receiveProjection(state: ClientState): Uint8Array // encodeClientState with the own application ratchet zeroed

// mls-rpc/src/registry/types.ts — RegistryHandleAccess adds (A3)
export type SealedApp = { ciphertext: Uint8Array; epoch: number; generation: number }
export type ReceiveInput = { ciphertext: Uint8Array; expectedAAD: Uint8Array } // callers with no expectation pass the frame's clear AAD
export type ReceiveResult =
  | { kind: 'opened'; payload: Uint8Array; senderDID?: string; aad: Uint8Array; frameEpoch: number; handleEpoch: number }
  | { kind: 'refused'; reason: 'past-epoch' | 'future-epoch'; frameEpoch: number; handleEpoch: number }
  | { kind: 'refused'; reason: 'log-intent' | 'consumed' | 'closed-epoch' | 'generation-bound' | 'capacity' | 'invalid'; error?: unknown }
seal(plaintext: Uint8Array, opts: { aad: Uint8Array; intent: 'log' | 'ephemeral' }): Promise<SealedApp>
receive(frames: Array<ReceiveInput>): Promise<Array<ReceiveResult>> // <= 64 inputs, else RangeError
onRotationRequired(listener: (identity: EpochIdentity) => void): () => void
onAdmissionChanged(listener: () => void): () => void // any effective-admission flip, in either direction (Task 6)
export class ApplicationLeaseUnavailableError extends Error {} // reason: 'cold' | 'exhausted' | 'deferred'

// RegistryOwner gains (Task 3):
//   send: { copy: GroupHandle; identity: EpochIdentity; limit: number; eligibility: Uint8Array } | null
//   knownVersion: number; expected: Map<number, ReadableGroupState>; maintenance // single-flight
//   latestCommitted: ReadableGroupState // the proven record of the latest own or foreign commit the owner has
//     accounted for: set from expected[v] on own proof, and from a cold reload after a foreign version (Sonnet M-r9-1)
// GroupSlot gains:
//   pendingHandoff: Reservation | null // carries its envelope (Task 3, seed/switch)
//   live: { lock; base: ReadableGroupState | null; receive: GroupHandle | null;
//           receiveDigest: Uint8Array | null; consumed: ConsumedSet; inflight: Set<Promise<unknown>> } | null // Task 4
// Registry value gains effectiveNext(key: GroupKey): number | null (Task 6)
// testing.ts (test-only): registryLeaseSnapshot(access) -> { identity; limit; own; storedGeneration } | null;
//   isLiveHandle(h); armLiveEncryptFault(access, 'throw-before' | 'throw-after' | 'block') wraps the copy's encryptApplication;
//   restoreCommittedSender(registry, groupID) // raw-key exception, test-only

// rpc (Task 6): LogDeliveryParams adds handoffHeld?: () => boolean // default held(); peer supplies held() minus rotation-required alone
// rpc (Task 7)
export const INTERNAL_OPERATION_PREFIX = 'kumiai/internal/'
export type InternalOperations = {
  bind(capability: { enqueue(op: OperationRequest): Promise<void> }): void
  onOutcome(outcome: Outcome): void | Promise<void>
}
// mls-rpc/src/auto-rotation.ts (Task 7)
export function autoRotationRequest(identity: EpochIdentity): OperationRequest // revokes: false; id = prefix + 'rotation/' + 32 hex of sha256(body)
export function isAutoRotation(op: OperationRequest): boolean
export function buildKeyRotation(op: Operation, group: GroupHandle): Promise<HostBuilt>
export function createAutoRotationScheduler(params: { access: RegistryHandleAccess }): InternalOperations & { stop(): void }
```

Fixture `RegistryLeaseFixture` (`rpc-conformance/src/persistence-fixture.ts`). Each task's tests use only methods available at that task:

| Task | Adds |
| --- | --- |
| 2 | `restoreCommittedSender` helper (mls-rpc `testing.ts`) for migrated seed/switch tests |
| 3 | `sealEphemeral`, `sealDurable`, `failNextEncrypt(when)`, `blockNextEncrypt`, `openDurable`, `lease()`, `storedGeneration()`, `rawRestoreEncrypt()`, `transactions()`, `restores()`, `inspectRows()`, `dropOwner()`, `reopen()`, `close()`, `drainMaintenance()`, `blockMaintenance()`, `forceStoredGeneration(g)`, `writeElsewhere('receive' \| 'proposal' \| 'control' \| 'cursor')`, `holdSafety(reason)` |
| 4 | `openEphemeral`, `advanceEpoch()`, `jumpEpochs(n)`, `removePeer()`, `switchIncarnation()` (Lane B uses these) |
| 6 | `admission()` reports `rotation-required` |
| 7 | `rotate()` |

## Verification commands

```bash
export SWC_NATIVE_BINDING_CACHE=/private/tmp/kumiai-2-3b-swc
ktest() {
  local package_name="$1"; shift
  rtk proxy pnpm --filter "$package_name" exec vitest run --maxWorkers=4 --testTimeout=30000 "$@" &&
    rtk proxy pnpm --filter "$package_name" run test:types
}
kbuild() { rtk proxy pnpm turbo run build:js build:types --env-mode=loose; }
kfinish() { rtk proxy pnpm exec turbo run test:types --force --env-mode=loose && rtk proxy pnpm run lint; }
kall() { rtk proxy pnpm exec turbo run test:types test:unit --force --env-mode=loose; } # check "Cached: 0"
kports() {
  ktest @kumiai/mls-rpc test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts \
    test/registry-conformance.test.ts test/storage-conformance.test.ts test/ownership-phases-conformance.test.ts \
    test/registry-crypto-conformance.test.ts test/registry-lease-conformance.test.ts &&
  ktest @kumiai/rpc test/ports-conformance.test.ts test/hub-conformance.test.ts
}
kgate() {
  kports &&
  ktest @kumiai/hub-server test/log-hub-conformance.test.ts &&
  ktest @kumiai/hub-tunnel test/hub-conformance.test.ts &&
  ktest @kumiai/integration-tests test/hub-log-conformance.test.ts &&
  ktest @kumiai/mls-rpc test/branch-history.test.ts test/branch-abandoned.test.ts
}
```

Run `kbuild` before any cross-package `ktest`. Drop `registry-lease-conformance.test.ts` from `kports` before Task 8. Every Lane A commit from Task 2 on runs `kall` (all packages' unit and type suites, `Cached: 0`) plus `kports` and `kfinish`. Lane B and C commits state their own gates.

## Tasks

### Task 0 (base): Amend Spec P to r26

**Files:** Modify the spec (Status :4; :523-527; :619-629; :882; :983-994; :1019; :1050-1051; :1371; :1727-1735; History after :2010).

- [ ] **Step 1: Apply verbatim.** Status: `draft r26 (2026-10-18)`.
  - **A1** (after :882): `// r26: committed own application generation reserved for this record's epoch; mirrors the stored sending ratchet after a reservation`.
  - **A2a** (:621): replace "Restore skips the committed ceiling before sealing." with "Restore needs no skip: reservations advance the committed state."
  - **A2b** (:623-624): replace "defer actual burn until encryption is allowed. Every eligible seal discharges its burn obligation." with "defer the reservation until encryption is allowed. Seals use only committed reserved ranges; there is no per-seal burn."
  - **A2** (insert after :622): "(r26) A reservation advances the committed state.
    - A reservation is one transaction. Every acceptance first relinquishes the caller's input: it is send-denied irreversibly, and encryptions already admitted drain. Only then is the input validated, compared or encoded. Divergence found by revalidation is refused. It then snapshots the state at `g = max(own, senderHWM)` and advances the stored sending ratchet by encrypt-and-discard to `min(g + 16, 500)`, saving that.
    - Only after commit proof may the private in-memory send copy, built from the snapshot, use `[g, min(g + 16, 500))`.
    - Invariants: every copy's limit is at most the committed stored own generation, and no send-capable handle other than the copy holds state below it. Memory loss only wastes generations.
    - Every installing write reserves in its own transaction and hands its snapshot to the registry in memory.
    - Renewal below 4 is a new reservation. It extends the copy only when it starts at the copy's limit with unchanged send eligibility; otherwise the copy is replaced or refused.
    - The copy is dropped on owner loss, identity change, send-eligibility change, and a stored version above the one this registry accounted for.
    - Application send policy only narrows. `denyApplicationSend` is irreversible and inherited by derivation; `bindSendCeiling` binds once. Registry-backed access denies every handle it issues or accepts. Control-build permit clones are denied for every host. Simple access otherwise sends as before."
  - **A3** (:983-994): replace `seal`/`receive` with the signatures and types in "Interfaces shared by tasks", plus `onRotationRequired`. Replace :1050-1051 with: "(r26) `seal` and `receive` are byte-level; no registry handle leaves the registry. Neither opens a provider transaction. Both refuse under a safety hold.
    - **Sends.** A cold, exhausted or deferred send rejects with ApplicationLeaseUnavailableError and schedules a reservation outside the call. A `log` seal first waits, bounded, for that reservation; the wait aborts at retirement start. `seal` refuses any non-admissible admission and reports the generation read inside the encryption's serialization.
    - **Cold receive.** A cold `receive` waits once, bounded, for its own scheduled refresh, aborting at retirement start. A cold ephemeral seal rejects at once.
    - **Receive handle.** `receive` uses a private send-denied decrypt-only handle, rebuilt when the committed receive projection changes. A version this registry committed installs its proven record as the base. A higher foreign version clears the base until a cold refresh, which is gated on receive lifecycle and safety, not on send admission.
    - **Per frame,** serialized per group across base rebuilds, `receive` compares the expected AAD before reading sender data. It refuses generations at or above 500, and refuses `(epoch, leaf, generation)` tuples already opened ephemerally in this process.
    - **Consumed set.** Its cap is members × 500 × retained epochs plus slack. Over the cap, the oldest non-current epoch is closed: its bucket is deleted and a closed marker is kept. A current epoch at the cap refuses instead.
    - The count of `opened` results is exact. One replay of an opened ephemeral frame after a restart is accepted. Durable opens are unchanged by the 500 refusal."
  - **A4** (after :625): "(r26) Effective next generation is the send copy's own generation when one exists, otherwise the committed stored generation.
    - At 500 admission reports `rotation-required` (not recovery-only). GroupMLS applies this at every admission update. New durable acceptance refuses, and a frame sealed below 500 still hands off.
    - The registry peer runs one outside-gate scheduler per identity. Through a private internal enqueue (the public enqueue refuses the namespace), it enqueues a deterministic, non-revoking, library-built auto-rotation whose id lies in the reserved `kumiai/internal/` namespace.
    - Enqueue errors and rejected attempts back off with a cap. Outcomes in that namespace go to the registry, never to the host, across restart.
    - The hub CAS decides: a built loser settles `lost`, an unbuilt stale intent `rejected`."
  - **A5** (:1019, :1371): "(r26) Wrap routes to `seal`; frame-less unwrap routes to `receive`, which refuses `log`-intent frames without consuming."
  - **A6** (:1727-1735): add `// r26: byte-level seal/receive; empty MLS AAD (kubun wire format); membership from committed runtime snapshots`.
  - **A7** (after :1019): "(r26) Live seal/receive operations join retirement's pre-commit drain; new live work, and any lease wait in progress, is refused from drain start. A reservation composes into a caller's transition: its advanced state is saved by that transition, and its hand-off is used after that transition's proof."
  - **A8** History: `- r26 (2026-10-18, plan 2.3b): reservation advances committed state with ownership transfer (no restore skip); installation pre-reserve; send copy limited by committed generation; narrowing send policy; byte-level seal/receive; serialized private receive and ephemeral consumed set; retirement drains live work; effective-next rotation-required admission, handoff tolerance, internal auto-rotation; MLSEncryptor lift.`
- [ ] **Step 2: Verify.** `rtk proxy grep -n "r26" <spec>` gives one hit per site. `rtk proxy grep -n "until 2.3b\|skips the committed ceiling\|burn obligation\|defer actual burn\|deny every handle they issue" <spec>` gives none.
- [ ] **Step 3: Commit (base).** `git commit -m 'docs(spec-p): r26 reservation and ephemeral amendments'`.

### Task 1 (A): Send policy, reservation range and sender-data peek in @kumiai/mls

**Files:** Create `mls/src/send-policy.ts`, `mls/test/send-policy.test.ts`, `mls-rpc/test/sealed-memory-send-parity.test.ts`. Modify:
- `mls/src/group-handle.ts`:
  - `encryptApplication`, with `encrypt` delegating to it;
  - `deriveGroup` (`:1822`): a denied or bound source yields a denied handle;
  - a private reserve kernel: loops `createApplicationMessage` with an empty plaintext, keeping `newState` and zeroing `consumed`;
  - `bootstrapLedger` (`:785`) and `processMessage` (`:1741`) mint a holding token around their `await opts.persist(this, { holding })`, and invalidate it in `finally`;
  - `readSenderData`;
  - `mls/src/mutex.ts`: add `acquire(): Promise<() => void>` (FIFO, the same chain as `run`);
  - `relinquishSend`, `Relinquished`, `reserveApplicationRange` and `HoldingToken` (in `send-policy.ts`);
  - new `mls/src/testing.ts` and a `"./testing"` entry in `mls/package.json` `exports`: `serializeHandle` (Sonnet M-r9-2);
- `mls/src/sender-data.ts:104-143`: a `readSenderData` helper requiring at least 8 bytes; `readSenderLeafIndex` wraps it;
- `mls/src/index.ts`;
- the double `sealed-memory-mls.ts`:
  - move the `encrypt` override (`:618-651`) to `encryptApplication`, adding the policy check;
  - a reserve-kernel override: `encrypt`'s three checks, `stepRatchet` loops, then `captureReceiveState`. the built module's `reserveApplicationRange` drives it inside the exclusive section;
  - `readSenderData` after the epoch, group and tag checks (`:742`);
  - drop the source-module `mutexFor` import (`:141-154`) and use `serializeHandle` from `@kumiai/mls/testing` for every serialized override;
  - `bootstrapLedger` (`:596-604`) and its `processMessage` override both run under `serializeHandle`, and pass the holding token to `persist(this, { holding })` as the real ones do (Sonnet M-r9-4). That is stricter, and gives parity.

- [ ] **Step 1: Write failing tests** (real MLS; double parity in the mls-rpc file):
  - `no policy sends`; `denied refuses before consuming`; `bound limit admits below only`.
  - `deny is irreversible`: after deny, bind throws. No export name matches `/grant|allow|unrestrict|enable/i`.
  - `bind is one-shot`; `derived handles of denied or bound handles refuse`.
  - `encryptApplication reports the wire generation`: 20 concurrent calls return generations equal to `readSenderData` of each ciphertext, distinct and contiguous. Mutation check: read the generation before the mutex.
  - `reserveApplicationRange` (on a private denied handle):
    - It refuses an undenied handle.
    - With `floor` 0 it returns `start` 0, `limit` 16, `pre` at 0 and `advanced` at 16. `advanced`, restored into a fresh test handle, encrypts at 16 (Codex r7 #6).
    - `floor` 40 gives `[40, 56)`. `cap` 500 gives `[490, 500)` from 490 and `null` from 500.
    - It refuses with proposals, when lapsed and when removed, leaving the state unchanged.
  - `exclusive transfer waits for any holder`, both modes, using barriers:
    - an admitted encrypt blocked mid-sign (real mode wraps the signer in the test's restore adapter; otherwise same-tick ordering after admission);
    - an unrelated `bootstrapLedger` that later rolls back (Codex r9 #1);
    - a concurrent decrypt (Sonnet r9 I-1).
    - In each case, `relinquishSend` resolves only after the holder finishes, and its captured bytes reflect the post-holder state. A private restore of them reserves above every generation the caller used.
    - `relinquishSend` calls no mutating method on the caller's object: a spy proxy over its mutating methods sees no call.
    - Mutation "deny without acquiring": a duplicate or a torn capture.
    - Mutation "skip the wait without a token": the bootstrap-rollback ordering captures rolled-back state.
  - `holding token`, both modes:
    - Inside `bootstrapLedger` persist and inside `processMessage` persist, `relinquishSend(this, { holding })` returns without waiting, and a reservation on a private restore of its bytes completes.
    - Without the token, the same call deadlocks, detected by a bounded fake timer (mutation and negative test).
    - A token used for another handle, or after its callback returned, throws `TypeError`.
  - `double shares the built serializer`: a double encrypt held at a barrier makes the built `relinquishSend` wait. Mutation: restore the source-module import; the transfer no longer waits.
  - `readSenderData peeks without consuming`: on peer frames and own frames. Junk, and 4-byte sender plaintext, give `null`. A missing key throws `CommitValidationUnavailableError`.
  - Parity: the double refuses, reserves and peeks identically, with the same encoded generation.
  - Mutation checks: the deny branch; derive propagation; the double's `stepRatchet` in the reserve kernel; token validity.
- [ ] **Step 2: RED.** `kbuild && ktest @kumiai/mls test/send-policy.test.ts`.
- [ ] **Step 3: Implement** with one module `WeakMap<GroupHandle, { kind: 'denied' } | { kind: 'bound'; limit: () => number }>`.
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls && ktest @kumiai/mls-rpc test/sealed-memory-send-parity.test.ts && kall && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls): send policy, relinquishSend, owned reservation range and sender-data peek'`.

### Task 2 (A): Reservation at every install; ownership transfer; denial

**Files:** Create `registry/reserve.ts`, `mls-rpc/test/registry-reserve.test.ts`, `mls-rpc/test/send-denial-sources.test.ts`. Modify:
- **`recordFor` (`access.ts:202-227`)** becomes async. It takes the `Relinquished` capture, not the caller's handle, and every persisted field (`state`, `ledger`, `credential`) comes from that capture.
  - A new identity calls `reserveFromBytes(environment, { ...record, state: captured.state, senderHWM: 0 }, 0)`: one extra private restore per installation. It persists the private handle's `advanced` bytes exactly.
  - A same identity persists `captured.state` unchanged. It performs one private restore, because derivation from the capture alone needs it (Codex r11 m2).
  - **Read nothing but the capture** (Sonnet I-r10-1). After transfer, every derived value comes from the registry-private restore of the captured bytes: `validateRegistryHandle`, `staged()`, `recoveryTrustFor`, `prepareCheckpointInstallation`, the anchor secret (`exportSecret`, `switch.ts:299`), epoch, authenticator and members.
    - The caller's object is never read again.
  - A private restore failure maps exactly as a cold-load restore failure does: `GroupUnavailableError({ reason: 'invalid' })`, with the same latch, so a restart fails the same way. The write is refused, and the caller's handle stays denied (Sonnet M-r10-3, M-r11-2).
  - Callers `await` it, including app-open (`app-open.ts:188`). The access method wraps the saved record and its version in a frozen `ReservationEnvelope`.
- **Ownership transfer** (S1 b, Codex r7 C1, r9). `const captured = await relinquishSend(input, { holding })` is the first statement touching each caller-supplied handle, before any validation, comparison or encoding. It is exclusive unless `holding` is the token mls supplied to the current persist callback. The token travels in one shared optional `PersistContext` type (Codex r10 #2, Sonnet M-r10-2) through:
  - `HandleAccess.mutate`'s `persist: (handle, ctx?: PersistContext) => Promise<void>` (`mls-rpc/src/access.ts:38-40`), and simple access (`:144`), which ignores it;
  - `registry-handle-access.ts:14` and registry `access.ts` `persist`;
  - `ApplyCommitParams.persist` (`apply-commit.ts:17-24`) and its wrapper (`:132`), plus `mls.ts:985`;
  - the fixtures `transactional-access.ts:468` and `sealed-control-access.ts:172`, the conformance doubles in `rpc-conformance/src/{registry,safety}.ts`, and `rpc-conformance/src/registry-fixture.ts:102-103` (`ConformanceRegistryAccess.mutate`; Codex r11 m1).
  The acceptance paths are:
  - **seed:** at entry, before `judge` (`seed.ts:~200`), so every exit, including `alreadyJoined` and refusals, leaves it denied (Sonnet M6). Then `:293` uses `reserveFromBytes` on the capture with floor 0, instead of encoding `group`. `:338` writes `senderHWM: reservation?.limit ?? own`. Validation at `:238-244` runs on the private restore;
  - **switch:** the candidate, before `:285`, then `reserveFromBytes` with floor 0, so the new incarnation inherits nothing;
  - **`ordinary`/`replace`/`adopt`:** the caller's `next`, at entry (`access.ts:392-400,666-683`), before `destinationFor` (`:284`) and the comparison (`validation.ts:183`). The restored destination is relinquished too;
  - **`persist(candidate)`:** the candidate, at entry (`:548`), before `adoption?.(staged(candidate))` and before a journal destination is substituted (`:566-586`);
  - **app-open:** the handle passed to `recordFor`.
  - **Revalidation:** after relinquishing, the existing checks rerun on drained state. That includes the full `ordinaryCandidateMatches` comparison (`validation.ts:183`) of `next` or the candidate against a substituted destination. The separate generation-equality guard of revision 8 is dropped (Codex r8 #4, Sonnet M-new-2).
  - Registry inputs are control-build clones or fresh restores, which never send, so legitimate flows never diverge.
  - **Holding callbacks.** `persist(current, { holding })` arrives inside `bootstrapLedger` (`mls.ts:984`) or `processMessage` (`apply-commit.ts:130-140`). Those two call sites forward the token, and only the token skips the wait.
    - For an incoming commit, the capture happens inside `processMessage`'s callback. The new-identity reservation runs on a private restore of the captured bytes, with `start` at the new epoch's own generation. That is the normal install path (Sonnet r8 C1).
    - Every other path (seed, switch, `next`, a substituted destination, app-open) is exclusive.
- **Mutating calls removed:** revision 9's in-place advance of `group` (seed), `candidate` (switch) and `persist` candidates is gone. A test-only spy proxy over every caller-supplied handle asserts that, after `relinquishSend`, the registry makes **zero reads and zero calls** on it (the `relinquish-isolation` test).
- **Other denial (hygiene, S7):**
  - `access.ts:284`; `control-build.ts:337` and its permit restore closure (`:312-319`, every host);
  - `control-validation.ts:110,198,253`; `registry-group-mls.ts:347`;
  - `mls.ts:807,898` and `recovery.ts:290,495,604` when registry-backed (`denySend` flag).
  - `control-adoption.ts` is unchanged: registry `replace` covers registry adoption, and simple hosts keep sending.
  - `cold.ts:56,147` is denied in Task 5.
- **`rpc-conformance/src/group-storage.ts`:** add a row refusing a same-epoch own application generation regression, on every provider.
- **Test migrations** (I7). Find them with `rtk proxy grep -rln "\.seed(\|switchIncarnation(" packages/*/test packages/rpc-conformance/src tests/integration/test`: 38 files at baseline. Each test that encrypts with, or compares against, a seeded or switched input handle switches to `restoreCommittedSender` (the raw-key exception, test-only), or to bytes read back from storage. Also migrate the pinned `senderHWM: 0|1` values. Record the migrated file list in the commit body.

The hand-off is not consumed until Task 3. Until then a reservation only advances stored state, which is safe: generations are wasted, never reused.

- [ ] **Step 1: Write failing tests:**
  - `registry-reserve.test.ts` (real and double):
    - each install advances stored state by 16: seed, Welcome seed, switch, incoming commit (mutate), control adoption (replace), registry-backed recovery adoption;
    - ineligible installs (lapsed, removed, pending proposal) commit without a reservation;
    - legacy lag is lifted for the same identity; a new identity starts at 0 even when the old epoch's `senderHWM` was 480 (M5); a new incarnation inherits neither (spec:622);
    - the 500 cap; same-identity writes never regress;
    - raw restore after an install encrypts at 16 or beyond.
  - **Ownership transfer (S1 b), both modes:**
    - **Already admitted.** An encrypt admitted and blocked mid-sign on each input runs into acceptance. The inputs are: the seed input; the switch candidate; `replace` next with a substituted journal destination; a persist candidate with a substituted destination; a same-identity `persist` candidate; the app-open handle. Acceptance waits for the encrypt, then either reserves above its generation or refuses `moved` on divergence. No generation appears twice across caller and copy frames.
    - **Started later.** A caller send started during the reservation is refused, for committed, rolled-back and unresolved-proof outcomes.
    - Mutations: deny without draining; relinquish after the comparison; weaken `ordinaryCandidateMatches` to ignore the epoch authenticator. Each produces a duplicate generation or a missed refusal.
  - `incoming commit installs through processMessage persist and reserves`, real and double: stored generation 16, hand-off `[0, 16)`, no hang. Mutation: drop the token forwarding in `apply-commit.ts`; deadlock on a bounded timer.
  - `concurrent decrypt at a barrier during seed and replace` (Sonnet r9 I-1): the transfer waits for the decrypt; stored generation equals the copy limit.
  - `relinquish-isolation`: for seed, switch, `replace`/`adopt` next, persist candidates and the incoming-commit callback handle, a proxy records zero property reads and zero calls by the registry after transfer.
    - Mutations: reserve on the caller handle; derive `staged()` or the anchor secret from the caller handle. Each fails.
  - `caller applies a commit concurrently on its own handle after transfer` (Sonnet I-r10-1): the saved record, trust, checkpoint and anchor all match the captured epoch, never the caller's newer one.
  - `private restore failure refuses the install` (Sonnet M-r10-3): an injected restore failure gives `GroupUnavailableError('invalid')` with the cold-load latch, for seed, switch, `replace` and an incoming commit via `processMessage` persist. Nothing is saved, the caller's handle is still denied, and a restart fails the same way (M-r11-2).
  - `persist context threads the token` through simple access (ignored), registry access, apply-commit and `mls.ts`, and through both fixtures. Mutation: drop the forwarding in `registry-handle-access.ts`; the incoming-commit test deadlocks on a bounded timer.
  - `private restore count`: `restores()` +1 per install and +1 per same-identity write (Codex r11 m2).
  - `unrelated bootstrap rollback during replace` (Codex r9 #1): ordered so the bootstrap's rollback lands between the transfer request and the capture. The transfer waits, and the persisted `advanced` bytes reflect the post-rollback state at `limit`.
  - `bootstrapLedger through mls.ts completes` with a registry host.
  - `send-denial-sources.test.ts`:
    - every registry source refuses `encrypt` and `bindSendCeiling`;
    - every seed exit (`alreadyJoined`, refusal) leaves the input denied;
    - simple hosts (`read`/`mutate`/`replace(next)`, fresh and restored recovery, normal control adoption fresh and restored) each send afterwards.
  - Mutation checks: the reservation in `recordFor`; the `senderHWM` lift; the new-identity floor 0; the seed entry relinquish; the permit-closure denial; the `ordinary` next denial; the registry-backed recovery denial.
- [ ] **Step 2: RED**, **Step 3: implement and migrate.**
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc && kports && kall && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls-rpc): relinquish inputs and reserve at every install'`.

### Task 3 (A): Send copy, reservation maintenance, seal, lifecycle

**Files:** Create `registry/live-send.ts`, `mls-rpc/test/registry-live-send.test.ts`, `mls-rpc/test/fixtures/registry-lease.ts`. Modify:
- `registry/access.ts` (owner fields; accept);
- `registry/registry.ts`:
  - forward `seal`/`onRotationRequired`;
  - `GroupSlot.pendingHandoff`;
  - `load()` consumes it and schedules warm-up;
  - the observation `:208-267`;
  - the retirement drain `:289`;
  - `dispose`;
- `registry/types.ts`, `mls-rpc/src/testing.ts`, `rpc-conformance/src/persistence-fixture.ts`.

**Rules:**
- **Accounted versions (I1).**
  - `owner.knownVersion` is the highest stored version the owner has validated or committed. Any registry write saving `v` registers `expected.set(v, record)` in prepare (observation classification only; its cleanup is unchanged) and raises `knownVersion` on proof.
  - An observation is **foreign** only if `activeVersion > knownVersion` and `!expected.has(activeVersion)`. Equal or lower versions are no-ops, which covers control, cursor, outbox and pending writes.
  - A foreign version drops `send`, raises `knownVersion`, schedules warm-up, and (Task 4) clears the receive base.
  - Expected entries (`pendingOwnVersions`) are kept until `resolve()` answers. An unknown-outcome commit that is later proven is therefore still classified as own. They are deleted on `committed` or `rolled-back` (Sonnet M-r11-1).
- **Accept** (the only writer of `send.limit`, S1 a). A reservation is accepted after `run` resolves, or after `resolve(mutationID) === 'committed'`. Otherwise it is discarded. Requirements:
  - the owner is current; `owner.key`/identity equals the reservation's; the reservation's `envelope.version` was registered in `pendingOwnVersions` and its commit was proven by `run` or `resolve()`; and no foreign version was observed since its prepare (Sonnet M2);
  - **S1 (a) directly:** `reservation.limit <= ownApplicationGeneration(decode(provenRecord.state))`, where `provenRecord` is `reservation.envelope.saved`, retained immutably with the reservation through proof resolution and acceptance and independent of the `expected` map (Codex r10 #1, Sonnet M-r10-1). Otherwise refuse and drop the copy;
  - `reservation.eligibility` equals `eligibilityOf(owner.latestCommitted.state)` (Codex r8 #1, Sonnet M-new-3). Receive-only own writes leave it equal and still accept; an own proposal, a lapse or a control change refuses;
  - this is rechecked after the async `environment.restore(pre)`, under the same owner-generation check that invalidation bumps, and the copy is discarded if anything moved;
  - if `send` exists with that identity:
    - `start === send.limit` with the same eligibility: set `send.limit = limit`;
    - `start > send.limit`: replace from `pre`;
    - otherwise refuse and drop `send` (M12);
  - building a copy: `environment.restore(pre)`, `restrictCommitAuthoring`, then `bindSendCeiling(copy, () => record.limit)`, where `record` is that copy's own send object, never `owner.send`. Assert `ownApplicationGeneration(copy.state) === start`, else discard.
- **Seed and switch hand-off (I3).** After proof, set `slot.pendingHandoff`.
  - `load()` accepts it directly when the identity matches, `loaded.version === envelope.version`, and the stored state bytes equal `envelope.saved.state` (Sonnet M-r11-3).
  - A larger same-identity version falls through to the eligibility check and `limit <= ownApplicationGeneration(loaded state)`. Any difference drops it. It is cleared in all cases.
  - Mutation: skip the byte comparison; a test with an equal version and different bytes fails.
  - It is also cleared by retirement, delete, dispose, a later install, or an observation with `activeVersion > pendingHandoff.version` for the same incarnation that the registry is not committing itself (Sonnet M3). Equal-version control or cursor observations keep it.
- **Drop** (`send = null`): owner drop or swap; identity change; an own same-identity write whose `eligibilityOf` differs; a foreign version. Receive-only own writes keep the copy.
- **Maintenance.** One in-flight job per owner, outside every lock and gate.
  - Scheduled by `seal`, owner `load()` when admissible and copy-less (M11), and a foreign version.
  - It re-checks need first (M7): no-op if a copy with 4 or more remaining exists, or if `effectiveNext >= 500`. It is not scheduled at all once the committed `max(own, senderHWM) >= 500` (Codex r7 #5), or for a deleted, retiring or non-admissible group.
  - One `capability.run`: prepare loads and restores; ineligible → record `deferred`; otherwise `reserveFromBytes(environment, record, record.senderHWM)` (the stored record's bytes; the private restore is the only handle advanced). Work runs `assertWorkSafety`, then saves.
  - Accept as above. Backoff 100 ms → 15 s. `close` and retirement cancel it.
- **`seal(plaintext, { aad, intent })`**, registered in `slot.live.inflight`:
  1. `assertAvailable()`.
  2. AAD intent mismatch → `TypeError`.
  3. Safety latch → `GroupSafetyHeldError`.
  4. Admission not admissible → `SendNotAdmissibleError(reason)`.
  5. No copy, or copy exhausted: schedule maintenance.
     - `ephemeral` throws at once: `'deferred'` if the last attempt was ineligible; otherwise `'cold'` with no copy or `'exhausted'` with an exhausted copy.
     - `log` waits up to `LEASE_AWAIT_MS` for the job (no lock or lane held; aborts at retirement start), then retries once (Codex r6 #4).
  6. `{ ciphertext, generation } = await copy.encryptApplication(plaintext, { aad })` (I6).
  7. Recompute `effectiveNext`, success or failure. Below 4 remaining, schedule maintenance. Return `{ ciphertext, epoch, generation }`.
- **Retirement and dispose.** Drain `capability.read(...)` plus `Promise.allSettled(slot.live.inflight)`; `assertAvailable` refuses from drain start; rollback resumes. `dispose` and the `failureSignal` abort cancel maintenance, drop copies and clear `pendingHandoff`.

- [ ] **Step 1: Write the fixture and failing tests** (both modes):
  - `install hand-off seals with zero transactions`, per source (seed, Welcome, switch via `pendingHandoff`, incoming commit, adoption): 12 seals give 0..11.
  - **S1 (a)**: after every install, renewal, owner drop and restart, `lease().limit <= storedGeneration()` and `rawRestoreEncrypt() >= lease().limit`.
    - Mutations: accept before `run` resolves with an injected rollback; accept on a rolled-back `resolve`; persist `pre` instead of `advanced` (the acceptance check refuses). All fail.
    - Mutation: remove the acceptance check while persisting `pre`; the S1 test fails.
  - `restart wastes, never reuses`: seal 5, `reopen()`, `sealDurable` succeeds at 16 with no manual drain (the bounded wait). All frames open once.
  - `owner drop`: the ephemeral seal is `'cold'`; the owner reload schedules warm-up; after `drainMaintenance()` the next seal gives 16.
  - `failed encrypt before and after consumption`: frames stay unique.
  - `renewal extends in place` (the copy object is unchanged; only the maintenance transaction's private restore counts); `renewal with start below the old limit is refused and drops the copy` (forced). Mutation: drop the `start >= limit` check.
  - `accounted versions`: `writeElsewhere('control')`, `writeElsewhere('cursor')`, a `pending.complete` and an own `openDurable` each keep the copy. `writeElsewhere('receive')` and `writeElsewhere('proposal')` drop it. Mutation: classify equal versions as foreign.
  - `eligibility change drops the copy`: an own durable proposal. Mutation: skip the eligibility compare.
  - `own write between proof and accept keeps the renewal` (Sonnet M2): an `openDurable` lands between a renewal's proof and its continuation, and the copy is still extended. Mutation: require version equality.
  - `foreign write between proof and accept discards it`.
  - **Envelope:**
    - `settlement cleanup`: `expected` is cleared when `run` settles, yet the reservation still accepts from its envelope.
    - `delayed committed resolution`: `run` rejects and `resolve(mutationID)` later says committed; accepted from the envelope.
    - `seed/switch hand-off with no owner`: the envelope travels in `pendingHandoff` and is checked at `load()`.
    - `own receive write between proof and accept` accepts.
    - Mutations: replace the envelope's `saved` with `pre` (S1 check refuses); delete the envelope before accept (accept refuses). Both fail their tests.
  - `own proposal between proof and accept refuses it` (Codex r8 #1): no copy; seal gives `'deferred'`; no generation is used while the proposal is pending. Mutation: skip the eligibility compare at accept.
  - `invalidation during the async restore discards the new copy`.
  - `pendingHandoff survives a control write before access()` (Sonnet M3): seed, `writeElsewhere('control')`, then `access()`; the first seal has zero transactions. It is refused for a mismatched identity and cleared by delete. Mutations for each.
  - `replaced copy keeps its own limit` (Sonnet M5): a seal holding the old copy, blocked in `encryptApplication`, is refused at the old limit after a replacement raises the new copy's limit. Mutation: bind `() => owner.send.limit`.
  - `no maintenance on the final lease` (Codex r7 #5): from stored 500 with a copy at 497, seals to 499 make zero transactions.
  - `deferred states`: pending proposal and suspended give `'deferred'`; removed gives `terminal`; lapsed gives `lapsed`. No stored advance.
  - `concurrent cold seals schedule one reservation`; `parallel seals report distinct contiguous generations`.
  - `ephemeral rejects at once; durable waits` (`blockMaintenance`); `maintenance re-checks need` (a second schedule with a healthy copy makes no transaction).
  - `safety hold` (I9): `holdSafety('fork-halted')`, then `seal` throws `GroupSafetyHeldError`, live and after `reopen()`. Mutation: drop the latch check.
  - `lease wait aborts on retirement start`; `retirement waits for live work`, including a `receive` queued on the slot lock that rechecks availability after acquiring it (Sonnet M9, completed in Task 4); `dispose drains`.
  - `durable wait holds no lane`; `host callbacks never receive the copy` (`isLiveHandle`).
- [ ] **Step 2: RED**, **Step 3: implement.**
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc && kports && kall && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls-rpc): send copy limited by committed reservations'`.

### Task 4 (A): Live receive side and ephemeral consumed set

**Files:** Create `registry/live-receive.ts`, `mls-rpc/test/registry-live-receive.test.ts`. Modify `mls-rpc/src/crypto.ts:332-352` (factor out `assertOpenableEpoch`), `registry/registry.ts` (forward `receive`; `GroupSlot.live`), `registry/access.ts` (own committed records set `base` after proof), and the fixture (`openEphemeral`, epoch and peer helpers).

**Rules:**
- **Base.** `load()`, own committed writes (after proof; never older than the current base) and the cold refresh set `live.base`. A foreign version (Task 3 rule) clears it and schedules a cold refresh.
  - The cold refresh is gated on receive lifecycle and safety, not on send admission.
- **Receive handle.** It is `environment.restore(base)`, then `restrictCommitAuthoring` and `denyApplicationSend`. It is rebuilt only when `sha256(receiveProjection(base.state))` differs from `receiveDigest`. A reservation therefore keeps it; a durable open rebuilds it (Codex r6 #7, Sonnet I5).
- **Serialization (Codex r6 #3, I4).** `receive` holds `slot.live.lock` for the whole call: base selection, rebuild, and every frame's check, decrypt and add. Handle mutexes alone are insufficient.
- **Consumed set.**
  - It is per incarnation on `GroupSlot` and survives owner drops and same-incarnation identity changes.
  - Epochs not retained by the new base are pruned.
  - The cap is `members × 500 × retainedEpochs + 1_024`. While over it, the oldest non-current epoch is closed. A current epoch at the cap refuses `capacity`.
  - A new incarnation clears it.
- **`receive(frames)`**, under the lock:
  1. More than 64 frames → `RangeError`. Acquire the lock, then run `assertAvailable` and the safety latch **after** acquiring it (Sonnet M9).
     - No `base`: schedule a refresh, release the lock, and wait once, bounded by `LEASE_AWAIT_MS` and aborting at retirement start (Sonnet M6). Then reacquire and recheck. If there is still no base, throw `'cold'`.
  2. Per frame, the first refusal wins and no refusal touches state:
     1. log intent;
     2. `expectedAAD` (required) differs from the clear AAD → `invalid`;
     3. epoch gate;
     4. `closed-epoch`;
     5. `readSenderData` null or throwing → `invalid`;
     6. generation ≥ 500 → `generation-bound`;
     7. `consumed`;
     8. `capacity`;
     9. `decrypt`: on success add the tuple and return `opened`; a throw gives `invalid`.
- **Durable opens** (`openBatch`) are unchanged: their own ratchet state already refuses replay. The ≥ 500 refusal is receive-only (M13).

- [ ] **Step 1: Write failing tests** (both modes):
  - `durable consumption and eviction are authoritative` (Codex r2 #3), with a mutation that skips the projection rebuild.
  - `overlapping receive across a rebuild opens once` (Codex r6 #3, I4). Receive A on frame X blocks inside decrypt. An own durable open changes the projection. Receive B on X waits, then reports `consumed`. One `opened` overall. Mutation: drop the slot lock.
  - `reservation keeps the receive handle; durable open rebuilds it`: `restores()` is unchanged after a reservation and +1 after `openDurable`. Both cases have transaction delta 0 on the following `receive`.
  - `ephemeral replay refused within the process, including across owner drop`; accepted once after a restart.
  - `cold receive needs no send eligibility` (pending proposal; lapsed own leaf).
  - `foreign write clears the base and refresh restores it`; `lapsed group refreshes its cold base`.
  - `first receive after reopen waits for its refresh and opens` (no manual drain), and `cold receive wait aborts on retirement start`.
  - `receive queued behind the lock rechecks availability`: a retirement started while it waits makes it refuse. Mutation: check only before acquiring.
  - `unchanged version keeps the base`: control and cursor writes. Mutation: equal is foreign.
  - `safety hold`: `receive` throws `GroupSafetyHeldError`, live and after `reopen()`. Mutation: drop the latch.
  - `zero transactions and exact counts`; `consumed bound` (cap injected as 4); `generation bound`; `wrong AAD reports invalid whether consumed or not`; `missing-key sender data maps to invalid`; `log-intent refused without consuming`.
- [ ] **Step 2: RED**, **Step 3: implement.**
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc && kports && kall && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls-rpc): serialized private receive with ephemeral consumed set'`.

### Task 5 (A): Registry crypto over the narrow API

**Files:** Modify:
- `mls-rpc/src/registry-crypto.ts:39-68`; `crypto.ts:332-352`;
- `registry/cold.ts:56,147` (`denyApplicationSend`, in this commit);
- `mls-rpc/test/fixtures/registry-crypto.ts` (port rows call `wrap`/`unwrap` right after create and advance; they rely on the install hand-off and the bounded log wait);
- migrate `mls-rpc/test/registry-crypto.test.ts:557-575`, `rpc-conformance/src/registry.ts:425-445`, and other encrypts on access handles (`rtk proxy grep -rn "advanceSender\|\.encrypt(" packages/mls-rpc/test packages/rpc-conformance/src`);
- `mls-rpc/README.md`: "every handle the registry hands to host code is send-denied".

**Interfaces:**
- `wrap(bytes, opts)` = `(await access.seal(bytes, { aad, intent: decodeAppAAD(aad)?.intent ?? 'ephemeral' })).ciphertext`.
- Frame-less `unwrap` = `access.receive([{ ciphertext, expectedAAD: opts?.expectedAAD ?? readMessageAAD(bytes) ?? new Uint8Array() }])`. It forwards the port's `expectedAAD` (`rpc/src/crypto.ts:78`). With no expectation it keeps today's permissive behaviour by comparing against the frame's own clear AAD (Codex r7 #3, Sonnet M1):
  - `opened` with a sender → `{ payload, senderDID, epoch: handleEpoch }`;
  - `opened` without a sender → `Error('unwrap: opened frame has no authenticated sender')`;
  - epoch refusals → `FrameEpochError`;
  - `invalid` → rethrow `error`, or `Error('unwrap: invalid app frame')` when there is none;
  - other refusals → `Error('unwrap: app frame refused (<reason>)')`.

- [ ] **Step 1: Write failing tests:**
  - narrow API only (`seal` 1, `receive` 1, `mutate` 0, transactions 0);
  - log-intent unwrap refuses while durable unwrap opens;
  - directed-reply AAD obeys the bound;
  - group-crypto conformance rows pass on the registry, both modes, including matching non-empty `expectedAAD`, wrong-then-correct AAD, and a malformed frame (`group-crypto.ts:112,404`);
  - an AAD-carrying frame opened with no expectation still opens; an `invalid` result without an error throws the fallback;
  - `send-denial-sources` gains `read`, `mutate` and `readControl`;
  - `every handle handed to host code is denied`. Mutation: drop the `cold.ts:56` denial.
- [ ] **Step 2: RED**, **Step 3: implement.**
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc && ktest @kumiai/integration-tests && kports && kall && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls-rpc): registry crypto over byte-level seal/receive'`.

### Task 6 (A): Effective-next rotation-required, GroupMLS overlay, handoff

**Files:** Modify:
- `registry/registry.ts:386-390`: overlay `rotation-required` when the base admission is admissible and `effectiveNext(key) >= 500`. `effectiveNext` is the copy's own generation, else the committed `max(own, senderHWM)`;
- `registry/types.ts` (`effectiveNext`);
- `registry-group-mls.ts:122-133`: `cache` applies the overlay to every admissible input (all three ingresses);
- `registry/live-send.ts`: after every encryption (success or failure), copy loss and accept, recompute effective admission.
  - On any change, in either direction, emit `onAdmissionChanged`. The GroupMLS listener calls `cache(value.admission())`, so memory-only progress, and an accept that restores headroom, reaches the cache despite `runtime.ts:106` (Codex r7 #2).
  - Separately, notify `onRotationRequired` once per identity when the effective next reaches 500;
- `registry-peer.ts:519-523`: ignore `rotation-required`;
- `rpc/src/log-delivery.ts:24-33,126,157,181`: optional `handoffHeld`, default `held`;
- `rpc/src/peer.ts:934-944` (supply it), `:988-992`.

Create `mls-rpc/test/registry-rotation-admission.test.ts` and `rpc/test/lease-handoff.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - mls-rpc, through the real registry and `createRegistryGroupMLS`:
    - `final lease is usable`: from `forceStoredGeneration(480)`, seals reach generation 499 while admissible. Seal 499 flips GroupMLS admission, and acceptance then refuses;
    - a failed encrypt at 499 flips it too;
    - `cold final range reopens GroupMLS` (Codex r7 #2): reopen at stored 496 with no copy, and maintenance commits `[496, 500)`. The observation caches `rotation-required`; the accept then restores headroom. GroupMLS admission is admissible with no further storage operation. Mutation: drop the accept-side `onAdmissionChanged`;
    - `restart at stored 500 without a copy` is `rotation-required`, not recovery-only;
    - copy loss at stored 500 flips;
    - lapse takes precedence;
    - a control-only provider write cannot reopen acceptance;
    - the listener fires once per identity and replays to late subscribers; a new epoch clears it;
    - a rotation-required group still refreshes its cold receive base;
    - mutation checks: the `cache` overlay; the post-failure recompute.
  - rpc:
    - a frame sealed at 499 through the real registry publishes; a resend publishes;
    - `admission flips between snapshot and seal` (Sonnet M-new-4): the GroupMLS admission flips to `rotation-required` after the outbox snapshot and before the moved check at `peer.ts:988-992`, and the sealed frame still publishes;
    - the next acceptance refuses;
    - accepted entries hold, then resume after the epoch changes;
    - mutation-check `:126`, `:157` and `:181` separately.
- [ ] **Step 2: RED**, **Step 3: implement.**
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc && ktest @kumiai/rpc && ktest @kumiai/integration-tests && kports && kall && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat: effective-next rotation-required admission with sealed-frame handoff'`.

### Task 7 (A): Auto-rotation with internal outcomes

**Files:** Create `mls-rpc/src/auto-rotation.ts`, `mls-rpc/test/auto-rotation.test.ts`, `rpc/test/enqueue-idempotent.test.ts`, `rpc/test/internal-outcomes.test.ts`. Modify:
- `control-build.ts:201-216,317-319` (`rotate?`, used iff `isAutoRotation(op)`);
- `rpc/src/control/operations.ts:55-69` (idempotent on id);
- `rpc/src/peer-types.ts`;
- `rpc/src/peer.ts`:
  - public `enqueue` (`:3796`) refuses the prefix; its body moves into a private `enqueueChecked` (same safety, `recoveryOnly`, `ready`, `assertLive`, `runSerial`, `scheduleOperations`); construction calls `params.internalOperations?.bind(...)`, accepting prefixed ids only;
  - **Emission boundary (Codex r6 #5).** `emitOutcome` (`:2690`), used by ordinary settlement and by `refreshControl` replay (`:2712`), routes prefixed outcomes away from `hostOutbox`. It pushes them to an internal queue drained **outside the serial lane**. Each item runs `applyResolved(control, { deleteOutcomes: [id] })`, then `internalOperations.onOutcome(outcome)`. `outcomes()` (`:3832`) also skips the prefix;
- `registry-peer.ts` (one scheduler per peer; `stop()` on swap and dispose);
- `rpc/test/fixtures/peer.ts`, a shared file: Lane A adds `internalOperations` wiring only, and C1's authoring edits merge at the merge point (Sonnet M-r9-3);
- `sealed-memory-mls.ts:968-1015`; `storage-persistence.ts:1030,1145`; `mls-rpc/src/index.ts`.

**Rules:**
- `autoRotationRequest` sets `revokes: false` (M1).
- `buildKeyRotation` guards throw `OperationRejectedError` before construction: superseded identity, unapplied proposals, not active, not admissible **except `rotation-required`** (M10). The double applies the same guards.
- **Scheduler**, per identity while `rotation-required`:
  - triggers: `onRotationRequired`, startup, `onOutcome` for its id, and runtime changes;
  - enqueue if no operation is live;
  - `lost` → enqueue again;
  - `rejected`, and enqueue errors, back off 250 ms → 15 s (cap) and reset on any runtime or eligibility change (Codex r6 #6);
  - `unknown` → wait for a runtime change or the probe;
  - the probe runs at most every 15 s while active and idle;
  - it stops on identity change, swap or dispose.

- [ ] **Step 1: Write failing tests:**
  - enqueue is idempotent on id.
  - Internal outcomes:
    - ordinary `landed` and `lost` settlements reach only `internalOperations.onOutcome`, never host `onOutcome` or `outcomes()`;
    - the row is deleted before the callback;
    - an enqueue from inside the callback does not deadlock;
    - restart replay after the operation row is gone happens once and never reaches the host;
    - a prefixed host enqueue and an unprefixed internal enqueue each give `TypeError`;
    - a disposed or recovery-only peer refuses;
    - mutation: remove the central prefix guard in `emitOutcome`.
  - Auto-rotation:
    - a non-admin rotation lands; its request has `revokes: false`;
    - the guards (real and double, each mutation-checked); a `rotation-required` group passes the guard;
    - a built loser settles `lost` and an unbuilt stale intent `rejected`;
    - reopen at 500 rotates via the internal enqueue with zero public `enqueue` calls;
    - `persistent proposals back off` (fake clock): attempts are bounded while proposals stay unchanged, then the rotation lands after they clear. Mutation: remove the rejected backoff;
    - an enqueue failure recovers; a lost outcome re-enqueues;
    - a withheld commit leaves only `rotation-required`, with no hold;
    - the host sees no auto-rotation outcome; the new epoch reserves `[0, 16)`.
- [ ] **Step 2: RED**, **Step 3: implement.**
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc && ktest @kumiai/rpc && ktest @kumiai/integration-tests && kports && kall && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat: any-member auto-rotation with internal outcomes'`.

### Task 8 (A): Lease and ephemeral contract suite

**Files:** Create `rpc-conformance/src/registry-lease.ts` and `mls-rpc/test/registry-lease-conformance.test.ts`, covering `['real-mls', 'double']` × ownership context supplied and absent (as `branch-history.test.ts:31`). Modify `rpc-conformance/src/index.ts`.

Rows (spec:1934, 1935, 1938, 1845):
- `S1 holds`: (a) after installs, renewals, owner drops, failed encryptions and restarts; (b) a blocked caller send during reservation is refused. Every published frame opens exactly once.
- `committed reservation before seal is skipped`.
- `lapsed, removed, suspended, pending proposal defer without blocking control or receive`.
- `safety holds block seal and receive, live and after restart`.
- `500 bound: final lease usable to 499, then reject, hold, resume`.
- `forward window covers the bound`.
- `1000 retention and forward window through create, restore, Welcome, external join, derive and recovery`, with real/double parity. `Ordinary adoption preserves sender and receive history`, with no evicted epoch resurrected (spec:1935, M9).
- `ephemeral persists nothing` (8 sealed, 8 opened, directed-reply AAD, delta 0, rows unchanged).
- `durable eviction is authoritative for ephemeral receive`, plus the foreign-write variant.
- `overlapping receives open once`.
- `receive refuses generations at or above 500 and keeps the consumed set under its cap`.
- `exhausted copy rejects without a transaction`.

- [ ] **Step 1: Write the rows.** **Step 2:** `kbuild && ktest @kumiai/mls-rpc test/registry-lease-conformance.test.ts`. A failing row is fixed in its owning task. **Step 3:** `kports && kall && kfinish`. **Step 4: Commit.** `git commit -m 'test(conformance): reservation and ephemeral rows on registry real and double'`.

### Task 9 (B): Lift MLSEncryptor into mls-rpc

**Files:** Create `mls-rpc/src/mls-encryptor.ts` and `mls-rpc/test/mls-encryptor.test.ts`, porting kubun `mls-encryptor.test.ts` and `mls-encryptor-multi.test.ts` onto the Task 4 fixture, both modes. Modify `mls-rpc/package.json:38-45` and `pnpm-lock.yaml`.

**Interfaces** (spec:1727-1735):
- `encrypt`: kubun frame tracking, then `(await access.seal(plaintext, { aad: new Uint8Array(), intent: 'ephemeral' })).ciphertext`.
- `decrypt`: kubun dedup, microtask flush and chunks of 64. It calls `access.receive(chunk.map(c => ({ ciphertext: c, expectedAAD: new Uint8Array() })))`.
  - Each `opened` result is checked for sender versus `peerDID`, membership in `runtime.snapshot()?.members`, frame decode, and staleness (an outstanding dialer reply only).
  - A non-`opened` result rejects its item. `accepted` is the count of `opened`.
- `watchPeerRemoval(dispose)`:
  - It closes immediately on an initial `null`, `!available`, or a missing peer.
  - It closes once on `null`, `!available`, a missing member, an incarnation change, `epoch > observed + 1`, or a throwing check.
  - Same epoch → keep; `+1` → advance. It returns an unsubscribe function.

- [ ] **Step 1: Port the failing tests**, adding:
  - accepted counts opened frames, including malformed plaintext;
  - decrypt opens no transaction;
  - a same-epoch unavailable snapshot closes once, and an initially unavailable one closes immediately;
  - a version-only change keeps;
  - a sequential rotation keeps (`advanceEpoch`), while a jump (`jumpEpochs(2)`) or a switch (`switchIncarnation`) closes once;
  - a removed peer (`removePeer`) closes once;
  - encrypt at the bound **rejects** (assert refusal only; the error class changes in Task 6, Sonnet M7);
  - mutation: drop the `available` check.
- [ ] **Step 2: RED**, **Step 3: implement.**
- [ ] **Step 4: GREEN (Lane B gate).** `rtk proxy pnpm install --frozen-lockfile && kbuild && ktest @kumiai/mls-rpc && ktest @kumiai/hub-tunnel && kfinish`.
- [ ] **Step 5: Commit (Lane B).** `git commit -m 'feat(mls-rpc): lift MLSEncryptor over byte-level registry seal/receive'`.

### Task 10 (C1): The rpc memory model authenticates commits

**Files:** Modify `rpc/test/fixtures/memory-group-mls.ts`:
- `processCommit` (`:2247+`): verify `verifyMemoryCommitTag(commit, authenticator())` after the epoch check and before any mutation. A failure returns `{ applied: false, advanced: false, epochBefore: epoch, epochAfter: epoch, refusal: 'invalid' }`;
- `validateRecoveryCommit` (`:2221`): a failure returns `{ epoch }`;
- export `memoryAuthenticator(mls)` (`:997`).

Also modify `rpc/test/fixtures/commits.ts:68-95` (a required `authenticator`) and the 305 sites in 60 `rpc/test` files. The 12 `mls-rpc/test` importers are: `authoring-permit-callers`, `clear-hold-outcome`, `control-validation`, `hub-migration`, `manual-recovery-conformance`, `registry-app-delivery`, `registry-delivery-safety`, `registry-double`, `registry-peer`, `runtime-neutral`, `storage-codec-reopen` and `successor-recovery`, each `.test.ts`. C1 edits only the synthetic commit-authoring sites in those that author memory commits; the others match the path substring only. Lane A's lease and denial edits in the same files merge at the merge point. Fixtures `sealed-memory-mls.ts` and `storage-persistence.ts` are Lane A and are handled in Task 11.

- [ ] **Step 1:** Failing tests for both ports: untagged refused, sibling tag refused, tagged applies. Mutation-check each verify call.
- [ ] **Step 2: RED**, then migrate.
- [ ] **Step 3: GREEN (Lane C gate).** `kbuild && ktest @kumiai/rpc && ktest @kumiai/mls-rpc && ktest @kumiai/integration-tests && kfinish` (Sonnet M8: integration tests import `rpc/test/fixtures`).
- [ ] **Step 4: Commit (Lane C).** `git commit -m 'test(rpc): memory model verifies source-epoch commit tags'`.

### Task 11 (A, after merging B and C1): Sealed-memory validation authenticates commits

**Files:** Modify `sealed-memory-mls.ts:1017-1085`. Inside `check`, verify the tag against `identity.authenticator` before `processCommit`. A failure gives `{ kind: 'invalid', reason: 'policy' }` from `validateFrame` and `false` from `verifyOwn`. Migrate the remaining `FAKE_BASE_SECRET` authors in `mls-rpc/test/**`, including `storage-persistence.ts`.

- [ ] **Step 1: Merge** B and C1, then `kbuild && kgate && kall`. Record conflicts in the merge commit.
- [ ] **Step 2:** Failing tests (`control-validation.test.ts`): untagged and sibling commits are invalid in the double, with parity. Mutation-check.
- [ ] **Step 3: GREEN.** `kbuild && kgate && kall && kfinish`.
- [ ] **Step 4: Commit.** `git commit -m 'test(mls-rpc): sealed-memory validation verifies commit tags'`.

### Task 12 (A): Exports, docs, gate

**Files:** Modify:
- `mls-rpc/src/index.ts`: `MLSEncryptor` and its params, `ApplicationLeaseUnavailableError`, `SealedApp`, `ReceiveInput`, `ReceiveResult`, the auto-rotation exports;
- `mls-rpc/README.md`:
  - reservations and S1 (a) and (b);
  - the ephemeral residuals: one replay after restart; a cold ephemeral seal after restart or owner drop rejects until warm-up commits;
  - `internalOperations` forwarding;
  - the raw-key ledger: `restore` builds the copy; `restoreCandidate`, `restoreSource` and the adoption `restoreCandidate` results are denied;
  - the send-denial invariant;
- `mls/README.md`: send policy, `relinquishSend` (exclusive transfer and byte capture; the holding token in persist callbacks), `reserveApplicationRange` (private handles only), `encryptApplication`, and the `@kumiai/mls/testing` subpath;
- `.changeset/spec-p-storage-foundation.md`: a 2.3b paragraph. It covers:
  - 16 discarded encryptions per install or renewal;
  - registry **ephemeral** receive refuses legacy senders' generations at or above 500 per epoch, while durable opens are unchanged;
  - the upstream ts-mls ratchet-skip obligation (Q5).

- [ ] **Step 1: Export and document.** `readme-persistence.test.ts` must compile.
- [ ] **Step 2: Final gate (I8).** `kbuild && kgate && kall && ktest @kumiai/integration-tests && kfinish`, with `kall` reporting `Cached: 0`.
- [ ] **Step 3: Commit.** `git commit -m 'docs: 2.3b reservations, live state and MLSEncryptor'`.

## 2.3c seam (S8)

`reserveFromBytes(environment, record, floor)` runs in any transaction's prepare, on bytes the transaction already holds (stored, or relinquished):
- it reserves on a registry-private restore and never touches a caller object;
- it returns the advanced bytes and `senderHWM` for the caller's own save;
- it returns a `Reservation` the caller stamps with its saved version and accepts after its proof.

It adds no save of its own. 2.3c co-commits an attempt row and a reservation by calling it inside the attempt transition's `mutate` prepare.

## Self-review notes

- Spec coverage:
  - D5: Tasks 1-3, 6, 7.
  - Ephemeral: Tasks 3-5, 8.
  - Safety holds: Tasks 3, 4, 8.
  - Routing: Task 5.
  - Rows 1934, 1935, 1938 and seam 1845: Task 8.
  - Row 1942 (encryptor half): Task 9.
  - Obligation 2: Tasks 10-11.
- Out of scope:
  - 2.3c: attempt/reservation co-commit.
  - 2.3d: batching and handlers.
  - 2.3e: Welcome burn and restore; `backup-restored` layers onto the Task 6 admission.
  - 2.4: the buffered hub view lift.
  - Kubun's switch to the lifted class.
