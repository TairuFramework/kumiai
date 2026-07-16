# Probe brief (REVISED) — anchor at the last ROSTER CHANGE: stable, rotating, and AGREED

Implementation probe in `/Users/paul/dev/yulsi/kumiai`, package `packages/rpc`, branch
`feat/app-lane-delivery`. Do NOT switch branches. Leave changes uncommitted for review.

## Read this first: the working tree already has a partial, PARTLY-WRONG attempt

A previous probe answered this question under an **older design that has since been corrected**. Its
changes are **uncommitted in your working tree**. Do not start from scratch and do not assume they are
right:

- **Correct and keep:** the topic-derivation swap in `peer.ts` — `protocolTopic(anchor.secret,
  anchor.epoch, name)` (~`:289`), `selfInbox = inboxTopic(anchor.secret, anchor.epoch, localDID)`
  (~`:296`), the acceptor's `resolveSendTopic` (~`:326`), `createDirectedClient` (~`:385-386`);
  `wrap`/`unwrap` left on live `crypto`; the `secret` module var removed; `epoch` kept
  (`frameCommit:956` reads it). `topic.ts` untouched.
- **Now wrong, must be re-inverted:** that probe updated several existing tests to the old
  "rotate only on Remove" invariant. Under the corrected model an **Add also rotates**, so at minimum
  `packages/rpc/test/peer-recovery.test.ts` (asserts a rejoin leaves the anchor put — a rejoin adds a
  leaf, so it must now ROTATE) and the add-only cases in `packages/rpc/test/peer-remove-detect.test.ts`
  (committed, asserts add-only does NOT rotate — it must now rotate) are backwards. Re-check every test
  it touched: `peer-commit-lane.test.ts`, `peer-control-lanes.test.ts`, `peer-recovery.test.ts`,
  `peer-app-topic.test.ts` (new).

## The exact question

Does deriving the app topics from an anchor at the **last roster change** hold the topic stable within
a segment, rotate it on any roster change, and — the decisive part — keep every member **agreeing** on
it, including one whose peer boots at a later epoch than the anchor?

## Why the design changed (context you need)

The anchor secret is `exportSecret(anchorEpoch)`; MLS ratchets forward, so a member cannot export the
secret of an epoch it never held. Anchoring at the last **Remove** is therefore underivable by anyone
who joined after it. Two constraints decide the anchor: it must be an epoch **every current member
holds the secret for** (≥ the newest join) and **after every removal** (forward secrecy). Their
intersection is `max(last add, last remove)` — **the last roster change**.

The previous probe measured the failure it causes: alice boots at epoch 1, the group advances twice
with non-roster-changing commits, dave's peer boots over a handle already at epoch 3, alice dispatches
one event → dave received **0** (per-epoch derivation delivered 1). Silent permanent partition, no
Remove involved.

## Relevant spec section (verbatim)

> The anchor sits at the last commit that changed the roster — an Add or a Remove. A commit that leaves
> the roster untouched (update, no-op, ledger-only) leaves the topic stable; any roster change rotates
> it. ... The anchor epoch must be one every current member holds the secret for, so it must be ≥ the
> newest member's join epoch ... and after every removal ... `max(last add, last remove)` = the last
> roster change. ... a member added at epoch E seeds its anchor at E, and every existing member rotates
> to E on applying that same add — they agree natively, each holding E's secret. An external-commit
> rejoin adds a leaf, so recovery re-synchronizes the anchor for free.
>
> Set inequality, not set difference: an Add rotates it just as a Remove does. A commit carrying both an
> Add and a Remove leaves the leaf count unchanged and still rotates. A self-removal or leave rotates. An
> external-commit rejoin adds a leaf, so it rotates too. An update, no-op, or ledger-only commit touches
> no leaf and does not rotate.

## Approved approach

1. **Widen the detection** — `packages/rpc/src/roster.ts` currently exports `detectRemoval(before,
   after)` (set difference, committed). Rename to **`detectRosterChange`** and widen to set
   **inequality**: true iff the two DID sets differ at all (gained or lost a leaf). Update its
   doc-comment rationale and its call site in `peer.ts` (~`:846`) and the `index.ts` export.
2. **Keep the derivation swap** already in the tree (see above).
3. **Fix the tests the old model got backwards** (see above). Do not weaken a test to make it pass —
   invert it to the corrected invariant, and if a test's real subject was something else (e.g.
   "a rotation never unsubscribes"), preserve that subject by driving a genuine roster change.
4. **Do NOT implement anchor persistence** — a restart still re-seeds and still partitions. That is the
   next question (Q2.3), deliberately separate. If a test would need persistence to pass, it is out of
   scope: say so in the report rather than building it.

## Done when (all required)

`packages/rpc/test/peer-app-topic.test.ts` (extend the existing new file):
1. **Stable within a segment** — two online members exchange logged (`retain:'log'`) events across
   several non-roster-changing commits (update/no-op/ledger-only) on one topic ID; assert on the wire
   (all frames on the one topic; the per-epoch topics the group would otherwise have used have zero
   subscribers).
2. **Rotates on a Remove** — delivery continues on a new topic ID.
3. **Rotates on an Add** — an add-only commit also rotates both members onto a new topic and delivery
   continues. (New under the corrected model.)
4. **AGREEMENT — the decisive test.** A member whose peer boots at a **later epoch than the group's
   anchor** agrees and exchanges messages: seed a group, advance it with non-roster-changing commits,
   then have a new member added at the later epoch and boot its peer over a handle at that epoch. The
   add rotates every existing member to the joiner's add epoch, and the joiner seeds there natively —
   so both must derive the same topic and exchange logged events in both directions.
   **This test must fail if the anchor is seeded per-peer from the live epoch with no rotation on
   add** — verify that by mutation (temporarily revert `detectRosterChange` to removal-only and confirm
   this test goes red). Report the mutation result.

Existing tests green — `peer-remove-detect.test.ts` (invert its add-only/external-rejoin cases; the
file name is now a misnomer, feel free to rename it to reflect roster-change detection),
`peer-app-retention.test.ts`, `peer-control-lanes.test.ts`, `peer-commit-lane.test.ts`,
`peer-recovery.test.ts`.

## Scope boundary

Topic-ID source, detection predicate, and agreement only. NO anchor persistence (Q2.3), NO
returning-member drain (Phase 3), NO directed delivery-semantics change.

## Conventions

`kigu:conventions` + repo `AGENTS.md`/`CLAUDE.md`. `type` not `interface`; `Array<T>`; no `any`;
capital `ID`; `#fields`; never edit `lib/`. Code/comments/tests never name plan questions or phases —
state the invariant ("the app topic is stable within a roster-change-bounded segment; every member
anchors at the last roster change").

## Verify (repo root, paste real output)

`pnpm run build && rtk proxy pnpm run lint && pnpm test`
(`pnpm run lint` alone → eslint via the `rtk` shim; use `rtk proxy pnpm run lint`.)

## Report contract

Full report → `docs/superpowers/probes/question-2.2-report.md` (OVERWRITE the previous one; changes with
file:line, which old-model tests you re-inverted and why, the agreement test + its mutation result,
pasted verify output, surprises, concerns). Return ONLY: status, uncommitted-changes note, one-line test
summary, concerns. No full diff.
