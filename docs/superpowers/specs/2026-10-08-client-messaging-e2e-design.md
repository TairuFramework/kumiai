# Client host, messaging protocol and multi-device e2e — design

Date: 2026-10-08
Status: approved r6 (2026-10-08)

This is the umbrella design. Three sub-specs must be written and approved before the phases that
depend on them:

- **Spec P: transactional persistence**, before phase 1.
- **Spec I: identity and group model**, before phase 4.
- **Spec H: hub authorization**, before phase 4.

Out of scope, recorded as backlog: verifiable pre-link history for newly linked devices, and
message-only push wake. See [Deferred](#deferred).

## Intent

- **Lift generic group-host logic out of Kubun** (`@kubun/plugin-p2p`) into kumiai packages, so Kubun
  shrinks and adopts kumiai pieces incrementally. Lifted code must be generic: no Kubun documents,
  catalogs, circles, credentials, sync or GraphQL concepts.
- **Harden kumiai with realistic tests**: many devices talking through a real hub over HTTP, each
  with its own durable store, exercising most packages end to end.
- **A small reusable messaging protocol** (`@kumiai/messaging`), Signal/WhatsApp-like, used as a
  simplified model of Kubun's needs. It is not the product; it must still be an independent package
  usable by other projects.
- **Multi-device users**: a `did:kokuin` controller owns several devices, backed by
  `@kokuin/store-controller` and `@kokuin/store-delegation`.
- **Future**: Android and iOS simulator devices join the same e2e scenarios. Out of scope here, but
  the design must not block it.

### Success criteria

1. Kubun's generic host code has a kumiai home behind ports Kubun can implement over its own rows.
2. A scenario suite runs N devices (in-process and child-process) against a real `createHubServer`
   and covers messaging, group admin/member management, multi-device link/revoke, hub refusal after
   removal/revocation, offline + push wake, concurrent commits, the named crash points and the
   adversarial cases under [Scenarios](#scenarios).
3. Every new port implementation, and every double, passes the relevant conformance suite.
4. `client` and `messaging` run on Expo: the `tests/e2e-expo` app imports both, and its Metro bundle
   builds in CI. Simulator runs come later.

## Context

Identity/hub context retains the 2026-10-08 reviews. Spec P port/publication claims below were
rechecked on 2026-10-09; each carries current source evidence.

**Spec P r10 amendments (r10 decision), 2026-10-09.** Every installed epoch co-writes its authenticator into the group's durable spent set.
Genesis, ordinary/last-resort Welcome, own/received commit and recovery all contribute. Welcome/candidate/seed admission refuses spent authenticators before epoch comparison, never merges.
Recovery and deletion retain the lifetime set, including tombstones. Growth is one authenticator per held epoch, like receipts. This explicitly amends P2a D4.
Private rotation/control builds reserve consumed handshake generations durably; every rebuild merges the source handshake HWM, including after restart.
Ordinary state writes retain lineage; only authorised recovery/Welcome replacement increments it. No path decreases it.
State/control/coordinated-outbox/anchor factories require a host at-rest codec with group/record AAD. The host owns all at-rest keys and their lifecycle.
Kumiai never generates or stores those keys. Phase 2 memory doubles inject a deterministic test codec; conformance inspects raw bytes and rejects wrong AAD.

- `@kumiai/mls` has signed-ledger roles (`roster.ts`: `admin | member`, only admins grant,
  zero-admin entries dropped). Roles persist after the subject's removal. Authority resolves through
  `controller ?? device` for registered devices (`registry.ts`); admission checks the added device's
  raw DID role, and removal protects raw device-admin roles (`policy.ts`).
- `@kumiai/mls` device support is per-controller: `addDevice`/`revokeDevice` (`group-device.ts`)
  need a direct, leaf-key-pinned `manage` capability issued by the affected device's controller,
  not group-admin rights. Leaves carry an embedded controller binding (`device-proof.ts`,
  `embedded-resolver.ts`); the embedded resolver never fetches external logs.
- Setting `anchor.controller` makes every leaf bind to that one controller (`lifecycle.ts`
  `checkBinding`). `createGroup` anchors a supplied creator controller automatically and rejects a
  controller-bound creator in an unanchored group (`group-create.ts`). An unanchored Welcome
  requires a role entry naming the joining device (`group-welcome.ts`), which `addDevice` does not
  supply. **So a multi-user group of controller-bound devices needs mls changes** (Spec I).
- `@kumiai/rpc` `createGroupPeer` takes ports `GroupCrypto`, `GroupMLS` and stores `AnchorStore`,
  `AppOutbox`, `AppCursorStore`, `ControlStore` (`packages/rpc/src/peer-types.ts:78`).
  P2a adoption carries state/control/anchor changes via `AdoptionWrite`
  (`packages/rpc/src/control/types.ts:39`). Only events may be log-retained
  (`packages/rpc/src/protocol.ts:21`); app topics derive from protocol name
  (`packages/rpc/src/peer-epoch.ts:262`).
- For log procedures with an outbox configured, rpc dispatch resolves once the outbox durably
  accepts the plaintext, before hub publication. Outbox entries are re-sealed after epoch changes.
  Publication acknowledgement tracking is in memory, and the app lane skips the publisher's own
  echo (`packages/rpc/src/app-outbox.ts:113`, `packages/rpc/src/log-delivery.ts:43`,
  `packages/rpc/src/app-lane.ts:789`). Delivery currently discards the publish result and removes
  without an outcome (`packages/rpc/src/log-delivery.ts:179`, `packages/rpc/src/app-outbox.ts:30`).
- Handlers see the MLS-authenticated sender at `ctx.message.payload.iss`. The opened epoch is not
  exposed consistently (`packages/rpc/src/handlers.ts:19`, `packages/rpc/src/handlers.ts:83`).
- Ephemeral (mailbox) publications queue for existing subscribers other than the publisher
  (`packages/hub-store/src/store.ts:236`), including offline subscribers. Frames are age-bounded by
  requested/default retention (`packages/hub-store/src/store.ts:522`), and the final ack frees them
  (`packages/hub-server/src/memoryStore.ts:190`).
- App-lane retries reseal plaintext; publication evidence stays in memory
  (`packages/rpc/src/log-delivery.ts:43`, `packages/rpc/src/log-delivery.ts:147`). App publishes omit
  IDs (`packages/rpc/src/peer.ts:656`); P2a control/rejoin replay uses persisted exact payloads and IDs
  (`packages/rpc/src/control/types.ts:75`, `packages/rpc/src/control/types.ts:103`).
- `verifyManagementCapability` takes no deny set and has no revocation hook; `bindingOfDID` reads
  the tree and returns an externally revoked device while its leaf remains. Survivor checks use
  only revocations folded from the group ledger. A synchronous `commitPolicy` can veto with
  preloaded state.
- Pending records carry frame/plaintext/sender but no opened epoch (`packages/rpc/src/crypto.ts:190`).
- Hozon combines stores in one transaction only when they come from the same transaction provider
  (`../hozon/packages/db/src/db.ts:208`, `../hozon/packages/db/src/db.ts:218`).
- Welcome and key-package traffic uses the public, secretless `discoveryTopic(memberDID)`.
- `hub-server` `createHub` `authorize` defaults to allow-any-authenticated. The hook sees the
  authenticated DID and topic, never bodies; coarse `receive` gets only the DID, `receive/deliver`
  gets DID and topic. Receive authorization is cached 5 s by default. `hubPlugin`/`createHubServer`
  let a host install `authorize`; `hubPlugin` does not take a direct `verifyToken`.
- Wake registration is per device DID with no topic selector, and both retention kinds wake offline
  subscribers. Hints are encrypted and coalesced.
- `hub-http` `createHubServer` is the production HTTP server, `hub-store` the durable Hozon store.
  Kumiai's integration suite reaches the hub in-process over `DirectTransports` except
  `hub-http.test.ts`, which uses a real socket but runs no peers.
- Kubun's `GroupHandleRegistry` persists ratchet state plus pending plaintext atomically for durable
  app-frame opens (tunnel decrypt uses a separate buffered path), reserves sender generations, and
  does versioned state writes. Restoring a handle needs credentials and the ordered signed ledger
  tokens alongside MLS state (`mls-state.ts`).
- `@kokuin/store-controller` and `@kokuin/store-delegation` are at 0.1.0 locally (registry status not
  checked). `store-delegation` replaces grants per `(grantor, audience, resource)`; revocation GC
  runs only when the caller schedules it. `store-controller` writes are last-writer-wins and callers
  must run the anti-truncation guard on untrusted logs first.
- `@hozon/expo` exists.

## Package layout

```
mls ─ mls-rpc (+ GroupHandleRegistry, MLSEncryptor, mls-state codec)
          │
rpc ──────┤  ports: GroupCrypto, GroupMLS, stores
          │
rpc-store  (new) Hozon impls of rpc stores + GroupStateStore
hub-client (+ reconnecting LogHub/MailboxHub over HTTP, scoped and buffered views)
mls-hub    (key-package pool / provisioner)
          │
client     (new) Device: identity + groups + hub connection
          │
messaging  (new) protocol definitions + Messenger
          │
tests/e2e  (new, private) DeviceDriver, hub fixture, scenarios
```

| Package | Change |
|---|---|
| `mls` | Spec P phase 2: version-2 lossless pending-proposal sender codec, configurable retention propagated through every constructor/recovery, non-mutating `commitKeyRotation` and private control builders exposing consumed handshake generations (r10 decision). Group-model changes from Spec I: bound creator in an unanchored group, Welcome admission for co-devices, role bootstrap/migration, revocation as ordered ledger evidence in unanchored groups, structured policy errors. |
| `rpc` | Spec P phase 2: opened epoch on pending records and every inbound application handler context (with supporting broadcast metadata); app attempt IDs, client `{sequenceID}` result and proof-time `remove(seq, outcome?)`; strict `decodeAppEntry`. Landed P2a `ControlStore` owns control/cursor; no CommitJournal. |
| `hub-client` | Phase 2 reconnecting HTTP hub, scoped/buffered views, ack backoff and discovery fetch. Preserve retention on reconnect/retry. Buffer injects inspectEpoch/currentEpoch/onEpochChanged; no MLS/registry import. Automatic `/info` integration remains BLOCKED (Risks). |
| `mls-rpc` | Phase 2 registry over memory `GroupStateStore`: asynchronous load/validated access, staged CAS, identity/lineage, confirmed lower-epoch recovery with separate tombstone floor, application lease/deferred burn and durable handshake reservations. Every installed epoch appends its authenticator; recovery/candidate/seed guard and lifetime tombstones preserve the spent set (r10 decision). Registry owns joinRef clearing and durable pending saves/ambiguity; HandleAccess gains seal/receive/buildControl/lineage and recovery mode. `MLSEncryptor` extraction uses committed membership snapshots and numeric receive counts (r8 decision). P2a recovery candidates encode complete version-2 sourceState; credential/token serialisation uses the lossless MLS codec (r8 decision). Hozon storage/projections remain adapters. |
| `mls-hub` | Landed P2a openWelcome/consume/receipt are prerequisites. Phase 2 publishes the complete nested openWelcome union (authenticator in joined.group.state.keySchedule), single-options judgeWelcomeAdmission and structural mirrors (r10 decision). Spent-first admission guards joined state/authenticator/joinRef save before consume; genuine readmission atomically resets control/anchor (Spec P D3). No Welcome digest. |
| `rpc-store` (new) | Phase 3 Hozon impls of `GroupStateStore`, `ControlStore`, `AnchorStore`, `AppCursorStore`, `AppOutbox` on sqlite, postgres and expo. MLS state, `AdoptionWrite` control changes and the anchor landed mark share one adoption transaction (Spec P2a). All writers share one root mutation gate and backend completion barrier, including independent anchor/cursor saves (r8 decision). Explicit factories and outcome-aware Hozon hook settlement are prerequisites (r8 decision). State/control/coordinated-outbox/anchor factories require host `atRest`; raw-byte/wrong-AAD cases cover anchor.secret (r10 decision). Passes `rpc-conformance`, extended per Spec P r10, including forbidden lineage changes. |
| `client` (new) | Phase 4 Device: identity/group verbs, one peer per group, inventory/pending/control restore, source-scoped Welcome consume sweep, rotation scheduling and stop/drain deletion; key-package provisioning and wake. |
| `hub-server` or a new `hub-authz` | The membership `authorize` policy and its state ingestion (Spec H decides placement). |
| `messaging` (new) | Phase 5 protocols, Messenger, MessageStore memory/Hozon impls; consumes phase-2 opened epoch and proof outcomes. Hooks atomically record acceptance/publication/failure with outbox writes. |
| `tests/e2e` (new, private) | Driver protocol and implementations, hub fixture, scenarios. |

New public packages join the shared version band. New transport, event, HTTP and logging
dependencies are declared per package. Kubun's projections (circles, catalog, credentials, ledger
ingest), its `processCommit` override and all of `sync/`, `context/`, `peer/` stay in Kubun.

### Lift classification

Verdicts copied from [phase 1 lift audit](2026-10-08-lift-audit.md), checked 2026-10-09:
5 MOVE, 6 EXTRACT, 8 REIMPLEMENT, 1 BLOCKED. Candidate paths are under
`../kubun/packages/plugin-p2p/src/`; source evidence uses that same prefix.

| File | Verdict | Treatment / source checked today |
|---|---|---|
| `groups/mls-codec.ts` | EXTRACT | Reuse existing MLS/crypto; preserve AAD/sender assertions, no duplicate codec (`../kubun/packages/plugin-p2p/src/groups/mls-codec.ts:14`). |
| `util/mutex.ts` | EXTRACT | Consolidate acquisition/deadline additions into existing MLS mutex (`../kubun/packages/plugin-p2p/src/util/mutex.ts:43`, `packages/mls/src/mutex.ts:15`). |
| `hub/http-client.ts` | MOVE | Generic HTTP factory; declare Enkaku dependencies (`../kubun/packages/plugin-p2p/src/hub/http-client.ts:33`). |
| `hub/peer-scoped-hub-view.ts` | MOVE | Mailbox filtering, retention and lifecycle (`../kubun/packages/plugin-p2p/src/hub/peer-scoped-hub-view.ts:51`). |
| `hub/sender-scoped-hub-view.ts` | MOVE | Include companion DeviceHub receive/filter type (`../kubun/packages/plugin-p2p/src/hub/sender-scoped-hub-view.ts:44`). |
| `hub/hub-like.ts` | MOVE | Reconnecting core; substitute logger, preserve retention replay (`../kubun/packages/plugin-p2p/src/hub/hub-like.ts:183`, `../kubun/packages/plugin-p2p/src/hub/hub-like.ts:529`). |
| `hub/ack-backoff.ts` | MOVE | Generic utilities; take @sozai/log logger (`../kubun/packages/plugin-p2p/src/hub/ack-backoff.ts:11`). |
| `groups/mls-encryptor.ts` | EXTRACT | Inject registry runtime access/notifications; use Spec P lease constants (`../kubun/packages/plugin-p2p/src/groups/mls-encryptor.ts:72`). |
| `groups/admin-roster.ts` | EXTRACT | Positioned convenience over existing foldRoster (`../kubun/packages/plugin-p2p/src/groups/admin-roster.ts:2`, `../kubun/packages/plugin-p2p/src/groups/admin-roster.ts:56`). |
| `groups/group-handle-registry.ts` | REIMPLEMENT | Generic registry over D3; Kubun projections/controller transactions stay (`../kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:1731`, `../kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:2091`). |
| `groups/mls-state.ts` | BLOCKED | G1 sender-zero preservation; Spec P r6 defines the codec prerequisite, cleared only when implemented/tested. Row mappings stay Kubun (`../kubun/packages/plugin-p2p/src/groups/mls-state.ts:39`). |
| `groups/group-crypto.ts` | REIMPLEMENT | Integrate registry into existing mls-rpc crypto; ownAgents guard stays host-side (`../kubun/packages/plugin-p2p/src/groups/group-crypto.ts:173`). |
| `groups/group-handle-access.ts` | REIMPLEMENT | Current HandleAccess including adoption/prepare; source mutate refuses (`../kubun/packages/plugin-p2p/src/groups/group-handle-access.ts:30`). |
| `groups/commit-journal.ts` | REIMPLEMENT | Superseded. Implement ControlStore in phase 3, never lift the legacy slot (`../kubun/packages/plugin-p2p/src/groups/commit-journal.ts:16`, `packages/rpc/src/control/types.ts:45`). |
| `groups/anchor-store.ts` | REIMPLEMENT | Keep landed mark and state/control/anchor co-commit (`../kubun/packages/plugin-p2p/src/groups/anchor-store.ts:19`). |
| `groups/app-cursor-store.ts` | REIMPLEMENT | Group-owned topic cursors; D3 deletes rows atomically (`../kubun/packages/plugin-p2p/src/groups/app-cursor-store.ts:19`). |
| `hub/buffered-peer-hub-view.ts` | EXTRACT | Inject inspectEpoch/currentEpoch/onEpochChanged; unsubscribe on dispose (`../kubun/packages/plugin-p2p/src/hub/buffered-peer-hub-view.ts:45`, `../kubun/packages/plugin-p2p/src/hub/buffered-peer-hub-view.ts:233`). |
| `hub/server-did.ts` | EXTRACT | Fetch only; persisted cache/change events stay Kubun. `/info` integration separately BLOCKED (`../kubun/packages/plugin-p2p/src/hub/server-did.ts:52`). |
| `groups/manager.ts` | REIMPLEMENT | Keep domain file; re-express generic group workflows in client (`../kubun/packages/plugin-p2p/src/groups/manager.ts:455`). |
| `groups/group-peer-manager.ts` | REIMPLEMENT | Keep domain file; re-express ownership/drain/control workflows in client (`../kubun/packages/plugin-p2p/src/groups/group-peer-manager.ts:1470`). |

## Group model

- **Messaging groups** are multi-user: `anchor.controller` is unset, and each leaf binds to its own
  device's controller through an embedded leaf proof. Roles come from the mls roster.
- Spec I settles, with mls changes:
  - creating an unanchored group with a controller-bound creator;
  - Welcome admission for a co-device added by `addDevice` (authenticated device-add entry, or an
    admin-issued role);
  - role bootstrap and migration, given policy resolves `controller ?? device` (a creator
    registering its device must not strand its device-admin role or redirect authority to an
    ungranted controller);
  - revoking a device that holds a direct device-admin role (that protection precedes the
    device-revoke carve-out today);
  - controller removal versus leaf removal, and whether surviving co-devices may restore a removed
    device;
  - roles of removed subjects (they persist today);
  - revocation as ordered ledger evidence, with its enactment authority (see Revocation
    guarantees).
- **Personal device-sync groups** (`anchor.controller` set) are out of scope for messaging.

## `@kumiai/client`

```ts
const device = await createDevice({
  identity,            // device keypair
  db,                  // Hozon provider: rpc-store + kokuin stores + mls-hub stores
  atRest,              // required host codec forwarded to state/control/outbox/anchor factories (r10 decision)
  hub: { url },        // reconnecting hub-client
  wake?: { token, platform },
  logger?,
})
device.identity.controller            // did:kokuin, or undefined for a standalone device
device.groups.create()
device.groups.invite(groupID, did)    // did: a device, or a controller (all its devices)
device.groups.join()                  // also automatic on incoming welcome
device.groups.remove(groupID, did)
device.groups.setRole(groupID, did, 'admin' | 'member')
device.groups.leave(groupID)
device.devices.link(newDeviceDID)     // controller side; returns the grants
device.devices.revoke(deviceDID)
device.peer(groupID): GroupPeer       // protocols attach here
device.events                         // group:joined | group:removed | roster:changed
                                      // | epoch:changed | device:revoked
await device.dispose()
```

### Flows

Identity details are settled in Spec I; this section fixes the shape.

- **Invite/join.** The admin fetches key packages and enqueues a P2a invite operation. Its durable
  Welcome obligation publishes the complete invitation to each device's public discovery topic.
  The invitee uses landed `openWelcome` (`packages/mls-hub/src/join.ts:26`, `packages/mls-hub/src/join.ts:31`).
  The r10 contract uses joined.group.state.keySchedule.epochAuthenticator for spent-first admission, then atomic state/authenticator/source-scoped joinRef save before consume (r10 decision).
  judgeWelcomeAdmission takes one options object; Spec P publishes its signature, the full openWelcome union and structural mirrors.
  Repeated receipts return alreadyJoined (`packages/mls-hub/src/join.ts:50`). Genuine readmission stops/drains the old peer;
  Spec P D3 atomically installs joined state and resets control/anchor, retaining outcomes/Welcomes.
  Exact and alternate A3 bytes after A4 → confirmed lower B2 recovery are refused by the same authenticator (r10 decision).
  An unspent lower-branch Welcome remains eligible against current epoch.
  Inviting a controller adds every
  device it currently grants (Spec I).
- **Device link.** The controller issues the new device a leaf-binding capability and, if it may
  manage co-devices, a leaf-key-pinned `manage` capability on `kumiai/devices`. The new device
  receives them out of band (direct handoff in tests, a QR code on a phone) and calls
  `registerDevice`. In each group, a device of the same controller holding `manage` commits
  `addDevice`. **A linked device starts at its admission epoch**; it does not receive earlier
  messages (see [Deferred](#deferred)).
- **Device revoke.** The controller publishes the revocation. In each group, a device of the same
  controller holding `manage` commits `revokeDevice`. The hub refuses the revoked device (Spec H).
- **Revocation guarantees.** Management grants authenticate against embedded proofs at issuance;
  unanchored groups keep a tree-time expiry check but no wall-clock freshness. A controller
  revocation therefore does not by itself stop a revoked manager in MLS, and checking each member's
  local `store-delegation` state at commit validation would be nondeterministic (members hold
  different revocation sets and could fork). The umbrella guarantees:
  1. Revocation enters a group only as **evidence in the ordered group ledger** (authenticated
     controller-log deny events, or equivalent verified revoke entries). Validation of device and
     management entries rejects denied issuers using the agreed pre-commit state, so every member
     decides identically. This is an mls change: today envelope folding rejects proof-bearing
     device entries without lifecycle context, and live proof verification requires an anchored
     controller and a same-controller issuer. The cryptographic verification of a named
     controller's chain needs no anchor.
  2. The revoked device is excluded from MLS when a commit **atomically adopts the verified
     revocation and the removals it requires** (today `revokeDevice` already pairs the deny entry
     with the Remove; an ordinary admin removal does not create a permanent deny). Revocation alone
     does not reject the revoked device's other otherwise-valid commits before that; tree-time
     expiry still applies. There is **no unconditional time bound**: if no authorized survivor is
     online, exclusion waits.
  3. External stores (`store-delegation`, `store-controller`) only trigger that commit and feed hub
     refusal (Spec H); they never gate commit validation directly.

  Spec I specifies, for unanchored multi-controller groups:
  - the ledger evidence format and the pre-commit validation;
  - **enactment authority**: who may relay revocation evidence into a group (today ordinary
    `revokeDevice` needs a same-controller manager, anchored proof enactment a same-controller bound
    device; cross-controller members cannot). Any-member relay is acceptable only with the checks
    below;
  - binding the evidence to the target's pre-commit controller, per-controller authenticated history
    and generation floors, and deriving the exact removals;
  - deterministic rejection of forged, detached, superseded and duplicate evidence. A signature
    alone does not prove freshness: kokuin permits deny replacement and cannot detect unseen later
    history on first encounter;
  - whether a group revocation is terminal even if the controller later re-authorizes the device;
  - grant expiry/renewal, controller key rotation/reset and loss of the last manager device.
- **Two resolution paths, kept separate.** External controller resolution: fetch, guard against
  truncation, and store controller logs (`store-controller`) and grants/revocations
  (`store-delegation`). Embedded leaf proofs: built at link time, carried in the leaf, verified by
  the mls embedded resolver without external fetches.
- **Restore.** Inventory includes credential and ordered signed ledger. The host restores live
  groups through awaited registry.access and sweeps joinRef through its owning source's consume (r8 decision).
  It calls registry.clearJoinRef with that exact ref (Spec P D3).
  Peers restore pending receives and replay P2a operations/rejoins/outcomes/Welcomes in P2a startup order.
  Tombstones never start peers; terminal removed groups only serve control outcomes/Welcomes.
- **Rotation/deletion.** Client schedules one rotation per epoch identity outside the registry gate.
  Private control builds expose and durably reserve their handshake generation before HostBuilt returns (r10 decision).
  A poison-head mismatch rebuild merges reserved source handshake HWM and uses a higher generation, including after restart.
  New sends reject rotation-required; accepted entries wait. Deletion blocks owner creation,
  disposes/drains the peer, then takes their shared root mutation gate before the atomic tombstone/status
  transaction (Spec P D3). Drain includes frozen proof removals and every adapter's ambiguity resolver (r8 decision).
  Welcome replacement uses the same lifecycle order. Unsettled control refuses deletion; explicit abandon/ack remains the escape.
  Tombstones retain all spent epoch authenticators; exact/alternate Welcome replay cannot resurrect a deleted group (r10 decision).

### Errors

Coded errors: `NOT_GROUP_ADMIN`, `LAST_GROUP_ADMIN`, `NOT_DEVICE_MANAGER`, `DEVICE_REVOKED`,
`KEY_PACKAGE_UNAVAILABLE`, `NOT_A_MEMBER`, `HUB_REFUSED`. The mls commit policy stays authoritative;
`client` maps its structured errors to these codes and adds no parallel authorization check.

## Hub authorization (Spec H)

The hub's allow-any default is not acceptable for this stack. Spec H designs a membership
`authorize` policy and must answer:

- **Action/topic matrix.** One row per action (publish, subscribe, fetch, `receive`,
  `receive/deliver`, key packages, wake) and topic kind (public discovery, commit, rendezvous, app
  topics across rotation, inbox topics). Group-derived topics require current membership.
- **Discovery topics.** They carry pre-group Welcome rendezvous and are enumerable by design.
  Subscribe, fetch and delivery on `discoveryTopic(did)` are restricted to the device owning `did`.
  Publishing needs sender and target quotas or invitation authorization (Welcome spam). The hub's
  key-package RPCs are a separate path with their own target-aware authorization and destructive
  consumption; Spec H states their quotas, relying on the existing requester/target limits and the
  last-resort fallback against exhaustion.
- **Unseen devices.** Authentication proves only control of a DID; the authorize request carries no
  controller binding or grant. Spec H defines how a new device registers its controller evidence
  with the hub, and how that evidence stays fresh.
- **Device validity on every delivery.** `receive` is checked only at channel open, so validity is
  checked again immediately before each frame is written, after any backpressure wait
  (`writer.ready`), not only when the frame is queued. The bound is defined at write initiation:
  no frame **starts** being written later than the bound after the policy update. Data already
  handed to the transport is accounted for separately and may still arrive.
- **Admission ordering.** Denied frames are not retried when policy changes; the hub requires a
  reconnect, which also discards the channel-local deny cache. A newly admitted member reconnects
  and refetches after the hub adopts the new roster (client-side only), or waits for an adoption
  acknowledgement (needs an ingestion/ack contract). Spec H picks one.
- **Responsibilities.** Spec H lists, per requirement, what is `authorize` policy and what needs a
  hub change:

  | Requirement | Where |
  |---|---|
  | Discovery owner restriction | Policy: compare the DID against `discoveryTopic(did)`; topic classification is policy state. |
  | Unseen-device registration | New evidence-ingestion path: a host endpoint, or a hub RPC (protocol and server change). |
  | Validity after `writer.ready` | `hub-server` change: the gate runs before backpressure today. |
  | Admission by reconnect | Client only. |
  | Admission by acknowledgement | Ingestion/ack contract. |
- **Genesis trust and topic binding.** How the hub learns that a topic belongs to a group and who
  its founding authority is.
- **Membership evidence.** What a member presents so the hub can adopt a new roster: accepted-commit
  evidence, not merely an authentic statement. Authentic-but-unauthorized and stale statements are
  rejected; forks and revisions have a defined outcome.
- **Revocations.** How controller revocations reach the hub and when they take effect. The 5 s
  receive cache bound starts when the policy state updates, not when the revocation is published,
  and it bounds write initiation only (see above); backpressure can delay an already-authorized
  frame indefinitely.
- **Durability.** Policy state survives a hub restart (`hub-store`).

Until phase 4 the e2e hub fixture runs with allow-any and the gap is documented in the suite.

## `@kumiai/messaging`

### Protocols

Two protocols attach per group via `device.peer(groupID)`, so they derive two topics.

| Protocol | Item | Kind | Retention | Payload |
|---|---|---|---|---|
| `kumiai.messaging` | `message` | event | `log` | `{id (ULID), sentAt, body: {type: 'text', text}, replyTo?: {author, id}}` |
| `kumiai.messaging.signals` | `receipt` | event | `ephemeral` | `{upTo: {author, id}, kind: 'delivered' \| 'read', at}` |
| `kumiai.messaging.signals` | `typing` | event | `ephemeral` | `{active: boolean, at}` |

- **Author** is the MLS-authenticated sender (`ctx.message.payload.iss`), never a payload field.
  There is no application-level signature: live authorship is MLS's, and pre-link history is out of
  scope.
- **Message identity** is `(groupID, author, id)`. Content is fixed at `send()`; re-sealing after an
  epoch change re-encrypts the same plaintext.
- **Epoch.** The handler records the authenticated epoch the frame opened in. Pending decrypted
  records persist that epoch so a durable restore keeps it (Spec P; `frame.segment` is the app
  anchor epoch, not the opened epoch).
- **Authorship holds on every delivery path** (Codex r3): live delivery refuses unnamed senders,
  catch-up uses the opened sender, durable restore uses the atomically persisted sender, and
  cross-topic replay fails AAD binding.

### API

```ts
const messenger = createMessenger({ device, store })   // store: MessageStore
await messenger.send(groupID, text)                     // returns a pending Message
messenger.list(groupID, { before?, limit })
messenger.markRead(groupID, { author, id })
messenger.setTyping(groupID, active)
messenger.events                                        // message | message:status | receipt | typing
```

### Semantics

- **Order.** Per device, a message's position is the hub `(segment, position)` of the occurrence
  whose **durable acceptance into `MessageStore` came first** on that device; topic rotation orders
  by segment. Later occurrences are deduplicated by `(groupID, author, id)` and never move it. Live
  delivery can precede an older retained pull, and epoch retries or rejoin resends can publish the
  same plaintext twice, so devices may disagree on the relative order of such a message; accepted
  (chat apps order per device). Pending local messages sort last until their own position is known.
- **Attempt identity.** Each app seal gets a fresh publishID and anchor segment. Persist only
  attempt metadata, never app ciphertext/acknowledgement proof. In-process handoff retries retain
  exact bytes/ID in memory. Restart or identity/segment invalidation reseals unproven entries with
  new IDs; receivers dedup message identity. Unproven acknowledgements and both proof paths retain
  authenticator/lineage identity, including same-number recovery. Already-proven removal outcomes stay frozen (Spec P D6).
  There is no app 365-day ambiguity rule. P2a control and
  rejoin payloads retain exact durable-byte replay (`packages/rpc/src/control/types.ts:75`,
  `packages/rpc/src/control/types.ts:103`).
- **Publish status.** `pending → accepted → published (position known)`. Coordinated put commits
  outbox/message rows together before acceptance resolves. Publication returns client `{sequenceID}`;
  store-only deduped is not part of that HTTP result (`packages/hub-protocol/src/protocol.ts:49`).
  Acknowledgement is not proof. rpc freezes the certified publication's segment/sequenceID and calls
  `remove(seq, {segment, position})`, the new optional outcome parameter. Published status/position
  commits with removal; failed removal retries the same outcome, including through self-removal and disposal drain (r8 decision).
  Clear/deletion follows frozen proof settlement, then fails remaining unpublished messages in its transaction (r8 decision).
  Hooks correlate by message identity decoded from entry.data, not seq.
  Ambiguous commit retains both hook queues; barrier-proven settlement runs exactly one queue before caller resolution (r8 decision).
  Phase 2 shares one memory transaction and opaque host rows; real MessageStore wiring lands in 5.
- **Ingestion.** At-least-once handler execution; `MessageStore.put` is idempotent on
  `(groupID, author, id)` and durable before the handler resolves, so rows are never lost or
  duplicated. A duplicate resolves successfully so pending completion and the cursor advance.
  Content is immutable: a second put with the same key and different content keeps the first row,
  logs the conflict and **consumes the frame successfully**. Throwing would block the durable
  worker, which retries its first failed record.
- **Receipts.** `upTo` names a message; receipts compare by that message's position on the
  receiving device. Two watermarks per `(member device, group)`, `delivered` and `read`, each
  monotonic; `read` implies `delivered`. A receipt whose `upTo` is unknown or still pending is held
  until the message has a position: at most 100 held receipts per group (on overflow the oldest
  held receipt is evicted), each dropped after 10 minutes. Per-user state is the maximum over that controller's devices. A member can misreport its
  own receipts; accepted.
- **Typing.** State per `(member device, group)` keeps the latest `at`; an update with an older
  `at` is ignored and an equal `at` replaces (last arrival wins), so a stale `active: false` cannot clear a newer `active: true`. Expires locally
  5 s after `at`. Arrival with `at` older than 5 s, or more than 5 s in the future, is ignored.
  Senders rate-limit to one per 2 s.
- **Retention.** Receipts and typing are not in the pullable log. Mailbox frames queue for
  subscribers other than the publisher and expire after the hub's mailbox TTL; an offline member
  may get them after reconnect or not at all. No-loss criteria apply to messages only.
- **Removed members.** Their past messages stay attributed to them.

### Wake

Every publication wakes offline subscribers, including receipts and typing; the hub coalesces hints
and its rate limiter bounds spam. The hub sees publisher, topic and subscriber relationships and push
adds timing correlation; accepted metadata exposure. Message-only wake is deferred.

## `tests/e2e`

### Driver

One Enkaku protocol (`e2e/v1`) with three transports. A device under test runs a small agent that
exposes `Device` and `Messenger` commands plus an event stream.

```ts
interface DeviceDriver {
  call<M extends Command>(method: M, args: Args<M>): Promise<Result<M>>
  waitFor<E extends EventName>(event: E, predicate, opts: { timeoutMs }): Promise<Event<E>>
  restart(): Promise<void>                  // graceful stop + start on the same db
  crash(point?: CrashPoint): Promise<void>  // child-process: SIGKILL, optionally at a named point
}
```

- **In-process**: the agent shares the test process, over `DirectTransports`.
- **Child-process**: a node child process, over the Enkaku stdio transport.
- **Crash points** follow arm → trigger → boundary reached → SIGKILL. The test arms a named point,
  triggers the action, the process blocks at the boundary and reports it, and the driver kills it.
  Boundaries inside `rpc` and `mls-rpc` (pending completion, cursor advance, acknowledgement
  bookkeeping, control apply) need wrapping stores/hub clients that pause before or after atomic calls.
  Spec P and P2a list the seams; no production pause hooks.
- **Simulator (future)**: the Expo app in `tests/e2e-expo` embeds the same agent over HTTP. Scenarios
  run unchanged.

### Hub fixture

`createHubServer` on a random port with `hub-store` on a tmpdir sqlite (opt-in postgres via the
existing testcontainers setup), a capturing `WakeSender`, a mock Expo push endpoint for the real
`createExpoSender`, and `hub.restart()`. Allow-any `authorize` until phase 4, then the Spec H policy.

### Scenarios

1. Two users 1:1: send/receive, ordering, publish status, receipts, typing (including stale and
   future `at`).
2. Three members: invite, remove. The removed member cannot decrypt later messages. After phase 4,
   the hub also refuses its fetch and `receive/deliver` once the cache window has passed.
3. Roles: promote/demote; a non-admin remove fails with `NOT_GROUP_ADMIN`; demoting the last admin
   fails with `LAST_GROUP_ADMIN`.
4. Multi-device: a group created by a controller-bound device; link a second device, which joins at
   its admission epoch and receives new messages; revoke a lost device, which is excluded once the
   revocation-and-removal commit is adopted, and refused by the hub.
5. Offline device: a publication wakes it (captured sender and mock Expo endpoint); it reconnects and
   catches up with no duplicates.
6. Concurrent admin commits converge to the same epoch and roster on all devices; a losing
   invite/remove is re-enacted or reported, never silently dropped.
7. Adversarial:
   - a payload claiming a different author has no effect (author is `iss`);
   - a frame replayed from another group or topic: rejected;
   - a replayed frame in the same group: deduplicated;
   - install Welcome A3, advance A4, confirm lower recovery B2, reconstruct: exact/alternate A3 (same authenticator, different bytes) both refused (r10 decision);
   - install, delete and reconstruct a group, then replay its Welcome: refused, tombstone and spent epoch set preserved (r10 decision);
     both replay cases cover ordinary and last-resort sources, including replay before ordinary consume;
   - poison/refused frame advances hub head without MLS advancement; rotation rebuilds use strictly increasing handshake generations, including after restart (r10 decision);
   - matching-CAS ordinary state write increases lineage with unchanged identity, or any write decreases lineage: refused on doubles and real stores (r10 decision);
   - raw storage exposes no anchor.secret; wrong-AAD anchor opens and ciphertext swaps reject (r10 decision);
   - a truncated controller log offered for a known controller: refused;
   - a false controller binding in a leaf: refused;
   - a revoked manager device attempting `addDevice` after the revocation evidence is enacted in the
     group ledger: rejected identically by every member;
   - Welcome spam to another device's discovery topic and subscribing to it (phase 4): refused;
   - same author reusing an `id` with different content: first row kept, conflict logged;
   - hub (phase 4): authentic-but-unauthorized membership statement, stale statement, revoked
     device on an already-open channel: all refused.
8. Child-process crash points, each followed by restart and a no-loss, no-duplicate assertion:
   - after decrypt, before the atomic ratchet-plus-pending save;
   - after that save has committed, before message persist ("after" a save always means after its
     transaction commits, not after the write call returns);
   - after message persist, before pending-frame completion;
   - after pending completion, before cursor advance;
   - after outbox accept, before publish;
   - after hub acknowledgement, before publication bookkeeping;
   - after proof, before published-status/outbox removal;
   - lease reserved, before seal;
   - handshake generation reserved, before control built persistence/publication (r10 decision);
   - joined state saved, before source consume;
   - Welcome readmission committed, before peer restart (state/control/anchor reset);
   - group deletion committed, before restart;
   - P2a intent/built/accepted and state/control/anchor co-commit seams, plus rejoin and Welcome delivery.
   Plus hub restart (durable delivery), device restart (groups restored), and a message published
   twice (epoch retry) observed by two receivers, including across topic rotation: each keeps one
   row.

### Rules

- No sleeps. Every wait is `waitFor` with a deadline, polling the last-settling state.
- Mutation checks for a named guard list, kept in the e2e README: author-is-`iss`, cross-group
  rejection, dedup, receipt monotonicity, typing staleness, controller-log truncation refusal, hub
  membership gate, revoked-device gate. Each guard is broken, the test must fail, then restored.
- CI runs the in-process suite on every push. The child-process suite also runs in CI and stays
  small.

## Phases

Each phase gets its own plan and branch. The e2e suite grows with each phase.

0. **Spec P: transactional persistence (draft r10).** Phase-2 contracts, identity-aware state CAS,
   atomic pending/adoption/Welcome reset, lossless codec prerequisite, lease/rotation, opened-epoch
   metadata, identity-bound app proof and coordinated outbox contracts. Memory doubles model unfinished COMMIT, completion barriers and retained hook queues.
   Recovery sourceState encoding, async access, tunnel runtime and shared factory signatures belong to phase 2 (r8 decision).
   Confirmed recovery may lower current epoch while preserving the tombstone floor. Landed P2a owns control.
   Spent-epoch admission amends P2a D4; every installed epoch appends its authenticator, retained across recovery/deletion (r10 decision).
   Complete Welcome signatures/mirrors, durable handshake reservations and forbidden lineage-change cases are binding (r10 decision).
   Host-injected at-rest codec, raw-byte checks and wrong-AAD rejection apply to state/control/outbox/anchor stores (r10 decision).
1. **Lift audit (probe).** Verdicts copied above. G1 codec prerequisite is specified in P r6;
   automatic `/info` integration remains separately BLOCKED.
2. **rpc/mls/mls-rpc/mls-hub/rpc-conformance/hub-client port and runtime additions on memory doubles.**
   Follow Spec P's implementation order: state/recovery codecs, retention/rotation, async registry/access, D4 metadata,
   D6 attempts/outcomes/terminal proof settlement, D7 decoder/shared transaction fixtures, encryptor and hub-client lifts (r8 decision). D4 includes only
   necessary optional metadata forwarding through broadcast. Both contract suites cover real
   implementations and affected doubles; repo-wide type tests pass. No client/messaging/Hozon adapters.
   e2e: allow-any real HTTP hub, injected server DID, in-process two-device group-peer smoke with
   real MLS, invite/join, send/epoch/proof, rotation/resume and memory-store runtime reconstruction.
   Required deterministic test codec, including anchor raw-byte/wrong-AAD checks; exact/alternate Welcome and spent-candidate refusal after recovery/deletion (r10 decision).
   Poison-head mismatch rotation rebuild/restart uses strictly increasing handshake generations; doubles reject unauthorised lineage changes (r10 decision).
3. **rpc-store.** Hozon state/control/anchor/pending/cursor/outbox implementations, coordinated hooks,
   tombstone deletion, root-provider discriminator and outcome-aware hook prerequisites (r8 decision). Provider conformance on sqlite,
   postgres and expo (node shim or explicit BLOCKED reason); state/control/anchor atomicity and
   commit ambiguity verified here. e2e devices on sqlite; restart restores groups.
   State/control/coordinated-outbox/anchor factories require the host codec; provider encryption alone does not satisfy the contract (r10 decision).
4. **Spec I and Spec H, then mls group changes, client and hub policy/server changes.**
   Gated on published kokuin stores. Client wires ownership, inventory/pending/control restore,
   Welcome consume sweep, rotation scheduling and deletion draining. e2e scenarios 2, 3, 4, 6 and
   identity/hub cases of 7.
5. **messaging.** Consume phase-2 opened epoch/proof outcomes; MessageStore, coordinated acceptance/
   publication/failure hooks and status events. e2e scenarios 1, 5 and messaging cases of 7.
   Expo bundle check joins CI. Handler epoch exposure is already phase 2, not a phase-5 port change.
6. **Child-process driver and scenario 8.** SIGKILL/restart at Spec P/P2a seams. Earlier in-process
   reconstruction/failure tests do not establish child-process crash coverage.

Kubun adoption is out of scope: a separate spec in the Kubun repo once these packages publish.

## Deferred

Recorded in `docs/agents/plans/backlog/` when this spec is approved:

- **Verifiable pre-link history.** A newly linked device fetching earlier messages from a peer
  needs an authenticated archive of historical membership, leaf keys, controller bindings and
  transcript checkpoints, plus signed envelopes that survive rpc's re-seal retries. Two reviews
  showed both are absent today.
- **Message-only wake.** Needs a hub wake-selection contract (per-topic or per-protocol
  registration) with conformance cases covering topic rotation and membership changes.

## Risks

- **Automatic discovery integration BLOCKED.** Fetch requests origin `/info`
  (`../kubun/packages/plugin-p2p/src/hub/server-did.ts:53`), but kumiai mounts default `/hub`
  (`packages/hub-http/src/plugin.ts:41`, `packages/hub-http/src/plugin.ts:80`); server composition
  installs no `/info` producer (`packages/hub-http/src/server.ts:39`). Before claiming URL-only
  connection, provide an endpoint or injected discovery strategy. Phase-2 smoke injects server DID.
  This does not block the fetch-file extraction.
- **Lift drag.** The coupled registry is re-implemented, not moved; Kubun keeps adapters.
- **Kokuin publication.** Phase 4 implementation blocks until both stores publish.
- **mls group-model changes.** Touch policy and Welcome admission; reviewed blind, with both
  conformance suites run against the real implementation and the doubles.
- **Hub authorization ingestion.** A new trust path into the hub. Designed in Spec H, reviewed
  blind.
- **Flake.** Real sockets and child processes. Mitigated by deadline-based waits and a small
  child-process suite.
