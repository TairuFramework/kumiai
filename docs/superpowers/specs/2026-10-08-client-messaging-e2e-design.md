# Client host, messaging protocol and multi-device e2e — design

Date: 2026-10-08
Status: draft r2 (Codex review folded in), awaiting review

This is the umbrella design. Two sub-specs must be written and approved before the phases that
depend on them: **Spec P (transactional persistence)** and **Spec I (identity distribution, hub
authorization and history security)**. See [Phases](#phases).

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
   removal/revocation, offline + push wake, concurrent commits, named crash points, and the
   adversarial cases listed under [Scenarios](#scenarios).
3. Every new port implementation, and every double, passes the relevant conformance suite.
4. Host, client and messaging packages import no `node:*` module, so they run on Expo with
   `@hozon/expo`.

## Context

Checked against source on 2026-10-08 (Codex review, file:line evidence in the review record).

- `@kumiai/mls` has signed-ledger roles (`roster.ts`: `admin | member`, only admins grant,
  zero-admin entries dropped).
- `@kumiai/mls` device support is **per-controller**: `addDevice`/`revokeDevice`
  (`group-device.ts`) need a management capability issued by the affected device's controller, not
  group-admin rights. Leaves carry an embedded controller binding (`device-proof.ts`,
  `embedded-resolver.ts`); the embedded resolver never fetches external logs.
- Setting `anchor.controller` makes every leaf bind to that one controller (`lifecycle.ts`
  `checkBinding`, `controller-mismatch`). It describes a single user's device-sync group and cannot
  host a multi-user chat.
- `@kumiai/rpc` `createGroupPeer` takes ports `GroupCrypto`, `GroupMLS` and stores `AnchorStore`
  (`load/save(AnchorSlot)`), `AppOutbox` (commit cursor plus `put/list/remove/clear`),
  `AppCursorStore` (`load/save` per topic), `CommitJournal` (`put/markAccepted/get/clear`, publish-ID
  fencing). Protocol retention is `log` or `ephemeral`; only events may be `log`. There is no
  per-publication TTL.
- The rpc dispatch resolves once the outbox durably accepts a frame, before hub publication; the app
  lane skips the publisher's own echo. The sender therefore learns neither its log position nor
  publication success today.
- `hub-server` `createHub` `authorize` **defaults to allow-any-authenticated**, with a default 5 s
  receive-authorization cache. `hubPlugin` (`hub-http`) does not accept a direct `verifyToken`; it
  wires Teikyo access grants/revocation instead. The hub wakes offline subscribers for every
  publication on a topic; hints are encrypted and coalesced.
- `hub-http` `createHubServer` is the production HTTP server, `hub-store` the durable Hozon store.
  Kumiai's integration suite reaches the hub in-process over `DirectTransports` except
  `hub-http.test.ts`, which uses a real socket but runs no peers.
- Kubun `plugin-p2p` builds on `@kumiai/mls`, `mls-rpc` and `rpc`. Its `GroupHandleRegistry` saves
  ratchet state plus pending plaintext atomically, reserves sender generations, and does versioned
  state writes.
- `@kokuin/store-controller` and `@kokuin/store-delegation` are at 0.1.0 locally; publication is
  pending (registry status not checked from source). `store-delegation` replaces grants per
  `(grantor, audience, resource)` and garbage-collects revocations, so it is not a permanent
  authorization archive. `store-controller` writes are last-writer-wins and callers must run the
  anti-truncation guard on untrusted logs first.
- `@hozon/expo` exists, so Hozon-backed stores can run on device.

## Package layout

Each lifted piece goes to the package that owns its layer; three packages are new.

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
| `hub-client` | Reconnecting `LogHub`/`MailboxHub` over HTTP, peer- and sender-scoped views, ack backoff, hub server-DID discovery fetch. The buffered peer view takes injected epoch inspection and change notifications; `hub-client` never imports `mls` or the registry. |
| `mls-rpc` | `GroupHandleRegistry` core (per-group mutex, epoch cache with change events, restore, displacement/lineage tracking, receive-tree merge) over the `GroupStateStore` port; `MLSEncryptor`; mls-state codec. Storage and projections are adapters. |
| `rpc-store` (new) | Hozon impls of `GroupStateStore`, `CommitJournal`, `AnchorStore`, `AppCursorStore`, `AppOutbox` on sqlite, postgres and expo. Passes `rpc-conformance`, extended with `GroupStateStore` cases. Mirrors `hub-store`/`hub-server`. |
| `client` (new) | `Device` orchestrator: identity layer, group verbs, one `GroupPeer` per group, restore, key-package provisioning via `mls-hub`, wake registration, the hub `authorize` policy helper. |
| `messaging` (new) | Messaging protocol and `Messenger`; `MessageStore` port with memory and Hozon impls. |
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

- **Messaging groups** are multi-user: `anchor.controller` is unset. Each leaf binds to its own
  device's controller through an embedded leaf proof. Group roles (`admin | member`) come from the
  mls roster. The role subject is decided in Spec I: the controller DID, so every device of an
  admin acts as admin, or the device DID.
- **Personal device-sync groups** (one controller, `anchor.controller` set) are out of scope for
  messaging. The identity layer may use one for a controller's own state; Spec I decides.

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

The identity details are settled in Spec I; this section fixes the shape only.

- **Invite.** A group admin fetches the invitee's key packages from the hub (`mls-hub` pool),
  commits, and sends welcomes through the hub directed inbox. Each invitee device joins via
  `processWelcomeFromSources`. Inviting a controller adds every device it currently grants.
- **Device link.** The controller issues the new device two grants: a leaf-binding capability (for
  the embedded leaf proof) and, if the device may manage co-devices, a leaf-key-pinned `manage`
  capability on `kumiai/devices`. The new device receives them out of band (direct handoff in tests,
  a QR code on a phone) and calls `registerDevice`. In each group, an existing device of the same
  controller commits `addDevice`; group admin is not required.
- **Device revoke.** The controller publishes the revocation. In each group, a device of the same
  controller holding `manage` commits `revokeDevice`. The hub refuses the revoked device through the
  `authorize` policy below.
- **Two resolution paths, kept separate.** External controller resolution: fetch, guard against
  truncation, and store controller logs (`store-controller`) and grants/revocations
  (`store-delegation`). Embedded leaf proofs: built at link time and carried in the leaf, verified
  by the existing mls embedded resolver without external fetches.
- **Restore.** On start, `GroupHandleRegistry` restores every group from `rpc-store`, completes
  pending receives, and each peer resumes from its cursor.

### Hub authorization

The hub's default allow-any policy is not acceptable for this stack. `client` exports an
`authorize` policy helper, and the e2e hub fixture installs it:

- Topic access (publish, subscribe, fetch, receive, `receive/deliver`) requires the caller's device
  to be a current member of the topic's group.
- Revoked devices are refused for every action.
- The hub learns membership and revocations through authenticated ingestion defined in Spec I
  (candidates: members post signed roster/revocation statements; the hub verifies them against
  controller logs).
- The receive-authorization cache window (default 5 s) is an accepted delay; tests assert refusal
  after the window, not instantly.

### Errors

Coded errors: `NOT_GROUP_ADMIN`, `LAST_GROUP_ADMIN`, `NOT_DEVICE_MANAGER`, `DEVICE_REVOKED`,
`KEY_PACKAGE_UNAVAILABLE`, `NOT_A_MEMBER`, `HUB_REFUSED`. The mls commit policy stays authoritative;
`client` maps its rejections (today generic errors in `group-commit.ts`) to these codes. That
mapping needs structured errors from `mls`, added as part of phase 4. The client adds no parallel
authorization check.

## `@kumiai/messaging`

### Protocol

All items are declared with `defineGroupProtocol` and attached per group via `device.peer(groupID)`.

| Item | Kind | Retention | Topic | Payload |
|---|---|---|---|---|
| `message` | event | `log` | message topic (wake on) | signed envelope, below |
| `receipt` | event | `ephemeral` | signal topic (wake off) | `{upTo: {author, id}, kind: 'delivered' \| 'read', at}` |
| `typing` | event | `ephemeral` | signal topic (wake off) | `{active: boolean, at}` |
| `history/fetch` | directed request | n/a | `hub-tunnel` | `{before?, limit}` returns signed envelopes |

Messages and signals use separate topics so wake applies only to messages. Phase 1 checks that
per-protocol topic derivation can give them distinct topics; if it cannot, this design returns to
review.

### Message envelope and signature

```
SignedMessage = {
  v: 1,
  groupID, epoch, transcriptHash,   // epoch the author sent in, and its confirmed transcript hash
  author: deviceDID, controller?,   // controller binding as in the author's leaf
  id,                               // ULID, unique per author
  sentAt, body: {type: 'text', text}, replyTo?: {author, id},
  sig                               // author device signing key over canonical bytes of all above
}
```

- **Canonical bytes**: versioned, deterministic encoding (fixed in Spec I) with a domain-separation
  label.
- **Signing key**: the author device's leaf signature key, so the signature verifies against the
  leaf the author held in `epoch`.
- **Live path**: the receiver checks that `author` equals the MLS sender leaf of the frame and that
  `epoch` equals the frame's epoch. A mismatch drops the frame.
- **Identity**: messages are keyed `(groupID, author, id)`. A second envelope with the same key and
  different content is a conflict: keep the first, flag the author.

### History guarantee (accepted limit)

A device catching up through `history/fetch` verifies each envelope: the signature, that `author`
was a member at `epoch` (roster/ledger), and that `transcriptHash` matches the group's transcript
at `epoch`. There is no trusted timestamp. **Accepted limit**: a device revoked at epoch N keeps its
old leaf key and can sign new envelopes claiming any epoch before N in which it was a member. Such
forgeries stay inside the author's own past membership window; they cannot impersonate another
author or claim an epoch after removal. The serving peer can withhold or reorder history; history
ordering is peer-asserted. This path gets a blind crypto review.

### API

```ts
const messenger = createMessenger({ device, store })   // store: MessageStore
await messenger.send(groupID, text)                     // pending Message
messenger.list(groupID, { before?, limit })
messenger.markRead(groupID, { author, id })
messenger.setTyping(groupID, active)
messenger.events                                        // message | message:status | receipt | typing
```

### Semantics

- **Order.** Live messages sort by hub `(topic, segment, position)`, persisted with each message.
  Topic rotations order by segment. History imports carry peer-asserted order and are marked so.
- **Publish status.** `message:status` goes `pending → accepted (outbox) → published (position
  known)`. This needs rpc plumbing to report a publication's log position to the publisher (phase 5).
- **Idempotent ingestion.** `MessageStore.put` is idempotent on `(groupID, author, id)` and is
  durable before the handler resolves, so a crash after decrypt neither loses nor duplicates a
  message.
- **Receipts.** Monotonic per `(member device, group)`: an `upTo` older than the stored one is
  ignored. An unknown `upTo` is held until the message arrives, then dropped after a bound. Per-user
  read state is the maximum over that controller's devices. A member can misreport its own receipts;
  that is accepted. Receipts are `ephemeral`, so an offline member misses them; because they are
  cumulative, the next receipt corrects the state. A member re-sends its latest receipt on reconnect.
- **Typing.** Expires locally 5 s after `at`, or immediately when `at` is older than 5 s on arrival
  (late delivery after reconnect). Senders rate-limit to one per 2 s.
- **Removed members.** Their past messages stay; the author leaves the roster.

### Wake

Only the message topic registers wake. The hub sees publisher, topic and subscriber relationships
and push adds timing correlation; this is accepted metadata exposure. A member can still spam
messages to cause wakes; the hub rate limiter and wake coalescing bound it.

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
- **Child-process**: a node child process, over the Enkaku stdio transport. Named crash points are
  test hooks compiled into the agent only.
- **Simulator (future)**: the Expo app in `tests/e2e-expo` embeds the same agent over HTTP. Scenarios
  run unchanged.

### Hub fixture

`createHubServer` on a random port with `hub-store` on a tmpdir sqlite (opt-in postgres via the
existing testcontainers setup), the `client` `authorize` policy, a capturing `WakeSender`, a mock
Expo push endpoint for the real `createExpoSender`, and `hub.restart()`.

### Scenarios

1. Two users 1:1: send/receive, ordering, publish status, receipts, typing (including late typing
   after reconnect).
2. Three members: invite, remove. The removed member cannot decrypt later messages, and the hub
   refuses its fetch and receive after the cache window.
3. Roles: promote/demote; a non-admin remove fails with `NOT_GROUP_ADMIN`; demoting the last admin
   fails with `LAST_GROUP_ADMIN`.
4. Multi-device: link a second device; it receives new messages and pre-link history. Revoke a lost
   device; it is excluded at the next epoch and the hub refuses it.
5. Offline device: a message wakes it (captured sender and mock Expo endpoint); receipts and typing
   do not. It reconnects and catches up with no duplicates.
6. Concurrent admin commits converge to the same epoch and roster on all devices.
7. Adversarial:
   - live frame whose envelope `author` differs from the MLS sender: dropped;
   - history envelope attributed to another member, or claiming an epoch after the author's removal,
     or with a wrong `transcriptHash`: rejected;
   - conflicting envelopes with the same `(author, id)`: first kept, conflict flagged;
   - replayed live frame: deduplicated;
   - truncated controller log offered for a known controller: refused;
   - revoked device's hub calls: refused.
8. Child-process crash points: after decrypt before message persist; after outbox accept before
   publish; mid-commit after journal put; then restart. Each asserts no loss and no duplicate. Hub
   restart keeps delivery durable; device restart restores groups.

### Rules

- No sleeps. Every wait is `waitFor` with a deadline, polling the last-settling state.
- Every guard-bearing test gets a mutation check: break the guard, confirm the test fails, restore.
- CI runs the in-process suite on every push. The child-process suite also runs in CI and stays
  small.

## Phases

Each phase gets its own plan and branch. The e2e suite grows with each phase.

0. **Spec P: transactional persistence.** The full `GroupStateStore` contract: versioned/CAS
   writes, sender-generation reservation, atomic state plus pending decrypted frame, pending
   list/complete, transaction visibility, recovery from an ambiguous write, inventory and deletion.
   The conformance cases to add to `rpc-conformance`, and `MessageStore` idempotency.
1. **Lift audit (probe).** Confirm the classification table file by file, fix port signatures
   against Spec P, and check per-protocol topic derivation for the message/signal split. BLOCKED is
   a valid outcome for any candidate.
2. **`hub-client` and `mls-rpc` additions,** on memory doubles that pass the conformance suites.
   e2e: hub fixture, in-process driver, a two-device group-peer smoke test over the real HTTP hub.
3. **`rpc-store`.** Passes `rpc-conformance` on sqlite and postgres, real impls and doubles. e2e:
   devices on sqlite; restart restores groups.
4. **Spec I, then `client`.** Spec I covers: who holds the controller key, grant shapes, controller
   log distribution with bootstrap and anti-truncation, which proofs are archived beyond
   `store-delegation`'s replacement and GC, hub membership/revocation ingestion, the role subject,
   canonical envelope bytes, and the history-verification algorithm. Implementation is gated on the
   kokuin stores being published. e2e: scenarios 2, 3, 4 (minus history), 6, and the identity
   cases of 7.
5. **`messaging`,** including the rpc publish-status plumbing. e2e: scenarios 1, 4 (history), 5,
   and the messaging cases of 7.
6. **Child-process driver and scenario 8.**

Kubun adoption is out of scope: a separate spec in the Kubun repo once these packages publish.

## Risks

- **Lift drag.** The coupled registry is re-implemented, not moved; Kubun keeps adapters.
- **Kokuin publication.** Phase 4 implementation blocks until both stores publish.
- **History forgery inside a revoked author's past membership window.** Accepted; see History
  guarantee.
- **Hub authorization ingestion.** A new trust path into the hub. Designed in Spec I, reviewed
  blind.
- **Flake.** Real sockets and child processes. Mitigated by deadline-based waits and a small
  child-process suite.
