# Client host, messaging protocol and multi-device e2e — design

Date: 2026-10-08
Status: draft, awaiting review

## Intent

- **Lift generic group-host logic out of Kubun** (`@kubun/plugin-p2p`) into kumiai packages, so Kubun
  shrinks and adopts kumiai pieces incrementally. The lifted code must be generic: no Kubun
  documents, catalogs, circles, credentials, sync or GraphQL concepts.
- **Harden kumiai with realistic tests**: many devices talking through a real hub over HTTP, each
  with its own durable store, exercising most packages end to end.
- **A small reusable messaging protocol** (`@kumiai/messaging`), Signal/WhatsApp-like, used as a
  simplified model of Kubun's needs. It is not the product; it must still be an independent package
  usable by other projects.
- **Multi-device users**: a `did:kokuin` controller owns several devices, backed by
  `@kokuin/store-controller` and `@kokuin/store-delegation`.
- **Future**: Android and iOS simulator devices join the same e2e scenarios. Out of scope for this
  spec, but the design must not block it.

### Success criteria

1. Kubun's generic host code has a kumiai home with ports Kubun can implement over its own rows.
2. A scenario suite runs N devices (in-process and child-process) against a real `createHubServer`
   and covers: messaging, group admin/member management, multi-device link/revoke, offline + push
   wake, concurrent commits, crash/restart durability.
3. Every new port implementation passes the relevant conformance suite.
4. Host, client and messaging packages are runtime-agnostic (no `node:*` imports), so they run on
   Expo with `@hozon/expo`.

## Context (verified 2026-10-08)

- `@kumiai/mls` already has signed-ledger roles (`roster.ts`, `admin | member`, only admins grant,
  zero-admin entries dropped) and `did:kokuin` device support (`anchor.controller`, `addDevice`,
  `registerDevice`, `revokeDevice`, `device-proof.ts`, `embedded-resolver.ts`).
- `@kumiai/rpc` `createGroupPeer` is the orchestrator: ports `GroupCrypto`, `GroupMLS`, stores
  `AnchorStore`, `AppOutbox`, `AppCursorStore`, `CommitJournal`. Lanes: broadcast (mailbox/log),
  anycast/gather, directed RPC.
- `hub-http` `createHubServer` is the production HTTP server; `hub-store` is the durable Hozon store.
  Existing integration tests use an in-process wire hub over `DirectTransports`; only
  `hub-http.test.ts` uses a real socket, with no peers.
- Kubun `plugin-p2p` already builds on `@kumiai/mls`, `mls-rpc` and `rpc`. Its generic candidates:
  `GroupHandleRegistry`, `mls-state.ts`, `mls-codec.ts`, `mls-encryptor.ts`, `group-crypto.ts`,
  `commit-journal.ts`, `anchor-store.ts`, `app-cursor-store.ts`, `group-handle-access.ts`,
  `admin-roster.ts`, `util/mutex.ts`, and on the hub side `hub-like.ts`, `peer-scoped-hub-view.ts`,
  `sender-scoped-hub-view.ts`, `buffered-peer-hub-view.ts`, `ack-backoff.ts`, `server-did.ts`,
  `http-client.ts`, plus the generic verbs of `GroupManager` and `group-peer-manager.ts`.
- `@kokuin/store-controller` and `@kokuin/store-delegation` are at 0.1.0 and **not yet published**.
  The catalog rule (published `^` ranges only) gates every phase that depends on them.
- `@hozon/expo` exists, so Hozon-backed stores can run on device.

## Package layout

Each lifted piece goes to the package that owns its layer; three packages are new.

```
mls ─ mls-rpc (+ GroupHandleRegistry, MLSEncryptor, mls-state codec)
          │
rpc ──────┤  ports: GroupCrypto, GroupMLS, stores
          │
rpc-store  (new) Hozon impls of rpc stores + group-state store
hub-client (+ reconnecting LogHub/MailboxHub over HTTP, scoped views)
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
| `hub-client` | Add reconnecting `LogHub`/`MailboxHub` over HTTP, peer- and sender-scoped views, buffered peer view, ack backoff, hub server-DID discovery. |
| `mls-rpc` | Add `GroupHandleRegistry` core (per-group mutex, epoch cache with change events, restore, displacement/lineage tracking, receive-tree merge) behind a `GroupStateStore` port; `MLSEncryptor` (hub-tunnel `Encryptor`, generation leases); mls-state codec. |
| `rpc-store` (new) | Hozon impls of `GroupStateStore`, `CommitJournal`, `AnchorStore`, `AppCursorStore`, `AppOutbox`. sqlite, postgres and expo adapters. Must pass `rpc-conformance` (extended with `GroupStateStore` cases). Mirrors `hub-store`/`hub-server`. |
| `client` (new) | `Device` orchestrator: identity layer, group verbs, one `GroupPeer` per group, restore, key-package provisioning via `mls-hub`, wake registration. |
| `messaging` (new) | Messaging protocol and `Messenger` API over `client`; `MessageStore` port with memory and Hozon impls. |
| `tests/e2e` (new, private) | Driver protocol and implementations, hub fixture, scenarios. |

New public packages join the shared version band. Kubun's projections (circles, catalog, credentials,
ledger ingest), its `processCommit` override and all of `sync/`, `context/`, `peer/` stay in Kubun.

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
device.groups.invite(groupID, did)
device.groups.join()                  // also automatic on incoming welcome
device.groups.remove(groupID, did)
device.groups.setRole(groupID, did, 'admin' | 'member')
device.groups.leave(groupID)
device.devices.link(newDeviceDID)     // controller side; returns the grant
device.devices.revoke(deviceDID)
device.peer(groupID): GroupPeer       // protocols attach here
device.events                         // group:joined | group:removed | roster:changed
                                      // | epoch:changed | device:revoked
await device.dispose()
```

### Flows

- **Invite.** The admin fetches the invitee's key package from the hub (`mls-hub` pool), commits,
  and sends the welcome through the hub directed inbox. The invitee device joins via
  `processWelcomeFromSources`. If the invitee is a controller, every linked device gets a leaf.
- **Device link.** The controller signs a delegation grant to the new device DID
  (`store-delegation`). The new device receives it out of band (direct handoff in tests, a QR code
  on a phone). The grant and the controller key-event log are published to a per-controller hub log
  topic. Peers store them (`store-controller`, `store-delegation`) and feed the mls resolver's
  `loadLog` port. Groups then admit the device via `addDevice`.
- **Device revoke.** The controller publishes the revocation. In each group an admin device commits
  `revokeDevice`. The hub `verifyToken` uses `createDelegationRevocationChecker` and refuses the
  revoked device.
- **Restore.** On start, `GroupHandleRegistry` restores every group from `rpc-store` and each peer
  resumes from its cursor.

### Errors

Coded errors: `NOT_GROUP_ADMIN`, `LAST_GROUP_ADMIN`, `DEVICE_REVOKED`, `KEY_PACKAGE_UNAVAILABLE`,
`NOT_A_MEMBER`. The mls commit policy stays authoritative; the client surfaces its rejections and
adds no parallel authorization check.

### Open identity questions (phase 1 probe)

1. Who holds the controller signing key: one primary device, or devices holding a delegated
   `device:link` capability?
2. Per-controller hub log topic vs peer fetch (Kubun's `controller/get-log`) for distributing
   controller logs and grants.
3. How the existing mls `loadLog`/embedded-resolver port maps onto `store-controller`, including the
   anti-truncation guard `store-controller` expects callers to run before `set`.

## `@kumiai/messaging`

### Protocol

Defined with `defineGroupProtocol`, attached per group via `device.peer(groupID)`.

| Item | Lane / retention | Payload |
|---|---|---|
| `message` | broadcast, `log` | `{id (ULID), sentAt, body: {type: 'text', text}, replyTo?, sig}` |
| `receipt` | broadcast, `mailbox` | `{upTo: messageID, kind: 'delivered' \| 'read'}`, cumulative per member |
| `typing` | broadcast, `mailbox`, short TTL | `{active: boolean}`, never persisted |
| `history/fetch` | directed RPC over `hub-tunnel` | `{before?, limit}` returns signed messages |

The author of a live message is the authenticated sender leaf, never a payload field. `sig` is the
author device's signature over `{groupID, id, sentAt, body, replyTo}`.

### API

```ts
const messenger = createMessenger({ device, store })   // store: MessageStore
await messenger.send(groupID, text)                     // returns a pending Message
messenger.list(groupID, { before?, limit })
messenger.markRead(groupID, messageID)
messenger.setTyping(groupID, active)
messenger.events                                        // message | message:sent | receipt | typing
```

### Semantics

- **Order.** By hub log sequence; pending local messages sort last until acknowledged.
- **Idempotency.** Dedup by `id`. Sends go through `AppOutbox`, so they survive restart and retry on
  reconnect.
- **Removed members.** Their past messages stay; the author simply leaves the roster.
- **History catch-up.** MLS forward secrecy stops a newly linked device from decrypting pre-join
  epochs, so it asks a peer through `history/fetch` over the encrypted tunnel. The receiver verifies
  each message's `sig` against the author device key and the grant valid at `sentAt`. A peer can
  therefore withhold history but cannot forge it. This path gets a blind crypto review.
- **Wake.** A `message` publish triggers the hub wake dispatcher for registered member devices.
  Receipts and typing never wake.

## `tests/e2e`

### Driver

One Enkaku protocol (`e2e/v1`) with three transports. A device under test runs a small agent that
exposes `Device` and `Messenger` commands plus an event stream.

```ts
interface DeviceDriver {
  call<M extends Command>(method: M, args: Args<M>): Promise<Result<M>>
  waitFor<E extends EventName>(event: E, predicate, opts: { timeoutMs }): Promise<Event<E>>
  restart(): Promise<void>   // graceful stop + start on the same db
  crash(): Promise<void>     // child-process: SIGKILL; in-process: drop without dispose
}
```

- **In-process**: the agent shares the test process, over `DirectTransports`.
- **Child-process**: a node child process, over the Enkaku stdio transport.
- **Simulator (future)**: the Expo app in `tests/e2e-expo` embeds the same agent over HTTP. Scenarios
  run unchanged.

### Hub fixture

`createHubServer` on a random port with `hub-store` on a tmpdir sqlite (opt-in postgres via the
existing testcontainers setup), a capturing `WakeSender`, a mock Expo push endpoint for the real
`createExpoSender`, and `hub.restart()`.

### Scenarios

1. Two users 1:1: send/receive, ordering, delivered/read receipts, typing.
2. Three members: invite, remove. The removed member cannot decrypt later messages and the hub
   refuses its fetch.
3. Roles: promote/demote; a non-admin remove fails with `NOT_GROUP_ADMIN`; demoting the last admin
   fails with `LAST_GROUP_ADMIN`.
4. Multi-device: link a second device; it receives new messages and pre-link history via
   `history/fetch`. Revoke a lost device; it is excluded at the next epoch and the hub refuses it. A
   forged history entry is rejected.
5. Offline device: the wake fires (captured sender and mock Expo endpoint); the device reconnects and
   catches up with no duplicates.
6. Concurrent admin commits converge to the same epoch and roster on all devices.
7. Child-process: crash mid-send then restart, the outbox resends with no duplicates; hub restart
   keeps delivery durable; device restart restores groups from disk.

### Rules

- No sleeps. Every wait is `waitFor` with a deadline, polling the last-settling state.
- Every guard-bearing test gets a mutation check: break the guard, confirm the test fails, restore.
- CI runs the in-process suite on every push. The child-process suite also runs in CI and stays
  small.

## Phases

Each phase gets its own plan and branch. The e2e suite grows with each phase instead of landing last.

1. **Lift audit and port design (probe).** Read every Kubun candidate. Confirm it is free of Kubun
   concepts and `store-p2p` schema coupling. Output the final lift list, the port signatures, and
   answers to the three identity questions. BLOCKED is a valid outcome for any candidate.
2. **`hub-client` and `mls-rpc` additions.** e2e: hub fixture, in-process driver, a bare two-device
   group-peer smoke test over the real HTTP hub.
3. **`rpc-store`.** Passes `rpc-conformance` on sqlite and postgres. e2e: devices on sqlite;
   restart restores groups.
4. **`client`, including the identity layer.** Gated on the kokuin stores being published. e2e:
   scenarios 2, 3, 4 (minus history) and 6.
5. **`messaging`.** e2e: scenarios 1, 4 (history), 5.
6. **Child-process driver and scenario 7.**

Kubun adoption is out of scope: a separate spec in the Kubun repo once these packages publish.

## Risks

- **Lift drag.** `GroupHandleRegistry` is about 2k LOC with Kubun-specific displacement handling
  mixed in. Phase 1 may split it or leave parts behind.
- **Kokuin publication.** Phase 4 blocks until both stores publish.
- **History forgery.** Covered by per-message signatures and a blind review.
- **Flake.** Real sockets and child processes. Mitigated by deadline-based waits and a small
  child-process suite.
