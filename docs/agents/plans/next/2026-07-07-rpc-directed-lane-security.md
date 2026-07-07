# Encrypt + authenticate the directed RPC lane and recovery replies

**Priority:** 1 — critical. The hub can currently read and forge exactly the traffic this
stack exists to protect.
**Origin:** 2026-07-02 audit (commit `bb343d9`), milestone
`milestones/2026-07-audit-remediation.md`.

## Findings

### Critical

- **`packages/rpc/src/directed.ts:28,84` — directed 1:1 lane is plaintext.** The lane is
  built with the plain `createHubTunnelTransport` (never
  `createEncryptedHubTunnelTransport` or MLS `wrap`/`unwrap`), so all directed RPC
  payloads transit the hub readable and injectable by it — while the broadcast lane *is*
  MLS-wrapped (`peer.ts:105-120`). Fix: run directed tunnels through the encrypted
  hub-tunnel variant or `wrap`/`unwrap` from `GroupCrypto`.

### High

- **`packages/rpc/src/directed.ts:63` — inbox server has `requireAuth: false`** and the
  tunnel adds no message authentication, so anyone who can publish to the inbox topic can
  invoke directed handlers with a forged identity. Fix: require signed enkaku messages or
  bind the lane to MLS-authenticated sender identity.
- **`packages/rpc/src/peer.ts:210-217` — recovery replies leak MLS GroupInfo.** The
  recovery responder publishes `exportGroupInfo()` bytes unencrypted on the handshake
  topic. Fix: encrypt recovery replies to the requester (or document that
  `exportGroupInfo` must return ciphertext).

### Low (same code area, fold in)

- `packages/rpc/src/peer.ts:201-224` + `recovery.ts:12-16` — recovery `requestID` is an
  unbounded attacker-controlled map key (`pendingReplies`/`suppressedRequests`) — memory
  amplification. Fix: cap decoded requestID length.

## Scope

`@kumiai/rpc` (`directed.ts`, `peer.ts`, `recovery.ts`); possibly `@kumiai/hub-tunnel`
(encrypted transport wiring) and `@kumiai/mls` (`GroupCrypto` wrap/unwrap surface).
