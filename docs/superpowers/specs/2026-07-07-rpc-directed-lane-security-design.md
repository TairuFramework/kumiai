# RPC directed-lane + recovery security — design

**Date:** 2026-07-07
**Origin:** `docs/agents/plans/next/2026-07-07-rpc-directed-lane-security.md`
(2026-07-02 full-repo audit, commit `bb343d9`), milestone
`docs/agents/plans/milestones/2026-07-audit-remediation.md` — Phase 1 item 1 (critical).

## Problem

`@kumiai/rpc` runs two lanes over the hub:

- The **broadcast lane** (`peer.ts:101-125`) is MLS-protected: it seals payloads with
  `crypto.wrap` and, on receive, recovers the authenticated MLS sender via `crypto.unwrap`
  (`{ payload, senderDID }`), stamping that sender onto the message so responders make
  authorization decisions against a cryptographically-authenticated identity.
- The **directed 1:1 lane** (`directed.ts`) does none of this. It uses the plain
  `createHubTunnelTransport`, so directed RPC frames transit the hub **in plaintext** and
  the inbox `Server` runs with `requireAuth: false`. Sender identity comes only from the
  hub-asserted `message.senderDID`.

Under the stack's threat model the hub is an adversary — the traffic this stack exists to
protect. A malicious hub can therefore **read** every directed RPC payload and **forge**
directed traffic, including lying about `senderDID` (the hub is the party that verifies the
signed-message `iss`, so its identity claims are untrustworthy). Separately, the recovery
rendezvous on the handshake lane publishes `exportGroupInfo()` bytes **unencrypted**,
leaking sensitive MLS group state to the hub and to non-members.

## Threat model

**Malicious hub.** The hub may read, drop, reorder, inject, and lie about `senderDID`.
Consequences: (1) sender identity is trusted **only** when recovered from MLS `unwrap`,
never from the hub-asserted `iss`/`message.senderDID`; (2) confidentiality of RPC payloads
and of recovery `GroupInfo` must hold against the hub.

Non-goal: **member-to-member** confidentiality on the directed lane. `crypto.wrap` is a
group-level MLS application message — every current member holds the app key. A directed
frame is hidden from the hub and from non-members (topic addressing + subscription), but a
member who obtained the ciphertext (e.g. a malicious hub misdelivering it) could decrypt
it. This matches the broadcast lane's existing guarantee. Recovery replies *are* 1:1
(sealed to the requester's leaf); if the directed lane later needs pairwise confidentiality
it requires an HPKE surface like recovery, tracked separately.

## Key structural fact

An MLS application message unwrap does **two jobs at once**: it decrypts the ciphertext
*and* recovers the authenticated sender from the MLS sender data. The existing
`Encryptor` interface in `@kumiai/hub-tunnel` (`{ encrypt, decrypt }` → bytes) is too
narrow — it drops the sender. The fix therefore uses `crypto.wrap` / `crypto.unwrap`
(already on the `GroupCrypto` port, `UnwrapResult = { payload, senderDID? }`), **not** the
`Encryptor` path.

## Design

### 1. Directed lane confidentiality + authenticated sender (Critical + High #1)

**Seal the whole frame.** Directed frames are sealed with `crypto.wrap` on send and opened
with `crypto.unwrap` on receive. The **entire** encoded hub-tunnel frame (`sessionID`,
`seq`, `kind`, `body`) is encrypted, so the hub sees only `{ topic, ciphertext }`. This is
the whole-frame variant of the existing `createEncryptedHubTunnelTransport` wiring, but
using an `unwrap`-based primitive that surfaces `senderDID` instead of the senderDID-
dropping `Encryptor`.

**Encrypted directed transport.** Introduce an encrypted directed transport built over
`mux.hubLike` that wraps outbound payloads with `crypto.wrap` and, on receive, opens them
with `crypto.unwrap`, surfacing the recovered `senderDID`. Two viable factorings; pick
during planning:

- Generalize `createEncryptedHubTunnelTransport` to accept a `wrap` / `unwrap`
  (`UnwrapResult`) pair in addition to (or in place of) `Encryptor`, stamping the recovered
  `senderDID` onto the decrypted `StoredMessage`; or
- Add a dedicated encrypted directed transport in `@kumiai/rpc` that composes the plain
  tunnel with `wrap`/`unwrap`.

Prefer reusing the hub-tunnel encrypted path if the generalization stays clean; otherwise
keep it in rpc. This is an implementation-plan decision, not a spec-level one.

**Bind each session to its MLS sender.** A directed tunnel session is 1:1. The inbox
acceptor (`createInboxAcceptor`) currently peeks the raw frame via `mux.onInbound` to read
`sessionID` and detect new sessions, and resolves the reply topic from the hub-asserted
`message.senderDID`. Change:

- The accept-peek decrypts the inbound envelope and recovers `senderDID` from `unwrap`
  (the frame header — `sessionID`, `kind` — is inside the encrypted frame under whole-frame
  sealing, so the peek must decrypt to read it).
- On first frame of a session, **bind the session to the recovered MLS `senderDID`**.
- Subsequent frames whose recovered `senderDID` ≠ the session's bound DID are dropped
  (a malicious hub cannot splice another member's frames into an established session).
- The reply topic is resolved from the **bound MLS DID**, never from
  `message.senderDID`.

This makes identity enforcement cryptographic at the transport boundary and removes the
`requireAuth: false` forgery gap: a directed handler's caller identity is the
MLS-authenticated DID the session is bound to.

### 2. Recovery reply sealing (High #3)

The recovery responder (`peer.ts:201-224`) publishes `exportGroupInfo()` bytes plaintext on
the handshake topic. Seal them, with the crypto owned by the MLS consumer (where the key
schedule lives), not by rpc:

- **`GroupMLS` contract change** (`crypto.ts`):
  - `exportGroupInfo(requesterDID: string): Promise<Uint8Array>` returns bytes **sealed to
    the requester's MLS leaf** (HPKE / equivalent). Only that requester can open them — not
    the hub, not other members.
  - `applyRecovery(sealed: Uint8Array)` opens the sealed bytes before applying.
- **Recovery request carries the requester DID.** Today `encodeRecoveryRequest` carries only
  `requestID` (`recovery.ts:9-15`). Extend it to `{ requestID, requesterDID }` so the
  responder knows whose leaf to seal to. Update `handleRecoveryRequest` to pass
  `requesterDID` into `exportGroupInfo`, and the request/reply plumbing accordingly.

This keeps `recoverySecret` single-purpose (topic/rendezvous derivation only — never an
encryption key), gets forward secrecy from the MLS layer, and makes recovery replies truly
1:1.

### 3. requestID DoS cap (Low)

`decodeRecoveryRequest` / `decodeRecoveryReply` (`recovery.ts:13,29-47`) decode an
attacker-controlled `requestID` that becomes a map key in `pendingReplies`,
`suppressedRequests`, and `recoveryWaiters` (`peer.ts:193-196`) — unbounded memory
amplification. Cap the decoded `requestID` length on decode (encode already caps at
`0xffff`; enforce a much tighter bound — the ID is a random handle, not user data).

## Components touched

| File | Change |
|------|--------|
| `packages/rpc/src/directed.ts` | Encrypted directed client + acceptor; session bound to MLS sender; reply topic from bound DID |
| `packages/rpc/src/peer.ts` | Pass `crypto.wrap`/`unwrap` into directed lane; thread `requesterDID` through recovery request/reply |
| `packages/rpc/src/recovery.ts` | `{ requestID, requesterDID }` codec; `requestID` length cap |
| `packages/rpc/src/crypto.ts` | `GroupMLS` port: `exportGroupInfo(requesterDID)` → sealed, `applyRecovery` opens |
| `packages/hub-tunnel/src/encrypted-transport.ts` (maybe) | Generalize to a `wrap`/`unwrap` pair surfacing `senderDID`, if that factoring is chosen |

## Testing

- **Hub cannot read:** a directed request's on-wire hub payload is ciphertext; the plaintext
  RPC params do not appear.
- **Forged sender rejected:** a frame whose MLS `unwrap` sender ≠ the session's bound DID is
  dropped; a handler is never invoked with a hub-asserted-but-unauthenticated identity.
- **Session binding:** frames spliced from a different member into an established session are
  dropped.
- **Reply routing:** replies target the bound MLS DID's inbox, not a hub-supplied topic.
- **Recovery seal round-trip:** `exportGroupInfo(requesterDID)` → `applyRecovery` opens for
  the intended requester; a different member / the hub cannot open it. Request carries
  `requesterDID`.
- **requestID cap:** an over-long decoded `requestID` is rejected before it can be stored as
  a map key.

## Open implementation-plan questions (not blocking the spec)

- Exact transport factoring for §1 (generalize `createEncryptedHubTunnelTransport` vs a new
  rpc-local encrypted directed transport).
- Whether the whole-frame accept-peek shares one decrypt with the per-session tunnel or
  accepts a second decrypt (current acceptor already double-processes frames, so a second
  decrypt is consistent).
- The concrete sealing primitive behind `exportGroupInfo(requesterDID)` lives in the MLS
  consumer, below this interface — this spec only fixes the `@kumiai/rpc` contract.
