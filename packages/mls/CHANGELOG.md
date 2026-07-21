# @kumiai/mls

## 0.4.0

### Minor Changes

- `GroupHandle.exportSecret(label, context, length)` — the RFC 9420 §8.5 exporter over this
  epoch's exporter secret. Per-epoch by construction, which is the only thing that cuts a removed
  member off from a name derived from it.

- `GroupHandle.decrypt(bytes)` — the counterpart to `encrypt`: opens an application message and
  returns the AEAD-authenticated sender's DID, which ts-mls's own `processMessage` does not
  surface.

- Forward-compatibility surface:

  - A third GroupContext extension type, `0xf102`, is reserved and advertised on every member
    leaf, so a future control extension can be installed into a live group without re-admitting
    every member.
  - `decodeClientState` throws a message-bearing error for an unknown version instead of returning
    `undefined` indistinguishably from a truncated read. Other decode failures are unchanged.
  - `MLSCredentialIdentity` gains `v?: 1`. An absent `v` reads as `1` **permanently** — a
    credential is baked into a leaf and covered by its signature, so identities written before
    this release live in leaves that can never be rewritten.

- Reserved namespaces now name kumiai: ledger entry types move from `group.*` to `kumiai.*`, and
  topic labels from `enkaku/*` to `kumiai/*`. `group.*` is freed for application entry types.

  **The type checker will not tell you.** `ROLE_ENTRY_TYPE`, `COMMIT_LABEL`, `INBOX_LABEL`,
  `RENDEZVOUS_LABEL` and `RECOVERY_REQUEST_TYPE` keep their names while their values move, so
  existing ledgers fold to a different head (recreate groups; no migration) and topics move
  (upgrade every peer together, or they partition silently).

### Patch Changes

- `bootstrapLedger` now fires `onLedgerEntries` for the entries it installs, deduped against what
  the handle already held. The commit path surfaced accepted entries while bootstrap replaced the
  whole ledger silently, so a host consuming that callback as an event stream was permanently
  unaware of everything enacted while it was away.

## 0.3.0

### Minor Changes

- Add the sealed recovery and ledger-gather surface (additive):

  - `createRecoveryRequest`, `sealGroupInfo`/`openSealedGroupInfo`, `sealLedger`/`openSealedLedger`
    and `processWelcomeOnce`.
  - A recovery reply carries a signed responder membership attestation and is authorized against
    the requester's own last-known roster leaf — HPKE base mode authenticates no responder, so the
    seal alone cannot tell a member's reply from an observer's forgery.
  - `sealLedger` seals only the responding handle's own ledger; a corrupt retained ephemeral key
    raises a distinct loud error rather than masquerading as "not for me".

## 0.2.0

### Minor Changes

- Enforce group permissions from a signed control ledger, and retire the capability chain.

  Authority is now a roster folded from a signed, anchor-rooted control ledger and enforced as a
  receiving-side commit policy: every peer independently refuses a commit whose author lacks the
  permission for it, on both the PrivateMessage and external-join (PublicMessage) paths. Breaking
  (pre-1.0):

  - `GroupPermission` narrows to `'admin' | 'member'`; `'read'` is removed. It was unenforceable —
    a group member holds the epoch secrets and derives the same application keys as anyone else.
  - The capability chain is gone. `Invite` becomes `{ groupID, inviterID, ledgerEntries }`;
    `MemberCredential` becomes `{ id, groupID }`; `restoreGroup`, `GroupHandle` and every
    construction site drop `rootCapability`. `createGroupCapability`, `delegateGroupMembership`
    and `validateGroupCapability` are removed. `GroupPermission` now lives in `roster.ts`.
  - An invite carries the full ordered ledger plus the invitee's signed role entry, and the joiner
    verifies the group-context ledger-head before folding, so a truncated or reordered ledger is
    rejected (`LedgerIncompleteError`).
  - A commit that enacts ledger entries advances the group-context ledger-head extension; a
    commit's `authenticatedData` carries a structured `ControlEnvelope { v, entries?, app? }`,
    whose `app` slot is opaque to the library.

- Serialize `GroupHandle` state mutations, zero retired secrets, and consolidate the receive path.

  Every async operation that reads-then-writes a handle's state now runs through one FIFO mutex
  per handle, so concurrent operations can no longer clobber a secret-tree advance or a
  key-schedule deletion. Synchronous getters stay synchronous. Breaking (pre-1.0):

  - `encrypt(plaintext)` returns framed wire `Uint8Array` instead of `{ message, consumed }`.
    Callers no longer need ts-mls encoders to put an application message on the wire, and retired
    secrets never cross the public boundary.
  - `decrypt` is removed. `processMessage` is the single receive path: an application message
    yields its plaintext bytes, an accepted handshake yields `null`, and a rejected commit throws
    `CommitRejectedError` with the state unchanged — erasing `decrypt`'s mutate-then-throw bug.
  - Retired `consumed` secret buffers are zeroed on the state-advancing paths, and deliberately
    not on the commit-producer path, where they alias still-live source key material.
  - `applyLedgerEntries` now runs on the handle mutex like the other state-mutating operations.

  Permission enforcement is also hardened against an authenticated-griefing stall: a received
  standalone proposal is judged by the same commit policy, and the commit producers filter the
  pending-proposal set against that policy before committing. Without both, any single member
  could permanently stall the group, including blocking an admin's attempt to evict them. A
  `group_context_extensions` commit must now also reproduce the group-context extension list
  exactly, with only `ledger_head` moved.
