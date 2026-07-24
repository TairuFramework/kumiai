# GroupAnchor.version Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks

**Goal:** Make `decodeGroupAnchor` withhold the `app` payload when an anchor's `version` exceeds the version this build understands, so a future-version payload never reaches a consumer as though it were current.

**Architecture:** Single-function change in `packages/mls/src/anchor.ts`. After the existing type guards, gate the `app` copy on `record.version <= CURRENT_VERSION`. A future version (`> CURRENT_VERSION`) returns the structural anchor (`creatorDID`, `version`) with no `app`; the member still joins because `readGroupAnchor` gets a non-null decode. No signature change; no touch to `readGroupAnchor`, `GroupHandle`, roster, or ledger.

**Tech Stack:** TypeScript, vitest, ts-mls. Package `@kumiai/mls`.

## Global Constraints

- pnpm only. Run repo scripts as `rtk proxy pnpm run <script>` (an `rtk` shim otherwise redirects `pnpm run` to the wrong tool).
- Do not edit generated files (`lib/`).
- Conventions (`kigu:conventions`): no `interface`, no `any`, no `T[]` (use `Array<T>`), no lowercase acronyms, ES `#fields`.
- `CURRENT_VERSION` is `1` and is the only value ever written (by `buildCurrentGroupAnchorExtension`). The guard is `> CURRENT_VERSION`, not `!== CURRENT_VERSION`: a lower, already-known version stays interpretable by the backward-compat contract.
- Design source: `docs/superpowers/specs/2026-07-24-group-anchor-version-enforcement-design.md`.

---

## File Structure

- `packages/mls/src/anchor.ts` — modify `decodeGroupAnchor` (gate the `app` copy) and its doc comment; add a forward-compat note to `readGroupAnchor`'s doc comment.
- `packages/mls/test/anchor.test.ts` — add version-enforcement cases.

No new files. No signature changes.

---

### Task 1: Withhold `app` on future-version anchors

**Files:**
- Modify: `packages/mls/src/anchor.ts` — `decodeGroupAnchor` (currently lines 52-76) and `readGroupAnchor` doc (currently lines 130-136).
- Test: `packages/mls/test/anchor.test.ts` — add a `describe`/`test` after the existing malformed-bytes test (currently ends line 124).

**Interfaces:**
- Consumes: `decodeGroupAnchor(bytes: Uint8Array): GroupAnchor | null`, `encodeGroupAnchor(anchor: GroupAnchor): Uint8Array`, `type GroupAnchor = { creatorDID: string; version: number; app?: unknown }` — all already exported from `../src/anchor.js`. `CURRENT_VERSION` is a module-private `const` = `1` (not exported; tests use the literal `2` for "above" and `0` for "below").
- Produces: no new exports. `decodeGroupAnchor`'s runtime contract changes: for `version > CURRENT_VERSION` the returned anchor omits `app`.

- [ ] **Step 1: Write the failing tests**

Add this block to `packages/mls/test/anchor.test.ts`, immediately after the test that ends at line 124 (`decodeGroupAnchor returns null (never throws) on malformed bytes or wrong shape`), still inside the `describe('group anchor', ...)` block:

```typescript
  test('decodeGroupAnchor withholds app when version is above CURRENT_VERSION', () => {
    // A future build wrote this anchor (version 2 > the current 1) with an app
    // payload this build cannot interpret. Structural fields stay; app is dropped.
    const future = encodeGroupAnchor({
      creatorDID: 'did:example:alice',
      version: 2,
      app: { recoverySecret: 'v2-seed', shape: 'unknown-to-v1' },
    })
    const decoded = decodeGroupAnchor(future)
    expect(decoded).not.toBeNull()
    expect(decoded?.creatorDID).toBe('did:example:alice')
    // version is preserved, so a consumer can tell "future, app withheld"
    // (version 2, app undefined) from "genuinely no app" (version 1, app undefined).
    expect(decoded?.version).toBe(2)
    expect(decoded?.app).toBeUndefined()
    expect('app' in (decoded as object)).toBe(false)
  })

  test('decodeGroupAnchor keeps app for a version below CURRENT_VERSION', () => {
    // No such anchor exists today (1 is the only value written), but by the
    // backward-compat contract a lower, already-known version stays interpretable.
    const older = encodeGroupAnchor({
      creatorDID: 'did:example:alice',
      version: 0,
      app: { note: 'still readable' },
    })
    const decoded = decodeGroupAnchor(older)
    expect(decoded?.version).toBe(0)
    expect(decoded?.app).toEqual({ note: 'still readable' })
  })

  test('decodeGroupAnchor keeps app at the current version', () => {
    const current = encodeGroupAnchor({
      creatorDID: 'did:example:alice',
      version: 1,
      app: { recoverySecret: 'v1-seed' },
    })
    const decoded = decodeGroupAnchor(current)
    expect(decoded?.version).toBe(1)
    expect(decoded?.app).toEqual({ recoverySecret: 'v1-seed' })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk proxy pnpm --filter @kumiai/mls exec vitest run test/anchor.test.ts`
Expected: the two new "current"/"below" tests PASS (behavior already correct), and `withholds app when version is above CURRENT_VERSION` FAILS — `decoded?.app` is currently the object, not `undefined`, so `expect(decoded?.app).toBeUndefined()` fails.

(If the "above" test unexpectedly passes, stop — the gate may already exist; re-read `decodeGroupAnchor` before implementing.)

- [ ] **Step 3: Gate the `app` copy on the version**

In `packages/mls/src/anchor.ts`, in `decodeGroupAnchor`, change the `app`-copy condition (currently lines 72-74):

```typescript
  const anchor: GroupAnchor = { creatorDID: record.creatorDID, version: record.version }
  if ('app' in record && record.app !== undefined) {
    anchor.app = record.app
  }
  return anchor
```

to:

```typescript
  const anchor: GroupAnchor = { creatorDID: record.creatorDID, version: record.version }
  // Withhold the app payload from a future build's anchor: a version this build
  // has never seen may carry a payload with v2 semantics, and handing it to a
  // consumer under v1 expectations is exactly the silent misread this guards.
  // The structural fields (creatorDID, version) stay usable, so the member still
  // joins — only the opaque payload it provably cannot interpret is dropped.
  if (record.version <= CURRENT_VERSION && 'app' in record && record.app !== undefined) {
    anchor.app = record.app
  }
  return anchor
```

- [ ] **Step 4: Update the `decodeGroupAnchor` doc comment**

Replace the `decodeGroupAnchor` doc comment (currently lines 52-56):

```typescript
/**
 * Tolerant decode: null on malformed bytes or wrong shape, never throws. `creatorDID` must be a
 * string and `version` a number; `app` is optional, so its absence isn't malformed. A consumer
 * needing a specific `app` shape validates that itself.
 */
```

with:

```typescript
/**
 * Tolerant decode: null on malformed bytes or wrong shape, never throws. `creatorDID` must be a
 * string and `version` a number; `app` is optional, so its absence isn't malformed. A consumer
 * needing a specific `app` shape validates that itself.
 *
 * Forward-compat gate: when `version > CURRENT_VERSION` (a future build wrote it), the returned
 * anchor keeps `creatorDID` and `version` but drops `app` — the opaque payload may carry semantics
 * this build has never seen, and a v1 consumer reading it as v1 (kubun keeps its recovery seed in
 * `app`) cannot tell. `version` is preserved so a consumer distinguishes "future version, app
 * withheld" from "genuinely no app". Contract this rests on: a `version` bump means `app` semantics
 * changed and nothing else; any future control-relevant field must go in a new extension type, never
 * inside the anchor where a version-tolerant older peer would silently ignore it.
 */
```

- [ ] **Step 5: Add the forward-compat note to `readGroupAnchor`'s doc**

Replace the `readGroupAnchor` doc comment (currently lines 130-136):

```typescript
/**
 * Read and decode the genesis anchor. Null only when genuinely absent; a present-but-
 * undecodable extension is corruption and throws, so a control gate fails closed instead of
 * silently downgrading (the anchor is authenticated by the GroupInfo signature, so this guards
 * corruption, not forgery). Use {@link readGroupAnchorExtension} for bytes to copy into a
 * proposal — never a re-encode of this result.
 */
```

with:

```typescript
/**
 * Read and decode the genesis anchor. Null only when genuinely absent; a present-but-
 * undecodable extension is corruption and throws, so a control gate fails closed instead of
 * silently downgrading (the anchor is authenticated by the GroupInfo signature, so this guards
 * corruption, not forgery). Use {@link readGroupAnchorExtension} for bytes to copy into a
 * proposal — never a re-encode of this result.
 *
 * A future-version anchor is not corruption: {@link decodeGroupAnchor} decodes it (dropping `app`),
 * so this returns a non-null anchor and the member joins. Only the payload a v1 build cannot
 * interpret is withheld.
 */
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `rtk proxy pnpm --filter @kumiai/mls exec vitest run test/anchor.test.ts`
Expected: all tests in the file PASS, including the three new ones and the pre-existing `an anchor with no app round-trips` test (line 50, which uses `version: 2` with no `app` — still passes, as there was no `app` to drop).

- [ ] **Step 7: Typecheck and lint**

Run: `rtk proxy pnpm --filter @kumiai/mls run typecheck` (or `rtk proxy pnpm exec tsc --noEmit -p packages/mls` if no such script)
Expected: no errors.

Run: `rtk proxy pnpm run lint` (real biome output — the `rtk` shim otherwise fakes it)
Expected: clean on the two touched files.

- [ ] **Step 8: Commit**

```bash
git add packages/mls/src/anchor.ts packages/mls/test/anchor.test.ts
git commit -m "feat(mls): enforce GroupAnchor.version on decode, withholding app from future versions"
```

---

## Self-Review

**Spec coverage:**
- decode gate `> CURRENT_VERSION` drops `app`, `<=` keeps it → Step 3. ✓
- doc comments on `decodeGroupAnchor` + `readGroupAnchor` stating rule and v2 contract → Steps 4-5. ✓
- no signature change; `readGroupAnchor`/`GroupHandle` untouched → confirmed (only the `app`-copy line and two doc comments change). ✓
- tests: version above (app absent, version preserved), below (full), at current (full) → Step 1. ✓
- behavior table `null`/throws paths for malformed → already covered by existing test at line 110-124, unchanged. ✓

**Placeholder scan:** none — every step carries the exact code or command.

**Type consistency:** `decodeGroupAnchor`, `encodeGroupAnchor`, `GroupAnchor` used exactly as declared in `anchor.ts`. `CURRENT_VERSION` referenced only inside `anchor.ts` (module-private); tests use literals `0`/`1`/`2`. No new symbols introduced.
