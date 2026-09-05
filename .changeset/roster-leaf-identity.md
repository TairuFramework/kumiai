---
"@kumiai/rpc": minor
"@kumiai/mls-rpc": minor
"@kumiai/rpc-conformance": minor
---

`GroupMLS.rosterDIDs` → `rosterEntries` with per-leaf identity (breaking). `rosterDIDs(): Promise<Array<string>>` is replaced by `rosterEntries(): Promise<Array<RosterEntry>>`, where `RosterEntry` is `{ did, leafIndex, longForm }`. Entries are returned in ascending `leafIndex` order; `leafIndex` is stable while a leaf remains present and is reassigned by a remove/rejoin of that member; `longForm` is the leaf credential's long form when it carries one, else its `id` (never absent, not a resolvability guarantee).

**Breaking:** the port rename and shape change hit the `@kumiai/rpc` `GroupMLS` port, the `@kumiai/mls-rpc` real implementation, and the `@kumiai/rpc-conformance` contract suite every implementation and every double must pass. `detectRosterChange` is unchanged — it keeps its `Array<string>` DID-set signature.

Known coverage gap (documented, not implemented): the in-repo test double addresses removal by DID and cannot model removing one of two leaves the same DID holds, so the duplicate-DID-leaf-removal case is not covered by conformance. No filed consumer needs it today; the real `@kumiai/mls-rpc` implementation is already faithful via ts-mls.
