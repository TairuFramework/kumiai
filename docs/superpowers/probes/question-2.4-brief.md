# Probe brief — the app-lane anchor must survive a restart

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, branch `feat/app-lane-delivery`. Do NOT switch
branches, do NOT commit. Leave changes uncommitted for review.

## Context: what is already committed and true

- App-lane topics derive from peer **anchor state** `{secret, epoch}` — `protocolTopic(anchor.secret,
  anchor.epoch, name)` (`peer.ts:308`), `inboxTopic(...)` (`:315`, `:345`, `:404`).
- The anchor sits at the **last roster change or rejoin**. It is captured at exactly three sites:
  - `peer.ts:1555` — **genesis seed**, `anchor = {secret: await crypto.exportSecret(), epoch:
    crypto.epoch()}`, immediately before `initControlLanes()` (`:1556`).
  - `peer.ts:888` — the **apply site** in `pullCommits`, on `detectRosterChange(rosterBefore, await
    port.rosterDIDs()) || header?.external === true`.
  - `peer.ts:1482` — the **rejoin adopt** in `recover()`, where the rejoiner sets its own anchor from
    the rejoined handle.
- Members agree because they all run the same rotation over the same commits.

## The known hole this question closes

The genesis seed at `:1555` runs on **every construction**, not only at genesis. A peer that restarts
over a handle already past the anchor re-seeds the anchor at the **live** epoch and partitions from
every peer that did not restart: it derives different topic IDs and neither sees the other's app
traffic.

It cannot be fixed by derivation. MLS ratchets forward — a rebooted handle can never re-export an
earlier epoch's secret. The anchor must be **persisted when captured and restored at construction**.

## Established facts (investigated — do not re-derive, do not contradict without evidence)

- `CommitJournal` (`packages/rpc/src/commit.ts:99`) is a **single-slot** store for one pending commit
  (`put`/`markAccepted`/`get`/`clear`), cleared on outcome. Wrong lifecycle for long-lived anchor
  state. Do NOT overload it.
- `GroupPeerMLSParams` (`peer.ts:103`) already bundles `mls` + `journal` + `adoptJournalled` with the
  documented reason: *"They arrive together or not at all — a peer with a port and no journal would
  silently lose every commit whose process died in the acceptance window, and the type is what stops a
  host wiring that."*

## The exact question

Does persisting the anchor at every capture site and restoring it at construction keep a restarted peer
on the group's topic?

## Approved approach (follow it; BLOCKED if it fights the code — do not redesign)

1. **New `AnchorStore` type** — `{ load(): Promise<{secret, epoch} | null>; save(anchor): Promise<void>
   }`. Put it beside the anchor's concern (a new `packages/rpc/src/anchor.ts` if `roster.ts`/`commit.ts`
   are a poor fit — your call, state it in the report). Export it from the package index alongside
   `CommitJournal`.
2. **Add `anchorStore` to `GroupPeerMLSParams`** — **required alongside `mls`/`journal`**, not optional,
   for exactly the reason that type already gives for `journal`: a peer with a port and no anchor store
   silently partitions on restart, and the type is what stops a host wiring that. Extend that type's doc
   comment to cover the third member.
3. **Restore before seed** — at `peer.ts:1555`, `load()` first. Non-null: restore it. Null (first boot):
   seed from `crypto` as today and `save()`. Both before `initControlLanes()` (`:1556`), so the lanes
   build on the restored anchor.
4. **Save on every rotation** — at `:888` and `:1482`. The anchor is only ever written at these three
   sites; every one must persist.

## Known residual — do NOT try to fix, do NOT report as a surprise

`processCommit` is durable, then rpc computes the anchor, then `save()` runs. A crash in that window
leaves a stale persisted anchor and the peer partitions until the next roster change. Closing it needs
the anchor in the same durable write as the handle, which rpc cannot do — it computes the anchor only
after `processCommit` returns. **Accepted as a stated residual.** Record it in a comment at the save
site as a known bound, not a TODO.

## Done when (all required)

1. **Restart convergence** — a new test (`packages/rpc/test/peer-anchor-restart.test.ts`) boots a peer,
   drifts the group **past the anchor with non-roster-changing commits** (otherwise the test proves
   nothing — the anchor and live epoch must differ), restarts the peer over the same handle and store,
   and asserts:
   - it restores the **persisted** anchor, not the live epoch (`anchorEpoch()`);
   - it still exchanges logged (`retain:'log'`) events **both ways** with a member that never restarted.
2. **First boot still works** — a peer with an empty store seeds at genesis and saves; assert the store
   holds it.
3. **Mutation check (required)** — drop the restore (always seed from `crypto`), confirm the restart
   test goes red, paste the failure, revert, confirm green with no residue.
4. Existing tests green — the whole suite, notably `peer-app-topic.test.ts`, `peer-recovery.test.ts`,
   `peer-commit-lane.test.ts`, `peer-control-lanes.test.ts`, `peer-app-retention.test.ts`. A memory
   anchor store fixture (`packages/rpc/test/fixtures/`) will be needed wherever peers are constructed;
   it must be able to **outlive** a peer, since that is the whole subject.

## Scope boundary

Anchor persistence ONLY. No returning-member drain. No pruned-window event. No `@kumiai/mls` change. Do
not touch `detectRosterChange` or the external-commit signal — both are correct and are not the subject.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`; capital
`ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases — state the
invariant ("the anchor is persisted state; a rebooted handle can never re-export an earlier epoch's
secret").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-2.4-report.md` (changes with file:line, the restart test,
the mutation result pasted, where you put `AnchorStore` and why, surprises, concerns). Return ONLY:
status, uncommitted-changes note, one-line test summary, concerns. No full diff.
