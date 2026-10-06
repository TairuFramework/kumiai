# rpc: protocol calls await an in-flight epoch rebuild — complete

**Date:** 2026-10-06
**Status:** complete
**Packages:** `@kumiai/rpc` (patch).
**Origin:** In 0.10.3, `rebuildEpoch` awaits `teardownEpoch`, which empties `runtimes` before it
awaits child disposal; `buildEpoch` only fills them afterwards. A `dispatch` (other than log
dispatch through the app outbox), `request`, `gather` or `to()` landing in that window reached
`surfaceFor` and threw `Unknown protocol: <name>`, which a live peer could not tell apart from a
real unknown protocol. kubun plugin-p2p worked around it with a message-prefix retry
(`throughRotation` / `isEpochRebuilding`).

## What shipped

- `peer-epoch.ts` tracks in-flight rebuilds and exposes `epochSettled()`, which resolves once none
  is in flight and never rejects.
- `peer.ts`: `dispatch`, `request` and `to()` go through `withEpoch` (ready, then `epochSettled`,
  then `assertLive`). `gather` waits the same way inside its abortable wait, so an abort during a
  rebuild still resolves `[]`.
- Tests (`test/peer-rebuild-window.test.ts`): one peer's teardown is held open while the other
  rotates; each call type is served on the new epoch, an aborted `gather` resolves empty, and a
  peer disposed during the wait rejects every call with `PeerDisposedError`. Each guarded call site
  was mutation-checked.

## Follow-ups, not done here

- kubun can drop the remaining `isEpochRebuilding` retry once this ships (kubun backlog
  `2026-10-06-plugin-p2p-ephemeral-rotation-retry.md`).
- A `request` or `gather` already in flight when teardown starts still rejects with
  `BroadcastClient disposed`. That is a separate race.
