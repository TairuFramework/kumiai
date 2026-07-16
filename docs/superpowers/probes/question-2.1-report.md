# Probe report — detect a Remove by roster-set diff around processCommit

**Status:** DONE
**Branch:** `feat/app-lane-delivery` (not switched; all changes left uncommitted for review)

## Verdict

Yes. Capturing the member DIDs before `processCommit` and diffing against the DIDs after
correctly flags a Remove — including a Commit carrying **both an Add and a Remove** (the leaf
count is unchanged, so a count check would miss it) — while an add-only, an update/no-op, and an
external-commit rejoin do **not** flag a removal. The approved approach fit the fixtures without a
redesign; the only fixture work required was the additive commit extension the brief anticipated.

## What changed (file:line)

Production (`packages/rpc/src`):

- **`crypto.ts:84`** — added `rosterDIDs(): Promise<Array<string>>` to the `GroupMLS` port type,
  documented like its neighbours: the current member DIDs (what `GroupHandle.listMembers()` would
  give), read around the apply site to detect a dropped leaf. Purely local, reads no secret.
- **`roster.ts`** (new) — pure helper `detectRemoval(before, after): boolean`, true iff the set
  difference `before \ after` is non-empty. No state, no order dependence, duplicates ignored.
- **`index.ts:82`** — export `detectRemoval` (organize-imports placed the line after `recovery.js`).
- **`peer.ts`**:
  - `GroupPeer.anchorEpoch(): number` added to the type (~`:216`) with a doc comment; returned from
    the peer object (~`:1497`). This is the chosen observable — the least-intrusive surface, a
    synchronous getter over recorded state.
  - Anchor state declared as a single object `anchor: { secret, epoch }` (~`:265`), seeded at
    genesis inside the `ready` IIFE **before** `initControlLanes` (~`:1489`) so a removal the seed
    pull applies rotates the anchor rather than being overwritten by a later re-seed.
  - Capture at the apply site in `pullCommits` (~`:772`): read `rosterDIDs()` before
    `processCommit`; when the commit **advanced**, read `rosterDIDs()` again and, if
    `detectRemoval` is true, rotate the anchor — `anchor = { secret: await crypto.exportSecret(),
    epoch: crypto.epoch() }` (the post-commit per-epoch secret, never the recovery secret). The
    before-read is unconditional at that point (it must precede the apply); the after-read and diff
    run only when the epoch advanced, since only an applied commit can move the roster.

Test fixtures (`packages/rpc/test/fixtures`):

- **`memory-group-mls.ts`** — extended the fake commit to optionally carry a roster op, additively:
  - `MemoryCommit` gains optional `adds?: Array<string>` / `removes?: Array<string>`.
  - `encodeMemoryCommit` accepts them in `options`; `decodeMemoryCommit` validates them as string
    arrays when present. Existing commits (no roster op) serialize and decode exactly as before.
  - `enact` applies them to `leaves` when the commit advances — **remove-first, then add**, so an
    Add+Remove in one commit changes the roster in both directions. This is the one tree effect a
    real Add/Remove has, i.e. what adopting the post-commit handle would produce.
  - Added the `rosterDIDs()` port method (returns `[...leaves]`).
- **`commits.ts`** — threaded `adds` / `removes` / `external` through `publishCommit` into
  `encodeMemoryCommit`, so a test frames a roster-op commit onto the lane via the off-stage-admin
  helper.

## The test

**`packages/rpc/test/peer-remove-detect.test.ts`** (new) — 12 tests, all green:

Five drive a commit through the commit lane (off-stage admin `publishCommit` → peer wakes and
pulls → `processCommit`) and read `peer.anchorEpoch()`:

- **remove-only** → detected (anchor 1 → 2; `carol` gone from `leaves`).
- **Add+Remove in one commit** → detected (leaves `['bob','dave']` — count unchanged, anchor 1 → 2).
- **add-only** → NOT detected (epoch advances to 2, anchor stays 1).
- **update / no-op** (no roster op) → NOT detected (epoch advances to 2, anchor stays 1).
- **external-commit rejoin** (an add of a returning member, `external: true`) → NOT detected
  (`dave`'s leaf added, anchor stays 1).

Seven unit-test `detectRemoval` directly: present-before-absent-after, self-removal, Add+Remove,
add-only, unchanged, order/duplicate independence, empty-before.

The names capture the invariant directly ("a commit that drops a leaf rotates the app-lane
anchor") with no reference to plan questions or phases.

## Verify output (real, from repo root: `pnpm run build && rtk proxy pnpm run lint && pnpm test`)

Build (turbo, all cached after first run):

```
 Tasks:    8 successful, 8 total
 Cached:    8 cached, 8 total
   Time:    29ms >>> FULL TURBO
```

Lint (`rtk proxy pnpm run lint` → real biome):

```
$ biome check --write ./packages ./tests
Checked 213 files in 157ms. No fixes applied.
```

Test (`pnpm test` in `packages/rpc` = `test:types` + `test:unit`):

```
$ tsc --noEmit --skipLibCheck -p tsconfig.test.json
$ vitest run

 Test Files  31 passed (31)
      Tests  188 passed | 1 skipped (189)
   Duration  8.65s
```

New file in isolation: `vitest run peer-remove-detect` → **12 passed (12)**.

## Surprises

- The first lint pass raised one `noUnusedVariables` **warning** (not an error): with `anchorSecret`
  as a bare write-only local, its only consumer is the out-of-scope topic derivation, so nothing
  reads it yet. Rather than leave a warning or prefix it `_` (which would read as "intentionally
  unused", the opposite of load-bearing recorded state), I folded the anchor into a single
  `anchor: { secret, epoch }` object. The object is read (the getter and the seed both touch it), so
  the recorded-but-not-yet-consumed secret rides it cleanly and lint is warning-free. Semantics are
  identical; the secret is still captured exactly as the brief specified.
- The repo's `pnpm run lint` runs `biome check --write`, so a lint invocation may apply safe fixes
  (here it reordered the `index.ts` export via organize-imports). No functional change.
- The fake crypto's `exportSecret()` returns a fixed secret independent of epoch, so the recorded
  `anchor.secret` value does not change across epochs in tests — only `anchor.epoch` does. That is
  fine for this probe: the observable and every assertion are on the epoch. In a real port the
  per-epoch secret genuinely rotates; the capture site reads it correctly either way.

## Concerns

- **`rosterDIDs()` is now a required method on `GroupMLS`.** Additive to the type, but any
  consumer-supplied port must implement it or fail typecheck. Trivial for a real MLS adapter
  (`GroupHandle.listMembers()` → DIDs), and intended, but it is a port-contract change to note.
- **`anchor.secret` is recorded but not yet consumed** in this probe (detection-only scope). It is
  dead-but-intentional until Q2.2 derives the app topic from it. If Q2.2 slips, this is a captured
  value with no reader — visible as such, not a leak.
- **Scope held:** no topic derivation, no subscription rotation, no drain were touched. The anchor
  rotation only records state and exposes the epoch; nothing downstream reacts to it yet.
