---
'@kumiai/mls': minor
---

`defaultCommitPolicy` now rejects an Add proposal whose leaf credential names a DID that holds no
role in the commit's candidate roster. Previously an Add from an admin sender was accepted without
the added leaf being looked at, so the key-package/roster binding `commitInvite` enforces held only
where the commit was authored — a modified or buggy write path could still Welcome an identity the
roster never granted a role to, and no receiver could see the disagreement.

Two narrowings ship with it:

- An Add whose key package carries a non-`basic` credential, or a `basic` credential whose identity
  bytes do not parse, is rejected rather than accepted unread.
- MLS membership now implies a roster grant. An Add absorbed by a commit that enacts no grant for
  the added DID — an admin's standalone Add riding an unrelated eviction commit, say — is dropped by
  the committer's own pending filter and rejected by receivers. The capability is not lost, only
  ordered: commit the grant, then let a later commit absorb the Add.

Non-breaking for every honest caller: `createInvite` always enacts a `kumiai.role` entry for the
invitee and `commitInvite` already binds the key package to it, so every invite this library issues
satisfies the rule by construction. Rejection is a plain `'reject'` with no new error type —
`defaultCommitPolicy` returns ts-mls's `IncomingMessageAction`, which carries no reason, and a host
that wants to distinguish this case can read the Add off `CommitRejectedError.proposals`.
