# Recovery commits are not journaled, so a restart strands the group (ask from Sakui, 2026-10-27)

## Context

Sakui CLI daemon (desktop hub peer, kubun 0.19.x, `@kumiai/rpc` / `@kumiai/mls` 0.12.x). After a phone pairing run, the
system device group `bc2381da-ae1a-4066-977a-a14c7f041db1` ended stranded and cannot recover without another online
member:

- `kubun_p2p_app_outbox_state` cursor: `{"position":"000000346159","epoch":98,"stranded":true}`.
- `kubun_p2p_commit_journal` is empty.
- Every lane on the group fails with `RecoveryRequiredError`, restart included.
- The hub log holds an external commit at epoch 98 by the desktop (frame `351309`, 13:32:18 UTC), followed by eleven more
  external commits up to frame `352886`.

## What happens

`packages/rpc/src/peer.ts` recovery publication (~2476-2504) publishes an external commit and keeps `pendingRecovery`
only in memory. An attempt that is not confirmed discards it (~2561), and the next attempt publishes another external
commit. After a restart, the pull path sees the desktop's own external commit at epoch 98 with no journal entry,
classifies it as own-unmerged and marks the group stranded. Clearing that needs a rejoin through another online member;
with every other member offline (the phone was unpaired), the group is unrecoverable short of leave + re-create.

Suspected trigger (unconfirmed): a lane failure that was not a group-state problem (`SubscriptionQuotaExceededError`
or `NotSubscribedError`, see `2026-10-27-subscription-retirement.md`) escalated by `commitWithRecovery` into a heal.

## Expected

- A recovery commit is journaled durably (with the pending state needed to merge it) before it is published, and
  restart reconciles it: merge if it is on the log, retry or abandon cleanly if not.
- At most one outstanding recovery commit per group. No pile-up of external commits from one peer.
- Transport/subscription errors do not escalate to MLS recovery.
- A peer that is the sole online member can recover its own stranded group from its own durable state.

## Open for kumiai to decide

- Journal shape (reuse the commit journal kubun already persists, or a kumiai-owned recovery record via the host
  storage seam).
- Which error classes `commitWithRecovery` treats as recovery-worthy.
- A supported operator path for an already stranded group (the current one is stuck forever without a member).

## Related

- Sakui backlog: `sakui/docs/agents/plans/backlog/2026-10-25-mobile-sync-ui-stall-upstream.md`.
