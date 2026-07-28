# Provisioning tells a caller whether to retry

**Status:** complete. Landed on `feat/provisioning-retryable-result`, 2026-07-28.
**Scope:** `@kumiai/mls-hub` only.
**Origin:** raised by the final whole-branch review of `feat/ordinary-keypackage-pool`; see
`docs/agents/plans/completed/2026-07-27-ordinary-keypackage-pool.complete.md`.

## What this closed

Both of `mls-hub`'s entry points had come to open with a network call — `ensureStocked()` leads with
`keyPackageStatus()` to learn the deficit, and `ensureProvisioned()` gained a `keyPackageStatus()`
readback so it stops trusting its own `uploadedAt`. That turned `ensureProvisioned()` from a call
with a genuinely local steady state into one that throws on a transient hub outage, and nothing
pinned or documented the new failure mode in either direction.

`ensureStocked()` and `ensureProvisioned()` now return `AsyncResult<T, HubRetryableError>` from
`@sozai/result`. A settled refusal throws `HubRefusedError` instead. Success types are unchanged.

## Why the split is by mechanism

Classification is by what the caller must do, not by where the error came from:

- **Retryable** — retrying later can succeed and nothing needs changing. Returned as an error
  `Result`, never thrown.
- **Refused** — the hub has answered settled; the app or its operator must change something.
  Thrown.

That maps onto what each mechanism does when unhandled. An unhandled throw is surfaced, which is
right for something that needs fixing. An unhandled retryable failure surfaced as a crash is wrong
for something whose correct response is "carry on, try later" — and as a return value that is the
behaviour a host gets for free.

The reasoning behind tolerating a degraded return at all: an unreachable hub costs the user nothing
while it lasts. Every message path is a hub call, and an inviter fetches key packages through the
same hub, so a top-up that fails during an outage denies nobody anything. All the damage is
deferred and lands on someone else — a low pool means the next inviter silently falls back to the
last-resort slot, and a lost last-resort slot means the user is unaddable, a failure that surfaces
at the *inviter* days later with nothing on the affected user's own device. Against that, throwing
would block a host from opening an app that otherwise works fully offline.

Nothing on a failure path writes state that suppresses a later check, so the next successful call
self-corrects — **provided the host calls on a cadence rather than only at startup.** That
obligation is stated in the README because the self-healing depends on it.

The same rule already existed in the codebase as `@kumiai/rpc`'s `isPermanentSubscribeFailure`
(`packages/rpc/src/hub-mux.ts`): *"Permanent means the hub has ANSWERED, not that it failed."*

## The classifier, and the thing that nearly broke it

Verified empirically against a real hub before the design was written: `hub-client` is a
pass-through wrapper, so a hub error reaching a caller is an enkaku `RequestError` whose `code` is
the wire code — `constructor.name` is `RequestError`, `name` is `'Error'`, and it is **not** an
instance of any `hub-protocol` error class. Nothing in production calls `hubErrorFromCode`.

So `toRetryableOrThrow` identifies an error by reading `error.code` first, with `hubErrorCodeOf`
(instanceof) and `error.name` only as fallbacks for a store error thrown in-process or an error
rebuilt across a bundle boundary. Identifying by `instanceof` and name alone — the obvious
approach, and what the design originally specified — would have classified **every** real hub
answer as retryable, including `AuthorizationDenied`: a host retrying a settled refusal forever,
silently. That is the failure this whole feature exists to prevent.

Refused: `HUB_AUTHORIZATION_DENIED`, `HUB_INVALID_PAYLOAD`, and enkaku `EK02`, `EK06`, `EK08`.
Retryable: everything else, including `HUB_KEYPACKAGE_QUOTA` (a cap clears as packages are consumed
or expire — matching rpc's deliberate exclusion of quotas from permanent) and any transport failure.

`EK08` is reachable rather than theoretical: the upload schema caps `keyPackages` at 50 entries and
nothing validates `target` against it, so a pool configured above that would otherwise re-mint a
doomed batch on every call forever.

## Invariants this preserved, and where they differ per slot

- **Store-before-upload**, both files. The hub must never serve a key package whose private half was
  never written down. Divergence between store and hub therefore only ever runs the safe direction.
- **The ordinary pool never retries a failed batch.** The hub does not dedupe key packages, so
  re-uploading one that did land would hand a single init key to two inviters — an MLS violation.
  Partial commit is real: the upload handler stores each package individually and charges the cap
  per call, so "the upload failed" can mean "17 of 20 landed." Recovery is that the next call reads
  the hub's true count and mints a fresh deficit. Stranded local records must **not** be deleted —
  if that upload did land, a Welcome can name them — so they age out at `notAfter` plus the grace.
- **The last-resort slot does resume.** It is one entry replaced in place, so re-uploading the
  identical package converges whether or not the failed attempt landed. The record keeps
  `uploadedAt: null` on failure so the next call resumes it rather than minting.
- **Prune's keep-set** guards just-minted records against a forward clock correction between the
  mint and prune's own clock read, which would otherwise delete the private half of a package the
  hub may already be serving.
- **Store failures stay outside the classification** and propagate raw. A host with a broken store
  must not be told its hub is flaky.

## Changes made during review, worth remembering

- **Pruning runs before classification**, not after. The classifier *throws* on a refusal, so
  calling it first meant pruning was silently skipped on every refused call while the doc comment
  claimed otherwise. Pruning is local housekeeping and owes nothing to the hub; a refusal is
  precisely the case where the next successful call may be days away. The in-catch prunes are
  individually wrapped so a store failure during prune can never displace the hub error the caller
  needs to see.
- **The provisioner's upload helper was split.** It had bundled the hub call with the `uploadedAt`
  store write, so a failing `store.put` was classified as a retryable *hub* error — contradicting
  the contract above, and a regression against pre-branch behaviour. The pool never had this bug.
  A regression test now fails if the two are folded back together.
- **Three tests that passed for the wrong reason were rebuilt.** Two asserted that records survive a
  failure but would have stayed green with the keep-set guard deleted; they now carry clock jumps
  and were each observed failing before being restored. Three more had been migrated from "rejects
  with this specific error" to "some error occurred" and lost their error-identity pinning.

## Residuals

- `CODE_BY_NAME` in `src/errors.ts` maps hub codes outside this feature's reachable set;
  `retentionExceeded` is documented in hub-protocol as settled yet is not in `REFUSED_CODES`,
  because it only arises on subscribe, which `toRetryableOrThrow` never sees. Harmless today, latent
  if the stage set ever widens. A one-line comment noting that membership in `CODE_BY_NAME` says
  nothing about classification would close it.
- Enkaku `EK07` (encryption required) is unreachable — the hub passes no encryption policy to
  `serve()` — and `EK09` (replay detected) is correctly retryable, since a retry mints a fresh
  authenticated message. Neither is in the refused set, deliberately.
- Whether the rest of the stack should adopt `Result` is deliberately unanswered; see
  `docs/agents/plans/next/2026-07-28-stack-wide-result-adoption.md`.

## Verification

110 tests in `mls-hub`, and a forced whole-repo run (`turbo run test:types test:unit --force`,
`Cached: 0`) green across 42 tasks. Lint clean. New dependencies: `@sozai/result` `^0.2.0` added to
the workspace catalog, `@enkaku/protocol` promoted from a devDependency to a dependency for its
`ErrorCodes` values.
