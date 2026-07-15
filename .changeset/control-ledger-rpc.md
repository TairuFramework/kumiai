---
"@kumiai/rpc": minor
---

BREAKING: the control-ledger lane. Commits publish to a compare-and-set commit log and converge by pull; a peer with positive evidence it is off the group's line heals by external-commit rejoin; entry bodies ride in the commit frame and a rejoined peer gathers the whole ordered ledger over a sealed rendezvous.

- `GroupMLS` gains `readCommitHeader`, `createRecoveryRequest`, `sealGroupInfo`, `isLedgerComplete`, `getLedger`, `sealLedger`, `openSealedLedger`, and `bootstrapLedger`; `applyRecovery` is retyped to `(sealed, requestID) => PendingRecovery | null`, and `exportGroupInfo` is removed from the port.
- `GroupPeer` replaces `localCommitted` with `commit`/`replay`, and `recover()` returns `{ advanced, reenact }`. `GroupPeerParams.hub` is now a `LogHub`, and supplying `mls` also requires `journal` and `adoptJournalled`.
- The handshake topic splits into `commitTopic` + `rendezvousTopic`; the recovery-request codecs are retyped; the in-memory `createMemoryGroupMLS` is removed (moved to test fixtures).
