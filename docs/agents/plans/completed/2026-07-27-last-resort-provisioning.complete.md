# Automatic last-resort key-package provisioning

**Status:** complete
**Date:** 2026-07-27
**Branch:** `feat/last-resort-provisioning`
**Scope:** `@kumiai/mls` (three additions), new package `@kumiai/mls-hub`

## The problem

`@kumiai/mls` could already generate a last-resort key package, the hub could already store and serve
one without consuming it, and `hub-client` could already upload one. **Nothing decided when to do any
of that.** Until a host wired it by hand, no DID had a last-resort package, every fetch behaved
exactly as before, and the key-package drain residual the mechanism exists to close stayed open in
practice.

Two host obligations were documented and unenforceable, and both failed silently at precisely the
moment the availability floor was needed:

1. **Retain the last-resort `privatePackage`** after processing a Welcome, instead of deleting it as
   a host correctly would an ordinary single-use bundle. Delete it and the member is silently
   unaddable forever — the exact outage the slot prevents.
2. **Re-upload before the package's MLS lifetime elapses.** The hub stores opaque bytes, cannot see
   the expiry, and goes on reporting the slot full while serving a package every inviter refuses.

## What was built

**`@kumiai/mls-hub`** — a new bridge package owning the policy: `createLastResortProvisioner({
identity, client, store })` with `ensureProvisioned()` and `bundles()`. `ensureProvisioned()` is
idempotent and single-flight; it mints, uploads and retains a package, replaces it once fewer than
30 days of its 90-day lifetime remain, and prunes a retired record only after its lifetime plus a
7-day grace. `bundles()` returns every retained bundle newest-first for `processWelcome`.
`LastResortStore` is the host-implemented storage port, shipped with a strict in-memory reference
implementation.

**`@kumiai/mls`** — gained `encodePrivateKeyPackage` / `decodePrivateKeyPackage` (the canonical
string form of a key package's private half) and `keyPackageRef` (the base64 KeyPackageRef a Welcome
names, used as a stored package's identity).

## Key design decisions

**A separate package, not a home in an existing one.** `@kumiai/mls` is the crypto core and must not
depend on transport — a group library importing a hub client inverts the stack. `@kumiai/hub-client`
must not depend on `ts-mls`: its whole character is that it never decodes MLS, matching the hub, and
every consumer would otherwise pay that dependency. `@kumiai/mls-rpc`'s charter is the `@kumiai/rpc`
consumer ports over `@kumiai/mls`, and provisioning implements no rpc port. So the code joining the
two belongs above both — an implementation spanning two packages goes in a third, because putting it
in either imports a dependency that package must not have. `mls-hub` does **not** depend on
`ts-mls`; every MLS wire form it needs is reached through `@kumiai/mls`, which is why the codecs were
added there rather than here.

**Persist before upload.** The record is written to the store *before* it is uploaded. This is the
load-bearing decision of the whole design: upload-then-persist has a crash window in which the hub
serves a key package whose private half was never written down — the silent "unaddable forever"
outage the slot exists to prevent. A crash in the chosen order leaves an un-uploaded record that the
next call finishes.

**Rotation accumulates, it does not replace.** An inviter that fetched the slot before a rotation
still holds the previous package, and callers of `fetchKeyPackages` cache for future joins — so a
Welcome arriving after a rotation legitimately matches an older record. Records therefore accumulate
and are pruned only once the MLS lifetime plus a grace period has passed.

**A stale pending record is abandoned, not resumed.** Crash-retry resumes an un-uploaded record, but
only while it still has more than the rotation window of life left. Without that bound, a process
down past the package's expiry would come back, upload a package no inviter accepts, and return
"rotated" — telling the host the floor is in place over a full-but-dead slot. This can never discard
a still-valid package: a pending record is always the newest mint, so if it is expired every other
record is too.

**The store's owner scoping is a security boundary, not a convenience.** Every `LastResortStore`
method is scoped by owner DID, and the port documents it in MUST language, because the records hold
private key material — a `list` that crossed owners would leak private keys across identities.

**`bundles()` throws on a corrupt record rather than skipping it.** Silently narrowing a corrupt
store to "you appear to have no last-resort package" would recreate exactly the failure this feature
removes. The cost is accepted and documented: one corrupt *retired* record denies joins the live
record could serve, on the grounds that a store violating its own round-trip contract is not
trustworthy for the live record either. If this is ever softened, the shape must be to return the
decodable bundles *and* raise the failure on a separate diagnostic channel — never to narrow
silently.

**No internal timer and no clock seam.** The host calls `ensureProvisioned()` on whatever cadence it
already has. Rotation and retention are driven by arithmetic the tests control directly; a seam only
tests would use was judged worse than arithmetic.

**Scope held to last-resort only.** Ordinary-pool replenishment was deliberately excluded — doing it
properly needs a hub pool-depth query the protocol does not have. See the follow-on item below.

## Wire-compatibility finding, verified rather than assumed

Nothing requires a publisher to advertise extension type `0x000A` in its LeafNode capabilities.
draft-ietf-mls-extensions-05 (which this value matches) has no such clause; RFC 9420's capabilities
rule binds *leaf-node* extensions and `last_resort` is KeyPackage-only, which is also why ts-mls
checks a peer's declared capabilities against leaf extensions alone. Draft -08 restructured the
feature entirely — it is now MLS Component Type `0x00000004` inside the `app_data_dictionary`
extension — but `0x000A` remains what deployed implementations use (OpenMLS `main` ships
`ExtensionType::LastResort => 10`), so it stays. Anyone migrating to the component form must revisit
`controlCapabilities()` at the same time, because -08 *does* ask clients to advertise
`app_data_dictionary` support in their LeafNodes. This is recorded at the constant itself and in
`docs/reference/reserved-namespaces.md`.

## Status

Complete. 42/42 turbo tasks green on a forced, uncached run; lint clean. The three layering
constraints hold and are checked: no `ts-mls` in `mls-hub`'s manifest or sources, and no
`hub-client` in `@kumiai/mls`.

Every task passed a scoped review, and five of the nine needed a fix round. The reviews caught, among
other things: the unconditional resume branch described above; an entire untested sort comparator in
`bundles()`; an untested `options` passthrough whose loss would have silently minted packages under
the wrong ciphersuite; unpinned units on a minted record's `notAfter`, where a milliseconds
regression would have disabled rotation forever with every test still green; and unvalidated numeric
options where a negative retention value would have deleted still-valid records — the feature
inflicting its own outage.

## Follow-on work

Filed as `docs/agents/plans/next/2026-07-26-ordinary-keypackage-replenishment.md`: nothing replenishes
the *ordinary* key-package pool, and the client cannot learn its own pool depth, so the real fix
needs a `hub/v1/keypackage/status` query. That item also records a sibling gap found here — there is
no self-read for a DID's own last-resort slot either, so the provisioner trusts its own record of a
successful upload and cannot detect hub-side loss of the slot.
