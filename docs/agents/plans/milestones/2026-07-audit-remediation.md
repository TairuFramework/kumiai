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

1. ~~Encrypt + authenticate the directed RPC lane~~ — **done**, see
   [completed](../completed/2026-07-07-rpc-directed-lane-security.complete.md).
2. ~~Enforce `GroupPermission` at the MLS boundary~~ — **done**, see
   [completed](../completed/2026-07-11-mls-permission-enforcement.complete.md). Landed as a signed,
   anchor-rooted control ledger folded into a roster and enforced as a receiving-side commit policy;
   the capability chain was retired rather than fixed.
3. ~~Serialize `GroupHandle` state + zero consumed secrets~~ — **done**, see
   [completed](../completed/2026-07-11-mls-state-serialization-secret-hygiene.complete.md). Bundled
   into the same release as item 2, since both reshape the `@kumiai/mls` surface kubun consumes.
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

- `backlog/mls-capability-revocation.md` — **premise now stale.** Permission enforcement (item 2)
  closed the hole it targets: a removed member has no leaf, so a resync is refused outright, and
  the capability layer it proposed to revoke no longer exists. See the status update in that doc —
  it should only be revisited if a non-resync external join is ever wanted.
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
