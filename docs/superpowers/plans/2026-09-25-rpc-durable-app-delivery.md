# Acknowledged durable app-frame delivery Plan

**Stage:** executing
**Mode:** learning-loop
**Spec:** docs/superpowers/specs/2026-09-25-rpc-durable-app-delivery-design.md (revision 4) — authoritative; read whole first.

## Working rules (every question)

- One question at a time. After each: fill the Decision Log entry (what was learned, deviations, pasted
  verify output), commit, then STOP and report. The next question starts only after human feedback.
- If a probe contradicts the spec, stop and report; do not work around it in code.
- Two failed approaches, then ask.
- Write the usage test first; if it reads awkwardly, fix the API before implementing.
- pnpm only; never edit `lib/`. Lint with `rtk proxy pnpm run lint` before `git add`.
- Per-question verify runs from repo root; the phase-exit gate is
  `pnpm exec turbo run test:types test:unit --force` (paste the `Cached: 0` line) plus
  `pnpm exec vitest run --root tests/integration` wherever a wire format or exported signature changed.
- Changing a port means running BOTH contract suites (`rpc-conformance`, `hub-conformance`) against the
  real implementation and the doubles (`docs/agents/architecture.md`). A double may be stricter than its
  port, never more permissive.
- Commits: Conventional Commits, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  Branch `feat/rpc-durable-app-delivery` only; never main; never push.
- Mutation-check every guard test: remove the guarded line, confirm the test fails, restore.

## Phase 1: MLS primitives

Exit criteria: staged open and the versioned AAD exist in `@kumiai/mls` / `@kumiai/rpc`, all seal and open
sites use the new AAD, all existing suites green.

### Question 1.1: Can `GroupHandle` open a frame without adopting the result until the host has persisted it?
- **Assumption:** ts-mls `processMessage` returns a separate `newState` that can be withheld, encoded
  with the repo's `ClientState` codec, and adopted later, with no shared mutable state leaking into the
  live handle or the shared group context.
- **Done when:** `decryptStaged(message, opts, persist)` exists under `mutexFor(this)`, and tests show:
  (a) success: `persist` receives encoded post-open state + `{ payload, senderDID, aad }`, then the live
  handle cannot reopen the frame; (b) `persist` throws: live state unchanged — the live handle still opens
  the frame, and a handle restored from the pre-open encoding opens it too; (c) a handle restored from
  the staged encoding cannot reopen the frame; (d) unnamed sender throws before `persist` with the live
  state unchanged; (e) the group context's device-deny provider is the live handle's after both success
  and failure; (f) `result.consumed` is zeroed only after successful adoption (assert the old secret is
  still usable after a failed persist — that is (b)).
- **Spec excerpt:** "Staged open in `@kumiai/mls`" section of the spec, including Zeroing, Sender and
  Encoding paragraphs.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/decrypt-staged.test.ts && pnpm --filter @kumiai/mls run test:types`

### Question 1.2: Does a versioned AAD carrying log intent round-trip through every seal and open site?
- **Assumption:** replacing `fromUTF(topicID)` with `encodeAppAAD({ topicID, intent })` at every site is
  mechanical, and `readMessageAAD` can read the cleartext AAD pre-open without a key.
- **Done when:** `packages/rpc/src/app-aad.ts` (`encodeAppAAD`, `decodeAppAAD`, injective, version byte
  0x01); `@kumiai/mls` exports `readMessageAAD(bytes): Uint8Array | null` (never throws); every site
  listed in the spec's "Authenticated log intent" section uses it — app publish sets intent from
  `retentionOf`, directed request/reply and self-inbox use `ephemeral`; a frame with the old bare-topic AAD
  fails to open; a rewritten intent byte fails to open; existing rpc, mls, integration suites green.
- **Spec excerpt:** "Authenticated log intent (wire change)" section.
- **Verify:** `pnpm exec turbo run test:types test:unit --force --filter=@kumiai/mls --filter=@kumiai/rpc && pnpm exec vitest run --root tests/integration`

## Phase 2: Port

Exit criteria: `GroupCrypto` carries `frameAAD`, optional `pending`, and `unwrap({ frame })`; the real port
and the fake double both pass the new conformance clauses; hub conformance green.

### Question 2.1: Can the `GroupCrypto` port express an atomic durable open that both the real port and the double honour?
- **Assumption:** `unwrap(bytes, { expectedAAD, frame })` over `decryptStaged` + host `persistOpened`
  gives atomicity on the real port, and the fake double can model the same contract without being more
  permissive.
- **Done when:** port types per spec ("Port change: `GroupCrypto`"), `AppFrameStorageError` +
  `isAppFrameStorageError`, `mls-rpc` `pending` param wired; `rpc-conformance` clause set from the spec's
  "Conformance" section runs against the real port (in-memory host store that stores encoded state and
  records, simulating restart by restoring a new handle from stored bytes) and the fake double, all
  clauses green on both; a deliberately permissive double variant (e.g. saving the record after adopting)
  fails at least one clause (mutation check). `frameAAD` already landed in 1.2. Milestone pickup (pre-1.0
  breaking-api, rpc): retype `open-once.ts:15` `project` and `directed.ts:35` against rpc's
  `GroupUnwrapResult` (required `senderDID`) instead of broadcast's optional-sender `UnwrapResult`, and
  mark the milestone item taken.
- **Spec excerpt:** "Port change", "Conformance", "Host contract" (save ordering) sections.
- **Verify:** `pnpm exec turbo run test:types test:unit --force --filter=@kumiai/rpc-conformance --filter=@kumiai/mls-rpc --filter=@kumiai/rpc --filter=@kumiai/hub-conformance`

## Phase 3: App lane

Exit criteria: durable mode delivers log events at least once, in log order, across crash, handler
failure, storage failure and rotation; non-durable mode unchanged.

### Question 3.1: Can the retained drain be the only opener of log-intent frames without stalling or mis-advancing the walk?
- **Assumption:** three-state frames, pending-dominates merge, fetch-only positions, walk-wide stop on
  storage failure, rebuild after partial progress, and settled fetches fit the existing drain and
  `pullCommits` structure.
- **Done when:** spec "App lane" (retained drain, frame states, merge rule), "Rebuild after partial
  progress" and "Settled fetches" implemented; tests: storage failure immediately before a commit blocks
  that commit until the frame is durably opened; storage failure in the final drain after a
  roster-changing commit leaves the runtime on the new epoch/topic; fast-rejecting fetch alongside a
  delayed one mutates nothing after retry starts; cursor never passes a `pending` frame; ephemeral-intent
  frame in the log is dead.
- **Spec excerpt:** "App lane" section through "Frame states".
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-drain.test.ts && pnpm --filter @kumiai/rpc run test:types`

### Question 3.2: Does treating a live log-intent push as a wakeup lose or indefinitely delay any frame?
- **Assumption:** wakeup + ack + coalesced drain + independent backoff retries + a post-subscription
  startup pull give liveness without any push-borne metadata entering the buffer.
- **Done when:** spec "Live log-intent push: wakeup only" and "Liveness" implemented; tests: pushes B then
  later-fetched A deliver A before B; pushed frame claiming another entry's position has no effect; hub
  stripping/adding `logPosition` changes nothing; failed fetch with no later push retries and delivers;
  publication in the seed-pull/listener gap delivered after startup; ephemeral live path unchanged.
- **Spec excerpt:** "Live log-intent push: wakeup only", "Liveness".
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-live.test.ts && pnpm --filter @kumiai/rpc run test:types`

### Question 3.3: Can delivery run outside every lock while preserving per-protocol log order?
- **Assumption:** a per-protocol queue with the earliest-unresolved-position barrier, handler-resolve as
  ack, and backoff on throw keeps order and never deadlocks a handler that calls the peer.
- **Done when:** spec "Delivery queue" (steps 1–6, Delivery barrier) and "Dispose" implemented; handler
  context carries `frame`; tests: epoch inversion (ahead A, at-epoch B) delivers A then B; handler throw
  retries with backoff and later frames wait; `complete()` failure retries; handler calling `commit()`
  does not deadlock; dispose during backoff clears timers and starts no handler.
- **Spec excerpt:** "Delivery queue", "Locking summary", "Dispose".
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-queue.test.ts && pnpm --filter @kumiai/rpc run test:types`

### Question 3.4: Does a crash between open and apply deliver the frame exactly once on restart?
- **Assumption:** restoring pending records before the seed pull, seeding matching buffered positions as
  `pending`, and retrying a failed `list()` give the decisive restart guarantee across rotations.
- **Done when:** spec "Restart" and "Rotation" implemented; the spec's **decisive restart test** passes
  (shared in-memory database of encoded handle + pending records + cursor across two peer instances);
  transient `list()` failure retried and the seed pull waits; old-segment record delivered after rotation
  without touching the new cursor.
- **Spec excerpt:** "Restart", "Rotation", "Tests" (decisive restart test).
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-restart.test.ts && pnpm --filter @kumiai/rpc run test:types`

### Question 3.5: Is a persistent storage fault observable and operable?
- **Assumption:** `onAppDeliveryStalled` through the shared `notifyHost` outbox and
  `GroupPeer.dropAppFrame(topicID, position)` make the fail-closed stall manageable without weakening
  the no-unpersisted-frame rule.
- **Done when:** spec "Fail-closed storage stall" implemented; tests: notice fires once per blocking
  frame; `dropAppFrame` marks only a buffered non-`pending` frame dead and resumes the journal-first
  walk; it refuses a `pending` frame.
- **Spec excerpt:** "Fail-closed storage stall".
- **Note:** `notifyHost` also lands on `feat/rpc-strand-observability`. Implement it here identically
  (`packages/rpc/src/host-notice.ts`); the later rebase keeps one copy.
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-stall.test.ts && pnpm --filter @kumiai/rpc run test:types`

## Phase 4: Lock order and release

Exit criteria: the host contract is proven against a single-connection SQLite-shaped host double; docs,
change intents, full gate and integration green.

### Question 4.1: Does the host contract hold under a single-connection database with concurrent transactional work?
- **Assumption:** with a host that obeys the contract (no transaction held while awaiting peer/handle
  operations; ordered saves with a same-epoch version guard), `persistOpened` under the handle mutex never
  deadlocks and a delayed earlier save cannot overwrite a staged state.
- **Done when:** a test host double with ONE serialized "connection" (a mutex around every store call),
  a transactional handler finishing its transaction before awaiting the peer, and a delayed pre-open save:
  no deadlock, no overwrite; the same double with the contract violated (transaction held across a peer
  await) is shown to wedge (documents the rule).
- **Spec excerpt:** "Host contract (documented)".
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-host-contract.test.ts`

### Question 4.2: Release readiness
- **Done when:** rpc, mls, mls-rpc READMEs document the guarantee, host contract, opt-in, new APIs; change
  intents for the 0.11 band across all twelve packages (check `.changeset/roster-leaf-identity.md` for the
  format and bump keyword), calling out the AAD mixed-version incompatibility; full gate `Cached: 0` and
  integration green.
- **Verify:** `pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration`

## Decision Log

<!-- One entry per question: date, what was learned, deviations, spec/plan updates, pasted verify output. -->

### 2026-09-25 — Question 1.1

- **Learned:** ts-mls returns a separate, serializable post-open `ClientState`. The live handle and its old ratchet secret stay usable while persistence is pending or fails. After persistence, adopting the staged state and zeroing consumed buffers prevents reopening. Staging does not repoint the shared device-deny provider.
- **Deviations:** None. The three usage tests failed before implementation, then passed. Five mutations (adoption, zeroing, deny-provider ownership, persistence, and unnamed-sender rejection) each made its guard test fail; the source was restored after each.
- **Spec/plan contradiction:** None in the Question 1.1 probe. The release section's 0.6 target differs from the repository's existing `@kumiai/mls` version 0.9.0; this question does not change versions.
- **Verify:** `pnpm --filter @kumiai/mls exec vitest run test/decrypt-staged.test.ts && pnpm --filter @kumiai/mls run test:types`

```text
 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/packages/mls


 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  14:19:02
   Duration  443ms (tests 40%, import 33%, transform 27%)

$ tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

### 2026-09-25 — Question 1.2

- **Learned:** ts-mls exposes a PrivateMessage application's AAD without an epoch key; changing its cleartext intent still fails authenticated open. The live app topic carries both log and ephemeral frames, so its expected AAD must be selected from that untrusted cleartext hint and compared in full during open. UTF-8 encoding replaces lone surrogates, so the codec rejects ill-formed topic strings to keep its encoding injective.
- **Deviations:** Brought the `GroupCrypto.frameAAD` member, real and fake implementations, and its shared conformance clause forward from Question 2.1 because the Question 1.2 live open needs to distinguish log from ephemeral intent. Updated legacy fixture seals to versioned log AAD; the intentional 0.9 bare-topic fixture remains. Usage tests failed before implementation. Eighteen guard mutations made their target tests fail; all source was restored. Integration initially lacked built `hub-client`/`hub-server` JavaScript in this worktree; building integration dependencies resolved it.
- **Spec/plan contradiction:** None. The phase split places `frameAAD` in Question 2.1, but the spec requires it for Question 1.2's live AAD round trip; only that member and its conformance clause moved forward. The repository remains in the 0.9 band; the planned band bump is 0.10 in Question 4.2.
- **Verify:** `pnpm exec turbo run test:types test:unit --force --filter=@kumiai/mls --filter=@kumiai/rpc && pnpm exec vitest run --root tests/integration`

```text
@kumiai/rpc:test:unit:  Test Files  71 passed (71)
@kumiai/rpc:test:unit:       Tests  467 passed (467)
@kumiai/mls:test:unit:  Test Files  47 passed (47)
@kumiai/mls:test:unit:       Tests  522 passed (522)

 Tasks:    18 successful, 18 total
Cached:    0 cached, 18 total
  Time:    15.859s

 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/tests/integration

 Test Files  8 passed (8)
      Tests  43 passed (43)
   Start at  14:38:17
   Duration  7.06s (tests 72%, transform 19%, import 9%)
```

### 2026-09-25 — Question 2.1

- **Learned:** The real handle can retain earlier-epoch payload ratchet material but cannot authenticate that epoch's sender after advancing. A staged below-epoch open therefore fails closed. Both the real port and the fake double reject it without calling `persistOpened` or changing live state; a repeat attempt with nothing changed rejects the same way. An atomic host write of staged handle state and the pending record lets a restored handle keep the consumed key spent while retaining the record.
- **Deviations:** The first run stopped on the contradictory below-epoch probe, with its partial implementation unstaged. After the user's resolution, the shared clause was changed to fail closed and the double was advanced in that test. The test harness was also adjusted to accept synchronous throws and rejected promises, both allowed by the port. The original usage tests failed on missing API members before implementation. Six targeted mutations, including adopting the fake state before persistence, each failed its conformance clause; all source was restored. The exported signature prompted an additional integration run.
- **Spec/plan contradiction:** The original Conformance clause expected a successful earlier-epoch staged open, contrary to the real port's authenticated-sender requirement. The user resolved this by changing the spec to fail closed. No contradiction remains for Question 2.1. Current packages are in the 0.9 band and this work targets 0.11; the earlier Question 1.2 log's 0.10 target is superseded.
- **Resolution (user, 2026-09-25):** option (a). The below-epoch clause now fails closed: staged open rejects without calling `persistOpened` and leaves live state unchanged, on the real port and the double. No past-epoch sender naming. Resume 2.1 from the partial work.
- **Verify:** `pnpm exec turbo run test:types test:unit --force --filter=@kumiai/rpc-conformance --filter=@kumiai/mls-rpc --filter=@kumiai/rpc --filter=@kumiai/hub-conformance`

```text
@kumiai/mls-rpc:test:unit:  Test Files  2 passed (2)
@kumiai/mls-rpc:test:unit:       Tests  64 passed (64)
@kumiai/rpc:test:unit:  Test Files  71 passed (71)
@kumiai/rpc:test:unit:       Tests  473 passed (473)

 Tasks:    22 successful, 22 total
Cached:    0 cached, 22 total
  Time:    10.111s
```

- **Phase-exit gate:** `pnpm exec turbo run test:types test:unit --force`

```text
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    16.468s
```

- **Integration:** `pnpm exec vitest run --root tests/integration`

```text
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Start at  14:58:57
   Duration  6.18s (tests 84%, import 8%, transform 8%)
```

### 2026-09-25 — Question 3.1

- **Learned:** A storage fault leaves a retained frame sealed. A successful atomic open makes it
  pending and holds the cursor. Settling all protocol fetches before releasing the app-lane mutex
  prevents late buffer writes after a retry starts. A failed final drain can follow a successful
  roster-changing apply. The runtime must rebuild before the original error propagates.
- **Deviations:** The first peer test used `recover()`, which waited for healing. The test switched
  to `commit()` as the journal-first entry point before implementation. Fetch-only position handling
  in `note()` moved forward from Question 3.2 because the buffer must reject pushed positions.
  Question 3.2 retains live push routing and retries. Question 3.3 retains the delivery worker.
  Initial usage tests exposed three failures before implementation. Two further guards were added
  and mutation-checked. All six pass. Eight source mutations each failed their guard test and were
  restored. The full rpc unit suite passed (72 files, 479 tests).
- **Spec/plan contradiction:** None. The Question 3.1 slice stages pending records in the app lane; the later questions connect live wakeups and handler delivery.
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-drain.test.ts && pnpm --filter @kumiai/rpc run test:types`

```text
 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/packages/rpc


 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  15:29:30
   Duration  688ms (tests 41%, transform 32%, import 27%)

$ tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

### 2026-09-25 — Question 3.2

- **Learned:** A durable live push can be acknowledged immediately and used only to request a journal-first retained pull. Fetch results supply both the ciphertext and position; pushed `logPosition` has no authority. A coalesced pull must retry fetch and storage failures without another push, and a second pull after app listener registration closes the seed-pull gap.
- **Deviations:** The initial usage tests failed before implementation (three failures; the startup-gap fixture initially published before the seed fetch and was tightened to publish after its result). The 3.3 delivery worker is not present yet, so the order guard checks the durable pending records' fetched order rather than host handler calls. A failed host-initiated walk also schedules a journal-first retry, as the spec's liveness rule requires. Seven guard mutations each failed their focused test and were restored. The full rpc unit suite passed (73 files, 486 tests).
- **Spec/plan contradiction:** None. Handler delivery and completion remain Question 3.3.
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-live.test.ts && pnpm --filter @kumiai/rpc run test:types`

```text
 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/packages/rpc


 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  15:48:59
   Duration  3.57s (tests 93%, transform 4%, import 3%)

$ tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

### 2026-09-25 — Question 3.3

- **Learned:** A pending record can be delivered in a per-protocol worker after the drain releases the app-lane and commit mutexes. An earlier sealed fetched position blocks delivery of a later pending record even when the later frame opened at an earlier epoch. A handler can await `commit()`; successful completion advances the cursor, while handler or `complete()` failure retries the same record after backoff.
- **Deviations:** The first six usage tests failed before implementation; a seventh peer-disposal guard was added afterward. Existing Question 3.2 tests now inspect saved-record history because the worker promptly completes records with no host handler. Seven source mutations each failed its focused guard test and were restored. The first full rpc unit run had one timing-sensitive failure in `peer-unknown-frame-version.test.ts`; that file passed alone and the full suite passed on rerun (74 files, 492 tests). Integration passed (8 files, 43 tests) because the handler context's exported type changed.
- **Spec/plan contradiction:** None. Restart restoration and old-segment record seeding remain Question 3.4.
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-queue.test.ts && pnpm --filter @kumiai/rpc run test:types`

```text
 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/packages/rpc


 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  16:04:18
   Duration  4.91s (tests 95%, transform 3%, import 2%)

$ tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

### 2026-09-25 — Question 3.4

- **Learned:** Startup must restore saved pending records before its first retained pull. Matching fetched positions enter as `pending`, so a spent key is never reopened and the cursor stays behind the record until the handler resolves. The delivery queue survives an app-topic rotation, and completing an old-segment record leaves the new topic's cursor alone. A transient `list()` failure can hold the seed pull until a backoff retry succeeds; disposal interrupts that wait.
- **Deviations:** The decisive test simulates a crash by disposing the first peer synchronously after the atomic state-and-record write, before its queued handler starts. Its second peer restores the serialized fake handle from the same in-memory database. Rotation is tested at the app-lane boundary so the old record and new cursor can be observed directly. The four usage tests failed before implementation, then passed. Seven targeted mutations each failed its guard and were restored. The full RPC unit suite passed (75 files, 497 tests).
- **Spec/plan contradiction:** None. No spec or plan change was needed.
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-restart.test.ts && pnpm --filter @kumiai/rpc run test:types`

```text
 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/packages/rpc


 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  16:11:58
   Duration  1.88s (tests 77%, transform 13%, import 10%)

$ tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

### 2026-09-25 — Question 3.5

- **Learned:** A storage fault leaves the same fetched position sealed across repeated walks. The app lane can identify the blocking frame and queue one notice per position. An operator drop can mark that sealed position done and resume the journal-first walk, while a pending record remains protected.
- **Deviations:** Two usage tests failed before implementation, then passed. Seven targeted mutations each failed its guard test and were restored. The first integration run overlapped Turbo's generated-file rebuild and failed on temporarily missing `lib/` modules; rerunning after the build passed. The full RPC unit suite passed (76 files, 499 tests).
- **Spec/plan contradiction:** None. The shared `notifyHost` helper was copied identically from `feat/rpc-strand-observability` as the plan requires. The current version band remains 0.9 and this work targets 0.11.
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-stall.test.ts && pnpm --filter @kumiai/rpc run test:types`

```text
 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/packages/rpc


 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  16:25:27
   Duration  692ms (transform 46%, import 29%, tests 24%)

$ tsc --noEmit --skipLibCheck -p tsconfig.test.json
```

- **Phase-exit gate:** `pnpm exec turbo run test:types test:unit --force`

```text
 Tasks:    49 successful, 49 total
Cached:    0 cached, 49 total
  Time:    29.893s
```

- **Integration:** `pnpm exec vitest run --root tests/integration`

```text
 Test Files  8 passed (8)
      Tests  43 passed (43)
   Start at  16:26:08
   Duration  7.17s (tests 70%, transform 21%, import 9%)
```

### 2026-09-25 — Question 4.1

- **Learned:** A single serialized connection permits a delayed pre-open handle save to finish before the staged open, and a same-epoch monotonic version rejects a late older write without losing the pending record. A handler that finishes its transaction before calling the peer can share that connection with a concurrent durable open. Holding the transaction while awaiting the peer creates the expected lock cycle; releasing the transaction lets the work finish.
- **Deviations:** The usage tests failed before the host double existed. The first implementation run exposed two fixture mistakes: an earlier save blocked startup `list()`, and the store rejected a second valid staged open. Moving the delayed save after startup and assigning increasing same-epoch versions fixed them. Three guard mutations (stale-write rejection and connection serialization against both the safe and violating transaction tests) each failed their focused test and were restored. The RPC test typecheck passed.
- **Spec/plan contradiction:** None. The probe uses the existing durable peer and fake crypto with a one-connection host double; the real handle's staged-open mutex behavior was established in Questions 1.1 and 2.1. The current band remains 0.9 and A targets 0.11.
- **Verify:** `pnpm --filter @kumiai/rpc exec vitest run test/durable-host-contract.test.ts`

```text
 RUN  v5.0.1 /Users/paul/dev/yulsi/kumiai.worktrees/durable-app-delivery/packages/rpc


 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  16:35:28
   Duration  1.65s (tests 42%, transform 40%, import 18%)
```
