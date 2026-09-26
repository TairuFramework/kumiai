# Acknowledged durable app-frame delivery — complete

**Date:** 2026-09-25
**Status:** complete
**Packages:** all twelve `@kumiai/*` (minor, 0.10 band). `@kumiai/rpc`, `@kumiai/mls`,
`@kumiai/mls-rpc` and `@kumiai/rpc-conformance` carry the change; the rest move with the band.
**Origin:** Kubun `@kubun/plugin-p2p` needs a transient failure between MLS open and host apply to
recover on its own. Before this work the retained drain marked a frame done before emitting it,
swallowed a throwing listener and advanced the durable cursor, and `GroupHandle.decrypt` adopted the
consumed key before any persist hook could run. A crash between open and apply lost the frame.

## Goal

App events declared `retain: 'log'` are delivered **at least once** across crashes and handler
failures, in log order per protocol, with a stable frame identity the host deduplicates on. Everything
else keeps its semantics. Opt-in: durable delivery is on iff `GroupCrypto.pending` is present.

**Guarantee boundary.** Holds for frames a conforming hub appended to the topic log and retains until
this peer durably opened them. Out of scope: hub omission or mailbox-only delivery (the hub is trusted
for availability), retention expiry before the read (`onAppWindowPruned`), and a frame sealed at an
epoch this peer already left (its sender can no longer be authenticated, so it is refused).

## What was built

- **Wire break: versioned app AAD** `[0x01][0x00 ephemeral | 0x01 log][topicID]` on every app,
  directed and request/reply seal and open. The whole AAD is compared before opening, so a rewritten
  intent byte kills the frame. 0.9 and 0.10 peers cannot exchange app frames. Shared codec
  `app-aad.ts`; `GroupCrypto.frameAAD(bytes)` reads the cleartext AAD for routing only (`@kumiai/mls`
  `readMessageAAD`).
- **Frame identity** `AppFrameRef { id, topicID, protocol, segment, position }`, `id` =
  length-prefixed hash of topic and ciphertext, stable across reconnect and replay. Records order by
  `(segment, position)`.
- **`GroupHandle.decryptStaged(message, opts, persist)`** in `@kumiai/mls`: computes the post-open
  state without adopting it, rejects an unnamed sender, awaits `persist(stagedState, opened)` under the
  handle mutex, then adopts and zeroes. Failure leaves the live state and its secrets untouched.
  `stagedState` is an encoded `ClientState`, not a live handle, so the shared device-deny provider is
  never repointed.
- **Port:** `unwrap(bytes, { expectedAAD, frame })`, optional `pending: { list, complete }`,
  `AppFrameStorageError` for retryable persist faults. `@kumiai/mls-rpc` `createGroupCrypto` takes
  `pending: { persistOpened(stagedState, record), list, complete }`; the host writes both in one
  transaction.
- **App lane:** in durable mode a live log-intent push is only a wakeup (acked, never opened or
  buffered); bytes and positions come only from `fetchTopic`. The retained drain is the sole opener of
  log-intent frames. A storage fault keeps the frame sealed and stops the commit walk before the next
  commit (fail-closed), retried on a 1 s to 60 s backoff. Fetches settle together; pages must move
  forward.
- **Delivery queue** per protocol, outside every kumiai lock. Handler resolve acknowledges
  (`complete(id)`, then the cursor advances); a throw retries with backoff and blocks later frames of
  that protocol. A delivery barrier holds a record while an earlier fetched position on its topic is
  still sealed (epoch inversion). Workers start only after the producing commit releases.
- **Restart:** `ready` restores pending records before the seed pull, so a restored position enters as
  `pending` and is never reopened. Records survive rotation; old-segment records keep delivering.
- **Stalls and operator drop:** `onAppDeliveryStalled` fires once per blocking frame per protocol
  (storage fault, missing protocol, or future epoch). `GroupPeer.dropAppFrame(topicID, position)`
  accepts the loss; it refuses a frame behind an earlier unresolved position.
- **Future-epoch retention** (user decision): a frame claiming an epoch above this peer's epoch is
  retained and the cursor stops before it, even when the hub omits the commit that produces that epoch.
  It opens once the peer reaches the epoch, or an operator drops it (durable across restart). A forged
  claim can hold delivery until that drop; the stall notice makes the wait visible.
- **Rotation race:** a seal barrier covers handle advance through anchor assignment, so a new-epoch
  frame never lands on the old topic; a failed anchor capture blocks sealing until it succeeds.
- **Conformance:** a `pending` clause set in `rpc-conformance` runs against the real `mls-rpc` port and
  the fake double (exact sender, wrong-AAD retry, restore, below-epoch fail-closed). The fake uses
  HMAC tags and one-way epoch exports; the real ledger entry seal wipes exported keys.

## Host contract (in the READMEs)

`persistOpened` runs under the handle and commit mutexes and must not call the handle or the peer. The
host never holds a transaction while awaiting a peer or handle operation. Staged writes are ordered
after earlier handle saves, and the store rejects an older state at the same epoch. Handlers record a
dedupe row keyed by `frame.id` in the same transaction as their effect.

## Key decisions

- **Staged open instead of a post-decrypt hook:** `decrypt` adopts inside its mutex, so atomicity needs
  the persist inside the open.
- **Drain as the only opener:** pushed metadata is unauthenticated (`logPosition`), so it cannot pick
  path or position.
- **Fail closed on storage faults:** no epoch passes a log frame that was neither durably opened nor
  classified dead; the stall notice and `dropAppFrame` make that operable.
- **Retain over discard for future epochs:** no silent loss when a hub temporarily omits a commit, at
  the cost that a forging hub can hold delivery until an operator drop.
- **Below-epoch fails closed:** the real handle cannot authenticate an earlier epoch's sender.

## Verification

Learning loop, four phases, then three blind Codex whole-branch reviews. Every finding was fixed
test-first and mutation-checked. Final gate after rebasing onto main: forced `test:types test:unit`
49/49 with 0 cached, RPC conformance 51 real / 51 fake, hub conformance, integration 8 files / 43 tests,
lint clean.

## Follow-on

- Host handle access for `mls-rpc` reshapes `pending.persistOpened` so the host owns the lock and write
  order: `2026-09-26-mls-rpc-host-handle-access.complete.md`, same 0.10 release
  (`../milestones/v0.10-release.md`).
- Accepted: the seal barrier resolves at anchor assignment, before anchor-store I/O, so a reentrant
  dispatch from the anchor save remains possible. The commit walk accepts a short, one-shot
  below-cursor fork reveal; only its full pages are bounded.
- Kubun adoption is tracked in Kubun's `next/` (`2026-09-25-kumiai-0-10-adoption.md`).
