# Client host, messaging protocol and multi-device e2e — design

Date: 2026-10-08
Status: approved r6 (2026-10-08), reconciled with Spec P draft r14 (2026-10-09)

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

**Spec P r14 model (r14 decision).** The hub is a strongly consistent DS trusted for ordering/CAS and availability,
never confidentiality/authenticity. Fork evidence durably halts all sends/control, keeps history and emits `group:fork`;
there is no automatic fork recovery. Exposed epoch authenticators support host out-of-band comparison because consistent
split views evade local detection ([RFC 9750 §5.2](https://www.rfc-editor.org/rfc/rfc9750.html#section-5.2)).
Stranded devices without fork evidence automatically external-resync; the host alone selects manual fork recovery routing.
Recovery/readmission installs a new local incarnation and tombstones the previous record atomically.
Epoch state, control, anchors, pending/outbox/cursors and local order belong to that incarnation.
The group-level spent-authenticator set survives every incarnation and tombstone.
Unpublished abandoned entries fail with a durable machine-readable event. Hosts may retry programmatically. No automatic reseal occurs.

Control builds persist exact bytes, ID and candidate before publication.
Head-only mismatch reconciles the log, then republishes those bytes when incarnation/epoch/authenticator still match.
Only epoch advancement permits another private build. No handshake reservations, budgets or baseline readers remain.

Every durable group transition uses one group-scoped provider transaction.
Adaptive batches default to 64 frames, 2 ms maximum coalescing delay and 8 ms staging work.
An idle lone frame starts immediately. Burst batches release the group scope and interleave control, other lanes and enqueue work.
Ready control and another lane complete within three total A/B/control batches, including the active A batch. Groups have independent scheduling.

Ephemeral RPC/signals create no outbox/pending records or transactions. They use previously reserved application keys.
Default durable handlers run outside transactions, at least once, with a stable idempotency key.
Opt-in handlers receive the group transaction and co-write effects with completion/cursor advancement, without network I/O.
MessageStore uses that same transactional-or-idempotent boundary.
Self-removal drains opened handlers before clearing. Certified settlement obligations retain the sealed topicID.
All persisted namespaces use the host at-rest codec. Completion barriers and outcome-aware hooks cover ambiguous commits.

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
rpc-store  (new) Hozon group persistence + transaction-bound rpc stores
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
| `mls` | Spec P phase 2: lossless v2 state/recovery codecs, propagated retention and non-mutating non-admin key rotation. Private controls use commit-once; external resync replaces the old leaf with fresh chains. Spec I supplies bound creators, co-device admission, role migration, ordered revocation evidence and policy errors. |
| `rpc` | Spec P phase 2: incarnation-scoped ControlStore, commit-once queue, durable fork halt/manual recovery, stranded resync, fair adaptive batches, opened epoch/idempotency metadata and transactional handler opt-in. App attempts, durable status events, proof-time settlements and strict decodeAppEntry. Terminal opened-handler drain remains. |
| `hub-client` | Phase 2 reconnecting HTTP hub, scoped/buffered views, ack backoff and discovery fetch. Preserve retention on reconnect/retry. Buffer injects inspectEpoch/currentEpoch/onEpochChanged; no MLS/registry import. Automatic `/info` integration remains BLOCKED (Risks). |
| `mls-rpc` | Phase 2 registry over group transaction memory stores: awaited validated access, monotonic incarnations, spent admission, application leases/rotation and atomic open/adoption/switch. Resync installs a new incarnation; recovery never merges old progress. Extract MLSEncryptor over committed membership snapshots. Recovery v2 stores complete sourceState. |
| `mls-hub` | Landed openWelcome/consume/receipt remain. Spent-first admission uses authenticated group state. Newer live Welcome or any unspent Welcome after tombstone starts the next incarnation. Group install commits before external source consume. |
| `rpc-store` (new) | Phase 3 group-scoped Hozon transactions across every kumiai namespace and opted-in host effects. Explicit root scope and outcome-aware hooks. sqlite/postgres conformance, Expo support or explicit blocked reason. Host at-rest codec covers anchors, cursors, topicIDs, spent set and durable events. |
| `client` (new) | Phase 4 Device: identity/group verbs, one peer per active incarnation, halt-first safety/control/pending restore and manual target selection, Welcome consume sweep, rotation and lifecycle drain. Retired outcomes/Welcomes/status events remain serviceable. Key-package provisioning and wake. |
| `hub-server` or a new `hub-authz` | The membership `authorize` policy and its state ingestion (Spec H decides placement). |
| `messaging` (new) | Phase 5 protocols, Messenger and MessageStore. Use the common idempotent or transactional handler model for ingestion and status effects. Incarnation-aware local order/read watermarks and per-anchor peer receipts. Failed-outbox events permit host retry. |
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
| `groups/group-handle-registry.ts` | REIMPLEMENT | Generic registry over Spec P group persistence; Kubun projections/controller transactions stay (`../kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:1731`, `../kubun/packages/plugin-p2p/src/groups/group-handle-registry.ts:2091`). |
| `groups/mls-state.ts` | BLOCKED | G1 sender-zero preservation; Spec P D5 defines the codec prerequisite, cleared only when implemented/tested. Row mappings stay Kubun (`../kubun/packages/plugin-p2p/src/groups/mls-state.ts:39`). |
| `groups/group-crypto.ts` | REIMPLEMENT | Integrate registry into existing mls-rpc crypto; ownAgents guard stays host-side (`../kubun/packages/plugin-p2p/src/groups/group-crypto.ts:173`). |
| `groups/group-handle-access.ts` | REIMPLEMENT | Current HandleAccess including adoption/prepare; source mutate refuses (`../kubun/packages/plugin-p2p/src/groups/group-handle-access.ts:30`). |
| `groups/commit-journal.ts` | REIMPLEMENT | Superseded. Implement ControlStore in phase 3, never lift the legacy slot (`../kubun/packages/plugin-p2p/src/groups/commit-journal.ts:16`, `packages/rpc/src/control/types.ts:45`). |
| `groups/anchor-store.ts` | REIMPLEMENT | Keep landed mark and state/control/anchor co-commit (`../kubun/packages/plugin-p2p/src/groups/anchor-store.ts:19`). |
| `groups/app-cursor-store.ts` | REIMPLEMENT | Incarnation-scoped topic cursors share group transactions (`../kubun/packages/plugin-p2p/src/groups/app-cursor-store.ts:19`). |
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
  atRest,              // required host codec for all persisted group namespaces
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
device.groups.epochAuthenticator(groupID) // committed epoch/authenticator for host comparison
device.groups.reportFork(groupID, evidence) // durable halt, including out-of-band mismatch
device.groups.recover(groupID, { mode: 'resync', targetID }) // explicit chosen hub/commit topic
// or { mode: 'successor', successor: { groupID, incarnation } }, already joined by the application
device.devices.link(newDeviceDID)     // controller side; returns the grants
device.devices.revoke(deviceDID)
device.peer(groupID): GroupPeer       // protocols attach here
device.events                         // group:joined | group:removed | roster:changed
                                      // | epoch:changed | incarnation:changed | group:fork | outbox:failed | device:revoked
await device.dispose()
```

### Flows

Identity details are settled in Spec I; this section fixes the shape.

- **Invite/join.** The admin enqueues a P2a invite. Its Welcome obligation delivers the complete invitation at least once.
  The invitee opens without consuming and derives the authenticated groupID/epoch/authenticator.
  Spent authenticators refuse exact and alternate representations across incarnations and tombstones.
  A single group transition installs joined state, spent authenticator, joinRef, control and anchor.
  Initial join starts incarnation 1. Newer live Welcome starts the next incarnation after peer stop/drain.
  A tombstone accepts any unspent authenticated Welcome into the next incarnation, without an epoch floor.
  Only then consume the source package/receipt and clear joinRef through the registry.
  Receipt-only repeats never install state. Last-resort sources still require spent admission.
  Inviting a controller adds every device it currently grants (Spec I).
- **Fault detection/fork halt (r14 decision).** Retain digest divergence, ahead, own-unmerged, unknown-version and retention-gap observations with confidence.
  Either divergence branch or a host same-epoch authenticator mismatch co-writes halt/evidence/stable event. No sends (including signals),
  new opens, control or automatic recovery resume after restart or event ack. Unsupported versions hold rather than trigger a resync bypass.
- **Stranded recovery (r14 decision).** Without fork evidence, retention/unprocessable gaps or lost MLS state automatically request sealed,
  authenticated GroupInfo and resync via Remove(own old leaf)+ExternalInit. Fresh leaf/secret tree starts at generation zero.
  Publish exact durable external bytes with CAS; retry them at unchanged epoch, fetch fresh GroupInfo before rebuilding at a new epoch.
  Normal replacement policy/holder evidence and exact-external-commit confirmation remain. No separate lower-epoch candidate approval/source-prefix scan.
- **Manual fork recovery (r14 decision).** Host calls recover with a registered targetID or already admitted successor.
  The application supplies hub/topic routing; ReInit carries no routing ([RFC 9420 §12.1.5](https://www.rfc-editor.org/rfc/rfc9420.html#section-12.1.5)).
  Same-group resync atomically tombstones n/installs n+1; a successor is admitted separately before retiring the halted source.
  Authorisation/target persists; failed/refused attempts keep the halt. Drain opened records first. Copy no epoch state.
  Old operations become unknown; outcomes/Welcomes remain under n. Certified entries publish; other outbox entries fail with durable events.
  History stays and hosts may retry failed sends programmatically; no automatic reseal.
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
- **Restore.** Inventory includes incarnation, credentials and ordered signed ledger.
  Load durable fork halt before enabling sends/control/recovery. Await validated registry access; lost MLS bytes use stranded recovery only with lifetime metadata. Consume each owning source joinRef, then clear the exact ref.
  Restore opened records and P2a stages before normal delivery. Tombstones never start peers.
  Storage-only workers serve retired outcomes, Welcomes and durable status events.
  A terminal incarnation restores and awaits every opened handler/completion before clearing.
  It performs no new opens/decryption/publication. Live self-removal uses the same drain.
- **Rotation/deletion.** Schedule one rotation per source identity outside the group gate.
  Save a private build once. A poison-head mismatch republishes identical bytes/ID after reconciliation.
  Epoch advancement permits rebuilding. Deadline/outcome ack cannot free the same-epoch commit-once slot.
  New sends reject rotation-required. Accepted entries wait.
  Deletion blocks owner creation and disposes/drains the peer before its group transaction.
  Drain includes opened handlers, settlements, network submissions and ambiguous backend completion.
  The deletion transaction tombstones/clears transport state and co-writes opted-in host effects.
  Unsettled control refuses deletion. Explicit abandon/ack remains the escape.
  Host history and spent authenticators survive deletion.

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

| Protocol | Item | Kind | Retention | Local durability | Payload |
|---|---|---|---|---|---|
| `kumiai.messaging` | `message` | event | `log` | group transaction, outbox/pending/completion | `{id (ULID), sentAt, body: {type: 'text', text}, replyTo?: {author, id}}` |
| `kumiai.messaging.signals` | `receipt` | event | `ephemeral` | none | `{upTo: {author, id}, watermark: {anchor, position}, kind: 'delivered' \| 'read', at}` |
| `kumiai.messaging.signals` | `typing` | event | `ephemeral` | none | `{active: boolean, at}` |

RPC request/response, stream and channel lanes are also ephemeral with no local transport persistence or group transactions.
Durable host actions such as markRead are separate from sending/receiving the ephemeral signal.

- **Author** is the MLS-authenticated sender (`ctx.message.payload.iss`), never a payload field.
  There is no application-level signature: live authorship is MLS's, and pre-link history is out of
  scope.
- **Message identity** is `(groupID, author, id)`. Content is fixed at `send()`; re-sealing after an
  epoch change re-encrypts the same plaintext.
- **Epoch.** The handler records the authenticated epoch the frame opened in. Pending decrypted
  records persist epoch and local incarnation. `frame.segment` is the authenticated app-anchor capture epoch.
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
messenger.events                                        // message | message:status | outbox:failed | receipt | typing
```

### Semantics

- **Order (r14 decision).** First durable occurrence keeps `(incarnation, anchor epoch, hub position)`.
  Compare positions numerically within the message lane. Late old-anchor frames retain their anchor epoch.
  A4 in incarnation n precedes B2 in n+1. Old local read watermarks cannot mark B2 read.
  Incarnation retirement accepts no new opens and never deletes history already handed to MessageStore.
  Each occurrence also persists its authenticated message-lane topicID for receipts.
  Later occurrences dedup by `(groupID, author, id)` and never move the first.
  Live delivery can precede retained pull, so devices may disagree on duplicate occurrence order.
  Pending local messages sort last until positioned. Local incarnation numbers never appear in peer receipts.
- **Attempt identity.** Every app seal has a fresh publishID, source identity, anchor epoch and sealed topicID.
  Same-process handoff retries retain exact bytes/ID in memory.
  Restart or epoch/topic invalidation reseals unproven entries only in the active incarnation.
  Incarnation switching atomically fails abandoned entries and emits durable machine-readable events.
  Hosts may retry programmatically. Kumiai does not reseal them automatically.
  App ciphertext and acknowledgement proof are not persisted.
  P2a controls persist exact bytes/ID/candidate and republish them after head-only mismatch.
- **Publish status.** `pending → accepted → published`, or `accepted → failed`.
  Acknowledgement is not proof. The client result stays `{sequenceID}`.
  Certification persists `{sequenceID, attemptID, topicID, outcome: 'published'}`.
  Settlement revalidates expected incarnation/epoch/authenticator/stateVersion/attemptID inside the group gate and transaction.
  A mismatch writes nothing. Both proof paths use this check.
  Removal writes status/effects with entry/obligation deletion in one transaction.
  Terminal clearing and incarnation switching report published for certified obligations and fail only unproven entries.
  Frozen occurrences retain original incarnation/anchor epoch/topicID/position after restart.
  Hosts opt into the shared transactional effect boundary or consume durable status events idempotently.
  Failure events retain entry data, stable event ID, reason and destination incarnation until ack.
  Host messages correlate by semantic identity, never outbox seq.
  Ambiguous commit completion settles one retained hook queue before callers resume.
- **Ingestion (r14 decision).** Default handlers run outside transactions, at least once, with a stable frame idempotency key.
  MessageStore.put is idempotent on `(groupID, author, id)`.
  Opt-in transactional handlers receive the group transaction and co-write MessageStore effect, pending completion and cursor.
  They perform no network I/O. This gives exactly-once durable effects when the store shares the provider.
  A same-key/different-content put keeps the first row, logs the conflict and consumes the frame successfully.
  Completion and contiguous cursor advancement always share one transaction.
- **Batching (r14 decision).** Group defaults are 64 frames, 2 ms maximum coalescing delay and 8 ms staging work.
  An idle lone message starts immediately. Catch-up batches amortise commits and release the group scope.
  Interleave other lanes, control adoption and enqueue work. Ready control and a low-rate lane complete within three total A/B/control batches, including active A.
  Other groups schedule independently.
- **Receipts.** `upTo` names a message. The watermark is `{anchor, position}`, where anchor is its persisted authenticated message-lane topicID.
  Never derive that topic from the current anchor.
  Delivered/read watermarks advance only within `(member device, group, anchor)`.
  Read implies delivered on the same anchor. Different anchors' positions are incomparable.
  A superseded-anchor receipt covers no replacement anchor or new incarnation's local read watermark.
  Local markRead uses `(incarnation, anchor epoch, position)` and sends separate receipts for covered anchors.
  Receivers retain the transmitted tuple even when their first occurrence of upTo used another anchor.
  Unknown/pending upTo receipts remain in memory, at most 100 per group, expiring after 10 minutes.
  Overflow evicts the oldest. Per-user maxima combine co-devices separately within each anchor.
  Receipt/typing handlers persist no transport records and use no group transaction.
  Members may misreport their own receipts.

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
  Boundaries inside `rpc` and `mls-rpc` (group transition commit, handler completion, acknowledgement
  bookkeeping, control publish) need wrapping stores/hub clients that pause before or after atomic calls.
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
   - A3 → A4 in n, host-selected external-resync B2 in n+1, then restart: exact/alternate spent A3 Welcomes both refuse;
   - A4 order/read watermark (n,4,10), then B2 (n+1,2,20): B2 sorts later and remains unread;
     superseded-anchor receipts cannot cover B2. History stays intact;
   - either fork divergence branch halts durably with stable event, live and after restart; no auto recovery, even after ack;
   - host same-epoch authenticator mismatch reports a fork; consistent split views without comparison remain a detection limitation;
   - stranded retention gap/lost MLS state automatically external-resyncs into a fresh incarnation/generation-zero chains;
   - manual chosen-target recovery persists authorisation, keeps halt on refusal and switches only after exact external acceptance;
   - stale GroupInfo must fail ordering before adoption; its capture-head binding is an explicit phase-2 unresolved gate;
   - old applied non-removal rows cannot mask self-removal in the new incarnation;
   - switch mid-transaction rolls back old tombstone, new state, spent append, failed statuses and events together;
   - switch fails old unpublished entries with durable events, without automatic reseal. Certified entries remain published;
   - certification checks A, adoption/switch queues ahead, then settlement revalidation refuses stale proof;
     inverse ordering persists the obligation before adoption;
   - certify on anchor A, removal fails, rotate to B and restart: settlement keeps A's persisted topicID/occurrence;
   - delete/reconstruct then replay exact/alternate spent Welcome: refusal without resurrection;
     unspent Welcome can start another incarnation without a prior epoch floor;
   - poison frame advances hub head only: control retries identical bytes/ID/handshake generation, also across restart;
     real receivers apply. Outcome ack/deadline cannot permit a second private build at the same epoch;
   - ordinary lower epoch or same-number authenticator replacement refuses every coupled write;
   - raw storage exposes no plaintext, anchor secret or topicID. Wrong-AAD opening and physical swaps reject;
   - sustained burst on lane A: low-rate B and ready control adoption complete within three total A/B/control batches;
   - ephemeral RPC/signals persist nothing and open no group transaction;
   - a truncated controller log offered for a known controller: refused;
   - a false controller binding in a leaf: refused;
   - a revoked manager device attempting `addDevice` after the revocation evidence is enacted in the
     group ledger: rejected identically by every member;
   - Welcome spam to another device's discovery topic and subscribing to it (phase 4): refused;
   - same author reusing an `id` with different content: first row kept, conflict logged;
   - hub (phase 4): authentic-but-unauthorized membership statement, stale statement, revoked
     device on an already-open channel: all refused.
8. Child-process crash points, followed by restart and no-loss/no-duplicate-effect assertions:
   - inside a group transition or N-frame open batch: all coupled rows/effects commit or none;
   - opened records committed, before default handlers, and after an external handler effect before completion;
     redelivery keeps the same idempotency key;
   - transactional handler effect/completion/cursor before or after commit: exactly-once durable effect;
   - self-removal committed, before opened handlers settle: terminal restart drains them before clearing;
   - exact control build committed before publication, and remote acceptance before local settlement;
   - accepted outbox before publish, acknowledgement before proof, certified obligation before removal;
     terminal/switch restart retains published status and sealed topicID;
   - fork halt committed before event emission: restart remains halted and replays the event without auto recovery;
   - manual recovery authorisation committed before external publish: restart resumes only the selected target;
   - incarnation switch committed before peer restart: isolated new state, old tombstone and failure events;
   - application lease committed before seal: reserved generations are skipped after restart;
   - joined incarnation committed before source consume, and Welcome delivery before obligation deletion;
   - COMMIT rejected with backend unfinished: negative read cannot release the group gate;
   - deletion committed before restart.
   Spec P/P2a stage replay covers remaining external publication/confirmation/bootstrap seams.
   There is no completion/cursor split seam or handshake-reservation seam.
   Also test durable hub restart and duplicated app publication across rotation. Each receiver keeps one message row.

### Rules

- No sleeps. Every wait is `waitFor` with a deadline, polling the last-settling state.
- Mutation checks for a named guard list, kept in the e2e README: author-is-`iss`, cross-group
  rejection, dedup, receipt monotonicity, typing staleness, controller-log truncation refusal, hub
  membership gate, revoked-device gate. Each guard is broken, the test must fail, then restored.
- CI runs the in-process suite on every push. The child-process suite also runs in CI and stays
  small.

## Phases

Each phase gets its own plan and branch. The e2e suite grows with each phase.

0. **Spec P: transactional persistence (draft r14).** Strongly consistent DS, durable fork halt/manual recovery, automatic stranded resync;
   incarnation monotonicity, commit-once and one group transaction per durable transition.
   Fair adaptive batching, durable-only lanes and transactional-or-idempotent handlers are binding (r14 decision).
   Keep v2 codecs, spent authenticators, application leases, at-rest codec, certified settlements and completion barriers.
   P2a's consolidated r14 amendments replace its earlier persistence notes.
1. **Lift audit (probe).** Verdicts copied above. The codec prerequisite remains until implemented/tested.
   Automatic /info integration remains separately blocked.
2. **rpc/mls/mls-rpc/mls-hub/rpc-conformance/hub-client on memory doubles.**
   Follow Spec P: codecs, group transaction coordinator, incarnations/spent admission, fork halt/manual recovery, stranded resync and commit-once control,
   fair batching/handlers, application leases/rotation, settlement/events, encryptor and hub-client lifts.
   Broadcast changes only forward authenticated metadata.
   Both contract suites cover real implementations and doubles. Run repository-wide type tests.
   No client/messaging/Hozon provider or child-process driver.
   HTTP smoke uses injected server DID, real MLS, standalone devices, invite/join, send/proof and rotation.
   Reconstruct memory runtimes for live/restart fork halt, automatic/manual resync, incarnation switches, spent refusal, commit-once and crash/batch/handler cases.
   Establish the GroupInfo freshness/head binding before claiming the stale-epoch refusal gate passes.
3. **rpc-store.** sqlite/postgres group transactions with explicit scope and outcome-aware provider hooks.
   Bind all namespace and host side-row writes to the supplied provider transaction.
   Verify CAS, completion barriers, late COMMIT, encrypted physical rows, wrong AAD and fairness.
   Expo uses a node shim or an explicit blocked reason. SQLite e2e devices reconstruct from durable rows.
4. **Spec I and Spec H, then mls group changes, client and hub policy/server changes.**
   Gated on published kokuin stores. Client wires ownership, inventory/pending/control restore,
   Welcome consume sweep, rotation scheduling and deletion draining. e2e scenarios 2, 3, 4, 6 and
   identity/hub cases of 7.
5. **messaging.** Consume phase-2 epoch/incarnation/proof metadata and failed-send events.
   MessageStore uses the shared transactional-or-idempotent handler/effect model for ingestion and status. e2e scenarios 1, 5 and messaging cases of 7.
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

- **GroupInfo freshness binding unresolved.** Current CAS compares only head; the sealed reply does not bind GroupInfo to its capture head
  (`packages/mls/src/recovery.ts:566`, `packages/hub-store/src/store.ts:226`). Spec P requires stale-epoch rejection but does not invent that binding.
- **Complete local database loss.** Automatic MLS-state recovery needs retained/restored credential and lifetime spent-authenticator metadata;
  resetting a previously known group's spent set is unsafe and is not authorised.

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
