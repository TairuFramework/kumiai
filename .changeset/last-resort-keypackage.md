---
'@kumiai/hub-conformance': minor
'@kumiai/hub-protocol': minor
'@kumiai/hub-server': minor
'@kumiai/hub-client': minor
'@kumiai/mls': minor
---

MLS last-resort key packages, so a drained pool can no longer strand a member.

The key-package drain was already rate-bounded, but an authorized attacker
staying within quota could still empty a victim's pool, after which the victim
could not be added to any group until they re-uploaded.

`@kumiai/mls` gains `createLastResortKeyPackageBundle`, which stamps the
`last_resort` extension (type `0x000A`, draft-ietf-mls-extensions) onto a key
package, marking it reusable by design. Hosts must retain its private package
after a Welcome rather than deleting it as they would an ordinary one.

The hub learns which package is last-resort from a `lastResort` flag on
`hub/v1/keypackage/upload` — it never decodes MLS. `HubStore` gains
`storeLastResortKeyPackage` and `fetchLastResortKeyPackage`, backing a single
replace-on-upload slot per DID that sits outside the per-DID storage cap and is
never consumed. A fetch serves ordinary packages first and appends the slot at
most once; when the per-target drain budget is spent it falls back to the slot
alone, since serving it consumes nothing and so charges nothing.

`hub-client` gains `uploadLastResortKeyPackage`.
