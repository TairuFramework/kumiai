---
"@kumiai/mls": minor
---

Adopt `@kokuin/controller` 0.2.1, `@kokuin/capability` 0.5.1 and `@kokuin/token` 0.6.1 for the 0.11 band.
Wire and persisted formats remain unchanged: `prefix`, `proof` and `recordedLog` still carry signed-event arrays.
Device revokes now use non-reset rotates whose state snapshots newly deny the device DID. Member-issued grants remain unsupported.

0.10 and 0.11 peers cannot share a lifecycle group because revoke encoding changed; upgrade all members together.
`@kumiai/mls-rpc` and `@kumiai/mls-hub` inherit the `@kumiai/mls` behaviour break.

Profile logs containing a non-reset rotate without a state snapshot, or a legacy chain `rev`, no longer fold.
Leaves built on these logs fail `controller-mismatch`. A profile reset can replace an obsolete prefix.
A reset removes controller-attributed leaves whose prefixes cannot fold, as well as those below its generation floor.
`RevokeProofError('legacy-log')` is raised only for authenticated legacy revokes, including one in `recordedLog`.
Unsigned or malformed legacy markers fail `not-authority-signed` and are dropped during permissive replay.
Revoke proofs containing a non-reset rotate without a snapshot fail `not-authority-signed`.
`no-rev` retains its name and now means no revoking rotate for the subject.

A group ledger containing a pre-0.11 revoke proof with an authenticated chain `rev` no longer replays.
Restore and derivation throw `RevokeProofError('legacy-log')` instead of forgetting the revocation. Recreate the group.
