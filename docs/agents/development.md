# Development

Shared build, test, and release workflow lives in the kigu `development` skill,
auto-loaded via the kigu plugin. See it for the pnpm / Turbo / SWC / Biome / Vitest
workflow and the `docs/agents/plans/` lifecycle.

## Repo-specific

Ten packages, locked as a group while pre-1.0:

- **Core** — `mls`, `broadcast`, `rpc`
- **Hub subsystem** — `hub-protocol`, `hub-client`, `hub-server`, `hub-tunnel`
- **Port implementation** — `mls-rpc`, the real implementation of rpc's consumer ports over a live
  MLS handle
- **Contract suites** — `rpc-conformance`, `hub-conformance`. Both run against every implementation
  AND every double; changing a port means running them against both sides, not just the real one.

Releases are manual: `pnpm release` (build, then `changeset publish`). There is no publish workflow,
here or anywhere else in the stack.
