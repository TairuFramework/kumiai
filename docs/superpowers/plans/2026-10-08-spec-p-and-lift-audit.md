# Spec P and lift audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an approved Spec P (transactional persistence) and a file-by-file lift audit, so the
phase 2 plan can fix port signatures without guessing.

**Architecture:** Documents only, no product code. Spec P is written from verified source evidence,
reviewed blind by Codex until no blocker remains, then approved by the user. The lift audit then
checks every Kubun candidate against Spec P's ports and feeds corrections back into the umbrella
spec.

**Tech Stack:** Markdown. Sources read: `@kumiai/rpc`, `@kumiai/rpc-conformance`, `@kumiai/mls-rpc`,
`@kumiai/hub-store`, Hozon (`../hozon` or the installed package), `@kubun/plugin-p2p`.

**Spec:** `docs/superpowers/specs/2026-10-08-client-messaging-e2e-design.md` (umbrella, r6). Phase 0
is its "Spec P" paragraph under [Phases]; phase 1 is "Lift audit".

## Global Constraints

- Designs and plans are ephemeral and live in `docs/superpowers/{specs,plans}/`; only backlog,
  completed, next and milestones persist in `docs/agents/plans/`.
- Every factual claim about current code carries `path:line` evidence checked against source on the
  day it is written. Premises copied from the umbrella spec are re-verified, not trusted.
- BLOCKED is a valid outcome for any audit candidate; it names the missing port or behaviour.
- Blind reviews: brief Codex with questions, never the expected answers.
- Codex runs as `node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs task --fresh "<prompt>"`
  in the background, output to the session scratchpad. The Codex MCP server does not connect.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec P must cover sqlite, postgres and `@hozon/expo`; a guarantee one of them cannot give is
  stated as such, not assumed.
- `AppOutbox` keeps its signature (umbrella: "No `AppOutbox` signature change is needed"). If Spec P
  finds that false, it says so with evidence and the umbrella spec is amended in Task 6.

## Review Focus

1. **Expo transactions.** `@hozon/expo` may not give the same nesting or isolation as sqlite/postgres.
   Expected: Spec P states per-provider what the coordinated `put` and the atomic ratchet-plus-pending
   save rely on, and adds a conformance case run on each provider. Owner: Task 3.
2. **Visibility before commit.** A store that resolves `put` before the outer transaction commits
   lets rpc publish an entry a crash then erases. Expected: a conformance case that crashes (rolls
   back) after `put` resolves inside the coordinated adapter and asserts nothing was published.
   Owner: Task 3.
3. **Ambiguous CAS write.** A versioned `GroupStateStore` write that times out may or may not have
   landed. Expected: Spec P defines how the registry learns the outcome (re-read by version) and a
   conformance case writes, drops the reply, and asserts the retry neither forks nor double-applies.
   Owner: Task 3.
4. **Sender-generation reuse across restart.** Reserving a generation in memory then crashing must
   not let the restarted handle seal two frames under one generation. Expected: a conformance case
   reserves, restarts the store, seals, and asserts distinct generations. Owner: Task 3.
5. **Kubun-only behaviour hidden in a "generic as is" file.** Expected: the audit reads each file's
   imports and side effects, not its name, and downgrades any file that touches Kubun rows, events
   or logger types. Owner: Task 5.

---

### Task 1: Mark the umbrella approved and record the deferred backlog

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-client-messaging-e2e-design.md:4`
- Create: `docs/agents/plans/backlog/2026-10-08-verifiable-pre-link-history.md`
- Create: `docs/agents/plans/backlog/2026-10-08-message-only-wake.md`

**Interfaces:**
- Produces: the two backlog files the umbrella's [Deferred] section names.

- [ ] **Step 1:** Change the status line to `Status: approved r6 (2026-10-08)`.
- [ ] **Step 2:** Write each backlog file in the house format (see
  `docs/agents/plans/backlog/2026-10-05-rpc-peer-module-split.md`): title, `**Priority:** backlog.`,
  the problem, what is missing today (copy the two bullets from [Deferred] and expand each with the
  reviews' reasons: no authenticated membership archive or transcript checkpoints; signed envelopes
  break under re-seal; no per-topic wake registration), and the condition to pick it up.
- [ ] **Step 3:** Commit.

```bash
git add docs/superpowers/specs/2026-10-08-client-messaging-e2e-design.md docs/agents/plans/backlog/2026-10-08-*.md
git commit -m "docs: approve client/messaging/e2e design; record deferred backlog"
```

### Task 2: Spec P evidence probe

**Files:**
- Create: `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` (Context section only)

**Interfaces:**
- Produces: a Context section Task 3 builds on, one bullet per question below, each with `path:line`.

- [ ] **Step 1:** Answer each question from source, recording evidence. Unknown is allowed; a guess
  is not.
  1. Every durable write rpc performs today, in order, for: app-frame open (durable path via
     `GroupCrypto.pending`), cursor advance (`AppCursorStore.save`), outbox accept/replace/remove,
     commit journal `put`/`markAccepted`/`clear`, anchor `save`. Which pairs does rpc assume
     atomic, and which only ordered?
  2. Where `AppOutboxEntry.lastAttempt` is set and read; whether any `publishID` is passed on app
     publishes (umbrella says none); where the hub dedups `(topicID, publishID)` and its expiry in
     `hub-store`.
  3. `PendingAppFrame` fields today, and every place an opened epoch is or is not available
     (`frame.segment` is the anchor epoch, not the opened epoch).
  4. `mls-rpc`'s in-memory handle persistence: what state it would need to save (MLS state,
     credentials, ordered signed ledger tokens) and the current codec, if any.
  5. Kubun's `group-handle-registry.ts` and `mls-state.ts`: versioned/CAS writes, sender-generation
     reservation, atomic state-plus-pending, restore inputs, displacement/lineage. Record the
     behaviours, not the Kubun schema.
  6. Hozon: how a transaction provider is obtained, how stores are bound to one transaction, what a
     nested transactional callback does, isolation level per provider (sqlite, postgres, expo).
  7. What `rpc-conformance` already covers for `AppOutbox`, `CommitJournal`, `AnchorStore` and
     `PendingAppFrames`, by case name.
- [ ] **Step 2:** Write the answers as the Context section of the Spec P file, with a header
  (`Date`, `Status: draft r1`, `Parent:` link to the umbrella).
- [ ] **Step 3:** Commit: `docs: Spec P evidence probe`.

### Task 3: Write Spec P

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md`

**Interfaces:**
- Consumes: Task 2's Context.
- Produces, as exact TypeScript in the spec: the `GroupStateStore` port; the changed
  `PendingAppFrame` (adds the opened epoch); the attempt-identity fields on `AppOutboxEntry` or a
  sibling store; the coordinated acceptance adapter's shape; the crash-seam hook type. Phase 2
  implements these names verbatim.

- [ ] **Step 1:** Write one section per umbrella phase-0 item, each ending in its decisions:
  - `GroupStateStore`: versioned/CAS write and its conflict error; sender-generation reservation;
    atomic state plus pending decrypted frame; pending list/complete; transaction visibility;
    recovery from an ambiguous write; inventory (credentials, ordered signed ledger tokens) and
    deletion.
  - Idempotent Welcome and commit adoption; journal `lost/reenact` recovery.
  - Pending records carry the authenticated opened epoch.
  - Outgoing: durable attempt identity (`publishID` per attempt; same attempt replayed after an
    ambiguous crash; new attempt after re-seal or rejoin resend; abandon past the 365-day dedup
    horizon); recovery of acknowledged-but-unrecorded publications; durable publication status and
    log position.
  - The coordinated `MessageStore`↔outbox adapter: same transaction provider, correlation,
    rollback, resolve only after the outer commit, reservation held until then, memory doubles
    sharing one in-memory transaction.
  - Per-provider guarantees table (sqlite, postgres, expo) for each atomicity claim above.
- [ ] **Step 2:** Write the crash-seam list: for each of the seven scenario-8 points in the
  umbrella, the exact boundary (which write, before/after its transaction commits), the component
  that owns it, and the seam mechanism (port hook or wrapping store). Hooks are test-only and absent
  in production builds by type, not by flag.
- [ ] **Step 3:** Write the conformance additions as a table: suite, case name, setup, assertion.
  It must include the four cases named in Review Focus 1–4, plus at least: duplicate `complete`
  resolves; CAS conflict leaves storage unchanged; pending list order is `(segment, position)`
  after restart; same-attempt replay carries the same `publishID`; re-seal carries a new one.
- [ ] **Step 4:** Self-review against the umbrella phase-0 paragraph: every noun in it maps to a
  section. Fix gaps inline.
- [ ] **Step 5:** Commit: `docs: Spec P draft r1`.

### Task 4: Blind review loop for Spec P

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md`

- [ ] **Step 1:** Run Codex on the spec with questions only, e.g.: "Is every atomicity claim
  achievable on each provider? Which crash between two writes loses or duplicates a message? Can an
  attempt be published under two `publishID`s for one ciphertext, or one `publishID` for two? Does
  any port change break an existing `rpc-conformance` case or a double? Which claim lacks source
  evidence?" Output: `codex-p-r1.md` in the scratchpad.
- [ ] **Step 2:** Verify each high/blocker finding in source before folding it (a finding can be
  wrong). Fold confirmed ones; record rejected ones with the reason in a short "Review log" section.
- [ ] **Step 3:** Commit: `docs: fold Codex review rN into Spec P`, bumping the status to `draft rN+1`.
- [ ] **Step 4:** Repeat Steps 1–3 with a fresh blind brief while a round still finds a blocker
  (max three rounds; past that, stop and ask the user).
- [ ] **Step 5:** Ask the user to review and approve Spec P. Stop until they do.

### Task 5: Lift audit probe

**Files:**
- Create: `docs/superpowers/specs/2026-10-08-lift-audit.md`

**Interfaces:**
- Consumes: approved Spec P port signatures; the umbrella's lift classification table.
- Produces: one row per candidate file, which Task 6 copies into the umbrella.

- [ ] **Step 1:** For every file in the umbrella's lift table (all under
  `../kubun/packages/plugin-p2p/src/`), record: imports outside `@sozai`/`@kokuin`/`@kumiai`/`ts-mls`;
  Kubun rows, events, logger types or schema it touches; its tests and whether they move; the
  confirmed class; target kumiai package and file; the port signature it needs, checked against
  Spec P; verdict `MOVE`, `EXTRACT`, `REIMPLEMENT` or `BLOCKED: <missing port or behaviour>`.
- [ ] **Step 2:** For `group-handle-registry.ts`, map each behaviour from Task 2 Q5 to the Spec P
  `GroupStateStore` method that carries it, or mark it Kubun-only. Any behaviour with neither is a
  Spec P gap: list it.
- [ ] **Step 3:** Check `buffered-peer-hub-view.ts` and `server-did.ts` can take injected epoch
  inspection and change notifications without importing `mls` or the registry (umbrella `hub-client`
  row). If not, BLOCKED with the reason.
- [ ] **Step 4:** Commit: `docs: lift audit probe`.

### Task 6: Reconcile the umbrella and hand off

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-client-messaging-e2e-design.md` (Lift classification,
  Package layout rows, Phases 2–3 if signatures moved)
- Modify: `docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md` (only for gaps from
  Task 5 Step 2)

- [ ] **Step 1:** Copy each changed verdict into the umbrella lift table; note BLOCKED items under
  Risks.
- [ ] **Step 2:** If Task 5 found Spec P gaps, add them to Spec P, run one targeted blind Codex pass
  on just those sections, and re-request user approval of Spec P.
- [ ] **Step 3:** Commit: `docs: reconcile umbrella with lift audit`.
- [ ] **Step 4:** Report to the user: verdict counts, BLOCKED items, and that phase 2's plan is next.
