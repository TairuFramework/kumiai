# Probe brief — members carry a 30-day retention request on app-topic subscribes

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

**Never run `git checkout`, `git restore`, or `git stash` on a file with uncommitted work.** That has
destroyed work on this plan twice. To revert a mutation, invert the edit by hand.

Small and mechanical. If it turns out not to be, report BLOCKED rather than growing it.

## Context: what is already committed and true

- The commit lane already carries a retention request: `mux.onInbound(commitTopicID, onCommitDelivery,
  { retention: commitLogRetentionSeconds })` (`peer.ts:~1353`), defaulting to
  `DEFAULT_COMMIT_LOG_RETENTION_SECONDS` = 30 days, overridable via `GroupPeerParams`.
- `HubMux.retain(topicID, options?)` passes `HubSubscribeOptions` through to `hub.subscribe`
  (`hub-mux.ts:111-115`). `retainTopic(topicID)` (the drain's listener-less subscribe) currently passes
  **nothing**.
- The app lane's subscribes pass **no retention today**, so app topics get the hub's default — which is
  the whole subject here.
- A subscription is never released: `retain`'s refcount tracks local listeners only, and a rotation
  tears down listeners, never subscriptions.

## The exact question

Do members request a 30-day retention on app-topic subscribe, overridable up to the operator cap?

## Relevant spec section (verbatim, §7)

> Members request **30 days** by default via `SubscribeParams.retention`
> (`hub-protocol/src/types.ts:84`) — aligned to the commit window so the membership-rebuild bound and
> the app-drain bound coincide (no partial-recovery gap). The hub **operator** governs real storage via
> the existing `maxRetention` cap; the hub is blind to groups and cannot enforce a per-group figure, so
> this is a default members carry, not a new mechanism. Per-member override up to the operator cap
> remains possible.

## Approved approach (follow it; BLOCKED if it fights the code)

1. **`appLogRetentionSeconds?: number` on `GroupPeerParams`**, defaulting to 30 days — mirroring
   `commitLogRetentionSeconds` in shape, default, and doc style. Say in the doc WHY it is 30 days: it is
   aligned to the commit window, so the membership-rebuild bound and the app-drain bound coincide and
   there is no span where a member can rebuild its membership but not its messages. A separate knob
   rather than one shared value, because the two bounds are aligned **by choice** and a host may have
   reason to move one.
2. **Every app-topic subscribe carries it.** Both the live listener subscribe and
   `mux.retainTopic` — the drain's listener-less subscribe is a subscribe, and it is the one that asks
   the hub to hold the log for a peer that is away. `retainTopic` will need to accept
   `HubSubscribeOptions`; keep it a pass-through.
3. Nothing else. This is a default members carry, not a mechanism.

## Known issue — do NOT fix here, do NOT report as a surprise

`hub-mux.ts:114` swallows every subscribe error (`.catch(() => {})`), including the
`RetentionExceededError` that `hub-protocol` raises rather than downgrade silently. So a host that
overrides retention **above the operator cap** is not downgraded — it is silently not subscribed. This
predates this question and is filed as
`docs/agents/plans/next/2026-07-16-mux-swallows-subscribe-failure.md`. **Out of scope.** Do not fix it,
do not work around it, and do not write a test that depends on the swallow's behaviour either way.

## Done when (all required)

1. A test asserts the retention value **on the subscribe call** for an app topic — the default of 30
   days, at the hub. Assert the number that actually reached `hub.subscribe`, not the param.
2. The override path is exercised: a peer constructed with a custom `appLogRetentionSeconds` subscribes
   its app topics with that value.
3. `retainTopic`'s subscribe carries it too — assert this specifically. It is the easiest one to miss
   and the one that matters most for a member that is away.
4. The commit lane's retention is unchanged and still asserted.
5. **Mutation check (required, paste it):** drop the retention from the app-topic subscribe → the test
   goes red. Invert by hand; confirm green, no residue.
6. Whole suite green.

## Scope boundary

The app-lane retention default ONLY. No `hub-protocol`/`hub-server` change. No mux error handling. No
architecture doc (that is the next question). Do not touch the drain, the cursor, `frameEpoch`, the
anchor, or the fake's strictness.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases — state the
invariant ("a member asks the hub to hold its app log as long as its commit log, so the two bounds
coincide").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-5.1-report.md` (changes with file:line, the mutation
pasted, whether every app-topic subscribe path was found — say which ones, surprises, concerns). Return
ONLY: status, uncommitted-changes note, one-line test summary, concerns. No full diff.
