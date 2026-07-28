# Provisioning tells a caller whether to retry

**Scope:** `@kumiai/mls-hub` only.
**Origin:** `docs/agents/plans/next/2026-07-27-hub-unreachable-provisioning-behaviour.md`, raised by
the final whole-branch review of `feat/ordinary-keypackage-pool`.

## The problem

Both of `mls-hub`'s entry points now open with a network call. `KeyPackagePool.ensureStocked()` leads
with `keyPackageStatus()` to learn the deficit (`pool.ts:123`); `LastResortProvisioner.ensureProvisioned()`
gained a `keyPackageStatus()` readback so it stops trusting its own `uploadedAt` (`provisioner.ts:164`).

`ensureProvisioned()` used to have a genuinely local steady state: healthy unexpired record, touch the
store, return. It no longer does. A transient hub outage turns a formerly all-local call into a throw,
and nothing pins or documents that in either direction.

## What an outage actually costs the user

Nothing, while it lasts. Every message path is a hub call, so a host with an unreachable hub can
neither send nor receive; and an inviter reaches key packages through `fetchKeyPackages` on that same
hub, so a top-up that fails during the outage denies nobody anything. Provisioning is only ever
preparation for a reachable hub.

All the damage is deferred, and it lands on someone else. If the outage passes and nothing retried,
the pool stays low and the next inviter silently falls back to the last-resort slot (a
forward-secrecy loss neither party sees), or the last-resort slot stays lost and the user is
unaddable — a failure that surfaces at the *inviter*, days later, with nothing on the affected user's
own device.

Against that, throwing has an immediate cost: a host that treats startup errors as fatal can no
longer open an app that otherwise works fully offline, blocked on a preparation step nobody could
have used. So the decision is not "loud versus silent" — it is which of two mechanisms carries which
kind of failure.

## The rule

Classify by what the caller must do, not by where the error came from.

- **Retryable** — retrying later can succeed and nothing needs changing. Returned as an error
  `Result`, never thrown.
- **Refused** — the hub has answered settled, and the app or its operator must change something for
  the call to ever succeed. Thrown.

This maps onto what each mechanism does by default. An unhandled throw is surfaced, which is right
for something that needs fixing. An unhandled retryable failure would be surfaced as a crash, which
is wrong for something whose correct response is "carry on, try again later" — and as a return value
that is exactly the behaviour a host gets for free.

The rule is not new here. `@kumiai/rpc` already draws it as `isPermanentSubscribeFailure`
(`packages/rpc/src/hub-mux.ts:255`): *"Permanent means the hub has ANSWERED, not that it failed…
anything else — a socket that dropped, a hub mid-restart — is assumed transient."* And
`hub-protocol/src/errors.ts:3` states the classifier this depends on: *"a transport failure carries
no hub code at all."*

### Which errors land where

| Error | Class | Why |
|---|---|---|
| No recognisable code (transport, socket drop, hub mid-restart) | retryable | The hub never answered. rpc's default, and its reasoning holds: retrying a real-permanent costs a bounded schedule, not retrying a real-transient costs a peer that never comes back. |
| `HUB_KEYPACKAGE_QUOTA` | retryable | A cap clears as packages are consumed or expire. rpc deliberately excludes quotas from permanent for the same reason (`hub-mux.ts:257`). |
| `HUB_AUTHORIZATION_DENIED` | refused | Documented as *"a settled answer, not a transient failure: the caller must not retry it as though the hub were unreachable"* (`hub-protocol/src/errors.ts:42`). |
| `HUB_INVALID_PAYLOAD` | refused | The hub could not decode what we sent. A bug in this package or its caller. |
| Enkaku `EK02` (access denied), `EK06` (message too large), `EK08` (invalid message) | refused | Each needs a change before the call can ever succeed — credentials, or a `target` that fits the wire schema. |
| Enkaku `EK03`, `EK04` (server limits), `EK05` (timeout), `EK01` (handler error) | retryable | Load or an unclassified server-side failure. |

### How the classifier actually identifies an error

Verified against a real hub over in-process transports: a hub error reaching the caller through
`HubClient` is an enkaku `RequestError` with `constructor.name` `RequestError`, `name` `'Error'`,
and `code` `'HUB_KEYPACKAGE_QUOTA'` — **not** an instance of `KeyPackageQuotaExceededError`.
`hub-client` is "a wrapper and nothing more"; nothing rebuilds the class, and no production code
calls `hubErrorFromCode`.

So the code string is the primary and only reliable signal:

1. `error.code`, when it is a string — the real-hub path.
2. `hubErrorCodeOf(error)` — a locally-thrown store error, or a double that throws the real class.
3. `error.name` against the hub error class names — a rebuilt error, or a host bundling two copies
   of `hub-protocol`, which breaks `instanceof` alone. rpc had to defend against exactly this
   (`hub-mux.ts:251-253`).

Identifying only by `instanceof` and `name` would class **every** real hub answer as retryable,
including `AuthorizationDenied` — the silent retry loop this whole rule exists to prevent.

`EK08` is reachable today rather than theoretical: the upload schema caps `keyPackages` at
`maxItems: 50` (`hub-protocol/src/protocol.ts:184`), and nothing validates `target` against it. A
pool configured with `target: 200` mints a full batch, fails the schema, and would repeat forever
if that classified as retryable.

Keeping quota retryable does not cause a mint loop: if the hub is genuinely at cap, the next
`keyPackageStatus()` reports a count at or above `lowWater` and no top-up is attempted.

## API

New dependencies: `@sozai/result` `^0.2.0` — a catalog entry and an `mls-hub` dep — and `@enkaku/protocol`
promoted from a devDependency to a dependency, for its `ErrorCodes` constants. `@sozai/result` is already
published and already used inside sozai (`packages/execution`). `AsyncResult` is thenable, so
`await pool.ensureStocked()` yields a `Result`, and reading `.value` on the error branch throws — a
host that ignores the union still cannot read a fabricated depth.

```ts
export class HubRetryableError extends Error {
  override name = 'HubRetryableError'
  /** Where it failed. `'status'`: nothing was attempted. `'upload'`: attempted, outcome unknown. */
  readonly stage: 'status' | 'upload'
  /** The wire code when the hub answered, null for a transport failure. A hub code or an enkaku one. */
  readonly code: string | null
  // `cause` carries the underlying error.
}

export class HubRefusedError extends Error {
  override name = 'HubRefusedError'
  readonly stage: 'status' | 'upload'
  readonly code: string
}
```

Signatures change to:

```ts
ensureStocked(): AsyncResult<{ minted: number; depth: number }, HubRetryableError>
ensureProvisioned(): AsyncResult<{ rotated: boolean; ref: string }, HubRetryableError>
```

The success types are untouched. That is the point of using a union rather than optional error
fields: `depth` has no honest value when the status read failed, and this way it never has to have
one.

```ts
const result = await pool.ensureStocked()
if (result.isError()) {
  // Deferred. Nothing to fix; the next call re-reads the hub and self-corrects.
}
```

`HubRefusedError` is thrown, so the type does not document it — the one real cost of splitting by
mechanism. It carries `code` and `stage` so a host that disagrees with our classification can catch
and downgrade deliberately.

## Behaviour per path

Divergence between store and hub only ever runs one way, and it is the safe way. Store-before-upload
(`pool.ts:97`, `provisioner.ts:114`) means the hub can never serve a package whose private half was
never written down. An upload failure can only leave the store holding private halves the hub does
not have — dead storage until pruned, not an outage.

**`ensureStocked`, status stage.** No deficit is computable without the hub — retained records are an
upper bound, since the hub consumes packages without telling the store. Prune (purely local), then
return the error.

**`ensureStocked`, upload stage.** Prune, then return the error with `stage: 'upload'`. The batch is
**not** retried, then or later:

- `storeKeyPackage` ends in `packages.push(...)` with no dedupe (`hub-server/src/memoryStore.ts:507`).
  Re-uploading a package that did land leaves the hub holding two copies of one init key, and
  `fetchKeyPackages` shifts them out to two different inviters — init-key reuse, the MLS violation
  the pool exists to prevent.
- Partial commit is real. The handler is `Promise.all(keyPackages.map(storeKeyPackage))` and each
  call charges the cap individually, so a batch crossing the cap stores some and rejects the rest
  (`hub-server/src/handlers.ts:604-612`). "The upload failed" can mean "17 of 20 landed."

Recovery is the next `ensureStocked()`: it reads the true count, which already includes whatever
landed, and mints a fresh deficit against it. The stranded local records must **not** be deleted —
if that upload did land, a Welcome can name them and the private half has to be there. They age out
at `notAfter` plus the grace like any other. This is README:16's existing "abandoned, not resumed"
rule, now stated as a failure-path guarantee.

**`ensureProvisioned`, status stage.** The readback is skipped, the local record is left as the
presumed-live one, and the error is returned. Prune still runs. No state is written that suppresses
a later check, so the next successful call performs the readback and repairs the slot if the hub
disagrees.

**`ensureProvisioned`, upload stage.** Return the error with `stage: 'upload'`. Retry here **is**
idempotent and does happen: the slot is one entry replaced in place
(`hub-server/src/handlers.ts:606`), the record keeps `uploadedAt: null`, and the next call resumes
that same package rather than minting (`provisioner.ts:147-155`). Whether the failed upload landed
does not matter — re-uploading the identical package converges either way.

Nothing is discarded when a later upload succeeds. The pool appends; a last-resort rotation replaces
the hub's slot but retains the older record locally until `notAfter` plus the grace, because an
inviter that fetched before the rotation still holds the old package.

**Pruning moves.** Today prune runs after a successful upload and is skipped when one throws. It
becomes unconditional: it is local, independent of the hub, and a caller that only ever hits
transient failures would otherwise never prune at all.

**Single-flight is preserved.** Both entry points share one in-flight run rather than starting a
competing one (`pool.ts:151`, `provisioner.ts:186`). Joining callers receive the same `Result`,
including the same error instance.

## What still throws

- Constructor validation of `target`, `lowWater`, `rotateWithinDays`, `retainAfterExpiryDays`. A
  programmer error, not a call outcome.
- `HubRefusedError`.
- Store failures (`store.put`, `store.list`, `store.delete`). Local, outside this classification, and
  unchanged. A store that cannot be written is not a hub problem.
- `bundles()` on a record that fails its round-trip contract, unchanged.

## Not in scope

`bundles()`, `release()`, and `processWelcomeFromSources` keep their current shapes. The
`sourceErrors`/`releaseError` fields on `ProcessWelcomeFromSourcesResult` stay as they are: they
report partial failure alongside a *successful* join, which is a different problem from "this call
could not complete", and converting them would ripple through the `BundleSource` port.

Adopting `Result` across the rest of kumiai is deliberately excluded. It would move 156 `throw new`
sites, both conformance suites, and every double behind them — and most of those throws are broken
invariants rather than outcomes a caller chooses between. `mls-hub` is the pilot; a separate spec
decides whether and where the pattern generalises, informed by what this costs. A `next/` item
records that question.

## Tests

Against the real in-process hub (`test/fixtures/hub.ts`) where the behaviour is observable there, and
against a `client` stand-in that throws a chosen error where the failure has to be injected. Per
`test-doubles-strictness-rule`, the stand-in may be stricter than `HubClient`, never more permissive.

Pin, for each entry point:

- Transport failure at the status stage returns an error `Result`, `stage: 'status'`, `code: null`.
- `KeyPackageQuotaExceededError` at the upload stage returns an error `Result`, not a throw.
- `AuthorizationDeniedError` throws `HubRefusedError` carrying the code and stage.
- A refusal arriving from the **real hub** — as a `RequestError` whose `code` is
  `HUB_AUTHORIZATION_DENIED`, matching neither the class nor the name — throws `HubRefusedError`.
  This is the path a host actually hits; classifying it by `instanceof` alone silently retries
  forever.
- An oversized batch (`target` above the schema's `maxItems: 50`) throws `HubRefusedError` with
  code `EK08`, rather than re-minting the batch on every call.
- A hub error arriving with the right `name` but a foreign class classifies identically to the real
  class — the double-bundling guard.
- Prune runs on every failure path, including both status and upload stages.
- Concurrent callers during a failing run share one `Result` and one error instance.

And per entry point specifically:

- Pool: after a transient upload failure, the next `ensureStocked()` mints against the hub's reported
  count and does **not** re-upload the stranded batch; the stranded records survive in the store.
- Last-resort: after a transient upload failure, the next `ensureProvisioned()` resumes the same
  `ref` rather than minting a new package.
- Last-resort: a status failure leaves the local record intact and the next successful call performs
  the readback and repairs a hub whose slot disagrees.

## Documentation

- README: the two entry points' return shape, the retryable/refused split with the error classes, and
  the explicit statement that a host must call on a cadence rather than only at startup — the
  self-healing behaviour depends on it.
- A changeset. Both entry points change their return type; pre-1.0, so no deprecation path.
- A `docs/agents/plans/next/` item for the stack-wide `Result` adoption question, so the decision to
  scope it out here is recorded rather than lost.
