# @kumiai/mls

## 0.5.0

### Minor Changes

- Key-package provisioning: last-resort slot, pool replenishment, and drain defence.

  **Security.** An authorized attacker within quota could drain a victim's key-package pool, after
  which the victim could not be added to any group until they re-uploaded. Closed on four fronts: a
  per-DID last-resort slot that is never consumed and sits outside the storage cap; per-DID caps
  (`maxKeyPackagesPerDID` 100, `maxSubscriptionsPerDID` 1000) that reject rather than evict; a
  per-target consumption quota (`maxPerTargetConsumed`, 60/window) so minting throwaway requester DIDs
  no longer amplifies a drain; and automatic provisioning in the new `@kumiai/mls-hub`, without which
  no DID had a slot at all.

  `@kumiai/hub-conformance` gains a clause that one owner's last-resort package is never served for
  another. **An existing store may now fail it**: every other clause exercises a single DID, so a read
  missing `AND owner = ?` passed them all. A fetch for BOB returning ALICE's package Welcomes ALICE,
  who derives the epoch secrets, while the ledger grants the role to BOB.

  **Breaking.**

  - `HubStore.countKeyPackages(ownerDID)` is a **new required method**. `storeKeyPackage` takes an
    optional `notAfter`; an expired entry must be neither served, counted, nor charged against the cap.
  - `KeyPackagePool.ensureStocked()` and `LastResortProvisioner.ensureProvisioned()` return an
    `AsyncResult` from `@sozai/result`. Read `.value`, or branch on `result.isError()` to carry on
    through an outage. A transient condition returns `HubRetryableError`; a settled refusal throws
    `HubRefusedError` with its wire code.
  - `@kumiai/mls-hub`'s pool and last-resort records carry `kind: 'ordinary'` or `kind: 'last-resort'`.
    `KeyPackagePoolStore` and `LastResortStore` were structurally assignable, so a host wiring one
    store to both got no diagnostic on the wrong half — under which a single-use ordinary package
    could be installed in the hub's reusable last-resort slot. The discriminant makes them mutually
    unassignable, and both callers re-check `kind` on every read since a store adapter rebuilding
    records from its own columns can drop the field where no compiler sees it. **A store MUST persist
    `kind` and return it unchanged.**

  **Added.** `@kumiai/mls`: `createLastResortKeyPackageBundle` (extension `0x000A`, explicit 90-day
  lifetime — ts-mls's ~15-day default made the slot read healthy while every join through it failed),
  `LAST_RESORT_LIFETIME_DAYS`, `encodeKeyPackage`/`decodeKeyPackage` and the private-half equivalents,
  `keyPackageRef`. `@kumiai/mls-hub`: `createLastResortProvisioner`, `createKeyPackagePool`,
  `processWelcomeFromSources`. `@kumiai/hub-protocol`: `hub/v1/keypackage/status` (caller's own depth
  only, takes no `did`), a `lastResort` upload flag, and four coded errors —
  `HUB_AUTHORIZATION_DENIED`, `HUB_KEYPACKAGE_QUOTA`, `HUB_SUBSCRIPTION_QUOTA`,
  `HUB_KEYPACKAGE_FETCH_LIMIT`. `@kumiai/hub-client`: `uploadLastResortKeyPackage`.

  **Host obligations**, silent if missed: retain a last-resort bundle's `privatePackage` across a
  Welcome, and re-upload before its lifetime elapses. The `LastResortStore` port holds secret key
  material and MUST scope every method by owner DID.

- Bind MLS membership to the roster on both sides of an invite, and enforce `GroupAnchor.version`.

  **Security.** Membership could disagree with the roster: `commitInvite` handed whatever key package
  it was given to the Add proposal, and `defaultCommitPolicy` accepted an Add from an admin sender
  without looking at the added leaf — so a Welcome could reach an identity the roster granted nothing
  to, and no receiver could see the disagreement.

  `commitInvite` now throws the new `InviteRecipientMismatchError` when the key package's credential
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
  belongs in a new GroupContext extension, never in the anchor.

- The group moves to the 0.5 band. Every publishable package shares one meaningful version — the minor
  while pre-1.0, the major after. Trailing segments still diverge freely: a package taking a patch
  release on its own does not move anyone else.

  `@kumiai/mls-hub` publishes for the first time in this release, at the band version.

  **Breaking.** Two dead exports removed while the band break makes it cheap, both unreachable in
  practice:

  - `@kumiai/mls` no longer exports the `GroupSyncScope` type — referenced by nothing, here or in any
    consumer.
  - `HubClient` no longer exposes the `rawClient` getter. `HubClient` now has one method per
    `HubProtocol` procedure, and a caller needing the underlying `Client<HubProtocol>` already holds
    it — `HubClientParams` takes it in.

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
