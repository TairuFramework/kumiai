---
'@kumiai/broadcast': minor
'@kumiai/mls': minor
'@kumiai/mls-rpc': minor
'@kumiai/rpc': minor
---

Reserved namespaces now name kumiai: ledger entry types move from `group.*` to
`kumiai.*`, and topic labels from `enkaku/*` to `kumiai/*`. `group.*` is freed
for application entry types — a host defining `group.settings` had its whole
commit rejected before this change.

**Breaking, and the type checker will not tell you.** The exported constant
names are unchanged (`ROLE_ENTRY_TYPE`, `COMMIT_LABEL`, `INBOX_LABEL`,
`RENDEZVOUS_LABEL`, `RECOVERY_REQUEST_TYPE`), so code importing them keeps
compiling while the values underneath move. Two consequences:

- **Ledgers do not survive.** Entry types are signed into tokens and folded into
  the ledger head, so every existing ledger folds to a different head. Recreate
  groups; there is no migration path and no compatibility shim.
- **Topics move.** Labels are hashed into topic IDs. Members that upgrade out of
  lockstep derive different topics and partition silently, with no error on
  either side. Upgrade every peer in a group together.

Code that hardcoded `'group.role'` rather than importing the constant breaks
with no diagnostic. Import the constants.

`@kumiai/mls-rpc`'s `RECOVERY_LABEL` also moves, from `kumiai/rendezvous/v1`
to `kumiai/recovery/v1` — it was colliding with `@kumiai/rpc`'s
`RENDEZVOUS_LABEL` and the two now have distinct values. Since the recovery
secret is exported under this label and both the commit topic and the
rendezvous topic are derived from that secret, all three — the recovery
secret and both topics derived from it — move together.
