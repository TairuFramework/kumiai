---
'@kumiai/hub-conformance': minor
'@kumiai/hub-server': patch
'@kumiai/hub-client': patch
'@kumiai/mls': patch
---

A failing last-resort top-up no longer destroys the key packages it was topping up, and `HubStore`
conformance now proves the slot is scoped to its owner.

`hub/v1/keypackage/fetch` ran both store reads inside one `try`. `fetchKeyPackages` is destructive —
by the time it returns, those packages are spliced out of the store for good — so a throw from the
following `fetchLastResortKeyPackage` discarded them and handed the client an error instead. Nobody
received the packages, and the retry burned the next batch, and the next. The likeliest trigger was
the very store this feature targets: one that has not implemented the slot yet throws
`store.fetchLastResortKeyPackage is not a function` on the second read, so every fetch against it
silently drained the target — the drain the last-resort slot exists to close, reintroduced by the
top-up read. The two reads are now split: the pool read's failure is still the client's error and
still keeps its wire code, while the top-up read can only fail the request when nothing was
consumed and there is therefore nothing to lose.

`@kumiai/hub-conformance` gains a clause requiring that one owner's last-resort package is never
served for another. **An existing store may now fail it.** Every other last-resort clause exercises
a single DID, so a read written as `SELECT blob FROM key_packages WHERE is_last_resort LIMIT 1` —
dropping `AND owner = ?` rather than `AND is_last_resort` — passed all of them. The consequence is
worse than init-key reuse: `commitInvite` hands whatever package it is given straight to the Add
proposal without checking the package's credential DID against the invite's recipient, so a fetch
for BOB that returns ALICE's package Welcomes ALICE into the group, where she derives the epoch
secrets, while the ledger entry grants the role to BOB. A store that fails the new clause must scope
its last-resort read by owner.

`hub-client`'s `uploadLastResortKeyPackage` JSDoc and README now carry the two host obligations that
otherwise fail silently — re-upload before the 90-day `LAST_RESORT_LIFETIME_DAYS` window elapses, and
retain the bundle's `privatePackage` for as long as it may be reused. `@kumiai/mls`'s README now
shows how a generic persistence layer can recognize a last-resort bundle at runtime, via the
already-exported `LAST_RESORT_EXTENSION_TYPE`.
