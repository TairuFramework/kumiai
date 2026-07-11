---
"@kumiai/mls": minor
---

Enforce group permissions from a signed control ledger, and retire the capability chain.

Authority is now a roster folded from a signed, anchor-rooted control ledger and enforced
as a receiving-side commit policy: every peer independently refuses a commit whose author
lacks the permission for it, on both the PrivateMessage and external-join (PublicMessage)
paths. This is a breaking change to the public surface (pre-1.0):

- `GroupPermission` narrows to `'admin' | 'member'`; the `'read'` level is removed. It was
  unenforceable — a group member holds the epoch secrets and derives the same application
  keys as anyone else, so MLS cannot express read-only membership.
- The capability chain is gone. `Invite` becomes `{ groupID, inviterID, ledgerEntries }`
  (no `capabilityToken`, `capabilityChain`, or `permission`); `MemberCredential` becomes
  `{ id, groupID }`; `restoreGroup`, `GroupHandle`, and every construction site drop
  `rootCapability`. `createGroupCapability`, `delegateGroupMembership`, and
  `validateGroupCapability` are removed. `GroupPermission` now lives in `roster.ts`.
- An invite carries the full ordered ledger plus the invitee's signed role entry, and the
  joiner verifies the group-context ledger-head before folding, so a truncated or reordered
  ledger is rejected (`LedgerIncompleteError`).
- A commit that enacts ledger entries advances the group-context ledger-head extension; a
  commit's `authenticatedData` carries a structured `ControlEnvelope { v, entries?, app? }`,
  whose `app` slot is opaque to the library.
