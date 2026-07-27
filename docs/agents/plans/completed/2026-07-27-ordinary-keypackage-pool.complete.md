# Ordinary key-package pool replenishment

**Status:** complete
**Date:** 2026-07-27
**Branch:** `feat/ordinary-keypackage-pool`
**Scope:** `@kumiai/mls`, `@kumiai/hub-protocol`, `@kumiai/hub-conformance`, `@kumiai/hub-server`,
`@kumiai/hub-client`, `@kumiai/mls-hub`

## The problem

`@kumiai/mls-hub` kept the last-resort slot filled. Nothing kept the ordinary pool filled. A host that
uploaded once at enrolment and never again eventually served every join from its reusable last-resort
package — correct, and the availability floor worked, but a reused init key denies new members the
forward secrecy a fresh package would give them.

A client could not even learn its own depth: `hub/v1/keypackage/upload` returned `{ stored }`, meaning
stored-by-this-call, and consumption happens on someone else's fetch.

**The part the original backlog item missed, found while designing:** depth alone does not say the pool
is *usable*, and a depth-only design wedges permanently. Ordinary bundles carried ts-mls's unexported
~15-day default lifetime; `storeKeyPackage` rejects at the per-DID cap and never evicts (a deliberate
anti-DoS decision); `fetchKeyPackages` is FIFO, so it served the nearest-expiry entry first; and
`HubStore` had no delete. A host topping up ~20 per lifetime therefore accumulated dead entries against
the cap and could never upload again after roughly five rounds.

## What was built

**Expiry carried on upload.** `hub/v1/keypackage/upload` gained an optional `notAfter` (seconds, one
value per batch). A store must not serve, count, or charge its cap for an expired entry; an entry with
no `notAfter` never expires. That closes both the wedge and the FIFO-serves-the-stalest problem.

**`hub/v1/keypackage/status`.** Reports the caller's own live depth and a digest of the caller's own
last-resort slot. `HubStore` gained `countKeyPackages(ownerDID)` (**required** — a breaking addition for
any third-party implementation) and a `notAfter` argument on `storeKeyPackage`.

**`createKeyPackagePool`** in `@kumiai/mls-hub`: tops the pool up against the hub's reported depth,
persists before uploading, prunes past expiry plus a grace, single-flight, no internal timer.

**`processWelcomeFromSources`**: selects the retained bundle a Welcome names by KeyPackageRef, calls
`processWelcome`, and releases it from whichever source it came from.

**Slot readback**: `LastResortProvisioner.ensureProvisioned()` now compares the hub's digest against its
own live record and re-uploads on a mismatch, instead of trusting its own memory of a successful upload.

**`@kumiai/mls`** gained `ORDINARY_KEY_PACKAGE_LIFETIME_DAYS = 30` (stamped explicitly) and
`welcomeKeyPackageRefs`.

## Key design decisions

**The status query takes no `did`.** Not an authorization rule — there is no parameter to authorize. A
query that could name another DID would tell an attacker exactly when a key-package drain against that
DID had succeeded. Closing it by construction means no later edit can relax it.

**The hub takes the uploader's word on expiry.** It stores opaque blobs and cannot read an MLS lifetime.
This matches the precedent the `lastResort` flag already set on the same procedure: misstating it only
harms the uploader's own DID — too early evicts your own live packages, too late keeps your own dead
ones holding your own cap.

**The digest is a digest, not a boolean.** A boolean detects a hub that lost the slot; a digest also
detects a hub holding a package that is not the one the provisioner believes it uploaded. It is computed
in the handler rather than in each store, so no implementation can drift from the definition. Hex over
Web Crypto rather than base64url, so `@kumiai/hub-protocol` takes on no dependency for a value nobody
parses.

**Expiry is not applied to the last-resort slot.** Its staleness is handled by rotation. A hub refusing
to serve an expired slot on its own clock would deny the availability floor over clock skew.

**The reject-at-cap decision stands.** Expiry removes the wedge without touching it. No hub-side
eviction.

**An interrupted pool record is abandoned, never resumed — the opposite of the sibling provisioner, and
the reason the two are separate implementations.** The last-resort slot is *replaced in place*, so
re-uploading a record whose upload may or may not have landed is idempotent. The ordinary pool
*appends*: re-uploading would put two copies of one init key in the pool and the hub would serve both —
precisely the init-key reuse this feature exists to remove. The asymmetry is structural rather than
merely observed: `KeyPackageRecord` has no `uploadedAt` field at all, so an interrupted batch is
*unresumable*, not just un-resumed. The abandoned private half stays readable for a late Welcome and is
pruned at expiry. Anyone tempted to "unify" the two implementations must preserve this.

**Store before upload**, in both implementations. The reverse order has a crash window in which the hub
serves a package whose private half was never written down.

**The consumption signal is a wrapper, not a documented obligation.** The preceding last-resort work
found that its two documented, unenforceable host obligations both failed silently at exactly the moment
they mattered. So dropping a used single-use private half is enforced by construction:
`processWelcomeFromSources` releases the bundle it used. A pool releases by deleting; a provisioner
releases by doing nothing, because its package is reusable and deleting it would make the owner silently
unaddable forever.

**Selection is by ref, never by trial decryption.** A mismatch is then a named error listing the refs
sought, rather than an undiagnosable crypto failure.

**A failed release does not fail the join.** Throwing would take the caller's group away over a storage
problem; swallowing would recreate the silent obligation the wrapper exists to remove. The group returns
with `releaseError` set — the separate-diagnostic-channel shape this package already settled on.

**Each source is isolated from the others.** `bundles()` throws loudly on a record that does not
round-trip, and that rule is right *within* a store: one that breaks its own contract is not trusted for
its live record either. It does not carry *across* stores. A corrupt ordinary-pool record says nothing
about the last-resort store, and letting it abort the scan would deny the availability floor the slot
exists to provide. A throwing source is recorded and skipped, and the failures ride back on
`sourceErrors` — surfaced, never swallowed, and named in the no-match error too, because "no bundle
matched" and "a store could not be read" send a caller looking in different places.

**`lowWater` must be at least 1.** `count < 0` is never true, so 0 would make the pool silently never
stock and the host would quietly fall back to reusing its last-resort init key — this feature's own
defect, arriving through a config value that looks reasonable.

**Two ports, shared mechanics.** `KeyPackagePoolStore` is not a generalization of `LastResortStore` and
neither imports the other; only the owner-scoped memory map and the sort-decode-or-throw are shared,
through an unexported internal module. Both ports hold secret key material and are owner-scoped in MUST
language.

## Status

Complete. 42/42 turbo tasks green on a forced, uncached run at the branch head; lint clean across 304
files. The layering constraints hold and were checked: no `ts-mls` in `mls-hub`'s manifest or sources,
no `hub-client` in `@kumiai/mls`.

Ten tasks, each with a scoped review; eight fix rounds landed, plus one fix wave after the final
whole-branch review.

**Every task's review found at least one test that stayed green while the code under test was broken** —
nine across the branch. Among them: a client method whose expiry argument could be deleted entirely with
the whole suite still passing; a handler test that could not distinguish threading `notAfter` from
dropping it; `lowWater`'s hysteresis, where replacing `count < lowWater` with `count < target` changed
nothing observable; the entire pre-decoded-Welcome branch of `welcomeKeyPackageRefs`; and the multi-source
loop in `processWelcomeFromSources`, where truncating to the first source alone passed 67 tests. Requiring
each implementer to break the behaviour, watch a named test fail, and restore it is what surfaced these —
a review that only reads code does not find them. One of the vacuous tests originated in the plan's own
illustrative snippet, so this is a plan-quality signal as much as an implementer one.

A generated `lib/` was also found stale mid-branch — `hub-protocol`'s built `protocol.js` was missing an
entire procedure its `.d.ts` already declared. A repo-wide rebuild (9 of 11 packages were cache misses)
was run before the `mls-hub` work so it did not build on phantom artefacts. Worth remembering when a
cross-package test result looks impossible.
