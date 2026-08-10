# kumiai

> **For AI agents:** 組合 ("union / cooperative") — the MLS group-messaging layer.
> E2EE group identity + membership (MLS), broadcast fan-out, hub subsystem, and
> group RPC. Depends downward on `@sozai`, `@kokuin`, and `@enkaku` (RPC); the
> top of the stack — no internal consumers.

## What this repo is

The MLS / group stack: `mls` (E2EE identity + membership crypto core), `broadcast`
(generic fan-out), `hub-protocol`/`hub-client`/`hub-server`/`hub-tunnel`/`hub-wake` (the hub
subsystem), `rpc` (group RPC), `mls-rpc` (the real implementation of rpc's consumer
ports over `mls`), `mls-hub` (key-package provisioning between `mls` and a hub), and the contract
suites `rpc-conformance` and `hub-conformance`
(every implementation AND every double must pass them). Young and tightly coupled — twelve
packages share one version band (same minor pre-1.0, same major from 1.0); raising it is a group
act, but a patch release within the band is not.

## Guardrails

See the `kigu:conventions` skill — canonical, do not restate here. Repo-specific only:

- pnpm only.
- Do not edit generated files (`lib/`).
- Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) go through the workspace catalog as
  published `^` ranges, never `workspace:`. Internal `@kumiai/*` deps are `workspace:^`.
- Changing a port means running **both** contract suites against the real implementation and the
  doubles — see `docs/agents/architecture.md`.

## Toolchain

All dev tooling and shared configs come from `@kigu/dev`. Extend
`@kigu/dev/tsconfig.json`, `["@kigu/dev/biome.json"]`, and `@kigu/dev/swc.json`.

See `../kigu/docs/repo-split-design.md` for the broader monorepo-split architecture.
