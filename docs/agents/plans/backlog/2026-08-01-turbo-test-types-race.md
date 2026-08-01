# `test:types` races its own `build:types` for leaf packages

**Priority:** medium — an intermittent CI failure, not a design question. Surfaced 2026-08-01 by a
dry release rehearsal for `chore/pnpm-native-versioning`; unrelated to that branch and reproduces on
`main` with caches cleared.

`turbo.json`'s `test:types` task declares:

```json
"test:types": {
  "dependsOn": ["^build:types"]
}
```

The `^` means "upstream workspace dependencies' `build:types`" only — nothing orders a package's own
`test:types` after its own `build:types`. A package with at least one internal `@kumiai/*` dependency
gets ordering for free, transitively, because Turbo still has to build that dependency's types before
it can build the package's own. A package with none does not: `@kumiai/mls` has no `@kumiai/*`
dependencies (only external catalog deps — `@kokuin/token`, `@sozai/codec`, `@sozai/runtime`,
`ts-mls`, the `@noble/*` libs), so nothing schedules its `build:types` before its `test:types`. On a
cold cache, Turbo is free to run them in either order or in parallel, and `@kumiai/mls`'s `test:types`
intermittently fails as a result.

**Worth checking, not asserted.** `test:unit` has the same shape:

```json
"test:unit": {
  "dependsOn": ["^build:js", "^build:types"]
}
```

Same missing self-edge, same leaf-package exposure. Only `test:types` was observed failing here —
`test:unit` was not independently reproduced — so treat it as a lead to check, not a confirmed second
instance.

**What a fix looks like.** Add the package's own `build:types` to `dependsOn`: `test:types` becomes
`["^build:types", "build:types"]`, and if `test:unit` turns out to share the flaw, the same edge
joins its list alongside the existing `^build:js`/`^build:types` pair.
