---
"@kumiai/mls": minor
---

did:kokuin device verification: an MLS leaf can opt in to being a device of a `did:kokuin:` controller (profile). Adds the bound-leaf verify path (zero-I/O synchronous validation), the group-folded device registry and `kumiai.device` ledger entries (register/add/revoke/label with terminal revocation and `authority = controllerOf ?? id`), and observability surfaces over a `@sozai/event` emitter (`revokedDevices()`, `deviceRevoked`, `controllerBeaconChanged`, `announceControllerBeacon`, the advisory controller-log beacon). New deps `@kokuin/capability` and `@sozai/event` via the workspace catalog. Purely additive; floating `did:key`/`did:peer:4` leaves are unchanged.
