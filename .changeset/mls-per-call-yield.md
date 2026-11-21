---
"@kumiai/mls": patch
"@kumiai/mls-rpc": patch
---

Add an optional per-call `yield` policy to MLS ledger application, bootstrap, restoration, commit reception and builders.
Pass `yield: false` to skip cooperative timer pauses inside host write transactions.
The default remains enabled, with validation and persist ordering unchanged.
Forward the option through `applyCommit` in `@kumiai/mls-rpc`.
