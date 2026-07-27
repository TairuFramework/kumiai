---
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-client': minor
'@kumiai/hub-server': minor
'@kumiai/mls-hub': minor
'@kumiai/mls': minor
---

Replenish the ordinary key-package pool.

`hub/v1/keypackage/upload` now carries an optional `notAfter`, and a store must neither serve, count,
nor charge its cap for an expired entry — without which a pool that filled with dead packages could
never be replenished. The new `hub/v1/keypackage/status` reports the caller's own live depth and a
digest of their own last-resort slot; it takes no `did`, so it cannot report on anyone else.
`@kumiai/mls-hub` gains `createKeyPackagePool`, which tops up against that depth, and
`processWelcomeFromSources`, which picks the bundle a Welcome names and drops a single-use private
half once it is used. `LastResortProvisioner` now re-uploads when the hub's slot does not hold what
it believes it uploaded.
