# GroupMLS roster leaf identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `GroupMLS.rosterDIDs(): Promise<Array<string>>` port method with `rosterEntries(): Promise<Array<RosterEntry>>` (`RosterEntry = { did; leafIndex; longForm }`) across `@kumiai/rpc`, `@kumiai/mls-rpc`, and `@kumiai/rpc-conformance`, in one 0.x `minor`.

**Architecture:** The port gains per-leaf identity. The real impl (`mls-rpc`) maps `listMembers()`, which already carries all three fields. The rpc test double converts its compact `Array<string>` roster to a hole-preserving `Map<number,string>` slot model so `leafIndex` is stable and reused exactly as ts-mls does. `detectRosterChange` stays a DID-set compare (consumers extract `.did`). Duplicate-DID leaf removal is deliberately out of scope (documented coverage gap).

**Tech Stack:** TypeScript, pnpm workspaces, turbo, biome, vitest. ts-mls under `@kumiai/mls`.

**Spec:** `docs/superpowers/specs/2026-09-04-roster-leaf-identity-design.md`

## Global Constraints

- pnpm only. Do not edit generated files (`lib/`).
- Internal `@kumiai/*` deps are `workspace:^`; cross-repo deps go through the catalog as published `^`.
- Lint with `rtk proxy pnpm run lint` — the bare `pnpm run lint` / `pnpm exec biome` are intercepted by the `rtk` shim and give fake output.
- Test verification: `pnpm test` reports cached turbo results. Force it and confirm `Cached: 0`. Do **not** use `pnpm test -- --force` (broken).
- Breaking type change: verify with repo-wide `turbo run test:types`, never a per-package `--filter` — a consumer package can hide un-migrated sites a filtered run reports green.
- `RosterEntry` is `{ did: string; leafIndex: number; longForm: string }`. `longForm` is long-form-or-`id` fallback, **never** a resolvability guarantee. `leafIndex` is stable only while the leaf remains present (a remove/rejoin may reassign it). `rosterEntries()` returns entries in **ascending `leafIndex` order**.
- A double may be stricter than its port, never more permissive.

---

## File structure

- `packages/rpc/src/crypto.ts` — declare `RosterEntry`; rename port method `rosterDIDs`→`rosterEntries`; rewrite its doc block and the `CommitHeader.external` note (`:186`).
- `packages/rpc/src/index.ts` — export `RosterEntry`.
- `packages/rpc/src/peer.ts` — two call sites in `advanceHandle` (`:1211`, `:1229`).
- `packages/rpc/test/fixtures/memory-group-mls.ts` — convert `leaves: Array<string>` to a `Map<number,string>` slot model; expose `rosterEntries`.
- `packages/rpc/test/roster-slot-model.test.ts` (new) — unit-test the double's slot semantics.
- `packages/rpc/test/roster-entries.type.test.ts` (new) — type-level test of `rosterEntries()`.
- `packages/rpc/test/did-normalization.test.ts` — comment rename (`:61`).
- `packages/mls-rpc/src/mls.ts` — impl (`:130`).
- `packages/rpc-conformance/src/group-mls.ts` — type row (`:47`), rekeyed assertions, renamed describe, new leaf-identity clauses.
- `docs/agents/architecture.md` — prose rename (`:46`).
- `packages/mls/src/group-handle.ts` — optional adjacent comment fix (`:713-717`).

---

## Task 1: Convert the double to a hole-preserving slot model (behavior-preserving)

Refactor `memory-group-mls.ts`'s internal `leaves: Array<string>` to a `Map<number,string>` slot model **without changing the port** — it still exposes `rosterDIDs()` returning occupied DIDs. This keeps the whole repo green while replacing compaction with blanking, so `leafIndex` (added in Task 2) is stable and reused. The existing exact-array tests (`peer-roster-change-detect.test.ts`) are the behavior guard.

**Files:**
- Modify: `packages/rpc/test/fixtures/memory-group-mls.ts` (init `:368`; reads `:405`, `:457`; mutations `:451`, `:457`, `:465/:467`, `:523`, `:597`, `:739/:741`; accessors `:484`, `:486`)
- Create: `packages/rpc/test/roster-slot-model.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: internal helpers in the double — `slotAdd(did)`, `slotRemoveDID(did)`, `slotHas(did): boolean`, `occupiedDIDs(): Array<string>` (ascending index). `rosterDIDs()` still returns `Array<string>`. Task 2 adds `rosterEntries()` beside these.

- [ ] **Step 1: Write the failing slot-model test**

Create `packages/rpc/test/roster-slot-model.test.ts`. `createMemoryGroupMLS(options)` returns a flat object that IS the port plus test helpers (`rosterDIDs`, `buildCommit`, `adopt`, `leaves` are all siblings — there is no `.mls` wrapper; that shape belongs to `makeMLSPeer`). `buildCommit(tokens = [], { adds?, removes? })` returns commit **bytes**; `adopt(bytes)` enacts the author's own commit (applies adds/removes and advances the epoch), which is the simplest way to drive a roster change directly.

```ts
import { describe, expect, test } from 'vitest'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'

// A freshly created 3-member group occupies dense slots 0,1,2; removing the
// middle member frees slot 1; the next add refills slot 1 (leftmost blank),
// NOT slot 3 — this is exactly what compaction gets wrong.
describe('memory double slot model', () => {
  test('remove frees a slot and the next add reuses it (ascending order preserved)', async () => {
    const g = createMemoryGroupMLS({ localDID: 'alice', members: ['alice', 'bob', 'carol'] })
    expect(await g.rosterDIDs()).toEqual(['alice', 'bob', 'carol'])

    g.adopt(g.buildCommit([], { removes: ['bob'] }))
    expect(await g.rosterDIDs()).toEqual(['alice', 'carol']) // hole at slot 1

    g.adopt(g.buildCommit([], { adds: ['dave'] }))
    // dave takes freed slot 1 -> ascending order is alice, dave, carol
    expect(await g.rosterDIDs()).toEqual(['alice', 'dave', 'carol'])
  })
})
```

Confirm `MemoryGroupMLSOptions` accepts `{ localDID, members }` (it does — see the factory at `memory-group-mls.ts:352` and the `members`/`localDID` seed at `:368`). `adopt` re-frames at the current epoch, so the second `buildCommit` is correctly framed after the first `adopt` advances it.

- [ ] **Step 2: Run it — confirm it fails on the compaction behavior**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/roster-slot-model.test.ts`
Expected: FAIL on the third assertion — the current compact-array double splices carol out then pushes dave, returning `['alice','carol','dave']`, not `['alice','dave','carol']`. (The first two assertions already pass; only the reuse-order one distinguishes the models.)

- [ ] **Step 3: Introduce the slot model and helpers**

In `memory-group-mls.ts`, replace the `leaves` array declaration (`:368`):

```ts
// Hole-preserving leaf-slot model, keyed by ratchet-tree leaf index. Real ts-mls blanks a
// removed leaf and fills the leftmost blank on add; a compact array cannot, and would hand out
// position-indices the real port never does (more permissive — forbidden for a double).
const slots = new Map<number, string>()
;(options.members ?? (localDID != null ? [localDID] : [])).forEach((did, i) => slots.set(i, did))

const lowestFreeSlot = (): number => {
  let i = 0
  while (slots.has(i)) i++
  return i
}
const slotAdd = (did: string): void => {
  // The double never adds a DID it already holds (matches how buildCommit models adds).
  if (![...slots.values()].includes(did)) slots.set(lowestFreeSlot(), did)
}
const slotRemoveDID = (did: string): void => {
  for (const [i, d] of slots) if (d === did) slots.delete(i)
}
const slotHas = (did: string): boolean => [...slots.values()].includes(did)
const occupiedDIDs = (): Array<string> =>
  [...slots.keys()].sort((a, b) => a - b).map((i) => slots.get(i) as string)
```

- [ ] **Step 4: Migrate every `leaves` read and mutation to the helpers**

Replace each site (line numbers pre-edit; find by the surrounding code):

- Recovery-request membership check (`:405`): `if (!leaves.includes(parsed.requesterDID))` → `if (!slotHas(parsed.requesterDID))`
- Ordinary remove loop (`:450-453`): the `for` + `splice` block → `for (const did of parsed.removes) slotRemoveDID(did)`
- Ordinary add loop (`:455-458`): the `for` + `push` block → `for (const did of parsed.adds) slotAdd(did)`
- External rejoin (`:464-467`): the `for`/`splice` + `push` → `slotRemoveDID(parsed.committerDID); slotAdd(parsed.committerDID)`
- `leaves` accessor (`:484`): `leaves: () => [...leaves]` → `leaves: () => occupiedDIDs()`
- `rosterDIDs` (`:486`): `return [...leaves]` → `return occupiedDIDs()`
- `evict` (`:522-523`): the `for`/`splice` → `slotRemoveDID(did)`
- Self-removal (`:596-597`): the `for`/`splice` → `slotRemoveDID(localDID)`
- Recovery adoption (`:738-741`): the `for`/`splice` + `leaves.push(localDID)` → `slotRemoveDID(localDID); slotAdd(localDID)`

Also update the `leaves: () => Array<string>` return-type comment if the fixture types the returned object explicitly (it stays `Array<string>`).

- [ ] **Step 5: Run the new test + the existing roster tests**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/roster-slot-model.test.ts test/peer-roster-change-detect.test.ts`
Expected: PASS. If `peer-roster-change-detect.test.ts` now fails on an exact array, trace the slot state — the intended contract is ascending-slot order; do NOT reintroduce insertion order to satisfy a stale expectation. Fix the test's expected array only if the spec's order-change note (`{0:a,1:b,2:c}` remove b add d → `[a,d,c]`) applies to it.

- [ ] **Step 6: Run the whole rpc suite (unchanged behavior everywhere else)**

Run: `pnpm --filter @kumiai/rpc test -- --run` (or the repo's vitest invocation) and confirm green. Then `turbo run test --filter @kumiai/rpc` with `Cached: 0`.
Expected: PASS — this task is behavior-preserving for every consumer of `rosterDIDs`/`leaves`.

- [ ] **Step 7: Lint + commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc/test/fixtures/memory-group-mls.ts packages/rpc/test/roster-slot-model.test.ts
git commit -m "refactor(rpc): hole-preserving slot model in memory GroupMLS double"
```

---

## Task 2: Rename the port to `rosterEntries` and migrate every site (the breaking change)

Add `RosterEntry`, rename the port method, and migrate all compile sites together — consumer, real impl, double, conformance type row + assertions, plus the two doc renames. A breaking type change cannot land green in isolation; the gate is repo-wide `turbo run test:types` plus both contract suites.

**Files:**
- Modify: `packages/rpc/src/crypto.ts` (`:186` note, port doc `:258-271`), `packages/rpc/src/index.ts` (`:40-47` export block), `packages/rpc/src/peer.ts` (`:1211`, `:1229`), `packages/rpc/test/fixtures/memory-group-mls.ts` (add `rosterEntries`), `packages/mls-rpc/src/mls.ts` (`:130`), `packages/rpc-conformance/src/group-mls.ts` (`:47` type row; assertions `:223/:230/:261/:327/:329/:333/:336/:339/:454`; describe `:313`), `packages/rpc/test/did-normalization.test.ts` (`:61` comment), `docs/agents/architecture.md` (`:46`)

**Interfaces:**
- Consumes: Task 1's `occupiedDIDs()` / `slots` in the double.
- Produces: `RosterEntry` (exported from `@kumiai/rpc`); `GroupMLS.rosterEntries(): Promise<Array<RosterEntry>>`; double `rosterEntries()`. No other port method changes.

- [ ] **Step 1: Declare `RosterEntry` and rename the port method + docs**

In `packages/rpc/src/crypto.ts`, add above `GroupMLS` (or beside `GroupUnwrapResult`):

```ts
/**
 * One occupied leaf of a group's ratchet tree. `rosterEntries()` yields these in ascending
 * `leafIndex` order.
 */
export type RosterEntry = {
  /** Normalized short DID of the member holding this leaf. */
  did: string
  /**
   * MLS ratchet-tree leaf index. Stable WHILE this leaf remains present — a commit that does not
   * remove this member does not move it. A remove-then-rejoin (external commit) MAY reassign it:
   * the rejoin takes the leftmost blank, which need not be the slot just vacated. Not a stable
   * per-member identity across a membership gap.
   */
  leafIndex: number
  /**
   * The leaf credential's long form when it carries one, else `id` (real impl:
   * `parsed.longForm ?? parsed.id`). Never absent — but NOT a dereferenceable/resolvable DID
   * guarantee: it is whatever the credential holds, and for an id with no long form it is the id.
   */
  longForm: string
}
```

Rename the method and rewrite its doc block (`:258-271`):

```ts
  /**
   * The leaves this handle's ratchet tree currently holds, one {@link RosterEntry} per leaf, in
   * ascending `leafIndex` order. Purely local: reads no secret, advances nothing.
   *
   * Read around {@link processCommit} to tell a Commit that dropped a leaf from one that didn't:
   * a `did` present before and absent after means a Remove was enacted (robust to a Commit
   * carrying both an Add and a Remove). Compared as a set of `did` — order and `leafIndex` do not
   * matter to that diff (see {@link "roster".detectRosterChange}).
   *
   * Membership only: a rejoin by a member the roster still holds changes no `did` and is invisible
   * to a `did` diff — {@link CommitHeader.external} is what the lane rotates on for that.
   */
  rosterEntries(): Promise<Array<RosterEntry>>
```

Update the `CommitHeader.external` note (`:186`) — replace `{@link rosterDIDs} reads the same set before and after` with `{@link rosterEntries} reads the same `did` set before and after`.

- [ ] **Step 2: Export `RosterEntry`**

In `packages/rpc/src/index.ts`, add to the `crypto.js` export block (`:40-47`):

```ts
  type PendingRecovery,
  type RosterEntry,
} from './crypto.js'
```

- [ ] **Step 3: Migrate the consumer (`peer.ts`)**

Both call sites in `advanceHandle` (`:1211`, `:1229`):

```ts
const rosterBefore = (await port.rosterEntries()).map((e) => normalizeDID(e.did))
// ...
detectRosterChange(rosterBefore, (await port.rosterEntries()).map((e) => normalizeDID(e.did)))
```

`detectRosterChange` and `roster.ts` are unchanged (still `Array<string>`).

- [ ] **Step 4: Migrate the real impl (`mls-rpc/src/mls.ts:130`)**

```ts
    async rosterEntries(): Promise<Array<RosterEntry>> {
      return handle()
        .listMembers()
        .map((member) => ({
          did: member.id,
          leafIndex: member.leafIndex,
          longForm: member.longForm,
        }))
    },
```

Add `RosterEntry` to the type import at `mls.ts:13`: `import type { CommitContext, CommitHeader, GroupMLS, PendingRecovery, RosterEntry } from '@kumiai/rpc'`. Retitle the doc note at `mls.ts:105` from `rosterDIDs` to `rosterEntries` (the "unparsable credential is simply absent" note still holds).

- [ ] **Step 5: Add `rosterEntries` to the double**

In `memory-group-mls.ts`, add a `rosterEntries` helper beside `occupiedDIDs` (from Task 1):

```ts
const rosterEntries = (): Array<{ did: string; leafIndex: number; longForm: string }> =>
  [...slots.keys()].sort((a, b) => a - b).map((i) => {
    const did = slots.get(i) as string
    return { did, leafIndex: i, longForm: did } // longForm = id fallback; fixture ids carry no long form
  })
```

Replace the returned `rosterDIDs` accessor (from Task 1's `occupiedDIDs`) with:

```ts
    async rosterEntries() {
      return rosterEntries()
    },
```

Keep `leaves: () => occupiedDIDs()` — the fixture-only `leaves()` accessor stays for DID-only tests.

- [ ] **Step 6: Migrate conformance (`group-mls.ts`)**

Type row (`:47`): `rosterDIDs: () => Promise<Array<string>>` → `rosterEntries: () => Promise<Array<RosterEntry>>` (import `RosterEntry` from `@kumiai/rpc` at the top of the file). Add a helper near the top of the suite:

```ts
const dids = (r: Array<RosterEntry>) => r.map((e) => e.did)
```

Rekey each assertion (`:223/:230/:261/:327/:329/:333/:336/:339/:454`). Two patterns:

```ts
// .toContain(x.did) / .not.toContain(x.did):
expect(dids(await alice.mls.rosterEntries())).toContain(carol.did)
expect(dids(await alice.mls.rosterEntries())).not.toContain(carol.did)
// new Set(await x.rosterDIDs()) comparisons:
expect(new Set(dids(await bob.mls.rosterEntries()))).toEqual(new Set(before))
```

where `before` becomes `const before = dids(await alice.mls.rosterEntries())`. Rename the `describe('rosterDIDs')` block (`:313`) to `describe('rosterEntries')`. Do not add new clauses here — that is Task 3.

- [ ] **Step 7: Rename the two doc references**

- `packages/rpc/test/did-normalization.test.ts:61` comment: ``the `rosterDIDs()` ingress`` → ``the `rosterEntries()` ingress``.
- `docs/agents/architecture.md:46`: the `GroupMLS` row `rosterDIDs` → `rosterEntries`.

- [ ] **Step 8: Repo-wide type check (the breaking-change gate)**

Run: `turbo run test:types`
Expected: PASS across all 14 packages. A failure here names an un-migrated site — fix it before proceeding. Do NOT use `--filter`.

- [ ] **Step 9: Run both contract suites + rpc/mls-rpc tests**

Run: `turbo run test --filter @kumiai/rpc --filter @kumiai/mls-rpc --filter @kumiai/rpc-conformance` and confirm `Cached: 0` and green. (Both `rpc-conformance` and `hub-conformance` obligations: only `rpc-conformance` is affected here; `hub-conformance` is untouched.)
Expected: PASS — the double and the real impl both satisfy the renamed port.

- [ ] **Step 10: Lint + commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc/src/crypto.ts packages/rpc/src/index.ts packages/rpc/src/peer.ts \
  packages/rpc/test/fixtures/memory-group-mls.ts packages/rpc/test/did-normalization.test.ts \
  packages/mls-rpc/src/mls.ts packages/rpc-conformance/src/group-mls.ts docs/agents/architecture.md
git commit -m "feat(rpc)!: GroupMLS.rosterDIDs -> rosterEntries with per-leaf identity"
```

---

## Task 3: Strengthen the conformance leaf-identity clauses

Add the new `rosterEntries` clauses that pin `leafIndex` structure AND values, so a stable-but-arbitrary index impl cannot pass. Additive to the suite.

**Files:**
- Modify: `packages/rpc-conformance/src/group-mls.ts` (the renamed `describe('rosterEntries')` block, `:313`)

**Interfaces:**
- Consumes: `dids` helper + `RosterEntry` import from Task 2; `withGroup` / `memberAt` / `buildCommit` already in the suite.
- Produces: nothing downstream.

- [ ] **Step 1: Add the leaf-identity test**

Inside the `describe('rosterEntries')` block, after the existing "reflects an APPLIED roster change" test:

```ts
test('leafIndex is a dense 0..n-1 on a fresh group, unique, ascending, and stable for untouched members', async () => {
  await withGroup(3, 'roster-leaf-identity', async (group) => {
    const alice = memberAt(group.members, 0)
    const entries = await alice.mls.rosterEntries()

    // Fresh n-member group occupies exactly slots {0..n-1}.
    expect(entries.map((e) => e.leafIndex).sort((a, b) => a - b)).toEqual([0, 1, 2])
    // Unique.
    expect(new Set(entries.map((e) => e.leafIndex)).size).toBe(entries.length)
    // Ascending order as returned.
    expect(entries.map((e) => e.leafIndex)).toEqual([...entries.map((e) => e.leafIndex)].sort((a, b) => a - b))
    // Non-empty longForm (presence only, NOT resolvability).
    for (const e of entries) expect(e.longForm.length).toBeGreaterThan(0)

    // Stability: removing member 2 does not move member 0's leafIndex.
    const alice0 = entries.find((e) => e.did === alice.did)?.leafIndex
    const removal = await group.buildCommit({ removes: 2 })
    await alice.mls.processCommit(removal.commit, removal.context)
    const after = await alice.mls.rosterEntries()
    expect(after.find((e) => e.did === alice.did)?.leafIndex).toBe(alice0)
  })
})
```

- [ ] **Step 2: Add the different-DID reuse test**

```ts
test('an add after a removal reuses the freed leaf index (leftmost blank, different DID)', async () => {
  await withGroup(3, 'roster-leaf-reuse', async (group) => {
    const alice = memberAt(group.members, 0)
    // Remove the member at slot 1, then add a fresh member; the new leaf takes freed slot 1.
    const freed = (await alice.mls.rosterEntries()).find((e) => e.leafIndex === 1)?.did
    expect(freed).toBeDefined()
    const removal = await group.buildCommit({ removes: 1 })
    await alice.mls.processCommit(removal.commit, removal.context)
    const add = await group.addMember(group, 'reuse-newcomer') // use the suite's real add helper
    await alice.mls.processCommit(add.commit, add.context)

    const entries = await alice.mls.rosterEntries()
    const newcomer = entries.find((e) => e.did !== alice.did && e.did !== freed && e.leafIndex === 1)
    expect(newcomer).toBeDefined() // the newcomer occupies freed slot 1, not slot 3
  })
})
```

Note: `group.addMember` / the add-a-new-member helper name comes from the conformance harness — inspect `withGroup`/`buildCommit`'s surrounding code and use the real helper for adding a *new* member (not `buildCommit({ adds })` if that only models an existing DID). If the harness cannot add a genuinely new member in-suite, assert the reuse against the double + real impl via `buildCommit({ removes })` followed by whatever add path the suite supports; the invariant to prove is *freed index reused*, not the specific helper.

- [ ] **Step 3: Run the conformance suite against BOTH the real impl and the double**

Run: `turbo run test --filter @kumiai/rpc --filter @kumiai/mls-rpc --filter @kumiai/rpc-conformance` (`Cached: 0`).
Expected: PASS for both. If the real ts-mls impl disagrees on `{0..n-1}` or reuse, the clause is wrong (the real impl is the source of truth) — re-derive from ts-mls behavior, not from the double.

- [ ] **Step 4: Lint + commit**

```bash
rtk proxy pnpm run lint
git add packages/rpc-conformance/src/group-mls.ts
git commit -m "test(rpc-conformance): pin rosterEntries leafIndex values, order, and reuse"
```

---

## Task 4: rpc type-level regression test

A compile-time guard that `rosterEntries()` is typed against `RosterEntry`.

**Files:**
- Create: `packages/rpc/test/roster-entries.type.test.ts`

**Interfaces:**
- Consumes: `GroupMLS`, `RosterEntry` from `@kumiai/rpc`.

- [ ] **Step 1: Write the type-level test**

```ts
import { expectTypeOf } from 'vitest'
import { test } from 'vitest'
import type { GroupMLS, RosterEntry } from '@kumiai/rpc'

test('rosterEntries is typed against RosterEntry', () => {
  type Ret = Awaited<ReturnType<GroupMLS['rosterEntries']>>
  expectTypeOf<Ret>().toEqualTypeOf<Array<RosterEntry>>()
  expectTypeOf<RosterEntry['did']>().toEqualTypeOf<string>()
  expectTypeOf<RosterEntry['leafIndex']>().toEqualTypeOf<number>()
  expectTypeOf<RosterEntry['longForm']>().toEqualTypeOf<string>()
})
```

- [ ] **Step 2: Verify types (vitest strips types — pair with the type checker)**

Run: `pnpm --filter @kumiai/rpc exec vitest run test/roster-entries.type.test.ts` (runtime no-op pass) AND `turbo run test:types --filter @kumiai/rpc`.
Expected: both PASS. The `test:types` run is what actually validates the `expectTypeOf` assertions — a green vitest run alone proves nothing about the types.

- [ ] **Step 3: Commit**

```bash
git add packages/rpc/test/roster-entries.type.test.ts
git commit -m "test(rpc): type-level guard for rosterEntries return shape"
```

---

## Task 5 (optional): adjacent comment fix in `@kumiai/mls`

Correct the overstated rejoin claim in `listMembers`'s doc — a comment accuracy fix, no behavior change. Skip if keeping the change strictly within the three rpc-stack packages.

**Files:**
- Modify: `packages/mls/src/group-handle.ts:713-717`

- [ ] **Step 1: Rewrite the comment**

Replace "and its leaf index is unchanged too, because a resync blanks the member's old leaf and the new leaf then takes the leftmost blank — the one just blanked (RFC 9420 §12.4.3.2)" with a correct version: the new leaf takes the **leftmost blank**, which is the just-vacated slot only when no earlier blank exists; otherwise the rejoiner moves. The DID set is unchanged regardless, which is why a `did` diff cannot see the rejoin and the caller reads `CommitHeader.external` instead.

- [ ] **Step 2: Type-check + commit**

```bash
turbo run test:types --filter @kumiai/mls
rtk proxy pnpm run lint
git add packages/mls/src/group-handle.ts
git commit -m "docs(mls): correct listMembers rejoin leaf-index comment"
```

---

## Task 6: Final verification + milestone bookkeeping

**Files:**
- Modify: `docs/agents/plans/backlog/rpc-api-surface.md` (strike the `rosterDIDs` finding), `docs/agents/plans/milestones/pre-1.0-breaking-api.md:118` (mark taken)
- Create: `docs/agents/plans/completed/2026-09-04-roster-leaf-identity.complete.md`

- [ ] **Step 1: Full repo gate**

Run: `turbo run test:types` (repo-wide) then `turbo run test` with `Cached: 0`, then `rtk proxy pnpm run lint`.
Expected: all green across the repo.

- [ ] **Step 2: Record a release intent**

Run `pnpm change` (or the repo's intent command per kigu:releasing) recording a `minor` for the band: "GroupMLS.rosterDIDs → rosterEntries with per-leaf identity (breaking)".

- [ ] **Step 3: Mark the milestone item taken**

In `rpc-api-surface.md`, strike the `GroupMLS.rosterDIDs` finding with a `*Taken 2026-09-04:*` note linking the completion doc. In `pre-1.0-breaking-api.md`, strike the same item in the rpc section index. Write `completed/2026-09-04-roster-leaf-identity.complete.md` summarizing the change, the scoped-out duplicate-DID gap, and the conformance clauses added.

- [ ] **Step 4: Commit**

```bash
git add docs/agents/plans/
git commit -m "docs: mark rosterEntries breaking-API item taken"
```

---

## Self-review notes

- **Spec coverage:** RosterEntry shape (T2) · rename + docs (T2) · consumer/detectRosterChange unchanged (T2 step 3) · real impl (T2 step 4) · hole-preserving double + all six mutation paths + reads (T1) · sparse-storage footgun avoided via `Map` (T1) · leaves() ascending projection + exact-array tests (T1) · conformance rekey (T2 step 6) + value/structural/reuse clauses (T3) · longForm id-fallback, presence-only assertion (T2, T3) · ascending-order contract (T2 doc, T3 assert) · type-level test (T4) · repo-wide test:types gate (T2 step 8, T6) · scoped-out duplicate-DID gap (documented, not implemented) · adjacent group-handle comment (T5) · milestone bookkeeping (T6). All covered.
- **Placeholders:** the two "inspect the harness for the real helper name" notes (T1 step 1, T3 step 2) are deliberate — the fixture/harness factory and add-member helper names must be read from source, not guessed; the invariant each test proves is stated concretely.
- **Type consistency:** `RosterEntry { did; leafIndex; longForm }` and `rosterEntries(): Promise<Array<RosterEntry>>` used identically in T2/T3/T4; double's internal `rosterEntries()` returns the structurally-equal inline type.
