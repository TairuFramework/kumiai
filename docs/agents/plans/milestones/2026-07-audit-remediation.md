# Milestone: 2026-07 audit remediation

**Origin:** full-repo audit performed 2026-07-02 against commit `bb343d9` (all 7 packages'
`src/`, `tests/`, root config, CI, docs). All findings were extracted into `next/` and
`backlog/` plan docs; this milestone tracks the sequencing.

All line numbers in the extracted docs reference the tree at commit `bb343d9`.

## Goal

Close the audit's security and correctness findings, in priority order, so the stack
actually delivers the E2EE guarantees it exists for, then clear the correctness,
API-consistency, and infra debt behind them.

## Phase 1 — immediate priorities (`next/`)

In order:

1. [Encrypt + authenticate the directed RPC lane](../next/2026-07-07-rpc-directed-lane-security.md) —
   the hub can currently read and forge exactly the traffic this stack exists to protect. (critical)
2. [Enforce `GroupPermission` at the MLS boundary](../next/2026-07-07-mls-permission-enforcement.md) —
   permission checks in mutating ops, a default commit policy, `processWelcome` token handling.
3. [Serialize `GroupHandle` state + zero consumed secrets](../next/2026-07-07-mls-state-serialization-secret-hygiene.md) —
   the two real crypto-hygiene holes.
4. [Fix the hub `receive` lifecycle](../next/2026-07-07-hub-receive-lifecycle.md) —
   drain-then-attach, pre-aborted signal, swallowed write errors.
5. [Key-package + subscribe caps](../next/2026-07-07-hub-keypackage-subscribe-caps.md) —
   quota/DoS hardening on the hub store (promoted + extended from the pre-existing
   `hub-keypackage-quotas` backlog item).
6. [Make anycast sound](../next/2026-07-07-anycast-soundness.md) —
   suppress only on success replies; attribute replies by the authenticated `senderDID`.
7. [Infra batch](../next/2026-07-07-infra-batch.md) — mechanical, one PR: non-mutating lint in
   CI, changesets release workflow, declare vitest, fix the turbo task graph.
8. [Close test gaps](../next/2026-07-07-test-gaps.md) — persist→restore path, real-hub
   integration, concurrency tests.

## Phase 2 — extracted backlog

Grouped by subsystem; each doc is roughly one PR of related fixes. Note the first two
contain **high-severity correctness** items (`to()` ready-gating, `resync()` tail
serialization, the dead durable-ack contract) — pull them forward at the next triage once
Phase 1 lands.

- [rpc peer lifecycle hardening](../backlog/2026-07-07-rpc-peer-lifecycle-hardening.md)
- [hub-tunnel reliability](../backlog/2026-07-07-hub-tunnel-reliability.md)
- [broadcast robustness](../backlog/2026-07-07-broadcast-robustness.md)
- [mls API hardening](../backlog/2026-07-07-mls-api-hardening.md)
- [hub protocol/server cleanup](../backlog/2026-07-07-hub-protocol-server-cleanup.md)
- [infra cleanup](../backlog/2026-07-07-infra-cleanup.md)

## Related pre-existing backlog

- `backlog/mls-capability-revocation.md` — design together with permission enforcement
  (both need committer-identity → capability resolution at `processMessage` time).
- `backlog/hub-group-member-expiry.md`, `backlog/peer4-mls-leaf-rotation.md`,
  `backlog/ts-mls-v2-stable-upgrade.md` — untouched by this milestone.

## Positive audit notes (no action)

- Conventions near clean across all packages (no `interface`, `any`, `T[]`, lowercase
  acronyms; ES `#fields` used correctly) — single `readonly` violation folded into the
  infra batch.
- Dependency ranges clean: cross-repo deps (`@sozai/*`, `@kokuin/*`, `@enkaku/*`) all via
  `catalog:` with `^` ranges, no `workspace:` leaks; internal deps `workspace:^`; devDep
  drift effectively zero via the catalog and `@kigu/dev`.

## Exit criteria

- All Phase 1 docs completed (moved to `completed/`).
- Phase 2 docs triaged into `next/` or explicitly deferred.
