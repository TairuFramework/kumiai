# Reserved namespaces should say `kumiai`, not `group.` and `enkaku/`

**Status:** ready to brainstorm/plan. Surfaced 2026-07-16 as an aside during app-lane-delivery; **not**
part of that branch.
**Priority:** real host-blocking footgun (Kubun hit it), and **breaking** — the window to do it cheaply
is closing. Pre-1.0, Kubun mid-migration to `@kumiai/rpc` 0.3, control-ledger lane freshly shipped.
**Blast radius:** `@kumiai/mls` (ledger entry types), `@kumiai/rpc` + `@kumiai/broadcast` (topic
labels), and every host protocol/ledger built on them.

## The problem

kumiai reserves **two** namespaces and neither one is named after kumiai. One is a generic English word
a host app naturally reaches for; the other borrows a different layer's name.

### 1. `group.*` — control-ledger entry types (`@kumiai/mls`)

Reserved at `packages/mls/src/envelope-fold.ts:22` (`GROUP_TYPE_PREFIX = 'group.'`) and enforced at
`:81-84`:

```ts
// `group.*` is reserved for @kumiai/mls; an unknown one fails closed.
if (entry.type.startsWith(GROUP_TYPE_PREFIX)) {
  return { ok: false, reason: 'unknown group.* type', entryID }
}
```

The only known types are `group.role` (`packages/mls/src/roster.ts:10`), `group.recovery-request` and
`group.recovery-groupinfo` (`packages/mls/src/recovery.ts:25,29`).

**How it bites:** a host that defines, say, `group.settings` does not get its entry ignored — the
envelope fold **rejects the whole commit** (`unknown group.* type`). Kubun hit exactly this. `group.` is
the obvious prefix for an app's own group-scoped entries, so hosts will keep walking into it.

**The fail-closed behaviour is correct and must be kept.** An unknown entry in a reserved,
authority-bearing namespace must never be surfaced unread — silently passing it on would be the worse
bug. The defect is the *choice of prefix*, not the strictness.

### 2. `enkaku/*` — topic labels (`@kumiai/rpc`, `@kumiai/broadcast`)

- `packages/rpc/src/topic.ts:6,9,12,14` — `INBOX_LABEL = 'enkaku/inbox/v1'`,
  `COMMIT_LABEL = 'enkaku/commit/v1'`, `RENDEZVOUS_LABEL = 'enkaku/rendezvous/v1'`,
  `DISCOVERY_PREFIX = 'enkaku/discovery/v1'`
- `packages/broadcast/src/topic.ts:5` — `TOPIC_INFO_PREFIX = 'enkaku/topic/v1'`

These are kumiai's reserved labels, living in the kumiai repo, wearing `@enkaku`'s name. Same class of
mistake: the namespace does not identify its owner. The `INBOX_LABEL` doc even says it exists "so it
never collides with an application protocol of the same name" — the collision-avoidance intent is
already explicit; the prefix just points at the wrong package.

## The ask

Move kumiai's reserved namespaces under a prefix that names kumiai — `kumiai.` for ledger entry types,
`kumiai/` for topic labels — freeing `group.*` (and `enkaku/*`) for hosts and for the layer that
actually owns that name. Keep the fail-closed rule; only the prefix changes.

## Why it is breaking, and why now

- **Entry types are signed into tokens and folded into the ledger head.** Renaming `group.role` →
  `kumiai.role` changes the entries, so every existing ledger folds to a different head. Existing
  ledgers do not survive without a migration.
- **Topic labels are hashed into topic IDs** (`deriveTopicID(secret, epoch, label, scope)`). Renaming
  moves every topic. Members that upgrade out of lockstep derive different topics and silently
  partition — the same failure class the app-lane anchor work just hit.

Both costs are near-zero today and grow with every real deployment. Pre-1.0 with a locked package group
is the moment.

## Open calls (for brainstorming)

- **Scope:** both namespaces, or only `group.*` (the one actively blocking Kubun)? Renaming the topic
  labels is the more dangerous of the two (silent partition) and the less urgent.
- **Migration:** hard cutover (pre-1.0, coordinate with Kubun, no compat shim) vs. a transitional
  accept-both period? A shim on the ledger side means accepting two spellings of an authority-bearing
  entry, which is its own hazard.
- **Should hosts get a *sanctioned* reserved-free convention** (e.g. an explicit "app types must not
  start with `kumiai.`" rule documented in `docs/agents/architecture.md`) so this is a stated contract
  rather than a discovered one?
- Coordinate the cutover with Kubun's in-flight 0.3 migration so it lands once, not twice.
