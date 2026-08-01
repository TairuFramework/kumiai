---
'@kumiai/mls': minor
---

Bind MLS membership to the roster on both sides of an invite, and enforce `GroupAnchor.version`.

**Security.** Membership could disagree with the roster. `commitInvite` handed whatever key package
it was given to the Add proposal, so a store serving the wrong owner's package admitted that owner
while the roster named someone else. On the receiving side `defaultCommitPolicy` accepted an Add
from an admin sender without looking at the added leaf, so the binding held only where the commit was
authored — a modified write path could Welcome an identity the roster granted nothing to, and no
receiver could see the disagreement.

Now: `commitInvite` throws the new `InviteRecipientMismatchError` when the key package's credential
DID is not the identity the invite's last enacted `kumiai.role` entry grants a role to, and
`defaultCommitPolicy` rejects an Add whose leaf credential names a DID holding no role in the
commit's candidate roster.

**Narrowings** — non-breaking for callers using `createInvite`, which produces exactly the required
shape:

- An invite enacting no `kumiai.role` entry for the group is refused. This includes an invite whose
  `ledgerEntries` equal the committer's own log.
- A key package carrying a non-`basic` credential, or a `basic` credential whose identity bytes do
  not parse, is refused rather than accepted unread.
- For a hand-assembled invite the invitee's grant must be the **last** `kumiai.role` entry. That
  ordering is now load-bearing.
- MLS membership implies a roster grant: an Add absorbed by a commit that enacts no grant for the
  added DID is dropped by the committer and rejected by receivers. Commit the grant first, then let
  a later commit absorb the Add.

Rejection is a plain `'reject'` with no new error type — `defaultCommitPolicy` returns ts-mls's
`IncomingMessageAction`, which carries no reason; read the Add off `CommitRejectedError.proposals`
to distinguish.

`decodeGroupAnchor` now withholds the opaque `app` payload when an anchor's `version` exceeds
`CURRENT_VERSION`, returning the structural anchor so a member still joins. Non-breaking —
`CURRENT_VERSION` is the only value ever written. The contract this rests on is now stated: a
`version` bump means `app` semantics changed and nothing else; any future control-relevant field
belongs in a new GroupContext extension, never in the anchor where a version-tolerant older peer
would ignore it.
