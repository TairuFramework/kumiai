---
"@kumiai/mls-rpc": minor
"@kumiai/rpc": minor
"@kumiai/rpc-conformance": minor
---

Host handle access, in the same 0.10 band as durable delivery.

**`@kumiai/mls-rpc` (breaking):** both factories take one shared `access: HandleAccess` in place of `handle` / `adopt` / `persist`; `simpleHandleAccess({ handle, adopt, persist })` builds it from the old parameters. A host with its own store implements `HandleAccess` (`epoch`, `read`, `mutate`, `replace`, `open`) and owns the lock, the transaction and the persist order. New exports: `applyCommit` for applying a received Commit inside a host transaction (it returns both rosters, the surfaced ledger entries, the committer, and `applied` / `advanced`), `deriveEntryKey`, `sealEntries`, `openEntries`, `createRecoveryPending` and `deriveRecoverySecret`. `createGroupMLS` takes an optional `recoverySecret(handle)` override; the default is unchanged, so existing groups keep their topics. Without `pending`, the simple adapter now saves the ratchet state after `wrap` and `unwrap`: a crash after `unwrap` and before the handler finishes loses that frame, and `pending` is the at-least-once path.

**`@kumiai/rpc` (breaking port change):** `GroupCrypto.epoch()` is a hint, and decisions use the epoch a locked port result reports. `exportSecret` returns `{ secret, epoch }`, `sealEntries` returns `{ sealed, epoch }`, `unwrap` results carry `epoch`, `processCommit` returns `{ advanced, epochBefore, epochAfter }`, and `GroupMLS` gains `readEpoch()`. `unwrap` throws `FrameEpochError { frameEpoch, handleEpoch }` for a readable frame at another epoch, before decrypting. App-frame retention, the drain, anchor capture, the commit walk and journal replay read the epoch under the handle lock instead of the hint.

**`@kumiai/rpc-conformance`:** harnesses provide `setEpochHintOffset(offset)`, and clauses run with a lying hint in both directions. The `GroupMLS` shape gains `readEpoch`.
