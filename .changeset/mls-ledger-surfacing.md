---
'@kumiai/mls': patch
---

`bootstrapLedger` now fires `onLedgerEntries` for the entries it installs, deduped against
what the handle already held.

The commit path surfaced accepted entries; the bootstrap replaced the whole ledger silently. A
heal is how a peer that missed commits catches up — rejoin, gather, bootstrap — so a host
consuming that callback as an event stream was permanently unaware of everything enacted while
it was away, with its state correct and nothing to look at. Not specific to any one recovery
path: every heal.
