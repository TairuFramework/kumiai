# Probe brief — the doubles the suites actually run against are checked by nothing

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.**

## The defect

`@kumiai/hub-conformance` is applied to exactly one implementation
(`packages/hub-server/test/conformance.test.ts`). The hub doubles the rpc and tunnel suites actually run
against are checked by **nothing**.

That is the structural root cause behind two separate production defects found this session — a
swallowed subscribe refusal that silently stalls a peer forever, and cross-group isolation resting on a
throw no test could observe. Both were doubles answering where the real thing refuses. Read
`docs/superpowers/probes/doubles-audit.md` and
`docs/agents/plans/next/2026-07-18-conformance-suite-runs-against-one-implementation.md` first.

The known blocker: the suite takes a `HubStore`, the doubles are `LogHub`s, and bridging needs an
adapter that would implement the very semantics under test.

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

**Extract the behavioural contract that can be checked at the `LogHub` seam, and run every double
against it.** Not the whole `HubStore` suite — the part a `LogHub` can answer for. Start from what the
audit found doubles getting wrong, because those are the properties with a demonstrated cost:

- **A retention above the ceiling is refused, never clamped** (`hub-tunnel/src/transport.ts:77-81`,
  `memoryStore.ts:391-397`).
- **A publish is not echoed to its sender** (`memoryStore.ts:190-197`) — `createMemoryBus`
  (`packages/broadcast/src/bus.ts:11-25`) violates this, and any component whose correctness turns on
  receiving its own publish passes on the bus and delivers nothing in production.
- **sequenceIDs order correctly as strings** — zero-padded, so `>` does not break at the 9→10 boundary
  (`memoryStore.ts:54`).
- **A log-class topic trims** once depth is exceeded (`memoryStore.ts:236-247`). The rpc doubles retain
  unconditionally and expose `trim()` as a manual control only, so no test meets a cursor below `oldest`
  unless it remembers to arrange one.

Then apply it to: `packages/rpc/test/fixtures/fake-hub.ts`, `packages/rpc/test/fixtures/durable-fake-hub.ts`,
`packages/hub-tunnel/test/fixtures/fake-hub.ts`, `createMemoryBus`, and the real `memoryStore`.

**Expect this to redden things, and treat every red as a finding to report, not to retune.** A double
failing the contract is the point. If fixing a double reddens a test that depended on its leniency, that
test was green for the wrong reason — report it with what it was actually asserting.

If a property genuinely cannot be expressed at the `LogHub` seam, say which and why rather than forcing
it. A smaller suite that every double passes honestly beats a larger one with exemptions.

## Done when (all required)

1. **A shared contract suite exists** and runs against every double named above plus the real store.
2. **Each property above is covered**, or explicitly documented as not expressible at this seam.
3. **Every double passes it** — by being fixed, not by the suite being weakened.
4. **Mutation check (required, paste it):** make one double lenient again in one property → its
   conformance test goes red. Invert by hand.
5. Whole suite green (30/30 turbo, integration 23/23). Do not weaken an existing test to make this pass.

## Scope boundary

`packages/hub-conformance/`, `packages/hub-server/`, `packages/hub-tunnel/`, `packages/broadcast/`, and
the **hub doubles** under `packages/rpc/test/fixtures/` (`fake-hub.ts`, `durable-fake-hub.ts`) ONLY.

**Do NOT touch** `packages/rpc/src/**` (another probe is working `peer.ts` and the app lane
concurrently), `packages/mls/**`, or any rpc fixture other than the two hub doubles. If fixing a double
requires an rpc `src` change, STOP and report it rather than making it.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`.

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`

## Report contract

Full report → `docs/superpowers/probes/conformance-report.md` (which properties made it in, which could
not and why, every test that reddened and what it was really asserting, the mutation pasted). Return
ONLY: status, uncommitted-changes note, one-line test summary, concerns. No full diff.
