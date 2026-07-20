# Reserved Namespace Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move kumiai's two reserved namespaces onto prefixes that name kumiai — `group.*` ledger entry types become `kumiai.*`, `enkaku/*` topic labels become `kumiai/*` — freeing `group.*` for host applications.

**Architecture:** Every reserved value already sits behind a named constant, so this is nine constant values, one reason string, and the literals that mention them. The constant *names* do not change. Exactly one behaviour changes: `group.*` stops failing closed in the envelope fold and becomes application space. That one change gets a positive test; everything else must leave the suites green without editing assertions.

**Tech Stack:** TypeScript, pnpm, turbo, vitest, biome, changesets.

**Spec:** `docs/superpowers/specs/2026-07-20-reserved-namespace-rename-design.md`

## Global Constraints

- Lands on the current branch `feat/app-lane-delivery` (PR #7). Do not create a new branch.
- Hard cutover. No compatibility shim, no accept-both period, no tripwire on the old spellings. This rests on the ruling that no persistent state needs to survive the rename.
- **Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has destroyed work on this branch twice. To revert an edit, invert it by hand.
- `pnpm run <script>` is intercepted by an `rtk` shim on this machine. Use `rtk proxy pnpm run lint`, or invoke tools directly (`pnpm exec ...`).
- `pnpm test -- --force` is broken. Use `pnpm exec turbo run test:types test:unit --force` and confirm `Cached: 0` in the summary.
- Conventions: `type` not `interface`, `Array<T>` not `T[]`, never `any`, capital `ID`, ES `#fields`. Do not edit generated `lib/` output.
- **Do not find-and-replace on the bare string `enkaku/`.** It appears in 32 files under `packages/`; all but `packages/rpc/src/topic.ts` and `packages/broadcast/src/topic.ts` are `@enkaku/*` package imports. An unanchored replace rewrites the import graph.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/mls/src/envelope-fold.ts` | Reserved entry-type prefix + fail-closed rule | 1 |
| `packages/mls/src/roster.ts` | `ROLE_ENTRY_TYPE` value | 1 |
| `packages/mls/src/recovery.ts` | Recovery entry-type values | 1 |
| `packages/mls/src/{types,policy,group-handle}.ts` | Doc comments naming the old types | 1 |
| `packages/mls/test/*.ts` | ~53 literal mentions | 1 |
| `packages/rpc/src/topic.ts` | Four topic labels | 2 |
| `packages/broadcast/src/topic.ts` | One topic-info prefix | 2 |
| `packages/mls/README.md`, `docs/agents/architecture.md` | Published contract | 3 |
| `.changeset/*.md` | Breaking-release notes | 3 |

The entry-type half is contained entirely within `@kumiai/mls`. The topic-label half touches only two files. They are independent and are separate tasks so a reviewer can reject one without the other.

---

### Task 1: Free `group.*` and move entry types to `kumiai.*`

The whole entry-type namespace moves at once. Splitting the prefix from the three type constants would leave the reserved prefix and the reserved types disagreeing about which namespace is reserved.

**Files:**
- Modify: `packages/mls/src/envelope-fold.ts:22` (prefix), `:83` (reason string), `:14,39,41` (doc comments)
- Modify: `packages/mls/src/roster.ts:10`, `packages/mls/src/recovery.ts:25,29`
- Modify: `packages/mls/src/types.ts`, `packages/mls/src/policy.ts`, `packages/mls/src/group-handle.ts` (doc comments only)
- Test: `packages/mls/test/envelope-fold.test.ts`, `group.test.ts`, `ledger.test.ts`, `ledger-bootstrap.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GROUP_TYPE_PREFIX = 'kumiai.'` (unexported, `envelope-fold.ts`), `ROLE_ENTRY_TYPE = 'kumiai.role'` (exported from `@kumiai/mls`), `RECOVERY_REQUEST_TYPE = 'kumiai.recovery-request'` (exported), `RECOVERY_GROUPINFO_TYPE = 'kumiai.recovery-groupinfo'` (unexported). All names unchanged; only values change.

- [ ] **Step 1: Write the failing test**

This is the Kubun case and the only behaviour this plan changes. Add to `packages/mls/test/envelope-fold.test.ts`, directly after the `rejects an unknown group.* type` test (currently ending at line 147):

```ts
  test('surfaces a host entry under the freed `group.` prefix, no longer reserved', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const hostEntry = input({
      issuer: CREATOR_DID,
      type: 'group.settings',
      value: { theme: 'dark' },
      entryID: 'h1',
    })

    const result = foldEnvelope(base, [hostEntry], GROUP_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.roster.roles).toEqual(base.roles)
      expect(result.surfaced).toEqual([hostEntry.verified])
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run test/envelope-fold.test.ts -t 'freed'
```

Expected: FAIL. `result.ok` is `false` — the fold currently rejects `group.settings` with reason `unknown group.* type`. That failure is the bug Kubun hit, reproduced.

- [ ] **Step 3: Move the reserved prefix and the reason string**

`packages/mls/src/envelope-fold.ts:22`:

```ts
export const GROUP_TYPE_PREFIX = 'kumiai.'
```

`packages/mls/src/envelope-fold.ts:81-84` — the comment names the namespace, so it moves with it:

```ts
    // `kumiai.*` is reserved for @kumiai/mls; an unknown one fails closed.
    if (entry.type.startsWith(GROUP_TYPE_PREFIX)) {
      return { ok: false, reason: 'unknown kumiai.* type', entryID }
    }
```

Leave the rule itself alone. Fail-closed on the reserved namespace is correct and is not what this plan changes.

- [ ] **Step 4: Move the three entry-type values**

`packages/mls/src/roster.ts:10`:

```ts
export const ROLE_ENTRY_TYPE = 'kumiai.role'
```

`packages/mls/src/recovery.ts:25,29`:

```ts
export const RECOVERY_REQUEST_TYPE = 'kumiai.recovery-request'
```

```ts
export const RECOVERY_GROUPINFO_TYPE = 'kumiai.recovery-groupinfo'
```

- [ ] **Step 5: Run the new test to verify it passes**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run test/envelope-fold.test.ts -t 'freed'
```

Expected: PASS.

- [ ] **Step 6: Update the existing reserved-namespace test**

`packages/mls/test/envelope-fold.test.ts:131-147` asserts both the old type name and the literal reason string. Both move:

```ts
  test('rejects an unknown kumiai.* type', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const mystery = input({
      issuer: CREATOR_DID,
      type: 'kumiai.mystery',
      value: 42,
      entryID: 'm1',
    })

    const result = foldEnvelope(base, [mystery], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unknown kumiai.* type')
      expect(result.entryID).toBe('m1')
    }
  })
```

- [ ] **Step 7: Update the remaining literals and doc comments**

Find every remaining mention inside `@kumiai/mls` only:

```bash
cd /Users/paul/dev/yulsi/kumiai && grep -rn "group\.role\|group\.recovery\|group\.\*" packages/mls/src packages/mls/test
```

Expected counts before editing: `test/group.test.ts` 22, `test/ledger.test.ts` 11, `test/ledger-bootstrap.test.ts` 5, `src/group-handle.ts` 3, `src/types.ts` 2, `src/policy.ts` 1, plus whatever remains in `envelope-fold.ts` and `roster.ts` after Steps 3-4.

Rewrite each: `group.role` → `kumiai.role`, `group.recovery-request` → `kumiai.recovery-request`, `group.recovery-groupinfo` → `kumiai.recovery-groupinfo`, `group.*` → `kumiai.*`. This includes prose inside doc comments — those name the type and are wrong if left.

Two things to leave alone:
- `packages/mls/src/envelope-fold.ts:14` says "base ∪ this envelope's group.role entries" — that is a type name, so it moves. But the surrounding phrase "the non-group entries to surface" describes a category, not the prefix. Read each mention before rewriting rather than replacing blind.
- The identifier `GROUP_TYPE_PREFIX` and every other constant *name* stays as it is. Only string values and prose move.

- [ ] **Step 8: Run the full mls suite**

```bash
cd /Users/paul/dev/yulsi/kumiai/packages/mls && pnpm exec vitest run
```

Expected: PASS, no failures. Any red test here means a literal was missed in Step 7 — fix the literal, do not weaken the assertion.

- [ ] **Step 9: Run the repo gate**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force
```

Expected: all tasks successful, and `Cached: 0` in the summary. `Cached: 10` means the run was replayed and proved nothing — rerun.

- [ ] **Step 10: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/mls
git commit -m "feat(mls)!: reserve kumiai.* for ledger entry types, freeing group.*"
```

---

### Task 2: Move topic labels to `kumiai/`

**Files:**
- Modify: `packages/rpc/src/topic.ts:6,9,12,14`
- Modify: `packages/broadcast/src/topic.ts:5`

**Interfaces:**
- Consumes: nothing from Task 1. Independent.
- Produces: `INBOX_LABEL = 'kumiai/inbox/v1'`, `COMMIT_LABEL = 'kumiai/commit/v1'`, `RENDEZVOUS_LABEL = 'kumiai/rendezvous/v1'` (all exported from `@kumiai/rpc`), `DISCOVERY_PREFIX = 'kumiai/discovery/v1'` (unexported), `TOPIC_INFO_PREFIX = 'kumiai/topic/v1'` (unexported, `@kumiai/broadcast`). Names unchanged.

There is no failing-test step here, and that is deliberate: no test asserts a label string. Tests assert *derived topic IDs*, which are computed from the labels and are value-neutral under a rename. The suites must stay green **without any test being edited** — that is this task's real assertion.

- [ ] **Step 1: Confirm no test asserts a label string**

```bash
cd /Users/paul/dev/yulsi/kumiai && grep -rn "enkaku/inbox\|enkaku/commit\|enkaku/rendezvous\|enkaku/discovery\|enkaku/topic" packages --include="*.ts" | grep -v node_modules | grep -v "/lib/"
```

Expected: exactly five lines, all in `packages/rpc/src/topic.ts` and `packages/broadcast/src/topic.ts`. If any test file appears, stop and report it — the spec's assumption that labels are asserted only through derived IDs is wrong, and this task needs rethinking before proceeding.

- [ ] **Step 2: Move the four rpc labels**

`packages/rpc/src/topic.ts:6,9,12,14`:

```ts
/** Reserved label for per-member unicast inbox topics. */
export const INBOX_LABEL = 'kumiai/inbox/v1'

/** Reserved label for the non-rotating MLS commit topic. */
export const COMMIT_LABEL = 'kumiai/commit/v1'

/** Reserved label for the non-rotating recovery-rendezvous topic. */
export const RENDEZVOUS_LABEL = 'kumiai/rendezvous/v1'

const DISCOVERY_PREFIX = 'kumiai/discovery/v1'
```

- [ ] **Step 3: Move the broadcast topic-info prefix**

`packages/broadcast/src/topic.ts:5`:

```ts
const TOPIC_INFO_PREFIX = 'kumiai/topic/v1'
```

- [ ] **Step 4: Verify the import graph is untouched**

```bash
cd /Users/paul/dev/yulsi/kumiai && grep -rn "from 'kumiai/\|from \"kumiai/" packages --include="*.ts" | grep -v node_modules | grep -v "/lib/"
```

Expected: no output. Any hit means a find-and-replace caught an `@enkaku/*` import and rewrote it into a broken module specifier.

- [ ] **Step 5: Run the repo gate**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force
```

Expected: all tasks successful, `Cached: 0`, no test edited. A red test here is a real finding — it means something asserted a label indirectly. Investigate it; do not update the assertion to match the new value.

- [ ] **Step 6: Run the integration suite**

Topic derivation is what the integration tests exercise end to end, so they are the strongest check that both ends of a lane still derive the same ID.

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec vitest run --root tests/integration
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add packages/rpc/src/topic.ts packages/broadcast/src/topic.ts
git commit -m "feat(rpc,broadcast)!: reserve kumiai/ for topic labels, replacing enkaku/"
```

---

### Task 3: Publish the contract and release

**Files:**
- Modify: `packages/mls/README.md:10,19,70`
- Modify: `docs/agents/architecture.md` (new section)
- Create: `.changeset/reserved-namespace-rename.md`
- Delete: `docs/agents/plans/next/2026-07-16-reserved-namespace-prefix.md`

**Interfaces:**
- Consumes: the final values from Tasks 1 and 2.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update the mls README**

Three mentions of `group.role` at `packages/mls/README.md:10,19,70` become `kumiai.role`. Read each line before editing — they are prose, and two of them explain the roster model rather than merely naming the type.

- [ ] **Step 2: Document the reservation**

`docs/agents/architecture.md` has no reserved-namespace section today, which is why Kubun discovered the reservation by hitting a wall. Add one:

```markdown
## Reserved namespaces

kumiai reserves two prefixes. Both name kumiai, so a host can tell at a glance
what is not theirs to define.

- **`kumiai.`** — control-ledger entry types (`kumiai.role`,
  `kumiai.recovery-request`, `kumiai.recovery-groupinfo`). The envelope fold
  **fails closed** on an unknown `kumiai.*` type: it rejects the whole commit
  rather than surfacing the entry unread. An entry in a reserved,
  authority-bearing namespace that no one understands must never be passed on.
- **`kumiai/`** — topic labels (`kumiai/inbox/v1`, `kumiai/commit/v1`,
  `kumiai/rendezvous/v1`, `kumiai/discovery/v1`, `kumiai/topic/v1`).

**Application entry types and topic labels must not start with either prefix.**
Everything else is yours, including `group.` — it was reserved until
2026-07-20 and is now application space.
```

- [ ] **Step 3: Write the changeset**

The type checker will not report this break — the constant names are unchanged, so a host importing `ROLE_ENTRY_TYPE` or `COMMIT_LABEL` keeps compiling while the wire values move underneath it. The changeset is the only place that says so.

Create `.changeset/reserved-namespace-rename.md`:

```markdown
---
'@kumiai/broadcast': minor
'@kumiai/mls': minor
'@kumiai/rpc': minor
---

Reserved namespaces now name kumiai: ledger entry types move from `group.*` to
`kumiai.*`, and topic labels from `enkaku/*` to `kumiai/*`. `group.*` is freed
for application entry types — a host defining `group.settings` had its whole
commit rejected before this change.

**Breaking, and the type checker will not tell you.** The exported constant
names are unchanged (`ROLE_ENTRY_TYPE`, `COMMIT_LABEL`, `INBOX_LABEL`,
`RENDEZVOUS_LABEL`, `RECOVERY_REQUEST_TYPE`), so code importing them keeps
compiling while the values underneath move. Two consequences:

- **Ledgers do not survive.** Entry types are signed into tokens and folded into
  the ledger head, so every existing ledger folds to a different head. Recreate
  groups; there is no migration path and no compatibility shim.
- **Topics move.** Labels are hashed into topic IDs. Members that upgrade out of
  lockstep derive different topics and partition silently, with no error on
  either side. Upgrade every peer in a group together.

Code that hardcoded `'group.role'` rather than importing the constant breaks
with no diagnostic. Import the constants.
```

- [ ] **Step 4: Delete the backlog item**

```bash
cd /Users/paul/dev/yulsi/kumiai && git rm docs/agents/plans/next/2026-07-16-reserved-namespace-prefix.md
```

- [ ] **Step 5: Confirm nothing still cites the old names as current**

```bash
cd /Users/paul/dev/yulsi/kumiai && grep -rn "group\.role\|group\.recovery\|enkaku/inbox\|enkaku/commit\|enkaku/topic" packages docs --include="*.md" --include="*.ts" | grep -v node_modules | grep -v "/lib/" | grep -v "plans/completed/" | grep -v "plans/backlog/"
```

Expected: no output, or only the new changeset quoting the old names to explain the break. Hits under `plans/completed/` and `plans/backlog/` are filtered out on purpose — those are historical records and stay as written.

- [ ] **Step 6: Lint**

```bash
cd /Users/paul/dev/yulsi/kumiai && rtk proxy pnpm run lint
```

Expected: clean. Plain `pnpm run lint` is intercepted by the `rtk` shim and reports nothing useful.

- [ ] **Step 7: Full gate**

```bash
cd /Users/paul/dev/yulsi/kumiai && pnpm exec turbo run test:types test:unit --force && pnpm exec vitest run --root tests/integration
```

Expected: all successful, `Cached: 0`.

- [ ] **Step 8: Commit and push**

```bash
cd /Users/paul/dev/yulsi/kumiai
git add -A
git commit -m "docs(mls): document the reserved namespaces, and release the rename"
git push
```
