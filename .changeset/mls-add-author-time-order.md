---
"@kumiai/mls": patch
---

Run the added-leaf author-time check inside `commitWithEntries` again, after the ledger fold and admission gate, so an invitee leaf lapsed at tree time rejects with `LeafLapsedError` instead of the generic authoring-time error. `commitWithEntries` takes the clock as `now`, required when its proposals carry an Add.
