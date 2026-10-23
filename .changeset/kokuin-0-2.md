---
"@kumiai/mls": minor
---

Adopt `@kokuin/controller` 0.2.1, `@kokuin/capability` 0.5.1 and `@kokuin/token` 0.6.1 for the 0.11 band.
Wire and persisted formats remain unchanged: `prefix`, `proof` and `recordedLog` still carry signed-event arrays.
Device revokes now use non-reset rotates whose state snapshots newly deny the device DID. Member-issued grants remain unsupported.

Profile logs containing a non-reset rotate without a state snapshot, or a legacy chain `rev`, no longer fold.
Leaves built on these logs fail `controller-mismatch`. A profile reset can replace an obsolete prefix.
Revoke proofs over a chain `rev`, including one in `recordedLog`, fail `RevokeProofError('legacy-log')`.
Revoke proofs containing a non-reset rotate without a snapshot fail `not-authority-signed`.
`no-rev` retains its name and now means no revoking rotate for the subject.

A group ledger containing a pre-0.11 revoke proof with a chain `rev` no longer replays.
Restore and derivation throw `RevokeProofError('legacy-log')` instead of forgetting the revocation. Recreate the group.
