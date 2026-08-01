# pnpm Native Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-08-01-pnpm-native-versioning-design.md`
**Branch:** `chore/pnpm-native-versioning`

**Goal:** Replace Changesets with pnpm's native release management, and make the version band the
docs claim into a rule a check enforces — with `@kumiai/mls-hub` on the band so its first published
version is 0.5.0, never 0.1.0.

**Architecture:** A ~40-line dependency-free Node script asserts every publishable package shares
one version band (the minor while pre-1.0, the major after), wired into `pnpm test` and the first
step of `pnpm release`. Release tooling moves to `pnpm change` / `pnpm version -r` /
`pnpm publish -r`, configured under `versioning:` in `pnpm-workspace.yaml`; the existing
`.changeset/*.md` intent files carry over unchanged because pnpm reads that format.

**Tech Stack:** pnpm 11.18.0 (native versioning, added 11.13.0), Node 24/26, vitest 4, Biome 2.5,
Turbo 2.10.

## Global Constraints

- pnpm only. Never `npm` or `yarn`.
- Do not edit generated files (`lib/`).
- Code style is Biome-enforced: single quotes, no semicolons, 2-space indent, 100-column lines,
  trailing commas. Run `rtk proxy pnpm run lint` for real lint output — a shim intercepts bare
  `pnpm run lint` and `pnpm exec biome`.
- Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as
  published `^` ranges. Internal `@kumiai/*` deps are `workspace:^`.
- The version band: every publishable package shares the same minor while pre-1.0 (`0.X`), the same
  major from 1.0 (`X`). Trailing segments diverge freely. Today's band is `0.4`; the next release
  takes the group to `0.5`.
- Nothing in this plan publishes. `pnpm publish -r` is never run.
- `packageManager` is `pnpm@11.18.0`; the local pnpm may still be 11.17.0 until the first
  `pnpm install` on this branch.

---

### Task 1: The band check script

**Files:**
- Create: `scripts/check-versions.mjs`
- Test: `tests/integration/test/version-band.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a CLI, `node scripts/check-versions.mjs [packagesDir]`. Default `packagesDir` is
  `packages/` relative to the repo root. Exit 0 when every publishable manifest shares one band,
  exit 1 otherwise. On failure stderr names each package with its version and band.

The test lives in `tests/integration` because that is the repo's only vitest home outside
`packages/`, and CI runs it (`.github/workflows/build-test.yml`, `integration-tests-dir`). It drives
the script as a subprocess against temporary fixture directories, so it needs no types for the
`.mjs` file.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/test/version-band.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../../../scripts/check-versions.mjs', import.meta.url))

const created: Array<string> = []

function fixture(manifests: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-band-'))
  created.push(dir)
  for (const manifest of manifests) {
    const packageDir = join(dir, String(manifest.name).replace(/^@[^/]+\//, ''))
    mkdirSync(packageDir)
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
  }
  return dir
}

function run(dir: string) {
  return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('version band check', () => {
  test('passes when every publishable package shares a pre-1.0 minor', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '0.4.0' },
      { name: '@kumiai/two', version: '0.4.3' },
      { name: '@kumiai/three', version: '0.4.11' },
    ])
    const result = run(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0.4')
  })

  test('fails when one package is off the band, naming it', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '0.4.0' },
      { name: '@kumiai/stray', version: '0.1.0' },
      { name: '@kumiai/two', version: '0.4.3' },
    ])
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@kumiai/stray')
    expect(result.stderr).toContain('0.1.0')
  })

  test('ignores private packages', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '0.4.0' },
      { name: '@kumiai/tests', version: '9.9.9', private: true },
    ])
    expect(run(dir).status).toBe(0)
  })

  test('bands on the major from 1.0, so minors may diverge', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '1.2.0' },
      { name: '@kumiai/two', version: '1.5.3' },
    ])
    expect(run(dir).status).toBe(0)
  })

  test('fails when majors diverge from 1.0', () => {
    const dir = fixture([
      { name: '@kumiai/one', version: '1.5.3' },
      { name: '@kumiai/two', version: '2.0.0' },
    ])
    expect(run(dir).status).toBe(1)
  })

  test('fails when no publishable package is found', () => {
    const dir = fixture([{ name: '@kumiai/tests', version: '0.0.0', private: true }])
    expect(run(dir).status).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @kumiai/integration-tests exec vitest run test/version-band.test.ts`
Expected: all six FAIL — the script does not exist, so `spawnSync` exits non-zero with a
`Cannot find module` error on stderr, and the passing cases assert `status` 0.

- [ ] **Step 3: Write the script**

Create `scripts/check-versions.mjs`:

```js
#!/usr/bin/env node
// Every publishable package shares one version band: the minor while pre-1.0 (0.X), the major
// after (X). Trailing segments diverge freely — a single package's patch release churns nobody.
// Usage: node scripts/check-versions.mjs [packagesDir]
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function bandOf(version) {
  const [major, minor] = version.split('.')
  return major === '0' ? `0.${minor}` : major
}

function readPackages(packagesDir) {
  const packages = []
  for (const entry of readdirSync(packagesDir)) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, entry, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (manifest.private || !manifest.version) {
      continue
    }
    packages.push({
      name: manifest.name,
      version: manifest.version,
      band: bandOf(manifest.version),
    })
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name))
}

const packagesDir =
  process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'packages')
const packages = readPackages(packagesDir)

if (packages.length === 0) {
  console.error(`No publishable package found in ${packagesDir}`)
  process.exit(1)
}

const bands = [...new Set(packages.map((entry) => entry.band))]
if (bands.length > 1) {
  console.error(`Version band split across ${bands.length} bands: ${bands.join(', ')}`)
  for (const entry of packages) {
    console.error(`  ${entry.name} ${entry.version} (band ${entry.band})`)
  }
  process.exit(1)
}

console.log(`All ${packages.length} publishable packages on band ${bands[0]}.`)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @kumiai/integration-tests exec vitest run test/version-band.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Prove the check bites**

Change the `bands.length > 1` condition to `bands.length > 2` and re-run the test.
Expected: "fails when one package is off the band" and "fails when majors diverge from 1.0" FAIL.
Restore the condition and re-run — 6 passed. A guard that never fails when broken is not a guard.

- [ ] **Step 6: Confirm the real tree is currently off band**

Run: `node scripts/check-versions.mjs`
Expected: exit 1, listing `@kumiai/mls-hub 0.0.0 (band 0.0)` against ten packages on band `0.4`.
This is the defect Task 2 fixes — do not fix it here.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-versions.mjs tests/integration/test/version-band.test.ts
git commit -m "test: a version band split fails a check, and mls-hub splits it"
```

---

### Task 2: Bring the tree onto the band

**Files:**
- Modify: `packages/mls-hub/package.json` (version `0.0.0` → `0.4.0`)
- Modify: all eleven `packages/*/package.json` (add `publishConfig`)

**Interfaces:**
- Consumes: `scripts/check-versions.mjs` from Task 1.
- Produces: a tree where `node scripts/check-versions.mjs` exits 0 on band `0.4`, and every
  publishable manifest carries `"publishConfig": { "access": "public" }`.

`publishConfig` is not cosmetic. Changesets' `.changeset/config.json` supplied `"access": "public"`;
under `pnpm publish -r` a scoped package defaults to **restricted**, so `mls-hub`'s first publish
would fail without it. No package has one today.

- [ ] **Step 1: Set the `mls-hub` baseline**

In `packages/mls-hub/package.json`, change `"version": "0.0.0"` to `"version": "0.4.0"`. The band's
minor, trailing segment at zero because the package has had no patch releases.

- [ ] **Step 2: Add `publishConfig` to all eleven manifests**

To each of `packages/broadcast`, `hub-client`, `hub-conformance`, `hub-protocol`, `hub-server`,
`hub-tunnel`, `mls`, `mls-hub`, `mls-rpc`, `rpc`, `rpc-conformance` — add, after `"license": "MIT"`:

```json
  "publishConfig": {
    "access": "public"
  },
```

Biome's `useSortedPackageJson` assist decides final key order; run `rtk proxy pnpm run lint` after
and let it normalise placement rather than hand-placing.

- [ ] **Step 3: Verify all eleven got it**

Run:
```bash
node -e "for (const d of require('node:fs').readdirSync('packages')) { const p = require('./packages/'+d+'/package.json'); console.log(d, p.version, JSON.stringify(p.publishConfig)) }"
```
Expected: eleven lines, every one ending `{"access":"public"}`, `mls-hub` at `0.4.0`, no `undefined`.

- [ ] **Step 4: Run the band check**

Run: `node scripts/check-versions.mjs`
Expected: `All 11 publishable packages on band 0.4.`

- [ ] **Step 5: Lint**

Run: `rtk proxy pnpm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/*/package.json
git commit -m "chore: put mls-hub on the 0.4 band and every package's publish access in its manifest"
```

---

### Task 3: Migrate to pnpm native versioning

**Files:**
- Modify: `pnpm-workspace.yaml` (add `versioning:` block)
- Delete: `.changeset/config.json`
- Modify: `package.json` (scripts, devDependencies)
- Modify: `pnpm-lock.yaml` (by `pnpm install`)

**Interfaces:**
- Consumes: `scripts/check-versions.mjs` from Task 1.
- Produces: root scripts `check:versions`, `change`, `release`; no `changeset` or `version` script;
  no `@changesets/cli` dependency.

The 21 pending `.changeset/*.md` intent files stay untouched — pnpm reads the Changesets format.
Only `config.json` goes, because its settings move to `pnpm-workspace.yaml` or have no counterpart:
`updateInternalDependencies` (pnpm propagates to dependents natively, and internal deps are
`workspace:^`), `privatePackages` (pnpm already skips `private` packages), `access` (replaced by
`publishConfig` in Task 2), `fixed` / `linked` (both empty, and neither expresses the band).

- [ ] **Step 1: Add the `versioning:` block**

Append to `pnpm-workspace.yaml`, after the `catalog:` block:

```yaml
versioning:
  changelog:
    storage: repository
```

`repository` preserves today's behaviour — ten packages have a committed `CHANGELOG.md`, and the
default (`registry`) would orphan them. No `fixed` (it locks the trailing segment, which is the
churn the band exists to avoid) and no `epics` (it bands majors only, numerically:
`M*100 … M*100+99`).

- [ ] **Step 2: Delete the Changesets config**

Run: `git rm .changeset/config.json`

- [ ] **Step 3: Rewrite the root scripts and drop the dependency**

In `package.json`, replace the `scripts` and `devDependencies` blocks with:

```json
  "scripts": {
    "build": "pnpm run build:types && pnpm run build:js",
    "build:js": "turbo run build:js",
    "build:types": "turbo run build:types",
    "check:versions": "node scripts/check-versions.mjs",
    "format": "biome format --write .",
    "lint": "biome check --write ./packages ./scripts ./tests",
    "prepare": "git config core.hooksPath .githooks",
    "release": "pnpm run check:versions && pnpm run build && pnpm publish -r",
    "test": "pnpm run check:versions && turbo run test:types test:unit"
  },
  "devDependencies": {
    "@kigu/dev": "^0.2.0"
  },
```

Three things to get right:

- The `version` script is **removed**, not renamed. `version` is an npm lifecycle hook name, so
  leaving it would make `pnpm version -r` fire `changeset version` as a side effect.
- `lint` gains `./scripts` so the new `.mjs` file is covered.
- `release` runs the band check first, so a drifted band cannot reach the registry.

- [ ] **Step 4: Refresh the lockfile**

Run: `pnpm install`
Expected: `@changesets/cli` and its transitive dependencies removed from `pnpm-lock.yaml`. pnpm may
first download 11.18.0 to honour `packageManager`.

- [ ] **Step 5: Verify Changesets is gone and pnpm sees the intents**

Run:
```bash
pnpm exec changeset --version; echo "exit=$?"
pnpm change status
```
Expected: the first command fails (binary gone). `pnpm change status` lists the 21 pending intents
and the versions they imply — no error about a missing or unreadable config.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: the band check prints `All 11 publishable packages on band 0.4.` before Turbo runs, and
every package task passes. Turbo caches results — if the run reports `Cached: N, N total` with no
fresh work and you need certainty, re-run with `turbo run test:types test:unit --force` and confirm
`Cached: 0`.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml .changeset/config.json
git commit -m "chore: release management moves to pnpm, and the band gets a check that runs"
```

---

### Task 4: The group minor that keeps the band at 0.5

**Files:**
- Create: `.changeset/version-band-0-5.md`

**Interfaces:**
- Consumes: nothing.
- Produces: an intent naming all eleven publishable packages `minor`.

Without it the pending set breaks the band on the very first release under the new rule: packages
named `minor` by the existing 21 intents would go to 0.5.0 while patch-only packages stayed at
0.4.x. Raising the band is a group act, so every package takes the minor.

- [ ] **Step 1: Write the intent**

Create `.changeset/version-band-0-5.md`:

```markdown
---
'@kumiai/broadcast': minor
'@kumiai/hub-client': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-tunnel': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/mls': minor
'@kumiai/rpc-conformance': minor
'@kumiai/rpc': minor
---

The group moves to the 0.5 band. Every publishable package shares one meaningful version — the minor
while pre-1.0, the major after — so a matched band is a coherent set. Trailing segments still
diverge freely: a package taking a patch release on its own does not move anyone else.

`@kumiai/mls-hub` publishes for the first time in this release, at the band version alongside its
neighbours.
```

- [ ] **Step 2: Confirm pnpm reads it and where it lands everyone**

Run: `pnpm change status`
Expected: 22 pending intents, and every publishable package listed as going to `0.5.0` — including
`@kumiai/mls-hub` (from `0.4.0`) and `@kumiai/rpc` (from `0.4.3`). If any package shows a different
target, stop: the band assumption is wrong and Task 6 cannot fix it.

- [ ] **Step 3: Commit**

```bash
git add .changeset/version-band-0-5.md
git commit -m "chore: a group minor, so the 0.5 band lands whole"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/agents/development.md:9-20`
- Modify: `docs/agents/architecture.md:11`
- Modify: `docs/agents/plans/roadmap.md:14-20` and `:82-86`

**Interfaces:**
- Consumes: the rule and commands established in Tasks 1–4.
- Produces: no code. The two dangling links to the deleted `next/` item are repaired here.

`docs/agents/plans/next/2026-08-01-version-lock-and-mls-hub-first-release.md` was deleted when the
spec was written, and `roadmap.md` links it twice. Those links are broken right now.

- [ ] **Step 1: Rewrite the versioning claim in `development.md`**

Replace the line `Eleven packages, locked as a group while pre-1.0:` with:

```markdown
Eleven packages sharing one version band — the same minor while pre-1.0 (`0.X`), the same major from
1.0 (`X`). Trailing segments diverge freely, so a package taking a patch release on its own churns
nobody. Raising the band is a group act: every package takes that bump, in one release.
`pnpm run check:versions` enforces it, and runs as part of `pnpm test` and `pnpm release`.
```

Then replace the release paragraph (`Releases are manual: pnpm release (build, then changeset
publish). There is no publish workflow, here or anywhere else in the stack.`) with:

```markdown
Releases use pnpm's own release management (11.13+), not Changesets. Record intents as you work with
`pnpm change` — markdown files in `.changeset/`, the Changesets format. At release time
`pnpm version -r` consumes them: it bumps versions, propagates to dependents, writes each package's
`CHANGELOG.md`, and records what it consumed in the committed `.changeset/ledger.yaml`. Commit that,
then `pnpm release` (band check, build, `pnpm publish -r`).

Raising the band means the release's intents name every package at that level — see
`.changeset/version-band-0-5.md` for the shape.

Releases are manual. There is no publish workflow, here or anywhere else in the stack.
```

- [ ] **Step 2: Fix the "Locked group" wording in `architecture.md:11`**

Replace `Locked group` with `One version band` in that sentence, keeping the rest of the line as-is.

- [ ] **Step 3: Repair the roadmap**

In `docs/agents/plans/roadmap.md`, replace the paragraph beginning `Versions have drifted apart
despite the docs describing a locked group` with:

```markdown
Versions share one band — `rpc` 0.4.3, `mls-rpc` 0.4.2, eight packages at 0.4.1, and `mls-hub`
brought onto the band at 0.4.0. **22 pending intents** and nothing has shipped since the 0.4.x line;
the next release takes the whole group to 0.5.0, `mls-hub`'s first published version included.
Releases are manual by decision (2026-07-23), so that backlog is a choice rather than a stall.
```

Then replace numbered item 2 in the open-items list (the `**The version lock and mls-hub's first
release**` entry, including its link to the deleted `next/` file) with:

```markdown
2. **The version lock and `mls-hub`'s first release** — settled on
   `chore/pnpm-native-versioning`: the band is enforced by `pnpm run check:versions`, release
   management moved to pnpm's own, and `mls-hub` publishes at the band version.
```

- [ ] **Step 4: Confirm nothing still points at the deleted file or at Changesets as current tooling**

Run:
```bash
grep -rn "2026-08-01-version-lock" docs/ ; echo "exit=$?"
grep -rn "changeset publish\|@changesets/cli\|locked as a group\|Locked group" docs/ AGENTS.md README.md | grep -v "plans/completed\|plans/archive\|plans/backlog\|superpowers/"
```
Expected: the first grep finds nothing (exit 1). The second finds nothing. Historical records under
`completed/`, `archive/`, and `backlog/` are left alone — they describe what was true then.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: the band rule, the pnpm release procedure, and a roadmap that links something real"
```

---

### Task 6: Prove the release outcome in a throwaway worktree

**Files:** none modified in the repo. All work happens in a worktree that is discarded.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a verification record pasted into the task's commit message. No version bump, changelog,
  or ledger is committed on this branch.

Nothing in Tasks 1–5 is exercised until someone runs a release. This task runs one, throws it away,
and reports what it saw. **Do not run `pnpm publish -r` at any point.**

- [ ] **Step 1: Create the worktree**

```bash
git worktree add --detach /tmp/kumiai-version-dry-run chore/pnpm-native-versioning
cd /tmp/kumiai-version-dry-run
pnpm install
```

- [ ] **Step 2: Run the version bump**

Run: `pnpm version -r`
Expected: it reports the packages it bumped. If it errors, capture the exact message — that is the
finding, and Tasks 3–4 need revisiting rather than the error being worked around here.

- [ ] **Step 3: Assert all eleven landed at 0.5.0**

Run:
```bash
node -e "for (const d of require('node:fs').readdirSync('packages')) { const p = require('./packages/'+d+'/package.json'); console.log(p.name, p.version) }"
```
Expected: eleven lines, every version exactly `0.5.0`, `@kumiai/mls-hub` among them. A `0.1.0`
anywhere is a failed verification — report it rather than patching around it.

- [ ] **Step 4: Assert the ledger and changelogs**

Run:
```bash
ls .changeset/
ls packages/*/CHANGELOG.md | wc -l
head -20 packages/mls-hub/CHANGELOG.md
```
Expected: `.changeset/` holds `ledger.yaml` and no leftover intent `.md` files (all 22 consumed);
eleven `CHANGELOG.md` files, i.e. a newly created one for `mls-hub`; its head shows `0.5.0` and the
band summary text.

- [ ] **Step 5: Assert the band check passes on the bumped tree**

Run: `node scripts/check-versions.mjs`
Expected: `All 11 publishable packages on band 0.5.`

- [ ] **Step 6: Assert internal dependency ranges still resolve**

Run: `pnpm install && pnpm test`
Expected: install succeeds with the bumped versions and the suite passes. Internal deps are
`workspace:^`, so nothing should need rewriting — a failure here means dependent propagation did
something unexpected and must be reported.

- [ ] **Step 7: Discard the worktree**

```bash
cd /Users/paul/dev/yulsi/kumiai
git worktree remove --force /tmp/kumiai-version-dry-run
git worktree list
```
Expected: only the main worktree remains. Confirm `git status` in the repo is clean apart from
anything intended — the dry run must leave no trace.

- [ ] **Step 8: Record the outcome**

```bash
git commit --allow-empty -F - <<'EOF'
chore: a dry release proves the band lands whole at 0.5.0

Ran `pnpm version -r` in a throwaway worktree off this branch and discarded it.
Observed: <fill in — the eleven versions, the ledger, the mls-hub changelog,
the band check, the post-bump install and test run>.
Nothing was published.
EOF
```

Replace the placeholder with what was actually observed, including anything that did not match
expectations.

---

### Task 7: File the stack-wide migration in kigu

**Files:**
- Create: `/Users/paul/dev/yulsi/kigu/docs/agents/plans/backlog/2026-08-01-stack-pnpm-versioning.md`

**Interfaces:**
- Consumes: the outcome of Task 6.
- Produces: a backlog item in kigu. kigu has no `next/` directory — only `backlog/` and
  `completed/`.

- [ ] **Step 1: Write the backlog item**

```markdown
# Move the stack off Changesets to pnpm's native versioning

**Priority:** low — nothing is broken; kumiai is the pilot and has proven the shape.
**Origin:** kumiai `chore/pnpm-native-versioning`, 2026-08-01.

pnpm 11.13+ ships release management that reads the Changesets intent format, so `@changesets/cli`
buys nothing. kumiai migrated: `versioning:` block in `pnpm-workspace.yaml`, `.changeset/config.json`
deleted, `pnpm change` / `pnpm version -r` / `pnpm publish -r` replacing the Changesets commands.

Remaining repos, with their current Changesets config:

- `sozai` — `fixed: []`, `linked: []`
- `kokuin` — `fixed: []`, `linked: []`
- `enkaku` — `fixed: [["@enkaku/*"]]`, a real lock that `versioning.fixed` expresses directly

Two things bite in any migration and are worth copying rather than rediscovering:

- Changesets' `"access": "public"` has no pnpm counterpart. Scoped packages default to **restricted**
  under `pnpm publish -r`, so every publishable manifest needs
  `"publishConfig": { "access": "public" }` — it only shows up as a failure on a package's *first*
  publish.
- A root `version` script is an npm lifecycle hook name and fires during `pnpm version -r`. Remove
  it, do not rename it.

kumiai also added a version-band rule (`scripts/check-versions.mjs`) that pnpm cannot express — its
`fixed` locks the full version and `epics` bands majors numerically. That part is kumiai's choice,
not a stack requirement; `enkaku` genuinely wants `fixed`.

Take this up once a real kumiai release has gone out on the new tooling.
```

- [ ] **Step 2: Commit in the kigu repo**

```bash
cd /Users/paul/dev/yulsi/kigu
git add docs/agents/plans/backlog/2026-08-01-stack-pnpm-versioning.md
git commit -m "docs: file the stack-wide pnpm versioning migration, kumiai as the pilot"
cd /Users/paul/dev/yulsi/kumiai
```

If kigu's working tree is not clean or is on an unexpected branch, stop and report rather than
committing into someone else's in-flight work.

---

## Done when

- `node scripts/check-versions.mjs` exits 0 on band `0.4`, and fails when a package is off band.
- `pnpm test` runs the band check before the suite; `pnpm release` runs it before building.
- No `@changesets/cli` dependency, no `.changeset/config.json`, no `changeset` or `version` script.
- `@kumiai/mls-hub` is at `0.4.0` with `publishConfig.access: public`, as are the other ten.
- A dry `pnpm version -r` in a discarded worktree landed all eleven at `0.5.0`.
- The docs state the band rule and the pnpm procedure; no doc links the deleted `next/` file.
- kigu carries the stack-wide follow-up.
