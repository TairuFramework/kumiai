# The version lock nothing enforces, and what `mls-hub` first publishes at

**Priority:** medium — neither is a defect today, but the second becomes permanent at the next
`changeset publish` and cannot be taken back.
**Origin:** the 2026-08-01 project-loop review. Both surfaced from the same check: the docs describe
the eleven packages as a locked group, and the tooling does not lock them.

## 1. "Locked as a group while pre-1.0" is a claim nothing enforces

`docs/agents/development.md` and `docs/agents/architecture.md` both say the packages move as a
group. `.changeset/config.json` has `"fixed": []` and `"linked": []`, so changesets bumps each
package only when a changeset names it. The versions have already diverged accordingly:

| Version | Packages |
| --- | --- |
| 0.4.3 | `rpc` |
| 0.4.2 | `mls-rpc` |
| 0.4.1 | `broadcast`, `hub-client`, `hub-conformance`, `hub-protocol`, `hub-server`, `hub-tunnel`, `mls`, `rpc-conformance` |
| 0.0.0 | `mls-hub` |

Two ways to close it, and the choice is a real one:

- **Add all eleven to `fixed`.** Makes the docs true. Every release bumps every package, so a
  consumer pinning `@kumiai/broadcast` sees churn from work that never touched it. Defensible while
  pre-1.0 precisely because the group is tightly coupled — that is the stated reason for the lock.
- **Reword the docs.** "Locked" becomes "released together, versioned per package". Cheaper, and
  honest about what the tooling does. Loses the property that a matched version set is a coherent
  set, which is what the lock was for.

Worth noting the divergence is small and recent, so either direction is cheap right now.

## 2. `@kumiai/mls-hub` would first publish at 0.1.0

The manifest is at `0.0.0`, the package is not `private`, and `npm view @kumiai/mls-hub` 404s — it
has never been published. Three pending changesets name it `minor`, so the next release takes it
`0.0.0` → `0.1.0` while the rest of the group goes to `0.5.0`.

That is a permanent version history for a package the roadmap describes as having a real surface,
and it reads as far less mature than its neighbours. Setting the manifest to `0.4.1` before the next
release lands it at `0.5.0` with everything else. Doing nothing is also a decision — just one that
cannot be undone once `0.1.0` is on the registry.

Resolving item 1 with a `fixed` group would settle this one as a side effect, which is the argument
for taking them together.

## Context

21 changesets are pending and nothing has been published since the 0.4.x line. Releases are manual
by decision (2026-07-23), so the deadline here is whenever that release happens — but it is a
deadline, not an open question.
