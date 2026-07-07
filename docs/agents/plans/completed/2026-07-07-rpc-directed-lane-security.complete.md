# RPC directed-lane + recovery security — completed

**Status:** complete
**Date:** 2026-07-07
**Branch:** `rpc-directed-lane-security`
**Origin:** 2026-07 audit remediation milestone, Phase 1 item 1 (critical). Closed audit
findings: 1 critical, 2 high, 1 low.

## Goal

Harden `@kumiai/rpc` against a **malicious hub** (may read, drop, reorder, inject, and lie
about `senderDID`): make the directed 1:1 RPC lane confidential and sender-authenticated,
and stop the recovery rendezvous leaking MLS group state.

## What was built

- **Directed lane sealed + authenticated.** Directed frames are now sealed with the same
  MLS `crypto.wrap`/`unwrap` primitive the broadcast lane uses — the **whole** hub-tunnel
  frame (sessionID, seq, kind, body), so the hub sees only `{ topic, ciphertext }`. A new
  `sealDirectedHub` adapter (`packages/rpc/src/directed-crypto.ts`) wraps the hub view for
  the client. The inbox acceptor (`packages/rpc/src/directed.ts`) was rewritten to own a
  single serialized sealed drain that feeds decrypted frame bytes into a per-session
  in-memory transport.
- **Sender identity from MLS only.** The authenticated `senderDID` recovered by `unwrap`
  (never the hub-asserted `message.senderDID`) drives everything: each tunnel session is
  bound to the sender recovered from its first frame; later frames whose recovered sender
  differs are dropped (splice defence); the reply topic is resolved from the bound DID. A
  frame that unwraps without any recovered sender is dropped, never falling back to the
  hub's claim. This replaced the old `requireAuth: false` forgery gap.
- **Recovery replies sealed 1:1.** `GroupMLS.exportGroupInfo(requesterDID)` now returns
  bytes sealed to the requesting member's leaf; `applyRecovery` opens them. The recovery
  request carries `requesterDID` so the responder knows whose leaf to seal to. `recover()`
  treats an un-openable / hub-injected reply as no-advance rather than rejecting.
- **DoS caps.** Recovery `requestID` (request and reply) and `requesterDID` are
  length-capped on decode, bounding the attacker-controlled map keys in the peer's
  rendezvous state.

## Key design decisions (rationale preserved)

- **`wrap`/`unwrap`, not the `Encryptor` interface.** An MLS application-message unwrap does
  two jobs at once — decrypt AND recover the authenticated sender. The hub-tunnel
  `Encryptor` type is too narrow (drops the sender), so the directed lane reuses
  `GroupCrypto.wrap`/`unwrap`, matching the broadcast lane.
- **Serialized inbound drain.** `unwrap` is async (real MLS decrypt has variable latency).
  Firing independent concurrent tasks per inbound frame could resolve out of dispatch order
  — racing to double-create a session, or feeding a tunnel out of wire order (dropped as
  stale seq). Processing is chained onto a running tail promise to preserve arrival order.
  Tradeoff: cross-session head-of-line blocking on a shared inbox topic (acceptable under a
  hub that can already drop/reorder).
- **Recovery sealing lives in the MLS consumer.** Sealing to the requester's leaf keeps the
  crypto where the key schedule lives, gives forward secrecy, and keeps `recoverySecret`
  single-purpose (topic/rendezvous derivation only — never an encryption key).
- **Non-goal: member-to-member confidentiality on the directed lane.** Group `wrap` means a
  member holding the group app key could read a misdelivered directed frame; the lane is
  confidential from the hub and non-members, same guarantee as broadcast. Recovery replies
  *are* 1:1.

## Verification

Full `@kumiai/rpc` suite green (68 tests, 16 files), biome clean, types build. New adversary
tests: hub-can't-read (wire bytes are ciphertext), session-splice rejection, null-sender
drop, async-unwrap ordering regression, recovery wrong-recipient rejection, recovery decode
caps/truncation. Directed request/stream/channel still work end-to-end through
`createGroupPeer`, now encrypted.

## Follow-on work

- **Session GC / anti-accumulation** (surfaced by the final review; pre-existed in the old
  acceptor) — see `docs/agents/plans/backlog/rpc-directed-session-gc.md`.
- **Minor cleanups + durable-hub readiness** — see
  `docs/agents/plans/backlog/rpc-directed-lane-cleanups.md`.
- **Real-hub end-to-end** for the directed security properties is tracked in the Phase 1
  test-gaps item (`docs/agents/plans/next/2026-07-07-test-gaps.md`): the current adversary
  tests use an in-memory hub double.
