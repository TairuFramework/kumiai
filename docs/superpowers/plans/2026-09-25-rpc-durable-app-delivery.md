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
  fails at least one clause (mutation check).
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
  intents for the 0.10 band across all twelve packages (check `.changeset/roster-leaf-identity.md` for the
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
