---
"@kumiai/mls": minor
---

Adopt `@kokuin/controller` 0.2.1, `@kokuin/capability` 0.5.1 and `@kokuin/token` 0.6.1 for the 0.11 band.
Wire and persisted formats remain unchanged: `prefix`, `proof` and `recordedLog` still carry signed-event arrays.
Device revokes now use non-reset rotates whose state snapshots newly deny the device DID. Member-issued grants remain unsupported.

`@kumiai/mls-rpc` and `@kumiai/mls-hub` inherit the `@kumiai/mls` behaviour change.
`no-rev` means no revoking rotate for the subject.
