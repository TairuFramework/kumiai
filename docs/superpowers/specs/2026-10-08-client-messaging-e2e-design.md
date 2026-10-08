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

Checked against source on 2026-10-08 by two Codex reviews (file:line evidence in their records).

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
  `AppOutbox`, `AppCursorStore`, `CommitJournal`. Retention is `log` or `ephemeral`; only events may
  be `log`; there is no per-publication TTL. One protocol derives one topic; differently named
  protocols derive different topics.
- For log procedures with an outbox configured, rpc dispatch resolves once the outbox durably
  accepts the plaintext, before hub publication. Outbox entries are re-sealed after epoch changes.
  Publication acknowledgement tracking is in memory, and the app lane skips the publisher's own
  echo. The sender learns neither its log position nor publication success today.
- Handlers see the MLS-authenticated sender at `ctx.message.payload.iss`. The opened epoch is not
  exposed to handlers consistently.
- Ephemeral (mailbox) publications queue for existing subscribers other than the publisher, whether
  or not they are online, and expire after the hub's mailbox TTL.
- App-lane epoch retries and external-rejoin resends republish the same plaintext; publication
  evidence is in memory. The hub deduplicates publications by a supplied `publishID`, but app
  publishes omit it today.
- `verifyManagementCapability` takes no deny set and has no revocation hook; `bindingOfDID` reads
  the tree and returns an externally revoked device while its leaf remains. Survivor checks use
  only revocations folded from the group ledger. A synchronous `commitPolicy` can veto with
  preloaded state.
- Pending decrypted records (`frame`, plaintext, sender) carry no opened epoch.
- Hozon combines stores in one transaction only when they come from the same transaction provider.
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
| `mls` | Group-model changes from Spec I: bound creator in an unanchored group, Welcome admission for co-devices, role bootstrap/migration, revocation as ordered ledger evidence in unanchored groups, structured policy errors. |
| `rpc` | Expose the authenticated epoch to handlers; report a publication's log position and status to the publisher. |
| `hub-client` | Reconnecting `LogHub`/`MailboxHub` over HTTP, peer- and sender-scoped views, ack backoff, hub server-DID discovery fetch. The buffered peer view takes injected epoch inspection and change notifications; `hub-client` never imports `mls` or the registry. |
| `mls-rpc` | `GroupHandleRegistry` core (per-group mutex, epoch cache with change events, restore, displacement/lineage tracking, receive-tree merge) over the `GroupStateStore` port; `MLSEncryptor`; mls-state codec. Storage and projections are adapters. |
| `rpc-store` (new) | Hozon impls of `GroupStateStore`, `CommitJournal`, `AnchorStore`, `AppCursorStore`, `AppOutbox` on sqlite, postgres and expo. Passes `rpc-conformance`, extended per Spec P. |
| `client` (new) | `Device` orchestrator: identity layer, group verbs, one `GroupPeer` per group, restore, key-package provisioning via `mls-hub`, wake registration. |
| `hub-server` or a new `hub-authz` | The membership `authorize` policy and its state ingestion (Spec H decides placement). |
| `messaging` (new) | Two protocols and `Messenger`; `MessageStore` port with memory and Hozon impls. |
| `tests/e2e` (new, private) | Driver protocol and implementations, hub fixture, scenarios. |

New public packages join the shared version band. New transport, event, HTTP and logging
dependencies are declared per package. Kubun's projections (circles, catalog, credentials, ledger
ingest), its `processCommit` override and all of `sync/`, `context/`, `peer/` stay in Kubun.

### Lift classification

All paths under `kubun/packages/plugin-p2p/src/`.

| Class | Files | Treatment |
|---|---|---|
| Generic as is | `groups/mls-codec.ts`, `util/mutex.ts`, `hub/http-client.ts`, `hub/peer-scoped-hub-view.ts`, `hub/sender-scoped-hub-view.ts` | Move. |
| Generic, Kubun logger types | `hub/hub-like.ts`, `hub/ack-backoff.ts` | Move; take a `@sozai/log` logger. |
| Generic core, local deps | `groups/mls-encryptor.ts`, `groups/admin-roster.ts` | Extract the core; inject the deps. |
| Schema/provider coupled | `groups/group-handle-registry.ts`, `mls-state.ts`, `group-crypto.ts`, `group-handle-access.ts`, `commit-journal.ts`, `anchor-store.ts`, `app-cursor-store.ts` | Re-implement behind kumiai ports (Spec P); Kubun keeps thin adapters over `store-p2p` rows. |
| Mixed | `hub/buffered-peer-hub-view.ts` (imports MLS parsing and the registry), `hub/server-did.ts` (resolver persistence and events are Kubun-specific) | Lift with injected epoch inspection; lift only the discovery fetch. |
| Domain-coupled | `groups/manager.ts`, `groups/group-peer-manager.ts` | Not lifted as files. Individual workflows (create, invite, join, remove, per-group peer lifecycle) are re-expressed in `client`. |

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

- **Invite.** A group admin fetches the invitee's key packages from the hub (`mls-hub` pool),
  commits, and publishes each welcome to the invitee device's public discovery topic
  (`discoveryTopic(deviceDID)`, the existing pre-group path). Each invitee device joins via
  `processWelcomeFromSources`, idempotently. Inviting a controller adds every device it currently
  grants.
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
- **Restore.** On start, `GroupHandleRegistry` restores every group from `rpc-store`, completes
  pending receives, recovers the commit journal (`lost/reenact`), and each peer resumes from its
  cursor.

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
- **Attempt identity.** Each publication attempt carries a durable `publishID`; the hub already
  deduplicates by `(topicID, publishID)`, so no hub change is needed. That dedup record expires
  after 365 days in `hub-store`; an attempt still ambiguous past that horizon is abandoned and the
  message is re-sent under a new attempt ID (receivers dedup it by message identity). Spec P persists each attempt's ID, topic,
  ciphertext and acknowledgement, and replays the **same** attempt after an ambiguous crash.
  Re-sealing after an epoch change or a deliberate rejoin resend creates a **new** attempt ID under
  the same message identity.
- **Publish status.** `message:status` goes `pending → accepted → published (position known)`.
  rpc reserves the outbox sequence inside acceptance, then calls `AppOutbox.put`. A coordinated
  `put(entry)` adapter writes the outbox entry, the message row and their correlation using stores
  obtained from the **same transaction**, and resolves only after the outer transaction commits;
  sharing a database with ordinary store instances is not enough, and a nested transactional
  callback resolves before the outer commit. The reservation is held until then. No `AppOutbox`
  signature change is needed. The memory doubles share one in-memory transaction. Position/status
  is persisted after the hub acknowledges; an acknowledgement lost to a crash is recovered by
  replaying the same attempt.
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
  bookkeeping, journal put) need injectable seams: optional test-only hooks on the ports or a
  wrapping store that pauses before or after a named write. Spec P lists each seam.
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
   - after hub acknowledgement, before status persist and outbox removal;
   - mid-commit, after journal put.
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

0. **Spec P: transactional persistence.** The `GroupStateStore` contract: versioned/CAS writes,
   sender-generation reservation, atomic state plus pending decrypted frame, pending list/complete,
   transaction visibility, recovery from an ambiguous write, inventory and deletion. The persisted
   inventory includes credentials and ordered signed ledger tokens. Idempotent Welcome and commit
   adoption; journal `lost/reenact` recovery. Pending decrypted records persist the authenticated
   opened epoch. Outgoing side: durable attempt identity for app publishes, recovery of an
   ambiguous publication (acknowledged by the hub but not recorded), the coordinated
   `MessageStore`↔outbox acceptance adapter (shared transaction provider, correlation, rollback,
   after-commit visibility) and durable publication status. The list of crash-point seams. The
   conformance cases added to `rpc-conformance`.
1. **Lift audit (probe).** Confirm the classification table file by file and fix port signatures
   against Spec P. BLOCKED is a valid outcome for any candidate.
2. **`hub-client` and `mls-rpc` additions,** plus the `rpc` port changes Spec P requires (opened
   epoch on pending records, attempt identity, crash-point seams), on memory doubles that pass the
   conformance suites.
   e2e: hub fixture (allow-any), in-process driver, a two-device group-peer smoke test over the real
   HTTP hub.
3. **`rpc-store`.** Passes `rpc-conformance` on sqlite and postgres, real impls and doubles. e2e:
   devices on sqlite; restart restores groups.
4. **Spec I and Spec H, then `mls` changes, `client`, the hub policy and the `hub-server` changes Spec H lists.** Implementation is gated
   on the kokuin stores being published. e2e: scenarios 2, 3, 4, 6, and the identity and hub cases
   of 7.
5. **`messaging`,** including handler exposure of the opened epoch and the publish-status events. e2e: scenarios 1, 5, and
   the messaging cases of 7. The Expo bundle check joins CI.
6. **Child-process driver and scenario 8.**

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

- **Lift drag.** The coupled registry is re-implemented, not moved; Kubun keeps adapters.
- **Kokuin publication.** Phase 4 implementation blocks until both stores publish.
- **mls group-model changes.** Touch policy and Welcome admission; reviewed blind, with both
  conformance suites run against the real implementation and the doubles.
- **Hub authorization ingestion.** A new trust path into the hub. Designed in Spec H, reviewed
  blind.
- **Flake.** Real sockets and child processes. Mitigated by deadline-based waits and a small
  child-process suite.
