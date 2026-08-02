---
'@kumiai/mls-hub': minor
---

Keep the two storage ports apart with a `kind` discriminant.

`KeyPackagePoolStore` and `LastResortStore` declared the same three methods, and their records
differed by exactly one optional-looking field, so `LastResortStore` was assignable to
`KeyPackagePoolStore`: a host wiring one store to both got no diagnostic on the wrong half. The
records now carry `kind: 'ordinary'` or `kind: 'last-resort'`, which makes them mutually
unassignable and turns that wiring into a compile error.

The default configuration had been containing the consequence by an exact tie rather than by
design. An ordinary package lives 30 days and the default `rotateWithinDays` is also 30, and the
provisioner's gate is strictly greater, so a freshly minted ordinary record missed by approximately
zero. Any `rotateWithinDays` below 30 — every value from 1 to 29 is legal — admitted it, and the
provisioner would then read a pool record's absent `uploadedAt` as "pending upload" and install a
single-use ordinary package in the hub's reusable last-resort slot.

Both callers also re-check `kind` on every read of the store and throw naming the ref and both
kinds, since a store adapter that rebuilds records from its own columns can drop the field where no
compiler can see it. A store MUST now persist `kind` and return it unchanged.
