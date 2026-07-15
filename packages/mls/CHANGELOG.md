# @kumiai/mls

## 0.3.0

### Minor Changes

- 70634ac: Add the sealed recovery and ledger-gather surface (additive):

  - `createRecoveryRequest`, `sealGroupInfo`/`openSealedGroupInfo`, `sealLedger`/`openSealedLedger`, and `processWelcomeOnce`.
  - A recovery reply carries a signed responder membership attestation and is authorized against the requester's own last-known roster leaf — HPKE base mode authenticates no responder, so the seal alone cannot tell a member's reply from an observer's forgery.
  - `sealLedger` seals only the responding handle's own ledger; a corrupt retained ephemeral key raises a distinct loud error rather than masquerading as "not for me".

## 0.2.0

### Minor Changes

- 03a60d2: Enforce group permissions from a signed control ledger, and retire the capability chain.

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

- 1ef7feb: Serialize `GroupHandle` state mutations, zero retired secrets, and consolidate the receive path.

  Every async operation that reads-then-writes a handle's state now runs through one FIFO mutex
  per handle, so concurrent operations can no longer clobber a secret-tree advance or a
  key-schedule deletion (both weakened forward secrecy). Synchronous getters are unchanged and
  stay synchronous. This is a breaking change to the public surface (pre-1.0):

  - `encrypt(plaintext)` now returns framed wire `Uint8Array` — the same shape every other
    producer returns — instead of `{ message, consumed }`. Callers no longer need ts-mls
    encoders to put an application message on the wire, and retired secrets never cross the
    public boundary.
  - `decrypt` is removed. `processMessage` is the single receive path: an application message
    yields its plaintext bytes, an accepted handshake yields `null` (the state advanced and any
    ledger entries were folded), and a rejected commit throws `CommitRejectedError` with the
    state unchanged. This erases `decrypt`'s mutate-then-throw bug, where an accepted commit
    advanced the group and _then_ threw.
  - Retired `consumed` secret buffers are zeroed on the state-advancing paths. They are
    deliberately _not_ zeroed on the commit-producer path: those producers fork a derived handle
    and leave the source live, so ts-mls's `consumed` there alias still-live source key material.
  - `applyLedgerEntries` now runs on the handle mutex like the other state-mutating operations.

  Permission enforcement is also hardened against an authenticated-griefing stall found in
  review: a received standalone proposal is now judged by the same commit policy (so a
  non-admin's authority-bearing proposal is rejected on receipt and never stored as pending),
  and the commit producers filter the pending-proposal set against that policy before
  committing (so an honest committer never authors a commit the group would refuse). Without
  both, any single member could permanently stall the group — including blocking an admin's
  attempt to evict them. A `group_context_extensions` commit must now also reproduce the
  group-context extension list exactly, with only `ledger_head` moved, so an admin cannot
  inject or strip another extension inside an otherwise-valid head move.
