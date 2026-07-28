# Errors reach a sink

**Closes:** `docs/agents/plans/next/2026-07-19-logging-reaches-a-sink.md`, both halves.

## The problem

Two packages notice something is wrong, correctly decline to fail the request, and then have
nowhere to say so.

**`@kumiai/rpc` reports into a logger that may carry nothing.** `hub-mux` reports a refused
subscription and an ended push lane through `@sozai/log` at `error` on `['kumiai', 'rpc']`, falling
back to `console.error` when `isSetup()` is false. That covers both ends and misses the middle,
which is the likely case in a real app: **logging IS configured, and the configuration does not
route `['kumiai']`.** `@sozai/log`'s own `getDefaultConfig()` is exactly such a configuration — its
loggers cover `['logtape', 'meta']` and `['sozai']`, nothing else. An app calling `setup()` with no
argument takes the documented easy path, `isSetup()` returns true, the console fallback stays out of
the way, and the record is dropped for want of a matching logger.

Verified against the real config on 2026-07-28:

| config | `getLogger(['kumiai','rpc']).error(...)` |
|---|---|
| current `getDefaultConfig()` | **dropped** |
| plus a root logger | **emitted** |

**`@kumiai/hub-server` has no error sink at all.** `createHandlers` takes no logger and no hook, and
the module contains no `logger` or `console` reference. Three store failures are swallowed with
nowhere to go:

- `handlers.ts:707-712` — the last-resort top-up read fails *after* `fetchKeyPackages` already
  consumed packages destructively. Surfacing it would destroy packages nobody received, so it is
  correctly swallowed and the request returns 200 with a short batch. A permanently broken slot read
  — a store that never implemented `fetchLastResortKeyPackage`, a dropped column, a failing
  connection — returns 200 forever. The availability floor the last-resort feature exists to provide
  is silently absent, and the operator's only clue is joins failing downstream at the inviter.
- `handlers.ts:541-545` — a `store.ack` failure inside `while (true)`. Correctly does not break: the
  frame stays pending and the client re-acks. A store whose ack never works redelivers every frame
  forever, silently.
- `hub.ts:92` — `store.purge(...).catch(() => {})` on the timer. Correctly non-fatal and retried,
  and a store that can never purge grows without bound with no signal.

The sibling swallow at `handlers.ts:670-684` is **not** in scope: that path already carries its read
failure out as `cause` on the refusal it throws. It is the one site that already has a channel.

## Shape

Two parts, in two repos, in order.

**Part A — `@sozai/log`.** A root logger in `getDefaultConfig()`, and `getReporter` as the one
mechanism. Additive; together a `minor`, `0.2.0` → `0.3.0`.

**Part B — `@kumiai/rpc` and `@kumiai/hub-server`.** Catalog bump, rpc adopts the shared reporter,
hub-server gains an `onStoreError` hook wired at the three sites.

**The sequencing is a hard constraint.** Cross-repo deps go through the workspace catalog as
published `^` ranges, never `workspace:`, so Part B cannot land until sozai has published 0.3.0. The
kumiai branch is unmergeable in between.

### Why the reporter lives in `@sozai/log`

`@sozai/log` owns `setup()` and `isSetup()`, so it owns the question "what happens when nobody
configured anything". A reporter that lives next to the config it depends on cannot drift from it —
and drift is what produced this document: rpc hand-rolled the same six lines twice.

Recorded honestly: **kumiai is the only repo in the stack that imports `isSetup()`** (checked across
kigu, sozai, kokuin, enkaku, tejika, mokei, kubun on 2026-07-28). `getReporter` has two consumers on
day one, both in kumiai. The argument for sozai is ownership and future consumers, not present
reuse.

### Why not the alternatives

The filed document listed four options. Two are now closed by evidence:

- **"Ask logtape whether a record would be emitted"** — not available. `Logger` exposes no such
  query. Deriving it from `getConfig()` means re-implementing logtape's category-prefix and
  `parentSinks` resolution in userland, which can drift from the real behaviour it is imitating.
- **"Log under `['sozai', 'kumiai', ...]`"** — retired. It was already noted as dishonest, and the
  root sink makes it unnecessary.

## Part A — `@sozai/log`

### The root logger

```ts
export function getDefaultConfig(options?: ConsoleSinkOptions): Config<'console', never> {
  return {
    sinks: { console: getConsoleSink(options) },
    loggers: [
      // Any category reaches the console at error unless an app deliberately narrows it.
      // Without this, a package logging under its own category is dropped by the very config
      // that made isSetup() answer true.
      { category: [], lowestLevel: 'error', sinks: ['console'] },
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: ['console'] },
      { category: ['sozai'], lowestLevel: 'error', sinks: ['console'] },
    ],
  }
}
```

`parentSinks` already defaults to `"inherit"`, so this propagates by logtape's own resolution rather
than around it. Probed 2026-07-28: `info` and `warn` under a non-sozai category stay dropped, and an
app that narrows `['kumiai']` with `parentSinks: 'override'` still wins.

**A named consequence.** This is a behaviour change for every consumer of the default config, not
only kumiai. Any dependency logging to logtape under any category now prints its errors. That is the
intent, and it means an app that was quiet becomes less quiet for a reason that will not be obvious
to whoever sees it. Bounded to `error`, and overridable.

### The reporter

```ts
export type Reporter = (message: string, error?: unknown) => void

/**
 * An error reporter that always lands somewhere. Records go to the logger for `category`; if
 * nothing has been configured at all, they go to the console tagged with `packageName`.
 *
 * `error` level only, deliberately: this is for conditions a host may have wired no handler for,
 * where the alternative is silence.
 */
export function getReporter(
  category: string | Array<string> | ReadonlyArray<string>,
  packageName: string,
): Reporter
```

Behaviour is rpc's existing `report` with one fix: `error` is optional, and when omitted the console
branch does not pass it, so nothing prints a bare `undefined`. rpc's second copy (`warnDropped`)
already takes a message alone, so both call sites are covered by one signature.

The `isSetup()` branch stays and is now honest rather than approximate. With the root sink,
"configured" means "reaches somewhere" unless the app opted out; `!isSetup()` still means logtape
drops everything, so the console is genuinely the last resort. This is why the two changes ship
together — the reporter without the root sink is the same hole under a new name.

## Part B — kumiai

1. Catalog: `'@sozai/log': ^0.3.0` in `pnpm-workspace.yaml`.
2. `@kumiai/rpc` replaces its two hand-rolled copies with
   `getReporter(['kumiai', 'rpc'], '@kumiai/rpc')` — `report` in `src/hub-mux.ts`, which takes an
   error, and `warnDropped` in `src/handlers.ts`, which takes only a message. That second call site
   is why `error` is optional on `Reporter` rather than required. The swap itself changes no
   behaviour; the root sink underneath does.
3. `@kumiai/hub-server` adds `@sozai/log` as a dependency (it has none today) and the surface below.

### The hub-server surface

```ts
/** A HubStore operation that failed where the hub deliberately did not fail the request. */
export type HubStoreErrorEvent = {
  /** The HubStore method that threw. The operator's fix is to make this method work. */
  method: 'fetchLastResortKeyPackage' | 'ack' | 'purge'
  /** The DID the operation was for, where it names one. Absent for `purge`. */
  did?: string
  error: unknown
}

export type HubStoreErrorHook = (event: HubStoreErrorEvent) => void
```

`method` names the port's own vocabulary rather than an invented operation enum: it stays true as
handlers move, and it is the thing an operator acts on.

Added as `onStoreError?: HubStoreErrorHook` to `CreateHandlersParams` and `CreateHubParams`.
`createHub` forwards it to `createHandlers` and uses it for the purge timer. Fire-and-forget: a
throw from the hook is swallowed, matching `onSubscribeFailed`. Unwired, the event goes to
`getReporter(['kumiai', 'hub-server'], '@kumiai/hub-server')`.

Both types are exported from `packages/hub-server/src/index.ts`.

### Call sites — control flow does not change

| site | `method` | `did` | what must stay true |
|---|---|---|---|
| `handlers.ts:707-712` | `fetchLastResortKeyPackage` | `targetDID` | still returns 200 with the short batch |
| `handlers.ts:541-545` | `ack` | `clientDID` | still does not break; the frame stays pending |
| `hub.ts:92` | `purge` | — | still non-fatal, still retried next interval |

Every one of these swallows is correct and stays. The only change is that the failure has somewhere
to go.

**No throttling, deliberately.** A permanently broken store emits per request — an ack failure on a
live receive channel could fire every few seconds. logtape ships `getThrottlingFilter`, so rate
control belongs in the app's sink config where an operator can tune it, not hard-coded in the hub. A
host wanting different behaviour wires `onStoreError`.

## Testing

### `@sozai/log`

The existing `getDefaultConfig` test asserts the `loggers` array literally and changes. That
structural assertion is not what proves the fix — it would pass against a root logger wired to no
sink. The behavioural tests run against the **real `getDefaultConfig()`** with an injected `console`,
never a bespoke sink, per the filed document's own criterion:

- a non-sozai category (`['kumiai', 'rpc']`) at `error` reaches the console
- the same category at `info` and `warn` does not — bounds the blast radius
- an app narrowing `['kumiai']` with `parentSinks: 'override'` still wins

`getReporter`: configured produces a record with the right category, level `error`, and the error in
properties; after `reset()` it calls `console.error` with the `[packageName]` prefix; with `error`
omitted the console branch prints no trailing `undefined`.

### `@kumiai/rpc`

`test/hub-mux-receive-ended.test.ts` covers both ends and neither covers the middle, which is the
filed defect. Add it: default `setup()`, no `onReceiveEnded`, lane ends, assert a human-findable
record. **This test fails before Part A and is written first, watched fail, and only then made to
pass.**

### `@kumiai/hub-server`

A fault-injection wrapper over `createMemoryStore` that throws from one method. It is test-local and
is **not** a `HubStore` implementation handed to `hub-conformance` — a fault injector, not a laxer
double.

Per site, two assertions that must both hold:

1. the hook fires with the right `method` and `did`
2. behaviour is unchanged — the top-up still returns 200 with the short batch, the ack loop still
   processes the next ack after a failed one, the purge still runs on the next interval

The second catches a "fix" that started failing requests, which for the top-up site would destroy
key packages nobody received. Plus one unwired-hook test asserting the reporter path.

### Mutation checks

Required on every site, and stated per site rather than per suite: delete the `onStoreError` call
and confirm **exactly one test fails — the right one**, not merely that the suite goes red. Same for
the root logger entry in `getDefaultConfig()`.

This is not ceremony. On 2026-07-28 the app-lane retention guard survived deletion with the whole
rpc suite green; the test existed, forged exactly the right frame, and passed for a reason forty
lines upstream of what it claimed to check. A suite that goes red proves something failed, not that
the right thing is covered.

## Out of scope

- `handlers.ts:425,445` — channel teardown and writer failures. Client connectivity, not store
  faults; a client walking away is normal, and folding it in would make the hook noisy and its
  meaning fuzzy.
- `handlers.ts:670-684` — already carries its read failure as `cause`.
- Throttling or deduplication of repeated events (see above).
- Any change to what the three sites return or how they recover.

## Acceptance criteria

- An app that calls `setup()` with no argument, wires no `onReceiveEnded`, and loses its push lane
  ends up with something a human can find — asserted against the real `getDefaultConfig()`.
- An app that calls `setup()` with no argument, wires no `onStoreError`, and runs a store whose
  `fetchLastResortKeyPackage` always throws sees the failure, while key-package fetches keep
  returning what the pool can serve.
- `@sozai/log` publishes 0.3.0 before the kumiai catalog bump lands.
- Both contract suites (`rpc-conformance`, `hub-conformance`) pass unchanged: no port changed.
- Each mutation check fails exactly the test written for it.
