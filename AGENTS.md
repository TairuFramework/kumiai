# kumiai

> **For AI agents:** 組合 ("union / cooperative") — the MLS group-messaging layer.
> E2EE group identity + membership (MLS), broadcast fan-out, hub subsystem, and
> group RPC. Depends downward on `@sozai`, `@kokuin`, and `@enkaku` (RPC); the
> top of the stack — no internal consumers.

## What this repo is

The MLS / group stack: `mls` (E2EE identity + membership crypto core), `broadcast`
(generic fan-out), `hub-protocol`/`hub-client`/`hub-server`/`hub-tunnel` (the hub
subsystem), and `rpc` (group RPC). Young and tightly coupled — pre-1.0, the whole
group moves together. Cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) are
published `^` ranges, never `workspace:`.

## Conventions

Follow the `conventions` skill from the `kigu` marketplace (the canonical source of
truth). pnpm only. `type` not `interface`; `Array<T>` not `T[]`; never `any`; capital
`ID`/`HTTP`/`JWT`/`DID`; ES `#fields`, never `private`/`readonly`. Do not edit
generated files (`lib/`).

## Toolchain

All dev tooling and shared configs come from `@kigu/dev`. Extend
`@kigu/dev/tsconfig.json`, `["@kigu/dev/biome.json"]`, and `@kigu/dev/swc.json`.

See `../kigu/docs/repo-split-design.md` for the broader monorepo-split architecture.
