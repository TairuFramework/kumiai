---
'@kumiai/broadcast': minor
'@kumiai/hub-client': minor
'@kumiai/hub-conformance': minor
'@kumiai/hub-http': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-store': minor
'@kumiai/hub-tunnel': minor
'@kumiai/hub-wake': minor
'@kumiai/mls': minor
'@kumiai/mls-hub': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
'@kumiai/rpc-conformance': minor
---

Introduce the breaking 0.12 management tier across all fourteen packages. Lifecycle groups require registry-seeding controller logs and support membership and member-rooted capability bindings. ControllerLog proofs carry exact denial, removal and reset effects, with survivor grants and retained removal evidence. Effective-member quorum time, admission-only epoch caps and recovery knowledge retention replace the previous lifecycle contracts. Wire shapes, persisted projections, adapters and conformance doubles follow the new surface.

Recheck lifecycle knowledge atomically when adopting recovery candidates, including adoption retries.

Reject log events authored by tombstoned member incarnations after stale root settlements.

Reject unauthenticated no-op log updates and bound replay and effect-claim verification work.

Verify lifecycle envelopes in order so renewal and attestation can share a commit.
