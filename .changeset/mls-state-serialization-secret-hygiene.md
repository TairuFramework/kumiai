---
"@kumiai/mls": minor
---

Serialize `GroupHandle` state mutations, zero retired secrets, and consolidate the receive path.

Every async operation that reads-then-writes a handle's state now runs through one FIFO mutex
per handle, so concurrent operations can no longer clobber a secret-tree advance or a
key-schedule deletion (both weakened forward secrecy). Synchronous getters are unchanged and
stay synchronous. This is a breaking change to the public surface (pre-1.0):

- `encrypt(plaintext)` now returns framed wire `Uint8Array` — the same shape every other
  producer returns — instead of `{ message, consumed }`. Callers no longer need ts-mls
  encoders to put an application message on the wire, and retired secrets never cross the
  public boundary.
- `decrypt` is removed. `processMessage` is the single receive path: an application message
  yields its plaintext bytes, an accepted handshake yields `null` (the state advanced and any
  ledger entries were folded), and a rejected commit throws `CommitRejectedError` with the
  state unchanged. This erases `decrypt`'s mutate-then-throw bug, where an accepted commit
  advanced the group and *then* threw.
- Retired `consumed` secret buffers are zeroed on the state-advancing paths. They are
  deliberately *not* zeroed on the commit-producer path: those producers fork a derived handle
  and leave the source live, so ts-mls's `consumed` there alias still-live source key material.
- `applyLedgerEntries` now runs on the handle mutex like the other state-mutating operations.

Permission enforcement is also hardened against an authenticated-griefing stall found in
review: a received standalone proposal is now judged by the same commit policy (so a
non-admin's authority-bearing proposal is rejected on receipt and never stored as pending),
and the commit producers filter the pending-proposal set against that policy before
committing (so an honest committer never authors a commit the group would refuse). Without
both, any single member could permanently stall the group — including blocking an admin's
attempt to evict them. A `group_context_extensions` commit must now also reproduce the
group-context extension list exactly, with only `ledger_head` moved, so an admin cannot
inject or strip another extension inside an otherwise-valid head move.
