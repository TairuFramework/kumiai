# Milestone: 2026-07 audit remediation

**Origin:** full-repo audit performed 2026-07-02 against commit `bb343d9` (all 7 packages'
`src/`, `tests/`, root config, CI, docs). All findings were extracted into `next/` and
`backlog/` plan docs; this milestone tracks the sequencing.

All line numbers in the extracted docs reference the tree at commit `bb343d9` and have drifted
substantially — the control ledger, app-lane delivery, directed-lane security, and
forward-compatibility work have all landed since. Re-verify a finding against HEAD before acting on
it; the 2026-07-23 triage found one whose named mechanism no longer exists (see Status below).

## Status — 2026-07-23 triage

**Phase 1 has not moved since 2026-07-07.** Items 1–3 landed in July; items 4–8 are still open in
`next/` with no owner. Meanwhile Phase 2's note to "pull them forward at the next triage once Phase 1
lands" gated three **high**-severity correctness findings behind that stalled **medium** work — a
priority inversion rather than a sequencing decision.

Resolved as follows:

- The three high items were extracted into
  [high-severity correctness](../next/2026-07-23-high-severity-correctness.md) at priority 1, ahead
  of every Phase 1 item. All three were re-verified against `5eb220a` and confirmed still open, with
  current line numbers. The `resync()` finding is **restated**: the `handshakeTail` it named no
  longer exists; the serialization mechanism is now `commitTail` via `runSerial`, and `resync()` is
  the sole `rebuildEpoch` caller that takes no lock.
- Their source docs — `rpc-peer-lifecycle-hardening` and `hub-tunnel-reliability` — keep every
  medium and low finding and stay in Phase 2. Their "pull forward at next triage" priority lines are
  discharged.
- `hub-protocol-server-cleanup`'s lead item ("no protocol version anywhere") is **done** — the
  `hub/v1/` namespace shipped in
  [forward compatibility](../completed/2026-07-21-forward-compatibility.complete.md). Struck in
  place rather than deleted, so the surrounding line numbers still make sense.
- `hub-protocol-server-cleanup`'s scope widened to cover `@kumiai/hub-tunnel`'s schema `$id`s.
  Its long-standing "`PublishParams` defined three times / hub-tunnel's `HubLike` re-declares the
  store surface" item was **verified and found void**: `@kumiai/hub-protocol` declares none of the
  port types the finding says should be imported from it, `HubLike` was renamed to `MailboxHub` in a
  shipped release, and the three data types the two packages genuinely share are structurally
  identical. One real defect fell out of the check — `LogHub.publish` is typed narrower than
  `HubStore.publish`, dropping `deduped` — and was folded into the wire-response gap it belongs to.
- A new sibling doc, [rpc API surface](../backlog/rpc-api-surface.md), was split out of
  `rpc-peer-lifecycle-hardening` for public-surface typing debt — different work from lifecycle
  correctness.

Phase 1's remaining items keep their existing priorities (4–7) and are now genuinely below the
promoted work rather than nominally above it.

## Related milestones

The 2026-07-20 API-surface audits produced a separate body of findings, indexed by change cost
rather than by subsystem:

- [pre-1.0 breaking API surface](./pre-1.0-breaking-api.md) — items whose cost is a `minor` while
  every package is 0.x (verified 2026-07-23: all ten are 0.4.x) and a `major` after.
- [non-breaking API work](./non-breaking-api.md) — the short list that can land any time, plus
  `GroupAnchor.version` enforcement, which has a ship-before-needed deadline of its own.

Those findings live in the same per-package backlog docs this milestone sequences; the two axes
cross-reference rather than compete.

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

Grouped by subsystem; each doc is roughly one PR of related fixes. The high-severity items these
docs once carried were promoted on 2026-07-23 — see Status above.

- [rpc peer lifecycle hardening](../backlog/2026-07-07-rpc-peer-lifecycle-hardening.md)
- [rpc API surface](../backlog/rpc-api-surface.md) — split out 2026-07-23
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
