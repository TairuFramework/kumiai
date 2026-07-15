# Upgrade ts-mls to stable v2.0.0

> **Relocated from enkaku** (0.18 stack split, 2026-06-30). MLS/ts-mls moved to kumiai (`@kumiai/mls`); enkaku no longer depends on ts-mls. Origin/`completed/` links point at the **enkaku** repo.


When ts-mls releases a stable 2.0.0, update `pnpm-workspace.yaml` from the currently pinned `2.0.0-rc.13` to `^2.0.0`. Verify no API changes between the latest RC and stable.

As of 2026-05-27, npm `dist-tags` show `latest: 1.6.2` and `rc: 2.0.0-rc.13` — stable not yet released. Keep tracking RC bumps until then.

## On upgrade: re-check the sender-data reimpl

`packages/mls/src/sender-data.ts` reimplements RFC 9420 §6.3.2 sender-data decrypt because
ts-mls `2.0.0-rc.13` ships `decryptSenderData` but does not re-export it from the package
index (the `exports` map exposes only `.`, so deep imports are blocked). See
`docs/superpowers/specs/2026-07-15-committer-reader-design.md`.

When adopting stable: check whether ts-mls now re-exports `decryptSenderData` (and the
sender-data TLS codecs). If so, delete `sender-data.ts` and delegate `GroupHandle`'s
sender-leaf lookup to ts-mls's own — the reimpl exists only to route around the missing
export.
