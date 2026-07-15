---
"@kumiai/mls": minor
---

Add the sealed recovery and ledger-gather surface (additive):

- `createRecoveryRequest`, `sealGroupInfo`/`openSealedGroupInfo`, `sealLedger`/`openSealedLedger`, and `processWelcomeOnce`.
- A recovery reply carries a signed responder membership attestation and is authorized against the requester's own last-known roster leaf — HPKE base mode authenticates no responder, so the seal alone cannot tell a member's reply from an observer's forgery.
- `sealLedger` seals only the responding handle's own ledger; a corrupt retained ephemeral key raises a distinct loud error rather than masquerading as "not for me".
