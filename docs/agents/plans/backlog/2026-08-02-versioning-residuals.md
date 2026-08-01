# Residuals from the pnpm versioning migration

**Priority:** low — none is a defect today; the first cannot be settled without a real release.
**Origin:** the whole-branch review of `chore/pnpm-native-versioning`, 2026-08-02. Background:
`../completed/2026-08-02-pnpm-native-versioning.complete.md`.

## 1. `prepublishOnly` runs the build a second time, possibly concurrently

`pnpm release` is `check:versions && build && pnpm publish -r`. The build is a Turbo run across the
workspace; `pnpm publish -r` then fires each package's own `prepublishOnly`
(`del lib && swc && tsc`) again, package by package.

Two things follow. The redundant rebuild is wasted work. Worse, if pnpm publishes packages
concurrently, one package's `del lib` can run while a dependent's `tsc --emitDeclarationOnly` is
reading those declarations — a race that would surface as a spurious type error mid-publish.

Neither is a regression: `changeset publish` fired the same hook the same way. And neither is
observable without a real publish, which is why the migration branch could not settle it. Watch the
first release on the new tooling; if it is clean, this reduces to the wasted rebuild, and the fix is
either dropping `prepublishOnly` (the `release` script already builds) or dropping the build from
`release` (and letting the hook own it).

## 2. Two check-script polish items

Both in `scripts/check-versions.mjs` and its tests, neither affecting what the check catches:

- A malformed `package.json` now fails loudly, but as an uncaught Node exception with a stack trace,
  while the script's two other failure paths use `console.error` + `process.exit(1)`. The directory
  name is in the message either way. Cosmetic inconsistency in a developer-facing script.
- Two cases in `tests/integration/test/version-band.test.ts` ("bands on the major from 1.0" and "no
  publishable package") assert exit status without checking stderr content. Both were verified to
  bite for their own mutations, and the file as a whole cannot pass with the script absent, so the
  residual risk is narrow — adding `expect(result.stderr).toContain(...)` to each is a two-line
  improvement, not a gap.

## 3. The count in the docs is not the count the check enforces

`docs/agents/development.md` says "Eleven packages sharing one version band". The check enforces
"every publishable package shares one band" and derives the count. A package that gained
`private: true`, or lost its `version` field, would pass at ten with the sentence still reading
eleven. Hardcoding the number would be brittle; the gap is worth knowing about rather than closing.
