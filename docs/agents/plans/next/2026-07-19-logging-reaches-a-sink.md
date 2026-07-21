# A configured logger is not the same as a logger that carries these

## The gap

`hub-mux` reports two conditions a host may have wired no handler for — a refused subscription and
a push lane that ended — through `@sozai/log` at `error` on category `['kumiai', 'rpc']`, falling
back to `console.error` when `isSetup()` says logging is not configured at all.

That covers the two ends. It does not cover the middle, which is the likely case in a real app:
**logging IS configured, and the configuration does not route `['kumiai']`.**

`@sozai/log`'s own `getDefaultConfig()` is exactly such a configuration. Its `loggers` cover
`['logtape', 'meta']` and `['sozai']`, and nothing else. An app that calls `setup()` with no
argument — the documented easy path — configures logging, so `isSetup()` returns true, so the
console fallback stays out of the way, and the record is then dropped for want of a matching
logger. The peer goes silently deaf, which is the precise failure the fallback was added to
remove, reachable through the most ordinary setup an app can perform.

## Why it is filed rather than fixed

Every fix is a judgement call that belongs to whoever owns the logging story across these repos,
not to `hub-mux`:

- **Ask logtape whether a record would be emitted.** Cleanest if the API allows it — it makes the
  fallback exact rather than approximate. Needs a look at what `@logtape/logtape` exposes; if
  there is no supported way to ask, do not reach into its internals for one.
- **Have `@sozai/log`'s default config carry a root sink**, so any category reaches the console
  unless an app deliberately narrows it. Changes behaviour for every consumer of that package, so
  it is a `sozai` decision.
- **Log under `['sozai', 'kumiai', ...]`** so the default config's `['sozai']` logger picks it up.
  Cheapest, and dishonest: this is not a `sozai` package, and a category that lies to get itself
  routed will mislead whoever reads the logs.
- **Document it and require apps to add a `['kumiai']` logger.** Honest, and the weakest — it
  fails exactly for the app that did not read the docs, which is the same app that wired no
  handler.

## How to tell it is fixed

An app that calls `setup()` with no argument, wires no `onReceiveEnded`, and loses its push lane
must end up with something a human can find. Assert it against the real `getDefaultConfig()`
rather than a bespoke test config — a test that configures its own sink proves only that the
logger works when someone has already thought about it, which is not the failing case.

## Related

- `packages/rpc/src/hub-mux.ts` — `report`, `warnSubscribeFailed`, `warnReceiveEnded`.
- `packages/rpc/test/hub-mux-receive-ended.test.ts` — covers both ends (configured with a sink
  that matches, and not configured at all); neither covers the middle.
