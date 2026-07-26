---
'@kumiai/mls': minor
---

`commitInvite` now refuses a key package whose credential DID is not the identity the invite's
last enacted `kumiai.role` entry grants a role to, throwing the new `InviteRecipientMismatchError`.
Previously the joining identity was decided by whoever supplied the key package bytes, so a store
that served the wrong owner's package would admit that owner while the roster named someone else.

Three more consumer-visible narrowings ship alongside it:

- An invite that enacts no `kumiai.role` entry for the group is now refused with a bare `Error`.
  This includes a previously-working shape: an invite whose `ledgerEntries` exactly equal the
  committer's own log, enacting nothing new.
- A key package carrying a non-`basic` credential is now refused with a bare `Error`, rather than
  being handed to the Add proposal.
- For a hand-assembled invite, the invitee's grant must be the **last** `kumiai.role` entry.
  `createInvite` has always placed it last; that ordering is now load-bearing rather than
  stylistic, and an invite that violates it binds to the trailing grant's subject instead of the
  intended invitee.

Non-breaking for every honest caller: `createInvite` already produces exactly this shape, so no
existing invite issued by this library changes behaviour. What changes is what a party who could
previously make membership disagree with the roster — by supplying a substituted key package, an
invite that grants no role, or a non-`basic` credential — can no longer do silently.
