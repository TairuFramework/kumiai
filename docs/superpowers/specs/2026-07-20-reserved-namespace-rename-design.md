# Reserved namespaces say `kumiai`

**Date:** 2026-07-20
**Status:** approved, ready to plan
**Lands in:** PR #7 (`feat/app-lane-delivery`), by ruling — one coordinated break for Kubun to migrate against once.

## The problem

kumiai reserves two namespaces and neither is named after kumiai. One is a generic English word a host
app naturally reaches for; the other borrows a different layer's name.

**`group.*` — control-ledger entry types.** Reserved at `packages/mls/src/envelope-fold.ts:22` and
enforced at `:82-84`: an unknown `group.*` type does not get ignored, it **rejects the whole commit**
(`unknown group.* type`). Kubun hit exactly this defining `group.settings`. `group.` is the obvious
prefix for an app's own group-scoped entries, so hosts will keep walking into it.

**`enkaku/*` — topic labels.** `packages/rpc/src/topic.ts:6,9,12,14` and
`packages/broadcast/src/topic.ts:5`. These are kumiai's reserved labels, living in the kumiai repo,
wearing `@enkaku`'s name. The `INBOX_LABEL` doc already says it exists "so it never collides with an
application protocol of the same name" — the collision-avoidance intent is explicit; the prefix points
at the wrong package.

**The fail-closed behaviour is correct and is kept.** An unknown entry in a reserved,
authority-bearing namespace must never be surfaced unread. The defect is the choice of prefix, not the
strictness.

## Rulings that scope this

Four open calls were settled before design:

1. **Scope: both namespaces.** Not `group.*` alone.
2. **Migration: hard cutover, no shim, no compat window.** There is no persistent state to survive the
   rename — dev/test groups only, recreated at will. This is what makes the rest of the design small,
   and it is the assumption everything below rests on. If it turns out false, this spec is void.
3. **Placement: PR #7.** Not a separate branch off main.
4. **No tripwire on the old spellings.** `group.*` becomes host space entirely. See Accepted Risks.

## New spellings

| Old | New | Site |
| --- | --- | --- |
| `group.` (prefix) | `kumiai.` | `mls/src/envelope-fold.ts:22` |
| `group.role` | `kumiai.role` | `mls/src/roster.ts:10` |
| `group.recovery-request` | `kumiai.recovery-request` | `mls/src/recovery.ts:25` |
| `group.recovery-groupinfo` | `kumiai.recovery-groupinfo` | `mls/src/recovery.ts:29` |
| `enkaku/inbox/v1` | `kumiai/inbox/v1` | `rpc/src/topic.ts:6` |
| `enkaku/commit/v1` | `kumiai/commit/v1` | `rpc/src/topic.ts:9` |
| `enkaku/rendezvous/v1` | `kumiai/rendezvous/v1` | `rpc/src/topic.ts:12` |
| `enkaku/discovery/v1` | `kumiai/discovery/v1` | `rpc/src/topic.ts:14` |
| `enkaku/topic/v1` | `kumiai/topic/v1` | `broadcast/src/topic.ts:5` |

Every value sits behind a named constant. **The constant names do not change — only their values.**
Nine definition lines, plus the reason string at `envelope-fold.ts:83` and ~48 `group.*` literals in
tests.

`enkaku/` appears in 32 files under `packages/`. All but the two `topic.ts` files above are `@enkaku/*`
package imports and are untouched — only the five label definitions move. Any find-and-replace over
`enkaku/` that is not anchored to those two files will rewrite the import graph.

## What changes semantically

Exactly one thing: **`group.*` stops failing closed and becomes application space.** Everything else is
a value substitution with no behavioural consequence.

This is the change Kubun is blocked on, so it gets a positive test rather than resting on the absence
of a rejection: a host-defined `group.settings` entry is **surfaced**, not rejected. A rename proved
only by tests that stopped failing is a rename proved by nothing.

## Verification

- **New:** host-defined `group.*` entry is surfaced by the envelope fold (the Kubun case).
- **Updated:** `packages/mls/test/envelope-fold.test.ts:131,144` — asserts both the old type name and
  the literal reason string `'unknown group.* type'`; both move to `kumiai.*`.
- **Mechanical:** ~48 `group.*` literals across the test suites.
- **Expected untouched:** no test asserts a topic-label string. They assert derived topic IDs, which
  are value-neutral under a label rename. **These suites should stay green without being edited. A red
  one is a real finding, not a rename artifact, and must be investigated rather than updated.**
- Full gate: `pnpm exec turbo run test:types test:unit --force` (confirm `Cached: 0`),
  `pnpm exec vitest run --root tests/integration`, `rtk proxy pnpm run lint`.

## Documentation

- `packages/mls/README.md` — old names updated.
- `docs/agents/architecture.md` — **new** reserved-namespace section. The file has none today, which is
  why Kubun discovered the reservation by hitting a wall. States the contract: `kumiai.` entry types and
  `kumiai/` topic labels are reserved by kumiai; application types must not use either prefix.
- Historical plan docs under `plans/completed/` and `plans/backlog/` mention the old names and **stay as
  written** — they record what was true when they ran.
- `docs/agents/plans/next/2026-07-16-reserved-namespace-prefix.md` deleted on completion.

## Release

Breaking changesets for `@kumiai/mls` (entry types), `@kumiai/rpc` and `@kumiai/broadcast` (topic
labels). Hub packages carry opaque topic IDs and need none.

## Accepted risks

**The type checker stays silent through a wire-format break.** Constant names are unchanged, so a host
importing `ROLE_ENTRY_TYPE` or `COMMIT_LABEL` keeps compiling across the break; a host that hardcoded
`'group.role'` breaks with no diagnostic. Kubun migrates by re-installing and recreating groups, not by
fixing compile errors. The changesets must say this in prose, because nothing else will say it.

**`group.role` inverts meaning silently.** After the rename it is a legal application entry type,
surfaced unread, where today it is authority-bearing and fails closed. So the one string whose meaning
inverts is the one governing the roster. A tripwire keeping the three old spellings rejected was
considered and declined: it would cost three strings to remove later and forbid hosts a name they may
want, and with nothing live, nothing should be emitting them. **This is safe only while ruling 2 holds.**

**Topic-label renames partition silently.** Members that derive labels out of lockstep land on
different topic IDs with no error — the failure class this branch was opened to fix. A hard cutover is
safe here only because no deployment spans the change. Same dependency on ruling 2.
