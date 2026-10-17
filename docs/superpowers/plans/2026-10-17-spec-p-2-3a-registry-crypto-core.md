# Spec P 2.3a Registry Crypto Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT revision 9, 2026-10-17. Revision 9 applies `review-codex-r8.md`'s three mechanical fixes (Tasks 6, 8, interfaces). Revision 8: Folds `review-codex-r7.md` (4 Important, 3 Minor): candidate and digest checked before framing, the permit consumed before construction, app notices drained independently of `runSerial`, and expiry settled as `expired`. Revision 7 folded `review-codex-r6.md` under `controller-rulings-r0.md` ("Revision 7 rulings"). Revision 7 makes the authoring restriction sticky and inherited on every access-issued handle, and restores the permit clone from the journal's `sourceState` bytes. Revision 6 replaced revision 5's spend accounting with a commit-authoring permit checked before construction (Task 5b). Every task number is kept. Revision 4 folded `review-codex-r3.md` and `review-codex-crypto.md`, which dropped revision 3's receive-merge model. `drafter-notes.md` maps every revision.

**Goal:** Registry-backed peers open durable application frames through the registry, with one exact concurrency rule for MLS state, and with authenticated commit progress that never waits on hub-driven app work.

**Architecture:**

- **Lane A (RC1, mls-rpc):**
  - Every MLS state write, receive included, is an exact `version` CAS (`version + 1`), serialised per group by the owner entry.
  - Pending, poison and cursor writes leave the version clock.
  - An own commit is adopted when the current state is control-compatible with the commit journal's `sourceState`, instead of when it matches a freshly captured `stateVersion`. Compatibility allows extra foreign proposals (spec:576). Build retry uses the same test.
  - Private commit construction needs an authoring permit, checked in `@kumiai/mls` before construction (Task 5b). Every handle an access implementation or mls-rpc issues is permanently restricted, and so is everything derived from it. Only the durable control-build path grants a permit: on a handle restored fresh from the journal's `sourceState` bytes, for one commit, with a receipt that identifies that commit (Task 6).
  - `RegistryHandleAccess.openBatch` writes a receive save plus pending and poison rows in one transition, and a registry `createGroupCrypto` routes durable `unwrap` to it.
  - Epoch key retention is host-configurable: default 4, cap 32.
- **Lane B (RC2, rpc):**
  - App work runs entirely off the peer's serial queue.
  - Departing-epoch frames open later from retained epochs.
  - Departing anchor topics are persisted with the anchor, carry their own segment identity, and stay pulled until authenticated epochs move past retention.
  - App pulls are budgeted and cancellable, with bounded outstanding requests and bounded diagnostic state.
  - One position comparator is used everywhere.
- **Deferred to 2.3c:** the resync drain, `drainOpened` and the `switch-blocked` status.

**Tech Stack:** TypeScript, pnpm 12.10.1, Vitest, ts-mls 2.0.0-rc.13, transactional memory persistence, `@kumiai/broadcast`.

**Spec:** [Spec P](../specs/2026-10-08-spec-p-transactional-persistence.md) r24 body, plus the r25 amendments in Task 0.

Baseline: `feat/spec-p-phase-2`, HEAD `cd01adb0`. Coordinates refer to this HEAD.

Retention facts:
- ts-mls defaults are 10 generations, 4 epochs and 200 forward steps (`keyRetentionConfig.js:2-6`).
- Registry handles force `retainKeysForGenerations` and `maximumForwardRatchetSteps` to at least 1,000 (`mls-rpc/src/registry/validation.ts:21-30`).
- Registry handles check their retention against options (`validation.ts:81-89`).

## Global Constraints

Copied from Spec P r24 (`spec:N` = line):

- "The hub is blind … It may withhold, delay, reorder, replay or selectively deliver bytes." "Never derive a durable halt/hold, discard, rebuild, owed-work deletion or permanent stranding from them." (spec:10-15) A hub fault degrades to non-delivery, never to a stall of authenticated commit progress or unbounded local growth.
- "`openBatch` stages in input order and returns one mixed result per input only after atomic state/pending/poison commit (r16 decision)." (spec:1034-1035)
- "Authenticated plaintext supplies procedure and idempotency key; pre-open references supply neither." (spec:1035)
- "Storage failure/ambiguity exposes no result; replay resolves saved pending/poison before reopening. … Registry crypto owns pending." (spec:1046-1047)
- "Malformed authenticated plaintext refuses, commits the consumed key and dead/poison occurrence … and never invokes a handler." (spec:1045-1046)
- "The frame key is JSON of `['kumiai/frame/v1', groupID, incarnation, topicID, position, protocol, procedure]`." (spec:534)
- "Prepare crypto outside the provider transaction under the group owner gate; the short transaction validates identity/version and writes the prepared result." (spec:496-497)
- "Mid-batch crash/failure commits all state, pending records and transactional effects or none." (spec:510)
- A local member spends sender generations only from its own leaf's current application and handshake ratchets (`createMessage.js:39`, `secretTree.js:174`, `createCommit.js:182`). No path may let two published messages use the same own-leaf generation.
- The MLS AAD comparison runs before `mlsProcessMessage` (`mls/src/group-handle.ts:1080`). `decryptStaged` refuses non-application content first (`:1078-1079`) and opens retained epochs (`:1083`).
- Seal every persisted namespace, including pending (spec:659-669). Keep the 2.2e port changes in real and double (cf-2e:14).
- A double may be stricter than its port, never more permissive. A crypto double is non-malleable and binds the epoch. Every changed port runs both contract suites, against the real implementation and every affected double.
- Verify breaking types repo-wide with `rtk proxy pnpm exec turbo run test:types --force`. Evidence is phase-2 memory reconstruction (spec:1786-1787).

Operational constraints:
- Use pnpm only, through `rtk proxy`.
- Do not edit `lib/`.
- Add no new dependencies, scripts or versions.
- Do not import MLS types into rpc, or implementation helpers into the conformance mirrors.

## Out-of-scope obligations (recorded, not fixed here)

These are pre-existing defects found by `review-codex-crypto.md`. USER ruling: track them separately, outside 2.3a.

1. **ts-mls skipped cache keeps chain secrets.**
   - `unusedGenerations` stores ratchet chain secrets, not per-message keys (`secretTree.js:109-120`).
   - A cached `S_j` can therefore re-derive later, already-consumed message keys. This defeats deletion (RFC 9420 §9.2).
   - The fix needs an upstream ts-mls change, or a replacement retention representation.
2. **Private Commit creation keeps a spent own handshake secret.**
   - It archives the pre-encryption source tree (`createCommit.js:77-84`).
   - The retained history therefore still holds the own handshake secret spent by the Commit.
   - `carryReceiveProgress` overwrites the candidate's retained source tree wholesale (`group-handle.ts:911`), so a straightforward upstream correction would be undone. Both need a forward-secrecy fix alongside obligation 1.

## Review Focus

- **No own handshake authoring outside control-build** (Codex r3 C1, r4 I2, r5 C1/C2, r6 C1). Builders inside callbacks, after an explicit `persist`, on a returned handle, in a delayed continuation, on a refreshed handle, or on an adopted candidate: all refuse with `CommitAuthoringRefusedError` before construction, owed or not, on every access implementation and double. Tasks 5b, 6.
- **Permit provenance** (Codex r6 I2/I3/I8). The permit clone is restored from `sourceState` bytes, shares no buffers, and keeps the double's handle class. The receipt must match the returned commit bytes and the candidate authenticator. Task 6.
- **`openBatch` never returns an unpersisted opened record** (Codex r6 I7). Task 8.
- **Foreign proposal after built-save** (Codex r4 C1, spec:576) and **retained-history eviction after built-save** (Codex r5 I5, `control-adoption.test.ts:152`). Adoption still installs, including after a restart. Tasks 5, 6.
- **Control compatibility is the adoption test** in all four layers (`control-adoption.ts:43-51`, `registry/access.ts:343-352`, `rpc/src/control/store.ts:111-133` via `memory-group-persistence.ts:745-790`, and the build retry at `control-build.ts:337-352`). Tasks 5-6.
- **No hub behaviour stalls commit progress.** This covers app retries on the serial queue, a hung non-durable handler, a withheld fetch, endless increasing junk and repeated deadlines. Tasks 13, 15.
- **A roster change does not lose departing-epoch frames.** This must hold across a restart, a key-only advance after the rotation, a hub that serves an empty page first, and changing epoch hints. No app-side write ever touches the anchor slot. Tasks 2b, 14.
- **One position comparator** governs buffer, workers, restore, pending list, the persistence pending store and contracts. Task 2.
- **App notices are bounded and ordered without commit activity, and no delivery start is stranded** (Codex r5 I10, r6 I5). Task 13.
- **Departing-topic expiry settles its stall bookkeeping** (Codex r6 I6). Task 14.

## File Structure

| Boundary | Files |
| --- | --- |
| Spec | `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` (Task 0, base). |
| Departing anchors port | `rpc/src/anchor.ts:12-22`, `rpc-conformance/src/anchor-store.ts`, runners in `rpc/test/ports-conformance.test.ts:418` and new `mls-rpc/test/anchor-store-conformance.test.ts` (Task 2b, base). |
| Commit authoring permit | New `mls/src/authoring.ts`; `mls/src/group-commit.ts:192-344` (`commitWithEntries`), `mls/src/group-handle.ts` (`proposeSelfRemoval` :936; `deriveGroup` :1800 inherits the mark), `mls/src/index.ts` (Task 5b). |
| Plaintext and frame key | New `rpc/src/app-frame.ts`; `InvalidAppEntryError` moves from `mls-rpc/src/persistence-errors.ts:47` (Task 1, base). |
| Retained epochs, comparator | `rpc/src/cursor.ts`, `rpc/src/crypto.ts:248-259`, `rpc/test/fixtures/fake-crypto.ts`, `mls-rpc/src/crypto.ts:226-229,275-277`, `mls-rpc/src/memory-incarnation-stores.ts:228-242,474`, `rpc-conformance/src/group-crypto.ts`, `rpc-conformance/src/pending-group-crypto.ts` (Task 2, base). |
| Entry reads | `mls-rpc/src/entry-capability.ts`, `memory-group-persistence.ts:242-300`, mirror (Task 3). |
| Guards and retention | `mls-rpc/src/persistence-guards.ts:49-150`, `registry/validation.ts:21-30,81-89`, `persistence-errors.ts`, `mls/src/types.ts:16` doc (Task 4). |
| Metadata clock, build retry | `memory-group-persistence.ts:153-180,1037-1077`; `control-build.ts:330-356`; new `mls-rpc/src/control-compat.ts` (Task 5). |
| Adoption and authoring | `control-adoption.ts:16-62`, `control-build.ts:190-330`, `control-journal.ts:6-56`, `control-validation.ts:193,246`, `access.ts:79-185`, `registry/cold.ts:50`, `registry/access.ts:277,330-370`, `registry-group-mls.ts:346`, `mls.ts:806,894`, `recovery.ts:263,494,584`, `memory-group-persistence.ts:745-790`, `revoke.ts:36-51`, `rpc/src/control/store.ts:111-133`, fixtures `transactional-access.ts`, `sealed-control-access.ts`, `sealed-memory-mls.ts:521-550`, `storage-persistence.ts:990-1000` (Task 6). |
| Registry double | `mls-rpc/test/fixtures/sealed-memory-mls.ts`, `fixtures/registry.ts:484-497` (Task 7). |
| Open core and crypto | New `registry/app-open.ts`, `registry-crypto.ts`; `registry/access.ts`, `registry/types.ts`, `persistence-types.ts`, `crypto.ts:131-135` (Tasks 8-9). |
| Contract suites | New `rpc-conformance/src/registry-crypto.ts`; `pending-group-crypto.ts` (Task 10). |
| rpc lane | `rpc/src/peer.ts`, `rpc/src/app-lane.ts`, `rpc/src/hub-mux.ts` (Tasks 13-16). |
| Cleanup | `mls-rpc/src/clear-hold.ts`, `mls-rpc/src/registry-peer.ts:736-775` (Task 17). |

## Lanes

Use a separate worktree per lane, each at a fresh path (`superpowers:using-git-worktrees`). Each lane runs `kbuild`/`kfinish` over the whole repo.

```
base:   0 ─ 1 ─ 2 ─ 2b ─┬─────────────────────────────────────────────────────────────┐
Lane A (RC1):           ├ 3 ─ 4 ─ 5 ─ 5b ─ 6 ─ 7 ─ 8 ─ 9 ─ 10 ─┬(merge B, C) 11 ─ 12 ─ 18
Lane B (RC2):           ├ 13 ─ 15 ─ 14 ─ 16 ────────────────────┘
Lane C:                 └ 17 ───────────────────────────────────┘
```

- **Base (Tasks 0-2b)** carries everything both lanes must agree on before they split:
  - the r25 text;
  - the plaintext helpers;
  - the retained-epoch contract rows, migrated from the old one-epoch-old refusal rows (Codex r3 I4);
  - the rpc fake and the non-registry real crypto, both passing those rows;
  - the single position comparator, used in the pending list and in the contract rows;
  - the `AnchorSlot.departing` port and its contract row.
  - So no contract changes inside a lane can contradict the other lane.
- **Lane A** owns:
  - `packages/mls-rpc/**`, except the Lane C files.
  - `packages/mls/src/authoring.ts` (new), `group-commit.ts`, `group-handle.ts` and `index.ts` (Task 5b), plus new mls tests.
  - `tests/integration/test/app-lane-e2e.ts` (the revoke-proof build routing, Task 6).
  - `rpc-conformance/src/{group-storage,persistence-fixture,registry-fixture,pending-group-crypto,registry-crypto,index}.ts`.
  - `rpc/src/control/store.ts` (Task 6).
  - The runner lines `rpc/test/ports-conformance.test.ts:97` (Task 10).
- **Lane B** owns `packages/rpc/**` except `rpc/src/control/**`, `rpc/src/app-frame.ts`, `rpc/src/cursor.ts`, `rpc/src/crypto.ts`, `rpc/src/anchor.ts` and `rpc/test/ports-conformance.test.ts`.
  - Lane B edits no `rpc-conformance` file.
  - `rpc/test/fixtures/host-db.ts` stays unchanged. It calls `controlAdoptionAllowed` with three arguments and so keeps the exact version check, which is stricter and allowed for a double (Task 6).
- **Lane C** owns `mls-rpc/src/clear-hold.ts`, `mls-rpc/src/registry-peer.ts` and three new test files (Task 17). Lane A does not edit them.
- **Merge point:** before Task 11, merge B and C into A, then run `kbuild && kports`. No contract row differs between lanes, so this is a merge for integration only.

## Interfaces shared by tasks

```ts
// rpc/src/cursor.ts (base) — the only position order, code-unit lexical (hubs zero-pad: hub-server memoryStore.ts:72, hub-store store.ts:166)
export function compareLogPositions(a: string, b: string): number // a < b ? -1 : a > b ? 1 : 0

// rpc/src/app-frame.ts (base)
export type AppEventPlaintext = { procedure: string; data: Record<string, unknown> }
export function decodeAppEventPlaintext(bytes: Uint8Array): AppEventPlaintext | null
export function appFrameIdempotencyKey(frame: GroupKey & { topicID: string; position: string; protocol: string; procedure: string }): string
export function isAppLogPosition(value: unknown): value is string // non-empty, ≤ 64 chars (cursor.ts:62-67 bound)
export const RETAINED_EPOCHS_DEFAULT = 4
export const RETAINED_EPOCHS_MAX = 32
export class InvalidAppEntryError extends Error {} // mls-rpc re-exports it

// mls-rpc/src/persistence-errors.ts (Task 4)
export class KeyRetentionRangeError extends RangeError {} // name 'KeyRetentionRangeError'

// mls-rpc/src/control-compat.ts (Task 5)
export function controlProjection(state: ClientState): Uint8Array
export function controlCompatible(source: ClientState, current: ClientState, referencedProposals?: Array<string>): boolean
export function ownHandshakeGeneration(state: ClientState): number

// mls-rpc/src/persistence-types.ts (additive, next to PreOpenAppFrameRef:337)
export type OpenAppInput = { frame: PreOpenAppFrameRef; ciphertext: Uint8Array; expectedAAD?: Uint8Array }
export type OpenAppResult =
  | { kind: 'opened'; record: PendingAppFrame }
  | { kind: 'refused'; frame: PreOpenAppFrameRef; reason: 'malformed-plaintext'; keyConsumed: true }
  | { kind: 'refused'; frame: PreOpenAppFrameRef; reason: 'invalid-ciphertext' | 'wrong-aad' | 'duplicate' | 'invalid-position'; keyConsumed: false }
  | { kind: 'refused'; frame: PreOpenAppFrameRef; reason: 'past-epoch'; keyConsumed: false; frameEpoch: number; handleEpoch: number } // not retained
  | { kind: 'held'; frame: PreOpenAppFrameRef; reason: 'future-epoch'; frameEpoch: number; handleEpoch: number }
  | { kind: 'held'; frame: PreOpenAppFrameRef; reason: 'unsupported-version' } // legacy/read-only; never produced
export type PendingAppFrames = { list(): Promise<Array<PendingAppFrame>>; complete(id: string): Promise<void> }
export const MAX_OPEN_BATCH_FRAMES = 64
export const RECEIVE_SAVE_ATTEMPTS = 3

// mls-rpc/src/registry/types.ts — RegistryHandleAccess adds
openBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>
pending: PendingAppFrames

// mls-rpc/src/entry-capability.ts — EntryReads adds
appFrame(incarnation: number, id: string): Promise<{ pending: PendingAppFrame | null; poison: AppPoisonRecord | null }>
pendingFrames(incarnation: number): Promise<Array<PendingAppFrame>>

// rpc/src/control/store.ts:111 (Task 6) — gains an optional fourth parameter; omitted keeps the exact version check
export function controlAdoptionAllowed(snapshot, source, expected, compatible?: (journal: Uint8Array) => boolean): boolean

// rpc/src/anchor.ts:12 (Task 2b, base) — AnchorSlot adds
departing?: Array<{ anchor: Anchor; departedAt: number }> // departedAt = epoch of the anchor that replaced it; ≤ RETAINED_EPOCHS_MAX entries, oldest first

// mls/src/authoring.ts (Task 5b, exported from the package index)
export class CommitAuthoringRefusedError extends Error {} // name 'CommitAuthoringRefusedError'
export type CommitReceipt = { commit: Uint8Array; referencedProposals: Array<string>; epoch: number; authenticatorBefore: Uint8Array; candidateAuthenticator: Uint8Array }
export function restrictCommitAuthoring(handle: GroupHandle): GroupHandle // sticky; deriveGroup inherits it
export function withCommitPermit<T>(restore: () => Promise<GroupHandle>, fn: (permitted: GroupHandle) => Promise<T>):
  Promise<{ value: T; receipt: CommitReceipt | null }> // fresh handle from restore(), one private commit
export function authorPrivateCommit<T>(handle: GroupHandle, construct: () => Promise<{ value: T; receipt: CommitReceipt }>): Promise<T> // the single gate

// mls-rpc/src/entry-capability.ts (Task 3) — EntryReads also adds
appCursor(incarnation: number, topicID: string): Promise<string | null>

// rpc/src/hub-mux.ts:145 (Lane B)
export type MuxFetchTopicParams = { topicID: string; after?: string; limit?: number; signal?: AbortSignal }
// rpc/src/app-lane.ts (Lane B): APP_PULL_MAX_PAGES = 4, APP_PULL_MAX_BYTES = 4 MiB, APP_PULL_DEADLINE_MS = 10_000,
//   APP_BUFFER_MAX_FRAMES = 1_000, APP_STAGED_MAX_FRAMES = 1_000, APP_OUTSTANDING_FETCHES_MAX = 2, APP_PRUNED_NOTICES_MAX = 64;
//   AppLane adds kick(), rotate(departedAt), idle(); AppLaneParams adds appliedEpoch(): number (authenticated, never crypto.epoch())
//   app notices and delivery starts share one FIFO with a coalesced self-scheduled microtask drain, independent of runSerial (Task 13)
// rpc/src/app-lane.ts:50 (Task 14) — AppDeliveryResumed adds settlement?: 'resumed' | 'expired' (always set by rpc; `reason` keeps the stall cause)

// mls-rpc/src/crypto.ts — new first overload; implementation signature widens to (params: GroupCryptoParams | RegistryGroupCryptoParams)
export type RegistryGroupCryptoParams = Omit<GroupCryptoParams, 'access' | 'pending'> & { access: RegistryHandleAccess }
export function createGroupCrypto(params: RegistryGroupCryptoParams):
  GroupCrypto & { pending: PendingAppFrames; unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>> }
// PendingAppFrames is the mls-rpc persistence-types one above (registry PendingAppFrame), exported from mls-rpc's index; not rpc's narrow rpc/src/crypto.ts:219 type (Codex r8 #3)
```

The registry `PendingAppFrame` is structurally assignable to rpc's narrow one (`rpc/src/crypto.ts:213-224`).

## Verification commands

```bash
export SWC_NATIVE_BINDING_CACHE=/private/tmp/kumiai-2-3a-swc
ktest() {
  local package_name="$1"
  shift
  rtk proxy pnpm --filter "$package_name" exec vitest run --maxWorkers=4 --testTimeout=30000 "$@" &&
    rtk proxy pnpm --filter "$package_name" run test:types
}
kbuild() { rtk proxy pnpm turbo run build:js build:types --env-mode=loose; }
kfinish() { rtk proxy pnpm exec turbo run test:types --force --env-mode=loose && rtk proxy pnpm run lint; }
kports() {
  ktest @kumiai/mls-rpc test/ports-conformance.test.ts test/ports-conformance-transactional.test.ts \
    test/registry-conformance.test.ts test/storage-conformance.test.ts test/ownership-phases-conformance.test.ts \
    test/registry-crypto-conformance.test.ts &&
  ktest @kumiai/rpc test/ports-conformance.test.ts test/hub-conformance.test.ts
}
```

Run `kbuild` before any cross-package `ktest`. Expected: every selected test PASSes, typechecks exit 0, lint exits 0, `kfinish` prints `Cached: 0`.

## Tasks

### Task 0 (base): Amend Spec P to r25

**Files:** Modify the spec (Status :4; :474; :485; :517; :873-883; :929; :984; :1029; :1867; :1010; :1012-1018; :1033-1047; :1338-1344; History after :1974).

- [ ] **Step 1: Apply verbatim.** Set the Status line to `draft r25 (2026-10-17)`. Revision 3's merge text (control/receive split, join) must not appear anywhere.
  - **A1** (:1014-1016): replace the refused/held members with the union in "Interfaces shared by tasks". Trailing comment: `// r25: locked epochs, duplicate, invalid-position; past-epoch only for epochs no longer retained`. At :1018 add `// r25: new rows always carry keyConsumed:true; legacy rows may carry false.`
  - **A2** (:1017): `// r25: only authenticated malformed plaintext (keyConsumed:true) persists an AppPoisonRecord. Crypto refusals, duplicates, invalid positions, outer-version faults and window/age expiry persist no row; durable cursor completion records them.`
    - At :1036 replace "Outer unsupported versions commit diagnostic poison without opening, count as completed, and never create durable holds." with "Outer unsupported versions refuse as invalid-ciphertext without opening or writing, count as completed through the cursor, and never create durable holds (r25)."
    - At :1043 replace "commit diagnostic poison with keyConsumed:false and mark completed" with "mark completed through the durable cursor without a poison row (r25)".
  - **A3** (after :1036): "(r25) Registry crypto validates fatal UTF-8, a JSON object, broadcast `v: 2`, `payload.typ === 'event'`, a non-empty well-formed string `payload.prc` and an absent or plain-object `payload.data`. Protocol membership, schema and retention stay rpc delivery checks."
  - **A4** (append to :1010 and :1339): "(r25) Phase 2.3a routes durable unwrap only; wrap and ephemeral unwrap use `mutate` until 2.3b. Until 2.3d, rpc keeps the r14 `AppFrameRef` and narrow `PendingAppFrame` and calls only singleton durable unwrap. Registry crypto binds GroupKey from its incarnation-bound access; a mismatching supplied key refuses as storage failure, never as a dead frame."
  - **A5** (:984): drop `open: HandleAccess['open']`. After :1338 add: "(r25) RegistryHandleAccess has no `open`; `openBatch` replaces it."
  - **A7** (after :1047): "(r25) Positions are opaque hub tokens ordered by one code-unit comparison everywhere; the registry compares them for equality only. One occurrence matcher (frame id, topicID, segment, position) serves in-batch and saved replay: a match returns the earlier or saved record or refusal without reopening or writing; the same id at another occurrence refuses as `duplicate` with keyConsumed:false and no write. A position that is empty or longer than 64 characters refuses as `invalid-position`. A completed frame's key is spent, so a refetch refuses without a write. An occurrence at or before the topic's durable cursor refuses as `duplicate` before decryption, and an attempt whose cursor moved before work re-prepares; openBatch never reports `opened` for a record it did not persist."
    - At :485 replace "Positions compare numerically only within that topic." with "Positions compare by one code-unit order only within that topic (r25)."
    - At :1867 replace "Numeric position ordering survives reopen." with "Code-unit position ordering survives reopen (r25)."
    - Scan: `rtk proxy grep -n -i "numeric" <spec>` must show no position-ordering requirement left.
  - **A8** (replaces every earlier A8 text).
    - At :929 replace "state version per state/metadata change" with "state version per MLS state, control, anchor, outbox, meta or trust change; pending, poison and cursor writes never advance it (r25)".
    - After :1344 add: "(r25) Every MLS state write, application receipt included, is an exact version CAS serialised per group; a receive save that loses its CAS re-prepares at most three times. An ordinary adoption or build retry of an own commit carries the commit journal and is checked for control compatibility: the current state's control projection (everything except secret-tree progress other than the own handshake generation, retained history and the proposal map) must equal that of the journal's `sourceState`; every proposal the commit references must still be present unchanged; no own-sender proposal may be added; and retained epochs may only have been evicted, never added. Extra foreign proposals are allowed (:576), and history eviction the retention policy performs is allowed and carried into the candidate. This replaces matching the captured stateVersion. Adoptions without a journal keep the exact version match."
  - **A9** (after :1034): "(r25) openBatch accepts at most 64 inputs and rejects larger arrays with RangeError before any read."
  - **A11** (at :1015 and after :1042): "(r25) A frame whose epoch is below the handle epoch but still retained opens from the retained epoch; past-epoch refuses only epochs no longer retained, and such frames are not delivered. Authenticated commit progress never awaits application delivery or a handler, and app work never runs on the peer's commit queue. App pulls run under page, byte and time budgets with a bounded number of outstanding hub requests; exhaustion leaves frames undelivered and is retried later. After an anchor rotation, the departing anchor is saved with the new anchor in one anchor-slot write, together with the epoch of the new anchor (its departure epoch). Every later anchor-slot write carries the departing list forward. Its topic keeps being pulled under its own segment identity while the authenticated applied epoch is less than the departure epoch plus 32; neither a short page nor the crypto epoch hint ends it, and expiry is computed when read, never written by app work. Expiry settles that topic's stalled frames with a delivery-settled notice marked `expired`, distinct from `resumed`."
  - **A12** (after :474 and :517): "(r25) Until 2.3c, every retirement (resync switch, delete, successor) leaves opened records durable and undelivered in the retired incarnation; 2.3c retired-port delivery drains them without a live peer, and the visible blocked-switch status moves with it."
  - **A13** (after :873-883): "(r25) `GroupOptions.keyRetention.retainKeysForEpochs` is host-configurable: default 4, an integer from 1 to 32; anything else throws KeyRetentionRangeError. Registry handles and storage guards enforce the configured epoch count, and every skipped-key index is a safe integer below its ratchet's generation."
  - **A14** (after :1029): "(r25) Private commit construction requires an authoring permit, checked inside @kumiai/mls before the commit is constructed. Every handle an access implementation issues (initial, refreshed, adopted, restored) and every handle derived from one is permanently restricted (CommitAuthoringRefusedError). Only the durable control-build path grants a permit: on a handle restored from the journal's sourceState bytes, for exactly one commit, whose receipt must match the returned commit bytes and candidate; journal, candidate and slot are persisted before the bytes are handed to the network. Public external commits (recovery, rejoin) spend no own handshake generation and are outside the permit."
  - **A6** History bullet: `- r25 (2026-10-17, plan 2.3a): locked epochs, duplicate/invalid-position results; poison only for authenticated malformed plaintext; envelope validation; durable-only registry routing; RegistryHandleAccess drops open; opaque positions with one comparator and occurrence matcher; exact CAS for every MLS state write with app metadata off the version clock; journal control-compatibility for own-commit adoption and build retry; private commit authoring only under a control-build permit; durable departing anchors preserved by every anchor-slot write; 64-frame bound; retained past epochs open; commit progress independent of app work; configurable epoch retention (default 4, cap 32); opened-record drain deferred to 2.3c.`
- [ ] **Step 2: Verify.** `rtk proxy grep -n "r25" <spec>` gives one hit per site above; read each. `rtk proxy grep -n "joinReceive\|receive part\|receiveRevision" <spec>` gives no hits.
- [ ] **Step 3: Commit (base).** `git commit -m 'docs(spec-p): r25 registry crypto core amendments'`.

### Task 1 (base): Strict event plaintext and frame keys in rpc

**Files:** Create `rpc/src/app-frame.ts`, `rpc/test/app-frame.test.ts`. Modify `rpc/src/index.ts` (export the module and `frameID` from `app-lane.ts:53`), `mls-rpc/src/persistence-errors.ts:47-49` (re-export), `mls-rpc/src/index.ts:99`, `mls-rpc/test/epoch-results.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - `decodes the canonical event frame`: `decodeAppEventPlaintext(encodeEventFrame('posted', { text: 'hi' }))` equals `{ procedure: 'posted', data: { text: 'hi' } }`, and absent data gives `{}`.
  - `refuses every malformed envelope`: each of these gives `null`:
    - `[0xff]`, non-JSON, and JSON `null`/array/number;
    - `v` missing, `1` or `3`;
    - a missing payload, or `typ: 'request'`;
    - `prc` that is `''`, a non-string or a lone surrogate;
    - `data` that is an array, `null` or a string.
  - `frame key is the spec tuple`: `appFrameIdempotencyKey({ groupID: 'g', incarnation: 2, topicID: 't', position: '10', protocol: 'chat', procedure: 'posted' }) === JSON.stringify(['kumiai/frame/v1', 'g', 2, 't', '10', 'chat', 'posted'])`.
  - `app positions share the fetched bound`: true for `'x'` and `'000000000042'`; false for `''`, a non-string and 65 characters.
  - `retention constants`: `RETAINED_EPOCHS_DEFAULT === 4`, `RETAINED_EPOCHS_MAX === 32`.
  - `one InvalidAppEntryError class`: `mlsRpc.InvalidAppEntryError === rpc.InvalidAppEntryError`.
- [ ] **Step 2: RED.** `ktest @kumiai/rpc test/app-frame.test.ts`.
- [ ] **Step 3: Implement.**
  - Decode with `TextDecoder('utf-8', { fatal: true })`, `BROADCAST_VERSION` (`broadcast/src/transport.ts:19`) and `isWellFormedUTF16` (`rpc/src/well-formed.ts:1`).
  - A plain object has prototype `Object.prototype` or `null`.
  - Any throw maps to `null`.
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/rpc test/app-frame.test.ts && ktest @kumiai/mls-rpc test/epoch-results.test.ts && kfinish`.
- [ ] **Step 5: Commit on base.** `git commit -m 'feat(rpc): strict app event plaintext and frame keys'`.

### Task 2 (base): Retained past epochs open; one position comparator

**Files:** Modify:
- `rpc/src/cursor.ts` (add `compareLogPositions`);
- `rpc/src/crypto.ts:248-259` (`sortPendingAppFrames` uses it);
- `rpc/test/fixtures/fake-crypto.ts` (retain the last `RETAINED_EPOCHS_DEFAULT` epochs; configurable);
- `mls-rpc/src/crypto.ts:226-229` and `:275-277` (the past check admits epochs in `historicalReceiverData`);
- `mls-rpc/src/memory-incarnation-stores.ts` (Codex r5 I7): the pending/poison comparator at :228-242 replaces its `BigInt` position order with `compareLogPositions` and its `a.id.localeCompare(b.id)` tie-break with code-unit order; the pending insertion check at :474 replaces `BigInt(position.position) >= BigInt(record.frame.position)` with `compareLogPositions(position.position, record.frame.position) >= 0`;
- `rpc-conformance/src/group-crypto.ts:170-180` and `:350-364`;
- `rpc-conformance/src/pending-group-crypto.ts:73-88`, `:176-195` and `:215-233`;
- `rpc-conformance/src/group-storage.ts` (the persistence rows below).

**Interfaces:**
- **Migrated refusal rows.** The old "one epoch below refuses" rows (Codex r3 I4) now advance past retention: `retainedEpochs + 1` advances, where the fixture's `retainedEpochs` defaults to 4. They expect `FrameEpochError` with the frame epoch and the current handle epoch.
- **New positive rows:** `a retained past-epoch frame opens` and `a retained past-epoch durable unwrap saves one record`.
- **Ordering.** The pending ordering row uses 12-digit positions, plus a second case with arbitrary tokens `['B', 'a']`, which lists as `['B', 'a']` (code-unit order).
- **Hint-offset rows** (`group-crypto.ts:170-180`): they keep refusing a frame from the *future* epoch. The past case now uses a non-retained epoch.
- **Persistence rows** (`rpc-conformance/src/group-storage.ts`, Codex r5 I7): `opaque pending positions list and insert without throwing` saves pending records at `'B'` and `'a'` on one topic, plus a cursor at `'B'`; insertion of `'a'` succeeds, insertion of `'A'` is skipped as passed, and `pending.list()` orders `['B', 'a']`. `unpadded positions use code-unit order` saves `'9'` and `'10'` and lists `['10', '9']`. Both rows repeat after reopen. No `BigInt(` call on a position remains: `rtk proxy grep -rn "BigInt(.*position" packages/*/src` gives no hits.

- [ ] **Step 1: Edit the rows** as above.
- [ ] **Step 2: RED.** `kbuild && kports`. Expected: the positive rows and the arbitrary-token ordering row fail on both the rpc fake and real crypto.
- [ ] **Step 3: Implement** the comparator, the fake's retention and the non-registry real crypto. `sortPendingAppFrames` drops its numeric branch (`rpc/src/crypto.ts:253-256`).
- [ ] **Step 4: GREEN.** `kbuild && kports && ktest @kumiai/rpc test/durable-restart.test.ts test/future-epoch-retention.test.ts && ktest @kumiai/mls-rpc test/storage-conformance.test.ts && kfinish`.
- [ ] **Step 5: Commit on base.** `git commit -m 'feat: retained past epochs open; one log-position comparator'`.

### Task 2b (base): Departing anchors in the anchor slot

**Files:** Modify `rpc/src/anchor.ts:12-22` (`AnchorSlot.departing?`), `rpc-conformance/src/anchor-store.ts` (`ConformanceAnchorSlot` mirror plus one row) and `rpc/test/ports-conformance.test.ts` (runners). Modify `rpc-conformance/src/control-store.ts:1660-1702` (the landed row). Create `mls-rpc/test/anchor-store-conformance.test.ts`.
No store changes are expected: the rpc fakes (`rpc/test/fixtures/anchor.ts`, `host-db.ts:255-262`, `memory-group-mls.ts`) and the real mls-rpc anchor namespace (`memory-incarnation-stores.ts:450-459`, `copyStoredValue`) store the slot whole, and no mls-rpc code validates the slot shape. The landed-proof writers spread the stored slot (`registry/access.ts:253`, `mls-rpc/test/fixtures/sealed-control-access.ts:114`) or set the field in place (`rpc-conformance/src/memory-control-store.ts:813`, `host-db.ts:351-355`), so they keep `departing`.

**Runners** (Codex r5 minor). Today `testAnchorStoreConformance` runs only on `createMemoryAnchorStore` (`rpc/test/ports-conformance.test.ts:418`). Add:
- `rpc/test/ports-conformance.test.ts`: the `host-db` anchor store (`createMemoryHostDatabase().anchorStore(groupID)`).
- `mls-rpc/test/anchor-store-conformance.test.ts`: the real mls-rpc anchor namespace, `stores.incarnation(1).anchor` from the memory incarnation stores, and the registry anchor rows that `registry/access.ts:251-253` writes through (`target.anchor`).
**Interfaces:**
- `departing?: Array<{ anchor: Anchor; departedAt: number }>`. `departedAt` is the epoch of the anchor that replaced it. The list is absent when empty, ordered oldest first, and holds at most `RETAINED_EPOCHS_MAX` entries.
- The departing list is written in the same `save` as the anchor it accompanies (Task 14). One slot write is the co-commit.
- A landed-proof write (`anchorLanded`) keeps `departing` unchanged.

- [ ] **Step 1: Write the failing row.** `departing anchors round-trip with the slot`: save `{ anchor, departing: [{ anchor: a1, departedAt: 5 }, { anchor: a2, departedAt: 9 }] }`. `load()` deep-equals it, including secret bytes. A later save without `departing` loads without the field. A second row, `landed proof keeps departing`, runs where the runner exposes an adoption write with `anchorLanded` (the control-store conformance row at `rpc-conformance/src/control-store.ts:1677-1699` gains a `departing` field in its slot and asserts it survives).
- [ ] **Step 2: RED** (a type error in the runners until the mirror field exists). **Step 3: implement.** **Step 4: GREEN.** `kbuild && kports && ktest @kumiai/mls-rpc test/anchor-store-conformance.test.ts test/control-store-conformance.test.ts && kfinish`. The row must pass on all four anchor-store runners.
- [ ] **Step 5: Commit on base.** `git commit -m 'feat(rpc): anchor slot carries departing anchors'`.

### Task 3 (A): Point reads for saved app frames and cursor-clear scope

**Files:** Modify:
- `mls-rpc/src/entry-capability.ts:38-50`;
- `mls-rpc/src/memory-group-persistence.ts:242-300`;
- `rpc-conformance/src/persistence-fixture.ts:298-310`;
- `rpc-conformance/src/group-storage.ts` (the N2 row, :1443-1466, and its setup);
- `mls-rpc/test/registry-source.test.ts:131-148`.

Test: `mls-rpc/test/entry-capability.test.ts`.

**Interfaces:**
- `appFrame` loads the `pending` and `poison` rows by id through `memoryRecordTable(...).load(id)` (`memory-incarnation-stores.ts:104`).
- `pendingFrames` delegates to `pending.list()`.
- `appCursor(incarnation, topicID)` is a point read of the durable app cursor: `cursor.load(await topicLocator(topicID))` (`memory-incarnation-stores.ts:505`). It returns the position or `null`. Task 8 uses it (Codex r6 I7).
- The mirror adds all three.

- [ ] **Step 1: Write failing tests:**
  - `prepare reads app frames by id`: commit pending `frame-a` and poison `poison-a` for incarnation 1. Then:
    - `(await reads.appFrame(1, 'frame-a')).pending?.frame.id === 'frame-a'`;
    - `(await reads.appFrame(1, 'poison-a')).poison?.keyConsumed === true`;
    - `appFrame(1, 'none')` equals `{ pending: null, poison: null }`;
    - `pendingFrames(1)` ids equal `['frame-a']`;
    - mutating a returned row does not change a re-read;
    - after `ports(key).cursor.save(topicID, 'B')`, `appCursor(1, topicID) === 'B'`, and an unknown topic gives `null`.
  - **N2 (cf-2e:34), a regression pin.** Save `ports(key).cursor.save('topic:keep', '7')` while incarnation 1 is active. After `incarnation(2).cursor.clear()`, `stores.incarnation(1).cursor.load('topic:keep')` is `'7'`.
  - **`registry-source.test.ts`:** intercept `appFrame` and `pendingFrames` as forbidden.
- [ ] **Step 2: RED.** `ktest @kumiai/mls-rpc test/entry-capability.test.ts`. Expected: `reads.appFrame is not a function`.
- [ ] **Step 3: Implement** in `prepareReads` with `memoryOperation`, and update the mirror.
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc test/entry-capability.test.ts test/registry-source.test.ts test/storage-conformance.test.ts test/ownership-phases-conformance.test.ts && kfinish`. Mutation-check N2 by making `clear()` group-wide.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls-rpc): entry prepare point-reads saved app frames'`.

### Task 4 (A): Storage guards and configurable epoch retention

**Files:** Modify:
- `mls-rpc/src/persistence-guards.ts` (`assertTreeProgress` :49-75, `assertReceiveProgress` :79-101);
- `mls-rpc/src/registry/validation.ts:21-30` (`registryOptions`) and `:81-89`;
- `mls-rpc/src/persistence-errors.ts` (`KeyRetentionRangeError`);
- `mls-rpc/src/index.ts`, `mls-rpc/README.md` (options);
- `mls-rpc/src/registry/access.ts:204` (`leafNodes[2 * privatePath.leafIndex]`, ts-mls `leafToNodeIndex`, `treemath.js:31`);
- `rpc-conformance/src/group-storage.ts` (rows), `mls-rpc/test/fixtures/storage-seed.ts` (hooks).

Tests: `mls-rpc/test/retention.test.ts`, `mls-rpc/test/guards.test.ts`.

**Interfaces:**
- **Skipped-key indices** (crypto review, Important). In `assertTreeProgress`, every key of `unusedGenerations` in the current tree and every retained tree is a safe-integer string `k` with `0 <= k < generation`. Otherwise the guard throws `'Invalid skipped-key index'`. This closes the "cache entry at the current generation" replay.
- **Retained companion fields** (crypto review, Important).
  - For an epoch present in both `previous.historicalReceiverData` and `next.historicalReceiverData`: `senderDataSecret` and the TLS encodings of `ratchetTree` and `groupContext` (ts-mls encoders, e.g. `groupContextEncoder`, `groupContext.d.ts`) are byte-equal, as `resumptionPsk` already is (`:84`).
  - On an epoch move, the retained entry for the previous epoch carries the previous state's `senderDataSecret`, `ratchetTree` and `groupContext`.
  - Otherwise the guard throws `'Retained epoch tuple changed'`.
- **`registryOptions`.**
  - `retainKeysForEpochs` defaults to `RETAINED_EPOCHS_DEFAULT` (4).
  - A value that is not an integer in `1..RETAINED_EPOCHS_MAX` (32) throws `KeyRetentionRangeError`.
  - The existing ≥ 1,000 checks for the other two fields are unchanged.
- **`validateRegistryHandle`** also requires `historicalReceiverData.size <= retainKeysForEpochs`, and at most `retainKeysForGenerations` entries per ratchet.
- **Contract-row hooks** in the mirror: `cacheAtCurrentGeneration(record)` and `retainedTupleChanged(record)`. Each returns a `version + 1` candidate built with real MLS.

- [ ] **Step 1: Write failing tests:**
  - Rows: `skipped key at the current generation refuses`; `retained epoch tuple change refuses`.
  - `retention.test.ts`:
    - `epoch retention defaults to 4 and caps at 32`: `registryOptions({}).keyRetention.retainKeysForEpochs === 4`, `32` passes, and `0`, `33` and `1.5` throw `KeyRetentionRangeError`.
    - `non-default retention is honoured`: a registry with `retainKeysForEpochs: 2`. At epoch e, seal F0 and F1; advance to e+1 and seal F2. Advance once more (handle at e+2, retained `[e, e+1]`; probe at `review-codex-r4.md` #9: epochs `[3, 4]` retained at 5): F1 and F2 both open. Advance a third time (retained `[e+1, e+2]`): F0 refuses as `past-epoch` (Codex r4 m9; F0 is sealed before leaving e, Codex r5 minor). Run in both modes after Task 8; mark `.todo` until then.
    - `restore refuses a state holding more retained epochs than configured`.
  - `guards.test.ts`: `senderHWM reads the own node index` (local leaf 1, after one own `encrypt`, `senderHWM === 1`).
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc test/retention.test.ts test/guards.test.ts test/group-state-persistence.test.ts test/registry-validation.test.ts && kports && kfinish`. Mutation-check by dropping the index bound: the cache row must pass wrongly.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls-rpc): skipped-key and retained-tuple guards; configurable epoch retention'`.

### Task 5 (A): App metadata off the version clock; build retry checks control compatibility

**Files:** Create `mls-rpc/src/control-compat.ts`, `mls-rpc/test/control-compat.test.ts`, `mls-rpc/test/metadata-clock.test.ts`. Modify:
- `mls-rpc/src/memory-group-persistence.ts:153-180` (`changedIncarnations` drops `pending`, `poison` and `cursor`; keeps `state`, `control`, `anchor`, `outbox` and `meta`, plus the trust/`restorePending` rule at :1039-1047);
- `mls-rpc/src/control-build.ts:330-356`;
- `mls-rpc/test/control-build.test.ts:239`.

**Interfaces:**
- **`controlProjection(state)`** is `encodeClientState(state')`, where `state'` replaces the current secret tree with `{ leafWidth, intermediateNodes: {}, leafNodes: { [2 * own]: { handshake: { secret: <empty>, generation: ownHandshakeGeneration(state), unusedGenerations: {} }, application: <zero placeholder> } } }`, replaces `unappliedProposals` with `{}` and replaces `historicalReceiverData` with an empty map. Every other field is kept byte-exact: `groupContext`, `keySchedule`, `ratchetTree`, `privatePath`, `confirmationTag`, `groupActiveState`.
  - Retained history leaves the projection (Codex r5 I5). A private commit's construction reads only the current epoch's state and the proposals it references. No builder references a PSK proposal: every builder passes `pendingProposals: {}` except `commitSelfRemovals`, which passes self-`remove` proposals only (`group-lifecycle.ts:57-66`). So retained epochs are not a build dependency, and eviction by the retention policy (`control-adoption.test.ts:152-225`, the `eviction` row) must not break compatibility. Adoption already carries the eviction into the candidate (`carryReceiveProgress`, `group-handle.ts:912-920`).
- **`ownHandshakeGeneration(state)`** is `leafNodes[2 * own]?.handshake.generation`. When the own leaf is not materialised, it is 0.
- **`controlCompatible(source, current, referencedProposals?)`** holds when all four of these hold:
  1. The two projections are byte-equal.
  2. Every ref in `referencedProposals` (when omitted: every `source.unappliedProposals` ref, which is stricter) is present in both maps, with byte-equal `proposalWithSenderEncoder` encodings **and** equal `senderLeafIndex`, compared explicitly with presence (`undefined` and `0` differ). ts-mls's `proposalWithSenderEncoder` uses `optionalEncoder`, which encodes sender `0` and an absent sender identically (Codex r7 probe). The repository codec compensates for the same defect (`mls/src/codec.ts:51`).
  3. No entry of `current.unappliedProposals` absent from the source has `senderLeafIndex === own`.
  4. The key set of `current.historicalReceiverData` is a subset of the source's. Eviction is allowed; an added retained epoch is not.
  - Extra foreign proposals are allowed (spec:576; Codex r4 C1). `commitWithEntries` sets `unappliedProposals: params.pendingProposals ?? {}` (`mls/src/group-commit.ts:279-282`), so a commit references exactly the refs passed in. Task 5b's permit records them, and Task 6 writes them into the journal (Codex r5 minor: record actual references).
  - Non-own receive progress, the own application ratchet and retained-history eviction may differ. Nothing else may.
- **Build retry.** When `fresh.source.stateVersion !== expected.stateVersion`, load the stored record. Retry with refreshed `expected` only when `controlCompatible(decodeClientState(sourceState), decode(stored.state), referencedProposals)` holds, passing the receipt's actual references (Task 6; Codex r6 minor), and the existing identity, hold and cursor checks still pass. Otherwise return `moved`. `sourceState` is the complete pre-build state (`control-build.ts:247`).

- [ ] **Step 1: Write failing tests:**
  - `control-compat.test.ts` (real MLS, local leaf 1):
    - an app receive keeps compatibility;
    - an own app send keeps it;
    - an own `proposeSelfRemoval` breaks it;
    - a received foreign proposal keeps it (extra proposal);
    - removing a referenced proposal breaks it;
    - removing an unreferenced source proposal keeps it when `referencedProposals` is given, and breaks it when omitted;
    - a referenced proposal whose sender changes from leaf `0` to absent (byte-equal encodings) breaks it (Codex r7 minor);
    - an own-sender proposal added breaks it;
    - evicting a retained epoch keeps it; a state with a retained epoch the source lacks breaks it;
    - a processed commit breaks it.
  - `proposal between build and save moves the build` (Codex r2 #1): gate the built-save port; on its first call, write a state whose own handshake generation advanced, then release. Produce it outside any access (Task 6 makes `mutate` refuse own proposals): restore a bare handle from the stored bytes, call `proposeSelfRemoval()`, and write its state through the store's raw state port with an exact version CAS. The result is `moved`, and no `commitOnce` holds the old bytes.
  - `build retry ignores an unreferenced source proposal`: the source holds a foreign proposal that the built commit does not reference. Between build and save, a receive removes it. The retry proceeds, and with `referencedProposals` omitted it returns `moved`.
  - The `control-build.test.ts:239` pin still retries. `putOutcomes` changes no MLS state. Also assert the second `expected.stateVersion === freshVersion`.
  - `metadata-clock.test.ts`:
    - a transition writing only a pending row, a poison row or a cursor leaves `state.version` and `metadata.version` unchanged;
    - a `meta`, `outbox` or `control` write still bumps.
  - `outbox settlement is not refused by app metadata`: an app cursor save between owned capture and `recordSettlement` (`memory-group-ports.ts:144`, check at `:168`) leaves `recorded: true`.
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc test/control-compat.test.ts test/control-build.test.ts test/metadata-clock.test.ts test/manual-recovery-conformance.test.ts test/registry-switch.test.ts test/checkpoint-writer-migration.test.ts && kports && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'fix(mls-rpc): app metadata off the version clock; build retry checks control compatibility'`.

### Task 5b (A): Private commit authoring needs a permit checked before construction

**Files:** Create `mls/src/authoring.ts`, `mls/test/authoring-permit.test.ts`. Modify `mls/src/group-commit.ts:192-344` (`commitWithEntries`), `mls/src/group-handle.ts` (`proposeSelfRemoval` :936-960; `deriveGroup` :1800-1814) and `mls/src/index.ts`.

**Root cause** (controller rulings, Revisions 6 and 7; Codex r3 C1, r4 I2, r5 C1/C2, r6 C1). Private commit authoring was reachable through generic access, so every guard was accounting after the fact. Revision 6's scoped refusal ended when the callback returned, so a returned or retained handle could still author. Revision 7 makes the restriction a permanent property of the handle.

**Premise (verified):**
- Own handshake messages are constructed at exactly two sites in `@kumiai/mls`:
  - `createCommit` in `commitWithEntries` (`group-commit.ts:333`);
  - `createProposal` in `proposeSelfRemoval` (`group-handle.ts:955`).
  `grep -n "createProposal\|createCommit(" packages/mls/src/*.ts` shows no other.
- All 13 exported private builders call `commitWithEntries` inside their existing `mutexFor(group).run`. The mutex is not reentrant (Codex r5 I3), so the check takes no lock: it is a synchronous `WeakMap` read.
- Handles are produced in mls by `deriveGroup` (`group-handle.ts:1800`, used for every builder's `newGroup`, not exported from the index), `restoreGroup` (`group-create.ts:163`), `createGroup`, and the welcome joins (`group-welcome.ts:118,344,384`). Only `deriveGroup` derives from an existing handle.
- `joinGroupExternal` (recovery, rejoin) builds a public external commit and spends no own handshake generation.

**Interfaces** (`authoring.ts`; the state lives in `const AUTHORING = new WeakMap<GroupHandle, 'restricted' | Permit>()`, following `MUTEXES` at `group-handle.ts:99-109`):
- **`restrictCommitAuthoring(handle): GroupHandle`.** Marks the handle `'restricted'` for good and returns it. It is idempotent. There is no unmark. A permit handle becomes restricted too.
- **Inheritance.** `deriveGroup(group, state)` marks its result `'restricted'` whenever `group` is marked (restricted or permit). A builder's `newGroup` from a permitted clone, which is the candidate, is therefore restricted.
- **`withCommitPermit(restore, fn)`**, where `restore: () => Promise<GroupHandle>`:
  - Calls `restore()`. It throws `CommitAuthoringRefusedError` if the result is already marked, because a permit needs a fresh handle.
  - Marks the result with an unused permit and calls `fn(permitted)`.
  - When `fn` settles, it marks `permitted` restricted.
  - It returns `{ value, receipt }`, where `receipt: CommitReceipt | null` comes from the one commit built under the permit.
  - The caller's `restore` must build an independent handle from bytes (Task 6). No state object or buffer is shared with any access-issued handle (Codex r6 I2).
- **`CommitReceipt`** is `{ commit: Uint8Array; referencedProposals: Array<string>; epoch: number; authenticatorBefore: Uint8Array; candidateAuthenticator: Uint8Array }`. It identifies the authored commit by its encoded bytes (Codex r6 I8).
- **`authorPrivateCommit(handle, construct)`**, where `construct: () => Promise<{ value: T; receipt: CommitReceipt }>`, is the single gate:
  - Synchronously, before `construct` is invoked and before any `await` (Codex r7 I2):
    - `'restricted'` throws `CommitAuthoringRefusedError('Private commit authoring requires the control-build permit')`;
    - a consumed permit throws the same error;
    - an unconsumed permit is **consumed** at this point;
    - an unmarked handle passes. A bare handle outside any access is outside the persistence contract, as at HEAD.
  - If `construct` throws, the permit stays consumed. A later authorized attempt gets a fresh restored clone through a new `withCommitPermit`.
  - After `construct` resolves on the permit handle that consumed the permit, its receipt is stored. Only that construction can set it, so a receipt cannot be overwritten.
  - So overlapping or delayed-continuation calls on one permit handle refuse before construction, whether or not the builder has its own outer mutex. `buildSealedMemoryOperation` has none.
  - `commitWithEntries` runs its whole body through it. Its receipt is:
    - `commit`: `encode(mlsMessageEncoder, result.commit)`, the same bytes every builder returns as `commitMessage`;
    - `referencedProposals`: `Object.keys(params.pendingProposals ?? {})`;
    - `epoch` and `authenticatorBefore` from `group`;
    - `candidateAuthenticator`: `result.newState.keySchedule.epochAuthenticator`.
  - The memory double's synthetic builder uses the same function (Task 6).
- **`proposeSelfRemoval`**, inside its existing mutex run: any mark (restricted or permit) throws `CommitAuthoringRefusedError('Own proposals are refused under access')`. No production path proposes.
- **Exports:** `CommitAuthoringRefusedError`, `CommitReceipt`, `restrictCommitAuthoring`, `withCommitPermit` and `authorPrivateCommit`.
  - The mls `exports` map is only `"."`.
  - A repo test (Task 6) pins `withCommitPermit(` in `packages/*/src` to `mls-rpc/src/control-build.ts`. It pins `authorPrivateCommit(` to `mls/src/group-commit.ts`, plus the test double `mls-rpc/test/fixtures/sealed-memory-mls.ts`.
  - Code holding the keys can restore an unmarked handle from raw bytes. That is the trusted-code exception (Q3).
- **No source-spend accounting** (removed in revision 6; still unneeded, see drafter-notes Revision 6). Codex r6 confirmed this holds once the restriction is permanent.

- [ ] **Step 1: Write failing tests** (`authoring-permit.test.ts`, real MLS):
  - `a restricted handle cannot build any private commit`: after `restrictCommitAuthoring(h)`, each of the 13 builders rejects with `CommitAuthoringRefusedError`, `h.state` encodes byte-equal, and no fold or gate work ran (a builder whose fold would throw a different error still throws the authoring error).
  - `restriction is permanent`: the refusal still holds after the creating scope has returned, in a later `setTimeout` continuation, and after a second `restrictCommitAuthoring`.
  - `derived handles inherit`: `deriveGroup` (imported from `src/group-handle.ts`) of a restricted handle, or of a permit handle, is restricted.
  - `proposeSelfRemoval refuses under restriction and under a permit`.
  - `a permit allows exactly one commit`: `withCommitPermit(() => restoreGroup(fresh bytes), (p) => commitKeyRotation(p))` returns a receipt whose `commit` equals the builder's `commitMessage`, with `referencedProposals: []` and `candidateAuthenticator` equal to `newGroup`'s. A second builder call inside `fn` refuses, and after `fn` returns `commitKeyRotation(p)` refuses.
  - `a permit needs a fresh handle`: a `restore` that returns an already-restricted handle throws.
  - `the permit is consumed before construction` (Codex r7 I2): under a permit, `Promise.all([authorPrivateCommit(p, slowConstruct), authorPrivateCommit(p, construct)])`. The second rejects before its `construct` runs (a spy counts one call), and the receipt is the first's. A `construct` that throws leaves the permit consumed.
  - `the receipt records referenced proposals`: with two foreign self-remove proposals pending, `commitSelfRemovals` under a permit records both refs.
  - `the check takes no lock` (Codex r5 I3): under a permit, `commitKeyRotation(p)` completes within 2 s, and a concurrent `p.decrypt` completes too.
  - `an unmarked handle builds as before`.
- [ ] **Step 2: RED.** `kbuild && ktest @kumiai/mls test/authoring-permit.test.ts`. Expected: `restrictCommitAuthoring is not a function`.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls test/authoring-permit.test.ts && rtk proxy pnpm --filter @kumiai/mls exec vitest run --maxWorkers=4 && kfinish`. The mls suite stays green unchanged, because bare handles are unmarked. Mutation checks:
  - moving the check after `construct` must fail the first row's unchanged-state assertion;
  - dropping inheritance from `deriveGroup` must fail the third row.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls): private commit authoring needs a permit checked before construction'`.

### Task 6 (A): Journal-compatible adoption; access-issued handles are restricted; control-build holds the only permit

**Files:** Modify:
- `mls-rpc/src/control-adoption.ts:16-62` (the `replace` prepare; restrict the restored candidate at :30);
- `mls-rpc/src/control-build.ts:190-330` (params including required `restoreCandidate`, permit, receipt and candidate check before framing, journal fields); its 11 test/integration call sites of `createControlBuildPort({` pass `restoreCandidate`. Passing it is not enough for synthetic builds (Codex r8 #2):
  - `mls-rpc/test/control-build.test.ts:143-157`: the `build` asserts `supplied === handle` and returns invented `commit`, `digest` and `journal` bytes. It is migrated to a permitted real builder (`commitKeyRotation(supplied)`) returning its `commitMessage`, `digestAppliedCommit(commitMessage)` and the candidate's state bytes. The identity assertion becomes clone independence: `supplied !== handle`, and `supplied.state` shares no object or `ArrayBuffer` with `handle.state`, while its `epochAuthenticator` equals the captured source's.
  - `mls-rpc/test/registry-consumer-access.test.ts:71-86`: the `build` returns `commit: new Uint8Array([1, 2])`, `digest: 'rotation'` and a journal from `f.advance(handle)`. It is migrated the same way: a permitted builder supplies commit, digest and candidate, and the candidate's authenticator matches the receipt.
  - The executor greps the remaining `createControlBuildPort({` sites for invented `commit:` literals and migrates each one found, listing them in the commit message;
- `mls-rpc/src/control-journal.ts:6-56` (optional `referencedProposals`, `candidateAuthenticator`);
- `mls-rpc/src/control-validation.ts:193,246`;
- `mls-rpc/src/access.ts:79-185` (simple access);
- `mls-rpc/src/registry/cold.ts:50` (`restoreValidated`), `mls-rpc/src/registry/access.ts:277` (`ordinaryDestination` :330-370 as well);
- `mls-rpc/src/registry-group-mls.ts:346`, `mls-rpc/src/mls.ts:806,894`, `mls-rpc/src/recovery.ts:263,494,584`;
- `mls-rpc/src/memory-group-persistence.ts:745-790`;
- `mls-rpc/src/revoke.ts:36-51`;
- `rpc/src/control/store.ts:111-133`;
- the doubles `mls-rpc/test/fixtures/transactional-access.ts:284-300,365-540`, `sealed-control-access.ts:29-185`, `sealed-memory-mls.ts:521-550` and `storage-persistence.ts:990-1000`;
- `tests/integration/test/app-lane-e2e.ts:369-440,715`.

Tests: `mls-rpc/test/owed-commit.test.ts`, `mls-rpc/test/authoring-access.test.ts`, `mls-rpc/test/authoring-permit-callers.test.ts`.

**Interfaces:**
- **`controlAdoptionAllowed(snapshot, source, expected, compatible?)`** (Codex r4 I8).
  - When `expected.journal !== undefined` and `compatible` is supplied, it replaces `source.stateVersion !== expected.stateVersion` with `!compatible(expected.journal)`.
  - When `compatible` is omitted, the exact version check stays.
  - Callers (`grep -rn "controlAdoptionAllowed("` gives four):
    - `memory-group-persistence.ts:778` passes the real callback, `controlCompatible(decode(j.sourceState), decode(prior.state), j.referencedProposals)`;
    - `transactional-access.ts:294` passes the same over its real `row.state` (`:88`);
    - `control-store-conformance.test.ts:153` stays unchanged (JSON fixture state, `rpc-conformance/src/control-store.ts:313-335`);
    - `rpc/test/fixtures/host-db.ts:316` stays unchanged (Lane B).
    The last two keep exact versions, which is stricter. No caller passes an unconditional `true`.
- **Compatibility test.** Each journal-bearing adoption computes `controlCompatible(sourceState, currentState, journal.referencedProposals)`, with `currentState` decoded from the stored bytes read in the same transaction (Codex r2 #10).
  - `control-adoption.ts` prepare: the `stateVersion` part of both `sameStoredValue(source, …)` checks becomes that result.
  - `ordinaryDestination`: key and identity equality plus that result.
  - The work-phase CAS at `registry/access.ts:463-468` is unchanged.
- **Sticky restriction at every issuance point** (Codex r6 C1; ruling). Every handle that mls-rpc creates or that an access implementation hands out is passed through `restrictCommitAuthoring` before any host code can see it:
  - **Simple access** (`access.ts`): the `params.handle()` result in the `readControl` helper (:79-95, which also serves `refresh` and `replace`), `read` (:142), `mutate` (:148) and `open` (:175). Also `next` in `replace`, before `params.adopt(next)`.
  - **Registry access:** `restoreValidated` (`registry/cold.ts:50`) restricts what it returns. That covers `isolated()` (`registry/access.ts:87`), and so `read` (:113), `refresh` (:130), `replace`'s current (:412), `mutate` (:515) and the committed source (:555). It also covers the candidate from `params.restoreCandidate` (:277).
  - **Transactional double:** `restore()` (`transactional-access.ts:365-375`) restricts what it returns. That covers `live` (:376), `readControl` and `refresh` (:406-446), `mutate`'s `working` (:458), `replace`'s current and `prepare` (:491, :502) and `open`'s `working` (:523-532). `live = next` (:397) also restricts `next`.
  - **Sealed-control double:** `read()` (`sealed-control-access.ts:29-50`, restore at :39), `live = fallback` (:51), `refresh` (:125), `replace`'s `prepare` (:148), `live = next` (:159) and `mutate` (:163-179).
  - **Library-internal handles** in `mls-rpc/src`:
    - `restoreGroup` at `registry-group-mls.ts:346`, `control-validation.ts:193`, `mls.ts:806`, `mls.ts:894` and `recovery.ts:494`;
    - `restoreCandidate` results at `control-adoption.ts:30` and `control-validation.ts:246`;
    - `joinGroupExternal` at `recovery.ts:263` and `:584`. It returns a result object, so the restriction targets its `.group` (Codex r7 minor);
    - `new GroupHandle` at `control-validation.ts:109` (the `working` copy used to process a commit);
    - `environment.restore` at `registry/cold.ts:146` (`loadValidatedGroup`), alongside the one inside `restoreValidated` (:55).
    Each handle is passed to `restrictCommitAuthoring` at creation.
  - **Documented non-authoring constructor:** the memory double's `#projection()` (`sealed-memory-mls.ts:384-396`) builds a transient `GroupHandle` for each read getter (`ledger`, `roster`, `registry`, `sendAdmission`, :399-443). It never escapes its getter, so no host code can author on it. The caller test allowlists it by name.
  - A refreshed handle, a returned handle, a handle kept by a continuation and a clone derived from any of them all stay restricted. Delegating wrappers inherit this: `registry-group-mls.ts:265-268`, `registry-handle-access.ts`, and the integration wrappers `hub-migration.test.ts:271`, `branch-abandoned.test.ts:157` and `fixtures/fork-halt.ts:176`.
  - `authoring-permit-callers.test.ts` also asserts that every `restoreGroup(`, `restoreValidated(`, `restoreCandidate(`, `environment.restore(`, `new GroupHandle(` and `joinGroupExternal(` site in `mls-rpc/src`, and in the four access fixtures, reaches `restrictCommitAuthoring` (for `joinGroupExternal`, on `.group`). The exceptions are the permit restore in `control-build.ts` and the allowlisted `#projection()`.
- **Control-build is the only permit holder** (Codex r6 I2, I8; ruling Q4):
  - `createControlBuildPort` gains an optional `restoreSource(source: { state: Uint8Array; credential: MemberCredential; ledgerEntries: Array<string> }): Promise<GroupHandle>`. The default is `restoreGroup` over `decodeClientState(state)` (a fresh decode, so no state object or buffer is shared), with the captured handle's environment taken inside the capture scope, as `mls.ts:894-905` does:
    - `ciphersuiteName` from `context.cipherSuite.id`;
    - `cryptoProvider` returning that suite (`mls.ts:806-815` pattern);
    - `keyRetention` from `context.clientConfig.keyRetentionConfig` (`group-context.ts:71`);
    - `commitPolicy`, `resolveLedgerEntries` and `onLedgerEntries` (`group-handle.ts:480-490`).
  - **Double adapter** (Codex r6 I3, r7 minor). `restoreMemoryControlHandle` (`sealed-memory-mls.ts:468`) takes `state: ClientState`, not bytes. So the memory fixtures pass an adapter:
    ```ts
    restoreSource: async ({ state, credential, ledgerEntries }) => {
      const decoded = decodeClientState(state) // fresh decode, no shared buffers
      if (decoded === undefined) throw new TypeError('Invalid control source state')
      return restoreMemoryControlHandle({ state: decoded, credential, ledgerEntries, options })
    }
    ```
    `options` is the fixture's captured group environment. The adapter keeps `MemoryControlHandle` and its model registration.
  - `prepareBuild` replaces `params.build(saved, handle)` (:267) with `withCommitPermit(() => restoreSource({ state: sourceState, credential: sourceCredential, ledgerEntries: sourceLedger }), (permitted) => params.build(saved, permitted))`. The build therefore runs on exactly the journal's source, even if simple access's live handle moved after capture.
  - **Receipt check, before framing** (Codex r6 I8, r7 I1). The checks run right after `params.build` returns and before `frame` (:275) or `saveBuilt` (:319). Unless all of these hold, the result is `{ kind: 'rejected', reason: 'commit not built under the control-build permit' }`, with nothing framed, saved or handed to the network:
    - `receipt !== null`;
    - `receipt.commit` is byte-equal to `host.commit`;
    - `host.digest === digestAppliedCommit(receipt.commit)` (`rpc/src/classify.ts:165`, exported at `rpc/src/index.ts:44`);
    - `receipt.epoch === host.epoch`;
    - `receipt.authenticatorBefore` equals `host.authenticatorBefore`;
    - the candidate check: `createControlBuildPort` gains a required `restoreCandidate(candidate: Uint8Array): Promise<GroupHandle>`, the same hook control-adoption and validation take. `prepareBuild` restores `host.journal`, restricts the result (a creation site), and requires its `state.keySchedule.epochAuthenticator` to equal `receipt.candidateAuthenticator`.
  - The journal gains `referencedProposals` and `candidateAuthenticator` from the receipt. Both are optional in `ControlJournal` version 1 and validated when present.
  - Adoption (`control-adoption.ts:30`, `registry/access.ts:277`) and `control-validation.ts:246` also refuse a restored candidate whose `epochAuthenticator` differs from `journal.candidateAuthenticator`. That is defensive only; the build-time check above already refused the mismatch.
  - **Ordering** (Codex r6 minor): source frames the bytes at `control-build.ts:275`, then persists at `saveBuilt` (:319). Network handoff follows persistence (the rpc publication funnel checks the saved slot before `mux.publish`). Host `build` and `frame` callbacks see bytes before persistence, and keeping them pure is a trusted-code requirement.
- **Memory double integration** (Codex r6 I3). `buildSealedMemoryOperation` (`sealed-memory-mls.ts:521-550`) runs its synthetic construction through `authorPrivateCommit(handle, …)`. Its receipt is:
  - `commit`;
  - `referencedProposals: []`;
  - `epoch` and `authenticatorBefore` from the model before `buildCommit`;
  - `candidateAuthenticator` from the model after `adopt`, before `restoreState`.
  So a restricted memory handle refuses, a permit allows one build, and control-build's receipt check passes. `storage-persistence.ts:998` keeps passing the build's handle, which is now the permitted memory clone.
- **The revision 5 owed-commit block stays removed.** `prepareBuild` refuses a second build while `commitOnce` holds the epoch (`control-build.ts:232-236`).
- **In-repo authoring outside control-build** (verified; Codex r6 confirmed it complete):
  - `revoke.ts:66` is routed. `buildRevokeProofOperation` (`:36-51`) gains a required `group` (the handle `build` received), reads only the incarnation through `readControl`, and builds on `group`. This is breaking; see Task 18.
  - `app-lane-e2e.ts` passes `supplied` under `createControlBuildPort` (:436, :715). Its `supplied === undefined` branch serves direct bare calls only.
  - `mls.ts:974` `bootstrapLedger` does not commit (`group-handle.ts:716-790`).
  - `registry-group-mls.ts:265-268` is a passthrough.
  - `recovery.ts:263,584` are public external commits; their handles are restricted anyway.
  - There are no hits in `rpc/src`, `mls-hub/src` or `hub-*/src`.
  - Bare-handle test sites stay unmarked. A test that builds on a handle an access issued, including the host handle given to `simpleHandleAccess` after its first issuance, is migrated to control-build or to a separate bare handle. The executor lists each migrated site in the commit message.

- [ ] **Step 1: Write failing tests.**
  - `authoring-access.test.ts`: real MLS, `test.each` over all four implementations (simple, registry, transactional double, sealed-control double), each with no commit owed and with a commit owed (built-save done). Every row expects `CommitAuthoringRefusedError` and asserts no new journal, `commitOnce` or Welcome:
    - `mutate((h) => commitKeyRotation(h))`; the stored state bytes and version are unchanged.
    - `mutate(async (h, persist) => { await persist(h); return commitKeyRotation(h) })` (Codex r5 C2). The version may move by the explicit save's one step, and the stored bytes equal what `persist` saved (Codex r6 minor).
    - `mutate((h) => h.proposeSelfRemoval())`.
    - **Returned handle** (Codex r6 C1): `const h = await access.read((h) => h)`, then `commitKeyRotation(h)` twice.
    - **Delayed continuation:** `mutate` schedules `setTimeout(() => commitKeyRotation(h))` and returns; the continuation refuses.
    - **Refreshed handle:** `readControl(async (s) => commitKeyRotation((await s.refresh()).handle))`.
    - **Candidate and live after adoption:** after an own commit is adopted, the handle `read` issues refuses.
    - **`open` and replacement `prepare`** where the implementation supports them (Codex r6 I4): simple and transactional `open`; replacement `prepare` on all four.
  - `control-build builds under the permit on every implementation`. `prepareBuild` saves a slot whose journal carries `referencedProposals: []` and the candidate authenticator. The double row runs through `buildSealedMemoryOperation` and the storage contract runners (`storage-persistence.ts`).
  - `the permit clone is independent and exact` (Codex r6 I2). Simple access: between `prepareBuild`'s capture and its `build`, a `mutate` receives an app frame. The built commit's `authenticatorBefore` and the journal's `sourceState` agree, and the permitted handle's `state` shares no object or `ArrayBuffer` with the live handle's (walk `secretTree` buffers).
  - `a host commit off-permit is rejected` (Codex r6 I8). These return `rejected` and save nothing:
    - a `build` that builds on a bare restored handle;
    - a `build` that builds C1 on the permitted handle and then returns a cached C2;
    - a `build` that returns C1's commit bytes with cached C2's candidate journal (Codex r7 I1);
    - a `build` that returns C1 with another `digest`.
    For each: no journal, no `commitOnce`, no Welcome row, `frame` never called (spy), and `mux.publish` never called in the rpc-level variant.
  - `overlapping double builds refuse before construction` (Codex r7 I2), through the real `buildSealedMemoryOperation`:
    - two concurrent calls on the permitted handle: the second rejects with `CommitAuthoringRefusedError` and the model's `buildCommit` runs once;
    - a `setTimeout` continuation that calls it again after the first has restored its model: it refuses too.
  - **Clone/restore on all four implementations** (Revision 7 ruling; Codex r7 minor). After reconstructing the access (a new registry, a transactional reopen, a sealed restore, and simple access with the host handing back a newly restored handle through `params.handle()`), the newly issued handle refuses. So does an adopted candidate.
  - `buildRevokeProofOperation builds on the supplied handle`.
  - `authoring-permit-callers.test.ts`: the caller pins from Task 5b, and the restriction wrapping of every creation site listed above.
  - `owed-commit.test.ts` (real MLS, two members):
    - `adoption refuses a commit whose source moved` (Codex r3 C1, with remote processing). The own proposal is written outside access, on a bare handle restored from stored bytes, through the raw state port with an exact CAS. The other member's processing of C fails with `Desired gen in the past`, and adoption returns `moved` in all four layers.
    - `foreign proposal after built-save keeps the owed commit` (Codex r4 C1; mirrors `control-adoption.test.ts:239`). The other member proposes on its bare handle, and the local member processes it through `access.mutate`. Adoption returns `installed`, and the proposal needs reproposal (spec:576). Repeat after a registry reconstruction.
    - `history eviction after built-save keeps the owed commit` (Codex r5 I5). `control-adoption.test.ts:152-225` stays green, and the same sequence runs on the registry.
    - `receive saves between evidence and adoption keep the own commit`.
    - `non-journal adoption keeps the exact version`.
    - `adoption caller without a callback keeps the exact version`.
- [ ] **Step 2: RED.** `kbuild && ktest @kumiai/mls-rpc test/authoring-access.test.ts test/owed-commit.test.ts test/authoring-permit-callers.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc test/authoring-access.test.ts test/owed-commit.test.ts test/authoring-permit-callers.test.ts test/control-adoption.test.ts test/registry-access.test.ts test/control-build.test.ts test/control-store-conformance.test.ts test/manual-recovery-conformance.test.ts test/transactional-access.test.ts test/storage-conformance.test.ts && rtk proxy pnpm --filter @kumiai/mls-rpc exec vitest run --maxWorkers=4 && rtk proxy pnpm --filter @kumiai/integration-tests exec vitest run --maxWorkers=4 && ktest @kumiai/rpc test/control-store.test.ts && kports && kfinish`. `control-adoption.test.ts:152` and `:239` stay green unchanged. Mutation checks:
  - removing the restriction from the transactional double's `restore()` must fail its returned-handle row (a double may not be more permissive);
  - removing it from simple access's `refresh` path must fail the refreshed-handle row;
  - dropping the receipt byte comparison must fail the cached-C2 row;
  - deleting the compatibility check in `ordinaryDestination` must fail `adoption refuses a commit whose source moved`.
- [ ] **Step 5: Commit.** `git commit -m 'fix(mls-rpc): access-issued handles are restricted; control-build holds the only commit permit'`.

### Task 7 (A): Registry double carries a fake MLS-framed AEAD app model

**Files:** Modify `mls-rpc/test/fixtures/sealed-memory-mls.ts` (`envelope` :178-258, `captureReceiveState` :289-305, `MemoryControlHandle` :327-450, model serialisation) and `mls-rpc/test/fixtures/registry.ts:484-497`. Test: `mls-rpc/test/registry-double.test.ts`.

**Interfaces:**
- **Overrides.** `MemoryControlHandle` overrides `encrypt`, `decrypt` and `decryptStaged` with the `GroupHandle` signatures (`group-handle.ts:973`, `:1016`, `:1067`).
- **Wire.** A real MLS `PrivateMessage` encoding (group id, epoch, content type application, `authenticatedData`), so `readMessageEpoch`/`readMessageAAD` (`mls/src/group-info.ts:28`, `:51`) parse it.
  - `encryptedSenderData` carries the sender leaf and generation.
  - `ciphertext` is the payload under an HMAC-SHA256 keystream, plus a 32-byte tag.
- **Tag.** HMAC-SHA256 keyed by `fakeEpochSecret(epoch, 'app', authenticator)`, over group id, epoch, sender leaf, generation, `authenticatedData` and ciphertext.
- **Ratchet.** It lives in the projected `secretTree.leafNodes[2 * leaf].application` as a real `GenerationSecret` shape:
  - `generation` is the next unseen generation; skipped generations sit in `unusedGenerations`, with indices below `generation`.
  - The forward limit and skipped-key retention are read from the handle's `keyRetentionConfig` (registry: ≥ 1,000 each; `validation.ts:21-30`).
  - A larger jump refuses with `'Desired generation too far in the future'`. An evicted or spent generation refuses with `'Desired gen in the past'`.
  - Retained epochs are trimmed to `retainKeysForEpochs`, and a retained past epoch opens from its tree.
- **Order.** Content type, AAD, sender lookup, lapse (`group-handle.ts:1090`), tag, generation. `decryptStaged` adopts the stepped tree only after `persist` resolves.
- **Epoch change.** `envelope` builds `leafNodes[2 * i]` for every roster slot, at generation 0, with `intermediateNodes: {}`. This replaces the single intermediate node 0 at `:240-244`.
- **Durable snapshot.** The serialised model (`confirmationTag`) excludes secret trees, which live in the envelope.
- **Authoring.** Own handshake authoring in the double advances `leafNodes[2 * own].handshake.generation`, so Tasks 5-6 hold in double mode.
- **Exporter.** Unchanged (`fakeEpochSecret`). Groups are all-double or all-real, never mixed.

- [ ] **Step 1: Write failing tests** (two-member double group, local leaf 1, double sender):
  - `double frames parse as MLS private messages`;
  - `double opens a member frame once`;
  - `double compares AAD before consuming`;
  - `double tag binds epoch, sender and AAD`;
  - `double staged failure keeps the key`;
  - `double unnamed sender refuses`;
  - `double progress survives encode and restore` (RED);
  - `double opens across an epoch transition` (RED: `No intermediate nodes found in path from leaf to root`);
  - differential rows in both modes through a shared helper: `generation beyond the forward limit refuses`, `evicted skipped generation refuses`, `retained past epoch opens; an evicted epoch refuses`, `lapsed sender refuses`.
- [ ] **Step 2: RED**, **Step 3: implement.** If the model cannot restore without secret trees, stop and report BLOCKED.
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc test/registry-double.test.ts test/registry-conformance.test.ts test/control-compat.test.ts && kfinish`. Mutation-check by dropping the forward limit: the forward-limit row must fail in double mode.
- [ ] **Step 5: Commit.** `git commit -m 'test(mls-rpc): registry double fake MLS-framed app crypto with real limits'`.

### Task 8 (A): Registry mixed-result openBatch and pending

**Files:** Create `mls-rpc/src/registry/app-open.ts`, `mls-rpc/test/registry-open-batch.test.ts`. Modify:
- `mls-rpc/src/registry/types.ts:34-50`;
- `mls-rpc/src/registry/registry.ts:377-395` (Codex r8 #1): the public object `registry.access()` returns forwards members one by one (`read`, `readControl`, `mutate`, `replace`, `adopt`, `onRetire`), so it also forwards `openBatch: access.openBatch` and `pending: access.pending`. Without this, the port type fails to check, and Task 9's `typeof access.openBatch === 'function'` dispatch falls back to the legacy path;
- `mls-rpc/src/registry/access.ts` (hoist `isolated` :78-108, `recordFor` :195-220 and `assertSafety`/`assertWorkSafety` :69-77; spread the members at :662-694);
- `mls-rpc/src/persistence-types.ts:337-356`;
- `mls-rpc/src/index.ts`;
- the mirrors `rpc-conformance/src/registry-fixture.ts:83-111` and `persistence-fixture.ts:543-565`.

**Interfaces:**
- Internal factory: `createRegistryAppOpen<TTx>(params: { owner; capability; isolated(reads, assertMutationSafety?): Promise<ControlRead>; recordFor(handle, value): ReadableGroupState; assertAvailable(); assertCurrent(); assertSafety(); assertWorkSafety(stores); publish(); diagnoseFailure(error) }): Pick<RegistryHandleAccess, 'openBatch' | 'pending'>`.
- `recordFor` gives `version + 1` (`access.ts:208`). A receive save is an ordinary exact-CAS save.
- `app-open.ts` defines its own `Noop`.
- **Occurrence matcher** `sameOccurrence(a, b)`: equal `id`, `topicID`, `segment` and `position`. It serves both in-batch and saved replay.

- [ ] **Step 1: Write failing tests** (both modes; a second member seals `encodeEventFrame` bytes under `encodeAppAAD({ topicID, intent: 'log' })`; ids from `frameID(topicID, ciphertext)`; 12-digit positions):
  - `mixed batch commits once in input order`. Inputs [valid A@1, malformed B@2 (`fromUTF('{}')` sealed), wrong-AAD C@3, valid D@4] give `opened`, `malformed-plaintext`, `wrong-aad`, `opened`. The lifetime revision and `stateVersion` each advance by exactly 1.
    - `appFrame` finds A and D pending, and B as poison with `keyConsumed: true`.
    - Record A has `procedure: 'posted'`, `epoch` equal to the handle epoch, the sender DID, and `idempotencyKey === appFrameIdempotencyKey(A.frame)`.
  - `refused and held inputs commit no transition`: junk, a non-retained past epoch and a future epoch give `invalid-ciphertext`, `past-epoch` and `future-epoch` (`frameEpoch: e + 1, handleEpoch: e`). The revision and `inspectRows()` are unchanged.
  - `retained past epoch opens`: the record has `epoch: e` after the registry applied e+1.
  - `wrong-topic sibling burns no generation and valid siblings open`: F sealed with AAD X and submitted with Y next to valid G. G opens, and F submitted with X then opens.
  - `duplicate frame in one batch yields one pending record`: [A@1, A@1].
  - `same ciphertext at another position refuses as duplicate`: [A@1, A@5], and a later [A@5].
  - `same id at another segment refuses as duplicate`.
  - `saved rows resolve on exact occurrence match`: rerunning [A@1, B@2] returns the same record and malformed refusal, with no transition.
  - `completed frame refetch refuses without a write`.
  - `occurrence behind the durable cursor refuses before decryption` (Codex r6 I7). With the cursor at `'B'`, an unseen valid ciphertext at `'A'` gives `duplicate`, `keyConsumed: false`. The state bytes, `stateVersion`, revision and `inspectRows()` are unchanged, and the frame still opens when submitted at `'C'`. Repeat after reconstruction, and with 12-digit positions.
  - `cursor moved between prepare and work re-prepares`: a fault hook saves the cursor past the input after prepare. The attempt throws internally, the second attempt refuses as `duplicate`, and nothing is persisted.
  - `invalid position refuses that input only`: `''` and 65 characters.
  - `receive save conflict re-prepares`: the fixture fault point `before-work` (add it to `fixtures/registry.ts:162` if absent; test fixture only) bumps the stored version once. `openBatch` resolves on the second attempt. Three consecutive bumps reject with `GroupStateConflictError`.
  - `safety hold rejects the whole batch`: `f.safety().reportFork(key, { kind: 'epoch-authenticator', … })` as in `clear-hold-storage.test.ts:43-56`. Expect `GroupSafetyHeldError` and no row change.
  - `batch bound`: 65 inputs give `RangeError`, with no read.
  - `foreign incarnation key rejects before any read` (`DisplacedGroupHandleError`).
  - `public registry.access() exposes openBatch and pending` (Codex r8 #1), in real and double modes. `typeof registry.access(key).openBatch === 'function'`, and `pending` is defined. A frame opened through the public object appears in `pending.list()`. After Task 9, `createGroupCrypto({ access: registry.access(key) })` dispatches to the registry `unwrapBatch` path (a spy on `openBatch` is called), not the legacy `mutate` open.
  - `pending lists in comparator order and completes idempotently`. `complete(id)` twice and `complete('unknown')` resolve, the unknown call writes no transition, and `complete` leaves `stateVersion` unchanged. Neither `list` nor `complete` is gated by app safety.
- [ ] **Step 2: RED.** `ktest @kumiai/mls-rpc test/registry-open-batch.test.ts`.
- [ ] **Step 3: Implement `openBatch`.**
  - Empty input gives `[]` with no run. More than 64 inputs throw `RangeError`. A GroupKey mismatch throws `DisplacedGroupHandleError`.
  - Then up to `RECEIVE_SAVE_ATTEMPTS` (3) runs of `capability.run({ groupID, mutationID: crypto.randomUUID() }, prepare, work)`. Retry only on the receive-source `GroupStateConflictError` raised in work.
  - **Prepare:** `assertSafety()`, then `{ handle, source } = await isolated(reads, assertSafety)`. Per input, first match wins:
    1. Not `isAppLogPosition`: `invalid-position`.
    1b. `reads.appCursor(n, topicID)` (one read per topic per attempt) is non-null and `compareLogPositions(cursor, position) >= 0`: `duplicate`, `keyConsumed: false`, with no decryption (Codex r6 I7). Without this, `pending.put` (`memory-incarnation-stores.ts:474`) would skip the record while the state save still committed the consumed key.
    2. An earlier input with the same id: its result on `sameOccurrence`, else `duplicate`.
    3. `reads.appFrame(n, id)`: the saved result on `sameOccurrence`, else `duplicate`.
    4. `readMessageEpoch` undefined: `invalid-ciphertext`. Above the handle epoch: future-epoch. Below it and absent from `handle.state.historicalReceiverData`: past-epoch.
    5. `expectedAAD` is set and `readMessageAAD` is null or different: `wrong-aad`.
    6. `handle.decryptStaged(ciphertext, { expectedAAD }, async (_s, opened) => { decoded = decodeAppEventPlaintext(opened.payload) })`. A throw gives `invalid-ciphertext`. A null decode gives malformed, and stages a poison row. Otherwise build the opened record.
  - If nothing was staged, throw `Noop(results)`. Otherwise return `{ expected: lifetime, mutationID, value: { source, record: recordFor(handle, owner.value), puts, poisons, results } }`.
  - **Work:** `assertCurrent()`, then `assertWorkSafety(stores)`. Reload the state: if its `version` differs from `source.stateVersion`, throw `GroupStateConflictError('Receive source moved')`. Cursor writes are off the version clock (Task 5), so also re-read the cursor of each staged topic. If any staged position is now at or before it, throw `GroupStateConflictError('Receive cursor moved')`; the attempt re-prepares, and step 1b then refuses that input. Then `state.save(record)`, `pending.put(puts)` and `pending.poison(poisons)`.
  - Errors go to `diagnoseFailure`; `finally publish()`.
- [ ] **Step 4: Implement `pending`.**
  - `list`: `capability.read` with `reads.pendingFrames(n)`, then `sortPendingAppFrames` (`rpc/src/crypto.ts:249`), then defensive copies.
  - `complete(id)`: one transition. Prepare throws `Noop` when `appFrame(n, id)` is null on both sides; work calls `pending.complete([id])`.
  - Neither runs `assertSafety` or `assertWorkSafety`.
- [ ] **Step 5: GREEN.** `kbuild && ktest @kumiai/mls-rpc test/registry-open-batch.test.ts test/registry-access.test.ts test/registry-conformance.test.ts test/retention.test.ts && kfinish`. Enable the Task 4 `.todo` row. Mutation-check the wrong-topic row by dropping `expectedAAD` and step 5.
- [ ] **Step 6: Commit.** `git commit -m 'feat(mls-rpc): registry mixed-result openBatch with owned pending'`.

### Task 9 (A): Registry createGroupCrypto overload

**Files:** Create `mls-rpc/src/registry-crypto.ts`, `mls-rpc/test/registry-crypto.test.ts`. Modify:
- `mls-rpc/src/crypto.ts:131-135` (overload, widened implementation signature, dispatch on `typeof params.access.openBatch === 'function'`);
- `mls-rpc/README.md` (Exports, "Registry app crypto", :585);
- `mls-rpc/test/readme-persistence.test.ts` if it compiles snippets.

**Interfaces:**
- `epoch`, `exportSecret`, `sealEntries`, `openEntries`, `frameEpoch` and `frameAAD` reuse `crypto.ts:148-208` and `:288-293`, factored and not copied.
- `wrap` and frame-less `unwrap` keep `mutate` (A4).

- [ ] **Step 1: Write failing tests** (rpc's narrow ref `{ id, topicID, protocol, segment, position }`):
  - `durable unwrap opens through one transition and lists the record`: the call resolves `{ payload, senderDID, epoch }`. `pending.list()` has one record with `access.key`'s GroupKey and `procedure`.
  - `singleton results map to rpc errors`:
    - a non-retained past epoch gives `FrameEpochError` (`frameEpoch < handleEpoch`);
    - future gives `isFrameAhead === true`;
    - malformed gives `InvalidAppEntryError`;
    - `wrong-aad`, `invalid-ciphertext`, `duplicate` and `invalid-position` give an `Error` that is neither `FrameEpochError` nor `AppFrameStorageError`.
  - `retained past epoch unwraps`.
  - `storage failure is AppFrameStorageError and writes nothing` (`armNextWorkFault('after-first-write')`). A retry then opens.
  - `a frame bound to another incarnation never completes as dead`: `AppFrameStorageError` with a `DisplacedGroupHandleError` cause, and no row changes.
  - `replayed unwrap returns the saved record`: both calls resolve with equal payload and sender, and one row exists.
  - `unwrapBatch never rejects valid siblings`: [junk, valid] gives [refused, opened].
  - `fork-halted rejects before any read`: `unwrap` and `unwrapBatch` both give `GroupSafetyHeldError('fork-halted')`.
- [ ] **Step 2: RED**, **Step 3: implement.**
  - Durable unwrap stamps the GroupKey from `access.key` when the ref omits it. A different supplied key throws `AppFrameStorageError` with a `DisplacedGroupHandleError` cause.
  - Call `access.openBatch([one])` and map per spec:1340. Map only `openBatch` rejections to `AppFrameStorageError`, with the cause attached. `GroupSafetyHeldError` and `RangeError` pass through.
- [ ] **Step 4: GREEN.** `kbuild && ktest @kumiai/mls-rpc test/registry-crypto.test.ts test/crypto.test.ts test/crypto-safety.test.ts test/readme-persistence.test.ts test/ports-conformance.test.ts && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'feat(mls-rpc): registry GroupCrypto routes durable unwrap to openBatch'`.

### Task 10 (A): Contract suites on registry crypto, real and double

**Files:** Create `rpc-conformance/src/registry-crypto.ts`, `mls-rpc/test/fixtures/registry-crypto.ts`, `mls-rpc/test/registry-crypto-conformance.test.ts`. Modify:
- `rpc-conformance/src/pending-group-crypto.ts` (the replay row, the encoder, optional `unnamedSender` and optional `probeRestored`);
- `rpc-conformance/src/index.ts`, `rpc-conformance/src/persistence-fixture.ts`;
- the runners `rpc/test/ports-conformance.test.ts:97` and `mls-rpc/test/ports-conformance.test.ts:129`.

**Interfaces:**

```ts
type RegistryCryptoFixture = {
  key: ConformanceGroupKey; topicID: string; senderDID: string
  access(): Promise<{ openBatch(frames: Array<ConformanceOpenAppInput>): Promise<Array<ConformanceOpenAppResult>>; pending: { list(): Promise<Array<ConformanceStoragePendingAppFrame>>; complete(id: string): Promise<void> } }>
  seal(plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>     // second member, current epoch
  sealAhead(plaintext: Uint8Array): Promise<Uint8Array>                 // sender commits a rotation the registry has not applied
  advanceRegistry(): Promise<void>  // applies the outstanding sealAhead rotation if any, else a fresh sender rotation
  frame(ciphertext: Uint8Array, position: string): ConformancePreOpenAppFrameRef // id = frameID(topicID, ciphertext)
  armNextWorkFault(point: 'after-first-write' | 'commit-then-reject'): { mutationID: Promise<string> }
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
  inspectRows(): Promise<Record<string, Map<string, unknown>>>
  reopen(): Promise<RegistryCryptoFixture>; close(): Promise<void>
}
```

- **Pending-suite fixture changes.** It adds `encode?(text)` (UTF-8 by default), makes `unnamedSender` optional, and adds optional `probeRestored(): Promise<{ unwrap(bytes, opts): Promise<GroupUnwrapResult> }>`. `probeRestored` is an independent crypto over a copy of the stored rows taken right after the failed durable unwrap, discarded after use (Codex r2 #9).
- **Storage-failure row** (`pending-group-crypto.ts:137`). With `probeRestored`, step 2 (the frame-less unwrap succeeds) runs on the probe, and step 3 (the original durable unwrap succeeds) runs on the fixture. Without it, the row is unchanged.
- **Registry fixture properties:**
  - `failPersist(yes)` arms `after-first-write` only before `openBatch` calls that would stage a write. Frame-less `mutate` is never faulted.
  - `liveContextOwned` is `true`, `saveHandle` is a no-op, and `persistCalls` counts lifetime revisions.
  - `unnamedSender` is omitted: the real refusal is at `group-handle.ts:1106`, and the double pins its own in Task 7.

- [ ] **Step 1: Edit the pending suite.**
  - In `durable open saves a record…`, assert length 1 plus `toMatchObject({ frame: ref, payload, senderDID })`.
  - A replayed unwrap either refuses or resolves `toMatchObject({ payload, senderDID })`; `pending.list()` stays at length 1 before and after `restore()`.
  - Payloads come from `fixture.encode`. The `unnamed` row runs only when `unnamedSender` is present. Add the `probeRestored` branch.
- [ ] **Step 2: Write `testRegistryCryptoConformance` rows:**
  - `pre-open reference carries no procedure; opened record derives it`.
  - `open N, crash mid-batch commits all or none`: `after-first-write` on 3 frames rejects. After `reopen()` no rows exist, and the same 3 then open.
  - `ambiguous commit resolves the whole batch once`: `commit-then-reject` on 3 frames resolves 3 `opened`. After `reopen()`, `resolve(mutationID) === 'committed'`; a replay returns 3 byte-identical records; the row count is 3.
  - `replay resolves saved pending before reopening`: the record is deep-equal across `reopen()` (payload, sender, epoch, incarnation, idempotencyKey).
  - `completed frame refetch is refused without a key or row`.
  - `future and unopenable inputs leave pending empty`; after `advanceRegistry()` the held frame opens.
  - `frames open across an epoch transition, retained epoch included`.
  - `pending order survives reopen`: 12-digit positions; both `list()` calls follow `compareLogPositions`.
  - `duplicate and invalid positions write nothing`.
- [ ] **Step 3: Fixture and runner.** Build on `createRegistryFixture({ mode })` for `real-mls` and `double`.
  - Real mode seeds two members via `commitInvite`/`processWelcome` (`fixtures/registry-welcome.ts`); double mode seeds every member as a double handle.
  - `advanceRegistry` applies the sender commit through `access.mutate((h, persist) => h.processMessage(commit, { persist }))`.
  - The runner also runs `testGroupCryptoConformance` (members[0] registry crypto; the others `testHandleAccess` over same-mode handles) and `testPendingGroupCryptoConformance`, in both modes.
- [ ] **Step 4: Run.** `kbuild && ktest @kumiai/mls-rpc test/registry-crypto-conformance.test.ts`. Fix failures in Tasks 3-9, never in the rows.
- [ ] **Step 5: Verify.** `kports && kfinish`.
- [ ] **Step 6: Commit.** `git commit -m 'test(rpc-conformance): registry crypto contract on real and double'`.

### Task 11 (A, after merging B and C): Registry peers deliver real app frames (integration verification)

**Files:** Modify `mls-rpc/test/registry-peer.test.ts:329-335` and `mls-rpc/test/registry-delivery-safety.test.ts:133-139`: replace each stub with `api.createGroupCrypto({ access: await f.registry.access(key.groupID) })`. Create `mls-rpc/test/registry-app-delivery.test.ts`. Extend `mls-rpc/test/hub-migration.test.ts:956-1000`.

**Interfaces:** This is integration verification, not RED-first. A failing witness is a defect in Tasks 2-10 or 13-16.

- [ ] **Step 0: Merge.** Merge Lanes B and C into A, then `kbuild && kports`.
- [ ] **Step 1: Witnesses** (both modes):
  - `registry peer delivers a durable app frame`: the handler sees the payload once, `crypto.pending.list()` ends empty, and `ports(key).cursor.load(topicID)` equals the frame's position.
  - `opened frame redelivers after restart before completion` (spec:1803):
    - The handler awaits a gate. Start `dispose()` without awaiting it; once disposal has closed delivery, release the gate, then await `dispose()` and `drained()` (Codex r4 m11: the old order never released the gate).
    - Assert disposal prevented completion: `crypto.pending.list()` holds one record and the cursor did not advance. Record the list. Reconstruct.
    - The handler runs again with equal `data` and `senderDID`, and the rpc-owned fields `id`, `topicID`, `protocol`, `segment` and `position` are equal.
    - The pending list is deep-equal to the recorded one until completion. Handler frame shapes differ by A4 until 2.3d.
  - `malformed authenticated plaintext never reaches a handler and the cursor passes it`.
  - `departing-epoch frame delivers after the commit applies`: the local commit applies before F's delivery starts, and F is delivered once.
  - `app metadata and receipt between evidence capture and adoption keep the own commit`:
    - Gate `replace` at entry. Inside the gate, in turn: `registryCrypto.unwrap` one frame (version + 1), complete a pending record, save the app cursor. Release.
    - The outcome is `landed`, `controlHold` is `null`, and the epoch advances once.
    - Mutation-check: put `pending` back on the version clock and remove the compatibility check from `ordinaryDestination`; the witness then fails with `moved`.
  - cf-2e:15: `moved current device receives app frames from a fresh hub over registry crypto / ${mode}`.
- [ ] **Step 2: Migrate the two fixtures.** If a witness needs an rpc change, stop and report BLOCKED.
- [ ] **Step 3: Verify.** `kbuild && ktest @kumiai/mls-rpc test/registry-app-delivery.test.ts test/hub-migration.test.ts test/registry-peer.test.ts test/registry-delivery-safety.test.ts && kfinish`. Run the new file 3 times; wait with `waitFor`, not sleeps.
- [ ] **Step 4: Commit.** `git commit -m 'test(mls-rpc): registry peers deliver real app frames'`.

### Task 12 (A): Retire every registry app-open stub

**Files:**

| # | Site | Treatment |
| --- | --- | --- |
| 1, 2 | `mls-rpc/test/registry-peer.test.ts:332`, `registry-delivery-safety.test.ts:136` | Done in Task 11. |
| 3 | `mls-rpc/test/successor-recovery.test.ts:451` | Registry overload. |
| 4 | `mls-rpc/test/manual-recovery-conformance.test.ts:727` | Registry overload. |
| 5 | `mls-rpc/test/clear-hold-live.test.ts:69` | Overload over `{ ...access, openBatch: spy }`, `spy = vi.fn(access.openBatch)`. While held, `spy` is never called and `inspectRows()` is unchanged. |
| 6, 7 | `tests/integration/test/hub-migration.test.ts:75`, `:273` | :75 uses the overload. :262-277 uses a lazy `RegistryHandleAccess` proxy: `key` returns `current`; `epoch`/`admission` come from `options.mls.sendAdmission()`; `read`, `readControl`, `mutate`, `replace`, `adopt`, `openBatch`, `pending.list` and `pending.complete` each await `fixture.registry.access(current.groupID)` per call and assert its key; `runtime`, `stateVersion` and `onRetire` throw `TypeError('unused')`. |
| 8 | `tests/integration/test/group-conditions.test.ts:106` | Overload. |
| 9 | `tests/integration/test/fixtures/fork-halt.ts:169` | Lazy proxy. |
| 10 | `tests/integration/test/branch-abandoned.test.ts:159` | Lazy proxy. |
| 11 | `mls-rpc/test/fixtures/sealed-control-access.ts:182` | **Kept**: a non-registry `HandleAccess` crash harness, and `HandleAccess.open` stays (A5). |

- [ ] **Step 1: Migrate sites 3-10**, keeping every assertion.
- [ ] **Step 2: Gate.** `rtk proxy grep -rn -A2 "open: async" packages/*/test tests --include='*.ts' | rtk proxy grep "throw new Error"`. Expected: only site 11 and `transactional-access.test.ts:326`.
- [ ] **Step 3: Verify.** `kbuild && ktest @kumiai/mls-rpc test/successor-recovery.test.ts test/clear-hold-live.test.ts test/manual-recovery-conformance.test.ts && CI=true rtk proxy pnpm exec vitest run --root tests/integration test/hub-migration.test.ts test/fork-halt.test.ts test/branch-abandoned.test.ts test/group-conditions.test.ts && kfinish`. The heal-timing flake (cf-2e:38) gets one rerun.
- [ ] **Step 4: Commit.** `git commit -m 'test: retire registry app-open stubs'`.

### Task 13 (B): App work leaves the peer's commit queue

**Files:** Modify `rpc/src/peer.ts` (`advanceHandle` :1715; `pullCommits` :2372; the `scheduleDrain` binding :576-582; the app notice bindings :585-618; `flushHostOutbox` :1250-1260; `dropAppFrame` :5554-5568) and `rpc/src/app-lane.ts` (the past-epoch branch :880-888; `deliver` :937; a new `kick`). Test: `rpc/test/commit-app-decoupling.test.ts`.

**Interfaces:**
- **`kick`.** `appLane.kick()` returns synchronously and never rejects into a caller. `advanceHandle` (:1715) and `pullCommits` (:2372) call it instead of `await appLane.deliver()`.
  - **Coalesced** (Codex r4 I7): at most one active drain plus one requested rerun, the same pattern as `scheduleSync` (`app-lane.ts:718-732`).
  - A `kick` during an active drain sets the rerun flag. Further kicks are no-ops until the rerun starts.
- **Off the serial queue.** The `scheduleDrain` binding (:576) no longer wraps `drain` in `runSerial`. App drains serialise on `runAppLane` only. Every MLS mutation they make goes through `crypto`, which the access/owner entry serialises.
- **`dropAppFrame`** (Codex r4 I5) runs `appLane.dropFrame(topicID, position)` **before** and outside `runSerial`. The `runSerial` block keeps only `settleOperations`, `ensureLedger` and `reconcileCommits`.
- **Handlers.** Non-durable handlers run inside the app drain, never under `runSerial`. A handler that never returns stalls app delivery only.
- **Past epoch.** A past `FrameEpochError` now means "not retained" (Task 2): the frame is done and not delivered, with no wait.
- **App notices** (Codex r5 I10). Today `onAppDeliveryStalled` always pushes into `hostOutbox` (:598-602), while window-pruned and resumed notices push there only when `appNoticeInSerial` is set (:591, :611). `hostOutbox` is flushed only after `runSerial` (:1250-1253). With app drains off the queue, stalled notices would pile up until the next commit operation, and a resumed notice could overtake its stalled one.
  - All app notices (window-pruned, stalled, resumed, and the delivery start, `scheduleDelivery` at :616-619) go into one FIFO, `appNotices`, separate from `hostOutbox`.
  - **Self-scheduled drain, independent of `runSerial`** (Codex r6 I5, r7 I3). `appNoticeInSerial` is one global flag that stays true across every `await` inside a serial operation (`peer.ts:1270-1290`). So "is a serial operation in progress" cannot tell where an enqueue came from: an autonomous app task finishing while a commit operation awaits a withheld fetch would wait for that unrelated operation. The app FIFO therefore never consults it:
    - `enqueueApp(n)` pushes `n`. If no drain is scheduled, it sets `appDrainScheduled` and calls `queueMicrotask(drainAppNotices)`.
    - `drainAppNotices` clears `appDrainScheduled`, swaps the array and runs each entry. Entries enqueued during a drain get a newly scheduled microtask.
    - Notices enqueued synchronously inside a serial task, such as `reset()` from `captureAnchor`, also drain on that microtask. Host callbacks run outside the synchronous serial frame, and nothing in `runSerial` awaits them. A host callback that calls back into the peer queues behind the serial operation, like any external caller, so there is no reentrant deadlock (the hazard the `runSerial` doc names, `peer.ts:1266-1267`, is handing a result to the host under the lock).
    - `appNoticeInSerial` (declared :554, set and cleared at :1273 and :1286) and its three app-notice reads (:591, :611, :617) are removed. `hostOutbox` keeps only commit-lane notices.
    - This matters because `deliver()` calls `scheduleDelivery` in its outer `finally` (`app-lane.ts:943-948`), after its `runAppLane` task has ended.
  - Order is preserved because there is one FIFO. The queue is bounded because every enqueue is followed by a drain within one microtask, and stalled notices are deduplicated per blocking key (`app-lane.ts:269`).
- **Authenticated applied epoch.** The peer keeps `appliedEpoch`: the value of `mls.readEpoch()` after each successful walk or `advanceHandle`. It passes it to the lane as `AppLaneParams.appliedEpoch()`, which Task 14 uses. `crypto.epoch()` is a display hint (`rpc/src/crypto.ts:16`) and is never used for expiry.

- [ ] **Step 1: Write failing tests** (each with the commit arriving **after** the app work has started):
  - `commit applies while an app retry awaits a withheld fetch` (Codex r3 C2).
  - `commit applies while a non-durable handler never returns`.
  - `commit applies while a durable handler never returns`.
  - `dropAppFrame does not hold the commit queue behind app work`: an app drain holds `runAppLane` behind a withheld fetch. `dropAppFrame` is pending, and a remote commit still applies.
  - `kicks coalesce`: 1,000 synchronous `kick()` calls while a drain is active. The drain runs at most twice.
  - `a delivery start queued after the last app task still runs` (Codex r6 I5): one durable frame arrives through an autonomous app pull, with no commit operation, and then nothing else happens. The handler runs, `crypto.pending.list()` ends empty, and the FIFO is empty.
  - `app delivery proceeds while a serial operation is gated` (Codex r7 I3): a commit operation awaits a withheld control fetch inside `runSerial`. Meanwhile an autonomous app pull delivers one durable frame, and a future-epoch frame stalls and resumes 200 times. The handler runs, notices arrive in order, and the FIFO stays ≤ 2 between microtasks. An `onAppDeliveryStalled` callback that starts, without awaiting, a peer operation that enters `runSerial` (a `peer.commit`) does not deadlock: the callback returns at once, and the operation completes after the gate is released.
  - `stall notices flow without commit activity` (Codex r5 I10): a future-epoch frame cycles through 200 timeout/retry rounds with no commit operation. `onAppDeliveryStalled` fires once per blocking episode, `hostOutbox.length` and `appNotices.length` stay ≤ 2 between app tasks, and for each key a resumed notice is delivered after its stalled one.
  - `departing-epoch frame delivers through retention`: F at e arrives after the local peer applied e+1, and it is delivered once.
  - `lag beyond retention leaves frames undelivered without a stall`: fake retention 2, frames at e fetched after e+3. They are done and not delivered, the cursor passes them, and no `onAppDeliveryStalled` fires.
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN.** `kbuild && ktest @kumiai/rpc test/commit-app-decoupling.test.ts test/future-epoch-retention.test.ts test/durable-restart.test.ts test/peer-drained.test.ts && kfinish`. Mutation-check: restoring `runSerial` in `scheduleDrain` must fail the first row.
- [ ] **Step 5: Commit.** `git commit -m 'fix(rpc): app work leaves the peer commit queue'`.

### Task 15 (B): Budgeted, cancellable app pulls outside every reservation

**Files:** Modify `rpc/src/hub-mux.ts` (`MuxFetchTopicParams` :145-150, `fetchTopic` :872-891) and `rpc/src/app-lane.ts` (`AppCursor` :74; `loadSegment` :427-494 and its callers `scheduleSync` :718-732, `drain` :787-790, `deliver` :937-950; `note` :765-785; `reportPrunedWindow` :373-379; `takeAppFrame` :163-170; `blockedByEarlierSealed` :529-535; restore sort :1025-1028; `finishRecord` :537-556). Test: `rpc/test/app-lane-hub-faults.test.ts`.

**Interfaces:**
- **Complete caller refactor** (Codex r4 I5). `loadSegment` becomes `pull()`, which is never called under `runAppLane`:
  1. `runAppLane` snapshot: for each topic (current and departing), `{ topicID, fetched, generation }`. Then release.
  2. Fetch with no reservation held: neither `runAppLane` nor `runSerial`.
  3. `runAppLane` merge: drop the page when `generation !== segmentGeneration` or the topic's cursor moved; otherwise buffer it.

  Callers:
  - `scheduleSync` (:725) becomes `void pull().then(() => runAppLane(advanceCursors))`.
  - `deliver` (:939) becomes `await pull(); await runAppLane(drainBuffered)`.
  - `drain` (:787) no longer calls `loadSegment`; it only opens and delivers what is buffered.
  - Nothing awaits `pull()` while holding `runAppLane` or `runSerial`, so `finishRecord`'s `runAppLane` task never waits on a hub fetch.
- **Budgets** per `pull()`, shared across current and departing topics:
  - `APP_PULL_MAX_PAGES` (4) pages per topic;
  - `APP_PULL_MAX_BYTES` (4 MiB) of payload;
  - `APP_PULL_DEADLINE_MS` (10 s) wall clock.
  Buffered frames per protocol stay ≤ `APP_BUFFER_MAX_FRAMES` (1,000); a full buffer stops pulling.
- **Live staging bound** (Codex r4 I7). `note` (:775) appends to `staged` only while `staged.get(name).length < APP_STAGED_MAX_FRAMES` (1,000), and drops further pushes. Pushes are unauthenticated hints; the next fetch is authoritative.
- **Cancellation.** A per-pull `AbortController` passes `signal`, and `fetchTopic` races the hub call against it.
- **Bounded outstanding requests.** Underlying hub calls that have not settled are counted, aborted ones included. At `APP_OUTSTANDING_FETCHES_MAX` (2), no new fetch starts.
- **Bounded diagnostics.** `reportedPruned` keeps at most `APP_PRUNED_NOTICES_MAX` (64) cursors per topic, evicting the oldest. `reset()` and departing-segment expiry delete that topic's entry.
- **Per-entry hygiene.**
  - `fetched` is the transport token; a new `accepted` is the highest buffered position.
  - Entries with `compareLogPositions(seq, accepted) <= 0` are skipped.
  - `assertForwardPage` is no longer called on app pulls.
  - An `InvalidLogPositionError` page ends that topic's pull without raising.
- **One comparator.** `takeAppFrame`, `orderedRecords`, `blockedByEarlierSealed` and the restore sort use `compareLogPositions`.

- [ ] **Step 1: Write failing tests:**
  - `endless increasing junk stays bounded`: one pull fetches ≤ 4 pages per topic, buffered frames stay ≤ 1,000, and a commit applies meanwhile.
  - `withheld fetch is aborted at the deadline`.
  - `repeated deadlines keep outstanding fetches bounded`: across 50 pulls against a hub that never settles, unsettled calls stay ≤ 2.
  - `hub-driven collections stay bounded` (Codex r3 I7, r4 I7). A non-durable handler hangs and holds the app drain while the hub pushes 10,000 junk frames and serves `gap: true` pages with new cursors. While it hangs, assert:
    - `staged` length ≤ 1,000;
    - `frames.length` ≤ 1,000;
    - queued drains ≤ 1 active + 1 rerun;
    - outstanding fetches ≤ 2.
    Then release the handler (Codex r5 minor: snapshot, fetch and merge pulls need the drain to finish), run 200 more pulls to completion, and assert `reportedPruned` per topic ≤ 64 and the same four bounds. The departing-list and expiry bounds are Task 14 rows.
  - `completion never waits on a fetch` (Codex r2 #4, r3 #4): a handler finishes while another pull's fetch is withheld. `crypto.pending.complete` and the cursor save both happen.
  - `one comparator orders buffer, workers and restore`: `['9', '10', '100']` and `['B', 'a']` are delivered in `compareLogPositions` order before and after restart.
  - `junk mid-page is skipped`; `non-increasing entry is skipped`; `oversized sequenceID page ends the pull without raising`; `reset aborts an in-flight pull and drops its result`.
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN.** `ktest @kumiai/rpc test/app-lane-hub-faults.test.ts test/durable-stall.test.ts test/durable-queue.test.ts test/peer-app-cursor.test.ts test/hub-conformance.test.ts && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'fix(rpc): budgeted cancellable app pulls outside every reservation'`.

### Task 14 (B, after 15): Durable departing anchor topics with their own segment identity

**Files:** Modify `rpc/src/peer.ts` and `rpc/src/app-lane.ts`. Test: `rpc/test/app-departing-topics.test.ts`.
- `peer.ts`: `saveResolvedAnchor` :635-643; `captureAnchor` :645-667; `keepAnchor` :669-676; the pending-rotation save :1738; the construction restore :5333-5337 (Codex r5: not :688, which is `resolveAnchorRotation`'s reload).
- `app-lane.ts`: `reset` :1040; `laneFor` :390-405; the ref stamp :818-826; `advanceCursor` :506-518; `finishRecord` :537-556; `dropFrame` :953-981; `orderedRecords` :521-524; `blockedByEarlierSealed` :529-535; `note` :765-785.

**Interfaces:**
- **One in-memory list, carried by every slot write** (Codex r4 I4, r5 I8). The peer keeps `departing: Array<{ anchor: Anchor; departedAt: number }>`, restored from `stored.departing ?? []` at :5333-5337. Every peer write of the anchor slot includes it (`departing` is omitted when empty):
  - `captureAnchor` (:659) computes `next = [...departing, { anchor: old, departedAt: newAnchor.epoch }]`, trimmed to the newest `RETAINED_EPOCHS_MAX`, and saves `{ anchor: newAnchor, departing: next }`. It assigns `departing = next` only after the save resolves. This one write co-commits the anchor and its departing list (Task 2b).
  - `keepAnchor` (:671) saves `{ anchor, departing }`.
  - The pending-rotation save (:1738) saves `{ anchor, pending: record, departing }`.
  - The landed-proof writers outside the peer already spread or mutate the stored slot (Task 2b premise), so they keep it.
  - `rtk proxy grep -n "anchorStore?.save\|saveResolvedAnchor(" packages/rpc/src/peer.ts` must list four lines: the helper's own `anchorStore?.save(slot)` (:638) and the three writers above, each carrying `departing` (Codex r6 minor).
- **Departure epoch** (Codex r5 minor). `departedAt` is the epoch of the replacing anchor: the `epoch` that `crypto.exportSecret` returned at capture (:649-651), read from the applied MLS state. It is not the later `appliedEpoch` refresh. Frames on a departing topic carry epochs below `departedAt`.
- **Expiry is computed, never written** (Codex r4 I3, r5 I9). A departing topic is pulled while `appliedEpoch() - departedAt < RETAINED_EPOCHS_MAX`, and ignored otherwise.
  - Why that bound: the newest frame on the topic is at `departedAt - 1`. With the maximum retention of 32, it stays openable while `departedAt - 1 >= appliedEpoch() - 32` (Codex probe: retention 2 at epoch 5 keeps `[3, 4]`).
  - App work never writes the anchor slot. An expired entry stays in the list until a later `captureAnchor` trims it. So no app-side save can overwrite a newer anchor or a landed proof.
  - A short or empty page never drops a topic, and `crypto.epoch()` is never consulted.
  - When the lane first sees a topic expired, or a captured trim drops it, it settles everything that topic owns (Codex r6 I6):
    - the in-memory lane, its `staged` entry and its `reportedPruned` entry;
    - every `blockingFrames` key with prefix `` `${topicID}\u0000` `` (`blockingKey`, `app-lane.ts:247`). Each is deleted, and its settle notice is emitted with `settlement: 'expired'`, so the host's stall episode closes and the app can tell the frames were abandoned (Revision 7 ruling Q2; Codex r7 I4). This is not a plain resumption;
    - its frames' `caughtUpTimes` entries (:228).
    Workers and their timers are keyed by protocol (:305-317) and shared with the live topic, so they stay. The future-epoch timer is lane-wide and is cleared only by `reset()`.
- **Settlement discriminator** (Revision 7 ruling Q2; Codex r7 I4). `AppDeliveryResumed` (`app-lane.ts:50`, `Omit<AppDeliveryStalled, 'error'>`) gains `settlement?: 'resumed' | 'expired'`. It is additive and optional in the type, but rpc always sets it:
  - `'resumed'` from `resumeBlocked` (:248-254), `resumeUnknown` (:255-260) and `reset()` (:1051-1053);
  - `'expired'` from departing-topic expiry and trimming.
  `reason` keeps the original stall cause. The type has no other consumer: `grep -rln AppDeliveryResumed packages/*/src` gives only `rpc/src` (`app-lane.ts`, `index.ts:14`, `peer-types.ts:287`, `host-boundary.ts:172`, `peer.ts`), and no `rpc-conformance` or mls-rpc mirror exists. So no contract suite changes, and the change stays in Lane B. The rpc tests that assert resumed events (`durable-stall.test.ts`, `future-epoch-retention.test.ts`, `fixtures/peer.ts`) add `settlement: 'resumed'`.
- **Lanes keyed by topic** (Codex r4 I6). `cursors`, `segment` and `staged` are keyed by `topicID`. Each lane carries `{ protocol, anchorEpoch }`. The Task 15 staging bound then reads `staged.get(topicID)` (Codex r5 minor).
  - A ref is stamped with the lane's own `anchorEpoch` as `segment`, never the live `anchor().epoch` (:824). The stamp is fixed when the unwrap starts, so a rotation during an awaited unwrap cannot change it.
  - `advanceCursor`, `finishRecord` and `dropFrame` find the lane by `record.frame.topicID` / `topicID`.
  - `blockedByEarlierSealed(record)` is true when an earlier sealed frame exists either in the record's own topic (`compareLogPositions`), or in any lane of the same protocol with a smaller `anchorEpoch`.
- **Restart.** The lane rebuilds each unexpired departing topic from `protocolTopic(anchor.secret, anchor.epoch, name)`. Its cursor comes back from `appCursorStore.load(topicID)`, because cursors are keyed by topic.
- **`reset()`** (disposal, recovery resync) clears in-memory lanes only. A new incarnation has its own anchor slot (`memory-incarnation-stores.ts:450-459` is per incarnation), so it starts with no departing list.

- [ ] **Step 1: Write failing tests:**
  - `delayed old-topic frame delivers across a roster change` (Codex r3 I3): F on the old topic is delivered once, before a new-topic frame published after the rotation.
  - `departing topic survives restart` (Codex r4 I4): rotate, crash before fetching the old topic, reconstruct. F is still delivered.
  - `departing topic survives a key-only advance and restart` (Codex r5 I8): rotate A to B, begin a key-only advance (the pending-rotation save at :1738 runs), crash, reconstruct. The slot still lists A, and F on A's topic is delivered.
  - `keepAnchor keeps departing`: a known-unlanded rotation after A to B resolves through `keepAnchor`, and the slot still lists A.
  - `landed proof keeps departing`: an adoption write with `anchorLanded` through `host-db` leaves `departing` deep-equal.
  - `empty page then revealed frame` (Codex r4 I3): the hub returns an empty page for the old topic once, then serves F. F is delivered.
  - `late honest publication on the old topic is delivered` while still inside retention.
  - `expiry boundary` (Codex r5 minor): departure at d. At `appliedEpoch() = d + 31` the topic is pulled; at `d + 32` it is not, and its `reportedPruned` entry is gone. `setEpochHintOffset` varying across `[-1, 0, 1]` changes neither outcome.
  - `trimming at 33 rotations`: after 33 rotations, the slot lists the newest 32 departures, oldest first.
  - `expiry settles stall bookkeeping` (Codex r6 I6): the hub injects a future-epoch occurrence on the old topic, and it stalls. Authenticated commits then pass the expiry bound before a retry. The stalled key is gone from `blockingFrames`, one settle notice is emitted with `settlement: 'expired'` and the original stall `reason: 'future-epoch'`, and `caughtUpTimes` holds none of the topic's frames. Repeated over 40 rotation/expiry cycles, `blockingFrames.size` and the notice FIFO stay ≤ 2.
  - `app work never writes the anchor slot` (Codex r5 I9): spy on `anchorStore.save`. Across 40 authenticated epochs of app pulls, including expiry, the only saves come from the three peer sites. A gated `captureAnchor` save racing an app drain that observes expiry leaves the newer anchor and `pending.landed` intact.
  - `rotation during an awaited unwrap keeps the old segment`: the unwrap is gated, rotation happens, the gate is released. The record has the old `segment`, and completion advances the old topic's cursor.
  - `old sealed frame blocks a newer-segment record with an overlapping token`: old topic sealed at `'000000000005'`, new topic pending at `'000000000001'`. The new record waits until the old frame is done.
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN.** `ktest @kumiai/rpc test/app-departing-topics.test.ts test/app-lane-hub-faults.test.ts test/durable-restart.test.ts test/peer-app-cursor.test.ts test/peer-anchor-restart.test.ts test/peer-anchor-rotation-record.test.ts test/peer-anchor-advance.test.ts test/peer-removed-member-anchor.test.ts && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'fix(rpc): durable departing anchor topics with their own segment identity'`.

### Task 16 (B): drained ordering and stall identity (cf-2e:36, :37)

**Files:** Modify `rpc/src/app-lane.ts` (`blockingKey`/`resumeBlocked` :247-254; `finishRecord`; `dropFrame` :953-981) and `rpc/src/peer.ts:5613-5617`. Test: `rpc/test/app-lane-durable-hygiene.test.ts`.

**Interfaces:**
- `AppLane.idle(): Promise<void>` awaits a snapshot of in-flight `finishRecord` promises. `GroupPeer.drained()` chains `appLane.idle()` after `boundary.drained`.
- `blockingKey(topicID, position, frameID)`. Sealed frames carry `frameID(topicID, bytes)`; pending records carry `record.frame.id`.
- `dropFrame` keeps a position-wide resume.

- [ ] **Step 1: Tests:**
  - `drained awaits an in-flight cursor save`: `appCursorStore.save` awaits a gate. Wait for the save to start, call `dispose()`, then `drained()`. `drained()` stays pending until the gate opens.
  - `a finished record does not resume another frame stalled at its position`: X stalls at T/P while a different pending record Y sits at T/P. Finishing Y emits no resume for X.
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN.** `ktest @kumiai/rpc test/app-lane-durable-hygiene.test.ts test/peer-drained.test.ts test/durable-stall.test.ts && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'fix(rpc): drained awaits cursor saves; frame-keyed stall resume'`.

### Task 17 (C): Carry-forward cleanups O6, M5 and M2

**Files:** Modify `mls-rpc/src/clear-hold.ts:102-172` and `mls-rpc/src/registry-peer.ts:736-775`. Create `mls-rpc/test/clear-hold-outcome.test.ts`, `mls-rpc/test/switch-proof-pending.test.ts` and `mls-rpc/test/spent-before-move.test.ts`.

**Interfaces:**
- **M5** (cf-2e:33). When `capability.entry.run` rejects after prepare staged `release` (:125), read `capability.entry.read(key.groupID, (reads) => reads.lifetime())`. If `lifetime?.mutationID === mutationID`, call `release()`, then rethrow. A failed read rethrows and keeps the latch.
- **O6** (cf-2d:8). spec:406 already decides it ("unbounded with visible pending until proof"). Witness only.
- **M2** (cf-2e:32). In `resume()`, run `diagnoseSpentSet` (:395) and its exit (:770-774) before `moveCurrent(manual)` at :741.

- [ ] **Step 1: Tests:**
  - `ambiguous clear commit still releases the app-hold latch` (`commit-then-reject`, `fixtures/registry.ts:162`): `clearHold` rejects, held app delivery resumes without restart, and `capability.held(key) === null`.
  - `unresolved switch proof stays pending without a bound`: across at least 5 coordinator rounds (fake timers), `status().kind === 'pending'`, never `failed`.
  - `spent diagnosis runs before a current move`: with a corrupt spent set and an authorised current-move record, `status()` becomes `spent-set-corrupt`, and the move does not commit.
- [ ] **Step 2: RED (M5, M2)**, **Step 3: implement**, **Step 4: verify.** `kbuild && ktest @kumiai/mls-rpc test/clear-hold-outcome.test.ts test/switch-proof-pending.test.ts test/spent-before-move.test.ts test/clear-hold-storage.test.ts test/spent-set-corrupt.test.ts && kfinish`.
- [ ] **Step 5: Commit.** `git commit -m 'fix(mls-rpc): carry-forward cleanups O6, M5 and M2'`.

### Task 18 (A): Release note and whole-branch gate

**Files:** `.changeset/spec-p-storage-foundation.md` (one 2.3a paragraph; versions stay in the band, cf-2e:16), `packages/rpc/README.md`, `packages/mls-rpc/README.md`.

- [ ] **Step 1: Write the paragraph.** Cover:
  - exact CAS for every MLS state write, and app metadata off the version clock;
  - journal-compatible adoption and build retry over referenced proposals, with history eviction allowed;
  - **`@kumiai/mls` behaviour change** (Codex r5 minor): private commit builders and `proposeSelfRemoval` throw `CommitAuthoringRefusedError` on any handle an access implementation or mls-rpc has issued, permanently, and on handles derived from one. This includes a host handle passed to `simpleHandleAccess`, once issued. Bare handles are unchanged. New exports: `CommitAuthoringRefusedError`, `CommitReceipt`, `restrictCommitAuthoring`, `withCommitPermit`, `authorPrivateCommit`;
  - **`@kumiai/mls-rpc` breaking change:** `buildRevokeProofOperation` takes the `group` handle that the control-build `build` callback receives. `createControlBuildPort` gains a required `restoreCandidate` and an optional `restoreSource`, and builds on a handle restored from the journal's `sourceState`. `prepareBuild` rejects host commits whose bytes do not match the permit receipt;
  - skipped-key and retained-tuple guards, and configurable epoch retention;
  - `openBatch`/`pending` and the registry `createGroupCrypto`;
  - retained past epochs;
  - app work off the commit queue, app notices and delivery starts in one self-draining FIFO independent of `runSerial`, durable departing topics whose expiry settles stall notices with `settlement: 'expired'` (new optional `AppDeliveryResumed.settlement`), and bounded pulls;
  - `openBatch` refuses occurrences at or before the durable cursor;
  - one comparator;
  - `idle`/`drained`;
  - the cleanups;
  - the 2.3c drain deferral;
  - the two out-of-scope crypto obligations.
- [ ] **Step 2: Full gate.**
  - `kbuild && rtk proxy pnpm exec turbo run test:types test:unit --force --env-mode=loose`. Expected: `Cached: 0`.
  - `CI=true rtk proxy pnpm exec vitest run --root tests/integration` with PostgreSQL participating. A skipped backend is BLOCKED (cf-2e:64 F5).
  - `rtk proxy pnpm run lint`.
- [ ] **Step 3: Commit.** `git commit -m 'docs: 2.3a release note'`.

## Coverage

| Requirement | Task / owner |
| --- | --- |
| RegistryHandleAccess `openBatch`/`pending` (spec:976-986, 1033-1047); A1, A7, A9 | 0, 8 |
| Envelope validation, procedure, frame key (spec:534, A3) | 1, 8 |
| Exact CAS for every MLS state write; metadata off the clock (A8, RC1) | 5, 8 |
| Own-commit adoption and build retry by journal compatibility over referenced proposals (A8; Codex r3 C1, r4 C1, r2 #1) | 5, 6 |
| Private commit authoring needs a control-build permit checked before construction; every access-issued, refreshed, adopted, restored or derived handle is permanently restricted on all four implementations (A14; Codex r3 C1, r4 I2, r5 C1/C2/I3/I4/I6, r6 C1/I4) | 5b, 6 |
| Permit clone restored from `sourceState` bytes, double-preserving; receipt binds the returned commit and the candidate; memory double builds through the gate (Codex r6 I2/I3/I8) | 5b, 6 |
| `openBatch` refuses occurrences behind the durable cursor; `appCursor` point read (Codex r6 I7) | 3, 8 |
| App FIFO drains itself, independent of `runSerial`; expiry settles stall bookkeeping as `expired` (Codex r6 I5/I6, r7 I3/I4; ruling Q2) | 13, 14 |
| Candidate and digest checked before framing; permit consumed before construction; sender-0 exactness; creation-site inventory; double restore adapter (Codex r7 I1/I2, minors) | 5, 5b, 6 |
| In-repo authoring outside control-build enumerated and routed (`revoke.ts`, `app-lane-e2e.ts`) or proven not to commit (`bootstrapLedger`) | 6 |
| Compatibility allows retained-history eviction; journal records referenced proposals (Codex r5 I5, minor) | 5, 6 |
| Adoption callers take the compatibility callback; omitted means exact (Codex r4 I8) | 6 |
| Departing anchors persisted in the anchor slot, carried by every slot write, with real-store runners (Codex r4 I4, r5 I8, minor) | 2b, 14 |
| Expiry computed on read, never written by app work (Codex r5 I9); departure-epoch boundary (Codex r5 minor) | 14 |
| Persistence pending store uses the shared comparator (Codex r5 I7) | 2 |
| App notices bounded and ordered off the commit queue (Codex r5 I10) | 13 |
| Skipped-key index and retained-tuple guards (crypto review); configurable retention (A13) | 4 |
| Retained past epochs (A11); migrated contract rows (Codex r3 I4); one comparator (Codex r3 I5) | 2, 8, 13, 15 |
| Registry `createGroupCrypto`, `unwrapBatch`, singleton mapping (spec:1133-1135, 1339-1340) | 9 |
| Contract suites on registry crypto, real and double; pending-suite probe | 10 |
| Registry double with real limits (Q6; Codex I3, r2 #8) | 7, 10 |
| Crash seam :1803; cf-2e:15; cf-2d:9/cf-2e:9 adapters | 11, 12 |
| App work off the commit queue, coalesced `kick`, `dropAppFrame` outside `runSerial` (Codex r3 C2, r4 I5/I7) | 13 |
| Departing topics: durable, authenticated-epoch expiry, per-topic segment identity (Codex r3 I3, r4 I3/I4/I6) | 14 |
| Bounded pulls outside every reservation, staged bound, outstanding work and diagnostics (Codex r2 #2/#4, r3 I6/I7, r4 I5/I7) | 15 |
| Retention witness off-by-one (Codex r4 m9); spec numeric ordering text (Codex r4 m10); restart witness gate order (Codex r4 m11) | 4; 0; 11 |
| Stall identity and drained (cf-2e:36, :37) | 16 |
| cf-2e:34 N2; cf-2e:14 port changes | 3; Global Constraints |
| O6, M5, M2 | 17 |
| Resync/retirement drain of opened records, `drainOpened`, `switch-blocked` status (USER option C) | 2.3c |
| `receive`, `seal`, leases, ephemeral | 2.3b |
| `HandlerCompletion`, handler metadata, rpc frame-ref migration, terminal drain and open refusal, `PersistenceTestPorts` aggregate, bounded A/B/control scheduler (spec:515-517) | 2.3d |
| N3 (cf-2e:13/:35), O1/O3/O4 settlement | 2.3c |
| ts-mls chain-secret skipped cache; Commit-creation retained own handshake secret | Out-of-scope obligations |

**Poison retention until 2.3d:** one sealed row per member-authored malformed frame. Rows are removed by `pending.complete`, `clearTransport` (`memory-incarnation-stores.ts:591-592`) or 2.3d `HandlerCompletion`. No hub-only input creates a row. The USER accepted this bound.

**Retirement until 2.3c:** opened records of a retired incarnation stay durable and undelivered (A12).

## Self-review

- **Spec coverage:** every 2.3a requirement and every Codex r3 to r7 and crypto-review finding maps to a task, a deferral or an obligation (drafter-notes, Revisions 4 to 8).
- **No merge machinery remains:** no `splitState`, `joinReceive`, `receiveRevision` or `assertReceiveOnly`. A8 says "exact CAS".
- **Step scan:** code steps name file, signature and values. Retained requirements are inline, with no "as in revision N" references.
- **Type consistency:**
  - `compareLogPositions`, `isAppLogPosition` and `RETAINED_EPOCHS_*`;
  - `KeyRetentionRangeError`;
  - `controlProjection`, `controlCompatible` and `ownHandshakeGeneration`;
  - `OpenAppInput`/`OpenAppResult`, `appFrame`/`pendingFrames` and `RECEIVE_SAVE_ATTEMPTS`;
  - `controlAdoptionAllowed(…, compatible?)`;
  - `CommitAuthoringRefusedError`, `CommitReceipt`, `restrictCommitAuthoring`, `withCommitPermit`, `authorPrivateCommit`, `ControlJournal.referencedProposals`/`candidateAuthenticator`, `restoreSource`, `EntryReads.appCursor` (A14);
  - no `withoutCommitAuthoring` remains;
  - no `spendOwnHandshake`, `advanceRatchet` or `__unsafeAllowOwedAuthoring` remains;
  - `AnchorSlot.departing` with `departedAt`, `appliedEpoch()`, `enqueueApp`/`drainAppNotices`, `APP_STAGED_MAX_FRAMES`, `APP_OUTSTANDING_FETCHES_MAX`, `APP_PRUNED_NOTICES_MAX`;
  - `MuxFetchTopicParams.signal`, `kick`, `rotate` and `idle`.
- **Lanes:** file-disjoint, with every shared contract on base.
