---
'@kumiai/mls': minor
---

`commitInvite` now refuses a key package whose credential DID is not the identity the invite's enacted role entry grants a role to, throwing the new `InviteRecipientMismatchError`. Previously the joining identity was decided by whoever supplied the key package bytes, so a store that served the wrong owner's package would admit that owner while the roster named someone else.
