# Development

Shared build, test, and release workflow lives in the kigu `development` skill,
auto-loaded via the kigu plugin. See it for the pnpm / Turbo / SWC / Biome / Vitest
workflow and the `docs/agents/plans/` lifecycle.

## Repo-specific

Eleven packages sharing one version band — the same minor while pre-1.0 (`0.X`), the same major from
1.0 (`X`). Trailing segments diverge freely, so a package taking a patch release on its own churns
nobody. Raising the band is a group act: every package takes that bump, in one release.
`pnpm run check:versions` enforces it, and runs as part of `pnpm test` and `pnpm release`.

- **Core** — `mls`, `broadcast`, `rpc`
- **Hub subsystem** — `hub-protocol`, `hub-client`, `hub-server`, `hub-tunnel`
- **Port implementation** — `mls-rpc`, the real implementation of rpc's consumer ports over a live
  MLS handle
- **Provisioning** — `mls-hub`, which owns when a peer's key packages are generated, uploaded,
  retained, and pruned between `mls` and a hub
- **Contract suites** — `rpc-conformance`, `hub-conformance`. Both run against every implementation
  AND every double; changing a port means running them against both sides, not just the real one.

Releases use pnpm's own release management (11.13+), not Changesets. Record intents as you work with
`pnpm change` — markdown files in `.changeset/`, the Changesets format. At release time
`pnpm version -r` consumes them: it bumps versions, propagates to dependents, writes each package's
`CHANGELOG.md`, and records what it consumed in the committed `.changeset/ledger.yaml`. Commit that,
then `pnpm release` (band check, build, `pnpm publish -r`).

Raising the band means the release's intents name every package at that level — see
`.changeset/version-band-0-5.md` for the shape.

One exception needs a hand. pnpm publishes a package that has never been released at the version
written in its manifest, verbatim — no intent bumps it. So after `pnpm version -r`, set any
first-time package's version to the band the rest of the group just landed on, and commit that with
the bump. `pnpm run check:versions` fails if you forget, which is the point.

Releases are manual. There is no publish workflow, here or anywhere else in the stack.
